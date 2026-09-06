export const VERTEX_OCCLUSION_TOLERANCE = 0.03;

export function shouldSelectVertexHit(
  vertexDistance: number,
  nearestMeshDistance: number | null,
  tolerance = VERTEX_OCCLUSION_TOLERANCE,
): boolean {
  if (!Number.isFinite(vertexDistance) || vertexDistance < 0) return false;
  if (nearestMeshDistance === null) return true;
  if (!Number.isFinite(nearestMeshDistance) || nearestMeshDistance < 0) return false;

  const depthTolerance = Number.isFinite(tolerance) ? Math.max(tolerance, 0) : 0;
  return vertexDistance <= nearestMeshDistance + depthTolerance;
}
