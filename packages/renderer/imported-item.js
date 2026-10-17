// Internal: static attachable items (weapons, shields, props) from asset-tooling bundles, and
// the generic joint attachment used by imported character instances (#134). Items are
// validated and lowered by the existing static GLB adapter; this module only materializes
// shared GPU resources and parents per-instance roots. Which item goes to which joint, with
// which transform and which item frame, is consumer data.
import * as THREE from "three"
import {adaptStaticGlb} from "./static-glb.js"
import {createIndexedMeshGeometry} from "./mesh-geometry.js"
import {createMaterial} from "./materials.js"

/** A column-major 4x4 of 16 finite numbers, or a failure. */
export function matrixFrom(values, what, fail) {
  if (!Array.isArray(values) && !ArrayBuffer.isView(values)) fail(`${what} must be a 16-value matrix`)
  if (values.length !== 16 || [...values].some(value => !Number.isFinite(value))) fail(`${what} must contain 16 finite values`)
  return new THREE.Matrix4().fromArray([...values])
}

/** Lower a static item GLB once; instances share its geometry and materials. */
export async function loadImportedItem(glb, resourceKey, fail) {
  const asset = await adaptStaticGlb(glb, {resourceKey})
  const frames = new Map()
  for (const node of asset.nodes) {
    if (node.name === null) continue
    if (frames.has(node.name)) fail(`item frame name ${node.name} is not unique`)
    frames.set(node.name, Object.freeze([...node.worldMatrix]))
  }
  const parts = asset.drawables.map(drawable => ({
    geometry: createIndexedMeshGeometry(drawable.geometry),
    material: createMaterial({
      node: {color: drawable.material.baseColor, doubleSided: drawable.material.doubleSided},
      vertexColors: drawable.geometry.colors !== undefined,
    }),
    matrix: new THREE.Matrix4().fromArray([...drawable.matrix]),
  }))
  let disposed = false
  const instances = new Set()
  const frameTable = Object.freeze(Object.fromEntries(frames))
  return Object.freeze({
    resourceKey: asset.resourceKey,
    /** Named item frames (for example `grip`) in item space, column-major. */
    frames: frameTable,
    createInstance() {
      if (disposed) fail("item asset disposed")
      const root = new THREE.Group()
      for (const part of parts) {
        const mesh = new THREE.Mesh(part.geometry, part.material)
        mesh.matrix.copy(part.matrix)
        mesh.matrixAutoUpdate = false
        root.add(mesh)
      }
      let instanceDisposed = false
      const instance = Object.freeze({
        root,
        frames: frameTable,
        dispose() {
          if (instanceDisposed) return
          instanceDisposed = true
          root.removeFromParent()
          instances.delete(instance)
        },
      })
      instances.add(instance)
      return instance
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const instance of [...instances]) instance.dispose()
      for (const part of parts) { part.geometry.dispose(); part.material.dispose() }
    },
  })
}

/**
 * Parent `item.root` under `joint` so the item's `frame` lands on the joint's socket transform:
 * holder = socket × inverse(frame). Returns a handle that detaches it again.
 */
export function attachToJoint(joint, item, {frame, socketMatrix}, fail) {
  if (!item?.root?.isObject3D || typeof item.frames !== "object") fail("attached item must be an item instance")
  if (item.root.parent) fail("item instance is already attached")
  if (!Object.hasOwn(item.frames, frame)) fail(`item has no frame ${frame}`)
  const frameMatrix = new THREE.Matrix4().fromArray([...item.frames[frame]])
  const inverse = frameMatrix.clone().invert()
  if (!inverse.elements.every(Number.isFinite) || frameMatrix.determinant() === 0) fail(`item frame ${frame} is not invertible`)
  const holder = new THREE.Group()
  holder.matrix.multiplyMatrices(socketMatrix, inverse)
  holder.matrixAutoUpdate = false
  holder.add(item.root)
  joint.add(holder)
  holder.updateMatrixWorld(true)
  let attached = true
  return Object.freeze({
    holder,
    detach() {
      if (!attached) return
      attached = false
      holder.remove(item.root)
      holder.removeFromParent()
    },
  })
}
