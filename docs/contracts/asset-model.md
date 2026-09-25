# Asset model ownership contract

`three-d-assets` owns the renderer-independent result of loading a mesh asset. It deliberately does not own a file format.

## Owned concepts

The crate models:

- an asset as a collection of named mesh groups, materials, encoded images, samplers, and textures;
- a mesh group as one or more primitives;
- a primitive as validated `three-d-core::Mesh` geometry plus an optional material reference and optional vertex-aligned `three-d-animation::SkinInfluence` data;
- a small metallic-roughness PBR material record with base-color, metallic, roughness, double-sided factors, and an optional normal-texture binding;
- an encoded image as MIME-typed bytes without imposing a pixel decoder;
- a sampler as renderer-independent filtering and wrapping semantics;
- a texture as an image reference plus an optional sampler reference;
- a normal-texture binding as a texture reference, UV-set index, and finite normal scale;
- referential integrity from primitives to materials, textures to images/samplers, and materials to textures.

The geometry inside every primitive remains owned by `three-d-core`; `three-d-assets` composes that geometry into an asset rather than duplicating mesh validation. Tangent vectors are geometry attributes and therefore flow through primitives automatically once present on the core mesh. Skin-weight semantics remain owned by `three-d-animation::SkinInfluence`; `three-d-assets` only preserves one influence record per mesh vertex and validates alignment. Encoded image bytes are preserved as asset data, while pixel decoding and renderer resource creation remain downstream.

## Format adapter boundary

`three-d-formats` is the downstream decoding layer. It uses dedicated OBJ and glTF parsers, normalizes accepted geometry into `three-d-core::Mesh`, and terminates in `three-d-assets::Asset`.

The adapter is deliberately loss-aware. It rejects source semantics that cannot currently be represented faithfully rather than silently deleting them. The current glTF mesh-asset path accepts triangle primitives with positions plus optional normals, tangents, UV0, color0, and paired `JOINTS_0`/`WEIGHTS_0`; embedded/GLB buffer data; factor-only metallic-roughness materials; encoded images from data URIs or buffer views; texture/sampler records; and normal-texture material bindings. Additional joint/weight sets, morph targets, base-color/metallic-roughness/occlusion/emissive textures, emissive/alpha material behavior, external buffer URIs, and external image URIs remain explicit unsupported boundaries. The mesh-asset loader preserves vertex skin influences but does not claim to assemble the glTF node-to-skin relationship; renderer-neutral scene/skin binding remains a separate scene-layer follow-up. The current in-memory OBJ path triangulates and single-indexes geometry, but rejects MTL-backed material references until an explicit MTL-to-material policy exists.

This separation means support can grow format-by-format without importing parser vocabulary into the semantic crates.

## Normal-map boundary

The geometry half of normal mapping is owned by `three-d-core`: it validates tangent VEC4 attributes and can derive a tangent basis deterministically from normals and UVs. `three-d-assets` now owns the renderer-independent resource half: encoded image data, sampler and texture references, and the material's normal-texture binding. `three-d-formats` maps glTF indices, data URIs, and buffer views into those concepts without leaking glTF accessor or JSON structure into the asset model.

The asset model deliberately preserves encoded image bytes rather than decoding them into pixels. Image decoding, GPU texture creation, mip generation, and renderer-specific resource lifetime remain downstream. This keeps normal-map semantics reusable without turning `three-d-assets` into an image library or rendering layer.

## Deliberately downstream

Format and renderer adapters own details that should not leak into the durable asset model:

- glTF scenes, nodes, primitive JSON, accessor indices, buffer-view indices, buffers, data URIs, GLB chunks, and extension decoding;
- OBJ groups, object records, face syntax, and material-library parsing;
- byte-order, component-type, stride, sparse-accessor, and external source-resolution details;
- encoded-image pixel decoding and transcoding;
- Three.js objects, GPU buffers/textures, shader materials, and renderer-specific resource lifetime.

A format adapter validates and decodes its source, constructs `three-d-core::Mesh` values, then builds `three-d-assets::Asset` values. Renderer adapters consume that result rather than reopening the source format.

## Teaching surface

The browser model-pipeline lesson intentionally exposes the full glTF chain—scene → node → mesh → primitive → accessors/bufferViews/buffer and material—because those format details are the subject being taught. The tangent-space lesson separately shows how geometry plus UVs produce the local basis used by a normal map. Neither teaching surface changes semantic ownership.


## Browser renderer materialization boundary

The reusable `@moritzbrantner/three-d-renderer` package accepts validated indexed mesh geometry as a renderer materialization boundary. A mesh descriptor carries positions, triangle indices, optional aligned normals, and a caller-supplied immutable `resourceKey`. The renderer validates structural safety, materializes one Three.js `BufferGeometry`, and caches it by that key.

The `resourceKey` is identity, not a filename. Downstream consumers should use a content-derived identity such as the SHA-256 already carried by `asset-tooling` outputs and must change the key whenever geometry bytes/semantics change. The renderer does not infer provenance, decode glTF/OBJ, normalize coordinates, or own asset-processing policy; those responsibilities remain with `three-d-formats`, `three-d-scene`, and `asset-tooling`.

This boundary is intentionally geometry-first. Texture/material transport remains a separate follow-up so applications do not grow local glTF loaders or ad-hoc renderer-specific asset semantics while waiting for full authored-model support.
