import * as THREE from "three";
import {
  TOPOLOGY_TRIANGLE_CHUNK_SIZE,
  persistentVertexAt,
  type PersistentMeshTopology,
} from "./scene-editor-topology-persistent";

const INDEX_VALUES_PER_SLOT = TOPOLOGY_TRIANGLE_CHUNK_SIZE * 3;
const MIN_VERTEX_CAPACITY = 64;
const MIN_INDEX_SLOT_CAPACITY = 16;
/** Affected vertices closer than this are uploaded as one range instead of separate sub-ranges. */
const VERTEX_RANGE_MERGE_GAP = 16;

/**
 * Renderer work for one adapter update. A localized edit keeps every materialization, geometry and
 * buffer-replacement counter at zero and uploads only touched vertex ranges and index slots.
 * `fullPreparationCount` is 1 only when the vertex chunk prefix changed identity (a structural jump,
 * such as switching to an unrelated topology), which rewrites every active vertex.
 */
export type TopologyRendererWorkObservations = Readonly<{
  fullMaterializationCount: number;
  materializedVertexReferences: number;
  materializedIndexValues: number;
  geometryCreateCount: number;
  geometryDisposeCount: number;
  bufferReplacementCount: number;
  positionValuesUploaded: number;
  normalValuesUploaded: number;
  indexValuesUploaded: number;
  uploadRangeCount: number;
  normalVerticesRecomputed: number;
  fullPreparationCount: number;
  localizedGeometryUpdateCount: number;
}>;

export type TopologyGeometryAdapter = Readonly<{
  object: THREE.Object3D;
  update(topology: PersistentMeshTopology): TopologyRendererWorkObservations;
  semanticTriangleIndex(raycastFaceIndex: number): number | null;
  dispose(): void;
}>;

export function emptyTopologyRendererWork(): TopologyRendererWorkObservations {
  return {
    fullMaterializationCount: 0,
    materializedVertexReferences: 0,
    materializedIndexValues: 0,
    geometryCreateCount: 0,
    geometryDisposeCount: 0,
    bufferReplacementCount: 0,
    positionValuesUploaded: 0,
    normalValuesUploaded: 0,
    indexValuesUploaded: 0,
    uploadRangeCount: 0,
    normalVerticesRecomputed: 0,
    fullPreparationCount: 0,
    localizedGeometryUpdateCount: 0,
  };
}

export function addTopologyRendererWork(
  left: TopologyRendererWorkObservations,
  right: TopologyRendererWorkObservations,
): TopologyRendererWorkObservations {
  const total = { ...left };
  for (const key of Object.keys(total) as (keyof TopologyRendererWorkObservations)[]) {
    (total as Record<keyof TopologyRendererWorkObservations, number>)[key] = left[key] + right[key];
  }
  return total;
}

function capacityWithSlack(required: number, minimum: number): number {
  const target = required + Math.max(minimum, Math.ceil(required / 4));
  let capacity = minimum;
  while (capacity < target) capacity *= 2;
  return capacity;
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

/**
 * Adds (sign 1) or removes (sign -1) the area-weighted face normals of one triangle chunk to the
 * per-vertex sums, matching `BufferGeometry.computeVertexNormals` before normalization.
 */
function accumulateChunkNormals(
  chunk: Uint32Array,
  sign: 1 | -1,
  positionArray: Float32Array,
  sums: Float64Array,
  affected: Set<number> | null,
): void {
  for (let offset = 0; offset < chunk.length; offset += 3) {
    const ia = chunk[offset];
    const ib = chunk[offset + 1];
    const ic = chunk[offset + 2];
    const a = ia * 3;
    const b = ib * 3;
    const c = ic * 3;
    const cbx = positionArray[c] - positionArray[b];
    const cby = positionArray[c + 1] - positionArray[b + 1];
    const cbz = positionArray[c + 2] - positionArray[b + 2];
    const abx = positionArray[a] - positionArray[b];
    const aby = positionArray[a + 1] - positionArray[b + 1];
    const abz = positionArray[a + 2] - positionArray[b + 2];
    const nx = sign * (cby * abz - cbz * aby);
    const ny = sign * (cbz * abx - cbx * abz);
    const nz = sign * (cbx * aby - cby * abx);
    for (const base of [a, b, c]) {
      sums[base] += nx;
      sums[base + 1] += ny;
      sums[base + 2] += nz;
    }
    if (affected) {
      affected.add(ia);
      affected.add(ib);
      affected.add(ic);
    }
  }
}

function normalizeVertexNormal(sums: Float64Array, normalArray: Float32Array, vertexIndex: number): void {
  const offset = vertexIndex * 3;
  const x = sums[offset];
  const y = sums[offset + 1];
  const z = sums[offset + 2];
  const length = Math.hypot(x, y, z);
  const scale = length > Number.EPSILON ? 1 / length : 0;
  normalArray[offset] = x * scale;
  normalArray[offset + 1] = y * scale;
  normalArray[offset + 2] = z * scale;
}

/** Coalesces sorted vertex indices into `[start, count]` ranges, bridging small gaps. */
function vertexRanges(sortedVertices: readonly number[]): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  let start = -1;
  let end = -1;
  for (const vertex of sortedVertices) {
    if (start < 0) {
      start = vertex;
      end = vertex + 1;
    } else if (vertex - end <= VERTEX_RANGE_MERGE_GAP) {
      end = vertex + 1;
    } else {
      ranges.push([start, end - start]);
      start = vertex;
      end = vertex + 1;
    }
  }
  if (start >= 0) ranges.push([start, end - start]);
  return ranges;
}

function boundsOf(positionArray: Float32Array, startVertex: number, endVertex: number, target: THREE.Box3): THREE.Box3 {
  const point = new THREE.Vector3();
  for (let vertexIndex = startVertex; vertexIndex < endVertex; vertexIndex += 1) {
    const offset = vertexIndex * 3;
    point.set(positionArray[offset], positionArray[offset + 1], positionArray[offset + 2]);
    target.expandByPoint(point);
  }
  return target;
}

function sphereOf(bounds: THREE.Box3): THREE.Sphere {
  return bounds.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 0) : bounds.getBoundingSphere(new THREE.Sphere());
}

/**
 * Renderer-side topology adapter aligned with the editor's persistent topology representation.
 *
 * Positions live in one growable buffer with slack. Persistent triangle chunks occupy fixed-size
 * index slots. Unchanged chunk identities keep their slot and upload nothing; changed chunks rewrite
 * only their slot. Vertex normals keep unnormalized area-weighted sums: removed chunks subtract their
 * face normals and inserted chunks add theirs, so only vertices of touched chunks are renormalized and
 * uploaded. Persistent topology edits only append vertices, so existing positions never move and the
 * sums of unchanged chunks stay valid. A changed vertex chunk prefix falls back to full preparation.
 *
 * Update ranges are appended, never cleared: three.js clears them after each upload, so several
 * updates between renders accumulate correctly.
 */
export function createTopologyGeometryAdapter(
  material: THREE.Material,
  initialTopology: PersistentMeshTopology,
): TopologyGeometryAdapter {
  let topology = initialTopology;
  let vertexCapacity = capacityWithSlack(initialTopology.vertexCount, MIN_VERTEX_CAPACITY);
  let indexSlotCapacity = capacityWithSlack(initialTopology.triangleChunks.length, MIN_INDEX_SLOT_CAPACITY);
  let positionArray = new Float32Array(vertexCapacity * 3);
  let normalArray = new Float32Array(vertexCapacity * 3);
  let normalSums = new Float64Array(vertexCapacity * 3);
  let indexArray = new Uint32Array(indexSlotCapacity * INDEX_VALUES_PER_SLOT);
  writeVertexRange(positionArray, initialTopology, 0, initialTopology.vertexCount);
  for (const chunk of initialTopology.triangleChunks) {
    accumulateChunkNormals(chunk, 1, positionArray, normalSums, null);
  }
  for (let vertexIndex = 0; vertexIndex < initialTopology.vertexCount; vertexIndex += 1) {
    normalizeVertexNormal(normalSums, normalArray, vertexIndex);
  }

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
  let normalAttribute = new THREE.BufferAttribute(normalArray, 3);
  let indexAttribute = new THREE.BufferAttribute(indexArray, 1);
  positionAttribute.setUsage(THREE.DynamicDrawUsage);
  normalAttribute.setUsage(THREE.DynamicDrawUsage);
  indexAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positionAttribute);
  geometry.setAttribute("normal", normalAttribute);
  geometry.setIndex(indexAttribute);
  geometry.setDrawRange(0, activeSlotCount * INDEX_VALUES_PER_SLOT);
  let bounds = boundsOf(positionArray, 0, initialTopology.vertexCount, new THREE.Box3());
  geometry.boundingSphere = sphereOf(bounds);
  const mesh = new THREE.Mesh(geometry, material);
  let disposed = false;

  const growVertexBuffers = (requiredVertexCount: number) => {
    const nextCapacity = capacityWithSlack(requiredVertexCount, MIN_VERTEX_CAPACITY);
    const nextPosition = new Float32Array(nextCapacity * 3);
    const nextNormal = new Float32Array(nextCapacity * 3);
    const nextSums = new Float64Array(nextCapacity * 3);
    nextPosition.set(positionArray);
    nextNormal.set(normalArray);
    nextSums.set(normalSums);
    positionArray = nextPosition;
    normalArray = nextNormal;
    normalSums = nextSums;
    vertexCapacity = nextCapacity;
    positionAttribute = new THREE.BufferAttribute(positionArray, 3);
    normalAttribute = new THREE.BufferAttribute(normalArray, 3);
    positionAttribute.setUsage(THREE.DynamicDrawUsage);
    normalAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", positionAttribute);
    geometry.setAttribute("normal", normalAttribute);
  };

  const growIndexBuffer = (requiredSlots: number) => {
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
  };

  return {
    object: mesh,
    update(nextTopology) {
      if (disposed) throw new Error("topology geometry adapter is disposed");
      const full = !sharedVertexChunkPrefix(topology, nextTopology);
      const previousVertexCount = topology.vertexCount;
      const nextVertexCount = nextTopology.vertexCount;
      let positionValuesUploaded = 0;
      let normalValuesUploaded = 0;
      let indexValuesUploaded = 0;
      let uploadRangeCount = 0;
      let bufferReplacementCount = 0;

      // Free slots of removed chunks and subtract their normals while their vertices are still in place.
      const affectedVertices = new Set<number>();
      const nextChunkSet = new Set(nextTopology.triangleChunks);
      const freedSlots: number[] = [];
      for (let slot = 0; slot < activeSlotCount; slot += 1) {
        const chunk = slotChunks[slot];
        if (chunk && !nextChunkSet.has(chunk)) {
          if (!full) accumulateChunkNormals(chunk, -1, positionArray, normalSums, affectedVertices);
          slotChunks[slot] = null;
          freedSlots.push(slot);
        }
      }

      let vertexBuffersReplaced = false;
      if (nextVertexCount > vertexCapacity) {
        growVertexBuffers(nextVertexCount);
        vertexBuffersReplaced = true;
        bufferReplacementCount += 2;
      }
      if (full) {
        writeVertexRange(positionArray, nextTopology, 0, nextVertexCount);
        if (!vertexBuffersReplaced) {
          positionAttribute.addUpdateRange(0, nextVertexCount * 3);
          positionAttribute.needsUpdate = true;
          positionValuesUploaded += nextVertexCount * 3;
          uploadRangeCount += 1;
        }
        bounds = boundsOf(positionArray, 0, nextVertexCount, new THREE.Box3());
      } else if (nextVertexCount > previousVertexCount) {
        writeVertexRange(positionArray, nextTopology, previousVertexCount, nextVertexCount);
        if (!vertexBuffersReplaced) {
          positionAttribute.addUpdateRange(previousVertexCount * 3, (nextVertexCount - previousVertexCount) * 3);
          positionAttribute.needsUpdate = true;
          positionValuesUploaded += (nextVertexCount - previousVertexCount) * 3;
          uploadRangeCount += 1;
        }
        bounds = boundsOf(positionArray, previousVertexCount, nextVertexCount, bounds);
      } else if (nextVertexCount < previousVertexCount) {
        // Dropped vertices are no longer referenced; clear residual sums so a later append starts clean.
        normalSums.fill(0, nextVertexCount * 3, previousVertexCount * 3);
        bounds = boundsOf(positionArray, 0, nextVertexCount, new THREE.Box3());
      }
      if (vertexBuffersReplaced) positionValuesUploaded += positionArray.length;

      let indexBufferReplaced = false;
      if (nextTopology.triangleChunks.length > indexSlotCapacity) {
        growIndexBuffer(nextTopology.triangleChunks.length);
        indexBufferReplaced = true;
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
            growIndexBuffer(activeSlotCount);
            indexBufferReplaced = true;
          }
        }
        chunkSlots.set(chunk, slot);
        slotChunks[slot] = chunk;
        writeIndexSlot(indexArray, slot, chunk);
        touchedSlots.add(slot);
        if (!full) accumulateChunkNormals(chunk, 1, positionArray, normalSums, affectedVertices);
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

      if (indexBufferReplaced) {
        bufferReplacementCount += 1;
        indexValuesUploaded += indexArray.length;
      } else if (touchedSlots.size > 0) {
        for (const slot of [...touchedSlots].sort((left, right) => left - right)) {
          indexAttribute.addUpdateRange(slot * INDEX_VALUES_PER_SLOT, INDEX_VALUES_PER_SLOT);
        }
        indexAttribute.needsUpdate = true;
        indexValuesUploaded += touchedSlots.size * INDEX_VALUES_PER_SLOT;
        uploadRangeCount += touchedSlots.size;
      }

      let normalVerticesRecomputed: number;
      if (full) {
        normalSums.fill(0);
        for (const chunk of nextTopology.triangleChunks) {
          accumulateChunkNormals(chunk, 1, positionArray, normalSums, null);
        }
        for (let vertexIndex = 0; vertexIndex < nextVertexCount; vertexIndex += 1) {
          normalizeVertexNormal(normalSums, normalArray, vertexIndex);
        }
        normalVerticesRecomputed = nextVertexCount;
        if (!vertexBuffersReplaced) {
          normalAttribute.addUpdateRange(0, nextVertexCount * 3);
          normalAttribute.needsUpdate = true;
          normalValuesUploaded += nextVertexCount * 3;
          uploadRangeCount += 1;
        }
      } else {
        const sorted = [...affectedVertices].filter((vertex) => vertex < nextVertexCount).sort((left, right) => left - right);
        for (const vertexIndex of sorted) normalizeVertexNormal(normalSums, normalArray, vertexIndex);
        normalVerticesRecomputed = sorted.length;
        if (!vertexBuffersReplaced && sorted.length > 0) {
          for (const [start, count] of vertexRanges(sorted)) {
            normalAttribute.addUpdateRange(start * 3, count * 3);
            normalValuesUploaded += count * 3;
            uploadRangeCount += 1;
          }
          normalAttribute.needsUpdate = true;
        }
      }
      if (vertexBuffersReplaced) normalValuesUploaded += normalArray.length;

      geometry.setDrawRange(0, activeSlotCount * INDEX_VALUES_PER_SLOT);
      geometry.boundingSphere = sphereOf(bounds);
      rebuildSemanticBases(nextTopology);
      topology = nextTopology;
      return {
        ...emptyTopologyRendererWork(),
        bufferReplacementCount,
        positionValuesUploaded,
        normalValuesUploaded,
        indexValuesUploaded,
        uploadRangeCount,
        normalVerticesRecomputed,
        fullPreparationCount: full ? 1 : 0,
        localizedGeometryUpdateCount: full ? 0 : 1,
      };
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
