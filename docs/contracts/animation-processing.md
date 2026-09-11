# Animation processing contract

`three-d-animation` owns renderer-independent keyframe sampling and quaternion SLERP. The `examples/asset-tooling-animation-adapter` package exposes those semantics through the generic asset-tooling process-adapter protocol without making workflow or provenance infrastructure part of the domain crate.

## Integration codec

The adapter uses `three-d-animation-json-v1`, a narrow integration envelope containing a non-empty ordered channel list. Each channel targets one node and one of `translation`, `rotation`, or `scale`, with strictly increasing non-negative keyframe times. Translation and scale values are finite vec3 values. Rotation values are finite normalized quaternions.

The codec is an integration boundary, not a replacement for glTF. Format import/export remains owned by the format pipeline; asset-tooling operates on content-addressed bytes and delegates animation semantics here.

## `animation.resample`

Version 1 is local-transform only and requires explicit interpolation rules:

- translation: `linear`;
- rotation: `slerp`;
- scale: `linear`.

The declared source time domain must exactly match the animation document's aggregate first/last keyframe times. Target times must be finite, strictly increasing, and inside that domain. Every source channel is sampled at every target time. Channels whose own key range is shorter than the aggregate clip domain retain their nearest endpoint value through the existing `KeyframeTrack::sample` behavior.

The processor reports source/result keyframe counts, channel count, and the elapsed span of the target grid. No playback timing or runtime animation state is introduced.

## `animation.reduce`

Version 1 is local-transform only. Reduction is deterministic, source-key based, and endpoint-conservative. It iteratively splits candidate spans and removes interior keys only when every source key in the candidate span can be reconstructed within the configured tolerance from the retained endpoints.

Error metrics are:

- translation: scale-stable Euclidean vec3 distance;
- rotation: scale-stable shortest-arc quaternion angular distance in radians;
- scale: scale-stable Euclidean vec3 distance.

Reduction work is deterministically bounded. If a pathological channel exhausts the comparison budget, the processor falls back to retaining every source key for that channel. That conservative fallback may sacrifice compression, but it cannot weaken the requested error bound or endpoint evidence.

After reduction, the adapter re-samples the reduced channel at every original source key time and reports the actual maximum observed error for each transform family. Endpoints are retained even when `preserveEndpoints` is false; `false` removes the requirement, not the permission to preserve them. When `preserveEndpoints` is true, failure to retain them is an error.

This v1 evidence proves error bounds at the original source key times. It does not claim a continuous-time error bound between source keys beyond the interpolation semantics already defined by the animation model.

## Ownership boundary

Asset-tooling may pin the exact 3d-lab revision, validate the probe, bind processor identity into operation build identity, and store resulting bytes. It must not reimplement resampling, SLERP, key-reduction, or transform-space semantics merely to centralize processing.
