import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  advancePreviewWallSeconds,
  findCrossFade,
  findPlayback,
  findScenario,
  frameAtWallTime,
  lookupTimingFrame,
  parsePlaybackTimingEvidence,
  partitionFinals,
  playbackTimingEvidence as evidence,
  type TimingSettings,
} from "./playback-timing";

const settings: TimingSettings = {
  view: "playback",
  scenario: "uneven",
  mode: "loop",
  direction: "forward",
  transitionSeconds: 1.5,
  curve: "smoothstep",
};

describe("Rust playback timing evidence", () => {
  test("parses and rejects malformed documents", () => {
    expect(evidence.scenarios.map((scenario) => scenario.id)).toEqual([
      "steady-30",
      "steady-60",
      "steady-120",
      "uneven",
    ]);
    expect(() => parsePlaybackTimingEvidence({ schema: "other" })).toThrow("unexpected schema");
    const truncated = structuredClone(evidence);
    truncated.playback[0].clipTime.pop();
    expect(() => parsePlaybackTimingEvidence(truncated)).toThrow("playback clip times");
  });

  test("looks up the frame presented at a wall-clock instant", () => {
    const thirty = findScenario(evidence, "steady-30");
    expect(frameAtWallTime(thirty, 0)).toBe(0);
    expect(frameAtWallTime(thirty, 0.03)).toBe(0);
    expect(frameAtWallTime(thirty, 1 / 30)).toBe(1);
    expect(frameAtWallTime(thirty, 99)).toBe(thirty.wallSeconds.length - 1);
    expect(frameAtWallTime(thirty, Number.NaN)).toBe(0);
  });

  test("elapsed-time results agree across frame partitions; fixed-step results do not", () => {
    for (const mode of ["clamp", "loop"] as const) {
      for (const direction of ["forward", "reverse"] as const) {
        const finals = partitionFinals(evidence, { ...settings, mode, direction });
        const elapsed = finals.map((final) => final.elapsed);
        expect(Math.max(...elapsed) - Math.min(...elapsed)).toBeLessThan(1e-5);
      }
    }
    const fixed = partitionFinals(evidence, { ...settings, mode: "clamp" }).map((final) => final.fixedStep);
    expect(new Set(fixed).size).toBeGreaterThan(1);
  });

  test("cross-fades complete at their wall-clock duration on every partition", () => {
    for (const scenario of evidence.scenarios) {
      const series = findCrossFade(evidence, scenario.id, 1.5, "linear");
      scenario.wallSeconds.forEach((wall, frame) => {
        expect(series.weight[frame] === 1).toBe(wall >= 1.5 - 1e-6);
        if (frame > 0) expect(series.weight[frame]).toBeGreaterThanOrEqual(series.weight[frame - 1]);
      });
    }
    const fixed30 = findCrossFade(evidence, "steady-30", 1.5, "linear").fixedStep.weight.at(-1);
    expect(fixed30).toBeLessThan(1);
  });

  test("reports the Rust pose and readouts for the selected view", () => {
    const frame = lookupTimingFrame(evidence, settings, 1);
    const series = findPlayback(evidence, "uneven", "loop", "forward");
    expect(frame.readouts[0].elapsed).toBe(series.clipTime[frame.frame]);
    expect(frame.presentedAtSeconds).toBeLessThanOrEqual(1);
    const fade = lookupTimingFrame(evidence, { ...settings, view: "crossfade" }, 2);
    expect(fade.readouts.map((readout) => readout.label)).toEqual(["Transition progress", "Blend weight"]);
    const [x, y, z, w] = fade.pose.rotation;
    expect(Math.abs(Math.hypot(x, y, z, w) - 1)).toBeLessThan(1e-5);
  });

  test("wraps the wall-time preview without dropping measured overrun", () => {
    // Normal frames advance by the measured delta; the endpoint stays reachable.
    expect(advancePreviewWallSeconds(1.5, 0.25, 2)).toBeCloseTo(1.75, 12);
    expect(advancePreviewWallSeconds(1.75, 0.25, 2)).toBe(2);
    // Crossing the end keeps the remainder instead of restarting at zero.
    expect(advancePreviewWallSeconds(1.99, 1 / 60, 2)).toBeCloseTo(1.99 + 1 / 60 - 2, 12);
    expect(advancePreviewWallSeconds(2, 0.1, 2)).toBeCloseTo(0.1, 12);
    // A hitch spanning several loops lands where continuous time would.
    expect(advancePreviewWallSeconds(0.5, 5.25, 2)).toBeCloseTo(1.75, 12);
    // Summing frames across many wraps matches the total measured time.
    let wall = 0;
    for (let index = 0; index < 650; index += 1) wall = advancePreviewWallSeconds(wall, 1 / 60, 2);
    expect(wall).toBeCloseTo((650 / 60) % 2, 9);
    // Deltas that measure nothing advance nothing.
    expect(advancePreviewWallSeconds(0.8, -0.004, 2)).toBe(0.8);
    expect(advancePreviewWallSeconds(0.8, Number.NaN, 2)).toBe(0.8);
    expect(advancePreviewWallSeconds(0.8, 0.1, 0)).toBe(0);
  });

  test("does not reimplement clip sampling or clock policy", () => {
    const source = readFileSync(new URL("./playback-timing.ts", import.meta.url), "utf8");
    for (const forbidden of ["slerp", "rem_euclid", "% duration", "smoothstep(", "requestAnimationFrame"]) {
      expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
