import { describe, expect, test } from "bun:test";
import { createEditorScene, validateEditorScene, type EditorScene } from "./scene-editor";
import {
  canRedoEditorCommand,
  canUndoEditorCommand,
  commitMeshVertex,
  commitNodeTransform,
  createEditorCommandLog,
  redoEditorCommand,
  replayEditorCommands,
  undoEditorCommand,
} from "./scene-editor-history";

describe("scene editor command log", () => {
  test("transform commands undo and redo without scene snapshots", () => {
    const initial = createEditorScene();
    const sideBefore = initial.nodes.find((node) => node.id === "side");
    let log = createEditorCommandLog(initial);

    log = commitNodeTransform(log, "mast", { translation: [0.5, 1, 0] });
    expect(log.entries).toHaveLength(1);
    expect(log.cursor).toBe(1);
    expect(log.entries[0]).not.toHaveProperty("scene");
    expect(log.scene.nodes.find((node) => node.id === "side")).toBe(sideBefore);
    expect(log.scene.nodes.find((node) => node.id === "mast")?.transform.translation).toEqual([0.5, 1, 0]);
    expect(canUndoEditorCommand(log)).toBe(true);
    expect(canRedoEditorCommand(log)).toBe(false);

    log = undoEditorCommand(log);
    expect(log.cursor).toBe(0);
    expect(log.scene.nodes.find((node) => node.id === "mast")?.transform.translation).toEqual([0.35, 0.7, 0]);
    expect(canRedoEditorCommand(log)).toBe(true);

    log = redoEditorCommand(log);
    expect(log.cursor).toBe(1);
    expect(log.scene.nodes.find((node) => node.id === "mast")?.transform.translation).toEqual([0.5, 1, 0]);
    expect(() => validateEditorScene(log.scene)).not.toThrow();
  });

  test("vertex undo restores the exact derived attribute state by reference", () => {
    const normals = [[0, 0, 1], [0, 0, 1], [0, 0, 1]] as const;
    const tangents = [[1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1]] as const;
    const uvs = [[0, 0], [1, 0], [0, 1]] as const;
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
            attributes: { normals, tangents, uvs },
          },
        },
      ],
    };
    let log = createEditorCommandLog(scene);

    log = commitMeshVertex(log, "mesh", 2, [0, 1.5, 0]);
    expect(log.scene.nodes[0].mesh?.attributes?.normals).toBeUndefined();
    expect(log.scene.nodes[0].mesh?.attributes?.tangents).toBeUndefined();
    expect(log.scene.nodes[0].mesh?.attributes?.uvs).toBe(uvs);

    log = undoEditorCommand(log);
    expect(log.scene.nodes[0].mesh?.vertices[2]).toEqual([0, 1, 0]);
    expect(log.scene.nodes[0].mesh?.attributes?.normals).toBe(normals);
    expect(log.scene.nodes[0].mesh?.attributes?.tangents).toBe(tangents);
    expect(log.scene.nodes[0].mesh?.attributes?.uvs).toBe(uvs);

    log = redoEditorCommand(log);
    expect(log.scene.nodes[0].mesh?.vertices[2]).toEqual([0, 1.5, 0]);
    expect(log.scene.nodes[0].mesh?.attributes?.normals).toBeUndefined();
    expect(log.scene.nodes[0].mesh?.attributes?.tangents).toBeUndefined();
  });

  test("committing after undo truncates the redo branch", () => {
    let log = createEditorCommandLog(createEditorScene());
    log = commitNodeTransform(log, "mast", { translation: [0.4, 0.8, 0] });
    log = commitNodeTransform(log, "mast", { translation: [0.5, 0.9, 0] });
    log = undoEditorCommand(log);
    expect(canRedoEditorCommand(log)).toBe(true);

    log = commitNodeTransform(log, "mast", { translation: [0.6, 1, 0] });
    expect(log.entries).toHaveLength(2);
    expect(log.cursor).toBe(2);
    expect(canRedoEditorCommand(log)).toBe(false);
    expect(log.scene.nodes.find((node) => node.id === "mast")?.transform.translation).toEqual([0.6, 1, 0]);
  });

  test("no-op edits do not create history entries", () => {
    const scene = createEditorScene();
    const body = scene.nodes.find((node) => node.id === "body");
    const bodyVertex = body?.mesh?.vertices[0];
    expect(bodyVertex).toBeDefined();
    let log = createEditorCommandLog(scene);

    log = commitNodeTransform(log, "mast", { translation: [0.35, 0.7, 0] });
    log = commitMeshVertex(log, "body", 0, bodyVertex!);
    expect(log.entries).toHaveLength(0);
    expect(log.scene).toBe(scene);
  });

  test("replaying semantic commands deterministically reproduces the current scene", () => {
    const initial = createEditorScene();
    let log = createEditorCommandLog(initial);
    log = commitNodeTransform(log, "mast", { rotation: [0.1, 0.2, 0.3] });
    log = commitMeshVertex(log, "body", 3, [-0.75, 0.5, -0.5]);
    log = commitNodeTransform(log, "side", { scale: [0.5, 0.4, 0.8] });

    const replayed = replayEditorCommands(initial, log.entries);
    expect(replayed).toEqual(log.scene);
    expect(() => validateEditorScene(replayed)).not.toThrow();
  });

  test("undo fails closed when command preconditions no longer match", () => {
    let log = createEditorCommandLog(createEditorScene());
    log = commitNodeTransform(log, "mast", { translation: [0.5, 1, 0] });
    const nodes = [...log.scene.nodes];
    const mastIndex = nodes.findIndex((node) => node.id === "mast");
    nodes[mastIndex] = {
      ...nodes[mastIndex],
      transform: { ...nodes[mastIndex].transform, translation: [99, 99, 99] },
    };
    const drifted = { ...log, scene: { nodes } };
    expect(() => undoEditorCommand(drifted)).toThrow("editor command precondition failed for node mast");
  });
});
