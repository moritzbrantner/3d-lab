# Animation playback and transition contract

Animation smoothness is a timing contract before it is a rendering technique.

## Ownership

- `three-d-animation` owns clip content, keyframe interpolation, transforms, quaternion SLERP, hierarchy evaluation, skeletons, and skinning semantics.
- `three-d-playback` owns runtime clock policy: elapsed-time advancement, looping/clamping, playback speed, transition progress, transition curves, and sampling two clips for a cross-fade.
- renderers decide when a pose is displayed. They must not derive animation truth from rendered frame count.

## Playback time

`PlaybackClock` advances from an explicit elapsed duration. A 50 ms delayed frame advances the clip by 50 ms; it does not pretend that one nominal 16.67 ms frame elapsed. This makes animation speed independent of refresh rate, dropped frames, and irregular scheduling.

The clock keeps its accumulated position as `f64` and converts to the existing `f32` clip-sampling contract only at the boundary. Looping uses Euclidean remainder so reverse playback wraps predictably as well.

## Transitions

`TransitionClock` is separate from clip clocks. A cross-fade has its own wall-clock duration and must not implicitly speed up or slow down because one participating clip has a different playback rate.

The transition exposes both:

- linear progress: elapsed transition time divided by transition duration;
- blend factor: progress mapped through the selected runtime curve.

The initial curves are `Linear` and `SmoothStep`. The curve changes weighting, not elapsed time. Progress clamps at one and remains complete until explicitly reset.

`sample_cross_fade` samples the source and target clips independently against the same base pose, then blends translation and scale linearly and rotation through quaternion SLERP. Non-finite sample times and blend factors fail closed.

## Uneven-frame evidence

`three-d-playback/examples/export_playback_fixture.rs` emits a deterministic teaching sequence with deliberately uneven frame intervals. For every frame it records:

- actual delta and cumulative wall time;
- correct elapsed-time clip sample time;
- an intentionally incorrect `1 / 60`-per-rendered-frame time for comparison;
- transition linear progress and curved blend factor;
- transition completion state;
- the fully blended transform produced by the Rust runtime contract.

Web tests regenerate the fixture and verify that correct playback follows cumulative elapsed time, the fixed-per-frame clock diverges, transition progress is monotonic, completion is stable, and blended quaternions remain normalized.

The browser lab visualizes that generated evidence. Its presentation speed only changes how quickly the evidence is replayed for a human; it does not alter the recorded animation timing.

## Physics-driven motion

A deterministic fixed-step physics simulation remains a separate authority. When physics poses are displayed between simulation ticks, the renderer may interpolate the last accepted simulation states for presentation. That interpolated presentation pose must not be fed back into simulation state.

## Next depth

- Add transition interruption semantics so a new transition can start from the currently presented pose without snapping.
- Add additive animation layers and masks only after ownership of per-node contribution and normalization is explicit.
- Add root-motion extraction as a separate contract rather than hiding world displacement inside visual-only animation.
- Add animation resampling/key-reduction processors with reproducible error evidence in `asset-tooling` when baked assets are needed.
