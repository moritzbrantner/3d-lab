import {
  validateEditorScene,
  type EditableTransform,
  type EditorNode,
  type EditorScene,
} from "./scene-editor";
import { validateMesh, type IndexedMesh, type Vec2, type Vec3, type Vec4 } from "./mesh";

export const EDITOR_SCENE_SNAPSHOT_SCHEMA = "3d-lab/editor-scene-snapshot/v1" as const;
export const MAX_EDITOR_SCENE_SNAPSHOT_NODES = 1024;
export const MAX_EDITOR_SCENE_SNAPSHOT_DEPTH = 64;
export const MAX_EDITOR_SCENE_SNAPSHOT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_EDITOR_SCENE_SNAPSHOT_VERTICES_PER_MESH = 65_536;
export const MAX_EDITOR_SCENE_SNAPSHOT_INDICES_PER_MESH = 393_216;
export const MAX_EDITOR_SCENE_SNAPSHOT_TOTAL_VERTICES = 131_072;
export const MAX_EDITOR_SCENE_SNAPSHOT_TOTAL_INDICES = 786_432;
/** Upper bound (UTF-16 code units) for node ids, which key hierarchy and selection state. */
export const MAX_EDITOR_SCENE_SNAPSHOT_NODE_ID_CHARS = 256;
/** Upper bound (UTF-16 code units) for node names rendered in the hierarchy, toolbar, and inspector. */
export const MAX_EDITOR_SCENE_SNAPSHOT_NODE_NAME_CHARS = 256;

export type EditorSceneSnapshot = Readonly<{
  schema: typeof EDITOR_SCENE_SNAPSHOT_SCHEMA;
  nodes: readonly EditorNode[];
}>;

type JsonRecord = Record<string, unknown>;

/** Upper bound for an untrusted string excerpt embedded in an import error. */
export const MAX_EDITOR_SCENE_SNAPSHOT_ERROR_EXCERPT_CHARS = 64;
/** Upper bound for any import error message surfaced to the editor UI. */
export const MAX_EDITOR_SCENE_SNAPSHOT_ERROR_MESSAGE_CHARS = 512;

function untrustedExcerpt(value: string): string {
  const limit = MAX_EDITOR_SCENE_SNAPSHOT_ERROR_EXCERPT_CHARS;
  const excerpt = value.length > limit ? `${value.slice(0, limit)}…` : value;
  const quoted = JSON.stringify(excerpt);
  return value.length > limit ? `${quoted} (${value.length} chars)` : quoted;
}

function boundedErrorMessage(message: string): string {
  const limit = MAX_EDITOR_SCENE_SNAPSHOT_ERROR_MESSAGE_CHARS;
  return message.length > limit ? `${message.slice(0, limit)}…` : message;
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function list(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function exactKeys(value: JsonRecord, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${label} contains unsupported field ${untrustedExcerpt(key)}`);
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function boundedString(value: unknown, label: string, limit: number): string {
  const parsed = stringValue(value, label);
  if (parsed.length > limit) throw new Error(`${label} length ${parsed.length} exceeds limit ${limit}`);
  return parsed;
}

function requireBoundedNodeStrings(node: EditorNode, label: string): void {
  boundedString(node.id, `${label}.id`, MAX_EDITOR_SCENE_SNAPSHOT_NODE_ID_CHARS);
  boundedString(node.name, `${label}.name`, MAX_EDITOR_SCENE_SNAPSHOT_NODE_NAME_CHARS);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

/**
 * Geometry and transform components are consumed as `f32` by the renderer (`Float32BufferAttribute`)
 * and by the Rust geometry authority, so finite JavaScript numbers that overflow `f32` are rejected.
 */
function isF32Representable(value: number): boolean {
  return Number.isFinite(value) && Number.isFinite(Math.fround(value));
}

function f32Number(value: unknown, label: string): number {
  const parsed = finiteNumber(value, label);
  if (!isF32Representable(parsed)) throw new Error(`${label} must be within the f32 range`);
  return parsed;
}

function tuple(value: unknown, length: number, label: string): number[] {
  const values = list(value, label);
  if (values.length !== length) throw new Error(`${label} must contain exactly ${length} numbers`);
  return values.map((component, index) => f32Number(component, `${label}[${index}]`));
}

function requireF32Tuples(
  values: readonly (readonly number[])[] | undefined,
  label: string,
): void {
  if (!values) return;
  values.forEach((value, index) => {
    value.forEach((component, componentIndex) => {
      if (!isF32Representable(component)) {
        throw new Error(`${label}[${index}][${componentIndex}] must be within the f32 range`);
      }
    });
  });
}

function requireF32SnapshotValues(node: EditorNode): void {
  const label = `scene snapshot node ${node.id}`;
  const { translation, rotation, scale } = node.transform;
  requireF32Tuples([translation, rotation, scale], `${label}.transform`);
  if (!node.mesh) return;
  requireF32Tuples(node.mesh.vertices, `${label}.mesh.vertices`);
  const attributes = node.mesh.attributes;
  requireF32Tuples(attributes?.normals, `${label}.mesh.attributes.normals`);
  requireF32Tuples(attributes?.tangents, `${label}.mesh.attributes.tangents`);
  requireF32Tuples(attributes?.uvs, `${label}.mesh.attributes.uvs`);
  requireF32Tuples(attributes?.colors, `${label}.mesh.attributes.colors`);
}

function vec2(value: unknown, label: string): Vec2 {
  const values = tuple(value, 2, label);
  return [values[0], values[1]];
}

function vec3(value: unknown, label: string): Vec3 {
  const values = tuple(value, 3, label);
  return [values[0], values[1], values[2]];
}

function vec4(value: unknown, label: string): Vec4 {
  const values = tuple(value, 4, label);
  return [values[0], values[1], values[2], values[3]];
}

function tupleListExact<T>(
  value: unknown,
  expectedLength: number,
  label: string,
  parse: (entry: unknown, label: string) => T,
): readonly T[] {
  const values = list(value, label);
  if (values.length !== expectedLength) {
    throw new Error(`${label} must contain exactly ${expectedLength} entries`);
  }
  return values.map((entry, index) => parse(entry, `${label}[${index}]`));
}

type SnapshotGeometryBudget = {
  vertices: number;
  indices: number;
};

function boundedArray(value: unknown, label: string, limit: number): readonly unknown[] {
  const values = list(value, label);
  if (values.length > limit) throw new Error(`${label} count ${values.length} exceeds limit ${limit}`);
  return values;
}

function reserveGeometryBudget(
  budget: SnapshotGeometryBudget,
  vertices: number,
  indices: number,
  label: string,
): void {
  if (budget.vertices + vertices > MAX_EDITOR_SCENE_SNAPSHOT_TOTAL_VERTICES) {
    throw new Error(
      `${label} would exceed total vertex limit ${MAX_EDITOR_SCENE_SNAPSHOT_TOTAL_VERTICES}`,
    );
  }
  if (budget.indices + indices > MAX_EDITOR_SCENE_SNAPSHOT_TOTAL_INDICES) {
    throw new Error(
      `${label} would exceed total index limit ${MAX_EDITOR_SCENE_SNAPSHOT_TOTAL_INDICES}`,
    );
  }
  budget.vertices += vertices;
  budget.indices += indices;
}

function reserveBoundedGeometry(
  budget: SnapshotGeometryBudget,
  vertices: number,
  indices: number,
  label: string,
): void {
  if (vertices > MAX_EDITOR_SCENE_SNAPSHOT_VERTICES_PER_MESH) {
    throw new Error(`${label}.vertices count ${vertices} exceeds limit ${MAX_EDITOR_SCENE_SNAPSHOT_VERTICES_PER_MESH}`);
  }
  if (indices > MAX_EDITOR_SCENE_SNAPSHOT_INDICES_PER_MESH) {
    throw new Error(`${label}.indices count ${indices} exceeds limit ${MAX_EDITOR_SCENE_SNAPSHOT_INDICES_PER_MESH}`);
  }
  reserveGeometryBudget(budget, vertices, indices, label);
}

function parseTransform(value: unknown, label: string): EditableTransform {
  const source = record(value, label);
  exactKeys(source, ["translation", "rotation", "scale"], label);
  return {
    translation: vec3(source.translation, `${label}.translation`),
    rotation: vec3(source.rotation, `${label}.rotation`),
    scale: vec3(source.scale, `${label}.scale`),
  };
}

function parseMesh(value: unknown, label: string, budget: SnapshotGeometryBudget): IndexedMesh {
  const source = record(value, label);
  exactKeys(source, ["vertices", "indices", "attributes"], label);
  const rawVertices = boundedArray(
    source.vertices,
    `${label}.vertices`,
    MAX_EDITOR_SCENE_SNAPSHOT_VERTICES_PER_MESH,
  );
  const rawIndices = boundedArray(
    source.indices,
    `${label}.indices`,
    MAX_EDITOR_SCENE_SNAPSHOT_INDICES_PER_MESH,
  );
  reserveBoundedGeometry(budget, rawVertices.length, rawIndices.length, label);

  const vertices = rawVertices.map((entry, index) => vec3(entry, `${label}.vertices[${index}]`));
  const indices = rawIndices.map((entry, index) => {
    const parsed = finiteNumber(entry, `${label}.indices[${index}]`);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(`${label}.indices[${index}] must be a non-negative safe integer`);
    }
    return parsed;
  });

  let attributes: IndexedMesh["attributes"];
  if (source.attributes !== undefined) {
    const raw = record(source.attributes, `${label}.attributes`);
    exactKeys(raw, ["normals", "tangents", "uvs", "colors"], `${label}.attributes`);
    attributes = {
      normals: raw.normals === undefined
        ? undefined
        : tupleListExact(raw.normals, rawVertices.length, `${label}.attributes.normals`, vec3),
      tangents: raw.tangents === undefined
        ? undefined
        : tupleListExact(raw.tangents, rawVertices.length, `${label}.attributes.tangents`, vec4),
      uvs: raw.uvs === undefined
        ? undefined
        : tupleListExact(raw.uvs, rawVertices.length, `${label}.attributes.uvs`, vec2),
      colors: raw.colors === undefined
        ? undefined
        : tupleListExact(raw.colors, rawVertices.length, `${label}.attributes.colors`, vec3),
    };
  }

  const mesh: IndexedMesh = { vertices, indices, ...(attributes ? { attributes } : {}) };
  validateMesh(mesh);
  return mesh;
}

function parseNode(value: unknown, index: number, budget: SnapshotGeometryBudget): EditorNode {
  const label = `scene snapshot node ${index}`;
  const source = record(value, label);
  exactKeys(source, ["id", "name", "parent", "transform", "mesh"], label);
  const parent = source.parent;
  if (parent !== null && typeof parent !== "string") throw new Error(`${label}.parent must be a string or null`);
  return {
    id: boundedString(source.id, `${label}.id`, MAX_EDITOR_SCENE_SNAPSHOT_NODE_ID_CHARS),
    name: boundedString(source.name, `${label}.name`, MAX_EDITOR_SCENE_SNAPSHOT_NODE_NAME_CHARS),
    parent,
    transform: parseTransform(source.transform, `${label}.transform`),
    ...(source.mesh === undefined ? {} : { mesh: parseMesh(source.mesh, `${label}.mesh`, budget) }),
  };
}

function requireSnapshotScene(scene: EditorScene): void {
  if (scene.nodes.length === 0) throw new Error("scene snapshot must contain at least one node");
  if (scene.nodes.length > MAX_EDITOR_SCENE_SNAPSHOT_NODES) {
    throw new Error(`scene snapshot node count ${scene.nodes.length} exceeds limit ${MAX_EDITOR_SCENE_SNAPSHOT_NODES}`);
  }
  scene.nodes.forEach((node, index) => requireBoundedNodeStrings(node, `scene snapshot node ${index}`));
  validateEditorScene(scene);
  for (const node of scene.nodes) requireF32SnapshotValues(node);

  const geometryBudget: SnapshotGeometryBudget = { vertices: 0, indices: 0 };
  for (const node of scene.nodes) {
    if (!node.mesh) continue;
    reserveBoundedGeometry(
      geometryBudget,
      node.mesh.vertices.length,
      node.mesh.indices.length,
      `scene snapshot node ${node.id}.mesh`,
    );
  }

  const depths = new Map<string, number>();
  for (const node of scene.nodes) {
    const depth = node.parent === null ? 1 : (depths.get(node.parent) ?? 0) + 1;
    if (depth > MAX_EDITOR_SCENE_SNAPSHOT_DEPTH) {
      throw new Error(
        `scene snapshot node ${node.id} exceeds hierarchy depth limit ${MAX_EDITOR_SCENE_SNAPSHOT_DEPTH}`,
      );
    }
    depths.set(node.id, depth);
  }
}

function cloneTuple2(value: Vec2): Vec2 {
  return [value[0], value[1]];
}

function cloneTuple3(value: Vec3): Vec3 {
  return [value[0], value[1], value[2]];
}

function cloneTuple4(value: Vec4): Vec4 {
  return [value[0], value[1], value[2], value[3]];
}

function snapshotMesh(mesh: IndexedMesh): IndexedMesh {
  const source = mesh.attributes;
  const hasAttributes = Boolean(source?.normals || source?.tangents || source?.uvs || source?.colors);
  return {
    vertices: mesh.vertices.map(cloneTuple3),
    indices: [...mesh.indices],
    ...(hasAttributes
      ? {
          attributes: {
            normals: source?.normals?.map(cloneTuple3),
            tangents: source?.tangents?.map(cloneTuple4),
            uvs: source?.uvs?.map(cloneTuple2),
            colors: source?.colors?.map(cloneTuple3),
          },
        }
      : {}),
  };
}

export function createEditorSceneSnapshot(scene: EditorScene): EditorSceneSnapshot {
  requireSnapshotScene(scene);
  return {
    schema: EDITOR_SCENE_SNAPSHOT_SCHEMA,
    nodes: scene.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      parent: node.parent,
      transform: {
        translation: cloneTuple3(node.transform.translation),
        rotation: cloneTuple3(node.transform.rotation),
        scale: cloneTuple3(node.transform.scale),
      },
      ...(node.mesh ? { mesh: snapshotMesh(node.mesh) } : {}),
    })),
  };
}

function snapshotUtf8ByteLength(source: string): number {
  return new TextEncoder().encode(source).byteLength;
}

export function serializeEditorSceneSnapshot(scene: EditorScene): string {
  const source = JSON.stringify(createEditorSceneSnapshot(scene)) + "\n";
  validateEditorSceneSnapshotFileSize(snapshotUtf8ByteLength(source));
  return source;
}

/**
 * Decode an untrusted snapshot value. Error messages are bounded so that rejected
 * files cannot push arbitrarily large untrusted strings (ids, keys, schema) into the UI.
 */
export function decodeEditorSceneSnapshot(value: unknown): EditorScene {
  try {
    return decodeUntrustedEditorSceneSnapshot(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(boundedErrorMessage(message));
  }
}

function decodeUntrustedEditorSceneSnapshot(value: unknown): EditorScene {
  const source = record(value, "scene snapshot");
  exactKeys(source, ["schema", "nodes"], "scene snapshot");
  const schema = stringValue(source.schema, "scene snapshot.schema");
  if (schema !== EDITOR_SCENE_SNAPSHOT_SCHEMA) {
    throw new Error(
      `unsupported scene snapshot schema ${untrustedExcerpt(schema)}; expected ${EDITOR_SCENE_SNAPSHOT_SCHEMA}`,
    );
  }
  const rawNodes = list(source.nodes, "scene snapshot.nodes");
  if (rawNodes.length === 0) throw new Error("scene snapshot must contain at least one node");
  if (rawNodes.length > MAX_EDITOR_SCENE_SNAPSHOT_NODES) {
    throw new Error(`scene snapshot node count ${rawNodes.length} exceeds limit ${MAX_EDITOR_SCENE_SNAPSHOT_NODES}`);
  }
  const budget: SnapshotGeometryBudget = { vertices: 0, indices: 0 };
  const scene: EditorScene = {
    nodes: rawNodes.map((value, index) => parseNode(value, index, budget)),
  };
  requireSnapshotScene(scene);
  return scene;
}

export function validateEditorSceneSnapshotFileSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("scene snapshot file size must be a non-negative safe integer");
  if (size > MAX_EDITOR_SCENE_SNAPSHOT_FILE_BYTES) {
    throw new Error(`scene snapshot file size ${size} exceeds limit ${MAX_EDITOR_SCENE_SNAPSHOT_FILE_BYTES}`);
  }
}

export function parseEditorSceneSnapshot(source: string): EditorScene {
  validateEditorSceneSnapshotFileSize(snapshotUtf8ByteLength(source));
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("scene snapshot is not valid JSON");
  }
  return decodeEditorSceneSnapshot(parsed);
}
