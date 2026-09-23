// Run: bun scripts/character-pose-evidence.mjs
// Also runs with Node 22+: node --experimental-strip-types scripts/character-pose-evidence.mjs
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { CHARACTER_CYCLE_SECONDS, createCharacterPose, sampleCharacterPose,
  sampleCharacterPoseInto, stepCharacterPhase } from "../web/lib/character-rig.ts";

import { sampleCharacterPose as historicalPose } from "./fixtures/character-rig-baseline.ts";

const target = createCharacterPose();
let checked = 0;
for (const motion of ["idle", "walk", "wave"]) {
  for (let sample = -1000; sample <= 1000; sample += 1) {
    assert.equal(sampleCharacterPoseInto(motion, sample / 997, target), target);
    assert.deepEqual(target, sampleCharacterPose(motion, sample / 997));
    assert(Object.values(target).every(Number.isFinite));
    const baseline = historicalPose(motion, sample / 997);
    for (const key of Object.keys(target)) {
      const intentionallyChanged = (motion === "walk" && (key === "rootX" || key === "rootY")) ||
        (motion === "idle" && key === "rootYaw");
      if (!intentionallyChanged) assert(Math.abs(target[key] - baseline[key]) < 1e-12);
    }
    checked += 1;
  }
  const epsilon = 1e-5;
  const before = sampleCharacterPose(motion, 1 - epsilon);
  const seam = sampleCharacterPose(motion, 0);
  const after = sampleCharacterPose(motion, epsilon);
  for (const key of ["rootX", "rootY", "rootYaw"]) {
    assert(Math.abs((seam[key] - before[key]) / epsilon - (after[key] - seam[key]) / epsilon) < 0.001);
  }
}
const saved = { ...target };
for (const phase of [NaN, Infinity, -Infinity]) {
  assert.throws(() => sampleCharacterPoseInto("walk", phase, target), /finite/);
  assert.deepEqual(target, saved);
}
assert(Math.abs((stepCharacterPhase(0.3, 1) - 0.3) * CHARACTER_CYCLE_SECONDS - 1 / 60) < 1e-12);
assert.equal(stepCharacterPhase(0, -1), 0);
assert.equal(stepCharacterPhase(1, 1), 1);

// Historical main versus current reusable output. The documented seam fixes
// intentionally change root channels; unchanged channels are compared above.
const count = 240_000;
const phases = Float64Array.from({ length: 4096 }, (_, index) => index / 4096);
function measure(reuse) {
  const output = createCharacterPose();
  let checksum = 0;
  const start = performance.now();
  for (let i = 0; i < count; i += 1) {
    const phase = phases[i & 4095];
    const pose = reuse ? sampleCharacterPoseInto("walk", phase, output) : historicalPose("walk", phase);
    checksum += pose.rootX + pose.rootY + pose.rootYaw + pose.spineZ + pose.leftShoulderX +
      pose.rightShoulderX + pose.rightShoulderZ + pose.leftElbowX + pose.rightElbowX +
      pose.leftHipX + pose.rightHipX + pose.leftKneeX + pose.rightKneeX;
  }
  assert(Number.isFinite(checksum));
  return { milliseconds: performance.now() - start, checksum };
}
measure(false); measure(true);
const baseline = [], reused = [];
for (let round = 0; round < 9; round += 1) {
  const first = measure(round % 2 === 0);
  const second = measure(round % 2 !== 0);
  (round % 2 === 0 ? reused : baseline).push(first.milliseconds);
  (round % 2 === 0 ? baseline : reused).push(second.milliseconds);
}
function median(values) { return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]; }
const baselineMs = median(baseline), reusedMs = median(reused);
console.log(JSON.stringify({
  schema: "character-pose-evidence/v1", runtime: process.version,
  baselineRevision: "7889a0066df928b101d42fb16f32353bd26c0696",
  correctness: { samples: checked, outputIdentity: "pass", historicalUnchangedChannels: "pass",
    motionSwitchReset: "pass", loopSeamVelocity: "pass", invalidPhaseAtomicity: "pass", exactFrameStep: "pass" },
  work: { samplesPerRound: count, baselinePoseObjects: count, reusedPoseObjects: 1 },
  timing: { unit: "ms", rounds: 9, baselineMedian: baselineMs, reusedMedian: reusedMs,
    ratio: baselineMs / reusedMs, baseline, reused, gating: false },
  limitations: "CPU pose microbenchmark only; no GPU/frame-time or heap-byte claim. Timing is not a CI threshold.",
}, null, 2));
