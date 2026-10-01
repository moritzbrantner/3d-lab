import {describe, expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {readFileSync} from "node:fs"
import path from "node:path"
import * as THREE from "three"
import {STATIC_GLB_FIXTURES, encodeGlb, octahedron, rockDocument, treeDocument} from "../../scripts/static-glb-fixtures.mjs"
import {sha256Hex} from "./content-hash.js"
import {ThreeRendererContractError, validateRenderFrame} from "./index.js"
import {createMaterial, materialKey} from "./materials.js"
import {createIndexedMeshGeometry} from "./mesh-geometry.js"
import {StaticGlbContractError, adaptStaticGlb, staticGlbInstanceBatches, staticGlbSceneNodes} from "./static-glb.js"

const FIXTURES = path.resolve(import.meta.dir, "../../fixtures/static-glb")
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const camera = {viewMatrix: IDENTITY, projectionMatrix: IDENTITY}
const rockBytes = readFileSync(path.join(FIXTURES, "rock.glb"))
const treeBytes = readFileSync(path.join(FIXTURES, "tree.glb"))

const toSrgbHex = (linear) => `#${new THREE.Color().setRGB(...linear, THREE.LinearSRGBColorSpace).getHexString()}`

function matrixParts(values) {
  const translation = new THREE.Vector3()
  const rotation = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  new THREE.Matrix4().fromArray(values).decompose(translation, rotation, scale)
  return {translation: translation.toArray(), rotation: rotation.toArray(), scale: scale.toArray()}
}

function expectClose(actual, expected, digits = 5) {
  expect(actual.length).toBe(expected.length)
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], digits))
}

/** Re-encodes a fixture after mutating its JSON and/or binary chunk. */
function mutated(build, mutate) {
  const {json, binary} = build()
  const copy = structuredClone(json)
  const bytes = binary.slice()
  mutate(copy, bytes)
  return encodeGlb(copy, bytes)
}

async function rejection(bytes, pattern) {
  let error
  try {
    await adaptStaticGlb(bytes)
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(StaticGlbContractError)
  expect(error).toBeInstanceOf(ThreeRendererContractError)
  expect(error.message).toMatch(pattern)
}

describe("static GLB fixtures", () => {
  test("committed fixtures match the deterministic generator", () => {
    for (const [name, build] of Object.entries(STATIC_GLB_FIXTURES)) {
      const {json, binary} = build()
      expect(Buffer.from(encodeGlb(json, binary)).equals(readFileSync(path.join(FIXTURES, name)))).toBe(true)
    }
  })
})

describe("static GLB adaptation", () => {
  test("rock: one placed node, exact geometry, factor material, and content identity", async () => {
    const asset = await adaptStaticGlb(rockBytes)
    const sha = createHash("sha256").update(rockBytes).digest("hex")
    expect(asset.resourceKey).toBe(`glb-sha256:${sha}`)
    expect(asset.ignoredExtensions).toEqual([])
    expect(asset.nodes.map((node) => [node.index, node.name, node.parent, node.mesh])).toEqual([[0, "rock", null, 0]])
    expect(asset.drawables).toHaveLength(1)

    const [drawable] = asset.drawables
    const source = octahedron(0.5)
    expect(drawable.id).toBe("node=0/mesh=0/primitive=0")
    expect(drawable.geometry.resourceKey).toBe(`glb-sha256:${sha}#mesh=0/primitive=0`)
    expect(drawable.geometry.positions).toEqual(source.positions)
    expect(drawable.geometry.indices).toEqual(source.indices)
    drawable.geometry.normals.forEach((normal, index) => expectClose(normal, source.normals[index]))
    drawable.geometry.uvs.forEach((uv, index) => expectClose(uv, source.uvs[index]))
    expect(drawable.geometry.colors).toBeUndefined()
    expect(drawable.bounds).toEqual({min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5]})

    const parts = matrixParts(drawable.matrix)
    expectClose(parts.translation, [0, 0.5, 0])
    expectClose(parts.rotation, [0, 0.38268343, 0, 0.92387953])
    // Asset bounds conservatively transform each local box: a +-0.5 cube rotated 45 degrees about Y.
    const reach = 0.5 * Math.SQRT2
    expectClose(asset.bounds.min, [-reach, 0, -reach])
    expectClose(asset.bounds.max, [reach, 1, reach])

    expect(drawable.material).toEqual({
      index: 0,
      name: "rock-surface",
      baseColor: toSrgbHex([0.25, 0.27, 0.29]),
      baseColorFactor: [0.25, 0.27, 0.29, 1],
      metallicFactor: 0,
      roughnessFactor: 0.85,
      emissive: null,
      unlit: false,
      doubleSided: true,
    })
    expect(Object.isFrozen(asset) && Object.isFrozen(drawable.geometry) && Object.isFrozen(drawable.geometry.positions[0])).toBe(true)
  })

  test("tree: hierarchy transforms compose parent-first, including a matrix node", async () => {
    const asset = await adaptStaticGlb(treeBytes)
    expect(asset.nodes.map((node) => [node.index, node.name, node.parent, node.children])).toEqual([
      [0, "tree", null, [1, 3]],
      [1, "trunk", 0, [2]],
      [2, "canopy", 1, []],
      [3, "root-flare", 0, []],
    ])
    const world = Object.fromEntries(asset.nodes.map((node) => [node.name, matrixParts(node.worldMatrix)]))
    expectClose(world.tree.scale, [2, 2, 2])
    expectClose(world.trunk.translation, [0, 1, 0])
    // canopy = scale 2 * (trunk T(0, .5, 0)) * (canopy T(0, .75, 0) R(y 45 deg))
    expectClose(world.canopy.translation, [0, 2.5, 0])
    expectClose(world.canopy.rotation, [0, 0.38268343, 0, 0.92387953])
    expectClose(world.canopy.scale, [2, 2, 2])
    expectClose(world["root-flare"].translation, [0, 0.1, 0])
    expectClose(world["root-flare"].scale, [4, 0.2, 4])

    expect(asset.drawables.map((drawable) => drawable.id)).toEqual([
      "node=1/mesh=0/primitive=0",
      "node=2/mesh=1/primitive=0",
      "node=2/mesh=1/primitive=1",
      "node=3/mesh=0/primitive=0",
    ])
    // The canopy's +-0.6 local box, rotated 45 degrees and scaled 2, dominates X/Z and the top.
    const reach = 1.2 * Math.SQRT2
    expectClose(asset.bounds.min, [-reach, 0, -reach])
    expectClose(asset.bounds.max, [reach, 3.7, reach])
  })

  test("tree: shared meshes share one geometry; strided, normalized, and non-indexed data decode exactly", async () => {
    const asset = await adaptStaticGlb(treeBytes)
    const [trunk, foliage, knot, flare] = asset.drawables
    expect(flare.geometry).toBe(trunk.geometry)
    expect(new Set(asset.drawables.map((drawable) => drawable.geometry.resourceKey)).size).toBe(3)

    // Interleaved POSITION/NORMAL (byteStride 24) and UNSIGNED_INT indices.
    expect(trunk.geometry.positions[0]).toEqual([Math.fround(0.1), -0.5, Math.fround(0.1)])
    expect(trunk.geometry.normals.slice(0, 4)).toEqual([[1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0]])
    expect(trunk.geometry.indices.slice(0, 6)).toEqual([0, 1, 2, 0, 2, 3])

    // Normalized UNSIGNED_BYTE COLOR_0 (linear) becomes sRGB components; alpha is dropped.
    const top = foliage.geometry.positions.findIndex(([, y]) => y > 0)
    expectClose(foliage.geometry.colors[top], [128, 200, 64].map((c) => toSrgbComponent(c / 255)), 4)
    expect(foliage.material.emissive).toBe(toSrgbHex([0, 0.02, 0]))
    expect(foliage.material.baseColor).toBe("#ffffff")

    // Non-indexed primitives get sequential indices.
    expect(knot.geometry.indices).toEqual(Array.from({length: 36}, (_, index) => index))
    expect(knot.material).toBe(trunk.material)
  })

  test("content hash is SHA-256 across block-padding edge lengths", () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const bytes = Uint8Array.from({length}, (_, index) => (index * 31 + 7) & 0xff)
      expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"))
    }
  })

  test("identity: same bytes give equal keys, different bytes or caller keys differ", async () => {
    const [first, second, tree, keyed] = await Promise.all([
      adaptStaticGlb(rockBytes),
      adaptStaticGlb(new Uint8Array(rockBytes)),
      adaptStaticGlb(treeBytes),
      adaptStaticGlb(rockBytes, {resourceKey: "sha256:asset-tooling-rock"}),
    ])
    expect(second.drawables[0].geometry.resourceKey).toBe(first.drawables[0].geometry.resourceKey)
    expect(tree.resourceKey).not.toBe(first.resourceKey)
    expect(keyed.drawables[0].geometry.resourceKey).toBe("sha256:asset-tooling-rock#mesh=0/primitive=0")
    await expect(adaptStaticGlb(rockBytes, {resourceKey: " "})).rejects.toThrow(StaticGlbContractError)
  })
})

function toSrgbComponent(linear) {
  return linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055
}

describe("static GLB rejection", () => {
  const cases = [
    ["bad magic", () => Uint8Array.from(rockBytes, (byte, index) => (index === 0 ? 0 : byte)), /binary magic/],
    ["truncated bytes", () => rockBytes.subarray(0, 16), /truncated/],
    ["header length mismatch", () => rockBytes.subarray(0, rockBytes.length - 4), /does not match/],
    ["malformed JSON", () => {
      const bytes = Uint8Array.from(rockBytes)
      bytes[20] = 0x7b + 1
      return bytes
    }, /JSON chunk is malformed/],
    ["missing BIN chunk", () => encodeGlb(rockDocument().json), /BIN chunk is missing/],
    ["required compression extension", () => mutated(rockDocument, (json) => {
      json.extensionsUsed = ["KHR_draco_mesh_compression"]
      json.extensionsRequired = ["KHR_draco_mesh_compression"]
    }), /requires unsupported extension KHR_draco_mesh_compression/],
    ["external buffer URI", () => mutated(rockDocument, (json) => {
      json.buffers[0].uri = "rock.bin"
    }), /uses a URI/],
    ["base color texture", () => mutated(rockDocument, (json) => {
      json.materials[0].pbrMetallicRoughness.baseColorTexture = {index: 0}
    }), /baseColorTexture; textured materials/],
    ["normal texture", () => mutated(rockDocument, (json) => {
      json.materials[0].normalTexture = {index: 0}
    }), /normalTexture/],
    ["alpha mask", () => mutated(rockDocument, (json) => {
      json.materials[0].alphaMode = "MASK"
    }), /alphaMode MASK/],
    ["skins", () => mutated(rockDocument, (json) => {
      json.skins = [{joints: [0]}]
    }), /skinned assets are out of scope/],
    ["animations", () => mutated(rockDocument, (json) => {
      json.animations = [{channels: [], samplers: []}]
    }), /animated assets are out of scope/],
    ["skin attributes", () => mutated(rockDocument, (json) => {
      json.meshes[0].primitives[0].attributes.JOINTS_0 = 0
    }), /attribute JOINTS_0 is unsupported/],
    ["second UV set", () => mutated(rockDocument, (json) => {
      json.meshes[0].primitives[0].attributes.TEXCOORD_1 = 3
    }), /attribute TEXCOORD_1 is unsupported/],
    ["line primitives", () => mutated(rockDocument, (json) => {
      json.meshes[0].primitives[0].mode = 1
    }), /mode 1 is unsupported/],
    ["morph targets", () => mutated(rockDocument, (json) => {
      json.meshes[0].primitives[0].targets = [{POSITION: 0}]
    }), /morph targets/],
    ["missing normals", () => mutated(rockDocument, (json) => {
      delete json.meshes[0].primitives[0].attributes.NORMAL
    }), /missing NORMAL/],
    ["missing positions", () => mutated(rockDocument, (json) => {
      delete json.meshes[0].primitives[0].attributes.POSITION
    }), /missing POSITION/],
    ["dangling material", () => mutated(rockDocument, (json) => {
      json.meshes[0].primitives[0].material = 4
    }), /material 4 does not reference/],
    ["matrix plus TRS", () => mutated(treeDocument, (json) => {
      json.nodes[3].translation = [0, 0, 0]
    }), /both matrix and TRS/],
    ["node with two parents", () => mutated(treeDocument, (json) => {
      json.nodes[3].children = [2]
    }), /more than one parent/],
    ["no scene", () => mutated(rockDocument, (json) => {
      delete json.scene
      json.scenes = []
    }), /no scene/],
    ["misaligned normals", () => mutated(rockDocument, (json) => {
      json.accessors[json.meshes[0].primitives[0].attributes.NORMAL].count = 3
    }), /NORMAL must be 3-component and align/],
    ["index out of range", () => mutated(rockDocument, (json, binary) => {
      const accessor = json.accessors[json.meshes[0].primitives[0].indices]
      const offset = json.bufferViews[accessor.bufferView].byteOffset
      new DataView(binary.buffer).setUint16(offset + 2, 999, true)
    }), /index 999 does not reference/],
    ["non-finite position", () => mutated(rockDocument, (json, binary) => {
      const accessor = json.accessors[json.meshes[0].primitives[0].attributes.POSITION]
      new DataView(binary.buffer).setFloat32(json.bufferViews[accessor.bufferView].byteOffset + 4, Number.NaN, true)
    }), /POSITION contains a non-finite value/],
    ["corrupt UV", () => mutated(rockDocument, (json, binary) => {
      const accessor = json.accessors[json.meshes[0].primitives[0].attributes.TEXCOORD_0]
      new DataView(binary.buffer).setFloat32(json.bufferViews[accessor.bufferView].byteOffset, Number.POSITIVE_INFINITY, true)
    }), /TEXCOORD_0 contains a non-finite value/],
  ]
  for (const [name, bytes, pattern] of cases) {
    test(name, () => rejection(bytes(), pattern))
  }

  test("optional extensions are reported, not applied; unlit is mapped", async () => {
    const asset = await adaptStaticGlb(mutated(rockDocument, (json) => {
      json.extensionsUsed = ["KHR_materials_specular", "KHR_materials_unlit"]
      json.materials[0].extensions = {KHR_materials_unlit: {}}
    }))
    expect(asset.ignoredExtensions).toEqual(["KHR_materials_specular"])
    expect(asset.materials[0].unlit).toBe(true)
    expect(staticGlbSceneNodes(asset, {id: "rock"})[0].unlit).toBe(true)
  })
})

describe("static GLB renderer submission", () => {
  test("scene nodes compose the placement with node matrices and pass frame validation", async () => {
    const asset = await adaptStaticGlb(treeBytes)
    const nodes = staticGlbSceneNodes(asset, {id: "oak-1", transform: {translation: [10, 0, -3]}})
    expect(nodes.map((node) => node.id)).toEqual(asset.drawables.map((drawable) => `oak-1/${drawable.id}`))
    expect(nodes[0].geometry).toBe(asset.drawables[0].geometry)
    expectClose(matrixParts(nodes[1].modelMatrix).translation, [10, 2.5, -3])
    expect(nodes[1]).toMatchObject({color: "#ffffff", emissive: toSrgbHex([0, 0.02, 0]), doubleSided: true})
    expect(() => validateRenderFrame({camera, nodes})).not.toThrow()

    const trunkOnly = staticGlbSceneNodes(asset, {id: "oak-2", filter: (drawable) => drawable.node === 1})
    expect(trunkOnly).toHaveLength(1)
    expect(() => staticGlbSceneNodes(asset, {id: "none", filter: () => false})).toThrow(StaticGlbContractError)
  })

  test("repeated placements share geometry descriptors and material keys", async () => {
    const asset = await adaptStaticGlb(rockBytes)
    const [a] = staticGlbSceneNodes(asset, {id: "rock-a", modelMatrix: IDENTITY})
    const [b] = staticGlbSceneNodes(asset, {id: "rock-b", transform: {translation: [3, 0, 0], scale: [2, 2, 2]}})
    expect(b.geometry).toBe(a.geometry)
    expect(materialKey({node: b, vertexColors: false})).toBe(materialKey({node: a, vertexColors: false}))
    expect(createMaterial({node: a, vertexColors: false}).side).toBe(THREE.DoubleSide)
    expect(createIndexedMeshGeometry(a.geometry).getAttribute("uv").count).toBe(a.geometry.positions.length)
  })

  test("instance batches: one batch per drawable, emissive materials rejected", async () => {
    const rock = await adaptStaticGlb(rockBytes)
    const batches = staticGlbInstanceBatches(rock, {
      id: "rocks",
      revision: "r1",
      instances: [{transform: {translation: [1, 0, 0]}}, {modelMatrix: IDENTITY}],
    })
    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({id: "rocks/node=0/mesh=0/primitive=0", revision: "r1", doubleSided: true, color: rock.materials[0].baseColor})
    expect(batches[0].geometry).toBe(rock.drawables[0].geometry)
    expectClose(matrixParts(batches[0].instances[0].modelMatrix).translation, [1, 0.5, 0])
    expect(() => validateRenderFrame({camera, nodes: [], instanceBatches: batches})).not.toThrow()

    const tree = await adaptStaticGlb(treeBytes)
    expect(() => staticGlbInstanceBatches(tree, {id: "trees", instances: [{}]})).toThrow(/emissive or unlit/)
    const bark = staticGlbInstanceBatches(tree, {id: "trees", instances: [{}], filter: (d) => !d.material.emissive})
    expect(bark).toHaveLength(3)
  })
})

describe("renderer mesh uvs and sidedness", () => {
  const mesh = {kind: "mesh", resourceKey: "k", positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], indices: [0, 1, 2]}
  const frame = (geometry, extra = {}) => ({
    camera,
    nodes: [{id: "n", transform: {translation: [0, 0, 0]}, geometry, color: "#ffffff", ...extra}],
  })

  test("uvs must align with positions and be finite pairs", () => {
    expect(() => validateRenderFrame(frame({...mesh, uvs: [[0, 0], [1, 0], [0, 1]]}))).not.toThrow()
    expect(() => validateRenderFrame(frame({...mesh, uvs: [[0, 0]]}))).toThrow(/uvs must align/)
    expect(() => validateRenderFrame(frame({...mesh, uvs: [[0, 0], [1, 0], [0, Number.NaN]]}))).toThrow(/mesh uv/)
  })

  test("doubleSided must be boolean and splits the material key", () => {
    expect(() => validateRenderFrame(frame(mesh, {doubleSided: "yes"}))).toThrow(/doubleSided/)
    const node = frame(mesh).nodes[0]
    expect(materialKey({node: {...node, doubleSided: true}, vertexColors: false})).not.toBe(materialKey({node, vertexColors: false}))
    expect(createMaterial({node, vertexColors: false}).side).toBe(THREE.FrontSide)
  })
})
