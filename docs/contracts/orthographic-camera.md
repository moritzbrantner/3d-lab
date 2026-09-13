# Orthographic camera contract

`three-d-camera::OrthographicCamera` is the renderer-independent authority for right-handed orthographic camera view and projection semantics.

## Ownership

The camera crate owns:

- validated eye/target/up view construction;
- finite orthographic view-volume bounds;
- WebGPU-depth (`0..1`) orthographic projection matrices;
- view-projection composition.

Renderer adapters own GPU/API-specific upload and draw behavior. Applications own camera interaction policy such as orbit increments, zoom gestures, framing targets, and persistence. They must not reimplement projection math merely to obtain an isometric or management-game view.

## Consumer rule

Consumers such as Zoo should keep game rules and selection semantics in their own domain core, use `three-d-camera` for camera matrices, and keep browser/renderer code as an adapter. CSS, Three.js, WebGPU, or native wgpu presentation may differ without changing the camera contract.

The orthographic camera uses the same right-handed view convention as `PerspectiveCamera`, with view-space `-near` mapping to depth `0` and `-far` mapping to depth `1`.