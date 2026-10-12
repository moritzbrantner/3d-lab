# Independent material/resource-preserving scene export (#116)

This technical prerequisite of video-to-3d#84 is owned by 3d-lab. Independent
acceptance baseline is main `076a4a4509e8aed90eb7b4638118777615155c05`, fetched
before creating this branch. Current local AGENTS/CLAUDE and all24 live resolved
convention files apply; resolver diagnostics were empty, sourceRevision
`46d8793bb3034326561f876dcc67dbaa5aa1e432`. This is acceptance-only, before any
#116 production. Rust owns assets, hierarchy, transforms and reusable export;
asset-tooling owns source processing/provenance; Video owns canonical scene
selection, semantic identities, provenance sidecars, colliders and CLI behavior.
No new parser, private Video GLB merger, renderer expansion or second normalizer.

## Immutable outcomes and routine API proposal

`material_scene_contract.rs` proposes `SceneSnapshot::from_asset(asset,nodes)`
for consuming a validated static Asset; scene node mesh indices identify its
existing mesh groups. A proposed validated `SceneResources` plus
`with_material_resources(resources, primitive_bindings)` permits the real Video84
case: geometry-only imported resources with separately supplied canonical typed
Material/EncodedImage/TextureSampler/Texture tables. The fixture has one group,
two primitives and two scene instances sharing those resources. Representation,
names and signatures can be independently translated before production, without
weakening the outcomes. This does not require Arc or a parallel asset model.
Reuse existing Asset referential validation. Validation of an imported Asset is
not scene normalization.

Both paths must use the existing public `export_scene_glb` authority and retain:

- every authored primitive, indexed positions/normals/UV0 and material binding;
- named parent/children, intended local TRS and independently checked world
  placement, with no second coordinate conversion;
- factor values, double-sided behavior, base-color, metallic-roughness and normal
  texture channels that the current typed Asset supports;
- exact encoded checker image bytes/MIME and image/texture/sampler references,
  filtering and wrapping, embedded in one portable GLB;
- repeat byte identity, unchanged retained scene/resource data and shared
  resources across two instances rather than per-instance copies.

The original geometry-only constructors/export remain compatible. The first
normalization follows existing scene semantics and observations; only an
already normalized retained scene export must report zero normalization passes.
Direct architecture review remains a required gate: consuming/borrowing should
retain imported geometry and resources without duplicate whole buffers merely
for adaptation or repeated instances. Test fixture to_vec/clone calls prepare
independent small oracle data; they do not authorize production copies. Existing
observations and source audit prove this boundary, not a new arbitrary budget.

Useful failure must expose dangling image/sampler/material references, malformed
primitive-binding shape, unsupported UV sets, non-glTF image MIME and imported
skin influences at this explicitly static seam. A resource constructor or later
composition/export boundary can reject unsupported UV/MIME semantics. Silently
choosing UV0, dropping skin or claiming portable unsupported images is forbidden.
Existing loader rejection remains authoritative for unsupported source semantics.
The stale asset-model prose claiming base-color/MR textures absent is not a test
limit: current typed model and loader already support them; production should
correct that prose in its own change.

## Fixtures and consumer

`prepare-material-fixture.py` deterministically encodes SOURCE GLBs only: one
triangle with actual normals/UV0, two authored primitive/material bindings, a
rotated/translated parent, and two instances. `geometry-only.glb` has the same
geometry/hierarchy without materials/resources. It never writes production
export output. The exact checker PNG is reused from the independent Video84
fixture, whose preparation derives checker data from authored synthetic truth;
this is interchange conformance, not reconstructed footage or approved art.

Fixture SHA-256:

- checker.png: `4143a30ba06146b0020708037bc68fd07477f3e68d75f409e63b8a6bea121099`
- geometry-only.glb: `8ef3bade8e67919bf9615690169728223a91459412ce8555f21098b83ffb985b`
- textured.glb: `5f3b640932324fb80c3589152f87a015a03a5c059dcf09e6096d2cf4c4bac297`

Native checks read actual exported GLB using the existing independent gltf crate.
The Blender consumer uses generic node names, not Video's semantic extras IDs.
Expected bounds are authored from the source triangle and parent90-degreeZ/TRS:
canonical Y-up to Blender Z-up maps `(x,y,z)` to `(x,-z,y)`. The Blender importer
also maps UV `v` to `1-v`; native glTF checks original UVs exactly. Consumer checks
actual hierarchy, world bounds, primitive/material assignments, UVs, material
factors, live image-node links and checker pixels, then edits an instance and
parent to prove correct independent and inherited transform effects.

```sh
cargo test -p three-d-export --test export_material_baseline
cargo test -p three-d-export --test material_scene_contract
# fresh evidence path, actual verified Blender5.0.1 binary:
tools/acceptance/material-export-portable.sh /external/new-proof /path/to/blender
```

Pinned consumer is Blender5.0.1; reuse the Video84 tooling archive verified with
SHA-256 `8019580ee1b7262e505f4196a00237ccf743c88d205b38d34201510676e60b09`.
The portable directory contains only actual production-export GLBs, no input
GLBs or original texture workspace. Native assertions forbid external image
URIs; the checker reference is an independent oracle supplied after import, not
an asset dependency. Both authored and caller-bound exports must import/edit in
actual Blender. Each external Blender process has a 300-second operational
timeout with a 10-second forced-termination grace period; a timeout fails the
gate, rather than becoming passing or skipped evidence. This is subprocess
lifecycle protection, not a gameplay cadence or export performance budget. Source-fixture harness self-tests are distinct from this gate.

## Chronological baseline and remaining gates

The initial current-path probe expected two materials but observed zero. Before
production, independent review recognized that the old geometry-only API cannot
recover material data callers cannot pass. The retained characterization now
asserts source loader2/output0 as evidence of a missing seam, not an impossible
expectation or permission to lose bindings in the proposed API. It is **3 GREEN**:
actual textured source validation, legacy export/retained normalization/repeat
bytes, and actual missing-seam characterization. Logs:
`/tmp/3dlab116-existing-export-baseline.log` (initial probe),
`/tmp/3dlab116-existing-characterization.log` (correct characterization).

The eight full-contract tests are **compile RED** at missing SceneResources and
SceneSnapshot::from_asset APIs (`/tmp/3dlab116-proposed-seam-red.log`). Their later
resource/hierarchy/negative/normalization/output assertions are **UNRUN**, not
individually witnessed failing cases. Production portable-export Blender is
also UNRUN. This draft is not merge-ready.

Actual pinned Blender source-fixture harness self-test is GREEN for the authored
textured INPUT and correctly rejects the geometry-only INPUT at missing material
bindings. These validate the consumer harness, not exported product output. The
initial harness UV expectation was corrected before production to match the real
Blender import convention. Reports/logs `/tmp/3dlab116-source-consumer-{selftest,negative}.*`.
Python/script syntax, Rust formatting and baseline-test strict Clippy passed.
Fixture regeneration is byte-identical. No full CI/renderer/browser pass or
production output claim is made.

Before merge require the full public native contract and both actual portable
Blender outputs, geometry-only compatibility, existing affected formats/assets/
scene/export tests, repository CI and direct authority/whole-buffer review.
Pages is not this library interchange capability's verification surface; no fake
browser rendering substitutes for Blender. This does not close Video84 CLI,
canonical provenance/metadata/selection or three-real-video product acceptance,
and does not expand renderer86 or animated export.
