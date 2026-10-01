// Chromium acceptance for the reusable renderer's presentation semantics:
// frame environment defaults, vertex color space, emissive/unlit shading, fog, shadow focus and
// caster reach, material sharing across nodes and reused geometry keys, and static GLB assets
// adapted in the page and rendered as nodes and instance batches with exact resource reuse.
// bun scripts/renderer-presentation-smoke.mjs [OUTPUT_DIR]
// Functional pixel checks on SwiftShader, never a wall-clock performance gate.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as THREE from "three";
import { chromium } from "playwright";
import { projectWorldPoint } from "../packages/renderer/index.js";
import { adaptStaticGlb, staticGlbInstanceBatches, staticGlbSceneNodes } from "../packages/renderer/static-glb.js";

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
    "window.createThreeSceneRenderer = createThreeSceneRenderer;\n" +
    `import { adaptStaticGlb } from ${JSON.stringify(path.join(repository, "packages/renderer/static-glb.js"))};\n` +
    "window.adaptStaticGlb = adaptStaticGlb;\n",
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
    shadowCasterReach: 5,
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

  // 7. Equal emissive, unlit, and vertex-colored nodes share materials through render(), and the
  //    cache counters report creation, reuse, and eviction exactly.
  const coloredTriangle = (resourceKey) => ({
    kind: "mesh",
    resourceKey,
    positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    indices: [0, 1, 2],
    colors: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  });
  const at = (x) => ({ translation: [x, 0, 0] });
  const glowing = [
    { id: "glow-a", transform: at(-3), geometry: { kind: "box", size: [1, 1, 1] }, color: "#202020", emissive: "#ff8800" },
    { id: "glow-b", transform: at(-2), geometry: { kind: "sphere", radius: 0.5 }, color: "#202020", emissive: "#ff8800" },
  ];
  const markers = [
    { id: "marker-a", transform: at(-1), geometry: { kind: "cylinder", radius: 0.5, height: 0.1 }, color: "#ffee00", unlit: true },
    { id: "marker-b", transform: at(0), geometry: { kind: "box", size: [1, 0.1, 1] }, color: "#ffee00", unlit: true },
  ];
  const terrain = [
    { id: "terrain-a", transform: at(1), geometry: coloredTriangle("terrain-a"), color: "#ffffff" },
    { id: "terrain-b", transform: at(2), geometry: coloredTriangle("terrain-b"), color: "#ffffff" },
  ];
  const [shared, withoutMarkers] = await draw({}, [
    { camera: flatCamera, nodes: [...glowing, ...markers, ...terrain] },
    { camera: flatCamera, nodes: [...glowing, ...terrain] },
  ]);
  const materialCounts = ({ materialCreateCount, materialReuseCount, materialEvictCount, liveMaterialCount }) => ({
    materialCreateCount,
    materialReuseCount,
    materialEvictCount,
    liveMaterialCount,
  });
  assert.deepEqual(
    materialCounts(shared.observations),
    { materialCreateCount: 3, materialReuseCount: 3, materialEvictCount: 0, liveMaterialCount: 3 },
    "six nodes in three shading groups share three materials",
  );
  assert.deepEqual(
    materialCounts(withoutMarkers.observations),
    { materialCreateCount: 0, materialReuseCount: 4, materialEvictCount: 1, liveMaterialCount: 2 },
    "dropping the unlit group evicts only its material",
  );
  evidence.materials = { shared: materialCounts(shared.observations), withoutMarkers: materialCounts(withoutMarkers.observations) };
  checks.push("equal emissive, unlit, and vertex-colored nodes share materials with exact counters");

  // 8. Under a low evening sun, a tower about 27 units sunward is beyond the default shadow frame's
  //    near plane and casts nothing onto the focus; shadowCasterReach brings its shadow in.
  const groundCamera = camera([0, 30, 0], [0, 0, 0], [0, 0, -1], 20);
  const towerNodes = [
    { id: "ground", transform: { translation: [0, -0.1, 0] }, geometry: { kind: "box", size: [12, 0.2, 12] }, color: "#ffffff" },
    { id: "tower", transform: { translation: [27, 10, 0] }, geometry: { kind: "box", size: [2, 20, 2] }, color: "#ffffff" },
  ];
  const evening = { direction: [1, 0.36, 0], color: 0xffffff, intensity: 2.2 };
  const [shortReach, longReach] = await draw({ shadows: true }, [
    { camera: groundCamera, nodes: towerNodes, environment: { sun: evening } },
    { camera: groundCamera, nodes: towerNodes, environment: { sun: evening, shadowCasterReach: 30 } },
  ]);
  const underTower = [0, 0, 0];
  const beside = [0, 0, 3];
  assert(
    luminance(pixelAt(longReach.pixels, groundCamera, underTower)) + 60 < luminance(pixelAt(shortReach.pixels, groundCamera, underTower)),
    "caster reach brings the distant tower's shadow onto the focus",
  );
  assert.deepEqual(pixelAt(shortReach.pixels, groundCamera, underTower), pixelAt(shortReach.pixels, groundCamera, beside), "default reach leaves the focus lit");
  assert.deepEqual(pixelAt(longReach.pixels, groundCamera, beside), pixelAt(shortReach.pixels, groundCamera, beside), "ground beside the tower's shadow unchanged");
  evidence.casterReach = {
    shortReach: pixelAt(shortReach.pixels, groundCamera, underTower),
    longReach: pixelAt(longReach.pixels, groundCamera, underTower),
    beside: pixelAt(longReach.pixels, groundCamera, beside),
  };
  checks.push("shadowCasterReach lets occluders far toward a low sun shade the focus");

  // 9. Instance batches use the shared lit material path: vertex colors and the batch color render
  //    like the equal node, batches on colored and uncolored meshes never share a material, fog
  //    applies, and a batched occluder casts into a moved shadow focus like a node does.
  const batchOf = (fields) => ({
    id: "batch",
    geometry: quad(),
    color: "#ffffff",
    instances: [{ transform: { translation: [0, 0, 0] } }],
    ...fields,
  });
  const [batchVertex, batchPlain, batchFogged] = await draw({}, [
    { camera: flatCamera, nodes: [], instanceBatches: [batchOf({ geometry: uniform })] },
    { camera: flatCamera, nodes: [], instanceBatches: [batchOf({ color: "#339966" })] },
    {
      camera: flatCamera,
      nodes: [],
      instanceBatches: [batchOf({ color: "#339966" })],
      environment: { fog: { color: "#000000", near: 1, far: 2 } },
    },
  ]);
  assert(maxChannelDifference(batchVertex.pixels, litVertex.pixels) <= 1, "vertex-colored batch matches the vertex-colored lit node");
  assert(maxChannelDifference(batchPlain.pixels, litNode.pixels) <= 1, "batch color matches the equal lit node color");
  assert.deepEqual(
    [batchPlain.observations.materialCreateCount, batchPlain.observations.materialEvictCount],
    [1, 1],
    "a batch on an uncolored mesh does not reuse the vertex-color batch material",
  );
  assert.deepEqual(pixelAt(batchFogged.pixels, flatCamera, middle), [0, 0, 0, 255], "fog applies to batches");
  const batchedPost = {
    id: "posts",
    geometry: { kind: "box", size: [1, 2, 1] },
    color: "#ffffff",
    instances: [{ transform: { translation: [100, 1, 100] } }],
  };
  const groundOnly = shadowNodes.filter((entry) => entry.id === "ground");
  const [batchUnfocused, batchFocused] = await draw({ shadows: true }, [
    { camera: topCamera, nodes: groundOnly, instanceBatches: [batchedPost], environment: { sun } },
    {
      camera: topCamera,
      nodes: groundOnly,
      instanceBatches: [batchedPost],
      environment: { sun, shadowFocus: [100, 0, 100], shadowExtent: 10 },
    },
  ]);
  assert(
    luminance(pixelAt(batchFocused.pixels, topCamera, occluded)) + 60 < luminance(pixelAt(batchUnfocused.pixels, topCamera, occluded)),
    "a batched occluder casts into the focused shadow frame",
  );
  assert.deepEqual(pixelAt(batchFocused.pixels, topCamera, occluded), pixelAt(focused.pixels, topCamera, occluded), "batched and node occluders cast the same shadow");
  evidence.instanceBatches = {
    vertex: pixelAt(batchVertex.pixels, flatCamera, middle),
    plain: pixelAt(batchPlain.pixels, flatCamera, middle),
    shadow: pixelAt(batchFocused.pixels, topCamera, occluded),
  };
  checks.push("instance batches share the lit material path, fog, and shadow frame with nodes");

  // 10. Static GLB assets: the adapter runs in Chromium and lowers the committed rock/tree GLBs to
  //     the same descriptors as under Bun; repeated placements and transform-only frames reuse every
  //     geometry and material; batches render the rock like equal nodes.
  const glbBytes = {
    rock: await readFile(path.join(repository, "fixtures/static-glb/rock.glb")),
    tree: await readFile(path.join(repository, "fixtures/static-glb/tree.glb")),
  };
  const [rock, tree] = [await adaptStaticGlb(glbBytes.rock), await adaptStaticGlb(glbBytes.tree)];
  const inPage = await page.evaluate(async (sources) => {
    const assets = {};
    for (const [name, bytes] of Object.entries(sources)) assets[name] = await window.adaptStaticGlb(new Uint8Array(bytes));
    return assets;
  }, { rock: Array.from(glbBytes.rock), tree: Array.from(glbBytes.tree) });
  assert.deepEqual(inPage.rock, JSON.parse(JSON.stringify(rock)), "rock adapts identically in Chromium and Bun");
  assert.deepEqual(inPage.tree, JSON.parse(JSON.stringify(tree)), "tree adapts identically in Chromium and Bun");

  const glbCamera = camera([0, 3, 9], [0, 1.4, 0]);
  const rockSpots = [[-2.4, 0, 1], [2.4, 0, 1], [0, 0, 2.5]];
  const placeRocks = (offset) =>
    rockSpots.flatMap((spot, index) =>
      staticGlbSceneNodes(rock, { id: `rock-${index}`, transform: { translation: [spot[0], spot[1] + offset, spot[2]] } }),
    );
  const placeTree = (offset) => staticGlbSceneNodes(tree, { id: "oak", transform: { translation: [0, offset, -1] } });
  const [glbFirst, glbMoved] = await draw({}, [
    { camera: glbCamera, nodes: [...placeRocks(0), ...placeTree(0)] },
    { camera: glbCamera, nodes: [...placeRocks(0.2), ...placeTree(0.1)] },
  ]);
  const resourceCounts = (o) => ({
    objectCreateCount: o.objectCreateCount,
    geometryCreateCount: o.geometryCreateCount,
    geometryReuseCount: o.geometryReuseCount,
    materialCreateCount: o.materialCreateCount,
    liveGeometryCount: o.liveGeometryCount,
    liveMaterialCount: o.liveMaterialCount,
  });
  // 3 rock nodes + 4 tree drawables; 1 rock + 3 tree geometries; rock, bark, and foliage materials.
  assert.deepEqual(
    resourceCounts(glbFirst.observations),
    { objectCreateCount: 7, geometryCreateCount: 4, geometryReuseCount: 3, materialCreateCount: 3, liveGeometryCount: 4, liveMaterialCount: 3 },
    "repeated rock placements and the tree's shared trunk mesh reuse geometry and materials",
  );
  assert.deepEqual(
    resourceCounts(glbMoved.observations),
    { objectCreateCount: 0, geometryCreateCount: 0, geometryReuseCount: 7, materialCreateCount: 0, liveGeometryCount: 4, liveMaterialCount: 3 },
    "a transform-only frame recreates no GLB resources",
  );
  const canopy = pixelAt(glbFirst.pixels, glbCamera, [0, 2.5, -1]);
  const trunkPixel = pixelAt(glbFirst.pixels, glbCamera, [0, 0.6, -0.8]);
  const rockPixel = pixelAt(glbFirst.pixels, glbCamera, [2.4, 0.5, 1.5]);
  const sky = pixelAt(glbFirst.pixels, glbCamera, [-3, 4.5, -1]);
  assert.deepEqual(sky, [0x0c, 0x11, 0x1a, 255], "the sky stays background");
  assert(canopy[1] > canopy[0] && canopy[1] > canopy[2], `vertex-colored canopy renders green: ${canopy}`);
  assert(trunkPixel[0] > trunkPixel[2] && trunkPixel[0] > trunkPixel[1], `bark trunk renders brown: ${trunkPixel}`);
  assert(luminance(rockPixel) > luminance(sky) + 30, `rock renders lit: ${rockPixel}`);

  const rockBatches = staticGlbInstanceBatches(rock, {
    id: "rocks",
    revision: "rocks-v1",
    instances: rockSpots.map((spot) => ({ transform: { translation: spot } })),
  });
  const [rockNodesOnly, rockBatched] = await draw({}, [
    { camera: glbCamera, nodes: placeRocks(0) },
    { camera: glbCamera, nodes: [], instanceBatches: rockBatches },
  ]);
  assert(maxChannelDifference(rockBatched.pixels, rockNodesOnly.pixels) <= 1, "batched rocks render like rock nodes");
  assert.deepEqual(
    [rockBatched.observations.instanceBatchCount, rockBatched.observations.instanceCount, rockBatched.observations.liveGeometryCount],
    [1, 3, 1],
    "three rock placements are one batch over one geometry",
  );
  // Lowered materials never carry emissive/unlit shading, so every tree drawable (bark and the
  // vertex-colored foliage) batches and renders like the equal tree nodes.
  const treeBatches = staticGlbInstanceBatches(tree, { id: "oaks", instances: [{ transform: { translation: [0, 0, -1] } }] });
  const [treeNodesOnly, treeBatched] = await draw({}, [
    { camera: glbCamera, nodes: placeTree(0) },
    { camera: glbCamera, nodes: [], instanceBatches: treeBatches },
  ]);
  assert(maxChannelDifference(treeBatched.pixels, treeNodesOnly.pixels) <= 1, "batched tree renders like tree nodes");
  assert.equal(treeBatched.observations.instanceBatchCount, 4, "every tree drawable is one batch");
  evidence.staticGlb = {
    first: resourceCounts(glbFirst.observations),
    moved: resourceCounts(glbMoved.observations),
    canopy,
    trunk: trunkPixel,
    rock: rockPixel,
  };
  checks.push("static GLB assets adapt in Chromium, render, and reuse geometry/materials across placements and transform-only frames");

  assert.deepEqual(errors, [], "page must not report errors or warnings");
} finally {
  await writeFile(path.join(output, "result.json"), `${JSON.stringify({ checks, evidence, errors }, null, 2)}\n`);
  await browser.close();
}
console.log(JSON.stringify({ checks }, null, 2));
