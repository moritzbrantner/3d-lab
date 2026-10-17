// Inspection-only entry point (#118, #137): original character source bytes pinned
// only by SHA-256 and byte length, optionally with pinned external .gltf resources,
// and possibly without clips (rest pose only). Not a production import; it never carries
// provenance and cannot pass `adaptImportedCharacter`'s gate. Decode, pose and
// render go through the same shared runtime as `./imported-character`.
import {copyBytes, loadCharacterRuntime, renderImportedCharacterInstances} from "./character-runtime.js"
import {sha256Hex} from "./content-hash.js"
import {assembleGlb} from "./bundle-glb.js"

function fail(message) { throw new Error(`inspection character: ${message}`) }
function verifyPin(bytes, pin) {
  if (typeof pin?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(pin.sha256)) fail("pin sha256 must be 64 lowercase hex characters")
  if (!Number.isSafeInteger(pin.byteLength) || pin.byteLength < 0) fail("pin byteLength must be a non-negative integer")
  if (bytes.byteLength !== pin.byteLength) fail(`source byte length ${bytes.byteLength} does not match pinned byteLength ${pin.byteLength}`)
  if (sha256Hex(bytes) !== pin.sha256) fail("source SHA-256 does not match the pin")
}

/**
 * A `.gltf` document with external buffer/image URIs, assembled with its pinned resources into
 * in-memory GLB bytes. Every external URI must be supplied and every resource pin verified first.
 */
function assemblePinnedGltf(document, resources) {
  if (typeof resources !== "object" || resources === null || Array.isArray(resources)) fail("resources must map glTF URIs to pinned bytes")
  let json
  try { json = JSON.parse(new TextDecoder().decode(document)) } catch { fail("a source with external resources must be glTF JSON") }
  const external = new Set()
  for (const item of json?.buffers ?? []) {
    if (typeof item?.uri !== "string" || item.uri.startsWith("data:")) fail("a source with external resources must reference every buffer by external URI")
    external.add(item.uri)
  }
  for (const image of json?.images ?? []) {
    // Images stored in a bufferView travel with their buffer; data: URIs are not pinned resources.
    if (image?.uri === undefined) continue
    if (typeof image.uri !== "string" || image.uri.startsWith("data:")) fail("a source with external resources must reference images by external URI or bufferView")
    external.add(image.uri)
  }
  const supplied = Object.keys(resources)
  for (const uri of supplied) if (!external.has(uri)) fail(`resource ${uri} is not referenced by the source`)
  const bytesByUri = new Map()
  for (const uri of external) {
    if (!Object.hasOwn(resources, uri)) fail(`external resource ${uri} was not supplied`)
    const resource = resources[uri]
    const bytes = copyBytes(resource?.bytes, fail)
    try { verifyPin(bytes, resource) } catch (error) { fail(`resource ${uri}: ${error.message.replace(/^inspection character: /, "")}`) }
    bytesByUri.set(uri, bytes)
  }
  return assembleGlb(json, bytesByUri, fail)
}

/**
 * Verify the pin over a private copy of exactly these bytes, then load for inspection. A `.gltf`
 * with external buffers/images also needs `options.resources`: each URI mapped to
 * `{bytes, sha256, byteLength}`, all verified before parsing.
 */
export async function adaptPinnedCharacterSource(source, pin, options = {}) {
  const document = copyBytes(source, fail)
  verifyPin(document, pin)
  const bytes = options.resources === undefined ? document : assemblePinnedGltf(document, options.resources)
  let runtime
  try { runtime = await loadCharacterRuntime(bytes, fail) }
  catch (error) {
    // The Rust bridge reports plain strings; give callers a real Error.
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`inspection character: unparsable or invalid glTF/GLB source: ${reason}`, {cause: error})
  }
  // A source without clips (e.g. a body or outfit that ships none) loads with `clips: []` and
  // shows its rest pose; production adapters still require clips.
  const {metadata} = runtime
  const authored = runtime.json.animations ?? []
  const clips = Object.freeze(metadata.clips.map((clip, index) => {
    const name = authored[index]?.name
    return Object.freeze(typeof name === "string" ? {index, duration: clip.duration, name} : {index, duration: clip.duration})
  }))
  // Index (or authored name) to the bridge's clip identity.
  const clipId = clip => {
    if (clips.length === 0) fail("source has no animation clips; only the rest pose is available")
    if (typeof clip === "number") {
      if (!Number.isInteger(clip) || clip < 0 || clip >= clips.length) fail(`clip index ${clip} is out of range 0..${clips.length - 1}`)
      return metadata.clips[clip].name
    }
    if (typeof clip !== "string") fail(`clip selector must be an index or an authored name, got ${typeof clip}`)
    const index = clips.findIndex(entry => entry.name === clip)
    if (index < 0) fail(`unknown clip ${String(clip)}`)
    return metadata.clips[index].name
  }
  return Object.freeze({
    validation: "inspection-only",
    clips,
    createInstance(options) {
      const instance = runtime.createInstance(options)
      return Object.freeze({
        root: instance.root,
        seek: (clip, seconds) => instance.seek(clipId(clip), seconds),
        advance: seconds => instance.advance(seconds),
        dispose: () => instance.dispose(),
      })
    },
    dispose: runtime.dispose,
  })
}
export {renderImportedCharacterInstances}
