import { describe, expect, test } from "bun:test";
import { cubeMesh, expandedVertexCount, triangleCount, triangleMesh } from "./mesh";

describe("mesh lesson data", () => {
  test("a triangle has three indexed corners", () => {
    expect(triangleMesh.vertices).toHaveLength(3);
    expect(triangleCount(triangleMesh)).toBe(1);
  });

  test("an indexed cube reuses eight positions for twelve triangles", () => {
    expect(cubeMesh.vertices).toHaveLength(8);
    expect(triangleCount(cubeMesh)).toBe(12);
    expect(expandedVertexCount(cubeMesh)).toBe(36);
  });
});
