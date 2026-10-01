import { describe, expect, test } from "bun:test";
import {
  effectiveEditorGizmoMode,
  effectiveEditorGizmoSpace,
  endEditorGizmoDragForTeardown,
} from "./scene-editor-gizmo";

describe("scene editor gizmo semantics", () => {
  test("vertices always use translation", () => {
    expect(effectiveEditorGizmoMode("vertex", "translate")).toBe("translate");
    expect(effectiveEditorGizmoMode("vertex", "rotate")).toBe("translate");
    expect(effectiveEditorGizmoMode("vertex", "scale")).toBe("translate");
  });

  test("nodes preserve the selected transform tool", () => {
    expect(effectiveEditorGizmoMode("node", "translate")).toBe("translate");
    expect(effectiveEditorGizmoMode("node", "rotate")).toBe("rotate");
    expect(effectiveEditorGizmoMode("node", "scale")).toBe("scale");
  });

  test("translation and rotation honor local/world space while scale stays local", () => {
    expect(effectiveEditorGizmoSpace("translate", "world")).toBe("world");
    expect(effectiveEditorGizmoSpace("rotate", "world")).toBe("world");
    expect(effectiveEditorGizmoSpace("translate", "local")).toBe("local");
    expect(effectiveEditorGizmoSpace("scale", "world")).toBe("local");
  });

  test("runtime teardown ends an in-flight drag and publishes the idle state", () => {
    const controls = { dragging: true };
    const published: boolean[] = [];
    expect(endEditorGizmoDragForTeardown(controls, (dragging) => published.push(dragging))).toBe(true);
    expect(controls.dragging).toBe(false);
    expect(published).toEqual([false]);
  });

  test("runtime teardown still publishes idle when no drag is active", () => {
    const controls = { dragging: false };
    const published: boolean[] = [];
    expect(endEditorGizmoDragForTeardown(controls, (dragging) => published.push(dragging))).toBe(false);
    expect(published).toEqual([false]);
  });
});
