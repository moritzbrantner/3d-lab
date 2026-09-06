"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { sampleCharacterPose, type CharacterMotion } from "@/lib/character-rig";
import styles from "./character-rig-lab.module.css";

type Runtime = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  resizeObserver: ResizeObserver;
  frameId: number;
  model: THREE.Group;
  skeletonHelper: THREE.SkeletonHelper;
  skinMaterial: THREE.MeshStandardMaterial;
  accentMaterial: THREE.MeshStandardMaterial;
  bones: {
    hips: THREE.Bone;
    spine: THREE.Bone;
    chest: THREE.Bone;
    leftUpperArm: THREE.Bone;
    leftLowerArm: THREE.Bone;
    rightUpperArm: THREE.Bone;
    rightLowerArm: THREE.Bone;
    leftUpperLeg: THREE.Bone;
    leftLowerLeg: THREE.Bone;
    rightUpperLeg: THREE.Bone;
    rightLowerLeg: THREE.Bone;
  };
};

type RigState = {
  motion: CharacterMotion;
  playing: boolean;
  phase: number;
  speed: number;
  showSkeleton: boolean;
  transparentSkin: boolean;
};

const DEFAULT_STATE: RigState = {
  motion: "walk",
  playing: true,
  phase: 0.08,
  speed: 1,
  showSkeleton: true,
  transparentSkin: false,
};

function segment(material: THREE.Material, length: number, radius: number, direction: 1 | -1 = -1) {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, Math.max(length - radius * 2, 0.05), 5, 10), material);
  mesh.position.y = direction * length * 0.5;
  return mesh;
}

function joint(material: THREE.Material, radius = 0.1) {
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), material);
}

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

function buildCharacter(): Pick<Runtime, "model" | "skeletonHelper" | "skinMaterial" | "accentMaterial" | "bones"> {
  const model = new THREE.Group();
  model.position.y = 1.9;

  const skinMaterial = new THREE.MeshStandardMaterial({
    color: 0xb6c6db,
    roughness: 0.62,
    metalness: 0.05,
  });
  const accentMaterial = new THREE.MeshStandardMaterial({
    color: 0x6f8fb7,
    roughness: 0.5,
    metalness: 0.08,
  });
  const jointMaterial = new THREE.MeshStandardMaterial({
    color: 0xf0b969,
    roughness: 0.38,
    metalness: 0.12,
  });

  const hips = new THREE.Bone();
  hips.name = "Hips";
  const spine = new THREE.Bone();
  spine.name = "Spine";
  spine.position.y = 0.72;
  const chest = new THREE.Bone();
  chest.name = "Chest";
  chest.position.y = 0.72;
  const neck = new THREE.Bone();
  neck.name = "Neck";
  neck.position.y = 0.48;
  const head = new THREE.Bone();
  head.name = "Head";
  head.position.y = 0.3;
  hips.add(spine);
  spine.add(chest);
  chest.add(neck);
  neck.add(head);

  const leftUpperArm = new THREE.Bone();
  leftUpperArm.name = "LeftUpperArm";
  leftUpperArm.position.set(-0.62, 0.3, 0);
  const leftLowerArm = new THREE.Bone();
  leftLowerArm.name = "LeftLowerArm";
  leftLowerArm.position.y = -0.7;
  leftUpperArm.add(leftLowerArm);
  chest.add(leftUpperArm);

  const rightUpperArm = new THREE.Bone();
  rightUpperArm.name = "RightUpperArm";
  rightUpperArm.position.set(0.62, 0.3, 0);
  const rightLowerArm = new THREE.Bone();
  rightLowerArm.name = "RightLowerArm";
  rightLowerArm.position.y = -0.7;
  rightUpperArm.add(rightLowerArm);
  chest.add(rightUpperArm);

  const leftUpperLeg = new THREE.Bone();
  leftUpperLeg.name = "LeftUpperLeg";
  leftUpperLeg.position.set(-0.28, -0.1, 0);
  const leftLowerLeg = new THREE.Bone();
  leftLowerLeg.name = "LeftLowerLeg";
  leftLowerLeg.position.y = -0.9;
  leftUpperLeg.add(leftLowerLeg);
  hips.add(leftUpperLeg);

  const rightUpperLeg = new THREE.Bone();
  rightUpperLeg.name = "RightUpperLeg";
  rightUpperLeg.position.set(0.28, -0.1, 0);
  const rightLowerLeg = new THREE.Bone();
  rightLowerLeg.name = "RightLowerLeg";
  rightLowerLeg.position.y = -0.9;
  rightUpperLeg.add(rightLowerLeg);
  hips.add(rightUpperLeg);

  hips.add(joint(jointMaterial, 0.13));
  spine.add(segment(skinMaterial, 0.72, 0.25, 1), joint(jointMaterial));
  chest.add(segment(skinMaterial, 0.72, 0.31, 1), joint(jointMaterial));
  neck.add(segment(accentMaterial, 0.42, 0.1, 1), joint(jointMaterial, 0.08));
  head.add(new THREE.Mesh(new THREE.SphereGeometry(0.29, 24, 18), skinMaterial));
  (head.children[0] as THREE.Mesh).position.y = 0.24;

  leftUpperArm.add(segment(skinMaterial, 0.7, 0.13), joint(jointMaterial, 0.09));
  leftLowerArm.add(segment(skinMaterial, 0.62, 0.11), joint(jointMaterial, 0.08));
  rightUpperArm.add(segment(skinMaterial, 0.7, 0.13), joint(jointMaterial, 0.09));
  rightLowerArm.add(segment(skinMaterial, 0.62, 0.11), joint(jointMaterial, 0.08));

  leftUpperLeg.add(segment(accentMaterial, 0.9, 0.16), joint(jointMaterial, 0.1));
  leftLowerLeg.add(segment(accentMaterial, 0.84, 0.14), joint(jointMaterial, 0.09));
  rightUpperLeg.add(segment(accentMaterial, 0.9, 0.16), joint(jointMaterial, 0.1));
  rightLowerLeg.add(segment(accentMaterial, 0.84, 0.14), joint(jointMaterial, 0.09));

  const leftFoot = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.5), accentMaterial);
  leftFoot.position.set(0, -0.85, 0.13);
  leftLowerLeg.add(leftFoot);
  const rightFoot = leftFoot.clone();
  rightLowerLeg.add(rightFoot);

  model.add(hips);
  const skeletonHelper = new THREE.SkeletonHelper(hips);
  model.add(skeletonHelper);

  return {
    model,
    skeletonHelper,
    skinMaterial,
    accentMaterial,
    bones: {
      hips,
      spine,
      chest,
      leftUpperArm,
      leftLowerArm,
      rightUpperArm,
      rightLowerArm,
      leftUpperLeg,
      leftLowerLeg,
      rightUpperLeg,
      rightLowerLeg,
    },
  };
}

function applyPose(runtime: Runtime, state: RigState) {
  const pose = sampleCharacterPose(state.motion, state.phase);
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
  for (const material of [runtime.skinMaterial, runtime.accentMaterial]) {
    material.transparent = state.transparentSkin;
    material.opacity = state.transparentSkin ? 0.42 : 1;
    material.depthWrite = !state.transparentSkin;
  }
}

export function CharacterRigLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const stateRef = useRef<RigState>(DEFAULT_STATE);
  const [state, setState] = useState<RigState>(DEFAULT_STATE);

  const patchState = (patch: Partial<RigState>) => {
    const next = { ...stateRef.current, ...patch };
    stateRef.current = next;
    setState(next);
  };

  useEffect(() => {
    stateRef.current = state;
    const runtime = runtimeRef.current;
    if (runtime) applyPose(runtime, state);
  }, [state]);

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

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 12),
      new THREE.MeshStandardMaterial({ color: 0x1a2330, roughness: 0.92, metalness: 0 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    scene.add(new THREE.GridHelper(12, 24, 0x53627a, 0x263243));

    const character = buildCharacter();
    scene.add(character.model);

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
      scene,
      camera,
      controls,
      resizeObserver,
      frameId: 0,
      ...character,
    };
    runtimeRef.current = runtime;
    applyPose(runtime, stateRef.current);

    let previous = performance.now();
    let lastUiUpdate = previous;
    const render = (now: number) => {
      const delta = Math.min((now - previous) / 1000, 0.1);
      previous = now;
      const current = stateRef.current;
      if (current.playing) {
        const nextPhase = (current.phase + delta * current.speed * 0.42) % 1;
        stateRef.current = { ...current, phase: nextPhase };
        applyPose(runtime, stateRef.current);
        if (now - lastUiUpdate >= 100) {
          lastUiUpdate = now;
          setState(stateRef.current);
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
            <p className="eyebrow">Playable 3D rig</p>
            <h2 id="character-rig-heading">Orbit a character while the bone hierarchy drives the pose.</h2>
          </div>
          <p>Drag to orbit, zoom in on a joint, scrub the motion, or expose the skeleton through the model.</p>
        </div>
        <canvas ref={canvasRef} className={styles.canvas} aria-label="Interactive animated humanoid rig" />
      </div>

      <aside className={styles.controlsPanel}>
        <div>
          <span className={styles.sectionLabel}>Motion</span>
          <div className={styles.segmented} aria-label="Animation motion">
            {(["idle", "walk", "wave"] as const).map((motion) => (
              <button
                key={motion}
                type="button"
                className={state.motion === motion ? styles.active : ""}
                onClick={() => patchState({ motion, phase: 0 })}
                aria-pressed={state.motion === motion}
              >
                {motion[0].toUpperCase() + motion.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <label className={styles.rangeControl}>
          <span>Timeline <output>{Math.round(state.phase * 100)}%</output></span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.001"
            value={state.phase}
            onChange={(event) => patchState({ phase: Number(event.target.value), playing: false })}
          />
        </label>

        <label className={styles.rangeControl}>
          <span>Playback speed <output>{state.speed.toFixed(1)}×</output></span>
          <input
            type="range"
            min="0.25"
            max="2"
            step="0.05"
            value={state.speed}
            onChange={(event) => patchState({ speed: Number(event.target.value) })}
          />
        </label>

        <button type="button" className={styles.primaryButton} onClick={() => patchState({ playing: !state.playing })}>
          {state.playing ? "Pause motion" : "Play motion"}
        </button>

        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={state.showSkeleton}
            onChange={(event) => patchState({ showSkeleton: event.target.checked })}
          />
          Show bone hierarchy
        </label>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={state.transparentSkin}
            onChange={(event) => patchState({ transparentSkin: event.target.checked })}
          />
          See skeleton through model
        </label>

        <div className={styles.boundary}>
          <strong>What this view owns</strong>
          <p>
            The browser owns camera controls, playback and this teaching mesh. Joint hierarchy and pose semantics stay aligned with <code>three-d-animation</code>. The detailed lab below continues with bind matrices, weights and linear-blend skinning.
          </p>
        </div>
      </aside>
    </section>
  );
}
