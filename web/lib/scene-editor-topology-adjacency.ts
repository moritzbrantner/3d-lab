import type { PersistentMeshTopology } from "./scene-editor-topology-persistent";
import type { MeshEdge, MeshTopologyIndex } from "./scene-editor-topology";

const MAX_ADJACENCY_LAYER_DEPTH = 64;

type TriangleRef = Readonly<{
  chunk: Uint32Array;
  valueOffset: number;
}>;

type AdjacencyLayer = Readonly<{
  parent: AdjacencyLayer | null;
  overrides: ReadonlyMap<string, readonly TriangleRef[]>;
  depth: number;
}>;

export type PersistentAdjacencyObservations = Readonly<{
  buildCount: number;
  triangleVisits: number;
}>;

const adjacencyByTopology = new WeakMap<PersistentMeshTopology, AdjacencyLayer>();

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

function triangleEdges(chunk: Uint32Array, valueOffset: number): readonly string[] {
  const a = chunk[valueOffset];
  const b = chunk[valueOffset + 1];
  const c = chunk[valueOffset + 2];
  return [edgeKey([a, b]), edgeKey([b, c]), edgeKey([c, a])];
}

function buildAdjacency(topology: PersistentMeshTopology): Readonly<{
  layer: AdjacencyLayer;
  observations: PersistentAdjacencyObservations;
}> {
  const edgeTriangles = new Map<string, TriangleRef[]>();
  for (const chunk of topology.triangleChunks) {
    for (let valueOffset = 0; valueOffset < chunk.length; valueOffset += 3) {
      const ref: TriangleRef = { chunk, valueOffset };
      for (const key of triangleEdges(chunk, valueOffset)) {
        const refs = edgeTriangles.get(key);
        if (refs) refs.push(ref);
        else edgeTriangles.set(key, [ref]);
      }
    }
  }
  return {
    layer: { parent: null, overrides: edgeTriangles, depth: 0 },
    observations: { buildCount: 1, triangleVisits: topology.triangleCount },
  };
}

function lookup(layer: AdjacencyLayer, key: string): readonly TriangleRef[] {
  for (let current: AdjacencyLayer | null = layer; current; current = current.parent) {
    const value = current.overrides.get(key);
    if (value !== undefined) return value;
  }
  return [];
}

function globalTriangleIndex(topology: PersistentMeshTopology, ref: TriangleRef): number {
  let triangleBase = 0;
  for (const chunk of topology.triangleChunks) {
    if (chunk === ref.chunk) {
      if (ref.valueOffset < 0 || ref.valueOffset + 2 >= chunk.length || ref.valueOffset % 3 !== 0) {
        throw new Error("persistent adjacency reference is invalid");
      }
      return triangleBase + ref.valueOffset / 3;
    }
    triangleBase += chunk.length / 3;
  }
  throw new Error("persistent adjacency reference is stale");
}

export function persistentTopologyEdgeIndex(
  topology: PersistentMeshTopology,
  edge: MeshEdge,
): Readonly<{ index: MeshTopologyIndex; observations: PersistentAdjacencyObservations }> {
  let layer = adjacencyByTopology.get(topology);
  let observations: PersistentAdjacencyObservations = { buildCount: 0, triangleVisits: 0 };
  if (!layer) {
    const built = buildAdjacency(topology);
    layer = built.layer;
    observations = built.observations;
    adjacencyByTopology.set(topology, layer);
  }

  const key = edgeKey(edge);
  const triangleIndices = lookup(layer, key)
    .map((ref) => globalTriangleIndex(topology, ref))
    .sort((left, right) => left - right);
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

function scanChunks(chunks: readonly Uint32Array[]): Readonly<{
  edgeRefs: Map<string, TriangleRef[]>;
  edgeKeys: Set<string>;
  triangleVisits: number;
}> {
  const edgeRefs = new Map<string, TriangleRef[]>();
  const edgeKeys = new Set<string>();
  let triangleVisits = 0;
  for (const chunk of chunks) {
    for (let valueOffset = 0; valueOffset < chunk.length; valueOffset += 3) {
      triangleVisits += 1;
      const ref: TriangleRef = { chunk, valueOffset };
      for (const key of triangleEdges(chunk, valueOffset)) {
        edgeKeys.add(key);
        const refs = edgeRefs.get(key);
        if (refs) refs.push(ref);
        else edgeRefs.set(key, [ref]);
      }
    }
  }
  return { edgeRefs, edgeKeys, triangleVisits };
}

export function inheritPersistentTopologyAdjacency(
  before: PersistentMeshTopology,
  after: PersistentMeshTopology,
): PersistentAdjacencyObservations {
  const layer = adjacencyByTopology.get(before);
  if (!layer) return { buildCount: 0, triangleVisits: 0 };

  if (layer.depth >= MAX_ADJACENCY_LAYER_DEPTH) {
    const rebuilt = buildAdjacency(after);
    adjacencyByTopology.set(after, rebuilt.layer);
    return rebuilt.observations;
  }

  const beforeSet = new Set(before.triangleChunks);
  const afterSet = new Set(after.triangleChunks);
  const removedChunks = before.triangleChunks.filter((chunk) => !afterSet.has(chunk));
  const insertedChunks = after.triangleChunks.filter((chunk) => !beforeSet.has(chunk));
  if (removedChunks.length === 0 && insertedChunks.length === 0) {
    adjacencyByTopology.set(after, layer);
    return { buildCount: 0, triangleVisits: 0 };
  }

  const removed = scanChunks(removedChunks);
  const inserted = scanChunks(insertedChunks);
  const removedSet = new Set(removedChunks);
  const keys = new Set([...removed.edgeKeys, ...inserted.edgeKeys]);
  const overrides = new Map<string, readonly TriangleRef[]>();
  for (const key of keys) {
    const retained = lookup(layer, key).filter((ref) => !removedSet.has(ref.chunk));
    overrides.set(key, [...retained, ...(inserted.edgeRefs.get(key) ?? [])]);
  }
  adjacencyByTopology.set(after, { parent: layer, overrides, depth: layer.depth + 1 });
  return {
    buildCount: 0,
    triangleVisits: removed.triangleVisits + inserted.triangleVisits,
  };
}

export function hasPersistentTopologyAdjacency(topology: PersistentMeshTopology): boolean {
  return adjacencyByTopology.has(topology);
}
