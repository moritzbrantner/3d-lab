/**
 * Read-only access to Rust-generated playback timing evidence.
 *
 * `three-d-playback` owns clip clocks, transition progress, and cross-fades;
 * `three-d-animation` owns clip sampling and blending. This module validates the
 * committed evidence and looks frames up in it. It never samples a clip,
 * advances a clock, or blends a pose itself — including for the "fixed step"
 * series, which Rust also produces by feeding its clocks 1/60 s per frame.
 */
import rawEvidence from "../../fixtures/playback/playback-timing.json";

export const PLAYBACK_TIMING_SCHEMA = "3d-lab.playback-timing-evidence.v1";
const POSE_STRIDE = 7;

export type PlaybackModeId = "clamp" | "loop";
export type PlaybackDirectionId = "forward" | "reverse";
export type TransitionCurveId = "linear" | "smoothstep";
export type TimingView = "playback" | "crossfade";

export type TimingScenario = {
  id: string;
  label: string;
  /** Measured frame deltas; frame `i` (i ≥ 1) presents after `deltaSeconds[i - 1]`. */
  deltaSeconds: number[];
  /** Wall time each frame is presented at; frame 0 is the start (0 s). */
  wallSeconds: number[];
};

export type PlaybackSeries = {
  scenario: string;
  mode: PlaybackModeId;
  direction: PlaybackDirectionId;
  clipTime: number[];
  pose: number[];
  fixedStep: { clipTime: number[]; pose: number[] };
};

export type CrossFadeSeries = {
  scenario: string;
  transitionSeconds: number;
  curve: TransitionCurveId;
  fromTime: number[];
  toTime: number[];
  progress: number[];
  weight: number[];
  pose: number[];
  fixedStep: { progress: number[]; weight: number[]; pose: number[] };
};

export type PlaybackTimingEvidence = {
  schema: string;
  generator: string;
  wallSeconds: number;
  fixedStepSeconds: number;
  boundaryEpsilonCycles: number;
  poseLayout: string[];
  clips: { name: string; durationSeconds: number; loopMode: string }[];
  crossFadeSetup: {
    from: { clip: string; mode: string; speed: number };
    to: { clip: string; mode: string; speed: number };
  };
  scenarios: TimingScenario[];
  playback: PlaybackSeries[];
  crossFades: CrossFadeSeries[];
};

export type Pose = {
  translation: [number, number, number];
  rotation: [number, number, number, number];
};

function fail(message: string): never {
  throw new Error(`Invalid playback timing evidence: ${message}`);
}

function checkLength(values: unknown, length: number, what: string) {
  if (!Array.isArray(values) || values.length !== length) fail(`${what} must have ${length} entries`);
}

export function parsePlaybackTimingEvidence(raw: unknown): PlaybackTimingEvidence {
  const evidence = raw as PlaybackTimingEvidence;
  if (!evidence || evidence.schema !== PLAYBACK_TIMING_SCHEMA) fail("unexpected schema");
  if (evidence.poseLayout?.length !== POSE_STRIDE) fail("unexpected pose layout");
  if (!Array.isArray(evidence.scenarios) || evidence.scenarios.length === 0) fail("expected scenarios");
  const frames = new Map<string, number>();
  for (const scenario of evidence.scenarios) {
    const count = scenario.deltaSeconds.length + 1;
    checkLength(scenario.wallSeconds, count, `${scenario.id} wall times`);
    if (scenario.wallSeconds[0] !== 0) fail(`${scenario.id} must start at 0 s`);
    if (scenario.wallSeconds.some((wall, index) => index > 0 && !(wall > scenario.wallSeconds[index - 1]))) {
      fail(`${scenario.id} wall times must increase`);
    }
    if (Math.abs(scenario.wallSeconds[count - 1] - evidence.wallSeconds) > 1e-6) {
      fail(`${scenario.id} must cover ${evidence.wallSeconds} s`);
    }
    frames.set(scenario.id, count);
  }
  const frameCount = (id: string) => frames.get(id) ?? fail(`unknown scenario ${id}`);
  for (const series of evidence.playback) {
    const count = frameCount(series.scenario);
    checkLength(series.clipTime, count, "playback clip times");
    checkLength(series.fixedStep.clipTime, count, "fixed-step clip times");
    checkLength(series.pose, count * POSE_STRIDE, "playback poses");
    checkLength(series.fixedStep.pose, count * POSE_STRIDE, "fixed-step poses");
  }
  for (const series of evidence.crossFades) {
    const count = frameCount(series.scenario);
    for (const values of [series.fromTime, series.toTime, series.progress, series.weight]) {
      checkLength(values, count, "cross-fade frames");
    }
    checkLength(series.fixedStep.weight, count, "fixed-step weights");
    checkLength(series.fixedStep.progress, count, "fixed-step progress");
    checkLength(series.pose, count * POSE_STRIDE, "cross-fade poses");
    checkLength(series.fixedStep.pose, count * POSE_STRIDE, "fixed-step cross-fade poses");
  }
  return evidence;
}

export const playbackTimingEvidence = parsePlaybackTimingEvidence(rawEvidence);

export function findScenario(evidence: PlaybackTimingEvidence, id: string): TimingScenario {
  return evidence.scenarios.find((scenario) => scenario.id === id) ?? fail(`unknown scenario ${id}`);
}

export function findPlayback(
  evidence: PlaybackTimingEvidence,
  scenario: string,
  mode: PlaybackModeId,
  direction: PlaybackDirectionId,
): PlaybackSeries {
  return (
    evidence.playback.find(
      (series) => series.scenario === scenario && series.mode === mode && series.direction === direction,
    ) ?? fail(`no playback series for ${scenario}/${mode}/${direction}`)
  );
}

export function findCrossFade(
  evidence: PlaybackTimingEvidence,
  scenario: string,
  transitionSeconds: number,
  curve: TransitionCurveId,
): CrossFadeSeries {
  return (
    evidence.crossFades.find(
      (series) =>
        series.scenario === scenario && series.transitionSeconds === transitionSeconds && series.curve === curve,
    ) ?? fail(`no cross-fade series for ${scenario}/${transitionSeconds}/${curve}`)
  );
}

export function transitionDurations(evidence: PlaybackTimingEvidence): number[] {
  return [...new Set(evidence.crossFades.map((series) => series.transitionSeconds))];
}

/**
 * The frame on screen at `wallSeconds`: the last frame presented at or before
 * that instant. Between presentations the previous frame stays visible.
 */
export function frameAtWallTime(scenario: TimingScenario, wallSeconds: number): number {
  const times = scenario.wallSeconds;
  const target = Number.isFinite(wallSeconds) ? wallSeconds + 1e-9 : 0;
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (times[middle] <= target) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * Advances the lab's looping wall-time preview by one measured browser delta.
 *
 * This is presentation time over the recorded evidence range, not clip-clock
 * policy (that stays in Rust). Crossing the end keeps the overrun instead of
 * restarting at zero, so no measured time is dropped on a wrap, even after a
 * hitch spanning several loops. The inclusive endpoint stays reachable.
 * Negative or non-finite deltas (e.g. a rAF timestamp predating the start
 * sample) advance nothing.
 */
export function advancePreviewWallSeconds(currentSeconds: number, deltaSeconds: number, spanSeconds: number): number {
  if (!(spanSeconds > 0) || !Number.isFinite(spanSeconds)) return 0;
  const current = Number.isFinite(currentSeconds) ? Math.min(Math.max(currentSeconds, 0), spanSeconds) : 0;
  const delta = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;
  const next = current + delta;
  if (next <= spanSeconds) return next;
  const wrapped = next % spanSeconds;
  return Number.isFinite(wrapped) ? wrapped : 0;
}

export function poseAt(flat: number[], frame: number): Pose {
  const offset = frame * POSE_STRIDE;
  if (offset < 0 || offset + POSE_STRIDE > flat.length) fail(`no pose for frame ${frame}`);
  return {
    translation: [flat[offset], flat[offset + 1], flat[offset + 2]],
    rotation: [flat[offset + 3], flat[offset + 4], flat[offset + 5], flat[offset + 6]],
  };
}

/** Translations of frames `0..=lastFrame`, flattened xyz, for drawing presented-frame trails. */
export function translationTrail(flat: number[], lastFrame: number): number[] {
  const trail: number[] = [];
  for (let frame = 0; frame <= lastFrame; frame += 1) {
    const offset = frame * POSE_STRIDE;
    trail.push(flat[offset], flat[offset + 1], flat[offset + 2]);
  }
  return trail;
}

export type TimingSettings = {
  view: TimingView;
  scenario: string;
  mode: PlaybackModeId;
  direction: PlaybackDirectionId;
  transitionSeconds: number;
  curve: TransitionCurveId;
};

export type TimingFrame = {
  frame: number;
  frameCount: number;
  /** Measured delta that produced this frame (0 for the first frame). */
  deltaSeconds: number;
  presentedAtSeconds: number;
  pose: Pose;
  fixedStepPose: Pose;
  posePath: number[];
  fixedStepPosePath: number[];
  readouts: { label: string; elapsed: number; fixedStep: number }[];
};

/** Looks up everything the lab shows for one wall-clock instant. */
export function lookupTimingFrame(
  evidence: PlaybackTimingEvidence,
  settings: TimingSettings,
  wallSeconds: number,
): TimingFrame {
  const scenario = findScenario(evidence, settings.scenario);
  const frame = frameAtWallTime(scenario, wallSeconds);
  const base = {
    frame,
    frameCount: scenario.wallSeconds.length,
    deltaSeconds: frame === 0 ? 0 : scenario.deltaSeconds[frame - 1],
    presentedAtSeconds: scenario.wallSeconds[frame],
  };
  if (settings.view === "playback") {
    const series = findPlayback(evidence, settings.scenario, settings.mode, settings.direction);
    return {
      ...base,
      pose: poseAt(series.pose, frame),
      fixedStepPose: poseAt(series.fixedStep.pose, frame),
      posePath: series.pose,
      fixedStepPosePath: series.fixedStep.pose,
      readouts: [{ label: "Clip time (s)", elapsed: series.clipTime[frame], fixedStep: series.fixedStep.clipTime[frame] }],
    };
  }
  const series = findCrossFade(evidence, settings.scenario, settings.transitionSeconds, settings.curve);
  return {
    ...base,
    pose: poseAt(series.pose, frame),
    fixedStepPose: poseAt(series.fixedStep.pose, frame),
    posePath: series.pose,
    fixedStepPosePath: series.fixedStep.pose,
    readouts: [
      { label: "Transition progress", elapsed: series.progress[frame], fixedStep: series.fixedStep.progress[frame] },
      { label: "Blend weight", elapsed: series.weight[frame], fixedStep: series.fixedStep.weight[frame] },
    ],
  };
}

export type PartitionFinal = { scenario: TimingScenario; elapsed: number; fixedStep: number };

/**
 * The last Rust value of every frame partition for the current settings: clip
 * time for playback, blend weight for a cross-fade. Elapsed-time values agree;
 * fixed-step values do not.
 */
export function partitionFinals(evidence: PlaybackTimingEvidence, settings: TimingSettings): PartitionFinal[] {
  return evidence.scenarios.map((scenario) => {
    if (settings.view === "playback") {
      const series = findPlayback(evidence, scenario.id, settings.mode, settings.direction);
      return { scenario, elapsed: series.clipTime.at(-1)!, fixedStep: series.fixedStep.clipTime.at(-1)! };
    }
    const series = findCrossFade(evidence, scenario.id, settings.transitionSeconds, settings.curve);
    return { scenario, elapsed: series.weight.at(-1)!, fixedStep: series.fixedStep.weight.at(-1)! };
  });
}
