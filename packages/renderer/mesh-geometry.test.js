import {describe, expect, test} from "bun:test"
import * as THREE from "three"
import {ThreeRendererContractError, validateRenderFrame} from "./index.js"
import {createIndexedMeshGeometry} from "./mesh-geometry.js"

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function quad(extra = {}) {
  return {
    kind: "mesh",
    resourceKey: "sha256:quad",
    positions: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
    indices: [0, 2, 1, 0, 3, 2],
    ...extra,
  }
}

function frameWith(geometry) {
  return {
    camera: {viewMatrix: IDENTITY, projectionMatrix: IDENTITY},
    nodes: [{id: "terrain", transform: {translation: [0, 0, 0]}, geometry, color: "#ffffff"}],
  }
}

describe("indexed mesh materialization", () => {
  test("keeps positions, indices, and derived normals and adds no color attribute by default", () => {
    const geometry = createIndexedMeshGeometry(quad())

    expect(Array.from(geometry.getAttribute("position").array)).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1])
    expect(Array.from(geometry.index.array)).toEqual([0, 2, 1, 0, 3, 2])
    expect(geometry.getAttribute("normal").getY(0)).toBeCloseTo(1, 6)
    expect(geometry.getAttribute("color")).toBeUndefined()
    expect(geometry.boundingSphere).not.toBeNull()
  })

  test("materializes sRGB vertex colors in the same color space as node colors", () => {
    const palette = ["#5a8f3c", "#ffffff", "#000000", "#c2a878"]
    const colors = palette.map((hex) => {
      const value = Number.parseInt(hex.slice(1), 16)
      return [(value >> 16) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255]
    })

    const attribute = createIndexedMeshGeometry(quad({colors})).getAttribute("color")

    expect(attribute.itemSize).toBe(3)
    expect(attribute.count).toBe(4)
    palette.forEach((hex, vertex) => {
      const nodeColor = new THREE.Color(hex)
      expect(attribute.getX(vertex)).toBeCloseTo(nodeColor.r, 6)
      expect(attribute.getY(vertex)).toBeCloseTo(nodeColor.g, 6)
      expect(attribute.getZ(vertex)).toBeCloseTo(nodeColor.b, 6)
    })
    // sRGB mid-grey is darker in the linear working space; white and black are exact.
    const grey = createIndexedMeshGeometry(quad({colors: [[0.5, 0.5, 0.5], [1, 1, 1], [0, 0, 0], [0, 0, 0]]}))
    expect(grey.getAttribute("color").getX(0)).toBeCloseTo(0.214041, 6)
    expect([grey.getAttribute("color").getX(1), grey.getAttribute("color").getX(2)]).toEqual([1, 0])
  })
})

describe("indexed mesh color validation", () => {
  test("accepts colors aligned with positions", () => {
    const value = frameWith(quad({colors: [[0, 0, 0], [1, 1, 1], [0.25, 0.5, 0.75], [1, 0, 0]]}))
    expect(validateRenderFrame(value)).toBe(value)
  })

  test.each([
    ["too few colors", [[0, 0, 0]], "mesh colors must align one-to-one with positions"],
    ["a non-array", "#ffffff", "mesh colors must align one-to-one with positions"],
    ["a short tuple", [[0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], "mesh color must contain exactly 3 finite numbers"],
    ["a NaN component", [[0, 0, Number.NaN], [0, 0, 0], [0, 0, 0], [0, 0, 0]], "mesh color must contain"],
    ["a component above 1", [[0, 0, 0], [0, 1.01, 0], [0, 0, 0], [0, 0, 0]], "between 0 and 1"],
    ["a negative component", [[0, 0, 0], [0, 0, 0], [0, 0, -0.1], [0, 0, 0]], "between 0 and 1"],
  ])("rejects %s", (_, colors, message) => {
    const value = frameWith(quad({colors}))
    expect(() => validateRenderFrame(value)).toThrow(ThreeRendererContractError)
    expect(() => validateRenderFrame(value)).toThrow(message)
  })
})
