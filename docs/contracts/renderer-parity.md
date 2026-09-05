# Renderer parity contract

Renderer comparison in `3d-lab` is grounded in shared data and matrix semantics, not screenshot similarity.

## Canonical fixture

`fixtures/renderer-parity/cube-and-transform.json` records three intentionally small facts:

- the position and index ordering of the canonical unit cube;
- one non-trivial translation × rotation × scale composition and its column-major 4×4 result;
- one right-handed perspective camera, its view matrix, and its WebGPU-depth projection matrix.

The fixture is test evidence, not a new domain owner. `three-d-core` still owns renderer-independent geometry behavior, `three-d-animation` owns renderer-independent transform math, and `three-d-camera` owns renderer-independent camera semantics.

## Required parity

- `three-d-core::Mesh::unit_cube()` must match the canonical positions and indices.
- the browser `cubeMesh` lesson model must match the same positions and indices.
- `three-d-animation::Mat4::trs` must produce the canonical column-major matrix within floating-point tolerance.
- Three.js matrix composition must produce the same canonical matrix within floating-point tolerance.
- `three-d-camera` must produce the canonical view matrix and WebGPU `0..1` depth projection matrix.
- Three.js must produce the same view matrix and, when explicitly asked for its WebGPU coordinate system, the same projection matrix.
- the native `wgpu` example must preserve the position and index order supplied by `three-d-core` and upload the renderer-independent view-projection matrix as a uniform.

Together these checks make the renderer seam explicit: geometry, transforms, and camera semantics agree before either adapter performs API-specific upload or drawing work.

## Coordinate-system boundary

The teaching site currently renders through `WebGLRenderer`, while the native example targets WebGPU. Their default projection matrices therefore have different normalized-device-coordinate depth conventions. This is not treated as a semantic mismatch: parity is checked against the WebGPU projection convention explicitly, while the browser display remains Three.js/WebGL-first.
