import { Color, Euler, Matrix4, Quaternion, Vector3 } from "three";
import { TEACHING_CLIP_DURATION, type TeachingPose } from "./skeletal-animation";

/**
 * Inspection helpers for the skeletal animation lab. They derive readouts from
 * the same joint hierarchy, clip and skin weights the renderer draws; nothing
 * here is a second model of the rig.
 */

export type Vec3 = readonly [number, number, number];

export type TeachingJoint = {
  index: number;
  name: string;
  parent: number;
  restPosition: Vec3;
  /** Which `TeachingPose` channel rotates this joint about Z. */
  poseChannel: keyof TeachingPose;
};

export const TEACHING_JOINTS: readonly TeachingJoint[] = [
  { index: 0, name: "Shoulder", parent: -1, restPosition: [0, -1.5, 0], poseChannel: "shoulder" },
  { index: 1, name: "Elbow", parent: 0, restPosition: [0, 1.5, 0], poseChannel: "elbow" },
  { index: 2, name: "Wrist", parent: 1, restPosition: [0, 1.5, 0], poseChannel: "wrist" },
];

export const TEACHING_CLIP_FPS = 30;

export const TEACHING_CLIP_INFO = {
  name: "Teaching reach",
  source: "procedural (sampleTeachingPose)",
  duration: TEACHING_CLIP_DURATION,
  fps: TEACHING_CLIP_FPS,
  keyframeTimes: [0, 1, 2],
  channels: "rotation Z × 3 joints",
  interpolation: "smoothstep per segment",
} as const;

/** Smallest playback window, one frame, so a range can never collapse. */
export const MIN_PLAYBACK_SPAN = 1 / TEACHING_CLIP_FPS;

// ---- joint hierarchy ---------------------------------------------------

export type JointTreeRow = {
  index: number;
  name: string;
  depth: number;
  parent: number;
  hasChildren: boolean;
  /** True when the row matches the query itself (ancestors are shown as context). */
  matches: boolean;
};

export function jointDepth(joints: readonly TeachingJoint[], index: number): number {
  let depth = 0;
  for (let parent = joints[index]?.parent ?? -1; parent >= 0; parent = joints[parent].parent) depth += 1;
  return depth;
}

/** Visible hierarchy rows: joints matching the query by name or index, plus their ancestors. */
export function filterJointTree(joints: readonly TeachingJoint[], query: string): JointTreeRow[] {
  const needle = query.trim().toLowerCase();
  const matches = joints.map(
    (joint) => needle === "" || joint.name.toLowerCase().includes(needle) || String(joint.index) === needle,
  );
  const visible = [...matches];
  joints.forEach((joint, index) => {
    if (!matches[index]) return;
    for (let parent = joint.parent; parent >= 0; parent = joints[parent].parent) visible[parent] = true;
  });
  return joints
    .filter((_, index) => visible[index])
    .map((joint) => ({
      index: joint.index,
      name: joint.name,
      depth: jointDepth(joints, joint.index),
      parent: joint.parent,
      hasChildren: joints.some((other) => other.parent === joint.index),
      matches: matches[joint.index],
    }));
}

export type TreeKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

/** WAI-ARIA tree keyboard navigation over the visible rows. Returns the joint to focus. */
export function navigateJointTree(rows: readonly JointTreeRow[], current: number, key: TreeKey): number {
  if (rows.length === 0) return current;
  const position = rows.findIndex((row) => row.index === current);
  if (position < 0) return rows[0].index;
  switch (key) {
    case "ArrowDown": return rows[Math.min(position + 1, rows.length - 1)].index;
    case "ArrowUp": return rows[Math.max(position - 1, 0)].index;
    case "Home": return rows[0].index;
    case "End": return rows[rows.length - 1].index;
    case "ArrowLeft": return rows.some((row) => row.index === rows[position].parent) ? rows[position].parent : current;
    case "ArrowRight": return rows.find((row) => row.parent === current)?.index ?? current;
  }
}

// ---- local / model-space readouts --------------------------------------

export type SpaceTransform = { position: Vec3; rotationDegrees: Vec3 };
export type JointTransforms = { index: number; name: string; local: SpaceTransform; model: SpaceTransform };

function describeMatrix(matrix: Matrix4): SpaceTransform {
  const position = new Vector3();
  const rotation = new Quaternion();
  matrix.decompose(position, rotation, new Vector3());
  const euler = new Euler().setFromQuaternion(rotation, "XYZ");
  const degrees = (radians: number) => (radians * 180) / Math.PI;
  return {
    position: [position.x, position.y, position.z],
    rotationDegrees: [degrees(euler.x), degrees(euler.y), degrees(euler.z)],
  };
}

export function jointTransforms(pose: TeachingPose, joints: readonly TeachingJoint[] = TEACHING_JOINTS): JointTransforms[] {
  const models: Matrix4[] = [];
  return joints.map((joint) => {
    const local = new Matrix4()
      .makeTranslation(...joint.restPosition)
      .multiply(new Matrix4().makeRotationZ((pose[joint.poseChannel] * Math.PI) / 180));
    const model = joint.parent >= 0 ? models[joint.parent].clone().multiply(local) : local;
    models[joint.index] = model;
    return { index: joint.index, name: joint.name, local: describeMatrix(local), model: describeMatrix(model) };
  });
}

export function formatVec(values: Vec3, digits: number): string {
  return values
    .map((value) => {
      const text = value.toFixed(digits);
      return Number(text) === 0 ? (0).toFixed(digits) : text;
    })
    .join(", ");
}

// ---- clip time, frames and playback range ------------------------------

export function timeToFrame(time: number, fps = TEACHING_CLIP_FPS): number {
  return Math.round(time * fps);
}

export function frameToTime(frame: number, fps = TEACHING_CLIP_FPS): number {
  return frame / fps;
}

export type PlaybackRangeState = { start: number; end: number };

export const FULL_PLAYBACK_RANGE: PlaybackRangeState = { start: 0, end: TEACHING_CLIP_DURATION };

/** Valid numeric bounds for each range handle given the other one. */
export function playbackRangeBounds(range: PlaybackRangeState, duration = TEACHING_CLIP_DURATION) {
  return {
    start: { min: 0, max: Math.max(0, range.end - MIN_PLAYBACK_SPAN) },
    end: { min: Math.min(duration, range.start + MIN_PLAYBACK_SPAN), max: duration },
  };
}

export function setRangeStart(range: PlaybackRangeState, start: number, duration = TEACHING_CLIP_DURATION): PlaybackRangeState {
  const bounds = playbackRangeBounds(range, duration).start;
  return { ...range, start: Math.min(Math.max(Number.isFinite(start) ? start : 0, bounds.min), bounds.max) };
}

export function setRangeEnd(range: PlaybackRangeState, end: number, duration = TEACHING_CLIP_DURATION): PlaybackRangeState {
  const bounds = playbackRangeBounds(range, duration).end;
  return { ...range, end: Math.min(Math.max(Number.isFinite(end) ? end : duration, bounds.min), bounds.max) };
}

/** Keyframe segment (1-based) containing `time`, for the clip readout. */
export function keyframeSegment(time: number, keyframes: readonly number[] = TEACHING_CLIP_INFO.keyframeTimes): number {
  for (let segment = 1; segment < keyframes.length; segment += 1) {
    if (time <= keyframes[segment]) return segment;
  }
  return keyframes.length - 1;
}

// ---- skin weights ------------------------------------------------------

export type WeightMode = "joints" | "selected" | "off";

export const WEIGHT_MODES: readonly { id: WeightMode; label: string }[] = [
  { id: "joints", label: "Joint colours" },
  { id: "selected", label: "Selected joint weight" },
  { id: "off", label: "Mesh only" },
];

export type TeachingVertex = {
  index: number;
  row: number;
  /** Bind-space position. */
  position: Vec3;
  joints: readonly [number, number];
  weights: readonly [number, number];
};

export const TEACHING_ROW_HEIGHTS = [-1.5, -1.0, -0.45, 0.15, 0.7, 1.2, 1.5] as const;
export const TEACHING_COLUMN_X = [-0.32, 0.32] as const;
/** Row whose middle-joint weight the weights lesson edits. */
export const EDITABLE_WEIGHT_ROW = 3;

type RowInfluence = readonly [readonly [number, number], readonly [number, number]];

export function teachingRowInfluences(middleWeight: number): readonly RowInfluence[] {
  return [
    [[0, 0], [1, 0]],
    [[0, 1], [0.82, 0.18]],
    [[0, 1], [0.68, 0.32]],
    [[0, 1], [1 - middleWeight, middleWeight]],
    [[1, 2], [0.72, 0.28]],
    [[1, 2], [0.25, 0.75]],
    [[2, 0], [1, 0]],
  ];
}

export function teachingVertices(middleWeight: number): TeachingVertex[] {
  const influences = teachingRowInfluences(Math.min(Math.max(middleWeight, 0), 1));
  return TEACHING_ROW_HEIGHTS.flatMap((y, row) =>
    TEACHING_COLUMN_X.map((x, column) => ({
      index: row * 2 + column,
      row,
      position: [x, y, 0] as Vec3,
      joints: influences[row][0],
      weights: influences[row][1],
    })),
  );
}

/** Weight a vertex gives one joint (slots may repeat a joint with zero weight). */
export function weightForJoint(vertex: Pick<TeachingVertex, "joints" | "weights">, joint: number): number {
  return vertex.joints.reduce((sum, slot, index) => (slot === joint ? sum + vertex.weights[index] : sum), 0);
}

export type JointInfluenceSummary = { joint: number; vertexCount: number; maxWeight: number; fullyWeighted: number };

export function summarizeJointInfluence(vertices: readonly TeachingVertex[], joint: number): JointInfluenceSummary {
  let vertexCount = 0;
  let maxWeight = 0;
  let fullyWeighted = 0;
  for (const vertex of vertices) {
    const weight = weightForJoint(vertex, joint);
    if (weight <= 0) continue;
    vertexCount += 1;
    maxWeight = Math.max(maxWeight, weight);
    if (weight >= 1 - 1e-9) fullyWeighted += 1;
  }
  return { joint, vertexCount, maxWeight, fullyWeighted };
}

const JOINT_COLORS = [new Color(0xe06a62), new Color(0x69b87a), new Color(0x6d8fe8)];
const HEAT_COLD = new Color(0x1b2638);
const HEAT_HOT = new Color(0xffc247);
const NEUTRAL = new Color(0x8794a8);

/** Linear RGB written to the vertex colour attribute for a weight visualization mode. */
export function vertexWeightColor(
  mode: WeightMode,
  vertex: Pick<TeachingVertex, "joints" | "weights">,
  selectedJoint: number,
): Vec3 {
  const result = new Color(0, 0, 0);
  if (mode === "off") result.copy(NEUTRAL);
  else if (mode === "selected") {
    result.copy(HEAT_COLD).lerp(HEAT_HOT, Math.min(Math.max(weightForJoint(vertex, selectedJoint), 0), 1));
  } else {
    vertex.joints.forEach((joint, slot) => {
      if (vertex.weights[slot] > 0) result.add(JOINT_COLORS[joint].clone().multiplyScalar(vertex.weights[slot]));
    });
  }
  return [result.r, result.g, result.b];
}

export function jointCssColor(joint: number): string {
  return `#${JOINT_COLORS[joint].getHexString()}`;
}

// ---- viewport picking --------------------------------------------------

export type ScreenPoint = { kind: "joint" | "vertex"; id: number; x: number; y: number };

/** Joints win near-ties against vertices lying under them. */
const JOINT_PICK_BIAS = 6;

/** Nearest pickable within `radius` CSS pixels of the pointer, or null. */
export function pickNearestScreenPoint(
  points: readonly ScreenPoint[],
  pointer: { x: number; y: number },
  radius = 14,
): ScreenPoint | null {
  let best: ScreenPoint | null = null;
  let bestScore = Infinity;
  for (const point of points) {
    const distance = Math.hypot(point.x - pointer.x, point.y - pointer.y);
    if (distance > radius) continue;
    const score = distance - (point.kind === "joint" ? JOINT_PICK_BIAS : 0);
    if (score < bestScore) {
      best = point;
      bestScore = score;
    }
  }
  return best;
}
