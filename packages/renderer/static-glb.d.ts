import type {
  IndexedMeshGeometry,
  Matrix4Values,
  RendererInstanceBatch,
  RendererSceneNode,
  RendererTransform,
  ThreeRendererContractError,
} from "./index.js"

/** Thrown for malformed GLBs and for source features the static adapter cannot render faithfully. */
export class StaticGlbContractError extends ThreeRendererContractError {}

export type StaticGlbBounds = Readonly<{
  min: readonly [number, number, number]
  max: readonly [number, number, number]
}>

/**
 * A glTF material lowered to factors. `baseColor` is the sRGB `#RRGGBB` form of the linear glTF
 * factor that the renderer applies; metallic/roughness are preserved for inspection
 * but not yet rendered (the renderer's lit material has fixed metalness/roughness).
 */
export type StaticGlbMaterial = Readonly<{
  /** glTF material index, or `null` for the glTF default material. */
  index: number | null
  name: string | null
  baseColor: `#${string}`
  /** Linear RGBA factor from the source; alpha is ignored because only OPAQUE is accepted. */
  baseColorFactor: readonly [number, number, number, number]
  metallicFactor: number
  roughnessFactor: number
  doubleSided: boolean
}>

export type StaticGlbNode = Readonly<{
  /** glTF node index. */
  index: number
  name: string | null
  parent: number | null
  children: ReadonlyArray<number>
  /** Column-major local transform (glTF matrix or composed TRS). */
  localMatrix: Matrix4Values
  /** Column-major transform from node space to asset (scene root) space. */
  worldMatrix: Matrix4Values
  mesh: number | null
}>

/** One mesh primitive placed by one node: the unit the renderer draws. */
export type StaticGlbDrawable = Readonly<{
  /** Stable within the asset: `node=<n>/mesh=<m>/primitive=<p>`. */
  id: string
  node: number
  mesh: number
  primitive: number
  material: StaticGlbMaterial
  /** Column-major node-to-asset-space matrix. */
  matrix: Matrix4Values
  /**
   * Shared immutable geometry. Its `resourceKey` is `<asset resourceKey>#mesh=<m>/primitive=<p>`,
   * so nodes that reuse a mesh, and every placement of the asset, share one renderer geometry.
   */
  geometry: IndexedMeshGeometry
  /** Local-space axis-aligned bounds of the geometry. */
  bounds: StaticGlbBounds
}>

export type StaticGlbAsset = Readonly<{
  /** Content identity: the caller's key, or `glb-sha256:<hex>` of the exact GLB bytes. */
  resourceKey: string
  /** Default-scene nodes in depth-first order. */
  nodes: ReadonlyArray<StaticGlbNode>
  materials: ReadonlyArray<StaticGlbMaterial>
  drawables: ReadonlyArray<StaticGlbDrawable>
  /** Asset-space bounds of all drawables. */
  bounds: StaticGlbBounds
  /** Optional (not required) extensions present in the source that the adapter does not apply. */
  ignoredExtensions: ReadonlyArray<string>
}>

export type StaticGlbAdaptOptions = {
  /**
   * Content identity of the GLB bytes, such as asset-tooling's SHA-256. Defaults to the SHA-256 of
   * the bytes. It must change whenever the bytes change.
   */
  resourceKey?: string
}

/**
 * Validate and lower one self-contained static GLB 2.0 into immutable renderer descriptors. Call
 * once per asset and reuse the result for every frame and placement. Rejects (with
 * `StaticGlbContractError`) textures, non-OPAQUE alpha, skins, animations, morph targets,
 * non-triangle primitives, missing NORMAL, attributes other than POSITION/NORMAL/TANGENT/
 * TEXCOORD_0/COLOR_0, URI buffers, and unsupported required extensions.
 */
export function adaptStaticGlb(
  source: ArrayBuffer | ArrayBufferView,
  options?: StaticGlbAdaptOptions,
): Promise<StaticGlbAsset>

type StaticGlbPlacementTransform =
  | {modelMatrix: Matrix4Values; transform?: never}
  | {modelMatrix?: never; transform: RendererTransform}
  | {modelMatrix?: never; transform?: never}

type StaticGlbSelection = {
  /** Prefix for the produced node/batch ids: `<id>/<drawable id>`. */
  id: string
  /** Restricts which drawables are submitted, e.g. by node name. Defaults to all. */
  filter?: (drawable: StaticGlbDrawable) => boolean
  opacity?: number
  wireframe?: boolean
  visible?: boolean
}

export type StaticGlbPlacement = StaticGlbSelection & StaticGlbPlacementTransform

/** Scene nodes for one placement of the asset (identity placement when no transform is given). */
export function staticGlbSceneNodes(asset: StaticGlbAsset, placement: StaticGlbPlacement): RendererSceneNode[]

export type StaticGlbInstanceBatchOptions = StaticGlbSelection & {
  instances: ReadonlyArray<StaticGlbPlacementTransform>
  /** Forwarded to every batch; see `RendererInstanceBatch.revision`. */
  revision?: string
}

/** One instance batch per drawable for many placements of the asset. */
export function staticGlbInstanceBatches(
  asset: StaticGlbAsset,
  options: StaticGlbInstanceBatchOptions,
): RendererInstanceBatch[]
