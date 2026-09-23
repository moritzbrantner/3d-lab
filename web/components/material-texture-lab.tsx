"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  generateProceduralRgba,
  type ProceduralPattern,
  type TextureBlendMode,
} from "@/lib/procedural-texture";
import styles from "./material-texture-lab.module.css";

type Shape = "plane" | "sphere" | "cube" | "torus";
type Pattern = "none" | ProceduralPattern;
type WrapMode = "repeat" | "mirror" | "clamp";

type MaterialState = {
  shape: Shape;
  baseColor: string;
  metallic: number;
  roughness: number;
  pattern: Pattern;
  secondaryPattern: Pattern;
  primaryFrequency: number;
  secondaryFrequency: number;
  blendMode: TextureBlendMode;
  blendAmount: number;
  repeatU: number;
  repeatV: number;
  rotationDegrees: number;
  offsetU: number;
  offsetV: number;
  wrap: WrapMode;
  stretchX: number;
  compensateStretch: boolean;
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
  secondaryPattern: "dots",
  primaryFrequency: 8,
  secondaryFrequency: 10,
  blendMode: "multiply",
  blendAmount: 0.35,
  repeatU: 2,
  repeatV: 2,
  rotationDegrees: 0,
  offsetU: 0,
  offsetV: 0,
  wrap: "repeat",
  stretchX: 1,
  compensateStretch: false,
  doubleSided: false,
};

const PATTERNS: Pattern[] = ["none", "checker", "stripes", "dots", "rings", "noise"];

function geometryForShape(shape: Shape): THREE.BufferGeometry {
  if (shape === "plane") return new THREE.PlaneGeometry(2.1, 2.1, 12, 12);
  if (shape === "cube") return new THREE.BoxGeometry(1.7, 1.7, 1.7, 4, 4, 4);
  if (shape === "torus") return new THREE.TorusKnotGeometry(0.78, 0.26, 140, 22);
  return new THREE.SphereGeometry(1.05, 48, 32);
}

function proceduralTexture(state: MaterialState): THREE.DataTexture | null {
  if (state.pattern === "none") return null;

  const pixels = generateProceduralRgba({
    size: 128,
    primary: {
      pattern: state.pattern,
      frequency: state.primaryFrequency,
      seed: 17,
    },
    secondary: state.secondaryPattern === "none"
      ? undefined
      : {
          pattern: state.secondaryPattern,
          frequency: state.secondaryFrequency,
          seed: 53,
        },
    blendMode: state.blendMode,
    blendAmount: state.blendAmount,
  });
  const texture = new THREE.DataTexture(pixels, 128, 128, THREE.RGBAFormat);
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

function effectiveRepeatU(state: MaterialState): number {
  if (state.shape === "plane" && state.compensateStretch) {
    return state.repeatU * state.stretchX;
  }
  return state.repeatU;
}

function applyTextureMapping(runtime: Runtime, state: MaterialState) {
  if (!runtime.texture) return;
  const wrap = wrapping(state.wrap);
  runtime.texture.wrapS = wrap;
  runtime.texture.wrapT = wrap;
  runtime.texture.repeat.set(effectiveRepeatU(state), state.repeatV);
  runtime.texture.center.set(0.5, 0.5);
  runtime.texture.rotation = THREE.MathUtils.degToRad(state.rotationDegrees);
  runtime.texture.offset.set(state.offsetU, state.offsetV);
  runtime.texture.needsUpdate = true;
}

function installTexture(runtime: Runtime, state: MaterialState) {
  runtime.texture?.dispose();
  runtime.texture = proceduralTexture(state);
  applyTextureMapping(runtime, state);
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
  }, [
    state.blendAmount,
    state.blendMode,
    state.pattern,
    state.primaryFrequency,
    state.secondaryFrequency,
    state.secondaryPattern,
  ]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    applyTextureMapping(runtime, state);
  }, [
    state.compensateStretch,
    state.offsetU,
    state.offsetV,
    state.repeatU,
    state.repeatV,
    state.rotationDegrees,
    state.shape,
    state.stretchX,
    state.wrap,
  ]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.mesh.scale.set(state.stretchX, 1, 1);
  }, [state.stretchX]);

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
    mesh.scale.set(state.stretchX, 1, 1);
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

  const hasTexture = state.pattern !== "none";
  const hasSecondLayer = hasTexture && state.secondaryPattern !== "none";
  const compensated = state.shape === "plane" && state.compensateStretch;

  return (
    <section className={styles.lab} aria-labelledby="material-lab-heading">
      <div className={styles.viewportPanel}>
        <div className={styles.headingRow}>
          <div>
            <p className="eyebrow">Texture authoring playground</p>
            <h2 id="material-lab-heading">Separate synthesis, mapping and sampling.</h2>
          </div>
          <p>Compose deterministic procedural pixels, then change how UVs map and how the sampler wraps them.</p>
        </div>
        <canvas ref={canvasRef} className={styles.canvas} aria-label="Interactive material and texture preview" />
        <div className={styles.mappingReadout} aria-live="polite">
          <strong>{hasTexture ? "Procedural texture active" : "Factor-only material"}</strong>
          <span>
            UV repeat {effectiveRepeatU(state).toFixed(1)} × {state.repeatV.toFixed(1)}
            {compensated ? " · U compensated for plane stretch" : ""}
          </span>
        </div>
        <div className={styles.shapePicker} aria-label="Preview geometry">
          {(["plane", "sphere", "cube", "torus"] as const).map((shape) => (
            <button
              key={shape}
              type="button"
              className={state.shape === shape ? styles.active : ""}
              onClick={() => patchState({ shape })}
              aria-pressed={state.shape === shape}
            >
              {shape === "plane" ? "UV plane" : shape === "torus" ? "Torus knot" : shape[0].toUpperCase() + shape.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <aside className={styles.controlsPanel}>
        <div className={styles.controlGroup}>
          <p className={styles.groupTitle}>PBR surface</p>
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
        </div>

        <div className={styles.controlGroup}>
          <p className={styles.groupTitle}>Procedural recipe</p>
          <label className={styles.selectControl}>
            <span>Layer A</span>
            <select value={state.pattern} onChange={(event) => patchState({ pattern: event.target.value as Pattern })}>
              {PATTERNS.map((pattern) => <option key={pattern} value={pattern}>{pattern}</option>)}
            </select>
          </label>
          <label className={styles.rangeControl}>
            <span>Layer A frequency <output>{state.primaryFrequency.toFixed(0)}</output></span>
            <input type="range" min="2" max="20" step="1" value={state.primaryFrequency} disabled={!hasTexture} onChange={(event) => patchState({ primaryFrequency: Number(event.target.value) })} />
          </label>
          <label className={styles.selectControl}>
            <span>Layer B</span>
            <select value={state.secondaryPattern} disabled={!hasTexture} onChange={(event) => patchState({ secondaryPattern: event.target.value as Pattern })}>
              {PATTERNS.map((pattern) => <option key={pattern} value={pattern}>{pattern}</option>)}
            </select>
          </label>
          <label className={styles.rangeControl}>
            <span>Layer B frequency <output>{state.secondaryFrequency.toFixed(0)}</output></span>
            <input type="range" min="2" max="20" step="1" value={state.secondaryFrequency} disabled={!hasSecondLayer} onChange={(event) => patchState({ secondaryFrequency: Number(event.target.value) })} />
          </label>
          <div className={styles.inlineGrid}>
            <label className={styles.selectControl}>
              <span>Blend</span>
              <select value={state.blendMode} disabled={!hasSecondLayer} onChange={(event) => patchState({ blendMode: event.target.value as TextureBlendMode })}>
                <option value="mix">Mix</option>
                <option value="multiply">Multiply</option>
                <option value="screen">Screen</option>
                <option value="difference">Difference</option>
              </select>
            </label>
            <label className={styles.rangeControl}>
              <span>Amount <output>{state.blendAmount.toFixed(2)}</output></span>
              <input type="range" min="0" max="1" step="0.05" value={state.blendAmount} disabled={!hasSecondLayer} onChange={(event) => patchState({ blendAmount: Number(event.target.value) })} />
            </label>
          </div>
        </div>

        <div className={styles.controlGroup}>
          <p className={styles.groupTitle}>UV mapping & stretching</p>
          <div className={styles.inlineGrid}>
            <label className={styles.rangeControl}>
              <span>Repeat U <output>{state.repeatU.toFixed(1)}×</output></span>
              <input type="range" min="0.5" max="8" step="0.5" value={state.repeatU} disabled={!hasTexture} onChange={(event) => patchState({ repeatU: Number(event.target.value) })} />
            </label>
            <label className={styles.rangeControl}>
              <span>Repeat V <output>{state.repeatV.toFixed(1)}×</output></span>
              <input type="range" min="0.5" max="8" step="0.5" value={state.repeatV} disabled={!hasTexture} onChange={(event) => patchState({ repeatV: Number(event.target.value) })} />
            </label>
          </div>
          <label className={styles.rangeControl}>
            <span>UV rotation <output>{state.rotationDegrees.toFixed(0)}°</output></span>
            <input type="range" min="-180" max="180" step="5" value={state.rotationDegrees} disabled={!hasTexture} onChange={(event) => patchState({ rotationDegrees: Number(event.target.value) })} />
          </label>
          <div className={styles.inlineGrid}>
            <label className={styles.rangeControl}>
              <span>Offset U <output>{state.offsetU.toFixed(2)}</output></span>
              <input type="range" min="-1" max="1" step="0.05" value={state.offsetU} disabled={!hasTexture} onChange={(event) => patchState({ offsetU: Number(event.target.value) })} />
            </label>
            <label className={styles.rangeControl}>
              <span>Offset V <output>{state.offsetV.toFixed(2)}</output></span>
              <input type="range" min="-1" max="1" step="0.05" value={state.offsetV} disabled={!hasTexture} onChange={(event) => patchState({ offsetV: Number(event.target.value) })} />
            </label>
          </div>
          <label className={styles.rangeControl}>
            <span>Object X stretch <output>{state.stretchX.toFixed(2)}×</output></span>
            <input type="range" min="0.5" max="3" step="0.1" value={state.stretchX} onChange={(event) => patchState({ stretchX: Number(event.target.value) })} />
          </label>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={state.compensateStretch}
              disabled={!hasTexture || state.shape !== "plane"}
              onChange={(event) => patchState({ compensateStretch: event.target.checked })}
            />
            Compensate U repeat for UV-plane X stretch
          </label>
          <p className={styles.helperText}>
            The compensation is exact only for the teaching plane. Arbitrary meshes need deliberate UV unwrapping/texel density or a projection method such as triplanar mapping.
          </p>
        </div>

        <div className={styles.controlGroup}>
          <p className={styles.groupTitle}>Sampler</p>
          <label className={styles.selectControl}>
            <span>Texture wrap</span>
            <select value={state.wrap} disabled={!hasTexture} onChange={(event) => patchState({ wrap: event.target.value as WrapMode })}>
              <option value="repeat">Repeat</option>
              <option value="mirror">Mirrored repeat</option>
              <option value="clamp">Clamp to edge</option>
            </select>
          </label>
          <label className={styles.toggle}>
            <input type="checkbox" checked={state.doubleSided} onChange={(event) => patchState({ doubleSided: event.target.checked })} />
            Double-sided material
          </label>
        </div>

        <button type="button" className={styles.resetButton} onClick={() => setState(DEFAULT_STATE)}>Reset texture lab</button>

        <div className={styles.boundary}>
          <strong>Authoring recipe → baked pixels → durable asset</strong>
          <p>
            Layering and procedural synthesis stay authoring-side. The portable asset keeps image/texture/sampler references plus UV-set and finite offset/scale/rotation intent; renderers only materialize that result.
          </p>
        </div>
      </aside>
    </section>
  );
}
