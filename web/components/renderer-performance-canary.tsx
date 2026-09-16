"use client";

import { useEffect, useRef, useState } from "react";
import {
  createThreeSceneRenderer,
  type Matrix4Values,
  type RendererFrame,
  type RendererSceneNode,
  type ThreeSceneRenderer,
} from "@moritzbrantner/three-d-renderer";

type RendererWorkObservations = {
  nodeVisitCount: number;
  objectCreateCount: number;
  objectReuseCount: number;
  objectRemoveCount: number;
  geometryCreateCount: number;
  geometryReuseCount: number;
  geometryEvictCount: number;
  materialCreateCount: number;
  materialReuseCount: number;
  materialEvictCount: number;
  liveObjectCount: number;
  liveGeometryCount: number;
  liveMaterialCount: number;
};

type CanaryState = {
  status: "booting" | "ready" | "running" | "done" | "error";
  frameCount: number;
  totals: RendererWorkObservations | null;
  error?: string;
};

declare global {
  interface Window {
    __THREE_D_RENDERER_PERF__?: CanaryState;
  }
}

const FRAME_COUNT = 64;
const NODE_COUNT = 192;
const SPECIAL_NODE_COUNT = 24;
const RESOURCE_EVICTION_FRAME = 20;
const COLUMNS = 16;

const VIEW_MATRIX: Matrix4Values = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, -20, 1,
];

const PROJECTION_MATRIX: Matrix4Values = [
  1 / 12, 0, 0, 0,
  0, 1 / 8, 0, 0,
  0, 0, 1 / (0.1 - 100), 0,
  0, 0, 0.1 / (0.1 - 100), 1,
];

const EXPECTED_TOTALS: RendererWorkObservations = {
  nodeVisitCount: 12_264,
  objectCreateCount: 216,
  objectReuseCount: 12_048,
  objectRemoveCount: 24,
  geometryCreateCount: 3,
  geometryReuseCount: 12_261,
  geometryEvictCount: 1,
  materialCreateCount: 4,
  materialReuseCount: 12_260,
  materialEvictCount: 1,
  liveObjectCount: 192,
  liveGeometryCount: 2,
  liveMaterialCount: 3,
};

function emptyTotals(): RendererWorkObservations {
  return {
    nodeVisitCount: 0,
    objectCreateCount: 0,
    objectReuseCount: 0,
    objectRemoveCount: 0,
    geometryCreateCount: 0,
    geometryReuseCount: 0,
    geometryEvictCount: 0,
    materialCreateCount: 0,
    materialReuseCount: 0,
    materialEvictCount: 0,
    liveObjectCount: 0,
    liveGeometryCount: 0,
    liveMaterialCount: 0,
  };
}

function accumulate(
  totals: RendererWorkObservations,
  frame: RendererWorkObservations,
): RendererWorkObservations {
  return {
    nodeVisitCount: totals.nodeVisitCount + frame.nodeVisitCount,
    objectCreateCount: totals.objectCreateCount + frame.objectCreateCount,
    objectReuseCount: totals.objectReuseCount + frame.objectReuseCount,
    objectRemoveCount: totals.objectRemoveCount + frame.objectRemoveCount,
    geometryCreateCount: totals.geometryCreateCount + frame.geometryCreateCount,
    geometryReuseCount: totals.geometryReuseCount + frame.geometryReuseCount,
    geometryEvictCount: totals.geometryEvictCount + frame.geometryEvictCount,
    materialCreateCount: totals.materialCreateCount + frame.materialCreateCount,
    materialReuseCount: totals.materialReuseCount + frame.materialReuseCount,
    materialEvictCount: totals.materialEvictCount + frame.materialEvictCount,
    liveObjectCount: frame.liveObjectCount,
    liveGeometryCount: frame.liveGeometryCount,
    liveMaterialCount: frame.liveMaterialCount,
  };
}

function buildNodes(frameIndex: number): RendererSceneNode[] {
  const omitSpecialNodes = frameIndex === RESOURCE_EVICTION_FRAME;
  const offset = ((frameIndex % 5) - 2) * 0.01;
  const nodes: RendererSceneNode[] = [];

  for (let index = 0; index < NODE_COUNT; index += 1) {
    const special = index >= NODE_COUNT - SPECIAL_NODE_COUNT;
    if (special && omitSpecialNodes) continue;

    const column = index % COLUMNS;
    const row = Math.floor(index / COLUMNS);
    nodes.push({
      id: `renderer-canary-${index}`,
      geometry: special
        ? { kind: "sphere", radius: 0.42 }
        : { kind: "box", size: [0.52, 0.52, 0.52] },
      color: special ? "#e89bff" : index % 2 === 0 ? "#8fd3ff" : "#ffd38f",
      transform: {
        translation: [column - 7.5 + offset, row - 5.5, 0],
      },
    });
  }

  return nodes;
}

function frameFor(index: number): RendererFrame {
  return {
    camera: {
      viewMatrix: VIEW_MATRIX,
      projectionMatrix: PROJECTION_MATRIX,
    },
    nodes: buildNodes(index),
  };
}

function assertExpectedTotals(totals: RendererWorkObservations) {
  for (const [key, expected] of Object.entries(EXPECTED_TOTALS)) {
    const actual = totals[key as keyof RendererWorkObservations];
    if (actual !== expected) {
      throw new Error(`renderer observation ${key} expected ${expected}, got ${actual}`);
    }
  }
}

export function RendererPerformanceCanary() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ThreeSceneRenderer | null>(null);
  const [state, setState] = useState<CanaryState>({
    status: "booting",
    frameCount: 0,
    totals: null,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    try {
      const renderer = createThreeSceneRenderer(canvas, {
        antialias: false,
        pixelRatioLimit: 1,
      });
      renderer.setSize(960, 540, 1);
      rendererRef.current = renderer;
      const ready: CanaryState = { status: "ready", frameCount: 0, totals: null };
      window.__THREE_D_RENDERER_PERF__ = ready;
      setState(ready);
      return () => {
        renderer.dispose();
        rendererRef.current = null;
      };
    } catch (error) {
      const failed: CanaryState = {
        status: "error",
        frameCount: 0,
        totals: null,
        error: error instanceof Error ? error.message : String(error),
      };
      window.__THREE_D_RENDERER_PERF__ = failed;
      setState(failed);
    }
  }, []);

  const run = () => {
    const renderer = rendererRef.current;
    if (!renderer || state.status === "running") return;

    const running: CanaryState = { status: "running", frameCount: 0, totals: null };
    window.__THREE_D_RENDERER_PERF__ = running;
    setState(running);

    try {
      let totals = emptyTotals();
      let observationsAvailable = false;
      for (let frameIndex = 0; frameIndex < FRAME_COUNT; frameIndex += 1) {
        const observations = renderer.render(frameFor(frameIndex)) as unknown as
          | RendererWorkObservations
          | undefined;
        if (observations) {
          observationsAvailable = true;
          totals = accumulate(totals, observations);
        }
      }

      if (observationsAvailable) assertExpectedTotals(totals);
      const done: CanaryState = {
        status: "done",
        frameCount: FRAME_COUNT,
        totals: observationsAvailable ? totals : null,
      };
      window.__THREE_D_RENDERER_PERF__ = done;
      setState(done);
    } catch (error) {
      const failed: CanaryState = {
        status: "error",
        frameCount: 0,
        totals: null,
        error: error instanceof Error ? error.message : String(error),
      };
      window.__THREE_D_RENDERER_PERF__ = failed;
      setState(failed);
    }
  };

  return (
    <section aria-labelledby="renderer-performance-heading">
      <h2 id="renderer-performance-heading">Reusable renderer performance canary</h2>
      <p>
        The workload renders {FRAME_COUNT} deterministic frames over {NODE_COUNT} scene nodes. One frame removes the
        final users of a geometry and material, then the next frame restores them, so reuse and eviction stay visible.
      </p>
      <button type="button" onClick={run} disabled={state.status === "booting" || state.status === "running"}>
        Run renderer canary
      </button>
      <p data-testid="renderer-canary-status">Status: {state.status}</p>
      <canvas
        ref={canvasRef}
        width={960}
        height={540}
        style={{ width: "100%", maxWidth: 960, height: "auto", display: "block" }}
      />
      <pre data-testid="renderer-canary-observations">
        {state.totals ? JSON.stringify(state.totals, null, 2) : "No renderer work observations captured yet."}
      </pre>
      {state.error ? <p role="alert">{state.error}</p> : null}
    </section>
  );
}
