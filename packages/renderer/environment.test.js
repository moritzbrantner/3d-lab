import {describe, expect, test} from "bun:test"
import * as THREE from "three"
import {createSceneEnvironment} from "./environment.js"
import {ThreeRendererContractError, validateRenderFrame} from "./index.js"

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const DEFAULT_BACKGROUND = 0x0c111a

function frame(environment) {
  return {camera: {viewMatrix: IDENTITY, projectionMatrix: IDENTITY}, nodes: [], environment}
}

function fixture(options = {background: DEFAULT_BACKGROUND, shadows: true}) {
  const scene = new THREE.Scene()
  return {scene, environment: createSceneEnvironment(scene, options)}
}

const DUSK = {
  background: "#1d2440",
  sky: {skyColor: "#8aa4d6", groundColor: 0x2b2418, intensity: 0.6},
  sun: {direction: [-4, 2, 1], color: "#ffb070", intensity: 1.1},
  fog: {color: "#1d2440", near: 20, far: 140},
  shadowFocus: [120, 0, -60],
  shadowExtent: 40,
}

function expectDefaultState({scene, environment}, background = DEFAULT_BACKGROUND) {
  // Reference: the scene state the renderer built before per-frame environments existed.
  const referenceSky = new THREE.HemisphereLight(0xffffff, 0x334433, 1.7)
  const referenceSun = new THREE.DirectionalLight(0xffffff, 2.2)
  referenceSun.position.set(10, 18, 8)

  const {hemisphere, sun} = environment
  expect(hemisphere.color.equals(referenceSky.color)).toBe(true)
  expect(hemisphere.groundColor.equals(referenceSky.groundColor)).toBe(true)
  expect(hemisphere.intensity).toBe(referenceSky.intensity)
  expect(sun.color.equals(referenceSun.color)).toBe(true)
  expect(sun.intensity).toBe(referenceSun.intensity)
  expect(sun.position.toArray()).toEqual([10, 18, 8])
  expect(sun.target.position.toArray()).toEqual([0, 0, 0])
  const camera = sun.shadow.camera
  const referenceCamera = referenceSun.shadow.camera
  expect([camera.left, camera.right, camera.top, camera.bottom, camera.near, camera.far]).toEqual([
    referenceCamera.left,
    referenceCamera.right,
    referenceCamera.top,
    referenceCamera.bottom,
    referenceCamera.near,
    referenceCamera.far,
  ])
  expect(camera.projectionMatrix.equals(referenceCamera.projectionMatrix)).toBe(true)
  if (background === null) {
    expect(scene.background).toBeNull()
  } else {
    expect(scene.background.equals(new THREE.Color(background))).toBe(true)
  }
  expect(scene.fog).toBeNull()
}

function shadowFrustum(sun) {
  sun.updateMatrixWorld()
  sun.shadow.updateMatrices(sun)
  return sun.shadow.getFrustum()
}

describe("renderer scene environment", () => {
  test("an omitted environment reproduces the pre-environment defaults exactly", () => {
    const f = fixture()
    expect(f.scene.children).toEqual([f.environment.hemisphere, f.environment.sun])
    expect(f.environment.sun.castShadow).toBe(true)
    expectDefaultState(f)
    expect(f.environment.apply(undefined)).toBe(0)
    expect(f.environment.apply({})).toBe(0)
    expectDefaultState(f)
  })

  test("an alpha renderer keeps a transparent default and honours an explicit background", () => {
    const f = fixture({background: null, shadows: false})
    expect(f.environment.sun.castShadow).toBe(false)
    expectDefaultState(f, null)

    expect(f.environment.apply({background: "#335577"})).toBe(1)
    expect(f.scene.background.equals(new THREE.Color("#335577"))).toBe(true)
    expect(f.environment.apply(undefined)).toBe(1)
    expect(f.scene.background).toBeNull()
  })

  test("applies background, sky, sun, and fog values through reused Three.js objects", () => {
    const f = fixture()
    const {hemisphere, sun, fog} = f.environment
    const background = f.scene.background

    expect(f.environment.apply(DUSK)).toBe(5)

    expect(f.scene.children).toEqual([hemisphere, sun])
    expect(f.scene.background).toBe(background)
    expect(background.equals(new THREE.Color("#1d2440"))).toBe(true)
    expect(hemisphere.color.equals(new THREE.Color("#8aa4d6"))).toBe(true)
    expect(hemisphere.groundColor.equals(new THREE.Color(0x2b2418))).toBe(true)
    expect(hemisphere.intensity).toBe(0.6)
    expect(sun.color.equals(new THREE.Color("#ffb070"))).toBe(true)
    expect(sun.intensity).toBe(1.1)
    expect(f.scene.fog).toBe(fog)
    expect(fog.color.equals(new THREE.Color("#1d2440"))).toBe(true)
    expect([fog.near, fog.far]).toEqual([20, 140])
  })

  test("an unchanged environment rewrites nothing, even when resubmitted as a new object", () => {
    const f = fixture()
    expect(f.environment.apply(DUSK)).toBe(5)
    const before = {
      background: f.scene.background,
      fog: f.scene.fog,
      sunPosition: f.environment.sun.position.toArray(),
      shadowProjection: f.environment.sun.shadow.camera.projectionMatrix.clone(),
    }

    expect(f.environment.apply(DUSK)).toBe(0)
    expect(f.environment.apply(structuredClone(DUSK))).toBe(0)

    expect(f.scene.background).toBe(before.background)
    expect(f.scene.fog).toBe(before.fog)
    expect(f.environment.sun.position.toArray()).toEqual(before.sunPosition)
    expect(f.environment.sun.shadow.camera.projectionMatrix.equals(before.shadowProjection)).toBe(true)
  })

  test("counts only the environment components whose inputs changed", () => {
    const f = fixture()
    f.environment.apply(DUSK)

    expect(f.environment.apply({...DUSK, shadowFocus: [121, 0, -60]})).toBe(1)
    expect(f.environment.apply({...DUSK, shadowFocus: [121, 0, -60], sun: {...DUSK.sun, intensity: 0}})).toBe(1)
    expect(f.environment.apply({...DUSK, shadowFocus: [121, 0, -60], sun: {...DUSK.sun, intensity: 0}, fog: null})).toBe(1)
    expect(f.scene.fog).toBeNull()
    expect(f.environment.apply({...DUSK, shadowFocus: [121, 0, -60], sun: {...DUSK.sun, intensity: 0}})).toBe(1)
    expect(f.scene.fog).toBe(f.environment.fog)
  })

  test("omitting fields after a custom environment restores every default exactly", () => {
    const f = fixture()
    f.environment.apply(DUSK)

    expect(f.environment.apply(undefined)).toBe(5)

    expectDefaultState(f)
    expect(f.environment.apply(undefined)).toBe(0)
  })

  test("fog null and omitted fog both disable fog", () => {
    const f = fixture()
    expect(f.environment.apply({fog: null})).toBe(0)
    expect(f.environment.apply({fog: DUSK.fog})).toBe(1)
    expect(f.environment.apply({})).toBe(1)
    expect(f.scene.fog).toBeNull()
  })

  test("the sun follows the shadow focus along its direction and frames the focus region", () => {
    const f = fixture()
    const {sun} = f.environment
    f.environment.apply({sun: {...DUSK.sun, direction: [0, 3, 0]}, shadowFocus: [100, 2, -40], shadowExtent: 30})

    expect(sun.target.position.toArray()).toEqual([100, 2, -40])
    expect(new THREE.Vector3().setFromMatrixPosition(sun.target.matrixWorld).toArray()).toEqual([100, 2, -40])
    expect(sun.position.x).toBe(100)
    expect(sun.position.z).toBe(-40)
    expect(sun.position.y).toBeCloseTo(2 + 60, 10)
    const camera = sun.shadow.camera
    expect([camera.left, camera.right, camera.top, camera.bottom, camera.near, camera.far]).toEqual([
      -30, 30, 30, -30, 0.5, 500,
    ])

    const frustum = shadowFrustum(sun)
    const focus = new THREE.Vector3(100, 2, -40)
    for (const offset of [
      [0, 0, 0],
      [29, 0, 0],
      [-29, 0, 0],
      [0, 0, 29],
      [0, 0, -29],
      [0, 29, 0],
      [0, -29, 0],
      [20, 0, 20],
    ]) {
      expect(frustum.containsPoint(focus.clone().add(new THREE.Vector3(...offset)))).toBe(true)
    }
    expect(frustum.containsPoint(focus.clone().add(new THREE.Vector3(31, 0, 0)))).toBe(false)
  })

  test("large shadow extents push the sun back and extend the shadow depth range", () => {
    const f = fixture()
    const {sun} = f.environment
    f.environment.apply({sun: DUSK.sun, shadowFocus: [0, 0, 0], shadowExtent: 400})

    expect(sun.position.length()).toBeCloseTo(800, 9)
    const direction = new THREE.Vector3(...DUSK.sun.direction).normalize()
    expect(sun.position.clone().normalize().distanceTo(direction)).toBeLessThan(1e-12)
    expect(sun.shadow.camera.far).toBe(1600)

    const frustum = shadowFrustum(sun)
    // The far side of the focus sphere, directly away from the sun, is still inside the frustum.
    expect(frustum.containsPoint(direction.clone().multiplyScalar(-399))).toBe(true)
    expect(frustum.containsPoint(direction.clone().multiplyScalar(399))).toBe(true)
  })
})

describe("renderer environment validation", () => {
  test("accepts a complete environment and a frame without one", () => {
    expect(validateRenderFrame(frame(DUSK)).environment).toBe(DUSK)
    expect(validateRenderFrame(frame(undefined)).environment).toBeUndefined()
    expect(validateRenderFrame(frame({fog: null})).environment.fog).toBeNull()
  })

  test.each([
    ["a non-object environment", 7, "render frame environment must be an object"],
    ["an invalid background", {background: "red"}, "environment background must be a 24-bit integer"],
    ["an incomplete sky", {sky: {skyColor: 0xffffff, intensity: 1}}, "environment sky groundColor"],
    [
      "a negative sky intensity",
      {sky: {skyColor: 0xffffff, groundColor: 0, intensity: -1}},
      "environment sky intensity must be finite and non-negative",
    ],
    [
      "a zero sun direction",
      {sun: {direction: [0, 0, 0], color: 0xffffff, intensity: 1}},
      "environment sun direction must be non-zero",
    ],
    [
      "a non-finite sun direction",
      {sun: {direction: [0, Number.NaN, 1], color: 0xffffff, intensity: 1}},
      "environment sun direction must contain exactly 3 finite numbers",
    ],
    [
      "a non-finite sun intensity",
      {sun: {direction: [0, 1, 0], color: 0xffffff, intensity: Number.POSITIVE_INFINITY}},
      "environment sun intensity",
    ],
    ["an invalid fog color", {fog: {color: 0x1000000, near: 1, far: 2}}, "environment fog color"],
    ["fog with far before near", {fog: {color: 0, near: 10, far: 10}}, "0 <= near < far"],
    ["fog with a negative near", {fog: {color: 0, near: -1, far: 10}}, "0 <= near < far"],
    ["a malformed shadow focus", {shadowFocus: [0, 0]}, "environment shadowFocus"],
    ["a zero shadow extent", {shadowExtent: 0}, "environment shadowExtent must be finite and positive"],
  ])("rejects %s", (_, environment, message) => {
    expect(() => validateRenderFrame(frame(environment))).toThrow(ThreeRendererContractError)
    expect(() => validateRenderFrame(frame(environment))).toThrow(message)
  })
})
