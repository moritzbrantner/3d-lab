import {describe, expect, test} from "bun:test"
import {webGpuProjectionToWebGl} from "./depth.js"
import {evictUnusedResources} from "./resources.js"

describe("renderer depth adaptation", () => {
  test("remaps WebGPU zero-to-one depth into WebGL negative-one-to-one depth", () => {
    const identity = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]

    expect(webGpuProjectionToWebGl(identity)).toEqual([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 2, 0,
      0, 0, -1, 1,
    ])
  })

  test("preserves x/y/w projection rows while only remapping clip depth", () => {
    const matrix = [
      3, 4, 5, 6,
      7, 8, 9, 10,
      11, 12, 13, 14,
      15, 16, 17, 18,
    ]
    const converted = webGpuProjectionToWebGl(matrix)

    expect(converted.filter((_, index) => ![2, 6, 10, 14].includes(index))).toEqual(
      matrix.filter((_, index) => ![2, 6, 10, 14].includes(index)),
    )
    expect([converted[2], converted[6], converted[10], converted[14]]).toEqual([
      2 * 5 - 6,
      2 * 9 - 10,
      2 * 13 - 14,
      2 * 17 - 18,
    ])
  })
})

describe("renderer resource lifecycle", () => {
  test("disposes and removes cache entries that no live scene node references", () => {
    const disposed = []
    const cache = new Map([
      ["live", {dispose: () => disposed.push("live")}],
      ["stale-a", {dispose: () => disposed.push("stale-a")}],
      ["stale-b", {dispose: () => disposed.push("stale-b")}],
    ])

    evictUnusedResources(cache, new Set(["live"]))

    expect([...cache.keys()]).toEqual(["live"])
    expect(disposed).toEqual(["stale-a", "stale-b"])
  })
})
