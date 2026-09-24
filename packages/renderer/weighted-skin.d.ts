import type { BufferGeometry, Material, Matrix4, Skeleton, SkinnedMesh } from "three";

export type WeightedSkinPart = {
  geometry: BufferGeometry;
  material: Material;
  /** Source mesh local space to model bind-local space. No reflection. */
  matrix: Matrix4;
  /** Flat four-lane joint indices, one vec4 per vertex. */
  skinIndices: ArrayLike<number>;
  /** Flat normalized weights, one vec4 per vertex. */
  skinWeights: ArrayLike<number>;
};

export type WeightedSkinBatch = {
  mesh: SkinnedMesh<BufferGeometry, Material[]>;
  sourceDraws: number;
  /** Opaque color-pass material groups, not a measured GPU frame time. */
  materialDraws: number;
  vertexCount: number;
  /** Vertices with more than one positive joint influence. */
  multiJointVertices: number;
  /** Four uint8 lanes for <=256 joints, otherwise four uint16 lanes. */
  skinIndexBytesPerVertex: 4 | 8;
};

/**
 * Caller owns weight authoring and disposes the returned mesh.geometry.
 * Materials/skeleton are borrowed. Each vertex supplies exactly four indices
 * and weights; weights must be finite, non-negative and sum to one.
 * Culling remains disabled until the caller supplies conservative animated bounds.
 */
export function batchWeightedSkin(
  skeleton: Skeleton,
  parts: readonly WeightedSkinPart[],
  bindMatrix: Matrix4,
): WeightedSkinBatch;
