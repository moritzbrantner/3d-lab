import { describe, expect, test } from "bun:test";
import { cubeMesh } from "./mesh";
import {
  childrenOf,
  commitMeshVertex,
  commitNodeTransform,
  createEditorHistory,
  createEditorScene,
  meshEdges,
  redoEditorHistory,
  replaceEditorScene,
  triangleVertexIndices,
  undoEditorHistory,
  updateMeshVertex,
  updateNodeTransform,
  validateEditorScene,
  type EditorScene,
} from "./scene-editor";

describe("scene editor model", () => {
  test("default hierarchy is parent-before-child and mesh-valid", () => {
    const scene = createEditorScene();
    expect(() => validateEditorScene(scene)).not.toThrow();
    expect(childrenOf(scene, "body").map((node) => node.id)).toEqual(["mast", "side"]);
  });

  test("hierarchy validation rejects forward parent references", () => {
    const scene: EditorScene = {
      nodes: [
        {
          id: "child",
          name: "Child",
          parent: "parent",
          transform: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
        {
          id: "parent",
          name: "Parent",
          parent: null,
          transform: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
      ],
    };
    expect(() => validateEditorScene(scene)).toThrow("parents must appear before children");
  });

  test("vertex edits are immutable and targeted", () => {
    const scene = createEditorScene();
    const body = scene.nodes.find((node) => node.id === "body");
    const original = body?.mesh?.vertices[0];
    const edited = updateMeshVertex(scene, "body", 0, [-0.9, -0.5, -0.5]);
    expect(original).toEqual(cubeMesh.vertices[0]);
    expect(edited.nodes.find((node) => node.id === "body")?.mesh?.vertices[0]).toEqual([-0.9, -0.5, -0.5]);
  });

  test("moving positions invalidates derived normals and tangents but preserves UV/color authoring data", () => {
    const scene: EditorScene = {
      nodes: [
        {
          id: "mesh",
          name: "Mesh",
          parent: null,
          transform: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          mesh: {
            vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
            indices: [0, 1, 2],
            attributes: {
              normals: [[0, 0, 1], [0, 0, 1], [0, 0, 1]],
              tangents: [[1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1]],
              uvs: [[0, 0], [1, 0], [0, 1]],
              colors: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
            },
          },
        },
      ],
    };
    const edited = updateMeshVertex(scene, "mesh", 2, [0, 1.5, 0]);
    expect(edited.nodes[0].mesh?.attributes?.normals).toBeUndefined();
    expect(edited.nodes[0].mesh?.attributes?.tangents).toBeUndefined();
    expect(edited.nodes[0].mesh?.attributes?.uvs).toEqual([[0, 0], [1, 0], [0, 1]]);
    expect(edited.nodes[0].mesh?.attributes?.colors).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  });

  test("transform edits do not touch sibling nodes", () => {
    const scene = createEditorScene();
    const sideBefore = scene.nodes.find((node) => node.id === "side")?.transform;
    const edited = updateNodeTransform(scene, "mast", { translation: [0.5, 1, 0] });
    expect(edited.nodes.find((node) => node.id === "mast")?.transform.translation).toEqual([0.5, 1, 0]);
    expect(edited.nodes.find((node) => node.id === "side")?.transform).toEqual(sideBefore);
  });

  test("vertex bounds remain fail-closed", () => {
    const scene = createEditorScene();
    expect(() => updateMeshVertex(scene, "body", 999, [0, 0, 0])).toThrow("is outside node body");
  });

  test("indexed topology exposes stable canonical edges and face references", () => {
    expect(meshEdges(cubeMesh)).toHaveLength(18);
    expect(meshEdges(cubeMesh)).toContainEqual([0, 2]);
    expect(triangleVertexIndices(cubeMesh, 0)).toEqual([0, 2, 1]);
    expect(() => triangleVertexIndices(cubeMesh, 12)).toThrow("face 12 is outside mesh with 12 faces");
  });

  test("undo and redo replay model edit commands", () => {
    let history = createEditorHistory();
    history = commitNodeTransform(history, "mast", { translation: [0.6, 1.1, 0] });
    history = commitMeshVertex(history, "body", 0, [-0.8, -0.5, -0.5]);
    expect(history.undo.map((command) => command.kind)).toEqual(["node-transform", "vertex-position"]);

    history = undoEditorHistory(history);
    expect(history.present.nodes.find((node) => node.id === "body")?.mesh?.vertices[0]).toEqual(cubeMesh.vertices[0]);
    history = undoEditorHistory(history);
    expect(history.present.nodes.find((node) => node.id === "mast")?.transform.translation).toEqual([0.35, 0.7, 0]);

    history = redoEditorHistory(history);
    expect(history.present.nodes.find((node) => node.id === "mast")?.transform.translation).toEqual([0.6, 1.1, 0]);
  });

  test("undoing a vertex edit restores the exact prior mesh attributes", () => {
    const source: EditorScene = {
      nodes: [
        {
          id: "mesh",
          name: "Mesh",
          parent: null,
          transform: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          mesh: {
            vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
            indices: [0, 1, 2],
            attributes: { normals: [[0, 0, 1], [0, 0, 1], [0, 0, 1]] },
          },
        },
      ],
    };
    let history = createEditorHistory(source);
    history = commitMeshVertex(history, "mesh", 2, [0, 1.5, 0]);
    expect(history.present.nodes[0].mesh?.attributes?.normals).toBeUndefined();
    history = undoEditorHistory(history);
    expect(history.present.nodes[0].mesh?.attributes?.normals).toEqual([[0, 0, 1], [0, 0, 1], [0, 0, 1]]);
  });

  test("a new command after undo clears the redo branch", () => {
    let history = createEditorHistory();
    history = commitNodeTransform(history, "mast", { translation: [0.6, 1.1, 0] });
    history = undoEditorHistory(history);
    expect(history.redo).toHaveLength(1);
    history = commitNodeTransform(history, "side", { translation: [-1, 0, 0] });
    expect(history.redo).toHaveLength(0);
  });

  test("scene replacement is a model command and can itself be undone", () => {
    let history = createEditorHistory();
    history = commitNodeTransform(history, "mast", { translation: [0.6, 1.1, 0] });
    history = replaceEditorScene(history, createEditorScene());
    expect(history.present.nodes.find((node) => node.id === "mast")?.transform.translation).toEqual([0.35, 0.7, 0]);
    history = undoEditorHistory(history);
    expect(history.present.nodes.find((node) => node.id === "mast")?.transform.translation).toEqual([0.6, 1.1, 0]);
  });
});
