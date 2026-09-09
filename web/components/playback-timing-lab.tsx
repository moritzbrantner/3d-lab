"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { playbackFixtureUrl, type PlaybackFixture } from "@/lib/playback-fixture";
import styles from "./playback-timing-lab.module.css";

type Runtime = {
  renderer: THREE.WebGLRenderer;
  correctMarker: THREE.Mesh;
  naiveMarker: THREE.Mesh;
  blendedMesh: THREE.Mesh;
  resizeObserver: ResizeObserver;
  frameId: number;
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
};

function normalizedTimelineX(time: number, duration: number) {
  return -1.5 + (time / duration) * 3;
}

export function PlaybackTimingLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const [fixture, setFixture] = useState<PlaybackFixture | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [presentationSpeed, setPresentationSpeed] = useState(1);

  useEffect(() => {
    const controller = new AbortController();
    fetch(playbackFixtureUrl(window.location.pathname), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Playback fixture returned HTTP ${response.status}`);
        return response.json();
      })
      .then((value: PlaybackFixture) => {
        if (value.schemaVersion !== 1 || !Array.isArray(value.frames) || value.frames.length === 0) {
          throw new Error("Playback fixture does not match schema version 1");
        }
        setFixture(value);
        setFrameIndex(0);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : "Could not load playback evidence");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!fixture || !playing) return;
    const nextIndex = (frameIndex + 1) % fixture.frames.length;
    const delayMilliseconds = Math.max(
      (fixture.frames[nextIndex].deltaSeconds * 1000) / presentationSpeed,
      12,
    );
    const timer = window.setTimeout(() => setFrameIndex(nextIndex), delayMilliseconds);
    return () => window.clearTimeout(timer);
  }, [fixture, frameIndex, playing, presentationSpeed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !fixture) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c111a);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 2.8, 5.5);
    camera.lookAt(0, 0.2, 0);

    const markerGeometry = new THREE.SphereGeometry(0.11, 20, 14);
    const cubeGeometry = new THREE.BoxGeometry(0.55, 0.55, 0.55);
    const correctMaterial = new THREE.MeshStandardMaterial({ color: 0x86d29a, roughness: 0.55 });
    const naiveMaterial = new THREE.MeshStandardMaterial({ color: 0xe5a67a, roughness: 0.55 });
    const blendMaterial = new THREE.MeshStandardMaterial({ color: 0x88aee5, roughness: 0.48 });

    const correctMarker = new THREE.Mesh(markerGeometry, correctMaterial);
    correctMarker.position.y = 1.05;
    const naiveMarker = new THREE.Mesh(markerGeometry, naiveMaterial);
    naiveMarker.position.y = 0.55;
    const blendedMesh = new THREE.Mesh(cubeGeometry, blendMaterial);
    blendedMesh.position.y = -0.55;
    scene.add(correctMarker, naiveMarker, blendedMesh);

    const trackMaterial = new THREE.LineBasicMaterial({ color: 0x526173 });
    const trackGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-1.5, 1.05, 0),
      new THREE.Vector3(1.5, 1.05, 0),
      new THREE.Vector3(1.5, 0.55, 0),
      new THREE.Vector3(-1.5, 0.55, 0),
    ]);
    scene.add(new THREE.LineSegments(trackGeometry, trackMaterial));

    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(3, 4, 4);
    scene.add(key, new THREE.AmbientLight(0xffffff, 0.55));

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

    let animationFrame = 0;
    const render = () => {
      renderer.render(scene, camera);
      animationFrame = requestAnimationFrame(render);
    };
    render();

    runtimeRef.current = {
      renderer,
      correctMarker,
      naiveMarker,
      blendedMesh,
      resizeObserver,
      frameId: animationFrame,
      geometries: [markerGeometry, cubeGeometry, trackGeometry],
      materials: [correctMaterial, naiveMaterial, blendMaterial, trackMaterial],
    };

    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      for (const geometry of [markerGeometry, cubeGeometry, trackGeometry]) geometry.dispose();
      for (const material of [correctMaterial, naiveMaterial, blendMaterial, trackMaterial]) material.dispose();
      renderer.dispose();
      runtimeRef.current = null;
    };
  }, [fixture]);

  useEffect(() => {
    if (!fixture) return;
    const runtime = runtimeRef.current;
    const frame = fixture.frames[frameIndex];
    if (!runtime || !frame) return;

    runtime.correctMarker.position.x = normalizedTimelineX(frame.playbackTimeSeconds, fixture.clipDurationSeconds);
    runtime.naiveMarker.position.x = normalizedTimelineX(frame.naiveFixedFrameTimeSeconds, fixture.clipDurationSeconds);
    runtime.blendedMesh.position.set(...frame.pose.translation);
    runtime.blendedMesh.position.y -= 0.55;
    runtime.blendedMesh.quaternion.set(...frame.pose.rotation);
    runtime.blendedMesh.scale.set(...frame.pose.scale);
  }, [fixture, frameIndex]);

  const frame = fixture?.frames[frameIndex] ?? null;
  const drift = frame ? frame.playbackTimeSeconds - frame.naiveFixedFrameTimeSeconds : 0;

  return (
    <section className={styles.lab} aria-labelledby="playback-timing-heading">
      <div className={styles.viewportPanel}>
        <div className={styles.headingRow}>
          <div>
            <p className="eyebrow">Animation timing</p>
            <h2 id="playback-timing-heading">Dropped frames should change sampling density, not animation speed.</h2>
          </div>
          <p>Rust advances the clocks from elapsed seconds. The orange marker shows what happens when code incorrectly assumes every rendered frame lasted 1/60 second.</p>
        </div>
        <canvas ref={canvasRef} className={styles.canvas} aria-label="Elapsed-time animation clock compared with fixed-per-frame timing and a blended pose" />
        <div className={styles.legend}>
          <span>green: elapsed-time clip clock</span>
          <span>orange: incorrect fixed-per-frame clock</span>
          <span>blue: Rust-generated cross-faded pose</span>
        </div>
        {loadError ? (
          <p className={`${styles.status} ${styles.error}`}>{loadError}</p>
        ) : fixture ? (
          <p className={styles.status}>Every sample shown here was generated by <code>three-d-playback</code>; Three.js is only presenting the recorded pose and timing evidence.</p>
        ) : (
          <p className={styles.status}>Loading build-generated playback evidence…</p>
        )}
      </div>

      <div className={styles.controlPanel}>
        <div>
          <p className="eyebrow">Uneven frame sequence</p>
          <h2>Inspect time, drift, and transition weight together.</h2>
        </div>

        <div className={styles.transport}>
          <button type="button" onClick={() => setPlaying((value) => !value)}>{playing ? "Pause" : "Play"}</button>
          <button type="button" onClick={() => setFrameIndex((value) => Math.max(value - 1, 0))}>Previous</button>
          <button type="button" onClick={() => fixture && setFrameIndex((value) => Math.min(value + 1, fixture.frames.length - 1))}>Next</button>
        </div>

        {fixture ? (
          <label className={styles.rangeLabel}>
            <span>Evidence frame <output>{frameIndex + 1} / {fixture.frames.length}</output></span>
            <input
              type="range"
              min="0"
              max={fixture.frames.length - 1}
              step="1"
              value={frameIndex}
              onChange={(event) => {
                setPlaying(false);
                setFrameIndex(Number(event.target.value));
              }}
            />
          </label>
        ) : null}

        <label className={styles.rangeLabel}>
          <span>Presentation speed <output>{presentationSpeed.toFixed(1)}×</output></span>
          <input type="range" min="0.5" max="2" step="0.5" value={presentationSpeed} onChange={(event) => setPresentationSpeed(Number(event.target.value))} />
        </label>

        <div className={styles.readout}>
          {frame && fixture ? (
            <>
              <p>This rendered frame followed a <strong>{(frame.deltaSeconds * 1000).toFixed(0)} ms</strong> interval. Wall time is <code>{frame.wallTimeSeconds.toFixed(3)} s</code>.</p>
              <p>The correct clip sample is <code>{frame.playbackTimeSeconds.toFixed(3)} s</code>; fixed-per-frame code thinks it is <code>{frame.naiveFixedFrameTimeSeconds.toFixed(3)} s</code>. Drift: <code>{drift.toFixed(3)} s</code>.</p>
              <p>The transition is <code>{(frame.transitionLinearProgress * 100).toFixed(1)}%</code> through its elapsed duration and applies a smoothstep blend weight of <code>{frame.blendFactor.toFixed(3)}</code>.</p>
              <p>{frame.transitionComplete ? "The cross-fade has completed; later frames remain fully on the target clip." : "Both clips are sampled independently, then translation/scale are blended and rotation is quaternion-SLERPed."}</p>
            </>
          ) : null}
        </div>

        <div className={styles.boundary}>
          <strong>Timing boundary</strong>
          <p>Render cadence only decides when a pose is displayed. Playback time and transition progress come from elapsed time; keyframe meaning and quaternion interpolation remain owned by <code>three-d-animation</code>.</p>
        </div>
      </div>
    </section>
  );
}
