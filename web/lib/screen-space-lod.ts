/**
 * Read-only access to Rust-generated screen-space LOD evidence.
 *
 * `three-d-lod` owns simplification and selection. This module only validates
 * the committed evidence document and looks decisions up in it; it never
 * projects errors or applies hysteresis itself.
 *
 * Projected error scales with viewport height, so Rust emits one set of tables
 * per offered viewport height. The lab sizes its canvas to exactly one of
 * those heights (see `fitViewportHeight`) instead of rescaling errors here.
 */
import rawEvidence from "../../fixtures/lod/screen-space-lod.json";

export const SCREEN_SPACE_LOD_SCHEMA = "3d-lab.screen-space-lod-evidence.v2";

export type LodSwitch = { distanceIndex: number; from: number; to: number };
export type SelectionReason = "kept" | "coarsened" | "refined";

export type LodLevelEvidence = {
  level: number;
  triangleCount: number;
  requestedTriangleCount: number;
  relativeError: number;
  geometricError: number;
  indices: number[];
};

export type LodPolicyEvidence = {
  maxPixelError: number;
  hysteresisPercent: number;
  idealLevel: string;
  selectedLevelByPrevious: string[];
  reasonByPrevious: string[];
  outboundSwitches: LodSwitch[];
  inboundSwitches: LodSwitch[];
};

export type LodViewportEvidence = {
  /** Viewport height in CSS pixels that these projections and decisions assume. */
  heightPixels: number;
  projectedErrorPixels: number[][];
  policies: LodPolicyEvidence[];
};

export type ScreenSpaceLodEvidence = {
  schema: string;
  generator: string;
  simplifierId: string;
  meshExtent: number;
  positions: number[];
  normals: number[];
  levels: LodLevelEvidence[];
  view: { verticalFovDegrees: number; distanceFrom: string; heightUnit: string };
  distances: { min: number; step: number; count: number };
  reasonCodes: Record<string, SelectionReason>;
  viewports: LodViewportEvidence[];
};

export type LodDecision = {
  level: number;
  idealLevel: number;
  reason: SelectionReason;
};

function fail(message: string): never {
  throw new Error(`Invalid screen-space LOD evidence: ${message}`);
}

export function parseScreenSpaceLodEvidence(raw: unknown): ScreenSpaceLodEvidence {
  const evidence = raw as ScreenSpaceLodEvidence;
  if (!evidence || evidence.schema !== SCREEN_SPACE_LOD_SCHEMA) fail("unexpected schema");
  const { count } = evidence.distances;
  const levelCount = evidence.levels.length;
  const vertexCount = evidence.positions.length / 3;
  if (!Number.isInteger(vertexCount) || evidence.normals.length !== evidence.positions.length) {
    fail("positions and normals must be aligned xyz triples");
  }
  if (levelCount < 2 || levelCount > 10) fail("expected 2..10 levels");
  evidence.levels.forEach((level, index) => {
    if (level.level !== index) fail(`level ${index} is out of order`);
    if (level.indices.length !== level.triangleCount * 3) fail(`level ${index} index count`);
    if (level.indices.some((vertex) => vertex < 0 || vertex >= vertexCount)) {
      fail(`level ${index} references a missing vertex`);
    }
  });
  if (!Array.isArray(evidence.viewports) || evidence.viewports.length === 0) fail("expected viewport tables");
  const policyKey = (policy: LodPolicyEvidence) => `${policy.maxPixelError}/${policy.hysteresisPercent}`;
  const policyKeys = evidence.viewports[0].policies.map(policyKey).join();
  let previousHeight = 0;
  for (const viewport of evidence.viewports) {
    if (!(viewport.heightPixels > previousHeight)) fail("viewport heights must be positive and ascending");
    previousHeight = viewport.heightPixels;
    if (viewport.projectedErrorPixels.length !== count) fail("projected error sample count");
    if (viewport.projectedErrorPixels.some((row) => row.length !== levelCount)) fail("projected error level count");
    if (viewport.policies.map(policyKey).join() !== policyKeys) fail("every viewport must offer the same policies");
    for (const policy of viewport.policies) {
      const rows = [policy.idealLevel, ...policy.selectedLevelByPrevious, ...policy.reasonByPrevious];
      if (policy.selectedLevelByPrevious.length !== levelCount || policy.reasonByPrevious.length !== levelCount) {
        fail("policy tables must cover every previous level");
      }
      if (rows.some((row) => row.length !== count)) fail("policy tables must cover every distance sample");
    }
  }
  return evidence;
}

export const screenSpaceLodEvidence = parseScreenSpaceLodEvidence(rawEvidence);

export function pixelBudgets(evidence: ScreenSpaceLodEvidence): number[] {
  return [...new Set(evidence.viewports[0].policies.map((policy) => policy.maxPixelError))];
}

export function hysteresisPercents(evidence: ScreenSpaceLodEvidence): number[] {
  return [...new Set(evidence.viewports[0].policies.map((policy) => policy.hysteresisPercent))];
}

export function viewportHeights(evidence: ScreenSpaceLodEvidence): number[] {
  return evidence.viewports.map((viewport) => viewport.heightPixels);
}

/**
 * Picks the canvas height for the available space: the tallest Rust-evaluated
 * height that fits, or the shortest one when nothing fits. The canvas is then
 * rendered at exactly that CSS height, so the selected tables match what is drawn.
 */
export function fitViewportHeight(evidence: ScreenSpaceLodEvidence, availableHeight: number): number {
  const heights = viewportHeights(evidence);
  return heights.filter((height) => height <= availableHeight).at(-1) ?? heights[0];
}

export function findViewport(evidence: ScreenSpaceLodEvidence, heightPixels: number): LodViewportEvidence {
  const viewport = evidence.viewports.find((candidate) => candidate.heightPixels === heightPixels);
  if (!viewport) throw new Error(`No Rust evidence for a ${heightPixels} px viewport`);
  return viewport;
}

export function findPolicy(
  viewport: LodViewportEvidence,
  maxPixelError: number,
  hysteresisPercent: number,
): LodPolicyEvidence {
  const policy = viewport.policies.find(
    (candidate) => candidate.maxPixelError === maxPixelError && candidate.hysteresisPercent === hysteresisPercent,
  );
  if (!policy) {
    throw new Error(`No Rust evidence for ${maxPixelError} px / ${hysteresisPercent}% at ${viewport.heightPixels} px`);
  }
  return policy;
}

export function distanceRange(evidence: ScreenSpaceLodEvidence) {
  const { min, step, count } = evidence.distances;
  return { min, max: distanceAt(evidence, count - 1), step };
}

/** Distances are sampled on a fixed grid; this is the grid point for `index`. */
export function distanceAt(evidence: ScreenSpaceLodEvidence, index: number): number {
  const { min, step } = evidence.distances;
  return Number((min + index * step).toFixed(6));
}

/** Snaps an arbitrary distance onto the evidence grid. */
export function distanceIndex(evidence: ScreenSpaceLodEvidence, distance: number): number {
  const { min, step, count } = evidence.distances;
  const index = Math.round((distance - min) / step);
  return Math.max(0, Math.min(count - 1, Number.isFinite(index) ? index : 0));
}

/** Looks up the Rust decision for one frame given the level shown in the previous frame. */
export function lookupDecision(
  evidence: ScreenSpaceLodEvidence,
  policy: LodPolicyEvidence,
  previousLevel: number,
  index: number,
): LodDecision {
  const code = policy.reasonByPrevious[previousLevel]?.[index];
  const level = Number(policy.selectedLevelByPrevious[previousLevel]?.[index]);
  const idealLevel = Number(policy.idealLevel[index]);
  const reason = code === undefined ? undefined : evidence.reasonCodes[code];
  if (!reason || !Number.isInteger(level) || !Number.isInteger(idealLevel)) {
    throw new Error(`No Rust decision for previous level ${previousLevel} at sample ${index}`);
  }
  return { level, idealLevel, reason };
}

/**
 * Replays a sequence of distance samples through the Rust decision tables,
 * carrying the selected level from one frame to the next.
 */
export function replayDecisions(
  evidence: ScreenSpaceLodEvidence,
  policy: LodPolicyEvidence,
  startLevel: number,
  indices: Iterable<number>,
): LodDecision[] {
  const decisions: LodDecision[] = [];
  let level = startLevel;
  for (const index of indices) {
    const decision = lookupDecision(evidence, policy, level, index);
    decisions.push(decision);
    level = decision.level;
  }
  return decisions;
}

export type LodLabState = {
  /** Canvas height in CSS pixels; always one of the Rust-evaluated heights. */
  viewportHeight: number;
  distanceIndex: number;
  maxPixelError: number;
  hysteresisPercent: number;
  /** Manual override level, or null when the Rust policy decides. */
  overrideLevel: number | null;
  /** Level shown in the previous frame; carried into the next lookup. */
  shownLevel: number;
  decision: LodDecision;
};

export type LodLabAction =
  | { type: "distance"; distance: number }
  | { type: "viewport"; availableHeight: number }
  | { type: "policy"; maxPixelError?: number; hysteresisPercent?: number }
  | { type: "override"; level: number | null };

export function initialLodLabState(
  evidence: ScreenSpaceLodEvidence,
  viewportHeight: number,
  distance: number,
  maxPixelError: number,
  hysteresisPercent: number,
): LodLabState {
  const index = distanceIndex(evidence, distance);
  const viewport = findViewport(evidence, viewportHeight);
  const decision = lookupDecision(evidence, findPolicy(viewport, maxPixelError, hysteresisPercent), 0, index);
  return {
    viewportHeight,
    distanceIndex: index,
    maxPixelError,
    hysteresisPercent,
    overrideLevel: null,
    shownLevel: decision.level,
    decision,
  };
}

/** Advances the lab by one interaction, carrying the shown level into the Rust lookup. */
export function reduceLodLab(
  evidence: ScreenSpaceLodEvidence,
  state: LodLabState,
  action: LodLabAction,
): LodLabState {
  const next = { ...state };
  if (action.type === "distance") next.distanceIndex = distanceIndex(evidence, action.distance);
  if (action.type === "viewport") {
    const height = fitViewportHeight(evidence, action.availableHeight);
    if (height === state.viewportHeight) return state;
    next.viewportHeight = height;
  }
  if (action.type === "policy") {
    next.maxPixelError = action.maxPixelError ?? state.maxPixelError;
    next.hysteresisPercent = action.hysteresisPercent ?? state.hysteresisPercent;
  }
  if (action.type === "override") next.overrideLevel = action.level;
  const policy = findPolicy(findViewport(evidence, next.viewportHeight), next.maxPixelError, next.hysteresisPercent);
  next.decision = lookupDecision(evidence, policy, state.shownLevel, next.distanceIndex);
  next.shownLevel = next.overrideLevel ?? next.decision.level;
  return next;
}
