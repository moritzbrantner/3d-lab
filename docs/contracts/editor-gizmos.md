# Editor drag-gizmo boundary

The scene editor treats drag gizmos as an input adapter over the semantic edit-command model, not as authoritative scene state.

## Coordinate semantics

- Node translation and rotation can use explicit `local` or `world` axes.
- Node scale is always local because scale belongs to the object's local basis.
- A selected vertex is position-only, so its gizmo is always translation. `local` aligns the axes with the owning mesh; `world` aligns them with the world basis.

These rules live in `web/lib/scene-editor-gizmo.ts` and are independent of Three.js.

## Drag transaction

`TransformControls` owns only the temporary visual preview between pointer-down and pointer-up. During a drag:

1. Orbit controls are disabled so camera input cannot compete with the gizmo.
2. Node transforms change only on the Three.js object used for preview.
3. Vertex motion changes only the temporary vertex-buffer preview and vertex handle.
4. No pointer-move sample is appended to editor history.
5. Pointer release commits exactly one existing semantic transform or vertex command.
6. `Escape` resets the temporary preview and commits nothing.

Undo therefore returns to the drag-start state in one operation. Renderer objects, matrices, and snapshots never enter the command log.

## Authority

The format-neutral editor scene and deterministic command log remain authoritative. Three.js owns rendering, ray picking, and drag interaction mechanics only. Once a drag commits, the normal scene-to-renderer synchronization path rewrites the preview from authoritative editor state.
