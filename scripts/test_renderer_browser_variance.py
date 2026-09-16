#!/usr/bin/env python3

import json
import tempfile
import unittest
from pathlib import Path

from summarize_renderer_browser_variance import (
    BROWSER_SCHEMA,
    MANIFEST_SCHEMA,
    SUMMARY_SCHEMA,
    summarize_bundles,
)

SURFACE_DIGEST = "sha256:" + "a" * 64


class RendererBrowserVarianceTests(unittest.TestCase):
    def write_bundle(
        self,
        root: Path,
        name: str,
        event_us: int,
        source_sha: str = "abc",
    ) -> Path:
        bundle = root / name
        bundle.mkdir()
        manifest = {
            "schema_version": MANIFEST_SCHEMA,
            "bundle_id": name,
            "scenario_id": "3d-lab-renderer-browser",
            "scenario_digest": "scenario",
            "environment_fingerprint": "environment",
            "source": {"git_sha": source_sha, "dirty": False},
        }
        browser = {
            "schema_version": BROWSER_SCHEMA,
            "adapter_version": "adapter",
            "browser_name": "chromium",
            "browser_version": "1",
            "viewport": {"width": 1280, "height": 720},
        }
        summary = {
            "schema_version": SUMMARY_SCHEMA,
            "trace_event_count": 1000 + event_us,
            "top_level_duration_us": event_us * 3,
            "long_task_count": 1,
            "longest_task_us": event_us,
            "hot_paths": [
                {
                    "frames": [
                        {
                            "name": "EventDispatch",
                            "category": "devtools.timeline",
                        }
                    ],
                    "max_duration_us": event_us,
                }
            ],
            "runtime_attribution": [
                {
                    "runtime_kind": "javascript",
                    "inclusive_duration_us": event_us * 4,
                }
            ],
        }
        for filename, value in [
            ("manifest.json", manifest),
            ("browser-runtime.json", browser),
            ("chromium-trace-summary.json", summary),
        ]:
            (bundle / filename).write_text(json.dumps(value), encoding="utf-8")
        return bundle

    def test_summarizes_repeated_unchanged_source_samples(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundles = [
                self.write_bundle(root, "a", 90),
                self.write_bundle(root, "b", 100),
                self.write_bundle(root, "c", 110),
            ]
            report = summarize_bundles(
                bundles,
                calibration_surface_digest=SURFACE_DIGEST,
                expected_samples=3,
            )
            metric = report["metrics"]["event_dispatch_max_us"]
            self.assertEqual(report["sample_count"], 3)
            self.assertEqual(metric["min"], 90)
            self.assertEqual(metric["median"], 100)
            self.assertEqual(metric["p95"], 110)
            self.assertEqual(metric["max"], 110)
            self.assertEqual(metric["median_absolute_deviation"], 10)
            self.assertEqual(
                report["identity"]["calibration_surface_digest"], SURFACE_DIGEST
            )
            self.assertEqual(report["policy"]["kind"], "calibration-only")
            self.assertFalse(report["policy"]["release_verdict"])

    def test_rejects_source_identity_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundles = [
                self.write_bundle(root, "a", 90, "abc"),
                self.write_bundle(root, "b", 100, "def"),
            ]
            with self.assertRaisesRegex(ValueError, "identical source"):
                summarize_bundles(
                    bundles,
                    calibration_surface_digest=SURFACE_DIGEST,
                )

    def test_rejects_wrong_sample_count(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = self.write_bundle(root, "a", 90)
            with self.assertRaisesRegex(ValueError, "expected 7 samples"):
                summarize_bundles(
                    [bundle],
                    calibration_surface_digest=SURFACE_DIGEST,
                    expected_samples=7,
                )

    def test_rejects_invalid_surface_digest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = self.write_bundle(root, "a", 90)
            with self.assertRaisesRegex(ValueError, "sha256"):
                summarize_bundles(
                    [bundle],
                    calibration_surface_digest="not-a-digest",
                )


if __name__ == "__main__":
    unittest.main()
