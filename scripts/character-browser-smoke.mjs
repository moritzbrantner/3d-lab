// Existing Chromium lane: bun scripts/character-browser-smoke.mjs URL OUTPUT_DIR
// Functional acceptance and screenshots, never a wall-clock performance gate.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:4173/skeletal-animation/";
const output = process.argv[3] ?? "target/character-browser-smoke";
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
const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
let result;
try {
  await page.goto(url, { waitUntil: "networkidle" });
  const region = page.locator('section[aria-labelledby="character-rig-heading"]');
  const canvas = region.locator("canvas");
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas[aria-label="Interactive animated humanoid rig"]');
    return canvas?.dataset.sourceDraws === "31" &&
      canvas.dataset.materialDraws === "3" &&
      canvas.dataset.skinMode === "weighted" &&
      Number(canvas.dataset.blendedVertices) > 0 &&
      canvas.dataset.skinIndexBytes === "4";
  });
  assert(await canvas.evaluate((element) => {
    const context = element.getContext("webgl2");
    return context && !context.isContextLost();
  }), "character WebGL context must be live");
  checks.push("WebGL initialization, weighted-skin contract and authored-part/material budget");

  const time = region.getByRole("spinbutton", { name: "Exact time (seconds)" });
  const speed = region.getByRole("spinbutton", { name: /Playback speed/ });
  await time.fill("0.73125");
  await time.press("Enter");
  close(Number(await time.inputValue()), 0.73125);
  assert(await region.getByRole("button", { name: "Play motion", exact: true }).isVisible());
  await region.getByRole("button", { name: "Next frame (1/60 second)", exact: true }).click();
  close(Number(await time.inputValue()), 0.73125 + 1 / 60);
  await region.getByRole("button", { name: "Previous frame (1/60 second)", exact: true }).click();
  close(Number(await time.inputValue()), 0.73125);
  checks.push("exact seconds and reversible 1/60-second stepping");

  await time.fill("1.234567");
  await time.press("Escape");
  close(Number(await time.inputValue()), 0.73125);
  await time.fill("");
  await time.press("Enter");
  close(Number(await time.inputValue()), 0.73125);
  await speed.fill("0.75");
  await speed.press("Enter");
  close(Number(await speed.inputValue()), 0.75);
  checks.push("editing drafts, Escape cancellation, empty-value rejection, exact speed");

  const paused = await time.inputValue();
  await page.evaluate(() => new Promise((resolve) => {
    let frames = 0;
    const next = () => { if (++frames === 12) resolve(); else requestAnimationFrame(next); };
    requestAnimationFrame(next);
  }));
  assert.equal(await time.inputValue(), paused);
  checks.push("paused clock remains unchanged across browser frames");

  await time.fill("0");
  await time.press("Enter");
  await region.getByRole("button", { name: "Previous frame (1/60 second)", exact: true }).click();
  close(Number(await time.inputValue()), 0);
  await time.fill("10");
  await time.press("Enter");
  await region.getByRole("button", { name: "Next frame (1/60 second)", exact: true }).click();
  close(Number(await time.inputValue()), 1 / 0.42);
  checks.push("frame stepping clamps at both clip boundaries");

  await region.getByRole("button", { name: "Wave", exact: true }).click();
  await region.getByRole("button", { name: "Play motion", exact: true }).click();
  await page.waitForFunction(() => {
    const input = document.querySelector('section[aria-labelledby="character-rig-heading"] input[type="number"]');
    return Number(input?.value) > 0.03;
  });
  await region.getByRole("button", { name: "Pause motion", exact: true }).click();
  await time.fill("0.6");
  await time.press("Enter");
  await canvas.screenshot({ path: path.join(output, "wave.png") });
  checks.push("motion switching and playback advance");

  await region.getByRole("checkbox", { name: "Show bind pose", exact: true }).check();
  await canvas.screenshot({ path: path.join(output, "bind-pose.png") });
  await region.getByRole("checkbox", { name: "See skeleton through model", exact: true }).check();
  await canvas.screenshot({ path: path.join(output, "skeleton-xray.png") });
  checks.push("bind-pose and x-ray inspection with screenshots");
  const importedRegion = page.locator('section[aria-labelledby="imported-skin-heading"]');
  const importedCanvas = importedRegion.locator('canvas[aria-label="Imported Khronos SimpleSkin animation"]');
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas[aria-label="Imported Khronos SimpleSkin animation"]');
    return canvas?.dataset.importedReady === "true" &&
      canvas.dataset.joints === "2" &&
      canvas.dataset.clipCount === "1" &&
      Number(canvas.dataset.duration) === 5.5 &&
      canvas.dataset.sourceDraws === "1" &&
      canvas.dataset.materialDraws === "1" &&
      canvas.dataset.skinIndexBytes === "4";
  });
  assert(await importedCanvas.evaluate((element) => {
    const context = element.getContext("webgl2");
    return context && !context.isContextLost();
  }), "imported SimpleSkin WebGL context must be live");
  const importedTime = importedRegion.getByRole("spinbutton", { name: "Imported animation time (seconds)" });
  const pauseImported = importedRegion.getByRole("button", { name: "Pause imported animation", exact: true });
  if (await pauseImported.isVisible()) await pauseImported.click();
  await importedTime.fill("2.75");
  await importedTime.press("Enter");
  close(Number(await importedTime.inputValue()), 2.75);
  await importedCanvas.screenshot({ path: path.join(output, "imported-simpleskin.png") });
  checks.push("canonical imported SimpleSkin, weighted-renderer normalization and exact clip seek");

  assert.deepEqual(errors, [], "page and shader console errors must be absent");
  result = { schema: "character-browser-smoke/v1", status: "pass", browser: browser.version(), checks,
    limitations: "Functional Chromium/SwiftShader check, not hardware GPU performance or pixel-reference comparison." };
} catch (error) {
  await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
  result = { schema: "character-browser-smoke/v1", status: "fail", checks, errors,
    error: error instanceof Error ? error.stack : String(error) };
  process.exitCode = 1;
} finally {
  await writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}
