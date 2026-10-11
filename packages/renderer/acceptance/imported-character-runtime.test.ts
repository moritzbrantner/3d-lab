// Independent #87 contract. Proposed public names may be translated independently;
// real imported resources, sampled poses and failure atomicity may not be weakened.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Matrix4, Vector3, type Object3D, type SkinnedMesh } from "three";

const root = new URL("../../../", import.meta.url);
const bytes = await readFile(new URL("fixtures/imported-character/fox.glb", root));
const proof = JSON.parse(await readFile(new URL("fixtures/imported-character/fox.production-import.json", root), "utf8"));
const oracle = JSON.parse(await readFile(new URL("fixtures/imported-character/fox.pose-oracle.json", root), "utf8"));
type Instance = { root: Object3D; seek(clip: string, seconds: number): Promise<void> | void;
  transition(clip: string, durationSeconds: number): Promise<void> | void;
  advance(deltaSeconds: number): Promise<void> | void };
type Asset = { createInstance(options?: { modelMatrix: readonly number[] }): Instance };
type Runtime = { adaptImportedCharacter(source: ArrayBufferView, options: { provenance: unknown }): Promise<Asset> };

async function runtime(): Promise<Runtime> {
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const entry = manifest.exports["./imported-character"];
  expect(entry, "public retained asset/instance runtime is absent").toBeDefined();
  return import(new URL(typeof entry === "string" ? entry : entry.import, root).href);
}
async function asset(): Promise<Asset> {
  return (await runtime()).adaptImportedCharacter(bytes, { provenance: proof });
}
function skin(instance: Instance): SkinnedMesh {
  const meshes: SkinnedMesh[] = [];
  instance.root.traverse(node => { if ((node as SkinnedMesh).isSkinnedMesh) { meshes.push(node as SkinnedMesh); } });
  expect(meshes.length).toBe(1);
  instance.root.updateMatrixWorld(true);
  meshes[0]!.skeleton.update();
  return meshes[0]!;
}
function pose(instance: Instance) {
  const mesh = skin(instance);
  return { joints: mesh.skeleton.bones.map(bone => [...bone.matrixWorld.elements]),
    vertices: [0,100,500,1000,1727].map(index => mesh.getVertexPosition(index, new Vector3()).applyMatrix4(mesh.matrixWorld).toArray()) };
}
function close(actual: readonly number[], expected: readonly number[], tolerance: number) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((value, i) => { expect(Number.isFinite(value)).toBe(true); expect(Math.abs(value - expected[i]!)).toBeLessThan(tolerance); });
}
function resources(mesh: SkinnedMesh) {
  return [mesh.geometry.index, ...Object.values(mesh.geometry.attributes)].map(attribute => Array.from(attribute!.array));
}

test("public live instances seek all actual Fox joint/world-vertex oracle poses", async () => {
  const instance = (await asset()).createInstance();
  for (const sample of oracle.samples) {
    await instance.seek(sample.clip, sample.time);
    const mesh = skin(instance);
    expect(mesh.skeleton.bones.map(b => b.name)).toEqual(sample.joints.map((j: {name: string}) => j.name));
    const actual = pose(instance);
    sample.joints.forEach((joint: {matrixWorld: number[]}, i: number) => close(actual.joints[i]!, joint.matrixWorld, 0.002));
    sample.vertices.forEach((vertex: {world: number[]}, i: number) => close(actual.vertices[i]!, vertex.world, 0.02));
  }
  await instance.seek("Walk", 0); const start = pose(instance);
  await instance.seek("Walk", oracle.samples.find((s: {clip: string; time: number}) => s.clip === "Walk" && s.time > 0).time);
  expect(pose(instance)).not.toEqual(start);
});

test("repeated characters share actual immutable geometry/material/skin buffers but independent poses", async () => {
  const retained = await asset(); const a = retained.createInstance(); const b = retained.createInstance();
  await a.seek("Survey", 0); await b.seek("Survey", 0);
  const am = skin(a); const bm = skin(b); const before = resources(am); const bpose = pose(b);
  expect(am.geometry).toBe(bm.geometry); expect(am.material).toBe(bm.material);
  expect(am.geometry.getAttribute("skinIndex").array).toBe(bm.geometry.getAttribute("skinIndex").array);
  expect(am.geometry.getAttribute("skinWeight").array).toBe(bm.geometry.getAttribute("skinWeight").array);
  expect(am.skeleton).not.toBe(bm.skeleton); expect(am.skeleton.bones[0]).not.toBe(bm.skeleton.bones[0]);
  const material = Array.isArray(am.material) ? am.material[0] : am.material;
  expect((material as {map?: unknown}).map, "actual embedded base-color texture cannot be silently dropped").toBeTruthy();
  await a.seek("Walk", 0.321); expect(pose(a)).not.toEqual(bpose); expect(pose(b)).toEqual(bpose);
  await a.seek("Run", 0.117); expect(pose(b)).toEqual(bpose); expect(resources(am)).toEqual(before);
  expect(am.geometry).toBe(bm.geometry);
});

test("model placement composes outside all nonjoint ancestors, inverse binds and skin slots", async () => {
  const retained = await asset(); const normal = retained.createInstance();
  const placement = new Matrix4().makeRotationY(0.37).setPosition(7,-3,11);
  const placed = retained.createInstance({ modelMatrix: placement.elements });
  await normal.seek("Walk", 0.321); await placed.seek("Walk", 0.321);
  const expected = pose(normal); const actual = pose(placed);
  expected.joints.forEach((matrix, i) => close(actual.joints[i]!, new Matrix4().multiplyMatrices(placement, new Matrix4().fromArray(matrix)).elements, 0.002));
  expected.vertices.forEach((v, i) => close(actual.vertices[i]!, new Vector3().fromArray(v).applyMatrix4(placement).toArray(), 0.02));
  expect(skin(normal).skeleton.bones.length).toBe(24);
  expect(proof.result.observations.nodes.length).toBe(26); // scene indices != palette slots
});

test("invalid seek, unknown clip and invalid transition/delta preserve valid pose and resources", async () => {
  const instance = (await asset()).createInstance(); await instance.seek("Walk", 0.321);
  const before = pose(instance); const resourceBefore = resources(skin(instance));
  const attempts = [() => instance.seek("Walk", Number.NaN), () => instance.seek("Walk", Infinity),
    () => instance.seek("absent-clip", 0), () => instance.transition("Run", -1), () => instance.advance(-1)];
  for (const attempt of attempts) {
    await expect(Promise.resolve().then(attempt)).rejects.toThrow();
    expect(pose(instance)).toEqual(before); expect(resources(skin(instance))).toEqual(resourceBefore);
  }
});

test("live public crossfade uses measured deltas, is partition invariant and reaches target clip", async () => {
  const retained = await asset(); const a = retained.createInstance(); const b = retained.createInstance();
  await a.seek("Survey", 0); await b.seek("Survey", 0);
  await a.transition("Walk", 0.4); await b.transition("Walk", 0.4);
  await a.advance(0.2); for (let i=0; i<20; i++) { await b.advance(0.01); }
  const midpoint = pose(a); const partition = pose(b);
  midpoint.joints.forEach((matrix,i) => close(partition.joints[i]!, matrix, 0.002));
  const target = retained.createInstance(); await target.seek("Walk", 0.2);
  expect(midpoint).not.toEqual(pose(target)); // not immediate clip replacement
  await a.advance(0.2); await target.seek("Walk", 0.4);
  const final = pose(a); const wanted = pose(target);
  final.joints.forEach((matrix,i) => close(matrix, wanted.joints[i]!, 0.002));
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
for (const [name, reason, change] of malformed) {
  test(`malformed actual Fox ${name} is rejected without damaging a retained valid instance`, async () => {
    const api = await runtime(); const retained = await api.adaptImportedCharacter(bytes,{provenance:proof});
    const instance = retained.createInstance(); await instance.seek("Walk",0.321); const before=pose(instance); const buffers=resources(skin(instance));
    // Fault-inject bytes with matching integrity fields so a stale checksum cannot
    // make the semantic validation pass. This is not a real asset-tooling receipt
    // or a new licensed asset: only a negative trust-boundary fixture.
    const damaged = mutate(change);
    const faultReceipt = structuredClone(proof);
    faultReceipt.result.outputs.output.sha256 = createHash("sha256").update(damaged).digest("hex");
    faultReceipt.result.outputs.output.byteLength = damaged.byteLength;
    await expect(api.adaptImportedCharacter(damaged,{provenance:faultReceipt})).rejects.toThrow(reason);
    expect(pose(instance)).toEqual(before); expect(resources(skin(instance))).toEqual(buffers);
    await instance.seek("Run",0.117); expect(pose(instance)).not.toEqual(before);
  });
}

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
