import {
  updateMeshVertex,
  updateNodeTransform,
  validateEditorScene,
  type EditableTransform,
  type EditorNode,
  type EditorScene,
} from "./scene-editor";
import {
  applyPersistentMeshTopologyDelta,
  createPersistentMeshTopology,
  materializePersistentMeshTopology,
  performPersistentMeshTopologyOperation,
  type PersistentMeshTopology,
} from "./scene-editor-topology-persistent";
import {
  type MeshTopologyDelta,
  type MeshTopologyIndex,
  type MeshTopologyOperation,
  type MeshTopologyWorkObservations,
} from "./scene-editor-topology";
import type { IndexedMesh, Vec3, Vec4 } from "./mesh";

export type EditorDerivedVertexAttributes = Readonly<{
  normals?: readonly Vec3[];
  tangents?: readonly Vec4[];
}>;

export type EditorTransformCommand = Readonly<{
  kind: "set-node-transform";
  nodeId: string;
  before: EditableTransform;
  after: EditableTransform;
}>;

export type EditorVertexCommand = Readonly<{
  kind: "set-mesh-vertex";
  nodeId: string;
  vertexIndex: number;
  before: Vec3;
  after: Vec3;
  beforeDerived: EditorDerivedVertexAttributes;
  afterDerived: EditorDerivedVertexAttributes;
}>;

export type EditorTopologyCommand = Readonly<{
  kind: "edit-mesh-topology";
  nodeId: string;
  operation: MeshTopologyOperation;
  delta: MeshTopologyDelta;
  observations: MeshTopologyWorkObservations;
}>;

export type EditorCommand = EditorTransformCommand | EditorVertexCommand | EditorTopologyCommand;

export type EditorCommandLog = Readonly<{
  scene: EditorScene;
  entries: readonly EditorCommand[];
  cursor: number;
  topologyStores: ReadonlyMap<string, PersistentMeshTopology>;
}>;

const topologyViewStores = new WeakMap<object, PersistentMeshTopology>();

function cloneVec3(value: Vec3): Vec3 {
  return [value[0], value[1], value[2]];
}

function cloneTransform(value: EditableTransform): EditableTransform {
  return {
    translation: cloneVec3(value.translation),
    rotation: cloneVec3(value.rotation),
    scale: cloneVec3(value.scale),
  };
}

function finiteTuple(value: readonly number[]): boolean {
  return value.every(Number.isFinite);
}

function sameVec3(left: Vec3, right: Vec3): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

function sameTransform(left: EditableTransform, right: EditableTransform): boolean {
  return sameVec3(left.translation, right.translation) && sameVec3(left.rotation, right.rotation) && sameVec3(left.scale, right.scale);
}

function findNode(scene: EditorScene, nodeId: string): { node: EditorNode; index: number } {
  const index = scene.nodes.findIndex((candidate) => candidate.id === nodeId);
  if (index < 0) throw new Error(`unknown node ${nodeId}`);
  return { node: scene.nodes[index], index };
}

function replaceNodeMesh(scene: EditorScene, nodeId: string, mesh: IndexedMesh): EditorScene {
  const { node, index } = findNode(scene, nodeId);
  if (!node.mesh) throw new Error(`node ${nodeId} does not own a mesh`);
  const nodes = [...scene.nodes];
  nodes[index] = { ...node, mesh };
  return { nodes };
}

function lazyMaterializedMesh(topology: PersistentMeshTopology): IndexedMesh {
  let cached: IndexedMesh | null = null;
  const materialized = () => {
    cached ??= materializePersistentMeshTopology(topology).mesh;
    return cached;
  };
  const view: IndexedMesh = {
    get vertices() {
      return materialized().vertices;
    },
    get indices() {
      return materialized().indices;
    },
    get attributes() {
      return materialized().attributes;
    },
  };
  topologyViewStores.set(view, topology);
  return view;
}

function derivedAttributes(node: EditorNode): EditorDerivedVertexAttributes {
  return { normals: node.mesh?.attributes?.normals, tangents: node.mesh?.attributes?.tangents };
}

function sameDerivedAttributeArray<T extends readonly number[]>(left: readonly T[] | undefined, right: readonly T[] | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => {
    const candidate = right[index];
    return value.length === candidate.length && value.every((component, componentIndex) => component === candidate[componentIndex]);
  });
}

function sameDerivedAttributes(left: EditorDerivedVertexAttributes, right: EditorDerivedVertexAttributes): boolean {
  return sameDerivedAttributeArray(left.normals, right.normals) && sameDerivedAttributeArray(left.tangents, right.tangents);
}

function validateDerivedAttributes(nodeId: string, vertexCount: number, attributes: EditorDerivedVertexAttributes): void {
  const entries = [["normal", attributes.normals], ["tangent", attributes.tangents]] as const;
  for (const [name, values] of entries) {
    if (!values) continue;
    if (values.length !== vertexCount) throw new Error(`${name} attribute count must match vertex count for node ${nodeId}`);
    values.forEach((value, index) => {
      if (!finiteTuple(value)) throw new Error(`${name} attribute ${index} contains a non-finite value`);
    });
  }
}

function applyVertexState(scene: EditorScene, nodeId: string, vertexIndex: number, position: Vec3, derived: EditorDerivedVertexAttributes): EditorScene {
  if (!finiteTuple(position)) throw new Error("vertex position must be finite");
  const { node, index } = findNode(scene, nodeId);
  if (!node.mesh) throw new Error(`node ${nodeId} does not own a mesh`);
  if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= node.mesh.vertices.length) {
    throw new Error(`vertex ${vertexIndex} is outside node ${nodeId}`);
  }
  validateDerivedAttributes(nodeId, node.mesh.vertices.length, derived);
  const vertices = [...node.mesh.vertices];
  vertices[vertexIndex] = cloneVec3(position);
  const sourceAttributes = node.mesh.attributes;
  const hasAttributes = derived.normals !== undefined || derived.tangents !== undefined || sourceAttributes?.uvs !== undefined || sourceAttributes?.colors !== undefined;
  const mesh: IndexedMesh = {
    vertices,
    indices: node.mesh.indices,
    attributes: hasAttributes
      ? { normals: derived.normals, tangents: derived.tangents, uvs: sourceAttributes?.uvs, colors: sourceAttributes?.colors }
      : undefined,
  };
  const nodes = [...scene.nodes];
  nodes[index] = { ...node, mesh };
  return { nodes };
}

function staleTopologyViewError(nodeId: string): Error {
  return new Error(`topology command appended-vertex precondition failed: compatibility-view precondition failed for node ${nodeId}`);
}

function topologyStoreFor(log: EditorCommandLog, nodeId: string): PersistentMeshTopology {
  const existing = log.topologyStores.get(nodeId);
  if (existing) {
    const { node } = findNode(log.scene, nodeId);
    if (!node.mesh || topologyViewStores.get(node.mesh) !== existing) throw staleTopologyViewError(nodeId);
    return existing;
  }
  const { node } = findNode(log.scene, nodeId);
  if (!node.mesh) throw new Error(`node ${nodeId} does not own a mesh`);
  return createPersistentMeshTopology(node.mesh);
}

function withTopologyStore(log: EditorCommandLog, nodeId: string, topology: PersistentMeshTopology): EditorCommandLog {
  const topologyStores = new Map(log.topologyStores);
  topologyStores.set(nodeId, topology);
  return { ...log, scene: replaceNodeMesh(log.scene, nodeId, lazyMaterializedMesh(topology)), topologyStores };
}

function materializeTopologyNode(log: EditorCommandLog, nodeId: string): EditorCommandLog {
  const topology = log.topologyStores.get(nodeId);
  if (!topology) return log;
  const { node } = findNode(log.scene, nodeId);
  if (!node.mesh || topologyViewStores.get(node.mesh) !== topology) throw staleTopologyViewError(nodeId);
  const mesh = materializePersistentMeshTopology(topology).mesh;
  const topologyStores = new Map(log.topologyStores);
  topologyStores.delete(nodeId);
  return { ...log, scene: replaceNodeMesh(log.scene, nodeId, mesh), topologyStores };
}

export function currentEditorTopology(log: EditorCommandLog, nodeId: string): PersistentMeshTopology {
  return topologyStoreFor(log, nodeId);
}

export function currentEditorMesh(log: EditorCommandLog, nodeId: string): IndexedMesh {
  const topology = log.topologyStores.get(nodeId);
  if (topology) {
    const { node } = findNode(log.scene, nodeId);
    if (!node.mesh || topologyViewStores.get(node.mesh) !== topology) throw staleTopologyViewError(nodeId);
    return materializePersistentMeshTopology(topology).mesh;
  }
  const { node } = findNode(log.scene, nodeId);
  if (!node.mesh) throw new Error(`node ${nodeId} does not own a mesh`);
  return node.mesh;
}

export function materializeEditorCommandLog(log: EditorCommandLog): EditorCommandLog {
  let result = log;
  for (const nodeId of [...log.topologyStores.keys()]) result = materializeTopologyNode(result, nodeId);
  return result;
}

function applyNonTopologyCommand(scene: EditorScene, command: EditorTransformCommand | EditorVertexCommand, direction: "forward" | "reverse"): EditorScene {
  if (command.kind === "set-node-transform") {
    const { node } = findNode(scene, command.nodeId);
    const expected = direction === "forward" ? command.before : command.after;
    const target = direction === "forward" ? command.after : command.before;
    if (!sameTransform(node.transform, expected)) throw new Error(`editor command precondition failed for node ${command.nodeId}`);
    return updateNodeTransform(scene, command.nodeId, target);
  }
  const { node } = findNode(scene, command.nodeId);
  if (!node.mesh) throw new Error(`node ${command.nodeId} does not own a mesh`);
  const expectedPosition = direction === "forward" ? command.before : command.after;
  const expectedDerived = direction === "forward" ? command.beforeDerived : command.afterDerived;
  const targetPosition = direction === "forward" ? command.after : command.before;
  const targetDerived = direction === "forward" ? command.afterDerived : command.beforeDerived;
  const currentPosition = node.mesh.vertices[command.vertexIndex];
  if (!currentPosition || !sameVec3(currentPosition, expectedPosition)) {
    throw new Error(`editor command precondition failed for node ${command.nodeId} vertex ${command.vertexIndex}`);
  }
  if (!sameDerivedAttributes(derivedAttributes(node), expectedDerived)) {
    throw new Error(`editor command derived-state precondition failed for node ${command.nodeId}`);
  }
  return applyVertexState(scene, command.nodeId, command.vertexIndex, targetPosition, targetDerived);
}

function applyTopologyCommand(log: EditorCommandLog, command: EditorTopologyCommand, direction: "forward" | "reverse"): EditorCommandLog {
  const topology = topologyStoreFor(log, command.nodeId);
  return withTopologyStore(log, command.nodeId, applyPersistentMeshTopologyDelta(topology, command.delta, direction));
}

export function createEditorCommandLog(scene: EditorScene): EditorCommandLog {
  validateEditorScene(scene);
  return { scene, entries: [], cursor: 0, topologyStores: new Map() };
}

export function canUndoEditorCommand(log: EditorCommandLog): boolean {
  return log.cursor > 0;
}

export function canRedoEditorCommand(log: EditorCommandLog): boolean {
  return log.cursor < log.entries.length;
}

export function commitNodeTransform(log: EditorCommandLog, nodeId: string, patch: Partial<EditableTransform>): EditorCommandLog {
  const { node } = findNode(log.scene, nodeId);
  const after: EditableTransform = {
    translation: patch.translation ? cloneVec3(patch.translation) : node.transform.translation,
    rotation: patch.rotation ? cloneVec3(patch.rotation) : node.transform.rotation,
    scale: patch.scale ? cloneVec3(patch.scale) : node.transform.scale,
  };
  if (sameTransform(node.transform, after)) return log;
  const command: EditorTransformCommand = { kind: "set-node-transform", nodeId, before: cloneTransform(node.transform), after: cloneTransform(after) };
  const scene = applyNonTopologyCommand(log.scene, command, "forward");
  const entries = [...log.entries.slice(0, log.cursor), command];
  return { ...log, scene, entries, cursor: entries.length };
}

export function commitMeshVertex(sourceLog: EditorCommandLog, nodeId: string, vertexIndex: number, position: Vec3): EditorCommandLog {
  const log = materializeTopologyNode(sourceLog, nodeId);
  const { node } = findNode(log.scene, nodeId);
  if (!node.mesh) throw new Error(`node ${nodeId} does not own a mesh`);
  if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= node.mesh.vertices.length) {
    throw new Error(`vertex ${vertexIndex} is outside node ${nodeId}`);
  }
  if (!finiteTuple(position)) throw new Error("vertex position must be finite");
  const before = node.mesh.vertices[vertexIndex];
  if (sameVec3(before, position)) return log;
  const command: EditorVertexCommand = {
    kind: "set-mesh-vertex",
    nodeId,
    vertexIndex,
    before: cloneVec3(before),
    after: cloneVec3(position),
    beforeDerived: derivedAttributes(node),
    afterDerived: {},
  };
  const scene = updateMeshVertex(log.scene, nodeId, vertexIndex, position);
  const entries = [...log.entries.slice(0, log.cursor), command];
  return { ...log, scene, entries, cursor: entries.length };
}

export function commitMeshTopology(log: EditorCommandLog, nodeId: string, operation: MeshTopologyOperation, topologyIndex?: MeshTopologyIndex): EditorCommandLog {
  const topology = topologyStoreFor(log, nodeId);
  const edit = performPersistentMeshTopologyOperation(topology, operation, topologyIndex);
  const command: EditorTopologyCommand = {
    kind: "edit-mesh-topology",
    nodeId,
    operation: edit.delta.operation,
    delta: edit.delta,
    observations: edit.observations,
  };
  const entries = [...log.entries.slice(0, log.cursor), command];
  return { ...withTopologyStore(log, nodeId, edit.topology), entries, cursor: entries.length };
}

export function undoEditorCommand(sourceLog: EditorCommandLog): EditorCommandLog {
  if (!canUndoEditorCommand(sourceLog)) return sourceLog;
  const command = sourceLog.entries[sourceLog.cursor - 1];
  if (command.kind === "edit-mesh-topology") return { ...applyTopologyCommand(sourceLog, command, "reverse"), cursor: sourceLog.cursor - 1 };
  const log = command.kind === "set-mesh-vertex" ? materializeTopologyNode(sourceLog, command.nodeId) : sourceLog;
  return { ...log, scene: applyNonTopologyCommand(log.scene, command, "reverse"), cursor: sourceLog.cursor - 1 };
}

export function redoEditorCommand(sourceLog: EditorCommandLog): EditorCommandLog {
  if (!canRedoEditorCommand(sourceLog)) return sourceLog;
  const command = sourceLog.entries[sourceLog.cursor];
  if (command.kind === "edit-mesh-topology") return { ...applyTopologyCommand(sourceLog, command, "forward"), cursor: sourceLog.cursor + 1 };
  const log = command.kind === "set-mesh-vertex" ? materializeTopologyNode(sourceLog, command.nodeId) : sourceLog;
  return { ...log, scene: applyNonTopologyCommand(log.scene, command, "forward"), cursor: sourceLog.cursor + 1 };
}

export function replayEditorCommands(initialScene: EditorScene, commands: readonly EditorCommand[], count = commands.length): EditorScene {
  if (!Number.isInteger(count) || count < 0 || count > commands.length) throw new Error(`command replay count ${count} is outside the command log`);
  let log = createEditorCommandLog(initialScene);
  for (let index = 0; index < count; index += 1) {
    const command = commands[index];
    if (command.kind === "edit-mesh-topology") log = applyTopologyCommand(log, command, "forward");
    else {
      const ready = command.kind === "set-mesh-vertex" ? materializeTopologyNode(log, command.nodeId) : log;
      log = { ...ready, scene: applyNonTopologyCommand(ready.scene, command, "forward") };
    }
  }
  return materializeEditorCommandLog(log).scene;
}
