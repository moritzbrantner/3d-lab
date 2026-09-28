import {describe, expect, test} from "bun:test"
import * as THREE from "three"
import {createMaterial, materialKey} from "./materials.js"

const BOX = {kind: "box", size: [1, 1, 1]}
const PLAIN_MESH = {kind: "mesh", resourceKey: "plain", positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], indices: [0, 1, 2]}
const COLORED_MESH = {...PLAIN_MESH, resourceKey: "colored", colors: [[1, 0, 0], [0, 1, 0], [0, 0, 1]]}

function node(overrides = {}) {
  return {id: "n", transform: {translation: [0, 0, 0]}, geometry: BOX, color: "#ffffff", ...overrides}
}

describe("scene node materials", () => {
  test("the default material keeps the historical lit parameters", () => {
    const material = createMaterial(node({color: "#78a861"}))

    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial)
    expect(material.color.equals(new THREE.Color("#78a861"))).toBe(true)
    expect([material.roughness, material.metalness]).toEqual([0.86, 0.02])
    expect([material.opacity, material.transparent, material.wireframe]).toEqual([1, false, false])
    expect(material.vertexColors).toBe(false)
  })

  test("nodes with equal material parameters share a key regardless of geometry shape", () => {
    expect(materialKey(node({geometry: BOX}))).toBe(materialKey(node({geometry: PLAIN_MESH})))
    expect(materialKey(node({geometry: COLORED_MESH, id: "a"}))).toBe(
      materialKey(node({geometry: {...COLORED_MESH, resourceKey: "other"}, id: "b"})),
    )
  })

  test("every material parameter distinguishes the key", () => {
    const base = materialKey(node())
    for (const variant of [
      node({color: "#fffffe"}),
      node({opacity: 0.5}),
      node({wireframe: true}),
      node({geometry: COLORED_MESH}),
    ]) {
      expect(materialKey(variant)).not.toBe(base)
    }
  })

  test("vertex-colored meshes get a vertex-color material that multiplies the node color", () => {
    const material = createMaterial(node({geometry: COLORED_MESH, color: "#ffffff"}))

    expect(material.vertexColors).toBe(true)
    expect(material.color.getHex()).toBe(0xffffff)
    expect(createMaterial(node({geometry: PLAIN_MESH})).vertexColors).toBe(false)
  })
})
