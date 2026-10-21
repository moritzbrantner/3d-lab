"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import {
  adaptPinnedCharacterSource,
  type IkLayer,
  type IkLayerReport,
  type InspectionCharacterAsset,
  type InspectionCharacterInstance,
} from "@moritzbrantner/three-d-renderer/inspection-character";
import { PrecisionRange } from "./PrecisionRange";
import styles from "./character-rig-lab.module.css";

const FIGURE_URL = "../fixtures/rigged-figure.glb";
const FIGURE_PIN = { sha256: "d6be85417d3e256861ee733eea6916093a7af7c79c16366181fd8abcaeb38cf5", byteLength: 50116 };

type TargetId = "foot" | "hand" | "look";
type Vec3 = [number, number, number];
const TARGETS: { id: TargetId; label: string; color: number }[] = [
  { id: "foot", label: "Left foot", color: 0x4ade80 },
  { id: "hand", label: "Right hand", color: 0xf59e0b },
  { id: "look", label: "Look-at", color: 0x60a5fa },
];
// RiggedFigure is Y-up and faces +Z; these rig facts are caller data, not solver policy.
const FOOT_UP_LOCAL: Vec3 = [0, 0.6226, -0.7825];
const HEAD_FORWARD_LOCAL: Vec3 = [0, 0, -1];

type Settings = {
  targets: Record<TargetId, Vec3>;
  weights: Record<TargetId, number>;
  slopeDegrees: number;
  maxAngle: number;
};

function layersOf(settings: Settings): IkLayer[] {
  const slope = (settings.slopeDegrees * Math.PI) / 180;
  return [
    {
      kind: "limb", joints: ["leg_joint_L_1", "leg_joint_L_2", "leg_joint_L_3"],
      target: settings.targets.foot, pole: [0.08, 0.4, 0.6], maxReach: 0.999,
      align: { localAxis: FOOT_UP_LOCAL, direction: [0, Math.cos(slope), -Math.sin(slope)] },
      weight: settings.weights.foot,
    },
    {
      kind: "limb", joints: ["arm_joint_R_1", "arm_joint_R_2", "arm_joint_R_3"],
      target: settings.targets.hand, pole: [-0.35, 0.9, -0.6], maxReach: 0.999,
      weight: settings.weights.hand,
    },
    {
      kind: "lookAt", joints: [["neck_joint_1", 0.5], ["neck_joint_2", 1]],
      forward: HEAD_FORWARD_LOCAL, target: settings.targets.look, maxAngle: settings.maxAngle,
      weight: settings.weights.look,
    },
  ];
}

type Runtime = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  orbit: OrbitControls;
  gizmo: TransformControls;
  markers: Record<TargetId, THREE.Mesh>;
  asset: InspectionCharacterAsset;
  instance: InspectionCharacterInstance;
  frameId: number;
  resizeObserver: ResizeObserver;
  removePick: () => void;
  playing: boolean;
  time: number;
};

export function LayeredIkLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const settingsRef = useRef<Settings | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selected, setSelected] = useState<TargetId>("foot");
  const [report, setReport] = useState<readonly IkLayerReport[]>([]);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0.5);
  const [error, setError] = useState<string | null>(null);

  // One owner for the authoritative layers: every edit goes through Rust `setIk`.
  const apply = useCallback((next: Settings) => {
    const runtime = runtimeRef.current;
    settingsRef.current = next;
    setSettings(next);
    if (!runtime) return;
    for (const { id } of TARGETS) runtime.markers[id].position.fromArray(next.targets[id]);
    try {
      runtime.instance.setIk(layersOf(next));
      setReport(runtime.instance.ikReport());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const editTarget = (id: TargetId, axis: number, value: number) => {
    const current = settingsRef.current;
    if (!current) return;
    const target = [...current.targets[id]] as Vec3;
    target[axis] = value;
    apply({ ...current, targets: { ...current.targets, [id]: target } });
  };

  const seek = (seconds: number) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.playing = false;
    runtime.time = seconds;
    runtime.instance.seek(0, seconds);
    setReport(runtime.instance.ikReport());
    setPlaying(false);
    setTime(seconds);
  };

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (runtime) runtime.gizmo.attach(runtime.markers[selected]);
  }, [selected, settings === null]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let runtime: Runtime | null = null;

    void (async () => {
      try {
        const response = await fetch(FIGURE_URL);
        if (!response.ok) throw new Error(`RiggedFigure fixture: HTTP ${response.status}`);
        const asset = await adaptPinnedCharacterSource(await response.arrayBuffer(), FIGURE_PIN);
        if (cancelled) { asset.dispose(); return; }

        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0c111a);
        scene.add(new THREE.HemisphereLight(0xe6efff, 0x263044, 2.6));
        const key = new THREE.DirectionalLight(0xffffff, 3);
        key.position.set(2, 4, 3);
        scene.add(key);
        scene.add(new THREE.GridHelper(2, 20, 0x334155, 0x1e293b));

        const camera = new THREE.PerspectiveCamera(38, 1, 0.02, 50);
        camera.position.set(1.4, 1.2, 2.1);
        const orbit = new OrbitControls(camera, canvas);
        orbit.enableDamping = true;
        orbit.target.set(0, 0.65, 0);
        orbit.update();

        const instance = asset.createInstance();
        scene.add(instance.root);
        instance.seek(0, 0.5);

        const markers = {} as Record<TargetId, THREE.Mesh>;
        for (const { id, color } of TARGETS) {
          const marker = new THREE.Mesh(new THREE.SphereGeometry(0.025, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false }));
          marker.renderOrder = 2;
          marker.userData.target = id;
          markers[id] = marker;
          scene.add(marker);
        }
        const gizmo = new TransformControls(camera, canvas);
        gizmo.setSize(0.7);
        gizmo.addEventListener("dragging-changed", (event) => { orbit.enabled = !event.value; });
        gizmo.addEventListener("objectChange", () => {
          const object = gizmo.object;
          const current = settingsRef.current;
          if (!object || !current) return;
          const id = object.userData.target as TargetId;
          apply({ ...current, targets: { ...current.targets, [id]: object.position.toArray() as Vec3 } });
        });
        scene.add(gizmo.getHelper());

        // Direct picking: clicking a target marker selects it for the gizmo and inspector.
        const raycaster = new THREE.Raycaster();
        const pick = (event: PointerEvent) => {
          if (gizmo.dragging) return;
          const rect = canvas.getBoundingClientRect();
          const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
          raycaster.setFromCamera(pointer, camera);
          const hit = raycaster.intersectObjects(Object.values(markers))[0];
          if (hit) setSelected(hit.object.userData.target as TargetId);
        };
        canvas.addEventListener("pointerdown", pick);

        const resize = () => {
          const width = Math.max(canvas.clientWidth, 1);
          const height = Math.max(canvas.clientHeight, 1);
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
        };
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(canvas);
        resize();

        runtime = { renderer, scene, camera, orbit, gizmo, markers, asset, instance, frameId: 0, resizeObserver, removePick: () => canvas.removeEventListener("pointerdown", pick), playing: false, time: 0.5 };
        runtimeRef.current = runtime;

        // Start each target from the sampled pose so the first solve is a small correction.
        const round = (v: number[]) => v.map((n) => Math.round(n * 1000) / 1000) as Vec3;
        const ankle = instance.jointPosition("leg_joint_L_3");
        const wrist = instance.jointPosition("arm_joint_R_3");
        const head = instance.jointPosition("neck_joint_2");
        apply({
          targets: {
            foot: round([ankle[0], ankle[1] + 0.08, ankle[2] + 0.05]),
            hand: round([wrist[0] + 0.1, wrist[1] + 0.25, wrist[2] + 0.2]),
            look: round([head[0] - 0.6, head[1] - 0.1, head[2] + 1]),
          },
          weights: { foot: 1, hand: 1, look: 1 },
          slopeDegrees: 0,
          maxAngle: 1,
        });
        canvas.dataset.ikReady = "true";

        let previous = performance.now();
        let lastUi = previous;
        const render = (now: number) => {
          if (!runtime) return;
          const delta = Math.max(0, Math.min((now - previous) / 1000, 0.1));
          previous = now;
          if (runtime.playing) {
            runtime.instance.advance(delta);
            runtime.time = (runtime.time + delta) % 1.25;
            if (now - lastUi >= 100) {
              lastUi = now;
              setTime(runtime.time);
              setReport(runtime.instance.ikReport());
            }
          }
          orbit.update();
          renderer.render(scene, camera);
          runtime.frameId = requestAnimationFrame(render);
        };
        runtime.frameId = requestAnimationFrame(render);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();

    return () => {
      cancelled = true;
      if (!runtime) return;
      cancelAnimationFrame(runtime.frameId);
      runtime.resizeObserver.disconnect();
      runtime.removePick();
      runtime.gizmo.detach();
      runtime.gizmo.dispose();
      runtime.orbit.dispose();
      runtime.instance.dispose();
      runtime.asset.dispose();
      runtime.renderer.dispose();
      runtimeRef.current = null;
    };
  }, [apply]);

  const togglePlaying = () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.playing = !runtime.playing;
    setPlaying(runtime.playing);
  };

  const index = TARGETS.findIndex((t) => t.id === selected);
  const target = settings?.targets[selected];
  const outcome = report[index];

  return (
    <section className={styles.lab} aria-labelledby="layered-ik-heading">
      <div className={styles.viewportPanel}>
        <div className={styles.headingRow}>
          <div>
            <p className="eyebrow">Layered IK over a sampled clip</p>
            <h2 id="layered-ik-heading">Drag a target; Rust corrects the pose without touching the clip.</h2>
          </div>
          <p>Click a marker to select it. Foot, hand and look-at layers are solved in order by <code>three_d_animation::ik</code> through the character WASM bridge.</p>
        </div>
        <canvas ref={canvasRef} className={styles.canvas} aria-label="RiggedFigure with layered IK targets" />
        {error ? <p role="alert">{error}</p> : null}
      </div>
      <aside className={styles.controlsPanel}>
        <div>
          <span className={styles.sectionLabel}>Target</span>
          <div className={styles.segmented} role="group" aria-label="IK target">
            {TARGETS.map(({ id, label }) => (
              <button key={id} type="button" aria-pressed={selected === id} onClick={() => setSelected(id)}>{label}</button>
            ))}
          </div>
        </div>
        {settings && target ? (
          <>
            {(["X", "Y", "Z"] as const).map((axis, i) => (
              <PrecisionRange key={`${selected}-${axis}`} className={styles.rangeControl} label={`${axis} (character space)`}
                value={target[i]} min={-1.5} max={2} step={0.001} unit="m"
                onChange={(value) => editTarget(selected, i, value)} />
            ))}
            <PrecisionRange className={styles.rangeControl} label="Layer weight" value={settings.weights[selected]}
              min={0} max={1} step={0.01}
              onChange={(value) => apply({ ...settings, weights: { ...settings.weights, [selected]: value } })} />
            {selected === "foot" ? (
              <PrecisionRange className={styles.rangeControl} label="Ground slope" value={settings.slopeDegrees}
                min={-30} max={30} step={0.5} unit="°"
                onChange={(value) => apply({ ...settings, slopeDegrees: value })} />
            ) : null}
            {selected === "look" ? (
              <PrecisionRange className={styles.rangeControl} label="Max aim angle" value={settings.maxAngle}
                min={0} max={Math.PI} step={0.01} unit="rad"
                onChange={(value) => apply({ ...settings, maxAngle: value })} />
            ) : null}
          </>
        ) : <strong>Loading…</strong>}
        <div data-testid="ik-report">
          <span className={styles.sectionLabel}>Solve</span>
          {TARGETS.map(({ id, label }, i) => (
            <p key={id}>{label}: <strong>{report[i]?.status ?? "–"}</strong>{report[i] ? ` · residual ${report[i].residual.toFixed(4)}${id === "look" ? " rad" : " m"}` : ""}</p>
          ))}
          {outcome?.status === "clamped" ? <p>Out of reach or beyond the angle limit; the closest permitted pose is shown.</p> : null}
        </div>
        <PrecisionRange className={styles.rangeControl} label="Clip time" value={time} min={0} max={1.25} step={0.001} unit="s"
          onEditStart={() => { if (runtimeRef.current) runtimeRef.current.playing = false; setPlaying(false); }}
          onChange={seek} />
        <button type="button" className={styles.primaryButton} onClick={togglePlaying} disabled={!settings}>
          {playing ? "Pause clip" : "Play clip"}
        </button>
        <div className={styles.boundary}>
          <strong>Ownership</strong>
          <p>Targets are explicit caller inputs; no ground or physics query happens here. Weight 0 leaves the sampled pose bit-identical. Khronos RiggedFigure, CC-BY 4.0 © 2017 Cesium.</p>
        </div>
      </aside>
    </section>
  );
}
