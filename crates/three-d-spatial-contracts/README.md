# three-d-spatial-contracts

Versioned, renderer-independent spatial interchange contracts for `3d-lab`.

This crate is a scoped migration of the product-agnostic annotation vocabulary and only the double-precision math required to represent and validate that vocabulary. The source contract was previously embedded in `moritzbrantner/rust-packages` under `three-d-processing-core`.

## Ownership

This crate owns serialized spatial interchange: coordinate-frame references, spatial selectors, opaque cross-domain entity references, `SpatialBinding`, and their compatibility math DTOs. `three-d-camera` remains authoritative for renderer-independent view/projection matrix behavior; `three-d-core` remains authoritative for mesh geometry; `three-d-animation` remains authoritative for scene transforms and animation behavior.

It deliberately does **not** absorb collision detection, broad-phase selection, point-cloud algorithms, mesh processing, surface operations, reconstruction, COLMAP execution, radiance fields, or Gaussian splatting from the historical package.

## Compatibility boundary

`SpatialBinding` remains schema version `1`. Existing selector tags and serde field casing are preserved so persisted sidecars can move to this crate without a format migration.

Migration provenance: `moritzbrantner/rust-packages` commit `da291014dd40f62307a9825a9f938ccf18fddcbc`, primarily `crates/three-d/three-d-processing-core/src/annotations.rs` plus the narrow double-precision DTO/validation subset from `spatial_math.rs`.
