import * as THREE from "three"
import {webGpuProjectionToWebGl} from "./depth.js"
import {createSceneEnvironment} from "./environment.js"
import {createMaterial, instanceBatchMaterialNode, materialKey} from "./materials.js"
import {createIndexedMeshGeometry} from "./mesh-geometry.js"
import {projectWorldPointUnchecked} from "./projection.js"
import {attachInstanceBatchResult, syncInstanceBatch} from "./instance-batches.js"
import {createCosmeticEffectLayer} from "./cosmetic-effects.js"
import {
  failContract,
  requireFiniteMatrix,
  requireFiniteTuple,
  ThreeRendererContractError,
  validateFrame,
  validateRenderCamera,
} from "./frame-validation.js"
import {acquireResource, evictUnusedResources, recordLiveCacheCounts} from "./resources.js"

export {ThreeRendererContractError, validateRenderCamera, validateRenderFrame} from "./frame-validation.js"

const DEFAULT_BACKGROUND = 0x0c111a
const DEFAULT_PIXEL_RATIO_LIMIT = 2
const IDENTITY_QUATERNION = [0, 0, 0, 1]
const UNIT_SCALE = [1, 1, 1]

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

/** Composes one node or instance transform (modelMatrix or TRS) into `matrix`. */
function composeTransform(matrix, node, scratch) {
  if (node.modelMatrix !== undefined) {
    matrix.fromArray(node.modelMatrix)
    return
  }

  const translation = node.transform.translation
  const scale = node.transform.scale ?? UNIT_SCALE
  const rotation = node.transform.rotationQuaternion ?? IDENTITY_QUATERNION
  scratch.translation.fromArray(translation)
  scratch.scale.fromArray(scale)
  scratch.rotation.fromArray(rotation).normalize()
  matrix.compose(scratch.translation, scratch.rotation, scratch.scale)
}

function createWorkObservations(nodeVisitCount) {
  return {
    nodeVisitCount,
    instanceBatchCount: 0,
    instanceCount: 0,
    instanceUploadCount: 0,
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
    liveInstanceBatchCount: 0,
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
  const instanceBatches = new Map()
  const geometries = new Map()
  const materials = new Map()
  const liveCaches = {objects, instanceBatches, geometries, materials}
  const transformScratch = {
    translation: new THREE.Vector3(),
    rotation: new THREE.Quaternion(),
    scale: new THREE.Vector3(),
    matrix: new THREE.Matrix4(),
    color: new THREE.Color(),
  }
  const writeInstanceMatrix = (matrix, instance) => composeTransform(matrix, instance, transformScratch)
  // Reused per node and per batch so material lookup allocates no request object.
  const materialInput = {node: null, vertexColors: false}
  // Batches use the default lit material in white; their colors are uploaded as instance colors.
  const batchMaterialNode = {}
  const effectLayer = createCosmeticEffectLayer(scene, {maxInstances: options.maxEffectInstances, fail: failContract})
  const pixelRatioLimit = options.pixelRatioLimit ?? DEFAULT_PIXEL_RATIO_LIMIT
  let configuredWidth = null
  let configuredHeight = null
  let configuredPixelRatio = null

  const importedRoots = new Set()
  // Mesh payloads are validated when uploaded and instance data when its revision changes. Frames
  // that reuse them are checked by resource key and revision only.
  const uploaded = {
    hasMesh: (resourceKey) => geometries.has(`mesh:${resourceKey}`),
    hasBatch: (batch) => batch.revision !== undefined && instanceBatches.get(batch.id)?.revision === batch.revision,
  }

  function applyCamera(frameCamera) {
    camera.matrixWorldInverse.fromArray(frameCamera.viewMatrix)
    camera.matrixWorld.copy(camera.matrixWorldInverse).invert()
    camera.projectionMatrix.fromArray(webGpuProjectionToWebGl(frameCamera.projectionMatrix))
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
  }

  return {
    configureTextureLoader(loader) {
      loader.detectSupport(renderer)
    },
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
      recordLiveCacheCounts(observations, liveCaches)
      effectLayer.observe(observations)
      renderer.render(scene, camera)
      return observations
    },

    /** Present Rust-authoritative imported poses through the same scene/context. */
    renderImportedRoots({camera: frameCamera, roots}) {
      validateRenderCamera(frameCamera)
      if (!Array.isArray(roots) || roots.some(root => !root?.isObject3D)) failContract("imported roots must be Three objects")
      const current = new Set(roots)
      for (const root of importedRoots) if (!current.has(root)) { scene.remove(root); importedRoots.delete(root) }
      for (const root of roots) if (!importedRoots.has(root)) { scene.add(root); importedRoots.add(root) }
      applyCamera(frameCamera)
      renderer.render(scene, camera)
      return {importedInstances: roots.length}
    },

    render(frame) {
      validateFrame(frame, uploaded)
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
        composeTransform(mesh.matrix, node, transformScratch)
        mesh.matrixWorldNeedsUpdate = true
        mesh.visible = node.visible !== false
      }
      materialInput.node = null

      for (const [id, mesh] of objects) {
        if (liveObjectIds.has(id)) continue
        scene.remove(mesh)
        objects.delete(id)
        observations.objectRemoveCount += 1
      }

      const liveBatchIds = new Set()
      for (const batch of frame.instanceBatches ?? []) {
        liveBatchIds.add(batch.id)
        const nextGeometryKey = geometryKey(batch.geometry)
        const geometry = acquireResource(
          geometries,
          nextGeometryKey,
          createGeometry,
          batch.geometry,
          observations,
          "geometryCreateCount",
        )
        materialInput.node = instanceBatchMaterialNode(batch, batchMaterialNode)
        materialInput.vertexColors = geometry.hasAttribute("color")
        const nextMaterialKey = materialKey(materialInput)
        const material = acquireResource(
          materials,
          nextMaterialKey,
          createMaterial,
          materialInput,
          observations,
          "materialCreateCount",
        )
        liveGeometryKeys.add(nextGeometryKey)
        liveMaterialKeys.add(nextMaterialKey)

        const result = syncInstanceBatch(
          instanceBatches.get(batch.id),
          batch,
          geometry,
          material,
          writeInstanceMatrix,
          transformScratch,
        )
        attachInstanceBatchResult(scene, result, options.shadows === true, observations)
        instanceBatches.set(batch.id, result.state)
        observations.instanceBatchCount += 1
        observations.instanceCount += batch.instances.length
      }
      materialInput.node = null
      for (const [id, state] of instanceBatches) {
        if (liveBatchIds.has(id)) continue
        scene.remove(state.mesh)
        state.mesh.dispose()
        instanceBatches.delete(id)
        observations.objectRemoveCount += 1
      }

      // Each node and each instance batch acquires exactly one object, geometry, and material.
      const acquisitions = observations.nodeVisitCount + observations.instanceBatchCount
      observations.objectReuseCount = acquisitions - observations.objectCreateCount
      observations.geometryReuseCount = acquisitions - observations.geometryCreateCount
      observations.materialReuseCount = acquisitions - observations.materialCreateCount
      observations.geometryEvictCount = evictUnusedResources(geometries, liveGeometryKeys)
      observations.materialEvictCount = evictUnusedResources(materials, liveMaterialKeys)
      recordLiveCacheCounts(observations, liveCaches)
      effectLayer.sync(frame.effects, observations)

      renderer.render(scene, camera)
      return observations
    },

    dispose() {
      for (const geometry of geometries.values()) geometry.dispose()
      for (const material of materials.values()) material.dispose()
      for (const state of instanceBatches.values()) state.mesh.dispose()
      effectLayer.dispose()
      renderer.dispose()
      objects.clear()
      instanceBatches.clear()
      geometries.clear()
      materials.clear()
    },
  }
}
