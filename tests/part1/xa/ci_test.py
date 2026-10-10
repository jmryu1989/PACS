"""RD-02: XA fetch uses bounded recovery and preserves pinned cache integrity (D73)."""
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import ci
import archive_download
from archive_download_test import DownloadContract, zipped_bytes


class XaCiTest(DownloadContract, unittest.TestCase):
    download = staticmethod(ci.download)

    def test_cache_plan_tracks_public_hashes_and_only_manifest_files(self):
        rows = [{"id": str(i), "relpath": f"series/{i}.dcm", "sha256": str(i) * 64} for i in (1, 2)]
        spec = {"root_env": "TEST_XA_CI_ROOT", "public": rows,
                "synthetic": [{"relpath": "private.dcm", "sha256": "f" * 64}]}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            def planned():
                output.write_text("", encoding="utf-8")
                with mock.patch.dict(os.environ, {"TEST_XA_CI_ROOT": directory, "GITHUB_OUTPUT": str(output)}):
                    with mock.patch.object(ci.json, "loads", return_value=spec):
                        ci.plan()
                lines = output.read_text(encoding="utf-8").splitlines()
                return lines[0], lines[2:-1]
            key, paths = planned()
            self.assertEqual(set(paths), {str(Path(directory) / r["relpath"]) for r in rows})
            self.assertEqual(len(paths), len(rows))
            rows.reverse()
            self.assertEqual(planned()[0], key, "row order does not change the cache identity")
            rows[0]["sha256"] = "3" * 64
            self.assertNotEqual(planned()[0], key, "a changed pinned file invalidates the cache")
            rows.pop()
            smaller_key, paths = planned()
            self.assertNotEqual(smaller_key, key)
            self.assertEqual(paths, [str(Path(directory) / rows[0]["relpath"])])

    def test_every_restored_file_is_verified_and_partial_cache_fetches_missing_bytes(self):
        payloads = [b"synthetic first", b"synthetic second"]
        rows = [{"id": str(i), "relpath": f"collection/series/{i}.dcm", "bytes": len(payload),
                 "sha256": hashlib.sha256(payload).hexdigest()} for i, payload in enumerate(payloads)]
        spec = {"root_env": "TEST_XA_CI_ROOT", "public": rows}
        with tempfile.TemporaryDirectory() as directory:
            targets = [Path(directory) / r["relpath"] for r in rows]
            targets[0].parent.mkdir(parents=True)
            targets[0].write_bytes(payloads[0])
            with mock.patch.dict(os.environ, {"TEST_XA_CI_ROOT": directory}):
                with mock.patch.object(ci.json, "loads", return_value=spec):
                    with mock.patch.object(archive_download.urllib.request, "urlopen",
                                           return_value=io.BytesIO(zipped_bytes(payloads[1]))) as request:
                        ci.fetch()
                        request.assert_called_once()
                    self.assertEqual([p.read_bytes() for p in targets], payloads)
                    with mock.patch.object(archive_download.urllib.request, "urlopen") as request:
                        ci.fetch()
                        for target, payload in zip(targets, payloads):
                            target.write_bytes(b"corrupt")
                            with self.assertRaisesRegex(RuntimeError, "cached sample hash mismatch"):
                                ci.fetch()
                            target.write_bytes(payload)
                        request.assert_not_called()
                    targets[1].unlink()
                    with mock.patch.object(archive_download.urllib.request, "urlopen",
                                           return_value=io.BytesIO(zipped_bytes(b"not the pinned sample"))):
                        with self.assertRaisesRegex(RuntimeError, "NOT RUN: public source lacks pinned samples"):
                            ci.fetch()
                    self.assertEqual(targets[0].read_bytes(), payloads[0])
                    self.assertFalse(targets[1].exists())

    def test_fetch_recovers_corrupt_archive_and_rechecks_pinned_cache(self):
        payload = b"synthetic sample"
        with tempfile.TemporaryDirectory() as directory:
            row = {"id": "public", "relpath": "collection/subject/series/sample.dcm",
                   "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
            spec = {"root_env": "TEST_XA_CI_ROOT", "public": [row]}
            target = Path(directory) / row["relpath"]
            with mock.patch.dict(os.environ, {"TEST_XA_CI_ROOT": directory}):
                with mock.patch.object(ci.json, "loads", return_value=spec):
                    with mock.patch.object(archive_download.urllib.request, "urlopen",
                                           side_effect=[io.BytesIO(b"truncated"), io.BytesIO(zipped_bytes(payload))]) as request:
                        with mock.patch.object(archive_download.time, "sleep"):
                            ci.fetch()
                        self.assertEqual(request.call_count, 2)
                        self.assertTrue(request.call_args.args[0].full_url.endswith("=series"))
                        self.assertEqual(target.read_bytes(), payload)
                    with mock.patch.object(archive_download.urllib.request, "urlopen") as request:
                        ci.fetch()
                        request.assert_not_called()
                        target.write_bytes(b"corrupt")
                        with self.assertRaisesRegex(RuntimeError, "cached sample hash mismatch"):
                            ci.fetch()
                        request.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
