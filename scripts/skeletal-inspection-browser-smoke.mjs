// Chromium smoke for the skeletal animation inspection tools:
//   bun scripts/skeletal-inspection-browser-smoke.mjs URL OUTPUT_DIR
// Functional acceptance (viewport picking, exact inputs, inspection modes,
// keyboard) plus a screenshot; never a wall-clock performance gate.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:4173/skeletal-animation/";
const output = process.argv[3] ?? "target/skeletal-inspection-browser-smoke";
await mkdir(output, { recursive: true });
const errors = [];
const browser = await chromium.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

try {
  await page.goto(url, { waitUntil: "networkidle" });
  const lab = page.locator('section[aria-label="Skeletal animation deep dive"]');
  await lab.getByRole("button", { name: /Inspect rig, clip & weights/ }).click();
  const viewport = lab.getByRole("group", { name: /Interactive 3D view/ });
  const canvas = viewport.locator("canvas");
  const inspector = lab.getByRole("complementary", { name: "Inspector" });
  const tree = inspector.getByRole("tree", { name: "Joint hierarchy" });
  const readout = (name) => inspector.locator(`[data-readout="${name}"]`);
  const timeInput = lab.getByRole("spinbutton", { name: "Clip time (s)" });
  const frameInput = lab.getByRole("spinbutton", { name: "Frame", exact: true });
  const commit = async (input, value) => {
    await input.fill(String(value));
    await input.press("Enter");
  };
  const pickPoints = async () => {
    await page.waitForFunction((el) => Boolean(el.dataset.pickPoints), await canvas.elementHandle());
    return (await canvas.evaluate((el) => JSON.parse(el.dataset.pickPoints)))
      .map(([kind, id, x, y]) => ({ kind: kind === "j" ? "joint" : "vertex", id, x, y }));
  };
  const clickCanvasAt = async ({ x, y }) => {
    const box = await canvas.boundingBox();
    await page.mouse.click(box.x + x, box.y + y);
  };

  assert(await canvas.evaluate((el) => {
    const context = el.getContext("webgl2");
    return context && !context.isContextLost();
  }), "skeletal lab WebGL context must be live");

  // Exact clip time first so the expected transforms are closed-form: shoulder -18, elbow 18, wrist 8.
  await commit(timeInput, 0);
  assert.equal(await readout("time").innerText(), "0.000 s · frame 0 / 60");

  // 1. Picking a joint in the viewport selects it in the hierarchy and drives the readouts.
  let points = await pickPoints();
  await clickCanvasAt(points.find((p) => p.kind === "joint" && p.id === 2));
  assert.equal(await tree.getByRole("treeitem", { name: /Wrist/ }).getAttribute("aria-selected"), "true", "viewport pick selects the wrist");
  assert.equal(await canvas.evaluate((el) => el.parentElement.dataset.selectedJoint), "2");
  assert.equal(await readout("local-position").innerText(), "0.000, 1.500, 0.000");
  assert.equal(await readout("local-rotation").innerText(), "0.00, 0.00, 8.00");
  assert.equal(await readout("model-position").innerText(), "0.464, 1.427, 0.000");
  assert.equal(await readout("model-rotation").innerText(), "0.00, 0.00, 8.00");

  await clickCanvasAt(points.find((p) => p.kind === "joint" && p.id === 1));
  assert.equal(await tree.getByRole("treeitem", { name: /Elbow/ }).getAttribute("aria-selected"), "true");
  assert.equal(await readout("model-position").innerText(), "0.464, -0.073, 0.000");
  assert.equal(await readout("local-rotation").innerText(), "0.00, 0.00, 18.00");
  assert.equal(await readout("model-rotation").innerText(), "0.00, 0.00, 0.00");

  // 2. Searchable hierarchy and tree keyboard behaviour.
  const search = inspector.getByRole("searchbox", { name: "Search joints" });
  await search.fill("elb");
  assert.deepEqual(await tree.getByRole("treeitem").allInnerTexts().then((t) => t.map((s) => s.replace(/\s*#\d+$/, ""))), ["Shoulder", "Elbow"]);
  await search.fill("zzz");
  assert.equal(await tree.getByRole("treeitem").count(), 0);
  await inspector.getByRole("status").waitFor();
  await search.fill("");
  assert.equal(await tree.getByRole("treeitem").count(), 3);
  await tree.getByRole("treeitem", { name: /Elbow/ }).focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await tree.getByRole("treeitem", { name: /Wrist/ }).getAttribute("aria-selected"), "true", "ArrowDown selects the next joint");
  assert(await tree.getByRole("treeitem", { name: /Wrist/ }).evaluate((el) => el === document.activeElement), "focus follows selection");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await tree.getByRole("treeitem", { name: /Elbow/ }).getAttribute("aria-selected"), "true", "ArrowLeft selects the parent");
  await page.keyboard.press("Home");
  assert.equal(await tree.getByRole("treeitem", { name: /Shoulder/ }).getAttribute("aria-selected"), "true");
  assert.equal(await readout("local-position").innerText(), "0.000, -1.500, 0.000");

  // 3. Exact numeric clip, frame and range controls share one clip state.
  await commit(timeInput, 1.25);
  assert.equal(await readout("time").innerText(), "1.250 s · frame 38 / 60");
  assert.equal(await readout("keyframes").innerText(), "0, 1, 2 s · segment 2");
  await commit(frameInput, 45);
  assert.equal(await readout("time").innerText(), "1.500 s · frame 45 / 60");
  assert.equal(Number(await timeInput.getAttribute("aria-valuenow")), 1.5);
  assert.equal(await readout("duration").innerText(), "2.00 s · 60 frames @ 30 fps");
  assert.equal(await readout("interpolation").innerText(), "smoothstep per segment");
  await commit(lab.getByRole("spinbutton", { name: "Range start (s)" }), 0.5);
  await commit(lab.getByRole("spinbutton", { name: "Range end (s)" }), 1.5);
  assert.equal(await readout("range").innerText(), "0.500 – 1.500 s");
  // The range cannot collapse: a start within one frame of the end is rejected and the range is kept.
  const rangeStart = lab.getByRole("spinbutton", { name: "Range start (s)" });
  await commit(rangeStart, 1.49);
  assert.equal(await rangeStart.getAttribute("aria-invalid"), "true");
  assert.equal(await readout("range").innerText(), "0.500 – 1.500 s");
  await rangeStart.press("Escape");

  // 4. Play once: restarts at the range start and stops exactly at the range end.
  const loop = lab.getByRole("checkbox", { name: "Loop" });
  assert(await loop.isChecked());
  await loop.uncheck();
  assert.equal(await readout("loop").innerText(), "play once");
  const play = lab.getByRole("button", { name: /^(Play|Pause) clip$/ });
  await play.click();
  await lab.getByRole("button", { name: "Play clip" }).waitFor({ timeout: 30_000 });
  assert.equal(await readout("time").innerText(), "1.500 s · frame 45 / 60", "play-once stops at the range end");
  await loop.check();

  // 5. Viewport keyboard: Space toggles playback, period steps a frame.
  await viewport.focus();
  await page.keyboard.press("Space");
  await lab.getByRole("button", { name: "Pause clip" }).waitFor();
  await page.keyboard.press("Space");
  await lab.getByRole("button", { name: "Play clip" }).waitFor();
  await commit(frameInput, 30);
  await viewport.focus();
  await page.keyboard.press(".");
  assert.match(await readout("time").innerText(), /frame 31 \/ 60$/, "period steps one frame");
  await page.keyboard.press(",");
  assert.match(await readout("time").innerText(), /frame 30 \/ 60$/, "comma steps one frame back");

  // 6. Influence visualization modes change the rendered mesh; vertex weights read exactly.
  const jointsShot = await canvas.screenshot();
  await inspector.getByRole("radio", { name: "Selected joint weight" }).check();
  await inspector.getByLabel(/weight, 0 to 100 percent/).waitFor();
  const heatShot = await canvas.screenshot();
  assert.notEqual(Buffer.compare(jointsShot, heatShot), 0, "weight heat map changes the rendered rig");
  await inspector.getByRole("radio", { name: "Mesh only" }).check();
  const plainShot = await canvas.screenshot();
  assert.notEqual(Buffer.compare(heatShot, plainShot), 0, "mesh-only mode changes the rendered rig");
  await inspector.getByRole("radio", { name: "Selected joint weight" }).check();

  await inspector.getByLabel("Inspected vertex").selectOption("6");
  assert.equal(await readout("weight-0").innerText(), "35.0%");
  assert.equal(await readout("weight-1").innerText(), "65.0%");
  assert.equal(await readout("weight-sum").innerText(), "100.0%");
  await commit(inspector.getByRole("spinbutton", { name: "Elbow weight (authored vertex) (%)" }), 30);
  assert.equal(await readout("weight-0").innerText(), "70.0%");
  assert.equal(await readout("weight-1").innerText(), "30.0%");

  // Pick a vertex in the viewport, away from any joint handle.
  points = await pickPoints();
  const joints = points.filter((p) => p.kind === "joint");
  const candidate = points
    .filter((p) => p.kind === "vertex" && p.id !== 6)
    .map((p) => ({ ...p, gap: Math.min(...joints.map((j) => Math.hypot(j.x - p.x, j.y - p.y))) }))
    .sort((a, b) => b.gap - a.gap)[0];
  await clickCanvasAt(candidate);
  assert.equal(await inspector.getByLabel("Inspected vertex").inputValue(), String(candidate.id), "viewport pick selects the vertex");

  await page.screenshot({ path: path.join(output, "skeletal-inspection.png") });
  assert.deepEqual(errors, []);
  console.log("skeletal inspection smoke passed");
} finally {
  await browser.close();
}
