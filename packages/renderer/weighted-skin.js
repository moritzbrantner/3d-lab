import { batchSkinParts } from "./skin-batch.js";

/**
 * Batch explicitly authored per-vertex skin influences into one GPU-skinned
 * mesh. Weight generation remains the caller's responsibility.
 */
export function batchWeightedSkin(skeleton, parts, bindMatrix) {
  return batchSkinParts(skeleton, parts, bindMatrix, "weighted skin", (part) => ({
    joints: part.skinIndices,
    weights: part.skinWeights,
  }));
}
