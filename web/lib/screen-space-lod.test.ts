import { describe, expect, test } from "bun:test";
import {
  distanceAt,
  distanceIndex,
  findPolicy,
  findViewport,
  fitViewportHeight,
  hysteresisPercents,
  initialLodLabState,
  lookupDecision,
  parseScreenSpaceLodEvidence,
  pixelBudgets,
  reduceLodLab,
  replayDecisions,
  screenSpaceLodEvidence as evidence,
  viewportHeights,
} from "./screen-space-lod";

const tall = findViewport(evidence, 720);

const allIndices = Array.from({ length: evidence.distances.count }, (_, index) => index);

describe("Rust screen-space LOD evidence", () => {
  test("describes a source mesh plus strictly coarser simplified levels", () => {
    expect(evidence.simplifierId).toStartWith("meshopt-");
    evidence.levels.slice(1).forEach((level, offset) => {
      const finer = evidence.levels[offset];
      expect(level.triangleCount).toBeLessThan(finer.triangleCount);
      expect(level.geometricError).toBeGreaterThanOrEqual(finer.geometricError);
    });
  });

  test("source normals point away from the centre, so winding is outward", () => {
    for (let vertex = 0; vertex < evidence.positions.length; vertex += 3) {
      const dot = evidence.positions[vertex] * evidence.normals[vertex]
        + evidence.positions[vertex + 1] * evidence.normals[vertex + 1]
        + evidence.positions[vertex + 2] * evidence.normals[vertex + 2];
      expect(dot).toBeGreaterThan(0);
    }
  });

  test("covers every budget and hysteresis combination the lab offers", () => {
    for (const budget of pixelBudgets(evidence)) {
      for (const hysteresis of hysteresisPercents(evidence)) {
        for (const viewport of evidence.viewports) {
          expect(findPolicy(viewport, budget, hysteresis).maxPixelError).toBe(budget);
        }
      }
    }
    expect(() => findPolicy(tall, 3, 0)).toThrow();
  });

  test("rejects documents with a different schema or truncated tables", () => {
    expect(() => parseScreenSpaceLodEvidence({ ...evidence, schema: "other" })).toThrow();
    const [firstViewport, ...otherViewports] = evidence.viewports;
    const [first, ...rest] = firstViewport.policies;
    const truncated = { ...first, idealLevel: first.idealLevel.slice(1) };
    const broken = { ...firstViewport, policies: [truncated, ...rest] };
    expect(() => parseScreenSpaceLodEvidence({ ...evidence, viewports: [broken, ...otherViewports] })).toThrow();
    expect(() => parseScreenSpaceLodEvidence({ ...evidence, viewports: [...otherViewports, firstViewport] })).toThrow();
  });

  test("snaps arbitrary distances onto the evidence grid", () => {
    const last = evidence.distances.count - 1;
    expect(distanceIndex(evidence, evidence.distances.min)).toBe(0);
    expect(distanceAt(evidence, distanceIndex(evidence, 7.26))).toBe(7.3);
    expect(distanceIndex(evidence, -5)).toBe(0);
    expect(distanceIndex(evidence, 1e6)).toBe(last);
  });

  test("replaying the Rust tables reproduces the Rust sweep switch distances", () => {
    for (const policy of evidence.viewports.flatMap((viewport) => viewport.policies)) {
      const outbound = replayDecisions(evidence, policy, 0, allIndices);
      const outSwitches = outbound.flatMap((decision, index) => {
        const previous = index === 0 ? 0 : outbound[index - 1].level;
        return decision.level === previous ? [] : [{ distanceIndex: index, from: previous, to: decision.level }];
      });
      expect(outSwitches).toEqual(policy.outboundSwitches);

      const farLevel = outbound.at(-1)!.level;
      const reversed = [...allIndices].reverse();
      const inbound = replayDecisions(evidence, policy, farLevel, reversed);
      const inSwitches = inbound.flatMap((decision, step) => {
        const previous = step === 0 ? farLevel : inbound[step - 1].level;
        return decision.level === previous ? [] : [{ distanceIndex: reversed[step], from: previous, to: decision.level }];
      });
      expect(inSwitches).toEqual(policy.inboundSwitches);
    }
  });

  test("hysteresis keeps a level while jittering across its ideal threshold", () => {
    const threshold = findPolicy(tall, 2, 0).outboundSwitches[0];
    const jitter = Array.from({ length: 20 }, (_, frame) => threshold.distanceIndex + (frame % 2 === 0 ? 2 : -2));
    const withoutBand = replayDecisions(evidence, findPolicy(tall, 2, 0), threshold.from, jitter);
    const withBand = replayDecisions(evidence, findPolicy(tall, 2, 25), threshold.from, jitter);
    expect(new Set(withoutBand.map((decision) => decision.level)).size).toBe(2);
    expect(new Set(withBand.map((decision) => decision.level))).toEqual(new Set([threshold.from]));
    expect(withBand.some((decision) => decision.idealLevel !== decision.level)).toBe(true);
  });

  test("exposes Rust reason codes for every decision", () => {
    const policy = findPolicy(tall, 1, 10);
    const decision = lookupDecision(evidence, policy, evidence.levels.length - 1, 0);
    expect(decision).toEqual({ level: 0, idealLevel: 0, reason: "refined" });
    expect(() => lookupDecision(evidence, policy, evidence.levels.length, 0)).toThrow();
  });
});

describe("viewport height", () => {
  test("Rust evaluates several canvas heights, and the lab snaps to the tallest that fits", () => {
    expect(viewportHeights(evidence)).toEqual([360, 540, 720]);
    expect(fitViewportHeight(evidence, 1000)).toBe(720);
    expect(fitViewportHeight(evidence, 720)).toBe(720);
    expect(fitViewportHeight(evidence, 719)).toBe(540);
    expect(fitViewportHeight(evidence, 400)).toBe(360);
    expect(fitViewportHeight(evidence, 200)).toBe(360);
    expect(() => findViewport(evidence, 600)).toThrow();
  });

  test("a shorter canvas reads its own Rust tables, so switches happen nearer the camera", () => {
    const short = findViewport(evidence, 360);
    const shortSwitch = findPolicy(short, 2, 25).outboundSwitches[0];
    const tallSwitch = findPolicy(tall, 2, 25).outboundSwitches[0];
    expect(shortSwitch.distanceIndex).toBeLessThan(tallSwitch.distanceIndex);
    // Projected error at 360 px is half of the 720 px value (Rust-computed, only compared here).
    expect(short.projectedErrorPixels[100][1]).toBeCloseTo(tall.projectedErrorPixels[100][1] / 2, 4);
  });

  test("resizing re-looks up the decision in the matching table, carrying the shown level", () => {
    const tallSwitch = findPolicy(tall, 2, 25).outboundSwitches[0];
    const between = distanceAt(evidence, tallSwitch.distanceIndex - 1);
    let state = initialLodLabState(evidence, 720, between, 2, 25);
    expect(state.shownLevel).toBe(tallSwitch.from);
    state = reduceLodLab(evidence, state, { type: "viewport", availableHeight: 500 });
    expect(state.viewportHeight).toBe(360);
    const short = findPolicy(findViewport(evidence, 360), 2, 25);
    expect(state.decision).toEqual(lookupDecision(evidence, short, tallSwitch.from, state.distanceIndex));
    expect(state.shownLevel).toBeGreaterThan(tallSwitch.from);
    const unchanged = reduceLodLab(evidence, state, { type: "viewport", availableHeight: 530 });
    expect(unchanged).toBe(state);
  });
});

describe("LOD lab state", () => {
  test("carries the shown level so hysteresis holds while dollying back", () => {
    const policy = findPolicy(tall, 2, 25);
    const [coarsen] = policy.outboundSwitches;
    let state = initialLodLabState(evidence, 720, distanceAt(evidence, coarsen.distanceIndex - 1), 2, 25);
    expect(state.shownLevel).toBe(coarsen.from);
    state = reduceLodLab(evidence, state, { type: "distance", distance: distanceAt(evidence, coarsen.distanceIndex) });
    expect(state.shownLevel).toBe(coarsen.to);
    expect(state.decision.reason).toBe("coarsened");
    state = reduceLodLab(evidence, state, { type: "distance", distance: distanceAt(evidence, coarsen.distanceIndex - 1) });
    expect(state.shownLevel).toBe(coarsen.to);
    expect(state.decision.reason).toBe("kept");
  });

  test("manual override pins the level and auto resumes from it", () => {
    let state = initialLodLabState(evidence, 720, 3, 2, 25);
    state = reduceLodLab(evidence, state, { type: "override", level: 3 });
    expect(state.shownLevel).toBe(3);
    state = reduceLodLab(evidence, state, { type: "override", level: null });
    expect(state.decision).toEqual(lookupDecision(evidence, findPolicy(tall, 2, 25), 3, state.distanceIndex));
    expect(state.shownLevel).toBe(state.decision.level);
  });
});
