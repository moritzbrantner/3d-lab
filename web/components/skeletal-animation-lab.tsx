"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  buildTeachingSkinningReadout,
  MODEL_ASSEMBLY,
  sampleTeachingPose,
  TEACHING_CLIP_DURATION,
  type ModelAssemblyId,
  type TeachingPose,
} from "@/lib/skeletal-animation";
import styles from "./skeletal-animation-lab.module.css";

type TopicId = "skeleton" | "bind-pose" | "weights" | "pipeline" | "assembly";

type LabState = {
  shoulder: number;
  elbow: number;
  wrist: number;
  middleWeight: number;
  time: number;
  playing: boolean;
  assembly: ModelAssemblyId;
};

type RigRuntime = {
  root: THREE.Group;
  update: (state: LabState, topic: TopicId) => void;
  dispose: () => void;
};

type Topic = {
  id: TopicId;
  number: string;
  title: string;
  summary: string;
  explanation: string;
  notice: string;
  formula: string;
};

const DEFAULT_STATE: LabState = {
  shoulder: 18,
  elbow: 52,
  wrist: -24,
  middleWeight: 0.65,
  time: 0.8,
  playing: false,
  assembly: "skin",
};

const TOPICS: readonly Topic[] = [
  {
    id: "skeleton",
    number: "01",
    title: "Skeleton = transform hierarchy",
    summary: "Bones are ordinary transforms arranged as parent and child joints.",
    explanation:
      "A skeleton is not a second mesh. It is a hierarchy of transforms. Each joint stores a local transform relative to its parent; multiplying down the chain produces the world transform used by the skinning stage. A shoulder therefore moves the elbow and wrist even when their own local values do not change.",
    notice:
      "Change only the shoulder and watch every downstream joint move. Then change the elbow: the wrist inherits both rotations.",
    formula: "M_world(child) = M_world(parent) × M_local(child)",
  },
  {
    id: "bind-pose",
    number: "02",
    title: "Bind pose & inverse bind matrices",
    summary: "The rig needs a remembered reference pose so animation is applied relative to the authored mesh.",
    explanation:
      "The bind pose is the pose in which the mesh was attached to the skeleton. For every joint, an inverse bind matrix maps a bind-space vertex into that joint's reference space. Multiplying the animated joint world matrix by the inverse bind matrix gives the joint's skin matrix. In the untouched bind pose, those two transforms cancel and the mesh stays where it was authored.",
    notice:
      "The dashed straight rig is the bind pose. The solid skeleton is the current animated pose; the skin matrices express the difference between them.",
    formula: "M_skin(joint) = M_world(joint) × M_inverseBind(joint)",
  },
  {
    id: "weights",
    number: "03",
    title: "Linear blend skinning",
    summary: "Each vertex blends several joint-transformed positions using normalized weights.",
    explanation:
      "The common real-time algorithm is linear blend skinning (LBS). A vertex stores joint indices and weights. Each referenced joint transforms the original bind-space position, and the weighted results are added. This makes vertices near a joint follow both bones instead of splitting the surface into rigid pieces.",
    notice:
      "Move the middle-joint weight from 0% to 100%. The selected vertex moves continuously between the root-only and middle-only transformed positions.",
    formula: "p′ = Σ wᵢ · M_skin(i) · p_bind",
  },
  {
    id: "pipeline",
    number: "04",
    title: "What happens every animation frame",
    summary: "A clip does not deform vertices directly; it updates local joint transforms first.",
    explanation:
      "At time t, animation tracks are sampled to produce local translation, rotation, and scale values. The joint hierarchy turns those locals into world matrices. Inverse bind matrices turn world matrices into a skinning palette. Finally, the vertex shader uses JOINTS and WEIGHTS attributes to deform every skinned vertex before projection and rasterization.",
    notice:
      "Scrub the clip and follow the pipeline below the viewport from sparse keyframes all the way to the final vertex positions.",
    formula: "clip time → local TRS → joint worlds → skin palette → skinned vertices",
  },
  {
    id: "assembly",
    number: "05",
    title: "How an animated model fits together",
    summary: "A model file connects mesh data, skin data, scene nodes, and animation tracks by references.",
    explanation:
      "In glTF, the mesh primitive owns geometry and skin attributes; a node instantiates that mesh and references a skin; the skin lists joint nodes and inverse bind matrices; animations target node TRS properties. The renderer resolves those references into the same runtime pipeline shown in the previous lessons.",
    notice:
      "Select each model part below. The important idea is ownership: geometry does not contain the animation clip, and a joint is still just a node in the scene hierarchy.",
    formula: "mesh + node + skin + joint hierarchy + animation = animated model instance",
  },
] as const;

const ROWS = [-1.5, -1.0, -0.45, 0.15, 0.7, 1.2, 1.5] as const;
const SELECTED_ROW = 3;

function setAttributeTuple(attribute: THREE.BufferAttribute, index: number, values: readonly number[]) {
  values.forEach((value, component) => attribute.setComponent(index, component, value));
}

function colorForInfluence(joints: readonly number[], weights: readonly number[]): THREE.Color {
  const jointColors = [
    new THREE.Color(0xe06a62),
    new THREE.Color(0x69b87a),
    new THREE.Color(0x6d8fe8),
  ];
  const result = new THREE.Color(0, 0, 0);
  joints.forEach((joint, index) => {
    if (weights[index] > 0) result.add(jointColors[joint].clone().multiplyScalar(weights[index]));
  });
  return result;
}

function createRig(initial: LabState): RigRuntime {
  const root = new THREE.Group();
  const geometry = new THREE.BufferGeometry();
  const positions: number[] = [];
  const indices: number[] = [];
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  const colors: number[] = [];

  const rowInfluences: readonly [readonly [number, number], readonly [number, number]][] = [
    [[0, 0], [1, 0]],
    [[0, 1], [0.82, 0.18]],
    [[0, 1], [0.68, 0.32]],
    [[0, 1], [1 - initial.middleWeight, initial.middleWeight]],
    [[1, 2], [0.72, 0.28]],
    [[1, 2], [0.25, 0.75]],
    [[2, 0], [1, 0]],
  ];

  ROWS.forEach((y, rowIndex) => {
    const [joints, weights] = rowInfluences[rowIndex];
    const color = colorForInfluence(joints, weights);
    [-0.32, 0.32].forEach((x) => {
      positions.push(x, y, 0);
      skinIndices.push(joints[0], joints[1], 0, 0);
      skinWeights.push(weights[0], weights[1], 0, 0);
      colors.push(color.r, color.g, color.b);
    });
  });

  for (let row = 0; row < ROWS.length - 1; row += 1) {
    const lowerLeft = row * 2;
    const lowerRight = lowerLeft + 1;
    const upperLeft = lowerLeft + 2;
    const upperRight = lowerLeft + 3;
    indices.push(lowerLeft, lowerRight, upperLeft, lowerRight, upperRight, upperLeft);
  }

  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeights, 4));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const rootBone = new THREE.Bone();
  rootBone.name = "Shoulder";
  rootBone.position.y = -1.5;
  const middleBone = new THREE.Bone();
  middleBone.name = "Elbow";
  middleBone.position.y = 1.5;
  const tipBone = new THREE.Bone();
  tipBone.name = "Wrist";
  tipBone.position.y = 1.5;
  rootBone.add(middleBone);
  middleBone.add(tipBone);

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.72,
    metalness: 0,
    side: THREE.DoubleSide,
    transparent: true,
  });
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.add(rootBone);
  const skeleton = new THREE.Skeleton([rootBone, middleBone, tipBone]);
  mesh.bind(skeleton);
  root.add(mesh);

  const helper = new THREE.SkeletonHelper(mesh);
  root.add(helper);

  const bindGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, -1.5, -0.02),
    new THREE.Vector3(0, 0, -0.02),
    new THREE.Vector3(0, 0, -0.02),
    new THREE.Vector3(0, 1.5, -0.02),
  ]);
  const bindMaterial = new THREE.LineDashedMaterial({ dashSize: 0.12, gapSize: 0.08, transparent: true, opacity: 0.7 });
  const bindGhost = new THREE.LineSegments(bindGeometry, bindMaterial);
  bindGhost.computeLineDistances();
  root.add(bindGhost);

  const markerGeometry = new THREE.SphereGeometry(0.085, 18, 12);
  const rootMarker = new THREE.Mesh(markerGeometry, new THREE.MeshBasicMaterial({ color: 0xe06a62 }));
  const middleMarker = new THREE.Mesh(markerGeometry, new THREE.MeshBasicMaterial({ color: 0x69b87a }));
  const blendMarker = new THREE.Mesh(markerGeometry, new THREE.MeshBasicMaterial({ color: 0xffffff }));
  root.add(rootMarker, middleMarker, blendMarker);

  const selectedWeightAttribute = geometry.getAttribute("skinWeight") as THREE.BufferAttribute;
  const colorAttribute = geometry.getAttribute("color") as THREE.BufferAttribute;

  const updateSelectedWeight = (weight: number) => {
    const clamped = THREE.MathUtils.clamp(weight, 0, 1);
    const influenceColor = colorForInfluence([0, 1], [1 - clamped, clamped]);
    for (const vertex of [SELECTED_ROW * 2, SELECTED_ROW * 2 + 1]) {
      setAttributeTuple(selectedWeightAttribute, vertex, [1 - clamped, clamped, 0, 0]);
      setAttributeTuple(colorAttribute, vertex, [influenceColor.r, influenceColor.g, influenceColor.b]);
    }
    selectedWeightAttribute.needsUpdate = true;
    colorAttribute.needsUpdate = true;
  };

  const update = (state: LabState, topic: TopicId) => {
    const clipDriven = topic === "pipeline" || (topic === "assembly" && state.assembly === "clip");
    const pose = clipDriven
      ? sampleTeachingPose(state.time)
      : { shoulder: state.shoulder, elbow: state.elbow, wrist: state.wrist };

    rootBone.rotation.z = THREE.MathUtils.degToRad(pose.shoulder);
    middleBone.rotation.z = THREE.MathUtils.degToRad(pose.elbow);
    tipBone.rotation.z = THREE.MathUtils.degToRad(pose.wrist);
    updateSelectedWeight(state.middleWeight);
    mesh.updateMatrixWorld(true);

    bindGhost.visible = topic === "bind-pose";
    helper.visible = topic !== "assembly" || state.assembly !== "mesh";
    material.opacity = topic === "skeleton" ? 0.24 : topic === "bind-pose" ? 0.58 : topic === "assembly" && state.assembly !== "mesh" ? 0.42 : 0.9;
    material.wireframe = topic === "assembly" && state.assembly === "mesh";

    const readout = buildTeachingSkinningReadout(pose, state.middleWeight);
    rootMarker.visible = topic === "weights";
    middleMarker.visible = topic === "weights";
    blendMarker.visible = topic === "weights";
    rootMarker.position.set(...readout.rootContribution);
    middleMarker.position.set(...readout.middleContribution);
    blendMarker.position.set(...readout.blendedPoint);
  };

  update(initial, "skeleton");

  return {
    root,
    update,
    dispose: () => {
      geometry.dispose();
      material.dispose();
      helper.geometry.dispose();
      const helperMaterials = Array.isArray(helper.material) ? helper.material : [helper.material];
      helperMaterials.forEach((helperMaterial) => helperMaterial.dispose());
      bindGeometry.dispose();
      bindMaterial.dispose();
      markerGeometry.dispose();
      [rootMarker, middleMarker, blendMarker].forEach((marker) => {
        (marker.material as THREE.Material).dispose();
      });
      skeleton.dispose();
    },
  };
}

function formatPoint(point: readonly [number, number, number]): string {
  return `(${point.map((value) => value.toFixed(2)).join(", ")})`;
}

export function SkeletalAnimationLab() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<RigRuntime | null>(null);
  const stateRef = useRef<LabState>(DEFAULT_STATE);
  const topicRef = useRef<TopicId>("skeleton");
  const [topicId, setTopicId] = useState<TopicId>("skeleton");
  const [state, setState] = useState<LabState>(DEFAULT_STATE);

  const topic = useMemo(() => TOPICS.find((entry) => entry.id === topicId) ?? TOPICS[0], [topicId]);
  const currentPose: TeachingPose = useMemo(
    () => (topicId === "pipeline" || (topicId === "assembly" && state.assembly === "clip")
      ? sampleTeachingPose(state.time)
      : { shoulder: state.shoulder, elbow: state.elbow, wrist: state.wrist }),
    [state.assembly, state.elbow, state.shoulder, state.time, state.wrist, topicId],
  );
  const readout = useMemo(
    () => buildTeachingSkinningReadout(currentPose, state.middleWeight),
    [currentPose, state.middleWeight],
  );
  const selectedAssembly = MODEL_ASSEMBLY.find((part) => part.id === state.assembly) ?? MODEL_ASSEMBLY[0];

  const patchState = (patch: Partial<LabState>) => setState((current) => ({ ...current, ...patch }));

  useEffect(() => {
    stateRef.current = state;
    runtimeRef.current?.update(state, topicId);
  }, [state, topicId]);

  useEffect(() => {
    topicRef.current = topicId;
  }, [topicId]);

  useEffect(() => {
    const shouldPlay = state.playing && (topicId === "pipeline" || (topicId === "assembly" && state.assembly === "clip"));
    if (!shouldPlay) return;

    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const delta = Math.min((now - previous) / 1000, 0.1);
      previous = now;
      setState((current) => ({ ...current, time: (current.time + delta) % TEACHING_CLIP_DURATION }));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [state.assembly, state.playing, topicId]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c111a);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    viewport.appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100);
    camera.position.set(3.5, 2.45, 4.5);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const light = new THREE.DirectionalLight(0xffffff, 3.2);
    light.position.set(3, 4, 3);
    scene.add(light);

    const grid = new THREE.GridHelper(7, 14);
    grid.position.y = -1.75;
    scene.add(grid);

    const runtime = createRig(stateRef.current);
    runtimeRef.current = runtime;
    runtime.update(stateRef.current, topicRef.current);
    scene.add(runtime.root);

    const resize = () => {
      const width = Math.max(viewport.clientWidth, 1);
      const height = Math.max(viewport.clientHeight, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);

    let frame = 0;
    const render = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      runtime.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      runtimeRef.current = null;
    };
  }, []);

  return (
    <section className={styles.lab} aria-label="Skeletal animation deep dive">
      <nav className={styles.topicNav} aria-label="Skeletal animation lessons">
        {TOPICS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={entry.id === topicId ? styles.topicActive : styles.topicButton}
            onClick={() => setTopicId(entry.id)}
          >
            <span>{entry.number}</span>
            <strong>{entry.title}</strong>
          </button>
        ))}
      </nav>

      <div className={styles.workspace}>
        <div className={styles.viewportPanel}>
          <div className={styles.heading}>
            <div>
              <p className="eyebrow">{topic.number} / skeletal animation</p>
              <h2>{topic.title}</h2>
            </div>
            <p>{topic.summary}</p>
          </div>
          <div ref={viewportRef} className={styles.viewport} aria-label={`Interactive 3D view for ${topic.title}`} />

          {(topicId === "skeleton" || topicId === "bind-pose" || topicId === "weights") && (
            <div className={styles.controls} aria-label="Joint pose controls">
              <label>
                Shoulder <output>{state.shoulder}°</output>
                <input type="range" min="-70" max="70" value={state.shoulder} onChange={(event) => patchState({ shoulder: Number(event.target.value) })} />
              </label>
              <label>
                Elbow <output>{state.elbow}°</output>
                <input type="range" min="-90" max="90" value={state.elbow} onChange={(event) => patchState({ elbow: Number(event.target.value) })} />
              </label>
              <label>
                Wrist <output>{state.wrist}°</output>
                <input type="range" min="-90" max="90" value={state.wrist} onChange={(event) => patchState({ wrist: Number(event.target.value) })} />
              </label>
            </div>
          )}

          {topicId === "weights" && (
            <div className={styles.weightControl}>
              <label>
                Selected vertex: middle-joint weight <output>{Math.round(state.middleWeight * 100)}%</output>
                <input type="range" min="0" max="1" step="0.01" value={state.middleWeight} onChange={(event) => patchState({ middleWeight: Number(event.target.value) })} />
              </label>
              <div className={styles.legend} aria-label="Skinning contribution markers">
                <span><i className={styles.rootDot} /> root-only result</span>
                <span><i className={styles.middleDot} /> middle-only result</span>
                <span><i className={styles.blendDot} /> weighted result</span>
              </div>
            </div>
          )}

          {topicId === "pipeline" && (
            <>
              <div className={styles.playbackControls}>
                <label>
                  Clip time <output>{state.time.toFixed(2)} s</output>
                  <input type="range" min="0" max={TEACHING_CLIP_DURATION} step="0.01" value={state.time} disabled={state.playing} onChange={(event) => patchState({ time: Number(event.target.value) })} />
                </label>
                <button type="button" onClick={() => patchState({ playing: !state.playing })}>
                  {state.playing ? "Pause clip" : "Play clip"}
                </button>
              </div>
              <div className={styles.pipeline} aria-label="Per-frame animation pipeline">
                <div><span>1</span><strong>Sample clip</strong><small>{state.time.toFixed(2)} s</small></div>
                <div><span>2</span><strong>Local TRS</strong><small>S {currentPose.shoulder.toFixed(0)}° · E {currentPose.elbow.toFixed(0)}°</small></div>
                <div><span>3</span><strong>World joints</strong><small>parent × local</small></div>
                <div><span>4</span><strong>Skin palette</strong><small>3 matrices</small></div>
                <div><span>5</span><strong>Vertex shader</strong><small>JOINTS + WEIGHTS</small></div>
              </div>
            </>
          )}

          {topicId === "assembly" && (
            <>
              <div className={styles.assemblyGraph} aria-label="glTF animated model parts">
                {MODEL_ASSEMBLY.map((part) => (
                  <button
                    key={part.id}
                    type="button"
                    className={part.id === state.assembly ? styles.assemblyActive : styles.assemblyPart}
                    onClick={() => patchState({ assembly: part.id })}
                  >
                    <strong>{part.label}</strong>
                    <span>{part.detail}</span>
                  </button>
                ))}
              </div>
              {state.assembly === "clip" && (
                <div className={styles.playbackControls}>
                  <label>
                    Animation time <output>{state.time.toFixed(2)} s</output>
                    <input type="range" min="0" max={TEACHING_CLIP_DURATION} step="0.01" value={state.time} disabled={state.playing} onChange={(event) => patchState({ time: Number(event.target.value) })} />
                  </label>
                  <button type="button" onClick={() => patchState({ playing: !state.playing })}>
                    {state.playing ? "Pause" : "Play"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <aside className={styles.copy}>
          <section>
            <p className="eyebrow">Concept</p>
            <p className={styles.explanation}>{topic.explanation}</p>
          </section>
          <section className={styles.formula}>
            <span>Core relation</span>
            <code>{topic.formula}</code>
          </section>
          <section className={styles.notice}>
            <strong>What to notice</strong>
            <p>{topic.notice}</p>
          </section>

          {topicId === "skeleton" && (
            <section>
              <p className="eyebrow">Current pose</p>
              <dl className={styles.stats}>
                <div><dt>shoulder local</dt><dd>{currentPose.shoulder.toFixed(0)}°</dd></div>
                <div><dt>elbow local</dt><dd>{currentPose.elbow.toFixed(0)}°</dd></div>
                <div><dt>wrist world origin</dt><dd>{formatPoint(readout.jointOrigins[2])}</dd></div>
              </dl>
            </section>
          )}

          {topicId === "bind-pose" && (
            <section>
              <p className="eyebrow">Why inverse bind?</p>
              <dl className={styles.stats}>
                <div><dt>mesh authored in</dt><dd>bind space</dd></div>
                <div><dt>joint reference</dt><dd>inverse bind</dd></div>
                <div><dt>rest result</dt><dd>identity deformation</dd></div>
              </dl>
            </section>
          )}

          {topicId === "weights" && (
            <section>
              <p className="eyebrow">Selected vertex inspector</p>
              <dl className={styles.stats}>
                <div><dt>bind position</dt><dd>{formatPoint(readout.bindPoint)}</dd></div>
                <div><dt>root weight</dt><dd>{(readout.weights[0] * 100).toFixed(0)}%</dd></div>
                <div><dt>middle weight</dt><dd>{(readout.weights[1] * 100).toFixed(0)}%</dd></div>
                <div><dt>root result</dt><dd>{formatPoint(readout.rootContribution)}</dd></div>
                <div><dt>middle result</dt><dd>{formatPoint(readout.middleContribution)}</dd></div>
                <div><dt>blended result</dt><dd>{formatPoint(readout.blendedPoint)}</dd></div>
              </dl>
            </section>
          )}

          {topicId === "pipeline" && (
            <section>
              <p className="eyebrow">Important boundary</p>
              <p className={styles.secondaryCopy}>
                Animation sampling produces a pose. Hierarchy evaluation produces joint worlds. Skinning consumes those matrices. Rendering only sees the resulting vertex positions plus the rest of the mesh attributes.
              </p>
            </section>
          )}

          {topicId === "assembly" && (
            <section>
              <p className="eyebrow">Selected model part</p>
              <strong className={styles.selectedPart}>{selectedAssembly.label}</strong>
              <p className={styles.secondaryCopy}>{selectedAssembly.detail}</p>
              <p className={styles.secondaryCopy}>
                glTF connects these pieces by indices and accessors; the loader resolves them into runtime objects such as BufferGeometry, SkinnedMesh, Skeleton, Bone, and AnimationClip.
              </p>
            </section>
          )}
        </aside>
      </div>
    </section>
  );
}
