import type { Color3, IndexedMesh, Vec2, Vec3, Vec4 } from "./mesh";

export type MeshEdge = readonly [number, number];
export type MeshTriangle = readonly [number, number, number];

export type MeshTopologyOperation =
  | Readonly<{ kind: "split-edge"; edge: MeshEdge }>
  | Readonly<{ kind: "inset-face"; triangleIndex: number; ratio: number }>
  | Readonly<{ kind: "extrude-face"; triangleIndex: number; distance: number }>;

export type MeshTopologyIndexObservations = Readonly<{
  triangleVisitCount: number;
  edgeReferenceCount: number;
  uniqueEdgeCount: number;
}>;

export type MeshTopologyIndex = Readonly<{
  edgeTriangles: ReadonlyMap<string, readonly number[]>;
  observations: MeshTopologyIndexObservations;
}>;

export type MeshTopologyWorkObservations = Readonly<{
  sourceVertexCount: number;
  sourceTriangleCount: number;
  affectedTriangleCount: number;
  createdVertexCount: number;
  resultVertexCount: number;
  resultTriangleCount: number;
  vertexReferenceCopyPassCount: number;
  vertexReferencesCopied: number;
  indexCopyPassCount: number;
  indexValuesCopied: number;
  indexValuesWritten: number;
  authoredAttributeReferencesCopied: number;
  authoredAttributeValuesCreated: number;
  topologyIndexBuildCount: number;
  topologyIndexTriangleVisits: number;
}>;

export type MeshTopologyDerivedAttributes = Readonly<{
  normals?: readonly Vec3[];
  tangents?: readonly Vec4[];
}>;

type TriangleReplacement = Readonly<{
  beforeStartTriangle: number;
  afterStartTriangle: number;
  before: readonly MeshTriangle[];
  after: readonly MeshTriangle[];
}>;

export type MeshTopologyDelta = Readonly<{
  operation: MeshTopologyOperation;
  beforeVertexCount: number;
  appendedVertices: readonly Vec3[];
  appendedUvs?: readonly Vec2[];
  appendedColors?: readonly Color3[];
  beforeDerived: MeshTopologyDerivedAttributes;
  replacements: readonly TriangleReplacement[];
}>;

export type MeshTopologyEdit = Readonly<{
  mesh: IndexedMesh;
  delta: MeshTopologyDelta;
  observations: MeshTopologyWorkObservations;
}>;

export const MAX_EDGE_ADJACENT_TRIANGLES = 2;
export const MIN_FACE_INSET_RATIO = 0.05;
export const MAX_FACE_INSET_RATIO = 0.9;
export const MIN_FACE_EXTRUDE_DISTANCE = 0.001;
export const MAX_FACE_EXTRUDE_DISTANCE = 10;

function edgeKey(edge: MeshEdge): string {
  const [a, b] = normalizeEdge(edge);
  return `${a}:${b}`;
}

function normalizeEdge(edge: MeshEdge): MeshEdge {
  const [a, b] = edge;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a === b) {
    throw new Error(`invalid mesh edge ${a}:${b}`);
  }
  return a < b ? [a, b] : [b, a];
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

function sameTuple(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function triangleAt(mesh: IndexedMesh, triangleIndex: number): MeshTriangle {
  const triangleCount = mesh.indices.length / 3;
  if (!Number.isInteger(triangleIndex) || triangleIndex < 0 || triangleIndex >= triangleCount) {
    throw new Error(`triangle ${triangleIndex} is outside the mesh`);
  }
  const start = triangleIndex * 3;
  return [mesh.indices[start], mesh.indices[start + 1], mesh.indices[start + 2]];
}

function vertexAt(mesh: IndexedMesh, index: number): Vec3 {
  const vertex = mesh.vertices[index];
  if (!vertex) throw new Error(`vertex ${index} is outside the mesh`);
  return vertex;
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

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
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

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function midpointVec2(a: Vec2, b: Vec2): Vec2 {
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

export function createMeshTopologyIndex(mesh: IndexedMesh): MeshTopologyIndex {
  const edgeTriangles = new Map<string, number[]>();
  const triangleCount = mesh.indices.length / 3;
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const [a, b, c] = triangleAt(mesh, triangleIndex);
    const edges: readonly MeshEdge[] = [
      [a, b],
      [b, c],
      [c, a],
    ];
    for (const edge of edges) {
      const key = edgeKey(edge);
      const triangles = edgeTriangles.get(key);
      if (triangles) triangles.push(triangleIndex);
      else edgeTriangles.set(key, [triangleIndex]);
    }
  }
  return {
    edgeTriangles,
    observations: {
      triangleVisitCount: triangleCount,
      edgeReferenceCount: triangleCount * 3,
      uniqueEdgeCount: edgeTriangles.size,
    },
  };
}

function pointSegmentDistanceSquared(point: Vec3, a: Vec3, b: Vec3): number {
  const ab = subtract(b, a);
  const denominator = dot(ab, ab);
  if (denominator <= Number.EPSILON) return dot(subtract(point, a), subtract(point, a));
  const t = Math.max(0, Math.min(1, dot(subtract(point, a), ab) / denominator));
  const closest = add(a, scale(ab, t));
  const delta = subtract(point, closest);
  return dot(delta, delta);
}

export function nearestTriangleEdge(mesh: IndexedMesh, triangleIndex: number, localPoint: Vec3): MeshEdge {
  const [a, b, c] = triangleAt(mesh, triangleIndex);
  const candidates: readonly MeshEdge[] = [
    [a, b],
    [b, c],
    [c, a],
  ];
  let best = normalizeEdge(candidates[0]);
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const edge of candidates) {
    const distance = pointSegmentDistanceSquared(localPoint, vertexAt(mesh, edge[0]), vertexAt(mesh, edge[1]));
    const normalized = normalizeEdge(edge);
    if (distance < bestDistance || (distance === bestDistance && edgeKey(normalized) < edgeKey(best))) {
      best = normalized;
      bestDistance = distance;
    }
  }
  return best;
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
  replacements: readonly Omit<TriangleReplacement, "afterStartTriangle">[],
): readonly TriangleReplacement[] {
  let offset = 0;
  return [...replacements]
    .sort((left, right) => left.beforeStartTriangle - right.beforeStartTriangle)
    .map((replacement) => {
      const result: TriangleReplacement = {
        ...replacement,
        afterStartTriangle: replacement.beforeStartTriangle + offset,
      };
      offset += replacement.after.length - replacement.before.length;
      return result;
    });
}

function derivedAttributes(mesh: IndexedMesh): MeshTopologyDerivedAttributes {
  return {
    normals: mesh.attributes?.normals,
    tangents: mesh.attributes?.tangents,
  };
}

function replaceTriangleSpans(
  indices: readonly number[],
  replacements: readonly TriangleReplacement[],
  direction: "forward" | "reverse",
): number[] {
  const spans = replacements.map((replacement) => ({
    start: direction === "forward" ? replacement.beforeStartTriangle : replacement.afterStartTriangle,
    expected: direction === "forward" ? replacement.before : replacement.after,
    replacement: direction === "forward" ? replacement.after : replacement.before,
  }));
  const output: number[] = [];
  let sourceIndex = 0;
  for (const span of spans) {
    const startIndex = span.start * 3;
    while (sourceIndex < startIndex) output.push(indices[sourceIndex++]);
    for (const expectedTriangle of span.expected) {
      const current: MeshTriangle = [indices[sourceIndex], indices[sourceIndex + 1], indices[sourceIndex + 2]];
      if (!sameTuple(current, expectedTriangle)) {
        throw new Error(`topology command triangle precondition failed at triangle ${span.start}`);
      }
      sourceIndex += 3;
    }
    for (const triangle of span.replacement) output.push(triangle[0], triangle[1], triangle[2]);
  }
  while (sourceIndex < indices.length) output.push(indices[sourceIndex++]);
  return output;
}

function buildAttributes(
  mesh: IndexedMesh,
  delta: MeshTopologyDelta,
  direction: "forward" | "reverse",
): IndexedMesh["attributes"] {
  const source = mesh.attributes;
  if (direction === "forward") {
    if (delta.appendedUvs && !source?.uvs) throw new Error("topology UV precondition failed");
    if (delta.appendedColors && !source?.colors) throw new Error("topology color precondition failed");
    const uvs = source?.uvs ? [...source.uvs, ...(delta.appendedUvs ?? [])] : undefined;
    const colors = source?.colors ? [...source.colors, ...(delta.appendedColors ?? [])] : undefined;
    if (!uvs && !colors) return undefined;
    return { uvs, colors };
  }

  const uvs = source?.uvs?.slice(0, delta.beforeVertexCount);
  const colors = source?.colors?.slice(0, delta.beforeVertexCount);
  const { normals, tangents } = delta.beforeDerived;
  if (!normals && !tangents && !uvs && !colors) return undefined;
  return { normals, tangents, uvs, colors };
}

function verifyAppendedVertexPrecondition(mesh: IndexedMesh, delta: MeshTopologyDelta): void {
  if (mesh.vertices.length !== delta.beforeVertexCount + delta.appendedVertices.length) {
    throw new Error("topology command vertex-count precondition failed");
  }
  delta.appendedVertices.forEach((vertex, offset) => {
    if (!sameTuple(mesh.vertices[delta.beforeVertexCount + offset], vertex)) {
      throw new Error(`topology command appended-vertex precondition failed at ${offset}`);
    }
  });
}

export function applyMeshTopologyDelta(
  mesh: IndexedMesh,
  delta: MeshTopologyDelta,
  direction: "forward" | "reverse",
): IndexedMesh {
  if (direction === "forward") {
    if (mesh.vertices.length !== delta.beforeVertexCount) {
      throw new Error("topology command vertex-count precondition failed");
    }
    return {
      vertices: [...mesh.vertices, ...delta.appendedVertices],
      indices: replaceTriangleSpans(mesh.indices, delta.replacements, "forward"),
      attributes: buildAttributes(mesh, delta, "forward"),
    };
  }

  verifyAppendedVertexPrecondition(mesh, delta);
  return {
    vertices: mesh.vertices.slice(0, delta.beforeVertexCount),
    indices: replaceTriangleSpans(mesh.indices, delta.replacements, "reverse"),
    attributes: buildAttributes(mesh, delta, "reverse"),
  };
}

function observationsFor(
  mesh: IndexedMesh,
  delta: MeshTopologyDelta,
  topologyIndexBuildCount: number,
  topologyIndexTriangleVisits: number,
): MeshTopologyWorkObservations {
  const affectedTriangleCount = delta.replacements.reduce((sum, replacement) => sum + replacement.before.length, 0);
  const writtenTriangleCount = delta.replacements.reduce((sum, replacement) => sum + replacement.after.length, 0);
  const authoredAttributeCount = Number(mesh.attributes?.uvs !== undefined) + Number(mesh.attributes?.colors !== undefined);
  const resultTriangleCount =
    mesh.indices.length / 3 +
    delta.replacements.reduce((sum, replacement) => sum + replacement.after.length - replacement.before.length, 0);
  return {
    sourceVertexCount: mesh.vertices.length,
    sourceTriangleCount: mesh.indices.length / 3,
    affectedTriangleCount,
    createdVertexCount: delta.appendedVertices.length,
    resultVertexCount: mesh.vertices.length + delta.appendedVertices.length,
    resultTriangleCount,
    vertexReferenceCopyPassCount: 1,
    vertexReferencesCopied: mesh.vertices.length,
    indexCopyPassCount: 1,
    indexValuesCopied: mesh.indices.length - affectedTriangleCount * 3,
    indexValuesWritten: writtenTriangleCount * 3,
    authoredAttributeReferencesCopied: mesh.vertices.length * authoredAttributeCount,
    authoredAttributeValuesCreated: delta.appendedVertices.length * authoredAttributeCount,
    topologyIndexBuildCount,
    topologyIndexTriangleVisits,
  };
}

export function topologyStructuralBudgetViolations(
  operation: MeshTopologyOperation,
  observations: MeshTopologyWorkObservations,
): string[] {
  const violations: string[] = [];
  const maxAffectedTriangles = operation.kind === "split-edge" ? 2 : 1;
  const maxCreatedVertices = operation.kind === "split-edge" ? 1 : 3;
  const maxWrittenTriangles = operation.kind === "split-edge" ? 4 : 7;
  if (observations.affectedTriangleCount > maxAffectedTriangles) violations.push("affected triangles exceed operation bound");
  if (observations.createdVertexCount > maxCreatedVertices) violations.push("created vertices exceed operation bound");
  if (observations.indexValuesWritten > maxWrittenTriangles * 3) violations.push("written triangles exceed operation bound");
  if (observations.vertexReferenceCopyPassCount > 1) violations.push("vertex references copied more than once");
  if (observations.indexCopyPassCount > 1) violations.push("index data copied more than once");
  if (observations.indexValuesCopied > observations.sourceTriangleCount * 3) violations.push("index copy exceeds source index count");
  return violations;
}

function finalizeEdit(
  mesh: IndexedMesh,
  operation: MeshTopologyOperation,
  appendedVertices: readonly Vec3[],
  replacements: readonly Omit<TriangleReplacement, "afterStartTriangle">[],
  appendedUvs: readonly Vec2[] | undefined,
  appendedColors: readonly Color3[] | undefined,
  topologyIndexBuildCount: number,
  topologyIndexTriangleVisits: number,
): MeshTopologyEdit {
  const delta: MeshTopologyDelta = {
    operation,
    beforeVertexCount: mesh.vertices.length,
    appendedVertices,
    appendedUvs,
    appendedColors,
    beforeDerived: derivedAttributes(mesh),
    replacements: withAfterStarts(replacements),
  };
  const result = applyMeshTopologyDelta(mesh, delta, "forward");
  const observations = observationsFor(mesh, delta, topologyIndexBuildCount, topologyIndexTriangleVisits);
  const violations = topologyStructuralBudgetViolations(operation, observations);
  if (violations.length > 0) throw new Error(`topology structural budget violated: ${violations.join("; ")}`);
  return { mesh: result, delta, observations };
}

export function splitMeshEdge(mesh: IndexedMesh, edge: MeshEdge, topologyIndex?: MeshTopologyIndex): MeshTopologyEdit {
  const normalizedEdge = normalizeEdge(edge);
  const [a, b] = normalizedEdge;
  const va = vertexAt(mesh, a);
  const vb = vertexAt(mesh, b);
  const index = topologyIndex ?? createMeshTopologyIndex(mesh);
  const adjacentTriangles = index.edgeTriangles.get(edgeKey(normalizedEdge)) ?? [];
  if (adjacentTriangles.length === 0) throw new Error(`edge ${a}:${b} is not referenced by any triangle`);
  if (adjacentTriangles.length > MAX_EDGE_ADJACENT_TRIANGLES) {
    throw new Error(`edge ${a}:${b} is non-manifold with ${adjacentTriangles.length} adjacent triangles`);
  }

  const midpointIndex = mesh.vertices.length;
  const replacements = adjacentTriangles.map((triangleIndex) => {
    const before = triangleAt(mesh, triangleIndex);
    return {
      beforeStartTriangle: triangleIndex,
      before: [before],
      after: splitTriangleAlongEdge(before, normalizedEdge, midpointIndex),
    };
  });
  const uvs = mesh.attributes?.uvs;
  const colors = mesh.attributes?.colors;
  return finalizeEdit(
    mesh,
    { kind: "split-edge", edge: normalizedEdge },
    [midpoint(va, vb)],
    replacements,
    uvs ? [midpointVec2(uvs[a], uvs[b])] : undefined,
    colors ? [midpointColor(colors[a], colors[b])] : undefined,
    topologyIndex ? 0 : 1,
    topologyIndex ? 0 : index.observations.triangleVisitCount,
  );
}

export function insetMeshFace(mesh: IndexedMesh, triangleIndex: number, ratio: number): MeshTopologyEdit {
  if (!Number.isFinite(ratio) || ratio < MIN_FACE_INSET_RATIO || ratio > MAX_FACE_INSET_RATIO) {
    throw new Error(`inset ratio must be from ${MIN_FACE_INSET_RATIO} to ${MAX_FACE_INSET_RATIO}`);
  }
  const [a, b, c] = triangleAt(mesh, triangleIndex);
  const va = vertexAt(mesh, a);
  const vb = vertexAt(mesh, b);
  const vc = vertexAt(mesh, c);
  const center = centroid3(va, vb, vc);
  const ia = mesh.vertices.length;
  const ib = ia + 1;
  const ic = ia + 2;
  const after: readonly MeshTriangle[] = [
    [a, b, ib],
    [a, ib, ia],
    [b, c, ic],
    [b, ic, ib],
    [c, a, ia],
    [c, ia, ic],
    [ia, ib, ic],
  ];
  const uvs = mesh.attributes?.uvs;
  const colors = mesh.attributes?.colors;
  const uvCenter = uvs ? centroid2(uvs[a], uvs[b], uvs[c]) : null;
  const colorCenter = colors ? centroidColor(colors[a], colors[b], colors[c]) : null;
  return finalizeEdit(
    mesh,
    { kind: "inset-face", triangleIndex, ratio },
    [toward3(va, center, ratio), toward3(vb, center, ratio), toward3(vc, center, ratio)],
    [{ beforeStartTriangle: triangleIndex, before: [[a, b, c]], after }],
    uvs && uvCenter
      ? [toward2(uvs[a], uvCenter, ratio), toward2(uvs[b], uvCenter, ratio), toward2(uvs[c], uvCenter, ratio)]
      : undefined,
    colors && colorCenter
      ? [
          towardColor(colors[a], colorCenter, ratio),
          towardColor(colors[b], colorCenter, ratio),
          towardColor(colors[c], colorCenter, ratio),
        ]
      : undefined,
    0,
    0,
  );
}

export function extrudeMeshFace(mesh: IndexedMesh, triangleIndex: number, distance: number): MeshTopologyEdit {
  if (!Number.isFinite(distance) || distance < MIN_FACE_EXTRUDE_DISTANCE || distance > MAX_FACE_EXTRUDE_DISTANCE) {
    throw new Error(`extrude distance must be from ${MIN_FACE_EXTRUDE_DISTANCE} to ${MAX_FACE_EXTRUDE_DISTANCE}`);
  }
  const [a, b, c] = triangleAt(mesh, triangleIndex);
  const va = vertexAt(mesh, a);
  const vb = vertexAt(mesh, b);
  const vc = vertexAt(mesh, c);
  const normal = normalize(cross(subtract(vb, va), subtract(vc, va)));
  if (!normal) throw new Error(`triangle ${triangleIndex} is degenerate and cannot be extruded`);
  const offset = scale(normal, distance);
  const ia = mesh.vertices.length;
  const ib = ia + 1;
  const ic = ia + 2;
  const after: readonly MeshTriangle[] = [
    [ia, ib, ic],
    [a, b, ib],
    [a, ib, ia],
    [b, c, ic],
    [b, ic, ib],
    [c, a, ia],
    [c, ia, ic],
  ];
  const uvs = mesh.attributes?.uvs;
  const colors = mesh.attributes?.colors;
  return finalizeEdit(
    mesh,
    { kind: "extrude-face", triangleIndex, distance },
    [add(va, offset), add(vb, offset), add(vc, offset)],
    [{ beforeStartTriangle: triangleIndex, before: [[a, b, c]], after }],
    uvs ? [cloneVec2(uvs[a]), cloneVec2(uvs[b]), cloneVec2(uvs[c])] : undefined,
    colors ? [cloneColor(colors[a]), cloneColor(colors[b]), cloneColor(colors[c])] : undefined,
    0,
    0,
  );
}

export function performMeshTopologyOperation(
  mesh: IndexedMesh,
  operation: MeshTopologyOperation,
  topologyIndex?: MeshTopologyIndex,
): MeshTopologyEdit {
  switch (operation.kind) {
    case "split-edge":
      return splitMeshEdge(mesh, operation.edge, topologyIndex);
    case "inset-face":
      return insetMeshFace(mesh, operation.triangleIndex, operation.ratio);
    case "extrude-face":
      return extrudeMeshFace(mesh, operation.triangleIndex, operation.distance);
  }
}
