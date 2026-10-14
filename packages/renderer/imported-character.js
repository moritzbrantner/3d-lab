import {copyBytes, loadCharacterRuntime, renderImportedCharacterInstances} from "./character-runtime.js"
import {sha256Hex} from "./content-hash.js"

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
export {renderImportedCharacterInstances}
