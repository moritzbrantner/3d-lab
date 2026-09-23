import { describe, expect, test } from "bun:test";
import { CHARACTER_CYCLE_SECONDS, createCharacterPose, sampleCharacterPose, sampleCharacterPoseInto, stepCharacterPhase } from "./character-rig";

describe("character pose runtime", () => {
  test("reuses output and overwrites every channel when motions change", () => {
    const target = createCharacterPose();
    for (const motion of ["wave", "walk", "idle", "wave", "idle"] as const) {
      for (const phase of [-0.25, 0, 0.125, 0.5, 0.999, 3.25]) {
        expect(sampleCharacterPoseInto(motion, phase, target)).toBe(target);
        expect(target).toEqual(sampleCharacterPose(motion, phase));
      }
    }
  });

  test("invalid time fails without partially changing the previous pose", () => {
    const target = sampleCharacterPose("wave", 0.25);
    const previous = { ...target };
    for (const time of [NaN, Infinity, -Infinity]) {
      expect(() => sampleCharacterPoseInto("walk", time, target)).toThrow("finite");
      expect(target).toEqual(previous);
    }
  });

  test("root position, bob and yaw have continuous loop-seam velocity", () => {
    const epsilon = 1e-5;
    for (const motion of ["idle", "walk", "wave"] as const) {
      const before = sampleCharacterPose(motion, 1 - epsilon);
      const seam = sampleCharacterPose(motion, 0);
      const after = sampleCharacterPose(motion, epsilon);
      for (const key of ["rootX", "rootY", "rootYaw"] as const) {
        const leftVelocity = (seam[key] - before[key]) / epsilon;
        const rightVelocity = (after[key] - seam[key]) / epsilon;
        expect(Math.abs(leftVelocity - rightVelocity)).toBeLessThan(0.001);
      }
    }
  });

  test("frame stepping is exactly 1/60 second and clamps at clip boundaries", () => {
    const phase = 0.3;
    expect((stepCharacterPhase(phase, 1) - phase) * CHARACTER_CYCLE_SECONDS).toBeCloseTo(1 / 60, 12);
    expect(stepCharacterPhase(stepCharacterPhase(phase, 1), -1)).toBeCloseTo(phase, 12);
    expect(stepCharacterPhase(0, -1)).toBe(0);
    expect(stepCharacterPhase(1, 1)).toBe(1);
    expect(() => stepCharacterPhase(NaN, 1)).toThrow();
    expect(() => stepCharacterPhase(0, 0.5)).toThrow();
  });
});
