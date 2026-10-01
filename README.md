# 3d-lab

`3d-lab` is an interactive learning repository for 3D fundamentals: vertices, triangles, indexed meshes, attributes, normals, tangents, transforms, cameras, lighting, procedural geometry, animation, skinning, asset pipelines, and scene authoring.

The repository deliberately has parallel surfaces:

- **Reusable browser renderer / `@moritzbrantner/three-d-renderer`** — concrete Three.js scene/GPU adaptation for downstream applications. It consumes authoritative camera/model matrices and stable scene-node data instead of owning simulation, camera, or transform semantics.
- **Web / Three.js** — visual, interactive lessons and an authoring/inspection surface that can be published with GitHub Pages and dogfoods the reusable renderer contract.
- **Rust / `three-d-core`** — renderer-independent mesh geometry, topology, normals, UVs, and tangent-space derivation.
- **Rust / `three-d-animation`** — renderer-independent matrices, transforms, animation tracks/clips, and skeletal data.
- **Rust / `three-d-playback`** — frame-rate-independent playback clocks (clamp/loop, forward/reverse), wall-time transition progress, and deterministic cross-fades on top of `three-d-animation`.
- **Rust / `three-d-rigged-assets`** — renderer-independent composition of skeletons, skin influences, animation clips, and joint-local primitive collision proxies, including deterministic bind-pose proxy fitting. It does not own physics simulation or asset-generation provenance.
- **Rust / `three-d-camera`** — renderer-independent right-handed view plus perspective and orthographic WebGPU-depth camera matrices.
- **Rust / `three-d-assets`** — renderer-independent asset meshes, PBR material factors, encoded texture resources, normal-map bindings, and cross-resource validation.
- **Rust / `three-d-formats`** — loss-aware OBJ/glTF decoding adapters that normalize supported file semantics into `three-d-assets`.
- **Rust / `three-d-lod`** — deterministic mesh simplification and source-based LOD derivation using meshopt while preserving the source vertex/attribute buffers, plus screen-space LOD selection by projected pixel error with hysteresis.
- **Native / `wgpu` example** — a narrow renderer-comparison adapter that consumes the Rust mesh and camera models without moving GPU ownership into the core crates.
- **Asset-tooling LOD adapter example** — a narrow process adapter that exposes `three-d-lod` through a canonical position/index mesh JSON envelope without moving asset-tooling ownership into the LOD crate.
- **Asset-tooling humanoid adapter example** — a narrow process adapter that validates production humanoid hierarchy, semantic bone IDs, Root/Hips separation, rest pose, and attachment sockets through `three-d-animation` without moving those semantics into workflow/provenance tooling.
- **Asset-tooling rigged-collision adapter example** — a narrow process adapter that exposes deterministic bind-pose joint collision fitting from `three-d-rigged-assets`; it transports data and observations without taking over fitting or physics authority.
- **Raw browser WebGPU experiment** — one intentionally tiny indexed draw that exposes browser GPU setup without replacing Three.js as the primary browser renderer.

The reusable browser renderer is intentionally Three.js-first. The Rust core crates do not depend on Three.js, WebGL, WebGPU, a windowing stack, or a glTF/OBJ parser; rendering and file-format adapters stay downstream of the renderer-independent models. Applications such as Zoo should consume the renderer package rather than constructing a parallel Three.js/CSS renderer, while still keeping their game-specific scene composition and interaction policy outside 3d-lab.

This authority is deliberately **3D-only**. `3d-lab` is not the shared home for ordinary flat-map rendering or general 2D vector rasterization. Products such as Maps keep their 2D map render planning/backends authoritative, while `2d-lab` may benchmark 2D Rust/WASM techniques without becoming a scene authority.

## Curriculum

The GitHub Pages curriculum currently covers:

1. Coordinate systems
2. Vertices
3. Triangles
4. Indexed meshes
5. Normals
6. Transforms
7. Perspective vs. orthographic projection
8. Lighting
9. Animation loops
10. Flat vs. smooth normals
11. UV coordinates and texture mapping
12. Vertex colors and attribute interpolation
13. Triangle winding and back-face culling
14. Mesh subdivision and procedural generation
15. Explicit 4×4 matrix composition
16. Parent/child transform hierarchies
17. Keyframes, interpolation, easing, playback, and reusable clips
18. Euler angles vs. quaternion SLERP
19. Skeletons, joints, weights, and skinning
20. A minimal glTF 2.0 animation loaded through Three.js
21. Three.js versus native `wgpu` renderer responsibilities
22. Raw browser WebGPU pipeline setup for one indexed draw
23. glTF scene/node/mesh/primitive/accessor/buffer/material anatomy
24. OBJ and glTF decoding into one renderer-independent asset model
25. Tangent derivation, handedness, and tangent-space normal-map shading
26. Scene hierarchy inspection, mesh picking, vertex selection, and direct vertex/transform authoring
27. Screen-space LOD selection with pixel-error budgets, hysteresis, and wireframe comparison
28. Versioned format-neutral scene snapshot import/export with strict trust-boundary validation
29. Frame-rate-independent playback timing and cross-fades across uneven frame partitions

Every topic combines a concise explanation with an interactive scene and a small data inspector. The Rust side mirrors the durable, renderer-independent concepts rather than wrapping Three.js APIs or asset-file structures.

## Development

### Rust

```bash
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
```

Run the native `wgpu` comparison on a machine with a supported graphics adapter:

```bash
cargo run -p three-d-wgpu-example
```

The asset-tooling integration adapters remain separate from the authoritative domain crates:

```bash
cargo run -p asset-tooling-lod-adapter -- probe
cargo run -p asset-tooling-humanoid-adapter -- probe
cargo run -p asset-tooling-rigged-collision-adapter -- probe
```

Regenerate the screen-space LOD evidence used by the web lab after changing `three-d-lod` (`cargo test` fails on drift):

```bash
cargo run -p three-d-lod --example screen_space_lod_evidence
```

### Reusable browser renderer

The repository root is the reusable package. Downstream consumers should pin an exact accepted repository revision rather than a branch tip.

```bash
bun install
```

The renderer receives explicit view/projection and model matrices. It must not become an alternate authority for camera, transform, simulation, placement, or physics semantics.

Repeated content can be submitted as instance batches (one draw call per batch); see [`docs/contracts/performance-observability.md`](docs/contracts/performance-observability.md#instance-batches).

Cosmetic impact/puff effects can be submitted as bounded baked flipbooks (`frame.effects`); fixed-time frame sampling is also available renderer-independently from `@moritzbrantner/three-d-renderer/flipbook`. See [`docs/contracts/browser-renderer.md`](docs/contracts/browser-renderer.md#cosmetic-flipbook-effects).

### Web

```bash
bun install
cd web
bun install
bun run typecheck
bun test
bun run build
```

Then run `bun run dev` for the local teaching site.

The playback timing lab reads committed Rust evidence. Regenerate it after changing `three-d-playback`, and optionally run its Chromium smoke against a served build:

```bash
cargo run -p three-d-playback --example playback_timing_evidence
bun scripts/playback-timing-browser-smoke.mjs http://127.0.0.1:4173/animation-timing/
```

The skeletal animation lab has an "Inspect rig, clip & weights" topic (joint picking, exact transforms, clip range and weight views). Run its Chromium smoke against a served build:

```bash
bun scripts/skeletal-inspection-browser-smoke.mjs http://127.0.0.1:4173/skeletal-animation/
```

## Architecture

See [`docs/contracts/mesh-model.md`](docs/contracts/mesh-model.md) for the mesh and tangent-space parity contract.

See [`docs/contracts/animation-model.md`](docs/contracts/animation-model.md) for transform, keyframe, hierarchy, and skeleton ownership.

See [`docs/contracts/animation-playback.md`](docs/contracts/animation-playback.md) for elapsed-time playback, transition timing, and partition invariance.

See [`docs/contracts/rigged-assets.md`](docs/contracts/rigged-assets.md) for rigged-asset composition and automatic collision-proxy fitting.

See [`docs/contracts/screen-space-lod.md`](docs/contracts/screen-space-lod.md) for LOD selection semantics and the Rust-generated web evidence.

See [`docs/contracts/renderer-parity.md`](docs/contracts/renderer-parity.md) for the cross-renderer mesh, matrix, and camera evidence contract.

See [`docs/contracts/browser-renderer.md`](docs/contracts/browser-renderer.md) for the reusable browser renderer's frame, environment, and material contract.

See [`docs/contracts/asset-model.md`](docs/contracts/asset-model.md) for asset/material ownership and the glTF/OBJ adapter boundary.

See [`docs/contracts/editor-model.md`](docs/contracts/editor-model.md) for the authoring-state, hierarchy, vertex-edit, and Three.js adapter boundary.

See [`ROADMAP.md`](ROADMAP.md) for the next implementation slices.
