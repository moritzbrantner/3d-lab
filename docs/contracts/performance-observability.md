# Performance and observability boundary

`3d-lab` treats performance as an architectural property that needs reproducible evidence, without making timing infrastructure part of geometry, scene, renderer, or export semantics.

## Ownership

- `three-d-*` domain crates own deterministic work facts that are meaningful without a clock. For scene normalization this includes source/materialized vertex counts, visited indices, and materialized attribute values.
- `three-d-export` reports whether it had to normalize its input. An already-normalized `SceneSnapshot` is reused directly instead of rematerializing mesh and attribute buffers.
- Repository-owned profile scripts define representative deterministic workloads.
- `runtime-profiler` owns elapsed-time, resident-memory, environment identity, immutable evidence bundles, and reference/candidate comparison.
- A future evaluator such as Moonlight may own regression thresholds after the workload has enough repeated evidence to understand normal variance. The profiler itself does not define release policy.

This keeps observability downstream of domain authority: adding or removing a profiler must not change scene, mesh, camera, animation, or rendering semantics.

## Scene normalization provenance

`SceneSnapshot::new` creates a validated but not necessarily canonical scene. `SceneSnapshot::normalized` creates canonical ordering, canonical transforms, and compacted mesh buffers, then attaches `SceneNormalizationObservations` to the result.

The attached observations serve two purposes:

1. they make algorithmic work visible without relying on noisy wall-clock thresholds; and
2. they mark the snapshot as already normalized so downstream consumers can avoid repeating the same materialization work.

Normalization remains deterministic and idempotent. Re-normalizing an already-normalized snapshot preserves the same scene and observations.

`three-d-export` still accepts an ordinary `SceneSnapshot` for convenience. If the input is not normalized, export performs one normalization pass. If the input is already normalized, as in the asset-tooling scene adapter, export serializes it directly. `SceneExportObservations::normalization_pass_count` makes that boundary testable.

## Runtime canary

`profiles/runtime-profiler/scene-export.json` exercises the actual release-mode `scene_export_glb` adapter against a generated deterministic scene. The fixture intentionally contains enough meshes, vertices, attributes, and canonical reordering work to expose repeated materialization while staying bounded and repository-local.

Pull requests that touch the Rust scene/export surface capture the same workload on the exact base and candidate revisions. The candidate workload definition is copied to the base before capture so the scenario itself is identical. The resulting runtime-profiler comparison is advisory evidence and is uploaded as a CI artifact.

The profile is intentionally separate from correctness tests:

- ordinary CI proves semantic behavior;
- deterministic work observations protect known algorithmic boundaries;
- runtime-profiler records timing/memory evidence;
- no brittle wall-clock threshold is embedded in unit tests.

## Next performance slices

After the scene-export canary has stable repeated evidence, extend the same pattern rather than introducing another profiler:

1. add a browser journey for the reusable Three.js renderer that exercises stable scene reuse and records renderer-main hot paths;
2. expose deterministic renderer work facts such as object/resource creations, reuses, evictions, and scene-node visits without moving renderer authority into a profiler;
3. add representative editor mutation workloads once edit-command/undo semantics stabilize;
4. introduce evaluator-owned budgets only for workloads whose variance and product relevance are understood.
