# Reusable browser renderer frame contract

`@moritzbrantner/three-d-renderer` (`packages/renderer`) adapts caller-owned frames to Three.js. Callers own camera matrices, transforms, scene composition, and presentation policy such as time of day or which effects glow. The renderer owns validation at the GPU boundary, Three.js object and resource lifetime, caching, and the concrete lights and materials that realize the frame.

## Frames are declarative

`ThreeSceneRenderer.render(frame)` receives a complete `RendererFrame`:

- `camera` — explicit view and WebGPU-depth projection matrices;
- `nodes` — every scene node to draw, identified by stable ids. A node missing from the frame is removed;
- `instanceBatches` (optional) — many copies of one geometry drawn through one instanced mesh per batch, identified by batch ids (see [`performance-observability.md`](performance-observability.md#instance-batches)). A batch missing from the frame is removed;
- `environment` (optional) — background, lights, fog, and the sun's shadow frame; and
- `effects` (optional) — cosmetic baked-flipbook effects (see [Cosmetic flipbook effects](#cosmetic-flipbook-effects)). Omitting it releases every effect resource.

Nodes and instance batch instances share one transform composition (a `modelMatrix`, or a translation/rotation/scale `transform`), so both place geometry identically. The environment applies to batches exactly as to nodes: they are lit by the same sky and sun, fogged by the same fog, and cast and receive shadows inside the same shadow frame whenever the renderer `shadows` option is on.

The environment follows the same rule as nodes: it describes the whole frame. Every omitted environment field, or an omitted environment, renders that field's renderer default. Callers therefore resend their environment each frame (reusing the same object is fine) rather than issuing incremental commands. `renderCamera(camera)` redraws the last submitted nodes and environment with a new camera only, so it is valid only while both are unchanged: a frame whose environment may differ, such as each step of a day/night cycle or a shadow focus following the viewer, must go through `render(frame)`.

`validateRenderFrame` rejects malformed input with `ThreeRendererContractError` before any Three.js state changes.

## Environment

| Field | Meaning | Default | Validation |
| --- | --- | --- | --- |
| `background` | Clear color | Renderer `background` option (`#0c111a`); transparent when the renderer was created with `alpha` | 24-bit integer or `#RRGGBB` |
| `sky` | Hemisphere light `{skyColor, groundColor, intensity}` | `#ffffff`, `#334433`, 1.7 | colors as above; intensity finite, `>= 0` |
| `sun` | Directional key light `{direction, color, intensity}` | direction (10, 18, 8), `#ffffff`, 2.2 | direction three finite numbers, non-zero; intensity finite, `>= 0` |
| `fog` | Linear fog `{color, near, far}`; `null` disables it | no fog | `0 <= near < far`, finite |
| `shadowFocus` | World point the sun's shadow camera is centred on | origin | three finite numbers |
| `shadowExtent` | Half-width of the square shadow region around the focus | 5 | finite, `> 0` |
| `shadowCasterReach` | How far beyond the shadow region, toward the sun, occluders still cast into it | `shadowExtent` | finite, `>= 0` |

`sun.direction` points from the scene toward the sun; only its direction is used. A supplied `sky`, `sun`, or `fog` must be complete.

### Sun placement and the shadow frame

The directional light's target is `shadowFocus`. The light sits on the ray from the focus toward the sun at distance `max(|(10, 18, 8)|, shadowExtent + shadowCasterReach + 0.5)`. Its orthographic shadow camera spans `±shadowExtent` across the light axis, with near 0.5 and far `max(500, distance + 2 * shadowExtent)`. Every point within `shadowExtent` of the focus therefore falls inside the shadow map, and so does every occluder within `±shadowExtent` of the light axis that lies less than `distance − 0.5` from the focus along the sun direction, which is at least `shadowCasterReach` beyond the region's sun-facing edge. Occluders farther toward the sun are behind the near plane: Three.js culls or clips them and they cast no shadow, so their shadows appear only once the focus moves close enough. With all shadow fields omitted (extent 5, reach 5) this is exactly Three.js's default directional shadow camera and the historical light position (10, 18, 8), so a frame without an environment renders as before; that default reaches only about 21.6 units from the focus toward the sun.

For worlds larger than one shadow map, move `shadowFocus` with the viewer each frame and choose an extent that covers the area where shadows matter. Choose `shadowCasterReach` independently from the tallest occluder and the lowest sun: an occluder of height `h` shades ground up to about `h / sin(elevation)` away along the sun direction, so a 10-unit tree under a 15° evening sun needs a reach of about 40. A larger reach does not change the shadow map's resolution across the region; it only lengthens the depth range. Shadows are drawn only when the renderer was created with `shadows: true`; the environment moves the shadow frame but does not enable shadow mapping. The renderer does not snap the focus to shadow texels, so a continuously moving focus can make shadow edges shimmer slightly; shadow map size and bias remain Three.js defaults.

### Change tracking

The renderer creates one hemisphere light, one directional light, one `Fog`, and one background `Color` for its lifetime and never replaces them. Each frame it compares the submitted values with the values it last applied and writes only what differs. An unchanged environment, including an equal environment submitted as a new object, performs no Three.js writes, and applying it allocates nothing. Colors compare by their submitted representation, so `0xffffff` after `"#ffffff"` counts as a change.

`RendererWorkObservations.environmentUpdateCount` reports how many of the five environment components had state rewritten in the frame: background, sky light, sun light (color/intensity), sun placement (direction, shadow focus, extent, and caster reach), and fog. It is 0 for an unchanged environment and for `renderCamera`.

Changing fog color or distances only updates uniforms. Turning fog on or off changes the shader variant of every material, lit or unlit, which costs a program switch (and a compile the first time). Toggle it rarely; fade fog by moving `near`/`far` instead.

## Scene node materials

A node's `color`, `opacity`, `wireframe`, and shading select its material:

- **lit** (default): Three.js `MeshStandardMaterial` with the historical roughness 0.86 and metalness 0.02;
- **emissive**: `emissive: color` adds self-illumination to the lit result. It is not scaled by lights, shadows, or vertex colors, so it keeps glowing spell effects visible at night; and
- **unlit**: `unlit: true` draws the flat node color (times vertex colors) with `MeshBasicMaterial`, ignoring lights and shadows. Use it for markers, selection circles, and similar elements that must read the same in any lighting.

Every node is single-sided (back faces culled) unless it sets `doubleSided: true`; instance batches take the same flag.

`unlit` and `emissive` are mutually exclusive; the types forbid the combination and validation rejects it. Fog applies to every material, so distant effects fade with the world. Shadow casting follows the renderer `shadows` option for all nodes, including emissive and unlit ones; unlit nodes never show received shadows.

Materials are cached by their parameters, not by node: nodes with equal color, opacity, wireframe mode, sidedness, vertex-color use, and shading (including the emissive color) share one material, and the material is evicted when no node uses it. Vertex-color use is read from the cached geometry bound to the node, not from the submitted payload, so the material and geometry always agree on whether a color attribute exists. Colors in the key compare by their submitted representation, like the environment. Adding emissive or unlit nodes therefore adds one material per distinct parameter set, visible through `materialCreateCount` and `liveMaterialCount`.

Instance batches always use the default **lit** material, in white, through the same material cache: the batch color and per-instance color overrides are uploaded as instance colors that multiply it. Batches take no `emissive` or `unlit` shading. Their material key holds opacity, wireframe mode, sidedness, and vertex-color use of the bound batch geometry, so batches that differ only in color share one material, a batch on a vertex-colored mesh never shares a material with a batch on a mesh without colors, and a batch may share its material with a white lit node of equal parameters. Vertex colors on a batch mesh multiply the instance color in linear space, just as they multiply a node color.

## Indexed mesh geometry and vertex colors

A `kind: "mesh"` geometry carries positions, triangle indices, optional aligned normals, optional aligned `uvs` (UV0, materialized as the `uv` attribute for future textured materials; no current material samples them), and optional aligned `colors`. The renderer validates structural safety every frame and materializes one Three.js `BufferGeometry` per `resourceKey`.

`resourceKey` identifies the exact payload: positions, indices, normals, uvs, and colors. The geometry cache is keyed on it alone and never compares buffers, so two payloads that differ in any attribute, such as the same terrain recolored for a season, must use different keys. A key reused with different contents keeps rendering the cached payload, including its colors or lack of them, until no node uses the key and it is evicted. Content-derived keys (for example a hash of the encoded payload) satisfy this by construction.

`colors` are per-vertex sRGB components in `0..1`, the same color space as `#RRGGBB` node colors: the vertex color `[0x5a/255, 0x8f/255, 0x3c/255]` renders like the node color `#5a8f3c`. They are converted to the linear Three.js working color space once at materialization. Interpolation across triangles and multiplication by the node color both happen in that linear space, like all Three.js shading. Terrain or props colored per vertex therefore normally use the neutral node color `#ffffff`, while any other node color tints the whole mesh (`#808080` times `#339966` renders as `#144a2f`, not the sRGB-space product `#1a4d33`).

## Static GLB assets

`@moritzbrantner/three-d-renderer/static-glb` turns one already validated, self-contained static GLB (for example an asset-tooling rock or tree) into the renderer descriptors above, so games consume such assets without a local glTF parser or lowering code.

- `adaptStaticGlb(bytes, {resourceKey?})` validates and lowers the GLB **once** and returns a deeply frozen `StaticGlbAsset`: the default scene's nodes (index, name, parent, children, local and asset-space matrices), factor-only materials, drawables (one per node × mesh primitive, each with its asset-space matrix, shared `IndexedMeshGeometry`, material, and local bounds), conservative asset-space bounds, and the optional extensions it did not apply.
- `staticGlbSceneNodes(asset, {id, modelMatrix | transform, filter?, ...})` produces scene nodes for one placement; `staticGlbInstanceBatches(asset, {id, instances, revision?, filter?, ...})` produces one instance batch per drawable for many placements. Both compose the placement with each drawable's matrix and reuse the asset's geometry objects. `filter` selects drawables (for example by node). Placements follow the renderer's `validateTransform` rules (finite values, positive scale, non-zero rotation quaternion) before composing, so a zero quaternion is rejected rather than normalized to identity, and a composed matrix that overflows is rejected; every rejection, including a malformed placement, filter, or asset, is a `StaticGlbContractError`. Neither reparses anything, so camera-only and transform-only frames create no geometry or material.

**Identity.** The asset `resourceKey` is the caller's content identity (such as asset-tooling's SHA-256) or, by default, `glb-sha256:<hex>` of the exact bytes. Each primitive's geometry key is `<resourceKey>#mesh=<m>/primitive=<p>`, so nodes reusing one glTF mesh, and every placement of the asset, share one renderer geometry, and different bytes never collide. Materials need no key: equal factors share one cached material through the normal material key.

**Lowering.** Hierarchy and TRS/matrix transforms compose parent-first into column-major asset-space matrices. POSITION, NORMAL, TEXCOORD_0 and COLOR_0 become positions, normals, `uvs`, and `colors`; glTF's linear COLOR_0 (alpha dropped, since only OPAQUE is accepted) is converted to the sRGB components the mesh contract expects, and non-indexed primitives get sequential indices. TANGENT is checked for alignment and finiteness (like `three-d-core`'s `Tangent4` validation) but not carried, because it serves only normal maps, which are rejected. A material's linear `baseColorFactor` becomes the sRGB node `color` and `doubleSided` is applied; nothing else shapes shading, so lowered nodes and batches always use the default lit material. `metallicFactor` and `roughnessFactor` are preserved on the material for inspection but not rendered: the lit material keeps its fixed roughness/metalness until the textured PBR contract (#86) defines them. A primitive without a material uses the glTF default (white, single-sided).

**Deliberate failures.** `StaticGlbContractError` (a `ThreeRendererContractError`) rejects malformed containers (magic, version, length, JSON or BIN chunk), buffers with URIs, every required extension (for example Draco or meshopt compression, or `KHR_materials_unlit`), any material texture, a non-zero `emissiveFactor`, non-OPAQUE alpha, skins, `JOINTS_0`/`WEIGHTS_0`, animations, morph targets, non-triangle primitives, attributes beyond POSITION/NORMAL/TANGENT/TEXCOORD_0/COLOR_0, missing POSITION or NORMAL (flat-normal generation is not implemented), malformed JSON entries (a non-object material, mesh, primitive, node, scene, buffer, bufferView, or accessor, a non-array list, or a missing byte count), zero-initialized accessors (no `bufferView` and no `sparse`) referenced by a primitive, accessor encodings outside glTF 2.0 core for their semantic (for example quantized POSITION, normalized floats, unnormalized integer colors/UVs, or non-integer indices), misaligned attributes, out-of-range indices, non-finite values in any read accessor (including TANGENT and the COLOR_0 alpha, which are checked before being dropped), zero or overflowing node rotations, asset-space matrices that overflow, nodes with both matrix and TRS or more than one parent, a default-scene root listed more than once (its drawables would repeat renderer node IDs), dangling references, and a default scene without mesh primitives. Optional extensions are ignored as glTF permits and listed in `ignoredExtensions`. Textures/alpha belong to #86 and skinned/animated assets to #87.

**Emissive and unlit.** The adapter deliberately does not map glTF emissive or `KHR_materials_unlit`, even though renderer nodes accept `emissive` and `unlit`. `three-d-formats` rejects any non-zero `emissiveFactor` (`UnsupportedMaterialFeature`) and enables no glTF extension, so it rejects a required `KHR_materials_unlit` and ignores an optional one; the `three-d-assets` material model has no emissive or unlit field. Interpreting either here would make the browser a second authority over which assets are supported and how they shade. The adapter therefore rejects a non-zero `emissiveFactor` and every required extension, and reports an optional `KHR_materials_unlit` in `ignoredExtensions` while rendering the material lit, exactly as the Rust loader treats it. Emissive or unlit GLB materials become supported only after the Rust material model owns those semantics (with #86 or a dedicated follow-up); the adapter then lowers them from that rule.

**Authority.** The adapter mirrors the supported boundary of the Rust `three-d-formats` glTF loader rather than defining a new semantic model: the browser cannot call the Rust crates (there is no WASM build), and `three-d-formats` lowers meshes and materials into `three-d-assets` but does not own a node hierarchy. Three.js `GLTFLoader` is therefore used **only** to decode the GLB container and accessors (strides, normalized and sparse data); hierarchy, transforms, materials, identity, and rejections are lowered from the glTF JSON here. Asset acquisition, provenance, and normalization stay in asset-tooling. Native parity is not claimed: the `wgpu` example does not consume GLB assets, and a native static-asset path would lower through `three-d-formats` plus a scene-layer node hierarchy.

## Cosmetic flipbook effects

`frame.effects` draws short cosmetic effects such as an impact puff as camera-facing quads that play a baked atlas. Effects are presentation only: the consumer supplies triggers, origins, and its cosmetic clock; the renderer never performs hit detection, owns game randomness, or feeds anything back into simulation. Dropping, disabling, or failing to draw an effect never changes a game outcome. The renderer had no sprite or billboard path before this; effects reuse the instanced-mesh and resource-observation patterns of instance batches instead of adding a particle engine.

```ts
effects: {
  time: number                 // cosmetic clock, same units as startTime/duration
  enabled?: boolean            // false: draw nothing and dispose every effect resource
  maxInstances?: number        // caller budget (e.g. reduced intensity), capped by the renderer option
  atlases: RendererEffectAtlas[]       // {resourceKey, width, height, pixels, columns, rows, frameCount?, filter?}
  instances: RendererEffectInstance[]  // {id, atlas, space: "world", origin, startTime, duration, loops?, scale, color?, opacity?}
}
```

### Atlas identity and resources

An atlas is RGBA sRGB `pixels` (top row first, `width * height * 4` bytes) divided into `columns x rows` cells; frames are numbered row-major from the top-left cell and `frameCount` (default `columns * rows`) may leave trailing cells unused. `width` and `height` must be multiples of `columns` and `rows`, so every texel belongs to exactly one cell.

`filter` defaults to `"linear"`. Bilinear filtering blends each sample with its neighboring texels, so a rectangle spanning a cell's exact boundaries would mix in the adjacent frame's color and alpha at the quad edges. Linear atlases therefore sample each frame through a rectangle inset by half a texel on every side (`flipbookFrameRect(layout, frame, target, {width, height})`): edge samples land on the outermost texel centers of their own cell, so atlases need no padding between frames. The outer half texel of each frame is clamped rather than stretched, which is invisible for the usual transparent or soft frame borders. `"nearest"` atlases sample the exact cell. Textures have no mipmaps, so minification never reaches beyond those neighbors either. `resourceKey` identifies the exact pixels and layout, like a mesh `resourceKey`: the renderer uploads one texture per key and never compares pixels again. Per declared atlas it owns one texture, one unlit transparent material (no depth writes; fog applies), one quad geometry with per-instance frame and opacity attributes, and one instanced mesh with fixed capacity `maxEffectInstances`. These are shared by every effect on that atlas and kept while the atlas stays declared, even with no active effect (the mesh is then hidden and costs no draw). An atlas missing from `effects.atlases`, an omitted `effects`, or `enabled: false` disposes all four resources in that frame. Consumers release GPU memory after a session or when effects are switched off by no longer declaring the atlas.

### Timing and frame selection

Sampling is stateless and lives in the renderer-independent `flipbook.js` module (package subpath `./flipbook`), which asset tooling can call to bake or check frames:

- `age = effects.time - startTime`. Negative ages are **pending** and draw nothing.
- `0 <= age < duration * loops` is **active**: `frame = min(frameCount - 1, floor((age mod duration) / duration * frameCount))`. `loops` defaults to 1 and must be a positive integer, so every effect has a bounded lifetime.
- `age >= duration * loops` is **expired** and draws nothing.

The frame depends only on the submitted time, never on previous frames, so seeking, pausing, replaying, and any partition of updates produce identical output. Replay or reset is a new `startTime`; cancellation is omitting the effect. Ages exactly on a frame boundary follow the IEEE double result of the formula (sample mid-frame in tests). Non-finite time, `startTime`, `duration`, or age are rejected.

### Space, appearance, and culling

`space` must be `"world"`; `origin` is the quad center in world space. Effects attached to a moving node are composed into a world origin by the consumer, which keeps transform authority outside the renderer. The quad is oriented in view space in the vertex shader, so it faces any camera, including a `renderCamera` redraw, with no CPU work or buffer upload per camera change. `scale` is the world-space quad size (one number for a square or `[width, height]`). `color` multiplies the atlas in linear space like instance colors, and `opacity` multiplies atlas alpha. Frustum culling uses each atlas mesh's bounding sphere over live effect origins with the unit quad's circumscribed radius, which bounds every orientation.

### Budget and drop policy

`ThreeSceneRendererOptions.maxEffectInstances` (default 64) caps active effects per frame across all atlases and is each atlas mesh's capacity, so effects never grow GPU buffers. `effects.maxInstances` lowers the cap for one frame, for example for a reduced-intensity setting. When more effects are active than the budget allows, the newest (`startTime` descending, then `id` ascending) are kept and the rest are dropped for that frame; the kept set does not depend on submission order.

### Change tracking and observations

Each frame the renderer writes every active effect into its atlas's instance slots and marks a buffer (matrix, color, frame, opacity) for upload only if a value actually changed, so an unchanged frame or a camera-only change uploads nothing and advancing time usually uploads only the frame attribute. `RendererWorkObservations` reports `effectActiveCount`, `effectPendingCount`, `effectExpiredCount`, `effectDroppedCount`, `effectBufferUploadCount`, `effectAtlasCreateCount`, `effectAtlasReuseCount`, `effectAtlasDisposeCount`, and `liveEffectAtlasCount`. Effect meshes are not counted in the object, geometry, or material counters. `renderCamera` reports zero effect work and the live atlas count; it does not advance effect time.

### Not supported

No seeded burst or independently moving particles yet (add a renderer-independent evaluator only when a consumer needs one), no local/attached space, no image or compressed-texture atlases (pixels only), no additive blending, no soft particles or sorting between effects, and no native `wgpu` path: the native example draws no effects and claims no parity.

## Evidence

- `packages/renderer/*.test.js` (`bun test packages/renderer`) cover validation, the environment's defaults against a reference built like the pre-environment renderer, change tracking and object reuse, shadow-frame coverage including the caster reach toward the sun, vertex color conversion, material keys (including instance batch materials), and instance batch upload, revision, capacity, and contract behavior, flipbook fixed-time sampling (first/last frames, pending/expired ages, loops, seek/partition independence, replay, invalid input), half-texel frame insets for linear atlases and whole-texel cells, and cosmetic effect resource create/reuse/dispose, upload tracking, budget drop order, and release on disable/omission, and the static GLB adapter (`static-glb.test.js`): fixture drift, exact geometry/hierarchy/material lowering, strided, normalized and non-indexed data, shared-mesh and content identity, every rejection above including corrupted indices, positions, and UVs, and node/batch submission. The fixtures are generated by `scripts/static-glb-fixtures.mjs` in the shape of asset-tooling's Blender rock/tree exports.
- `scripts/renderer-presentation-smoke.mjs` bundles the renderer and checks rendered pixels in Chromium (SwiftShader): omitted, empty, explicit-default, and restored environments are pixel-identical; vertex colors round-trip sRGB and multiply in linear space; emissive and unlit nodes render in darkness; fog, background, and alpha defaults; a shadow focus far from the origin; a `shadowCasterReach` that brings a distant occluder's shadow under a low sun onto the focus; a `resourceKey` reused with colors added or removed keeps rendering its cached payload; equal emissive, unlit, and vertex-colored nodes share materials with exact `materialCreateCount`, `materialReuseCount`, `materialEvictCount`, and `liveMaterialCount`; and instance batches render vertex and batch colors like the equal lit node, never share a material across colored and uncolored meshes, take fog, and cast into a moved shadow focus exactly like a node occluder; the committed static GLB rock and tree adapt in Chromium to the same descriptors as under Bun, render green vertex-colored foliage, brown bark, and a lit rock, create exactly 4 geometries and 3 materials for 3 rocks plus a tree with a shared trunk mesh, create none on a transform-only frame, render as one instance batch like the equal rock nodes, and render the whole tree (bark and vertex-colored foliage) as instance batches like the equal tree nodes; and a generated 2x2 puff atlas (`scripts/fixtures/cosmetic-puff-atlas.mjs`) draws each sampled frame at its age, nothing while pending, expired, or disabled, keeps the default linear filter inside each cell at every internal cell edge, applies color and opacity, faces side and oblique cameras with zero buffer uploads on camera-only changes, and disposes its resources when disabled. It writes the effect pixels and observations to `cosmetic-effect-frames.json`. The renderer runtime evidence workflow runs it for renderer changes; run it locally with `bun scripts/renderer-presentation-smoke.mjs [OUTPUT_DIR]` after `bunx playwright install chromium`.
