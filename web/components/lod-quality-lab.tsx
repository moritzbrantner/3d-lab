"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { allLodLevels, lodFixtureUrl, type LodFixture, type LodFixtureLevel } from "@/lib/lod-fixture";
import { projectedErrorPixels, selectLodLevel } from "@/lib/lod-selection";
import styles from "./lod-quality-lab.module.css";

type Runtime = {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sourceMaterial: THREE.MeshStandardMaterial;
  selectedMaterial: THREE.MeshStandardMaterial;
  geometries: THREE.BufferGeometry[];
  selectedMesh: THREE.Mesh;
  resizeObserver: ResizeObserver;
  frameId: number;
};

function createGeometry(fixture: LodFixture, level: LodFixtureLevel) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(fixture.positions.flat(), 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(fixture.normals.flat(), 3));
  geometry.setIndex(level.indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function cameraPosition(distance: number) {
  return new THREE.Vector3(0, distance * 0.34, distance * 0.94);
}

export function LodQualityLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const [fixture, setFixture] = useState<LodFixture | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [distance, setDistance] = useState(8);
  const [targetPixelError, setTargetPixelError] = useState(2);
  const [hysteresisFraction, setHysteresisFraction] = useState(0.15);
  const [viewportHeightPixels, setViewportHeightPixels] = useState(720);
  const [currentLevel, setCurrentLevel] = useState(0);
  const [autoSelect, setAutoSelect] = useState(true);
  const [wireframe, setWireframe] = useState(false);

  const levels = useMemo(() => (fixture ? allLodLevels(fixture) : []), [fixture]);
  const relativeErrors = useMemo(() => levels.map((level) => level.relativeError), [levels]);
  const selectedLevel = levels[currentLevel] ?? null;

  useEffect(() => {
    const controller = new AbortController();
    const url = lodFixtureUrl(window.location.pathname);
    fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`LOD fixture returned HTTP ${response.status}`);
        return response.json();
      })
      .then((value: LodFixture) => {
        if (value.schemaVersion !== 1 || !Array.isArray(value.positions) || !Array.isArray(value.levels)) {
          throw new Error("LOD fixture does not match schema version 1");
        }
        setFixture(value);
        setViewportHeightPixels(value.selector.viewportHeightPixels);
        setCurrentLevel(0);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : "Could not load the generated LOD fixture");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!fixture || !autoSelect || relativeErrors.length === 0) return;
    setCurrentLevel((previousLevel) =>
      selectLodLevel(
        relativeErrors,
        Math.min(previousLevel, relativeErrors.length - 1),
        { targetPixelError, hysteresisFraction },
        {
          meshExtent: fixture.meshExtent,
          distance,
          viewportHeightPixels,
          verticalFovRadians: fixture.selector.verticalFovRadians,
        },
      ).level,
    );
  }, [
    autoSelect,
    distance,
    fixture,
    hysteresisFraction,
    relativeErrors,
    targetPixelError,
    viewportHeightPixels,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !fixture) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c111a);
    const camera = new THREE.PerspectiveCamera(
      THREE.MathUtils.radToDeg(fixture.selector.verticalFovRadians),
      1,
      0.1,
      100,
    );
    camera.position.copy(cameraPosition(distance));
    camera.lookAt(0, 0, 0);

    const controls = new OrbitControls(camera, canvas);
    controls.target.set(0, 0, 0);
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const geometries = allLodLevels(fixture).map((level) => createGeometry(fixture, level));
    const sourceMaterial = new THREE.MeshStandardMaterial({
      color: 0xaebfd8,
      roughness: 0.7,
      metalness: 0.02,
      wireframe,
    });
    const selectedMaterial = new THREE.MeshStandardMaterial({
      color: 0x7fa3d7,
      roughness: 0.62,
      metalness: 0.04,
      wireframe,
    });

    const sourceMesh = new THREE.Mesh(geometries[0], sourceMaterial);
    sourceMesh.position.x = -1.3;
    const selectedMesh = new THREE.Mesh(geometries[currentLevel] ?? geometries[0], selectedMaterial);
    selectedMesh.position.x = 1.3;
    scene.add(sourceMesh, selectedMesh);

    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(3.5, 5, 4);
    const fill = new THREE.DirectionalLight(0x9bbcff, 1.1);
    fill.position.set(-4, 2, 1.5);
    scene.add(key, fill, new THREE.AmbientLight(0xffffff, 0.5));

    const drawingBufferSize = new THREE.Vector2();
    const resize = () => {
      const width = Math.max(canvas.clientWidth, 1);
      const height = Math.max(canvas.clientHeight, 1);
      renderer.setSize(width, height, false);
      renderer.getDrawingBufferSize(drawingBufferSize);
      setViewportHeightPixels(drawingBufferSize.y);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();

    let frameId = 0;
    const render = () => {
      controls.update();
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(render);
    };
    render();

    runtimeRef.current = {
      renderer,
      camera,
      controls,
      sourceMaterial,
      selectedMaterial,
      geometries,
      selectedMesh,
      resizeObserver,
      frameId,
    };

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      controls.dispose();
      geometries.forEach((geometry) => geometry.dispose());
      sourceMaterial.dispose();
      selectedMaterial.dispose();
      renderer.dispose();
      runtimeRef.current = null;
    };
  }, [fixture]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.camera.position.copy(cameraPosition(distance));
    runtime.camera.lookAt(runtime.controls.target);
    runtime.controls.update();
  }, [distance]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || currentLevel >= runtime.geometries.length) return;
    runtime.selectedMesh.geometry = runtime.geometries[currentLevel];
  }, [currentLevel]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.sourceMaterial.wireframe = wireframe;
    runtime.selectedMaterial.wireframe = wireframe;
    runtime.sourceMaterial.needsUpdate = true;
    runtime.selectedMaterial.needsUpdate = true;
  }, [wireframe]);

  const projectedError = fixture && selectedLevel
    ? projectedErrorPixels(selectedLevel.relativeError, {
        meshExtent: fixture.meshExtent,
        distance,
        viewportHeightPixels,
        verticalFovRadians: fixture.selector.verticalFovRadians,
      })
    : 0;

  return (
    <section className={styles.lab} aria-labelledby="lod-quality-heading">
      <div className={styles.viewportPanel}>
        <div className={styles.headingRow}>
          <div>
            <p className="eyebrow">Level of detail</p>
            <h2 id="lod-quality-heading">Judge the actual Rust simplifier output, not a browser approximation.</h2>
          </div>
          <p>Orbit the comparison. Distance controls both the viewing scale and the screen-space LOD decision.</p>
        </div>
        <div className={styles.comparisonLabels} aria-hidden="true">
          <span>source mesh</span>
          <span>{currentLevel === 0 ? "source mesh" : `LOD ${currentLevel}`}</span>
        </div>
        <canvas ref={canvasRef} className={styles.canvas} aria-label="Source mesh and selected simplified mesh comparison" />
        {loadError ? (
          <p className={`${styles.status} ${styles.error}`}>{loadError}</p>
        ) : fixture ? (
          <p className={styles.status}>
            Generated by <code>{fixture.simplifierId}</code>. Every displayed LOD reuses the same source vertex buffer and a Rust-produced index buffer.
          </p>
        ) : (
          <p className={styles.status}>Loading the build-generated LOD fixture…</p>
        )}
      </div>

      <div className={styles.controlPanel}>
        <div>
          <p className="eyebrow">Selection policy</p>
          <h2>Make detail a bounded visual error.</h2>
        </div>

        <div className={styles.controlGroup}>
          <label className={styles.rangeLabel}>
            <span>Camera distance <output>{distance.toFixed(1)}</output></span>
            <input type="range" min="4" max="16" step="0.25" value={distance} onChange={(event) => setDistance(Number(event.target.value))} />
          </label>
          <label className={styles.rangeLabel}>
            <span>Pixel-error budget <output>{targetPixelError.toFixed(1)} px</output></span>
            <input type="range" min="0.5" max="6" step="0.1" value={targetPixelError} onChange={(event) => setTargetPixelError(Number(event.target.value))} />
          </label>
          <label className={styles.rangeLabel}>
            <span>Hysteresis <output>{Math.round(hysteresisFraction * 100)}%</output></span>
            <input type="range" min="0" max="0.4" step="0.05" value={hysteresisFraction} onChange={(event) => setHysteresisFraction(Number(event.target.value))} />
          </label>
        </div>

        <label className={styles.toggle}>
          <input type="checkbox" checked={autoSelect} onChange={(event) => setAutoSelect(event.target.checked)} />
          Select level from projected error
        </label>

        <div className={styles.levelButtons} aria-label="Manual LOD selection">
          {levels.map((level, index) => (
            <button
              key={level.level}
              type="button"
              className={index === currentLevel ? styles.activeLevel : undefined}
              onClick={() => {
                setAutoSelect(false);
                setCurrentLevel(index);
              }}
            >
              {index === 0 ? "Source" : `LOD ${index}`}
            </button>
          ))}
        </div>

        <label className={styles.toggle}>
          <input type="checkbox" checked={wireframe} onChange={(event) => setWireframe(event.target.checked)} />
          Show triangle structure
        </label>

        <div className={styles.readout}>
          {fixture && selectedLevel ? (
            <>
              <p>
                <strong>{currentLevel === 0 ? "Source" : `LOD ${currentLevel}`}</strong> uses {selectedLevel.triangleCount.toLocaleString()} triangles; the source uses {fixture.source.triangleCount.toLocaleString()}.
              </p>
              {selectedLevel.requestedTriangleCount !== undefined ? (
                <p>The requested budget was {selectedLevel.requestedTriangleCount.toLocaleString()} triangles; topology and the error limit determine the actual result.</p>
              ) : null}
              <p>
                Relative simplification error is <code>{selectedLevel.relativeError.toFixed(5)}</code>, which projects to about <code>{projectedError.toFixed(2)} px</code> at this distance and a <code>{Math.round(viewportHeightPixels)} px</code> drawing-buffer height.
              </p>
            </>
          ) : null}
        </div>

        <div className={styles.boundary}>
          <strong>Authority boundary</strong>
          <p>
            Rust owns simplification and the screen-space selection contract. The browser mirrors selection only for interaction, and its transition sequence is tested against Rust-generated fixture samples. Three.js only draws the chosen buffers.
          </p>
        </div>
      </div>
    </section>
  );
}
