import * as THREE from "three"

// The pre-environment renderer defaults. An omitted environment (or omitted field) must keep
// producing exactly this scene state.
export const DEFAULT_SKY = Object.freeze({skyColor: 0xffffff, groundColor: 0x334433, intensity: 1.7})
export const DEFAULT_SUN = Object.freeze({
  direction: Object.freeze([10, 18, 8]),
  color: 0xffffff,
  intensity: 2.2,
})
// Three.js DirectionalLightShadow's default orthographic camera: +/-5 across, near 0.5, far 500.
export const DEFAULT_SHADOW_EXTENT = 5
export const SHADOW_NEAR = 0.5
export const MIN_SHADOW_FAR = 500
export const DEFAULT_SUN_DISTANCE = Math.hypot(...DEFAULT_SUN.direction)
const ORIGIN = Object.freeze([0, 0, 0])
const NO_ENVIRONMENT = Object.freeze({})

function sameTuple(current, next) {
  return current[0] === next[0] && current[1] === next[1] && current[2] === next[2]
}

function copyTuple(target, source) {
  target[0] = source[0]
  target[1] = source[1]
  target[2] = source[2]
}

/**
 * Own the renderer's background, hemisphere light, sun, fog, and sun shadow frame.
 *
 * `apply` takes an already-validated `RendererEnvironment` (or `undefined`) and rewrites only the
 * Three.js state whose inputs differ from the previous frame. It reuses one light, fog, and color
 * object for the renderer lifetime and allocates nothing when the environment is unchanged.
 */
export function createSceneEnvironment(scene, {background = null, shadows = false} = {}) {
  const hemisphere = new THREE.HemisphereLight(
    DEFAULT_SKY.skyColor,
    DEFAULT_SKY.groundColor,
    DEFAULT_SKY.intensity,
  )
  scene.add(hemisphere)
  const sun = new THREE.DirectionalLight(DEFAULT_SUN.color, DEFAULT_SUN.intensity)
  sun.position.set(...DEFAULT_SUN.direction)
  sun.castShadow = shadows
  scene.add(sun)
  const backgroundColor = new THREE.Color()
  const fog = new THREE.Fog(0xffffff)

  const defaultBackground = background
  const applied = {
    background: undefined,
    skyColor: DEFAULT_SKY.skyColor,
    groundColor: DEFAULT_SKY.groundColor,
    sunColor: DEFAULT_SUN.color,
    sunDirection: [...DEFAULT_SUN.direction],
    shadowFocus: [...ORIGIN],
    shadowExtent: DEFAULT_SHADOW_EXTENT,
    shadowCasterReach: DEFAULT_SHADOW_EXTENT,
    fogEnabled: false,
    fogColor: undefined,
  }
  applyBackground(defaultBackground)

  function applyBackground(value) {
    if (value === applied.background) return false
    applied.background = value
    if (value === null) {
      scene.background = null
    } else {
      backgroundColor.set(value)
      scene.background = backgroundColor
    }
    return true
  }

  function applySky(sky) {
    let changed = false
    if (sky.skyColor !== applied.skyColor) {
      hemisphere.color.set(sky.skyColor)
      applied.skyColor = sky.skyColor
      changed = true
    }
    if (sky.groundColor !== applied.groundColor) {
      hemisphere.groundColor.set(sky.groundColor)
      applied.groundColor = sky.groundColor
      changed = true
    }
    if (sky.intensity !== hemisphere.intensity) {
      hemisphere.intensity = sky.intensity
      changed = true
    }
    return changed
  }

  function applySunLight(value) {
    let changed = false
    if (value.color !== applied.sunColor) {
      sun.color.set(value.color)
      applied.sunColor = value.color
      changed = true
    }
    if (value.intensity !== sun.intensity) {
      sun.intensity = value.intensity
      changed = true
    }
    return changed
  }

  function applySunPlacement(direction, focus, extent, casterReach) {
    const frameChanged = extent !== applied.shadowExtent || casterReach !== applied.shadowCasterReach
    if (!frameChanged && sameTuple(applied.sunDirection, direction) && sameTuple(applied.shadowFocus, focus)) {
      return false
    }
    copyTuple(applied.sunDirection, direction)
    copyTuple(applied.shadowFocus, focus)
    applied.shadowExtent = extent
    applied.shadowCasterReach = casterReach

    // The sun sits on the ray from the focus toward the sun, far enough back that the shadow
    // camera's near plane lies `casterReach` beyond the region's sun-facing edge: occluders that
    // close to the region along the sun direction still reach the shadow map. The default
    // direction's own length is the minimum distance, so the default placement (extent 5, reach
    // 5) is exactly (10, 18, 8).
    const distance = Math.max(DEFAULT_SUN_DISTANCE, extent + casterReach + SHADOW_NEAR)
    const scale = distance / Math.hypot(direction[0], direction[1], direction[2])
    sun.position.set(
      focus[0] + direction[0] * scale,
      focus[1] + direction[1] * scale,
      focus[2] + direction[2] * scale,
    )
    sun.target.position.set(focus[0], focus[1], focus[2])
    // The target is not part of the scene graph, so Three.js does not update its world matrix.
    sun.target.updateMatrixWorld()

    if (frameChanged) {
      // The orthographic shadow camera spans +/-extent across the light axis and covers from
      // just in front of the sun to beyond the far side of the focus sphere.
      const shadowCamera = sun.shadow.camera
      shadowCamera.left = -extent
      shadowCamera.right = extent
      shadowCamera.top = extent
      shadowCamera.bottom = -extent
      shadowCamera.near = SHADOW_NEAR
      shadowCamera.far = Math.max(MIN_SHADOW_FAR, distance + 2 * extent)
      shadowCamera.updateProjectionMatrix()
    }
    return true
  }

  function applyFog(value) {
    if (value === null) {
      if (!applied.fogEnabled) return false
      applied.fogEnabled = false
      scene.fog = null
      return true
    }
    let changed = false
    if (value.color !== applied.fogColor) {
      fog.color.set(value.color)
      applied.fogColor = value.color
      changed = true
    }
    if (value.near !== fog.near) {
      fog.near = value.near
      changed = true
    }
    if (value.far !== fog.far) {
      fog.far = value.far
      changed = true
    }
    if (!applied.fogEnabled) {
      applied.fogEnabled = true
      scene.fog = fog
      changed = true
    }
    return changed
  }

  return {
    hemisphere,
    sun,
    fog,
    /**
     * Apply one frame's environment. Omitted fields fall back to the renderer defaults.
     * Returns how many of the five environment components (background, sky light, sun light,
     * sun placement/shadow frame, fog) had Three.js state rewritten.
     */
    apply(environment) {
      const value = environment ?? NO_ENVIRONMENT
      let updates = 0
      if (applyBackground(value.background ?? defaultBackground)) updates += 1
      if (applySky(value.sky ?? DEFAULT_SKY)) updates += 1
      const sunValue = value.sun ?? DEFAULT_SUN
      if (applySunLight(sunValue)) updates += 1
      const shadowExtent = value.shadowExtent ?? DEFAULT_SHADOW_EXTENT
      if (
        applySunPlacement(
          sunValue.direction,
          value.shadowFocus ?? ORIGIN,
          shadowExtent,
          value.shadowCasterReach ?? shadowExtent,
        )
      ) {
        updates += 1
      }
      if (applyFog(value.fog ?? null)) updates += 1
      return updates
    },
  }
}
