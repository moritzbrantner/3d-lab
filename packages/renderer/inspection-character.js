// Inspection-only entry point (#118): original character source bytes pinned
// only by SHA-256 and byte length. Not a production import; it never carries
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

/** Animation count declared by a GLB or glTF JSON document, or undefined when it cannot be read. */
function declaredAnimationCount(bytes) {
  let text
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (bytes.byteLength >= 20 && view.getUint32(0, true) === 0x46546c67) {
      const length = view.getUint32(12, true)
      if (view.getUint32(16, true) !== 0x4e4f534a || 20 + length > bytes.byteLength) return undefined
      text = new TextDecoder().decode(bytes.subarray(20, 20 + length))
    } else {
      text = new TextDecoder().decode(bytes)
    }
    const json = JSON.parse(text)
    // Only a skinned glTF character (asset.version, meshes and skins) counts as clipless; anything
    // else is left to the runtime and reported as an invalid source.
    if (typeof json !== "object" || json === null || typeof json.asset?.version !== "string"
      || !Array.isArray(json.meshes) || json.meshes.length === 0
      || !Array.isArray(json.skins) || json.skins.length === 0) return undefined
    if (json.animations === undefined) return 0
    return Array.isArray(json.animations) ? json.animations.length : undefined
  } catch { return undefined }
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
  for (const item of [...(json?.buffers ?? []), ...(json?.images ?? [])]) {
    if (typeof item?.uri !== "string" || item.uri.startsWith("data:")) fail("a source with external resources must reference every buffer and image by external URI")
    external.add(item.uri)
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
    // Clipless only when the parser itself failed on the clip list of a well-formed skinned
    // document declaring no animations; every other failure stays an invalid-source error.
    // Only the formats crate's empty/duplicate clip-name rejection; its generic "glTF node/skin/clip:"
    // validation prefix covers unrelated malformed input and must stay an invalid-source error.
    if (reason.includes("clip names must be present and unique") && declaredAnimationCount(bytes) === 0) {
      throw new Error("inspection character: source has no animation clips", {cause: error})
    }
    throw new Error(`inspection character: unparsable or invalid glTF/GLB source: ${reason}`, {cause: error})
  }
  const {metadata} = runtime
  if (metadata.clips.length === 0) { runtime.dispose(); fail("source has no animation clips") }
  const authored = runtime.json.animations ?? []
  const clips = Object.freeze(metadata.clips.map((clip, index) => {
    const name = authored[index]?.name
    return Object.freeze(typeof name === "string" ? {index, duration: clip.duration, name} : {index, duration: clip.duration})
  }))
  // Index (or authored name) to the bridge's clip identity.
  const clipId = clip => {
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
