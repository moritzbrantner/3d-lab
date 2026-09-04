# Mesh model parity contract

The Rust crate and the browser lessons intentionally share concepts, not implementation code.

## Owned concepts

Both surfaces model:

- a vertex position as three finite coordinates `(x, y, z)`;
- an indexed triangle as exactly three vertex indices;
- an indexed mesh as a position buffer plus an index buffer;
- optional per-vertex normal, UV, and color buffers aligned one-to-one with the position buffer;
- triangle count as `indices.length / 3`;
- triangle orientation through index winding order;
- face normals from cross products and smooth vertex normals from accumulated adjacent face normals;
- deterministic procedural subdivision of a plane into `(n + 1)²` vertices and `2n²` triangles.

## Attribute invariants

Renderer-independent attributes obey the same boundary on both surfaces:

1. Every index references an existing position.
2. Index counts are divisible by three.
3. Positions and present attributes contain only finite values.
4. A present normal, UV, or color buffer has exactly one record for every indexed vertex slot.
5. UV values are not restricted to `0..1`, because tiling and atlas workflows can intentionally use other ranges.
6. Color values are finite but are not clamped by the geometry core, leaving linear/HDR interpretation to downstream rendering.

A hard edge or UV seam may therefore require duplicated positions: two logical corners can occupy the same spatial coordinate while carrying different per-vertex attributes.

## Ownership boundary

`three-d-core` owns renderer-independent geometry validation, attributes, normal derivation, and procedural mesh construction.

The web application owns presentation, interaction, cameras, materials, lights, textures, culling configuration, and Three.js conversion. It may mirror the small data structures to make lessons inspectable, but it must not turn `three-d-core` into a Three.js adapter.

Future WebGPU/native work should consume the Rust mesh model rather than move GPU-specific types into the core crate.