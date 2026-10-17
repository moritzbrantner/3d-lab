// Internal: admits one asset-tooling `gltf-resources-v1` bundle entry and assembles its
// glTF plus declared external resources into in-memory GLB bytes for the shared
// character runtime. Transport only: Rust still owns every rig/clip/pose meaning.

export const GLTF_RESOURCES_PROFILE = "gltf-resources-v1"
const GLB_MAGIC = 0x46546c67, JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942

const pad4 = n => (n + 3) & ~3

/** The exact key/variant entry of a schema-4 `gltf-resources-v1` manifest. */
export function bundleEntry(manifest, key, variant, fail) {
  if (manifest?.schemaVersion !== 4 || manifest.profile !== GLTF_RESOURCES_PROFILE) fail(`bundle manifest must be ${GLTF_RESOURCES_PROFILE} schema 4`)
  if (typeof key !== "string" || typeof variant !== "string") fail("bundle key and variant must be strings")
  const entry = Array.isArray(manifest.assets) ? manifest.assets.find(asset => asset?.key === key && asset?.variant === variant) : undefined
  if (!entry) fail(`bundle has no ${key}/${variant} entry`)
  if (typeof entry.path !== "string" || !entry.path.endsWith(".gltf")) fail(`bundle entry ${key}/${variant} has no glTF path`)
  if (!Array.isArray(entry.resources)) fail(`bundle entry ${key}/${variant} declares no resources`)
  for (const resource of entry.resources) {
    if (typeof resource?.uri !== "string" || typeof resource.path !== "string" || !Number.isSafeInteger(resource.byteLength) || resource.byteLength < 0) fail("bundle resource needs uri, path and byteLength")
  }
  return entry
}

/** Every external buffer/image URI the glTF uses, each of which must be a declared resource. */
export function referencedResources(json, entry, fail) {
  const declared = new Map(entry.resources.map(resource => [resource.uri, resource]))
  const uris = new Set()
  for (const item of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (item.uri === undefined) continue
    if (typeof item.uri !== "string" || item.uri.startsWith("data:")) fail("bundle glTF resources must be declared external files")
    if (!declared.has(item.uri)) fail(`glTF uri ${item.uri} is not a declared bundle resource`)
    uris.add(item.uri)
  }
  return [...uris].map(uri => declared.get(uri))
}

/** One GLB: all buffers, then all external images, as views into a single BIN chunk. */
export function assembleGlb(json, bytesByUri, fail) {
  const doc = structuredClone(json)
  const parts = []
  let length = 0
  const append = bytes => { const offset = length; parts.push([offset, bytes]); length = pad4(offset + bytes.byteLength); return offset }
  const bufferOffsets = (doc.buffers ?? []).map((buffer, index) => {
    if (buffer.uri === undefined) fail(`glTF buffer ${index} has no uri`)
    const bytes = bytesByUri.get(buffer.uri)
    if (bytes.byteLength < buffer.byteLength) fail(`glTF buffer ${index} is shorter than its byteLength`)
    return append(bytes.subarray(0, buffer.byteLength))
  })
  doc.bufferViews = (doc.bufferViews ?? []).map(view => ({...view, buffer: 0, byteOffset: (view.byteOffset ?? 0) + bufferOffsets[view.buffer]}))
  for (const image of doc.images ?? []) {
    if (image.uri === undefined) continue
    const bytes = bytesByUri.get(image.uri)
    const offset = append(bytes)
    image.bufferView = doc.bufferViews.push({buffer: 0, byteOffset: offset, byteLength: bytes.byteLength}) - 1
    delete image.uri
  }
  doc.buffers = [{byteLength: length}]
  const jsonBytes = new TextEncoder().encode(JSON.stringify(doc))
  const jsonLength = pad4(jsonBytes.byteLength)
  const total = 12 + 8 + jsonLength + 8 + length
  const glb = new Uint8Array(total)
  const view = new DataView(glb.buffer)
  view.setUint32(0, GLB_MAGIC, true); view.setUint32(4, 2, true); view.setUint32(8, total, true)
  view.setUint32(12, jsonLength, true); view.setUint32(16, JSON_CHUNK, true)
  glb.fill(0x20, 20, 20 + jsonLength); glb.set(jsonBytes, 20)
  const bin = 20 + jsonLength
  view.setUint32(bin, length, true); view.setUint32(bin + 4, BIN_CHUNK, true)
  for (const [offset, bytes] of parts) glb.set(bytes, bin + 8 + offset)
  return glb
}
