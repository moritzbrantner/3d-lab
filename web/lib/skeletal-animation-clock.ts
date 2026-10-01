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
  /** Set when a non-looping clip reached the end of its playback range. */
  finished: boolean;
};

export type PlaybackRange = { start: number; end: number };

export type ClipClockOptions = {
  duration?: number;
  /** Playback window inside the clip; defaults to the whole clip. */
  range?: PlaybackRange;
  /** Wrap at the range end (default) or stop there and report `finished`. */
  loop?: boolean;
  publishInterval?: number;
  maxFrameDelta?: number;
};

function wrapClipTime(time: number, duration: number): number {
  const wrapped = time % duration;
  return wrapped < 0 ? wrapped + duration : wrapped;
}

/**
 * Explicitly set times (scrub, pause sync) keep the inclusive clip endpoint so
 * the advertised maximum stays inspectable; only playback wraps.
 */
function clampClipTime(time: number, duration: number): number {
  if (!Number.isFinite(time)) return 0;
  return Math.min(Math.max(time, 0), duration);
}

export function createClipClock(time: number, duration = TEACHING_CLIP_DURATION): ClipClock {
  return { time: clampClipTime(time, duration), sinceLastPublish: 0, finished: false };
}

/**
 * Sets the clock to an exact time (scrub, pause sync) and restarts the publish
 * window. The time is clamped to `[0, duration]`, never wrapped.
 */
export function setClipClockTime(clock: ClipClock, time: number, duration = TEACHING_CLIP_DURATION): void {
  clock.time = clampClipTime(time, duration);
  clock.sinceLastPublish = 0;
  clock.finished = false;
}

/**
 * Prepares the clock for playback: a time outside the playback range, or the
 * end of a finished non-looping clip, restarts at the range start.
 */
export function prepareClipPlayback(clock: ClipClock, options: ClipClockOptions = {}): void {
  const duration = options.duration ?? TEACHING_CLIP_DURATION;
  const { start, end } = options.range ?? { start: 0, end: duration };
  const loop = options.loop ?? true;
  if (clock.time < start || clock.time > end || (!loop && clock.time >= end)) {
    setClipClockTime(clock, start, duration);
  }
  clock.finished = false;
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

  const { start, end } = options.range ?? { start: 0, end: duration };
  const span = end - start;
  if (!(span > 0)) return false;
  // Playback always lives inside the range; an explicit scrub outside it rejoins at the start.
  const from = clock.time < start || clock.time > end ? start : clock.time;
  const next = from + delta;
  if (options.loop ?? true) {
    clock.time = start + wrapClipTime(next - start, span);
  } else if (next >= end) {
    clock.time = end;
    clock.finished = true;
    clock.sinceLastPublish = 0;
    return true;
  } else {
    clock.time = next;
  }
  clock.sinceLastPublish += delta;
  if (clock.sinceLastPublish < publishInterval) return false;
  clock.sinceLastPublish = 0;
  return true;
}
