"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  sampleTeachingTerrain,
  solveTwoBoneIk,
  type GroundContactSample,
  type TerrainProfile,
  type Vec3Value,
} from "@/lib/procedural-animation";
import styles from "./procedural-animation-lab.module.css";

type LabState = {
  playing: boolean;
  procedural: boolean;
  footLock: boolean;
  showContacts: boolean;
  profile: TerrainProfile;
  speed: number;
};

type FootRuntime = {
  lock: GroundContactSample | null;
  wasStance: boolean;
};

type FootTarget = {
  target: Vec3Value;
  contact: GroundContactSample | null;
  stance: boolean;
  locked: boolean;
};

type FrameReadout = {
  pelvisDrop: number;
  leftReached: boolean;
  rightReached: boolean;
  lockedFeet: number;
};

type Runtime = {
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  resizeObserver: ResizeObserver;
  frameId: number;
  simulationTime: number;
  lastPathX: number;
  pelvisY: number;
  terrainGeometry: THREE.PlaneGeometry;
  terrainBaseXZ: Float32Array;
  leftFootState: FootRuntime;
  rightFootState: FootRuntime;
  torso: THREE.Mesh;
  hips: THREE.Mesh;
  head: THREE.Mesh;
  leftUpper: THREE.Mesh;
  leftLower: THREE.Mesh;
  rightUpper: THREE.Mesh;
  rightLower: THREE.Mesh;
  leftFoot: THREE.Mesh;
  rightFoot: THREE.Mesh;
  leftProbe: THREE.Line;
  rightProbe: THREE.Line;
  leftContact: THREE.Mesh;
  rightContact: THREE.Mesh;
};

const DEFAULT_STATE: LabState = {
  playing: true,
  procedural: true,
  footLock: true,
  showContacts: true,
  profile: "uneven",
  speed: 1,
};

const UPPER_LENGTH = 0.9;
const LOWER_LENGTH = 0.84;
const LEG_REACH = UPPER_LENGTH + LOWER_LENGTH - 0.015;
const FOOT_HEIGHT = 0.11;
const HIP_OFFSET_Z = 0.24;
const STANCE_PORTION = 0.58;
const STRIDE = 0.96;
const PATH_MIN = -4.35;
const PATH_MAX = 4.35;
const PATH_LENGTH = PATH_MAX - PATH_MIN;

function toThree(value: Vec3Value): THREE.Vector3 {
  return new THREE.Vector3(value.x, value.y, value.z);
}

function resetFootState(foot: FootRuntime) {
  foot.lock = null;
  foot.wasStance = false;
}

function phase01(value: number) {
  return ((value % 1) + 1) % 1;
}

function lerp(start: number, end: number, factor: number) {
  return start + (end - start) * factor;
}

function createSegment(material: THREE.Material, radius: number) {
  const geometry = new THREE.CylinderGeometry(radius, radius, 1, 14, 1);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  return mesh;
}

function setSegment(mesh: THREE.Mesh, start: Vec3Value, end: Vec3Value) {
  const startVector = toThree(start);
  const endVector = toThree(end);
  const direction = endVector.clone().sub(startVector);
  const distance = Math.max(direction.length(), 1e-5);
  mesh.position.copy(startVector).add(endVector).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.multiplyScalar(1 / distance),
  );
  mesh.scale.set(1, distance, 1);
}

function createProbe(material: THREE.LineBasicMaterial) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3));
  return new THREE.Line(geometry, material);
}

function setProbe(line: THREE.Line, start: Vec3Value, end: Vec3Value) {
  const attribute = line.geometry.getAttribute("position") as THREE.BufferAttribute;
  attribute.setXYZ(0, start.x, start.y, start.z);
  attribute.setXYZ(1, end.x, end.y, end.z);
  attribute.needsUpdate = true;
  line.geometry.computeBoundingSphere();
}

function disposeScene(scene: THREE.Scene) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Line)) return;
    geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    objectMaterials.forEach((material) => materials.add(material));
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

function updateTerrain(runtime: Runtime, profile: TerrainProfile) {
  const positions = runtime.terrainGeometry.getAttribute("position") as THREE.BufferAttribute;
  for (let index = 0; index < positions.count; index += 1) {
    const x = runtime.terrainBaseXZ[index * 2];
    const z = runtime.terrainBaseXZ[index * 2 + 1];
    positions.setY(index, sampleTeachingTerrain(profile, x, z).position.y);
  }
  positions.needsUpdate = true;
  runtime.terrainGeometry.computeVertexNormals();
  runtime.terrainGeometry.computeBoundingSphere();
}

function desiredFootTarget(
  rootX: number,
  basePelvisY: number,
  z: number,
  gaitPhase: number,
  state: LabState,
  runtime: FootRuntime,
): FootTarget {
  const phase = phase01(gaitPhase);
  const stance = phase < STANCE_PORTION;
  const authoredStanceOffset = STRIDE * (0.5 - phase / STANCE_PORTION);

  if (!state.procedural) {
    runtime.lock = null;
    runtime.wasStance = stance;
    if (stance) {
      return {
        target: { x: rootX + authoredStanceOffset, y: basePelvisY - 1.69, z },
        contact: null,
        stance,
        locked: false,
      };
    }

    const swing = (phase - STANCE_PORTION) / (1 - STANCE_PORTION);
    return {
      target: {
        x: rootX + lerp(-STRIDE * 0.5, STRIDE * 0.5, swing),
        y: basePelvisY - 1.69 + Math.sin(Math.PI * swing) * 0.44,
        z,
      },
      contact: null,
      stance,
      locked: false,
    };
  }

  if (stance) {
    const authoredX = rootX + authoredStanceOffset;
    if (!runtime.wasStance || runtime.lock === null) {
      runtime.lock = sampleTeachingTerrain(state.profile, authoredX, z);
    }

    const contact = state.footLock
      ? runtime.lock
      : sampleTeachingTerrain(state.profile, authoredX, z);
    runtime.wasStance = true;
    return {
      target: {
        x: contact.position.x,
        y: contact.position.y + FOOT_HEIGHT,
        z: contact.position.z,
      },
      contact,
      stance,
      locked: state.footLock,
    };
  }

  runtime.lock = null;
  runtime.wasStance = false;
  const swing = (phase - STANCE_PORTION) / (1 - STANCE_PORTION);
  const x = rootX + lerp(-STRIDE * 0.5, STRIDE * 0.5, swing);
  const contact = sampleTeachingTerrain(state.profile, x, z);
  return {
    target: {
      x,
      y: contact.position.y + FOOT_HEIGHT + Math.sin(Math.PI * swing) * 0.42,
      z,
    },
    contact,
    stance,
    locked: false,
  };
}

function pelvisLimit(rootX: number, hipZ: number, target: Vec3Value) {
  const horizontal = Math.hypot(target.x - rootX, target.z - hipZ);
  const vertical = Math.sqrt(Math.max(LEG_REACH * LEG_REACH - horizontal * horizontal, 0));
  return target.y + vertical;
}

function alignFoot(mesh: THREE.Mesh, target: Vec3Value, normal: Vec3Value) {
  mesh.position.set(target.x, target.y - FOOT_HEIGHT * 0.38, target.z);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    toThree(normal).normalize(),
  );
}

function applyFrame(
  runtime: Runtime,
  state: LabState,
  delta: number,
): FrameReadout {
  if (state.playing) runtime.simulationTime += delta * state.speed;

  const distance = runtime.simulationTime * 0.9;
  const rootX = PATH_MIN + (distance % PATH_LENGTH);
  if (rootX + 2 < runtime.lastPathX) {
    resetFootState(runtime.leftFootState);
    resetFootState(runtime.rightFootState);
  }
  runtime.lastPathX = rootX;

  const gait = phase01(runtime.simulationTime * 0.9);
  const baseGround = sampleTeachingTerrain(state.profile, rootX, 0);
  const basePelvisY = baseGround.position.y + 1.82;

  const leftTarget = desiredFootTarget(
    rootX,
    basePelvisY,
    HIP_OFFSET_Z,
    gait,
    state,
    runtime.leftFootState,
  );
  const rightTarget = desiredFootTarget(
    rootX,
    basePelvisY,
    -HIP_OFFSET_Z,
    gait + 0.5,
    state,
    runtime.rightFootState,
  );

  const targetPelvisY = state.procedural
    ? Math.min(
        basePelvisY,
        pelvisLimit(rootX, HIP_OFFSET_Z, leftTarget.target),
        pelvisLimit(rootX, -HIP_OFFSET_Z, rightTarget.target),
      )
    : basePelvisY;

  const smoothing = 1 - Math.exp(-delta * 11);
  runtime.pelvisY += (targetPelvisY - runtime.pelvisY) * smoothing;

  const leftHip = { x: rootX, y: runtime.pelvisY, z: HIP_OFFSET_Z };
  const rightHip = { x: rootX, y: runtime.pelvisY, z: -HIP_OFFSET_Z };
  const leftPole = { x: rootX + 0.72, y: runtime.pelvisY - 0.5, z: HIP_OFFSET_Z + 0.06 };
  const rightPole = { x: rootX + 0.72, y: runtime.pelvisY - 0.5, z: -HIP_OFFSET_Z - 0.06 };

  const leftSolution = solveTwoBoneIk({
    root: leftHip,
    target: leftTarget.target,
    pole: leftPole,
    upperLength: UPPER_LENGTH,
    lowerLength: LOWER_LENGTH,
  });
  const rightSolution = solveTwoBoneIk({
    root: rightHip,
    target: rightTarget.target,
    pole: rightPole,
    upperLength: UPPER_LENGTH,
    lowerLength: LOWER_LENGTH,
  });

  setSegment(runtime.leftUpper, leftSolution.root, leftSolution.knee);
  setSegment(runtime.leftLower, leftSolution.knee, leftSolution.end);
  setSegment(runtime.rightUpper, rightSolution.root, rightSolution.knee);
  setSegment(runtime.rightLower, rightSolution.knee, rightSolution.end);

  const up = { x: 0, y: 1, z: 0 };
  alignFoot(runtime.leftFoot, leftSolution.end, leftTarget.contact?.normal ?? up);
  alignFoot(runtime.rightFoot, rightSolution.end, rightTarget.contact?.normal ?? up);

  runtime.hips.position.set(rootX, runtime.pelvisY + 0.02, 0);
  runtime.torso.position.set(rootX, runtime.pelvisY + 0.73, 0);
  runtime.head.position.set(rootX, runtime.pelvisY + 1.52, 0);

  const leftContactPosition = leftTarget.contact?.position ?? {
    x: leftTarget.target.x,
    y: leftTarget.target.y - FOOT_HEIGHT,
    z: leftTarget.target.z,
  };
  const rightContactPosition = rightTarget.contact?.position ?? {
    x: rightTarget.target.x,
    y: rightTarget.target.y - FOOT_HEIGHT,
    z: rightTarget.target.z,
  };

  setProbe(
    runtime.leftProbe,
    { x: leftTarget.target.x, y: runtime.pelvisY + 0.25, z: leftTarget.target.z },
    leftContactPosition,
  );
  setProbe(
    runtime.rightProbe,
    { x: rightTarget.target.x, y: runtime.pelvisY + 0.25, z: rightTarget.target.z },
    rightContactPosition,
  );
  runtime.leftProbe.visible = state.showContacts && state.procedural;
  runtime.rightProbe.visible = state.showContacts && state.procedural;
  runtime.leftContact.visible = state.showContacts && state.procedural;
  runtime.rightContact.visible = state.showContacts && state.procedural;
  runtime.leftContact.position.set(
    leftContactPosition.x,
    leftContactPosition.y + 0.025,
    leftContactPosition.z,
  );
  runtime.rightContact.position.set(
    rightContactPosition.x,
    rightContactPosition.y + 0.025,
    rightContactPosition.z,
  );

  return {
    pelvisDrop: Math.max(basePelvisY - runtime.pelvisY, 0),
    leftReached: leftSolution.reachedTarget,
    rightReached: rightSolution.reachedTarget,
    lockedFeet: Number(leftTarget.locked && leftTarget.stance) + Number(rightTarget.locked && rightTarget.stance),
  };
}

export function ProceduralAnimationLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const stateRef = useRef<LabState>(DEFAULT_STATE);
  const [state, setState] = useState(DEFAULT_STATE);
  const [readout, setReadout] = useState<FrameReadout>({
    pelvisDrop: 0,
    leftReached: true,
    rightReached: true,
    lockedFeet: 0,
  });

  const patchState = (patch: Partial<LabState>) => {
    const previous = stateRef.current;
    const next = { ...previous, ...patch };
    stateRef.current = next;
    setState(next);

    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (next.profile !== previous.profile) updateTerrain(runtime, next.profile);
    if (
      next.profile !== previous.profile ||
      next.procedural !== previous.procedural ||
      next.footLock !== previous.footLock
    ) {
      resetFootState(runtime.leftFootState);
      resetFootState(runtime.rightFootState);
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1018);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 100);
    camera.position.set(6.6, 4.4, 7.1);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.target.set(0, 1.15, 0);
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.update();

    scene.add(new THREE.HemisphereLight(0xe4efff, 0x202838, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 3.3);
    key.position.set(4, 8, 5);
    key.castShadow = true;
    scene.add(key);

    const terrainGeometry = new THREE.PlaneGeometry(12, 6, 120, 32);
    terrainGeometry.rotateX(-Math.PI / 2);
    const terrainPositions = terrainGeometry.getAttribute("position") as THREE.BufferAttribute;
    const terrainBaseXZ = new Float32Array(terrainPositions.count * 2);
    for (let index = 0; index < terrainPositions.count; index += 1) {
      terrainBaseXZ[index * 2] = terrainPositions.getX(index);
      terrainBaseXZ[index * 2 + 1] = terrainPositions.getZ(index);
    }
    const terrainMaterial = new THREE.MeshStandardMaterial({
      color: 0x1b2635,
      roughness: 0.94,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    const terrain = new THREE.Mesh(terrainGeometry, terrainMaterial);
    terrain.receiveShadow = true;
    scene.add(terrain);
    const wire = new THREE.Mesh(
      terrainGeometry,
      new THREE.MeshBasicMaterial({
        color: 0x405168,
        wireframe: true,
        transparent: true,
        opacity: 0.22,
      }),
    );
    wire.position.y = 0.004;
    scene.add(wire);

    const limbMaterial = new THREE.MeshStandardMaterial({
      color: 0x7597c4,
      roughness: 0.55,
      metalness: 0.08,
    });
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0xb8c8dc,
      roughness: 0.64,
      metalness: 0.04,
    });
    const footMaterial = new THREE.MeshStandardMaterial({
      color: 0xe1a85e,
      roughness: 0.48,
      metalness: 0.06,
    });
    const contactMaterial = new THREE.MeshBasicMaterial({ color: 0x7ed39a });
    const probeMaterial = new THREE.LineBasicMaterial({
      color: 0x86a7d4,
      transparent: true,
      opacity: 0.9,
    });

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.31, 0.72, 6, 12), bodyMaterial);
    torso.castShadow = true;
    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.22, 0.68), limbMaterial);
    hips.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 20, 16), bodyMaterial);
    head.castShadow = true;
    const leftUpper = createSegment(limbMaterial, 0.145);
    const leftLower = createSegment(limbMaterial, 0.125);
    const rightUpper = createSegment(limbMaterial, 0.145);
    const rightLower = createSegment(limbMaterial, 0.125);
    const footGeometry = new THREE.BoxGeometry(0.52, FOOT_HEIGHT, 0.28);
    const leftFoot = new THREE.Mesh(footGeometry, footMaterial);
    const rightFoot = new THREE.Mesh(footGeometry, footMaterial);
    leftFoot.castShadow = true;
    rightFoot.castShadow = true;
    const leftProbe = createProbe(probeMaterial);
    const rightProbe = createProbe(probeMaterial);
    const contactGeometry = new THREE.CylinderGeometry(0.08, 0.08, 0.025, 18);
    const leftContact = new THREE.Mesh(contactGeometry, contactMaterial);
    const rightContact = new THREE.Mesh(contactGeometry, contactMaterial);

    scene.add(
      torso,
      hips,
      head,
      leftUpper,
      leftLower,
      rightUpper,
      rightLower,
      leftFoot,
      rightFoot,
      leftProbe,
      rightProbe,
      leftContact,
      rightContact,
    );

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

    const initialGround = sampleTeachingTerrain(stateRef.current.profile, PATH_MIN, 0);
    const runtime: Runtime = {
      renderer,
      controls,
      resizeObserver,
      frameId: 0,
      simulationTime: 0,
      lastPathX: PATH_MIN,
      pelvisY: initialGround.position.y + 1.82,
      terrainGeometry,
      terrainBaseXZ,
      leftFootState: { lock: null, wasStance: false },
      rightFootState: { lock: null, wasStance: false },
      torso,
      hips,
      head,
      leftUpper,
      leftLower,
      rightUpper,
      rightLower,
      leftFoot,
      rightFoot,
      leftProbe,
      rightProbe,
      leftContact,
      rightContact,
    };
    runtimeRef.current = runtime;
    updateTerrain(runtime, stateRef.current.profile);

    let previous = performance.now();
    let lastUiUpdate = previous;
    const render = (now: number) => {
      const delta = Math.min((now - previous) / 1000, 0.08);
      previous = now;
      const frameReadout = applyFrame(runtime, stateRef.current, delta);
      if (now - lastUiUpdate > 100) {
        lastUiUpdate = now;
        setReadout(frameReadout);
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
      disposeScene(scene);
      renderer.dispose();
      runtimeRef.current = null;
    };
  }, []);

  return (
    <section className={styles.lab} aria-labelledby="procedural-lab-heading">
      <div className={styles.workspace}>
        <div className={styles.viewportPanel}>
          <div className={styles.heading}>
            <div>
              <p className="eyebrow">Live correction stack</p>
              <h2 id="procedural-lab-heading">Authored gait → contact sample → IK → planted foot.</h2>
            </div>
            <p>
              Drag to orbit. The gait is deliberately simple so each procedural layer remains visible.
            </p>
          </div>
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            aria-label="Walking mannequin using procedural foot placement over uneven terrain"
          />
          <div className={styles.legend} aria-label="Viewport legend">
            <span><i className={styles.contactDot} /> sampled support contact</span>
            <span><i className={styles.probeDot} /> ground probe</span>
            <span><i className={styles.footDot} /> final foot pose</span>
          </div>
        </div>

        <aside className={styles.controlsPanel}>
          <div>
            <span className={styles.sectionLabel}>Terrain</span>
            <div className={styles.segmented} aria-label="Terrain profile">
              {(["slope", "stairs", "uneven"] as const).map((profile) => (
                <button
                  type="button"
                  key={profile}
                  className={state.profile === profile ? styles.active : ""}
                  aria-pressed={state.profile === profile}
                  onClick={() => patchState({ profile })}
                >
                  {profile[0].toUpperCase() + profile.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.switchList}>
            <label>
              <input
                type="checkbox"
                checked={state.procedural}
                onChange={(event) => patchState({ procedural: event.target.checked })}
              />
              <span>
                <strong>Procedural correction</strong>
                <small>Sample the support surface and solve both legs after the authored gait.</small>
              </span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={state.footLock}
                disabled={!state.procedural}
                onChange={(event) => patchState({ footLock: event.target.checked })}
              />
              <span>
                <strong>World-space foot lock</strong>
                <small>Keep a stance foot attached to the same support point while the pelvis moves past it.</small>
              </span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={state.showContacts}
                disabled={!state.procedural}
                onChange={(event) => patchState({ showContacts: event.target.checked })}
              />
              <span>
                <strong>Show contact evidence</strong>
                <small>Expose the sampled point and the presentation-only ground probe.</small>
              </span>
            </label>
          </div>

          <label className={styles.range}>
            <span>
              Playback speed
              <output>{state.speed.toFixed(1)}×</output>
            </span>
            <input
              type="range"
              min="0.4"
              max="1.6"
              step="0.1"
              value={state.speed}
              onChange={(event) => patchState({ speed: Number(event.target.value) })}
            />
          </label>

          <button
            type="button"
            className={styles.playButton}
            onClick={() => patchState({ playing: !state.playing })}
          >
            {state.playing ? "Pause walk" : "Resume walk"}
          </button>

          <dl className={styles.stats}>
            <div>
              <dt>Two-bone reach</dt>
              <dd>{readout.leftReached && readout.rightReached ? "inside limits" : "clamped"}</dd>
            </div>
            <div>
              <dt>Pelvis correction</dt>
              <dd>{(readout.pelvisDrop * 100).toFixed(1)} cm down</dd>
            </div>
            <div>
              <dt>World-locked feet</dt>
              <dd>{readout.lockedFeet} / 2</dd>
            </div>
          </dl>
        </aside>
      </div>

      <div className={styles.pipeline} aria-label="Procedural animation ownership pipeline">
        <div>
          <span>01</span>
          <strong>Authored pose</strong>
          <small>Animation remains the style and timing baseline.</small>
        </div>
        <div>
          <span>02</span>
          <strong>World contact</strong>
          <small>The demo supplies point + normal like a physics adapter would.</small>
        </div>
        <div>
          <span>03</span>
          <strong>Foot target</strong>
          <small>Plant metadata chooses whether the target stays world-locked.</small>
        </div>
        <div>
          <span>04</span>
          <strong>Analytical IK</strong>
          <small>Two segment lengths + pole vector produce the knee and ankle.</small>
        </div>
        <div>
          <span>05</span>
          <strong>Final pose</strong>
          <small>Feet align to the surface; gameplay/world authority stays elsewhere.</small>
        </div>
      </div>

      <div className={styles.explanationGrid}>
        <article>
          <p className="eyebrow">Why the feet stop skating</p>
          <h3>The target can stay fixed while the character keeps moving.</h3>
          <p>
            During the stance phase, the lab remembers the sampled support point in world space. The root
            advances, but the IK target does not. Disable only the foot lock to keep the feet on the ground
            while making the sliding immediately visible.
          </p>
        </article>
        <article>
          <p className="eyebrow">Authority boundary</p>
          <h3>Animation consumes contacts; it does not invent collision truth.</h3>
          <p>
            The teaching terrain is a stand-in contact provider. A game can replace it with
            <code> physics-engine </code> ray/shape queries without moving skeletal constraints, foot
            metadata or pose correction into the physics engine.
          </p>
        </article>
      </div>
    </section>
  );
}
