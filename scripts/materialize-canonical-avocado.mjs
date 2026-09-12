import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const [assetToolingRootArg, outputPathArg] = process.argv.slice(2);
if (!assetToolingRootArg || !outputPathArg) {
  throw new Error("usage: bun scripts/materialize-canonical-avocado.mjs <asset-tooling-root> <output-path>");
}

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const assetToolingRoot = path.resolve(assetToolingRootArg);
const outputPath = path.resolve(outputPathArg);
const fixture = JSON.parse(
  await readFile(path.join(repositoryRoot, "fixtures/catalog/khronos-avocado-glb.asset.json"), "utf8"),
);

const [{ createAssetCatalog }, { readAssetCatalogStorageSource }] = await Promise.all([
  import(pathToFileURL(path.join(assetToolingRoot, "src/catalog.js")).href),
  import(pathToFileURL(path.join(assetToolingRoot, "src/catalog-storage.js")).href),
]);

const providersDocument = JSON.parse(
  await readFile(path.join(assetToolingRoot, "catalog/providers.json"), "utf8"),
);
const sourcesDocument = JSON.parse(
  await readFile(path.join(assetToolingRoot, "catalog/sources.json"), "utf8"),
);
const storageDocument = JSON.parse(
  await readFile(path.join(assetToolingRoot, "catalog/storage.json"), "utf8"),
);
const catalog = createAssetCatalog({
  providers: providersDocument.providers,
  sources: sourcesDocument.sources,
});

const stored = await readAssetCatalogStorageSource({
  catalog,
  storage: storageDocument,
  sourceId: fixture.catalogId,
  storageRoot: assetToolingRoot,
});

function assertEqual(actual, expected, location) {
  if (actual !== expected) {
    throw new Error(`${location} drifted: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

assertEqual(stored.entry.path, fixture.assetTooling.storagePath, "catalog storage path");
assertEqual(stored.source.provider, fixture.source.provider, "catalog provider");
assertEqual(stored.source.source.revision, fixture.source.revision, "catalog source revision");
assertEqual(stored.source.source.path, fixture.source.path, "catalog source path");
assertEqual(stored.source.source.sha256, fixture.source.sha256, "catalog SHA-256");
assertEqual(stored.source.source.byteLength, fixture.source.byteLength, "catalog byte length");
assertEqual(stored.source.license.spdx, fixture.license.spdx, "catalog license SPDX");
assertEqual(stored.source.license.evidenceUrl, fixture.license.evidenceUrl, "catalog license evidence URL");
assertEqual(stored.bytes.byteLength, fixture.source.byteLength, "hydrated byte length");

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, stored.bytes);

console.log(
  JSON.stringify({
    status: "materialized",
    catalogId: fixture.catalogId,
    sha256: fixture.source.sha256,
    byteLength: stored.bytes.byteLength,
    sourceRevision: fixture.source.revision,
    assetToolingRevision: fixture.assetTooling.revision,
    outputPath,
  }),
);
