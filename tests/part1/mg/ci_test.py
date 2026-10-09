"""D837: sample approval scope, cache integrity and bounded HTTP recovery (no network).

D73: asserts selected dependencies, requested bytes and failures, not source spelling.
"""
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


class MgCiTest(unittest.TestCase):
    def test_hosted_exclusions_follow_manifest_dependencies(self):
        rows = {r["id"]: r for r in ci.manifest()["used"]}
        with mock.patch.dict(os.environ, {"KIN_MG_CI_SCOPE": "hosted"}):
            for name in ("dicom", "dom"):
                body, selected, excluded = ci.selection(name)
                for case in body["cases"]:
                    restricted = [s for s in case.get("samples", []) if ci.local_only(rows[s])]
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
            rows = [r for r in ci.manifest()["used"] if not ci.local_only(r)]
            expected = hashlib.sha256("\n".join(sorted(r["sha256"] for r in rows)).encode("ascii")).hexdigest()
            self.assertIn("cache-key=mg-public-v1-" + expected, text)
            for row in ci.manifest()["used"]:
                self.assertEqual(str(ci.sample_target(ci.manifest(), row)) in text, not ci.local_only(row))

    def test_transient_http_retries_discard_partial_bytes(self):
        error = urllib.error.HTTPError("https://test", 503, "unavailable", {}, None)
        with mock.patch.object(ci.urllib.request, "urlopen", side_effect=[error, error, io.BytesIO(b"archive")]) as request:
            with mock.patch.object(ci.time, "sleep") as sleep:
                archive = io.BytesIO(b"partial response")
                ci.download("https://test", archive)
                self.assertEqual(archive.read(), b"archive")
                self.assertEqual(request.call_count, 3)
                self.assertEqual(sleep.call_count, 2)

    def test_permanent_and_exhausted_http_errors_fail(self):
        for status, attempts in ((404, 1), (503, 3)):
            with self.subTest(status=status):
                error = urllib.error.HTTPError("https://test", status, "failed", {}, None)
                with mock.patch.object(ci.urllib.request, "urlopen", side_effect=error) as request:
                    with mock.patch.object(ci.time, "sleep"):
                        with self.assertRaises(urllib.error.HTTPError):
                            ci.download("https://test", io.BytesIO())
                        self.assertEqual(request.call_count, attempts)

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
