// asset-tooling #775: a `gltf-resources-v1` character ships no clips of its own; they come in
// `<key>.clips/<family>` clip-library entries (skeleton nodes and one family's clips, no mesh),
// as the live Ranger release does. The bundle entry point binds them by joint name.
import {expect, test} from "bun:test"
import {readFile} from "node:fs/promises"
import {createHash} from "node:crypto"
import {adaptImportedCharacterBundle} from "./imported-character.js"
import {splitGlbToBundle} from "../../scripts/lib/gltf-resources-bundle.ts"

const fox = new Uint8Array(await readFile(new URL("../../fixtures/imported-character/fox.glb", import.meta.url)))
const sha = bytes => createHash("sha256").update(bytes).digest("hex")
const encode = json => new TextEncoder().encode(JSON.stringify(json))

/** The split Fox, texture-free for Bun, with its clips either embedded or in per-family clip libraries. */
function foxBundle(families) {
  const {manifest, files, json} = splitGlbToBundle(fox)
  const [entry] = manifest.assets
  delete json.images; delete json.textures; delete json.samplers
  for (const material of json.materials ?? []) delete material.pbrMetallicRoughness?.baseColorTexture
  entry.resources = entry.resources.filter(resource => resource.uri === json.buffers[0].uri)
  const animations = json.animations
  if (families) {
    delete json.animations
    for (const [variant, names] of Object.entries(families)) {
      const library = {
        asset: json.asset, scene: 0, scenes: [{nodes: json.scenes[0].nodes}],
        nodes: json.nodes.map(({mesh, skin, ...node}) => node),
        accessors: json.accessors, bufferViews: json.bufferViews, buffers: json.buffers,
        animations: animations.filter(clip => names.includes(clip.name)),
      }
      const bytes = encode(library), path = `scenes/fixture.character.clips/${variant}.gltf`
      files.set(path, bytes)
      manifest.assets.push({key: "fixture.character.clips", variant, path, sha256: sha(bytes), resources: entry.resources, attachments: [], source: {kind: "scene"}})
    }
  }
  const document = encode(json)
  files.set(entry.path, document)
  entry.sha256 = sha(document)
  const requests = []
  const readResource = async path => { requests.push(path); return files.get(path) ?? Promise.reject(Error(`missing ${path}`)) }
  return {manifest, key: "fixture.character", readResource, requests}
}

test("a character binds its bundle's clip-library entries by joint name", async () => {
  const embedded = await adaptImportedCharacterBundle(foxBundle())
  const split = foxBundle({move: ["Walk", "Run"], idle: ["Survey"]})
  const shared = await adaptImportedCharacterBundle(split)
  try {
    expect(shared.clips.map(clip => clip.name)).toEqual(["Walk", "Run", "Survey"])
    expect(shared.clips.map(clip => clip.name).sort()).toEqual(embedded.clips.map(clip => clip.name).sort())
    // The shared .bin is read once even though every library declares it.
    expect(split.requests.filter(path => path.endsWith(".bin"))).toHaveLength(1)
    expect(shared.resourceKey).not.toBe(embedded.resourceKey)
    const a = embedded.createInstance(), b = shared.createInstance()
    for (const name of ["Run", "Survey"]) {
      a.seek(name, 0.4); b.seek(name, 0.4)
      a.jointPosition("b_Head_05").forEach((value, i) => expect(b.jointPosition("b_Head_05")[i]).toBeCloseTo(value, 5))
    }
    a.dispose(); b.dispose()
  } finally { embedded.dispose(); shared.dispose() }
})

test("a character without embedded clips or clip libraries stays rejected", async () => {
  const bundle = foxBundle({move: ["Walk"]})
  bundle.manifest.assets = bundle.manifest.assets.filter(asset => asset.key === "fixture.character")
  await expect(adaptImportedCharacterBundle(bundle)).rejects.toThrow(/character has no animation clips/)
})

test("clip libraries may not repeat a clip name", async () => {
  await expect(adaptImportedCharacterBundle(foxBundle({move: ["Walk"], again: ["Walk"]}))).rejects.toThrow(/duplicate clip Walk/)
})
