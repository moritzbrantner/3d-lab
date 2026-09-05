import { cubeMesh, type IndexedMesh, type Vec3, validateMesh } from "./mesh";

export type EditableTransform = {
  translation: Vec3;
  rotation: Vec3;
  scale: Vec3;
};

export type EditorNode = {
  id: string;
  name: string;
  parent: string | null;
  transform: EditableTransform;
  mesh?: IndexedMesh;
};

export type EditorScene = {
  nodes: readonly EditorNode[];
};

export type MeshEdge = readonly [a: number, b: number];

export type EditorCommand =
  | {
      kind: "node-transform";
      nodeId: string;
      before: EditableTransform;
      after: EditableTransform;
    }
  | {
      kind: "vertex-position";
      nodeId: string;
      vertexIndex: number;
      before: Vec3;
      after: Vec3;
      beforeMesh: IndexedMesh;
      afterMesh: IndexedMesh;
    }
  | {
      kind: "replace-scene";
      before: EditorScene;
      after: EditorScene;
    };

export type EditorHistory = {
  present: EditorScene;
  undo: readonly EditorCommand[];
  redo: readonly EditorCommand[];
};

export const MAX_EDITOR_HISTORY = 100;

const IDENTITY_TRANSFORM: EditableTransform = {
  translation: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

function cloneVec3(value: Vec3): Vec3 {
  return [value[0], value[1], value[2]];
}

function cloneMesh(mesh: IndexedMesh): IndexedMesh {
  return {
    vertices: mesh.vertices.map(cloneVec3),
    indices: [...mesh.indices],
    attributes: mesh.attributes
      ? {
          normals: mesh.attributes.normals?.map(cloneVec3),
          tangents: mesh.attributes.tangents?.map((value) => [value[0], value[1], value[2], value[3]] as const),
          uvs: mesh.attributes.uvs?.map((value) => [value[0], value[1]] as const),
          colors: mesh.attributes.colors?.map(cloneVec3),
        }
      : undefined,
  };
}

function cloneTransform(transform: EditableTransform): EditableTransform {
  return {
    translation: cloneVec3(transform.translation),
    rotation: cloneVec3(transform.rotation),
    scale: cloneVec3(transform.scale),
  };
}

export function cloneEditorScene(scene: EditorScene): EditorScene {
  return {
    nodes: scene.nodes.map((node) => ({
      ...node,
      transform: cloneTransform(node.transform),
      mesh: node.mesh ? cloneMesh(node.mesh) : undefined,
    })),
  };
}

function finiteVec3(value: Vec3): boolean {
  return value.every(Number.isFinite);
}

function vec3Equal(left: Vec3, right: Vec3): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

function transformEqual(left: EditableTransform, right: EditableTransform): boolean {
  return (
    vec3Equal(left.translation, right.translation)
    && vec3Equal(left.rotation, right.rotation)
    && vec3Equal(left.scale, right.scale)
  );
}

function sceneEqual(left: EditorScene, right: EditorScene): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function findNodeIndex(scene: EditorScene, nodeId: string): number {
  const index = scene.nodes.findIndex((node) => node.id === nodeId);
  if (index < 0) throw new Error(`unknown node ${nodeId}`);
  return index;
}

function canonicalEdge(a: number, b: number): MeshEdge {
  return a < b ? [a, b] : [b, a];
}

export function createEditorScene(): EditorScene {
  const makeCube = () => cloneMesh(cubeMesh);
  return {
    nodes: [
      {
        id: "scene",
        name: "Scene",
        parent: null,
        transform: cloneTransform(IDENTITY_TRANSFORM),
      },
      {
        id: "body",
        name: "Body mesh",
        parent: "scene",
        transform: {
          translation: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1.7, 0.65, 1.05],
        },
        mesh: makeCube(),
      },
      {
        id: "mast",
        name: "Mast group",
        parent: "body",
        transform: {
          translation: [0.35, 0.7, 0],
          rotation: [0, 0, -0.18],
          scale: [1, 1, 1],
        },
      },
      {
        id: "tip",
        name: "Tip mesh",
        parent: "mast",
        transform: {
          translation: [0, 0.6, 0],
          rotation: [0.12, 0.2, 0],
          scale: [0.35, 0.8, 0.35],
        },
        mesh: makeCube(),
      },
      {
        id: "side",
        name: "Side mesh",
        parent: "body",
        transform: {
          translation: [-0.85, 0.05, 0.15],
          rotation: [0, 0.35, 0.12],
          scale: [0.45, 0.35, 0.7],
        },
        mesh: makeCube(),
      },
    ],
  };
}

export function validateEditorScene(scene: EditorScene): void {
  const seen = new Set<string>();
  scene.nodes.forEach((node, index) => {
    if (!node.id) throw new Error(`node ${index} has an empty id`);
    if (seen.has(node.id)) throw new Error(`duplicate node id ${node.id}`);
    if (node.parent !== null && !seen.has(node.parent)) {
      throw new Error(`node ${node.id} references parent ${node.parent}; parents must appear before children`);
    }
    if (!finiteVec3(node.transform.translation)) throw new Error(`node ${node.id} has a non-finite translation`);
    if (!finiteVec3(node.transform.rotation)) throw new Error(`node ${node.id} has a non-finite rotation`);
    if (!finiteVec3(node.transform.scale)) throw new Error(`node ${node.id} has a non-finite scale`);
    if (node.mesh) validateMesh(node.mesh);
    seen.add(node.id);
  });
}

export function childrenOf(scene: EditorScene, parent: string | null): readonly EditorNode[] {
  return scene.nodes.filter((node) => node.parent === parent);
}

export function meshEdges(mesh: IndexedMesh): readonly MeshEdge[] {
  validateMesh(mesh);
  const edges: MeshEdge[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const triangle = [mesh.indices[offset], mesh.indices[offset + 1], mesh.indices[offset + 2]] as const;
    const candidates = [
      canonicalEdge(triangle[0], triangle[1]),
      canonicalEdge(triangle[1], triangle[2]),
      canonicalEdge(triangle[2], triangle[0]),
    ] as const;
    candidates.forEach((edge) => {
      const key = `${edge[0]}:${edge[1]}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push(edge);
    });
  }
  return edges;
}

export function triangleVertexIndices(mesh: IndexedMesh, faceIndex: number): readonly [number, number, number] {
  validateMesh(mesh);
  const faceCount = mesh.indices.length / 3;
  if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= faceCount) {
    throw new Error(`face ${faceIndex} is outside mesh with ${faceCount} faces`);
  }
  const offset = faceIndex * 3;
  return [mesh.indices[offset], mesh.indices[offset + 1], mesh.indices[offset + 2]];
}

export function updateNodeTransform(
  scene: EditorScene,
  nodeId: string,
  patch: Partial<EditableTransform>,
): EditorScene {
  const index = findNodeIndex(scene, nodeId);
  const node = scene.nodes[index];
  const transform: EditableTransform = {
    translation: patch.translation ? cloneVec3(patch.translation) : cloneVec3(node.transform.translation),
    rotation: patch.rotation ? cloneVec3(patch.rotation) : cloneVec3(node.transform.rotation),
    scale: patch.scale ? cloneVec3(patch.scale) : cloneVec3(node.transform.scale),
  };
  const nodes = scene.nodes.map((candidate, candidateIndex) =>
    candidateIndex === index ? { ...candidate, transform } : candidate,
  );
  const next = { nodes };
  validateEditorScene(next);
  return next;
}

export function updateMeshVertex(scene: EditorScene, nodeId: string, vertexIndex: number, position: Vec3): EditorScene {
  if (!finiteVec3(position)) throw new Error("vertex position must be finite");
  const index = findNodeIndex(scene, nodeId);
  const node = scene.nodes[index];
  if (!node.mesh) throw new Error(`node ${nodeId} does not own a mesh`);
  if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= node.mesh.vertices.length) {
    throw new Error(`vertex ${vertexIndex} is outside node ${nodeId}`);
  }

  const vertices = node.mesh.vertices.map((vertex, candidateIndex) =>
    candidateIndex === vertexIndex ? cloneVec3(position) : cloneVec3(vertex),
  );
  const sourceAttributes = node.mesh.attributes;
  const attributes = sourceAttributes
    ? {
        uvs: sourceAttributes.uvs?.map((value) => [value[0], value[1]] as const),
        colors: sourceAttributes.colors?.map(cloneVec3),
      }
    : undefined;
  const mesh: IndexedMesh = {
    vertices,
    indices: [...node.mesh.indices],
    attributes,
  };
  const nodes = scene.nodes.map((candidate, candidateIndex) =>
    candidateIndex === index ? { ...candidate, mesh } : candidate,
  );
  const next = { nodes };
  validateEditorScene(next);
  return next;
}

function replaceNodeMesh(scene: EditorScene, nodeId: string, mesh: IndexedMesh): EditorScene {
  const index = findNodeIndex(scene, nodeId);
  const nodes = scene.nodes.map((candidate, candidateIndex) =>
    candidateIndex === index ? { ...candidate, mesh: cloneMesh(mesh) } : candidate,
  );
  const next = { nodes };
  validateEditorScene(next);
  return next;
}

export function createEditorHistory(scene: EditorScene = createEditorScene()): EditorHistory {
  validateEditorScene(scene);
  return { present: cloneEditorScene(scene), undo: [], redo: [] };
}

function pushCommand(history: EditorHistory, command: EditorCommand, present: EditorScene): EditorHistory {
  const undo = [...history.undo, command].slice(-MAX_EDITOR_HISTORY);
  return { present, undo, redo: [] };
}

export function commitNodeTransform(
  history: EditorHistory,
  nodeId: string,
  patch: Partial<EditableTransform>,
): EditorHistory {
  const index = findNodeIndex(history.present, nodeId);
  const before = cloneTransform(history.present.nodes[index].transform);
  const present = updateNodeTransform(history.present, nodeId, patch);
  const after = cloneTransform(present.nodes[index].transform);
  if (transformEqual(before, after)) return history;
  return pushCommand(history, { kind: "node-transform", nodeId, before, after }, present);
}

export function commitMeshVertex(
  history: EditorHistory,
  nodeId: string,
  vertexIndex: number,
  position: Vec3,
): EditorHistory {
  const index = findNodeIndex(history.present, nodeId);
  const sourceMesh = history.present.nodes[index].mesh;
  const before = sourceMesh?.vertices[vertexIndex];
  if (!sourceMesh || !before) throw new Error(`vertex ${vertexIndex} is outside node ${nodeId}`);
  if (vec3Equal(before, position)) return history;
  const beforeMesh = cloneMesh(sourceMesh);
  const present = updateMeshVertex(history.present, nodeId, vertexIndex, position);
  const afterMesh = cloneMesh(present.nodes[index].mesh!);
  return pushCommand(history, {
    kind: "vertex-position",
    nodeId,
    vertexIndex,
    before: cloneVec3(before),
    after: cloneVec3(position),
    beforeMesh,
    afterMesh,
  }, present);
}

export function replaceEditorScene(history: EditorHistory, scene: EditorScene): EditorHistory {
  validateEditorScene(scene);
  if (sceneEqual(history.present, scene)) return history;
  const after = cloneEditorScene(scene);
  return pushCommand(history, {
    kind: "replace-scene",
    before: cloneEditorScene(history.present),
    after: cloneEditorScene(after),
  }, after);
}

function applyCommand(scene: EditorScene, command: EditorCommand, forward: boolean): EditorScene {
  switch (command.kind) {
    case "node-transform":
      return updateNodeTransform(scene, command.nodeId, forward ? command.after : command.before);
    case "vertex-position":
      return replaceNodeMesh(scene, command.nodeId, forward ? command.afterMesh : command.beforeMesh);
    case "replace-scene":
      return cloneEditorScene(forward ? command.after : command.before);
  }
}

export function undoEditorHistory(history: EditorHistory): EditorHistory {
  const command = history.undo[history.undo.length - 1];
  if (!command) return history;
  return {
    present: applyCommand(history.present, command, false),
    undo: history.undo.slice(0, -1),
    redo: [command, ...history.redo].slice(0, MAX_EDITOR_HISTORY),
  };
}

export function redoEditorHistory(history: EditorHistory): EditorHistory {
  const command = history.redo[0];
  if (!command) return history;
  return {
    present: applyCommand(history.present, command, true),
    undo: [...history.undo, command].slice(-MAX_EDITOR_HISTORY),
    redo: history.redo.slice(1),
  };
}
