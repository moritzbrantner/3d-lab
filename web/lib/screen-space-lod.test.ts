import { describe, expect, test } from "bun:test";
import {
  distanceAt,
  distanceIndex,
  findPolicy,
  hysteresisPercents,
  lookupDecision,
  parseScreenSpaceLodEvidence,
  pixelBudgets,
  replayDecisions,
  screenSpaceLodEvidence as evidence,
} from "./screen-space-lod";

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
        expect(findPolicy(evidence, budget, hysteresis).maxPixelError).toBe(budget);
      }
    }
    expect(() => findPolicy(evidence, 3, 0)).toThrow();
  });

  test("rejects documents with a different schema or truncated tables", () => {
    expect(() => parseScreenSpaceLodEvidence({ ...evidence, schema: "other" })).toThrow();
    const [first, ...rest] = evidence.policies;
    const truncated = { ...first, idealLevel: first.idealLevel.slice(1) };
    expect(() => parseScreenSpaceLodEvidence({ ...evidence, policies: [truncated, ...rest] })).toThrow();
  });

  test("snaps arbitrary distances onto the evidence grid", () => {
    const last = evidence.distances.count - 1;
    expect(distanceIndex(evidence, evidence.distances.min)).toBe(0);
    expect(distanceAt(evidence, distanceIndex(evidence, 7.26))).toBe(7.3);
    expect(distanceIndex(evidence, -5)).toBe(0);
    expect(distanceIndex(evidence, 1e6)).toBe(last);
  });

  test("replaying the Rust tables reproduces the Rust sweep switch distances", () => {
    for (const policy of evidence.policies) {
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
    const threshold = findPolicy(evidence, 2, 0).outboundSwitches[0];
    const jitter = Array.from({ length: 20 }, (_, frame) => threshold.distanceIndex + (frame % 2 === 0 ? 2 : -2));
    const withoutBand = replayDecisions(evidence, findPolicy(evidence, 2, 0), threshold.from, jitter);
    const withBand = replayDecisions(evidence, findPolicy(evidence, 2, 25), threshold.from, jitter);
    expect(new Set(withoutBand.map((decision) => decision.level)).size).toBe(2);
    expect(new Set(withBand.map((decision) => decision.level))).toEqual(new Set([threshold.from]));
    expect(withBand.some((decision) => decision.idealLevel !== decision.level)).toBe(true);
  });

  test("exposes Rust reason codes for every decision", () => {
    const policy = findPolicy(evidence, 1, 10);
    const decision = lookupDecision(evidence, policy, evidence.levels.length - 1, 0);
    expect(decision).toEqual({ level: 0, idealLevel: 0, reason: "refined" });
    expect(() => lookupDecision(evidence, policy, evidence.levels.length, 0)).toThrow();
  });
});
