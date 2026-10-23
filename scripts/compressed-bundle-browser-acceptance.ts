// Explicit real-release acceptance tier; acquire inputs first, then run offline:
// bun scripts/compressed-bundle-browser-acceptance.ts target/ranger-rolling [output]
// Input: full/manifest.json and compact/humanoid-ranger-male.index.json plus declared files.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const inputs = resolve(process.argv[2] ?? "target/ranger-rolling");
const output = resolve(process.argv[3] ?? "target/compressed-bundle-acceptance");
const baseline = resolve(process.argv[4] ?? root);
await mkdir(output, { recursive: true });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response(
        '<!doctype html><canvas width="640" height="480" aria-label="Rolling Ranger"></canvas>',
        { headers: { "Content-Type": "text/html" } },
      );
    }
    let base = root;
    let suffix = url.pathname.slice(1);
    if (url.pathname.startsWith("/assets/")) {
      base = inputs;
      suffix = url.pathname.slice(8);
    }
    if (url.pathname.startsWith("/baseline/")) {
      base = baseline;
      suffix = url.pathname.slice(10);
    }
    const path = resolve(base, suffix);
    if (!path.startsWith(base + sep)) {
      return new Response("outside root", { status: 403 });
    }
    const file = Bun.file(path);
    return (await file.exists()) ? new Response(file) : new Response("missing", { status: 404 });
  },
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.CHROMIUM_EXECUTABLE }
    : { channel: "chromium" }),
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
});
const results = [];
try {
  // Paired cold contexts: 40 ms latency, 10 Mbit/s download. Each includes codecs,
  // WASM and first render, not only the asset request. No public services here.
  for (const mode of ["full", "compact", "compact-knight"] as const) {
    const context = await browser.newContext({ viewport: { width: 640, height: 480 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const session = await context.newCDPSession(page);
    await session.send("Network.enable");
    await session.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 40,
      downloadThroughput: 1_250_000,
      uploadThroughput: 1_250_000,
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.evaluate(() => {
      const map = document.createElement("script");
      map.type = "importmap";
      map.textContent = JSON.stringify({
        imports: {
          three: "/node_modules/three/build/three.module.js",
          "three/": "/node_modules/three/",
        },
      });
      document.head.appendChild(map);
    });
    const result = await page.evaluate(async (mode) => {
      const liveUrls = new Set<string>();
      const createUrl = URL.createObjectURL.bind(URL),
        revokeUrl = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob: Blob) => {
        const url = createUrl(blob);
        liveUrls.add(url);
        return url;
      };
      URL.revokeObjectURL = (url: string) => {
        liveUrls.delete(url);
        revokeUrl(url);
      };
      const workers = new Set<Worker>();
      window.Worker = new Proxy(window.Worker, {
        construct(Target, args) {
          const worker = Reflect.construct(Target, args) as Worker;
          workers.add(worker);
          const terminate = worker.terminate.bind(worker);
          worker.terminate = () => {
            workers.delete(worker);
            terminate();
          };
          return worker;
        },
      });
      const start = performance.now();
      const THREE = await import("three");
      const publicRenderer = await import("/packages/renderer/index.js");
      const module = await import(
        mode === "full"
          ? "/baseline/packages/renderer/imported-character.js"
          : "/packages/renderer/imported-character.js"
      );
      const check = (condition: unknown, message: string) => {
        if (!condition) {
          throw Error(message);
        }
      };
      const canvas = document.querySelector("canvas")!;
      const renderer = publicRenderer.createThreeSceneRenderer(canvas, {
        background: 0,
        shadows: false,
        antialias: false,
      });
      renderer.setSize(640, 480, 1);
      const compact = mode !== "full";
      const prefix = `/assets/${compact ? "compact" : "full"}/`;
      const index = await (
        await fetch(prefix + (compact ? "humanoid-ranger-male.index.json" : "manifest.json"))
      ).json();
      const readResource = async (path: string) => {
        const response = await fetch(prefix + path);
        if (!response.ok) {
          throw Error(`missing ${path}: ${response.status}`);
        }
        return response.arrayBuffer();
      };
      const source = {
        manifest: index,
        key: "humanoid.ranger.male",
        variant: mode === "compact-knight" ? "outfit.knight" : "default",
        readResource,
      };
      const progress: any[] = [];
      const options = {
        renderer,
        transcoderPath: "/node_modules/three/examples/jsm/libs/basis/",
        onProgress: (p: any) => progress.push(p),
      };
      const loadedAt = performance.now();
      const asset = await module.adaptImportedCharacterBundle(source, options);
      const decodeMs = performance.now() - loadedAt;
      check(
        workers.size === 0 && liveUrls.size === 0,
        "decoder workers/object URLs leaked after loading",
      );
      const a = asset.createInstance(),
        b = asset.createInstance();
      const meshes = (root: any) => {
        const nodes: any[] = [];
        root.traverse((node: any) => {
          if (node.isSkinnedMesh) {
            nodes.push(node);
          }
        });
        return nodes;
      };
      check(meshes(a.root)[0].geometry === meshes(b.root)[0].geometry, "geometry must be shared");
      const materials = meshes(a.root).flatMap((node) =>
        Array.isArray(node.material) ? node.material : [node.material],
      );
      check(
        materials.some((material) => material.map?.image?.width > 0),
        "Ranger base colour textures must decode",
      );
      check(
        materials.some((material) => material.normalMap?.image?.width > 0),
        "Ranger normal maps must decode",
      );
      const required = [
        "Idle_Loop",
        "Sword_Idle",
        "Idle_Shield_Loop",
        "Death01",
        "Walk_Loop",
        "Jog_Fwd_Loop",
        "Sprint_Loop",
      ];
      for (const name of required) {
        check(
          asset.clips.some((clip: any) => clip.name === name),
          `missing ${name}`,
        );
        a.seek(name, 0.2);
      }
      a.seek("Walk_Loop", 0);
      const before = a.jointPosition("hand_r");
      a.advance(0.3);
      const after = a.jointPosition("hand_r");
      check(
        before.some((value: number, i: number) => Math.abs(value - after[i]) > 0.001),
        "walk must animate joints",
      );
      a.transition("Idle_Loop", 0.2);
      a.advance(0.3);
      const itemAssets: any[] = [];
      if (mode !== "compact-knight") {
        const sockets = (
          (await module.readBundleAttachment({ ...source, name: "humanoid-sockets" })) as any
        ).sockets;
        for (const [key, id] of [
          ["equipment.sword.arming", "hand_r.weapon"],
          ["equipment.shield.heater", "hand_l.shield"],
        ]) {
          const item = await module.adaptImportedItemBundle(
            { ...source, key, variant: "default" },
            { renderer, transcoderPath: options.transcoderPath },
          );
          itemAssets.push(item);
          const socket = sockets.find((s: any) => s.id === id);
          const matrix = new THREE.Matrix4()
            .compose(
              new THREE.Vector3(...socket.translation),
              new THREE.Quaternion(...socket.rotation),
              new THREE.Vector3(1, 1, 1),
            )
            .toArray();
          a.attach(item.createInstance(), { joint: socket.joint, socket: matrix, frame: "grip" });
        }
      }
      a.seek("Walk_Loop", 0.3);
      const bounds = new THREE.Box3().setFromObject(a.root),
        center = bounds.getCenter(new THREE.Vector3()),
        span = bounds.getSize(new THREE.Vector3()).length();
      const camera = new THREE.PerspectiveCamera(45, 640 / 480, span / 1000, span * 20);
      camera.position.copy(center).add(new THREE.Vector3(span * 0.5, span * 0.2, span * 1.4));
      camera.lookAt(center);
      camera.updateMatrixWorld(true);
      module.renderImportedCharacterInstances(renderer, {
        camera: {
          viewMatrix: camera.matrixWorldInverse.toArray(),
          projectionMatrix: camera.projectionMatrix.toArray(),
        },
        instances: [a],
      });
      const firstRenderMs = performance.now() - start;
      const gl = canvas.getContext("webgl2")!;
      const pixels = new Uint8Array(640 * 480 * 4);
      gl.readPixels(0, 0, 640, 480, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let visible = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] || pixels[i + 1] || pixels[i + 2]) {
          visible++;
        }
      }
      check(visible > 500, "Ranger must render visibly");
      check(
        progress.every(
          (p, i) =>
            i === 0 || p.loadedBytes >= progress[i - 1].loadedBytes || p.loadedBytes < 20_000,
        ),
        "progress regressed",
      );
      // Save frame before cleanup; screenshot is taken outside evaluate after the render.
      (window as any).finish = () => {
        let disposals = 0;
        const resources = new Set<any>();
        a.root.traverse((node: any) => {
          if (node.geometry) {
            resources.add(node.geometry);
          }
          for (const material of node.material
            ? Array.isArray(node.material)
              ? node.material
              : [node.material]
            : []) {
            resources.add(material);
            for (const value of Object.values(material) as any[]) {
              if (value?.isTexture) {
                resources.add(value);
              }
            }
          }
        });
        for (const resource of resources) {
          resource.addEventListener("dispose", () => {
            disposals++;
          });
        }
        asset.dispose();
        asset.dispose();
        for (const item of itemAssets) {
          item.dispose();
          item.dispose();
        }
        check(
          disposals === resources.size,
          `each resource must dispose once: ${disposals}/${resources.size}`,
        );
        let rejected = false;
        try {
          b.advance(0.1);
        } catch {
          rejected = true;
        }
        check(rejected, "disposed instances must reject playback");
        renderer.dispose();
        return { resources: resources.size, disposals };
      };
      const timing = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      // Independent behavior reference: plain Three.js with AnimationMixer. Run
      // after the measured first frame, so oracle traffic is excluded from timings.
      let maxJointError = 0;
      if (compact) {
        const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
        const { KTX2Loader } = await import("three/examples/jsm/loaders/KTX2Loader.js");
        const { MeshoptDecoder } =
          await import("three/examples/jsm/libs/meshopt_decoder.module.js");
        const ktx = new KTX2Loader().setTranscoderPath(options.transcoderPath);
        renderer.configureTextureLoader(ktx);
        try {
          const loader = new GLTFLoader().setKTX2Loader(ktx).setMeshoptDecoder(MeshoptDecoder);
          const reference = await loader.loadAsync(
            prefix + `humanoid.ranger.male.${source.variant}.gltf`,
          );
          const clips = (await loader.loadAsync(prefix + index.clips.file)).animations;
          const mixer = new THREE.AnimationMixer(reference.scene);
          check(clips.length === asset.clips.length, "shared clips lost during binding");
          for (const clip of clips) {
            for (const fraction of [0, 0.25, 0.7]) {
              mixer.stopAllAction();
              mixer.clipAction(clip).play();
              mixer.setTime(clip.duration * fraction);
              reference.scene.updateMatrixWorld(true);
              a.seek(clip.name, clip.duration * fraction);
              a.root.updateMatrixWorld(true);
              for (const name of ["hand_r", "hand_l", "Head", "pelvis"]) {
                const expected = reference.scene.getObjectByName(name);
                const actual = a.root.getObjectByName(name);
                check(expected && actual, `missing oracle joint ${name}`);
                expected.matrixWorld.toArray().forEach((value: number, i: number) => {
                  maxJointError = Math.max(
                    maxJointError,
                    Math.abs(value - actual.matrixWorld.elements[i]),
                  );
                });
              }
            }
          }
          check(
            maxJointError < 0.0002,
            `shared clip pose differs from plain Three.js: ${maxJointError}`,
          );
          const { disposeDecoded } = await import("/packages/renderer/download-bundle.js");
          disposeDecoded(reference);
        } finally {
          ktx.dispose();
        }
      }

      let failureCleanup = null;
      if (compact && mode !== "compact-knight") {
        // Reject after successful geometry/texture decode: no clips, not a network failure.
        const malformed = {
          ...index,
          entries: index.entries.map((entry: any) =>
            entry.key === source.key && entry.variant === source.variant
              ? { ...entry, clips: undefined }
              : entry,
          ),
        };
        let disposals = 0;
        const prototypes = [
          THREE.BufferGeometry.prototype,
          THREE.Material.prototype,
          THREE.Texture.prototype,
        ];
        const originals = prototypes.map((proto) => proto.dispose);
        prototypes.forEach((proto, i) => {
          proto.dispose = function () {
            disposals++;
            originals[i].call(this);
          };
        });
        let rejected = false;
        try {
          await module.adaptImportedCharacterBundle({ ...source, manifest: malformed }, options);
        } catch (error) {
          rejected = /no animation clips/.test(String(error));
        } finally {
          prototypes.forEach((proto, i) => {
            proto.dispose = originals[i];
          });
        }
        check(
          rejected && disposals > 20,
          "failed character admission must release decoded resources",
        );
        check(
          workers.size === 0 && liveUrls.size === 0,
          "failed admission leaked workers/object URLs",
        );
        failureCleanup = { disposals, workers: workers.size, objectUrls: liveUrls.size };
      }
      check(workers.size === 0 && liveUrls.size === 0, "oracle left workers/object URLs alive");
      return {
        mode,
        maxJointError,
        failureCleanup,
        clips: asset.clips.length,
        meshes: meshes(a.root).length,
        visiblePixels: visible,
        decodeMs,
        firstRenderMs,
        assetBytes: timing
          .filter((t) => t.name.includes("/assets/"))
          .reduce((n, t) => n + t.encodedBodySize, 0),
        totalBodyBytes: timing.reduce((n, t) => n + t.encodedBodySize, 0),
        requests: timing.map((t) => ({
          path: new URL(t.name).pathname,
          bytes: t.encodedBodySize,
          transferBytes: t.transferSize,
          durationMs: t.duration,
        })),
        progress,
      };
    }, mode);
    await page.locator("canvas").screenshot({ path: resolve(output, `${mode}.png`) });
    const cleanup = await page.evaluate(() => (window as any).finish());
    if (errors.length) {
      throw Error(errors.join("\n"));
    }
    results.push({ ...result, cleanup });
    await context.close();
    console.log(
      `${mode}: ${result.assetBytes} asset bytes; first frame ${result.firstRenderMs.toFixed(0)} ms`,
    );
  }
  await writeFile(
    resolve(output, "observations.json"),
    JSON.stringify(
      {
        browser: browser.version(),
        network: { latencyMs: 40, downloadBytesPerSecond: 1_250_000 },
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  server.stop(true);
}
