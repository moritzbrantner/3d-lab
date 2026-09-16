import { describe, expect, test } from "bun:test";
import { validateMesh, type IndexedMesh } from "./mesh";
import {
  applyMeshTopologyDelta,
  createMeshTopologyIndex,
  extrudeMeshFace,
  insetMeshFace,
  nearestTriangleEdge,
  splitMeshEdge,
  topologyStructuralBudgetViolations,
} from "./scene-editor-topology";

const quad: IndexedMesh = {
  vertices: [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ],
  indices: [0, 1, 2, 0, 2, 3],
  attributes: {
    uvs: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    colors: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 1, 1],
    ],
    normals: [
      [0, 0, 1],
      [0, 0, 1],
      [0, 0, 1],
      [0, 0, 1],
    ],
  },
};

describe("scene editor topology", () => {
  test("builds one reusable edge-to-triangle index", () => {
    const index = createMeshTopologyIndex(quad);
    expect(index.edgeTriangles.get("0:2")).toEqual([0, 1]);
    expect(index.observations).toEqual({
      triangleVisitCount: 2,
      edgeReferenceCount: 6,
      uniqueEdgeCount: 5,
    });
  });

  test("selects the closest edge of a face deterministically", () => {
    expect(nearestTriangleEdge(quad, 0, [0.5, 0.02, 0])).toEqual([0, 1]);
    expect(nearestTriangleEdge(quad, 0, [0.98, 0.5, 0])).toEqual([1, 2]);
  });

  test("splits a manifold edge once and rewrites only adjacent triangles", () => {
    const index = createMeshTopologyIndex(quad);
    const edit = splitMeshEdge(quad, [2, 0], index);
    expect(edit.mesh.vertices).toHaveLength(5);
    expect(edit.mesh.vertices[4]).toEqual([0.5, 0.5, 0]);
    expect(edit.mesh.indices).toHaveLength(12);
    expect(edit.mesh.attributes?.uvs?.[4]).toEqual([0.5, 0.5]);
    expect(edit.mesh.attributes?.normals).toBeUndefined();
    expect(edit.observations.affectedTriangleCount).toBe(2);
    expect(edit.observations.createdVertexCount).toBe(1);
    expect(edit.observations.topologyIndexBuildCount).toBe(0);
    expect(topologyStructuralBudgetViolations(edit.delta.operation, edit.observations)).toEqual([]);
    expect(() => validateMesh(edit.mesh)).not.toThrow();

    const restored = applyMeshTopologyDelta(edit.mesh, edit.delta, "reverse");
    expect(restored).toEqual(quad);
    const replayed = applyMeshTopologyDelta(restored, edit.delta, "forward");
    expect(replayed).toEqual(edit.mesh);
  });

  test("accounts for an uncached topology-index build explicitly", () => {
    const edit = splitMeshEdge(quad, [0, 1]);
    expect(edit.observations.topologyIndexBuildCount).toBe(1);
    expect(edit.observations.topologyIndexTriangleVisits).toBe(2);
  });

  test("rejects a non-manifold edge instead of doing unbounded work", () => {
    const mesh: IndexedMesh = {
      vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1]],
      indices: [0, 1, 2, 1, 0, 3, 0, 1, 4],
    };
    expect(() => splitMeshEdge(mesh, [0, 1])).toThrow("non-manifold");
  });

  test("insets one face into a bounded seven-triangle patch", () => {
    const edit = insetMeshFace(quad, 0, 0.25);
    expect(edit.mesh.vertices).toHaveLength(7);
    expect(edit.mesh.indices).toHaveLength(24);
    expect(edit.observations.affectedTriangleCount).toBe(1);
    expect(edit.observations.createdVertexCount).toBe(3);
    expect(edit.observations.indexValuesWritten).toBe(21);
    expect(topologyStructuralBudgetViolations(edit.delta.operation, edit.observations)).toEqual([]);
    expect(() => validateMesh(edit.mesh)).not.toThrow();
    expect(applyMeshTopologyDelta(edit.mesh, edit.delta, "reverse")).toEqual(quad);
  });

  test("extrudes one face along its normal with a bounded seven-triangle patch", () => {
    const edit = extrudeMeshFace(quad, 0, 0.5);
    expect(edit.mesh.vertices.slice(-3)).toEqual([
      [0, 0, 0.5],
      [1, 0, 0.5],
      [1, 1, 0.5],
    ]);
    expect(edit.observations.affectedTriangleCount).toBe(1);
    expect(edit.observations.createdVertexCount).toBe(3);
    expect(edit.observations.indexValuesWritten).toBe(21);
    expect(topologyStructuralBudgetViolations(edit.delta.operation, edit.observations)).toEqual([]);
    expect(() => validateMesh(edit.mesh)).not.toThrow();
    expect(applyMeshTopologyDelta(edit.mesh, edit.delta, "reverse")).toEqual(quad);
  });

  test("bounds inset and extrusion parameters fail closed", () => {
    expect(() => insetMeshFace(quad, 0, 0)).toThrow("inset ratio");
    expect(() => insetMeshFace(quad, 0, 1)).toThrow("inset ratio");
    expect(() => extrudeMeshFace(quad, 0, 0)).toThrow("extrude distance");
    expect(() => extrudeMeshFace(quad, 0, 11)).toThrow("extrude distance");
  });

  test("delta application rejects stale mesh state", () => {
    const edit = insetMeshFace(quad, 0, 0.25);
    const stale: IndexedMesh = {
      ...edit.mesh,
      vertices: [...edit.mesh.vertices.slice(0, -1), [9, 9, 9]],
    };
    expect(() => applyMeshTopologyDelta(stale, edit.delta, "reverse")).toThrow("appended-vertex precondition");
  });
});
