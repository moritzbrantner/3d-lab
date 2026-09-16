export async function run({page}) {
  await page.goto("http://127.0.0.1:4173/renderer-performance/", {waitUntil: "networkidle"})
  await page.waitForFunction(
    () => window.__THREE_D_RENDERER_PERF__?.status === "ready",
    undefined,
    {timeout: 30_000},
  )

  await page.getByRole("button", {name: "Run renderer canary"}).click()
  await page.waitForFunction(
    () => {
      const status = window.__THREE_D_RENDERER_PERF__?.status
      return status === "done" || status === "error"
    },
    undefined,
    {timeout: 60_000},
  )

  const state = await page.evaluate(() => window.__THREE_D_RENDERER_PERF__)
  if (!state || state.status !== "done") {
    throw new Error(`renderer canary failed: ${state?.error ?? "missing result"}`)
  }
  if (state.frameCount !== 64) {
    throw new Error(`renderer canary expected 64 frames, got ${state.frameCount}`)
  }
}
