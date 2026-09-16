import type { PersistentMeshTopology } from "./scene-editor-topology-persistent";
import type { MeshEdge, MeshTopologyIndex } from "./scene-editor-topology";

const TRIANGLES_PER_CHUNK = 128;

type IncidenceCache = {
  vertexTriangles: Map<number, number[]>;
  chunkIds: WeakMap<Uint32Array, number>;
  chunksById: Map<number, Uint32Array>;
  nextChunkId: number;
};

export type PersistentAdjacencyObservations = Readonly<{
  buildCount: number;
  triangleVisits: number;
}>;

const incidenceByTopology = new WeakMap<PersistentMeshTopology, IncidenceCache>();

function normalizeEdge(edge: MeshEdge): MeshEdge {
  const [a, b] = edge;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a === b) {
    throw new Error(`invalid mesh edge ${a}:${b}`);
  }
  return a < b ? [a, b] : [b, a];
}

function edgeKey(edge: MeshEdge): string {
  const [a, b] = normalizeEdge(edge);
  return `${a}:${b}`;
}

function packedRef(chunkId: number, localTriangle: number): number {
  return chunkId * TRIANGLES_PER_CHUNK + localTriangle;
}

function unpackRef(value: number): Readonly<{ chunkId: number; localTriangle: number }> {
  return {
    chunkId: Math.floor(value / TRIANGLES_PER_CHUNK),
    localTriangle: value % TRIANGLES_PER_CHUNK,
  };
}

function appendIncidence(cache: IncidenceCache, vertex: number, ref: number): void {
  const refs = cache.vertexTriangles.get(vertex);
  if (refs) refs.push(ref);
  else cache.vertexTriangles.set(vertex, [ref]);
}

function removeIncidence(cache: IncidenceCache, vertex: number, ref: number): void {
  const refs = cache.vertexTriangles.get(vertex);
  if (!refs) throw new Error(`persistent adjacency is missing vertex ${vertex}`);
  const index = refs.indexOf(ref);
  if (index < 0) throw new Error(`persistent adjacency is missing triangle reference for vertex ${vertex}`);
  refs.splice(index, 1);
  if (refs.length === 0) cache.vertexTriangles.delete(vertex);
}

function registerChunk(cache: IncidenceCache, chunk: Uint32Array): number {
  const existing = cache.chunkIds.get(chunk);
  if (existing !== undefined) return existing;
  const chunkId = cache.nextChunkId;
  cache.nextChunkId += 1;
  cache.chunkIds.set(chunk, chunkId);
  cache.chunksById.set(chunkId, chunk);
  for (let valueOffset = 0; valueOffset < chunk.length; valueOffset += 3) {
    const ref = packedRef(chunkId, valueOffset / 3);
    appendIncidence(cache, chunk[valueOffset], ref);
    appendIncidence(cache, chunk[valueOffset + 1], ref);
    appendIncidence(cache, chunk[valueOffset + 2], ref);
  }
  return chunkId;
}

function unregisterChunk(cache: IncidenceCache, chunk: Uint32Array): void {
  const chunkId = cache.chunkIds.get(chunk);
  if (chunkId === undefined) throw new Error("persistent adjacency is missing a removed chunk");
  for (let valueOffset = 0; valueOffset < chunk.length; valueOffset += 3) {
    const ref = packedRef(chunkId, valueOffset / 3);
    removeIncidence(cache, chunk[valueOffset], ref);
    removeIncidence(cache, chunk[valueOffset + 1], ref);
    removeIncidence(cache, chunk[valueOffset + 2], ref);
  }
  cache.chunkIds.delete(chunk);
  cache.chunksById.delete(chunkId);
}

function buildIncidence(topology: PersistentMeshTopology): Readonly<{
  cache: IncidenceCache;
  observations: PersistentAdjacencyObservations;
}> {
  const cache: IncidenceCache = {
    vertexTriangles: new Map(),
    chunkIds: new WeakMap(),
    chunksById: new Map(),
    nextChunkId: 0,
  };
  for (const chunk of topology.triangleChunks) registerChunk(cache, chunk);
  return {
    cache,
    observations: { buildCount: 1, triangleVisits: topology.triangleCount },
  };
}

function globalTriangleIndex(topology: PersistentMeshTopology, cache: IncidenceCache, packed: number): number {
  const { chunkId, localTriangle } = unpackRef(packed);
  const target = cache.chunksById.get(chunkId);
  if (!target) throw new Error("persistent adjacency reference is stale");
  let triangleBase = 0;
  for (const chunk of topology.triangleChunks) {
    if (chunk === target) {
      if (localTriangle < 0 || localTriangle >= chunk.length / 3) {
        throw new Error("persistent adjacency reference is invalid");
      }
      return triangleBase + localTriangle;
    }
    triangleBase += chunk.length / 3;
  }
  throw new Error("persistent adjacency chunk is stale");
}

export function persistentTopologyEdgeIndex(
  topology: PersistentMeshTopology,
  edge: MeshEdge,
): Readonly<{ index: MeshTopologyIndex; observations: PersistentAdjacencyObservations }> {
  let cache = incidenceByTopology.get(topology);
  let observations: PersistentAdjacencyObservations = { buildCount: 0, triangleVisits: 0 };
  if (!cache) {
    const built = buildIncidence(topology);
    cache = built.cache;
    observations = built.observations;
    incidenceByTopology.set(topology, cache);
  }

  const [a, b] = normalizeEdge(edge);
  const aRefs = cache.vertexTriangles.get(a) ?? [];
  const bRefs = cache.vertexTriangles.get(b) ?? [];
  const smaller = aRefs.length <= bRefs.length ? aRefs : bRefs;
  const larger = smaller === aRefs ? bRefs : aRefs;
  const triangleIndices = smaller
    .filter((ref) => larger.includes(ref))
    .map((ref) => globalTriangleIndex(topology, cache, ref))
    .sort((left, right) => left - right);

  const key = edgeKey([a, b]);
  return {
    index: {
      edgeTriangles: new Map([[key, triangleIndices]]),
      observations: {
        triangleVisitCount: observations.triangleVisits,
        edgeReferenceCount: triangleIndices.length,
        uniqueEdgeCount: triangleIndices.length > 0 ? 1 : 0,
      },
    },
    observations,
  };
}

export function inheritPersistentTopologyAdjacency(
  before: PersistentMeshTopology,
  after: PersistentMeshTopology,
): PersistentAdjacencyObservations {
  const cache = incidenceByTopology.get(before);
  if (!cache) return { buildCount: 0, triangleVisits: 0 };

  const beforeSet = new Set(before.triangleChunks);
  const afterSet = new Set(after.triangleChunks);
  const removedChunks = before.triangleChunks.filter((chunk) => !afterSet.has(chunk));
  const insertedChunks = after.triangleChunks.filter((chunk) => !beforeSet.has(chunk));
  if (removedChunks.length === 0 && insertedChunks.length === 0) {
    incidenceByTopology.delete(before);
    incidenceByTopology.set(after, cache);
    return { buildCount: 0, triangleVisits: 0 };
  }

  let triangleVisits = 0;
  for (const chunk of removedChunks) {
    triangleVisits += chunk.length / 3;
    unregisterChunk(cache, chunk);
  }
  for (const chunk of insertedChunks) {
    triangleVisits += chunk.length / 3;
    registerChunk(cache, chunk);
  }
  incidenceByTopology.delete(before);
  incidenceByTopology.set(after, cache);
  return { buildCount: 0, triangleVisits };
}

export function hasPersistentTopologyAdjacency(topology: PersistentMeshTopology): boolean {
  return incidenceByTopology.has(topology);
}
