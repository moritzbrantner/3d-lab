// #184: rigid, node-animated asset-tooling `zoo-animals` entries (quadruped-rigid zebra,
// biped-rigid penguin) load through the shared Rust character runtime in Bun.
import {expect, test} from "bun:test"
import {readFile} from "node:fs/promises"
import * as THREE from "three"
import {adaptImportedCharacterBundle} from "./imported-character.js"

const fixture = new URL("../../fixtures/zoo-animals/", import.meta.url)
const manifest = JSON.parse(await readFile(new URL("manifest.json", fixture), "utf8"))
const readResource = async path => new Uint8Array(await readFile(new URL(path, fixture)))
const nodeNamed = (instance, name) => instance.root.getObjectByName(name)
const world = (instance, name) => { instance.root.updateMatrixWorld(true); return nodeNamed(instance, name).matrixWorld.toArray() }
const differs = (a, b) => a.some((value, i) => Math.abs(value - b[i]) > 1e-4)

test("fixture files are byte-identical to the pinned zoo-animals release tar", async () => {
  const source = JSON.parse(await readFile(new URL("source.json", fixture), "utf8"))
  expect(source.tar.sha256).toBe("10478f08b43b05a7a36ff481584d09ef30cef829f56c6b4fbe9bb7465c767f18")
  for (const [path, sha256] of Object.entries(source.files)) {
    expect(new Bun.CryptoHasher("sha256").update(await readResource(path)).digest("hex")).toBe(sha256)
  }
  for (const asset of manifest.assets) {
    expect(asset.observations.skins).toBe(0)
    expect(new Bun.CryptoHasher("sha256").update(await readResource(asset.path)).digest("hex")).toBe(asset.sha256)
  }
})

for (const key of ["zoo.animal.zebra", "zoo.animal.penguin"]) {
  test(`${key}/expressive animates rigid parts from Rust node poses`, async () => {
    const asset = await adaptImportedCharacterBundle({manifest, key, variant: "expressive", readResource})
    try {
      expect(asset.skinNodes).toEqual([])
      expect(asset.clips.map(clip => clip.name)).toEqual(["idle", "walk", "feed", "rest"])
      expect(asset.provenance.bundle).toMatchObject({profile: "gltf-resources-v1", key, variant: "expressive"})
      const a = asset.createInstance(), b = asset.createInstance()
      const meshes = instance => { const list = []; instance.root.traverse(node => { if (node.isMesh) list.push(node) }); return list }
      expect(meshes(a).length).toBeGreaterThan(8)
      expect(meshes(a).some(mesh => mesh.isSkinnedMesh)).toBe(false)
      meshes(a).forEach((mesh, i) => {
        expect(mesh.geometry).toBe(meshes(b)[i].geometry)
        expect(mesh.material).toBe(meshes(b)[i].material)
      })
      a.seek("walk", 0)
      b.seek("walk", 0)
      const rest = world(a, "leg_0_lower")
      a.seek("walk", 0.25)
      const moved = world(a, "leg_0_lower")
      expect(differs(rest, moved)).toBe(true)
      // Instances are independent: `b` keeps its own pose.
      expect(differs(world(b, "leg_0_lower"), rest)).toBe(false)
      // The decoded node follows the Rust world transform (character space).
      const position = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(world(a, "head")))
      a.jointPosition("head").forEach((value, i) => expect(value).toBeCloseTo(position.getComponent(i), 4))
      a.transition("idle", 0.2)
      a.advance(0.1)
      const blending = world(a, "leg_0_lower")
      a.advance(0.2)
      expect(differs(blending, world(a, "leg_0_lower"))).toBe(true)
      expect(() => a.seek("run", 0)).toThrow(/unknown clip/)
      a.dispose()
      expect(() => a.advance(0.1)).toThrow(/disposed/)
      b.advance(0.1)
    } finally { asset.dispose() }
  })
}

test("rigid entries without animated parts stay rejected", async () => {
  const entry = manifest.assets.find(asset => asset.key === "zoo.animal.zebra")
  const stripped = async path => {
    if (path !== entry.path) return readResource(path)
    const json = JSON.parse(new TextDecoder().decode(await readResource(path)))
    delete json.animations
    return new TextEncoder().encode(JSON.stringify(json))
  }
  await expect(adaptImportedCharacterBundle({manifest, key: entry.key, variant: "expressive", readResource: stripped}))
    .rejects.toThrow(/rigid mesh node driven by an animated node/)
})
