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

## Next implementation horizon

### Slice 5 — model pipeline

- [x] Expand glTF anatomy from animation-only to meshes/materials/assets.
- [ ] Add OBJ and glTF mesh loading and validation.
- [ ] Add tangents and normal maps.
- [ ] Add level-of-detail and mesh simplification experiments.
