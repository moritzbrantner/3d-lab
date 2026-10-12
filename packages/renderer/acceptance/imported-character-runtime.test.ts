// Independent #87: browser-dependent runtime contracts live in the mandatory
// scripts/imported-character-browser-acceptance.ts; no DOM or texture doubles.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
const root = new URL("../../../", import.meta.url);
const bytes = await readFile(new URL("fixtures/imported-character/fox.glb", root));
test("public imported-character runtime is exported", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  expect(manifest.exports["./imported-character"], "public retained asset/instance runtime is absent").toBeDefined();
});

// Mutate real production GLB data, preserving valid framing and all unrelated bytes.
function mutate(change: (json: any, binary: Buffer) => void): Buffer {
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20,20+jsonLength).toString());
  const binary = Buffer.from(bytes.subarray(28+jsonLength)); change(json,binary);
  const encoded = Buffer.from(JSON.stringify(json)); const padded = Buffer.alloc(Math.ceil(encoded.length/4)*4,0x20); encoded.copy(padded);
  const result = Buffer.alloc(28+padded.length+binary.length);
  result.writeUInt32LE(0x46546c67,0); result.writeUInt32LE(2,4); result.writeUInt32LE(result.length,8);
  result.writeUInt32LE(padded.length,12); result.writeUInt32LE(0x4e4f534a,16); padded.copy(result,20);
  result.writeUInt32LE(binary.length,20+padded.length); result.writeUInt32LE(0x004e4942,24+padded.length); binary.copy(result,28+padded.length);
  return result;
}
function accessorOffset(json: any, index: number): number {
  const accessor = json.accessors[index]; return (json.bufferViews[accessor.bufferView].byteOffset ?? 0)+(accessor.byteOffset ?? 0);
}
const malformed: Array<[string, RegExp, (json: any, binary: Buffer) => void]> = [
  ["dangling active joint", /joint|skin/i, (j,b) => { b.writeUInt16LE(24, accessorOffset(j,j.meshes[0].primitives[0].attributes.JOINTS_0)); }],
  ["nonfinite weight", /weight|influence/i, (j,b) => { b.writeFloatLE(NaN, accessorOffset(j,j.meshes[0].primitives[0].attributes.WEIGHTS_0)); }],
  ["negative weight", /weight|influence/i, (j,b) => { b.writeFloatLE(-1, accessorOffset(j,j.meshes[0].primitives[0].attributes.WEIGHTS_0)); }],
  ["zero weight tuple", /weight|influence/i, (j,b) => { b.fill(0,accessorOffset(j,j.meshes[0].primitives[0].attributes.WEIGHTS_0),accessorOffset(j,j.meshes[0].primitives[0].attributes.WEIGHTS_0)+16); }],
  ["nonfinite inverse bind", /bind|matrix/i, (j,b) => { b.writeFloatLE(Infinity,accessorOffset(j,j.skins[0].inverseBindMatrices)); }],
  ["dangling clip target", /target|node/i, j => { j.animations[0].channels[0].target.node=26; }],
  ["unsupported cubic interpolation", /interpolation|cubic/i, j => { j.animations[0].samplers[0].interpolation="CUBICSPLINE"; }],
];
 test("negative fixtures retain real GLB framing and change the targeted input", () => {
  for (const [, , change] of malformed) {
    const damaged = mutate(change);
    expect(damaged.readUInt32LE(0)).toBe(0x46546c67);
    expect(damaged.readUInt32LE(8)).toBe(damaged.byteLength);
    expect(damaged.equals(bytes)).toBe(false);
    const length = damaged.readUInt32LE(12);
    expect(() => JSON.parse(damaged.subarray(20,20+length).toString())).not.toThrow();
  }
 });
