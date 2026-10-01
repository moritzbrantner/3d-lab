import * as THREE from "three"

const WHITE = new THREE.Color(0xffffff)

/**
 * Creates or updates the InstancedMesh backing one instance batch.
 *
 * `state` is the previous result for the same batch id (or undefined). The mesh is rebuilt only
 * when its instance capacity is exceeded; instance data is re-uploaded only when the batch has no
 * `revision`, its revision changed, or its geometry changed, so static batches cost nothing per
 * frame after the first.
 * `writeMatrix(matrix, instance)` composes one instance's model matrix into `matrix`.
 */
export function syncInstanceBatch(state, batch, geometry, material, writeMatrix, scratch) {
  const count = batch.instances.length
  let mesh = state?.mesh
  let created = false
  const geometryChanged = mesh !== undefined && mesh.geometry !== geometry
  if (!mesh || mesh.instanceMatrix.count < count) {
    const capacity = Math.max(1, count, mesh ? mesh.instanceMatrix.count * 2 : 0)
    mesh = new THREE.InstancedMesh(geometry, material, capacity)
    mesh.matrixAutoUpdate = false
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // Allocate the color attribute up front so every batch shares one shader variant.
    mesh.setColorAt(0, WHITE)
    created = true
  } else {
    mesh.geometry = geometry
    mesh.material = material
  }

  const upload =
    created || geometryChanged || batch.revision === undefined || batch.revision !== state?.revision
  if (upload) {
    for (let index = 0; index < count; index += 1) {
      const instance = batch.instances[index]
      writeMatrix(scratch.matrix, instance)
      mesh.setMatrixAt(index, scratch.matrix)
      mesh.setColorAt(index, scratch.color.set(instance.color ?? batch.color))
    }
    mesh.count = count
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceColor.needsUpdate = true
    // Frustum culling uses the bounds of all live instances, not the base geometry.
    if (count > 0) mesh.computeBoundingSphere()
  }
  mesh.visible = batch.visible !== false && count > 0

  return {
    state: {mesh, revision: batch.revision},
    replacedMesh: created && state?.mesh ? state.mesh : null,
    created,
    uploaded: upload,
  }
}

/**
 * Applies one `syncInstanceBatch` result to the scene and records the object lifecycle.
 *
 * A capacity-growth replacement disposes and removes the old mesh (counted as a removal) and adds
 * the new mesh (counted as a creation), keeping create/remove observations symmetric.
 */
export function attachInstanceBatchResult(scene, result, shadows, observations) {
  if (result.replacedMesh) {
    scene.remove(result.replacedMesh)
    result.replacedMesh.dispose()
    observations.objectRemoveCount += 1
  }
  if (result.created) {
    result.state.mesh.castShadow = shadows
    result.state.mesh.receiveShadow = shadows
    scene.add(result.state.mesh)
    observations.objectCreateCount += 1
  }
  if (result.uploaded) observations.instanceUploadCount += 1
}
