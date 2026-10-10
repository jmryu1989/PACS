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
    protected = [r for r in spec["used"] if r["id"] in expected]
    public = [r for r in spec["used"] if r["id"] not in expected]
    test.assertFalse({Path(r["path"]).parent.name for r in protected} &
                     {Path(r["path"]).parent.name for r in public}, "D717 series UID reused outside approval")
    test.assertFalse({r["sha256"] for r in protected} & {r["sha256"] for r in public},
                     "D717 sha256 reused outside approval")
    test.assertEqual({r["id"] for r in spec["used"] if ci.local_only(r, spec)}, expected,
                     "local-only selection must match independent D717 approval")
    ci.validate_manifest(spec)


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
                with self.assertRaisesRegex(ValueError, "D717 approval/subject mismatch"):
                    assert_local_only_matches_approval(self, spec)

    def test_public_aliases_of_d717_identifiers_are_refused_before_any_io(self):
        for variant in ("duplicate-relabelled-public-row", "sha256-only", "series-uid-only"):
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as directory:
                spec = copy.deepcopy(ci.manifest())
                restricted = next(r for r in spec["used"] if r["id"] in approved_ids(spec))
                row = dict(restricted, id="public-lookalike", set="tcia-20261004")
                row["path"] = row["path"].replace("EA1141-4339969", "EA1141-0000000", 1)
                if variant == "sha256-only":
                    row["path"] = "CMMD/renamed-subject/other-series/sample.dcm"
                    row["collection"] = "CMMD"
                elif variant == "series-uid-only":
                    row["sha256"] = "0" * 64
                spec["used"].append(row)
                for root in spec["sets"].values():
                    root.update(root_env="TEST_MG_CI_ROOT", default_root=directory)
                with self.assertRaisesRegex(AssertionError, "D717 (series UID|sha256) reused"):
                    assert_local_only_matches_approval(self, spec)
                output = Path(directory) / "output"
                output.write_text("existing output\n", encoding="utf-8")
                with mock.patch.dict(os.environ, {"KIN_MG_CI_SCOPE": "hosted", "TEST_MG_CI_ROOT": directory,
                                                  "GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": ""}):
                    with mock.patch.object(ci, "manifest", return_value=spec):
                        self.assertTrue(ci.local_only(row))
                        with mock.patch.object(ci.urllib.request, "urlopen") as request:
                            for action in (ci.plan, ci.fetch):
                                with self.assertRaisesRegex(ValueError, "D717 series UID or sha256 reused"):
                                    action()
                            for name in ("dicom", "dom"):
                                with self.assertRaisesRegex(ValueError, "D717 series UID or sha256 reused"):
                                    ci.selection(name)
                            request.assert_not_called()
                self.assertEqual(output.read_text(encoding="utf-8"), "existing output\n")
                self.assertEqual(list(Path(directory).iterdir()), [output])

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
            restricted = dict(row, id="restricted", set="local", collection="EA1141",
                              path="EA1141/EA1141-4339969/private/sample.dcm", sha256="0" * 64)
            root = {"root_env": "TEST_MG_CI_ROOT", "default_root": directory}
            spec = {"sets": {"test": root, "local": dict(root, approval="D717 local test use only")},
                    "used": [row, restricted]}
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
