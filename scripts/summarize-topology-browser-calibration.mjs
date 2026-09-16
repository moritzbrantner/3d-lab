import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [referenceRoot, candidateRoot, outputPath] = process.argv.slice(2);
if (!referenceRoot || !candidateRoot || !outputPath) {
  throw new Error(
    "usage: summarize-topology-browser-calibration.mjs <reference-root> <candidate-root> <output-json>",
  );
}

const metricDefinitions = [
  ["topLevelDurationUs", "us", (summary) => summary.top_level_duration_us],
  ["longTaskCount", "count", (summary) => summary.long_task_count],
  ["longTaskTotalDurationUs", "us", (summary) => summary.long_task_total_duration_us],
  ["longestTaskUs", "us", (summary) => summary.longest_task_us],
  [
    "javascriptInclusiveDurationUs",
    "us",
    (summary) => runtimeDuration(summary, "javascript"),
  ],
  ["otherInclusiveDurationUs", "us", (summary) => runtimeDuration(summary, "other")],
];

function runtimeDuration(summary, runtimeKind) {
  return (
    summary.runtime_attribution.find((entry) => entry.runtime_kind === runtimeKind)?.inclusive_duration_us ?? 0
  );
}

function percentile(sorted, fraction) {
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function stats(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length;
  const standardDeviation = Math.sqrt(variance);
  const median = percentile(sorted, 0.5);
  return {
    count: sorted.length,
    min: round(sorted[0]),
    median: round(median),
    p90: round(percentile(sorted, 0.9)),
    max: round(sorted.at(-1)),
    mean: round(mean),
    standardDeviation: round(standardDeviation),
    coefficientOfVariationPct: mean === 0 ? null : round((standardDeviation / Math.abs(mean)) * 100),
    rangeVsMedianPct: median === 0 ? null : round(((sorted.at(-1) - sorted[0]) / Math.abs(median)) * 100),
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function browserIdentity(runtime) {
  return {
    schemaVersion: runtime.schema_version,
    adapterVersion: runtime.adapter_version,
    adapterDigest: runtime.adapter_digest,
    normalizerDigest: runtime.normalizer_digest,
    journeyDigest: runtime.journey_digest,
    nodeVersion: runtime.node_version,
    playwrightVersion: runtime.playwright_version,
    browserName: runtime.browser_name,
    browserVersion: runtime.browser_version,
    viewport: runtime.viewport,
    traceCategories: runtime.trace_categories,
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function loadRuns(root) {
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (entries.length < 3) {
    throw new Error(`expected at least 3 calibration runs in ${root}, found ${entries.length}`);
  }
  return Promise.all(
    entries.map(async (entry) => {
      const runPath = path.join(root, entry.name);
      return {
        id: entry.name,
        summary: await readJson(path.join(runPath, "chromium-trace-summary.json")),
        runtime: await readJson(path.join(runPath, "browser-runtime.json")),
        environment: await readJson(path.join(runPath, "environment.json")),
      };
    }),
  );
}

function assertSingleIdentity(referenceRuns, candidateRuns) {
  const runs = [...referenceRuns, ...candidateRuns];
  const browserIdentities = new Map(
    runs.map((run) => [stableJson(browserIdentity(run.runtime)), browserIdentity(run.runtime)]),
  );
  if (browserIdentities.size !== 1) {
    throw new Error(`browser runtime identity drifted across calibration runs (${browserIdentities.size} identities)`);
  }
  const environmentFingerprints = new Set(runs.map((run) => run.environment.fingerprint));
  if (environmentFingerprints.size !== 1) {
    throw new Error(
      `environment fingerprint drifted across calibration runs (${environmentFingerprints.size} fingerprints)`,
    );
  }
  return {
    browser: browserIdentities.values().next().value,
    environmentFingerprint: environmentFingerprints.values().next().value,
  };
}

function metricSummary(runs) {
  return Object.fromEntries(
    metricDefinitions.map(([name, unit, readMetric]) => [
      name,
      {
        unit,
        ...stats(runs.map((run) => readMetric(run.summary))),
      },
    ]),
  );
}

function pairedDeltaSummary(referenceRuns, candidateRuns) {
  return Object.fromEntries(
    metricDefinitions
      .filter(([, unit]) => unit === "us")
      .map(([name, , readMetric]) => {
        const deltas = referenceRuns.map((referenceRun, index) => {
          const reference = readMetric(referenceRun.summary);
          const candidate = readMetric(candidateRuns[index].summary);
          return reference === 0 ? 0 : ((candidate - reference) / reference) * 100;
        });
        return [name, { unit: "percent", ...stats(deltas) }];
      }),
  );
}

const referenceRuns = await loadRuns(referenceRoot);
const candidateRuns = await loadRuns(candidateRoot);
if (referenceRuns.length !== candidateRuns.length) {
  throw new Error(
    `reference/candidate run count mismatch: ${referenceRuns.length} vs ${candidateRuns.length}`,
  );
}

const identity = assertSingleIdentity(referenceRuns, candidateRuns);
const report = {
  schemaVersion: "3d-lab/topology-browser-calibration/v1",
  runtimeBudget: {
    enabled: false,
    reason: "calibration-only evidence; review repeated variance before selecting and enforcing a runtime budget",
  },
  runCountPerSide: referenceRuns.length,
  identity,
  referenceSource: referenceRuns[0].environment.source,
  candidateSource: candidateRuns[0].environment.source,
  reference: metricSummary(referenceRuns),
  candidate: metricSummary(candidateRuns),
  pairedCandidateVsReference: pairedDeltaSummary(referenceRuns, candidateRuns),
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
