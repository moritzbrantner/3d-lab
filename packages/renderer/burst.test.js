import {describe, expect, test} from "bun:test"
import {
  FlipbookContractError,
  MAX_BURST_PARTICLES,
  burstParticleStartTime,
  compileBurst,
  compileFlipbookLayout,
  sampleBurst,
  sampleBurstParticle,
} from "./flipbook.js"

const layout = compileFlipbookLayout({columns: 2, rows: 2})
const preset = {count: 8, lifetime: 0.8, speed: [1, 2], direction: [0, 1, 0], spread: Math.PI / 4}
const burst = compileBurst({...preset, startTime: 10, seed: 42})

describe("seeded burst sampling", () => {
  test("equal seeds give equal particles; other seeds differ", () => {
    const again = compileBurst({...preset, startTime: 10, seed: 42})
    expect(sampleBurst(layout, again, 10.3)).toEqual(sampleBurst(layout, burst, 10.3))
    const other = sampleBurst(layout, compileBurst({...preset, startTime: 10, seed: 43}), 10.3)
    expect(other.map((p) => p.offset)).not.toEqual(sampleBurst(layout, burst, 10.3).map((p) => p.offset))
  })

  test("pins a reference particle so the seeded stream stays stable", () => {
    const sample = sampleBurstParticle(layout, burst, 0, 10.5)
    expect(sample.phase).toBe("active")
    expect(sample.frame).toBe(2)
    expect(sample.offset.map((v) => Number(v.toFixed(6)))).toEqual([-0.258802, 0.554385, 0.432082])
  })

  test("particles start at the burst start, end after lifetime, and stay in the cone", () => {
    for (const sample of sampleBurst(layout, burst, 10)) {
      expect(sample).toMatchObject({phase: "active", frame: 0, size: 1, opacity: 1, offset: [0, 0, 0]})
    }
    expect(sampleBurst(layout, burst, 9.99).every((p) => p.phase === "pending" && p.frame === -1)).toBe(true)
    expect(sampleBurst(layout, burst, 10.8).every((p) => p.phase === "expired")).toBe(true)
    for (const sample of sampleBurst(layout, burst, 10.5)) {
      const [x, y, z] = sample.offset
      const distance = Math.hypot(x, y, z)
      expect(distance).toBeGreaterThanOrEqual(0.5 - 1e-9)
      expect(distance).toBeLessThanOrEqual(1 + 1e-9)
      expect(y / distance).toBeGreaterThanOrEqual(Math.cos(Math.PI / 4) - 1e-9)
    }
    expect(sampleBurstParticle(layout, burst, 0, 10.79).frame).toBe(3)
  })

  test("gravity, endScale, fadeOut, and emitDuration follow their closed forms", () => {
    const falling = compileBurst({count: 4, lifetime: 2, speed: 0, gravity: [0, -10, 0], endScale: 3, fadeOut: true, emitDuration: 1, startTime: 0, seed: 1})
    const sample = sampleBurstParticle(layout, falling, 0, 1)
    expect(sample.offset).toEqual([0, -5, 0])
    expect(sample.size).toBe(2)
    expect(sample.opacity).toBe(0.5)
    expect(burstParticleStartTime(falling, 2)).toBe(0.5)
    expect(sampleBurstParticle(layout, falling, 3, 0.7).phase).toBe("pending")
    expect(sampleBurstParticle(layout, falling, 3, 0.75).phase).toBe("active")
  })

  test("seek and update partitions are independent; replay is a new startTime", () => {
    const times = Array.from({length: 30}, (_, index) => 9.95 + index * 0.031)
    const forward = times.map((time) => sampleBurst(layout, burst, time))
    const reversed = [...times].reverse().map((time) => sampleBurst(layout, burst, time)).reverse()
    expect(reversed).toEqual(forward)
    const replay = compileBurst({...preset, startTime: 20, seed: 42})
    expect(sampleBurst(layout, replay, 20.25).map((p) => p.frame)).toEqual(sampleBurst(layout, burst, 10.25).map((p) => p.frame))
  })

  test("rejects unbounded or invalid bursts", () => {
    const base = {...preset, startTime: 0, seed: 0}
    for (const bad of [
      {count: 0},
      {count: MAX_BURST_PARTICLES + 1},
      {seed: -1},
      {seed: 2 ** 32},
      {lifetime: 0},
      {speed: [2, 1]},
      {speed: -1},
      {direction: [0, 0, 0]},
      {spread: 4},
      {gravity: [0, Number.NaN, 0]},
      {endScale: -1},
      {emitDuration: -1},
      {startTime: Infinity},
    ]) {
      expect(() => compileBurst({...base, ...bad})).toThrow(FlipbookContractError)
    }
    expect(() => sampleBurstParticle(layout, burst, 0, Number.NaN)).toThrow(FlipbookContractError)
  })
})
