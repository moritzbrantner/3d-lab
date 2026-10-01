import * as THREE from "three"

// Vertex colors arrive as sRGB components like `#RRGGBB` node colors and are converted to the
// Three.js working color space once, when the geometry is materialized.
function workingColorBuffer(colors) {
  const values = new Float32Array(colors.length * 3)
  const scratch = new THREE.Color()
  for (let index = 0; index < colors.length; index += 1) {
    const [red, green, blue] = colors[index]
    scratch.setRGB(red, green, blue, THREE.SRGBColorSpace)
    values[index * 3] = scratch.r
    values[index * 3 + 1] = scratch.g
    values[index * 3 + 2] = scratch.b
  }
  return values
}

/** Materialize validated indexed mesh geometry into one Three.js BufferGeometry. */
export function createIndexedMeshGeometry(geometry) {
  const meshGeometry = new THREE.BufferGeometry()
  meshGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(geometry.positions.flat(), 3),
  )
  meshGeometry.setIndex([...geometry.indices])
  if (geometry.normals !== undefined) {
    meshGeometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(geometry.normals.flat(), 3),
    )
  } else {
    meshGeometry.computeVertexNormals()
  }
  if (geometry.uvs !== undefined) {
    meshGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(geometry.uvs.flat(), 2))
  }
  if (geometry.colors !== undefined) {
    meshGeometry.setAttribute("color", new THREE.BufferAttribute(workingColorBuffer(geometry.colors), 3))
  }
  meshGeometry.computeBoundingSphere()
  return meshGeometry
}
