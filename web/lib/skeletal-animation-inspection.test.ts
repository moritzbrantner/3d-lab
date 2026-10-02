import { describe, expect, test } from "bun:test";
import { buildTeachingSkinningReadout, sampleTeachingPose } from "./skeletal-animation";
import {
  filterJointTree,
  formatVec,
  frameToTime,
  jointTransforms,
  keyframeSegment,
  navigateJointTree,
  pickNearestScreenPoint,
  playbackRangeBounds,
  setRangeEnd,
  setRangeStart,
  summarizeJointInfluence,
  teachingVertices,
  TEACHING_JOINTS,
  timeToFrame,
  vertexWeightColor,
  weightForJoint,
} from "./skeletal-animation-inspection";

describe("joint hierarchy", () => {
  test("empty query lists the whole hierarchy with depths", () => {
    expect(filterJointTree(TEACHING_JOINTS, "").map((row) => [row.name, row.depth])).toEqual([
      ["Shoulder", 0], ["Elbow", 1], ["Wrist", 2],
    ]);
  });

  test("search keeps ancestors of a match as context", () => {
    const rows = filterJointTree(TEACHING_JOINTS, "  WRI ");
    expect(rows.map((row) => row.name)).toEqual(["Shoulder", "Elbow", "Wrist"]);
    expect(rows.map((row) => row.matches)).toEqual([false, false, true]);
    expect(filterJointTree(TEACHING_JOINTS, "shoulder").map((row) => row.name)).toEqual(["Shoulder"]);
    expect(filterJointTree(TEACHING_JOINTS, "nothing")).toEqual([]);
  });

  test("keyboard navigation follows the WAI-ARIA tree pattern", () => {
    const rows = filterJointTree(TEACHING_JOINTS, "");
    expect(navigateJointTree(rows, 0, "ArrowDown")).toBe(1);
    expect(navigateJointTree(rows, 2, "ArrowDown")).toBe(2);
    expect(navigateJointTree(rows, 1, "ArrowUp")).toBe(0);
    expect(navigateJointTree(rows, 1, "ArrowLeft")).toBe(0);
    expect(navigateJointTree(rows, 0, "ArrowLeft")).toBe(0);
    expect(navigateJointTree(rows, 0, "ArrowRight")).toBe(1);
    expect(navigateJointTree(rows, 2, "ArrowRight")).toBe(2);
    expect(navigateJointTree(rows, 1, "End")).toBe(2);
    expect(navigateJointTree(rows, 1, "Home")).toBe(0);
    expect(navigateJointTree([], 1, "Home")).toBe(1);
  });
});

describe("local and model-space readouts", () => {
  test("model origins agree with the skinning readout", () => {
    const pose = sampleTeachingPose(0.7);
    const readout = buildTeachingSkinningReadout(pose, 0.5);
    jointTransforms(pose).forEach((joint, index) => {
      joint.model.position.forEach((value, axis) => expect(value).toBeCloseTo(readout.jointOrigins[index][axis], 9));
    });
  });

  test("local transform is the rest offset plus the pose rotation", () => {
    const [shoulder, elbow] = jointTransforms({ shoulder: 30, elbow: -45, wrist: 0 });
    expect(shoulder.local.rotationDegrees[2]).toBeCloseTo(30, 9);
    expect(elbow.local.position).toEqual([0, 1.5, 0]);
    expect(elbow.local.rotationDegrees[2]).toBeCloseTo(-45, 9);
  });

  test("model rotation accumulates down the chain", () => {
    const wrist = jointTransforms({ shoulder: 30, elbow: -45, wrist: 20 })[2];
    expect(wrist.model.rotationDegrees[2]).toBeCloseTo(5, 9);
  });

  test("formatting never prints negative zero", () => {
    expect(formatVec([-0.0001, 1.23456, -2], 2)).toBe("0.00, 1.23, -2.00");
  });
});

describe("clip time and playback range", () => {
  test("frames and times round-trip at 30 fps", () => {
    expect(timeToFrame(0.5)).toBe(15);
    expect(frameToTime(45)).toBe(1.5);
    expect(timeToFrame(frameToTime(37))).toBe(37);
  });

  test("range handles cannot cross or collapse", () => {
    const range = { start: 0.5, end: 1.5 };
    expect(setRangeStart(range, 5).start).toBeCloseTo(1.5 - 1 / 30, 9);
    expect(setRangeStart(range, -1).start).toBe(0);
    expect(setRangeEnd(range, 0).end).toBeCloseTo(0.5 + 1 / 30, 9);
    expect(setRangeEnd(range, 9).end).toBe(2);
    expect(setRangeEnd(range, Number.NaN).end).toBe(2);
    expect(playbackRangeBounds(range).start.max).toBeCloseTo(1.5 - 1 / 30, 9);
  });

  test("locates the keyframe segment for a time", () => {
    expect(keyframeSegment(0)).toBe(1);
    expect(keyframeSegment(1)).toBe(1);
    expect(keyframeSegment(1.2)).toBe(2);
    expect(keyframeSegment(2)).toBe(2);
  });
});

describe("skin weights", () => {
  test("vertex weights are normalized and follow the editable weight", () => {
    const vertices = teachingVertices(0.4);
    expect(vertices).toHaveLength(14);
    vertices.forEach((vertex) => expect(vertex.weights[0] + vertex.weights[1]).toBeCloseTo(1, 9));
    expect(weightForJoint(vertices[6], 1)).toBeCloseTo(0.4, 9);
    expect(weightForJoint(vertices[6], 2)).toBe(0);
  });

  test("a repeated zero-weight slot does not leak into joint weight", () => {
    const tip = teachingVertices(0.5)[12];
    expect(tip.joints).toEqual([2, 0]);
    expect(weightForJoint(tip, 0)).toBe(0);
    expect(weightForJoint(tip, 2)).toBe(1);
  });

  test("summarizes per-joint influence", () => {
    const summary = summarizeJointInfluence(teachingVertices(0.65), 2);
    expect(summary.vertexCount).toBe(6);
    expect(summary.fullyWeighted).toBe(2);
    expect(summary.maxWeight).toBe(1);
  });

  test("heat colour grows with the selected joint's weight", () => {
    const [low, high] = [teachingVertices(0.1)[6], teachingVertices(0.9)[6]];
    expect(vertexWeightColor("selected", high, 1)[0]).toBeGreaterThan(vertexWeightColor("selected", low, 1)[0]);
    expect(vertexWeightColor("off", low, 1)).toEqual(vertexWeightColor("off", high, 0));
  });
});

describe("viewport picking", () => {
  const points = [
    { kind: "joint" as const, id: 1, x: 100, y: 100 },
    { kind: "vertex" as const, id: 6, x: 104, y: 100 },
    { kind: "vertex" as const, id: 7, x: 300, y: 300 },
  ];

  test("prefers the joint over a vertex beneath it", () => {
    expect(pickNearestScreenPoint(points, { x: 103, y: 100 })).toMatchObject({ kind: "joint", id: 1 });
  });

  test("picks the nearest vertex away from joints and nothing outside the radius", () => {
    expect(pickNearestScreenPoint(points, { x: 296, y: 303 })).toMatchObject({ kind: "vertex", id: 7 });
    expect(pickNearestScreenPoint(points, { x: 200, y: 200 })).toBeNull();
  });
});
