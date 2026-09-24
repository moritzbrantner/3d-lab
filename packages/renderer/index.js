import * as THREE from "three"
import {webGpuProjectionToWebGl} from "./depth.js"
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

function requireColor(value) {
  const numeric = typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff
  const hex = typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)
  if (!numeric && !hex) {
    throw new ThreeRendererContractError("node color must be a 24-bit integer or #RRGGBB string")
  }
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
    requireColor(node.color)
    if (node.opacity !== undefined && (!Number.isFinite(node.opacity) || node.opacity < 0 || node.opacity > 1)) {
      throw new ThreeRendererContractError(`opacity for ${node.id} must be between 0 and 1`)
    }
  }

  return frame
}

export function projectWorldPoint(camera, point, viewport) {
  if (!camera || typeof camera !== "object") {
    throw new ThreeRendererContractError("projection camera is required")
  }
  requireFiniteMatrix("camera view matrix", camera.viewMatrix)
  requireFiniteMatrix("camera projection matrix", camera.projectionMatrix)
  requireFiniteTuple("world point", point, 3)
  if (!viewport || typeof viewport !== "object") {
    throw new ThreeRendererContractError("projection viewport is required")
  }
  const normalizedViewport = {
    x: viewport.x ?? 0,
    y: viewport.y ?? 0,
    width: viewport.width,
    height: viewport.height,
  }
  if (
    !Number.isFinite(normalizedViewport.x) ||
    !Number.isFinite(normalizedViewport.y) ||
    !Number.isFinite(normalizedViewport.width) ||
    !Number.isFinite(normalizedViewport.height) ||
    normalizedViewport.width <= 0 ||
    normalizedViewport.height <= 0
  ) {
    throw new ThreeRendererContractError("projection viewport must have finite positive width/height")
  }

  const projected = projectWorldPointUnchecked(camera, point, normalizedViewport)
  if (![projected.x, projected.y, projected.depth].every(Number.isFinite)) {
    throw new ThreeRendererContractError("world point projection must remain finite")
  }
  return projected
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
    case "mesh": {
      const meshGeometry = new THREE.BufferGeometry()
      meshGeometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(geometry.positions.flat(), 3),
      )
      meshGeometry.setIndex([...geometry.indices])
      if (geometry.normals !== undefined) {
        meshGeometry.setAttribute(
          "normal",
          new THREE.Float32BufferAttribute(geometry.normals.flat(), 3),
        )
      } else {
        meshGeometry.computeVertexNormals()
      }
      meshGeometry.computeBoundingSphere()
      return meshGeometry
    }
    default:
      throw new ThreeRendererContractError(`unsupported geometry kind: ${String(geometry.kind)}`)
  }
}

function materialKey(node) {
  return `${String(node.color)}:${node.opacity ?? 1}:${node.wireframe === true}`
}

function createMaterial(node) {
  const opacity = node.opacity ?? 1
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(node.color),
    opacity,
    transparent: opacity < 1,
    wireframe: node.wireframe === true,
    roughness: 0.86,
    metalness: 0.02,
  })
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
  scene.background = options.alpha === true ? null : new THREE.Color(options.background ?? DEFAULT_BACKGROUND)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334433, 1.7))
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.2)
  keyLight.position.set(10, 18, 8)
  keyLight.castShadow = options.shadows === true
  scene.add(keyLight)

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
     * Draw the already-submitted scene with a new camera without revisiting scene nodes.
     * The caller opts into this method only when object/geometry/material/transform state is unchanged.
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
        const nextMaterialKey = materialKey(node)
        const nextMaterial = acquireResource(
          materials,
          nextMaterialKey,
          createMaterial,
          node,
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
