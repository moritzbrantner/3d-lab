"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  loadImportedSkinnedGltf,
  SIMPLE_SKIN_FIXTURE_URL,
  SIMPLE_SKIN_SOURCE,
  type ImportedSkinnedModel,
} from "@/lib/imported-skin";
import styles from "./character-rig-lab.module.css";

type Runtime = ImportedSkinnedModel & {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction;
  frameId: number;
  resizeObserver: ResizeObserver;
  time: number;
  playing: boolean;
};

function ExactTimeInput({ value, max, onCommit }: { value: number; max: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelRef = useRef(false);
  return <input
    aria-label="Imported animation time (seconds)"
    type="number"
    min={0}
    max={max}
    step="any"
    value={draft ?? String(Number(value.toFixed(6)))}
    onFocus={() => setDraft(String(value))}
    onChange={(event) => setDraft(event.target.value)}
    onKeyDown={(event) => {
      if (event.key === "Enter") {
        const next = event.currentTarget.valueAsNumber;
        if (Number.isFinite(next)) {
          const committed = THREE.MathUtils.clamp(next, 0, max);
          onCommit(committed);
          setDraft(String(committed));
        }
        event.preventDefault();
      } else if (event.key === "Escape") {
        cancelRef.current = true;
        event.preventDefault();
        event.currentTarget.blur();
      }
    }}
    onBlur={(event) => {
      const next = event.target.valueAsNumber;
      if (!cancelRef.current && Number.isFinite(next)) onCommit(THREE.MathUtils.clamp(next, 0, max));
      cancelRef.current = false;
      setDraft(null);
    }}
  />;
}

export function ImportedSkinLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const [ready, setReady] = useState(false);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [duration, setDuration] = useState(5.5);
  const [error, setError] = useState<string | null>(null);

  const seek = (next: number) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.playing = false;
    runtime.time = next;
    runtime.mixer.setTime(next);
    runtime.root.updateMatrixWorld(true);
    runtime.skeleton.update();
    setPlaying(false);
    setTime(next);
  };

  const togglePlaying = () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.playing = !runtime.playing;
    if (runtime.playing) runtime.action.play();
    setPlaying(runtime.playing);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let runtime: Runtime | null = null;

    void (async () => {
      try {
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0c111a);
        scene.add(new THREE.HemisphereLight(0xe6efff, 0x263044, 2.6));
        const key = new THREE.DirectionalLight(0xffffff, 3);
        key.position.set(3, 5, 4);
        scene.add(key);

        const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 100);
        camera.position.set(3.1, 2.2, 4.6);
        const controls = new OrbitControls(camera, canvas);
        controls.enableDamping = true;
        controls.target.set(0, 1, 0);
        controls.update();

        const imported = await loadImportedSkinnedGltf(SIMPLE_SKIN_FIXTURE_URL);
        if (cancelled) {
          imported.dispose();
          renderer.dispose();
          controls.dispose();
          return;
        }
        imported.mesh.material.forEach((material) => {
          material.side = THREE.DoubleSide;
          material.needsUpdate = true;
        });
        scene.add(imported.root);
        imported.skeletonHelper.visible = true;

        const clip = imported.clips[0];
        if (!clip) throw new Error("canonical SimpleSkin fixture contains no animation clip");
        const mixer = new THREE.AnimationMixer(imported.root);
        const action = mixer.clipAction(clip);
        action.play();

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

        runtime = {
          ...imported, renderer, scene, camera, controls, mixer, action,
          frameId: 0, resizeObserver, time: 0, playing: true,
        };
        runtimeRef.current = runtime;
        canvas.dataset.importedReady = "true";
        canvas.dataset.joints = String(imported.skeleton.bones.length);
        canvas.dataset.clipCount = String(imported.clips.length);
        canvas.dataset.duration = String(clip.duration);
        canvas.dataset.sourceDraws = String(imported.sourceDraws);
        canvas.dataset.materialDraws = String(imported.materialDraws);
        canvas.dataset.skinIndexBytes = String(imported.skinIndexBytesPerVertex);
        setDuration(clip.duration);
        setReady(true);

        let previous = performance.now();
        let lastUiUpdate = previous;
        const render = (now: number) => {
          if (!runtime) return;
          const delta = Math.max(0, Math.min((now - previous) / 1000, 0.1));
          previous = now;
          if (runtime.playing) {
            runtime.mixer.update(delta);
            runtime.time = runtime.mixer.time % clip.duration;
            if (now - lastUiUpdate >= 100) {
              lastUiUpdate = now;
              setTime(runtime.time);
            }
          }
          runtime.controls.update();
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
      runtime.controls.dispose();
      runtime.mixer.stopAllAction();
      runtime.dispose();
      runtime.renderer.dispose();
      runtimeRef.current = null;
    };
  }, []);

  return (
    <section className={styles.lab} aria-labelledby="imported-skin-heading">
      <div className={styles.viewportPanel}>
        <div className={styles.headingRow}>
          <div>
            <p className="eyebrow">Canonical imported asset</p>
            <h2 id="imported-skin-heading">Khronos SimpleSkin through the same weighted renderer boundary.</h2>
          </div>
          <p>The fixture is vendored and verified, so the demo works offline and does not depend on a runtime CDN.</p>
        </div>
        <canvas ref={canvasRef} className={styles.canvas} aria-label="Imported Khronos SimpleSkin animation" />
        {error ? <p role="alert">{error}</p> : null}
      </div>
      <aside className={styles.controlsPanel}>
        <div>
          <span className={styles.sectionLabel}>Imported clip</span>
          <strong>{ready ? "animation_0" : "Loading…"}</strong>
        </div>
        <label className={styles.rangeControl}>
          <span>Timeline <output>{time.toFixed(3)} s / {duration.toFixed(3)} s</output></span>
          <input type="range" min={0} max={duration} step="0.001" value={Math.min(time, duration)}
            onChange={(event) => seek(Number(event.target.value))} disabled={!ready} />
        </label>
        <label className={styles.rangeControl}>
          <span>Exact time (seconds)</span>
          <ExactTimeInput value={time} max={duration} onCommit={seek} />
        </label>
        <button type="button" className={styles.primaryButton} onClick={togglePlaying} disabled={!ready}>
          {playing ? "Pause imported animation" : "Play imported animation"}
        </button>
        <div className={styles.boundary}>
          <strong>Source and ownership</strong>
          <p>{SIMPLE_SKIN_SOURCE.provider}, pinned revision <code>{SIMPLE_SKIN_SOURCE.revision.slice(0, 12)}</code>, {SIMPLE_SKIN_SOURCE.license}.</p>
          <p>GLTFLoader parses the asset. The adapter extracts explicit indexed geometry, joints, weights and bind data; the reusable renderer validates and batches them. Animation clips and provenance remain outside the renderer.</p>
        </div>
      </aside>
    </section>
  );
}
