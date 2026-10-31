import {validateCosmeticEffects} from "./cosmetic-effects.js"

export class ThreeRendererContractError extends Error {
  constructor(message) {
    super(message)
    this.name = "ThreeRendererContractError"
  }
}

export function failContract(message) {
  throw new ThreeRendererContractError(message)
}

export function requireFiniteMatrix(name, value) {
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

export function requireFiniteTuple(name, value, length, {positive = false} = {}) {
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
  if (geometry.uvs !== undefined) {
    if (!Array.isArray(geometry.uvs) || geometry.uvs.length !== geometry.positions.length) {
      throw new ThreeRendererContractError("mesh uvs must align one-to-one with positions")
    }
    for (const uv of geometry.uvs) {
      requireFiniteTuple("mesh uv", uv, 2)
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

function validateGeometry(geometry, uploaded) {
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
      if (typeof geometry.resourceKey !== "string" || geometry.resourceKey.trim().length === 0) {
        throw new ThreeRendererContractError("mesh resourceKey must be a non-empty string")
      }
      if (!uploaded.hasMesh(geometry.resourceKey)) validateIndexedMeshGeometry(geometry)
      return
    default:
      throw new ThreeRendererContractError(`unsupported geometry kind: ${String(geometry.kind)}`)
  }
}

function validateTransform(node, label = node.id) {
  const hasMatrix = node.modelMatrix !== undefined
  const hasTransform = node.transform !== undefined
  if (hasMatrix === hasTransform) {
    throw new ThreeRendererContractError(
      `scene node ${label} must provide exactly one of modelMatrix or transform`,
    )
  }
  if (hasMatrix) {
    requireFiniteMatrix(`model matrix for ${label}`, node.modelMatrix)
    return
  }

  if (!node.transform || typeof node.transform !== "object") {
    throw new ThreeRendererContractError(`transform for ${label} must be an object`)
  }
  requireFiniteTuple(`translation for ${label}`, node.transform.translation, 3)
  if (node.transform.scale !== undefined) {
    requireFiniteTuple(`scale for ${label}`, node.transform.scale, 3, {positive: true})
  }
  if (node.transform.rotationQuaternion !== undefined) {
    requireFiniteTuple(`rotation quaternion for ${label}`, node.transform.rotationQuaternion, 4)
    const lengthSquared = node.transform.rotationQuaternion.reduce((sum, entry) => sum + entry * entry, 0)
    if (!Number.isFinite(lengthSquared) || lengthSquared <= Number.EPSILON) {
      throw new ThreeRendererContractError(`rotation quaternion for ${label} must be non-zero`)
    }
  }
}

const NOTHING_UPLOADED = Object.freeze({hasMesh: () => false, hasBatch: () => false})

/** Validate every part of a frame, including every mesh vertex and every batch instance. */
export function validateRenderFrame(frame) {
  return validateFrame(frame, NOTHING_UPLOADED)
}

/**
 * Validate a frame against the payloads a renderer already holds. A mesh whose `resourceKey` is
 * uploaded (`uploaded.hasMesh(key)`) is checked by key only. An instance batch whose revision
 * matches the uploaded one (`uploaded.hasBatch(batch)`) skips its per-instance checks. Each payload
 * is thus validated once, when it is uploaded, and per-frame work does not grow with static vertex
 * or instance counts.
 */
export function validateFrame(frame, uploaded) {
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
    validateGeometry(node.geometry, uploaded)
    validateNodeShading(node)
    requireColor(node.color)
    requireOpacity(node)
    requireDoubleSided(node)
  }

  if (frame.instanceBatches !== undefined) validateInstanceBatches(frame.instanceBatches, uploaded)
  if (frame.effects !== undefined) validateCosmeticEffects(frame.effects, failContract)

  return frame
}

function requireDoubleSided(entry) {
  if (entry.doubleSided !== undefined && typeof entry.doubleSided !== "boolean") {
    throw new ThreeRendererContractError(`doubleSided for ${entry.id} must be a boolean`)
  }
}

function requireOpacity(entry) {
  if (entry.opacity !== undefined && (!Number.isFinite(entry.opacity) || entry.opacity < 0 || entry.opacity > 1)) {
    throw new ThreeRendererContractError(`opacity for ${entry.id} must be between 0 and 1`)
  }
}

function validateInstanceBatches(batches, uploaded) {
  if (!Array.isArray(batches)) {
    throw new ThreeRendererContractError("render frame instanceBatches must be an array")
  }
  const ids = new Set()
  for (const batch of batches) {
    if (!batch || typeof batch !== "object") {
      throw new ThreeRendererContractError("instance batch must be an object")
    }
    if (typeof batch.id !== "string" || batch.id.length === 0) {
      throw new ThreeRendererContractError("instance batch id must be a non-empty string")
    }
    if (ids.has(batch.id)) {
      throw new ThreeRendererContractError(`duplicate instance batch id: ${batch.id}`)
    }
    ids.add(batch.id)
    if (batch.revision !== undefined && (typeof batch.revision !== "string" || batch.revision.length === 0)) {
      throw new ThreeRendererContractError(`revision for instance batch ${batch.id} must be a non-empty string`)
    }
    validateGeometry(batch.geometry, uploaded)
    requireColor(batch.color)
    requireOpacity(batch)
    requireDoubleSided(batch)
    if (!Array.isArray(batch.instances)) {
      throw new ThreeRendererContractError(`instances for batch ${batch.id} must be an array`)
    }
    if (uploaded.hasBatch(batch)) continue
    for (let index = 0; index < batch.instances.length; index += 1) {
      const instance = batch.instances[index]
      const label = `${batch.id}[${index}]`
      if (!instance || typeof instance !== "object") {
        throw new ThreeRendererContractError(`instance ${label} must be an object`)
      }
      validateTransform(instance, label)
      if (instance.color !== undefined) requireColor(instance.color)
    }
  }
}
