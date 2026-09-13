function transformPoint(matrix, [x, y, z, w]) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12] * w,
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13] * w,
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14] * w,
    matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15] * w,
  ]
}

export function projectWorldPointUnchecked(camera, point, viewport) {
  const view = transformPoint(camera.viewMatrix, [point[0], point[1], point[2], 1])
  const clip = transformPoint(camera.projectionMatrix, view)
  const reciprocalW = 1 / clip[3]
  const ndcX = clip[0] * reciprocalW
  const ndcY = clip[1] * reciprocalW
  const ndcZ = clip[2] * reciprocalW

  return {
    x: viewport.x + (ndcX + 1) * 0.5 * viewport.width,
    y: viewport.y + (1 - ndcY) * 0.5 * viewport.height,
    depth: ndcZ,
    visible: clip[3] > 0 && ndcZ >= 0 && ndcZ <= 1,
  }
}
