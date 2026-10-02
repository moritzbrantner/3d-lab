import * as THREE from "three"
import {GLTFLoader} from "three/examples/jsm/loaders/GLTFLoader.js"
import {sha256Hex} from "./content-hash.js"
import {ThreeRendererContractError} from "./index.js"

// Static GLB adapter: lowers one already validated, self-contained GLB into immutable renderer
// descriptors (scene-node hierarchy, indexed mesh geometry, and factor-only materials) once, so
// callers submit them every frame without reparsing. Three.js GLTFLoader is used only to decode
// the GLB container and accessors; hierarchy, transforms, materials, and the supported-feature
// boundary are lowered here from the glTF JSON, mirroring `three-d-formats`. See
// docs/contracts/browser-renderer.md#static-glb-assets.

const GLB_MAGIC = 0x46546c67
const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942
const TRIANGLES = 4
const SUPPORTED_ATTRIBUTES = new Set(["POSITION", "NORMAL", "TANGENT", "TEXCOORD_0", "COLOR_0"])
const FLOAT_COMPONENT = 5126
const UNSIGNED_BYTE_COMPONENT = 5121
const UNSIGNED_SHORT_COMPONENT = 5123
const UNSIGNED_INT_COMPONENT = 5125
// glTF 2.0 core accessor encodings per semantic (no KHR_mesh_quantization, which, like every
// extension, `three-d-formats` does not enable): [types, component types allowed as float,
// component types allowed only when normalized]. Indices must be unnormalized unsigned scalars.
const SEMANTIC_ENCODINGS = Object.freeze({
  POSITION: [["VEC3"], [FLOAT_COMPONENT], []],
  NORMAL: [["VEC3"], [FLOAT_COMPONENT], []],
  TANGENT: [["VEC4"], [FLOAT_COMPONENT], []],
  TEXCOORD_0: [["VEC2"], [FLOAT_COMPONENT], [UNSIGNED_BYTE_COMPONENT, UNSIGNED_SHORT_COMPONENT]],
  COLOR_0: [["VEC3", "VEC4"], [FLOAT_COMPONENT], [UNSIGNED_BYTE_COMPONENT, UNSIGNED_SHORT_COMPONENT]],
  indices: [["SCALAR"], [UNSIGNED_BYTE_COMPONENT, UNSIGNED_SHORT_COMPONENT, UNSIGNED_INT_COMPONENT], []],
})
/**
 * Extensions whose semantics the adapter maps. Empty on purpose: `three-d-formats` enables no glTF
 * extension, so it rejects every required extension and ignores optional ones (including
 * `KHR_materials_unlit`). The adapter mirrors that instead of interpreting extensions itself.
 */
const SUPPORTED_EXTENSIONS = new Set()
const MATERIAL_TEXTURES = [
  ["pbrMetallicRoughness", "baseColorTexture"],
  ["pbrMetallicRoughness", "metallicRoughnessTexture"],
  [null, "normalTexture"],
  [null, "occlusionTexture"],
  [null, "emissiveTexture"],
]

export class StaticGlbContractError extends ThreeRendererContractError {
  constructor(message) {
    super(message)
    this.name = "StaticGlbContractError"
  }
}

function fail(message) {
  throw new StaticGlbContractError(message)
}

function toBytes(source) {
  if (source instanceof ArrayBuffer) return new Uint8Array(source)
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
  return fail("static GLB source must be an ArrayBuffer or a byte view")
}

/** Reads the GLB 2.0 header and JSON chunk; returns the document and the BIN chunk length. */
function readGlbDocument(bytes) {
  if (bytes.byteLength < 20) fail("static GLB is truncated: missing header or JSON chunk")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== GLB_MAGIC) fail("static GLB must start with the glTF binary magic")
  if (view.getUint32(4, true) !== 2) fail(`static GLB version ${view.getUint32(4, true)} is unsupported; expected 2`)
  if (view.getUint32(8, true) !== bytes.byteLength) {
    fail(`static GLB header length ${view.getUint32(8, true)} does not match ${bytes.byteLength} bytes`)
  }
  const jsonLength = view.getUint32(12, true)
  if (view.getUint32(16, true) !== JSON_CHUNK || 20 + jsonLength > bytes.byteLength) {
    fail("static GLB first chunk must be a complete JSON chunk")
  }
  let json
  try {
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)))
  } catch (error) {
    fail(`static GLB JSON chunk is malformed: ${error.message}`)
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) fail("static GLB JSON must be an object")

  let binLength = null
  const binOffset = 20 + jsonLength
  if (binOffset < bytes.byteLength) {
    if (binOffset + 8 > bytes.byteLength) fail("static GLB BIN chunk header is truncated")
    binLength = view.getUint32(binOffset, true)
    if (view.getUint32(binOffset + 4, true) !== BIN_CHUNK || binOffset + 8 + binLength > bytes.byteLength) {
      fail("static GLB second chunk must be a complete BIN chunk")
    }
  }
  return {json, binLength}
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

function requireObject(value, label) {
  if (!isObject(value)) fail(`${label} must be an object`)
  return value
}

/** An optional glTF array property: absent means empty, anything but an array is malformed. */
function list(owner, key, label) {
  const value = owner[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(`${label} ${key} must be an array`)
  return value
}

/** An optional glTF array of objects (`buffers`, `materials`, `nodes`, ...). */
function objectList(owner, key, label) {
  const entries = list(owner, key, label)
  entries.forEach((entry, index) => requireObject(entry, `${label} ${key} ${index}`))
  return entries
}

function requireByteCount(value, label, {optional = false} = {}) {
  if (optional && value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer`)
  return value
}

function requireIndex(value, length, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= length) {
    fail(`${label} ${String(value)} does not reference an existing entry`)
  }
}

/**
 * Rejects every source semantic the adapter cannot render faithfully before any decoding, so
 * unsupported content fails deliberately instead of degrading. Returns the default scene's
 * root nodes and the optional extensions that were present but not used.
 */
function preflight(json, binLength) {
  const asset = requireObject(json.asset, "static GLB asset")
  if (typeof asset.version !== "string" || !asset.version.startsWith("2.")) {
    fail("static GLB asset.version must be 2.x")
  }
  for (const name of list(json, "extensionsRequired", "static GLB")) {
    if (!SUPPORTED_EXTENSIONS.has(name)) fail(`static GLB requires unsupported extension ${String(name)}`)
  }
  const extensionsUsed = list(json, "extensionsUsed", "static GLB")
  if (extensionsUsed.some((name) => typeof name !== "string")) fail("static GLB extensionsUsed must contain strings")
  const ignoredExtensions = extensionsUsed.filter((name) => !SUPPORTED_EXTENSIONS.has(name))

  const buffers = objectList(json, "buffers", "static GLB")
  buffers.forEach((buffer, index) => {
    if (buffer.uri !== undefined) {
      fail(`static GLB buffer ${index} uses a URI; package a self-contained GLB with only the BIN chunk`)
    }
    if (index !== 0) fail("static GLB may declare only the BIN-chunk buffer")
    const byteLength = requireByteCount(buffer.byteLength, `buffer ${index} byteLength`)
    if (binLength === null || binLength < byteLength) {
      fail(`static GLB buffer 0 needs ${byteLength} bytes but the BIN chunk is missing or shorter`)
    }
  })
  const bufferViews = objectList(json, "bufferViews", "static GLB")
  bufferViews.forEach((bufferView, index) => {
    requireIndex(bufferView.buffer, buffers.length, `bufferView ${index} buffer`)
    const byteOffset = requireByteCount(bufferView.byteOffset, `bufferView ${index} byteOffset`, {optional: true})
    const byteLength = requireByteCount(bufferView.byteLength, `bufferView ${index} byteLength`)
    if (bufferView.byteStride !== undefined) requireByteCount(bufferView.byteStride, `bufferView ${index} byteStride`)
    if (byteOffset + byteLength > buffers[bufferView.buffer].byteLength) {
      fail(`bufferView ${index} exceeds its buffer`)
    }
  })
  // The Rust loader loads every declared image, used or not, and rejects external URIs
  // (`UnsupportedGltfImageUri`); only embedded data URIs and bufferView images are self-contained.
  objectList(json, "images", "static GLB").forEach((image, index) => {
    if (image.uri !== undefined && (typeof image.uri !== "string" || !image.uri.startsWith("data:"))) {
      fail(`static GLB image ${index} uses an external URI; package a self-contained GLB`)
    }
    if (image.bufferView !== undefined) requireIndex(image.bufferView, bufferViews.length, `image ${index} bufferView`)
  })
  const accessors = objectList(json, "accessors", "static GLB")
  accessors.forEach((accessor, index) => {
    if (accessor.bufferView !== undefined) requireIndex(accessor.bufferView, bufferViews.length, `accessor ${index} bufferView`)
    requireByteCount(accessor.byteOffset, `accessor ${index} byteOffset`, {optional: true})
    requireByteCount(accessor.count, `accessor ${index} count`)
  })

  if (list(json, "skins", "static GLB").length > 0) fail("static GLB declares skins; skinned assets are out of scope for the static adapter")
  if (list(json, "animations", "static GLB").length > 0) {
    fail("static GLB declares animations; animated assets are out of scope for the static adapter")
  }

  const materials = objectList(json, "materials", "static GLB")
  materials.forEach((material, index) => {
    const label = `material ${index}`
    if (material.pbrMetallicRoughness !== undefined) requireObject(material.pbrMetallicRoughness, `${label} pbrMetallicRoughness`)
    for (const [group, slot] of MATERIAL_TEXTURES) {
      const owner = group === null ? material : material[group]
      if (owner?.[slot] !== undefined) fail(`${label} uses ${slot}; textured materials are not supported yet`)
    }
    if (material.alphaMode !== undefined && material.alphaMode !== "OPAQUE") {
      fail(`${label} alphaMode ${String(material.alphaMode)} is unsupported; only OPAQUE is rendered`)
    }
    if (material.doubleSided !== undefined && typeof material.doubleSided !== "boolean") fail(`${label} doubleSided must be a boolean`)
    // Mirrors `three-d-formats`, which rejects any non-zero emissive factor: emissive semantics
    // belong to the Rust material model first, not to this adapter.
    const emissiveFactor = material.emissiveFactor ?? [0, 0, 0]
    if (!Array.isArray(emissiveFactor) || emissiveFactor.length !== 3) fail(`${label} emissiveFactor must have 3 components`)
    requireFinite(emissiveFactor, `${label} emissiveFactor`)
    if (emissiveFactor.some((value) => value !== 0)) {
      fail(`${label} uses a non-zero emissiveFactor; emissive materials are not supported yet`)
    }
  })

  const meshes = objectList(json, "meshes", "static GLB")
  meshes.forEach((mesh, meshIndex) => {
    const primitives = objectList(mesh, "primitives", `mesh ${meshIndex}`)
    if (primitives.length === 0) fail(`mesh ${meshIndex} has no primitives`)
    if (mesh.weights !== undefined) fail(`mesh ${meshIndex} declares morph weights; morph targets are unsupported`)
    primitives.forEach((primitive, primitiveIndex) => {
      const label = `mesh ${meshIndex} primitive ${primitiveIndex}`
      if ((primitive.mode ?? TRIANGLES) !== TRIANGLES) fail(`${label} mode ${String(primitive.mode)} is unsupported; only triangles are rendered`)
      if (list(primitive, "targets", label).length > 0) fail(`${label} declares morph targets; morph targets are unsupported`)
      const attributes = requireObject(primitive.attributes, `${label} attributes`)
      for (const [semantic, accessor] of Object.entries(attributes)) {
        if (!SUPPORTED_ATTRIBUTES.has(semantic)) fail(`${label} attribute ${semantic} is unsupported`)
        requireIndex(accessor, accessors.length, `${label} ${semantic} accessor`)
      }
      if (attributes.POSITION === undefined) fail(`${label} is missing POSITION`)
      if (attributes.NORMAL === undefined) fail(`${label} is missing NORMAL; generated flat normals are not supported`)
      if (primitive.indices !== undefined) requireIndex(primitive.indices, accessors.length, `${label} indices accessor`)
      // A glTF accessor with neither bufferView nor sparse is zero-initialized. GLTFLoader would
      // materialize zeros (older versions resolve null), while `three-d-formats` reads it as an
      // absent attribute; neither is a meaningful static mesh, so it is rejected explicitly.
      const referenced = [...Object.entries(attributes), ...(primitive.indices === undefined ? [] : [["indices", primitive.indices]])]
      for (const [semantic, accessor] of referenced) {
        const definition = accessors[accessor]
        if (definition.bufferView === undefined && definition.sparse === undefined) {
          fail(`${label} ${semantic} accessor ${accessor} has no bufferView or sparse data; zero-initialized accessors are not supported`)
        }
        // Mirrors the glTF 2.0 semantic encodings the Rust loader enforces, so GLTFLoader cannot
        // decode (and the adapter render) geometry with an encoding the authority rejects.
        const [types, plain, normalizedOnly] = SEMANTIC_ENCODINGS[semantic]
        const normalized = definition.normalized ?? false
        const allowed = types.includes(definition.type) && (
          semantic === "indices"
            ? normalized === false && plain.includes(definition.componentType)
            : (plain.includes(definition.componentType) && normalized === false) ||
              (normalizedOnly.includes(definition.componentType) && normalized === true)
        )
        if (!allowed) {
          fail(`${label} ${semantic} accessor ${accessor} uses an unsupported encoding (${String(definition.type)}, componentType ${String(definition.componentType)}${normalized ? ", normalized" : ""})`)
        }
      }
      if (primitive.material !== undefined) requireIndex(primitive.material, materials.length, `${label} material`)
    })
  })

  const nodes = objectList(json, "nodes", "static GLB")
  const parents = new Array(nodes.length).fill(null)
  nodes.forEach((node, index) => {
    if (node.skin !== undefined) fail(`node ${index} references a skin; skinned assets are out of scope for the static adapter`)
    if (node.weights !== undefined) fail(`node ${index} declares morph weights; morph targets are unsupported`)
    if (node.mesh !== undefined) requireIndex(node.mesh, meshes.length, `node ${index} mesh`)
    const hasTrs = node.translation !== undefined || node.rotation !== undefined || node.scale !== undefined
    if (node.matrix !== undefined && hasTrs) fail(`node ${index} declares both matrix and TRS properties`)
    for (const child of list(node, "children", `node ${index}`)) {
      requireIndex(child, nodes.length, `node ${index} child`)
      if (parents[child] !== null || child === index) fail(`node ${child} has more than one parent or is its own child`)
      parents[child] = index
    }
  })

  const scenes = objectList(json, "scenes", "static GLB")
  if (scenes.length === 0) fail("static GLB declares no scene to instantiate")
  const sceneIndex = json.scene ?? 0
  requireIndex(sceneIndex, scenes.length, "static GLB default scene")
  const roots = list(scenes[sceneIndex], "nodes", `scene ${sceneIndex}`)
  const seenRoots = new Set()
  for (const root of roots) {
    requireIndex(root, nodes.length, "scene root node")
    if (parents[root] !== null) fail(`scene root node ${root} is also a child of node ${parents[root]}`)
    if (seenRoots.has(root)) fail(`scene root node ${root} is listed more than once`)
    seenRoots.add(root)
  }
  return {roots, ignoredExtensions}
}

/**
 * Re-packs the GLB with every extension declaration removed. Preflight already rejected required
 * extensions, and the Rust loader enables none, so an optional extension (for example Draco with
 * core fallback attributes) must not switch GLTFLoader onto an extension decoding path; it reads
 * only the core accessors. The BIN chunk is copied unchanged.
 */
function coreGlb(bytes, json) {
  const stripped = JSON.stringify(json, (key, value) =>
    key === "extensions" || key === "extensionsUsed" || key === "extensionsRequired" ? undefined : value,
  )
  const encoded = new TextEncoder().encode(stripped)
  const jsonLength = Math.ceil(encoded.byteLength / 4) * 4
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const binStart = 20 + view.getUint32(12, true)
  const bin = bytes.subarray(binStart)
  const output = new Uint8Array(12 + 8 + jsonLength + bin.byteLength)
  const out = new DataView(output.buffer)
  out.setUint32(0, GLB_MAGIC, true)
  out.setUint32(4, 2, true)
  out.setUint32(8, output.byteLength, true)
  out.setUint32(12, jsonLength, true)
  out.setUint32(16, JSON_CHUNK, true)
  output.fill(0x20, 20, 20 + jsonLength)
  output.set(encoded, 20)
  output.set(bin, 20 + jsonLength)
  return output
}

async function decodeGltf(bytes, json) {
  // A fresh copy, so the loader never observes caller-owned memory after this call.
  const buffer = coreGlb(bytes, json).buffer
  try {
    return await new GLTFLoader().parseAsync(buffer, "")
  } catch (error) {
    return fail(`static GLB could not be decoded: ${error?.message ?? String(error)}`)
  }
}

function requireFinite(values, label) {
  for (const value of values) {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite value`)
  }
}

/** Checks every component of an accessor, including ones the adapter does not carry. */
function requireFiniteComponents(attribute, size, label) {
  for (let index = 0; index < attribute.count; index += 1) {
    for (let component = 0; component < size; component += 1) {
      if (!Number.isFinite(attribute.getComponent(index, component))) fail(`${label} contains a non-finite value`)
    }
  }
}

function readTuples(attribute, size, label) {
  const tuples = new Array(attribute.count)
  for (let index = 0; index < attribute.count; index += 1) {
    const tuple =
      size === 2
        ? [attribute.getX(index), attribute.getY(index)]
        : [attribute.getX(index), attribute.getY(index), attribute.getZ(index)]
    requireFinite(tuple, label)
    tuples[index] = Object.freeze(tuple)
  }
  return Object.freeze(tuples)
}

const scratchColor = new THREE.Color()

/** glTF COLOR_0 is linear; the renderer mesh contract takes sRGB components. */
function readSrgbColors(attribute, label) {
  const colors = new Array(attribute.count)
  for (let index = 0; index < attribute.count; index += 1) {
    const linear = [attribute.getX(index), attribute.getY(index), attribute.getZ(index)]
    // The alpha of a VEC4 COLOR_0 is dropped (only OPAQUE renders) but checked like RGB first.
    const checked = attribute.itemSize === 4 ? [...linear, attribute.getW(index)] : linear
    requireFinite(checked, label)
    if (checked.some((value) => value < 0 || value > 1)) fail(`${label} components must be between 0 and 1`)
    scratchColor.setRGB(linear[0], linear[1], linear[2], THREE.LinearSRGBColorSpace)
    const srgb = {r: 0, g: 0, b: 0}
    scratchColor.getRGB(srgb, THREE.SRGBColorSpace)
    colors[index] = Object.freeze([clamp01(srgb.r), clamp01(srgb.g), clamp01(srgb.b)])
  }
  return Object.freeze(colors)
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value))
}

async function lowerPrimitive(parser, primitive, resourceKey, label) {
  const attributes = primitive.attributes
  const accessor = async (index) => {
    try {
      return await parser.getDependency("accessor", index)
    } catch (error) {
      return fail(`${label} accessor ${index} could not be decoded: ${error?.message ?? String(error)}`)
    }
  }
  const positionAttribute = await accessor(attributes.POSITION)
  if (positionAttribute.itemSize !== 3 || positionAttribute.count === 0) fail(`${label} POSITION must be non-empty VEC3`)
  const positions = readTuples(positionAttribute, 3, `${label} POSITION`)
  const vertexCount = positions.length

  const aligned = async (semantic, itemSizes) => {
    if (attributes[semantic] === undefined) return null
    const attribute = await accessor(attributes[semantic])
    if (!itemSizes.includes(attribute.itemSize) || attribute.count !== vertexCount) {
      fail(`${label} ${semantic} must be ${itemSizes.join("/")}-component and align with POSITION`)
    }
    return attribute
  }
  const normals = readTuples(await aligned("NORMAL", [3]), 3, `${label} NORMAL`)
  const uvAttribute = await aligned("TEXCOORD_0", [2])
  const colorAttribute = await aligned("COLOR_0", [3, 4])
  // TANGENT is validated like the Rust loader (aligned, and every component finite, as
  // `three-d-core` checks each `Tangent4`) but not carried: tangents only serve normal maps, which
  // this adapter rejects until a textured-material contract exists.
  const tangentAttribute = await aligned("TANGENT", [4])
  if (tangentAttribute) requireFiniteComponents(tangentAttribute, 4, `${label} TANGENT`)

  let indices
  if (primitive.indices === undefined) {
    indices = Array.from({length: vertexCount}, (_, index) => index)
  } else {
    const indexAttribute = await accessor(primitive.indices)
    if (indexAttribute.itemSize !== 1) fail(`${label} indices must be SCALAR`)
    indices = Array.from({length: indexAttribute.count}, (_, index) => indexAttribute.getX(index))
  }
  if (indices.length === 0 || indices.length % 3 !== 0) fail(`${label} must contain whole triangles`)
  for (const index of indices) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= vertexCount) {
      fail(`${label} index ${index} does not reference an existing vertex`)
    }
  }

  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const position of positions) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], position[axis])
      max[axis] = Math.max(max[axis], position[axis])
    }
  }

  const geometry = {kind: "mesh", resourceKey, positions, indices: Object.freeze(indices), normals}
  if (uvAttribute) geometry.uvs = readTuples(uvAttribute, 2, `${label} TEXCOORD_0`)
  if (colorAttribute) geometry.colors = readSrgbColors(colorAttribute, `${label} COLOR_0`)
  return {geometry: Object.freeze(geometry), bounds: freezeBounds(min, max)}
}

function freezeBounds(min, max) {
  return Object.freeze({min: Object.freeze(min), max: Object.freeze(max)})
}

function linearToSrgbHex(rgb) {
  scratchColor.setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace)
  return `#${scratchColor.getHexString(THREE.SRGBColorSpace)}`
}

function requireFactor(value, fallback, label, {max = 1} = {}) {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > max) fail(`${label} must be between 0 and ${max}`)
  return resolved
}

const DEFAULT_MATERIAL = Object.freeze({
  index: null,
  name: null,
  baseColor: "#ffffff",
  baseColorFactor: Object.freeze([1, 1, 1, 1]),
  metallicFactor: 1,
  roughnessFactor: 1,
  doubleSided: false,
})

function lowerMaterial(material, index) {
  const label = `material ${index}`
  const pbr = material.pbrMetallicRoughness ?? {}
  const baseColorFactor = pbr.baseColorFactor ?? [1, 1, 1, 1]
  if (!Array.isArray(baseColorFactor) || baseColorFactor.length !== 4) fail(`${label} baseColorFactor must have 4 components`)
  baseColorFactor.forEach((value) => requireFactor(value, 0, `${label} baseColorFactor`))
  return Object.freeze({
    index,
    name: typeof material.name === "string" ? material.name : null,
    baseColor: linearToSrgbHex(baseColorFactor),
    baseColorFactor: Object.freeze([...baseColorFactor]),
    metallicFactor: requireFactor(pbr.metallicFactor, 1, `${label} metallicFactor`),
    roughnessFactor: requireFactor(pbr.roughnessFactor, 1, `${label} roughnessFactor`),
    doubleSided: material.doubleSided === true,
  })
}

function localMatrix(node, index) {
  const matrix = new THREE.Matrix4()
  if (node.matrix !== undefined) {
    if (!Array.isArray(node.matrix) || node.matrix.length !== 16) fail(`node ${index} matrix must have 16 values`)
    requireFinite(node.matrix, `node ${index} matrix`)
    return matrix.fromArray(node.matrix)
  }
  const translation = node.translation ?? [0, 0, 0]
  const rotation = node.rotation ?? [0, 0, 0, 1]
  const scale = node.scale ?? [1, 1, 1]
  for (const [name, value, length] of [["translation", translation, 3], ["rotation", rotation, 4], ["scale", scale, 3]]) {
    if (!Array.isArray(value) || value.length !== length) fail(`node ${index} ${name} must have ${length} values`)
    requireFinite(value, `node ${index} ${name}`)
  }
  requireNonZeroQuaternion(rotation, `node ${index} rotation`)
  return matrix.compose(
    new THREE.Vector3().fromArray(translation),
    new THREE.Quaternion().fromArray(rotation).normalize(),
    new THREE.Vector3().fromArray(scale),
  )
}

/** Same rule as the renderer's `validateTransform`: normalization must not invent a rotation. */
function requireNonZeroQuaternion(rotation, label) {
  const lengthSquared = rotation.reduce((sum, entry) => sum + entry * entry, 0)
  if (!Number.isFinite(lengthSquared) || lengthSquared <= Number.EPSILON) fail(`${label} must be a finite non-zero quaternion`)
}

/** Composed matrices can overflow even when every input is finite. */
function requireFiniteMatrix(matrix, label) {
  requireFinite(matrix.elements, label)
  return matrix
}

const freezeMatrix = (matrix) => Object.freeze(matrix.toArray())

/**
 * Validate and lower one self-contained static GLB into immutable renderer descriptors.
 *
 * @param {ArrayBuffer | ArrayBufferView} source
 * @param {{resourceKey?: string}} [options]
 */
export async function adaptStaticGlb(source, options = {}) {
  const bytes = toBytes(source)
  requireObject(options, "static GLB adapt options")
  if (options.resourceKey !== undefined && (typeof options.resourceKey !== "string" || options.resourceKey.trim() === "")) {
    fail("static GLB resourceKey must be a non-empty string")
  }
  const {json, binLength} = readGlbDocument(bytes)
  const {roots, ignoredExtensions} = preflight(json, binLength)
  // Computed in script: `crypto.subtle` is missing outside secure contexts (plain-http pages).
  const resourceKey = options.resourceKey ?? `glb-sha256:${sha256Hex(bytes)}`
  const {parser} = await decodeGltf(bytes, json)

  const materials = Object.freeze(list(json, "materials", "static GLB").map(lowerMaterial))
  const primitiveCache = new Map()
  const lowered = async (meshIndex, primitiveIndex) => {
    const key = `${meshIndex}/${primitiveIndex}`
    if (!primitiveCache.has(key)) {
      const primitive = json.meshes[meshIndex].primitives[primitiveIndex]
      primitiveCache.set(
        key,
        lowerPrimitive(parser, primitive, `${resourceKey}#mesh=${meshIndex}/primitive=${primitiveIndex}`, `mesh ${meshIndex} primitive ${primitiveIndex}`),
      )
    }
    return primitiveCache.get(key)
  }

  const nodes = []
  const drawables = []
  const assetMin = [Infinity, Infinity, Infinity]
  const assetMax = [-Infinity, -Infinity, -Infinity]
  const corner = new THREE.Vector3()
  const visit = async (index, parent, parentWorld) => {
    const node = json.nodes[index]
    const local = localMatrix(node, index)
    const world = requireFiniteMatrix(parentWorld.clone().multiply(local), `node ${index} asset-space matrix`)
    const children = list(node, "children", `node ${index}`)
    nodes.push(
      Object.freeze({
        index,
        name: typeof node.name === "string" ? node.name : null,
        parent,
        children: Object.freeze([...children]),
        localMatrix: freezeMatrix(local),
        worldMatrix: freezeMatrix(world),
        mesh: node.mesh ?? null,
      }),
    )
    if (node.mesh !== undefined) {
      const primitives = json.meshes[node.mesh].primitives
      for (let primitiveIndex = 0; primitiveIndex < primitives.length; primitiveIndex += 1) {
        const {geometry, bounds} = await lowered(node.mesh, primitiveIndex)
        const materialIndex = primitives[primitiveIndex].material
        for (let mask = 0; mask < 8; mask += 1) {
          corner
            .set(mask & 1 ? bounds.max[0] : bounds.min[0], mask & 2 ? bounds.max[1] : bounds.min[1], mask & 4 ? bounds.max[2] : bounds.min[2])
            .applyMatrix4(world)
          for (let axis = 0; axis < 3; axis += 1) {
            assetMin[axis] = Math.min(assetMin[axis], corner.getComponent(axis))
            assetMax[axis] = Math.max(assetMax[axis], corner.getComponent(axis))
          }
        }
        drawables.push(
          Object.freeze({
            id: `node=${index}/mesh=${node.mesh}/primitive=${primitiveIndex}`,
            node: index,
            mesh: node.mesh,
            primitive: primitiveIndex,
            material: materialIndex === undefined ? DEFAULT_MATERIAL : materials[materialIndex],
            matrix: freezeMatrix(world),
            geometry,
            bounds,
          }),
        )
      }
    }
    for (const child of children) await visit(child, index, world)
  }
  for (const root of roots) await visit(root, null, new THREE.Matrix4())
  if (drawables.length === 0) fail("static GLB default scene contains no mesh primitives")
  requireFinite([...assetMin, ...assetMax], "static GLB asset-space bounds")

  return Object.freeze({
    resourceKey,
    nodes: Object.freeze(nodes),
    materials,
    drawables: Object.freeze(drawables),
    bounds: freezeBounds(assetMin, assetMax),
    ignoredExtensions: Object.freeze(ignoredExtensions),
  })
}

const scratchInstance = new THREE.Matrix4()
const scratchDrawable = new THREE.Matrix4()

/**
 * Mirrors the renderer's `validateTransform` for `modelMatrix`/`RendererTransform` placements
 * (finite values, positive scale, non-zero quaternion) before composing, so the adapter never
 * renders a transform the renderer contract would reject.
 */
function placementMatrix(placement, label) {
  requireObject(placement, label)
  const matrix = new THREE.Matrix4()
  if (placement.modelMatrix !== undefined && placement.transform !== undefined) {
    fail(`${label} must provide at most one of modelMatrix or transform`)
  }
  if (placement.modelMatrix !== undefined) {
    if (!Array.isArray(placement.modelMatrix) || placement.modelMatrix.length !== 16) fail(`${label} modelMatrix must have 16 values`)
    requireFinite(placement.modelMatrix, `${label} modelMatrix`)
    return matrix.fromArray(placement.modelMatrix)
  }
  if (placement.transform !== undefined) {
    const {translation, rotationQuaternion = [0, 0, 0, 1], scale = [1, 1, 1]} = requireObject(placement.transform, `${label} transform`)
    for (const [value, length] of [[translation, 3], [rotationQuaternion, 4], [scale, 3]]) {
      if (!Array.isArray(value) || value.length !== length) fail(`${label} transform has a malformed component`)
      requireFinite(value, `${label} transform`)
    }
    if (scale.some((value) => value <= 0)) fail(`${label} transform scale values must be positive`)
    requireNonZeroQuaternion(rotationQuaternion, `${label} transform rotationQuaternion`)
    return matrix.compose(
      new THREE.Vector3().fromArray(translation),
      new THREE.Quaternion().fromArray(rotationQuaternion).normalize(),
      new THREE.Vector3().fromArray(scale),
    )
  }
  return matrix
}

function composedMatrix(instance, drawable, label) {
  return requireFiniteMatrix(scratchInstance.copy(instance).multiply(scratchDrawable.fromArray(drawable.matrix)), label).toArray()
}

function selectedDrawables(asset, filter) {
  if (!isObject(asset) || !Array.isArray(asset.drawables)) fail("static GLB asset must be the result of adaptStaticGlb")
  if (filter !== undefined && typeof filter !== "function") fail("static GLB filter must be a function")
  const drawables = filter === undefined ? asset.drawables : asset.drawables.filter(filter)
  if (drawables.length === 0) fail("static GLB selection contains no drawables")
  return drawables
}

/** Mirrors the renderer's node/batch appearance rules so bad options fail as StaticGlbContractError. */
function requireAppearance(options, label, {batch = false} = {}) {
  if (options.opacity !== undefined && (!Number.isFinite(options.opacity) || options.opacity < 0 || options.opacity > 1)) {
    fail(`${label} opacity must be between 0 and 1`)
  }
  for (const flag of ["wireframe", "visible"]) {
    if (options[flag] !== undefined && typeof options[flag] !== "boolean") fail(`${label} ${flag} must be a boolean`)
  }
  if (batch && options.revision !== undefined && (typeof options.revision !== "string" || options.revision.length === 0)) {
    fail(`${label} revision must be a non-empty string`)
  }
}

function requireId(id) {
  if (typeof id !== "string" || id.length === 0) fail("static GLB placement id must be a non-empty string")
}

/**
 * Scene nodes for one placement of an adapted asset: one node per selected drawable, sharing the
 * asset's immutable geometry descriptors and composing `modelMatrix`/`transform` with each node's
 * asset-space matrix.
 */
export function staticGlbSceneNodes(asset, placement) {
  requireId(placement?.id)
  const label = `static GLB placement ${placement.id}`
  requireAppearance(placement, label)
  const instance = placementMatrix(placement, label)
  return selectedDrawables(asset, placement.filter).map((drawable) => {
    const {material} = drawable
    const node = {
      id: `${placement.id}/${drawable.id}`,
      geometry: drawable.geometry,
      color: material.baseColor,
      modelMatrix: composedMatrix(instance, drawable, `${label} ${drawable.id} matrix`),
    }
    if (material.doubleSided) node.doubleSided = true
    if (placement.opacity !== undefined) node.opacity = placement.opacity
    if (placement.wireframe !== undefined) node.wireframe = placement.wireframe
    if (placement.visible !== undefined) node.visible = placement.visible
    return node
  })
}

/**
 * Instance batches for many placements of one adapted asset: one batch (one draw call) per
 * selected drawable, drawn with the same default lit material as the equivalent scene nodes.
 */
export function staticGlbInstanceBatches(asset, options) {
  requireId(options?.id)
  if (!Array.isArray(options.instances)) fail(`static GLB batch ${options.id} instances must be an array`)
  requireAppearance(options, `static GLB batch ${options.id}`, {batch: true})
  const label = (index) => `static GLB batch ${options.id}[${index}]`
  const instances = options.instances.map((instance, index) => placementMatrix(instance, label(index)))
  return selectedDrawables(asset, options.filter).map((drawable) => {
    const {material} = drawable
    const batch = {
      id: `${options.id}/${drawable.id}`,
      geometry: drawable.geometry,
      color: material.baseColor,
      instances: instances.map((instance, index) => ({
        modelMatrix: composedMatrix(instance, drawable, `${label(index)} ${drawable.id} matrix`),
      })),
    }
    if (material.doubleSided) batch.doubleSided = true
    if (options.revision !== undefined) batch.revision = options.revision
    if (options.opacity !== undefined) batch.opacity = options.opacity
    if (options.wireframe !== undefined) batch.wireframe = options.wireframe
    if (options.visible !== undefined) batch.visible = options.visible
    return batch
  })
}
