import {describe, expect, test} from "bun:test"
import {
  ThreeRendererContractError,
  createWorldProjector,
  projectWorldPoint,
  validateRenderCamera,
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

  test("validates camera-only updates without requiring scene nodes", () => {
    const camera = frame().camera
    expect(validateRenderCamera(camera)).toBe(camera)
    camera.projectionMatrix[0] = Number.NaN
    expect(() => validateRenderCamera(camera)).toThrow("must contain exactly 16 finite numbers")
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

  test("accepts content-addressed indexed mesh geometry", () => {
    const value = frame()
    value.nodes = [
      {
        id: "asset:zoo-entrance",
        transform: {translation: [0, 0, 0]},
        geometry: {
          kind: "mesh",
          resourceKey: "sha256:entrance-fixture",
          positions: [
            [-0.5, 0, 0],
            [0.5, 0, 0],
            [0, 1, 0],
          ],
          indices: [0, 1, 2],
          normals: [
            [0, 0, 1],
            [0, 0, 1],
            [0, 0, 1],
          ],
        },
        color: "#d8c79d",
      },
    ]

    expect(validateRenderFrame(value)).toBe(value)
  })

  test("rejects invalid indexed mesh references before GPU submission", () => {
    const value = frame()
    value.nodes = [
      {
        id: "asset:broken",
        transform: {translation: [0, 0, 0]},
        geometry: {
          kind: "mesh",
          resourceKey: "sha256:broken-fixture",
          positions: [
            [0, 0, 0],
            [1, 0, 0],
            [0, 1, 0],
          ],
          indices: [0, 1, 3],
        },
        color: "#d8c79d",
      },
    ]

    expect(() => validateRenderFrame(value)).toThrow(
      "mesh index 3 must reference an existing position",
    )
  })

  test("rejects mesh normals that do not align with positions", () => {
    const value = frame() as unknown as {
      camera: RendererFrame["camera"]
      nodes: Array<Record<string, unknown>>
    }
    value.nodes = [
      {
        id: "asset:broken-normals",
        transform: {translation: [0, 0, 0]},
        geometry: {
          kind: "mesh",
          resourceKey: "sha256:broken-normal-fixture",
          positions: [
            [0, 0, 0],
            [1, 0, 0],
            [0, 1, 0],
          ],
          indices: [0, 1, 2],
          normals: [[0, 0, 1]],
        },
        color: "#d8c79d",
      },
    ]

    expect(() => validateRenderFrame(value as unknown as RendererFrame)).toThrow(
      "mesh normals must align one-to-one with positions",
    )
  })

  test("projects world points for downstream DOM interaction overlays", () => {
    const projected = projectWorldPoint(frame().camera, [0, 0, 0], {
      x: 10,
      y: 20,
      width: 200,
      height: 100,
    })

    expect(projected).toEqual({x: 110, y: 70, depth: 0, visible: true})
  })

  test("reuses validated camera and viewport across repeated world projections", () => {
    const camera = frame().camera
    const viewport = {x: 10, y: 20, width: 200, height: 100}
    const project = createWorldProjector(camera, viewport)

    for (const point of [[0, 0, 0], [0.25, -0.5, 0.5], [-0.75, 0.5, 0.25]] as const) {
      expect(project([...point])).toEqual(projectWorldPoint(camera, [...point], viewport))
    }
    expect(() => project([Number.NaN, 0, 0])).toThrow("world point")
  })

  test("prepared world projection fails before returning a callable projector", () => {
    const camera = frame().camera
    camera.viewMatrix[0] = Number.NaN
    expect(() => createWorldProjector(camera, {width: 100, height: 100})).toThrow(
      "camera view matrix",
    )
    expect(() => createWorldProjector(frame().camera, {width: 0, height: 100})).toThrow(
      "finite positive width/height",
    )
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
