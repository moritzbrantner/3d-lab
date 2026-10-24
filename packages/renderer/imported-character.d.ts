import type {Object3D} from "three"
import type {RendererCamera, ThreeSceneRenderer} from "./index.js"
export interface ImportedItemInstance {
  readonly root: Object3D
  /** The item's named frames in item space, column-major (shared with its asset). */
  readonly frames: Readonly<Record<string, readonly number[]>>
  dispose(): void
}
export interface ImportedItemAsset {
  readonly resourceKey: string
  /** Named item frames (for example `grip`, `grip.offhand`) in item space, column-major. */
  readonly frames: Readonly<Record<string, readonly number[]>>
  createInstance(): ImportedItemInstance
  dispose(): void
}
export interface ImportedCharacterAttachment {
  readonly joint: string
  readonly frame: string
  detach(): void
}
type Vec3 = readonly [number, number, number]
/**
 * Two-bone limb correction (`three_d_animation::ik::LimbGoal`). Joints are named root, mid,
 * tip; positions are character (scene root) space. `orientation` (x,y,z,w) sets a hand grip;
 * `align` turns the tip's local axis toward a direction (foot up to a ground normal).
 */
export interface IkLimbLayer {
  readonly kind: "limb"
  readonly joints: readonly [string, string, string]
  readonly target: Vec3
  readonly pole?: Vec3
  /** Usable fraction of the chain length, (0, 1]; default 1. */
  readonly maxReach?: number
  readonly orientation?: readonly [number, number, number, number]
  readonly align?: {readonly localAxis: Vec3; readonly direction: Vec3}
  /** Layer weight in [0, 1]; default 1. Zero leaves the pose untouched. */
  readonly weight?: number
}
/** Look-at over ≤4 ancestor→aim joints with per-joint weights (`LookAtGoal`). */
export interface IkLookAtLayer {
  readonly kind: "lookAt"
  readonly joints: readonly (readonly [string, number])[]
  /** Aim axis in the last joint's local space. */
  readonly forward: Vec3
  readonly target: Vec3
  /** Maximum deviation from the sampled aim, radians. */
  readonly maxAngle: number
  readonly weight?: number
}
export type IkLayer = IkLimbLayer | IkLookAtLayer
export interface IkLayerReport {
  readonly status: "skipped" | "reached" | "clamped"
  /** Tip-to-target distance (limb) or remaining aim angle in radians (lookAt). */
  readonly residual: number
}
/** Optional Rust layered IK applied over every sampled pose; source clips are never changed. */
export interface CharacterIkControls {
  /** Replace the layers (solved in order, ≤16); `[]` clears. Invalid layers throw and keep the pose. */
  setIk(layers: readonly IkLayer[]): void
  /** Outcome of each layer in the most recent solve. */
  ikReport(): readonly IkLayerReport[]
  /** Character-space position of a named joint in the current corrected pose. */
  jointPosition(joint: string): [number, number, number]
}
export interface ImportedCharacterInstance extends CharacterIkControls {
  readonly root: Object3D
  /**
   * Parent an item instance under the named joint so the item's `frame` (default `grip`) lands
   * on the `socket` transform (column-major, in the joint's frame; identity when omitted).
   * Which item, joint, socket and frame to use is consumer data.
   */
  attach(item: ImportedItemInstance, attachment: {joint: string; socket?: readonly number[]; frame?: string}): ImportedCharacterAttachment
  /**
   * Replace all morph target influences (for example face variants): every influence resets
   * to 0, then each named target is set on every mesh declaring it. Unknown names throw.
   */
  setMorphWeights(weights: Readonly<Record<string, number>>): void
  seek(clip: string, seconds: number): void
  transition(clip: string, durationSeconds: number): void
  advance(deltaSeconds: number): void
  dispose(): void
}
export interface ImportedCharacterAsset {
  readonly resourceKey: string
  readonly provenance: unknown
  readonly skinNodes: readonly number[]
  /** Morph target names across the character's meshes, in first-seen scene order. */
  readonly morphTargets: readonly string[]
  readonly clips: readonly {name:string; duration:number}[]
  createInstance(options?: {modelMatrix?: readonly number[]}): ImportedCharacterInstance
  dispose(): void
}
export function adaptImportedCharacter(source: ArrayBuffer | ArrayBufferView, options: {provenance:unknown}): Promise<ImportedCharacterAsset>
export interface GltfResourcesBundleSource {
  /** Parsed `manifest.json` (`gltf-resources-v1`) or the producer’s `asset-downloads-v1` index. */
  manifest: unknown
  key: string
  variant?: string
  /** Reads one bundle-relative path (the entry's glTF or a declared resource). */
  readResource(path: string): Promise<ArrayBuffer | ArrayBufferView>
}
export type BundleLoadOptions = {
  onProgress?(progress: {loadedBytes: number; totalBytes: number}): void
  /** Required for KTX2. Detection delegates to the existing drawing renderer. */
  renderer?: Pick<ThreeSceneRenderer, "configureTextureLoader">
  /** Consumer-served matching Three.js Basis transcoder directory, trailing slash. */
  transcoderPath?: string
}
export function adaptImportedCharacterBundle(bundle: GltfResourcesBundleSource, options?: BundleLoadOptions): Promise<ImportedCharacterAsset>
export function adaptImportedItemBundle(bundle: GltfResourcesBundleSource, options?: BundleLoadOptions): Promise<ImportedItemAsset>
export function readBundleAttachment(source: {manifest: unknown; key: string; variant?: string; name: string; readResource(path: string): Promise<ArrayBuffer | ArrayBufferView>}): Promise<unknown>
export function renderImportedCharacterInstances(renderer: ThreeSceneRenderer, frame: {camera:RendererCamera; instances:readonly ImportedCharacterInstance[]}): unknown
