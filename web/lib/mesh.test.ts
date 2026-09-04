import { describe, expect, test } from "bun:test";
import {
  coloredTriangleMesh,
  cubeMesh,
  expandedVertexCount,
  smoothVertexNormals,
  subdividedPlane,
  triangleCount,
  triangleMesh,
  triangleNormal,
  uvQuadMesh,
  validateMesh,
} from "./mesh";

describe("mesh lesson data", () => {
  test("a triangle has three indexed corners", () => {
    expect(triangleMesh.vertices).toHaveLength(3);
    expect(triangleCount(triangleMesh)).toBe(1);
    expect(triangleNormal(triangleMesh, 0)).toEqual([0, 0, 1]);
  });

  test("an indexed cube reuses eight positions for twelve triangles", () => {
    expect(cubeMesh.vertices).toHaveLength(8);
    expect(triangleCount(cubeMesh)).toBe(12);
    expect(expandedVertexCount(cubeMesh)).toBe(36);
  });

  test("aligned UV and color attributes validate", () => {
    expect(() => validateMesh(uvQuadMesh)).not.toThrow();
    expect(() => validateMesh(coloredTriangleMesh)).not.toThrow();
  });

  test("attribute counts must match the position buffer", () => {
    expect(() => validateMesh({
      ...triangleMesh,
      attributes: { uvs: [[0, 0]] },
    })).toThrow("uv attribute count must match vertex count");
  });

  test("smooth normals accumulate adjacent face normals", () => {
    expect(smoothVertexNormals(uvQuadMesh)).toEqual([
      [0, 0, 1],
      [0, 0, 1],
      [0, 0, 1],
      [0, 0, 1],
    ]);
  });

  test("subdivision grows vertices and triangles predictably", () => {
    const mesh = subdividedPlane(2);
    expect(mesh.vertices).toHaveLength(9);
    expect(triangleCount(mesh)).toBe(8);
    expect(mesh.attributes?.uvs).toHaveLength(9);
    expect(mesh.attributes?.normals).toHaveLength(9);
  });

  test("subdivision rejects zero", () => {
    expect(() => subdividedPlane(0)).toThrow("segments must be an integer from 1");
  });
});