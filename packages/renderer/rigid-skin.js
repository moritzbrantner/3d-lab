import { batchSkinParts } from "./skin-batch.js";

/**
 * Bake already-authored rigid attachments into one indexed GPU-skinned mesh.
 * This is a renderer adapter, not a rig generator or animation authority.
 * Parts use mesh-local -> model-bind-local matrices and one joint per vertex.
 * Input geometry, materials, skeleton and bone ordering remain caller-owned.
 */
export function batchRigidSkin(skeleton, parts, bindMatrix) {
  return batchSkinParts(skeleton, parts, bindMatrix, "rigid skin", (part, count) => {
    if (!Number.isInteger(part.joint) || part.joint < 0 || part.joint >= skeleton.bones.length) {
      throw new Error(`rigid part references invalid joint ${String(part.joint)}`);
    }
    const joints = new Uint16Array(count * 4);
    const weights = new Float32Array(count * 4);
    for (let vertex = 0; vertex < count; vertex += 1) {
      joints[vertex * 4] = part.joint;
      weights[vertex * 4] = 1;
    }
    return { joints, weights };
  });
}
