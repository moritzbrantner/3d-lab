# Native `wgpu` baseline

This package is the first renderer-comparison slice for `3d-lab`.

It deliberately stays smaller than an application renderer:

- `three-d-core` remains the owner of mesh topology and validation;
- this example only packs the core mesh into GPU vertex/index buffers;
- the example requests a native `wgpu` adapter and device, renders one indexed draw into an offscreen texture, and exits;
- it does not own a scene graph, asset model, camera model, window loop, or browser WebGPU path.

Run it on a machine with a supported native graphics adapter:

```bash
cargo run -p three-d-wgpu-example
```

Hosted CI does not require a GPU. Workspace Clippy and tests compile this package and verify the deterministic CPU-side mesh packing contract; executing the native render remains a local capability check.
