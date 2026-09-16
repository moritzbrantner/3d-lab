import { subdividedPlane } from "../web/lib/mesh";
import { validateEditorScene, type EditorNode, type EditorScene } from "../web/lib/scene-editor";
import {
  commitMeshVertex,
  commitNodeTransform,
  createEditorCommandLog,
  redoEditorCommand,
  undoEditorCommand,
} from "../web/lib/scene-editor-history";

const GRID_SEGMENTS = 96;
const AUXILIARY_NODE_COUNT = 128;
const TRANSFORM_EDIT_COUNT = 1024;
const VERTEX_EDIT_COUNT = 192;
const HISTORY_ROUND_TRIP_COUNT = VERTEX_EDIT_COUNT;

function identityTransform() {
  return {
    translation: [0, 0, 0] as const,
    rotation: [0, 0, 0] as const,
    scale: [1, 1, 1] as const,
  };
}

function createWorkloadScene(): EditorScene {
  const nodes: EditorNode[] = [
    {
      id: "root",
      name: "Root",
      parent: null,
      transform: identityTransform(),
    },
  ];

  for (let index = 0; index < AUXILIARY_NODE_COUNT; index += 1) {
    nodes.push({
      id: `helper-${index}`,
      name: `Helper ${index}`,
      parent: "root",
      transform: {
        translation: [index * 0.001, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    });
  }

  nodes.push({
    id: "editable-mesh",
    name: "Editable mesh",
    parent: "root",
    transform: identityTransform(),
    mesh: subdividedPlane(GRID_SEGMENTS),
  });

  return { nodes };
}

let history = createEditorCommandLog(createWorkloadScene());

for (let edit = 0; edit < TRANSFORM_EDIT_COUNT; edit += 1) {
  const x = ((edit % 31) - 15) * 0.001;
  const y = ((edit % 17) - 8) * 0.001;
  const z = ((edit % 11) - 5) * 0.001;
  history = commitNodeTransform(history, "editable-mesh", {
    translation: [x, y, z],
  });
}

for (let edit = 0; edit < VERTEX_EDIT_COUNT; edit += 1) {
  const mesh = history.scene.nodes[history.scene.nodes.length - 1].mesh;
  if (!mesh) throw new Error("editor mutation workload lost its mesh");
  const vertexIndex = (edit * 149 + 17) % mesh.vertices.length;
  const source = mesh.vertices[vertexIndex];
  history = commitMeshVertex(history, "editable-mesh", vertexIndex, [
    source[0],
    source[1] + ((edit % 7) + 1) * 0.0001,
    source[2],
  ]);
}

for (let index = 0; index < HISTORY_ROUND_TRIP_COUNT; index += 1) {
  history = undoEditorCommand(history);
}
for (let index = 0; index < HISTORY_ROUND_TRIP_COUNT; index += 1) {
  history = redoEditorCommand(history);
}

const scene = history.scene;
validateEditorScene(scene);

const mesh = scene.nodes[scene.nodes.length - 1].mesh;
if (!mesh) throw new Error("editor mutation workload lost its final mesh");
const vertexChecksum = mesh.vertices.reduce(
  (sum, vertex, index) => sum + vertex[0] * 3 + vertex[1] * 5 + vertex[2] * 7 + index * 0.000001,
  0,
);
const finalTransform = scene.nodes[scene.nodes.length - 1].transform;

console.log(
  JSON.stringify({
    nodeCount: scene.nodes.length,
    vertexCount: mesh.vertices.length,
    indexCount: mesh.indices.length,
    transformEditCount: TRANSFORM_EDIT_COUNT,
    vertexEditCount: VERTEX_EDIT_COUNT,
    historyEntryCount: history.entries.length,
    historyCursor: history.cursor,
    historyRoundTripCount: HISTORY_ROUND_TRIP_COUNT,
    finalTranslation: finalTransform.translation,
    vertexChecksum: Number(vertexChecksum.toFixed(6)),
  }),
);
