# Asset model ownership contract

`three-d-assets` owns the renderer-independent result of loading a mesh asset. It deliberately does not own a file format.

## Owned concepts

The crate models:

- an asset as a collection of named mesh groups and materials;
- a mesh group as one or more primitives;
- a primitive as validated `three-d-core::Mesh` geometry plus an optional material reference;
- a small metallic-roughness PBR material record with base-color, metallic, roughness, and double-sided factors;
- referential integrity between primitives and the asset material table.

The geometry inside every primitive remains owned by `three-d-core`; `three-d-assets` composes that geometry into an asset rather than duplicating mesh validation. Tangent vectors are geometry attributes and therefore flow through primitives automatically once present on the core mesh.

## Format adapter boundary

`three-d-formats` is the downstream decoding layer. It uses dedicated OBJ and glTF parsers, normalizes accepted geometry into `three-d-core::Mesh`, and terminates in `three-d-assets::Asset`.

The adapter is deliberately loss-aware. It rejects source semantics that cannot currently be represented faithfully rather than silently deleting them. The current glTF path accepts triangle primitives with positions plus optional normals, tangents, UV0, and color0, embedded/GLB buffer data, and factor-only metallic-roughness materials. Extra attribute sets, skinning attributes, morph targets, textures, emissive/alpha material behavior, and external buffer URIs remain explicit unsupported boundaries. The current in-memory OBJ path triangulates and single-indexes geometry, but rejects MTL-backed material references until an explicit MTL-to-material policy exists.

This separation means support can grow format-by-format without importing parser vocabulary into the semantic crates.

## Normal-map boundary

The geometry half of normal mapping now has an owner: `three-d-core` validates tangent VEC4 attributes and can derive a tangent basis deterministically from normals and UVs. The glTF adapter preserves `TANGENT` data when it is present.

Encoded images, texture/sampler records, UV-set selection, and material normal-texture bindings are not yet represented by `three-d-assets`. Until that model exists, `three-d-formats` continues to reject glTF normal textures instead of discarding them. This keeps the next asset slice explicit and lossless.

## Deliberately downstream

Format adapters own details that should not leak into the durable asset model:

- glTF scenes, nodes, primitive JSON, accessor indices, buffer-view indices, buffers, data URIs, GLB chunks, and extension decoding;
- OBJ groups, object records, face syntax, and material-library parsing;
- byte-order, component-type, stride, sparse-accessor, and image decoding;
- Three.js objects, GPU buffers, shader materials, and renderer-specific resource lifetime.

A format adapter validates and decodes its source, constructs `three-d-core::Mesh` values, then builds `three-d-assets::Asset` values. Renderer adapters consume that result rather than reopening the source format.

## Teaching surface

The browser model-pipeline lesson intentionally exposes the full glTF chain—scene → node → mesh → primitive → accessors/bufferViews/buffer and material—because those format details are the subject being taught. The tangent-space lesson separately shows how geometry plus UVs produce the local basis used by a normal map. Neither teaching surface changes semantic ownership.
