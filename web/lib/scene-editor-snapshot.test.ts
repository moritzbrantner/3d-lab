import { describe, expect, test } from "bun:test";
import { createEditorScene, updateMeshVertex, updateNodeTransform, type EditorScene } from "./scene-editor";
import {
  EDITOR_SCENE_SNAPSHOT_SCHEMA,
  MAX_EDITOR_SCENE_SNAPSHOT_DEPTH,
  MAX_EDITOR_SCENE_SNAPSHOT_FILE_BYTES,
  MAX_EDITOR_SCENE_SNAPSHOT_INDICES_PER_MESH,
  MAX_EDITOR_SCENE_SNAPSHOT_NODES,
  MAX_EDITOR_SCENE_SNAPSHOT_TOTAL_VERTICES,
  MAX_EDITOR_SCENE_SNAPSHOT_VERTICES_PER_MESH,
  decodeEditorSceneSnapshot,
  parseEditorSceneSnapshot,
  serializeEditorSceneSnapshot,
  validateEditorSceneSnapshotFileSize,
} from "./scene-editor-snapshot";

describe("editor scene snapshots", () => {
  test("round-trips edited scene state deterministically", () => {
    let scene = createEditorScene();
    scene = updateNodeTransform(scene, "mast", { translation: [0.625, 1.25, -0.125] });
    scene = updateMeshVertex(scene, "body", 0, [-0.875, -0.5, -0.5]);

    const encoded = serializeEditorSceneSnapshot(scene);
    expect(encoded).not.toContain("\n  ");
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

    const tooMany: unknown[] = Array.from(
      { length: MAX_EDITOR_SCENE_SNAPSHOT_NODES + 1 },
      (_, index) => node(index, null),
    );
    tooMany[0] = {};
    expect(() => decodeEditorSceneSnapshot({
      schema: EDITOR_SCENE_SNAPSHOT_SCHEMA,
      nodes: tooMany,
    })).toThrow("node count");
  });

  test("bounds mesh and aggregate geometry before copying payload arrays", () => {
    const meshNode = (id: string, vertices: unknown[], indices: unknown[]) => ({
      id,
      name: id,
      parent: null,
      transform: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      mesh: { vertices, indices },
    });

    expect(() => decodeEditorSceneSnapshot({
      schema: EDITOR_SCENE_SNAPSHOT_SCHEMA,
      nodes: [meshNode(
        "too-many-vertices",
        Array(MAX_EDITOR_SCENE_SNAPSHOT_VERTICES_PER_MESH + 1).fill([0, 0, 0]),
        [0, 0, 0],
      )],
    })).toThrow("vertices count");

    expect(() => decodeEditorSceneSnapshot({
      schema: EDITOR_SCENE_SNAPSHOT_SCHEMA,
      nodes: [meshNode(
        "too-many-indices",
        [[0, 0, 0]],
        Array(MAX_EDITOR_SCENE_SNAPSHOT_INDICES_PER_MESH + 1).fill(0),
      )],
    })).toThrow("indices count");

    const firstCount = Math.floor(MAX_EDITOR_SCENE_SNAPSHOT_TOTAL_VERTICES / 2);
    const secondCount = MAX_EDITOR_SCENE_SNAPSHOT_TOTAL_VERTICES - firstCount;
    expect(() => decodeEditorSceneSnapshot({
      schema: EDITOR_SCENE_SNAPSHOT_SCHEMA,
      nodes: [
        meshNode("aggregate-a", Array(firstCount).fill([0, 0, 0]), [0, 0, 0]),
        meshNode("aggregate-b", Array(secondCount).fill([0, 0, 0]), [0, 0, 0]),
        meshNode("aggregate-overflow", [[0, 0, 0]], [0, 0, 0]),
      ],
    })).toThrow("total vertex limit");
  });

  test("rejects oversized file metadata before the UI reads it", () => {
    expect(() => validateEditorSceneSnapshotFileSize(MAX_EDITOR_SCENE_SNAPSHOT_FILE_BYTES)).not.toThrow();
    expect(() => validateEditorSceneSnapshotFileSize(MAX_EDITOR_SCENE_SNAPSHOT_FILE_BYTES + 1))
      .toThrow("file size");
  });

  test("serializer never returns a snapshot larger than the import limit", () => {
    const scene = createEditorScene();
    const nodes = [...scene.nodes];
    nodes[0] = { ...nodes[0], name: "x".repeat(MAX_EDITOR_SCENE_SNAPSHOT_FILE_BYTES) };
    expect(() => serializeEditorSceneSnapshot({ nodes })).toThrow("file size");
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
