# Native `wgpu` comparison

This package is the native renderer-comparison surface for `3d-lab`.

It deliberately stays smaller than an application renderer:

- `three-d-core` remains the owner of mesh topology and validation;
- `three-d-camera` owns renderer-independent right-handed view and WebGPU-depth perspective matrices;
- this example packs the core mesh into GPU vertex/index buffers and the camera matrix into a uniform buffer;
- the example requests a native `wgpu` adapter and device, binds the camera uniform, renders one indexed draw into an offscreen texture, and exits;
- it does not own a scene graph, asset model, window loop, or browser WebGPU path.

Run it on a machine with a supported native graphics adapter:

```bash
cargo run -p three-d-wgpu-example
```

Hosted CI does not require a GPU. Workspace Clippy and tests compile this package and verify deterministic mesh packing, camera math, and uniform layout; executing the native render remains a local capability check.
