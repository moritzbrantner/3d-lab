import * as THREE from "three"

/**
 * A material request: a validated scene node plus whether the geometry bound to its mesh carries
 * a `color` attribute. The flag comes from the cached geometry, not the submitted payload, so a
 * `resourceKey` reused with a different color layout keeps rendering the cached payload instead of
 * pairing a vertex-color material with a geometry that has no colors (which renders black).
 *
 * @typedef {{node: object, vertexColors: boolean}} MaterialInput
 */

/**
 * Cache key for a material request. Requests with equal keys share one material, so the key must
 * include every parameter createMaterial reads.
 *
 * @param {MaterialInput} input
 */
export function materialKey({node, vertexColors}) {
  return `${String(node.color)}:${node.opacity ?? 1}:${node.wireframe === true}:${vertexColors}:${shadingKey(node)}`
}

function shadingKey(node) {
  if (node.unlit === true) return "unlit"
  return node.emissive === undefined ? "lit" : `emissive=${String(node.emissive)}`
}

/** @param {MaterialInput} input */
export function createMaterial({node, vertexColors}) {
  const opacity = node.opacity ?? 1
  const parameters = {
    color: new THREE.Color(node.color),
    opacity,
    transparent: opacity < 1,
    wireframe: node.wireframe === true,
    // Vertex colors multiply the node color, so white nodes show the vertex colors unchanged.
    vertexColors,
  }
  if (node.unlit === true) {
    // Ignores lights and shadows; scene fog still applies.
    return new THREE.MeshBasicMaterial(parameters)
  }
  return new THREE.MeshStandardMaterial({
    ...parameters,
    // Added after lighting; not scaled by lights, shadows, or vertex colors.
    emissive: new THREE.Color(node.emissive ?? 0x000000),
    roughness: 0.86,
    metalness: 0.02,
  })
}
