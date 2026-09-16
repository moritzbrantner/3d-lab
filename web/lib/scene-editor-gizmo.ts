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
