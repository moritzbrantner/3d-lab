import { describe, expect, test } from "bun:test";
import { createEditorScene, updateMeshVertex, updateNodeTransform, type EditorScene } from "./scene-editor";
import {
  EDITOR_SCENE_SNAPSHOT_SCHEMA,
  MAX_EDITOR_SCENE_SNAPSHOT_DEPTH,
  MAX_EDITOR_SCENE_SNAPSHOT_ERROR_MESSAGE_CHARS,
  MAX_EDITOR_SCENE_SNAPSHOT_FILE_BYTES,
  MAX_EDITOR_SCENE_SNAPSHOT_INDICES_PER_MESH,
  MAX_EDITOR_SCENE_SNAPSHOT_NODES,
  MAX_EDITOR_SCENE_SNAPSHOT_NODE_ID_CHARS,
  MAX_EDITOR_SCENE_SNAPSHOT_NODE_NAME_CHARS,
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
      .toThrow('unsupported field "history"');
  });

  test("bounds untrusted strings in import error messages", () => {
    const snapshot = JSON.parse(serializeEditorSceneSnapshot(createEditorScene()));
    const huge = "x".repeat(1_000_000);
    const errorMessage = (value: unknown): string => {
      try {
        decodeEditorSceneSnapshot(value);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected decode to fail");
    };

    const schemaMessage = errorMessage({ ...snapshot, schema: huge });
    expect(schemaMessage).toContain("unsupported scene snapshot schema");
    expect(schemaMessage).toContain(`(${huge.length} chars)`);
    expect(schemaMessage).toContain(EDITOR_SCENE_SNAPSHOT_SCHEMA);
    expect(schemaMessage.length).toBeLessThan(256);

    const fieldMessage = errorMessage({ ...snapshot, [huge]: true });
    expect(fieldMessage).toContain("unsupported field");
    expect(fieldMessage.length).toBeLessThan(256);

    const duplicateIds = JSON.parse(serializeEditorSceneSnapshot(createEditorScene()));
    const longId = "x".repeat(MAX_EDITOR_SCENE_SNAPSHOT_NODE_ID_CHARS);
    duplicateIds.nodes[0].id = longId;
    duplicateIds.nodes[1].id = longId;
    duplicateIds.nodes[1].parent = null;
    const duplicateMessage = errorMessage(duplicateIds);
    expect(duplicateMessage).toContain("duplicate node id");
    expect(duplicateMessage.length).toBeLessThanOrEqual(MAX_EDITOR_SCENE_SNAPSHOT_ERROR_MESSAGE_CHARS + 1);
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

  test("rejects finite numbers that overflow f32 on import and export", () => {
    const overflowVertex = JSON.parse(serializeEditorSceneSnapshot(createEditorScene()));
    const body = overflowVertex.nodes.find((node: { id: string }) => node.id === "body");
    body.mesh.vertices[0][1] = 1e100;
    expect(() => decodeEditorSceneSnapshot(overflowVertex))
      .toThrow("scene snapshot node 1.mesh.vertices[0][1] must be within the f32 range");

    const overflowTransform = JSON.parse(serializeEditorSceneSnapshot(createEditorScene()));
    overflowTransform.nodes[0].transform.scale[2] = -1e39;
    expect(() => decodeEditorSceneSnapshot(overflowTransform))
      .toThrow("transform.scale[2] must be within the f32 range");

    const atLimit = JSON.parse(serializeEditorSceneSnapshot(createEditorScene()));
    atLimit.nodes[0].transform.translation[0] = 3.4028234663852886e38;
    expect(decodeEditorSceneSnapshot(atLimit).nodes[0].transform.translation[0]).toBe(3.4028234663852886e38);

    const scene = updateMeshVertex(createEditorScene(), "body", 0, [1e100, 0, 0]);
    expect(() => serializeEditorSceneSnapshot(scene))
      .toThrow("scene snapshot node body.mesh.vertices[0][0] must be within the f32 range");
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

  test("bounds imported node names and ids before they reach hierarchy and inspector text", () => {
    const node = (id: string, name: string) => ({
      id,
      name,
      parent: null,
      transform: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    const atLimit = decodeEditorSceneSnapshot({
      schema: EDITOR_SCENE_SNAPSHOT_SCHEMA,
      nodes: [node("i".repeat(MAX_EDITOR_SCENE_SNAPSHOT_NODE_ID_CHARS), "n".repeat(MAX_EDITOR_SCENE_SNAPSHOT_NODE_NAME_CHARS))],
    });
    expect(atLimit.nodes[0]?.name.length).toBe(MAX_EDITOR_SCENE_SNAPSHOT_NODE_NAME_CHARS);

    const hugeName = "word ".repeat(200_000);
    const decodeName = () => decodeEditorSceneSnapshot({
      schema: EDITOR_SCENE_SNAPSHOT_SCHEMA,
      nodes: [node("root", hugeName)],
    });
    expect(decodeName).toThrow(`name length ${hugeName.length} exceeds limit ${MAX_EDITOR_SCENE_SNAPSHOT_NODE_NAME_CHARS}`);
    try {
      decodeName();
    } catch (error) {
      expect((error as Error).message.length).toBeLessThanOrEqual(MAX_EDITOR_SCENE_SNAPSHOT_ERROR_MESSAGE_CHARS + 1);
      expect((error as Error).message).not.toContain("word word");
    }

    expect(() => decodeEditorSceneSnapshot({
      schema: EDITOR_SCENE_SNAPSHOT_SCHEMA,
      nodes: [node("i".repeat(MAX_EDITOR_SCENE_SNAPSHOT_NODE_ID_CHARS + 1), "Root")],
    })).toThrow(`id length ${MAX_EDITOR_SCENE_SNAPSHOT_NODE_ID_CHARS + 1} exceeds limit`);

    const scene = createEditorScene();
    const renamed: EditorScene = {
      nodes: scene.nodes.map((entry, index) =>
        index === 0 ? { ...entry, name: "n".repeat(MAX_EDITOR_SCENE_SNAPSHOT_NODE_NAME_CHARS + 1) } : entry,
      ),
    };
    expect(() => serializeEditorSceneSnapshot(renamed)).toThrow("name length");
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
    // Every per-mesh and aggregate budget passes, but long f32-representable decimals across all
    // vertex attributes push the serialized JSON past the byte limit.
    const component = -1.2345678901234567e-30;
    const count = MAX_EDITOR_SCENE_SNAPSHOT_VERTICES_PER_MESH;
    const vec = <N extends number>(length: N) => Array.from({ length }, () => component);
    nodes[0] = {
      ...nodes[0],
      mesh: {
        vertices: Array.from({ length: count }, () => vec(3) as [number, number, number]),
        indices: [],
        attributes: {
          normals: Array.from({ length: count }, () => vec(3) as [number, number, number]),
          tangents: Array.from({ length: count }, () => vec(4) as [number, number, number, number]),
          uvs: Array.from({ length: count }, () => vec(2) as [number, number]),
          colors: Array.from({ length: count }, () => vec(3) as [number, number, number]),
        },
      },
    };
    expect(() => serializeEditorSceneSnapshot({ nodes })).toThrow("file size");
  });

  test("serializer applies the same node and geometry budgets the decoder enforces", () => {
    const transform = { translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } as const;
    const flatNode = (index: number) => ({
      id: `node-${index}`,
      name: `Node ${index}`,
      parent: null,
      transform: {
        translation: [...transform.translation],
        rotation: [...transform.rotation],
        scale: [...transform.scale],
      },
    }) as EditorScene["nodes"][number];
    const meshNode = (id: string, vertexCount: number) => ({
      ...flatNode(0),
      id,
      name: id,
      mesh: {
        vertices: Array.from({ length: vertexCount }, (_, index) => [index, 0, 0] as [number, number, number]),
        indices: [0, 1, 2],
      },
    }) as EditorScene["nodes"][number];

    const tooManyNodes: EditorScene = {
      nodes: Array.from({ length: MAX_EDITOR_SCENE_SNAPSHOT_NODES + 1 }, (_, index) => flatNode(index)),
    };
    expect(() => serializeEditorSceneSnapshot(tooManyNodes)).toThrow("node count");

    const oversizedMesh: EditorScene = {
      nodes: [meshNode("oversized", MAX_EDITOR_SCENE_SNAPSHOT_VERTICES_PER_MESH + 1)],
    };
    expect(() => serializeEditorSceneSnapshot(oversizedMesh)).toThrow("vertices count");

    const half = MAX_EDITOR_SCENE_SNAPSHOT_TOTAL_VERTICES / 2;
    const overAggregate: EditorScene = {
      nodes: [meshNode("a", half), meshNode("b", half), meshNode("c", 3)],
    };
    expect(() => serializeEditorSceneSnapshot(overAggregate)).toThrow("total vertex limit");

    const atLimit: EditorScene = {
      nodes: Array.from({ length: MAX_EDITOR_SCENE_SNAPSHOT_NODES }, (_, index) => flatNode(index)),
    };
    expect(parseEditorSceneSnapshot(serializeEditorSceneSnapshot(atLimit))).toEqual(atLimit);
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
