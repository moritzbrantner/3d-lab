"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { subdividedPlane } from "@/lib/mesh";
import type { EditorNode, EditorScene } from "@/lib/scene-editor";
import {
  commitMeshTopology,
  createEditorCommandLog,
  currentEditorTopology,
  type EditorCommandLog,
} from "@/lib/scene-editor-history";
import {
  createPersistentMeshTopology,
  persistentTriangleAt,
} from "@/lib/scene-editor-topology-persistent";
import {
  createTopologyGeometryAdapter,
  type TopologyGeometryAdapter,
  type TopologyRendererWorkObservations,
} from "@/lib/topology-renderer-adapter";

const GRID_SEGMENTS = 64;
const EDGE_SPLIT_COUNT = 8;
const FACE_INSET_COUNT = 16;
const FACE_EXTRUDE_COUNT = 16;
const OPERATION_COUNT = EDGE_SPLIT_COUNT + FACE_INSET_COUNT + FACE_EXTRUDE_COUNT;
const MESH_NODE_ID = "topology-perf-mesh";

type CanaryState = Readonly<{
  status: "booting" | "ready" | "running" | "done" | "error";
  operationCount: number;
  finalVertexCount: number;
  finalTriangleCount: number;
  work: TopologyRendererWorkObservations | null;
  error?: string;
}>;

declare global {
  interface Window {
    __THREE_D_TOPOLOGY_RENDER_PERF__?: CanaryState;
  }
}

type Runtime = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  adapter: TopologyGeometryAdapter;
  material: THREE.MeshStandardMaterial;
};

function emptyWork(): TopologyRendererWorkObservations {
  return {
    fullMaterializationCount: 0,
    materializedVertexReferences: 0,
    materializedIndexValues: 0,
    geometryCreateCount: 0,
    geometryDisposeCount: 0,
    positionValuesUploaded: 0,
    indexValuesUploaded: 0,
    localizedGeometryUpdateCount: 0,
  };
}

function addWork(
  totals: TopologyRendererWorkObservations,
  current: TopologyRendererWorkObservations,
): TopologyRendererWorkObservations {
  return {
    fullMaterializationCount: totals.fullMaterializationCount + current.fullMaterializationCount,
    materializedVertexReferences: totals.materializedVertexReferences + current.materializedVertexReferences,
    materializedIndexValues: totals.materializedIndexValues + current.materializedIndexValues,
    geometryCreateCount: totals.geometryCreateCount + current.geometryCreateCount,
    geometryDisposeCount: totals.geometryDisposeCount + current.geometryDisposeCount,
    positionValuesUploaded: totals.positionValuesUploaded + current.positionValuesUploaded,
    indexValuesUploaded: totals.indexValuesUploaded + current.indexValuesUploaded,
    localizedGeometryUpdateCount: totals.localizedGeometryUpdateCount + current.localizedGeometryUpdateCount,
  };
}

function createScene(): EditorScene {
  const node: EditorNode = {
    id: MESH_NODE_ID,
    name: "Topology performance mesh",
    parent: null,
    transform: {
      translation: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    mesh: subdividedPlane(GRID_SEGMENTS),
  };
  return { nodes: [node] };
}

function triangleCount(log: EditorCommandLog): number {
  return currentEditorTopology(log, MESH_NODE_ID).triangleCount;
}

function edgeAt(log: EditorCommandLog, triangleIndex: number): readonly [number, number] {
  const triangle = persistentTriangleAt(currentEditorTopology(log, MESH_NODE_ID), triangleIndex);
  return [triangle[0], triangle[1]];
}

function applyDeterministicWorkload(
  source: EditorCommandLog,
  onEdit: (log: EditorCommandLog) => void,
): EditorCommandLog {
  let log = source;
  for (let round = 0; round < EDGE_SPLIT_COUNT; round += 1) {
    const splitTriangle = (round * 997 + 17) % triangleCount(log);
    log = commitMeshTopology(log, MESH_NODE_ID, {
      kind: "split-edge",
      edge: edgeAt(log, splitTriangle),
    });
    onEdit(log);

    for (let local = 0; local < 2; local += 1) {
      const edit = round * 2 + local;
      const insetTriangle = (edit * 613 + 31) % triangleCount(log);
      log = commitMeshTopology(log, MESH_NODE_ID, {
        kind: "inset-face",
        triangleIndex: insetTriangle,
        ratio: 0.22,
      });
      onEdit(log);

      const extrudeTriangle = (edit * 431 + 47) % triangleCount(log);
      log = commitMeshTopology(log, MESH_NODE_ID, {
        kind: "extrude-face",
        triangleIndex: extrudeTriangle,
        distance: 0.035,
      });
      onEdit(log);
    }
  }
  return log;
}

export function TopologyRendererPerformanceCanary() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const initialSceneRef = useRef<EditorScene | null>(null);
  const [state, setState] = useState<CanaryState>({
    status: "booting",
    operationCount: 0,
    finalVertexCount: 0,
    finalTriangleCount: 0,
    work: null,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    try {
      const editorScene = createScene();
      initialSceneRef.current = editorScene;
      const mesh = editorScene.nodes[0].mesh;
      if (!mesh) throw new Error("topology renderer canary is missing its source mesh");

      const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
      renderer.setPixelRatio(1);
      renderer.setSize(960, 540, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0c111a);
      const camera = new THREE.PerspectiveCamera(45, 960 / 540, 0.05, 100);
      camera.position.set(2.8, 2.3, 3.5);
      camera.lookAt(0, 0, 0);
      scene.add(new THREE.HemisphereLight(0xdce8ff, 0x20283a, 2.2));
      const material = new THREE.MeshStandardMaterial({ color: 0xaebbc9, roughness: 0.72, metalness: 0.06 });
      const adapter = createTopologyGeometryAdapter(material, createPersistentMeshTopology(mesh));
      scene.add(adapter.object);
      renderer.render(scene, camera);
      runtimeRef.current = { renderer, scene, camera, adapter, material };

      const ready: CanaryState = {
        status: "ready",
        operationCount: 0,
        finalVertexCount: mesh.vertices.length,
        finalTriangleCount: mesh.indices.length / 3,
        work: null,
      };
      window.__THREE_D_TOPOLOGY_RENDER_PERF__ = ready;
      setState(ready);

      return () => {
        adapter.dispose();
        material.dispose();
        renderer.dispose();
        runtimeRef.current = null;
      };
    } catch (error) {
      const failed: CanaryState = {
        status: "error",
        operationCount: 0,
        finalVertexCount: 0,
        finalTriangleCount: 0,
        work: null,
        error: error instanceof Error ? error.message : String(error),
      };
      window.__THREE_D_TOPOLOGY_RENDER_PERF__ = failed;
      setState(failed);
    }
  }, []);

  const run = () => {
    const runtime = runtimeRef.current;
    const editorScene = initialSceneRef.current;
    if (!runtime || !editorScene || state.status === "running") return;

    const running: CanaryState = {
      status: "running",
      operationCount: 0,
      finalVertexCount: 0,
      finalTriangleCount: 0,
      work: null,
    };
    window.__THREE_D_TOPOLOGY_RENDER_PERF__ = running;
    setState(running);

    try {
      let totals = emptyWork();
      const initialLog = createEditorCommandLog(editorScene);
      const finalLog = applyDeterministicWorkload(initialLog, (log) => {
        const topology = currentEditorTopology(log, MESH_NODE_ID);
        totals = addWork(totals, runtime.adapter.update(topology));
        runtime.renderer.render(runtime.scene, runtime.camera);
      });
      const finalTopology = currentEditorTopology(finalLog, MESH_NODE_ID);
      if (finalLog.entries.length !== OPERATION_COUNT || finalLog.cursor !== OPERATION_COUNT) {
        throw new Error(`topology renderer canary expected ${OPERATION_COUNT} history entries`);
      }

      const done: CanaryState = {
        status: "done",
        operationCount: OPERATION_COUNT,
        finalVertexCount: finalTopology.vertexCount,
        finalTriangleCount: finalTopology.triangleCount,
        work: totals,
      };
      window.__THREE_D_TOPOLOGY_RENDER_PERF__ = done;
      setState(done);
    } catch (error) {
      const failed: CanaryState = {
        status: "error",
        operationCount: 0,
        finalVertexCount: 0,
        finalTriangleCount: 0,
        work: null,
        error: error instanceof Error ? error.message : String(error),
      };
      window.__THREE_D_TOPOLOGY_RENDER_PERF__ = failed;
      setState(failed);
    }
  };

  return (
    <section aria-labelledby="topology-renderer-performance-heading">
      <h2 id="topology-renderer-performance-heading">Topology renderer performance canary</h2>
      <p>
        The canary performs {OPERATION_COUNT} deterministic topology edits and runs the same materialize/rebuild/render boundary
        used by the current topology editor after every edit. Work counters distinguish semantic topology work from renderer
        materialization and buffer replacement.
      </p>
      <button type="button" onClick={run} disabled={state.status === "booting" || state.status === "running"}>
        Run topology renderer canary
      </button>
      <p data-testid="topology-renderer-canary-status">Status: {state.status}</p>
      <canvas
        ref={canvasRef}
        width={960}
        height={540}
        style={{ width: "100%", maxWidth: 960, height: "auto", display: "block" }}
      />
      <pre data-testid="topology-renderer-canary-observations">
        {state.work ? JSON.stringify(state, null, 2) : "No topology renderer work observations captured yet."}
      </pre>
    </section>
  );
}
