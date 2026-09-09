import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { allLodLevels, type LodFixture } from "./lod-fixture";
import { selectLodLevel } from "./lod-selection";

const fixtureUrl = new URL("../public/generated/lod-fixture.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8")) as LodFixture;

describe("Rust-generated LOD fixture", () => {
  test("coarser levels use fewer triangles and do not report less geometric error", () => {
    const levels = allLodLevels(fixture);
    for (let level = 1; level < levels.length; level += 1) {
      expect(levels[level].triangleCount).toBeLessThan(levels[level - 1].triangleCount);
      expect(levels[level].relativeError).toBeGreaterThanOrEqual(levels[level - 1].relativeError);
    }
  });

  test("browser selection reproduces the Rust hysteresis transition samples", () => {
    const relativeErrors = allLodLevels(fixture).map((level) => level.relativeError);
    const policy = {
      targetPixelError: fixture.selector.targetPixelError,
      hysteresisFraction: fixture.selector.hysteresisFraction,
    };

    for (const sample of fixture.selector.samples) {
      const selection = selectLodLevel(relativeErrors, sample.previousLevel, policy, {
        meshExtent: fixture.meshExtent,
        distance: sample.distance,
        viewportHeightPixels: fixture.selector.viewportHeightPixels,
        verticalFovRadians: fixture.selector.verticalFovRadians,
      });
      expect(selection.level).toBe(sample.selectedLevel);
      expect(selection.projectedErrorPixels).toBeCloseTo(sample.projectedErrorPixels, 4);
    }
  });

  test("generated indices always reference the shared source vertex buffer", () => {
    const vertexCount = fixture.positions.length;
    for (const level of allLodLevels(fixture)) {
      expect(level.indices.length % 3).toBe(0);
      expect(level.indices.every((index) => Number.isInteger(index) && index >= 0 && index < vertexCount)).toBeTrue();
    }
  });
});
