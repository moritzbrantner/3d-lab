export type EditorGizmoMode = "translate" | "rotate" | "scale";
export type EditorGizmoSpace = "local" | "world";
export type EditorGizmoTargetKind = "node" | "vertex";

/**
 * Vertex handles only represent one position, so they always use translation.
 * Node handles expose the full transform tool selected by the author.
 */
export function effectiveEditorGizmoMode(
  target: EditorGizmoTargetKind,
  requested: EditorGizmoMode,
): EditorGizmoMode {
  return target === "vertex" ? "translate" : requested;
}

/**
 * Three-dimensional scale is defined on the object's local axes. Translation and
 * rotation can explicitly use either local or world axes.
 */
export function effectiveEditorGizmoSpace(
  mode: EditorGizmoMode,
  requested: EditorGizmoSpace,
): EditorGizmoSpace {
  return mode === "scale" ? "local" : requested;
}

export interface EditorGizmoDragState {
  dragging: boolean;
}

/**
 * Runtime teardown removes gizmo listeners before disposing the controls, so no
 * final `dragging-changed` event can reach the editor. End any in-flight drag
 * explicitly and publish the idle state so the UI matches the replacement
 * controls, which always start idle. Returns whether a drag was interrupted.
 */
export function endEditorGizmoDragForTeardown(
  controls: EditorGizmoDragState,
  publishDragging: (dragging: false) => void,
): boolean {
  const wasDragging = controls.dragging;
  controls.dragging = false;
  publishDragging(false);
  return wasDragging;
}
