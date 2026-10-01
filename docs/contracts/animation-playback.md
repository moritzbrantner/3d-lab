# Animation playback timing contract

## Ownership

`three-d-animation` remains the authority for clips, keyframes, interpolation,
quaternion SLERP, pose buffers, and cross-fade blending.

`three-d-playback` is a separate, narrow runtime layer on top of it. It owns
only how measured wall-clock frame deltas become clip time and transition
weight. It was made a focused crate rather than a module of
`three-d-animation` so clock policy stays outside the clip authority and the
animation crate does not grow a runtime clock.

The browser never samples clips, steps clocks, or blends poses. It presents
Rust-derived evidence.

## Playback clock

`PlaybackClock` accumulates `speed × delta` in `f64` seconds and resolves clip
time from that total:

- `Clamp` holds the end pose (the start pose when reversed); `Loop` wraps.
- `Forward` runs `0 → duration`; `Reverse` runs `duration → 0`. Reverse is a
  policy, not a negative delta. Negative or non-finite deltas, negative or
  non-finite speeds, and non-positive durations fail closed. A delta whose
  accumulated total (or cycle count) would overflow returns `TimeOverflow` and
  leaves the clock, or the whole cross-fade, unchanged.
- The clock is the only wrap authority. `sample` uses
  `AnimationClip::sample_resolved`, which clamps but never re-applies the
  clip's `LoopMode`, so a reverse loop at `duration` shows the end pose even
  on a `Repeat` clip.
- `PlaybackClock::from_clip` adopts the clip's `LoopMode`, so the clip and the
  clock never disagree about wrapping.
- Positions within `BOUNDARY_EPSILON_CYCLES` (1e-6 cycles) of a cycle boundary
  resolve to the boundary. Durations are authored as `f32`, so this makes
  36 × 1/60 s complete a 0.6 s fade and keeps summation noise from putting
  different frame partitions on opposite sides of a loop wrap.

## Transitions

`TransitionClock` advances by wall seconds only. Its linear progress maps to a
blend weight through `Linear` or `SmoothStep`. Clip speed or direction never
changes how long a transition takes.

`CrossFade` advances three separate clocks by the same wall delta: the outgoing
clip clock, the incoming clip clock, and the transition clock. It samples both
clips and blends them through `ClipBlendWorkspace::sample_resolved_crossfade`, so the
same deltas always produce bit-identical poses.

## Partition invariance

Splitting the same wall time into different frame deltas (one step, steady
30/60/144 Hz, jitter with hitches) gives the same clip time, transition weight,
and sampled pose within `1e-6`. Unit tests in `three-d-playback` and the
evidence integration test assert this for every clamp/loop × forward/reverse
policy and for cross-fades.

## Web evidence

`cargo run -p three-d-playback --example playback_timing_evidence` writes
`fixtures/playback/playback-timing.json`. It covers four partitions of the same
2 s (steady 30, 60 and 120 Hz, and uneven with hitches), every playback policy,
and two transition durations × two curves.

Each series also has a `fixedStep` companion: the same Rust clocks fed a fixed
1/60 s per frame instead of the measured delta. This is the anti-pattern the
`/animation-timing/` lab shows, labelled as intentionally wrong.

`tests/playback_timing_evidence.rs` (and `-- --check`) fails if the committed
fixture drifts. Values are rounded to six decimals; the comparison requires
identical structure and strings and allows numbers to differ by at most
`DRIFT_TOLERANCE` (2e-6), because `f32` `sin`/`acos` differ in the last bit
between libm versions and such a bit can flip the sixth decimal. The
lab only looks up the frame presented at a wall-clock instant;
`scripts/playback-timing-browser-smoke.mjs` checks in Chromium that exact
wall-time input and timeline scrubbing share one state.
