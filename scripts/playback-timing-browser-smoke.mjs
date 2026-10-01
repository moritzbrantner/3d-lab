// Chromium smoke for the playback timing lab: bun scripts/playback-timing-browser-smoke.mjs URL OUTPUT_DIR
// Checks that exact wall-time input and timeline scrubbing drive one state and
// that the viewport presents the Rust frame the inspector reports.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:4173/animation-timing/";
const output = process.argv[3] ?? "target/playback-timing-browser-smoke";
await mkdir(output, { recursive: true });
const errors = [];
const browser = await chromium.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
try {
  await page.goto(url, { waitUntil: "networkidle" });
  const canvas = page.locator("canvas").first();
  assert(await canvas.evaluate((element) => {
    const context = element.getContext("webgl2");
    return context && !context.isContextLost();
  }), "timing lab WebGL context must be live");

  const timeline = page.getByRole("slider", { name: /Wall time; each tick/ });
  const wallInput = page.getByRole("spinbutton", { name: /Wall time/ });
  const presentedFrame = () => page.locator("dt", { hasText: "Presented frame" }).locator("xpath=following-sibling::dd").innerText();

  await wallInput.fill("1.25");
  await wallInput.press("Enter");
  assert.equal(Number(await timeline.getAttribute("aria-valuenow")), 1.25, "exact input drives the timeline");

  await page.getByRole("combobox").selectOption("steady-30");
  assert.equal(await presentedFrame(), "37 / 60", "1.25 s at 30 Hz presents frame 37");

  await timeline.scrollIntoViewIfNeeded();
  const box = await timeline.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const scrubbed = Number(await wallInput.getAttribute("aria-valuenow"));
  assert(Math.abs(scrubbed - 1) < 0.02, `timeline scrub drives the exact input (${scrubbed})`);

  await timeline.focus();
  await page.keyboard.press("ArrowRight");
  const stepped = await presentedFrame();
  assert.match(stepped, /^3[01] \/ 60$/, `arrow key steps one presented frame (${stepped})`);

  await page.screenshot({ path: path.join(output, "playback-timing.png") });
  await page.getByRole("button", { name: "Cross-fade" }).click();
  await page.screenshot({ path: path.join(output, "cross-fade.png") });
  assert.deepEqual(errors, []);
  console.log("playback timing smoke passed");
} finally {
  await browser.close();
}
