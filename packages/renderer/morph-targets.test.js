// Skinned primitives carrying morph targets (asset-tooling humanoid face variants) load
// through the shared character runtime; influences are set per instance by name.
import {expect, test} from "bun:test"
import {readFile} from "node:fs/promises"
import {loadCharacterRuntime} from "./character-runtime.js"

const fox = await readFile(new URL("../../fixtures/imported-character/fox.glb", import.meta.url))
const fail = message => { throw new Error(`imported character: ${message}`) }

function withMorphTarget(bytes) {
  const jsonLength = bytes.readUInt32LE(12)
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString())
  const binaryChunk = Buffer.from(bytes.subarray(20 + jsonLength))
  const primitive = json.meshes[0].primitives[0]
  primitive.targets = [{POSITION: primitive.attributes.POSITION}, {POSITION: primitive.attributes.POSITION}]
  json.meshes[0].weights = [0, 0]
  json.meshes[0].extras = {targetNames: ["smile", "brow"]}
  let text = Buffer.from(JSON.stringify(json))
  text = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 0x20)])
  const header = Buffer.alloc(20)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4)
  header.writeUInt32LE(text.length, 12); header.writeUInt32LE(0x4e4f534a, 16)
  const out = Buffer.concat([header, text, binaryChunk])
  out.writeUInt32LE(out.length, 8)
  return new Uint8Array(out)
}

test("skinned primitive with morph targets loads and takes per-instance named weights", async () => {
  const runtime = await loadCharacterRuntime(withMorphTarget(fox), fail)
  try {
    expect(runtime.morphTargets).toEqual(["smile", "brow"])
    const a = runtime.createInstance()
    const b = runtime.createInstance()
    const meshOf = instance => { let found; instance.root.traverse(node => { if (node.isSkinnedMesh) found = node }); return found }
    expect(meshOf(a).morphTargetInfluences).toEqual([0, 0])
    a.setMorphWeights({brow: 0.75})
    expect(meshOf(a).morphTargetInfluences).toEqual([0, 0.75])
    a.setMorphWeights({smile: 1})
    expect(meshOf(a).morphTargetInfluences).toEqual([1, 0])
    expect(meshOf(b).morphTargetInfluences).toEqual([0, 0])
    expect(() => a.setMorphWeights({frown: 1})).toThrow(/no morph target frown/)
    expect(() => a.setMorphWeights({smile: Number.NaN})).toThrow(/finite/)
    a.seek(runtime.metadata.clips[0].name, 0.1)
  } finally { runtime.dispose() }
})
