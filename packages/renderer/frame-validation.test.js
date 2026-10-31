import {describe, expect, test} from "bun:test"
import {ThreeRendererContractError, validateFrame, validateRenderFrame} from "./frame-validation.js"

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const camera = {viewMatrix: IDENTITY, projectionMatrix: IDENTITY}

/** Wraps an array so every element read is counted in `reads.count`. */
function counted(values, reads) {
  return new Proxy(values, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads.count += 1
      return Reflect.get(target, key, receiver)
    },
  })
}

/** A strip of `quads` quads with positions, normals, and indices whose element reads are counted. */
function countedMesh(quads, reads) {
  const positions = []
  const normals = []
  const indices = []
  for (let quad = 0; quad < quads; quad += 1) {
    const base = positions.length
    positions.push([quad, 0, 0], [quad + 1, 0, 0], [quad + 1, 1, 0], [quad, 1, 0])
    normals.push([0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1])
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  return {
    kind: "mesh",
    resourceKey: `strip-${quads}`,
    positions: counted(positions, reads),
    normals: counted(normals, reads),
    indices: counted(indices, reads),
  }
}

function meshFrame(geometry) {
  return {camera, nodes: [{id: "ground", geometry, color: "#ffffff", transform: {translation: [0, 0, 0]}}]}
}

function countedBatch(count, reads) {
  const instances = Array.from({length: count}, (_, index) => ({transform: {translation: [index, 0, 0]}}))
  return {
    id: "trees",
    revision: "r1",
    geometry: {kind: "box", size: [1, 1, 1]},
    color: "#336633",
    instances: counted(instances, reads),
  }
}

const meshUploaded = {hasMesh: () => true, hasBatch: () => false}
const batchUploaded = {hasMesh: () => false, hasBatch: (batch) => batch.revision === "r1"}

describe("upload-aware frame validation", () => {
  test("full validation reads every vertex, normal, and index", () => {
    const small = {count: 0}
    const large = {count: 0}
    validateRenderFrame(meshFrame(countedMesh(2, small)))
    validateRenderFrame(meshFrame(countedMesh(2000, large)))
    expect(small.count).toBeGreaterThan(0)
    expect(large.count).toBe(small.count * 1000)
  })

  test("per-frame work for an uploaded mesh does not grow with its vertex count", () => {
    const small = {count: 0}
    const large = {count: 0}
    validateFrame(meshFrame(countedMesh(2, small)), meshUploaded)
    validateFrame(meshFrame(countedMesh(20_000, large)), meshUploaded)
    expect(small.count).toBe(0)
    expect(large.count).toBe(0)
  })

  test("an uploaded mesh is checked by resource key only", () => {
    const invalidPayload = {kind: "mesh", resourceKey: "rock", positions: [[0, Number.NaN, 0]], indices: [0]}
    expect(() => validateFrame(meshFrame(invalidPayload), meshUploaded)).not.toThrow()
    expect(() => validateRenderFrame(meshFrame(invalidPayload))).toThrow(ThreeRendererContractError)
    expect(() => validateFrame(meshFrame({...invalidPayload, resourceKey: " "}), meshUploaded)).toThrow(
      "mesh resourceKey must be a non-empty string",
    )
  })

  test("per-frame work for an uploaded batch revision does not grow with its instance count", () => {
    const small = {count: 0}
    const large = {count: 0}
    validateFrame({camera, nodes: [], instanceBatches: [countedBatch(2, small)]}, batchUploaded)
    validateFrame({camera, nodes: [], instanceBatches: [countedBatch(20_000, large)]}, batchUploaded)
    expect(small.count).toBe(0)
    expect(large.count).toBe(0)

    const changed = {count: 0}
    validateFrame({camera, nodes: [], instanceBatches: [{...countedBatch(3, changed), revision: "r2"}]}, batchUploaded)
    expect(changed.count).toBe(3)
  })
})
