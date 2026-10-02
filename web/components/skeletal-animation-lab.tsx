"use client";

import { PrecisionRange } from "./PrecisionRange";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
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
import {
  advanceClipClock,
  createClipClock,
  prepareClipPlayback,
  setClipClockTime,
} from "@/lib/skeletal-animation-clock";
import {
  EDITABLE_WEIGHT_ROW,
  FULL_PLAYBACK_RANGE,
  jointCssColor,
  pickNearestScreenPoint,
  TEACHING_CLIP_FPS,
  TEACHING_JOINTS,
  teachingVertices,
  vertexWeightColor,
  type PlaybackRangeState,
  type ScreenPoint,
  type WeightMode,
} from "@/lib/skeletal-animation-inspection";
import { InspectPlaybackControls, SkeletalInspector } from "./skeletal-animation-inspector";
import styles from "./skeletal-animation-lab.module.css";

type TopicId = "skeleton" | "bind-pose" | "weights" | "pipeline" | "assembly" | "inspect";

type LabState = {
  shoulder: number;
  elbow: number;
  wrist: number;
  middleWeight: number;
  time: number;
  playing: boolean;
  assembly: ModelAssemblyId;
  // Inspection selection and view options. The rig, clip and weights stay the single source of truth.
  selectedJoint: number;
  selectedVertex: number;
  weightMode: WeightMode;
  range: PlaybackRangeState;
  loop: boolean;
};

type RigRuntime = {
  root: THREE.Group;
  update: (state: LabState, topic: TopicId) => void;
  /** Pickable joints and vertices projected to canvas CSS pixels. */
  screenPoints: (camera: THREE.Camera, width: number, height: number) => ScreenPoint[];
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
  selectedJoint: 1,
  selectedVertex: EDITABLE_WEIGHT_ROW * 2,
  weightMode: "joints",
  range: FULL_PLAYBACK_RANGE,
  loop: true,
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
  {
    id: "inspect",
    number: "06",
    title: "Inspect rig, clip & weights",
    summary: "Pick joints and vertices in the viewport; read exact transforms, clip timing and skin weights.",
    explanation: "",
    notice: "",
    formula: "",
  },
] as const;

function isClipDriven(topic: TopicId, assembly: ModelAssemblyId): boolean {
  return topic === "pipeline" || topic === "inspect" || (topic === "assembly" && assembly === "clip");
}

function setAttributeTuple(attribute: THREE.BufferAttribute, index: number, values: readonly number[]) {
  values.forEach((value, component) => attribute.setComponent(index, component, value));
}

function createRig(initial: LabState): RigRuntime {
  const root = new THREE.Group();
  const geometry = new THREE.BufferGeometry();
  const positions: number[] = [];
  const indices: number[] = [];
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  const colors: number[] = [];

  const vertices = teachingVertices(initial.middleWeight);
  vertices.forEach((vertex) => {
    const color = vertexWeightColor("joints", vertex, initial.selectedJoint);
    positions.push(...vertex.position);
    skinIndices.push(vertex.joints[0], vertex.joints[1], 0, 0);
    skinWeights.push(vertex.weights[0], vertex.weights[1], 0, 0);
    colors.push(...color);
  });

  for (let row = 0; row < vertices.length / 2 - 1; row += 1) {
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

  const bones = TEACHING_JOINTS.map((joint) => {
    const bone = new THREE.Bone();
    bone.name = joint.name;
    bone.position.set(...joint.restPosition);
    return bone;
  });
  TEACHING_JOINTS.forEach((joint) => {
    if (joint.parent >= 0) bones[joint.parent].add(bones[joint.index]);
  });
  const [rootBone, middleBone, tipBone] = bones;

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.72,
    metalness: 0,
    side: THREE.DoubleSide,
    transparent: true,
  });
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.add(rootBone);
  const skeleton = new THREE.Skeleton(bones);
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

  // Inspection overlays live in the scene: joint handles, the selected bone and vertex handles.
  const jointGeometry = new THREE.SphereGeometry(0.07, 16, 10);
  const jointHandles = bones.map((_, joint) => {
    const handle = new THREE.Mesh(jointGeometry, new THREE.MeshBasicMaterial({
      color: new THREE.Color(jointCssColor(joint)), depthTest: false, transparent: true,
    }));
    handle.renderOrder = 10;
    handle.name = `joint-handle-${joint}`;
    root.add(handle);
    return handle;
  });
  const highlightMaterial = new THREE.MeshBasicMaterial({ color: 0xffc247, depthTest: false, transparent: true, opacity: 0.95 });
  const boneGeometry = new THREE.CylinderGeometry(0.045, 0.045, 1, 12);
  const boneHighlight = new THREE.Mesh(boneGeometry, highlightMaterial);
  boneHighlight.renderOrder = 9;
  const selectionRing = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.022, 10, 32), highlightMaterial);
  selectionRing.renderOrder = 11;
  root.add(boneHighlight, selectionRing);
  const vertexPointGeometry = new THREE.BufferGeometry();
  vertexPointGeometry.setAttribute("position", new THREE.Float32BufferAttribute(new Array(vertices.length * 3).fill(0), 3));
  const vertexPointMaterial = new THREE.PointsMaterial({
    color: 0xffffff, size: 7, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.85,
  });
  const vertexPoints = new THREE.Points(vertexPointGeometry, vertexPointMaterial);
  vertexPoints.renderOrder = 8;
  vertexPoints.frustumCulled = false;
  const selectedVertexMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
  const selectedVertexMarker = new THREE.Mesh(new THREE.SphereGeometry(0.06, 14, 10), selectedVertexMaterial);
  selectedVertexMarker.renderOrder = 12;
  root.add(vertexPoints, selectedVertexMarker);
  const skinnedVertexPosition = new THREE.Vector3();
  const vertexWorld = (index: number, target: THREE.Vector3) => {
    mesh.getVertexPosition(index, target);
    return mesh.localToWorld(target);
  };
  const jointWorld = (joint: number, target: THREE.Vector3) => bones[joint].getWorldPosition(target);

  const selectedWeightAttribute = geometry.getAttribute("skinWeight") as THREE.BufferAttribute;
  const colorAttribute = geometry.getAttribute("color") as THREE.BufferAttribute;

  const updateVertexAttributes = (state: LabState, topic: TopicId) => {
    const mode = topic === "inspect" ? state.weightMode : "joints";
    teachingVertices(state.middleWeight).forEach((vertex) => {
      const color = vertexWeightColor(mode, vertex, state.selectedJoint);
      setAttributeTuple(selectedWeightAttribute, vertex.index, [vertex.weights[0], vertex.weights[1], 0, 0]);
      setAttributeTuple(colorAttribute, vertex.index, color);
    });
    selectedWeightAttribute.needsUpdate = true;
    colorAttribute.needsUpdate = true;
  };

  const from = new THREE.Vector3();
  const to = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  const update = (state: LabState, topic: TopicId) => {
    const clipDriven = isClipDriven(topic, state.assembly);
    const pose = clipDriven
      ? sampleTeachingPose(state.time)
      : { shoulder: state.shoulder, elbow: state.elbow, wrist: state.wrist };

    rootBone.rotation.z = THREE.MathUtils.degToRad(pose.shoulder);
    middleBone.rotation.z = THREE.MathUtils.degToRad(pose.elbow);
    tipBone.rotation.z = THREE.MathUtils.degToRad(pose.wrist);
    updateVertexAttributes(state, topic);
    mesh.updateMatrixWorld(true);

    bindGhost.visible = topic === "bind-pose";
    helper.visible = topic !== "assembly" || state.assembly !== "mesh";
    material.opacity = topic === "inspect" ? 0.55 : topic === "skeleton" ? 0.24 : topic === "bind-pose" ? 0.58 : topic === "assembly" && state.assembly !== "mesh" ? 0.42 : 0.9;
    material.wireframe = topic === "assembly" && state.assembly === "mesh";

    const readout = buildTeachingSkinningReadout(pose, state.middleWeight);
    rootMarker.visible = topic === "weights";
    middleMarker.visible = topic === "weights";
    blendMarker.visible = topic === "weights";
    rootMarker.position.set(...readout.rootContribution);
    middleMarker.position.set(...readout.middleContribution);
    blendMarker.position.set(...readout.blendedPoint);

    const inspecting = topic === "inspect";
    jointHandles.forEach((handle, joint) => {
      handle.visible = inspecting;
      jointWorld(joint, handle.position);
      const selected = joint === state.selectedJoint;
      handle.scale.setScalar(selected ? 1.5 : 1);
      (handle.material as THREE.MeshBasicMaterial).color.set(selected ? 0xffc247 : jointCssColor(joint));
    });
    selectionRing.visible = inspecting;
    selectionRing.position.copy(jointHandles[state.selectedJoint].position);
    boneHighlight.visible = inspecting && TEACHING_JOINTS[state.selectedJoint].parent >= 0;
    if (boneHighlight.visible) {
      jointWorld(TEACHING_JOINTS[state.selectedJoint].parent, from);
      jointWorld(state.selectedJoint, to);
      boneHighlight.position.copy(from).add(to).multiplyScalar(0.5);
      boneHighlight.scale.set(1, Math.max(from.distanceTo(to), 1e-6), 1);
      boneHighlight.quaternion.setFromUnitVectors(up, to.sub(from).normalize());
    }
    vertexPoints.visible = inspecting;
    selectedVertexMarker.visible = inspecting;
    if (inspecting) {
      const pointAttribute = vertexPointGeometry.getAttribute("position") as THREE.BufferAttribute;
      vertices.forEach((vertex) => {
        vertexWorld(vertex.index, skinnedVertexPosition);
        pointAttribute.setXYZ(vertex.index, skinnedVertexPosition.x, skinnedVertexPosition.y, skinnedVertexPosition.z);
      });
      pointAttribute.needsUpdate = true;
      vertexWorld(state.selectedVertex, selectedVertexMarker.position);
    }
  };

  const projected = new THREE.Vector3();
  const screenPoints = (camera: THREE.Camera, width: number, height: number): ScreenPoint[] => {
    const project = (position: THREE.Vector3) => {
      projected.copy(position).project(camera);
      return { x: ((projected.x + 1) / 2) * width, y: ((1 - projected.y) / 2) * height };
    };
    return [
      ...bones.map((_, joint) => ({ kind: "joint" as const, id: joint, ...project(jointWorld(joint, from)) })),
      ...vertices.map((vertex) => ({ kind: "vertex" as const, id: vertex.index, ...project(vertexWorld(vertex.index, to)) })),
    ];
  };

  update(initial, "skeleton");

  return {
    root,
    update,
    screenPoints,
    dispose: () => {
      jointGeometry.dispose();
      jointHandles.forEach((handle) => (handle.material as THREE.Material).dispose());
      highlightMaterial.dispose();
      boneGeometry.dispose();
      selectionRing.geometry.dispose();
      vertexPointGeometry.dispose();
      vertexPointMaterial.dispose();
      selectedVertexMarker.geometry.dispose();
      selectedVertexMaterial.dispose();
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
  // Renderer-owned clip clock: advanced by the Three.js frame loop, published to React at UI cadence.
  const clockRef = useRef(createClipClock(DEFAULT_STATE.time));
  const playingRef = useRef(false);
  const [topicId, setTopicId] = useState<TopicId>("skeleton");
  const [state, setState] = useState<LabState>(DEFAULT_STATE);

  const stepFrame = (direction: number) => {
    if (state.playing) return;
    scrubClip(Math.round((clockRef.current.time * TEACHING_CLIP_FPS) + direction) / TEACHING_CLIP_FPS);
  };
  const onViewportKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (topicId !== "inspect") return;
    if (event.key === " ") {
      event.preventDefault();
      togglePlaying();
    } else if (event.key === "," || event.key === ".") {
      event.preventDefault();
      stepFrame(event.key === "," ? -1 : 1);
    }
  };

  const topic = useMemo(() => TOPICS.find((entry) => entry.id === topicId) ?? TOPICS[0], [topicId]);
  const currentPose: TeachingPose = useMemo(
    () => (isClipDriven(topicId, state.assembly)
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
  const scrubClip = (time: number) => {
    setClipClockTime(clockRef.current, time);
    patchState({ time: clockRef.current.time });
  };
  const togglePlaying = () => {
    // Pausing publishes the renderer clock exactly so the readout and scrubber match the rig.
    if (state.playing) patchState({ playing: false, time: clockRef.current.time });
    else {
      // A time outside the range, or the end of a play-once clip, restarts at the range start.
      prepareClipPlayback(clockRef.current, { range: state.range, loop: state.loop });
      patchState({ playing: true, time: clockRef.current.time });
    }
  };

  useEffect(() => {
    stateRef.current = state;
    runtimeRef.current?.update({ ...state, time: clockRef.current.time }, topicId);
  }, [state, topicId]);

  useEffect(() => {
    topicRef.current = topicId;
  }, [topicId]);

  const shouldPlay = state.playing && isClipDriven(topicId, state.assembly);
  useEffect(() => {
    playingRef.current = shouldPlay;
    if (shouldPlay) return;
    // Playback stopped (pause or topic/assembly change): publish the exact renderer time once.
    const finalTime = clockRef.current.time;
    setClipClockTime(clockRef.current, finalTime);
    setState((current) => (current.time === finalTime ? current : { ...current, time: finalTime }));
  }, [shouldPlay]);

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
    runtime.update({ ...stateRef.current, time: clockRef.current.time }, topicRef.current);
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
    let previousFrame: number | null = null;
    const render = (now: number) => {
      if (playingRef.current) {
        const clock = clockRef.current;
        const { range, loop } = stateRef.current;
        const publish = advanceClipClock(clock, previousFrame === null ? 0 : (now - previousFrame) / 1000, { range, loop });
        previousFrame = now;
        runtime.update({ ...stateRef.current, time: clock.time }, topicRef.current);
        if (clock.finished) {
          // A play-once clip reached the end of its range: stop and publish the exact end time.
          const endTime = clock.time;
          setState((current) => ({ ...current, time: endTime, playing: false }));
        } else if (publish) {
          const publishedTime = clock.time;
          setState((current) => ({ ...current, time: publishedTime }));
        }
      } else {
        previousFrame = null;
      }
      controls.update();
      if (topicRef.current === "inspect") {
        // Pickable screen positions let browser evidence click real joints; written only when they change.
        const points = runtime.screenPoints(camera, viewport.clientWidth, viewport.clientHeight);
        const encoded = JSON.stringify(points.map((point) => [point.kind[0], point.id, Math.round(point.x), Math.round(point.y)]));
        if (renderer.domElement.dataset.pickPoints !== encoded) renderer.domElement.dataset.pickPoints = encoded;
      }
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);

    // The canvas owns picking: a click without a drag selects the nearest joint or vertex.
    const canvas = renderer.domElement;
    let pressed: { x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      pressed = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    };
    const onPointerUp = (event: PointerEvent) => {
      const start = pressed;
      pressed = null;
      if (!start || topicRef.current !== "inspect" || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
      const rect = canvas.getBoundingClientRect();
      const hit = pickNearestScreenPoint(
        runtime.screenPoints(camera, rect.width, rect.height),
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
      );
      if (!hit) return;
      setState((current) => hit.kind === "joint"
        ? { ...current, selectedJoint: hit.id }
        : { ...current, selectedVertex: hit.id });
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
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
          <div ref={viewportRef} className={styles.viewport} aria-label={`Interactive 3D view for ${topic.title}`}
            role="group" tabIndex={topicId === "inspect" ? 0 : undefined}
            aria-describedby={topicId === "inspect" ? "inspect-viewport-hint" : undefined}
            data-selected-joint={topicId === "inspect" ? state.selectedJoint : undefined}
            onKeyDown={onViewportKeyDown} />
          {topicId === "inspect" && (
            <>
              <p id="inspect-viewport-hint" className={styles.hint}>
                Click a joint or vertex to select it, drag to orbit. With the viewport focused: Space plays or pauses, comma and period step one frame.
              </p>
              <InspectPlaybackControls time={state.time} playing={state.playing} loop={state.loop} range={state.range}
                onToggle={togglePlaying} onScrub={scrubClip}
                onLoop={(loop) => patchState({ loop })}
                onRange={(range) => patchState({ range })} />
            </>
          )}

          {(topicId === "skeleton" || topicId === "bind-pose" || topicId === "weights") && (
            <div className={styles.controls} aria-label="Joint pose controls">
              <PrecisionRange label="Shoulder" value={state.shoulder} min={-70} max={70} unit="°"
                onChange={(shoulder) => patchState({ shoulder })} />
              <PrecisionRange label="Elbow" value={state.elbow} min={-90} max={90} unit="°"
                onChange={(elbow) => patchState({ elbow })} />
              <PrecisionRange label="Wrist" value={state.wrist} min={-90} max={90} unit="°"
                onChange={(wrist) => patchState({ wrist })} />
            </div>
          )}

          {topicId === "weights" && (
            <div className={styles.weightControl}>
              <PrecisionRange label="Selected vertex: middle-joint weight"
                value={state.middleWeight * 100} min={0} max={100} step={1} unit="%"
                onChange={(percent) => patchState({ middleWeight: percent / 100 })} />
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
                <PrecisionRange label="Clip time" value={state.time} min={0}
                  max={TEACHING_CLIP_DURATION} step={0.01} unit="s" disabled={state.playing}
                  onChange={scrubClip} />
                <button type="button" onClick={togglePlaying}>
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
                  <PrecisionRange label="Animation time" value={state.time} min={0}
                    max={TEACHING_CLIP_DURATION} step={0.01} unit="s" disabled={state.playing}
                    onChange={scrubClip} />
                  <button type="button" onClick={togglePlaying}>
                    {state.playing ? "Pause" : "Play"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <aside className={styles.copy} aria-label={topicId === "inspect" ? "Inspector" : "Lesson notes"}>
          {topicId === "inspect" ? (
            <SkeletalInspector pose={currentPose} time={state.time} loop={state.loop} range={state.range}
              selectedJoint={state.selectedJoint} selectedVertex={state.selectedVertex}
              weightMode={state.weightMode} middleWeight={state.middleWeight}
              onSelectJoint={(selectedJoint) => patchState({ selectedJoint })}
              onSelectVertex={(selectedVertex) => patchState({ selectedVertex })}
              onWeightMode={(weightMode) => patchState({ weightMode })}
              onMiddleWeight={(middleWeight) => patchState({ middleWeight })} />
          ) : (<>
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
          </>)}
        </aside>
      </div>
    </section>
  );
}
