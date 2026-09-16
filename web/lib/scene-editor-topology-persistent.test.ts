import { describe, expect, test } from "bun:test";
import { subdividedPlane, validateMesh, type IndexedMesh } from "./mesh";
import {
  performMeshTopologyOperation,
  type MeshTopologyOperation,
} from "./scene-editor-topology";
import {
  TOPOLOGY_TRIANGLE_CHUNK_SIZE,
  applyPersistentMeshTopologyDelta,
  createPersistentMeshTopology,
  createPersistentMeshTopologyIndex,
  materializePersistentMeshTopology,
  performPersistentMeshTopologyOperation,
  persistentTriangleAt,
} from "./scene-editor-topology-persistent";

function expectMeshEqual(actual: IndexedMesh, expected: IndexedMesh): void {
  expect(actual.vertices).toEqual(expected.vertices);
  expect(actual.indices).toEqual(expected.indices);
  expect(actual.attributes).toEqual(expected.attributes);
  expect(() => validateMesh(actual)).not.toThrow();
}

function runEquivalent(mesh: IndexedMesh, operation: MeshTopologyOperation) {
  const legacy = performMeshTopologyOperation(mesh, operation);
  const persistent = performPersistentMeshTopologyOperation(createPersistentMeshTopology(mesh), operation);
  const materialized = materializePersistentMeshTopology(persistent.topology).mesh;
  expectMeshEqual(materialized, legacy.mesh);
  return persistent;
}

describe("persistent editor topology", () => {
  test("edge split matches legacy semantics without copying the full mesh", () => {
    const mesh = subdividedPlane(32);
    const topology = createPersistentMeshTopology(mesh);
    const triangle = persistentTriangleAt(topology, 77);
    const edge = [triangle[0], triangle[1]] as const;
    const index = createPersistentMeshTopologyIndex(topology);
    const persistent = performPersistentMeshTopologyOperation(topology, { kind: "split-edge", edge }, index);
    const legacy = performMeshTopologyOperation(mesh, { kind: "split-edge", edge });

    expectMeshEqual(materializePersistentMeshTopology(persistent.topology).mesh, legacy.mesh);
    expect(persistent.observations.vertexReferencesCopied).toBe(0);
    expect(persistent.observations.authoredAttributeReferencesCopied).toBe(0);
    expect(persistent.observations.indexValuesCopied).toBeLessThanOrEqual(TOPOLOGY_TRIANGLE_CHUNK_SIZE * 3 * 2);
    expect(persistent.topology.vertexChunks[0]).toBe(mesh.vertices);
  });

  test("inset and extrude match legacy semantics with one local chunk copy", () => {
    const mesh = subdividedPlane(24);
    for (const operation of [
      { kind: "inset-face", triangleIndex: 211, ratio: 0.22 } as const,
      { kind: "extrude-face", triangleIndex: 211, distance: 0.04 } as const,
    ]) {
      const persistent = runEquivalent(mesh, operation);
      expect(persistent.observations.vertexReferencesCopied).toBe(0);
      expect(persistent.observations.authoredAttributeReferencesCopied).toBe(0);
      expect(persistent.observations.indexValuesCopied).toBeLessThanOrEqual(TOPOLOGY_TRIANGLE_CHUNK_SIZE * 3);
    }
  });

  test("undo restores the exact source mesh without flattening intermediate states", () => {
    const mesh = subdividedPlane(20);
    const topology = createPersistentMeshTopology(mesh);
    const edit = performPersistentMeshTopologyOperation(topology, {
      kind: "inset-face",
      triangleIndex: 37,
      ratio: 0.3,
    });
    const undone = applyPersistentMeshTopologyDelta(edit.topology, edit.delta, "reverse");
    expect(undone.vertexChunks[0]).toBe(mesh.vertices);
    expectMeshEqual(materializePersistentMeshTopology(undone).mesh, mesh);
  });

  test("a repeated edit sequence stays equivalent while copy work remains local", () => {
    const initial = subdividedPlane(32);
    let legacy = initial;
    let persistent = createPersistentMeshTopology(initial);
    let copied = 0;
    let written = 0;

    for (let edit = 0; edit < 12; edit += 1) {
      const triangleIndex = (edit * 173 + 19) % persistent.triangleCount;
      const operation: MeshTopologyOperation =
        edit % 2 === 0
          ? { kind: "inset-face", triangleIndex, ratio: 0.2 }
          : { kind: "extrude-face", triangleIndex, distance: 0.025 };
      const legacyEdit = performMeshTopologyOperation(legacy, operation);
      const persistentEdit = performPersistentMeshTopologyOperation(persistent, operation);
      legacy = legacyEdit.mesh;
      persistent = persistentEdit.topology;
      copied += persistentEdit.observations.indexValuesCopied;
      written += persistentEdit.observations.indexValuesWritten;
    }

    expectMeshEqual(materializePersistentMeshTopology(persistent).mesh, legacy);
    expect(copied).toBeLessThan(initial.indices.length);
    expect(written).toBeGreaterThan(0);
  });
});
