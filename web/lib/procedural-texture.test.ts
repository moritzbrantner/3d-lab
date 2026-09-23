import { describe, expect, test } from "bun:test";
import {
  blendProceduralValues,
  generateProceduralRgba,
  sampleProceduralPattern,
  type ProceduralTextureRecipe,
} from "./procedural-texture";

const recipe: ProceduralTextureRecipe = {
  size: 8,
  primary: { pattern: "checker", frequency: 4, seed: 1 },
  secondary: { pattern: "noise", frequency: 6, seed: 17 },
  blendMode: "multiply",
  blendAmount: 0.45,
};

describe("procedural texture recipes", () => {
  test("generate deterministic RGBA pixels for the same recipe", () => {
    const first = generateProceduralRgba(recipe);
    const second = generateProceduralRgba(recipe);

    expect(first).toEqual(second);
    expect(first).toHaveLength(8 * 8 * 4);
    for (let index = 3; index < first.length; index += 4) {
      expect(first[index]).toBe(255);
    }
  });

  test("seed changes deterministic noise without changing the recipe shape", () => {
    const first = generateProceduralRgba(recipe);
    const changed = generateProceduralRgba({
      ...recipe,
      secondary: { pattern: "noise", frequency: 6, seed: 18 },
    });

    expect(changed).toHaveLength(first.length);
    expect(changed).not.toEqual(first);
  });

  test("blend modes remain bounded and blend amount zero preserves the primary layer", () => {
    expect(blendProceduralValues(0.8, 0.25, "multiply", 0)).toBeCloseTo(0.8);
    expect(blendProceduralValues(0.8, 0.25, "multiply", 1)).toBeCloseTo(0.2);
    expect(blendProceduralValues(0.8, 0.25, "screen", 1)).toBeCloseTo(0.85);
    expect(blendProceduralValues(0.8, 0.25, "difference", 1)).toBeCloseTo(0.55);
  });

  test("pattern sampling is stable at known coordinates", () => {
    expect(sampleProceduralPattern({ pattern: "checker", frequency: 4, seed: 0 }, 0.1, 0.1)).toBe(0.92);
    expect(sampleProceduralPattern({ pattern: "checker", frequency: 4, seed: 0 }, 0.3, 0.1)).toBe(0.24);
    expect(sampleProceduralPattern({ pattern: "dots", frequency: 4, seed: 0 }, 0.125, 0.125)).toBe(0.22);
  });
});
