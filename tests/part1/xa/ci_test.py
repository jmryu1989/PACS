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
