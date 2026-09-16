# Performance and observability boundary

`3d-lab` treats performance as an architectural property that needs reproducible evidence, without making timing infrastructure part of geometry, scene, renderer, or export semantics.

## Ownership

- `three-d-*` domain crates own deterministic work facts that are meaningful without a clock. For scene normalization this includes source/materialized vertex counts, visited indices, and materialized attribute values.
- `@moritzbrantner/three-d-renderer` owns deterministic renderer work facts for the concrete Three.js adapter: scene-node visits, object/resource creation and reuse, removals, evictions, and live cache sizes.
- `three-d-export` reports whether it had to normalize its input. An already-normalized `SceneSnapshot` is reused directly instead of rematerializing mesh and attribute buffers.
- Repository-owned profile scripts and browser journeys define representative deterministic workloads.
- `runtime-profiler` owns elapsed-time, resident-memory, browser runtime identity, Chromium traces, immutable evidence bundles, and reference/candidate comparison.
- Repository-owned calibration tooling may summarize repeated, identity-equivalent profiler bundles. It owns descriptive spread statistics only, not a performance verdict.
- A future evaluator such as Moonlight may own regression thresholds after repeated calibration has established normal same-run and cross-run variance. The profiler and calibration summarizer do not define release policy.

This keeps observability downstream of domain authority: adding or removing a profiler must not change scene, mesh, camera, animation, or rendering semantics.

## Scene normalization provenance

`SceneSnapshot::new` creates a validated but not necessarily canonical scene. `SceneSnapshot::normalized` creates canonical ordering, canonical transforms, and compacted mesh buffers, then attaches `SceneNormalizationObservations` to the result.

The attached observations serve two purposes:

1. they make algorithmic work visible without relying on noisy wall-clock thresholds; and
2. they mark the snapshot as already normalized so downstream consumers can avoid repeating the same materialization work.

Normalization remains deterministic and idempotent. Re-normalizing an already-normalized snapshot preserves the same scene and observations.

`three-d-export` still accepts an ordinary `SceneSnapshot` for convenience. If the input is not normalized, export performs one normalization pass. If the input is already normalized, as in the asset-tooling scene adapter, export serializes it directly. `SceneExportObservations::normalization_pass_count` makes that boundary testable.

## Renderer work observations

`ThreeSceneRenderer.render` returns a `RendererWorkObservations` value after each frame. The report is descriptive work evidence, not a timing result. It records:

- scene nodes visited;
- Three.js mesh objects created, reused, and removed;
- geometry resources created, reused, and evicted;
- material resources created, reused, and evicted; and
- live object, geometry, and material cache sizes after the frame.

Creation/reuse counts describe cache acquisitions performed by the renderer. They intentionally do not claim GPU allocation cost or exclusive CPU time. Chromium/runtime timing remains owned by `runtime-profiler`.

The resource cache helpers expose creation-versus-reuse and eviction counts directly, so the observations are produced by the same code path that owns the actual cache. The performance fixture does not maintain a second shadow cache model.

## Runtime canaries

`profiles/runtime-profiler/scene-export.json` exercises the actual release-mode `scene_export_glb` adapter against a generated deterministic scene. The fixture intentionally contains enough meshes, vertices, attributes, and canonical reordering work to expose repeated materialization while staying bounded and repository-local.

`profiles/runtime-profiler/renderer-browser.json` exercises the reusable Three.js renderer through the static `/renderer-performance/` route. Its 64-frame, 192-node workload includes one phase that removes the final users of a geometry/material and then restores them. On a renderer that exposes work observations, the route checks the exact aggregate create/reuse/remove/evict counts before reporting success.

For pull-request browser evidence, the candidate workload files are copied into the exact base checkout before either site is built. Both revisions therefore run the same route and journey module. `runtime-profiler compare-browser` verifies scenario, journey, Playwright, Chromium, viewport, trace configuration, and normalizer identity before the two captures are interpreted together.

The profiles remain separate from correctness tests:

- ordinary CI proves semantic behavior;
- deterministic work observations protect known algorithmic and cache boundaries;
- runtime-profiler records process/browser runtime evidence;
- browser comparison must first establish strict workload/runtime comparability;
- no brittle wall-clock threshold is embedded in unit tests.

## Renderer variance calibration

`.github/workflows/renderer-variance-calibration.yml` measures noise separately from code changes. It builds the renderer canary once, keeps one static server alive, and performs seven sequential Chromium captures of that exact source on one runner. The calibration summarizer fails closed unless all samples have identical:

- source Git identity;
- scenario id and digest;
- execution-environment fingerprint; and
- complete browser runtime identity, including journey, adapter, normalizer, Node, Playwright, Chromium, viewport, and trace categories.

`scripts/summarize_renderer_browser_variance.py` then writes `3d-lab/renderer-browser-variance/v1`. It retains every raw sample and reports min, median, mean, p95, max, median absolute deviation, population standard deviation, coefficient of variation, and range relative to the median for:

- the maximum top-level `EventDispatch` duration, which is the closest normalized Chromium signal for the synchronous canary action;
- longest top-level task duration;
- total top-level task duration;
- inclusive JavaScript trace duration;
- long-task count; and
- trace-event count.

The report is explicitly `calibration-only` and always has `release_verdict: false`. A single seven-sample run describes same-run noise; it is not enough to define a durable threshold. The workflow therefore also runs weekly on `main` and remains manually dispatchable so future policy can inspect cross-run variation caused by runner, browser, and operating-environment changes rather than hiding those changes inside one percentage budget.

## Next performance slices

Extend the same evidence pattern rather than introducing another profiler:

1. accumulate several scheduled renderer calibration artifacts and decide whether the same-run and cross-run spread is stable enough for an explicit evaluator margin policy;
2. add representative editor mutation workloads once edit-command/undo semantics stabilize;
3. add downstream game/application journeys where the reusable renderer is a meaningful part of frame cost; and
4. introduce evaluator-owned budgets only for workloads whose variance and product relevance are understood.
