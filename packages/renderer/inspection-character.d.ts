import type {Object3D} from "three"
import type {RendererCamera, ThreeSceneRenderer} from "./index.js"
/** Pin of the original source bytes: lowercase hex SHA-256 and exact byte length. */
export interface CharacterSourcePin {
  readonly sha256: string
  readonly byteLength: number
}
export interface InspectionCharacterClip {
  readonly index: number
  readonly duration: number
  /** Authored glTF name; absent for unnamed clips, which are addressed by index. */
  readonly name?: string
}
export interface InspectionCharacterInstance {
  readonly root: Object3D
  /** A number seeks the clip at that index; a string seeks by authored name. Invalid clips throw and leave the pose unchanged. */
  seek(clip: string | number, seconds: number): void
  advance(deltaSeconds: number): void
  dispose(): void
}
/** Inspection-only: not production-validated, carries no provenance, never an `ImportedCharacterAsset`. */
export interface InspectionCharacterAsset {
  readonly validation: "inspection-only"
  readonly provenance?: undefined
  readonly clips: readonly InspectionCharacterClip[]
  /** A fresh instance shows the rest pose (no clip applied). */
  createInstance(options?: {modelMatrix?: readonly number[]}): InspectionCharacterInstance
  dispose(): void
}
/** One external glTF buffer/image: its bytes and their pin. */
export interface PinnedCharacterResource extends CharacterSourcePin {
  readonly bytes: ArrayBuffer | ArrayBufferView
}
/**
 * Verifies `pin` over exactly `source` (copied first) before any parsing; rejects on mismatch.
 * A `.gltf` with external buffers/images needs `resources`: every referenced URI, exactly as
 * written in the document, mapped to its pinned bytes. Every resource pin is verified before parsing.
 */
export function adaptPinnedCharacterSource(source: ArrayBuffer | ArrayBufferView, pin: CharacterSourcePin, options?: {resources?: Readonly<Record<string, PinnedCharacterResource>>}): Promise<InspectionCharacterAsset>
/** The identical production render call from `./imported-character`, re-exported. */
export function renderImportedCharacterInstances(renderer: ThreeSceneRenderer, frame: {camera:RendererCamera; instances:readonly {readonly root: Object3D}[]}): unknown
