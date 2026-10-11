# Imported character acceptance (#87)

This independent acceptance was established on origin/main
`a39a673` before production implementation. Shared conventions resolved at
`46d8793bb3034326561f876dcc67dbaa5aa1e432`. This draft is a partial acceptance
handoff and uses `Refs #87`: a public export alone does not complete the issue.

## Actual source and authority

The fixture is Khronos Fox at source revision
`90d7ede14c7e280af263824604b427a1ca02cb66`, path
`Models/Fox/glTF-Binary/Fox.glb`. Source SHA-256 is
`d97044e701822bac5a62696459b27d7b375aada5de8574ed4362edbba94771f7`
(162852 bytes). Source model is PixelMannen's CC0 work; rigging/animation is
attributed to tomkranis and conversion to @AsoboStudio/@scurest, under CC BY 4.0.
The adjacent upstream README/license preserve those attributions.

This is technical conformance evidence, **not an approved Knight, humanoid,
medieval art asset, or game consumer approval**. No humanoid mapping is invented.
The approved game asset remains unavailable to this acceptance.

Actual asset-tooling `scene.import.gltf@2` at
`cabe242da90bd62521bfc921af8165236a8ccabb` processed the source. Both source and
output passed the Khronos validator without warnings. The operation's existing
`requiredClipNames` policy requires Survey/Walk/Run. Two real executions returned
identical results. The retained output hash is
`e8f4a6cc4677f7f5942fb6c0c9c639586fb2d6617ec4b2802c82fca72f6ef505`
(164252 bytes). The complete actual build identity, analysis, result, source
AssetRef, dependency-lock hash and processor fingerprint are retained in
`fixtures/imported-character/fox.production-import.json`.

The output retains one indexed skinned primitive, 1728 vertices, 576 triangles,
24 ordered skin joints, 26 scene nodes, inverse binds, three named LINEAR clips,
and one embedded base-color texture. Material/resource references must survive
composition; quietly dropping the texture does not satisfy acceptance.

## Runnable established evidence

- `bun test packages/renderer/acceptance/imported-character.test.ts`: fixture integrity,
  import/source identity, accepted policy, warnings and clip names pass; the
  absent public package export fails on the baseline.
- `cargo test -p three-d-formats --test imported_character_clips`: existing native
  clip lowering and sampling match independent Three.js reference local matrices
  at endpoints and quarter intervals of all three clips (15 poses, 24 joints).
  Exact seek replay and invalid-time atomicity are covered. Tolerance is `2e-5`
  per local-matrix component, not a screenshot comparison.
- `bun scripts/replay-imported-character-fixture.ts <asset-tooling-checkout>
  <explicit-Fox.glb>`: hashes the explicitly acquired original source, delegates
  two executions to the existing production operation, compares complete recorded
  identities/results and exact committed GLB bytes. Processor drift fails closed.
  It performs no network acquisition, fixture edits, or second normalization.
- Serve the repository root and run
  `bun scripts/imported-character-reference.ts http://127.0.0.1:4187/
  target/fox-reference.json` to regenerate the independently evaluated reference.
  GLTFLoader/AnimationMixer/SkinnedMesh in actual Chromium decode the real output,
  including its embedded texture. Reference records all joint world matrices and
  five deformed world vertices per pose, plus local transforms for native clip
  comparison. It is a reference oracle, **not candidate browser acceptance**.

The reference does not inject output into production or author animation clips.
All animation/skin data comes from the actual imported source. The test's initial
local pose uses the reference start pose to supply unanimated defaults; existing
native clips still own every sampled animated channel.

## Remaining mandatory independent scenarios before implementation merge

1. Public `./imported-character` is a reusable entrypoint. A retained immutable
   asset handle lowers through existing parser/asset/animation/renderer boundaries
   once. Routine interface names may be translated independently without weakening
   these semantics. Consumers do not import private `web/lib` or write local
   adapters/normalizers. Existing static assets remain compatible.
2. The original scene-to-skin relation is explicit: skin slots, glTF node indices,
   parent/non-joint ancestors, inverse binds, root/model transform and named clip
   targets retain their distinct meanings. Fox's 26 nodes are not silently
   equated with its 24 palette slots. Existing `RiggedAsset`, `Skeleton`,
   `SkinInfluence` and format lowering remain the semantic authorities.
3. Actual public asset instances share immutable indexed geometry, material refs,
   influence/resource buffers and clip data. Independent pose/skeleton state lets
   instance A seek Walk while B stays Survey; subsequent A updates never mutate B,
   asset buffers or resource identity. Test identity and bytes, not claimed labels.
4. Public sampling and transitions use `three-d-animation`/`three-d-playback`.
   Native and browser seek all reference poses, compare joint world matrices and
   deformed world vertices, and prove actual nonzero motion. Browser runtime must
   support arbitrary deterministic seek and existing crossfade semantics, not
   merely replay the 15 reference snapshots or use an independent JS sampler.
5. Real Chromium renders the actual public character on the consumer/lab surface,
   selects at least Survey and Walk, seeks exact times, transitions, and observes
   independent instances. Compare live joint/vertex evidence with the independent
   oracle, require a live render context and nonempty visible character; retain
   screenshots as visual evidence. Never replace an unavailable texture with an
   invented shaded substitute and claim complete material rendering.
6. Invalid joint slots, nonfinite/negative/zero-sum weights, invalid inverse binds,
   dangling clip targets and unsupported interpolation fail closed through the
   existing boundaries. Errors leave previous valid asset/pose/resource state
   intact. Parser/normalizer behavior belongs to its current owner.
7. Existing #66 animated bounds/culling remains authoritative. Where existing work
   counters exist, verify pose updates reuse immutable resources rather than
   rebuilding geometry or publishing React state per frame. Do not invent budgets.

These runtime scenarios are **not covered by the present public-export failure**.
They require independent executable coverage against the settled production seam
before any implementation merge or #87 completion claim.

## Explicit baseline gaps

`web/lib/imported-skin.ts` is private, mutates the decoded scene, and exposes
Three.js clips. The existing lab uses `AnimationMixer`. Other Rust animation labs
present prepared evidence; no live browser Rust sampling bridge currently exists.
The prepared oracle here establishes reference values, not that missing bridge.

`three-d-formats::load_gltf_animation_clips` maps numeric scene-node targets and
preserves clips. Generic mesh import preserves vertex influences, but explicitly
leaves scene-node skin/skeleton assembly separate. Its material boundary rejects
base-color textures, so Fox cannot be honestly claimed as a fully native-rendered
asset through that path. Preserve reference metadata; record #86 material coverage
and any permitted native adapter follow-up explicitly rather than broadening #87
into PBR or adding another parser.

Issue #87 permits an explicit native adapter follow-up when payload submission is
unavailable; renderer-independent pose/skin semantics still need proof. Local
AGENTS requires one task/branch/PR and prohibits unapproved splits. This acceptance
does not create a child issue, claim full scope, close #87, or claim downstream
ARPG #55/#145 ready.
