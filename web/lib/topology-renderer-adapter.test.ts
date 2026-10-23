import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { subdividedPlane } from "./mesh";
import type { MeshTopologyDelta, MeshTopologyOperation } from "./scene-editor-topology";
import {
  TOPOLOGY_TRIANGLE_CHUNK_SIZE,
  applyPersistentMeshTopologyDelta,
  createPersistentMeshTopology,
  materializePersistentMeshTopology,
  performPersistentMeshTopologyOperation,
  persistentTriangleAt,
  type PersistentMeshTopology,
} from "./scene-editor-topology-persistent";
import {
  addTopologyRendererWork,
  createTopologyGeometryAdapter,
  emptyTopologyRendererWork,
  type TopologyGeometryAdapter,
  type TopologyRendererWorkObservations,
} from "./topology-renderer-adapter";

const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

/** Full reference path: contiguous materialization, a fresh BufferGeometry and three.js vertex normals. */
function referenceMesh(topology: PersistentMeshTopology): THREE.Mesh {
  const { mesh } = materializePersistentMeshTopology(topology);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.vertices.flat(), 3));
  geometry.setIndex(mesh.indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

function pick(object: THREE.Object3D, x: number, z: number, fromAbove: boolean) {
  const raycaster = new THREE.Raycaster(
    new THREE.Vector3(x, fromAbove ? 5 : -5, z),
    new THREE.Vector3(0, fromAbove ? -1 : 1, 0),
  );
  return raycaster.intersectObject(object, false)[0] ?? null;
}

function expectMatchesReference(adapter: TopologyGeometryAdapter, topology: PersistentMeshTopology): void {
  const reference = referenceMesh(topology);
  const referenceGeometry = reference.geometry;
  const geometry = (adapter.object as THREE.Mesh).geometry;
  const vertexValues = topology.vertexCount * 3;

  const position = geometry.getAttribute("position").array as Float32Array;
  expect([...position.subarray(0, vertexValues)]).toEqual([...(referenceGeometry.getAttribute("position").array as Float32Array)]);

  const normal = geometry.getAttribute("normal").array as Float32Array;
  const referenceNormal = referenceGeometry.getAttribute("normal").array as Float32Array;
  for (let offset = 0; offset < vertexValues; offset += 1) {
    expect(Math.abs(normal[offset] - referenceNormal[offset])).toBeLessThan(1e-5);
  }

  const index = geometry.getIndex()!.array as Uint32Array;
  const referenceIndex = referenceGeometry.getIndex()!.array;
  const drawTriangles = geometry.drawRange.count / 3;
  const seen = new Set<number>();
  for (let face = 0; face < drawTriangles; face += 1) {
    const semantic = adapter.semanticTriangleIndex(face);
    if (semantic === null) {
      expect([index[face * 3], index[face * 3 + 1], index[face * 3 + 2]]).toEqual([0, 0, 0]);
      continue;
    }
    expect(seen.has(semantic)).toBe(false);
    seen.add(semantic);
    expect([index[face * 3], index[face * 3 + 1], index[face * 3 + 2]]).toEqual([
      referenceIndex[semantic * 3],
      referenceIndex[semantic * 3 + 1],
      referenceIndex[semantic * 3 + 2],
    ]);
  }
  expect(seen.size).toBe(topology.triangleCount);

  for (let row = 0; row < 9; row += 1) {
    for (let column = 0; column < 9; column += 1) {
      const x = -0.97 + column * 0.2371;
      const z = -0.95 + row * 0.2293;
      for (const fromAbove of [true, false]) {
        const hit = pick(adapter.object, x, z, fromAbove);
        const referenceHit = pick(reference, x, z, fromAbove);
        expect(hit === null).toBe(referenceHit === null);
        if (!hit || !referenceHit) continue;
        expect(hit.distance).toBeCloseTo(referenceHit.distance, 6);
        expect(adapter.semanticTriangleIndex(hit.faceIndex!)).toBe(referenceHit.faceIndex!);
      }
    }
  }
  referenceGeometry.dispose();
}

function expectLocalized(work: TopologyRendererWorkObservations): void {
  expect(work.fullMaterializationCount).toBe(0);
  expect(work.materializedVertexReferences).toBe(0);
  expect(work.materializedIndexValues).toBe(0);
  expect(work.geometryCreateCount).toBe(0);
  expect(work.geometryDisposeCount).toBe(0);
  expect(work.fullPreparationCount).toBe(0);
  expect(work.localizedGeometryUpdateCount).toBe(1);
}

describe("localized topology renderer adapter", () => {
  test("a single localized edit on the canary workload touches only its chunk", () => {
    const source = createPersistentMeshTopology(subdividedPlane(32));
    const adapter = createTopologyGeometryAdapter(material, source);
    const object = adapter.object;

    const inset = performPersistentMeshTopologyOperation(source, { kind: "inset-face", triangleIndex: 17, ratio: 0.25 });
    const work = adapter.update(inset.topology);

    expect(adapter.object).toBe(object);
    expectLocalized(work);
    expect(work.bufferReplacementCount).toBe(0);
    expect(work.positionValuesUploaded).toBe(9);
    expect(work.indexValuesUploaded).toBeLessThanOrEqual(TOPOLOGY_TRIANGLE_CHUNK_SIZE * 3 * 2);
    expect(work.normalVerticesRecomputed).toBeLessThan(inset.topology.vertexCount / 4);
    expect(work.normalValuesUploaded).toBeLessThan(inset.topology.vertexCount * 3 / 4);
    expectMatchesReference(adapter, inset.topology);
    adapter.dispose();
  });

  test("matches the full materialization reference across edits, undo/redo, growth, shrink and replacement", () => {
    const source = createPersistentMeshTopology(subdividedPlane(12));
    const adapter = createTopologyGeometryAdapter(material, source);
    expectMatchesReference(adapter, source);

    const history: Array<{ topology: PersistentMeshTopology; delta: MeshTopologyDelta }> = [];
    let topology = source;
    let total = emptyTopologyRendererWork();
    const apply = (operation: MeshTopologyOperation) => {
      const edit = performPersistentMeshTopologyOperation(topology, operation);
      history.push({ topology, delta: edit.delta });
      topology = edit.topology;
      const work = adapter.update(topology);
      expectLocalized(work);
      total = addTopologyRendererWork(total, work);
      expectMatchesReference(adapter, topology);
    };
    const triangleEdge = (triangleIndex: number) => {
      const [a, b] = persistentTriangleAt(topology, triangleIndex);
      return [a, b] as const;
    };

    // Chunk boundaries: last triangle of chunk 0 and first triangle of chunk 1.
    apply({ kind: "inset-face", triangleIndex: TOPOLOGY_TRIANGLE_CHUNK_SIZE - 1, ratio: 0.3 });
    apply({ kind: "split-edge", edge: triangleEdge(TOPOLOGY_TRIANGLE_CHUNK_SIZE + 6) });
    apply({ kind: "extrude-face", triangleIndex: 5, distance: 0.3 });

    // Undo twice, then redo once.
    const undone: typeof history = [];
    for (let step = 0; step < 2; step += 1) {
      const last = history.pop()!;
      topology = applyPersistentMeshTopologyDelta(topology, last.delta, "reverse");
      undone.push(last);
      expectLocalized(adapter.update(topology));
      expectMatchesReference(adapter, topology);
    }
    const redo = undone.pop()!;
    topology = applyPersistentMeshTopologyDelta(topology, redo.delta, "forward");
    history.push(redo);
    expectLocalized(adapter.update(topology));
    expectMatchesReference(adapter, topology);

    // Growth past the initial vertex capacity replaces buffers but never the geometry.
    for (let edit = 0; edit < 40; edit += 1) {
      apply({ kind: "inset-face", triangleIndex: (edit * 37 + 11) % topology.triangleCount, ratio: 0.2 });
    }
    expect(total.bufferReplacementCount).toBeGreaterThan(0);

    // Shrink back to the source by undoing everything.
    while (history.length > 0) {
      const last = history.pop()!;
      topology = applyPersistentMeshTopologyDelta(topology, last.delta, "reverse");
      expectLocalized(adapter.update(topology));
    }
    expectMatchesReference(adapter, topology);

    // An unrelated topology is a structural jump and takes the full preparation path.
    const replacement = createPersistentMeshTopology(subdividedPlane(5));
    const work = adapter.update(replacement);
    expect(work.fullPreparationCount).toBe(1);
    expect(work.geometryCreateCount).toBe(0);
    expectMatchesReference(adapter, replacement);
    adapter.dispose();
  }, 30_000);

  test("maps slot-padded raycast faces back to semantic triangle indices", () => {
    const source = createPersistentMeshTopology(subdividedPlane(32));
    const adapter = createTopologyGeometryAdapter(material, source);

    expect(adapter.semanticTriangleIndex(0)).toBe(0);
    expect(adapter.semanticTriangleIndex(128)).toBe(128);

    const inset = performPersistentMeshTopologyOperation(source, {
      kind: "inset-face",
      triangleIndex: 0,
      ratio: 0.25,
    });
    adapter.update(inset.topology);
    expect(adapter.semanticTriangleIndex(0)).toBe(0);

    adapter.dispose();
  });
});
