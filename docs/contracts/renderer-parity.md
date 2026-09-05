# Renderer parity contract

Renderer comparison in `3d-lab` is grounded in shared data and matrix semantics, not screenshot similarity.

## Canonical fixture

`fixtures/renderer-parity/cube-and-transform.json` records two intentionally small facts:

- the position and index ordering of the canonical unit cube;
- one non-trivial translation × rotation × scale composition and its column-major 4×4 result.

The fixture is test evidence, not a new domain owner. `three-d-core` still owns renderer-independent geometry behavior and `three-d-animation` still owns renderer-independent transform math.

## Required parity

- `three-d-core::Mesh::unit_cube()` must match the canonical positions and indices.
- the browser `cubeMesh` lesson model must match the same positions and indices.
- `three-d-animation::Mat4::trs` must produce the canonical column-major matrix within floating-point tolerance.
- Three.js matrix composition must produce the same canonical matrix within floating-point tolerance.
- the native `wgpu` example must preserve the position and index order supplied by `three-d-core` when packing GPU buffers.

Together these checks make the renderer seam explicit: geometry and transforms agree before either adapter performs API-specific upload or drawing work.

## Deliberate non-parity

The first native `wgpu` baseline does not yet implement a camera or model/view/projection uniform buffer. It maps the unit cube directly into WebGPU clip-space depth for an offscreen draw. Camera/uniform parity is the next implementation slice and should consume the renderer-independent matrix semantics above rather than inventing a renderer-owned transform model.
