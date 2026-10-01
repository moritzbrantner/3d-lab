import {describe, expect, test} from "bun:test"
import * as THREE from "three"
import {ThreeRendererContractError, validateRenderFrame} from "./index.js"
import {createMaterial, materialKey} from "./materials.js"

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

const BOX = {kind: "box", size: [1, 1, 1]}
const PLAIN_MESH = {kind: "mesh", resourceKey: "plain", positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], indices: [0, 1, 2]}
const COLORED_MESH = {...PLAIN_MESH, resourceKey: "colored", colors: [[1, 0, 0], [0, 1, 0], [0, 0, 1]]}

function node(overrides = {}) {
  return {id: "n", transform: {translation: [0, 0, 0]}, geometry: BOX, color: "#ffffff", ...overrides}
}

/** A material request as the renderer builds it: the node plus its bound geometry's color flag. */
function request(overrides = {}, vertexColors = false) {
  return {node: node(overrides), vertexColors}
}

describe("scene node materials", () => {
  test("the default material keeps the historical lit parameters", () => {
    const material = createMaterial(request({color: "#78a861"}))

    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial)
    expect(material.color.equals(new THREE.Color("#78a861"))).toBe(true)
    expect([material.roughness, material.metalness]).toEqual([0.86, 0.02])
    expect([material.opacity, material.transparent, material.wireframe]).toEqual([1, false, false])
    expect(material.vertexColors).toBe(false)
    expect(material.emissive.equals(new THREE.MeshStandardMaterial().emissive)).toBe(true)
  })

  test("nodes with equal material parameters share a key regardless of geometry shape", () => {
    expect(materialKey(request({geometry: BOX}))).toBe(materialKey(request({geometry: PLAIN_MESH})))
    expect(materialKey(request({geometry: COLORED_MESH, id: "a"}, true))).toBe(
      materialKey(request({geometry: {...COLORED_MESH, resourceKey: "other"}, id: "b"}, true)),
    )
  })

  test("every material parameter distinguishes the key", () => {
    const base = materialKey(request())
    for (const variant of [
      request({color: "#fffffe"}),
      request({opacity: 0.5}),
      request({wireframe: true}),
      request({}, true),
      request({emissive: "#ff8800"}),
      request({unlit: true}),
    ]) {
      expect(materialKey(variant)).not.toBe(base)
    }
  })

  test("vertex-colored meshes get a vertex-color material that multiplies the node color", () => {
    const material = createMaterial(request({geometry: COLORED_MESH, color: "#ffffff"}, true))

    expect(material.vertexColors).toBe(true)
    expect(material.color.getHex()).toBe(0xffffff)
    expect(createMaterial(request({geometry: PLAIN_MESH})).vertexColors).toBe(false)
  })

  test("vertex-color use follows the bound geometry, not the submitted payload", () => {
    // A resourceKey reused with a different color layout binds the cached geometry; the material
    // must match that geometry or a missing color attribute renders black.
    expect(materialKey(request({geometry: COLORED_MESH}, false))).toBe(materialKey(request({geometry: PLAIN_MESH}, false)))
    expect(materialKey(request({geometry: PLAIN_MESH}, true))).toBe(materialKey(request({geometry: COLORED_MESH}, true)))
    expect(createMaterial(request({geometry: COLORED_MESH}, false)).vertexColors).toBe(false)
    expect(createMaterial(request({geometry: PLAIN_MESH, unlit: true}, true)).vertexColors).toBe(true)
  })

  test("emissive nodes share a material per emissive color and glow on top of lighting", () => {
    expect(materialKey(request({id: "a", emissive: "#ff8800"}))).toBe(materialKey(request({id: "b", emissive: "#ff8800"})))
    expect(materialKey(request({emissive: "#ff8800"}))).not.toBe(materialKey(request({emissive: "#ff8801"})))
    expect(materialKey(request({unlit: false}))).toBe(materialKey(request()))

    const material = createMaterial(request({color: "#553311", emissive: "#ff8800"}))
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial)
    expect(material.color.equals(new THREE.Color("#553311"))).toBe(true)
    expect(material.emissive.equals(new THREE.Color("#ff8800"))).toBe(true)
  })

  test("unlit nodes use a flat material that keeps opacity, wireframe, vertex colors, and fog", () => {
    const material = createMaterial(
      request({geometry: COLORED_MESH, color: "#ffee00", opacity: 0.4, wireframe: true, unlit: true}, true),
    )

    expect(material).toBeInstanceOf(THREE.MeshBasicMaterial)
    expect(material.color.equals(new THREE.Color("#ffee00"))).toBe(true)
    expect([material.opacity, material.transparent, material.wireframe]).toEqual([0.4, true, true])
    expect(material.vertexColors).toBe(true)
    expect(material.fog).toBe(true)
    expect(materialKey(request({id: "a", unlit: true}))).toBe(materialKey(request({id: "b", unlit: true})))
  })
})

describe("scene node shading validation", () => {
  function frameWith(overrides) {
    return {camera: {viewMatrix: IDENTITY, projectionMatrix: IDENTITY}, nodes: [node(overrides)]}
  }

  test("accepts emissive and unlit nodes", () => {
    for (const overrides of [{emissive: 0xff8800}, {emissive: "#ff8800", unlit: false}, {unlit: true}, {unlit: false}]) {
      const value = frameWith(overrides)
      expect(validateRenderFrame(value)).toBe(value)
    }
  })

  test.each([
    ["a non-boolean unlit flag", {unlit: "yes"}, "unlit for n must be a boolean"],
    ["an invalid emissive color", {emissive: "orange"}, "emissive color for n must be a 24-bit integer"],
    ["unlit combined with emissive", {unlit: true, emissive: "#ff8800"}, "cannot be both unlit and emissive"],
  ])("rejects %s", (_, overrides, message) => {
    expect(() => validateRenderFrame(frameWith(overrides))).toThrow(ThreeRendererContractError)
    expect(() => validateRenderFrame(frameWith(overrides))).toThrow(message)
  })
})
