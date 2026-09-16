import { chromium } from "playwright"

const url = process.argv[2] ?? "http://127.0.0.1:4173/topology-performance/"
const browser = await chromium.launch({headless: true})
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}})
  await page.goto(url, {waitUntil: "networkidle"})
  await page.waitForFunction(() => window.__THREE_D_TOPOLOGY_RENDER_PERF__?.status === "ready", undefined, {timeout: 30_000})
  await page.getByRole("button", {name: "Run topology renderer canary"}).click()
  await page.waitForFunction(() => {
    const status = window.__THREE_D_TOPOLOGY_RENDER_PERF__?.status
    return status === "done" || status === "error"
  }, undefined, {timeout: 60_000})
  const state = await page.evaluate(() => window.__THREE_D_TOPOLOGY_RENDER_PERF__)
  if (!state || state.status !== "done") throw new Error(state?.error ?? "missing topology renderer canary result")
  process.stdout.write(`${JSON.stringify(state)}\n`)
} finally {
  await browser.close()
}
