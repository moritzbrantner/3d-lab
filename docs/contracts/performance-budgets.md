# Performance budget policy

`3d-lab` separates deterministic work budgets from noisy runtime budgets. A budget is allowed to block only when its owner can measure the relevant work reproducibly and the threshold has enough calibration evidence to distinguish a regression from normal variance.

## 1. Deterministic structural budgets — blocking now

Structural budgets describe algorithmic work, not elapsed time. They belong with the code that owns the work and are safe to enforce in ordinary tests.

For topology editing:

| Operation | Affected source triangles | New vertices | Replacement triangles | Vertex-reference copy passes | Index copy passes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Split edge | at most 2 | at most 1 | at most 4 | at most 1 | at most 1 |
| Inset face | 1 | at most 3 | at most 7 | at most 1 | at most 1 |
| Extrude face | 1 | at most 3 | at most 7 | at most 1 | at most 1 |

`MeshTopologyWorkObservations` also records exact index values copied/written, authored attribute references copied, new attribute values, and topology-index builds/triangle visits. `topologyStructuralBudgetViolations` is the blocking policy for the bounded operation itself.

An edge split rejects non-manifold edges with more than two adjacent triangles. Inset and extrusion parameters are bounded and fail closed. The editor caches the edge-to-triangle index per mesh revision; an operation that receives that cached index reports zero index-build work itself.

The current flat indexed-mesh representation still requires one output index-array copy when topology changes. That O(mesh-size) representation cost is deliberately measured rather than disguised as operation-local work. If runtime evidence shows it dominates, the corrective architecture is a chunked/persistent topology representation or equivalent localized storage, not a larger budget.

## 2. Pull-request runtime evidence — advisory until calibrated

`profiles/runtime-profiler/editor-topology.json` exercises a deterministic 9,409-vertex / 18,432-triangle mesh through:

- 8 edge splits;
- 16 face insets;
- 16 face extrusions; and
- a complete 40-command undo/redo round-trip.

The workload emits deterministic semantic and work-fact output. Pull-request CI requires byte-identical reference/candidate output before runtime evidence is interpreted.

The runtime signals are:

1. median `process.wall_time` — primary latency signal;
2. p95 `process.wall_time` — tail signal, initially advisory;
3. median `process.max_observed_rss` — memory signal; and
4. deterministic topology work totals — diagnostic authority when runtime changes.

No wall-clock number is embedded in unit tests.

## 3. Scheduled calibration — collect before activating a gate

The topology workflow runs weekly and on manual dispatch. Each run records seven process samples plus a `sha256:` calibration-surface digest covering the topology implementation, command history, editor/mesh primitives, workload, scenario, and lockfile.

A runtime budget may be proposed only after at least **four independent scheduled runs** share the same calibration-surface digest. Those artifacts establish cross-run variance instead of treating seven samples from one GitHub runner as independent environments.

For each signal, calibration should retain:

- the per-run median;
- the per-run p95;
- median absolute deviation (MAD) across run medians;
- coefficient of variation across run medians; and
- environment/runtime identity from `runtime-profiler`.

If the calibration surface or relevant runtime identity changes, the evidence series resets rather than silently mixing populations.

## 4. Proposed evaluator policy after calibration

The evaluator, not `runtime-profiler`, will own release policy. When the minimum calibration evidence exists, start with a robust relative margin derived from cross-run medians:

`margin = max(policy floor, 3 × MAD(run medians) / median(run medians))`

Initial policy floors to evaluate against the collected data are:

- wall-time median: 10%;
- observed-RSS median: 8%.

These floors are proposals, not active thresholds. They must be reviewed against the first four same-surface calibration artifacts before activation.

A first runtime breach should produce a **confirmation-required** result. A second exact-head reference/candidate capture must reproduce the breach before the runtime budget becomes blocking. This avoids turning one noisy hosted runner into release authority.

p95 remains warning-only until its cross-run relative MAD is sufficiently stable to support a separate tail margin. It must not be folded into the median margin merely to obtain a single score.

## 5. Regression triage

When runtime regresses:

- If deterministic work also increased, fix the algorithm/materialization boundary first.
- If deterministic work is unchanged, inspect runtime-profiler hotspots/environment evidence before changing a budget.
- If only p95 moves while the median and work facts are stable, treat it as variance until repeated evidence says otherwise.
- Never raise a threshold automatically because a regression landed.
- Budget changes require an explicit policy change with supporting calibration evidence.

The same staged policy applies to the renderer canary and editor-mutation workload: deterministic work evidence first, repeated variance second, evaluator-owned runtime gates last.
