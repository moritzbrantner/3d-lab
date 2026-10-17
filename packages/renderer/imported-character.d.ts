import type {Object3D} from "three"
import type {RendererCamera, ThreeSceneRenderer} from "./index.js"
export interface ImportedCharacterInstance {
  readonly root: Object3D
  seek(clip: string, seconds: number): void
  transition(clip: string, durationSeconds: number): void
  advance(deltaSeconds: number): void
  dispose(): void
}
export interface ImportedCharacterAsset {
  readonly resourceKey: string
  readonly provenance: unknown
  readonly skinNodes: readonly number[]
  readonly clips: readonly {name:string; duration:number}[]
  createInstance(options?: {modelMatrix?: readonly number[]}): ImportedCharacterInstance
  dispose(): void
}
export function adaptImportedCharacter(source: ArrayBuffer | ArrayBufferView, options: {provenance:unknown}): Promise<ImportedCharacterAsset>
export interface GltfResourcesBundleSource {
  /** Parsed `manifest.json` of an unpacked asset-tooling `gltf-resources-v1` bundle. */
  manifest: unknown
  key: string
  variant?: string
  /** Reads one bundle-relative path (the entry's glTF or a declared resource). */
  readResource(path: string): Promise<ArrayBuffer | ArrayBufferView>
}
export function adaptImportedCharacterBundle(bundle: GltfResourcesBundleSource, options?: {onProgress?(progress: {loadedBytes: number; totalBytes: number}): void}): Promise<ImportedCharacterAsset>
export function renderImportedCharacterInstances(renderer: ThreeSceneRenderer, frame: {camera:RendererCamera; instances:readonly ImportedCharacterInstance[]}): unknown
