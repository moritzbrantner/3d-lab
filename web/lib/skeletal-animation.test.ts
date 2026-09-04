import { describe, expect, test } from "bun:test";
import { Matrix4, Vector3 } from "three";
import {
  buildTeachingSkinningReadout,
  linearBlendSkinPoint,
  normalizeSkinWeights,
  sampleTeachingPose,
  skinMatrix,
} from "./skeletal-animation";

describe("skeletal animation teaching math", () => {
  test("normalizes four skin weights", () => {
    expect(normalizeSkinWeights([3, 1, 0, 0])).toEqual([0.75, 0.25, 0, 0]);
  });

  test("a bind transform multiplied by its inverse produces a rest skin matrix", () => {
    const bind = new Matrix4().makeTranslation(0, 2, 0).multiply(new Matrix4().makeRotationZ(0.4));
    const matrix = skinMatrix(bind, bind.clone().invert());
    const point = new Vector3(0.4, -0.2, 0.1).applyMatrix4(matrix);
    expect(point.x).toBeCloseTo(0.4, 6);
    expect(point.y).toBeCloseTo(-0.2, 6);
    expect(point.z).toBeCloseTo(0.1, 6);
  });

  test("linear blend skinning interpolates transformed positions by weight", () => {
    const result = linearBlendSkinPoint(
      new Vector3(0, 0, 0),
      [new Matrix4().makeTranslation(0, 0, 0), new Matrix4().makeTranslation(2, 0, 0)],
      { joints: [0, 1, 0, 0], weights: [1, 1, 0, 0] },
    );
    expect(result.x).toBeCloseTo(1, 6);
    expect(result.y).toBeCloseTo(0, 6);
  });

  test("teaching clip returns to the same pose at both ends", () => {
    expect(sampleTeachingPose(0)).toEqual(sampleTeachingPose(2));
    expect(sampleTeachingPose(1).elbow).toBeGreaterThan(sampleTeachingPose(0).elbow);
  });

  test("teaching readout keeps its blend weights complementary", () => {
    const readout = buildTeachingSkinningReadout(sampleTeachingPose(1), 0.35);
    expect(readout.weights[0] + readout.weights[1]).toBeCloseTo(1, 8);
  });
});
