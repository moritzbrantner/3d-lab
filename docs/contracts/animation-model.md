# Transform and animation ownership contract

The Three.js lessons and Rust animation crate intentionally share concepts, not implementation code.

## Ownership

`three-d-core` owns mesh positions, indices, mesh attributes, normals, and procedural topology.

`three-d-animation` owns renderer-independent scene and animation data:

- `Mat4` as a column-major 4×4 transform matrix;
- `Quat` as a normalized orientation representation with SLERP;
- `Transform` as translation + quaternion rotation + scale;
- ordered `TransformNode` hierarchies and deterministic world-matrix evaluation;
- typed keyframes, linear/smooth interpolation, and reusable `AnimationClip` tracks;
- skeleton joints, inverse bind matrices, and normalized four-slot skin influences.

The web application owns interactive presentation, Three.js scene objects, `AnimationMixer`, `Bone`/`SkinnedMesh`, and `GLTFLoader`.

## Deterministic hierarchy rule

Rust transform and skeleton arrays are topologically ordered: a parent must appear before every child. This makes world-matrix evaluation a deterministic single forward pass and rejects cycles/forward references at the boundary.

For a child node:

`world = parent_world × local`

A root node uses its local matrix directly.

## Matrix convention

`Mat4` stores column-major values and composes a local transform as:

`model = translation × rotation × scale`

Applied to a point, that means local scale happens first, then rotation, then translation.

## Rotation convention

Euler angles remain a useful authoring/explanation representation, but renderer-independent animation tracks store rotations as quaternions. Quaternion interpolation uses the shortest-arc SLERP path and normalizes its result.

## Keyframe contract

A `KeyframeTrack<T>`:

- contains at least one keyframe;
- requires finite, strictly increasing times;
- clamps sampling before the first and after the last keyframe;
- supports linear or smooth-step time remapping;
- uses linear interpolation for scalars/vectors and SLERP for quaternions.

An `AnimationClip` groups one or more typed transform tracks and samples them into a pose without owning a renderer or clock.

## Skinning contract

A `Skeleton` is an ordered joint hierarchy plus inverse bind matrices. Skin matrices are computed as:

`joint_world × inverse_bind`

Each `SkinInfluence` has four joint slots and four non-negative finite weights. Construction normalizes the weights to sum to one, and validation rejects active joint indices outside the skeleton.

## glTF boundary

The browser lesson uses a deliberately tiny embedded glTF 2.0 asset to show how keyframe concepts are serialized into buffers, accessors, samplers, and channels. Parsing glTF is not owned by either Rust core crate yet; a future model-pipeline slice may add an adapter that converts glTF data into the existing mesh and animation contracts.