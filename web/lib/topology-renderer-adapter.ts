import * as THREE from "three";
import {
  TOPOLOGY_TRIANGLE_CHUNK_SIZE,
  persistentVertexAt,
  type PersistentMeshTopology,
} from "./scene-editor-topology-persistent";

const INDEX_VALUES_PER_SLOT = TOPOLOGY_TRIANGLE_CHUNK_SIZE * 3;
const MIN_VERTEX_CAPACITY = 64;
const MIN_INDEX_SLOT_CAPACITY = 16;

export type TopologyRendererWorkObservations = Readonly<{
  fullMaterializationCount: number;
  materializedVertexReferences: number;
  materializedIndexValues: number;
  geometryCreateCount: number;
  geometryDisposeCount: number;
  positionValuesUploaded: number;
  indexValuesUploaded: number;
  localizedGeometryUpdateCount: number;
}>;

export type TopologyGeometryAdapter = Readonly<{
  object: THREE.Object3D;
  update(topology: PersistentMeshTopology): TopologyRendererWorkObservations;
  semanticTriangleIndex(raycastFaceIndex: number): number | null;
  dispose(): void;
}>;

function capacityWithSlack(required: number, minimum: number): number {
  const target = required + Math.max(minimum, Math.ceil(required / 4));
  let capacity = minimum;
  while (capacity < target) capacity *= 2;
  return capacity;
}

function emptyWork(): TopologyRendererWorkObservations {
  return {
    fullMaterializationCount: 0,
    materializedVertexReferences: 0,
    materializedIndexValues: 0,
    geometryCreateCount: 0,
    geometryDisposeCount: 0,
    positionValuesUploaded: 0,
    indexValuesUploaded: 0,
    localizedGeometryUpdateCount: 1,
  };
}

function writeVertexRange(
  array: Float32Array,
  topology: PersistentMeshTopology,
  startVertex: number,
  endVertex: number,
): void {
  for (let vertexIndex = startVertex; vertexIndex < endVertex; vertexIndex += 1) {
    const vertex = persistentVertexAt(topology, vertexIndex);
    const offset = vertexIndex * 3;
    array[offset] = vertex[0];
    array[offset + 1] = vertex[1];
    array[offset + 2] = vertex[2];
  }
}

function sharedVertexChunkPrefix(
  left: PersistentMeshTopology,
  right: PersistentMeshTopology,
): boolean {
  const sharedChunkCount = Math.min(left.vertexChunks.length, right.vertexChunks.length);
  for (let index = 0; index < sharedChunkCount; index += 1) {
    if (left.vertexChunks[index] !== right.vertexChunks[index]) return false;
  }
  return true;
}

function writeIndexSlot(array: Uint32Array, slot: number, chunk: Uint32Array): void {
  const start = slot * INDEX_VALUES_PER_SLOT;
  array.fill(0, start, start + INDEX_VALUES_PER_SLOT);
  array.set(chunk, start);
}

function activeBoundingSphere(positionArray: Float32Array, vertexCount: number): THREE.Sphere {
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    const offset = vertexIndex * 3;
    point.set(positionArray[offset], positionArray[offset + 1], positionArray[offset + 2]);
    box.expandByPoint(point);
  }
  return box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 0) : box.getBoundingSphere(new THREE.Sphere());
}

/**
 * Renderer-side topology adapter aligned with the editor's persistent topology representation.
 *
 * Positions live in one growable buffer with slack. Persistent triangle chunks occupy fixed-size
 * index slots. Unchanged chunk identities keep their slot and upload nothing; changed chunks rewrite
 * only their slot. Degenerate zero-index padding fills unused values inside active slots, allowing one
 * BufferGeometry to render a chunked logical index stream without shifting every following triangle.
 */
export function createTopologyGeometryAdapter(
  material: THREE.Material,
  initialTopology: PersistentMeshTopology,
): TopologyGeometryAdapter {
  let topology = initialTopology;
  let vertexCapacity = capacityWithSlack(initialTopology.vertexCount, MIN_VERTEX_CAPACITY);
  let indexSlotCapacity = capacityWithSlack(initialTopology.triangleChunks.length, MIN_INDEX_SLOT_CAPACITY);
  let positionArray = new Float32Array(vertexCapacity * 3);
  let indexArray = new Uint32Array(indexSlotCapacity * INDEX_VALUES_PER_SLOT);
  writeVertexRange(positionArray, initialTopology, 0, initialTopology.vertexCount);

  const chunkSlots = new WeakMap<Uint32Array, number>();
  const slotChunks: Array<Uint32Array | null> = new Array(indexSlotCapacity).fill(null);
  for (let slot = 0; slot < initialTopology.triangleChunks.length; slot += 1) {
    const chunk = initialTopology.triangleChunks[slot];
    chunkSlots.set(chunk, slot);
    slotChunks[slot] = chunk;
    writeIndexSlot(indexArray, slot, chunk);
  }
  let activeSlotCount = initialTopology.triangleChunks.length;
  let semanticBaseByChunk = new WeakMap<Uint32Array, number>();

  const rebuildSemanticBases = (current: PersistentMeshTopology) => {
    semanticBaseByChunk = new WeakMap();
    let triangleBase = 0;
    for (const chunk of current.triangleChunks) {
      semanticBaseByChunk.set(chunk, triangleBase);
      triangleBase += chunk.length / 3;
    }
  };
  rebuildSemanticBases(initialTopology);

  const geometry = new THREE.BufferGeometry();
  let positionAttribute = new THREE.BufferAttribute(positionArray, 3);
  let indexAttribute = new THREE.BufferAttribute(indexArray, 1);
  positionAttribute.setUsage(THREE.DynamicDrawUsage);
  indexAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positionAttribute);
  geometry.setIndex(indexAttribute);
  geometry.setDrawRange(0, activeSlotCount * INDEX_VALUES_PER_SLOT);
  geometry.computeVertexNormals();
  geometry.boundingSphere = activeBoundingSphere(positionArray, initialTopology.vertexCount);
  const mesh = new THREE.Mesh(geometry, material);
  let disposed = false;

  const growPositionBuffer = (requiredVertexCount: number, work: TopologyRendererWorkObservations) => {
    const nextCapacity = capacityWithSlack(requiredVertexCount, MIN_VERTEX_CAPACITY);
    const next = new Float32Array(nextCapacity * 3);
    next.set(positionArray);
    positionArray = next;
    vertexCapacity = nextCapacity;
    positionAttribute = new THREE.BufferAttribute(positionArray, 3);
    positionAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", positionAttribute);
    geometry.deleteAttribute("normal");
    return { ...work, positionValuesUploaded: work.positionValuesUploaded + positionArray.length };
  };

  const growIndexBuffer = (requiredSlots: number, work: TopologyRendererWorkObservations) => {
    const nextCapacity = capacityWithSlack(requiredSlots, MIN_INDEX_SLOT_CAPACITY);
    const next = new Uint32Array(nextCapacity * INDEX_VALUES_PER_SLOT);
    next.set(indexArray);
    indexArray = next;
    indexSlotCapacity = nextCapacity;
    slotChunks.length = indexSlotCapacity;
    for (let index = activeSlotCount; index < slotChunks.length; index += 1) slotChunks[index] ??= null;
    indexAttribute = new THREE.BufferAttribute(indexArray, 1);
    indexAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setIndex(indexAttribute);
    return { ...work, indexValuesUploaded: work.indexValuesUploaded + indexArray.length };
  };

  return {
    object: mesh,
    update(nextTopology) {
      if (disposed) throw new Error("topology geometry adapter is disposed");
      let work = emptyWork();

      const vertexPrefixStable = sharedVertexChunkPrefix(topology, nextTopology);
      const previousVertexCount = topology.vertexCount;
      if (!vertexPrefixStable) {
        if (nextTopology.vertexCount > vertexCapacity) work = growPositionBuffer(nextTopology.vertexCount, work);
        writeVertexRange(positionArray, nextTopology, 0, nextTopology.vertexCount);
        positionAttribute.clearUpdateRanges();
        positionAttribute.addUpdateRange(0, nextTopology.vertexCount * 3);
        positionAttribute.needsUpdate = true;
        work = {
          ...work,
          positionValuesUploaded: work.positionValuesUploaded + nextTopology.vertexCount * 3,
        };
      } else if (nextTopology.vertexCount > previousVertexCount) {
        if (nextTopology.vertexCount > vertexCapacity) {
          work = growPositionBuffer(nextTopology.vertexCount, work);
          writeVertexRange(positionArray, nextTopology, previousVertexCount, nextTopology.vertexCount);
        } else {
          writeVertexRange(positionArray, nextTopology, previousVertexCount, nextTopology.vertexCount);
          positionAttribute.clearUpdateRanges();
          positionAttribute.addUpdateRange(previousVertexCount * 3, (nextTopology.vertexCount - previousVertexCount) * 3);
          positionAttribute.needsUpdate = true;
          work = {
            ...work,
            positionValuesUploaded:
              work.positionValuesUploaded + (nextTopology.vertexCount - previousVertexCount) * 3,
          };
        }
      }

      const nextChunkSet = new Set(nextTopology.triangleChunks);
      const freedSlots: number[] = [];
      for (let slot = 0; slot < activeSlotCount; slot += 1) {
        const chunk = slotChunks[slot];
        if (chunk && !nextChunkSet.has(chunk)) {
          slotChunks[slot] = null;
          freedSlots.push(slot);
        }
      }

      if (nextTopology.triangleChunks.length > indexSlotCapacity) {
        work = growIndexBuffer(nextTopology.triangleChunks.length, work);
      }

      const touchedSlots = new Set<number>();
      const insertedChunks = nextTopology.triangleChunks.filter((chunk) => {
        const slot = chunkSlots.get(chunk);
        return slot === undefined || slotChunks[slot] !== chunk;
      });
      freedSlots.sort((left, right) => left - right);
      for (const chunk of insertedChunks) {
        let slot = freedSlots.shift();
        if (slot === undefined) {
          slot = activeSlotCount;
          activeSlotCount += 1;
          if (activeSlotCount > indexSlotCapacity) {
            work = growIndexBuffer(activeSlotCount, work);
          }
        }
        chunkSlots.set(chunk, slot);
        slotChunks[slot] = chunk;
        writeIndexSlot(indexArray, slot, chunk);
        touchedSlots.add(slot);
      }

      let firstHole = slotChunks.findIndex((chunk, index) => index < activeSlotCount && chunk === null);
      while (firstHole >= 0) {
        let lastSlot = activeSlotCount - 1;
        while (lastSlot > firstHole && slotChunks[lastSlot] === null) lastSlot -= 1;
        if (lastSlot <= firstHole) break;
        const moved = slotChunks[lastSlot];
        if (!moved) break;
        chunkSlots.set(moved, firstHole);
        slotChunks[firstHole] = moved;
        slotChunks[lastSlot] = null;
        writeIndexSlot(indexArray, firstHole, moved);
        indexArray.fill(0, lastSlot * INDEX_VALUES_PER_SLOT, (lastSlot + 1) * INDEX_VALUES_PER_SLOT);
        touchedSlots.add(firstHole);
        touchedSlots.add(lastSlot);
        firstHole = slotChunks.findIndex((chunk, index) => index < activeSlotCount && chunk === null);
      }
      while (activeSlotCount > 0 && slotChunks[activeSlotCount - 1] === null) activeSlotCount -= 1;

      if (touchedSlots.size > 0 && work.indexValuesUploaded === 0) {
        indexAttribute.clearUpdateRanges();
        for (const slot of [...touchedSlots].sort((left, right) => left - right)) {
          indexAttribute.addUpdateRange(slot * INDEX_VALUES_PER_SLOT, INDEX_VALUES_PER_SLOT);
        }
        indexAttribute.needsUpdate = true;
        work = {
          ...work,
          indexValuesUploaded: touchedSlots.size * INDEX_VALUES_PER_SLOT,
        };
      }

      geometry.setDrawRange(0, activeSlotCount * INDEX_VALUES_PER_SLOT);
      geometry.computeVertexNormals();
      geometry.boundingSphere = activeBoundingSphere(positionArray, nextTopology.vertexCount);
      rebuildSemanticBases(nextTopology);
      topology = nextTopology;
      return work;
    },
    semanticTriangleIndex(raycastFaceIndex) {
      if (!Number.isInteger(raycastFaceIndex) || raycastFaceIndex < 0) return null;
      const slot = Math.floor(raycastFaceIndex / TOPOLOGY_TRIANGLE_CHUNK_SIZE);
      const localTriangle = raycastFaceIndex % TOPOLOGY_TRIANGLE_CHUNK_SIZE;
      const chunk = slotChunks[slot];
      if (!chunk || localTriangle >= chunk.length / 3) return null;
      const base = semanticBaseByChunk.get(chunk);
      return base === undefined ? null : base + localTriangle;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      geometry.dispose();
    },
  };
}
