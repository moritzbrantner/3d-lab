import * as THREE from "three"
import {webGpuProjectionToWebGl} from "./depth.js"
import {createSceneEnvironment} from "./environment.js"
import {createMaterial, materialKey} from "./materials.js"
import {createIndexedMeshGeometry} from "./mesh-geometry.js"
import {projectWorldPointUnchecked} from "./projection.js"
import {acquireResource, evictUnusedResources} from "./resources.js"

const DEFAULT_BACKGROUND = 0x0c111a
const DEFAULT_PIXEL_RATIO_LIMIT = 2
const IDENTITY_QUATERNION = [0, 0, 0, 1]
const UNIT_SCALE = [1, 1, 1]

export class ThreeRendererContractError extends Error {
  constructor(message) {
    super(message)
    this.name = "ThreeRendererContractError"
  }
}

function requireFiniteMatrix(name, value) {
  if (!Array.isArray(value) || value.length !== 16 || value.some((entry) => !Number.isFinite(entry))) {
    throw new ThreeRendererContractError(`${name} must contain exactly 16 finite numbers`)
  }
}

function validateCamera(camera) {
  if (!camera || typeof camera !== "object") {
    throw new ThreeRendererContractError("render frame camera is required")
  }
  requireFiniteMatrix("camera view matrix", camera.viewMatrix)
  requireFiniteMatrix("camera projection matrix", camera.projectionMatrix)
}

export function validateRenderCamera(camera) {
  validateCamera(camera)
  return camera
}

function requireFiniteTuple(name, value, length, {positive = false} = {}) {
  if (!Array.isArray(value) || value.length !== length || value.some((entry) => !Number.isFinite(entry))) {
    throw new ThreeRendererContractError(`${name} must contain exactly ${length} finite numbers`)
  }
  if (positive && value.some((entry) => entry <= 0)) {
    throw new ThreeRendererContractError(`${name} values must be positive`)
  }
}

function requireColor(value, name = "node color") {
  const numeric = typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff
  const hex = typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)
  if (!numeric && !hex) {
    throw new ThreeRendererContractError(`${name} must be a 24-bit integer or #RRGGBB string`)
  }
}

function requireObject(name, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ThreeRendererContractError(`${name} must be an object`)
  }
}

function requireIntensity(name, value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new ThreeRendererContractError(`${name} must be finite and non-negative`)
  }
}

function validateEnvironment(environment) {
  requireObject("render frame environment", environment)
  if (environment.background !== undefined) {
    requireColor(environment.background, "environment background")
  }
  if (environment.sky !== undefined) {
    requireObject("environment sky", environment.sky)
    requireColor(environment.sky.skyColor, "environment sky skyColor")
    requireColor(environment.sky.groundColor, "environment sky groundColor")
    requireIntensity("environment sky intensity", environment.sky.intensity)
  }
  if (environment.sun !== undefined) {
    const sun = environment.sun
    requireObject("environment sun", sun)
    requireFiniteTuple("environment sun direction", sun.direction, 3)
    const length = Math.hypot(sun.direction[0], sun.direction[1], sun.direction[2])
    if (!Number.isFinite(length) || length <= Number.EPSILON) {
      throw new ThreeRendererContractError("environment sun direction must be non-zero")
    }
    requireColor(sun.color, "environment sun color")
    requireIntensity("environment sun intensity", sun.intensity)
  }
  if (environment.fog !== undefined && environment.fog !== null) {
    const fog = environment.fog
    requireObject("environment fog", fog)
    requireColor(fog.color, "environment fog color")
    if (!Number.isFinite(fog.near) || fog.near < 0 || !Number.isFinite(fog.far) || fog.far <= fog.near) {
      throw new ThreeRendererContractError("environment fog must satisfy 0 <= near < far with finite distances")
    }
  }
  if (environment.shadowFocus !== undefined) {
    requireFiniteTuple("environment shadowFocus", environment.shadowFocus, 3)
  }
  if (
    environment.shadowExtent !== undefined &&
    (!Number.isFinite(environment.shadowExtent) || environment.shadowExtent <= 0)
  ) {
    throw new ThreeRendererContractError("environment shadowExtent must be finite and positive")
  }
  if (
    environment.shadowCasterReach !== undefined &&
    (!Number.isFinite(environment.shadowCasterReach) || environment.shadowCasterReach < 0)
  ) {
    throw new ThreeRendererContractError("environment shadowCasterReach must be finite and non-negative")
  }
}

function validateNodeShading(node) {
  if (node.unlit !== undefined && typeof node.unlit !== "boolean") {
    throw new ThreeRendererContractError(`unlit for ${node.id} must be a boolean`)
  }
  if (node.emissive === undefined) return
  if (node.unlit === true) {
    throw new ThreeRendererContractError(`scene node ${node.id} cannot be both unlit and emissive`)
  }
  requireColor(node.emissive, `emissive color for ${node.id}`)
}

function validateIndexedMeshGeometry(geometry) {
  if (typeof geometry.resourceKey !== "string" || geometry.resourceKey.trim().length === 0) {
    throw new ThreeRendererContractError("mesh resourceKey must be a non-empty string")
  }
  if (!Array.isArray(geometry.positions) || geometry.positions.length === 0) {
    throw new ThreeRendererContractError("mesh positions must be a non-empty array")
  }
  for (const position of geometry.positions) {
    requireFiniteTuple("mesh position", position, 3)
  }
  if (
    !Array.isArray(geometry.indices) ||
    geometry.indices.length === 0 ||
    geometry.indices.length % 3 !== 0
  ) {
    throw new ThreeRendererContractError("mesh indices must be a non-empty triangle index array")
  }
  for (const index of geometry.indices) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= geometry.positions.length) {
      throw new ThreeRendererContractError(
        `mesh index ${String(index)} must reference an existing position`,
      )
    }
  }
  if (geometry.normals !== undefined) {
    if (!Array.isArray(geometry.normals) || geometry.normals.length !== geometry.positions.length) {
      throw new ThreeRendererContractError("mesh normals must align one-to-one with positions")
    }
    for (const normal of geometry.normals) {
      requireFiniteTuple("mesh normal", normal, 3)
    }
  }
  if (geometry.colors !== undefined) {
    if (!Array.isArray(geometry.colors) || geometry.colors.length !== geometry.positions.length) {
      throw new ThreeRendererContractError("mesh colors must align one-to-one with positions")
    }
    for (const color of geometry.colors) {
      requireFiniteTuple("mesh color", color, 3)
      if (color[0] < 0 || color[0] > 1 || color[1] < 0 || color[1] > 1 || color[2] < 0 || color[2] > 1) {
        throw new ThreeRendererContractError("mesh color components must be between 0 and 1")
      }
    }
  }
}

function validateGeometry(geometry) {
  if (!geometry || typeof geometry !== "object") {
    throw new ThreeRendererContractError("node geometry is required")
  }
  switch (geometry.kind) {
    case "box":
      requireFiniteTuple("box size", geometry.size, 3, {positive: true})
      return
    case "sphere":
      if (!Number.isFinite(geometry.radius) || geometry.radius <= 0) {
        throw new ThreeRendererContractError("sphere radius must be finite and positive")
      }
      return
    case "cylinder":
      for (const [name, value] of [
        ["cylinder radius", geometry.radius],
        ["cylinder height", geometry.height],
      ]) {
        if (!Number.isFinite(value) || value <= 0) {
          throw new ThreeRendererContractError(`${name} must be finite and positive`)
        }
      }
      return
    case "mesh":
      validateIndexedMeshGeometry(geometry)
      return
    default:
      throw new ThreeRendererContractError(`unsupported geometry kind: ${String(geometry.kind)}`)
  }
}

function validateTransform(node) {
  const hasMatrix = node.modelMatrix !== undefined
  const hasTransform = node.transform !== undefined
  if (hasMatrix === hasTransform) {
    throw new ThreeRendererContractError(
      `scene node ${node.id} must provide exactly one of modelMatrix or transform`,
    )
  }
  if (hasMatrix) {
    requireFiniteMatrix(`model matrix for ${node.id}`, node.modelMatrix)
    return
  }

  if (!node.transform || typeof node.transform !== "object") {
    throw new ThreeRendererContractError(`transform for ${node.id} must be an object`)
  }
  requireFiniteTuple(`translation for ${node.id}`, node.transform.translation, 3)
  if (node.transform.scale !== undefined) {
    requireFiniteTuple(`scale for ${node.id}`, node.transform.scale, 3, {positive: true})
  }
  if (node.transform.rotationQuaternion !== undefined) {
    requireFiniteTuple(`rotation quaternion for ${node.id}`, node.transform.rotationQuaternion, 4)
    const lengthSquared = node.transform.rotationQuaternion.reduce((sum, entry) => sum + entry * entry, 0)
    if (!Number.isFinite(lengthSquared) || lengthSquared <= Number.EPSILON) {
      throw new ThreeRendererContractError(`rotation quaternion for ${node.id} must be non-zero`)
    }
  }
}

export function validateRenderFrame(frame) {
  if (!frame || typeof frame !== "object") {
    throw new ThreeRendererContractError("render frame is required")
  }
  validateRenderCamera(frame.camera)
  if (frame.environment !== undefined) validateEnvironment(frame.environment)
  if (!Array.isArray(frame.nodes)) {
    throw new ThreeRendererContractError("render frame nodes must be an array")
  }

  const ids = new Set()
  for (const node of frame.nodes) {
    if (!node || typeof node !== "object") {
      throw new ThreeRendererContractError("scene node must be an object")
    }
    if (typeof node.id !== "string" || node.id.length === 0) {
      throw new ThreeRendererContractError("scene node id must be a non-empty string")
    }
    if (ids.has(node.id)) {
      throw new ThreeRendererContractError(`duplicate scene node id: ${node.id}`)
    }
    ids.add(node.id)
    validateTransform(node)
    validateGeometry(node.geometry)
    validateNodeShading(node)
    requireColor(node.color)
    if (node.opacity !== undefined && (!Number.isFinite(node.opacity) || node.opacity < 0 || node.opacity > 1)) {
      throw new ThreeRendererContractError(`opacity for ${node.id} must be between 0 and 1`)
    }
  }

  return frame
}

function requireProjectionCamera(camera) {
  if (!camera || typeof camera !== "object") {
    throw new ThreeRendererContractError("projection camera is required")
  }
  requireFiniteMatrix("camera view matrix", camera.viewMatrix)
  requireFiniteMatrix("camera projection matrix", camera.projectionMatrix)
}

function normalizeProjectionViewport(viewport) {
  if (!viewport || typeof viewport !== "object") {
    throw new ThreeRendererContractError("projection viewport is required")
  }
  const normalized = {
    x: viewport.x ?? 0,
    y: viewport.y ?? 0,
    width: viewport.width,
    height: viewport.height,
  }
  if (
    !Number.isFinite(normalized.x) ||
    !Number.isFinite(normalized.y) ||
    !Number.isFinite(normalized.width) ||
    !Number.isFinite(normalized.height) ||
    normalized.width <= 0 ||
    normalized.height <= 0
  ) {
    throw new ThreeRendererContractError("projection viewport must have finite positive width/height")
  }
  return normalized
}

function projectValidatedWorldPoint(camera, point, viewport) {
  requireFiniteTuple("world point", point, 3)
  const projected = projectWorldPointUnchecked(camera, point, viewport)
  if (![projected.x, projected.y, projected.depth].every(Number.isFinite)) {
    throw new ThreeRendererContractError("world point projection must remain finite")
  }
  return projected
}

export function createWorldProjector(camera, viewport) {
  requireProjectionCamera(camera)
  const normalizedViewport = normalizeProjectionViewport(viewport)
  return (point) => projectValidatedWorldPoint(camera, point, normalizedViewport)
}

export function projectWorldPoint(camera, point, viewport) {
  requireProjectionCamera(camera)
  return projectValidatedWorldPoint(camera, point, normalizeProjectionViewport(viewport))
}

function geometryKey(geometry) {
  switch (geometry.kind) {
    case "box":
      return `box:${geometry.size.join(",")}`
    case "sphere":
      return `sphere:${geometry.radius}`
    case "cylinder":
      return `cylinder:${geometry.radius}:${geometry.height}`
    case "mesh":
      return `mesh:${geometry.resourceKey}`
    default:
      throw new ThreeRendererContractError(`unsupported geometry kind: ${String(geometry.kind)}`)
  }
}

function createGeometry(geometry) {
  switch (geometry.kind) {
    case "box":
      return new THREE.BoxGeometry(...geometry.size)
    case "sphere":
      return new THREE.SphereGeometry(geometry.radius, 20, 12)
    case "cylinder":
      return new THREE.CylinderGeometry(geometry.radius, geometry.radius, geometry.height, 20)
    case "mesh":
      return createIndexedMeshGeometry(geometry)
    default:
      throw new ThreeRendererContractError(`unsupported geometry kind: ${String(geometry.kind)}`)
  }
}

function applyNodeTransform(mesh, node, scratch) {
  if (node.modelMatrix !== undefined) {
    mesh.matrix.fromArray(node.modelMatrix)
    return
  }

  const translation = node.transform.translation
  const scale = node.transform.scale ?? UNIT_SCALE
  const rotation = node.transform.rotationQuaternion ?? IDENTITY_QUATERNION
  scratch.translation.fromArray(translation)
  scratch.scale.fromArray(scale)
  scratch.rotation.fromArray(rotation).normalize()
  mesh.matrix.compose(scratch.translation, scratch.rotation, scratch.scale)
}

function createWorkObservations(nodeVisitCount) {
  return {
    nodeVisitCount,
    objectCreateCount: 0,
    objectReuseCount: 0,
    objectRemoveCount: 0,
    geometryCreateCount: 0,
    geometryReuseCount: 0,
    geometryEvictCount: 0,
    materialCreateCount: 0,
    materialReuseCount: 0,
    materialEvictCount: 0,
    environmentUpdateCount: 0,
    liveObjectCount: 0,
    liveGeometryCount: 0,
    liveMaterialCount: 0,
  }
}

export function createThreeSceneRenderer(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== "function") {
    throw new ThreeRendererContractError("renderer requires a canvas-like target")
  }

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: options.antialias !== false,
    alpha: options.alpha === true,
  })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = options.shadows === true

  const scene = new THREE.Scene()
  const sceneEnvironment = createSceneEnvironment(scene, {
    background: options.alpha === true ? null : options.background ?? DEFAULT_BACKGROUND,
    shadows: options.shadows === true,
  })

  const camera = new THREE.Camera()
  camera.matrixAutoUpdate = false
  const objects = new Map()
  const geometries = new Map()
  const materials = new Map()
  const transformScratch = {
    translation: new THREE.Vector3(),
    rotation: new THREE.Quaternion(),
    scale: new THREE.Vector3(),
  }
  // Reused per node so material lookup allocates no request object.
  const materialInput = {node: null, vertexColors: false}
  const pixelRatioLimit = options.pixelRatioLimit ?? DEFAULT_PIXEL_RATIO_LIMIT
  let configuredWidth = null
  let configuredHeight = null
  let configuredPixelRatio = null

  function applyCamera(frameCamera) {
    camera.matrixWorldInverse.fromArray(frameCamera.viewMatrix)
    camera.matrixWorld.copy(camera.matrixWorldInverse).invert()
    camera.projectionMatrix.fromArray(webGpuProjectionToWebGl(frameCamera.projectionMatrix))
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
  }

  return {
    setSize(width, height, devicePixelRatio = 1) {
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new ThreeRendererContractError("renderer size must be finite and positive")
      }
      if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
        throw new ThreeRendererContractError("device pixel ratio must be finite and positive")
      }

      const pixelRatio = Math.min(devicePixelRatio, pixelRatioLimit)
      const pixelRatioChanged = pixelRatio !== configuredPixelRatio
      const sizeChanged = width !== configuredWidth || height !== configuredHeight
      if (!pixelRatioChanged && !sizeChanged) return

      if (pixelRatioChanged) renderer.setPixelRatio(pixelRatio)
      if (sizeChanged) renderer.setSize(width, height, false)
      configuredWidth = width
      configuredHeight = height
      configuredPixelRatio = pixelRatio
    },

    /**
     * Draw the already-submitted scene with a new camera without revisiting scene nodes or the
     * environment. The caller opts into this method only when object/geometry/material/transform
     * state and the frame environment are unchanged.
     */
    renderCamera(frameCamera) {
      validateRenderCamera(frameCamera)
      applyCamera(frameCamera)

      const observations = createWorkObservations(0)
      observations.liveObjectCount = objects.size
      observations.liveGeometryCount = geometries.size
      observations.liveMaterialCount = materials.size
      renderer.render(scene, camera)
      return observations
    },

    render(frame) {
      validateRenderFrame(frame)
      applyCamera(frame.camera)

      const observations = createWorkObservations(frame.nodes.length)
      observations.environmentUpdateCount = sceneEnvironment.apply(frame.environment)
      const liveObjectIds = new Set()
      const liveGeometryKeys = new Set()
      const liveMaterialKeys = new Set()
      for (const node of frame.nodes) {
        liveObjectIds.add(node.id)
        const nextGeometryKey = geometryKey(node.geometry)
        const nextGeometry = acquireResource(
          geometries,
          nextGeometryKey,
          createGeometry,
          node.geometry,
          observations,
          "geometryCreateCount",
        )
        // The material follows the geometry actually bound to the mesh, so both always agree on
        // the color attribute even when a resourceKey is reused with a different payload.
        materialInput.node = node
        materialInput.vertexColors = nextGeometry.hasAttribute("color")
        const nextMaterialKey = materialKey(materialInput)
        const nextMaterial = acquireResource(
          materials,
          nextMaterialKey,
          createMaterial,
          materialInput,
          observations,
          "materialCreateCount",
        )
        liveGeometryKeys.add(nextGeometryKey)
        liveMaterialKeys.add(nextMaterialKey)

        let mesh = objects.get(node.id)
        if (!mesh) {
          mesh = new THREE.Mesh(nextGeometry, nextMaterial)
          mesh.matrixAutoUpdate = false
          mesh.castShadow = options.shadows === true
          mesh.receiveShadow = options.shadows === true
          objects.set(node.id, mesh)
          scene.add(mesh)
          observations.objectCreateCount += 1
        } else {
          mesh.geometry = nextGeometry
          mesh.material = nextMaterial
        }
        applyNodeTransform(mesh, node, transformScratch)
        mesh.matrixWorldNeedsUpdate = true
        mesh.visible = node.visible !== false
      }
      materialInput.node = null

      observations.objectReuseCount = observations.nodeVisitCount - observations.objectCreateCount
      observations.geometryReuseCount = observations.nodeVisitCount - observations.geometryCreateCount
      observations.materialReuseCount = observations.nodeVisitCount - observations.materialCreateCount

      for (const [id, mesh] of objects) {
        if (liveObjectIds.has(id)) continue
        scene.remove(mesh)
        objects.delete(id)
        observations.objectRemoveCount += 1
      }
      observations.geometryEvictCount = evictUnusedResources(geometries, liveGeometryKeys)
      observations.materialEvictCount = evictUnusedResources(materials, liveMaterialKeys)
      observations.liveObjectCount = objects.size
      observations.liveGeometryCount = geometries.size
      observations.liveMaterialCount = materials.size

      renderer.render(scene, camera)
      return observations
    },

    dispose() {
      for (const geometry of geometries.values()) geometry.dispose()
      for (const material of materials.values()) material.dispose()
      renderer.dispose()
      objects.clear()
      geometries.clear()
      materials.clear()
    },
  }
}
