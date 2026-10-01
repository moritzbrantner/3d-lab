import { describe, expect, test } from "bun:test";
import {
  advanceClipClock,
  CLIP_UI_PUBLISH_INTERVAL,
  createClipClock,
  MAX_CLIP_FRAME_DELTA,
  setClipClockTime,
} from "./skeletal-animation-clock";
import { TEACHING_CLIP_DURATION } from "./skeletal-animation";

describe("skeletal animation clip clock", () => {
  test("renderer time advances every frame while UI publishes stay bounded", () => {
    const clock = createClipClock(0);
    const frameDelta = 1 / 60;
    const frames = 90;
    let publishes = 0;
    const rendererTimes: number[] = [];

    for (let frame = 0; frame < frames; frame += 1) {
      if (advanceClipClock(clock, frameDelta)) publishes += 1;
      rendererTimes.push(clock.time);
    }

    // Every frame moved the renderer clock forward; none were skipped or batched.
    rendererTimes.forEach((time, frame) => {
      expect(time).toBeCloseTo((frameDelta * (frame + 1)) % TEACHING_CLIP_DURATION, 9);
    });
    expect(publishes).toBeGreaterThan(0);
    expect(publishes).toBeLessThanOrEqual(Math.floor((frames * frameDelta) / CLIP_UI_PUBLISH_INTERVAL));
    expect(publishes).toBeLessThan(frames / 5);
  });

  test("publishes exactly once per interval with exactly representable steps", () => {
    const clock = createClipClock(0);
    const results = Array.from({ length: 8 }, () => advanceClipClock(clock, 0.0625, { publishInterval: 0.125 }));
    expect(results).toEqual([false, true, false, true, false, true, false, true]);
    expect(clock.time).toBe(0.5);
  });

  test("wraps at the clip duration and clamps long frames", () => {
    const clock = createClipClock(TEACHING_CLIP_DURATION - 0.05);
    advanceClipClock(clock, 5);
    expect(clock.time).toBeCloseTo(MAX_CLIP_FRAME_DELTA - 0.05, 9);
    advanceClipClock(clock, -1);
    advanceClipClock(clock, Number.NaN);
    expect(clock.time).toBeCloseTo(MAX_CLIP_FRAME_DELTA - 0.05, 9);
  });

  test("scrubbing sets an exact time and restarts the publish window", () => {
    const clock = createClipClock(0.8);
    advanceClipClock(clock, 0.0625, { publishInterval: 0.125 });
    setClipClockTime(clock, 1.25);
    expect(clock.time).toBe(1.25);
    expect(clock.sinceLastPublish).toBe(0);
    expect(advanceClipClock(clock, 0.0625, { publishInterval: 0.125 })).toBe(false);
  });

  test("scrubbing keeps the inclusive clip endpoint and clamps out-of-range times", () => {
    const clock = createClipClock(TEACHING_CLIP_DURATION);
    expect(clock.time).toBe(TEACHING_CLIP_DURATION);

    setClipClockTime(clock, 0.4);
    setClipClockTime(clock, TEACHING_CLIP_DURATION);
    expect(clock.time).toBe(TEACHING_CLIP_DURATION);

    setClipClockTime(clock, TEACHING_CLIP_DURATION + 0.5);
    expect(clock.time).toBe(TEACHING_CLIP_DURATION);
    setClipClockTime(clock, -0.25);
    expect(clock.time).toBe(0);
    setClipClockTime(clock, Number.NaN);
    expect(clock.time).toBe(0);

    // Playback from the endpoint still wraps back into the clip.
    setClipClockTime(clock, TEACHING_CLIP_DURATION);
    advanceClipClock(clock, 0.0625);
    expect(clock.time).toBeCloseTo(0.0625, 9);
  });
});
