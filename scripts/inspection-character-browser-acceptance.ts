// Independent #118 Chromium render smoke, written before implementation.
// It loads the pinned ORIGINAL Fox source through the public
// `./inspection-character` export, verifies the pin rejection in the browser,
// renders a rest-pose and a seeked instance through the existing public
// renderer, and compares live poses with the production `./imported-character`
// path on the accepted import of the same source. It also loads RiggedFigure
// (one unnamed clip) and SimpleSkin (embedded .gltf), seeks their clip by index
// and compares with a three.js AnimationMixer reference. Usage:
//   bun scripts/inspection-character-browser-acceptance.ts [output-dir]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "target/inspection-character-browser-acceptance");
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const exportPath = (name: string) => { const entry = manifest.exports[name]; return entry && (typeof entry === "string" ? entry : entry.import); };
const inspectionPath = exportPath("./inspection-character");
const productionPath = exportPath("./imported-character");
const proof = JSON.parse(await readFile(resolve(root, "fixtures/imported-character/fox.production-import.json"), "utf8"));
const source = await readFile(resolve(root, "fixtures/imported-character/Fox.source.glb"));
assert.equal(createHash("sha256").update(source).digest("hex"), proof.source.sha256);
assert.equal(source.byteLength, proof.source.byteLength);
const pin = { sha256: proof.source.sha256, byteLength: proof.source.byteLength };
// Catalog sources without a production import: unnamed clips, embedded .gltf.
const catalog = await Promise.all([
  { label: "RiggedFigure", path: "fixtures/imported-character/RiggedFigure.source.glb", sha256: "d6be85417d3e256861ee733eea6916093a7af7c79c16366181fd8abcaeb38cf5", byteLength: 50116, duration: 1.25 },
  { label: "SimpleSkin", path: "fixtures/catalog/khronos-simpleskin-embedded.gltf", sha256: "7d0c3f48d0510d101269cb4fdd3ee035eaada0e04809a0899e0b4cfe8c38e68f", byteLength: 3566, duration: 5.5 },
].map(async entry => {
  const bytes = await readFile(resolve(root, entry.path));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, `${entry.label} fixture hash`);
  assert.equal(bytes.byteLength, entry.byteLength, `${entry.label} fixture length`);
  return entry;
}));

const pageErrors: string[] = [];
const wasm: Array<{ url: string; sha256: string; bytes: number }> = [];
// Disposable fixture server: static repository files only.
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/") {
    return new Response('<!doctype html><html><body><canvas aria-label="Inspection-only pinned character" width="640" height="480"></canvas></body></html>', { headers: { "Content-Type": "text/html" } });
  }
  const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
  if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) { return new Response("outside fixture root", { status: 403 }); }
  const file = Bun.file(path);
  if (!await file.exists()) { return new Response("missing candidate resource", { status: 404 }); }
  return new Response(file);
} });
const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on("pageerror", error => pageErrors.push(error.message));
const responses: Promise<void>[] = [];
page.on("response", response => {
  if (response.headers()["content-type"]?.includes("application/wasm") || new URL(response.url()).pathname.endsWith(".wasm")) {
    responses.push(response.body().then(bytes => { wasm.push({ url: response.url(), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength }); }));
  }
});
try {
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.evaluate(() => {
    const map = document.createElement("script"); map.type = "importmap";
    map.textContent = JSON.stringify({ imports: { three: "/node_modules/three/build/three.module.js", "three/": "/node_modules/three/" } });
    document.head.appendChild(map);
  });
  const result = await page.evaluate(async ({ inspectionPath, productionPath, pin, catalog }) => {
    const THREE = await import("three");
    const publicRenderer = await import("/packages/renderer/index.js");
    const canvas = document.querySelector("canvas")!;
    const renderer = publicRenderer.createThreeSceneRenderer(canvas, { background: 0, shadows: false, antialias: false });
    renderer.setSize(640, 480, 1);
    const gl = canvas.getContext("webgl2");
    if (!gl || gl.isContextLost()) { throw Error("actual public renderer WebGL context unavailable"); }
    if (!inspectionPath) { throw Error("#118 public ./inspection-character export absent after real renderer initialization"); }
    let instantiated = 0;
    const originalInstantiate = WebAssembly.instantiate.bind(WebAssembly);
    WebAssembly.instantiate = async (...args) => { const r = await originalInstantiate(...args); instantiated += 1; return r; };
    const originalStreaming = WebAssembly.instantiateStreaming.bind(WebAssembly);
    WebAssembly.instantiateStreaming = async (...args) => { const r = await originalStreaming(...args); instantiated += 1; return r; };
    const check = (condition: unknown, message: string) => { if (!condition) { throw Error(message); } };
    const close = (a: number[], b: number[], tolerance: number, label: string) => {
      check(a.length === b.length, `${label}: shape changed`);
      a.forEach((v, i) => check(Number.isFinite(v) && Math.abs(v - b[i]) < tolerance, `${label}: ${v} vs ${b[i]}`));
    };
    const inspection = await import("/" + inspectionPath.replace(/^\.\//, ""));
    const bytes = new Uint8Array(await (await fetch("/fixtures/imported-character/Fox.source.glb")).arrayBuffer());

    // Pin rejection in the browser, before parsing: corrupt bytes under the
    // genuine pin must fail as a pin mismatch, not as a glTF parse error.
    const corrupt = bytes.slice(); corrupt.fill(0x5a, 0, 64);
    let pinFailure: unknown;
    try { await inspection.adaptPinnedCharacterSource(corrupt, pin); } catch (error) { pinFailure = error; }
    check(pinFailure && /sha-?256|hash|byte ?length|length|mismatch|integrity|pin/i.test(String(pinFailure)), `pin mismatch not reported as such: ${pinFailure}`);
    let wrongHash: unknown;
    try { await inspection.adaptPinnedCharacterSource(bytes, { ...pin, sha256: "0".repeat(64) }); } catch (error) { wrongHash = error; }
    check(wrongHash, "wrong sha256 pin accepted");

    const asset = await inspection.adaptPinnedCharacterSource(bytes, pin);
    check(asset.validation === "inspection-only", "asset not marked inspection-only");
    check(instantiated > 0, "inspection path never instantiated the compiled Rust WebAssembly bridge");
    check(JSON.stringify(asset.clips.map((clip: any) => clip.name)) === JSON.stringify(["Survey", "Walk", "Run"]), "clip names lost");
    check(asset.clips.every((clip: any) => clip.duration > 0), "clip durations missing");
    const production = await import("/" + productionPath.replace(/^\.\//, ""));
    const render = inspection.renderImportedCharacterInstances ?? production.renderImportedCharacterInstances;
    check(render === production.renderImportedCharacterInstances, "inspection rendering must use the shared production render call");

    const mesh = (instance: any) => {
      const list: any[] = []; instance.root.traverse((node: any) => { if (node.isSkinnedMesh) { list.push(node); } });
      check(list.length === 1, "Fox must contain one skinned primitive");
      instance.root.updateMatrixWorld(true); list[0].skeleton.update(); return list[0];
    };
    const pose = (instance: any) => {
      const m = mesh(instance);
      return { names: m.skeleton.bones.map((bone: any) => bone.name), joints: m.skeleton.bones.map((bone: any) => bone.matrixWorld.toArray()),
        vertices: [0, 100, 500, 1000, 1727].map(index => m.getVertexPosition(index, new THREE.Vector3()).applyMatrix4(m.matrixWorld).toArray()) };
    };
    const material = (instance: any) => { const m = mesh(instance).material; return Array.isArray(m) ? m[0] : m; };

    const rest = asset.createInstance();
    const walk = asset.createInstance();
    check(mesh(rest).geometry === mesh(walk).geometry, "inspection instances must share immutable geometry");
    const texture = material(rest).map;
    check(texture && texture.image && texture.image.width > 0 && texture.image.height > 0, "embedded source texture must be decoded, not dropped");

    // Live parity with the production path on the accepted import of the same source.
    const proof = await (await fetch("/fixtures/imported-character/fox.production-import.json")).json();
    const oracle = await (await fetch("/fixtures/imported-character/fox.pose-oracle.json")).json();
    const accepted = await production.adaptImportedCharacter(new Uint8Array(await (await fetch("/fixtures/imported-character/fox.glb")).arrayBuffer()), { provenance: proof });
    const reference = accepted.createInstance();
    const restPose = pose(rest), referenceRest = pose(reference);
    check(JSON.stringify(restPose.names) === JSON.stringify(referenceRest.names), "joint names/order differ from production");
    restPose.joints.forEach((matrix: number[], i: number) => close(matrix, referenceRest.joints[i], 0.002, `rest joint ${i}`));
    const samples = [];
    for (const sample of [...oracle.samples.map((s: any) => ({ clip: s.clip, time: s.time, oracle: s })), { clip: "Walk", time: 0.321 }, { clip: "Run", time: 0.117 }]) {
      walk.seek(sample.clip, sample.time); reference.seek(sample.clip, sample.time);
      const live = pose(walk), expected = pose(reference);
      live.joints.forEach((matrix: number[], i: number) => close(matrix, expected.joints[i], 0.002, `${sample.clip}@${sample.time} joint ${i}`));
      live.vertices.forEach((vertex: number[], i: number) => close(vertex, expected.vertices[i], 0.02, `${sample.clip}@${sample.time} vertex ${i}`));
      if (sample.oracle) {
        sample.oracle.joints.forEach((joint: any, i: number) => close(live.joints[i], joint.matrixWorld, 0.002, `${sample.clip}@${sample.time} oracle joint ${joint.name}`));
        sample.oracle.vertices.forEach((vertex: any, i: number) => close(live.vertices[i], vertex.world, 0.02, `${sample.clip}@${sample.time} oracle vertex`));
      }
      samples.push({ clip: sample.clip, time: sample.time, joints: live.joints.length });
    }
    check(JSON.stringify(pose(rest)) === JSON.stringify(restPose), "seeking a sibling changed the rest-pose instance");

    // Render through the existing public renderer: rest pose, then the seeked clip.
    const bounds = new THREE.Box3().setFromObject(rest.root); const center = bounds.getCenter(new THREE.Vector3()); const span = bounds.getSize(new THREE.Vector3()).length();
    const camera = new THREE.PerspectiveCamera(45, 640 / 480, Math.max(span / 1000, 0.01), span * 20);
    camera.position.copy(center).add(new THREE.Vector3(span * 0.6, span * 0.35, span * 1.6)); camera.lookAt(center); camera.updateMatrixWorld(true);
    const renderCamera = { viewMatrix: camera.matrixWorldInverse.toArray(), projectionMatrix: camera.projectionMatrix.toArray() };
    const draw = (instances: any[]) => {
      render(renderer, { camera: renderCamera, instances });
      const pixels = new Uint8Array(640 * 480 * 4); gl.readPixels(0, 0, 640, 480, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      check(gl.getError() === gl.NO_ERROR, "frame readback failed"); return pixels;
    };
    const differing = (a: Uint8Array, b: Uint8Array) => { let n = 0; for (let i = 0; i < a.length; i += 4) { if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) { n++; } } return n; };
    const empty = draw([]);
    const restFrame = draw([rest]);
    const visible = differing(restFrame, empty);
    check(visible > 64, "rest-pose inspection character is not visibly rendered");
    walk.seek("Walk", 0.321);
    const walkFrame = draw([walk]);
    const moving = differing(walkFrame, restFrame);
    check(differing(walkFrame, empty) > 64, "seeked inspection character is not visibly rendered");
    check(moving > 8, "seeked clip is visually indistinguishable from the rest pose");

    // Unnamed clips addressable by index, against an independent three.js
    // GLTFLoader + AnimationMixer reference (no production import exists).
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const ordered = (instance: any) => mesh(instance).skeleton.bones.map((bone: any) => bone.matrixWorld.toArray());
    const catalogResults = [];
    for (const entry of catalog) {
      const sourceBytes = new Uint8Array(await (await fetch("/" + entry.path)).arrayBuffer());
      const pinned = await inspection.adaptPinnedCharacterSource(sourceBytes, { sha256: entry.sha256, byteLength: entry.byteLength });
      check(pinned.validation === "inspection-only", `${entry.label}: not inspection-only`);
      check(pinned.clips.length === 1 && pinned.clips[0].index === 0 && Math.abs(pinned.clips[0].duration - entry.duration) < 1e-6, `${entry.label}: clip index/duration ${JSON.stringify(pinned.clips)}`);
      const referenceAt = async (time: number | null) => {
        const gltf = await new GLTFLoader().parseAsync(sourceBytes.slice().buffer, "");
        if (time !== null) { const mixer = new THREE.AnimationMixer(gltf.scene); mixer.clipAction(gltf.animations[0]).play(); mixer.setTime(time); }
        gltf.scene.updateMatrixWorld(true);
        let skinned: any; gltf.scene.traverse((node: any) => { if (node.isSkinnedMesh) { skinned = node; } });
        return skinned.skeleton.bones.map((bone: any) => bone.matrixWorld.toArray());
      };
      const restInstance = pinned.createInstance(), live = pinned.createInstance();
      const restExpected = await referenceAt(null);
      ordered(restInstance).forEach((m: number[], j: number) => close(m, restExpected[j], 0.002, `${entry.label} rest joint ${j}`));
      const times = [0.1, 0.4 * entry.duration, 0.8 * entry.duration];
      for (const time of times) {
        live.seek(0, time);
        const expected = await referenceAt(time);
        ordered(live).forEach((m: number[], j: number) => close(m, expected[j], 0.002, `${entry.label} clip 0 @${time} joint ${j}`));
      }
      live.seek(0, times[1]); const first = JSON.stringify(ordered(live));
      live.seek(0, times[2]); const second = JSON.stringify(ordered(live));
      check(first !== second, `${entry.label}: two index-seek times give the same pose`);
      live.seek(0, times[1]); check(JSON.stringify(ordered(live)) === first, `${entry.label}: re-seek is not exact`);
      let badIndex: unknown; try { live.seek(1, 0.1); } catch (error) { badIndex = error; }
      check(badIndex && JSON.stringify(ordered(live)) === first, `${entry.label}: out-of-range index accepted or not atomic`);
      // Visible render through the same shared call, framed on this asset.
      const box = new THREE.Box3().setFromObject(live.root); const mid = box.getCenter(new THREE.Vector3()); const size = Math.max(box.getSize(new THREE.Vector3()).length(), 1e-3);
      const view = new THREE.PerspectiveCamera(45, 640 / 480, size / 1000, size * 20);
      view.position.copy(mid).add(new THREE.Vector3(size * 0.3, size * 0.2, size * 1.4)); view.lookAt(mid); view.updateMatrixWorld(true);
      const assetCamera = { viewMatrix: view.matrixWorldInverse.toArray(), projectionMatrix: view.projectionMatrix.toArray() };
      const frame = (instances: any[]) => { render(renderer, { camera: assetCamera, instances }); const px = new Uint8Array(640 * 480 * 4); gl.readPixels(0, 0, 640, 480, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
      const blank = frame([]); const shown = differing(frame([live]), blank);
      check(shown > 64, `${entry.label}: not visibly rendered (${shown})`);
      catalogResults.push({ label: entry.label, clips: pinned.clips, referenceTimes: times, visiblePixels: shown });
      restInstance.dispose(); live.dispose();
    }

    draw([rest, walk]);
    const present = () => { render(renderer, { camera: renderCamera, instances: [walk] }); requestAnimationFrame(present); }; requestAnimationFrame(present);
    return { validation: asset.validation, clips: asset.clips, samples, catalog: catalogResults, visiblePixels: visible, movingPixels: moving, wasmInstances: instantiated };
  }, { inspectionPath, productionPath, pin, catalog });
  await Promise.all(responses);
  assert(wasm.some(resource => resource.bytes > 8), "compiled Rust WASM artifact bytes were not observed");
  assert.deepEqual(pageErrors, []);
  await page.locator("canvas").screenshot({ path: resolve(output, "inspection-character.png") });
  await writeFile(resolve(output, "evidence.json"), JSON.stringify({ sourceSha256: pin.sha256, ...result, wasm }, null, 2) + "\n");
  console.log("inspection-character-browser-acceptance=passed");
} finally {
  await browser.close(); server.stop(true);
}
