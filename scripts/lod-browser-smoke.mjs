// Focused Chromium acceptance for the screen-space LOD lab:
//   bun scripts/lod-browser-smoke.mjs [URL] [OUTPUT_DIR]
// Checks that viewport gestures and exact inputs drive one distance state, and
// that the canvas draws the level the Rust evidence selected at the canvas
// height it is actually drawn at. Not a timing gate.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:4173/lod/";
const output = process.argv[3] ?? "target/lod-browser-smoke";
const evidence = JSON.parse(await readFile(new URL("../fixtures/lod/screen-space-lod.json", import.meta.url), "utf8"));
const policyAt = (height) =>
  evidence.viewports
    .find((viewport) => viewport.heightPixels === height)
    .policies.find((entry) => entry.maxPixelError === 2 && entry.hysteresisPercent === 25);
const policy = policyAt(720);
const distanceAt = (index) => Number((evidence.distances.min + index * evidence.distances.step).toFixed(6));

await mkdir(output, { recursive: true });
const errors = [];
const checks = [];
const browser = await chromium.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

const canvas = page.locator('section[aria-labelledby="lod-lab-heading"] canvas');
const distanceInput = page.getByRole("spinbutton", { name: /Camera distance/ });
const rendered = () => canvas.getAttribute("data-rendered");
// The drawn CSS height must equal the Rust-evaluated height the lab looks decisions up in.
const expectDrawnHeight = async (height) => {
  await page.waitForFunction(
    (value) => {
      const element = document.querySelector('section[aria-labelledby="lod-lab-heading"] canvas');
      return element?.dataset.evidenceHeight === value && element.dataset.drawnHeight === value;
    },
    String(height),
    { timeout: 10_000 },
  );
};
const waitRendered = (expected) =>
  page.waitForFunction(
    (value) => document.querySelector('section[aria-labelledby="lod-lab-heading"] canvas')?.dataset.rendered === value,
    expected,
    { timeout: 10_000 },
  );

try {
  await page.goto(url, { waitUntil: "networkidle" });
  await waitRendered("0@6");
  await expectDrawnHeight(720);
  checks.push("initial distance 6 draws L0 on a 720 px canvas");

  const [coarsen] = policy.outboundSwitches;
  const out = distanceAt(coarsen.distanceIndex);
  await distanceInput.fill(String(out));
  await distanceInput.press("Enter");
  await waitRendered(`${coarsen.to}@${out}`);
  checks.push(`exact distance ${out} draws Rust-selected L${coarsen.to}`);

  const back = distanceAt(coarsen.distanceIndex - 2);
  await distanceInput.fill(String(back));
  await distanceInput.press("Enter");
  await waitRendered(`${coarsen.to}@${back}`);
  checks.push(`hysteresis keeps L${coarsen.to} at ${back}`);

  await canvas.hover();
  await page.mouse.wheel(0, 400);
  await page.waitForFunction(
    (previous) => {
      const value = document.querySelector('section[aria-labelledby="lod-lab-heading"] canvas')?.dataset.rendered;
      return value && !value.endsWith(`@${previous}`);
    },
    back,
  );
  const afterWheel = Number((await rendered()).split("@")[1]);
  assert(afterWheel > back, `wheel should dolly out: ${afterWheel}`);
  assert.equal(Number(await distanceInput.inputValue()), afterWheel, "exact input follows the viewport gesture");
  checks.push(`wheel dolly synchronized exact distance ${afterWheel}`);

  await page.getByRole("button", { name: "L3", exact: true }).click();
  await page.getByLabel("Split with source").check();
  await waitRendered(`0,3@${afterWheel}`);
  checks.push("override plus split view draws source and L3");

  const pixels = await canvas.screenshot({ path: path.join(output, "lod-split.png") });
  assert(pixels.byteLength > 10_000, "viewport screenshot should contain rendered geometry");

  // A short window snaps the canvas to the 360 px tables; switches move nearer the camera.
  await page.getByRole("button", { name: "Auto", exact: true }).click();
  await page.getByLabel("Split with source").uncheck();
  await page.setViewportSize({ width: 390, height: 640 });
  await expectDrawnHeight(360);
  const [shortCoarsen] = policyAt(360).outboundSwitches;
  assert(shortCoarsen.distanceIndex < coarsen.distanceIndex, "shorter canvas should coarsen nearer");
  const near = distanceAt(shortCoarsen.distanceIndex - 20);
  await distanceInput.fill(String(near));
  await distanceInput.press("Enter");
  await waitRendered(`${shortCoarsen.from}@${near}`);
  const shortOut = distanceAt(shortCoarsen.distanceIndex);
  await distanceInput.fill(String(shortOut));
  await distanceInput.press("Enter");
  await waitRendered(`${shortCoarsen.to}@${shortOut}`);
  checks.push(`360 px canvas draws Rust-selected L${shortCoarsen.to} at ${shortOut}`);
  assert.deepEqual(errors, []);
} finally {
  await writeFile(path.join(output, "lod-browser-smoke.json"), `${JSON.stringify({ url, checks, errors }, null, 2)}\n`);
  await browser.close();
}
console.log(checks.join("\n"));
