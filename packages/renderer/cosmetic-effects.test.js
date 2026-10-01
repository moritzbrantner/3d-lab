import {describe, expect, test} from "bun:test"
import * as THREE from "three"
import {createPuffAtlas} from "../../scripts/fixtures/cosmetic-puff-atlas.mjs"
import {createCosmeticEffectLayer, validateCosmeticEffects} from "./cosmetic-effects.js"
import {ThreeRendererContractError, validateRenderFrame} from "./index.js"

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const camera = {viewMatrix: IDENTITY, projectionMatrix: IDENTITY}
const atlas = createPuffAtlas()

function puff(id, startTime, extra = {}) {
  return {id, atlas: atlas.resourceKey, space: "world", origin: [0, 1, 0], startTime, duration: 0.4, scale: 1, ...extra}
}

function effects(time, instances, extra = {}) {
  return {time, atlases: [atlas], instances, ...extra}
}

function sync(layer, value) {
  const observations = {}
  layer.sync(value, observations)
  return observations
}

function frameRect(state, slot) {
  return Array.from(state.frameAttribute.array.slice(slot * 4, slot * 4 + 4))
}

describe("cosmetic effect layer", () => {
  test("creates atlas resources once and reuses them across bursts", () => {
    const scene = new THREE.Scene()
    const layer = createCosmeticEffectLayer(scene)
    const first = sync(layer, effects(0, [puff("a", 0)]))
    expect(first).toMatchObject({effectAtlasCreateCount: 1, effectActiveCount: 1, liveEffectAtlasCount: 1})
    const state = layer.atlasState(atlas.resourceKey)
    expect(scene.children).toContain(state.mesh)
    expect(state.mesh.count).toBe(1)
    expect(state.mesh.visible).toBe(true)

    for (let burst = 1; burst <= 20; burst += 1) {
      const observations = sync(layer, effects(burst, [puff(`b${burst}`, burst)]))
      expect(observations).toMatchObject({effectAtlasCreateCount: 0, effectAtlasReuseCount: 1, effectActiveCount: 1})
    }
    expect(layer.atlasState(atlas.resourceKey)).toBe(state)
    expect(scene.children.length).toBe(1)
  })

  test("writes the sampled frame rectangle and uploads only changed buffers", () => {
    const layer = createCosmeticEffectLayer(new THREE.Scene())
    const first = sync(layer, effects(0, [puff("a", 0, {color: "#ff8800", opacity: 0.5})]))
    expect(first.effectBufferUploadCount).toBe(4)
    const state = layer.atlasState(atlas.resourceKey)
    expect(frameRect(state, 0)).toEqual([0, 0.5, 0.5, 0.5])
    expect(state.opacityAttribute.array[0]).toBe(0.5)

    // Same time again: nothing changed, nothing uploaded (this is also a camera-only change).
    const repeat = sync(layer, effects(0, [puff("a", 0, {color: "#ff8800", opacity: 0.5})]))
    expect(repeat.effectBufferUploadCount).toBe(0)

    // Advancing into the last frame only uploads the frame attribute.
    const later = sync(layer, effects(0.35, [puff("a", 0, {color: "#ff8800", opacity: 0.5})]))
    expect(later.effectBufferUploadCount).toBe(1)
    expect(frameRect(state, 0)).toEqual([0.5, 0, 0.5, 0.5])
  })

  test("linear atlases (the default) inset each frame by half a texel; nearest atlases do not", () => {
    // 16x16 atlas, 2x2 cells of 8 texels: half a texel is 1/32 of the texture.
    const {filter: _nearest, ...defaultFilter} = atlas
    const linear = {...defaultFilter, resourceKey: "fixture:puff-linear"}
    const layer = createCosmeticEffectLayer(new THREE.Scene())
    const instances = [puff("n", 0), puff("l", 0, {atlas: linear.resourceKey})]
    sync(layer, {time: 0.35, atlases: [atlas, linear], instances})
    expect(frameRect(layer.atlasState(atlas.resourceKey), 0)).toEqual([0.5, 0, 0.5, 0.5])
    const inset = 1 / 32
    expect(frameRect(layer.atlasState(linear.resourceKey), 0)).toEqual([0.5 + inset, inset, 0.5 - 2 * inset, 0.5 - 2 * inset])
    expect(layer.atlasState(linear.resourceKey).texture.magFilter).toBe(THREE.LinearFilter)
  })

  test("pending and expired effects draw nothing", () => {
    const layer = createCosmeticEffectLayer(new THREE.Scene())
    const observations = sync(layer, effects(1, [puff("early", 0), puff("late", 2), puff("now", 0.9)]))
    expect(observations).toMatchObject({effectActiveCount: 1, effectPendingCount: 1, effectExpiredCount: 1})
    const state = layer.atlasState(atlas.resourceKey)
    expect(state.mesh.count).toBe(1)

    const idle = sync(layer, effects(5, [puff("early", 0)]))
    expect(idle.effectActiveCount).toBe(0)
    expect(state.mesh.count).toBe(0)
    expect(state.mesh.visible).toBe(false)
  })

  test("enforces the budget by keeping the newest effects deterministically", () => {
    const layer = createCosmeticEffectLayer(new THREE.Scene(), {maxInstances: 3})
    const burst = [puff("c", 0.1), puff("a", 0.2), puff("b", 0.2), puff("d", 0), puff("e", 0.3)]
    const observations = sync(layer, effects(0.35, burst))
    expect(observations).toMatchObject({effectActiveCount: 3, effectDroppedCount: 2})
    const reordered = sync(layer, effects(0.35, [...burst].reverse()))
    expect(reordered.effectDroppedCount).toBe(2)
    // The kept set (e, a, b) is independent of submission order, so no slot data changes.
    expect(reordered.effectBufferUploadCount).toBe(0)

    const reduced = sync(layer, effects(0.35, burst, {maxInstances: 1}))
    expect(reduced).toMatchObject({effectActiveCount: 1, effectDroppedCount: 4})
  })

  test("disabled, omitted, and undeclared atlases release every GPU resource", () => {
    const scene = new THREE.Scene()
    const layer = createCosmeticEffectLayer(scene)
    sync(layer, effects(0, [puff("a", 0)]))
    const state = layer.atlasState(atlas.resourceKey)
    const disposed = []
    for (const resource of [state.texture, state.material, state.geometry]) {
      resource.addEventListener("dispose", () => disposed.push(resource.type ?? "texture"))
    }

    const off = sync(layer, effects(0, [puff("a", 0)], {enabled: false}))
    expect(off).toMatchObject({effectAtlasDisposeCount: 1, liveEffectAtlasCount: 0, effectActiveCount: 0})
    expect(disposed.length).toBe(3)
    expect(scene.children.length).toBe(0)

    sync(layer, effects(0, [puff("a", 0)]))
    expect(sync(layer, undefined)).toMatchObject({effectAtlasDisposeCount: 1, liveEffectAtlasCount: 0})
    sync(layer, effects(0, []))
    expect(sync(layer, {time: 0, atlases: [], instances: []}).effectAtlasDisposeCount).toBe(1)
    layer.dispose()
  })

  test("observe reports live counts without per-frame work", () => {
    const layer = createCosmeticEffectLayer(new THREE.Scene())
    sync(layer, effects(0, [puff("a", 0)]))
    const observations = {}
    layer.observe(observations)
    expect(observations).toMatchObject({liveEffectAtlasCount: 1, effectActiveCount: 0, effectBufferUploadCount: 0})
  })
})

describe("cosmetic effect validation", () => {
  const frame = (value) => ({camera, nodes: [], effects: value})

  test("accepts a valid frame", () => {
    expect(() => validateRenderFrame(frame(effects(0, [puff("a", 0, {scale: [1, 2], loops: 2})])))).not.toThrow()
  })

  test.each([
    ["non-finite time", effects(Number.NaN, [])],
    ["unknown atlas", effects(0, [puff("a", 0, {atlas: "missing"})])],
    ["local space", effects(0, [puff("a", 0, {space: "local"})])],
    ["duplicate ids", effects(0, [puff("a", 0), puff("a", 1)])],
    ["zero duration", effects(0, [puff("a", 0, {duration: 0})])],
    ["negative scale", effects(0, [puff("a", 0, {scale: -1})])],
    ["bad origin", effects(0, [puff("a", 0, {origin: [0, Number.NaN, 0]})])],
    ["bad opacity", effects(0, [puff("a", 0, {opacity: 2})])],
    ["bad color", effects(0, [puff("a", 0, {color: "red"})])],
    ["fractional loops", effects(0, [puff("a", 0, {loops: 1.5})])],
    ["negative budget", effects(0, [], {maxInstances: -1})],
    ["short pixels", {time: 0, atlases: [{...atlas, pixels: new Uint8Array(4)}], instances: []}],
    ["frames beyond grid", {time: 0, atlases: [{...atlas, frameCount: 5}], instances: []}],
    ["duplicate atlas", {time: 0, atlases: [atlas, atlas], instances: []}],
    ["cells splitting texels", {time: 0, atlases: [{...createPuffAtlas(), columns: 3, rows: 2, frameCount: 4}], instances: []}],
  ])("rejects %s", (_, value) => {
    expect(() => validateRenderFrame(frame(value))).toThrow(ThreeRendererContractError)
  })

  test("validation reports through the caller's failure function", () => {
    expect(() => validateCosmeticEffects(null, (message) => { throw new Error(`custom: ${message}`) })).toThrow("custom:")
  })
})
