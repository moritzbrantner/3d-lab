// Inspection-only entry point (#118): original character source bytes pinned
// only by SHA-256 and byte length. Not a production import; it never carries
// provenance and cannot pass `adaptImportedCharacter`'s gate. Decode, pose and
// render go through the same shared runtime as `./imported-character`.
import {copyBytes, loadCharacterRuntime, renderImportedCharacterInstances} from "./character-runtime.js"
import {sha256Hex} from "./content-hash.js"

function fail(message) { throw new Error(`inspection character: ${message}`) }
function verifyPin(bytes, pin) {
  if (typeof pin?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(pin.sha256)) fail("pin sha256 must be 64 lowercase hex characters")
  if (!Number.isSafeInteger(pin.byteLength) || pin.byteLength < 0) fail("pin byteLength must be a non-negative integer")
  if (bytes.byteLength !== pin.byteLength) fail(`source byte length ${bytes.byteLength} does not match pinned byteLength ${pin.byteLength}`)
  if (sha256Hex(bytes) !== pin.sha256) fail("source SHA-256 does not match the pin")
}

/** Verify the pin over a private copy of exactly these bytes, then load for inspection. */
export async function adaptPinnedCharacterSource(source, pin) {
  const bytes = copyBytes(source, fail)
  verifyPin(bytes, pin)
  let runtime
  try { runtime = await loadCharacterRuntime(bytes, fail) }
  catch (error) {
    // The Rust bridge reports plain strings; give callers a real Error.
    const reason = error instanceof Error ? error.message : String(error)
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
