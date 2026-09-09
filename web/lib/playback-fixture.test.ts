import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { PlaybackFixture } from "./playback-fixture";

const fixtureUrl = new URL("../public/generated/playback-fixture.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8")) as PlaybackFixture;

describe("Rust-generated playback timing fixture", () => {
  test("correct playback time follows elapsed wall time under uneven frames", () => {
    let cumulative = 0;
    for (const frame of fixture.frames) {
      cumulative += frame.deltaSeconds;
      expect(frame.wallTimeSeconds).toBeCloseTo(cumulative, 5);
      expect(frame.playbackTimeSeconds).toBeCloseTo(cumulative % fixture.clipDurationSeconds, 5);
    }
  });

  test("fixed-per-frame progression visibly diverges when frame durations vary", () => {
    const final = fixture.frames.at(-1);
    expect(final).toBeDefined();
    expect(final!.naiveFixedFrameTimeSeconds).toBeCloseTo(fixture.frames.length * fixture.naiveFrameSeconds, 5);
    expect(Math.abs(final!.playbackTimeSeconds - final!.naiveFixedFrameTimeSeconds)).toBeGreaterThan(0.1);
  });

  test("transition progress and blend factor are monotonic and finish once", () => {
    let previousProgress = 0;
    let previousBlend = 0;
    let sawComplete = false;
    for (const frame of fixture.frames) {
      expect(frame.transitionLinearProgress).toBeGreaterThanOrEqual(previousProgress);
      expect(frame.blendFactor).toBeGreaterThanOrEqual(previousBlend);
      expect(frame.transitionLinearProgress).toBeLessThanOrEqual(1);
      expect(frame.blendFactor).toBeLessThanOrEqual(1);
      if (sawComplete) expect(frame.transitionComplete).toBeTrue();
      sawComplete ||= frame.transitionComplete;
      previousProgress = frame.transitionLinearProgress;
      previousBlend = frame.blendFactor;
    }
    expect(sawComplete).toBeTrue();
  });

  test("blended rotations remain normalized", () => {
    for (const frame of fixture.frames) {
      const [x, y, z, w] = frame.pose.rotation;
      const length = Math.hypot(x, y, z, w);
      expect(length).toBeCloseTo(1, 4);
    }
  });
});
