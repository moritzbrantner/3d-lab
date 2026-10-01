import {describe, expect, test} from "bun:test"
import {
  FlipbookContractError,
  compileFlipbookLayout,
  compileFlipbookPlayback,
  flipbookFrameRect,
  sampleFlipbook,
} from "./flipbook.js"

const layout = compileFlipbookLayout({columns: 2, rows: 2})
const playback = compileFlipbookPlayback({startTime: 10, duration: 0.5})

describe("flipbook sampling", () => {
  test("selects frames by fixed-time age with exact first and last frames", () => {
    const frames = [10, 10.124, 10.125, 10.25, 10.375, 10.4999].map(
      (time) => sampleFlipbook(layout, playback, time).frame,
    )
    expect(frames).toEqual([0, 0, 1, 2, 3, 3])
    expect(sampleFlipbook(layout, playback, 10).phase).toBe("active")
  })

  test("is pending before the start and expired at the end of its lifetime", () => {
    expect(sampleFlipbook(layout, playback, 9.999)).toMatchObject({phase: "pending", frame: -1, loop: 0, progress: 0})
    expect(sampleFlipbook(layout, playback, 9.999).age).toBeLessThan(0)
    expect(sampleFlipbook(layout, playback, 10.5).phase).toBe("expired")
    expect(sampleFlipbook(layout, playback, 1e9).frame).toBe(-1)
  })

  test("loops a whole number of passes", () => {
    const looping = compileFlipbookPlayback({startTime: 0, duration: 1, loops: 2})
    expect(sampleFlipbook(layout, looping, 1.25)).toMatchObject({phase: "active", loop: 1, frame: 1})
    expect(sampleFlipbook(layout, looping, 1.99).frame).toBe(3)
    expect(sampleFlipbook(layout, looping, 2).phase).toBe("expired")
  })

  test("seek and update partitions are independent", () => {
    const times = Array.from({length: 41}, (_, index) => 9.9 + index * 0.0175)
    const forward = times.map((time) => sampleFlipbook(layout, playback, time))
    const reversed = [...times].reverse().map((time) => sampleFlipbook(layout, playback, time)).reverse()
    const coarse = times.filter((_, index) => index % 4 === 0).map((time) => sampleFlipbook(layout, playback, time))
    expect(reversed).toEqual(forward)
    expect(coarse).toEqual(forward.filter((_, index) => index % 4 === 0))
  })

  test("replay or reset is a new startTime, not hidden state", () => {
    const replay = compileFlipbookPlayback({startTime: 20, duration: 0.5})
    for (const offset of [0, 0.1, 0.2, 0.3, 0.4]) {
      expect(sampleFlipbook(layout, replay, 20 + offset).frame).toBe(sampleFlipbook(layout, playback, 10 + offset).frame)
    }
  })

  test("frame rectangles are row-major from the top-left cell", () => {
    expect(flipbookFrameRect(layout, 0)).toEqual([0, 0.5, 0.5, 0.5])
    expect(flipbookFrameRect(layout, 1)).toEqual([0.5, 0.5, 0.5, 0.5])
    expect(flipbookFrameRect(layout, 3)).toEqual([0.5, 0, 0.5, 0.5])
    expect(compileFlipbookLayout({columns: 3, rows: 2, frameCount: 5}).frameCount).toBe(5)
  })

  test("rejects invalid layouts, timing, and sample times", () => {
    for (const bad of [{columns: 0, rows: 1}, {columns: 2, rows: 1.5}, {columns: 2, rows: 2, frameCount: 5}]) {
      expect(() => compileFlipbookLayout(bad)).toThrow(FlipbookContractError)
    }
    for (const bad of [
      {startTime: Number.NaN, duration: 1},
      {startTime: 0, duration: 0},
      {startTime: 0, duration: Infinity},
      {startTime: 0, duration: 1, loops: 0},
    ]) {
      expect(() => compileFlipbookPlayback(bad)).toThrow(FlipbookContractError)
    }
    expect(() => sampleFlipbook(layout, playback, Number.NaN)).toThrow(FlipbookContractError)
    expect(() => sampleFlipbook(layout, compileFlipbookPlayback({startTime: -1e308, duration: 1}), 1e308)).toThrow(
      FlipbookContractError,
    )
  })
})
