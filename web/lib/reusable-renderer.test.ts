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

  test("accepts renderer-owned transform adaptation", () => {
    const value = frame()
    value.nodes = [
      {
        id: "guest:7",
        transform: {
          translation: [2.5, 0.45, 8.5],
          scale: [0.35, 0.9, 0.35],
        },
        geometry: {kind: "cylinder", radius: 0.5, height: 1},
        color: "#d2b48c",
      },
    ]

    expect(validateRenderFrame(value)).toBe(value)
  })

  test("rejects duplicate stable node ids", () => {
    const value = frame()
    value.nodes.push({...value.nodes[0]})

    expect(() => validateRenderFrame(value)).toThrow(ThreeRendererContractError)
  })

  test("rejects non-finite matrices before renderer submission", () => {
    const value = frame()
    const node = value.nodes[0]
    if (node.modelMatrix === undefined) throw new Error("fixture must use a model matrix")
    node.modelMatrix[12] = Number.NaN

    expect(() => validateRenderFrame(value)).toThrow("must contain exactly 16 finite numbers")
  })

  test("rejects ambiguous matrix and transform ownership", () => {
    const value = frame() as unknown as {
      camera: RendererFrame["camera"]
      nodes: Array<Record<string, unknown>>
    }
    value.nodes[0].transform = {translation: [0, 0, 0]}

    expect(() => validateRenderFrame(value as unknown as RendererFrame)).toThrow(
      "must provide exactly one of modelMatrix or transform",
    )
  })
})
