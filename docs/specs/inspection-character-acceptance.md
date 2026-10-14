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
  readonly clips: readonly {name: string; index?: number; duration: number}[]
  createInstance(options?: {modelMatrix?: readonly number[]}): InstanceLike
  dispose?(): void
}
// InstanceLike: {root: Object3D; seek(clip, seconds); advance(delta); dispose(); ...}
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
| R5 | Clips exposed with name or index plus duration | three clips Survey/Walk/Run in source order, durations equal to the production asset (1e-6) and to the proof; `index`, when present, equals position |
| R6 | Exact seek parity with the production path on the same source, within existing tolerances | Fox source vs accepted `fox.glb`: all 15 oracle samples plus Walk 0.321, Run 0.117, Survey 2.0001: joint world matrices (by name, 0.002) and five skinned world vertices (0.02 source units) against the production instance **and** the independent #87 oracle; `advance` parity after a seek, inside and past the clip end. Chromium repeats joints/vertices against production and oracle |
| R7 | Rest pose: an instance with no clip applied | fresh instance's joint world matrices equal the source glTF node TRS composition and the production fresh instance; differ from Survey@0; unchanged while a sibling seeks/advances. Chromium checks rest parity and isolation |
| R8 | Clear errors for sources without clips and for unparsable bytes | Fox with `animations` removed or empty, under its own correct pin → error mentioning clip/animation, not a pin error; 4-byte garbage, empty, truncated GLB, bare JSON under their own pins → error naming glTF/GLB/parse/invalid, not a pin error |
| R9 | Reuse the same parser, skin, animation and render path; no second skin/animation stack | static import graph of the inspection module reaches `imported-character-wasm/character.js`; its source has no `AnimationMixer`/`AnimationClip`/`KeyframeTrack`/`Interpolant`/`PropertyBinding`, no `new Skeleton/SkinnedMesh/Bone`, no `.wasm` reference, no lerp/slerp; the only WASM under `packages/renderer` is `imported-character-wasm/character_bg.wasm`, and `three-d-character-wasm` stays the only wasm-bindgen crate; Chromium observes real WASM instantiation on the inspection path |
| R10 | Rendered through the existing `renderImportedCharacterInstances`; browser render smoke | Chromium with the public `createThreeSceneRenderer` on a real WebGL2 canvas: rest pose visibly rendered (>64 changed pixels vs empty frame), seeked Walk visibly differs from rest (>8), embedded texture decoded, shared geometry across instances, no page errors; screenshot + `evidence.json` |
| R11 | Package export and docs updated | `README.md` and `docs/contracts/browser-renderer.md` name `inspection-character` and state "inspection-only" |

Tolerances are the existing #87 ones; no new budget or ratchet is introduced.

## Baseline (origin/main `00f1587` + these tests)

- `inspection-character.test.ts`: 4 pass (fixture integrity, production gate refuses
  the original source, production `fox.glb` adapts, no new WASM/crate), 19 fail at the
  missing `./inspection-character` export before any later assertion runs.
- `bun test packages/renderer`: 200 pass, 19 fail, all 19 being the new file.
- Chromium script: real WebGL2 renderer initializes, then fails on the absent export.
- The harness itself was checked against a throwaway, uncommitted prototype (outside
  the repository) that wrapped the existing Rust bridge: every behavioural Bun case
  and the full Chromium script passed, with bit-identical source-vs-output poses.
  Only export/docs/import-graph checks failed, as expected for an unpublished module.

## Open points (not decided here)

1. **CI wiring.** The Chromium script is not yet a step in
   `renderer-runtime-evidence.yml` (and the workflow's path filter does not list it).
   Adding it is CI work for the implementation PR; this acceptance does not edit CI.
2. **Unnamed clips.** The issue says "name or index"; the existing Rust loader rejects
   sources whose clip names are missing or duplicated ("clip names must be present and
   unique"). Whether inspection should accept unnamed clips and seek by index is open;
   the tests only require names for Fox and allow an `index` field.
3. **Returning to rest.** The issue asks for "an instance with no clip applied". The
   tests use a fresh instance; whether an existing instance can be reset to rest is not
   specified.
4. **Pin format.** The tests assume lowercase 64-hex `sha256` and an integer
   `byteLength`, and reject strings/NaN/negatives. Accepting uppercase hex is not tested.
5. **Exposing the pin.** Whether the asset reports its verified `{sha256, byteLength}`
   (useful to the viewer) is not required.
6. **SimpleSkin / RiggedFigure.** The issue names them as example catalog sources; this
   acceptance uses Fox only because it has an accepted production import for parity.
   The vendored `khronos-simpleskin-embedded.gltf` is a `.gltf` (JSON), not GLB.
7. **Production gate is structural.** `provenanceOf` compares receipt fields, not a
   signature (as documented in `browser-renderer.md`); a hand-forged receipt matching the
   source bytes would pass it. That is existing #87 behaviour and is out of scope; the
   tests only require that the inspection asset and pin-shaped objects do not pass it.
8. **Render-call ownership.** Whether the inspection module re-exports the render call
   or consumers import it from `./imported-character` is left to the implementation.
