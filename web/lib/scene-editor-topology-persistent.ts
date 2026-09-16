import type { Color3, IndexedMesh, Vec2, Vec3 } from "./mesh";
import {
  MAX_EDGE_ADJACENT_TRIANGLES,
  MAX_FACE_EXTRUDE_DISTANCE,
  MAX_FACE_INSET_RATIO,
  MIN_FACE_EXTRUDE_DISTANCE,
  MIN_FACE_INSET_RATIO,
  topologyStructuralBudgetViolations,
  type MeshEdge,
  type MeshTopologyDelta,
  type MeshTopologyDerivedAttributes,
  type MeshTopologyEdit,
  type MeshTopologyIndex,
  type MeshTopologyOperation,
  type MeshTopologyWorkObservations,
  type MeshTriangle,
} from "./scene-editor-topology";

export const TOPOLOGY_TRIANGLE_CHUNK_SIZE = 128;

export type PersistentMeshTopology = Readonly<{
  vertexChunks: readonly (readonly Vec3[])[];
  uvChunks?: readonly (readonly Vec2[])[];
  colorChunks?: readonly (readonly Color3[])[];
  triangleChunks: readonly (readonly MeshTriangle[])[];
  vertexCount: number;
  triangleCount: number;
  derived: MeshTopologyDerivedAttributes;
}>;

export type PersistentTopologyEdit = Readonly<{
  topology: PersistentMeshTopology;
  delta: MeshTopologyDelta;
  observations: MeshTopologyWorkObservations;
}>;

export type MeshTopologyMaterializationObservations = Readonly<{
  vertexReferencesCopied: number;
  indexValuesCopied: number;
  authoredAttributeReferencesCopied: number;
  materializationCount: 1;
}>;

function sameTuple(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function cloneVec3(value: Vec3): Vec3 {
  return [value[0], value[1], value[2]];
}

function cloneVec2(value: Vec2): Vec2 {
  return [value[0], value[1]];
}

function cloneColor(value: Color3): Color3 {
  return [value[0], value[1], value[2]];
}

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

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(value: Vec3, factor: number): Vec3 {
  return [value[0] * factor, value[1] * factor, value[2] * factor];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(value: Vec3): Vec3 | null {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (length <= Number.EPSILON) return null;
  return [value[0] / length, value[1] / length, value[2] / length];
}

function midpoint3(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function midpoint2(a: Vec2, b: Vec2): Vec2 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function midpointColor(a: Color3, b: Color3): Color3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function centroid3(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
}

function centroid2(a: Vec2, b: Vec2, c: Vec2): Vec2 {
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
}

function centroidColor(a: Color3, b: Color3, c: Color3): Color3 {
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
}

function toward3(value: Vec3, center: Vec3, ratio: number): Vec3 {
  return add(value, scale(subtract(center, value), ratio));
}

function toward2(value: Vec2, center: Vec2, ratio: number): Vec2 {
  return [value[0] + (center[0] - value[0]) * ratio, value[1] + (center[1] - value[1]) * ratio];
}

function towardColor(value: Color3, center: Color3, ratio: number): Color3 {
  return [
    value[0] + (center[0] - value[0]) * ratio,
    value[1] + (center[1] - value[1]) * ratio,
    value[2] + (center[2] - value[2]) * ratio,
  ];
}

function chunksFromIndices(indices: readonly number[]): readonly (readonly MeshTriangle[])[] {
  const chunks: MeshTriangle[][] = [];
  let current: MeshTriangle[] = [];
  for (let index = 0; index < indices.length; index += 3) {
    if (current.length === TOPOLOGY_TRIANGLE_CHUNK_SIZE) {
      chunks.push(current);
      current = [];
    }
    current.push([indices[index], indices[index + 1], indices[index + 2]]);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function createPersistentMeshTopology(mesh: IndexedMesh): PersistentMeshTopology {
  return {
    vertexChunks: [mesh.vertices],
    uvChunks: mesh.attributes?.uvs ? [mesh.attributes.uvs] : undefined,
    colorChunks: mesh.attributes?.colors ? [mesh.attributes.colors] : undefined,
    triangleChunks: chunksFromIndices(mesh.indices),
    vertexCount: mesh.vertices.length,
    triangleCount: mesh.indices.length / 3,
    derived: { normals: mesh.attributes?.normals, tangents: mesh.attributes?.tangents },
  };
}

function valueFromChunks<T>(chunks: readonly (readonly T[])[], index: number, label: string): T {
  if (!Number.isInteger(index) || index < 0) throw new Error(`${label} ${index} is outside the mesh`);
  let offset = index;
  for (const chunk of chunks) {
    if (offset < chunk.length) return chunk[offset];
    offset -= chunk.length;
  }
  throw new Error(`${label} ${index} is outside the mesh`);
}

export function persistentVertexAt(topology: PersistentMeshTopology, vertexIndex: number): Vec3 {
  return valueFromChunks(topology.vertexChunks, vertexIndex, "vertex");
}

export function persistentTriangleAt(topology: PersistentMeshTopology, triangleIndex: number): MeshTriangle {
  return valueFromChunks(topology.triangleChunks, triangleIndex, "triangle");
}

function uvAt(topology: PersistentMeshTopology, vertexIndex: number): Vec2 | undefined {
  return topology.uvChunks ? valueFromChunks(topology.uvChunks, vertexIndex, "uv") : undefined;
}

function colorAt(topology: PersistentMeshTopology, vertexIndex: number): Color3 | undefined {
  return topology.colorChunks ? valueFromChunks(topology.colorChunks, vertexIndex, "color") : undefined;
}

export function createPersistentMeshTopologyIndex(topology: PersistentMeshTopology): MeshTopologyIndex {
  const edgeTriangles = new Map<string, number[]>();
  let triangleIndex = 0;
  for (const chunk of topology.triangleChunks) {
    for (const [a, b, c] of chunk) {
      const edges: readonly MeshEdge[] = [[a, b], [b, c], [c, a]];
      for (const edge of edges) {
        const key = edgeKey(edge);
        const triangles = edgeTriangles.get(key);
        if (triangles) triangles.push(triangleIndex);
        else edgeTriangles.set(key, [triangleIndex]);
      }
      triangleIndex += 1;
    }
  }
  return {
    edgeTriangles,
    observations: {
      triangleVisitCount: topology.triangleCount,
      edgeReferenceCount: topology.triangleCount * 3,
      uniqueEdgeCount: edgeTriangles.size,
    },
  };
}

function splitTriangleAlongEdge(triangle: MeshTriangle, edge: MeshEdge, midpointIndex: number): readonly MeshTriangle[] {
  const [a, b, c] = triangle;
  const [x, y] = normalizeEdge(edge);
  const matches = (left: number, right: number) => (left === x && right === y) || (left === y && right === x);
  if (matches(a, b)) return [[a, midpointIndex, c], [midpointIndex, b, c]];
  if (matches(b, c)) return [[b, midpointIndex, a], [midpointIndex, c, a]];
  if (matches(c, a)) return [[c, midpointIndex, b], [midpointIndex, a, b]];
  throw new Error(`triangle ${a},${b},${c} does not contain edge ${x}:${y}`);
}

function withAfterStarts(
  replacements: readonly { beforeStartTriangle: number; before: readonly MeshTriangle[]; after: readonly MeshTriangle[] }[],
): MeshTopologyDelta["replacements"] {
  let offset = 0;
  return [...replacements]
    .sort((left, right) => left.beforeStartTriangle - right.beforeStartTriangle)
    .map((replacement) => {
      const result = { ...replacement, afterStartTriangle: replacement.beforeStartTriangle + offset };
      offset += replacement.after.length - replacement.before.length;
      return result;
    });
}

function splitTriangleChunk(chunk: readonly MeshTriangle[]): readonly (readonly MeshTriangle[])[] {
  if (chunk.length <= TOPOLOGY_TRIANGLE_CHUNK_SIZE) return chunk.length === 0 ? [] : [chunk];
  const chunks: MeshTriangle[][] = [];
  for (let start = 0; start < chunk.length; start += TOPOLOGY_TRIANGLE_CHUNK_SIZE) {
    chunks.push(chunk.slice(start, start + TOPOLOGY_TRIANGLE_CHUNK_SIZE));
  }
  return chunks;
}

type SpanReplacementResult = Readonly<{
  chunks: readonly (readonly MeshTriangle[])[];
  copiedIndexValueCount: number;
}>;

function replaceTriangleSpan(
  chunks: readonly (readonly MeshTriangle[])[],
  startTriangle: number,
  expected: readonly MeshTriangle[],
  replacement: readonly MeshTriangle[],
): SpanReplacementResult {
  let remainingStart = startTriangle;
  let firstChunkIndex = -1;
  let firstOffset = -1;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    if (remainingStart < chunk.length) {
      firstChunkIndex = chunkIndex;
      firstOffset = remainingStart;
      break;
    }
    remainingStart -= chunk.length;
  }
  if (firstChunkIndex < 0) throw new Error(`topology command triangle precondition failed at triangle ${startTriangle}`);

  const prefix = chunks[firstChunkIndex].slice(0, firstOffset);
  const encountered: MeshTriangle[] = [];
  let chunkIndex = firstChunkIndex;
  let offset = firstOffset;
  while (encountered.length < expected.length) {
    const chunk = chunks[chunkIndex];
    if (!chunk) throw new Error(`topology command triangle precondition failed at triangle ${startTriangle}`);
    while (offset < chunk.length && encountered.length < expected.length) {
      encountered.push(chunk[offset]);
      offset += 1;
    }
    if (encountered.length < expected.length) {
      chunkIndex += 1;
      offset = 0;
    }
  }
  if (encountered.length !== expected.length || encountered.some((triangle, index) => !sameTuple(triangle, expected[index]))) {
    throw new Error(`topology command triangle precondition failed at triangle ${startTriangle}`);
  }
  const suffix = chunks[chunkIndex].slice(offset);
  const combined = [...prefix, ...replacement, ...suffix];
  return {
    chunks: [
      ...chunks.slice(0, firstChunkIndex),
      ...splitTriangleChunk(combined),
      ...chunks.slice(chunkIndex + 1),
    ],
    copiedIndexValueCount: (prefix.length + suffix.length) * 3,
  };
}

function appendChunk<T>(chunks: readonly (readonly T[])[] | undefined, appended: readonly T[] | undefined): readonly (readonly T[])[] | undefined {
  if (!chunks) {
    if (appended && appended.length > 0) throw new Error("topology authored-attribute precondition failed");
    return undefined;
  }
  if (!appended || appended.length === 0) return chunks;
  return [...chunks, appended];
}

function removeLastChunk<T>(chunks: readonly (readonly T[])[] | undefined, expected: readonly T[] | undefined): readonly (readonly T[])[] | undefined {
  if (!expected || expected.length === 0) return chunks;
  if (!chunks || chunks.length === 0) throw new Error("topology authored-attribute precondition failed");
  const last = chunks[chunks.length - 1];
  if (last.length !== expected.length || last.some((value, index) => !sameTuple(value as readonly number[], expected[index] as readonly number[]))) {
    throw new Error("topology appended-attribute precondition failed");
  }
  return chunks.length === 1 ? [] : chunks.slice(0, -1);
}

export function applyPersistentMeshTopologyDelta(
  topology: PersistentMeshTopology,
  delta: MeshTopologyDelta,
  direction: "forward" | "reverse",
): PersistentMeshTopology {
  if (direction === "forward" && topology.vertexCount !== delta.beforeVertexCount) {
    throw new Error("topology command vertex-count precondition failed");
  }
  if (direction === "reverse" && topology.vertexCount !== delta.beforeVertexCount + delta.appendedVertices.length) {
    throw new Error("topology command vertex-count precondition failed");
  }

  let triangleChunks = topology.triangleChunks;
  if (direction === "forward") {
    let shift = 0;
    for (const replacement of delta.replacements) {
      const result = replaceTriangleSpan(triangleChunks, replacement.beforeStartTriangle + shift, replacement.before, replacement.after);
      triangleChunks = result.chunks;
      shift += replacement.after.length - replacement.before.length;
    }
    return {
      vertexChunks: delta.appendedVertices.length > 0 ? [...topology.vertexChunks, delta.appendedVertices] : topology.vertexChunks,
      uvChunks: appendChunk(topology.uvChunks, delta.appendedUvs),
      colorChunks: appendChunk(topology.colorChunks, delta.appendedColors),
      triangleChunks,
      vertexCount: topology.vertexCount + delta.appendedVertices.length,
      triangleCount: topology.triangleCount + delta.replacements.reduce((sum, replacement) => sum + replacement.after.length - replacement.before.length, 0),
      derived: {},
    };
  }

  for (const replacement of [...delta.replacements].reverse()) {
    const result = replaceTriangleSpan(triangleChunks, replacement.afterStartTriangle, replacement.after, replacement.before);
    triangleChunks = result.chunks;
  }
  const lastVertices = topology.vertexChunks[topology.vertexChunks.length - 1];
  if (
    delta.appendedVertices.length > 0 &&
    (!lastVertices || lastVertices.length !== delta.appendedVertices.length || lastVertices.some((value, index) => !sameTuple(value, delta.appendedVertices[index])))
  ) {
    throw new Error("topology command appended-vertex precondition failed");
  }
  return {
    vertexChunks: delta.appendedVertices.length > 0 ? topology.vertexChunks.slice(0, -1) : topology.vertexChunks,
    uvChunks: removeLastChunk(topology.uvChunks, delta.appendedUvs),
    colorChunks: removeLastChunk(topology.colorChunks, delta.appendedColors),
    triangleChunks,
    vertexCount: delta.beforeVertexCount,
    triangleCount: topology.triangleCount - delta.replacements.reduce((sum, replacement) => sum + replacement.after.length - replacement.before.length, 0),
    derived: delta.beforeDerived,
  };
}

function operationObservations(
  topology: PersistentMeshTopology,
  delta: MeshTopologyDelta,
  copiedIndexValueCount: number,
  topologyIndexBuildCount: number,
  topologyIndexTriangleVisits: number,
): MeshTopologyWorkObservations {
  const affectedTriangleCount = delta.replacements.reduce((sum, replacement) => sum + replacement.before.length, 0);
  const writtenTriangleCount = delta.replacements.reduce((sum, replacement) => sum + replacement.after.length, 0);
  return {
    sourceVertexCount: topology.vertexCount,
    sourceTriangleCount: topology.triangleCount,
    affectedTriangleCount,
    createdVertexCount: delta.appendedVertices.length,
    resultVertexCount: topology.vertexCount + delta.appendedVertices.length,
    resultTriangleCount: topology.triangleCount + delta.replacements.reduce((sum, replacement) => sum + replacement.after.length - replacement.before.length, 0),
    vertexReferenceCopyPassCount: 0,
    vertexReferencesCopied: 0,
    indexCopyPassCount: copiedIndexValueCount > 0 ? 1 : 0,
    indexValuesCopied: copiedIndexValueCount,
    indexValuesWritten: writtenTriangleCount * 3,
    authoredAttributeReferencesCopied: 0,
    authoredAttributeValuesCreated: delta.appendedVertices.length * (Number(topology.uvChunks !== undefined) + Number(topology.colorChunks !== undefined)),
    topologyIndexBuildCount,
    topologyIndexTriangleVisits,
  };
}

function finalizePersistentEdit(
  topology: PersistentMeshTopology,
  operation: MeshTopologyOperation,
  appendedVertices: readonly Vec3[],
  replacements: readonly { beforeStartTriangle: number; before: readonly MeshTriangle[]; after: readonly MeshTriangle[] }[],
  appendedUvs: readonly Vec2[] | undefined,
  appendedColors: readonly Color3[] | undefined,
  topologyIndexBuildCount: number,
  topologyIndexTriangleVisits: number,
): PersistentTopologyEdit {
  const delta: MeshTopologyDelta = {
    operation,
    beforeVertexCount: topology.vertexCount,
    appendedVertices,
    appendedUvs,
    appendedColors,
    beforeDerived: topology.derived,
    replacements: withAfterStarts(replacements),
  };

  let scratch = topology.triangleChunks;
  let copiedIndexValueCount = 0;
  let shift = 0;
  for (const replacement of delta.replacements) {
    const result = replaceTriangleSpan(scratch, replacement.beforeStartTriangle + shift, replacement.before, replacement.after);
    scratch = result.chunks;
    copiedIndexValueCount += result.copiedIndexValueCount;
    shift += replacement.after.length - replacement.before.length;
  }
  const observations = operationObservations(topology, delta, copiedIndexValueCount, topologyIndexBuildCount, topologyIndexTriangleVisits);
  // The legacy source-index bound describes a single flat-array copy. Persistent storage intentionally
  // replaces it with a touched-chunk bound; on tiny meshes two adjacent replacements can revisit the same
  // local chunk while still remaining strictly bounded and independent of total mesh size.
  const violations = topologyStructuralBudgetViolations(operation, observations).filter(
    (violation) => violation !== "index copy exceeds source index count",
  );
  const maxLocalizedCopiedValues = TOPOLOGY_TRIANGLE_CHUNK_SIZE * 3 * (operation.kind === "split-edge" ? 2 : 1);
  if (observations.indexValuesCopied > maxLocalizedCopiedValues) {
    violations.push("localized index copy exceeds touched-chunk budget");
  }
  if (observations.vertexReferencesCopied !== 0) violations.push("persistent topology copied source vertex references");
  if (observations.authoredAttributeReferencesCopied !== 0) violations.push("persistent topology copied authored attribute references");
  if (violations.length > 0) throw new Error(`topology structural budget violated: ${violations.join("; ")}`);
  return { topology: applyPersistentMeshTopologyDelta(topology, delta, "forward"), delta, observations };
}

export function performPersistentMeshTopologyOperation(
  topology: PersistentMeshTopology,
  operation: MeshTopologyOperation,
  topologyIndex?: MeshTopologyIndex,
): PersistentTopologyEdit {
  if (operation.kind === "split-edge") {
    const edge = normalizeEdge(operation.edge);
    const [a, b] = edge;
    const va = persistentVertexAt(topology, a);
    const vb = persistentVertexAt(topology, b);
    const index = topologyIndex ?? createPersistentMeshTopologyIndex(topology);
    const adjacentTriangles = index.edgeTriangles.get(edgeKey(edge)) ?? [];
    if (adjacentTriangles.length === 0) throw new Error(`edge ${a}:${b} is not referenced by any triangle`);
    if (adjacentTriangles.length > MAX_EDGE_ADJACENT_TRIANGLES) {
      throw new Error(`edge ${a}:${b} is non-manifold with ${adjacentTriangles.length} adjacent triangles`);
    }
    const midpointIndex = topology.vertexCount;
    const replacements = adjacentTriangles.map((triangleIndex) => {
      const before = persistentTriangleAt(topology, triangleIndex);
      return { beforeStartTriangle: triangleIndex, before: [before], after: splitTriangleAlongEdge(before, edge, midpointIndex) };
    });
    const uvA = uvAt(topology, a);
    const uvB = uvAt(topology, b);
    const colorA = colorAt(topology, a);
    const colorB = colorAt(topology, b);
    return finalizePersistentEdit(
      topology,
      { kind: "split-edge", edge },
      [midpoint3(va, vb)],
      replacements,
      uvA && uvB ? [midpoint2(uvA, uvB)] : undefined,
      colorA && colorB ? [midpointColor(colorA, colorB)] : undefined,
      topologyIndex ? 0 : 1,
      topologyIndex ? 0 : index.observations.triangleVisitCount,
    );
  }

  if (operation.kind === "inset-face") {
    const { triangleIndex, ratio } = operation;
    if (!Number.isFinite(ratio) || ratio < MIN_FACE_INSET_RATIO || ratio > MAX_FACE_INSET_RATIO) {
      throw new Error(`inset ratio must be from ${MIN_FACE_INSET_RATIO} to ${MAX_FACE_INSET_RATIO}`);
    }
    const [a, b, c] = persistentTriangleAt(topology, triangleIndex);
    const va = persistentVertexAt(topology, a);
    const vb = persistentVertexAt(topology, b);
    const vc = persistentVertexAt(topology, c);
    const center = centroid3(va, vb, vc);
    const ia = topology.vertexCount;
    const ib = ia + 1;
    const ic = ia + 2;
    const after: readonly MeshTriangle[] = [[a, b, ib], [a, ib, ia], [b, c, ic], [b, ic, ib], [c, a, ia], [c, ia, ic], [ia, ib, ic]];
    const uvA = uvAt(topology, a);
    const uvB = uvAt(topology, b);
    const uvC = uvAt(topology, c);
    const colorA = colorAt(topology, a);
    const colorB = colorAt(topology, b);
    const colorC = colorAt(topology, c);
    const uvCenter = uvA && uvB && uvC ? centroid2(uvA, uvB, uvC) : null;
    const colorCenter = colorA && colorB && colorC ? centroidColor(colorA, colorB, colorC) : null;
    return finalizePersistentEdit(
      topology,
      operation,
      [toward3(va, center, ratio), toward3(vb, center, ratio), toward3(vc, center, ratio)],
      [{ beforeStartTriangle: triangleIndex, before: [[a, b, c]], after }],
      uvA && uvB && uvC && uvCenter ? [toward2(uvA, uvCenter, ratio), toward2(uvB, uvCenter, ratio), toward2(uvC, uvCenter, ratio)] : undefined,
      colorA && colorB && colorC && colorCenter
        ? [towardColor(colorA, colorCenter, ratio), towardColor(colorB, colorCenter, ratio), towardColor(colorC, colorCenter, ratio)]
        : undefined,
      0,
      0,
    );
  }

  const { triangleIndex, distance } = operation;
  if (!Number.isFinite(distance) || distance < MIN_FACE_EXTRUDE_DISTANCE || distance > MAX_FACE_EXTRUDE_DISTANCE) {
    throw new Error(`extrude distance must be from ${MIN_FACE_EXTRUDE_DISTANCE} to ${MAX_FACE_EXTRUDE_DISTANCE}`);
  }
  const [a, b, c] = persistentTriangleAt(topology, triangleIndex);
  const va = persistentVertexAt(topology, a);
  const vb = persistentVertexAt(topology, b);
  const vc = persistentVertexAt(topology, c);
  const normal = normalize(cross(subtract(vb, va), subtract(vc, va)));
  if (!normal) throw new Error(`triangle ${triangleIndex} is degenerate and cannot be extruded`);
  const offset = scale(normal, distance);
  const ia = topology.vertexCount;
  const ib = ia + 1;
  const ic = ia + 2;
  const after: readonly MeshTriangle[] = [[ia, ib, ic], [a, b, ib], [a, ib, ia], [b, c, ic], [b, ic, ib], [c, a, ia], [c, ia, ic]];
  const uvA = uvAt(topology, a);
  const uvB = uvAt(topology, b);
  const uvC = uvAt(topology, c);
  const colorA = colorAt(topology, a);
  const colorB = colorAt(topology, b);
  const colorC = colorAt(topology, c);
  return finalizePersistentEdit(
    topology,
    operation,
    [add(va, offset), add(vb, offset), add(vc, offset)],
    [{ beforeStartTriangle: triangleIndex, before: [[a, b, c]], after }],
    uvA && uvB && uvC ? [cloneVec2(uvA), cloneVec2(uvB), cloneVec2(uvC)] : undefined,
    colorA && colorB && colorC ? [cloneColor(colorA), cloneColor(colorB), cloneColor(colorC)] : undefined,
    0,
    0,
  );
}

function flattenChunks<T>(chunks: readonly (readonly T[])[]): T[] {
  const values: T[] = [];
  for (const chunk of chunks) values.push(...chunk);
  return values;
}

export function materializePersistentMeshTopology(
  topology: PersistentMeshTopology,
): Readonly<{ mesh: IndexedMesh; observations: MeshTopologyMaterializationObservations }> {
  const vertices = flattenChunks(topology.vertexChunks);
  const indices: number[] = [];
  for (const chunk of topology.triangleChunks) {
    for (const triangle of chunk) indices.push(triangle[0], triangle[1], triangle[2]);
  }
  const uvs = topology.uvChunks ? flattenChunks(topology.uvChunks) : undefined;
  const colors = topology.colorChunks ? flattenChunks(topology.colorChunks) : undefined;
  const { normals, tangents } = topology.derived;
  const attributes = normals || tangents || uvs || colors ? { normals, tangents, uvs, colors } : undefined;
  return {
    mesh: { vertices, indices, attributes },
    observations: {
      vertexReferencesCopied: topology.vertexCount,
      indexValuesCopied: topology.triangleCount * 3,
      authoredAttributeReferencesCopied: topology.vertexCount * (Number(uvs !== undefined) + Number(colors !== undefined)),
      materializationCount: 1,
    },
  };
}

export function persistentTopologyAsLegacyEdit(edit: PersistentTopologyEdit): MeshTopologyEdit {
  return { mesh: materializePersistentMeshTopology(edit.topology).mesh, delta: edit.delta, observations: edit.observations };
}
