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

const array = (value) => (Array.isArray(value) ? value : [])

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
  if (typeof json.asset?.version !== "string" || !json.asset.version.startsWith("2.")) {
    fail("static GLB asset.version must be 2.x")
  }
  for (const name of array(json.extensionsRequired)) {
    if (!SUPPORTED_EXTENSIONS.has(name)) fail(`static GLB requires unsupported extension ${name}`)
  }
  const ignoredExtensions = array(json.extensionsUsed).filter((name) => !SUPPORTED_EXTENSIONS.has(name))

  const buffers = array(json.buffers)
  buffers.forEach((buffer, index) => {
    if (buffer.uri !== undefined) {
      fail(`static GLB buffer ${index} uses a URI; package a self-contained GLB with only the BIN chunk`)
    }
    if (index !== 0) fail("static GLB may declare only the BIN-chunk buffer")
    if (binLength === null || binLength < buffer.byteLength) {
      fail(`static GLB buffer 0 needs ${buffer.byteLength} bytes but the BIN chunk is missing or shorter`)
    }
  })
  const bufferViews = array(json.bufferViews)
  bufferViews.forEach((bufferView, index) => {
    requireIndex(bufferView.buffer, buffers.length, `bufferView ${index} buffer`)
    if ((bufferView.byteOffset ?? 0) + bufferView.byteLength > buffers[bufferView.buffer].byteLength) {
      fail(`bufferView ${index} exceeds its buffer`)
    }
  })
  const accessors = array(json.accessors)
  accessors.forEach((accessor, index) => {
    if (accessor.bufferView !== undefined) requireIndex(accessor.bufferView, bufferViews.length, `accessor ${index} bufferView`)
  })

  if (array(json.skins).length > 0) fail("static GLB declares skins; skinned assets are out of scope for the static adapter")
  if (array(json.animations).length > 0) fail("static GLB declares animations; animated assets are out of scope for the static adapter")

  const materials = array(json.materials)
  materials.forEach((material, index) => {
    for (const [group, slot] of MATERIAL_TEXTURES) {
      const owner = group === null ? material : material[group]
      if (owner?.[slot] !== undefined) fail(`material ${index} uses ${slot}; textured materials are not supported yet`)
    }
    if (material.alphaMode !== undefined && material.alphaMode !== "OPAQUE") {
      fail(`material ${index} alphaMode ${material.alphaMode} is unsupported; only OPAQUE is rendered`)
    }
    // Mirrors `three-d-formats`, which rejects any non-zero emissive factor: emissive semantics
    // belong to the Rust material model first, not to this adapter.
    const emissiveFactor = material.emissiveFactor ?? [0, 0, 0]
    if (!Array.isArray(emissiveFactor) || emissiveFactor.length !== 3) fail(`material ${index} emissiveFactor must have 3 components`)
    if (emissiveFactor.some((value) => value !== 0)) {
      fail(`material ${index} uses a non-zero emissiveFactor; emissive materials are not supported yet`)
    }
  })

  const meshes = array(json.meshes)
  meshes.forEach((mesh, meshIndex) => {
    if (array(mesh.primitives).length === 0) fail(`mesh ${meshIndex} has no primitives`)
    if (mesh.weights !== undefined) fail(`mesh ${meshIndex} declares morph weights; morph targets are unsupported`)
    mesh.primitives.forEach((primitive, primitiveIndex) => {
      const label = `mesh ${meshIndex} primitive ${primitiveIndex}`
      if ((primitive.mode ?? TRIANGLES) !== TRIANGLES) fail(`${label} mode ${primitive.mode} is unsupported; only triangles are rendered`)
      if (array(primitive.targets).length > 0) fail(`${label} declares morph targets; morph targets are unsupported`)
      const attributes = primitive.attributes ?? {}
      for (const [semantic, accessor] of Object.entries(attributes)) {
        if (!SUPPORTED_ATTRIBUTES.has(semantic)) fail(`${label} attribute ${semantic} is unsupported`)
        requireIndex(accessor, accessors.length, `${label} ${semantic} accessor`)
      }
      if (attributes.POSITION === undefined) fail(`${label} is missing POSITION`)
      if (attributes.NORMAL === undefined) fail(`${label} is missing NORMAL; generated flat normals are not supported`)
      if (primitive.indices !== undefined) requireIndex(primitive.indices, accessors.length, `${label} indices accessor`)
      if (primitive.material !== undefined) requireIndex(primitive.material, materials.length, `${label} material`)
    })
  })

  const nodes = array(json.nodes)
  const parents = new Array(nodes.length).fill(null)
  nodes.forEach((node, index) => {
    if (node.skin !== undefined) fail(`node ${index} references a skin; skinned assets are out of scope for the static adapter`)
    if (node.weights !== undefined) fail(`node ${index} declares morph weights; morph targets are unsupported`)
    if (node.mesh !== undefined) requireIndex(node.mesh, meshes.length, `node ${index} mesh`)
    const hasTrs = node.translation !== undefined || node.rotation !== undefined || node.scale !== undefined
    if (node.matrix !== undefined && hasTrs) fail(`node ${index} declares both matrix and TRS properties`)
    for (const child of array(node.children)) {
      requireIndex(child, nodes.length, `node ${index} child`)
      if (parents[child] !== null || child === index) fail(`node ${child} has more than one parent or is its own child`)
      parents[child] = index
    }
  })

  const scenes = array(json.scenes)
  if (scenes.length === 0) fail("static GLB declares no scene to instantiate")
  const sceneIndex = json.scene ?? 0
  requireIndex(sceneIndex, scenes.length, "static GLB default scene")
  const roots = array(scenes[sceneIndex].nodes)
  const seenRoots = new Set()
  for (const root of roots) {
    requireIndex(root, nodes.length, "scene root node")
    if (parents[root] !== null) fail(`scene root node ${root} is also a child of node ${parents[root]}`)
    if (seenRoots.has(root)) fail(`scene root node ${root} is listed more than once`)
    seenRoots.add(root)
  }
  return {roots, ignoredExtensions}
}

async function decodeGltf(bytes) {
  // Copy so the loader never observes caller-owned memory after this call.
  const buffer = bytes.slice().buffer
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
    requireFinite(linear, label)
    if (linear.some((value) => value < 0 || value > 1)) fail(`${label} components must be between 0 and 1`)
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
  const accessor = (index) => parser.getDependency("accessor", index)
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
  // TANGENT is accepted and validated for alignment but not carried: tangents only serve normal
  // maps, which this adapter rejects until a textured-material contract exists.
  await aligned("TANGENT", [4])

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
  const quaternion = new THREE.Quaternion().fromArray(rotation)
  if (quaternion.length() <= Number.EPSILON) fail(`node ${index} rotation must be non-zero`)
  return matrix.compose(new THREE.Vector3().fromArray(translation), quaternion.normalize(), new THREE.Vector3().fromArray(scale))
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
  if (options.resourceKey !== undefined && (typeof options.resourceKey !== "string" || options.resourceKey.trim() === "")) {
    fail("static GLB resourceKey must be a non-empty string")
  }
  const {json, binLength} = readGlbDocument(bytes)
  const {roots, ignoredExtensions} = preflight(json, binLength)
  // Computed in script: `crypto.subtle` is missing outside secure contexts (plain-http pages).
  const resourceKey = options.resourceKey ?? `glb-sha256:${sha256Hex(bytes)}`
  const {parser} = await decodeGltf(bytes)

  const materials = Object.freeze(array(json.materials).map(lowerMaterial))
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
    const world = parentWorld.clone().multiply(local)
    const children = array(node.children)
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

function placementMatrix(placement, label) {
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
    const {translation, rotationQuaternion = [0, 0, 0, 1], scale = [1, 1, 1]} = placement.transform ?? {}
    for (const [value, length] of [[translation, 3], [rotationQuaternion, 4], [scale, 3]]) {
      if (!Array.isArray(value) || value.length !== length) fail(`${label} transform has a malformed component`)
      requireFinite(value, `${label} transform`)
    }
    return matrix.compose(
      new THREE.Vector3().fromArray(translation),
      new THREE.Quaternion().fromArray(rotationQuaternion).normalize(),
      new THREE.Vector3().fromArray(scale),
    )
  }
  return matrix
}

function composedMatrix(instance, drawable) {
  return scratchInstance.copy(instance).multiply(scratchDrawable.fromArray(drawable.matrix)).toArray()
}

function selectedDrawables(asset, filter) {
  const drawables = filter === undefined ? asset.drawables : asset.drawables.filter(filter)
  if (drawables.length === 0) fail("static GLB selection contains no drawables")
  return drawables
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
  const instance = placementMatrix(placement, `static GLB placement ${placement.id}`)
  return selectedDrawables(asset, placement.filter).map((drawable) => {
    const {material} = drawable
    const node = {
      id: `${placement.id}/${drawable.id}`,
      geometry: drawable.geometry,
      color: material.baseColor,
      modelMatrix: composedMatrix(instance, drawable),
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
  const instances = options.instances.map((instance, index) => placementMatrix(instance, `static GLB batch ${options.id}[${index}]`))
  return selectedDrawables(asset, options.filter).map((drawable) => {
    const {material} = drawable
    const batch = {
      id: `${options.id}/${drawable.id}`,
      geometry: drawable.geometry,
      color: material.baseColor,
      instances: instances.map((instance) => ({modelMatrix: composedMatrix(instance, drawable)})),
    }
    if (material.doubleSided) batch.doubleSided = true
    if (options.revision !== undefined) batch.revision = options.revision
    if (options.opacity !== undefined) batch.opacity = options.opacity
    if (options.wireframe !== undefined) batch.wireframe = options.wireframe
    if (options.visible !== undefined) batch.visible = options.visible
    return batch
  })
}
