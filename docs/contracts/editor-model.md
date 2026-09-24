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

## Scene snapshot boundary

The editor's portable snapshot format is versioned as `3d-lab/editor-scene-snapshot/v1`. It serializes the ordered node hierarchy, local transforms, indexed mesh data, and format-neutral vertex attributes only.

Snapshot export is deterministic for the same editor scene: parent-before-child node order is preserved and persistent topology state is materialized only at this explicit compatibility boundary. Selection, gizmo mode, camera state, undo/redo commands, topology caches, Three.js objects, and GPU resources are not serialized.

Snapshot import is a trust boundary. The decoder rejects unknown schema versions and unsupported fields, validates tuple shapes and finite numeric data, then runs the authoritative scene/mesh validation before replacing editor state. A successful import starts a fresh semantic command log; malformed input leaves the current scene unchanged.

## Next boundary

glTF authoring round-trips should be adapters over this format-neutral scene boundary. File-format accessors, buffer views, node indices, and renderer objects must not become the editor's durable source of truth.
