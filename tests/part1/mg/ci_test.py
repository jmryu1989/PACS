"""D837: sample approval scope, cache integrity and bounded HTTP recovery (no network).

D73: asserts selected dependencies, requested bytes and failures, not source spelling.
"""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import urllib.error
import zipfile

import ci
from archive_download_test import DownloadContract


def approved_ids(spec):
    return {r["id"] for r in spec["used"] if spec["sets"][r["set"]].get("approval", "").split(" ", 1)[0] == "D717"}


def assert_local_only_matches_approval(test, spec):
    expected = approved_ids(spec)
    test.assertEqual(len(expected), 12, "D717 approval must cover the 12 local-only rows")
    test.assertEqual({r["id"] for r in spec["used"] if ci.local_only(r)}, expected,
                     "local-only selection must match independent D717 approval")


class MgCiTest(DownloadContract, unittest.TestCase):
    download = staticmethod(ci.download)

    def test_local_only_rows_match_d717_approval(self):
        assert_local_only_matches_approval(self, ci.manifest())

    def test_manifest_relocation_cannot_silently_drop_d717_exclusion(self):
        for field, value in [("collection", "renamed-collection"), ("path", "relocated/subject/series/sample.dcm")]:
            with self.subTest(field=field):
                spec = copy.deepcopy(ci.manifest())
                restricted = approved_ids(spec)
                for row in spec["used"]:
                    if row["id"] in restricted:
                        row[field] = value
                with self.assertRaisesRegex(AssertionError, "independent D717 approval"):
                    assert_local_only_matches_approval(self, spec)

    def test_hosted_exclusions_follow_manifest_dependencies(self):
        restricted_ids = approved_ids(ci.manifest())
        with mock.patch.dict(os.environ, {"KIN_MG_CI_SCOPE": "hosted"}):
            for name in ("dicom", "dom"):
                body, selected, excluded = ci.selection(name)
                for case in body["cases"]:
                    restricted = [s for s in case.get("samples", []) if s in restricted_ids]
                    self.assertEqual(case["name"] in selected, not restricted)
                self.assertEqual(len(selected) + len(excluded), body["expected"])
                self.assertTrue(all(e["reason"] == "D717 local-only sample" for e in excluded))
        with mock.patch.dict(os.environ, {"KIN_MG_CI_SCOPE": "local", "RUNNER_ENVIRONMENT": "local"}):
            for name in ("dicom", "dom"):
                body, selected, excluded = ci.selection(name)
                self.assertEqual(len(selected), body["expected"])
                self.assertEqual(excluded, [])

    def test_cache_paths_and_hash_key_exclude_local_only_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            with mock.patch.dict(os.environ, {"GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": "", "KIN_MG_CI_SCOPE": "hosted"}):
                with mock.patch("sys.stdout", new_callable=io.StringIO):
                    ci.plan()
            text = output.read_text(encoding="utf-8")
            rows = [r for r in ci.manifest()["used"] if r["id"] not in approved_ids(ci.manifest())]
            expected = hashlib.sha256("\n".join(sorted(r["sha256"] for r in rows)).encode("ascii")).hexdigest()
            self.assertIn("cache-key=mg-public-v1-" + expected, text)
            for row in ci.manifest()["used"]:
                self.assertEqual(str(ci.sample_target(ci.manifest(), row)) in text, row["id"] not in approved_ids(ci.manifest()))

    def test_download_never_requests_local_only_series_and_rechecks_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            payload = b"public synthetic sample"
            row = {"id": "public", "set": "test", "collection": "CMMD", "path": "CMMD/subject/series/sample.dcm",
                   "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
            restricted = dict(row, id="restricted", collection="EA1141", path="EA1141/EA1141-4339969/private/sample.dcm")
            spec = {"sets": {"test": {"root_env": "TEST_MG_CI_ROOT", "default_root": directory}}, "used": [row, restricted]}
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, "w") as zipped:
                zipped.writestr("server-name.dcm", payload)
            with mock.patch.dict(os.environ, {"KIN_MG_CI_SCOPE": "hosted", "TEST_MG_CI_ROOT": directory}):
                with mock.patch.object(ci, "manifest", return_value=spec):
                    with mock.patch.object(ci.urllib.request, "urlopen", return_value=io.BytesIO(archive.getvalue())) as request:
                        ci.fetch()
                        self.assertEqual(request.call_count, 1)
                        self.assertTrue(request.call_args.args[0].full_url.endswith("=series"))
                    with mock.patch.object(ci.urllib.request, "urlopen") as request:
                        ci.fetch()
                        request.assert_not_called()
                        ci.sample_target(spec, row).write_bytes(b"corrupt")
                        with self.assertRaisesRegex(RuntimeError, "cached sample hash mismatch"):
                            ci.fetch()
                        request.assert_not_called()
                    self.assertFalse(ci.sample_target(spec, restricted).exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
