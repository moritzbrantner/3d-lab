// Offline fixture verification delegates processing to asset-tooling's public
// operation/store boundaries. It never rewrites the committed fixture or proof.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [assetToolingRoot, sourcePath] = process.argv.slice(2);
if (!assetToolingRoot || !sourcePath) {
  throw new Error("usage: bun scripts/replay-imported-character-fixture.ts <pinned-asset-tooling-checkout> <explicitly-acquired-Fox.glb>");
}
const fixtureRoot = new URL("../fixtures/imported-character/", import.meta.url);
const proof = JSON.parse(await readFile(new URL("fox.production-import.json", fixtureRoot), "utf8"));
const bytes = await readFile(sourcePath);
assert.equal(bytes.byteLength, proof.source.byteLength);
assert.equal(createHash("sha256").update(bytes).digest("hex"), proof.source.sha256);
const store = await import(pathToFileURL(path.join(assetToolingRoot, "src/asset-store.ts")).href);
const processing = await import(pathToFileURL(path.join(assetToolingRoot, "src/gltf-production-operations.ts")).href);
const temporary = await mkdtemp(path.join(tmpdir(), "imported-character-replay-"));
try {
  const { asset } = await store.storeAssetObject(temporary, {
    bytes, kind: proof.source.kind, mediaType: proof.source.mediaType, metadata: proof.source.metadata,
  });
  assert.deepEqual(asset, proof.source);
  const invocation = { inputs: { source: asset }, parameters: proof.identity.parameters };
  const identity = await processing.createGltfProductionImportOperationBuildIdentity(temporary, invocation);
  assert.deepEqual(identity, proof.identity, "processor/lock/source fingerprint drift must fail closed");
  const result = await processing.executeGltfProductionImportOperation(temporary, invocation);
  const replay = await processing.executeGltfProductionImportOperation(temporary, invocation);
  assert.deepEqual(result, proof.result);
  assert.deepEqual(replay, result);
  const actual = await store.resolveAssetObject(temporary, result.outputs.output);
  assert.deepEqual(actual, await readFile(new URL("fox.glb", fixtureRoot)));
  console.log("Actual Fox import replay and committed fixture bytes match");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
