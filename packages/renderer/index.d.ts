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

export type RendererGeometry = BoxGeometry | SphereGeometry | CylinderGeometry

export type RendererSceneNode = {
  id: string
  modelMatrix: Matrix4Values
  geometry: RendererGeometry
  color: number | `#${string}`
  opacity?: number
  wireframe?: boolean
  visible?: boolean
}

export type RendererFrame = {
  camera: RendererCamera
  nodes: RendererSceneNode[]
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
  render(frame: RendererFrame): void
  dispose(): void
}

export class ThreeRendererContractError extends Error {}

export function validateRenderFrame(frame: RendererFrame): RendererFrame

export function createThreeSceneRenderer(
  canvas: HTMLCanvasElement,
  options?: ThreeSceneRendererOptions,
): ThreeSceneRenderer
