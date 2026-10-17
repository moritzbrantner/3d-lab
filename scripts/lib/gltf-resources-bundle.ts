// Test/acceptance helper: split a single-buffer GLB into an asset-tooling style
// `gltf-resources-v1` bundle (glTF JSON + one .bin + one file per embedded image),
// mirroring the shape of real asset-tooling bundles. Not a production exporter.
import { createHash } from "node:crypto";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const ext: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg" };

export function splitGlbToBundle(glb: Uint8Array, key = "fixture.character", variant = "default") {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
  const bin = glb.subarray(28 + jsonLength, 28 + jsonLength + view.getUint32(20 + jsonLength, true));
  const files = new Map<string, Uint8Array>();
  const resources: Array<Record<string, unknown>> = [];
  const declare = (bytes: Uint8Array, mediaType: string, extension: string) => {
    const hash = sha(bytes), path = `resources/${hash}.${extension}`;
    if (!files.has(path)) { files.set(path, bytes); resources.push({ byteLength: bytes.byteLength, mediaType, path, sha256: hash, uri: `../../${path}` }); }
    return `../../${path}`;
  };
  const imageViews = new Set<number>();
  for (const image of json.images ?? []) {
    const v = json.bufferViews[image.bufferView];
    const bytes = bin.slice(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
    imageViews.add(image.bufferView);
    image.uri = declare(bytes, image.mimeType, ext[image.mimeType] ?? "bin");
    delete image.bufferView;
  }
  // Images keep their (now unreferenced) view bytes in the .bin, as real exporters may.
  json.buffers = [{ byteLength: bin.byteLength, uri: declare(bin.slice(), "application/octet-stream", "bin") }];
  const gltf = new TextEncoder().encode(JSON.stringify(json));
  const path = `scenes/${key}/${variant}.gltf`;
  files.set(path, gltf);
  const manifest = { schemaVersion: 4, profile: "gltf-resources-v1", policy: {},
    assets: [{ key, variant, path, sha256: sha(gltf), resources, attachments: [], source: { kind: "scene" } }] };
  return { manifest, files, json, imageViews };
}
