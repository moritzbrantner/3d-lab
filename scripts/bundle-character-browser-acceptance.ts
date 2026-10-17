// #132 real browser consumer: the Fox production import split into an asset-tooling
// style `gltf-resources-v1` bundle must load through `adaptImportedCharacterBundle`
// with the same Rust-authoritative poses as the single-file GLB path.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { splitGlbToBundle } from "./lib/gltf-resources-bundle.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "target/bundle-character-browser-acceptance");
await mkdir(output, { recursive: true });
const fox = new Uint8Array(await readFile(resolve(root, "fixtures/imported-character/fox.glb")));
const bundle = splitGlbToBundle(fox);
const requests: string[] = [];
const pageErrors: string[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/") return new Response('<!doctype html><html><body><canvas width="640" height="480"></canvas></body></html>', { headers: { "Content-Type": "text/html" } });
  if (url.pathname.startsWith("/bundle/")) {
    const path = decodeURIComponent(url.pathname.slice("/bundle/".length));
    requests.push(path);
    if (path === "manifest.json") return Response.json(bundle.manifest);
    const bytes = bundle.files.get(path);
    return bytes ? new Response(bytes) : new Response("missing", { status: 404 });
  }
  const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
  if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) return new Response("outside root", { status: 403 });
  const file = Bun.file(path);
  return (await file.exists()) ? new Response(file) : new Response("missing", { status: 404 });
} });
const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on("pageerror", error => pageErrors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.evaluate(() => {
    const map = document.createElement("script"); map.type = "importmap";
    map.textContent = JSON.stringify({ imports: { three: "/node_modules/three/build/three.module.js", "three/": "/node_modules/three/" } });
    document.head.appendChild(map);
  });
  const result = await page.evaluate(async () => {
    const THREE = await import("three");
    const publicRenderer = await import("/packages/renderer/index.js");
    const module = await import("/packages/renderer/imported-character.js");
    const check = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
    const canvas = document.querySelector("canvas")!;
    const renderer = publicRenderer.createThreeSceneRenderer(canvas, { background: 0, shadows: false, antialias: false });
    renderer.setSize(640, 480, 1);
    const gl = canvas.getContext("webgl2")!;
    const manifest = await (await fetch("/bundle/manifest.json")).json();
    const readResource = async (path: string) => {
      const response = await fetch(`/bundle/${path}`);
      if (!response.ok) throw Error(`missing bundle file ${path}`);
      return response.arrayBuffer();
    };
    const progress: Array<{ loadedBytes: number; totalBytes: number }> = [];
    const asset = await module.adaptImportedCharacterBundle({ manifest, key: "fixture.character", readResource }, { onProgress: (p: any) => progress.push(p) });
    const proof = await (await fetch("/fixtures/imported-character/fox.production-import.json")).json();
    const glb = new Uint8Array(await (await fetch("/fixtures/imported-character/fox.glb")).arrayBuffer());
    const reference = await module.adaptImportedCharacter(glb, { provenance: proof });
    const oracle = await (await fetch("/fixtures/imported-character/fox.pose-oracle.json")).json();
    const mesh = (instance: any) => { const list: any[] = []; instance.root.traverse((n: any) => { if (n.isSkinnedMesh) list.push(n); }); instance.root.updateMatrixWorld(true); list[0].skeleton.update(); return list[0]; };
    const pose = (instance: any) => { const m = mesh(instance); return { joints: m.skeleton.bones.map((b: any) => b.matrixWorld.toArray()), vertices: [0, 100, 500, 1000, 1727].map(i => m.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(m.matrixWorld).toArray()) }; };
    const close = (a: number[], b: number[], tolerance: number) => a.forEach((v, i) => check(Number.isFinite(v) && Math.abs(v - b[i]) < tolerance, `pose differs ${v} vs ${b[i]}`));
    check(JSON.stringify(asset.clips) === JSON.stringify(reference.clips), "bundle clips differ from the GLB path");
    check(asset.provenance.bundle.key === "fixture.character" && asset.provenance.bundle.profile === "gltf-resources-v1", "bundle provenance missing");
    const a = asset.createInstance(), b = asset.createInstance(), r = reference.createInstance();
    check(mesh(a).geometry === mesh(b).geometry && mesh(a).material === mesh(b).material, "bundle instances must share immutable resources");
    const material = Array.isArray(mesh(a).material) ? mesh(a).material[0] : mesh(a).material;
    check(material.map?.image?.width > 0, "bundle texture must be decoded");
    for (const sample of oracle.samples) {
      await a.seek(sample.clip, sample.time); await r.seek(sample.clip, sample.time);
      const actual = pose(a), expected = pose(r);
      sample.joints.forEach((joint: any, i: number) => close(actual.joints[i], joint.matrixWorld, 0.002));
      expected.vertices.forEach((v: number[], i: number) => close(actual.vertices[i], v, 0.02));
    }
    check(progress.length >= 2 && progress[0].loadedBytes === 0, "progress must start at zero");
    check(progress.every((p, i) => i === 0 || p.loadedBytes >= progress[i - 1].loadedBytes), "progress must be monotonic");
    check(progress.at(-1)!.loadedBytes === progress.at(-1)!.totalBytes && progress.at(-1)!.totalBytes > 0, "progress must finish at the total");
    await a.seek("Survey", 0);
    const bounds = new THREE.Box3().setFromObject(a.root), center = bounds.getCenter(new THREE.Vector3()), span = bounds.getSize(new THREE.Vector3()).length();
    const camera = new THREE.PerspectiveCamera(45, 640 / 480, span / 1000, span * 20);
    camera.position.copy(center).add(new THREE.Vector3(span * 0.6, span * 0.35, span * 1.6)); camera.lookAt(center); camera.updateMatrixWorld(true);
    const renderCamera = { viewMatrix: camera.matrixWorldInverse.toArray(), projectionMatrix: camera.projectionMatrix.toArray() };
    const draw = (instances: any[]) => { module.renderImportedCharacterInstances(renderer, { camera: renderCamera, instances }); const px = new Uint8Array(640 * 480 * 4); gl.readPixels(0, 0, 640, 480, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
    const empty = draw([]), drawn = draw([a]);
    let visible = 0; for (let i = 0; i < drawn.length; i += 4) if (drawn[i] !== empty[i] || drawn[i + 1] !== empty[i + 1] || drawn[i + 2] !== empty[i + 2]) visible++;
    check(visible > 64, "bundle character is not visibly rendered");
    const rejections: Record<string, string> = {};
    const expectRejection = async (name: string, pattern: RegExp, source: any) => {
      let error: unknown; try { await module.adaptImportedCharacterBundle(source); } catch (e) { error = e; }
      check(error && pattern.test(String(error)), `${name}: expected rejection ${pattern}, got ${error}`);
      rejections[name] = String(error);
    };
    const entry = manifest.assets[0];
    const binPath = entry.resources.find((res: any) => res.path.endsWith(".bin")).path;
    await expectRejection("wrong profile", /gltf-resources-v1/, { manifest: { ...manifest, profile: "static-glb-png-v1" }, key: "fixture.character", readResource });
    await expectRejection("missing resource", /missing bundle file/, { manifest, key: "fixture.character", readResource: (path: string) => path === binPath ? readResource("absent.bin") : readResource(path) });
    await expectRejection("short resource", /declared/, { manifest, key: "fixture.character", readResource: async (path: string) => path === binPath ? (await readResource(path)).slice(0, 64) : readResource(path) });
    await expectRejection("undeclared resource", /not a declared bundle resource/, { manifest: { ...manifest, assets: [{ ...entry, resources: entry.resources.filter((res: any) => res.path !== binPath) }] }, key: "fixture.character", readResource });
    await a.seek("Walk", 0.321); check(pose(a).joints.length === 24, "retained bundle instance unusable after rejections");
    a.dispose(); b.dispose(); r.dispose(); asset.dispose(); reference.dispose();
    return { clips: asset.clips, progress, visiblePixels: visible, rejections, samples: oracle.samples.length };
  });
  const declared = new Set(["manifest.json", ...bundle.files.keys(), "absent.bin"]);
  const undeclared = requests.filter(path => !declared.has(path));
  assert.deepEqual(undeclared, [], `undeclared bundle requests: ${undeclared}`);
  assert.deepEqual(pageErrors, []);
  await writeFile(resolve(output, "evidence.json"), JSON.stringify({ ...result, requests }, null, 2) + "\n");
  console.log("bundle-character-browser-acceptance=passed");
} finally {
  await browser.close(); server.stop(true);
}
