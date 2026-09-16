import { describe, expect, test } from "bun:test";
import { subdividedPlane } from "./mesh";
import {
  inheritPersistentTopologyAdjacency,
  persistentTopologyEdgeIndex,
} from "./scene-editor-topology-adjacency";
import {
  createPersistentMeshTopology,
  performPersistentMeshTopologyOperation,
  persistentTriangleAt,
} from "./scene-editor-topology-persistent";

describe("persistent topology adjacency", () => {
  test("builds once then follows localized chunk replacements", () => {
    const initial = createPersistentMeshTopology(subdividedPlane(32));
    const firstTriangle = persistentTriangleAt(initial, 17);
    const firstEdge = [firstTriangle[0], firstTriangle[1]] as const;
    const firstLookup = persistentTopologyEdgeIndex(initial, firstEdge);
    expect(firstLookup.observations.buildCount).toBe(1);
    expect(firstLookup.observations.triangleVisits).toBe(initial.triangleCount);

    const split = performPersistentMeshTopologyOperation(initial, { kind: "split-edge", edge: firstEdge }, firstLookup.index);
    const splitMaintenance = inheritPersistentTopologyAdjacency(initial, split.topology);
    expect(splitMaintenance.buildCount).toBe(0);
    expect(splitMaintenance.triangleVisits).toBeLessThan(600);

    const secondTriangle = persistentTriangleAt(split.topology, 997);
    const secondEdge = [secondTriangle[0], secondTriangle[1]] as const;
    const secondLookup = persistentTopologyEdgeIndex(split.topology, secondEdge);
    expect(secondLookup.observations).toEqual({ buildCount: 0, triangleVisits: 0 });

    const inset = performPersistentMeshTopologyOperation(split.topology, {
      kind: "inset-face",
      triangleIndex: 311,
      ratio: 0.25,
    });
    const insetMaintenance = inheritPersistentTopologyAdjacency(split.topology, inset.topology);
    expect(insetMaintenance.buildCount).toBe(0);
    expect(insetMaintenance.triangleVisits).toBeLessThan(300);

    const thirdTriangle = persistentTriangleAt(inset.topology, 1501);
    const thirdEdge = [thirdTriangle[0], thirdTriangle[1]] as const;
    const thirdLookup = persistentTopologyEdgeIndex(inset.topology, thirdEdge);
    expect(thirdLookup.observations).toEqual({ buildCount: 0, triangleVisits: 0 });
  });
});
