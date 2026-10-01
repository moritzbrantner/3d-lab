# Reusable browser renderer frame contract

`@moritzbrantner/three-d-renderer` (`packages/renderer`) adapts caller-owned frames to Three.js. Callers own camera matrices, transforms, scene composition, and presentation policy such as time of day or which effects glow. The renderer owns validation at the GPU boundary, Three.js object and resource lifetime, caching, and the concrete lights and materials that realize the frame.

## Frames are declarative

`ThreeSceneRenderer.render(frame)` receives a complete `RendererFrame`:

- `camera` — explicit view and WebGPU-depth projection matrices;
- `nodes` — every scene node to draw, identified by stable ids. A node missing from the frame is removed;
- `instanceBatches` (optional) — many copies of one geometry drawn through one instanced mesh per batch, identified by batch ids (see [`performance-observability.md`](performance-observability.md#instance-batches)). A batch missing from the frame is removed; and
- `environment` (optional) — background, lights, fog, and the sun's shadow frame.

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
- `staticGlbSceneNodes(asset, {id, modelMatrix | transform, filter?, ...})` produces scene nodes for one placement; `staticGlbInstanceBatches(asset, {id, instances, revision?, filter?, ...})` produces one instance batch per drawable for many placements. Both compose the placement with each drawable's matrix and reuse the asset's geometry objects. `filter` selects drawables (for example by node). Neither reparses anything, so camera-only and transform-only frames create no geometry or material.

**Identity.** The asset `resourceKey` is the caller's content identity (such as asset-tooling's SHA-256) or, by default, `glb-sha256:<hex>` of the exact bytes. Each primitive's geometry key is `<resourceKey>#mesh=<m>/primitive=<p>`, so nodes reusing one glTF mesh, and every placement of the asset, share one renderer geometry, and different bytes never collide. Materials need no key: equal factors share one cached material through the normal material key.

**Lowering.** Hierarchy and TRS/matrix transforms compose parent-first into column-major asset-space matrices. POSITION, NORMAL, TEXCOORD_0 and COLOR_0 become positions, normals, `uvs`, and `colors`; glTF's linear COLOR_0 (alpha dropped, since only OPAQUE is accepted) is converted to the sRGB components the mesh contract expects, and non-indexed primitives get sequential indices. TANGENT is checked for alignment but not carried, because it serves only normal maps, which are rejected. A material's linear `baseColorFactor` becomes the sRGB node `color` and `doubleSided` is applied; nothing else shapes shading, so lowered nodes and batches always use the default lit material. `metallicFactor` and `roughnessFactor` are preserved on the material for inspection but not rendered: the lit material keeps its fixed roughness/metalness until the textured PBR contract (#86) defines them. A primitive without a material uses the glTF default (white, single-sided).

**Deliberate failures.** `StaticGlbContractError` (a `ThreeRendererContractError`) rejects malformed containers (magic, version, length, JSON or BIN chunk), buffers with URIs, every required extension (for example Draco or meshopt compression, or `KHR_materials_unlit`), any material texture, a non-zero `emissiveFactor`, non-OPAQUE alpha, skins, `JOINTS_0`/`WEIGHTS_0`, animations, morph targets, non-triangle primitives, attributes beyond POSITION/NORMAL/TANGENT/TEXCOORD_0/COLOR_0, missing POSITION or NORMAL (flat-normal generation is not implemented), misaligned attributes, out-of-range indices, non-finite values, nodes with both matrix and TRS or more than one parent, a default-scene root listed more than once (its drawables would repeat renderer node IDs), dangling references, and a default scene without mesh primitives. Optional extensions are ignored as glTF permits and listed in `ignoredExtensions`. Textures/alpha belong to #86 and skinned/animated assets to #87.

**Emissive and unlit.** The adapter deliberately does not map glTF emissive or `KHR_materials_unlit`, even though renderer nodes accept `emissive` and `unlit`. `three-d-formats` rejects any non-zero `emissiveFactor` (`UnsupportedMaterialFeature`) and enables no glTF extension, so it rejects a required `KHR_materials_unlit` and ignores an optional one; the `three-d-assets` material model has no emissive or unlit field. Interpreting either here would make the browser a second authority over which assets are supported and how they shade. The adapter therefore rejects a non-zero `emissiveFactor` and every required extension, and reports an optional `KHR_materials_unlit` in `ignoredExtensions` while rendering the material lit, exactly as the Rust loader treats it. Emissive or unlit GLB materials become supported only after the Rust material model owns those semantics (with #86 or a dedicated follow-up); the adapter then lowers them from that rule.

**Authority.** The adapter mirrors the supported boundary of the Rust `three-d-formats` glTF loader rather than defining a new semantic model: the browser cannot call the Rust crates (there is no WASM build), and `three-d-formats` lowers meshes and materials into `three-d-assets` but does not own a node hierarchy. Three.js `GLTFLoader` is therefore used **only** to decode the GLB container and accessors (strides, normalized and sparse data); hierarchy, transforms, materials, identity, and rejections are lowered from the glTF JSON here. Asset acquisition, provenance, and normalization stay in asset-tooling. Native parity is not claimed: the `wgpu` example does not consume GLB assets, and a native static-asset path would lower through `three-d-formats` plus a scene-layer node hierarchy.

## Evidence

- `packages/renderer/*.test.js` (`bun test packages/renderer`) cover validation, the environment's defaults against a reference built like the pre-environment renderer, change tracking and object reuse, shadow-frame coverage including the caster reach toward the sun, vertex color conversion, material keys (including instance batch materials), instance batch upload, revision, capacity, and contract behavior, and the static GLB adapter (`static-glb.test.js`): fixture drift, exact geometry/hierarchy/material lowering, strided, normalized and non-indexed data, shared-mesh and content identity, every rejection above including corrupted indices, positions, and UVs, and node/batch submission. The fixtures are generated by `scripts/static-glb-fixtures.mjs` in the shape of asset-tooling's Blender rock/tree exports.
- `scripts/renderer-presentation-smoke.mjs` bundles the renderer and checks rendered pixels in Chromium (SwiftShader): omitted, empty, explicit-default, and restored environments are pixel-identical; vertex colors round-trip sRGB and multiply in linear space; emissive and unlit nodes render in darkness; fog, background, and alpha defaults; a shadow focus far from the origin; a `shadowCasterReach` that brings a distant occluder's shadow under a low sun onto the focus; a `resourceKey` reused with colors added or removed keeps rendering its cached payload; equal emissive, unlit, and vertex-colored nodes share materials with exact `materialCreateCount`, `materialReuseCount`, `materialEvictCount`, and `liveMaterialCount`; instance batches render vertex and batch colors like the equal lit node, never share a material across colored and uncolored meshes, take fog, and cast into a moved shadow focus exactly like a node occluder; and the committed static GLB rock and tree adapt in Chromium to the same descriptors as under Bun, render green vertex-colored foliage, brown bark, and a lit rock, create exactly 4 geometries and 3 materials for 3 rocks plus a tree with a shared trunk mesh, create none on a transform-only frame, render as one instance batch like the equal rock nodes, and render the whole tree (bark and vertex-colored foliage) as instance batches like the equal tree nodes. The renderer runtime evidence workflow runs it for renderer changes; run it locally with `bun scripts/renderer-presentation-smoke.mjs [OUTPUT_DIR]` after `bunx playwright install chromium`.
