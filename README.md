# 3d-lab

`3d-lab` is an interactive learning repository for 3D fundamentals: vertices, triangles, indexed meshes, attributes, normals, transforms, cameras, lighting, procedural geometry, animation, and skinning.

The repository deliberately has parallel surfaces:

- **Web / Three.js** — visual, interactive lessons that can be published with GitHub Pages.
- **Rust / `three-d-core`** — renderer-independent mesh geometry and topology.
- **Rust / `three-d-animation`** — renderer-independent matrices, transforms, animation tracks/clips, and skeletal data.
- **Rust / `three-d-camera`** — renderer-independent right-handed view and WebGPU-depth perspective camera matrices.
- **Native / `wgpu` example** — a narrow renderer-comparison adapter that consumes the Rust mesh and camera models without moving GPU ownership into the core crates.

The web renderer is intentionally Three.js-first. The Rust core crates do not depend on Three.js, WebGL, WebGPU, a windowing stack, or a glTF loader; native/WebGPU rendering and asset adapters stay downstream of the renderer-independent models.

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
17. Keyframes, interpolation, easing, and reusable clips
18. Euler angles vs. quaternion SLERP
19. Skeletons, joints, weights, and skinning
20. A minimal glTF 2.0 animation loaded through Three.js
21. Three.js versus native `wgpu` renderer responsibilities

Every topic combines a concise explanation with an interactive scene and a small data inspector. The Rust side mirrors the durable, renderer-independent concepts rather than wrapping Three.js APIs.

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

### Web

```bash
cd web
bun install
bun run typecheck
bun test
bun run build
```

Then run `bun run dev` for the local teaching site.

## Architecture

See [`docs/contracts/mesh-model.md`](docs/contracts/mesh-model.md) for the mesh parity contract.

See [`docs/contracts/animation-model.md`](docs/contracts/animation-model.md) for transform, keyframe, hierarchy, and skeleton ownership.

See [`docs/contracts/renderer-parity.md`](docs/contracts/renderer-parity.md) for the cross-renderer mesh, matrix, and camera evidence contract.

See [`ROADMAP.md`](ROADMAP.md) for the next implementation slices.
