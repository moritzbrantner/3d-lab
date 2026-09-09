# Mesh LOD and smooth playback contract

This slice separates two performance concerns that are easy to conflate: reducing the amount of geometry a renderer consumes, and evaluating animation without frame-rate-dependent motion.

## Ownership

- `three-d-core` remains authoritative for mesh positions, indices, aligned vertex attributes, and topology validity.
- `three-d-lod` derives deterministic alternate index buffers from a validated source mesh and owns renderer-independent screen-space LOD selection policy. It does not own rendering, asset formats, or mutable mesh truth.
- `three-d-animation` remains authoritative for transforms, keyframe tracks, interpolation, clips, skeletons, skin influences, and quaternion SLERP.
- `three-d-playback` owns only runtime clock and clip-transition policy.
- Renderer adapters such as Three.js consume these results. They must not invent their own simplification or animation truth.

## Mesh simplification

A useful LOD system is not simply "delete every other triangle". A simplifier should minimize visible geometric error while reducing the index budget, preserve topological constraints where possible, and make the quality limit explicit.

`three-d-lod` pins `meshopt` 0.6.2 and records `meshopt-0.6.2` in every simplification result. The current simplifier receives only source positions when evaluating geometric error. Its resulting index buffer continues to reference the original vertex buffer, so existing normals, tangents, UVs, and colors remain byte-for-byte aligned with their source vertices.

That structural attribute preservation is not the same as appearance-aware simplification. Normals, UVs, colors, or skinning data are not yet weighted in the error metric. A later quality tier can use attribute-aware simplification once the repository has explicit semantics for which attributes matter and how strongly.

A target triangle count is a budget, not a promise. Topology and the requested error limit can make the simplifier stop before reaching that budget. Callers must therefore inspect both the requested and resulting triangle counts and the reported relative error.

`target_error` is relative to mesh extents and lives in `0..=1`. Small values preserve the source more aggressively. `lock_border` protects topological border vertices and is appropriate when independently simplified chunks must still meet exactly, such as terrain tiles.

### LOD-chain rules

Each LOD is generated from the original source mesh, never from the previous simplified LOD. Cascading simplification compounds approximation error and makes results depend on the chosen intermediate levels.

LOD specifications use strictly decreasing source-triangle ratios. Each level keeps its actual resulting triangle count and relative error because the requested budget alone is not acceptance evidence.

### Screen-space selection

`ScreenSpaceLodPolicy` converts a level's relative geometric error into projected pixel error using the source mesh extent, camera distance, viewport height, and vertical field of view:

`projected_error_pixels = relative_error × mesh_extent × projection_scale / distance`

where `projection_scale = viewport_height / (2 × tan(vertical_fov / 2))`.

Levels are ordered from finest to coarsest with nondecreasing relative error. The selector chooses the coarsest level inside the configured pixel-error budget instead of relying on model-specific distance constants.

Hysteresis creates separate transition margins:

- moving to a coarser level requires the candidate to fit inside `target × (1 - hysteresis)`;
- moving back to a finer level is delayed until the current level exceeds `target × (1 + hysteresis)`.

This prevents camera jitter near one threshold from alternating levels every frame. It does not itself hide a visible topology pop when a genuine level transition occurs; optional geometric morphing or renderer-level dithered transitions remain separate presentation techniques.

### Browser parity

The browser does not simplify meshes. `three-d-lod/examples/export_lod_fixture.rs` deterministically builds a teaching surface, runs the Rust simplifier, and exports the shared source vertex buffer, every generated index buffer, triangle counts, relative errors, and a reference screen-space transition sequence.

Web development, tests, CI, and Pages builds regenerate that fixture before use. The TypeScript selection mirror is tested against the Rust-generated transition samples. Three.js owns only visualization and interactive controls.

### Static versus skinned meshes

The current `three-d-core::Mesh` does not contain per-vertex joint indices or skin weights; those semantics currently live separately in `three-d-animation`. Therefore this simplification contract remains deliberately static-mesh-only.

Skinned-mesh simplification must not silently discard or misalign skinning data. Before enabling it, the repository needs an explicit format-neutral association between mesh vertices and skin influences, plus a simplification policy that accounts for deformation-relevant attributes. That work should be validated on animated poses, not only on the bind pose.

## Smooth animation playback

Smooth animation has several independent requirements:

1. Playback position advances by elapsed time, not by "one amount per rendered frame". Otherwise animation speed changes with refresh rate and dropped frames.
2. Rotation interpolation uses normalized quaternion SLERP rather than component-wise Euler interpolation for general 3D orientation changes.
3. Switching clips blends sampled poses over a transition interval instead of snapping the complete transform set on one frame.
4. Long-running playback uses higher-precision clock state internally and converts to the existing `f32` clip sampling contract only at the boundary.
5. Physics-driven animation should keep deterministic fixed simulation steps separate from rendering and interpolate between accepted simulation states for display. The renderer must not feed presentation interpolation back into simulation truth.

`three-d-playback::PlaybackClock` implements elapsed-time clamp/loop behavior, including reverse playback, with an internal `f64` position. `sample_cross_fade` samples both existing `AnimationClip`s against the same base pose and blends translation and scale linearly while using `Quat::slerp` for rotation.

The playback layer does not change keyframe interpolation inside a clip. Easing remains a `three-d-animation` concern; playback determines *when* to sample, while the animation crate determines *what pose that time means*.

## Performance implications

Mesh LOD primarily reduces vertex processing, rasterization pressure, bandwidth, and asset/runtime memory when followed by an appropriate compacting/packing pipeline. Animation playback primarily affects CPU pose evaluation and, for skinned meshes, joint/vertex deformation work. They should be measured separately.

The current LODs intentionally share the source vertex buffer because that makes attribute preservation explicit and keeps the first contract narrow. A later asset-processing stage can compact each LOD's used vertices and then optimize vertex-cache order, overdraw, vertex-fetch order, quantization, and compression. Those transformations belong in reproducible asset processing, not in the renderer's frame loop.

## Next experiments

- Add appearance-aware simplification that can weight normals, UVs, and colors without changing the source ownership boundary.
- Add compact per-LOD vertex/index asset variants plus cache/fetch optimization and reproducibility receipts.
- Add deformation-aware simplification only after vertex-to-skin-influence ownership is explicit.
- Add a separate animation timing lab that visualizes uneven render intervals and clip cross-fading against the frame-rate-independent playback contract.
