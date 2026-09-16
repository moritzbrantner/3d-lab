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
const INDEX_VALUES_PER_CHUNK = TOPOLOGY_TRIANGLE_CHUNK_SIZE * 3;

export type PersistentMeshTopology = Readonly<{
  vertexChunks: readonly (readonly Vec3[])[];
  uvChunks?: readonly (readonly Vec2[])[];
  colorChunks?: readonly (readonly Color3[])[];
  triangleChunks: readonly Uint32Array[];
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

function chunksFromIndices(indices: readonly number[]): readonly Uint32Array[] {
  const chunks: Uint32Array[] = [];
  for (let start = 0; start < indices.length; start += INDEX_VALUES_PER_CHUNK) {
    const length = Math.min(INDEX_VALUES_PER_CHUNK, indices.length - start);
    const chunk = new Uint32Array(length);
    for (let offset = 0; offset < length; offset += 1) chunk[offset] = indices[start + offset];
    chunks.push(chunk);
  }
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

function locateTriangle(chunks: readonly Uint32Array[], triangleIndex: number): { chunkIndex: number; valueOffset: number } {
  if (!Number.isInteger(triangleIndex) || triangleIndex < 0) throw new Error(`triangle ${triangleIndex} is outside the mesh`);
  let remaining = triangleIndex;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const triangleCount = chunks[chunkIndex].length / 3;
    if (remaining < triangleCount) return { chunkIndex, valueOffset: remaining * 3 };
    remaining -= triangleCount;
  }
  throw new Error(`triangle ${triangleIndex} is outside the mesh`);
}

function triangleAtChunks(chunks: readonly Uint32Array[], triangleIndex: number): MeshTriangle {
  const { chunkIndex, valueOffset } = locateTriangle(chunks, triangleIndex);
  const chunk = chunks[chunkIndex];
  return [chunk[valueOffset], chunk[valueOffset + 1], chunk[valueOffset + 2]];
}

export function persistentTriangleAt(topology: PersistentMeshTopology, triangleIndex: number): MeshTriangle {
  return triangleAtChunks(topology.triangleChunks, triangleIndex);
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
    for (let offset = 0; offset < chunk.length; offset += 3) {
      const a = chunk[offset];
      const b = chunk[offset + 1];
      const c = chunk[offset + 2];
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

function writeLocalizedChunks(
  prefix: Uint32Array,
  replacement: readonly MeshTriangle[],
  suffix: Uint32Array,
): readonly Uint32Array[] {
  const totalLength = prefix.length + replacement.length * 3 + suffix.length;
  if (totalLength === 0) return [];
  const chunks: Uint32Array[] = [];
  for (let start = 0; start < totalLength; start += INDEX_VALUES_PER_CHUNK) {
    chunks.push(new Uint32Array(Math.min(INDEX_VALUES_PER_CHUNK, totalLength - start)));
  }
  let cursor = 0;
  const write = (value: number) => {
    const chunkIndex = Math.floor(cursor / INDEX_VALUES_PER_CHUNK);
    const valueOffset = cursor % INDEX_VALUES_PER_CHUNK;
    chunks[chunkIndex][valueOffset] = value;
    cursor += 1;
  };
  for (const value of prefix) write(value);
  for (const triangle of replacement) {
    write(triangle[0]);
    write(triangle[1]);
    write(triangle[2]);
  }
  for (const value of suffix) write(value);
  return chunks;
}

type SpanReplacementResult = Readonly<{
  chunks: readonly Uint32Array[];
  copiedIndexValueCount: number;
}>;

function replaceTriangleSpan(
  chunks: readonly Uint32Array[],
  startTriangle: number,
  expected: readonly MeshTriangle[],
  replacement: readonly MeshTriangle[],
): SpanReplacementResult {
  if (expected.length === 0) throw new Error("topology replacement must contain expected triangles");
  for (let index = 0; index < expected.length; index += 1) {
    if (!sameTuple(triangleAtChunks(chunks, startTriangle + index), expected[index])) {
      throw new Error(`topology command triangle precondition failed at triangle ${startTriangle}`);
    }
  }

  const first = locateTriangle(chunks, startTriangle);
  const last = locateTriangle(chunks, startTriangle + expected.length - 1);
  const prefix = chunks[first.chunkIndex].subarray(0, first.valueOffset);
  const suffix = chunks[last.chunkIndex].subarray(last.valueOffset + 3);
  const localized = writeLocalizedChunks(prefix, replacement, suffix);
  return {
    chunks: [...chunks.slice(0, first.chunkIndex), ...localized, ...chunks.slice(last.chunkIndex + 1)],
    copiedIndexValueCount: prefix.length + suffix.length,
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
      triangleCount: topology.triangleCount + delta.replacements.reduce((sum, item) => sum + item.after.length - item.before.length, 0),
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
    triangleCount: topology.triangleCount - delta.replacements.reduce((sum, item) => sum + item.after.length - item.before.length, 0),
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
  const violations = topologyStructuralBudgetViolations(operation, observations).filter(
    (violation) => violation !== "index copy exceeds source index count",
  );
  const maxLocalizedCopiedValues = INDEX_VALUES_PER_CHUNK * (operation.kind === "split-edge" ? 2 : 1);
  if (observations.indexValuesCopied > maxLocalizedCopiedValues) violations.push("localized index copy exceeds touched-chunk budget");
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
  const indices = new Array<number>(topology.triangleCount * 3);
  let indexCursor = 0;
  for (const chunk of topology.triangleChunks) {
    for (const value of chunk) indices[indexCursor++] = value;
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
