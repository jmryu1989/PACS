"""RD-02: transport/ZIP failures cannot poison sample bytes or retry forever (D73).

Both consumers run this contract against their actual imported download callable.
"""
import http.client
import io
import socket
import unittest
from unittest import mock
import urllib.error
import zipfile
import zlib

import archive_download


def zipped_bytes(payload=b"synthetic sample"):
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zipped:
        zipped.writestr("sample.dcm", payload)
    return archive.getvalue()


class PartialResponse(io.BytesIO):
    def __init__(self, error):
        super().__init__(b"partial bytes that must be discarded")
        self.error = error

    def read(self, size=-1):
        chunk = super().read(size)
        if not chunk:
            raise self.error
        return chunk


class DownloadContract:
    def test_transient_failures_discard_partial_bytes_then_recover(self):
        for error in [urllib.error.URLError("disconnected"), socket.timeout("timed out"),
                      http.client.IncompleteRead(b"tail", 100), zipfile.BadZipFile("bad archive"),
                      zlib.error("bad deflate stream"), EOFError("truncated member")]:
            with self.subTest(error=type(error).__name__):
                expected = zipped_bytes()
                with mock.patch.object(archive_download.urllib.request, "urlopen",
                                       side_effect=[PartialResponse(error), PartialResponse(error), io.BytesIO(expected)]) as request:
                    with mock.patch.object(archive_download.time, "sleep") as sleep:
                        archive = io.BytesIO(b"previous attempt")
                        self.download("https://test", archive)
                        self.assertEqual(archive.read(), expected)
                        self.assertEqual(request.call_count, 3)
                        self.assertEqual(sleep.call_args_list, [mock.call(2), mock.call(4)])

    def test_exhaustion_discards_partial_response_and_raises(self):
        for error in [urllib.error.URLError("disconnected"), socket.timeout("timed out"),
                      http.client.IncompleteRead(b"tail", 100), zipfile.BadZipFile("bad archive"),
                      zlib.error("bad deflate stream"), EOFError("truncated member")]:
            with self.subTest(error=type(error).__name__):
                with mock.patch.object(archive_download.urllib.request, "urlopen",
                                       side_effect=[PartialResponse(error) for _ in range(3)]) as request:
                    with mock.patch.object(archive_download.time, "sleep") as sleep:
                        archive = io.BytesIO()
                        with self.assertRaises(type(error)):
                            self.download("https://test", archive)
                        self.assertEqual(archive.getvalue(), b"")
                        self.assertEqual(request.call_count, 3)
                        self.assertEqual(sleep.call_count, 2)

    def test_http_recovery_and_permanent_failure(self):
        for status in [408, 429, 500, 501, 502, 503, 504, 599]:
            with self.subTest(status=status):
                error = urllib.error.HTTPError("https://test", status, "failed", {}, None)
                expected = zipped_bytes()
                with mock.patch.object(archive_download.urllib.request, "urlopen", side_effect=[error, error, io.BytesIO(expected)]) as request:
                    with mock.patch.object(archive_download.time, "sleep"):
                        archive = io.BytesIO(b"partial")
                        self.download("https://test", archive)
                        self.assertEqual(archive.read(), expected)
                        self.assertEqual(request.call_count, 3)
        for status, attempts in [(400, 1), (403, 1), (404, 1), (503, 3)]:
            with self.subTest(status=status, attempts=attempts):
                error = urllib.error.HTTPError("https://test", status, "failed", {}, None)
                with mock.patch.object(archive_download.urllib.request, "urlopen", side_effect=error) as request:
                    with mock.patch.object(archive_download.time, "sleep") as sleep:
                        with self.assertRaises(urllib.error.HTTPError):
                            self.download("https://test", io.BytesIO())
                        self.assertEqual(request.call_count, attempts)
                        self.assertEqual(sleep.call_count, attempts - 1)

    def test_truncated_and_crc_corrupt_archives_are_retried(self):
        expected = zipped_bytes()
        for corrupt in [expected[:20], expected.replace(b"synthetic sample", b"corrupted sample")]:
            with self.subTest(corrupt=corrupt[:20]):
                with mock.patch.object(archive_download.urllib.request, "urlopen",
                                       side_effect=[io.BytesIO(corrupt), io.BytesIO(expected)]) as request:
                    with mock.patch.object(archive_download.time, "sleep"):
                        archive = io.BytesIO()
                        self.download("https://test", archive)
                        self.assertEqual(archive.read(), expected)
                        self.assertEqual(request.call_count, 2)

    def test_member_decompression_failures_retry_and_discard_archive(self):
        expected = zipped_bytes()
        for error in [zlib.error("bad deflate stream"), EOFError("truncated member")]:
            for recover in [True, False]:
                with self.subTest(error=type(error).__name__, recover=recover):
                    outcomes = [error, error, None if recover else error]
                    with mock.patch.object(archive_download.urllib.request, "urlopen",
                                           side_effect=[io.BytesIO(expected) for _ in range(3)]) as request:
                        with mock.patch.object(zipfile.ZipFile, "testzip", side_effect=outcomes):
                            with mock.patch.object(archive_download.time, "sleep") as sleep:
                                archive = io.BytesIO(b"previous attempt")
                                if recover:
                                    self.download("https://test", archive)
                                    self.assertEqual(archive.read(), expected)
                                else:
                                    with self.assertRaises(type(error)):
                                        self.download("https://test", archive)
                                    self.assertEqual(archive.getvalue(), b"")
                                self.assertEqual(request.call_count, 3)
                                self.assertEqual(sleep.call_args_list, [mock.call(2), mock.call(4)])


class ArchiveDownloadTest(DownloadContract, unittest.TestCase):
    download = staticmethod(archive_download.download)


if __name__ == "__main__":
    unittest.main(verbosity=2)
