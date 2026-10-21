# Ranger three.js reference (#141)

Plain three.js running a real, published game character is the capability reference for
the existing 3d-lab imported-character candidate. This record measures; it adds no
candidate capability. Consumers ship with plain three.js
([MMORPG #244](https://github.com/moritzbrantner/mmorpg/issues/244),
[asset-tooling #281](https://github.com/moritzbrantner/asset-tooling/issues/281)) and do not
wait on this; asset-tooling Atlas 7.1.1 keeps 3d-lab's character runtime historical/optional.

## Identities

- Character: the rolling asset-tooling release
  [`humanoid-ranger-male`](https://github.com/moritzbrantner/asset-tooling/releases/tag/humanoid-ranger-male)
  (Atlas Decision 7.1.5; assets are replaced in place). Last run on its
  `humanoid.ranger.male.tar` uploaded 2026-10-18 (sha256 `f883d262…341897`, built from
  asset-tooling `3748069`; `export.ref.json` bundle sha256 `3c2c5d06…513c58`). That build
  predates asset-tooling #340 (`humanoid-sockets-v2`, `humanoid-item-v1`, left-handed
  sockets). `gltf-resources-v1` bundle entries `humanoid.ranger.male`, `equipment.sword.arming`, `equipment.shield.heater`
  and the entry's `humanoid-sockets` / `humanoid-clips` attachments, used as supplied.
- Reference: three.js r185 `GLTFLoader`, `AnimationMixer`, `SkeletonUtils.clone`; items are
  parented under the socket joint so their `grip` node lands on the socket transform.
- Candidate: 3d-lab `aad5d85` `adaptImportedCharacterBundle`, `adaptImportedItemBundle`,
  `attach`, `seek` (`packages/renderer/imported-character.js`, unchanged).

## Rerun

```sh
gh release download humanoid-ranger-male -R moritzbrantner/asset-tooling -p humanoid.ranger.male.tar -p export.ref.json -D target --clobber
bun scripts/ranger-three-reference.ts target/humanoid.ranger.male.tar
```

Manual/local only; routine CI does not fetch the release and the bundle is not committed.
The release changes in place, so keep a local copy of the tar when a fixed input is needed;
`reference.json` records its sha256. The run uses the review tar (PNG textures, no meshopt);
the release's per-entry KTX2/meshopt downloads are not exercised.
Output in `target/ranger-three-reference/`: `reference.json` (joint and socket world
matrices, 16 deformed vertices across four skinned meshes, clip durations, material
summaries, numeric differences) and `screenshots/<pose>.png` (same camera at about 6 m,
same light values, reference left, candidate right). A candidate operation that throws is
recorded `unsupported` with its error.

## Tested poses

rest; `Idle_Loop` 0.5 s; `Walk_Loop` 0, ¼, ½, ¾ of its 1.3333 s; `Sword_Regular_C` 0.65 s;
`Idle_Shield_Loop` 0.5 s. Arming sword on `hand_r.weapon`, heater shield on `hand_l.shield`
in every pose.

## Observed (2026-10-21, rolling tar above, Chromium/SwiftShader)

| Capability | Candidate | Observed difference vs three.js |
| --- | --- | --- |
| Bundle load (default entry: 2 skins, 12 meshes, 13 textures, 52 clips) | supported | clip names and durations identical for all 52 clips |
| Joint world transforms (65 joints, 8 poses) | supported | max 9.8e-7 m, 8.9e-5° (`Sword_Regular_C`) |
| Socket and attached `grip` placement (both sockets, 8 poses) | supported | max 8.3e-7 m, 8.3e-5° |
| Deformed vertices (16 per pose) | supported | max 5.8e-7 m |
| Repeatable seek; independent instances | supported | re-seek identical positions; instance B on another clip leaves A at reference |
| Root motion | n/a | all tested clips are authored `in-place`; no root travel to compare |
| Character materials/textures | supported | same three.js materials (candidate decodes with `GLTFLoader`); screenshots match |
| Item materials | **gap** | `adaptImportedItemBundle` keeps base color but drops authored `metallicFactor`/`roughnessFactor` (all items render roughness 0.86, metalness 0.02); the steel blade and iron rim/boss look matte and lighter than the reference |

No tested candidate operation was `unsupported`.

## Gaps and owners

- **Item PBR factors.** `packages/renderer/imported-item.js` builds item materials from
  `drawable.material.baseColor` only, although `static-glb` lowers the glTF factors. The PBR
  material contract was owned by [#86](https://github.com/moritzbrantner/3d-lab/issues/86)
  (closed); no consumer currently needs the 3d-lab item path, so no new issue is opened.
- Not exercised here: IK ([#65](https://github.com/moritzbrantner/3d-lab/issues/65)) and
  cosmetic effects ([#85](https://github.com/moritzbrantner/3d-lab/issues/85)); no gap is
  claimed for them.

## Unverified limits

Software rendering (SwiftShader) only; no GPU or consumer gameplay camera. Transitions,
`advance`, clip end clamping, other clips/sockets and the bow/quiver/arrow items are not
compared; only the `default` entry runs, not the outfit, Light-skin, LOD or hair entries. Vertex samples are four fixed indices per mesh, not full-mesh deformation.
Screenshots are for side-by-side inspection; no pixel comparison or threshold is applied.
