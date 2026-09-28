# Reusable browser renderer frame contract

`@moritzbrantner/three-d-renderer` (`packages/renderer`) adapts caller-owned frames to Three.js. Callers own camera matrices, transforms, scene composition, and presentation policy such as time of day or which effects glow. The renderer owns validation at the GPU boundary, Three.js object and resource lifetime, caching, and the concrete lights and materials that realize the frame.

## Frames are declarative

`ThreeSceneRenderer.render(frame)` receives a complete `RendererFrame`:

- `camera` — explicit view and WebGPU-depth projection matrices;
- `nodes` — every scene node to draw, identified by stable ids. A node missing from the frame is removed; and
- `environment` (optional) — background, lights, fog, and the sun's shadow frame.

The environment follows the same rule as nodes: it describes the whole frame. Every omitted environment field, or an omitted environment, renders that field's renderer default. Callers therefore resend their environment each frame (reusing the same object is fine) rather than issuing incremental commands. `renderCamera(camera)` redraws the last submitted nodes and environment with a new camera only.

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

`sun.direction` points from the scene toward the sun; only its direction is used. A supplied `sky`, `sun`, or `fog` must be complete.

### Sun placement and the shadow frame

The directional light's target is `shadowFocus`. The light sits on the ray from the focus toward the sun at distance `max(|(10, 18, 8)|, 2 * shadowExtent)`. Its orthographic shadow camera spans `±shadowExtent` across the light axis, with near 0.5 and far `max(500, distance + 2 * shadowExtent)`, so every point within `shadowExtent` of the focus, and occluders between it and the sun, fall inside the shadow map. With both shadow fields omitted this is exactly Three.js's default directional shadow camera and the historical light position (10, 18, 8), so a frame without an environment renders as before.

For worlds larger than one shadow map, move `shadowFocus` with the viewer each frame and choose an extent that covers the area where shadows matter. Shadows are drawn only when the renderer was created with `shadows: true`; the environment moves the shadow frame but does not enable shadow mapping. The renderer does not snap the focus to shadow texels, so a continuously moving focus can make shadow edges shimmer slightly; shadow map size and bias remain Three.js defaults.

### Change tracking

The renderer creates one hemisphere light, one directional light, one `Fog`, and one background `Color` for its lifetime and never replaces them. Each frame it compares the submitted values with the values it last applied and writes only what differs. An unchanged environment, including an equal environment submitted as a new object, performs no Three.js writes and allocates nothing. Colors compare by their submitted representation, so `0xffffff` after `"#ffffff"` counts as a change.

`RendererWorkObservations.environmentUpdateCount` reports how many of the five environment components had state rewritten in the frame: background, sky light, sun light (color/intensity), sun placement (direction, shadow focus, and extent), and fog. It is 0 for an unchanged environment and for `renderCamera`.

Changing fog color or distances only updates uniforms. Turning fog on or off changes the shader variant of every lit material, which costs a program switch (and a compile the first time). Toggle it rarely; fade fog by moving `near`/`far` instead.
