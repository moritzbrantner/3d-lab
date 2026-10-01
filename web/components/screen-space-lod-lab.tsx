"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import * as THREE from "three";
import {
  distanceAt,
  distanceRange,
  findPolicy,
  findViewport,
  hysteresisPercents,
  initialLodLabState,
  pixelBudgets,
  reduceLodLab,
  screenSpaceLodEvidence as evidence,
  viewportHeights,
  type LodLabAction,
  type LodLabState,
  type LodSwitch,
} from "@/lib/screen-space-lod";
import { PrecisionRange } from "./PrecisionRange";
import styles from "./screen-space-lod-lab.module.css";

const range = distanceRange(evidence);
const budgets = pixelBudgets(evidence);
const hysteresisOptions = hysteresisPercents(evidence);
const reduce = (state: LodLabState, action: LodLabAction) => reduceLodLab(evidence, state, action);
const tallestViewport = viewportHeights(evidence).at(-1)!;
/** Space the canvas may take; the canvas then snaps to a Rust-evaluated height within it. */
const availableViewportHeight = () => Math.round(window.innerHeight * 0.72);
const formatPixels = (value: number) => (value < 10 ? value.toFixed(2) : value.toFixed(1));

function SwitchList({ label, switches, onJump }: { label: string; switches: LodSwitch[]; onJump: (distance: number) => void }) {
  return (
    <div className={styles.switchRow}>
      <span>{label}</span>
      {switches.length === 0 ? <em>none in range</em> : switches.map((entry) => {
        const distance = distanceAt(evidence, entry.distanceIndex);
        return (
          <button key={`${entry.from}-${entry.to}`} type="button" onClick={() => onJump(distance)}
            title={`Move the camera to ${distance}`}>
            L{entry.from}→L{entry.to} @ {distance}
          </button>
        );
      })}
    </div>
  );
}

export function ScreenSpaceLodLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, dispatch] = useReducer(reduce, undefined, () => initialLodLabState(evidence, tallestViewport, 6, 2, 25));
  const [wireframe, setWireframe] = useState(true);
  const [compare, setCompare] = useState(false);
  const distance = distanceAt(evidence, state.distanceIndex);
  const viewRef = useRef({ distance, level: state.shownLevel, wireframe, compare });
  viewRef.current = { distance, level: state.shownLevel, wireframe, compare };
  const viewport = findViewport(evidence, state.viewportHeight);
  const policy = findPolicy(viewport, state.maxPixelError, state.hysteresisPercent);
  const projected = viewport.projectedErrorPixels[state.distanceIndex];
  const shown = evidence.levels[state.shownLevel];

  // The canvas is rendered at exactly the Rust-evaluated height in state, so the
  // projected errors and decisions shown describe the pixels actually drawn.
  useEffect(() => {
    const fit = () => dispatch({ type: "viewport", availableHeight: availableViewportHeight() });
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setScissorTest(true);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c111a);
    const camera = new THREE.PerspectiveCamera(evidence.view.verticalFovDegrees, 1, 0.05, 200);

    const position = new THREE.Float32BufferAttribute(evidence.positions, 3);
    const normal = new THREE.Float32BufferAttribute(evidence.normals, 3);
    const geometries = evidence.levels.map((level) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", position);
      geometry.setAttribute("normal", normal);
      geometry.setIndex(level.indices);
      return geometry;
    });
    const surfaceMaterial = new THREE.MeshStandardMaterial({
      color: 0x9fb4d8, roughness: 0.62, metalness: 0.04,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    const wireMaterial = new THREE.MeshBasicMaterial({ color: 0xffc56b, wireframe: true, transparent: true, opacity: 0.55 });
    const surface = new THREE.Mesh(geometries[0], surfaceMaterial);
    const wire = new THREE.Mesh(geometries[0], wireMaterial);
    scene.add(surface, wire);
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(3, 4, 5);
    const rim = new THREE.DirectionalLight(0x9bbcff, 1.2);
    rim.position.set(-4, 1, -2);
    scene.add(key, rim, new THREE.AmbientLight(0xffffff, 0.35));

    // Orbit angles are presentation only; the authoritative distance lives in React state.
    const orbit = { yaw: 0.6, pitch: 0.35 };
    let drag: { id: number; x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      orbit.yaw -= (event.clientX - drag.x) * 0.008;
      orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + (event.clientY - drag.y) * 0.008, -1.4, 1.4);
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const onPointerUp = (event: PointerEvent) => {
      if (drag?.id === event.pointerId) drag = null;
    };
    // Accumulate sub-step wheel deltas so trackpads can cross grid samples.
    let wheelDistance = viewRef.current.distance;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const shown = viewRef.current.distance;
      const base = Math.abs(wheelDistance - shown) < range.step ? wheelDistance : shown;
      wheelDistance = THREE.MathUtils.clamp(base * Math.exp(event.deltaY * 0.0015), range.min, range.max);
      dispatch({ type: "distance", distance: wheelDistance });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const current = viewRef.current.distance;
      const fast = event.shiftKey ? 10 : 1;
      if (event.key === "+" || event.key === "=") dispatch({ type: "distance", distance: current - range.step * fast });
      else if (event.key === "-") dispatch({ type: "distance", distance: current + range.step * fast });
      else if (event.key === "ArrowLeft") orbit.yaw += 0.1;
      else if (event.key === "ArrowRight") orbit.yaw -= 0.1;
      else if (event.key === "ArrowUp") orbit.pitch = Math.min(1.4, orbit.pitch + 0.1);
      else if (event.key === "ArrowDown") orbit.pitch = Math.max(-1.4, orbit.pitch - 0.1);
      else return;
      event.preventDefault();
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("keydown", onKeyDown);

    const resize = () => renderer.setSize(Math.max(canvas.clientWidth, 1), Math.max(canvas.clientHeight, 1), false);
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const drawPane = (level: number, x: number, width: number, height: number) => {
      surface.geometry = geometries[level];
      wire.geometry = geometries[level];
      renderer.setViewport(x, 0, width, height);
      renderer.setScissor(x, 0, width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    };

    let frame = 0;
    const render = () => {
      const view = viewRef.current;
      const size = renderer.getSize(new THREE.Vector2());
      camera.position.setFromSphericalCoords(view.distance, Math.PI / 2 - orbit.pitch, orbit.yaw);
      camera.lookAt(0, 0, 0);
      wire.visible = view.wireframe;
      const drawn = view.compare ? [0, view.level] : [view.level];
      if (view.compare) {
        const half = Math.floor(size.x / 2);
        drawPane(0, 0, half, size.y);
        drawPane(view.level, half, size.x - half, size.y);
      } else {
        drawPane(view.level, 0, size.x, size.y);
      }
      // Browser evidence: which index buffers and camera distance the GPU actually drew.
      const evidenceText = `${drawn.join(",")}@${view.distance}`;
      if (canvas.dataset.rendered !== evidenceText) canvas.dataset.rendered = evidenceText;
      const drawnHeight = String(canvas.clientHeight);
      if (canvas.dataset.drawnHeight !== drawnHeight) canvas.dataset.drawnHeight = drawnHeight;
      frame = requestAnimationFrame(render);
    };
    render();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("keydown", onKeyDown);
      geometries.forEach((geometry) => geometry.dispose());
      surfaceMaterial.dispose();
      wireMaterial.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <section className={styles.lab} aria-labelledby="lod-lab-heading">
      <div className={styles.viewportPanel}>
        <h2 id="lod-lab-heading" className={styles.srOnly}>Screen-space LOD viewport</h2>
        <canvas ref={canvasRef} className={styles.canvas} tabIndex={0}
          style={{ height: state.viewportHeight }} data-evidence-height={state.viewportHeight}
          aria-label={`Displaced sphere at distance ${distance}, showing LOD ${state.shownLevel}. Drag to orbit, scroll or press plus and minus to change distance.`} />
        <p className={styles.viewportHint}>
          {compare ? <><span>Left: source L0</span><span>Right: shown L{state.shownLevel}</span></> : <span>Drag to orbit · scroll or +/− to dolly</span>}
        </p>
      </div>

      <aside className={styles.inspector} aria-label="LOD inspector">
        <dl className={styles.readout}>
          <div><dt>Shown</dt><dd>L{state.shownLevel} · {shown.triangleCount} tris</dd></div>
          <div><dt>Policy</dt><dd>{state.overrideLevel === null ? `${state.decision.reason}, ideal L${state.decision.idealLevel}` : `override (policy L${state.decision.level})`}</dd></div>
          <div><dt>Error on screen</dt><dd>{formatPixels(projected[state.shownLevel])} px / {state.maxPixelError} px</dd></div>
        </dl>

        <PrecisionRange label="Camera distance" value={distance} min={range.min} max={range.max} step={range.step}
          onChange={(next) => dispatch({ type: "distance", distance: next })} />

        <fieldset className={styles.segmented}>
          <legend>Pixel budget</legend>
          {budgets.map((budget) => (
            <button key={budget} type="button" aria-pressed={state.maxPixelError === budget}
              onClick={() => dispatch({ type: "policy", maxPixelError: budget })}>{budget} px</button>
          ))}
        </fieldset>
        <fieldset className={styles.segmented}>
          <legend>Hysteresis band</legend>
          {hysteresisOptions.map((percent) => (
            <button key={percent} type="button" aria-pressed={state.hysteresisPercent === percent}
              onClick={() => dispatch({ type: "policy", hysteresisPercent: percent })}>±{percent}%</button>
          ))}
        </fieldset>
        <fieldset className={styles.segmented}>
          <legend>Level</legend>
          <button type="button" aria-pressed={state.overrideLevel === null}
            onClick={() => dispatch({ type: "override", level: null })}>Auto</button>
          {evidence.levels.map((level) => (
            <button key={level.level} type="button" aria-pressed={state.overrideLevel === level.level}
              onClick={() => dispatch({ type: "override", level: level.level })}>L{level.level}</button>
          ))}
        </fieldset>
        <div className={styles.toggles}>
          <label><input type="checkbox" checked={wireframe} onChange={(event) => setWireframe(event.target.checked)} /> Wireframe</label>
          <label><input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} /> Split with source</label>
        </div>

        <table className={styles.levels}>
          <thead><tr><th>Level</th><th>Tris</th><th>Error</th><th>On screen</th></tr></thead>
          <tbody>
            {evidence.levels.map((level) => (
              <tr key={level.level} aria-current={level.level === state.shownLevel || undefined}>
                <td>L{level.level}{level.level === state.decision.idealLevel ? " ·ideal" : ""}</td>
                <td>{level.triangleCount}</td>
                <td>{level.geometricError.toFixed(4)}</td>
                <td>{formatPixels(projected[level.level])} px</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className={styles.switches}>
          <SwitchList label="Dolly out" switches={policy.outboundSwitches} onJump={(next) => dispatch({ type: "distance", distance: next })} />
          <SwitchList label="Dolly in" switches={policy.inboundSwitches} onJump={(next) => dispatch({ type: "distance", distance: next })} />
        </div>

        <p className={styles.provenance}>
          Levels and decisions come from <code>three-d-lod</code> ({evidence.simplifierId}), sampled every {range.step} units for this {state.viewportHeight} px tall, {evidence.view.verticalFovDegrees}° view
          (Rust tables exist for {viewportHeights(evidence).join(", ")} px; the canvas snaps to the tallest that fits). Errors are in object units.
        </p>
      </aside>
    </section>
  );
}
