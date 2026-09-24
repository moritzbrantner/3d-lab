import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "fixtures/catalog/khronos-simpleskin-embedded.gltf");
const manifestPath = resolve(root, "fixtures/catalog/khronos-simpleskin-embedded.asset.json");
const destination = resolve(root, "web/public/fixtures/khronos-simpleskin-embedded.gltf");

const [bytes, manifestSource] = await Promise.all([readFile(source), readFile(manifestPath, "utf8")]);
const manifest = JSON.parse(manifestSource);
const digest = createHash("sha256").update(bytes).digest("hex");

if (bytes.byteLength !== manifest.source.byteLength) {
  throw new Error(`SimpleSkin byte length drifted: ${bytes.byteLength} != ${manifest.source.byteLength}`);
}
if (digest !== manifest.source.sha256) {
  throw new Error(`SimpleSkin sha256 drifted: ${digest} != ${manifest.source.sha256}`);
}

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
console.log(`Synced canonical Khronos SimpleSkin fixture (${bytes.byteLength} bytes, ${digest.slice(0, 12)}…)`);
