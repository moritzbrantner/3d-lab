#!/usr/bin/env python3
"""Summarize repeated unchanged-source Chromium renderer captures."""

from __future__ import annotations

import argparse
import json
import math
import statistics
from pathlib import Path
from typing import Any

SUMMARY_SCHEMA = "runtime-profiler/chromium-trace-summary/v1"
MANIFEST_SCHEMA = "runtime-profiler/bundle-manifest/v1"
BROWSER_SCHEMA = "runtime-profiler/browser-runtime/v1"
OUTPUT_SCHEMA = "3d-lab/renderer-browser-variance/v1"


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError(f"missing required evidence file: {path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"invalid JSON evidence file {path}: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"evidence file must contain a JSON object: {path}")
    return value


def percentile_nearest_rank(values: list[int], percentile: float) -> int:
    ordered = sorted(values)
    rank = max(1, math.ceil(percentile * len(ordered)))
    return ordered[rank - 1]


def metric_statistics(values: list[int]) -> dict[str, Any]:
    ordered = sorted(values)
    median = statistics.median(ordered)
    mean = statistics.fmean(ordered)
    population_standard_deviation = statistics.pstdev(ordered)
    deviations = [abs(value - median) for value in ordered]
    median_absolute_deviation = statistics.median(deviations)
    return {
        "samples": values,
        "min": ordered[0],
        "median": median,
        "mean": mean,
        "p95": percentile_nearest_rank(ordered, 0.95),
        "max": ordered[-1],
        "median_absolute_deviation": median_absolute_deviation,
        "population_standard_deviation": population_standard_deviation,
        "coefficient_of_variation_percent": (
            0.0 if mean == 0 else population_standard_deviation / mean * 100.0
        ),
        "range_percent_of_median": (
            0.0 if median == 0 else (ordered[-1] - ordered[0]) / median * 100.0
        ),
    }


def runtime_duration(summary: dict[str, Any], runtime_kind: str) -> int:
    entries = summary.get("runtime_attribution")
    if not isinstance(entries, list):
        raise ValueError("chromium trace summary is missing runtime_attribution")
    for entry in entries:
        if isinstance(entry, dict) and entry.get("runtime_kind") == runtime_kind:
            value = entry.get("inclusive_duration_us")
            if isinstance(value, int) and value >= 0:
                return value
    raise ValueError(
        f"chromium trace summary is missing {runtime_kind!r} runtime attribution"
    )


def event_dispatch_max_us(summary: dict[str, Any]) -> int:
    hot_paths = summary.get("hot_paths")
    if not isinstance(hot_paths, list):
        raise ValueError("chromium trace summary is missing hot_paths")
    candidates: list[int] = []
    for hot_path in hot_paths:
        if not isinstance(hot_path, dict):
            continue
        frames = hot_path.get("frames")
        if (
            isinstance(frames, list)
            and len(frames) == 1
            and isinstance(frames[0], dict)
            and frames[0].get("name") == "EventDispatch"
            and frames[0].get("category") == "devtools.timeline"
        ):
            value = hot_path.get("max_duration_us")
            if isinstance(value, int) and value >= 0:
                candidates.append(value)
    if not candidates:
        raise ValueError(
            "chromium trace summary is missing the top-level EventDispatch hot path"
        )
    return max(candidates)


def load_bundle(bundle: Path) -> dict[str, Any]:
    manifest = read_json(bundle / "manifest.json")
    browser = read_json(bundle / "browser-runtime.json")
    summary = read_json(bundle / "chromium-trace-summary.json")
    if manifest.get("schema_version") != MANIFEST_SCHEMA:
        raise ValueError(f"unsupported manifest schema in {bundle}")
    if browser.get("schema_version") != BROWSER_SCHEMA:
        raise ValueError(f"unsupported browser runtime schema in {bundle}")
    if summary.get("schema_version") != SUMMARY_SCHEMA:
        raise ValueError(f"unsupported Chromium summary schema in {bundle}")

    source = manifest.get("source")
    if not isinstance(source, dict) or not isinstance(source.get("git_sha"), str):
        raise ValueError(f"bundle manifest lacks source identity: {bundle}")

    def required_nonnegative_int(name: str) -> int:
        value = summary.get(name)
        if not isinstance(value, int) or value < 0:
            raise ValueError(
                f"Chromium summary field {name!r} must be a non-negative integer: {bundle}"
            )
        return value

    return {
        "bundle": bundle.as_posix(),
        "bundle_id": manifest.get("bundle_id"),
        "scenario_id": manifest.get("scenario_id"),
        "scenario_digest": manifest.get("scenario_digest"),
        "environment_fingerprint": manifest.get("environment_fingerprint"),
        "source": source,
        "browser_runtime": browser,
        "metrics": {
            "event_dispatch_max_us": event_dispatch_max_us(summary),
            "longest_task_us": required_nonnegative_int("longest_task_us"),
            "top_level_duration_us": required_nonnegative_int(
                "top_level_duration_us"
            ),
            "javascript_inclusive_duration_us": runtime_duration(
                summary, "javascript"
            ),
            "long_task_count": required_nonnegative_int("long_task_count"),
            "trace_event_count": required_nonnegative_int("trace_event_count"),
        },
    }


def summarize_bundles(
    bundle_paths: list[Path], expected_samples: int | None = None
) -> dict[str, Any]:
    if not bundle_paths:
        raise ValueError("at least one renderer browser evidence bundle is required")
    if expected_samples is not None and len(bundle_paths) != expected_samples:
        raise ValueError(
            f"expected {expected_samples} samples, got {len(bundle_paths)}"
        )

    captures = [load_bundle(path) for path in bundle_paths]
    first = captures[0]
    identity_fields = [
        "scenario_id",
        "scenario_digest",
        "environment_fingerprint",
        "source",
        "browser_runtime",
    ]
    for capture in captures[1:]:
        for field in identity_fields:
            if capture[field] != first[field]:
                raise ValueError(
                    f"unchanged-source variance requires identical {field}; "
                    f"mismatch in {capture['bundle']}"
                )

    metric_names = list(first["metrics"].keys())
    metrics = {
        name: metric_statistics(
            [capture["metrics"][name] for capture in captures]
        )
        for name in metric_names
    }
    return {
        "schema_version": OUTPUT_SCHEMA,
        "sample_count": len(captures),
        "identity": {
            "scenario_id": first["scenario_id"],
            "scenario_digest": first["scenario_digest"],
            "environment_fingerprint": first["environment_fingerprint"],
            "source": first["source"],
            "browser_runtime": first["browser_runtime"],
        },
        "bundle_ids": [capture["bundle_id"] for capture in captures],
        "metrics": metrics,
        "policy": {
            "kind": "calibration-only",
            "release_verdict": False,
            "note": (
                "Repeated unchanged-source evidence describes variance; "
                "it does not define a regression budget."
            ),
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundles", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--expected-samples", type=int)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        report = summarize_bundles(args.bundles, args.expected_samples)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
