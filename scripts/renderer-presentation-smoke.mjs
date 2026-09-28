// Chromium acceptance for the reusable renderer's presentation semantics:
// frame environment defaults, vertex color space, emissive/unlit shading, fog, and shadow focus.
// bun scripts/renderer-presentation-smoke.mjs [OUTPUT_DIR]
// Functional pixel checks on SwiftShader, never a wall-clock performance gate.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as THREE from "three";
import { chromium } from "playwright";
import { projectWorldPoint } from "../packages/renderer/index.js";

const SIZE = 64;
const repository = path.resolve(import.meta.dir, "..");
const output = process.argv[2] ?? "target/renderer-presentation-smoke";
await mkdir(output, { recursive: true });

// Bundle the renderer (with its own Three.js) for the page.
const buildDirectory = await mkdtemp(path.join(os.tmpdir(), "renderer-presentation-"));
const entry = path.join(buildDirectory, "entry.js");
await writeFile(
  entry,
  `import { createThreeSceneRenderer } from ${JSON.stringify(path.join(repository, "packages/renderer/index.js"))};\n` +
    "window.createThreeSceneRenderer = createThreeSceneRenderer;\n",
);
const build = await Bun.build({ entrypoints: [entry], target: "browser", format: "iife" });
await rm(buildDirectory, { recursive: true, force: true });
assert(build.success, `renderer bundle failed: ${build.logs.join("\n")}`);
const bundle = await build.outputs[0].text();

function camera(eye, target, up = [0, 1, 0], fov = 50) {
  const perspective = new THREE.PerspectiveCamera(fov, 1, 0.1, 500);
  perspective.coordinateSystem = THREE.WebGPUCoordinateSystem;
  perspective.up.set(...up);
  perspective.position.set(...eye);
  perspective.lookAt(...target);
  perspective.updateMatrixWorld();
  perspective.updateProjectionMatrix();
  return {
    viewMatrix: perspective.matrixWorldInverse.toArray(),
    projectionMatrix: perspective.projectionMatrix.toArray(),
  };
}

const browser = await chromium.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
});
const errors = [];
const page = await browser.newPage();
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
});
await page.setContent("<!doctype html><body></body>");
await page.addScriptTag({ content: bundle });

/** Render frames with one renderer and return RGBA pixels plus work observations per frame. */
async function draw(options, frames) {
  const outputs = await page.evaluate(
    ({ size, options, frames }) => {
      const canvas = document.createElement("canvas");
      document.body.append(canvas);
      const renderer = window.createThreeSceneRenderer(canvas, {
        antialias: false,
        pixelRatioLimit: 1,
        ...options,
      });
      renderer.setSize(size, size, 1);
      const gl = canvas.getContext("webgl2");
      const results = frames.map((frame) => {
        const observations = renderer.render(frame);
        const pixels = new Uint8Array(size * size * 4);
        gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return { pixels: Array.from(pixels), observations };
      });
      renderer.dispose();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
      return results;
    },
    { size: SIZE, options, frames },
  );
  return outputs;
}

function pixelAt(pixels, frameCamera, point) {
  const projected = projectWorldPoint(frameCamera, point, { width: SIZE, height: SIZE });
  const x = Math.floor(projected.x);
  const y = SIZE - 1 - Math.floor(projected.y);
  const offset = (y * SIZE + x) * 4;
  return pixels.slice(offset, offset + 4);
}

function maxChannelDifference(a, b) {
  let max = 0;
  for (let index = 0; index < a.length; index += 1) max = Math.max(max, Math.abs(a[index] - b[index]));
  return max;
}

function assertNear(actual, expected, tolerance, message) {
  assert(
    actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance),
    `${message}: ${JSON.stringify(actual)} is not within ${tolerance} of ${JSON.stringify(expected)}`,
  );
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const checks = [];
const evidence = {};

try {
  // 1. Omitted, empty, and explicit-default environments render identically, and returning to
  //    an omitted environment after a custom one restores the defaults exactly.
  const sceneCamera = camera([4, 5, 7], [0, 0.5, 0]);
  const nodes = [
    { id: "ground", transform: { translation: [0, -0.1, 0] }, geometry: { kind: "box", size: [10, 0.2, 10] }, color: "#78a861" },
    { id: "box", transform: { translation: [0, 0.5, 0], rotationQuaternion: [0, 0.2, 0, 1] }, geometry: { kind: "box", size: [1, 1, 1] }, color: 0xd2b48c },
    { id: "sphere", transform: { translation: [1.5, 0.6, -1] }, geometry: { kind: "sphere", radius: 0.6 }, color: "#8fd3ff", opacity: 0.6 },
  ];
  const explicitDefault = {
    background: 0x0c111a,
    sky: { skyColor: 0xffffff, groundColor: 0x334433, intensity: 1.7 },
    sun: { direction: [10, 18, 8], color: 0xffffff, intensity: 2.2 },
    fog: null,
    shadowFocus: [0, 0, 0],
    shadowExtent: 5,
  };
  const dusk = {
    background: "#1d2440",
    sky: { skyColor: "#8aa4d6", groundColor: "#2b2418", intensity: 0.6 },
    sun: { direction: [-4, 2, 1], color: "#ffb070", intensity: 1.1 },
    fog: { color: "#1d2440", near: 4, far: 30 },
    shadowFocus: [1, 0, 1],
    shadowExtent: 8,
  };
  for (const options of [{}, { shadows: true }, { alpha: true }]) {
    const label = JSON.stringify(options);
    const explicit = options.alpha ? { ...explicitDefault, background: undefined } : explicitDefault;
    const [omitted, empty, explicitFrame, custom, restored] = await draw(options, [
      { camera: sceneCamera, nodes },
      { camera: sceneCamera, nodes, environment: {} },
      { camera: sceneCamera, nodes, environment: explicit },
      { camera: sceneCamera, nodes, environment: dusk },
      { camera: sceneCamera, nodes },
    ]);
    for (const [name, frame] of [["empty", empty], ["explicit default", explicitFrame], ["restored", restored]]) {
      assert.equal(maxChannelDifference(frame.pixels, omitted.pixels), 0, `${label} ${name} environment matches omitted`);
    }
    assert(maxChannelDifference(custom.pixels, omitted.pixels) > 32, `${label} custom environment changes the frame`);
    const updates = [omitted, empty, explicitFrame, custom, restored].map((frame) => frame.observations.environmentUpdateCount);
    assert.deepEqual(updates, [0, 0, 0, 5, 5], `${label} environment update counts`);
    evidence[`defaults ${label}`] = updates;
  }
  checks.push("omitted, empty, explicit-default and restored environments render identically");

  // 2. Vertex colors are sRGB like node colors, interpolate, and multiply the node color in linear space.
  const flatCamera = camera([0, 0, 5], [0, 0, 0]);
  const quad = (colors) => ({
    kind: "mesh",
    resourceKey: `quad:${JSON.stringify(colors ?? null)}`,
    positions: [[-3, -3, 0], [3, -3, 0], [3, 3, 0], [-3, 3, 0]],
    indices: [0, 1, 2, 0, 2, 3],
    normals: [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]],
    ...(colors ? { colors } : {}),
  });
  const node = (fields) => ({ id: "quad", transform: { translation: [0, 0, 0] }, color: "#ffffff", geometry: quad(), ...fields });
  const sea = [0x33, 0x99, 0x66];
  const seaVertex = sea.map((channel) => channel / 255);
  const uniform = quad([seaVertex, seaVertex, seaVertex, seaVertex]);
  const [unlitVertex, unlitNode, litVertex, litNode, tinted, gradient] = await draw({}, [
    { camera: flatCamera, nodes: [node({ geometry: uniform, unlit: true })] },
    { camera: flatCamera, nodes: [node({ color: "#339966", unlit: true })] },
    { camera: flatCamera, nodes: [node({ geometry: uniform })] },
    { camera: flatCamera, nodes: [node({ color: "#339966" })] },
    { camera: flatCamera, nodes: [node({ geometry: uniform, color: "#808080", unlit: true })] },
    { camera: flatCamera, nodes: [node({ geometry: quad([[1, 0, 0], [0, 0, 1], [0, 0, 1], [1, 0, 0]]), unlit: true })] },
  ]);
  const middle = [0, 0, 0];
  assertNear(pixelAt(unlitVertex.pixels, flatCamera, middle), [...sea, 255], 1, "unlit vertex color round-trips sRGB");
  assert(maxChannelDifference(unlitVertex.pixels, unlitNode.pixels) <= 1, "vertex color matches the equal node color");
  assert(maxChannelDifference(litVertex.pixels, litNode.pixels) <= 1, "lit vertex color matches the equal lit node color");
  const tint = sea.map((channel) => Math.round(255 * toSrgb(toLinear(channel / 255) * toLinear(0x80 / 255))));
  assertNear(pixelAt(tinted.pixels, flatCamera, middle), [...tint, 255], 1, "node color multiplies vertex color in linear space");
  const left = pixelAt(gradient.pixels, flatCamera, [-1.5, 0, 0]);
  const right = pixelAt(gradient.pixels, flatCamera, [1.5, 0, 0]);
  assert(left[0] > left[2] && right[2] > right[0], `vertex colors interpolate: ${left} / ${right}`);
  evidence.vertexColors = { unlit: pixelAt(unlitVertex.pixels, flatCamera, middle), tinted: pixelAt(tinted.pixels, flatCamera, middle), left, right };
  checks.push("vertex colors are sRGB, interpolate, and multiply the node color in linear space");

  // 3. Emissive glows and unlit ignores lights in a fully dark environment.
  const dark = {
    background: 0x000000,
    sky: { skyColor: 0, groundColor: 0, intensity: 0 },
    sun: { direction: [0, 1, 0], color: 0, intensity: 0 },
  };
  const [emissive, lit, unlit] = await draw({}, [
    { camera: flatCamera, environment: dark, nodes: [node({ color: "#000000", emissive: "#ff8800" })] },
    { camera: flatCamera, environment: dark, nodes: [node({ color: "#ffee00" })] },
    { camera: flatCamera, environment: dark, nodes: [node({ color: "#ffee00", unlit: true })] },
  ]);
  assertNear(pixelAt(emissive.pixels, flatCamera, middle), [255, 0x88, 0, 255], 1, "emissive glows without light");
  assert.deepEqual(pixelAt(lit.pixels, flatCamera, middle), [0, 0, 0, 255], "lit node is black without light");
  assertNear(pixelAt(unlit.pixels, flatCamera, middle), [255, 0xee, 0, 255], 1, "unlit node ignores lights");
  checks.push("emissive nodes glow and unlit nodes ignore lighting");

  // 4. Fog, background, and transparent defaults.
  const white = [node({ unlit: true })];
  const [fogged, clear, redFog, fogOff, background] = await draw({}, [
    { camera: flatCamera, nodes: white, environment: { fog: { color: "#000000", near: 1, far: 2 } } },
    { camera: flatCamera, nodes: white, environment: { fog: { color: "#000000", near: 10, far: 20 } } },
    { camera: flatCamera, nodes: white, environment: { fog: { color: "#ff0000", near: 0, far: 1 } } },
    { camera: flatCamera, nodes: white, environment: { fog: null } },
    { camera: flatCamera, nodes: [], environment: { background: "#336699" } },
  ]);
  assert.deepEqual(pixelAt(fogged.pixels, flatCamera, middle), [0, 0, 0, 255], "beyond fog far is fog color");
  assert.deepEqual(pixelAt(clear.pixels, flatCamera, middle), [255, 255, 255, 255], "before fog near is unfogged");
  assert.deepEqual(pixelAt(redFog.pixels, flatCamera, middle), [255, 0, 0, 255], "fog color applies to unlit nodes");
  assert.deepEqual(pixelAt(fogOff.pixels, flatCamera, middle), [255, 255, 255, 255], "null fog disables fog");
  assertNear(pixelAt(background.pixels, flatCamera, middle), [0x33, 0x66, 0x99, 255], 1, "environment background");
  const [transparent, opaque] = await draw({ alpha: true }, [
    { camera: flatCamera, nodes: [] },
    { camera: flatCamera, nodes: [], environment: { background: "#336699" } },
  ]);
  assert.equal(pixelAt(transparent.pixels, flatCamera, middle)[3], 0, "alpha renderer stays transparent by default");
  assertNear(pixelAt(opaque.pixels, flatCamera, middle), [0x33, 0x66, 0x99, 255], 1, "explicit background on an alpha renderer");
  checks.push("fog, background, and alpha defaults");

  // 5. A shadow focus far from the origin brings the sun's shadow map to the viewer.
  const topCamera = camera([98.5, 30, 100], [98.5, 0, 100], [0, 0, -1], 20);
  const shadowNodes = [
    { id: "ground", transform: { translation: [100, -0.1, 100] }, geometry: { kind: "box", size: [40, 0.2, 40] }, color: "#ffffff" },
    { id: "post", transform: { translation: [100, 1, 100] }, geometry: { kind: "box", size: [1, 2, 1] }, color: "#ffffff" },
  ];
  const sun = { direction: [1, 1, 0], color: 0xffffff, intensity: 2.2 };
  const [unfocused, focused, repeated] = await draw({ shadows: true }, [
    { camera: topCamera, nodes: shadowNodes, environment: { sun } },
    { camera: topCamera, nodes: shadowNodes, environment: { sun, shadowFocus: [100, 0, 100], shadowExtent: 10 } },
    { camera: topCamera, nodes: shadowNodes, environment: { sun, shadowFocus: [100, 0, 100], shadowExtent: 10 } },
  ]);
  const occluded = [98.5, 0, 100];
  const open = [95, 0, 100];
  const luminance = ([red, green, blue]) => red + green + blue;
  assert(
    luminance(pixelAt(focused.pixels, topCamera, occluded)) + 60 < luminance(pixelAt(unfocused.pixels, topCamera, occluded)),
    "focused shadow darkens the occluded ground",
  );
  assert.deepEqual(pixelAt(focused.pixels, topCamera, open), pixelAt(unfocused.pixels, topCamera, open), "unoccluded ground unchanged");
  assert.deepEqual(
    [unfocused, focused, repeated].map((frame) => frame.observations.environmentUpdateCount),
    [1, 1, 0],
    "shadow focus update counts",
  );
  evidence.shadow = { unfocused: pixelAt(unfocused.pixels, topCamera, occluded), focused: pixelAt(focused.pixels, topCamera, occluded) };
  checks.push("shadow focus moves the sun's shadow frame to the viewer");

  // 6. A resourceKey reused with a different color layout keeps rendering its cached payload:
  //    the material follows the cached geometry, not the resubmitted colors.
  const green = [0, 1, 0];
  const reusedQuad = (colors) => ({ ...quad(colors), resourceKey: "reused" });
  const recolored = { camera: flatCamera, nodes: [node({ geometry: reusedQuad([green, green, green, green]), unlit: true })] };
  const uncolored = { camera: flatCamera, nodes: [node({ geometry: reusedQuad(), unlit: true })] };
  const [plainFirst, colorsAdded] = await draw({}, [uncolored, recolored]);
  const [coloredFirst, colorsRemoved] = await draw({}, [recolored, uncolored]);
  assert.deepEqual(pixelAt(plainFirst.pixels, flatCamera, middle), [255, 255, 255, 255], "uncolored payload renders the node color");
  assert.deepEqual(pixelAt(colorsAdded.pixels, flatCamera, middle), [255, 255, 255, 255], "colors added under a reused key keep the cached payload");
  assert.deepEqual(pixelAt(coloredFirst.pixels, flatCamera, middle), [0, 255, 0, 255], "colored payload renders its vertex colors");
  assert.deepEqual(pixelAt(colorsRemoved.pixels, flatCamera, middle), [0, 255, 0, 255], "colors removed under a reused key keep the cached payload");
  for (const frame of [colorsAdded, colorsRemoved]) {
    const { geometryCreateCount, materialCreateCount, materialEvictCount } = frame.observations;
    assert.deepEqual([geometryCreateCount, materialCreateCount, materialEvictCount], [0, 0, 0], "reused key reuses its geometry and material");
  }
  evidence.reusedResourceKey = { colorsAdded: pixelAt(colorsAdded.pixels, flatCamera, middle), colorsRemoved: pixelAt(colorsRemoved.pixels, flatCamera, middle) };
  checks.push("a reused resourceKey keeps rendering its cached payload, colors included");

  assert.deepEqual(errors, [], "page must not report errors or warnings");
} finally {
  await writeFile(path.join(output, "result.json"), `${JSON.stringify({ checks, evidence, errors }, null, 2)}\n`);
  await browser.close();
}
console.log(JSON.stringify({ checks }, null, 2));
