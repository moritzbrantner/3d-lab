import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { ANATOMY_STEPS, MINIMAL_MODEL_GLTF_DOCUMENT } from "./model-pipeline";

describe("minimal model glTF", () => {
  test("scene, node, mesh, primitive, and material references resolve", () => {
    const document = MINIMAL_MODEL_GLTF_DOCUMENT;
    const sceneNode = document.scenes[document.scene].nodes[0];
    const node = document.nodes[sceneNode];
    const mesh = document.meshes[node.mesh];
    const primitive = mesh.primitives[0];

    expect(document.accessors[primitive.attributes.POSITION].bufferView).toBe(0);
    expect(document.accessors[primitive.attributes.NORMAL].bufferView).toBe(1);
    expect(document.accessors[primitive.indices].bufferView).toBe(2);
    expect(document.materials[primitive.material].name).toBe("Blue PBR");
  });

  test("buffer views stay inside the declared binary buffer", () => {
    const document = MINIMAL_MODEL_GLTF_DOCUMENT;
    const encoded = document.buffers[0].uri.split(",")[1];
    const decoded = Buffer.from(encoded, "base64");

    expect(decoded.byteLength).toBe(document.buffers[0].byteLength);
    document.bufferViews.forEach((view) => {
      expect(view.byteOffset + view.byteLength).toBeLessThanOrEqual(decoded.byteLength);
    });
  });

  test("the teaching flow covers every durable glTF layer in order", () => {
    expect(ANATOMY_STEPS.map((step) => step.id)).toEqual([
      "scene",
      "node",
      "mesh",
      "primitive",
      "accessors",
      "buffer",
      "material",
    ]);
  });
});
