import { describe, expect, test } from "bun:test";
import { sampleTeachingTerrain, solveTwoBoneIk } from "./procedural-animation";

function expectVectorClose(
  actual: { x: number; y: number; z: number },
  expected: { x: number; y: number; z: number },
) {
  expect(actual.x).toBeCloseTo(expected.x, 5);
  expect(actual.y).toBeCloseTo(expected.y, 5);
  expect(actual.z).toBeCloseTo(expected.z, 5);
}

describe("two-bone IK", () => {
  test("solves a reachable target in the pole-defined plane", () => {
    const result = solveTwoBoneIk({
      root: { x: 0, y: 0, z: 0 },
      target: { x: 1, y: 0, z: 0 },
      pole: { x: 0, y: 1, z: 0 },
      upperLength: 1,
      lowerLength: 1,
    });

    expect(result.reachedTarget).toBe(true);
    expectVectorClose(result.end, { x: 1, y: 0, z: 0 });
    expectVectorClose(result.knee, {
      x: 0.5,
      y: Math.sqrt(0.75),
      z: 0,
    });
  });

  test("pole direction deterministically chooses the bend side", () => {
    const positive = solveTwoBoneIk({
      root: { x: 0, y: 0, z: 0 },
      target: { x: 1, y: 0, z: 0 },
      pole: { x: 0, y: 1, z: 0 },
      upperLength: 1,
      lowerLength: 1,
    });
    const negative = solveTwoBoneIk({
      root: { x: 0, y: 0, z: 0 },
      target: { x: 1, y: 0, z: 0 },
      pole: { x: 0, y: -1, z: 0 },
      upperLength: 1,
      lowerLength: 1,
    });

    expect(positive.knee.y).toBeGreaterThan(0);
    expect(negative.knee.y).toBeLessThan(0);
  });

  test("clamps an unreachable target to the chain reach", () => {
    const result = solveTwoBoneIk({
      root: { x: 0, y: 0, z: 0 },
      target: { x: 5, y: 0, z: 0 },
      pole: { x: 0, y: 1, z: 0 },
      upperLength: 1,
      lowerLength: 1,
    });

    expect(result.reachedTarget).toBe(false);
    expect(result.solvedDistance).toBeCloseTo(2);
    expectVectorClose(result.end, { x: 2, y: 0, z: 0 });
  });

  test("folds equal-length bones onto a root target without a singularity", () => {
    const result = solveTwoBoneIk({
      root: { x: 0, y: 0, z: 0 },
      target: { x: 0, y: 0, z: 0 },
      pole: { x: 0, y: 1, z: 0 },
      upperLength: 1,
      lowerLength: 1,
    });

    expect(result.reachedTarget).toBe(true);
    expectVectorClose(result.end, { x: 0, y: 0, z: 0 });
    expectVectorClose(result.knee, { x: 0, y: 1, z: 0 });
  });

  test("rejects invalid segment lengths", () => {
    expect(() =>
      solveTwoBoneIk({
        root: { x: 0, y: 0, z: 0 },
        target: { x: 1, y: 0, z: 0 },
        pole: { x: 0, y: 1, z: 0 },
        upperLength: 0,
        lowerLength: 1,
      }),
    ).toThrow("segment lengths");
  });
});

describe("procedural animation teaching terrain", () => {
  test("slope samples expose an upward unit normal", () => {
    const sample = sampleTeachingTerrain("slope", 2, 0);
    const normalLength = Math.hypot(sample.normal.x, sample.normal.y, sample.normal.z);

    expect(sample.position.y).toBeCloseTo(0.32);
    expect(sample.normal.y).toBeGreaterThan(0.9);
    expect(normalLength).toBeCloseTo(1);
  });

  test("stairs retain stable support identity within a tread", () => {
    expect(sampleTeachingTerrain("stairs", 1.0, 0).supportId).toBe(
      sampleTeachingTerrain("stairs", 1.4, 0).supportId,
    );
  });
});
