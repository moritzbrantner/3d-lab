# Imported character acceptance (#87)

This independent acceptance was established on origin/main
`a39a673` before production implementation. Shared conventions resolved at
`46d8793bb3034326561f876dcc67dbaa5aa1e432`. This draft establishes independent acceptance before implementation and uses
`Refs #87`: a public export alone does not complete the issue.

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

The additional package and actual Chromium contracts below make these runtime
requirements executable against the proposed routine public seam. Baseline failures
occur before instance creation: later assertions remain unexecuted, and every
contract plus the authority audit must pass before implementation merge.

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

## Additional independent public runtime contract (before implementation)

`packages/renderer/acceptance/imported-character-runtime.test.ts` consumes the
**actual processed output** `fox.glb` and its complete retained asset-tooling
proof, not the original source GLB. Proposed routine names
`adaptImportedCharacter(outputBytes, {provenance})`, retained
`asset.createInstance({modelMatrix?})`, and instance `seek`, `transition`,
`advance` may be independently translated to a settled public seam. They do not
license a competing parser, normalization operation, JavaScript animation sampler
or `AnimationMixer` runtime. Existing Rust format/rig/animation/playback authorities
must supply the semantics; Three.js objects only submit/present them.

The new public contract directly inspects the actual returned scene's single
SkinnedMesh: all 15 source oracle poses (joint world matrices and five deformed
world vertices), nonzero locomotion, shared geometry/material/influence-buffer
identity and unchanged bytes, separate skeleton/pose objects, retained embedded
texture, arbitrary non-oracle seek times, placed joint/vertex composition, invalid
seek/clip/transition/delta atomicity, and measured-delta crossfade partition
invariance with a real intermediate pose and target completion. World-matrix
component tolerance is 0.002 and vertex tolerance 0.02 **Fox source units**, not
invented meters. The independent native local-matrix tolerance remains 2e-5.

Seven malformed fixtures fault-inject the real processed GLB's active joint,
nonfinite/negative/zero-sum weights, inverse bind, clip target and unsupported
interpolation. Their negative trust-boundary receipts retain attribution and match
the edited bytes' integrity fields; they are explicitly not genuine processor
results or new source assets. Rejection must identify the violated semantic
boundary, not merely reject a stale hash/missing receipt. A framing test establishes
that each mutation preserves valid GLB framing and actually changes input. The
previous valid instance's pose/resources must remain unchanged and usable.

Baseline: the framing invariant passes; twelve public runtime cases are red at
missing export **before instance creation**, so their later assertions have not
executed. This makes runtime requirements executable once the public seam exists;
it does not demonstrate Rust/WASM/browser execution or candidate rendering now.
If mandatory upstream receipt verification preempts the fault-fixture semantic
boundary, independently translate these negatives to the existing authoritative
validator seam rather than accepting provenance-only rejection as skin coverage.

### Remaining exact consumer gap

There is no public live Rust/WASM imported-character sampling/transition bridge or
settled browser consumer surface on the baseline. Existing private imported-skin
lab uses AnimationMixer; existing Chromium script is an independent source oracle.
Neither is a candidate pass. Package tests inspect actual renderer resources but
create no WebGL context and cannot prove draw submission, visible animated pixels,
texture rendering, per-frame publication ownership, or Rust sampling authority.
The current package runner is Bun. If production texture decoding or the public
WASM bridge requires browser facilities, independently move these same scenarios
to actual Chromium; do not fabricate DOM/image decoders to make Bun green or force
a browser-only production adapter into an inappropriate universal shape.

Before #87 merge, a distinct implementation context must settle the existing
public bridge and consumer route within this same issue/PR, then independent
acceptance must exercise actual Chromium against it: load processed Fox once,
select Survey/Walk, arbitrary seek and fade, compare live joints/vertices, and
verify independent instances plus a nonempty visible textured character. No
placeholder window state, prepared-oracle replay, fake canvas or new child issue
is authorized. Native renderer submission may remain the explicit issue-permitted
adapter gap; shared runtime semantics may not. This expanded draft remains
partial; it does not close #87 or establish approved ARPG Knight assets.


## Actual public Chromium consumer acceptance (before implementation)

Run `bun scripts/imported-character-browser-acceptance.ts [ignored-output-dir]`.
This uses existing Playwright/Chromium, a disposable localhost port0 fixture server,
and the actual public `createThreeSceneRenderer` on a real canvas. That renderer is
the existing JavaScript/Three rendering backend, not a Rust renderer. The candidate
imported-character path must extend/reuse it, not create a parallel renderer. The
routine proposed submission name
`renderImportedCharacterInstances(existingRenderer,{camera,instances})` may be
translated independently together with the existing asset/instance method names.
No new product direction, parser, reconstruction, framework or private lab adapter
is introduced by this acceptance consumer. Asset-tooling still owns the actual
processed GLB/bundle and receipt; Rust owns pose/clip/rig/playback semantics.

The script verifies actual processed Fox integrity, initializes the public WebGL2
renderer, imports only the proposed public module, and requires:

- all15 live sampled world-joint/vertex reference poses; actual24-joint palette;
- arbitrary0.321s seek, invalid-time/unknown-clip/delta/transition atomicity;
- unchanged geometry/material/influence buffers shared across distinct skeletons;
- a decoded actual embedded texture, not a replacement material;
- actual draw submission measured by framebuffer differences from an empty frame,
  and visible motion between Survey and Walk (no DOM or prepared-pixel proxy);
- placed source-unit skinned vertices retaining root/ancestor/bind composition;
- measured-delta fade partition equivalence, intermediate pose and target endpoint;
- real WebAssembly instantiation during candidate module initialization/adaptation/
  sampling, and retained hash/length of the actual compiled artifact response;
- a screenshot and numeric/resource evidence from the real public rendered consumer.

The WebAssembly observer forwards every invocation to the real browser API and
never replaces execution or returned values. It is not an animation implementation.
An inline/synchronous bridge can receive an independently verified observer
translation that preserves real compiled-module execution/artifact identity.
The test camera and pixel/joint inspections are independent acceptance inputs and
measurements, not gameplay/presentation pose authorities. Rendering the same
submitted state in RAF only keeps the actual canvas available for screenshot.

**Mandatory source audit:** bind the observed compiled artifact to the existing
`three-d-animation`/`three-d-playback`/rig hierarchy and format lowering. Follow the
public `seek`, transition and measured-delta call graph into compiled Rust and back
into renderer pose submission. No Three AnimationMixer, JS interpolation/clock,
15-pose replay table, dummy or unrelated WASM module can satisfy authority, even if
it happens to pass numeric/pixel assertions. Geometry, skin and resource lowering
remain retained; source hash/provenance cannot silently change. Submission uses
one existing renderer/context, with no private preview, new shader stand-in or
second renderer. Inspect existing work observations where exposed, not invented
performance thresholds. Browser/renderer ownership and candidate source audit are
both required before #87 merge.

Observed baseline `d06fc58` plus this test: actual Chromium and public renderer
WebGL initialized successfully, then the missing `./imported-character` export
caused expected RED. No later seek/texture/draw/fade/WASM assertion executed. This
is a meaningful missing-capability acceptance failure, not a reason to omit the
browser contract. The previous private source oracle remains independent reference
only. The existing runtime-evidence lane must execute this protected command once
the public candidate is implemented; no green partial/package-only merge is
allowed. Full browser acceptance is now specified as an executable consumer, but
candidate behavior and authority are still unproven until implementation and audit.
No approved Knight/Sword/Shield bundle, native skin submission or ARPG readiness is
claimed.
