import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { assembleGlb, bundleEntry, referencedResources } from "./bundle-glb.js";
import { splitGlbToBundle } from "../../scripts/lib/gltf-resources-bundle.ts";

const fail = message => { throw new Error(message); };
const fox = new Uint8Array(await readFile(new URL("../../fixtures/imported-character/fox.glb", import.meta.url)));

function parseGlb(glb) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  expect(view.getUint32(0, true)).toBe(0x46546c67);
  expect(view.getUint32(8, true)).toBe(glb.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
  const binLength = view.getUint32(20 + jsonLength, true);
  expect(view.getUint32(24 + jsonLength, true)).toBe(0x004e4942);
  return { json, bin: glb.subarray(28 + jsonLength, 28 + jsonLength + binLength) };
}
const viewBytes = ({ json, bin }, index) => {
  const v = json.bufferViews[index];
  return bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
};
function load(bundle) {
  const entry = bundleEntry(bundle.manifest, "fixture.character", "default", fail);
  const json = JSON.parse(new TextDecoder().decode(bundle.files.get(entry.path)));
  const resources = referencedResources(json, entry, fail);
  return { json, entry, bytes: new Map(resources.map(r => [r.uri, bundle.files.get(r.path)])) };
}

test("a split Fox bundle reassembles into a GLB with the same views, images and document", () => {
  const original = parseGlb(fox);
  const bundle = splitGlbToBundle(fox);
  const { json, bytes } = load(bundle);
  const rebuilt = parseGlb(assembleGlb(json, bytes, fail));
  expect(rebuilt.json.buffers).toEqual([{ byteLength: rebuilt.bin.byteLength }]);
  expect(rebuilt.json.accessors).toEqual(original.json.accessors);
  expect(rebuilt.json.animations).toEqual(original.json.animations);
  expect(rebuilt.json.skins).toEqual(original.json.skins);
  original.json.bufferViews.forEach((_, i) => expect(viewBytes(rebuilt, i)).toEqual(viewBytes(original, i)));
  original.json.images.forEach((image, i) => {
    const rebuiltImage = rebuilt.json.images[i];
    expect(rebuiltImage.uri).toBeUndefined();
    expect(rebuiltImage.mimeType).toBe(image.mimeType);
    expect(viewBytes(rebuilt, rebuiltImage.bufferView)).toEqual(viewBytes(original, image.bufferView));
  });
  for (const v of rebuilt.json.bufferViews) expect((v.byteOffset ?? 0) % 4).toBe(0);
});

test("manifest admission requires the gltf-resources-v1 profile and the exact entry", () => {
  const { manifest } = splitGlbToBundle(fox);
  expect(() => bundleEntry({ ...manifest, profile: "static-glb-png-v1" }, "fixture.character", "default", fail)).toThrow(/gltf-resources-v1/);
  expect(() => bundleEntry({ ...manifest, schemaVersion: 3 }, "fixture.character", "default", fail)).toThrow(/schema 4/);
  expect(() => bundleEntry(manifest, "fixture.character", "other", fail)).toThrow(/no fixture.character\/other/);
});

test("every glTF uri must be a declared resource and embedded data URIs are refused", () => {
  const bundle = splitGlbToBundle(fox);
  const entry = bundle.manifest.assets[0];
  const json = JSON.parse(new TextDecoder().decode(bundle.files.get(entry.path)));
  expect(() => referencedResources(json, { ...entry, resources: entry.resources.slice(1) }, fail)).toThrow(/not a declared bundle resource/);
  const embedded = structuredClone(json); embedded.images[0].uri = "data:image/png;base64,AAAA";
  expect(() => referencedResources(embedded, entry, fail)).toThrow(/declared external files/);
});

test("a buffer shorter than its declared glTF byteLength is refused", () => {
  const { json, bytes } = load(splitGlbToBundle(fox));
  const bufferUri = json.buffers[0].uri;
  bytes.set(bufferUri, bytes.get(bufferUri).subarray(0, 16));
  expect(() => assembleGlb(json, bytes, fail)).toThrow(/shorter/);
});
