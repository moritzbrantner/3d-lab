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
   * Stable immutable identity for this exact geometry payload.
   * Content-addressed asset hashes are the preferred downstream value.
   */
  resourceKey: string
  positions: ReadonlyArray<readonly [number, number, number]>
  indices: ReadonlyArray<number>
  normals?: ReadonlyArray<readonly [number, number, number]>
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
  color: number | `#${string}`
  opacity?: number
  wireframe?: boolean
  visible?: boolean
}

export type RendererSceneNode = RendererNodeBase & (
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
 * bulk-updated content such as vegetation, props, or crowds.
 */
export type RendererInstanceBatch = {
  id: string
  geometry: RendererGeometry
  /** Default instance color. */
  color: number | `#${string}`
  opacity?: number
  wireframe?: boolean
  visible?: boolean
  /**
   * Stable identity for the exact instance payload (instances plus batch color). When present
   * and unchanged since the previous frame, the renderer skips re-uploading instance data.
   * Omit for batches whose instances change every frame.
   */
  revision?: string
  instances: ReadonlyArray<RendererInstance>
}

export type RendererFrame = {
  camera: RendererCamera
  nodes: RendererSceneNode[]
  /** Instance batch ids are unique among batches; they do not share a namespace with node ids. */
  instanceBatches?: ReadonlyArray<RendererInstanceBatch>
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
  liveObjectCount: number
  liveGeometryCount: number
  liveMaterialCount: number
  liveInstanceBatchCount: number
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
