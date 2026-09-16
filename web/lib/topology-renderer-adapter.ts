import * as THREE from "three";
import {
  materializePersistentMeshTopology,
  type PersistentMeshTopology,
} from "./scene-editor-topology-persistent";

export type TopologyRendererWorkObservations = Readonly<{
  fullMaterializationCount: number;
  materializedVertexReferences: number;
  materializedIndexValues: number;
  geometryCreateCount: number;
  geometryDisposeCount: number;
  positionValuesUploaded: number;
  indexValuesUploaded: number;
  localizedGeometryUpdateCount: number;
}>;

export type TopologyGeometryAdapter = Readonly<{
  object: THREE.Object3D;
  update(topology: PersistentMeshTopology): TopologyRendererWorkObservations;
  dispose(): void;
}>;

function geometryFromTopology(topology: PersistentMeshTopology): Readonly<{
  geometry: THREE.BufferGeometry;
  observations: TopologyRendererWorkObservations;
}> {
  const materialized = materializePersistentMeshTopology(topology);
  const { mesh } = materialized;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.vertices.flat(), 3));
  geometry.setIndex([...mesh.indices]);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return {
    geometry,
    observations: {
      fullMaterializationCount: 1,
      materializedVertexReferences: materialized.observations.vertexReferencesCopied,
      materializedIndexValues: materialized.observations.indexValuesCopied,
      geometryCreateCount: 1,
      geometryDisposeCount: 1,
      positionValuesUploaded: mesh.vertices.length * 3,
      indexValuesUploaded: mesh.indices.length,
      localizedGeometryUpdateCount: 0,
    },
  };
}

/**
 * Baseline topology renderer adapter matching the current editor behavior.
 * Every semantic topology edit crosses the compatibility boundary, rebuilds a full BufferGeometry,
 * replaces the previous geometry, and disposes it. The browser canary records this cost explicitly.
 */
export function createTopologyGeometryAdapter(
  material: THREE.Material,
  initialTopology: PersistentMeshTopology,
): TopologyGeometryAdapter {
  const initial = geometryFromTopology(initialTopology);
  const mesh = new THREE.Mesh(initial.geometry, material);
  let disposed = false;

  return {
    object: mesh,
    update(topology) {
      if (disposed) throw new Error("topology geometry adapter is disposed");
      const next = geometryFromTopology(topology);
      const previous = mesh.geometry;
      mesh.geometry = next.geometry;
      previous.dispose();
      return next.observations;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mesh.geometry.dispose();
    },
  };
}
