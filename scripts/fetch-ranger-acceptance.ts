// Explicit acquisition for the real-release acceptance tier; ordinary tests are offline.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve(process.argv[2] ?? "target/ranger-rolling");
const base =
  "https://github.com/moritzbrantner/asset-tooling/releases/download/humanoid-ranger-male/";
await mkdir(resolve(output, "compact"), { recursive: true });
await mkdir(resolve(output, "full"), { recursive: true });
const observations: { file: string; bytes: number; sha256: string; milliseconds: number }[] = [];
const acquire = async (file: string, path: string) => {
  const start = performance.now();
  const response = await fetch(base + file, { signal: AbortSignal.timeout(120_000) });
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
const indexBytes = await acquire(
  "humanoid-ranger-male.index.json",
  resolve(output, "compact/humanoid-ranger-male.index.json"),
);
const index = JSON.parse(new TextDecoder().decode(indexBytes));
if (index.schema !== "asset-downloads-v1") {
  throw Error("unsupported Ranger release index");
}
const entries = index.entries.filter(
  (entry: any) =>
    (entry.key === "humanoid.ranger.male" &&
      ["default", "outfit.knight"].includes(entry.variant)) ||
    (["equipment.sword.arming", "equipment.shield.heater"].includes(entry.key) &&
      entry.variant === "default"),
);
if (entries.length !== 4) {
  throw Error("Ranger acceptance needs default, knight, sword and shield");
}
const files = [
  ...new Set<string>(
    entries.flatMap((entry: any) => [
      ...entry.files,
      ...entry.textures,
      ...(entry.clips ? [entry.clips] : []),
    ]),
  ),
].sort();
if (!files.every((file) => /^[\w.-]+$/.test(file) && file !== "." && file !== "..")) {
  throw Error("unsafe release filename");
}
let next = 0;
const results = await Promise.allSettled(
  Array.from({ length: 6 }, async () => {
    while (next < files.length) {
      const file = files[next++];
      await acquire(file, resolve(output, "compact", file));
    }
  }),
);
const failure = results.find((result) => result.status === "rejected");
if (failure?.status === "rejected") {
  throw failure.reason;
}
const archive = resolve(output, "humanoid.ranger.male.tar");
await acquire("humanoid.ranger.male.tar", archive);
const unpacked = Bun.spawnSync(["tar", "-xf", archive, "-C", resolve(output, "full")]);
if (unpacked.exitCode !== 0) {
  throw Error(`unpack Ranger: ${unpacked.stderr}`);
}
await writeFile(
  resolve(output, "acquisition.json"),
  JSON.stringify(
    {
      release: base,
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
