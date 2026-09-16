export async function run({page}) {
  await page.goto("http://127.0.0.1:4173/topology-performance/", {waitUntil: "networkidle"})
  await page.waitForFunction(
    () => window.__THREE_D_TOPOLOGY_RENDER_PERF__?.status === "ready",
    undefined,
    {timeout: 30_000},
  )

  await page.getByRole("button", {name: "Run topology renderer canary"}).click()
  await page.waitForFunction(
    () => {
      const status = window.__THREE_D_TOPOLOGY_RENDER_PERF__?.status
      return status === "done" || status === "error"
    },
    undefined,
    {timeout: 60_000},
  )

  const state = await page.evaluate(() => window.__THREE_D_TOPOLOGY_RENDER_PERF__)
  if (!state || state.status !== "done") {
    throw new Error(`topology renderer canary failed: ${state?.error ?? "missing result"}`)
  }
  if (state.operationCount !== 40) {
    throw new Error(`topology renderer canary expected 40 operations, got ${state.operationCount}`)
  }
  if (!state.work) throw new Error("topology renderer canary did not report work observations")
}
