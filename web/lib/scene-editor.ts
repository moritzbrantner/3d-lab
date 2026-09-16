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

function finiteVec3(value: Vec3): boolean {
  return value.every(Number.isFinite);
}

function findNodeIndex(scene: EditorScene, nodeId: string): number {
  const index = scene.nodes.findIndex((node) => node.id === nodeId);
  if (index < 0) throw new Error(`unknown node ${nodeId}`);
  return index;
}

function replaceNode(scene: EditorScene, index: number, node: EditorNode): EditorScene {
  const nodes = [...scene.nodes];
  nodes[index] = node;
  return { nodes };
}

function validateTransform(nodeId: string, transform: EditableTransform): void {
  if (!finiteVec3(transform.translation)) throw new Error(`node ${nodeId} has a non-finite translation`);
  if (!finiteVec3(transform.rotation)) throw new Error(`node ${nodeId} has a non-finite rotation`);
  if (!finiteVec3(transform.scale)) throw new Error(`node ${nodeId} has a non-finite scale`);
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
    validateTransform(node.id, node.transform);
    if (node.mesh) validateMesh(node.mesh);
    seen.add(node.id);
  });
}

export function childrenOf(scene: EditorScene, parent: string | null): readonly EditorNode[] {
  return scene.nodes.filter((node) => node.parent === parent);
}

/**
 * Apply a transform edit to an already validated editor scene.
 *
 * Imported or externally constructed scenes must pass validateEditorScene once at the trust boundary.
 * Local edits then validate only the values they introduce and preserve every unrelated invariant by
 * structural sharing instead of revalidating meshes and sibling nodes on each interaction.
 */
export function updateNodeTransform(
  scene: EditorScene,
  nodeId: string,
  patch: Partial<EditableTransform>,
): EditorScene {
  const index = findNodeIndex(scene, nodeId);
  const node = scene.nodes[index];
  const transform: EditableTransform = {
    translation: patch.translation ? cloneVec3(patch.translation) : node.transform.translation,
    rotation: patch.rotation ? cloneVec3(patch.rotation) : node.transform.rotation,
    scale: patch.scale ? cloneVec3(patch.scale) : node.transform.scale,
  };
  validateTransform(nodeId, transform);
  return replaceNode(scene, index, { ...node, transform });
}

/**
 * Apply one position edit to an already validated editor scene.
 *
 * Only the vertex-reference array and the edited Vec3 are materialized. Index data, unaffected vertex
 * tuples, UV/color authoring attributes, sibling nodes, and transforms are reused. Normals and tangents
 * remain intentionally invalidated because they are derived from positions.
 */
export function updateMeshVertex(scene: EditorScene, nodeId: string, vertexIndex: number, position: Vec3): EditorScene {
  if (!finiteVec3(position)) throw new Error("vertex position must be finite");
  const index = findNodeIndex(scene, nodeId);
  const node = scene.nodes[index];
  if (!node.mesh) throw new Error(`node ${nodeId} does not own a mesh`);
  if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= node.mesh.vertices.length) {
    throw new Error(`vertex ${vertexIndex} is outside node ${nodeId}`);
  }

  const vertices = [...node.mesh.vertices];
  vertices[vertexIndex] = cloneVec3(position);
  const sourceAttributes = node.mesh.attributes;
  const attributes = sourceAttributes
    ? {
        uvs: sourceAttributes.uvs,
        colors: sourceAttributes.colors,
      }
    : undefined;
  const mesh: IndexedMesh = {
    vertices,
    indices: node.mesh.indices,
    attributes,
  };
  return replaceNode(scene, index, { ...node, mesh });
}
