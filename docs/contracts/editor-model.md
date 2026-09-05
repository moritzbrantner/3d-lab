# Scene editor ownership contract

The browser scene editor is an authoring and inspection surface over the existing renderer-independent concepts. It must not turn Three.js objects into the durable scene model.

## Ownership

- `three-d-core` remains the authority for mesh positions, indices, attribute alignment, derived normals/tangents, and topology validity.
- `three-d-animation` remains the authority for ordered parent/child transforms and deterministic world-matrix evaluation.
- The browser editor owns selection, viewport interaction, editable drafts, numeric authoring controls, and bounded edit history.
- Three.js owns rendering, camera interaction, ray picking, transform-gizmo presentation, and transient GPU-side geometry/material objects.

The TypeScript editor model mirrors the parts of the Rust contracts needed for a static GitHub Pages teaching surface. It is not a second renderer-independent core.

## Hierarchy rule

Editor nodes are stored parent-before-child, matching `TransformNode` ordering in `three-d-animation`. A node may reference only a parent that already appeared in the ordered scene array. This makes invalid forward references fail closed and keeps later serialization deterministic.

## Mesh editing rule

A vertex edit changes exactly one local-space position in the selected mesh draft. Indices, UVs, and vertex colors remain stable. Normals and tangents are derived surface data, so changing positions invalidates them instead of pretending the old values are still correct.

The Three.js adapter recomputes display normals for immediate shading. That recomputation is renderer presentation evidence; it does not overwrite the format-neutral mesh draft with new canonical normal or tangent attributes.

## Component-selection rule

Object, vertex, edge, and face selection are editor state, not scene semantics. Vertices are addressed by indexed position id, edges by a canonical sorted vertex-id pair, and faces by indexed triangle id. Selecting any of them must not mutate the durable hierarchy or mesh until an explicit edit occurs.

Ray-cast hits are translated back to those model references. Three.js object identity is never persisted as the source of truth.

## Gizmo rule

Transform controls may manipulate transient Three.js objects while a pointer drag is active, but the drag becomes durable only at the drag boundary. Node gizmos commit local translation/rotation/scale values. A selected vertex uses a child target whose committed local position becomes the indexed vertex position.

`local` and `world` describe manipulation space only. The durable model continues to store the same local transform and local vertex coordinates used by the renderer-independent contracts.

## Undo/redo rule

Undo/redo is a bounded deterministic edit-command log. Commands store model ids plus before/after values for node transforms, vertex positions, or an explicit format-neutral scene replacement. They never store Three.js objects, matrices captured from GPU state, renderer snapshots, or DOM state.

Undo applies the command's previous model value; redo reapplies its next value. Executing a new command after undo clears the redo branch. The history is bounded so a long editing session cannot grow browser memory without limit.

## Next boundary

Topology selection is now inspectable, but topology mutation remains separate. Split, inset, extrude, weld, and similar operations should first be expressed as bounded renderer-independent mesh edits with explicit validity rules before the viewport exposes them.
