import * as THREE from "three"
import {
  compileFlipbookLayout,
  compileFlipbookPlayback,
  flipbookFrameRect,
  sampleFlipbook,
} from "./flipbook.js"

// Cosmetic baked-flipbook effects: camera-facing quads that play one atlas frame sequence.
// Effects are presentation only. The layer samples caller-supplied timing statelessly, so it holds
// no simulation state, and it releases every GPU resource of an atlas the frame no longer declares.

export const DEFAULT_MAX_EFFECT_INSTANCES = 64

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

function isColor(value) {
  return (
    (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff) ||
    (typeof value === "string" && COLOR_PATTERN.test(value))
  )
}

function isFiniteTuple(value, length) {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite)
}

/**
 * Validates `frame.effects`. `fail(message)` must throw. Returns nothing; the layer re-derives
 * compiled layouts and playback from the validated input.
 */
export function validateCosmeticEffects(effects, fail) {
  if (!effects || typeof effects !== "object" || Array.isArray(effects)) fail("render frame effects must be an object")
  if (!Number.isFinite(effects.time)) fail("effects time must be finite")
  if (effects.enabled !== undefined && typeof effects.enabled !== "boolean") fail("effects enabled must be a boolean")
  if (
    effects.maxInstances !== undefined &&
    (!Number.isSafeInteger(effects.maxInstances) || effects.maxInstances < 0)
  ) {
    fail("effects maxInstances must be a non-negative integer")
  }
  if (!Array.isArray(effects.atlases)) fail("effects atlases must be an array")
  if (!Array.isArray(effects.instances)) fail("effects instances must be an array")

  const atlasKeys = new Set()
  for (const atlas of effects.atlases) {
    if (!atlas || typeof atlas !== "object") fail("effect atlas must be an object")
    if (typeof atlas.resourceKey !== "string" || atlas.resourceKey.trim().length === 0) {
      fail("effect atlas resourceKey must be a non-empty string")
    }
    if (atlasKeys.has(atlas.resourceKey)) fail(`duplicate effect atlas resourceKey: ${atlas.resourceKey}`)
    atlasKeys.add(atlas.resourceKey)
    const label = `effect atlas ${atlas.resourceKey}`
    if (!Number.isSafeInteger(atlas.width) || atlas.width <= 0 || !Number.isSafeInteger(atlas.height) || atlas.height <= 0) {
      fail(`${label} width and height must be positive integers`)
    }
    if (
      !(atlas.pixels instanceof Uint8Array || atlas.pixels instanceof Uint8ClampedArray) ||
      atlas.pixels.length !== atlas.width * atlas.height * 4
    ) {
      fail(`${label} pixels must be RGBA bytes of length width * height * 4`)
    }
    if (atlas.filter !== undefined && atlas.filter !== "linear" && atlas.filter !== "nearest") {
      fail(`${label} filter must be "linear" or "nearest"`)
    }
    try {
      compileFlipbookLayout(atlas)
    } catch (error) {
      fail(`${label}: ${error.message}`)
    }
  }

  const ids = new Set()
  for (const effect of effects.instances) {
    if (!effect || typeof effect !== "object") fail("effect instance must be an object")
    if (typeof effect.id !== "string" || effect.id.length === 0) fail("effect id must be a non-empty string")
    if (ids.has(effect.id)) fail(`duplicate effect id: ${effect.id}`)
    ids.add(effect.id)
    const label = `effect ${effect.id}`
    if (!atlasKeys.has(effect.atlas)) fail(`${label} atlas must name a declared effects atlas`)
    if (effect.space !== "world") fail(`${label} space must be "world"`)
    if (!isFiniteTuple(effect.origin, 3)) fail(`${label} origin must contain exactly 3 finite numbers`)
    const scale = typeof effect.scale === "number" ? [effect.scale, effect.scale] : effect.scale
    if (!isFiniteTuple(scale, 2) || scale[0] <= 0 || scale[1] <= 0) {
      fail(`${label} scale must be a positive number or [width, height]`)
    }
    if (effect.color !== undefined && !isColor(effect.color)) fail(`${label} color must be a 24-bit integer or #RRGGBB string`)
    if (effect.opacity !== undefined && (!Number.isFinite(effect.opacity) || effect.opacity < 0 || effect.opacity > 1)) {
      fail(`${label} opacity must be between 0 and 1`)
    }
    try {
      compileFlipbookPlayback(effect)
    } catch (error) {
      fail(`${label}: ${error.message}`)
    }
  }
}

const VERTEX_DECLARATIONS = "attribute vec4 effectFrame;\nattribute float effectOpacity;\nvarying float vEffectOpacity;\n"

// Billboards in view space: the instance matrix carries only the origin and the quad scale, so the
// quad faces any camera without per-camera CPU work or buffer uploads.
function patchFlipbookShader(shader) {
  shader.vertexShader = VERTEX_DECLARATIONS + shader.vertexShader
    .replace(
      "#include <uv_vertex>",
      "#include <uv_vertex>\n#ifdef USE_MAP\n\tvMapUv = uv * effectFrame.zw + effectFrame.xy;\n#endif\n\tvEffectOpacity = effectOpacity;",
    )
    .replace(
      "#include <project_vertex>",
      [
        "vec4 mvPosition = modelViewMatrix * vec4( instanceMatrix[ 3 ].xyz, 1.0 );",
        "mvPosition.xy += position.xy * vec2( length( instanceMatrix[ 0 ].xyz ), length( instanceMatrix[ 1 ].xyz ) );",
        "gl_Position = projectionMatrix * mvPosition;",
      ].join("\n"),
    )
  shader.fragmentShader = "varying float vEffectOpacity;\n" + shader.fragmentShader.replace(
    "#include <alphamap_fragment>",
    "#include <alphamap_fragment>\n\tdiffuseColor.a *= vEffectOpacity;",
  )
}

function createAtlasTexture(atlas) {
  // Atlas pixels are given top row first like an image; WebGL data textures start at the bottom.
  const rowBytes = atlas.width * 4
  const data = new Uint8Array(atlas.pixels.length)
  for (let row = 0; row < atlas.height; row += 1) {
    const source = (atlas.height - 1 - row) * rowBytes
    data.set(atlas.pixels.subarray(source, source + rowBytes), row * rowBytes)
  }
  const texture = new THREE.DataTexture(data, atlas.width, atlas.height, THREE.RGBAFormat)
  texture.colorSpace = THREE.SRGBColorSpace
  const filter = atlas.filter === "nearest" ? THREE.NearestFilter : THREE.LinearFilter
  texture.magFilter = filter
  texture.minFilter = filter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}

function createAtlasState(atlas, capacity) {
  const texture = createAtlasTexture(atlas)
  const material = new THREE.MeshBasicMaterial({map: texture, transparent: true, depthWrite: false})
  material.onBeforeCompile = patchFlipbookShader
  material.customProgramCacheKey = () => "cosmetic-flipbook"
  const geometry = new THREE.PlaneGeometry(1, 1)
  const frameAttribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
  const opacityAttribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
  frameAttribute.setUsage(THREE.DynamicDrawUsage)
  opacityAttribute.setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute("effectFrame", frameAttribute)
  geometry.setAttribute("effectOpacity", opacityAttribute)
  const mesh = new THREE.InstancedMesh(geometry, material, capacity)
  mesh.matrixAutoUpdate = false
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.setColorAt(0, new THREE.Color(0xffffff))
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
  mesh.count = 0
  mesh.visible = false
  mesh.renderOrder = 1
  return {
    layout: compileFlipbookLayout(atlas),
    texture,
    material,
    geometry,
    mesh,
    frameAttribute,
    opacityAttribute,
    capacity,
    cursor: 0,
  }
}

function disposeAtlasState(scene, state) {
  scene.remove(state.mesh)
  state.mesh.dispose()
  state.geometry.dispose()
  state.material.dispose()
  state.texture.dispose()
}

/** Writes `value` into `array[offset]`, returning whether it changed. */
function store(array, offset, value) {
  const stored = Math.fround(value)
  if (array[offset] === stored) return false
  array[offset] = stored
  return true
}

function compareActive(a, b) {
  // Newest effects win the budget; ids break ties so the kept set is deterministic.
  if (a.effect.startTime !== b.effect.startTime) return b.effect.startTime - a.effect.startTime
  return a.effect.id < b.effect.id ? -1 : a.effect.id > b.effect.id ? 1 : 0
}

export function createEffectObservations() {
  return {
    effectActiveCount: 0,
    effectPendingCount: 0,
    effectExpiredCount: 0,
    effectDroppedCount: 0,
    effectBufferUploadCount: 0,
    effectAtlasCreateCount: 0,
    effectAtlasReuseCount: 0,
    effectAtlasDisposeCount: 0,
    liveEffectAtlasCount: 0,
  }
}

/**
 * Owns the Three.js resources for cosmetic flipbook effects in one scene: per declared atlas one
 * texture, material, quad geometry, and instanced mesh with fixed capacity `maxInstances`.
 */
export function createCosmeticEffectLayer(
  scene,
  {maxInstances = DEFAULT_MAX_EFFECT_INSTANCES, fail = (message) => { throw new RangeError(message) }} = {},
) {
  if (!Number.isSafeInteger(maxInstances) || maxInstances < 0) {
    fail("maxEffectInstances must be a non-negative integer")
  }
  const atlases = new Map()
  const scratchMatrix = new THREE.Matrix4()
  const scratchColor = new THREE.Color()
  const scratchPosition = new THREE.Vector3()
  const scratchScale = new THREE.Vector3()
  const identityRotation = new THREE.Quaternion()
  const rect = [0, 0, 0, 0]

  function release(liveKeys, observations) {
    for (const [key, state] of atlases) {
      if (liveKeys?.has(key)) continue
      disposeAtlasState(scene, state)
      atlases.delete(key)
      observations.effectAtlasDisposeCount += 1
    }
  }

  function writeSlot(state, slot, effect, sample) {
    let matrixChanged = false
    let colorChanged = false
    let frameChanged = false
    const scale = typeof effect.scale === "number" ? effect.scale : null
    scratchPosition.fromArray(effect.origin)
    scratchScale.set(scale ?? effect.scale[0], scale ?? effect.scale[1], 1)
    scratchMatrix.compose(scratchPosition, identityRotation, scratchScale)
    const matrixArray = state.mesh.instanceMatrix.array
    for (let index = 0; index < 16; index += 1) {
      matrixChanged = store(matrixArray, slot * 16 + index, scratchMatrix.elements[index]) || matrixChanged
    }
    scratchColor.set(effect.color ?? 0xffffff)
    const colorArray = state.mesh.instanceColor.array
    colorChanged = store(colorArray, slot * 3, scratchColor.r) || colorChanged
    colorChanged = store(colorArray, slot * 3 + 1, scratchColor.g) || colorChanged
    colorChanged = store(colorArray, slot * 3 + 2, scratchColor.b) || colorChanged
    flipbookFrameRect(state.layout, sample.frame, rect)
    const frameArray = state.frameAttribute.array
    for (let index = 0; index < 4; index += 1) {
      frameChanged = store(frameArray, slot * 4 + index, rect[index]) || frameChanged
    }
    const opacityChanged = store(state.opacityAttribute.array, slot, effect.opacity ?? 1)
    return {matrixChanged, colorChanged, frameChanged, opacityChanged}
  }

  return {
    /** Reconciles one validated `frame.effects` (or undefined) and records observations. */
    sync(effects, observations) {
      Object.assign(observations, createEffectObservations())
      if (!effects || effects.enabled === false) {
        release(null, observations)
        return
      }

      const liveKeys = new Set()
      for (const atlas of effects.atlases) {
        liveKeys.add(atlas.resourceKey)
        let state = atlases.get(atlas.resourceKey)
        if (state) {
          observations.effectAtlasReuseCount += 1
        } else {
          state = createAtlasState(atlas, maxInstances)
          atlases.set(atlas.resourceKey, state)
          scene.add(state.mesh)
          observations.effectAtlasCreateCount += 1
        }
        state.cursor = 0
        state.dirty = {matrix: false, color: false, frame: false, opacity: false}
      }
      release(liveKeys, observations)

      const active = []
      for (const effect of effects.instances) {
        const state = atlases.get(effect.atlas)
        const sample = sampleFlipbook(state.layout, compileFlipbookPlayback(effect), effects.time)
        if (sample.phase === "pending") observations.effectPendingCount += 1
        else if (sample.phase === "expired") observations.effectExpiredCount += 1
        else active.push({effect, sample, state})
      }
      const budget = Math.min(maxInstances, effects.maxInstances ?? maxInstances)
      if (active.length > budget) {
        active.sort(compareActive)
        observations.effectDroppedCount = active.length - budget
        active.length = budget
      }
      observations.effectActiveCount = active.length

      for (const {effect, sample, state} of active) {
        const changed = writeSlot(state, state.cursor, effect, sample)
        state.cursor += 1
        state.dirty.matrix ||= changed.matrixChanged
        state.dirty.color ||= changed.colorChanged
        state.dirty.frame ||= changed.frameChanged
        state.dirty.opacity ||= changed.opacityChanged
      }

      for (const state of atlases.values()) {
        const countChanged = state.mesh.count !== state.cursor
        state.mesh.count = state.cursor
        state.mesh.visible = state.cursor > 0
        const buffers = [
          [state.mesh.instanceMatrix, state.dirty.matrix],
          [state.mesh.instanceColor, state.dirty.color],
          [state.frameAttribute, state.dirty.frame],
          [state.opacityAttribute, state.dirty.opacity],
        ]
        for (const [attribute, dirty] of buffers) {
          if (!dirty) continue
          attribute.needsUpdate = true
          observations.effectBufferUploadCount += 1
        }
        // Conservative culling bounds: the unit quad's sphere covers every billboard orientation.
        if ((state.dirty.matrix || countChanged) && state.cursor > 0) state.mesh.computeBoundingSphere()
      }
      observations.liveEffectAtlasCount = atlases.size
    },

    /** Records live counts without per-frame work (used by camera-only redraws). */
    observe(observations) {
      Object.assign(observations, createEffectObservations())
      observations.liveEffectAtlasCount = atlases.size
    },

    /** Test/diagnostic view of live atlas state. */
    atlasState(resourceKey) {
      return atlases.get(resourceKey)
    },

    dispose() {
      for (const state of atlases.values()) disposeAtlasState(scene, state)
      atlases.clear()
    },
  }
}
