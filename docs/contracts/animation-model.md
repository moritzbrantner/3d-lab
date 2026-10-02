# Transform and animation ownership contract

The Three.js lessons and Rust animation crate intentionally share concepts, not implementation code.

## Ownership

`three-d-core` owns mesh positions, indices, mesh attributes, normals, and procedural topology.

`three-d-animation` owns renderer-independent scene and animation data:

- `Mat4` as a column-major 4×4 transform matrix;
- `Quat` as a normalized orientation representation with SLERP;
- `Transform` as translation + quaternion rotation + scale;
- ordered `TransformNode` hierarchies and deterministic world-matrix evaluation;
- typed keyframes, step/linear/smooth interpolation, reusable `AnimationClip` tracks, explicit loop policy, reusable pose buffers, and deterministic cross-fades;
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
- supports step, linear, or smooth-step time remapping;
- uses linear interpolation for scalars/vectors and SLERP for quaternions.

An `AnimationClip` groups one or more typed transform tracks and samples them into a pose without owning a renderer or clock. Clip time is explicit: `Clamp` holds the endpoints and `Repeat` wraps with `rem_euclid`; non-finite time fails closed.

`PoseBuffer` and `ClipBlendWorkspace` own reusable transform storage. Cross-fades sample both clips from the same explicit base pose and blend translation/scale linearly and rotations with shortest-arc SLERP. Callers provide the output slice, so the hot path does not require per-sample pose allocation.

## Hot-path clip sampling contract

`AnimationClip::sample` remains the reference sampler. `three_d_animation::sampling` adds crowd-scale samplers that are checked against it rather than defining new semantics:

- `CompiledClip::compile(&clip, node_count)` pre-resolves every track's node and channel once (failing with `ClipError::NodeOutOfBounds`) and flattens key times and values into contiguous `f32` arrays. `sample(time, pose)` uses a per-track binary search; `sample_with_cursor(time, &mut cursor, pose)` first tries the cursor's cached segment and its successor, then falls back to binary search. Both write only animated channels into a caller-owned pose of exactly `node_count` transforms and allocate nothing.
- Compiled sampling is bit-for-bit identical to the reference for every finite time: the same clip-time policy, the same segment rule (clamp at/outside the end keys, otherwise `times[s] < t <= times[s + 1]`), the same interpolation-factor arithmetic, and the same `Interpolate`/SLERP code. A `SampleCursor` affects lookup cost only, never the selected segment.
- `SampleCursor` is per-instance state (one per character per clip); compiled clips are shared immutable data. A cursor from a clip with a different track count fails with `SamplerError::CursorMismatch`; a wrong pose length fails with `SamplerError::PoseLengthMismatch`; non-finite time fails with `ClipError::NonFiniteTime`. Errors are detected before any pose write.
- `QuantizedClip::compress(&clip, node_count, QuantizationBudget)` stores key values as `u16` (translation/scale over each track's per-component range, rotations over `[-1, 1]` decoded as unit quaternions) while keeping key times exact. The budget is an explicit maximum sampled error: Euclidean distance for translation/scale and rotation angle in radians (`sampling::rotation_angle`). Translation/scale interpolate convexly, so checking every key bounds every sample. SLERP can amplify key errors perpendicular to the arc towards the middle of a segment, so for each non-step rotation segment compression also checks the derived first-order bound `max(e0, e1) / cos(Ω / 2)` (`Ω` the quaternion-space angle between the adjacent keys, so the factor is at most `√2`), plus at most `1.02e-6` rad when only one of the source and decoded arcs takes SLERP's normalized-linear fallback; the bound is conservative. Hemisphere and fallback decisions are made on exactly the values `Quat::slerp` uses (the raw source keys the reference samples and the decoded keys, both normalized again inside SLERP), never on separately rounded copies. Compression fails closed on an invalid budget, non-finite or zero-length keys, a quantization-induced SLERP hemisphere flip on an interpolated (non-step) segment, or any key or rotation segment bound exceeding its budget; `measured_error()` reports the largest accepted error or rotation bound. Because segment selection and factors are unchanged, sampled error is bounded by the budget plus float rounding.

`benches/clip_sampling_hot_path.rs` prints raw JSON evidence for one character and a 256-character crowd (reference, compiled, cursor, quantized, plus key-storage bytes). It is evidence, not a timing gate.

## Retargeting contract

Humanoid retargeting is explicit semantic adaptation, not renderer behavior.
`HumanoidRig` maps roles such as hips, spine, head, upper/lower limbs and optional
hands/feet to numeric nodes and retains that rig's local rest pose. Required roles
fail at construction when absent; optional roles may be missing.

`retarget_pose` transfers rest-relative local transform deltas. Rotation deltas
are applied on top of the target bind orientation, translation deltas are scaled
by the explicit reference-height ratio, and scale changes are transferred as
ratios. No node-name lookup, asset parsing, renderer mutation, or allocation is
required on the successful hot path.

## Production humanoid contract

`HumanoidSkeleton::production_v1` composes the existing `Skeleton` and
`HumanoidRig` authorities into the stricter reusable-game-character profile.
It does not introduce a second hierarchy or skinning representation.

The production profile requires a character-space `Root` distinct from
`Hips`. The root carries character-relative/root-motion presentation data;
hips remain the pelvis and may move independently inside authored animation.
Gameplay/world placement is still owned by the consuming game or physics
authority rather than by this animation contract.

The required semantic chains cover spine/head, clavicles plus complete arms, and
complete legs through the feet. Semantic relationships are validated as
ancestry rather than direct-parent equality so imported rigs may keep twist or
helper joints between canonical humanoid bones. Optional toe semantics extend
the foot chains.

Production rigs also provide standard attachment sockets for head, chest, back,
both hands, and both hips. Each socket is a finite local transform owned by its
expected semantic bone. These are presentation attachment frames for weapons,
armor, hair, backpacks, and similar assets; they do not encode gameplay
equipment legality or statistics.

Humanoid bones and sockets expose stable lower-kebab-case semantic IDs for
cross-process adapters. `asset-tooling-humanoid-adapter` accepts the
`three-d-humanoid-json-v1` transport envelope and calls
`HumanoidSkeleton::production_v1` as the authoritative validation step. The
adapter may parse and serialize the transport document, but it must not duplicate
the hierarchy, Root/Hips, or socket-ownership rules in another implementation.

## Skinning contract

A `Skeleton` is an ordered joint hierarchy plus inverse bind matrices. Skin matrices are computed as:

`joint_world × inverse_bind`

Each `SkinInfluence` has four joint slots and four non-negative finite weights. Construction rejects weight tuples whose total is zero or overflows to a non-finite value, normalizes the remaining weights to sum to one, and validation rejects active joint indices outside the skeleton.

## glTF boundary

`three-d-formats::load_gltf_animation_clips` is the file-format adapter into this contract. It resolves glTF channel targets to numeric node indices and converts LINEAR/STEP translation, rotation, and scale samplers into `AnimationClip` tracks. CUBICSPLINE and morph-weight animation fail explicitly until their semantics are represented. Generic mesh loading remains loss-aware and now preserves paired `JOINTS_0`/`WEIGHTS_0` as vertex-aligned `SkinInfluence` data. Scene-node skin binding and skeleton assembly remain separate from mesh-asset extraction.