import { describe, expect, test } from "bun:test";
import { createEditorScene, updateMeshVertex, updateNodeTransform, type EditorScene } from "./scene-editor";
import {
  EDITOR_SCENE_SNAPSHOT_SCHEMA,
  MAX_EDITOR_SCENE_SNAPSHOT_DEPTH,
  MAX_EDITOR_SCENE_SNAPSHOT_NODES,
  decodeEditorSceneSnapshot,
  parseEditorSceneSnapshot,
  serializeEditorSceneSnapshot,
} from "./scene-editor-snapshot";

describe("editor scene snapshots", () => {
  test("round-trips edited scene state deterministically", () => {
    let scene = createEditorScene();
    scene = updateNodeTransform(scene, "mast", { translation: [0.625, 1.25, -0.125] });
    scene = updateMeshVertex(scene, "body", 0, [-0.875, -0.5, -0.5]);

    const encoded = serializeEditorSceneSnapshot(scene);
    expect(JSON.parse(encoded).schema).toBe(EDITOR_SCENE_SNAPSHOT_SCHEMA);
    const decoded = parseEditorSceneSnapshot(encoded);
    expect(decoded).toEqual(scene);
    expect(serializeEditorSceneSnapshot(decoded)).toBe(encoded);
  });

  test("preserves all format-neutral vertex attributes", () => {
    const scene: EditorScene = {
      nodes: [{
        id: "mesh",
        name: "Attributed mesh",
        parent: null,
        transform: { translation: [0, 0, 0], rotation: [0.1, 0.2, 0.3], scale: [1, 2, 1] },
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
      }],
    };
    expect(parseEditorSceneSnapshot(serializeEditorSceneSnapshot(scene))).toEqual(scene);
  });

  test("fails closed on schema drift and unsupported fields", () => {
    const snapshot = JSON.parse(serializeEditorSceneSnapshot(createEditorScene()));
    expect(() => decodeEditorSceneSnapshot({ ...snapshot, schema: "3d-lab/editor-scene-snapshot/v2" }))
      .toThrow("unsupported scene snapshot schema");
    expect(() => decodeEditorSceneSnapshot({ ...snapshot, history: [] }))
      .toThrow("unsupported field history");
  });

  test("validates hierarchy and mesh data at the import trust boundary", () => {
    const snapshot = JSON.parse(serializeEditorSceneSnapshot(createEditorScene()));
    const nodes = snapshot.nodes as Array<Record<string, unknown>>;
    const body = nodes.find((node) => node.id === "body");
    if (!body) throw new Error("expected body node");
    body.parent = "future-parent";
    expect(() => decodeEditorSceneSnapshot(snapshot)).toThrow("parents must appear before children");

    const invalidMesh = JSON.parse(serializeEditorSceneSnapshot(createEditorScene()));
    const invalidBody = invalidMesh.nodes.find((node: { id: string }) => node.id === "body");
    invalidBody.mesh.indices[0] = 9999;
    expect(() => decodeEditorSceneSnapshot(invalidMesh)).toThrow("outside the vertex buffer");
  });

  test("bounds imported hierarchy size and depth before it reaches recursive UI rendering", () => {
    const node = (index: number, parent: string | null) => ({
      id: `node-${index}`,
      name: `Node ${index}`,
      parent,
      transform: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });

    const tooDeep = Array.from({ length: MAX_EDITOR_SCENE_SNAPSHOT_DEPTH + 1 }, (_, index) =>
      node(index, index === 0 ? null : `node-${index - 1}`),
    );
    expect(() => decodeEditorSceneSnapshot({
      schema: EDITOR_SCENE_SNAPSHOT_SCHEMA,
      nodes: tooDeep,
    })).toThrow("hierarchy depth limit");

    const tooMany = Array.from({ length: MAX_EDITOR_SCENE_SNAPSHOT_NODES + 1 }, (_, index) =>
      node(index, null),
    );
    expect(() => decodeEditorSceneSnapshot({
      schema: EDITOR_SCENE_SNAPSHOT_SCHEMA,
      nodes: tooMany,
    })).toThrow("node count");
  });

  test("rejects empty scenes, malformed tuples, and invalid JSON explicitly", () => {
    expect(() => decodeEditorSceneSnapshot({ schema: EDITOR_SCENE_SNAPSHOT_SCHEMA, nodes: [] }))
      .toThrow("at least one node");

    const snapshot = JSON.parse(serializeEditorSceneSnapshot(createEditorScene()));
    snapshot.nodes[0].transform.translation = [0, 0];
    expect(() => decodeEditorSceneSnapshot(snapshot)).toThrow("exactly 3 numbers");
    expect(() => parseEditorSceneSnapshot("{not json")).toThrow("not valid JSON");
  });
});
