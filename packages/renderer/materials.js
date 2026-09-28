import * as THREE from "three"
import {meshHasVertexColors} from "./mesh-geometry.js"

/**
 * Cache key for a validated scene node's material. Nodes with equal keys share one material, so
 * the key must include every parameter createMaterial reads.
 */
export function materialKey(node) {
  const vertexColors = meshHasVertexColors(node.geometry)
  return `${String(node.color)}:${node.opacity ?? 1}:${node.wireframe === true}:${vertexColors}`
}

export function createMaterial(node) {
  const opacity = node.opacity ?? 1
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(node.color),
    opacity,
    transparent: opacity < 1,
    wireframe: node.wireframe === true,
    // Vertex colors multiply the node color, so white nodes show the vertex colors unchanged.
    vertexColors: meshHasVertexColors(node.geometry),
    roughness: 0.86,
    metalness: 0.02,
  })
}
