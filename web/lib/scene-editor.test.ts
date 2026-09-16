import { describe, expect, test } from "bun:test";
import { cubeMesh } from "./mesh";
import {
  childrenOf,
  createEditorScene,
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
    expect(() => validateEditorScene(edited)).not.toThrow();
  });

  test("vertex edits reuse all unaffected mesh and scene data", () => {
    const scene = createEditorScene();
    const bodyIndex = scene.nodes.findIndex((node) => node.id === "body");
    const sideIndex = scene.nodes.findIndex((node) => node.id === "side");
    const bodyBefore = scene.nodes[bodyIndex];
    const meshBefore = bodyBefore.mesh;
    expect(meshBefore).toBeDefined();

    const edited = updateMeshVertex(scene, "body", 0, [-0.9, -0.5, -0.5]);
    const meshAfter = edited.nodes[bodyIndex].mesh;
    expect(meshAfter).toBeDefined();

    expect(edited.nodes[sideIndex]).toBe(scene.nodes[sideIndex]);
    expect(meshAfter?.indices).toBe(meshBefore?.indices);
    expect(meshAfter?.vertices[1]).toBe(meshBefore?.vertices[1]);
    expect(meshAfter?.vertices[0]).not.toBe(meshBefore?.vertices[0]);
  });

  test("moving positions invalidates derived normals and tangents but reuses UV/color authoring data", () => {
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
    const attributesBefore = scene.nodes[0].mesh?.attributes;
    const edited = updateMeshVertex(scene, "mesh", 2, [0, 1.5, 0]);
    expect(edited.nodes[0].mesh?.attributes?.normals).toBeUndefined();
    expect(edited.nodes[0].mesh?.attributes?.tangents).toBeUndefined();
    expect(edited.nodes[0].mesh?.attributes?.uvs).toBe(attributesBefore?.uvs);
    expect(edited.nodes[0].mesh?.attributes?.colors).toBe(attributesBefore?.colors);
    expect(() => validateEditorScene(edited)).not.toThrow();
  });

  test("transform edits reuse siblings and untouched transform vectors", () => {
    const scene = createEditorScene();
    const mastIndex = scene.nodes.findIndex((node) => node.id === "mast");
    const sideIndex = scene.nodes.findIndex((node) => node.id === "side");
    const mastBefore = scene.nodes[mastIndex];
    const edited = updateNodeTransform(scene, "mast", { translation: [0.5, 1, 0] });
    const mastAfter = edited.nodes[mastIndex];

    expect(mastAfter.transform.translation).toEqual([0.5, 1, 0]);
    expect(mastAfter.transform.rotation).toBe(mastBefore.transform.rotation);
    expect(mastAfter.transform.scale).toBe(mastBefore.transform.scale);
    expect(edited.nodes[sideIndex]).toBe(scene.nodes[sideIndex]);
    expect(() => validateEditorScene(edited)).not.toThrow();
  });

  test("mutation values remain fail-closed", () => {
    const scene = createEditorScene();
    expect(() => updateMeshVertex(scene, "body", 999, [0, 0, 0])).toThrow("is outside node body");
    expect(() => updateMeshVertex(scene, "body", 0, [Number.NaN, 0, 0])).toThrow("vertex position must be finite");
    expect(() => updateNodeTransform(scene, "mast", { translation: [Number.POSITIVE_INFINITY, 0, 0] })).toThrow(
      "node mast has a non-finite translation",
    );
  });
});
