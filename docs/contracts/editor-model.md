# Scene editor ownership contract

The browser scene editor is an authoring and inspection surface over the existing renderer-independent concepts. It must not turn Three.js objects into the durable scene model.

## Ownership

- `three-d-core` remains the authority for mesh positions, indices, attribute alignment, derived normals/tangents, and topology validity.
- `three-d-animation` remains the authority for ordered parent/child transforms and deterministic world-matrix evaluation.
- The browser editor owns selection, viewport interaction, editable drafts, numeric authoring controls, and presentation state.
- Three.js owns rendering, camera interaction, ray picking, and transient GPU-side geometry/material objects.

The TypeScript editor model mirrors the parts of the Rust contracts needed for a static GitHub Pages teaching surface. It is not a second renderer-independent core.

## Hierarchy rule

Editor nodes are stored parent-before-child, matching `TransformNode` ordering in `three-d-animation`. A node may reference only a parent that already appeared in the ordered scene array. This makes invalid forward references fail closed and keeps later serialization deterministic.

## Mesh editing rule

A vertex edit changes exactly one local-space position in the selected mesh draft. Indices, UVs, and vertex colors remain stable. Normals and tangents are derived surface data, so changing positions invalidates them instead of pretending the old values are still correct.

The Three.js adapter recomputes display normals for immediate shading. That recomputation is renderer presentation evidence; it does not overwrite the format-neutral mesh draft with new canonical normal or tangent attributes.

## Selection rule

Node and vertex selection are editor state, not scene semantics. Selecting a mesh or vertex must not mutate the durable hierarchy or mesh unless the user performs an explicit edit.

Ray-cast hits are translated back to node ids and indexed vertex ids. Three.js object identity is never persisted as the source of truth.

## Next boundary

Future drag gizmos should emit the same model edits as numeric controls. Undo/redo should store deterministic edit commands over model ids and values, not snapshots of Three.js objects or GPU buffers.
