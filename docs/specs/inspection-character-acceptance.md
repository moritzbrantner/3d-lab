# Inspection-only character entry point acceptance (#118)

Independent acceptance written on `feat/inspection-character-118` from origin/main
`00f1587`, before implementation. It translates issue #118 into checkable
requirements and does not add product policy. #118 blocks asset-tooling#111
(owner decision, option A: a Pages viewer for a **pinned original catalog
source** with play/pause, exact seek, rest pose and camera presets).

## Boundary

The production boundary from #87 stays as it is. `./imported-character`
(`adaptImportedCharacter(bytes, {provenance})`) accepts only accepted
`scene.import.gltf@2` output with full provenance, and its `provenanceOf` gate is
unchanged in behaviour. #118 adds a **separate, explicitly inspection-only** entry
point for original source bytes that are pinned only by hash and length. It is not
a production import, does not imply asset-tooling acceptance, and must never be
usable as, or substitute for, a production `ImportedCharacterAsset`.

## Source fixture

`fixtures/imported-character/Fox.source.glb` is the original Khronos Fox, vendored
byte-identical from the pinned source already named by the #87 proof:

- URL: `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/90d7ede14c7e280af263824604b427a1ca02cb66/Models/Fox/glTF-Binary/Fox.glb`
- SHA-256 `d97044e701822bac5a62696459b27d7b375aada5de8574ed4362edbba94771f7`,
  162852 bytes, git blob `1ef5c0d05658caea339680fe581aa2c8302b3365` (matches upstream).
- It equals `fox.production-import.json` `source` and the output's `sourceSha256`.
  The accepted import of it is `fox.glb` (SHA-256 `e8f4a6cc…f505`).
- Attribution: model PixelMannen (CC0-1.0); rigging and animation tomkranis
  (CC-BY-4.0); glTF conversion @AsoboStudio and @scurest (CC-BY-4.0). Recorded in
  `Fox.source.asset.json`, with the upstream `Fox.LICENSE.md` and `Fox.source.md`.

Catalog sources without a production import (asset-tooling#111 inspects them):

- `fixtures/imported-character/RiggedFigure.source.glb`: Khronos RiggedFigure at the
  same revision (`Models/RiggedFigure/glTF-Binary/RiggedFigure.glb`), SHA-256
  `d6be85417d3e256861ee733eea6916093a7af7c79c16366181fd8abcaeb38cf5`, 50116 bytes,
  git blob `c505a33dfa5ba84bd5f3dd0a85f74ee4c9978322` (matches upstream); one clip with
  **no authored name**, 1.25 s. © 2017 Cesium, CC-BY-4.0; recorded in
  `RiggedFigure.source.asset.json`.
- SimpleSkin reuses the already vendored, byte-identical
  `fixtures/catalog/khronos-simpleskin-embedded.gltf` (SHA-256
  `7d0c3f48d0510d101269cb4fdd3ee035eaada0e04809a0899e0b4cfe8c38e68f`, 3566 bytes, CC0,
  attribution in `khronos-simpleskin-embedded.asset.json`): an embedded `.gltf` (JSON
  with data URIs), one unnamed 5.5 s clip.

## Assumed API (routine names may be translated; semantics may not)

```ts
// package.json exports["./inspection-character"] = {types, import} under packages/renderer
export function adaptPinnedCharacterSource(
  source: ArrayBuffer | ArrayBufferView,
  pin: {sha256: string /* lowercase hex */; byteLength: number},
): Promise<InspectionCharacterAsset>
interface InspectionCharacterAsset {          // frozen
  readonly validation: "inspection-only"
  readonly provenance?: undefined             // never production provenance
  readonly clips: readonly {index: number; duration: number; name?: string}[]
  createInstance(options?: {modelMatrix?: readonly number[]}): InstanceLike
  dispose?(): void
}
// InstanceLike: {root: Object3D; seek(clip: string | number, seconds: number);
//   advance(delta); dispose(); ...}  A number seeks the clip at that index;
//   a non-integer or out-of-range index rejects and leaves the pose unchanged.
// i.e. the same shape renderImportedCharacterInstances already consumes.
```

If the inspection module re-exports `renderImportedCharacterInstances`, it must be the
identical production function; otherwise consumers use the one from `./imported-character`.

## Requirements and the tests that check them

Bun: `bun test packages/renderer/acceptance/inspection-character.test.ts`.
Chromium: `bun scripts/inspection-character-browser-acceptance.ts [output-dir]`.

| # | Requirement (from the issue) | Check |
| --- | --- | --- |
| R1 | Public, separately named export `./inspection-character` exporting `adaptPinnedCharacterSource`; shipped in the package so asset-tooling can consume it through a commit-pinned git dependency | export test: `types`/`import` exist, inside `files`, not an alias of `./imported-character`; `.d.ts` declares the function, `sha256`, `byteLength`, `"inspection-only"`; `./imported-character` export unchanged |
| R2 | SHA-256 and byte length verified **before** parsing; fails closed | wrong SHA-256 on genuine bytes, wrong length, truncated bytes under the genuine pin → pin error, and `GLTFLoader` parse is never called; ordering: corrupt bytes under the genuine pin → pin error, the same corrupt bytes under their own pin → a different, non-pin parse error; missing/malformed pins reject; bytes mutated by the caller after the call cannot be what gets parsed; an offset view is hashed over exactly its own bytes. Chromium repeats the corrupt-bytes ordering and wrong-hash rejection |
| R3 | Result clearly marked inspection-only, never passes as a production asset | `validation === "inspection-only"`, frozen and not overwritable, no production `provenance`; the asset, a spread of it, or a pin-shaped object passed as `provenance` to `adaptImportedCharacter` is rejected by the existing gate |
| R4 | `adaptImportedCharacter` and its provenance gate behaviourally unchanged; existing acceptance green | original source bytes still rejected without validated provenance (with `{}`, the source-pin, or the real proof, which belongs to the output); `fox.glb` + proof still adapts with full provenance and no `validation` field; all existing `imported-character*` tests and `scripts/imported-character-browser-acceptance.ts` stay green |
| R5 | Clips exposed with name or index plus duration | every clip has `index` equal to its position and `duration`; Fox: Survey/Walk/Run names in source order, durations equal to the production asset (1e-6) and to the proof; Fox `seek(i, t)` equals `seek(name, t)` exactly |
| R5b | Unnamed clips are addressable by index; sources without a production import load | RiggedFigure (Bun and Chromium) and SimpleSkin `.gltf` (Chromium only) load under their pins as inspection-only, expose `{index: 0, duration}` (1.25 s / 5.5 s) and optional string `name`; `seek(0, t)` at two times gives different joints and re-seeking a time gives identical joints; indices 1, -1, 0.5, NaN reject without changing the pose; rest pose and index seeks at several times match an independent three.js `GLTFLoader` + `AnimationMixer` reference within 0.002 per world-matrix component; both render visibly through the shared call |
| R6 | Exact seek parity with the production path on the same source, within existing tolerances | Fox source vs accepted `fox.glb`: all 15 oracle samples plus Walk 0.321, Run 0.117, Survey 2.0001: joint world matrices (by name, 0.002) and five skinned world vertices (0.02 source units) against the production instance **and** the independent #87 oracle; `advance` parity after a seek, inside and past the clip end. Chromium repeats joints/vertices against production and oracle |
| R7 | Rest pose: an instance with no clip applied | fresh instance's joint world matrices equal the source glTF node TRS composition and the production fresh instance; differ from Survey@0; unchanged while a sibling seeks/advances. Chromium checks rest parity and isolation |
| R8 | Clear errors for sources without clips and for unparsable bytes | Fox with `animations` removed or empty, under its own correct pin → error mentioning clip/animation, not a pin error; 4-byte garbage, empty, truncated GLB, bare JSON under their own pins → error naming glTF/GLB/parse/invalid, not a pin error |
| R9 | Reuse the same parser, skin, animation and render path; no second skin/animation stack | static import graph of the inspection module reaches `imported-character-wasm/character.js`; its source has no `AnimationMixer`/`AnimationClip`/`KeyframeTrack`/`Interpolant`/`PropertyBinding`, no `new Skeleton/SkinnedMesh/Bone`, no `.wasm` reference, no lerp/slerp; the only WASM under `packages/renderer` is `imported-character-wasm/character_bg.wasm`, and `three-d-character-wasm` stays the only wasm-bindgen crate; Chromium observes real WASM instantiation on the inspection path |
| R10 | Rendered through the existing `renderImportedCharacterInstances`; browser render smoke | Chromium with the public `createThreeSceneRenderer` on a real WebGL2 canvas: rest pose visibly rendered (>64 changed pixels vs empty frame), seeked Walk visibly differs from rest (>8), embedded texture decoded, shared geometry across instances, no page errors; screenshot + `evidence.json` |
| R11 | Package export and docs updated | `README.md` and `docs/contracts/browser-renderer.md` name `inspection-character` and state "inspection-only" |

Tolerances are the existing #87 ones; no new budget or ratchet is introduced.

## Baseline (origin/main `00f1587` + these tests)

- `inspection-character.test.ts`: 5 pass (Fox and RiggedFigure fixture integrity,
  production gate refuses the original source, production `fox.glb` adapts, no new
  WASM/crate), 23 fail at the missing `./inspection-character` export before any later
  assertion runs.
- `bun test packages/renderer`: 201 pass, 23 fail, all 23 being the new file.
- Chromium script: real WebGL2 renderer initializes, then fails on the absent export.
- The harness itself was checked against a throwaway, uncommitted prototype (outside
  the repository) that wrapped the existing Rust bridge: every behavioural Bun case
  and the full Chromium script passed, with bit-identical source-vs-output poses.
  Only export/docs/import-graph checks failed, as expected for an unpublished module.
  The extended prototype (index seek mapped onto the existing bridge) also passed the
  RiggedFigure and SimpleSkin cases in Bun and Chromium against the AnimationMixer reference.

## Open points (not decided here)

1. **CI wiring.** The Chromium script is not yet a step in
   `renderer-runtime-evidence.yml` (and the workflow's path filter does not list it).
   Adding it is CI work for the implementation PR; this acceptance does not edit CI.
2. **Unnamed clips (settled).** Unnamed clips are addressable by index on the inspection
   path; production naming rules are unchanged. For context: `three-d-formats` already
   substitutes `animation_<index>` for a missing clip name before the "clip names must be
   present and unique" check, so these sources pass that check. Whether the inspection
   asset reports such a substituted string as `name` is left open; the tests accept it
   but do not require it, and never compare it with an authored name.
3. **Returning to rest.** The issue asks for "an instance with no clip applied". The
   tests use a fresh instance; whether an existing instance can be reset to rest is not
   specified.
4. **Pin format.** The tests assume lowercase 64-hex `sha256` and an integer
   `byteLength`, and reject strings/NaN/negatives. Accepting uppercase hex is not tested.
5. **Exposing the pin.** Whether the asset reports its verified `{sha256, byteLength}`
   (useful to the viewer) is not required.
6. **SimpleSkin in Bun.** Decoding its data URIs through `GLTFLoader` needs browser
   facilities Bun lacks (`ProgressEvent`), so SimpleSkin is covered only in Chromium; no
   DOM shim is added. RiggedFigure is covered in both.
7. **Production gate is structural.** `provenanceOf` compares receipt fields, not a
   signature (as documented in `browser-renderer.md`); a hand-forged receipt matching the
   source bytes would pass it. That is existing #87 behaviour and is out of scope; the
   tests only require that the inspection asset and pin-shaped objects do not pass it.
8. **Render-call ownership.** Whether the inspection module re-exports the render call
   or consumers import it from `./imported-character` is left to the implementation.
