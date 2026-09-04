# 3d-lab roadmap

## Current slice — fundamentals on GitHub Pages

- [x] Establish renderer-independent Rust mesh primitives.
- [x] Establish the parallel TypeScript mesh representation used by lessons.
- [x] Publish a Three.js teaching surface with topic-based interactive examples.
- [x] Cover coordinates, vertices, triangles, indexed meshes, normals, transforms, projection, lighting, and animation.
- [x] Add CI and GitHub Pages deployment.

## Next implementation horizon

### Slice 2 — topology and attributes

- Per-face vs. per-vertex normals.
- UV coordinates and texture mapping.
- Vertex colors and custom attributes.
- Triangle winding, back-face culling, and manifold intuition.
- Mesh subdivision and simple procedural generation.

### Slice 3 — transforms and animation depth

- Matrix composition and parent/child transforms.
- Keyframes and interpolation.
- Quaternion rotation.
- Skeletons, joints, skinning, and a minimal glTF animation example.

### Slice 4 — renderer comparison

- Add a native Rust `wgpu` example beside the Three.js lessons.
- Keep the browser teaching surface Three.js-first.
- Compare vertex/index buffers, uniforms, camera matrices, and draw calls across APIs.
- Add WebGPU in the browser only where the comparison itself teaches something.

### Slice 5 — model pipeline

- OBJ and glTF anatomy.
- Mesh loading and validation.
- Tangents and normal maps.
- Level-of-detail and mesh simplification experiments.
