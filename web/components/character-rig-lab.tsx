"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildCharacterModel } from "@/lib/character-model";
import {
  CHARACTER_CYCLE_SECONDS, createCharacterPose, sampleCharacterPoseInto,
  stepCharacterPhase, type CharacterMotion, type CharacterPose,
} from "@/lib/character-rig";
import styles from "./character-rig-lab.module.css";

type Runtime = ReturnType<typeof buildCharacterModel> & {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  resizeObserver: ResizeObserver;
  frameId: number;
  pose: CharacterPose;
  bindPose: CharacterPose;
};

type RigState = {
  motion: CharacterMotion;
  playing: boolean;
  phase: number;
  speed: number;
  showSkeleton: boolean;
  transparentSkin: boolean;
  bindPose: boolean;
};

const DEFAULT_STATE: RigState = {
  motion: "walk", playing: true, phase: 0.08, speed: 1,
  showSkeleton: true, transparentSkin: false, bindPose: false,
};

function disposeObject(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points)) return;
    geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    objectMaterials.forEach((material) => materials.add(material));
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

function applyPose(runtime: Runtime, state: RigState) {
  const pose = state.bindPose ? runtime.bindPose : sampleCharacterPoseInto(state.motion, state.phase, runtime.pose);
  runtime.model.position.x = pose.rootX;
  runtime.model.position.y = 1.9 + pose.rootY;
  runtime.bones.hips.rotation.y = pose.rootYaw;
  runtime.bones.spine.rotation.z = pose.spineZ;
  runtime.bones.leftUpperArm.rotation.x = pose.leftShoulderX;
  runtime.bones.rightUpperArm.rotation.x = pose.rightShoulderX;
  runtime.bones.rightUpperArm.rotation.z = pose.rightShoulderZ;
  runtime.bones.leftLowerArm.rotation.x = pose.leftElbowX;
  runtime.bones.rightLowerArm.rotation.x = pose.rightElbowX;
  runtime.bones.leftUpperLeg.rotation.x = pose.leftHipX;
  runtime.bones.rightUpperLeg.rotation.x = pose.rightHipX;
  runtime.bones.leftLowerLeg.rotation.x = pose.leftKneeX;
  runtime.bones.rightLowerLeg.rotation.x = pose.rightKneeX;
  runtime.skeletonHelper.visible = state.showSkeleton;
  runtime.mesh.boundingBox = null;
  runtime.mesh.boundingSphere = null;
  for (const material of runtime.materials) {
    if (material.transparent === state.transparentSkin) continue;
    material.transparent = state.transparentSkin;
    material.opacity = state.transparentSkin ? 0.42 : 1;
    material.depthWrite = !state.transparentSkin;
    material.needsUpdate = true;
  }
}

export function CharacterRigLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  // Runtime and React snapshots must not share a mutable object. React never
  // writes a delayed 10 Hz UI snapshot back into the animation clock.
  const stateRef = useRef<RigState>({ ...DEFAULT_STATE });
  const [state, setState] = useState<RigState>({ ...DEFAULT_STATE });

  const patchState = (patch: Partial<RigState>) => {
    const next = { ...stateRef.current, ...patch };
    stateRef.current = next;
    if (runtimeRef.current) applyPose(runtimeRef.current, next);
    setState({ ...next });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c111a);
    const camera = new THREE.PerspectiveCamera(44, 1, 0.05, 100);
    camera.position.set(4.8, 3.4, 6.4);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.target.set(0, 1.6, 0);
    controls.update();
    scene.add(new THREE.HemisphereLight(0xe6efff, 0x263044, 2.3));
    const key = new THREE.DirectionalLight(0xffffff, 3.4);
    key.position.set(4, 7, 5);
    key.castShadow = true;
    scene.add(key);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12),
      new THREE.MeshStandardMaterial({ color: 0x1a2330, roughness: 0.92, metalness: 0 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor, new THREE.GridHelper(12, 24, 0x53627a, 0x263243));
    const character = buildCharacterModel();
    scene.add(character.model, character.skeletonHelper);
    canvas.dataset.sourceDraws = String(character.sourceDraws);
    canvas.dataset.materialDraws = String(character.materialDraws);
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
    const runtime: Runtime = { renderer, scene, camera, controls, resizeObserver,
      frameId: 0, pose: createCharacterPose(), bindPose: createCharacterPose(), ...character };
    runtimeRef.current = runtime;
    applyPose(runtime, stateRef.current);
    let previous = performance.now();
    let lastUiUpdate = previous;
    const render = (now: number) => {
      const delta = Math.max(0, Math.min((now - previous) / 1000, 0.1));
      previous = now;
      const current = stateRef.current;
      if (current.playing && !current.bindPose) {
        current.phase = (current.phase + delta * current.speed / CHARACTER_CYCLE_SECONDS) % 1;
        applyPose(runtime, current);
        if (now - lastUiUpdate >= 100) {
          lastUiUpdate = now;
          setState({ ...current });
        }
      }
      controls.update();
      renderer.render(scene, camera);
      runtime.frameId = requestAnimationFrame(render);
    };
    runtime.frameId = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(runtime.frameId);
      resizeObserver.disconnect();
      controls.dispose();
      character.skeleton.dispose();
      disposeObject(scene);
      renderer.dispose();
      runtimeRef.current = null;
    };
  }, []);

  return (
    <section className={styles.lab} aria-labelledby="character-rig-heading">
      <div className={styles.viewportPanel}>
        <div className={styles.headingRow}>
          <div>
            <p className="eyebrow">GPU-skinned character</p>
            <h2 id="character-rig-heading">Inspect a complete articulated model, its bind pose and its animation.</h2>
          </div>
          <p>Drag to orbit, step by 1/60 second, enter an exact time, or expose the skeleton through the model.</p>
        </div>
        <canvas ref={canvasRef} className={styles.canvas} aria-label="Interactive animated humanoid rig" />
      </div>
      <aside className={styles.controlsPanel}>
        <div>
          <span className={styles.sectionLabel}>Motion</span>
          <div className={styles.segmented} aria-label="Animation motion">
            {(["idle", "walk", "wave"] as const).map((motion) => (
              <button key={motion} type="button" className={state.motion === motion ? styles.active : ""}
                onClick={() => patchState({ motion, phase: 0, bindPose: false })} aria-pressed={state.motion === motion}>
                {motion[0].toUpperCase() + motion.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <label className={styles.rangeControl}>
          <span>Timeline <output>{(state.phase * CHARACTER_CYCLE_SECONDS).toFixed(3)} s</output></span>
          <input type="range" min="0" max="1" step="0.001" value={state.phase}
            onChange={(event) => patchState({ phase: Number(event.target.value), playing: false, bindPose: false })} />
        </label>
        <label className={styles.rangeControl}>
          <span>Exact time (seconds)</span>
          <input type="number" min="0" max={CHARACTER_CYCLE_SECONDS} step="any"
            value={Number((state.phase * CHARACTER_CYCLE_SECONDS).toFixed(6))}
            onChange={(event) => {
              const value = event.target.valueAsNumber;
              if (Number.isFinite(value)) patchState({ phase: Math.min(1, Math.max(0, value / CHARACTER_CYCLE_SECONDS)), playing: false, bindPose: false });
            }} />
        </label>
        <div className={`${styles.segmented} ${styles.frameControls}`}>
          <button type="button" aria-label="Previous frame (1/60 second)" onClick={() => patchState({
            phase: stepCharacterPhase(stateRef.current.phase, -1), playing: false, bindPose: false,
          })}>Previous frame</button>
          <button type="button" aria-label="Next frame (1/60 second)" onClick={() => patchState({
            phase: stepCharacterPhase(stateRef.current.phase, 1), playing: false, bindPose: false,
          })}>Next frame</button>
        </div>
        <label className={styles.rangeControl}>
          <span>Playback speed <output>{state.speed.toFixed(2)}×</output></span>
          <input type="number" min="0.25" max="2" step="0.05" value={state.speed}
            onChange={(event) => {
              const value = event.target.valueAsNumber;
              if (Number.isFinite(value)) patchState({ speed: Math.min(2, Math.max(0.25, value)) });
            }} />
        </label>
        <button type="button" className={styles.primaryButton}
          onClick={() => patchState({ playing: !state.playing, bindPose: false })}>
          {state.playing ? "Pause motion" : "Play motion"}
        </button>
        <label className={styles.toggle}>
          <input type="checkbox" checked={state.bindPose}
            onChange={(event) => patchState({ bindPose: event.target.checked, playing: false })} />
          Show bind pose
        </label>
        <label className={styles.toggle}>
          <input type="checkbox" checked={state.showSkeleton}
            onChange={(event) => patchState({ showSkeleton: event.target.checked })} />
          Show bone hierarchy
        </label>
        <label className={styles.toggle}>
          <input type="checkbox" checked={state.transparentSkin}
            onChange={(event) => patchState({ transparentSkin: event.target.checked })} />
          See skeleton through model
        </label>
        <div className={styles.boundary}>
          <strong>Model and renderer boundaries</strong>
          <p>Thirteen joints drive one indexed skinned mesh with three material groups. These are rigid, single-joint attachments, not automatically generated smooth skin weights.</p>
          <p>The teaching model owns its shape and motions. The reusable renderer batches attachments; <code>three-d-animation</code> remains the reusable animation authority.</p>
        </div>
      </aside>
    </section>
  );
}
