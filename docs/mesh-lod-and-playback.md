# Mesh LOD and smooth playback contract

This slice separates two performance concerns that are easy to conflate: reducing the amount of geometry a renderer consumes, and evaluating animation without frame-rate-dependent motion.

## Ownership

- `three-d-core` remains authoritative for mesh positions, indices, aligned vertex attributes, and topology validity.
- `three-d-lod` derives deterministic alternate index buffers from a validated source mesh. It does not own rendering, asset formats, or mutable mesh truth.
- `three-d-animation` remains authoritative for transforms, keyframe tracks, interpolation, clips, skeletons, skin influences, and quaternion SLERP.
- `three-d-playback` owns only runtime clock and clip-transition policy.
- Renderer adapters such as Three.js consume these results. They must not invent their own simplification or animation truth.

## Mesh simplification

A useful LOD system is not simply "delete every other triangle". A simplifier should minimize visible geometric error while reducing the index budget, preserve topological constraints where possible, and make the quality limit explicit.

`three-d-lod` pins `meshopt` 0.6.2 and records `meshopt-0.6.2` in every simplification result. The simplifier receives only source positions when evaluating geometric error. Its resulting index buffer continues to reference the original vertex buffer, so existing normals, tangents, UVs, and colors remain byte-for-byte aligned with their source vertices.

A target triangle count is a budget, not a promise. Topology and the requested error limit can make the simplifier stop before reaching that budget. Callers must therefore inspect both the requested and resulting triangle counts and the reported relative error.

`target_error` is relative to mesh extents and lives in `0..=1`. Small values preserve the source more aggressively. `lock_border` protects topological border vertices and is appropriate when independently simplified chunks must still meet exactly, such as terrain tiles.

### LOD-chain rules

Each LOD is generated from the original source mesh, never from the previous simplified LOD. Cascading simplification compounds approximation error and makes results depend on the chosen intermediate levels.

LOD specifications use strictly decreasing source-triangle ratios. Runtime selection is intentionally not part of this first slice. A later renderer-facing experiment should select levels from projected/screen-space error and use hysteresis (or an explicit transition technique) so small camera movements do not rapidly toggle levels or cause obvious popping. Distance-only magic constants should not become model truth.

### Static versus skinned meshes

The current `three-d-core::Mesh` does not contain per-vertex joint indices or skin weights; those semantics currently live separately in `three-d-animation`. Therefore this first simplification slice is deliberately a static-mesh contract.

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

A production asset pipeline can additionally optimize vertex-cache order, overdraw, vertex-fetch order, quantization, and compression after the final topology for each asset variant is known. Those transformations belong in reproducible asset processing, not in the renderer's frame loop.

## Next experiments

The next visual experiment should render the same source model beside several generated LODs and expose requested triangles, actual triangles, simplification error, wireframe/silhouette comparison, and an automatic screen-space selector with hysteresis. A separate animation experiment should visualize frame-rate-independent sampling and clip cross-fading under deliberately uneven render intervals.
