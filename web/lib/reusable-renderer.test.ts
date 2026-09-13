import {describe, expect, test} from "bun:test"
import {
  ThreeRendererContractError,
  validateRenderFrame,
  type RendererFrame,
} from "@moritzbrantner/three-d-renderer"

const identity = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
] as const

function frame(): RendererFrame {
  return {
    camera: {
      viewMatrix: [...identity],
      projectionMatrix: [...identity],
    },
    nodes: [
      {
        id: "tile:0:0",
        modelMatrix: [...identity],
        geometry: {kind: "box", size: [1, 0.1, 1]},
        color: "#78a861",
      },
    ],
  }
}

describe("reusable Three renderer contract", () => {
  test("accepts matrix-owned scene frames", () => {
    const value = frame()
    expect(validateRenderFrame(value)).toBe(value)
  })

  test("rejects duplicate stable node ids", () => {
    const value = frame()
    value.nodes.push({...value.nodes[0]})

    expect(() => validateRenderFrame(value)).toThrow(ThreeRendererContractError)
  })

  test("rejects non-finite matrices before renderer submission", () => {
    const value = frame()
    value.nodes[0].modelMatrix[12] = Number.NaN

    expect(() => validateRenderFrame(value)).toThrow("must contain exactly 16 finite numbers")
  })
})
