import { performance } from "node:perf_hooks"

import { projectWorldPoint, validateRenderFrame } from "../packages/renderer/index.js"

const RUNS = 3
const NODE_COUNT = 10_000
const PROJECTION_COUNT = 10_000
const IDENTITY = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]

const camera = {
  viewMatrix: IDENTITY,
  projectionMatrix: IDENTITY,
}
const nodes = Array.from({ length: NODE_COUNT }, (_, index) => ({
  id: `node-${index}`,
  geometry:
    index % 3 === 0
      ? { kind: "box", size: [1, 1, 1] }
      : index % 3 === 1
        ? { kind: "sphere", radius: 0.5 }
        : { kind: "cylinder", radius: 0.5, height: 1 },
  color: index % 2 === 0 ? 0x336699 : "#993366",
  transform: {
    translation: [((index % 101) - 50) / 50, ((Math.floor(index / 101) % 101) - 50) / 50, 0],
  },
}))
const frame = { camera, nodes }
const viewport = { width: 1920, height: 1080 }

let expectedChecksum
const elapsedMs = []
for (let run = 0; run < RUNS; run += 1) {
  const started = performance.now()
  const validated = validateRenderFrame(frame)
  let checksum = validated.nodes.length
  for (let index = 0; index < PROJECTION_COUNT; index += 1) {
    const x = ((index % 101) - 50) / 50
    const y = ((Math.floor(index / 101) % 101) - 50) / 50
    const projected = projectWorldPoint(camera, [x, y, 0], viewport)
    checksum += Math.round(projected.x) + Math.round(projected.y) + (projected.visible ? 1 : 0)
  }
  elapsedMs.push(performance.now() - started)
  expectedChecksum ??= checksum
  if (checksum !== expectedChecksum) {
    throw new Error(`3d-lab performance smoke became nondeterministic: ${checksum} != ${expectedChecksum}`)
  }
}

elapsedMs.sort((left, right) => left - right)
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      suite: "3d-lab/renderer-contract-v1",
      scenario: "validate-and-project-10k",
      runs: RUNS,
      nodeValidations: NODE_COUNT,
      projections: PROJECTION_COUNT,
      checksum: expectedChecksum,
      medianElapsedMs: elapsedMs[Math.floor(RUNS / 2)],
      deterministic: true,
      timing: "advisory-shared-runner",
    },
    null,
    2,
  ),
)
