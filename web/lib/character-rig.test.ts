import { describe, expect, test } from "bun:test";
import { sampleCharacterPose } from "./character-rig";

describe("sampleCharacterPose", () => {
  test("wraps phase deterministically", () => {
    expect(sampleCharacterPose("walk", 0.25)).toEqual(sampleCharacterPose("walk", 1.25));
    expect(sampleCharacterPose("wave", -0.75)).toEqual(sampleCharacterPose("wave", 0.25));
  });

  test("walk alternates opposing limbs", () => {
    const pose = sampleCharacterPose("walk", 0.25);
    expect(Math.sign(pose.leftHipX)).toBe(-Math.sign(pose.rightHipX));
    expect(Math.sign(pose.leftShoulderX)).toBe(-Math.sign(pose.rightShoulderX));
  });

  test("wave lifts the right shoulder into a visible side pose", () => {
    const pose = sampleCharacterPose("wave", 0.125);
    expect(pose.rightShoulderZ).toBeGreaterThan(1);
    expect(Math.abs(pose.rightElbowX)).toBeGreaterThan(0.1);
  });

  test("all sampled values stay finite", () => {
    for (const motion of ["idle", "walk", "wave"] as const) {
      for (const phase of [-10, -0.25, 0, 0.5, 1, 12.75]) {
        const pose = sampleCharacterPose(motion, phase);
        expect(Object.values(pose).every(Number.isFinite)).toBe(true);
      }
    }
  });
});
