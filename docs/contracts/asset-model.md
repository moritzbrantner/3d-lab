# Asset model ownership contract

`three-d-assets` owns the renderer-independent result of loading a mesh asset. It deliberately does not own a file format.

## Owned concepts

The crate models:

- an asset as a collection of named mesh groups and materials;
- a mesh group as one or more primitives;
- a primitive as validated `three-d-core::Mesh` geometry plus an optional material reference;
- a small metallic-roughness PBR material record with base-color, metallic, roughness, and double-sided factors;
- referential integrity between primitives and the asset material table.

The geometry inside every primitive remains owned by `three-d-core`; `three-d-assets` composes that geometry into an asset rather than duplicating mesh validation.

## Deliberately downstream

Format adapters own details that should not leak into the durable asset model:

- glTF scenes, nodes, primitive JSON, accessor indices, buffer-view indices, buffers, data URIs, GLB chunks, and extension decoding;
- OBJ groups, object records, face syntax, and material-library parsing;
- byte-order, component-type, stride, sparse-accessor, and image decoding;
- Three.js objects, GPU buffers, shader materials, and renderer-specific resource lifetime.

A glTF or OBJ adapter should validate and decode its source, construct `three-d-core::Mesh` values, then build `three-d-assets::Asset` values. The next model-pipeline slice can therefore add file loaders without moving file-format vocabulary into the semantic core.

## Teaching surface

The browser model-pipeline lesson intentionally exposes the full glTF chain—scene → node → mesh → primitive → accessors/bufferViews/buffer and material—because those format details are the subject being taught. That does not make the Rust asset model a glTF wrapper.
