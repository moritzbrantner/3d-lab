# 3d-lab roadmap

## Completed slices

### Slice 1 — fundamentals on GitHub Pages

- [x] Establish renderer-independent Rust mesh primitives.
- [x] Establish the parallel TypeScript mesh representation used by lessons.
- [x] Publish a Three.js teaching surface with topic-based interactive examples.
- [x] Cover coordinates, vertices, triangles, indexed meshes, normals, transforms, projection, lighting, and animation.
- [x] Add CI and GitHub Pages deployment.

### Slice 2 — topology and attributes

- [x] Compare per-face and per-vertex normals.
- [x] Add UV coordinates and texture mapping.
- [x] Add vertex colors and attribute interpolation.
- [x] Demonstrate triangle winding and back-face culling.
- [x] Add bounded mesh subdivision and procedural plane generation.
- [x] Validate optional normal, UV, and color buffers in both the TypeScript lesson model and `three-d-core`.

### Slice 3 — transforms and animation depth

- [x] Teach explicit translation × rotation × scale matrix composition.
- [x] Demonstrate parent/child/grandchild transform composition.
- [x] Add keyframes, interpolation/easing, playback, and reusable clips.
- [x] Compare Euler interpolation with quaternion SLERP around a 90° middle-axis rotation.
- [x] Build a three-joint skinned strip from explicit bone weights before introducing file formats.
- [x] Load a minimal glTF 2.0 translation animation with `GLTFLoader` and `AnimationMixer`.
- [x] Add renderer-independent `Mat4`, `Quat`, `Transform`, hierarchy, keyframe/clip, skeleton, and skin-influence types in Rust.

### Slice 4 — renderer comparison

- [x] Add an offscreen native Rust `wgpu` baseline that consumes `three-d-core` mesh data and submits an indexed draw without moving GPU types into the core crate.
- [x] Add a Three.js ↔ `wgpu` teaching comparison for vertex/index buffers and draw calls.
- [x] Add deterministic parity fixtures for mesh packing and matrix conventions across renderer adapters.
- [x] Compare uniforms and camera matrices across APIs using renderer-independent camera math.
- [x] Add browser WebGPU only where the comparison itself teaches something.

## Active implementation horizon

### Slice 5 — model pipeline

- [x] Expand glTF anatomy from animation-only to meshes/materials/assets.
- [x] Add OBJ and glTF mesh loading and validation.
- [x] Let the reusable browser renderer consume content-identified indexed mesh geometry without becoming a file-format or provenance authority.
- [x] Add renderer-independent tangent attributes and deterministic tangent derivation.
- [x] Preserve glTF `TANGENT` attributes and teach tangent-space normal-map shading interactively.
- [x] Preserve encoded image/texture data and glTF normal-texture bindings through `three-d-assets`.
- [x] Restore deterministic level-of-detail and mesh simplification through `three-d-lod`, preserving the source vertex/attribute buffers while deriving index buffers with explicit target/error/border semantics.
- [x] Keep the asset-tooling process adapter outside `three-d-lod`, using a narrow canonical mesh JSON integration envelope so the domain crate does not depend on workflow/provenance infrastructure.

### Slice 6 — authoring and inspection

- [x] Add an interactive scene editor with node-hierarchy selection, viewport mesh picking, vertex handles, transform editing, and direct vertex-position editing.
- [x] Add drag gizmos for node transforms and selected vertices with explicit local/world coordinate modes and one semantic command per completed drag.
- [x] Add face and edge selection plus bounded split, inset, and extrude operations backed by deterministic topology deltas.
- [x] Add undo/redo as a deterministic semantic edit-command log instead of renderer or scene snapshots.
- [ ] Add format-neutral scene snapshot import/export before teaching glTF authoring round-trips.

### Slice 7 — procedural character animation

- [ ] Add renderer-independent analytical two-bone IK for arms and legs with explicit target, pole-vector, reach, and joint-limit semantics.
- [ ] Add weighted post-sampling pose constraints so authored/keyframed animation remains the base pose and procedural correction can blend in and out without becoming gameplay authority.
- [ ] Add foot/limb placement that consumes external world-contact samples (position, normal, support identity) without making `three-d-animation` depend on a physics engine.
- [ ] Add authored contact/plant metadata, world-space foot locking, pelvis/body-height correction, and surface-normal alignment for stable walking on slopes, stairs, and uneven ground.
- [ ] Add predictive swing/landing targets and bounded motion-warping primitives for interactions, attacks, vaults, and other target-relative animation while keeping authoritative movement outside the animation runtime.
- [ ] Generalize proven constraint primitives to hand grips, look-at/aim constraints, quadruped limbs, and longer chains only after the two-bone/contact contracts are stable.
- [ ] Add an interactive uneven-ground/stair acceptance lab plus deterministic pose/constraint fixtures so render adapters can share the same semantics.

### Texture authoring foundation

- [x] Preserve renderer-independent texture offset/scale/rotation intent on material texture bindings without moving renderer APIs into `three-d-assets`.
- [x] Add deterministic procedural texture synthesis and layer blending to the browser teaching surface.
- [x] Make stretching visible with independent U/V repeat, rotation/offset controls, object-axis stretch, and a deliberately narrow plane texel-density compensation example.
- [ ] Import and export glTF `KHR_texture_transform` explicitly once extension round-tripping is covered by fixtures.
- [ ] Route procedural recipe baking through `asset-tooling` with content-derived provenance/cache keys instead of keeping recipes inside renderer state.
- [ ] Compare authored UVs with box/triplanar projection on representative consumer assets before deciding whether runtime projection belongs in the reusable renderer.

### Cross-cutting performance foundation

- [x] Record deterministic scene-normalization work facts such as source/materialized vertices, visited indices, and materialized attribute values.
- [x] Preserve normalized-scene provenance so downstream export can reuse canonical buffers rather than normalizing and materializing them again.
- [x] Add an observable GLB-export boundary that reports whether export had to perform normalization.
- [x] Add a deterministic release-mode scene-export workload and exact-base/candidate `runtime-profiler` evidence in pull requests.
- [x] Add a browser journey for reusable Three.js renderer hot paths and resource/object reuse once the first runtime canary has stable repeated evidence.
- [x] Add deterministic renderer work observations for node visits, object/resource creation, reuse, and eviction without moving renderer authority into performance tooling.
- [x] Add seven-sample unchanged-source renderer-browser calibration with fail-closed source/runtime identity, machine-readable spread statistics, and scheduled recalibration.
- [x] Add a representative editor transform/vertex-mutation workload and structural-sharing hot path so local edits do not rematerialize or revalidate unrelated scene and mesh data.
- [x] Extend the editor mutation workload through deterministic command-log execution plus full vertex-edit undo/redo round-trips.
- [x] Add topology structural work budgets, deterministic topology runtime evidence, and weekly same-surface runtime calibration.
- [x] Replace per-operation flat topology rematerialization with persistent vertex/attribute chunks and localized triangle chunks; materialize contiguous `IndexedMesh` data only at explicit compatibility/render/export boundaries.
- [x] Replace repeated full topology adjacency rebuilds with a lazily built vertex-incidence cache that follows localized chunk replacements and undo/redo without entering semantic history.
- [ ] Reduce renderer-side full topology materialization and whole `BufferGeometry` replacement where browser evidence shows it is material.
- [ ] After at least four independent same-surface calibration runs, review robust MAD-derived wall-time/RSS margins and move the accepted policy into an evaluator-owned confirmation gate.
