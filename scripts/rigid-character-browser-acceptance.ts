// #184 real browser consumer: rigid, node-animated asset-tooling `zoo-animals` entries
// (quadruped-rigid zebra, biped-rigid penguin) load through `adaptImportedCharacterBundle`,
// pose from the Rust runtime, match a plain three.js AnimationMixer reference and render.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "target/rigid-character-browser-acceptance");
await mkdir(output, { recursive: true });
const pageErrors: string[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/") return new Response('<!doctype html><html><body><canvas width="640" height="480"></canvas></body></html>', { headers: { "Content-Type": "text/html" } });
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
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const publicRenderer = await import("/packages/renderer/index.js");
    const module = await import("/packages/renderer/imported-character.js");
    const check = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
    const canvas = document.querySelector("canvas")!;
    const renderer = publicRenderer.createThreeSceneRenderer(canvas, { background: 0, shadows: false, antialias: false });
    renderer.setSize(640, 480, 1);
    const gl = canvas.getContext("webgl2")!;
    const base = "/fixtures/zoo-animals/";
    const manifest = await (await fetch(`${base}manifest.json`)).json();
    const readResource = async (path: string) => {
      const response = await fetch(base + path);
      if (!response.ok) throw Error(`missing bundle file ${path}`);
      return response.arrayBuffer();
    };
    const evidence: Record<string, unknown> = {};
    for (const key of ["zoo.animal.zebra", "zoo.animal.penguin"]) {
      const entry = manifest.assets.find((asset: any) => asset.key === key && asset.variant === "expressive");
      const asset = await module.adaptImportedCharacterBundle({ manifest, key, variant: "expressive", readResource });
      check(asset.skinNodes.length === 0, `${key}: rigid character reports skin nodes`);
      const a = asset.createInstance(), b = asset.createInstance({ modelMatrix: new THREE.Matrix4().makeTranslation(1.5, 0, 0).toArray() });
      // Independent behaviour reference: plain three.js GLTFLoader + AnimationMixer.
      const reference = await new GLTFLoader().loadAsync(base + entry.path);
      const mixer = new THREE.AnimationMixer(reference.scene);
      const names: string[] = [];
      reference.scene.traverse((node: any) => { if (node.name && node.name !== "animal_root" && a.root.getObjectByName(node.name)) names.push(node.name); });
      check(names.length >= 10, `${key}: too few named nodes ${names.length}`);
      let worst = 0, samples = 0;
      for (const clip of asset.clips) {
        const action = mixer.clipAction(THREE.AnimationClip.findByName(reference.animations, clip.name));
        mixer.stopAllAction(); action.play();
        for (const fraction of [0, 0.13, 0.5, 0.91]) {
          const time = clip.duration * fraction;
          a.seek(clip.name, time); a.root.updateMatrixWorld(true);
          mixer.setTime(time); reference.scene.updateMatrixWorld(true);
          for (const name of names) {
            const actual = a.root.getObjectByName(name)!.matrixWorld.elements;
            const expected = reference.scene.getObjectByName(name)!.matrixWorld.elements;
            actual.forEach((v: number, i: number) => { worst = Math.max(worst, Math.abs(v - expected[i])); });
          }
          samples++;
        }
      }
      check(worst < 2e-3, `${key}: Rust pose differs from the AnimationMixer reference by ${worst}`);
      a.seek("walk", 0); b.seek("idle", 0);
      const shared = (x: any, y: any) => { const m: any[] = [], n: any[] = []; x.root.traverse((o: any) => o.isMesh && m.push(o)); y.root.traverse((o: any) => o.isMesh && n.push(o)); return m.length > 0 && m.every((o, i) => o.geometry === n[i].geometry && o.material === n[i].material); };
      check(shared(a, b), `${key}: instances must share geometry and materials`);
      const bounds = new THREE.Box3().setFromObject(a.root).union(new THREE.Box3().setFromObject(b.root));
      const center = bounds.getCenter(new THREE.Vector3()), span = bounds.getSize(new THREE.Vector3()).length();
      const camera = new THREE.PerspectiveCamera(45, 640 / 480, span / 1000, span * 20);
      camera.position.copy(center).add(new THREE.Vector3(span * 0.2, span * 0.3, span * 1.1)); camera.lookAt(center); camera.updateMatrixWorld(true);
      const renderCamera = { viewMatrix: camera.matrixWorldInverse.toArray(), projectionMatrix: camera.projectionMatrix.toArray() };
      const draw = (instances: any[]) => { module.renderImportedCharacterInstances(renderer, { camera: renderCamera, instances }); const px = new Uint8Array(640 * 480 * 4); gl.readPixels(0, 0, 640, 480, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
      const changed = (x: Uint8Array, y: Uint8Array) => { let count = 0; for (let i = 0; i < x.length; i += 4) if (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2]) count++; return count; };
      const empty = draw([]), first = draw([a, b]);
      const visible = changed(empty, first);
      check(visible > 500, `${key}: rigid character is not visibly rendered (${visible} px)`);
      a.transition("feed", 0.25); a.advance(0.1); a.advance(0.6);
      const animated = changed(first, draw([a, b]));
      check(animated > 20, `${key}: advancing the Rust pose does not change the rendered frame (${animated} px)`);
      a.dispose(); b.dispose(); asset.dispose();
      evidence[key] = { clips: asset.clips, referenceSamples: samples, nodes: names.length, maxMatrixDelta: worst, visiblePixels: visible, animatedPixels: animated };
    }
    return evidence;
  });
  assert.deepEqual(pageErrors, []);
  await writeFile(resolve(output, "evidence.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
  console.log("rigid-character-browser-acceptance=passed");
} finally {
  await browser.close(); server.stop(true);
}
