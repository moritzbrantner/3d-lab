import { describe, expect, test } from "bun:test";
import type { EditorScene } from "./scene-editor";
import {
  commitMeshTopology,
  createEditorCommandLog,
  redoEditorCommand,
  replayEditorCommands,
  undoEditorCommand,
} from "./scene-editor-history";
import { createMeshTopologyIndex } from "./scene-editor-topology";

function topologyScene(): EditorScene {
  return {
    nodes: [
      {
        id: "mesh",
        name: "Mesh",
        parent: null,
        transform: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        mesh: {
          vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
          indices: [0, 1, 2, 0, 2, 3],
        },
      },
    ],
  };
}

describe("editor topology command history", () => {
  test("split edge is one semantic command with exact undo and redo", () => {
    const initial = topologyScene();
    const base = createEditorCommandLog(initial);
    const mesh = base.scene.nodes[0].mesh!;
    const index = createMeshTopologyIndex(mesh);
    const edited = commitMeshTopology(base, "mesh", { kind: "split-edge", edge: [0, 2] }, index);

    expect(edited.entries).toHaveLength(1);
    expect(edited.entries[0].kind).toBe("edit-mesh-topology");
    if (edited.entries[0].kind !== "edit-mesh-topology") throw new Error("expected topology command");
    expect(edited.entries[0].observations.topologyIndexBuildCount).toBe(0);
    expect(edited.scene.nodes[0].mesh?.vertices).toHaveLength(5);

    const undone = undoEditorCommand(edited);
    expect(undone.scene).toEqual(initial);
    expect(undone.cursor).toBe(0);

    const redone = redoEditorCommand(undone);
    expect(redone.scene).toEqual(edited.scene);
    expect(redone.cursor).toBe(1);
  });

  test("face operations replay deterministically", () => {
    const initial = topologyScene();
    let log = createEditorCommandLog(initial);
    log = commitMeshTopology(log, "mesh", { kind: "inset-face", triangleIndex: 0, ratio: 0.25 });
    log = commitMeshTopology(log, "mesh", { kind: "extrude-face", triangleIndex: 7, distance: 0.2 });

    const replayed = replayEditorCommands(initial, log.entries);
    expect(replayed).toEqual(log.scene);

    const undoneTwice = undoEditorCommand(undoEditorCommand(log));
    expect(undoneTwice.scene).toEqual(initial);
    expect(redoEditorCommand(redoEditorCommand(undoneTwice)).scene).toEqual(log.scene);
  });

  test("committing after undo truncates the topology redo suffix", () => {
    const initial = topologyScene();
    let log = createEditorCommandLog(initial);
    log = commitMeshTopology(log, "mesh", { kind: "inset-face", triangleIndex: 0, ratio: 0.25 });
    log = undoEditorCommand(log);
    log = commitMeshTopology(log, "mesh", { kind: "extrude-face", triangleIndex: 0, distance: 0.2 });
    expect(log.entries).toHaveLength(1);
    expect(log.cursor).toBe(1);
    expect(log.entries[0].kind).toBe("edit-mesh-topology");
    if (log.entries[0].kind !== "edit-mesh-topology") throw new Error("expected topology command");
    expect(log.entries[0].operation.kind).toBe("extrude-face");
  });

  test("topology undo fails closed when semantic mesh state was changed outside history", () => {
    const initial = topologyScene();
    const edited = commitMeshTopology(
      createEditorCommandLog(initial),
      "mesh",
      { kind: "inset-face", triangleIndex: 0, ratio: 0.25 },
    );
    const mesh = edited.scene.nodes[0].mesh!;
    const vertices = [...mesh.vertices];
    vertices[vertices.length - 1] = [9, 9, 9];
    const stale = {
      ...edited,
      scene: {
        nodes: [{ ...edited.scene.nodes[0], mesh: { ...mesh, vertices } }],
      },
    };
    expect(() => undoEditorCommand(stale)).toThrow("appended-vertex precondition");
  });
});
