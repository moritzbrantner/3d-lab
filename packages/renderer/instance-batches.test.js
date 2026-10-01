import {describe, expect, test} from "bun:test"
import * as THREE from "three"
import {ThreeRendererContractError, validateRenderFrame} from "./index.js"
import {attachInstanceBatchResult, syncInstanceBatch} from "./instance-batches.js"

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const camera = {viewMatrix: IDENTITY, projectionMatrix: IDENTITY}

function scratch() {
  return {matrix: new THREE.Matrix4(), color: new THREE.Color()}
}

function writeTranslation(matrix, instance) {
  matrix.makeTranslation(...instance.transform.translation)
}

function batch(count, extra = {}) {
  return {
    id: "trees",
    geometry: {kind: "box", size: [1, 1, 1]},
    color: "#336633",
    instances: Array.from({length: count}, (_, index) => ({transform: {translation: [index, 0, 0]}})),
    ...extra,
  }
}

describe("instance batch sync", () => {
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const material = new THREE.MeshStandardMaterial()

  test("uploads matrices and per-instance colors, falling back to the batch color", () => {
    const input = batch(3)
    input.instances[1].color = "#ff0000"
    const {state, created, uploaded} = syncInstanceBatch(
      undefined,
      input,
      geometry,
      material,
      writeTranslation,
      scratch(),
    )

    expect(created).toBe(true)
    expect(uploaded).toBe(true)
    expect(state.mesh.count).toBe(3)
    const matrix = new THREE.Matrix4()
    state.mesh.getMatrixAt(2, matrix)
    expect(new THREE.Vector3().setFromMatrixPosition(matrix).x).toBe(2)
    const color = new THREE.Color()
    state.mesh.getColorAt(1, color)
    expect(color.getHexString()).toBe("ff0000")
    state.mesh.getColorAt(0, color)
    expect(color.getHexString()).toBe(new THREE.Color("#336633").getHexString())
    expect(state.mesh.boundingSphere.center.x).toBeCloseTo(1)
  })

  test("skips re-upload while the revision is unchanged and uploads when it changes", () => {
    const first = syncInstanceBatch(
      undefined,
      batch(2, {revision: "a"}),
      geometry,
      material,
      writeTranslation,
      scratch(),
    )
    const same = syncInstanceBatch(
      first.state,
      batch(2, {revision: "a"}),
      geometry,
      material,
      writeTranslation,
      scratch(),
    )
    expect(same.created).toBe(false)
    expect(same.uploaded).toBe(false)
    expect(same.state.mesh).toBe(first.state.mesh)

    const changed = syncInstanceBatch(
      same.state,
      batch(1, {revision: "b"}),
      geometry,
      material,
      writeTranslation,
      scratch(),
    )
    expect(changed.uploaded).toBe(true)
    expect(changed.state.mesh.count).toBe(1)
  })

  test("always uploads batches without a revision", () => {
    const first = syncInstanceBatch(undefined, batch(2), geometry, material, writeTranslation, scratch())
    const next = syncInstanceBatch(first.state, batch(2), geometry, material, writeTranslation, scratch())
    expect(next.uploaded).toBe(true)
  })

  test("grows capacity by replacing the mesh and reports the replaced mesh for disposal", () => {
    const first = syncInstanceBatch(undefined, batch(2), geometry, material, writeTranslation, scratch())
    const grown = syncInstanceBatch(first.state, batch(3), geometry, material, writeTranslation, scratch())
    expect(grown.created).toBe(true)
    expect(grown.replacedMesh).toBe(first.state.mesh)
    expect(grown.state.mesh.instanceMatrix.count).toBe(4)
    expect(grown.state.mesh.count).toBe(3)
  })

  test("counts a capacity-growth replacement as one removal and one creation", () => {
    const scene = new THREE.Scene()
    const observations = () => ({objectCreateCount: 0, objectRemoveCount: 0, instanceUploadCount: 0})
    const first = syncInstanceBatch(undefined, batch(2), geometry, material, writeTranslation, scratch())
    attachInstanceBatchResult(scene, first, false, observations())

    const grownObservations = observations()
    const grown = syncInstanceBatch(first.state, batch(3), geometry, material, writeTranslation, scratch())
    attachInstanceBatchResult(scene, grown, false, grownObservations)

    expect(grownObservations).toEqual({objectCreateCount: 1, objectRemoveCount: 1, instanceUploadCount: 1})
    expect(scene.children).toEqual([grown.state.mesh])
  })

  test("re-uploads when geometry changes under an unchanged revision", () => {
    const first = syncInstanceBatch(
      undefined,
      batch(1, {revision: "a"}),
      geometry,
      material,
      writeTranslation,
      scratch(),
    )
    const next = syncInstanceBatch(
      first.state,
      batch(1, {revision: "a"}),
      new THREE.BoxGeometry(2, 2, 2),
      material,
      writeTranslation,
      scratch(),
    )
    expect(next.uploaded).toBe(true)
  })

  test("hides empty batches", () => {
    const {state} = syncInstanceBatch(undefined, batch(0), geometry, material, writeTranslation, scratch())
    expect(state.mesh.visible).toBe(false)
  })
})

describe("instance batch contract validation", () => {
  test("accepts a frame with transform and matrix instances", () => {
    const frame = {
      camera,
      nodes: [],
      instanceBatches: [
        {
          id: "rocks",
          geometry: {kind: "sphere", radius: 1},
          color: 0x888888,
          revision: "v1",
          instances: [{transform: {translation: [0, 0, 0]}, color: "#aaaaaa"}, {modelMatrix: IDENTITY}],
        },
      ],
    }
    expect(validateRenderFrame(frame)).toBe(frame)
  })

  test.each([
    ["duplicate batch ids", {instanceBatches: [batch(1), batch(1)]}],
    ["empty revision", {instanceBatches: [batch(1, {revision: ""})]}],
    ["non-array instances", {instanceBatches: [{...batch(0), instances: null}]}],
    [
      "instance with both matrix and transform",
      {instanceBatches: [{...batch(0), instances: [{modelMatrix: IDENTITY, transform: {translation: [0, 0, 0]}}]}]},
    ],
    ["invalid instance color", {instanceBatches: [{...batch(0), instances: [{modelMatrix: IDENTITY, color: "red"}]}]}],
    ["non-finite translation", {instanceBatches: [{...batch(0), instances: [{transform: {translation: [0, NaN, 0]}}]}]}],
  ])("rejects %s", (_, extra) => {
    expect(() => validateRenderFrame({camera, nodes: [], ...extra})).toThrow(ThreeRendererContractError)
  })
})
