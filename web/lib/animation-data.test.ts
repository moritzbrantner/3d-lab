import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ADVANCED_STATE,
  KEYFRAME_POSITIONS,
  KEYFRAME_TIMES,
  MINIMAL_ANIMATED_GLTF,
} from "./animation-data";

describe("animation lesson data", () => {
  test("keyframe times are strictly increasing and aligned with values", () => {
    expect(KEYFRAME_TIMES).toHaveLength(KEYFRAME_POSITIONS.length);
    for (let index = 1; index < KEYFRAME_TIMES.length; index += 1) {
      expect(KEYFRAME_TIMES[index]).toBeGreaterThan(KEYFRAME_TIMES[index - 1]);
    }
  });

  test("embedded glTF is a minimal translation animation", () => {
    const gltf = JSON.parse(MINIMAL_ANIMATED_GLTF) as {
      asset: { version: string };
      animations: Array<{ channels: Array<{ target: { path: string } }> }>;
      buffers: Array<{ byteLength: number; uri: string }>;
    };

    expect(gltf.asset.version).toBe("2.0");
    expect(gltf.animations).toHaveLength(1);
    expect(gltf.animations[0]?.channels[0]?.target.path).toBe("translation");
    expect(gltf.buffers[0]?.byteLength).toBe(48);
    expect(gltf.buffers[0]?.uri.startsWith("data:application/octet-stream;base64,")).toBe(true);
  });

  test("interactive defaults stay inside lesson control bounds", () => {
    expect(DEFAULT_ADVANCED_STATE.keyframeTime).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_ADVANCED_STATE.keyframeTime).toBeLessThanOrEqual(2);
    expect(DEFAULT_ADVANCED_STATE.rotationT).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_ADVANCED_STATE.rotationT).toBeLessThanOrEqual(1);
    expect(Math.abs(DEFAULT_ADVANCED_STATE.skeletonBend)).toBeLessThanOrEqual(80);
  });
});