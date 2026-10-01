export type Matrix4Values = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
]

export type RendererCamera = {
  viewMatrix: Matrix4Values
  projectionMatrix: Matrix4Values
}

/** A 24-bit sRGB color: an integer such as `0x8fd3ff` or a `#RRGGBB` string. */
export type RendererColor = number | `#${string}`

/** Hemisphere (sky/ground) ambient light. */
export type RendererSkyLight = {
  skyColor: RendererColor
  groundColor: RendererColor
  /** Finite and non-negative. */
  intensity: number
}

/** The directional key light. */
export type RendererSunLight = {
  /**
   * World-space vector pointing from the scene toward the sun. It need not be normalized but must
   * be non-zero; only its direction is used.
   */
  direction: readonly [number, number, number]
  color: RendererColor
  /** Finite and non-negative. */
  intensity: number
}

/** Linear distance fog, measured from the camera in world units. */
export type RendererFog = {
  color: RendererColor
  /** Finite, `0 <= near < far`. */
  near: number
  far: number
}

/**
 * Per-frame presentation environment. Like scene nodes it is declarative: every omitted field
 * (or an omitted environment) renders the renderer default for that field, so callers resend the
 * environment each frame and the renderer rewrites only what changed.
 */
export type RendererEnvironment = {
  /** Clear color. Defaults to the renderer `background` option (transparent with `alpha`). */
  background?: RendererColor
  /** Defaults to sky `#ffffff`, ground `#334433`, intensity 1.7. */
  sky?: RendererSkyLight
  /** Defaults to direction (10, 18, 8), color `#ffffff`, intensity 2.2. */
  sun?: RendererSunLight
  /** `null` or omitted disables fog (the default). */
  fog?: RendererFog | null
  /**
   * World point the sun's shadow camera is centred on. Defaults to the origin. Move it with the
   * viewer to keep shadows around the player in scenes larger than the shadow frame.
   */
  shadowFocus?: readonly [number, number, number]
  /**
   * Half-width in world units of the square region around `shadowFocus` covered by the sun's
   * shadow map. Finite and positive; defaults to 5.
   */
  shadowExtent?: number
  /**
   * How far beyond the shadow region, along `sun.direction`, occluders still cast shadows into
   * it. Occluders farther toward the sun are outside the shadow camera and cast nothing, so set
   * this to at least the longest caster distance you need (roughly caster height divided by the
   * sine of the lowest sun elevation). Finite and non-negative; defaults to `shadowExtent`.
   */
  shadowCasterReach?: number
}

export type BoxGeometry = {
  kind: "box"
  size: [number, number, number]
}

export type SphereGeometry = {
  kind: "sphere"
  radius: number
}

export type CylinderGeometry = {
  kind: "cylinder"
  radius: number
  height: number
}

export type IndexedMeshGeometry = {
  kind: "mesh"
  /**
   * Stable immutable identity for this exact geometry payload, including positions, indices,
   * normals, uvs, and colors. Geometry is cached by this key alone, so a payload with different
   * contents (for example recolored terrain) needs a different key.
   * Content-addressed asset hashes are the preferred downstream value.
   */
  resourceKey: string
  positions: ReadonlyArray<readonly [number, number, number]>
  indices: ReadonlyArray<number>
  normals?: ReadonlyArray<readonly [number, number, number]>
  /**
   * Per-vertex texture coordinates (UV0), aligned one-to-one with positions. Materialized as the
   * `uv` attribute; no current material samples a texture, so they do not change shading yet.
   */
  uvs?: ReadonlyArray<readonly [number, number]>
  /**
   * Per-vertex sRGB colors with components in 0..1, aligned one-to-one with positions. They
   * multiply the node color in linear space, so a `#ffffff` node shows them unchanged.
   */
  colors?: ReadonlyArray<readonly [number, number, number]>
}

export type RendererGeometry =
  | BoxGeometry
  | SphereGeometry
  | CylinderGeometry
  | IndexedMeshGeometry

export type RendererTransform = {
  translation: [number, number, number]
  scale?: [number, number, number]
  rotationQuaternion?: [number, number, number, number]
}

type RendererNodeBase = {
  id: string
  geometry: RendererGeometry
  color: RendererColor
  opacity?: number
  wireframe?: boolean
  visible?: boolean
  /** Render back faces too instead of culling them. Defaults to false (single-sided). */
  doubleSided?: boolean
}

/**
 * How a node responds to light. Nodes with equal color, opacity, wireframe, sidedness,
 * vertex-color use, and shading share one material.
 */
export type RendererNodeShading =
  | {
      /** Standard lit shading (the default). */
      unlit?: false
      /**
       * Self-illumination added after lighting, unaffected by lights, shadows, or vertex colors.
       * Use for glowing effects. Defaults to none.
       */
      emissive?: RendererColor
    }
  | {
      /**
       * Flat node color (times vertex colors) that ignores lights and shadows; fog still applies.
       * Use for markers and other elements that must read the same by day and night.
       */
      unlit: true
      emissive?: never
    }

export type RendererSceneNode = RendererNodeBase & RendererNodeShading & (
  | {
      modelMatrix: Matrix4Values
      transform?: never
    }
  | {
      modelMatrix?: never
      transform: RendererTransform
    }
)

export type RendererInstance = {
  /** Overrides the batch color for this instance. */
  color?: number | `#${string}`
} & (
  | {
      modelMatrix: Matrix4Values
      transform?: never
    }
  | {
      modelMatrix?: never
      transform: RendererTransform
    }
)

/**
 * Many copies of one geometry drawn in a single draw call. Use for repeated static or
 * bulk-updated content such as vegetation, props, or crowds. Batches always use the default lit
 * material (no `emissive`/`unlit`); batch and instance colors are applied per instance and multiply
 * any vertex colors of a mesh geometry. Batches follow the frame environment and shadow settings
 * like nodes.
 */
export type RendererInstanceBatch = {
  id: string
  geometry: RendererGeometry
  /** Default instance color. */
  color: number | `#${string}`
  opacity?: number
  wireframe?: boolean
  visible?: boolean
  /** Render back faces too instead of culling them. Defaults to false (single-sided). */
  doubleSided?: boolean
  /**
   * Stable identity for the exact instance payload (instances plus batch color). When present
   * and unchanged since the previous frame, the renderer skips re-uploading instance data.
   * Omit for batches whose instances change every frame.
   */
  revision?: string
  instances: ReadonlyArray<RendererInstance>
}

/**
 * A baked flipbook atlas: RGBA sRGB pixels, top row first, divided into `columns` x `rows` cells.
 * Frames are numbered row-major from the top-left cell. The renderer uploads one texture per
 * `resourceKey` and keeps it while the atlas is declared in `RendererEffects.atlases`.
 */
export type RendererEffectAtlas = {
  /** Stable identity of the exact pixels and layout, like mesh `resourceKey`. */
  resourceKey: string
  /** Must be a multiple of `columns` (whole-texel cells). */
  width: number
  /** Must be a multiple of `rows` (whole-texel cells). */
  height: number
  pixels: Uint8Array | Uint8ClampedArray
  columns: number
  rows: number
  /** Defaults to `columns * rows`. */
  frameCount?: number
  /**
   * Texture filtering; defaults to `"linear"`. Linear atlases sample each frame inset by half a
   * texel so edges never blend the adjacent frame; `"nearest"` samples the exact cell.
   */
  filter?: "linear" | "nearest"
}

/**
 * One cosmetic camera-facing flipbook. Playback is sampled statelessly from `RendererEffects.time`:
 * pending before `startTime`, active for `duration * loops`, then expired. Effects never feed back
 * into simulation or game state.
 */
export type RendererEffectInstance = {
  /** Unique among effects; the caller owns lifetime by including or omitting the id. */
  id: string
  /** `resourceKey` of a declared atlas. */
  atlas: string
  /** Only world space is supported; callers compose attached effects into a world origin. */
  space: "world"
  origin: readonly [number, number, number]
  /** Same clock as `RendererEffects.time`. */
  startTime: number
  /** Seconds (or caller clock units) for one pass through all frames; positive. */
  duration: number
  /** Whole passes before expiry; defaults to 1. */
  loops?: number
  /** World-space quad size: one number for a square or `[width, height]`. Positive. */
  scale: number | readonly [number, number]
  /** Multiplies the atlas color; defaults to `#ffffff`. */
  color?: RendererColor
  /** Multiplies the atlas alpha; 0..1, defaults to 1. */
  opacity?: number
}

export type RendererEffects = {
  /** The cosmetic clock the effects are sampled at. */
  time: number
  /** `false` draws nothing and disposes every effect resource; defaults to `true`. */
  enabled?: boolean
  /**
   * Caller budget for this frame (for example a reduced-intensity setting); the renderer
   * `maxEffectInstances` option still caps it. Newest effects are kept; the rest are dropped.
   */
  maxInstances?: number
  atlases: ReadonlyArray<RendererEffectAtlas>
  instances: ReadonlyArray<RendererEffectInstance>
}

export type RendererFrame = {
  camera: RendererCamera
  environment?: RendererEnvironment
  nodes: RendererSceneNode[]
  /** Instance batch ids are unique among batches; they do not share a namespace with node ids. */
  instanceBatches?: ReadonlyArray<RendererInstanceBatch>
  /** Cosmetic flipbook effects. Omitting it releases all effect resources. */
  effects?: RendererEffects
}

export type RendererWorkObservations = Readonly<{
  nodeVisitCount: number
  instanceBatchCount: number
  instanceCount: number
  /** Batches whose instance data was (re)uploaded this frame. */
  instanceUploadCount: number
  objectCreateCount: number
  objectReuseCount: number
  objectRemoveCount: number
  geometryCreateCount: number
  geometryReuseCount: number
  geometryEvictCount: number
  materialCreateCount: number
  materialReuseCount: number
  materialEvictCount: number
  /**
   * Environment components (background, sky light, sun light, sun placement/shadow frame, fog)
   * whose Three.js state was rewritten this frame; 0 when the environment is unchanged.
   */
  environmentUpdateCount: number
  /** Live Three.js mesh objects: scene-node meshes plus one instanced mesh per live instance batch. */
  liveObjectCount: number
  liveGeometryCount: number
  liveMaterialCount: number
  /** Batch-specific subset of `liveObjectCount`. */
  liveInstanceBatchCount: number
  /** Effects drawn this frame (after the budget). */
  effectActiveCount: number
  /** Effects whose `startTime` is still ahead of `effects.time`. */
  effectPendingCount: number
  /** Effects past `startTime + duration * loops`. */
  effectExpiredCount: number
  /** Active effects dropped by the instance budget. */
  effectDroppedCount: number
  /** Effect instance attribute buffers (matrix, color, frame, opacity) marked for upload. */
  effectBufferUploadCount: number
  effectAtlasCreateCount: number
  effectAtlasReuseCount: number
  effectAtlasDisposeCount: number
  /** Atlases with live texture, material, geometry, and instanced mesh. Not part of `liveObjectCount`. */
  liveEffectAtlasCount: number
}>

export type ProjectionViewport = {
  x?: number
  y?: number
  width: number
  height: number
}

export type ProjectedPoint = {
  x: number
  y: number
  depth: number
  visible: boolean
}

export type ThreeSceneRendererOptions = {
  antialias?: boolean
  alpha?: boolean
  background?: number | string
  shadows?: boolean
  pixelRatioLimit?: number
  /** Hard cap on effects drawn per frame across all atlases (also each atlas mesh's fixed capacity). Defaults to 64. */
  maxEffectInstances?: number
}

export type ThreeSceneRenderer = {
  setSize(width: number, height: number, devicePixelRatio?: number): void
  /**
   * Re-render the currently submitted scene with a new camera only. It redraws the last
   * submitted nodes and environment unchanged. Callers must use full render() whenever node
   * content or any frame environment field (background, sky, sun, fog, or shadow frame) may
   * have changed, for example on every frame of an animated day/night cycle.
   */
  renderCamera(camera: RendererCamera): RendererWorkObservations
  render(frame: RendererFrame): RendererWorkObservations
  dispose(): void
}

export class ThreeRendererContractError extends Error {}

export function validateRenderCamera(camera: RendererCamera): RendererCamera

export function validateRenderFrame(frame: RendererFrame): RendererFrame

export type WorldProjector = (point: [number, number, number]) => ProjectedPoint

export function createWorldProjector(
  camera: RendererCamera,
  viewport: ProjectionViewport,
): WorldProjector

export function projectWorldPoint(
  camera: RendererCamera,
  point: [number, number, number],
  viewport: ProjectionViewport,
): ProjectedPoint

export function createThreeSceneRenderer(
  canvas: HTMLCanvasElement,
  options?: ThreeSceneRendererOptions,
): ThreeSceneRenderer
