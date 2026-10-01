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

`unlit` and `emissive` are mutually exclusive; the types forbid the combination and validation rejects it. Fog applies to every material, so distant effects fade with the world. Shadow casting follows the renderer `shadows` option for all nodes, including emissive and unlit ones; unlit nodes never show received shadows.

Materials are cached by their parameters, not by node: nodes with equal color, opacity, wireframe mode, vertex-color use, and shading (including the emissive color) share one material, and the material is evicted when no node uses it. Vertex-color use is read from the cached geometry bound to the node, not from the submitted payload, so the material and geometry always agree on whether a color attribute exists. Colors in the key compare by their submitted representation, like the environment. Adding emissive or unlit nodes therefore adds one material per distinct parameter set, visible through `materialCreateCount` and `liveMaterialCount`.

Instance batches always use the default **lit** material, in white, through the same material cache: the batch color and per-instance color overrides are uploaded as instance colors that multiply it. Batches take no `emissive` or `unlit` shading. Their material key holds opacity, wireframe mode, and vertex-color use of the bound batch geometry, so batches that differ only in color share one material, a batch on a vertex-colored mesh never shares a material with a batch on a mesh without colors, and a batch may share its material with a white lit node of equal parameters. Vertex colors on a batch mesh multiply the instance color in linear space, just as they multiply a node color.

## Indexed mesh geometry and vertex colors

A `kind: "mesh"` geometry carries positions, triangle indices, optional aligned normals, and optional aligned `colors`. The renderer validates structural safety every frame and materializes one Three.js `BufferGeometry` per `resourceKey`.

`resourceKey` identifies the exact payload: positions, indices, normals, and colors. The geometry cache is keyed on it alone and never compares buffers, so two payloads that differ in any attribute, such as the same terrain recolored for a season, must use different keys. A key reused with different contents keeps rendering the cached payload, including its colors or lack of them, until no node uses the key and it is evicted. Content-derived keys (for example a hash of the encoded payload) satisfy this by construction.

`colors` are per-vertex sRGB components in `0..1`, the same color space as `#RRGGBB` node colors: the vertex color `[0x5a/255, 0x8f/255, 0x3c/255]` renders like the node color `#5a8f3c`. They are converted to the linear Three.js working color space once at materialization. Interpolation across triangles and multiplication by the node color both happen in that linear space, like all Three.js shading. Terrain or props colored per vertex therefore normally use the neutral node color `#ffffff`, while any other node color tints the whole mesh (`#808080` times `#339966` renders as `#144a2f`, not the sRGB-space product `#1a4d33`).

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

An atlas is RGBA sRGB `pixels` (top row first, `width * height * 4` bytes) divided into `columns x rows` cells; frames are numbered row-major from the top-left cell and `frameCount` (default `columns * rows`) may leave trailing cells unused. `resourceKey` identifies the exact pixels and layout, like a mesh `resourceKey`: the renderer uploads one texture per key and never compares pixels again. Per declared atlas it owns one texture, one unlit transparent material (no depth writes; fog applies), one quad geometry with per-instance frame and opacity attributes, and one instanced mesh with fixed capacity `maxEffectInstances`. These are shared by every effect on that atlas and kept while the atlas stays declared, even with no active effect (the mesh is then hidden and costs no draw). An atlas missing from `effects.atlases`, an omitted `effects`, or `enabled: false` disposes all four resources in that frame. Consumers release GPU memory after a session or when effects are switched off by no longer declaring the atlas.

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

- `packages/renderer/*.test.js` (`bun test packages/renderer`) cover validation, the environment's defaults against a reference built like the pre-environment renderer, change tracking and object reuse, shadow-frame coverage including the caster reach toward the sun, vertex color conversion, material keys (including instance batch materials), and instance batch upload, revision, capacity, and contract behavior, flipbook fixed-time sampling (first/last frames, pending/expired ages, loops, seek/partition independence, replay, invalid input), and cosmetic effect resource create/reuse/dispose, upload tracking, budget drop order, and release on disable/omission.
- `scripts/renderer-presentation-smoke.mjs` bundles the renderer and checks rendered pixels in Chromium (SwiftShader): omitted, empty, explicit-default, and restored environments are pixel-identical; vertex colors round-trip sRGB and multiply in linear space; emissive and unlit nodes render in darkness; fog, background, and alpha defaults; a shadow focus far from the origin; a `shadowCasterReach` that brings a distant occluder's shadow under a low sun onto the focus; a `resourceKey` reused with colors added or removed keeps rendering its cached payload; equal emissive, unlit, and vertex-colored nodes share materials with exact `materialCreateCount`, `materialReuseCount`, `materialEvictCount`, and `liveMaterialCount`; and instance batches render vertex and batch colors like the equal lit node, never share a material across colored and uncolored meshes, take fog, and cast into a moved shadow focus exactly like a node occluder; and a generated 2x2 puff atlas (`scripts/fixtures/cosmetic-puff-atlas.mjs`) draws each sampled frame at its age, nothing while pending, expired, or disabled, applies color and opacity, faces side and oblique cameras with zero buffer uploads on camera-only changes, and disposes its resources when disabled. It writes the effect pixels and observations to `cosmetic-effect-frames.json`. The renderer runtime evidence workflow runs it for renderer changes; run it locally with `bun scripts/renderer-presentation-smoke.mjs [OUTPUT_DIR]` after `bunx playwright install chromium`.
