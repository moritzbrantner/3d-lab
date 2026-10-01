"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PrecisionRange } from "./PrecisionRange";
import { disposeRenderableResources } from "@/lib/three-resources";
import {
  findScenario,
  lookupTimingFrame,
  partitionFinals,
  playbackTimingEvidence as evidence,
  transitionDurations,
  type PlaybackDirectionId,
  type PlaybackModeId,
  type Pose,
  type TimingSettings,
  type TransitionCurveId,
} from "@/lib/playback-timing";
import styles from "./playback-timing-lab.module.css";

const ELAPSED_COLOR = 0x79a9ff;
const FIXED_STEP_COLOR = 0xffa45c;

type Viewport = {
  render: () => void;
  elapsed: THREE.Group;
  fixedStep: THREE.Group;
  path: THREE.Line;
  fixedStepPath: THREE.Line;
  trail: THREE.Points;
};

function marker(material: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 0.2), material);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.26, 16), material);
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 0.38;
  group.add(body, nose);
  return group;
}

function applyPose(object: THREE.Object3D, pose: Pose) {
  object.position.set(...pose.translation);
  object.quaternion.set(...pose.rotation);
}

/** Translations of every Rust frame as xyz triples (pose layout: t xyz, q xyzw). */
function translations(flatPoses: number[]): Float32Array {
  const frames = flatPoses.length / 7;
  const positions = new Float32Array(frames * 3);
  for (let frame = 0; frame < frames; frame += 1) {
    positions.set(flatPoses.slice(frame * 7, frame * 7 + 3), frame * 3);
  }
  return positions;
}

function setPositions(geometry: THREE.BufferGeometry, positions: Float32Array) {
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
}

const format = (value: number, digits = 4) => value.toFixed(digits);

function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className={styles.field}>
      <span>{label}</span>
      <div className={styles.segmented} role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={option.value === value}
            className={option.value === value ? styles.active : undefined}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function PlaybackTimingLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const [settings, setSettings] = useState<TimingSettings>({
    view: "playback",
    scenario: "uneven",
    mode: "loop",
    direction: "forward",
    transitionSeconds: 1.5,
    curve: "smoothstep",
  });
  const [wallSeconds, setWallSeconds] = useState(0.8);
  const [playing, setPlaying] = useState(false);
  const [showFixedStep, setShowFixedStep] = useState(true);

  const total = evidence.wallSeconds;
  const scenario = findScenario(evidence, settings.scenario);
  const frame = useMemo(() => lookupTimingFrame(evidence, settings, wallSeconds), [settings, wallSeconds]);
  const finals = useMemo(() => partitionFinals(evidence, settings), [settings]);
  const patch = (next: Partial<TimingSettings>) => setSettings((current) => ({ ...current, ...next }));
  const seek = (seconds: number) => setWallSeconds(Math.min(total, Math.max(0, seconds)));
  const stepFrame = (offset: number) => {
    setPlaying(false);
    const target = Math.min(scenario.wallSeconds.length - 1, Math.max(0, frame.frame + offset));
    seek(scenario.wallSeconds[target]);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c111a);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0.2, 5.4);
    const controls = new OrbitControls(camera, canvas);
    controls.target.set(0, 0, 0);
    controls.update();

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(2, 3, 4);
    scene.add(key);
    const grid = new THREE.GridHelper(4, 8, 0x273244, 0x1a2333);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.4;
    scene.add(grid);

    const elapsed = marker(new THREE.MeshStandardMaterial({ color: ELAPSED_COLOR, roughness: 0.45 }));
    const fixedStep = marker(new THREE.MeshBasicMaterial({ color: FIXED_STEP_COLOR, wireframe: true }));
    const path = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: ELAPSED_COLOR, transparent: true, opacity: 0.3 }),
    );
    const fixedStepPath = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: FIXED_STEP_COLOR, transparent: true, opacity: 0.25 }),
    );
    const trail = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ color: 0xd7e5ff, size: 5, sizeAttenuation: false }),
    );
    scene.add(path, fixedStepPath, trail, elapsed, fixedStep);

    const render = () => renderer.render(scene, camera);
    controls.addEventListener("change", render);
    const resize = () => {
      const width = Math.max(canvas.clientWidth, 1);
      const height = Math.max(canvas.clientHeight, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    viewportRef.current = { render, elapsed, fixedStep, path, fixedStepPath, trail };
    resize();

    return () => {
      viewportRef.current = null;
      observer.disconnect();
      controls.removeEventListener("change", render);
      controls.dispose();
      disposeRenderableResources(scene);
      renderer.dispose();
    };
  }, []);

  // Rebuild the Rust frame paths when the selected series changes.
  const { posePath, fixedStepPosePath } = frame;
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const positions = translations(posePath);
    setPositions(viewport.path.geometry, positions);
    setPositions(viewport.trail.geometry, positions);
    setPositions(viewport.fixedStepPath.geometry, translations(fixedStepPosePath));
  }, [posePath, fixedStepPosePath]);

  // Present the looked-up Rust frame.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    applyPose(viewport.elapsed, frame.pose);
    applyPose(viewport.fixedStep, frame.fixedStepPose);
    viewport.fixedStep.visible = showFixedStep;
    viewport.fixedStepPath.visible = showFixedStep;
    viewport.trail.geometry.setDrawRange(0, frame.frame + 1);
    viewport.render();
  }, [frame, showFixedStep]);

  // Real-time preview: advance the lab's wall clock by measured browser time.
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let id = requestAnimationFrame(function tick(now) {
      const delta = (now - last) / 1000;
      last = now;
      setWallSeconds((current) => (current + delta > total ? 0 : current + delta));
      id = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(id);
  }, [playing, total]);

  const scrubFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    seek(((event.clientX - bounds.left) / Math.max(bounds.width, 1)) * total);
  };
  const onTimelineKey = (event: KeyboardEvent<SVGSVGElement>) => {
    const offset = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
    if (offset === undefined) return;
    event.preventDefault();
    stepFrame(offset);
  };

  const finalLabel = settings.view === "playback" ? "clip time (s)" : "blend weight";

  return (
    <section className={styles.lab} aria-labelledby="playback-timing-heading">
      <div className={styles.viewportPanel}>
        <div className={styles.headingRow}>
          <h2 id="playback-timing-heading">Same wall time, different frame partitions</h2>
          <ul className={styles.legend}>
            <li><i className={styles.elapsedSwatch} /> Elapsed time (Rust)</li>
            <li><i className={styles.fixedSwatch} /> Fixed 1/60 s per frame — intentionally wrong</li>
          </ul>
        </div>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          aria-label="Rust-sampled clip pose for the presented frame beside the fixed-step pose; drag to orbit"
        />
        <svg
          className={styles.timeline}
          viewBox="0 0 1000 36"
          preserveAspectRatio="none"
          role="slider"
          tabIndex={0}
          aria-label="Wall time; each tick is one presented frame"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={wallSeconds}
          aria-valuetext={`${format(wallSeconds, 3)} s, frame ${frame.frame}`}
          onKeyDown={onTimelineKey}
          onPointerDown={(event) => {
            setPlaying(false);
            event.currentTarget.setPointerCapture(event.pointerId);
            scrubFromPointer(event);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) scrubFromPointer(event);
          }}
        >
          {scenario.wallSeconds.map((wall, index) => (
            <line
              key={index}
              x1={(wall / total) * 1000}
              x2={(wall / total) * 1000}
              y1={index === frame.frame ? 2 : 12}
              y2={34}
              className={index === frame.frame ? styles.currentTick : styles.tick}
            />
          ))}
          <line x1={(wallSeconds / total) * 1000} x2={(wallSeconds / total) * 1000} y1={0} y2={36} className={styles.playhead} />
        </svg>
      </div>

      <aside className={styles.inspector} aria-label="Playback timing inspector">
        <Segmented
          label="View"
          value={settings.view}
          options={[
            { value: "playback", label: "Clip playback" },
            { value: "crossfade", label: "Cross-fade" },
          ]}
          onChange={(view) => patch({ view })}
        />
        <label className={styles.field}>
          <span>Frame partition</span>
          <select value={settings.scenario} onChange={(event) => patch({ scenario: event.target.value })}>
            {evidence.scenarios.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label} ({option.deltaSeconds.length} frames)
              </option>
            ))}
          </select>
        </label>
        {settings.view === "playback" ? (
          <>
            <Segmented<PlaybackModeId>
              label="Mode"
              value={settings.mode}
              options={[
                { value: "clamp", label: "Clamp" },
                { value: "loop", label: "Loop" },
              ]}
              onChange={(mode) => patch({ mode })}
            />
            <Segmented<PlaybackDirectionId>
              label="Direction"
              value={settings.direction}
              options={[
                { value: "forward", label: "Forward" },
                { value: "reverse", label: "Reverse" },
              ]}
              onChange={(direction) => patch({ direction })}
            />
          </>
        ) : (
          <>
            <Segmented<number>
              label="Transition"
              value={settings.transitionSeconds}
              options={transitionDurations(evidence).map((seconds) => ({ value: seconds, label: `${seconds} s` }))}
              onChange={(transitionSeconds) => patch({ transitionSeconds })}
            />
            <Segmented<TransitionCurveId>
              label="Curve"
              value={settings.curve}
              options={[
                { value: "linear", label: "Linear" },
                { value: "smoothstep", label: "Smoothstep" },
              ]}
              onChange={(curve) => patch({ curve })}
            />
          </>
        )}

        <PrecisionRange
          label="Wall time"
          unit="s"
          value={Number(format(wallSeconds, 4))}
          min={0}
          max={total}
          step={0.01}
          onEditStart={() => setPlaying(false)}
          onChange={seek}
        />
        <div className={styles.transport}>
          <button type="button" onClick={() => stepFrame(-1)} aria-label="Previous presented frame">◀</button>
          <button type="button" onClick={() => setPlaying((value) => !value)}>{playing ? "Pause" : "Play"}</button>
          <button type="button" onClick={() => stepFrame(1)} aria-label="Next presented frame">▶</button>
          <label>
            <input type="checkbox" checked={showFixedStep} onChange={(event) => setShowFixedStep(event.target.checked)} />
            Fixed-step ghost
          </label>
        </div>

        <dl className={styles.stats}>
          <div><dt>Presented frame</dt><dd>{frame.frame} / {frame.frameCount - 1}</dd></div>
          <div><dt>Presented at</dt><dd>{format(frame.presentedAtSeconds)} s</dd></div>
          <div><dt>Measured Δ</dt><dd>{format(frame.deltaSeconds * 1000, 2)} ms</dd></div>
          {frame.readouts.map((readout) => (
            <div key={readout.label}>
              <dt>{readout.label}</dt>
              <dd>
                {format(readout.elapsed)}
                <span className={styles.fixedValue}> / {format(readout.fixedStep)}</span>
              </dd>
            </div>
          ))}
        </dl>

        <table className={styles.finals}>
          <caption>At {total} s, {finalLabel}</caption>
          <thead>
            <tr><th scope="col">Partition</th><th scope="col">Elapsed</th><th scope="col">Fixed step</th></tr>
          </thead>
          <tbody>
            {finals.map((final) => (
              <tr key={final.scenario.id} className={final.scenario.id === settings.scenario ? styles.selectedRow : undefined}>
                <th scope="row">{final.scenario.label}</th>
                <td>{format(final.elapsed)}</td>
                <td className={styles.fixedValue}>{format(final.fixedStep)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={styles.note}>
          Every value comes from <code>three-d-playback</code> evidence; this page only picks the frame on screen.
        </p>
      </aside>
    </section>
  );
}
