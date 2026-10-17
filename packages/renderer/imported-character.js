import {copyBytes, loadCharacterRuntime, renderImportedCharacterInstances} from "./character-runtime.js"
import {sha256Hex} from "./content-hash.js"
import {assembleGlb, bundleEntry, referencedResources} from "./bundle-glb.js"

function fail(message) { throw new Error(`imported character: ${message}`) }
function provenanceOf(bytes, provenance) {
  const output = provenance?.result?.outputs?.output
  if (!output || output.byteLength !== bytes.byteLength || output.sha256 !== sha256Hex(bytes)) fail("output integrity does not match provenance")
  if (output.metadata?.operation !== "scene.import.gltf" || output.metadata?.operationVersion !== "2" || provenance.analysis?.observations?.accepted !== true ||
      provenance.result.observations?.validatorWarnings?.length !== 0 || provenance.result.observations?.outputValidatorWarnings?.length !== 0 ||
      !provenance.source?.metadata?.license || !provenance.source?.metadata?.provider || output.metadata.sourceSha256 !== provenance.source.sha256 ||
      JSON.stringify(provenance.identity?.inputs?.source) !== JSON.stringify(provenance.source)) fail("validated import provenance is required")
  return structuredClone(provenance)
}
/** Decode GPU resources once; the real Rust bridge owns all rig/clip/pose meaning. */
export async function adaptImportedCharacter(source, options = {}) {
  const bytes = copyBytes(source, fail)
  const provenance = provenanceOf(bytes, options.provenance)
  const runtime = await loadCharacterRuntime(bytes, fail)
  const {metadata} = runtime
  const retained = {
    resourceKey: `glb-sha256:${sha256Hex(bytes)}`,
    provenance: Object.freeze(provenance),
    // Authored skin slots remain distinct from full structural scene nodes.
    skinNodes: Object.freeze([...metadata.skinNodes]),
    clips: Object.freeze(metadata.clips.map(clip => Object.freeze(clip))),
    createInstance: runtime.createInstance,
    dispose: runtime.dispose,
  }
  return Object.freeze(retained)
}
function toBytes(value, what) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return fail(`${what} must resolve to bytes`)
}
/**
 * Load one character from an unpacked asset-tooling `gltf-resources-v1` bundle. Only the
 * entry's glTF and the resources it declares are read, through the caller's
 * `readResource(path)`; there is no implicit network access. Byte lengths are checked;
 * content verification (asset-tooling `verifyAssetBundle`) stays the consumer's choice.
 */
export async function adaptImportedCharacterBundle(bundle, options = {}) {
  const {manifest, key, variant = "default", readResource} = bundle ?? {}
  if (typeof readResource !== "function") fail("bundle readResource must be a function")
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {}
  const entry = bundleEntry(manifest, key, variant, fail)
  const document = toBytes(await readResource(entry.path), "bundle glTF")
  let json
  try { json = JSON.parse(new TextDecoder().decode(document)) } catch { fail(`bundle glTF ${entry.path} is not JSON`) }
  const resources = referencedResources(json, entry, fail)
  const totalBytes = resources.reduce((sum, resource) => sum + resource.byteLength, 0)
  let loadedBytes = 0
  onProgress({loadedBytes, totalBytes})
  const bytesByUri = new Map()
  for (const resource of resources) {
    const bytes = toBytes(await readResource(resource.path), `bundle resource ${resource.path}`)
    if (bytes.byteLength !== resource.byteLength) fail(`bundle resource ${resource.path} has ${bytes.byteLength} bytes, declared ${resource.byteLength}`)
    bytesByUri.set(resource.uri, bytes)
    loadedBytes += bytes.byteLength
    onProgress({loadedBytes, totalBytes})
  }
  const runtime = await loadCharacterRuntime(assembleGlb(json, bytesByUri, fail), fail)
  const {metadata} = runtime
  return Object.freeze({
    resourceKey: `bundle:${key}/${variant}:${entry.sha256}`,
    provenance: Object.freeze(structuredClone({bundle: {profile: manifest.profile, key, variant, sha256: entry.sha256, source: entry.source}})),
    skinNodes: Object.freeze([...metadata.skinNodes]),
    clips: Object.freeze(metadata.clips.map(clip => Object.freeze(clip))),
    createInstance: runtime.createInstance,
    dispose: runtime.dispose,
  })
}
export {renderImportedCharacterInstances}
