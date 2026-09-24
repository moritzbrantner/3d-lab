# Performance and observability boundary

`3d-lab` treats performance as an architectural property that needs reproducible evidence, without making timing infrastructure part of geometry, scene, renderer, or export semantics.

## Ownership

- `three-d-*` domain crates own deterministic work facts that are meaningful without a clock. For scene normalization this includes source/materialized vertex counts, visited indices, and materialized attribute values.
- `@moritzbrantner/three-d-renderer` owns deterministic renderer work facts for the concrete Three.js adapter: scene-node visits, object/resource creation and reuse, removals, evictions, and live cache sizes.
- The scene-editor model owns edit semantics and the structural-sharing boundary for local transform and vertex mutations. Imported or externally constructed scenes are validated once at the trust boundary; local mutations validate only the values they introduce and preserve unaffected invariants by construction.
- The editor command log owns deterministic mutation history and undo/redo semantics. It records semantic deltas and a cursor, never renderer state or per-command scene snapshots.
- `three-d-export` reports whether it had to normalize its input. An already-normalized `SceneSnapshot` is reused directly instead of rematerializing mesh and attribute buffers.
- Repository-owned profile scripts and browser journeys define representative deterministic workloads.
- `runtime-profiler` owns elapsed-time, resident-memory, browser runtime identity, Chromium traces, immutable evidence bundles, and reference/candidate comparison.
- Repository-owned calibration tooling may summarize repeated, identity-equivalent profiler bundles. It owns descriptive spread statistics only, not a performance verdict.
- A future evaluator such as Moonlight may own regression thresholds after repeated calibration has established normal same-run and cross-run variance. The profiler and calibration summarizer do not define release policy.

This keeps observability downstream of domain authority: adding or removing a profiler must not change scene, mesh, camera, animation, editing, or rendering semantics.

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

`ThreeSceneRenderer.renderCamera` is the explicit unchanged-scene fast path. It validates and applies the new camera, issues the draw, and reports zero scene-node/resource visits while retaining the current live-cache counts. It deliberately does not infer unchanged scene state from object or array identity: callers must choose the method only when node geometry, materials, visibility, and transforms are unchanged. Any scene mutation must go through full `render(frame)`, preserving the existing validation and reconciliation contract.


The resource cache helpers expose creation-versus-reuse and eviction counts directly, so the observations are produced by the same code path that owns the actual cache. The performance fixture does not maintain a second shadow cache model.

## Editor mutation boundary

The editor hot path follows the same “compute only what changed” rule. `validateEditorScene` remains the authoritative full validator for imported or externally constructed state. Once a scene has crossed that boundary, the local mutation APIs preserve the invariant rather than re-running whole-scene validation on every pointer/input event.

`updateNodeTransform`:

- validates only the new transform tuple(s);
- copies only the top-level node-reference array and the edited node/transform object;
- reuses sibling node objects and untouched transform tuples; and
- does not revisit mesh buffers that a transform edit cannot invalidate.

`updateMeshVertex`:

- validates the new position and target vertex index;
- copies only the top-level vertex-reference array and the edited `Vec3`;
- reuses the index buffer, all untouched vertex tuples, sibling nodes, and UV/color authoring buffers; and
- intentionally drops derived normal/tangent buffers because position changes invalidate them.

This is not an unsafe unchecked path: the source scene is expected to have been validated at its trust boundary, and each local operation validates every value capable of breaking the invariant it owns. The distinction prevents large meshes from being scanned and deep-copied merely because a user moved one object or vertex.

### Deterministic command history

`scene-editor-history.ts` layers undo/redo on top of those mutation primitives without introducing snapshots. Transform commands store the node id plus before/after transforms. Vertex commands store the node id, vertex index, before/after position, and only the derived normal/tangent references needed to restore the exact pre-edit semantic state.

The command log is an immutable `{ scene, entries, cursor }` value. Undo applies the inverse of `entries[cursor - 1]`; redo reapplies `entries[cursor]`; committing after undo truncates only the redo suffix. Commands fail closed if the current transform, position, or derived-attribute state does not match the command precondition. This makes in-memory replay deterministic and prevents stale history from silently applying to drifted state.

Undoing a vertex edit does not rebuild the whole mesh. It copies the vertex-reference array and edited tuple, reuses indices/UVs/colors, and restores previously valid normal/tangent arrays by reference. Renderer objects remain outside this model entirely.

`profiles/runtime-profiler/editor-mutations.json` exercises the public editor mutation and command-log APIs against a deterministic scene containing a 96×96 subdivided plane (9,409 vertices), 128 auxiliary nodes, 1,024 transform edits, and 192 vertex edits. The workload then undoes and redoes all 192 vertex edits before emitting its deterministic semantic checksum and command-log cursor/count. Pull-request evidence copies exactly that workload into the base checkout, requires byte-identical base/candidate output, and then captures seven process samples per revision through `runtime-profiler`. Runtime comparison remains advisory; semantic equivalence is blocking.

For the first command-log slice only, the workflow injects the new history module into a base revision that predates the feature so both revisions can execute the same workload. Once command history exists on `main`, future PRs keep the base implementation intact and compare old-vs-new command-log behavior normally.

## Runtime canaries

`profiles/runtime-profiler/scene-export.json` exercises the actual release-mode `scene_export_glb` adapter against a generated deterministic scene. The fixture intentionally contains enough meshes, vertices, attributes, and canonical reordering work to expose repeated materialization while staying bounded and repository-local.

`profiles/runtime-profiler/renderer-browser.json` exercises the reusable Three.js renderer through the static `/renderer-performance/` route. Its 64-frame, 192-node workload includes one phase that removes the final users of a geometry/material and then restores them. On a renderer that exposes work observations, the route checks the exact aggregate create/reuse/remove/evict counts before reporting success.

For pull-request browser evidence, the candidate workload files are copied into the exact base checkout before either site is built. Both revisions therefore run the same route and journey module. `runtime-profiler compare-browser` verifies scenario, journey, Playwright, Chromium, viewport, trace configuration, and normalizer identity before the two captures are interpreted together.

The profiles remain separate from correctness tests:

- ordinary CI proves semantic behavior;
- structural-sharing identity tests protect known editor allocation boundaries;
- command-log tests prove exact undo/redo, branch truncation, replay, and fail-closed preconditions;
- deterministic work observations protect known algorithmic and renderer-cache boundaries;
- runtime-profiler records process/browser runtime evidence;
- browser comparison must first establish strict workload/runtime comparability;
- no brittle wall-clock threshold is embedded in unit tests.

## Renderer variance calibration

`.github/workflows/renderer-variance-calibration.yml` measures noise separately from code changes. It builds the renderer canary once, keeps one static server alive, and performs seven sequential Chromium captures of that exact source on one runner. The calibration summarizer fails closed unless all samples have identical:

- source Git identity;
- scenario id and digest;
- execution-environment fingerprint; and
- complete browser runtime identity, including journey, adapter, normalizer, Node, Playwright, Chromium, viewport, and trace categories.

Before dependencies are installed, the workflow also records a `sha256:` calibration-surface digest derived from the committed Git objects for the root package/lock, `packages/renderer`, the benchmark route, its shared layout/CSS and build/package inputs, and the renderer-browser scenario/journey. The full Git SHA still proves same-source identity within one seven-sample run. The narrower calibration-surface digest is the future cross-run anchor: weekly artifacts may be compared for environment noise when that digest is unchanged even if unrelated repository commits changed the overall Git SHA.

`scripts/summarize_renderer_browser_variance.py` writes `3d-lab/renderer-browser-variance/v1`. It retains every raw sample, the calibration-surface digest, and reports min, median, mean, p95, max, median absolute deviation, population standard deviation, coefficient of variation, and range relative to the median for:

- the maximum top-level `EventDispatch` duration, which is the closest normalized Chromium signal for the synchronous canary action;
- longest top-level task duration;
- total top-level task duration;
- inclusive JavaScript trace duration;
- long-task count; and
- trace-event count.

The report is explicitly `calibration-only` and always has `release_verdict: false`. A single seven-sample run describes same-run noise; it is not enough to define a durable threshold. The workflow therefore also runs weekly on `main` and remains manually dispatchable so future policy can inspect cross-run variation caused by runner, browser, and operating-environment changes rather than hiding those changes inside one percentage budget.

## Next performance slices

Extend the same evidence pattern rather than introducing another profiler:

1. accumulate several scheduled renderer calibration artifacts with the same calibration-surface digest and decide whether the same-run and cross-run spread is stable enough for an explicit evaluator margin policy;
2. keep the editor command-log workload representative as drag gizmos and topology commands are added, preserving exact replay/undo semantics without snapshotting;
3. add downstream game/application journeys where the reusable renderer is a meaningful part of frame cost; and
4. introduce evaluator-owned budgets only for workloads whose variance and product relevance are understood.
