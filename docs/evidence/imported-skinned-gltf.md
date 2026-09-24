# Imported skinned glTF evidence

Issue: #62

The skeletal animation page now exercises the pinned Khronos **SimpleSkin**
glTF-Embedded sample through the same explicit weighted renderer boundary used by
the teaching character.

The canonical source remains `fixtures/catalog/khronos-simpleskin-embedded.gltf`.
`scripts/sync-web-animation-fixtures.mjs` verifies its recorded byte length and
SHA-256 from the provenance manifest before copying it into the static site's
`public/fixtures` directory. Both `dev` and `build` run that synchronization,
so the demo is offline and deterministic rather than fetching a CDN at runtime.

`web/lib/imported-skin.ts` deliberately separates responsibilities:

- Three.js `GLTFLoader` parses glTF and owns glTF semantics.
- the import adapter extracts the already-authored indexed geometry, JOINTS_0,
  WEIGHTS_0, skeleton and bind transform;
- `batchWeightedSkin` validates/packs/batches those explicit values;
- the renderer does not parse glTF, invent weights, choose clips or own provenance.

The SimpleSkin fixture contains one indexed skinned primitive, two joints, ten
vertices and one LINEAR rotation animation lasting 5.5 seconds. The renderer
normalization keeps one material submission and compacts its small joint palette
to four uint8 joint-index bytes per vertex.

The regression test parses the canonical asset twice with GLTFLoader. One copy is
left on Three.js' reference SkinnedMesh path; the other is normalized through
`batchWeightedSkin`. Every vertex is compared in world space at six animation
times, including the first and final keyframes. This protects bind transforms,
joint ordering, authored weights and animation interoperability without comparing
screenshots as a correctness oracle.

The existing Chromium evidence lane additionally loads the static fixture from the
built site, requires the expected joint/clip/draw/index metadata, seeks the imported
clip to exactly 2.75 seconds and captures `imported-simpleskin.png`.
