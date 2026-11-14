// Explicit acquisition for the real-release acceptance tier; ordinary tests are offline.
// The Ranger's sword and shield come from the rolling `humanoid-equipment` release (asset-tooling #517): the compact
// index and the full bundle merge its entries in, so the acceptance reads them as before.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve(process.argv[2] ?? "target/ranger-rolling");
const releases = "https://github.com/moritzbrantner/asset-tooling/releases/download/";
const base = `${releases}humanoid-ranger-male/`;
const equipmentBase = `${releases}humanoid-equipment/`;
const ITEMS = ["equipment.sword.arming", "equipment.shield.heater"];
const isItem = (key: string) => key.startsWith("equipment.");
await mkdir(resolve(output, "compact"), { recursive: true });
await mkdir(resolve(output, "full"), { recursive: true });
const observations: { file: string; bytes: number; sha256: string; milliseconds: number }[] = [];
const acquire = async (file: string, path: string, from = base) => {
  const start = performance.now();
  const response = await fetch(from + file, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw Error(`Ranger download ${file}: ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(path, bytes);
  observations.push({
    file,
    bytes: bytes.byteLength,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    milliseconds: performance.now() - start,
  });
  return bytes;
};
const readIndex = async (file: string, from: string) => {
  const index = JSON.parse(new TextDecoder().decode(await acquire(file, resolve(output, "compact", file), from)));
  if (index.schema !== "asset-downloads-v1") {
    throw Error(`unsupported ${file}`);
  }
  return index;
};
const rangerIndex = await readIndex("humanoid-ranger-male.index.json", base);
const equipmentIndex = await readIndex("humanoid-equipment.index.json", equipmentBase);
const index = {
  ...rangerIndex,
  entries: [
    ...rangerIndex.entries.filter((entry: any) => !isItem(entry.key)),
    ...equipmentIndex.entries.filter((entry: any) => isItem(entry.key)),
  ],
};
await writeFile(resolve(output, "compact/humanoid-ranger-male.index.json"), JSON.stringify(index, null, 2));
const entries = index.entries.filter(
  (entry: any) =>
    (entry.key === "humanoid.ranger.male" &&
      ["default", "outfit.knight"].includes(entry.variant)) ||
    (ITEMS.includes(entry.key) && entry.variant === "default"),
);
if (entries.length !== 4) {
  throw Error("Ranger acceptance needs default, knight, sword and shield");
}
const sources = new Map<string, string>();
for (const entry of entries) {
  for (const file of [...entry.files, ...entry.textures, ...(entry.clips ? [entry.clips] : [])]) {
    sources.set(file, isItem(entry.key) ? equipmentBase : base);
  }
}
const files = [...sources.keys()].sort();
if (!files.every((file) => /^[\w.-]+$/.test(file) && file !== "." && file !== "..")) {
  throw Error("unsafe release filename");
}
let next = 0;
const results = await Promise.allSettled(
  Array.from({ length: 6 }, async () => {
    while (next < files.length) {
      const file = files[next++];
      await acquire(file, resolve(output, "compact", file), sources.get(file));
    }
  }),
);
const failure = results.find((result) => result.status === "rejected");
if (failure?.status === "rejected") {
  throw failure.reason;
}
const unpack = async (tar: string, from: string, into: string) => {
  const archive = resolve(output, tar);
  await acquire(tar, archive, from);
  await mkdir(into, { recursive: true });
  const unpacked = Bun.spawnSync(["tar", "-xf", archive, "-C", into]);
  if (unpacked.exitCode !== 0) {
    throw Error(`unpack ${tar}: ${unpacked.stderr}`);
  }
};
await unpack("humanoid.ranger.male.tar", base, resolve(output, "full"));
// The full bundle takes the equipment bundle's items: its content-addressed files beside the Ranger's, and its
// manifest entries in place of the Ranger's own.
const equipmentDir = resolve(output, "full-equipment");
await rm(equipmentDir, { recursive: true, force: true });
await unpack("humanoid.equipment.tar", equipmentBase, equipmentDir);
const manifestPath = resolve(output, "full/manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const equipmentManifest = JSON.parse(await readFile(resolve(equipmentDir, "manifest.json"), "utf8"));
await cp(equipmentDir, resolve(output, "full"), {
  recursive: true, force: false, filter: (path) => !/(manifest|export\.ref)\.json$/.test(path),
});
manifest.assets = [
  ...manifest.assets.filter((asset: any) => !isItem(asset.key)),
  ...equipmentManifest.assets.filter((asset: any) => isItem(asset.key)),
];
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
await writeFile(
  resolve(output, "acquisition.json"),
  JSON.stringify(
    {
      release: base,
      equipment: equipmentBase,
      acquiredAt: new Date().toISOString(),
      files: observations.sort((a, b) => a.file.localeCompare(b.file)),
    },
    null,
    2,
  ),
);
console.log(
  `Acquired ${observations.length} release files (${observations.reduce((n, file) => n + file.bytes, 0)} bytes)`,
);
