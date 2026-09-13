import * as THREE from "three"

const DEFAULT_BACKGROUND = 0x0c111a
const DEFAULT_PIXEL_RATIO_LIMIT = 2

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

function requireFiniteTriple(name, value, {positive = false} = {}) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => !Number.isFinite(entry))) {
    throw new ThreeRendererContractError(`${name} must contain exactly three finite numbers`)
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

function validateGeometry(geometry) {
  if (!geometry || typeof geometry !== "object") {
    throw new ThreeRendererContractError("node geometry is required")
  }
  switch (geometry.kind) {
    case "box":
      requireFiniteTriple("box size", geometry.size, {positive: true})
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
    default:
      throw new ThreeRendererContractError(`unsupported geometry kind: ${String(geometry.kind)}`)
  }
}

export function validateRenderFrame(frame) {
  if (!frame || typeof frame !== "object") {
    throw new ThreeRendererContractError("render frame is required")
  }
  if (!frame.camera || typeof frame.camera !== "object") {
    throw new ThreeRendererContractError("render frame camera is required")
  }
  requireFiniteMatrix("camera view matrix", frame.camera.viewMatrix)
  requireFiniteMatrix("camera projection matrix", frame.camera.projectionMatrix)
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
    requireFiniteMatrix(`model matrix for ${node.id}`, node.modelMatrix)
    validateGeometry(node.geometry)
    requireColor(node.color)
    if (node.opacity !== undefined && (!Number.isFinite(node.opacity) || node.opacity < 0 || node.opacity > 1)) {
      throw new ThreeRendererContractError(`opacity for ${node.id} must be between 0 and 1`)
    }
  }

  return frame
}

function geometryKey(geometry) {
  switch (geometry.kind) {
    case "box":
      return `box:${geometry.size.join(",")}`
    case "sphere":
      return `sphere:${geometry.radius}`
    case "cylinder":
      return `cylinder:${geometry.radius}:${geometry.height}`
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
  const pixelRatioLimit = options.pixelRatioLimit ?? DEFAULT_PIXEL_RATIO_LIMIT

  function acquireGeometry(descriptor) {
    const key = geometryKey(descriptor)
    let geometry = geometries.get(key)
    if (!geometry) {
      geometry = createGeometry(descriptor)
      geometries.set(key, geometry)
    }
    return geometry
  }

  function acquireMaterial(node) {
    const key = materialKey(node)
    let material = materials.get(key)
    if (!material) {
      material = createMaterial(node)
      materials.set(key, material)
    }
    return material
  }

  function applyCamera(frameCamera) {
    camera.matrixWorldInverse.fromArray(frameCamera.viewMatrix)
    camera.matrixWorld.copy(camera.matrixWorldInverse).invert()
    camera.projectionMatrix.fromArray(frameCamera.projectionMatrix)
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
      renderer.setPixelRatio(Math.min(devicePixelRatio, pixelRatioLimit))
      renderer.setSize(width, height, false)
    },

    render(frame) {
      validateRenderFrame(frame)
      applyCamera(frame.camera)

      const live = new Set()
      for (const node of frame.nodes) {
        live.add(node.id)
        const nextGeometry = acquireGeometry(node.geometry)
        const nextMaterial = acquireMaterial(node)
        let mesh = objects.get(node.id)
        if (!mesh) {
          mesh = new THREE.Mesh(nextGeometry, nextMaterial)
          mesh.matrixAutoUpdate = false
          mesh.castShadow = options.shadows === true
          mesh.receiveShadow = options.shadows === true
          objects.set(node.id, mesh)
          scene.add(mesh)
        } else {
          mesh.geometry = nextGeometry
          mesh.material = nextMaterial
        }
        mesh.matrix.fromArray(node.modelMatrix)
        mesh.matrixWorldNeedsUpdate = true
        mesh.visible = node.visible !== false
      }

      for (const [id, mesh] of objects) {
        if (live.has(id)) continue
        scene.remove(mesh)
        objects.delete(id)
      }

      renderer.render(scene, camera)
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
