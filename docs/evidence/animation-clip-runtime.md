# Reusable animation clip runtime

Issue: #63

## Runtime contract

`three-d-animation` remains the animation authority. Clips contain typed,
pre-resolved numeric node targets and expose explicit `Clamp` or `Repeat` loop
behavior. Sampling rejects non-finite time. `STEP`, linear vector interpolation,
and shortest-arc quaternion SLERP are represented directly.

`PoseBuffer` and `ClipBlendWorkspace` make ownership explicit: callers allocate
pose/output storage once and reuse it. Cross-fades reset both working poses from
one base pose, sample the two clips, and blend into caller-owned output. Regression
tests retain the same working-buffer addresses across repeated cross-fades, so
accidental per-sample pose replacement is fenced off independently of timing.

## Imported clip integration

`three-d-formats::load_gltf_animation_clips` converts glTF animation samplers and
channels into the same `AnimationClip` representation. It supports LINEAR and
STEP translation/rotation/scale tracks and fails closed on CUBICSPLINE or animation
targets the core does not represent.

The pinned Khronos SimpleSkin fixture is the integration ratchet: its 5.5-second
rotation channel targets glTF node 2 and is sampled directly into a three-node
`Transform` pose. This animation extraction is intentionally separate from the
generic asset loader, which still refuses to discard JOINTS_0/WEIGHTS_0.

## Native benchmark

Run:

`cargo bench -p three-d-animation --bench clip_sampling`

The benchmark samples 128 pre-resolved tracks across 64 nodes 500,000 times, then
runs 500,000 two-clip cross-fades using persistent workspace/output storage. It
prints one JSON record with raw elapsed nanoseconds and ns/sample. Timing is
diagnostic evidence, not a CI threshold; pointer/storage reuse and numerical
correctness are deterministic ratchets.
