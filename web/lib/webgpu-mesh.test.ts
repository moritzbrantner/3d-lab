import { describe, expect, test } from "bun:test";
import { triangleMesh } from "./mesh";
import { packWebGpuMesh } from "./webgpu-mesh";

describe("browser WebGPU mesh packing", () => {
  test("preserves renderer-independent vertex and index order", () => {
    const packed = packWebGpuMesh(triangleMesh);

    expect(Array.from(packed.vertices)).toEqual(triangleMesh.vertices.flat());
    expect(Array.from(packed.indices)).toEqual(triangleMesh.indices);
  });
});
