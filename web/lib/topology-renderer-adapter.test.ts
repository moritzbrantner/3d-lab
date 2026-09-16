import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { subdividedPlane } from "./mesh";
import {
  createPersistentMeshTopology,
  performPersistentMeshTopologyOperation,
} from "./scene-editor-topology-persistent";
import { createTopologyGeometryAdapter } from "./topology-renderer-adapter";

describe("localized topology renderer adapter", () => {
  test("keeps one geometry object and uploads only appended vertices plus local index slots", () => {
    const source = createPersistentMeshTopology(subdividedPlane(32));
    const material = new THREE.MeshBasicMaterial();
    const adapter = createTopologyGeometryAdapter(material, source);
    const object = adapter.object;

    const inset = performPersistentMeshTopologyOperation(source, {
      kind: "inset-face",
      triangleIndex: 17,
      ratio: 0.25,
    });
    const work = adapter.update(inset.topology);

    expect(adapter.object).toBe(object);
    expect(work.fullMaterializationCount).toBe(0);
    expect(work.materializedVertexReferences).toBe(0);
    expect(work.materializedIndexValues).toBe(0);
    expect(work.geometryCreateCount).toBe(0);
    expect(work.geometryDisposeCount).toBe(0);
    expect(work.localizedGeometryUpdateCount).toBe(1);
    expect(work.positionValuesUploaded).toBe(9);
    expect(work.indexValuesUploaded).toBeLessThanOrEqual(128 * 3 * 2);

    adapter.dispose();
    material.dispose();
  });

  test("maps slot-padded raycast faces back to semantic triangle indices", () => {
    const source = createPersistentMeshTopology(subdividedPlane(32));
    const material = new THREE.MeshBasicMaterial();
    const adapter = createTopologyGeometryAdapter(material, source);

    expect(adapter.semanticTriangleIndex(0)).toBe(0);
    expect(adapter.semanticTriangleIndex(128)).toBe(128);

    const inset = performPersistentMeshTopologyOperation(source, {
      kind: "inset-face",
      triangleIndex: 0,
      ratio: 0.25,
    });
    adapter.update(inset.topology);
    expect(adapter.semanticTriangleIndex(0)).toBe(0);

    adapter.dispose();
    material.dispose();
  });
});
