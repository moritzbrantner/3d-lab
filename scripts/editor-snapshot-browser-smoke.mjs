// Functional editor snapshot acceptance and screenshot; never a wall-clock performance gate.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:4173/editor/";
const output = process.argv[3] ?? "target/editor-snapshot-browser-smoke";
await mkdir(output, { recursive: true });
const errors = [];
const checks = [];
const browser = await chromium.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

let result;
try {
  await page.goto(url, { waitUntil: "networkidle" });
  const editor = page.locator('section[aria-labelledby="scene-editor-heading"]');
  const translationX = editor.locator("fieldset").filter({ hasText: "Translation" }).locator("input").first();
  await translationX.fill("1.25");
  assert.equal(Number(await translationX.inputValue()), 1.25);

  const downloadPromise = page.waitForEvent("download");
  await editor.getByRole("button", { name: "Export JSON", exact: true }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "3d-lab-scene.snapshot.json");
  const exportedPath = await download.path();
  assert(exportedPath, "snapshot export must produce a download");
  const snapshot = JSON.parse(await readFile(exportedPath, "utf8"));
  assert.equal(snapshot.schema, "3d-lab/editor-scene-snapshot/v1");
  assert.equal(snapshot.nodes.find((node) => node.id === "body").transform.translation[0], 1.25);
  assert(!("history" in snapshot), "semantic history must not leak into the snapshot");
  assert(!("selection" in snapshot), "editor selection must not leak into the snapshot");
  checks.push("deterministic model-only JSON export");

  const body = snapshot.nodes.find((node) => node.id === "body");
  body.transform.translation[0] = -0.625;
  snapshot.nodes.push({
    id: "imported-group",
    name: "Imported group",
    parent: "scene",
    transform: { translation: [0, 1.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const fileInput = editor.locator('input[aria-label="Import scene snapshot"]');
  await fileInput.setInputFiles({
    name: "round-trip.snapshot.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(snapshot)),
  });
  await editor.getByRole("button", { name: /Imported group/ }).waitFor();
  assert.equal(Number(await translationX.inputValue()), -0.625);
  assert(await editor.getByRole("button", { name: "Undo", exact: true }).isDisabled(),
    "snapshot import must establish a fresh semantic-history boundary");
  checks.push("structural import rebuilds the viewport and resets command history");

  await page.evaluate(() => {
    const originalText = File.prototype.text;
    File.prototype.text = function delayedSnapshotText() {
      const contents = originalText.call(this);
      if (!this.name.startsWith("slow-")) return contents;
      return new Promise((resolve, reject) => {
        window.setTimeout(() => void contents.then(resolve, reject), 180);
      });
    };
  });
  const stale = structuredClone(snapshot);
  stale.nodes.find((node) => node.id === "body").transform.translation[0] = 9;
  stale.nodes.find((node) => node.id === "imported-group").name = "Stale group";
  const latest = structuredClone(snapshot);
  latest.nodes.find((node) => node.id === "body").transform.translation[0] = -1.125;
  latest.nodes.find((node) => node.id === "imported-group").name = "Latest group";
  await fileInput.setInputFiles({
    name: "slow-stale.snapshot.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(stale)),
  });
  await fileInput.setInputFiles({
    name: "latest.snapshot.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(latest)),
  });
  await editor.getByRole("button", { name: /Latest group/ }).waitFor();
  await page.waitForTimeout(250);
  assert.equal(await editor.getByRole("button", { name: /Stale group/ }).count(), 0);
  assert.equal(Number(await translationX.inputValue()), -1.125);
  checks.push("most recently selected snapshot wins overlapping asynchronous file reads");

  const invalid = { ...latest, schema: "3d-lab/editor-scene-snapshot/v999" };
  await fileInput.setInputFiles({
    name: "invalid.snapshot.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(invalid)),
  });
  await editor.getByRole("status").filter({ hasText: "Import failed" }).waitFor();
  assert.equal(Number(await translationX.inputValue()), -1.125,
    "invalid snapshot must leave the accepted scene unchanged");
  checks.push("invalid schema fails closed without replacing scene state");

  await editor.screenshot({ path: path.join(output, "scene-snapshot.png") });
  assert.deepEqual(errors, [], "page and WebGL console errors must be absent");
  result = { schema: "editor-snapshot-browser-smoke/v1", status: "pass", browser: browser.version(), checks };
} catch (error) {
  await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
  result = {
    schema: "editor-snapshot-browser-smoke/v1",
    status: "fail",
    checks,
    errors,
    error: error instanceof Error ? error.stack : String(error),
  };
  process.exitCode = 1;
} finally {
  await writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}
