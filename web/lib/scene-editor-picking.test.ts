import { describe, expect, test } from "bun:test";
import { shouldSelectVertexHit, VERTEX_OCCLUSION_TOLERANCE } from "./scene-editor-picking";

describe("scene editor picking", () => {
  test("accepts a vertex when no mesh surface is hit", () => {
    expect(shouldSelectVertexHit(2.5, null)).toBe(true);
  });

  test("accepts a vertex on the visible surface within depth tolerance", () => {
    expect(shouldSelectVertexHit(2.5, 2.5)).toBe(true);
    expect(shouldSelectVertexHit(2.5 + VERTEX_OCCLUSION_TOLERANCE, 2.5)).toBe(true);
  });

  test("rejects a vertex hidden behind the nearest mesh surface", () => {
    expect(shouldSelectVertexHit(2.5 + VERTEX_OCCLUSION_TOLERANCE + 0.001, 2.5)).toBe(false);
  });

  test("fails closed for invalid ray distances", () => {
    expect(shouldSelectVertexHit(Number.NaN, 2.5)).toBe(false);
    expect(shouldSelectVertexHit(-1, 2.5)).toBe(false);
    expect(shouldSelectVertexHit(2.5, Number.POSITIVE_INFINITY)).toBe(false);
  });
});
