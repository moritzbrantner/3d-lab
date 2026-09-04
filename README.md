# 3d-lab

`3d-lab` is an interactive learning repository for 3D fundamentals: vertices, triangles, indexed meshes, attributes, normals, transforms, cameras, lighting, procedural geometry, and animation.

The repository deliberately has two parallel surfaces:

- **Web / Three.js** — visual, interactive lessons that can be published with GitHub Pages.
- **Rust / `three-d-core`** — renderer-independent geometry primitives and algorithms for understanding and testing the same concepts at the data level.

The web renderer is intentionally Three.js-first. The Rust crate does not depend on Three.js, WebGL, WebGPU, or a windowing stack; native/WebGPU rendering can be added later without moving mesh ownership out of the core crate.

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
9. Animation
10. Flat vs. smooth normals
11. UV coordinates and texture mapping
12. Vertex colors and attribute interpolation
13. Triangle winding and back-face culling
14. Mesh subdivision and procedural generation

Every topic combines a concise explanation with an interactive scene and a small data inspector. The topology-and-attributes lessons also mirror their data model in Rust: optional normal, UV, and color buffers must align with the position buffer, and procedural generation produces deterministic indexed geometry on both surfaces.

## Development

### Rust

```bash
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
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

See [`docs/contracts/mesh-model.md`](docs/contracts/mesh-model.md) for the intentionally small parity contract between the TypeScript lessons and the Rust core.

See [`ROADMAP.md`](ROADMAP.md) for the next implementation slices.