"""Bounded recovery for public sample archives; never retain a failed response."""
import http.client
import shutil
import socket
import time
import urllib.error
import urllib.request
import zipfile


def download(url, archive):
    for attempt in range(3):
        archive.seek(0)
        archive.truncate()
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "PACS-part1-CI/1.0"})
            with urllib.request.urlopen(request, timeout=180) as response:
                shutil.copyfileobj(response, archive, 1024 * 1024)
            archive.seek(0)
            # A truncated response can finish without a transport exception. Check
            # structure and CRC before any pinned destination is written.
            with zipfile.ZipFile(archive) as zipped:
                if zipped.testzip() is not None:
                    raise zipfile.BadZipFile("archive member CRC mismatch")
            archive.seek(0)
            return
        except (urllib.error.URLError, socket.timeout, http.client.IncompleteRead, zipfile.BadZipFile) as error:
            archive.seek(0)
            archive.truncate()
            if (isinstance(error, urllib.error.HTTPError) and
                    error.code not in (408, 429) and not 500 <= error.code <= 599) or attempt == 2:
                raise
            print("transient archive failure", type(error).__name__, "retry", attempt + 1, flush=True)
            time.sleep(2 ** (attempt + 1))
