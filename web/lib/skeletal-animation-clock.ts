import { TEACHING_CLIP_DURATION } from "./skeletal-animation";

/** Longest frame step the renderer clock accepts, so a backgrounded tab does not jump the clip. */
export const MAX_CLIP_FRAME_DELTA = 0.1;

/** Seconds of clip time between React readout publishes while the clip plays. */
export const CLIP_UI_PUBLISH_INTERVAL = 0.1;

/**
 * Renderer-owned clip clock. The Three.js runtime advances it every animation
 * frame; React only receives `time` when `advanceClipClock` reports a publish
 * or when playback stops.
 */
export type ClipClock = {
  time: number;
  sinceLastPublish: number;
};

export type ClipClockOptions = {
  duration?: number;
  publishInterval?: number;
  maxFrameDelta?: number;
};

function wrapClipTime(time: number, duration: number): number {
  const wrapped = time % duration;
  return wrapped < 0 ? wrapped + duration : wrapped;
}

export function createClipClock(time: number, duration = TEACHING_CLIP_DURATION): ClipClock {
  return { time: wrapClipTime(time, duration), sinceLastPublish: 0 };
}

/** Sets the clock to an exact time (scrub, pause sync) and restarts the publish window. */
export function setClipClockTime(clock: ClipClock, time: number, duration = TEACHING_CLIP_DURATION): void {
  clock.time = wrapClipTime(time, duration);
  clock.sinceLastPublish = 0;
}

/**
 * Advances renderer time by one frame. Returns true when enough clip time has
 * elapsed since the last publish that React readouts should be refreshed.
 */
export function advanceClipClock(clock: ClipClock, frameDeltaSeconds: number, options: ClipClockOptions = {}): boolean {
  const duration = options.duration ?? TEACHING_CLIP_DURATION;
  const publishInterval = options.publishInterval ?? CLIP_UI_PUBLISH_INTERVAL;
  const maxFrameDelta = options.maxFrameDelta ?? MAX_CLIP_FRAME_DELTA;
  const delta = Math.min(Math.max(Number.isFinite(frameDeltaSeconds) ? frameDeltaSeconds : 0, 0), maxFrameDelta);

  clock.time = wrapClipTime(clock.time + delta, duration);
  clock.sinceLastPublish += delta;
  if (clock.sinceLastPublish < publishInterval) return false;
  clock.sinceLastPublish = 0;
  return true;
}
