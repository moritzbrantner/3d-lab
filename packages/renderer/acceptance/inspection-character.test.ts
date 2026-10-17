// Independent acceptance for #118: an inspection-only, hash-checked entry point
// for original (unprocessed) character source bytes. Written before the
// implementation; see docs/specs/inspection-character-acceptance.md.
//
// The proposed public seam is `./inspection-character` exporting
// `adaptPinnedCharacterSource(bytes, {sha256, byteLength})`. Everything else is
// compared against the existing production `./imported-character` path on the
// same Khronos Fox source, whose accepted import is fixtures/imported-character/fox.glb.
// Browser render smoke lives in scripts/inspection-character-browser-acceptance.ts.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const rootUrl = new URL("../../../", import.meta.url);
const root = fileURLToPath(rootUrl);
const fixtures = new URL("fixtures/imported-character/", rootUrl);
const manifest = JSON.parse(await readFile(new URL("package.json", rootUrl), "utf8"));
const proof = JSON.parse(await readFile(new URL("fox.production-import.json", fixtures), "utf8"));
const oracle = JSON.parse(await readFile(new URL("fox.pose-oracle.json", fixtures), "utf8"));
const sourceRecord = JSON.parse(await readFile(new URL("Fox.source.asset.json", fixtures), "utf8"));
const source = await readFile(new URL("Fox.source.glb", fixtures));
const output = await readFile(new URL("fox.glb", fixtures));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pin = { sha256: proof.source.sha256 as string, byteLength: proof.source.byteLength as number };

// Existing tolerances (#87): world-matrix component 0.002, vertex 0.02 Fox source units.
const MATRIX_TOLERANCE = 0.002;
const VERTEX_TOLERANCE = 0.02;
const ORACLE_VERTICES = [0, 100, 500, 1000, 1727];
// A pin failure names the pin; a parse failure must not be reported as one.
const PIN_ERROR = /sha-?256|hash|byte ?length|length|mismatch|integrity|pin/i;
const PIN_ONLY_WORDS = /sha-?256|byte ?length|mismatch/i;

function inspectionPath(): string {
  const entry = manifest.exports?.["./inspection-character"];
  const target = entry && (typeof entry === "string" ? entry : entry.import);
  if (!target) throw new Error("#118 public ./inspection-character export is absent from package.json");
  return resolve(root, target);
}
async function inspection(): Promise<any> {
  const module = await import(inspectionPath());
  if (typeof module.adaptPinnedCharacterSource !== "function") throw new Error("./inspection-character must export adaptPinnedCharacterSource");
  return module;
}
const production = () => import(resolve(root, manifest.exports["./imported-character"].import));
async function rejection(promise: () => Promise<unknown> | unknown): Promise<Error> {
  try { await promise(); } catch (error) { return error as Error; }
  throw new Error("expected rejection, but the call succeeded");
}

// Framing-preserving GLB JSON edit (same technique as the #87 fault fixtures).
function mutate(bytes: Buffer, change: (json: any) => void): Buffer {
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  const binary = Buffer.from(bytes.subarray(28 + jsonLength)); change(json);
  const encoded = Buffer.from(JSON.stringify(json)); const padded = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 0x20); encoded.copy(padded);
  const result = Buffer.alloc(28 + padded.length + binary.length);
  result.writeUInt32LE(0x46546c67, 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(padded.length, 12); result.writeUInt32LE(0x4e4f534a, 16); padded.copy(result, 20);
  result.writeUInt32LE(binary.length, 20 + padded.length); result.writeUInt32LE(0x004e4942, 24 + padded.length); binary.copy(result, 28 + padded.length);
  return result;
}
const sourceJson = (() => { const length = source.readUInt32LE(12); return JSON.parse(source.subarray(20, 20 + length).toString()); })();

function mesh(instance: any): any {
  const meshes: any[] = [];
  instance.root.traverse((node: any) => { if (node.isSkinnedMesh) meshes.push(node); });
  if (meshes.length !== 1) throw new Error(`Fox must expose exactly one skinned mesh, got ${meshes.length}`);
  instance.root.updateMatrixWorld(true); meshes[0].skeleton.update();
  return meshes[0];
}
function joints(instance: any): Map<string, number[]> {
  return new Map(mesh(instance).skeleton.bones.map((bone: any) => [bone.name, bone.matrixWorld.toArray()]));
}
function vertices(instance: any): number[][] {
  const m = mesh(instance);
  return ORACLE_VERTICES.map(index => m.getVertexPosition(index, new THREE.Vector3()).applyMatrix4(m.matrixWorld).toArray());
}
function expectClose(actual: number[], expected: number[], tolerance: number, label: string) {
  expect(actual.length, label).toBe(expected.length);
  actual.forEach((value, i) => {
    expect(Number.isFinite(value), label).toBe(true);
    if (Math.abs(value - expected[i]) >= tolerance) throw new Error(`${label}[${i}]: ${value} vs ${expected[i]} (tolerance ${tolerance})`);
  });
}
function expectSameJoints(actual: Map<string, number[]>, expected: Map<string, number[]>, label: string) {
  expect([...actual.keys()].sort(), `${label}: joint names`).toEqual([...expected.keys()].sort());
  for (const [name, matrix] of expected) expectClose(actual.get(name)!, matrix, MATRIX_TOLERANCE, `${label} ${name}`);
}
// Rest pose straight from the source glTF node TRS/matrix, independent of any adapter.
function sourceRestWorld(): Map<string, number[]> {
  const parent = new Map<number, number>();
  sourceJson.nodes.forEach((node: any, index: number) => (node.children ?? []).forEach((child: number) => parent.set(child, index)));
  const local = (node: any) => node.matrix ? new THREE.Matrix4().fromArray(node.matrix)
    : new THREE.Matrix4().compose(new THREE.Vector3(...(node.translation ?? [0, 0, 0])),
      new THREE.Quaternion(...(node.rotation ?? [0, 0, 0, 1])), new THREE.Vector3(...(node.scale ?? [1, 1, 1])));
  const world = (index: number): THREE.Matrix4 => parent.has(index)
    ? new THREE.Matrix4().multiplyMatrices(world(parent.get(index)!), local(sourceJson.nodes[index])) : local(sourceJson.nodes[index]);
  const result = new Map<string, number[]>();
  for (const index of sourceJson.skins[0].joints) result.set(sourceJson.nodes[index].name, world(index).toArray());
  return result;
}

// GLTFLoader is the shared decoder; counting its parse calls supplements the
// message-based proof that pin rejection happens before any parsing.
function countGltfParses() {
  const proto = GLTFLoader.prototype as any;
  const parse = proto.parse, parseAsync = proto.parseAsync;
  let calls = 0;
  proto.parse = function (...args: unknown[]) { calls += 1; return parse.apply(this, args); };
  proto.parseAsync = function (...args: unknown[]) { calls += 1; return parseAsync.apply(this, args); };
  return { get calls() { return calls; }, restore() { proto.parse = parse; proto.parseAsync = parseAsync; } };
}

describe("fixtures (pass on baseline)", () => {
  test("original Fox source is byte-identical to the pinned Khronos source recorded by the production import", () => {
    expect(source.byteLength).toBe(proof.source.byteLength);
    expect(sha256(source)).toBe(proof.source.sha256);
    expect(proof.result.outputs.output.metadata.sourceSha256).toBe(sha256(source));
    expect(sourceRecord.source).toMatchObject({
      sha256: proof.source.sha256, byteLength: proof.source.byteLength,
      revision: proof.source.metadata.revision, path: proof.source.metadata.path,
    });
    expect(sourceRecord.license.spdx).toBe(proof.source.metadata.license);
    // The source is not the processed output; the inspection path must not need one.
    expect(sha256(source)).not.toBe(proof.result.outputs.output.sha256);
    expect(sha256(output)).toBe(proof.result.outputs.output.sha256);
  });

  test("production adaptImportedCharacter still refuses the original source bytes without validated provenance", async () => {
    const { adaptImportedCharacter } = await production();
    for (const options of [{}, { provenance: undefined }, { provenance: proof }, { provenance: { sha256: pin.sha256, byteLength: pin.byteLength } }]) {
      const error = await rejection(() => adaptImportedCharacter(source, options));
      expect(String(error)).toMatch(/imported character: (output integrity does not match provenance|validated import provenance is required)/);
    }
  });
});

describe("public export", () => {
  test("package exports ./inspection-character with types and an import target shipped in the package", () => {
    const entry = manifest.exports["./inspection-character"];
    expect(entry, "#118 separate inspection-only entry point is absent").toBeDefined();
    for (const key of ["types", "import"]) {
      expect(typeof entry[key]).toBe("string");
      expect(existsSync(resolve(root, entry[key])), `${key} target missing`).toBe(true);
      expect(manifest.files.some((prefix: string) => entry[key].replace(/^\.\//, "").startsWith(prefix)), `${key} not shipped`).toBe(true);
    }
    // Separately named: never an alias of the production entry point.
    expect(entry.import).not.toBe(manifest.exports["./imported-character"].import);
    expect(manifest.exports["./imported-character"]).toEqual({
      types: "./packages/renderer/imported-character.d.ts", import: "./packages/renderer/imported-character.js",
    });
    const types = readFileSync(resolve(root, entry.types), "utf8");
    expect(types).toMatch(/export (declare )?function adaptPinnedCharacterSource/);
    expect(types).toMatch(/sha256/);
    expect(types).toMatch(/byteLength/);
    expect(types).toMatch(/["']inspection-only["']/);
  });

  test("README and the browser-renderer contract document the inspection-only entry point", () => {
    for (const doc of ["README.md", "docs/contracts/browser-renderer.md"]) {
      const text = readFileSync(resolve(root, doc), "utf8");
      expect(text, `${doc} must name the entry point`).toContain("inspection-character");
      expect(text, `${doc} must state inspection-only`).toMatch(/inspection-only/);
    }
  });
});

describe("pin is verified before parsing", () => {
  test("wrong SHA-256 on the genuine source rejects with a pin error and never decodes", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    const parses = countGltfParses();
    try {
      const wrong = sha256(Buffer.from("not the fox"));
      const error = await rejection(() => adaptPinnedCharacterSource(source, { sha256: wrong, byteLength: pin.byteLength }));
      expect(String(error)).toMatch(PIN_ERROR);
      expect(parses.calls).toBe(0);
    } finally { parses.restore(); }
  });

  test("wrong byteLength with the correct SHA-256 rejects with a pin error", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    for (const byteLength of [pin.byteLength - 1, pin.byteLength + 1, 0]) {
      const error = await rejection(() => adaptPinnedCharacterSource(source, { sha256: pin.sha256, byteLength }));
      expect(String(error)).toMatch(PIN_ERROR);
    }
  });

  test("truncated source with the original pin is a pin failure, not a parse failure", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    const error = await rejection(() => adaptPinnedCharacterSource(source.subarray(0, 5000), pin));
    expect(String(error)).toMatch(PIN_ERROR);
  });

  test("ordering: corrupt bytes give a pin error under a wrong pin and a parse error under their own pin", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    const corrupt = Buffer.from(source); corrupt.fill(0x5a, 0, 64); // destroys GLB header and JSON chunk start
    const parses = countGltfParses();
    let pinError: Error;
    try {
      pinError = await rejection(() => adaptPinnedCharacterSource(corrupt, pin)); // pin of the genuine source
      expect(parses.calls).toBe(0);
    } finally { parses.restore(); }
    const parseError = await rejection(() => adaptPinnedCharacterSource(corrupt, { sha256: sha256(corrupt), byteLength: corrupt.byteLength }));
    expect(String(pinError)).toMatch(PIN_ERROR);
    expect(String(parseError)).not.toMatch(PIN_ONLY_WORDS);
    expect(String(parseError)).not.toBe(String(pinError));
  });

  test("missing or malformed pins fail closed", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    for (const options of [undefined, {}, { sha256: pin.sha256 }, { byteLength: pin.byteLength },
      { sha256: "", byteLength: pin.byteLength }, { sha256: "zz", byteLength: pin.byteLength },
      { sha256: pin.sha256, byteLength: Number.NaN }, { sha256: pin.sha256, byteLength: -1 }, { sha256: pin.sha256, byteLength: "162852" }]) {
      await rejection(() => adaptPinnedCharacterSource(source, options));
    }
  });

  test("the hash-checked bytes are the parsed bytes (caller mutation after the call cannot swap content)", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    const buffer = new Uint8Array(source);
    const pending = adaptPinnedCharacterSource(buffer, pin);
    buffer.fill(0);
    const asset = await pending;
    expect(asset.clips.map((clip: any) => clip.name)).toEqual(["Survey", "Walk", "Run"]);
    asset.dispose?.();
  });

  test("an offset view into a larger buffer is hashed over exactly its own bytes", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    const larger = new Uint8Array(source.byteLength + 32); larger.fill(7); larger.set(source, 16);
    const asset = await adaptPinnedCharacterSource(larger.subarray(16, 16 + source.byteLength), pin);
    expect(asset.validation).toBe("inspection-only");
    asset.dispose?.();
  });
});

describe("inspection-only marking and production separation", () => {
  test("result is marked inspection-only, frozen, and carries no production provenance", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    const asset = await adaptPinnedCharacterSource(source, pin);
    expect(asset.validation).toBe("inspection-only");
    expect(Object.isFrozen(asset)).toBe(true);
    expect(() => { (asset as any).validation = "production"; }).toThrow();
    expect(asset.validation).toBe("inspection-only");
    expect(asset.provenance ?? null, "an inspection asset must not carry production provenance").toBeNull();
    asset.dispose?.();
  });

  test("the inspection asset cannot be used where production provenance is required", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    const { adaptImportedCharacter } = await production();
    const asset = await adaptPinnedCharacterSource(source, pin);
    for (const provenance of [asset, { ...asset }, { validation: asset.validation, ...pin }, structuredClone({ ...pin, validation: "inspection-only" })]) {
      const error = await rejection(() => adaptImportedCharacter(source, { provenance }));
      expect(String(error)).toMatch(/imported character: (output integrity does not match provenance|validated import provenance is required)/);
    }
    asset.dispose?.();
  });

  test("the production path is unchanged: accepted output with its proof still adapts, with full provenance", async () => {
    const { adaptImportedCharacter } = await production();
    const asset = await adaptImportedCharacter(output, { provenance: proof });
    expect(asset.provenance).toEqual(proof);
    expect((asset as any).validation).toBeUndefined();
    asset.dispose();
  });
});

describe("clips, seek parity, rest pose", () => {
  test("clips expose name (or index) and duration matching the production path", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    const { adaptImportedCharacter } = await production();
    const asset = await adaptPinnedCharacterSource(source, pin);
    const accepted = await adaptImportedCharacter(output, { provenance: proof });
    expect(asset.clips.length).toBe(3);
    asset.clips.forEach((clip: any, i: number) => {
      expect(clip.index, "every clip is addressable by index").toBe(i);
      expect(clip.name).toBe(accepted.clips[i].name);
      expect(Math.abs(clip.duration - accepted.clips[i].duration)).toBeLessThan(1e-6);
    });
    expect(asset.clips.map((clip: any) => clip.name)).toEqual(["Survey", "Walk", "Run"]);
    expect(Math.abs(asset.clips[0].duration - proof.result.observations.clips[0].durationSeconds)).toBeLessThan(1e-6);
    asset.dispose?.(); accepted.dispose();
  });

  test("exact seek parity with the production path at every oracle time and at arbitrary times", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    const { adaptImportedCharacter } = await production();
    const asset = await adaptPinnedCharacterSource(source, pin);
    const accepted = await adaptImportedCharacter(output, { provenance: proof });
    const candidate = asset.createInstance(), reference = accepted.createInstance();
    expect(mesh(candidate).skeleton.bones.length).toBe(24);
    const times: Array<[string, number]> = [...oracle.samples.map((s: any) => [s.clip, s.time]), ["Walk", 0.321], ["Run", 0.117], ["Survey", 2.0001]];
    for (const [clip, time] of times) {
      candidate.seek(clip, time); reference.seek(clip, time);
      expectSameJoints(joints(candidate), joints(reference), `${clip}@${time} vs production`);
      const actual = vertices(candidate), expected = vertices(reference);
      actual.forEach((vertex, i) => expectClose(vertex, expected[i], VERTEX_TOLERANCE, `${clip}@${time} vertex ${ORACLE_VERTICES[i]}`));
    }
    // And against the independent Three.js oracle of the accepted import.
    for (const sample of oracle.samples) {
      candidate.seek(sample.clip, sample.time);
      expectSameJoints(joints(candidate), new Map(sample.joints.map((joint: any) => [joint.name, joint.matrixWorld])), `${sample.clip}@${sample.time} vs oracle`);
      vertices(candidate).forEach((vertex, i) => expectClose(vertex, sample.vertices[i].world, VERTEX_TOLERANCE, `${sample.clip}@${sample.time} oracle vertex`));
    }
    asset.dispose?.(); accepted.dispose();
  });

  test("advance parity with the production path after a seek", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    const { adaptImportedCharacter } = await production();
    const asset = await adaptPinnedCharacterSource(source, pin);
    const accepted = await adaptImportedCharacter(output, { provenance: proof });
    const candidate = asset.createInstance(), reference = accepted.createInstance();
    candidate.seek("Walk", 0); reference.seek("Walk", 0);
    const start = JSON.stringify([...joints(candidate)]);
    let moved = false;
    // Stay inside Walk (0.708s): its end key repeats the start pose.
    for (const delta of [0.05, 0.1, 0.2]) {
      candidate.advance(delta); reference.advance(delta);
      expectSameJoints(joints(candidate), joints(reference), `Walk advance ${delta}`);
      moved ||= JSON.stringify([...joints(candidate)]) !== start;
    }
    expect(moved, "advance must produce real motion").toBe(true);
    // Past the clip end, both paths keep the same (existing) playback-clock semantics.
    candidate.advance(0.6); reference.advance(0.6);
    expectSameJoints(joints(candidate), joints(reference), "Walk advance past end");
    asset.dispose?.(); accepted.dispose();
  });

  test("rest pose: a fresh instance with no clip applied shows the source bind/rest transforms", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    const { adaptImportedCharacter } = await production();
    const asset = await adaptPinnedCharacterSource(source, pin);
    const accepted = await adaptImportedCharacter(output, { provenance: proof });
    const rest = asset.createInstance();
    const restJoints = joints(rest);
    expectSameJoints(restJoints, sourceRestWorld(), "rest vs source node transforms");
    expectSameJoints(restJoints, joints(accepted.createInstance()), "rest vs production fresh instance");
    // Rest is genuinely distinct from the first clip frame...
    const survey = asset.createInstance(); survey.seek("Survey", 0);
    const surveyJoints = joints(survey);
    expect([...restJoints].some(([name, m]) => m.some((v, i) => Math.abs(v - surveyJoints.get(name)![i]) > 1e-3))).toBe(true);
    // ...and stays untouched while a sibling instance plays.
    survey.seek("Walk", 0.321); survey.advance(0.1);
    expectSameJoints(joints(rest), restJoints, "rest after sibling playback");
    asset.dispose?.(); accepted.dispose();
  });
});

describe("clipless sources load in rest pose (#137)", () => {
  test("a pinned source without animations loads with clips: [] and the source rest pose", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    for (const change of [(json: any) => { delete json.animations; }, (json: any) => { json.animations = []; }]) {
      const noClips = mutate(source, change);
      const asset = await adaptPinnedCharacterSource(noClips, { sha256: sha256(noClips), byteLength: noClips.byteLength });
      expect(asset.validation).toBe("inspection-only");
      expect(asset.clips).toEqual([]);
      const rest = asset.createInstance();
      expectSameJoints(joints(rest), sourceRestWorld(), "clipless rest vs source node transforms");
      expect(() => rest.seek(0, 0)).toThrow(/no animation clips/);
      rest.dispose(); asset.dispose?.();
    }
  });
});

describe("pinned external resources for .gltf sources (#137)", () => {
  // Split the Fox GLB into a .gltf document plus one external .bin, as Quaternius ships its sources.
  const length = source.readUInt32LE(12);
  const json = JSON.parse(source.subarray(20, 20 + length).toString());
  const bin = Buffer.from(source.subarray(28 + length));
  json.buffers = [{ uri: "Fox.bin", byteLength: json.buffers[0].byteLength }];
  const gltf = Buffer.from(JSON.stringify(json));
  const gltfPin = { sha256: sha256(gltf), byteLength: gltf.byteLength };
  const resources = () => ({ "Fox.bin": { bytes: bin, sha256: sha256(bin), byteLength: bin.byteLength } });

  test("a .gltf with pinned external buffers loads like the GLB source", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    const asset = await adaptPinnedCharacterSource(gltf, gltfPin, { resources: resources() });
    const reference = await adaptPinnedCharacterSource(source, pin);
    expect(asset.clips).toEqual(reference.clips);
    const a = asset.createInstance(), b = reference.createInstance();
    a.seek("Walk", 0.321); b.seek("Walk", 0.321);
    expectSameJoints(joints(a), joints(b), ".gltf vs GLB source");
    asset.dispose?.(); reference.dispose?.();
  });

  test("missing, extra or mispinned resources are rejected before parsing", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{}, /Fox\.bin was not supplied/],
      [{ ...resources(), "extra.png": { bytes: bin, sha256: sha256(bin), byteLength: bin.byteLength } }, /extra\.png is not referenced/],
      [{ "Fox.bin": { ...resources()["Fox.bin"], sha256: "0".repeat(64) } }, /Fox\.bin: .*SHA-256/],
    ];
    for (const [given, message] of cases) {
      const error = await rejection(() => adaptPinnedCharacterSource(gltf, gltfPin, { resources: given }));
      expect(String(error)).toMatch(message);
    }
  });
});

describe("unnamed clips are addressable by index (RiggedFigure)", () => {
  // Khronos RiggedFigure: one clip without an authored name, 1.25 s, no textures.
  // No production import exists, so an independent three.js GLTFLoader +
  // AnimationMixer reference is the oracle. SimpleSkin (.gltf with data URIs)
  // needs browser fetch facilities and is covered in the Chromium script.
  const figure = readFileSync(new URL("RiggedFigure.source.glb", fixtures));
  const figureRecord = JSON.parse(readFileSync(new URL("RiggedFigure.source.asset.json", fixtures), "utf8"));
  const figurePin = { sha256: figureRecord.source.sha256 as string, byteLength: figureRecord.source.byteLength as number };
  const figureJson = (() => { const length = figure.readUInt32LE(12); return JSON.parse(figure.subarray(20, 20 + length).toString()); })();
  const ordered = (instance: any) => mesh(instance).skeleton.bones.map((bone: any) => bone.matrixWorld.toArray() as number[]);
  async function reference(time: number): Promise<number[][]> {
    const buffer = figure.buffer.slice(figure.byteOffset, figure.byteOffset + figure.byteLength);
    const gltf = await new GLTFLoader().parseAsync(buffer, "");
    const mixer = new THREE.AnimationMixer(gltf.scene);
    mixer.clipAction(gltf.animations[0]).play();
    mixer.setTime(time);
    gltf.scene.updateMatrixWorld(true);
    let skinned: any; gltf.scene.traverse((node: any) => { if (node.isSkinnedMesh) skinned = node; });
    return skinned.skeleton.bones.map((bone: any) => bone.matrixWorld.toArray());
  }

  test("fixture is byte-identical to the pinned Khronos source, and its clip has no authored name (passes on baseline)", () => {
    expect(figure.byteLength).toBe(50116);
    expect(sha256(figure)).toBe("d6be85417d3e256861ee733eea6916093a7af7c79c16366181fd8abcaeb38cf5");
    expect(figurePin).toEqual({ sha256: sha256(figure), byteLength: figure.byteLength });
    expect(figureRecord.license.spdx).toBe("CC-BY-4.0");
    expect(figureJson.animations.length).toBe(1);
    expect(figureJson.animations[0].name).toBeUndefined();
  });

  test("loads under its pin and exposes the unnamed clip by index and duration", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    const asset = await adaptPinnedCharacterSource(figure, figurePin);
    expect(asset.validation).toBe("inspection-only");
    expect(asset.clips.length).toBe(1);
    expect(asset.clips[0].index).toBe(0);
    expect(Math.abs(asset.clips[0].duration - 1.25)).toBeLessThan(1e-6);
    // `name` is optional for an unnamed clip; when present it is a string.
    if (asset.clips[0].name !== undefined) expect(typeof asset.clips[0].name).toBe("string");
    asset.dispose?.();
  });

  test("seek by index: distinct times differ, re-seeking a time is exact, invalid indices fail atomically", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    const asset = await adaptPinnedCharacterSource(figure, figurePin);
    const instance = asset.createInstance();
    instance.seek(0, 0.3); const early = ordered(instance);
    instance.seek(0, 0.9); const late = ordered(instance);
    expect(early.some((m, j) => m.some((v, i) => Math.abs(v - late[j][i]) > 1e-4)), "two times must give different joints").toBe(true);
    instance.seek(0, 0.3);
    expect(ordered(instance)).toEqual(early);
    for (const bad of [1, -1, 0.5, Number.NaN]) {
      await rejection(() => instance.seek(bad, 0.3));
      expect(ordered(instance)).toEqual(early);
    }
    asset.dispose?.();
  });

  test("non-string, non-number clip selectors never match an unnamed clip", async () => {
    // Regression (Codex P2 on #119): an unnamed clip has no authored name, so
    // `undefined` (or any other non-selector) must not select it.
    const { adaptPinnedCharacterSource } = await inspection();
    const asset = await adaptPinnedCharacterSource(figure, figurePin);
    const instance = asset.createInstance();
    instance.seek(0, 0.9); const before = ordered(instance);
    for (const bad of [undefined, null, {}]) {
      await rejection(() => instance.seek(bad, 0.3));
      expect(ordered(instance)).toEqual(before);
    }
    asset.dispose?.();
  });

  test("index seek and rest pose match an independent three.js AnimationMixer reference", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    const asset = await adaptPinnedCharacterSource(figure, figurePin);
    const rest = asset.createInstance(), playing = asset.createInstance();
    const restReference = await (async () => {
      const buffer = figure.buffer.slice(figure.byteOffset, figure.byteOffset + figure.byteLength);
      const gltf = await new GLTFLoader().parseAsync(buffer, ""); gltf.scene.updateMatrixWorld(true);
      let skinned: any; gltf.scene.traverse((node: any) => { if (node.isSkinnedMesh) skinned = node; });
      return skinned.skeleton.bones.map((bone: any) => bone.matrixWorld.toArray());
    })();
    ordered(rest).forEach((m: number[], j: number) => expectClose(m, restReference[j], MATRIX_TOLERANCE, `rest joint ${j}`));
    for (const time of [0, 0.3, 0.625, 1.1]) {
      playing.seek(0, time);
      const expected = await reference(time);
      ordered(playing).forEach((m: number[], j: number) => expectClose(m, expected[j], MATRIX_TOLERANCE, `clip 0 @${time} joint ${j}`));
    }
    asset.dispose?.();
  });

  test("named sources accept index seek equal to name seek (Fox)", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    const asset = await adaptPinnedCharacterSource(source, pin);
    const byName = asset.createInstance(), byIndex = asset.createInstance();
    for (const [index, name, time] of [[0, "Survey", 1.2], [1, "Walk", 0.321], [2, "Run", 0.117]] as const) {
      byName.seek(name, time); byIndex.seek(index, time);
      expect(ordered(byIndex)).toEqual(ordered(byName));
    }
    asset.dispose?.();
  });
});

describe("clear errors", () => {
  test("production adapters still reject a character without clips", async () => {
    const { adaptImportedCharacter } = await production();
    const noClips = mutate(output, json => { delete json.animations; });
    const forged = structuredClone(proof);
    forged.result.outputs.output = { ...forged.result.outputs.output, sha256: sha256(noClips), byteLength: noClips.byteLength };
    const error = await rejection(() => adaptImportedCharacter(noClips, { provenance: forged }));
    expect(String(error)).toMatch(/no animation clips/i);
  });

  test("malformed animations (object or null) are an invalid source, not a missing-clips source", async () => {
    // Regression (Codex P2 on #119): only an absent or empty `animations` list is a clipless source.
    const { adaptPinnedCharacterSource } = await inspection();
    for (const animations of [{}, null]) {
      const malformed = mutate(source, json => { json.animations = animations; });
      const error = await rejection(() => adaptPinnedCharacterSource(malformed, { sha256: sha256(malformed), byteLength: malformed.byteLength }));
      expect(String(error)).toMatch(/unparsable|invalid/i);
      expect(String(error)).not.toMatch(/\bno (animation )?clips\b|\bno animations?\b|without (animation )?clips|zero (animation )?clips/i);
      expect(String(error)).not.toMatch(PIN_ONLY_WORDS);
    }
  });

  test("a clipless source with another malformed field is an invalid source, not a missing-clips source", async () => {
    // Regression (Codex P2 on #119): dropping clips never hides another malformed field.
    const { adaptPinnedCharacterSource } = await inspection();
    for (const dropClips of [(json: any) => { delete json.animations; }, (json: any) => { json.animations = []; }]) {
      const malformed = mutate(source, json => { dropClips(json); json.scenes[json.scene ?? 0].nodes = [999]; });
      const error = await rejection(() => adaptPinnedCharacterSource(malformed, { sha256: sha256(malformed), byteLength: malformed.byteLength }));
      expect(String(error)).toMatch(/unparsable|invalid/i);
      expect(String(error)).not.toMatch(/\bno (animation )?clips\b|\bno animations?\b|without (animation )?clips|zero (animation )?clips/i);
      expect(String(error)).not.toMatch(PIN_ONLY_WORDS);
    }
  });

  test("malformed bytes under their own correct pin are rejected as unparsable, not as a pin failure", async () => {
    const { adaptPinnedCharacterSource } = await inspection();
    const truncated = Buffer.from(source.subarray(0, 5000));
    for (const bytes of [Buffer.from([1, 2, 3, 4]), Buffer.alloc(0), truncated, Buffer.from("{\"asset\":{\"version\":\"2.0\"}}")]) {
      const error = await rejection(() => adaptPinnedCharacterSource(bytes, { sha256: sha256(bytes), byteLength: bytes.byteLength }));
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/glb|gltf|pars|invalid|malformed|unsupported|read/i);
      expect(String(error)).not.toMatch(PIN_ONLY_WORDS);
    }
  });
});

describe("architecture: no second skin/animation implementation", () => {
  const rendererDir = resolve(root, "packages/renderer");
  function importGraph(entry: string): Set<string> {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file) || !existsSync(file)) return;
      seen.add(file);
      const text = readFileSync(file, "utf8");
      for (const [, specifier] of text.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
        if (specifier.startsWith(".")) visit(resolve(dirname(file), specifier));
      }
    };
    visit(entry);
    return seen;
  }
  function files(dir: string, suffix: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? files(join(dir, entry.name), suffix) : entry.name.endsWith(suffix) ? [join(dir, entry.name)] : []);
  }

  test("the inspection module reaches the existing Rust bridge and contains no animation/skin stack of its own", () => {
    const entry = inspectionPath();
    const graph = [...importGraph(entry)].map(file => relative(rendererDir, file));
    expect(graph).toContain("imported-character-wasm/character.js");
    const text = readFileSync(entry, "utf8");
    expect(text).not.toMatch(/AnimationMixer|AnimationClip|AnimationAction|KeyframeTrack|Interpolant|PropertyBinding/);
    expect(text).not.toMatch(/new\s+(THREE\.)?(Skeleton|SkinnedMesh|Bone)\b/);
    expect(text).not.toMatch(/\.wasm\b/);
    expect(text).not.toMatch(/\bslerp\b|\blerp\b/i);
  });

  test("no new WASM artifact or wasm-bindgen crate is added", () => {
    expect(files(rendererDir, ".wasm").map(file => relative(rendererDir, file))).toEqual(["imported-character-wasm/character_bg.wasm"]);
    const crates = readdirSync(resolve(root, "crates")).filter(name => {
      const cargo = resolve(root, "crates", name, "Cargo.toml");
      return existsSync(cargo) && /wasm-bindgen/.test(readFileSync(cargo, "utf8"));
    });
    expect(crates).toEqual(["three-d-character-wasm"]);
  });

  test("render submission is the shared production call", async () => {
    const inspectionModule = await inspection();
    const { renderImportedCharacterInstances } = await production();
    if ("renderImportedCharacterInstances" in inspectionModule) {
      expect(inspectionModule.renderImportedCharacterInstances).toBe(renderImportedCharacterInstances);
    }
    const asset = await inspectionModule.adaptPinnedCharacterSource(source, pin);
    const instance = asset.createInstance();
    // Same instance shape the production render call consumes (`root` Object3D).
    expect(instance.root?.isObject3D).toBe(true);
    for (const method of ["seek", "advance", "dispose"]) expect(typeof instance[method]).toBe("function");
    asset.dispose?.();
  });
});
