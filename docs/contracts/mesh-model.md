# Mesh model parity contract

The Rust crate and the browser lessons intentionally share concepts, not implementation code.

## Owned concepts

Both surfaces model:

- a vertex position as three finite coordinates `(x, y, z)`;
- an indexed triangle as exactly three vertex indices;
- an indexed mesh as a vertex buffer plus an index buffer;
- triangle count as `indices.length / 3`;
- triangle orientation through index winding order;
- normals as derived geometry rather than independent topology.

## Ownership boundary

`three-d-core` owns renderer-independent geometry validation and algorithms.

The web application owns presentation, interaction, cameras, materials, lights, and Three.js conversion. It may mirror tiny data structures to make lessons inspectable, but it must not turn `three-d-core` into a Three.js adapter.

Future WebGPU/native work should consume the Rust mesh model rather than move GPU-specific types into the core crate.
