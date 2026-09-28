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
   * normals, and colors. Geometry is cached by this key alone, so a payload with different
   * contents (for example recolored terrain) needs a different key.
   * Content-addressed asset hashes are the preferred downstream value.
   */
  resourceKey: string
  positions: ReadonlyArray<readonly [number, number, number]>
  indices: ReadonlyArray<number>
  normals?: ReadonlyArray<readonly [number, number, number]>
  /**
   * Per-vertex sRGB colors with components in 0..1, aligned one-to-one with positions. They
   * multiply the node color, so a `#ffffff` node shows them unchanged.
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
}

/**
 * How a node responds to light. Nodes with equal color, opacity, wireframe, vertex-color use,
 * and shading share one material.
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

export type RendererFrame = {
  camera: RendererCamera
  environment?: RendererEnvironment
  nodes: RendererSceneNode[]
}

export type RendererWorkObservations = Readonly<{
  nodeVisitCount: number
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
  liveObjectCount: number
  liveGeometryCount: number
  liveMaterialCount: number
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
}

export type ThreeSceneRenderer = {
  setSize(width: number, height: number, devicePixelRatio?: number): void
  /**
   * Re-render the currently submitted scene with a new camera only.
   * Callers must use full render() whenever node content may have changed.
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
