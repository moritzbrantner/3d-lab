/**
 * Read-only access to Rust-generated screen-space LOD evidence.
 *
 * `three-d-lod` owns simplification and selection. This module only validates
 * the committed evidence document and looks decisions up in it; it never
 * projects errors or applies hysteresis itself.
 */
import rawEvidence from "../../fixtures/lod/screen-space-lod.json";

export const SCREEN_SPACE_LOD_SCHEMA = "3d-lab.screen-space-lod-evidence.v1";

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

export type ScreenSpaceLodEvidence = {
  schema: string;
  generator: string;
  simplifierId: string;
  meshExtent: number;
  positions: number[];
  normals: number[];
  levels: LodLevelEvidence[];
  view: { viewportHeightPixels: number; verticalFovDegrees: number; distanceFrom: string };
  distances: { min: number; step: number; count: number };
  projectedErrorPixels: number[][];
  reasonCodes: Record<string, SelectionReason>;
  policies: LodPolicyEvidence[];
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
  if (evidence.projectedErrorPixels.length !== count) fail("projected error sample count");
  if (evidence.projectedErrorPixels.some((row) => row.length !== levelCount)) fail("projected error level count");
  for (const policy of evidence.policies) {
    const rows = [policy.idealLevel, ...policy.selectedLevelByPrevious, ...policy.reasonByPrevious];
    if (policy.selectedLevelByPrevious.length !== levelCount || policy.reasonByPrevious.length !== levelCount) {
      fail("policy tables must cover every previous level");
    }
    if (rows.some((row) => row.length !== count)) fail("policy tables must cover every distance sample");
  }
  return evidence;
}

export const screenSpaceLodEvidence = parseScreenSpaceLodEvidence(rawEvidence);

export function pixelBudgets(evidence: ScreenSpaceLodEvidence): number[] {
  return [...new Set(evidence.policies.map((policy) => policy.maxPixelError))];
}

export function hysteresisPercents(evidence: ScreenSpaceLodEvidence): number[] {
  return [...new Set(evidence.policies.map((policy) => policy.hysteresisPercent))];
}

export function findPolicy(
  evidence: ScreenSpaceLodEvidence,
  maxPixelError: number,
  hysteresisPercent: number,
): LodPolicyEvidence {
  const policy = evidence.policies.find(
    (candidate) => candidate.maxPixelError === maxPixelError && candidate.hysteresisPercent === hysteresisPercent,
  );
  if (!policy) throw new Error(`No Rust evidence for ${maxPixelError} px / ${hysteresisPercent}%`);
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
