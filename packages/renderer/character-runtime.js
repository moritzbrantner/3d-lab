// Internal shared character runtime for `./imported-character` and
// `./inspection-character`: one GPU decode, one Rust WASM pose authority, one
// instance shape. Not a public export; entry points own their admission gates.
import * as THREE from "three"
import {GLTFLoader} from "three/examples/jsm/loaders/GLTFLoader.js"
import {clone as cloneSkeleton} from "three/examples/jsm/utils/SkeletonUtils.js"
import init, {CharacterAsset} from "./imported-character-wasm/character.js"

let initialized
function initialize() {
  initialized ??= init()
  return initialized
}
/** Copy caller bytes so later caller mutation cannot change what is checked and parsed. */
export function copyBytes(source, fail) {
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0))
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength))
  return fail("source must be GLB bytes")
}
/**
 * Decode GPU resources once; the real Rust bridge owns all rig/clip/pose meaning.
 * `fail` throws with the caller's message prefix. Returns the unfrozen runtime
 * parts; the caller composes and freezes its public asset.
 */
export async function loadCharacterRuntime(bytes, fail) {
  await initialize()
  const authority = new CharacterAsset(bytes)
  let gltf
  try { gltf = await new GLTFLoader().parseAsync(bytes.buffer, "") }
  catch (error) { authority.free(); throw error }
  const metadata = JSON.parse(authority.metadata_json())
  const mapping = new Map()
  let primitive = 0
  gltf.scene.traverse(node => { if (node.isSkinnedMesh) {
    // Existing weighted-skin policy: bind bounds are not conservative animated bounds (#66).
    node.frustumCulled = false
    if (!node.geometry.index) node.geometry.setIndex(new THREE.Uint32BufferAttribute(metadata.primitiveIndices[primitive], 1))
    // Consume Rust-normalized authored palette slots; never reinterpret active weights here.
    node.geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(metadata.gpuSkinIndices[primitive].flat(), 4))
    primitive += 1
  } })
  gltf.scene.traverse(node => {
    const index = gltf.parser.associations.get(node)?.nodes
    if (index !== undefined) mapping.set(node, index)
  })
  let disposed = false
  const instances = new Set()
  return {
    metadata,
    // Authored glTF JSON (names as written, before any substitution).
    json: gltf.parser.json,
    createInstance({modelMatrix} = {}) {
      if (disposed) fail("asset disposed")
      if (modelMatrix !== undefined && (!Array.isArray(modelMatrix) || modelMatrix.length !== 16 || modelMatrix.some(v => !Number.isFinite(v)))) fail("model matrix must contain16 finite values")
      const scene = cloneSkeleton(gltf.scene)
      const root = new THREE.Group()
      if (modelMatrix) { root.matrix.fromArray(modelMatrix); root.matrixAutoUpdate = false }
      root.add(scene)
      const sourceNodes = new Map()
      const pair = (original, copy) => {
        if (mapping.has(original)) sourceNodes.set(mapping.get(original), copy)
        original.children.forEach((child, i) => pair(child, copy.children[i]))
      }
      pair(gltf.scene, scene)
      const pose = authority.create_instance()
      let instanceDisposed = false
      const apply = () => {
        const matrices = pose.local_matrices()
        metadata.sourceNodes.forEach((sourceIndex, canonical) => {
          const node = sourceNodes.get(sourceIndex)
          if (node) {
            node.matrix.fromArray(matrices, canonical * 16)
            node.matrixAutoUpdate = false
            node.matrixWorldNeedsUpdate = true
          }
        })
        root.updateMatrixWorld(true)
      }
      const update = (method, ...args) => {
        if (instanceDisposed || disposed) fail("instance disposed")
        pose[method](...args)
        apply()
      }
      const instance = {root,
        seek: (clip, seconds) => update("seek", clip, seconds),
        transition: (clip, seconds) => update("transition", clip, seconds),
        advance: seconds => update("advance", seconds),
        dispose() { if (instanceDisposed) return; instanceDisposed = true; root.removeFromParent(); pose.free(); instances.delete(instance) },
      }
      apply()
      instances.add(instance)
      return instance
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const instance of instances) instance.dispose()
      const geometries = new Set(), materials = new Set(), textures = new Set()
      gltf.scene.traverse(node => { if (node.isMesh) { geometries.add(node.geometry); for (const material of Array.isArray(node.material) ? node.material : [node.material]) { materials.add(material); for (const value of Object.values(material)) if (value?.isTexture) textures.add(value) } } })
      for (const item of [...geometries,...materials,...textures]) item.dispose()
      authority.free()
    },
  }
}
/** Submit through the existing public renderer; no separate context or animation loop. */
export function renderImportedCharacterInstances(renderer, {camera, instances}) {
  return renderer.renderImportedRoots({camera, roots:instances.map(instance => instance.root)})
}
