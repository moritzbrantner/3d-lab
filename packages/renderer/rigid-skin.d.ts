import type { BufferGeometry, Material, Matrix4, Skeleton, SkinnedMesh } from "three";

export type RigidSkinPart = {
  geometry: BufferGeometry;
  material: Material;
  /** Index in the caller's authoritative skeleton.bones array. */
  joint: number;
  /** Source mesh local space to model bind-local space. No reflection. */
  matrix: Matrix4;
};

export type RigidSkinBatch = {
  mesh: SkinnedMesh<BufferGeometry, Material[]>;
  sourceDraws: number;
  /** Opaque color-pass material groups, not a measured GPU frame time. */
  materialDraws: number;
  vertexCount: number;
};

/**
 * Caller disposes the returned mesh.geometry. Materials/skeleton are borrowed.
 * Rigid (one-joint) weights preserve attachments; this does not invent smooth
 * skin weights. Input geometry must be indexed with compatible attributes.
 * Culling is disabled until the caller supplies conservative animated bounds.
 * Clear mesh.boundingBox/boundingSphere after pose changes before raycasting.
 */
export function batchRigidSkin(
  skeleton: Skeleton,
  parts: readonly RigidSkinPart[],
  bindMatrix: Matrix4,
): RigidSkinBatch;
