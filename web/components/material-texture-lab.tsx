"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import styles from "./material-texture-lab.module.css";

type Shape = "sphere" | "cube" | "torus";
type Pattern = "none" | "checker" | "stripes" | "dots";
type WrapMode = "repeat" | "mirror" | "clamp";

type MaterialState = {
  shape: Shape;
  baseColor: string;
  metallic: number;
  roughness: number;
  pattern: Pattern;
  repeat: number;
  wrap: WrapMode;
  doubleSided: boolean;
};

type Runtime = {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  texture: THREE.Texture | null;
  resizeObserver: ResizeObserver;
  frameId: number;
};

const DEFAULT_STATE: MaterialState = {
  shape: "sphere",
  baseColor: "#91b7e5",
  metallic: 0.15,
  roughness: 0.48,
  pattern: "checker",
  repeat: 3,
  wrap: "repeat",
  doubleSided: false,
};

function geometryForShape(shape: Shape): THREE.BufferGeometry {
  if (shape === "cube") return new THREE.BoxGeometry(1.7, 1.7, 1.7, 4, 4, 4);
  if (shape === "torus") return new THREE.TorusKnotGeometry(0.78, 0.26, 140, 22);
  return new THREE.SphereGeometry(1.05, 48, 32);
}

function patternTexture(pattern: Exclude<Pattern, "none">): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      let value = 255;
      if (pattern === "checker") value = ((Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0) ? 245 : 82;
      if (pattern === "stripes") value = Math.floor(x / 7) % 2 === 0 ? 245 : 94;
      if (pattern === "dots") {
        const dx = (x % 16) - 8;
        const dy = (y % 16) - 8;
        value = dx * dx + dy * dy < 18 ? 78 : 238;
      }
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function wrapping(mode: WrapMode): THREE.Wrapping {
  if (mode === "mirror") return THREE.MirroredRepeatWrapping;
  if (mode === "clamp") return THREE.ClampToEdgeWrapping;
  return THREE.RepeatWrapping;
}

function installTexture(runtime: Runtime, state: MaterialState) {
  runtime.texture?.dispose();
  runtime.texture = state.pattern === "none" ? null : patternTexture(state.pattern);
  if (runtime.texture) {
    const wrap = wrapping(state.wrap);
    runtime.texture.wrapS = wrap;
    runtime.texture.wrapT = wrap;
    runtime.texture.repeat.set(state.repeat, state.repeat);
    runtime.texture.needsUpdate = true;
  }
  runtime.mesh.material.map = runtime.texture;
  runtime.mesh.material.needsUpdate = true;
}

function applyMaterial(runtime: Runtime, state: MaterialState) {
  runtime.mesh.material.color.set(state.baseColor);
  runtime.mesh.material.metalness = state.metallic;
  runtime.mesh.material.roughness = state.roughness;
  runtime.mesh.material.side = state.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
  runtime.mesh.material.needsUpdate = true;
}

export function MaterialTextureLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const [state, setState] = useState<MaterialState>(DEFAULT_STATE);

  const patchState = (patch: Partial<MaterialState>) => setState((current) => ({ ...current, ...patch }));

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    applyMaterial(runtime, state);
  }, [state.baseColor, state.doubleSided, state.metallic, state.roughness]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    installTexture(runtime, state);
  }, [state.pattern, state.repeat, state.wrap]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const next = geometryForShape(state.shape);
    runtime.mesh.geometry.dispose();
    runtime.mesh.geometry = next;
  }, [state.shape]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c111a);
    const camera = new THREE.PerspectiveCamera(46, 1, 0.05, 100);
    camera.position.set(3.3, 2.4, 4.4);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.target.set(0, 0.1, 0);
    controls.update();

    scene.add(new THREE.HemisphereLight(0xe6efff, 0x273044, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 4.2);
    key.position.set(4, 5, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x8bb8ff, 2.1);
    rim.position.set(-4, 2, -3);
    scene.add(rim);

    const material = new THREE.MeshStandardMaterial();
    const mesh = new THREE.Mesh(geometryForShape(state.shape), material);
    scene.add(mesh);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(2.7, 64),
      new THREE.MeshStandardMaterial({ color: 0x1a2330, roughness: 0.95, metalness: 0 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.25;
    scene.add(floor);

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

    const runtime: Runtime = {
      renderer,
      camera,
      controls,
      mesh,
      texture: null,
      resizeObserver,
      frameId: 0,
    };
    runtimeRef.current = runtime;
    applyMaterial(runtime, state);
    installTexture(runtime, state);

    const clock = new THREE.Clock();
    const render = () => {
      const delta = Math.min(clock.getDelta(), 0.05);
      mesh.rotation.y += delta * 0.18;
      controls.update();
      renderer.render(scene, camera);
      runtime.frameId = requestAnimationFrame(render);
    };
    runtime.frameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(runtime.frameId);
      resizeObserver.disconnect();
      controls.dispose();
      runtime.texture?.dispose();
      mesh.geometry.dispose();
      material.dispose();
      floor.geometry.dispose();
      (floor.material as THREE.Material).dispose();
      renderer.dispose();
      runtimeRef.current = null;
    };
  }, []);

  return (
    <section className={styles.lab} aria-labelledby="material-lab-heading">
      <div className={styles.viewportPanel}>
        <div className={styles.headingRow}>
          <div>
            <p className="eyebrow">PBR material playground</p>
            <h2 id="material-lab-heading">Change the surface, not the geometry.</h2>
          </div>
          <p>Orbit the object while material factors, UV repetition and sampler wrapping update immediately.</p>
        </div>
        <canvas ref={canvasRef} className={styles.canvas} aria-label="Interactive material and texture preview" />
        <div className={styles.shapePicker} aria-label="Preview geometry">
          {(["sphere", "cube", "torus"] as const).map((shape) => (
            <button
              key={shape}
              type="button"
              className={state.shape === shape ? styles.active : ""}
              onClick={() => patchState({ shape })}
              aria-pressed={state.shape === shape}
            >
              {shape === "torus" ? "Torus knot" : shape[0].toUpperCase() + shape.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <aside className={styles.controlsPanel}>
        <label className={styles.colorControl}>
          <span>Base color</span>
          <input type="color" value={state.baseColor} onChange={(event) => patchState({ baseColor: event.target.value })} />
          <code>{state.baseColor}</code>
        </label>

        <label className={styles.rangeControl}>
          <span>Metallic <output>{state.metallic.toFixed(2)}</output></span>
          <input type="range" min="0" max="1" step="0.01" value={state.metallic} onChange={(event) => patchState({ metallic: Number(event.target.value) })} />
        </label>
        <label className={styles.rangeControl}>
          <span>Roughness <output>{state.roughness.toFixed(2)}</output></span>
          <input type="range" min="0" max="1" step="0.01" value={state.roughness} onChange={(event) => patchState({ roughness: Number(event.target.value) })} />
        </label>

        <label className={styles.selectControl}>
          <span>Texture pattern</span>
          <select value={state.pattern} onChange={(event) => patchState({ pattern: event.target.value as Pattern })}>
            <option value="none">None</option>
            <option value="checker">Checker</option>
            <option value="stripes">Stripes</option>
            <option value="dots">Dots</option>
          </select>
        </label>

        <label className={styles.rangeControl}>
          <span>UV repeat <output>{state.repeat.toFixed(1)}×</output></span>
          <input type="range" min="0.5" max="8" step="0.5" value={state.repeat} disabled={state.pattern === "none"} onChange={(event) => patchState({ repeat: Number(event.target.value) })} />
        </label>

        <label className={styles.selectControl}>
          <span>Texture wrap</span>
          <select value={state.wrap} disabled={state.pattern === "none"} onChange={(event) => patchState({ wrap: event.target.value as WrapMode })}>
            <option value="repeat">Repeat</option>
            <option value="mirror">Mirrored repeat</option>
            <option value="clamp">Clamp to edge</option>
          </select>
        </label>

        <label className={styles.toggle}>
          <input type="checkbox" checked={state.doubleSided} onChange={(event) => patchState({ doubleSided: event.target.checked })} />
          Double-sided material
        </label>

        <button type="button" className={styles.resetButton} onClick={() => setState(DEFAULT_STATE)}>Reset material</button>

        <div className={styles.boundary}>
          <strong>Durable model → renderer adapter</strong>
          <p>
            These controls mirror <code>three-d-assets</code>: base color factor, metallic factor, roughness factor, double-sided state and sampler wrapping. The generated teaching texture is browser-only; Three.js maps the model to GPU material state.
          </p>
        </div>
      </aside>
    </section>
  );
}
