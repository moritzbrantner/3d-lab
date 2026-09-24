# Character skinning and animation runtime

Base: `7889a0066df928b101d42fb16f32353bd26c0696` (main before this change).

## Ownership and model changes

`packages/renderer/rigid-skin.js` is a narrow renderer adapter. It receives an
existing Skeleton, an explicit bind matrix, source geometry/materials, joint
indices, and source-to-model-bind transforms. It does not generate hierarchy,
choose animation, parse models, retarget clips, or normalize asset provenance.

`web/lib/character-model.ts` composes the teaching humanoid. Torso sections now
start at the proximal joint (the prior Hips -> Spine gap is filled); hands and
eyes provide articulation/facing cues; bind-pose feet reach the floor. The 13
joints and idle/walk/wave demo remain. This is deliberately a rigid-attachment
skin, not a claim of smooth multi-joint humanoid skinning or an imported model.

The helper is a scene sibling, not a model child: SkeletonHelper already uses
the joint root's world matrix. Nesting it under a translated model previously
applied the model transform twice.

## Performance evidence and ratchets

The new teaching model has **31 authored rigid parts and 3 distinct materials**.
They become one indexed SkinnedMesh with **3 contiguous material groups**.
The old main showcase had 26 individually rendered mesh parts. The structural
color-pass budget therefore changes from 26 to 3 relative to the old model, or
31 to 3 against an unbatched version of the richer new model. These are material
submission counts, NOT measured whole-scene draw counts or GPU frame times.

The runtime reuses one CharacterPose and the existing bone palette/geometry.
It does not allocate a new pose or copy RigState on every animation frame. React
receives independent 10 Hz snapshots and never writes a delayed snapshot back
into the runtime clock. OrbitControls, Three.js and React may still allocate;
this is not a zero-allocation claim about the entire application.

Run `bun run bench:character-pose` from the repository root. The script also
runs with `node --experimental-strip-types scripts/character-pose-evidence.mjs`.
It retains the historical sampler in `scripts/fixtures/character-rig-baseline.ts`,
checks 6,003 samples, compares every unchanged channel, verifies stable output,
finite-input rejection, seam velocity and exact frame stepping, and reports
nine alternating-order timing rounds. Root X/Y for walk and root yaw for idle
are intentional mathematical changes to remove loop-seam velocity cusps.

The attached `character-pose-local.json` records one Node v22.16.0 run: median
62.355 ms historical versus 11.873 ms reusable sampling over 240,000 walk poses
(5.25x in that process). This is a CPU microbenchmark, not a browser/GPU or heap
measurement; engine, host and workload can change the timing. Timing does not
gate CI. Deterministic output identity, topology reuse, group count and parity do.

## Correctness and controls

Renderer tests compare every vertex of the batch against original rigid meshes
through 17 poses, including non-identity bind/root transforms and parent motion.
They check material identity/group ranges, index rebasing, borrowed resource
ownership, and explicit rejection of partial draw ranges, pre-skinned
inputs, invalid joint indices, singular transforms and baked reflections.
The first CI run exposed a package-boundary identity bug: an `instanceof Mesh`
check missed a mesh from the renderer package's separate Three.js module. Both
resource cleanup and inspection now use Three's structural type flags, with an
exactly-once resource disposal regression. Model tests enforce 13 joints,
31-to-3 grouping, helper alignment, floor contact, and stable geometry/index/
palette buffers across 120 poses.

The showcase provides exact time entry in seconds, exact numeric playback speed,
1/60-second forward/backward stepping (clamped at boundaries), a bind-pose toggle,
and skeleton/x-ray inspection. Numeric fields preserve partial/empty editing
drafts, commit on Enter/blur, and cancel on Escape. The coarse timeline slider
remains an adjunct.

## Limits and verification status

Culling is deliberately disabled for this small animated teaching mesh rather
than reusing incorrect static bind-pose bounds or skinning every vertex on the
CPU each frame. Reusable consumers must supply conservative animated bounds
before enabling culling. Clear mesh.boundingBox/boundingSphere after pose
changes before raycasting. The showcase does this; raycasting bounds are lazy.
Batched translucent groups do not preserve per-part transparency sorting; x-ray
mode is an inspection aid, not a general translucent character renderer.

Local execution verified the pure pose evidence script and JavaScript syntax.
The editing environment had no Bun, Three.js dependencies or browser, so the
renderer/model Bun tests, web typecheck/build and visual/browser behavior require
CI/browser execution. Check the pull request's current checks for their outcome.
No dependency or CI workflow was added; tests use the existing root and web lanes.
