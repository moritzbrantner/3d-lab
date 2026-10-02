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
  return `${String(node.color)}:${node.opacity ?? 1}:${node.wireframe === true}:${vertexColors}:${shadingKey(node)}:${node.doubleSided === true}`
}

function shadingKey(node) {
  if (node.unlit === true) return "unlit"
  return node.emissive === undefined ? "lit" : `emissive=${String(node.emissive)}`
}

/**
 * Writes the material node for an instance batch into `target` (reused to avoid allocation).
 * Batches always use the default lit material in white: the batch color and per-instance color
 * overrides are uploaded as instance colors and multiply it, so batches that differ only in color
 * share one material (and share it with equally configured white lit nodes). Batches take no
 * `emissive` or `unlit` shading.
 *
 * @param {{opacity?: number, wireframe?: boolean, doubleSided?: boolean}} batch
 * @param {object} [target]
 */
export function instanceBatchMaterialNode(batch, target = {}) {
  target.color = 0xffffff
  target.opacity = batch.opacity ?? 1
  target.wireframe = batch.wireframe === true
  target.doubleSided = batch.doubleSided === true
  return target
}

/** @param {MaterialInput} input */
export function createMaterial({node, vertexColors}) {
  const opacity = node.opacity ?? 1
  const parameters = {
    color: new THREE.Color(node.color),
    opacity,
    transparent: opacity < 1,
    wireframe: node.wireframe === true,
    // Single-sided (back faces culled) unless the node opts into rendering both faces.
    side: node.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
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
