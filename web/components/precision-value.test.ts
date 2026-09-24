import { test } from "node:test";
import assert from "node:assert/strict";
import {
  finishNumericDraft,
  formatNumericValue,
  nudgeNumericValue,
  numericDraftNudgeValue,
  parseNumericValue,
  quantizeCoarseValue,
  rebaseNumericDraft,
} from "./precision-value";

const angles = { min: -180, max: 180 };

test("exact fractional and negative values are independent of coarse slider steps", () => {
  assert.equal(parseNumericValue("-36.125", angles), -36.125);
  assert.equal(parseNumericValue("333.25", { min: 280, max: 700 }), 333.25);
  assert.equal(parseNumericValue("0.12345", { min: 0, max: 1 }), 0.12345);
  assert.equal(parseNumericValue("3.125", { min: 0.5, max: 8 }), 3.125);
  assert.equal(parseNumericValue("-36,125", angles), -36.125);
  assert.equal(parseNumericValue("1e-3", angles), 0.001);
});

test("incomplete drafts and nonfinite numbers never become model values", () => {
  for (const text of ["", " ", "-", ".", "1e", "NaN", "Infinity", "1e309", "0x10", "1,2,3"]) {
    assert.equal(parseNumericValue(text, angles), null, text);
    assert.deepEqual(finishNumericDraft({ baseline: 0, text }, 0, angles), { kind: "invalid" });
  }
});

test("bounds are inclusive and integer constraints are explicit", () => {
  assert.equal(parseNumericValue("-180", angles), -180);
  assert.equal(parseNumericValue("180", angles), 180);
  assert.equal(parseNumericValue("180.001", angles), null);
  const count = { min: 0, max: 8, integer: true };
  assert.equal(parseNumericValue("2.5", count), null);
  assert.equal(parseNumericValue("8", count), 8);
});

test("drafts commit exactly once and stale drafts cannot overwrite external state", () => {
  assert.deepEqual(finishNumericDraft({ baseline: 34, text: "34.125" }, 34, angles), { kind: "commit", value: 34.125 });
  assert.deepEqual(finishNumericDraft(null, 34.125, angles), { kind: "idle" });
  assert.deepEqual(finishNumericDraft({ baseline: 34, text: "-12.75" }, 45, angles), { kind: "stale" });
});

test("active edits preserve typed text while rebasing external publications", () => {
  const current = 17.25;
  const rebased = rebaseNumericDraft({ baseline: 16.9, text: "14.1", dirty: true }, current);
  assert.deepEqual(rebased, { baseline: current, text: "14.1", dirty: true });
  assert.deepEqual(finishNumericDraft(rebased, current, { min: 0, max: 100 }), {
    kind: "commit",
    value: 14.1,
  });
  assert.equal(numericDraftNudgeValue(rebased, current, { min: 0, max: 100 }), 14.1);
});

test("focus-only drafts never roll an external publication back", () => {
  const current = 17.25;
  const rebased = rebaseNumericDraft({ baseline: 16.9, text: "16.9", dirty: false }, current);
  assert.deepEqual(rebased, { baseline: current, text: "16.9", dirty: false });
  assert.deepEqual(finishNumericDraft(rebased, current, { min: 0, max: 100 }), { kind: "idle" });
  assert.equal(numericDraftNudgeValue(rebased, current, { min: 0, max: 100 }), current);
});

test("human-facing formatting removes conversion noise without snapping meaningful precision", () => {
  assert.equal(formatNumericValue(0.141 * 100), "14.1");
  assert.equal(formatNumericValue(0.1 + 0.2), "0.3");
  const precise = 14.123456789012344;
  assert.equal(formatNumericValue(precise), String(precise));
  assert.equal(formatNumericValue(-0), "0");
});

test("keyboard nudges retain off-grid fractions and stop at bounds", () => {
  assert.equal(nudgeNumericValue(0.1, 0.2, angles), 0.3);
  assert.equal(nudgeNumericValue(-36.125, 0.1, angles), -36.025);
  assert.equal(nudgeNumericValue(179.95, 0.1, angles), 180);
  assert.equal(nudgeNumericValue(7.8, 1, { min: 0, max: 8, integer: true }), 8);
});

test("coarse pointer adjustments quantize without changing exact-entry semantics", () => {
  assert.equal(quantizeCoarseValue(337.8, 20, { min: 300, max: 1400 }), 340);
  assert.equal(quantizeCoarseValue(0.126, 0.05, { min: 0, max: 1 }), 0.15);
  assert.equal(quantizeCoarseValue(-36.125, 5, angles), -35);
  assert.equal(quantizeCoarseValue(4.4, 1, { min: 2, max: 5, integer: true }), 4);
});
