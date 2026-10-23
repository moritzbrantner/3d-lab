// Browser-native ES module, like the renderer's other distributed modules. This is
// transport/codec adaptation only; Rust still validates and samples the canonical rig.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { sha256Hex } from "./content-hash.js";
import { assembleGlb } from "./bundle-glb.js";

const decodedExtensions = new Set([
  "EXT_meshopt_compression",
  "KHR_mesh_quantization",
  "KHR_texture_basisu",
]);
const filename = (value) =>
  typeof value === "string" && /^[\w.-]+$/.test(value) && value !== "." && value !== "..";
export function downloadEntry(index, key, variant, fail) {
  if (index?.schema !== "asset-downloads-v1" || !Array.isArray(index.entries)) {
    fail("bundle index must be asset-downloads-v1");
  }
  const matches = index.entries.filter((entry) => entry.key === key && entry.variant === variant);
  if (matches.length !== 1) {
    fail(`bundle has no ${key}/${variant} unique entry`);
  }
  const entry = matches[0];
  if (
    !Array.isArray(entry.files) ||
    !Array.isArray(entry.textures) ||
    ![...entry.files, ...entry.textures, ...(entry.clips ? [entry.clips] : [])].every(filename) ||
    entry.files.filter((path) => path.endsWith(".gltf")).length !== 1
  ) {
    fail("download entry needs safe filenames and one glTF");
  }
  return entry;
}
/** Append standard decoded clip accessors, remapping each target by its authored name. */
export function bindSharedAnimations(target, clips, fail) {
  const names = new Map();
  for (const [index, node] of target.nodes.entries()) {
    if (typeof node.name === "string") {
      names.set(node.name, names.has(node.name) ? null : index);
    }
  }
  const clipNames = new Set((target.animations ?? []).map((clip) => clip.name));
  const animations = structuredClone(clips.animations ?? []);
  const accessorOffset = (target.accessors ?? []).length;
  for (const clip of animations) {
    if (clipNames.has(clip.name)) {
      fail(`duplicate clip ${clip.name}`);
    }
    clipNames.add(clip.name);
    for (const channel of clip.channels) {
      const name = clips.nodes[channel.target.node]?.name;
      const node = names.get(name);
      if (
        node === undefined ||
        node === null ||
        clips.nodes.filter((joint) => joint.name === name).length !== 1
      ) {
        fail(`shared clips require unique joint ${name}`);
      }
      channel.target.node = node;
    }
    for (const sampler of clip.samplers) {
      sampler.input += accessorOffset;
      sampler.output += accessorOffset;
    }
  }
  const viewOffset = (target.bufferViews ?? []).length;
  const bufferOffset = (target.buffers ?? []).length;
  target.accessors = [
    ...(target.accessors ?? []),
    ...(clips.accessors ?? []).map((accessor) => ({
      ...accessor,
      ...(accessor.bufferView === undefined
        ? {}
        : { bufferView: accessor.bufferView + viewOffset }),
    })),
  ];
  target.bufferViews = [
    ...(target.bufferViews ?? []),
    ...(clips.bufferViews ?? []).map((view) => ({ ...view, buffer: view.buffer + bufferOffset })),
  ];
  target.buffers = [...(target.buffers ?? []), ...(clips.buffers ?? [])];
  target.animations = [...(target.animations ?? []), ...animations];
}
/** One disposal per shared GPU resource, also used when admission fails after decoding. */
export function disposeDecoded(gltf) {
  const resources = new Set();
  const images = new Set();
  for (const scene of gltf.scenes ?? [gltf.scene]) {
    scene.traverse((node) => {
      if (node.geometry) {
        resources.add(node.geometry);
      }
      if (node.skeleton) {
        resources.add(node.skeleton);
      }
      for (const material of node.material
        ? Array.isArray(node.material)
          ? node.material
          : [node.material]
        : []) {
        resources.add(material);
        for (const value of Object.values(material)) {
          if (value?.isTexture) {
            resources.add(value);
            if (value.image?.close) {
              images.add(value.image);
            }
          }
        }
      }
    });
  }
  for (const resource of resources) {
    resource.dispose();
  }
  for (const image of images) {
    image.close();
  }
}
/** Normalize decoded accessors without reinterpreting transforms, skinning or clips. */
async function canonicalDocument(gltf, uri, fail) {
  const json = structuredClone(gltf.parser.json);
  const integral = new Set();
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      if (primitive.indices !== undefined) {
        integral.add(primitive.indices);
      }
      for (const [semantic, accessor] of Object.entries(primitive.attributes)) {
        if (semantic.startsWith("JOINTS_")) {
          integral.add(accessor);
        }
      }
    }
  }
  const parts = [];
  let byteLength = 0;
  const views = [];
  json.accessors = await Promise.all(
    (json.accessors ?? []).map(async (source, index) => {
      const attribute = await gltf.parser.getDependency("accessor", index);
      // JOINTS_0 is unsigned short in standard glTF; indices may use unsigned int.
      let typed = new Float32Array(attribute.count * attribute.itemSize);
      if (integral.has(index)) {
        typed =
          source.type === "SCALAR" ? new Uint32Array(typed.length) : new Uint16Array(typed.length);
      }
      for (let i = 0; i < attribute.count; i++) {
        for (let component = 0; component < attribute.itemSize; component++) {
          typed[i * attribute.itemSize + component] = attribute.getComponent(i, component);
        }
      }
      return { source, attribute, typed };
    }),
  ).then((entries) =>
    entries.map(({ source, attribute, typed }) => {
      const bytes = new Uint8Array(typed.buffer);
      const bufferView = views.length;
      views.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength });
      parts.push([byteLength, bytes]);
      byteLength = (byteLength + bytes.byteLength + 3) & ~3;
      let componentType = 5126;
      if (typed instanceof Uint16Array) {
        componentType = 5123;
      }
      if (typed instanceof Uint32Array) {
        componentType = 5125;
      }
      const accessor = { bufferView, componentType, count: attribute.count, type: source.type };
      if (source.min || source.max) {
        accessor.min = Array.from({ length: attribute.itemSize }, (_, c) => {
          let value = Infinity;
          for (let i = c; i < typed.length; i += attribute.itemSize) {
            value = Math.min(value, typed[i]);
          }
          return value;
        });
        accessor.max = Array.from({ length: attribute.itemSize }, (_, c) => {
          let value = -Infinity;
          for (let i = c; i < typed.length; i += attribute.itemSize) {
            value = Math.max(value, typed[i]);
          }
          return value;
        });
      }
      return accessor;
    }),
  );
  const bytes = new Uint8Array(byteLength);
  for (const [offset, part] of parts) {
    bytes.set(part, offset);
  }
  json.bufferViews = views;
  json.buffers = [{ uri, byteLength }];
  // GPU textures stay in the single Three.js decode, never transcoded back to PNG
  // merely to validate a pose. The Rust copy carries factor-only material data.
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const material of json.materials ?? []) {
    for (const slot of ["normalTexture", "occlusionTexture", "emissiveTexture"]) {
      delete material[slot];
    }
    if (material.pbrMetallicRoughness) {
      delete material.pbrMetallicRoughness.baseColorTexture;
      delete material.pbrMetallicRoughness.metallicRoughnessTexture;
    }
  }
  for (const field of ["extensionsUsed", "extensionsRequired"]) {
    if (json[field]) {
      json[field] = json[field].filter((name) => !decodedExtensions.has(name));
    }
  }
  const unsupported = json.extensionsRequired ?? [];
  if (unsupported.length) {
    fail(`unsupported required extensions: ${unsupported.join(", ")}`);
  }
  return { json, bytes };
}
export async function loadDownloadBundle(bundle, options, fail, character) {
  const { manifest, key, variant = "default", readResource } = bundle;
  if (typeof readResource !== "function") {
    fail("bundle readResource must be a function");
  }
  const entry = downloadEntry(manifest, key, variant, fail);
  const documentPath = entry.files.find((path) => path.endsWith(".gltf"));
  const read = async (path) => {
    const value = await readResource(path);
    if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) {
      fail(`bundle resource ${path} must resolve to bytes`);
    }
    return new Uint8Array(
      value instanceof ArrayBuffer
        ? value
        : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  };
  const document = await read(documentPath);
  const json = JSON.parse(new TextDecoder().decode(document));
  if (
    (json.extensionsUsed ?? []).includes("KHR_texture_basisu") &&
    (!options.renderer?.configureTextureLoader ||
      typeof options.transcoderPath !== "string" ||
      !options.transcoderPath.endsWith("/"))
  ) {
    fail("KTX2 needs renderer.configureTextureLoader and transcoderPath ending in /");
  }
  const declared = new Set([...entry.files, ...entry.textures]);
  const paths = new Set();
  for (const resource of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (resource.uri === undefined && resource.extensions?.EXT_meshopt_compression?.fallback) {
      continue;
    }
    if (!filename(resource.uri) || !declared.has(resource.uri)) {
      fail(`glTF uri ${resource.uri} is not a declared download resource`);
    }
    paths.add(resource.uri);
  }
  if (character && entry.clips) {
    paths.add(entry.clips);
  }
  const totalBytes =
    (entry.bytes ?? 0) + (character && entry.clips ? (manifest.clips?.bytes ?? 0) : 0);
  let loadedBytes = document.byteLength;
  options.onProgress?.({ loadedBytes, totalBytes });
  const files = new Map(
    await Promise.all(
      [...paths].map(async (path) => {
        const bytes = await read(path);
        loadedBytes += bytes.byteLength;
        options.onProgress?.({ loadedBytes, totalBytes });
        return [path, bytes];
      }),
    ),
  );
  const manager = new THREE.LoadingManager();
  const failures = [];
  manager.onError = (url) => {
    failures.push(url);
  };
  const urls = new Map();
  for (const [path, bytes] of files) {
    urls.set(path, URL.createObjectURL(new Blob([bytes])));
  }
  manager.setURLModifier((url) => {
    if (urls.has(url)) {
      return urls.get(url);
    }
    if (
      typeof options.transcoderPath === "string" &&
      ["basis_transcoder.js", "basis_transcoder.wasm"].some(
        (file) => url === options.transcoderPath + file,
      )
    ) {
      return url;
    }
    // Embedded images created by GLTFLoader itself are already owned there.
    if (url.startsWith("blob:")) {
      return url;
    }
    fail(`undeclared loader URL ${url}`);
  });
  let ktx2, gltf, clips, parser;
  try {
    const loader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
    loader.register((activeParser) => {
      parser = activeParser;
      return { name: "bundle-resource-owner" };
    });
    if ((json.extensionsUsed ?? []).includes("KHR_texture_basisu")) {
      if (!options.renderer?.configureTextureLoader || typeof options.transcoderPath !== "string") {
        fail("KTX2 needs renderer.configureTextureLoader and transcoderPath");
      }
      ktx2 = new KTX2Loader(manager).setTranscoderPath(options.transcoderPath);
      options.renderer.configureTextureLoader(ktx2);
      loader.setKTX2Loader(ktx2);
    }
    gltf = await loader.parseAsync(new TextDecoder().decode(document), "");
    if (failures.length) {
      fail(`bundle resource decode failed: ${failures.join(", ")}`);
    }
    const canonical = await canonicalDocument(gltf, "entry.decoded.bin", fail);
    const buffers = new Map([["entry.decoded.bin", canonical.bytes]]);
    if (character && entry.clips) {
      clips = await loader.parseAsync(files.get(entry.clips).buffer, "");
      const shared = await canonicalDocument(clips, "clips.decoded.bin", fail);
      bindSharedAnimations(canonical.json, shared.json, fail);
      buffers.set("clips.decoded.bin", shared.bytes);
    }
    options.onProgress?.({ loadedBytes, totalBytes: loadedBytes });
    const identity = [
      sha256Hex(document),
      ...[...files]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, bytes]) => `${path}:${sha256Hex(bytes)}`),
    ].join("\n");
    return {
      entry: { ...entry, sha256: sha256Hex(new TextEncoder().encode(identity)) },
      key,
      variant,
      gltf,
      glb: assembleGlb(canonical.json, buffers, fail),
    };
  } catch (error) {
    if (gltf) {
      disposeDecoded(gltf);
    }
    // GLTFLoader may reject after some sibling primitives/textures have loaded.
    // Observe only already-started dependencies; never initiate new loads on failure.
    if (!gltf && parser) {
      const pending = [];
      for (const kind of ["mesh", "material", "texture"]) {
        const field = kind === "mesh" ? "meshes" : `${kind}s`;
        for (let i = 0; i < (parser.json[field] ?? []).length; i++) {
          const promise = parser.cache.get(`${kind}:${i}`);
          if (promise) {
            pending.push(promise);
          }
        }
      }
      for (const value of Object.values(parser.primitiveCache)) {
        pending.push(value.promise);
      }
      const resources = new Set();
      const collect = (value) => {
        if (value?.isObject3D) {
          value.traverse((node) => {
            if (node.geometry) {
              resources.add(node.geometry);
            }
            if (node.material) {
              for (const material of Array.isArray(node.material)
                ? node.material
                : [node.material]) {
                collect(material);
              }
            }
          });
        }
        if (value?.isMaterial) {
          resources.add(value);
          for (const texture of Object.values(value)) {
            if (texture?.isTexture) {
              resources.add(texture);
            }
          }
        }
        if (value?.isTexture || value?.isBufferGeometry) {
          resources.add(value);
        }
        if (Array.isArray(value)) {
          value.forEach(collect);
        }
      };
      for (const result of await Promise.allSettled(pending)) {
        if (result.status === "fulfilled") {
          collect(result.value);
        }
      }
      for (const resource of resources) {
        resource.dispose();
      }
    }
    throw error;
  } finally {
    if (clips) {
      disposeDecoded(clips);
    }
    ktx2?.dispose();
    for (const url of urls.values()) {
      URL.revokeObjectURL(url);
    }
  }
}
