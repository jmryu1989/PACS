# coding: utf-8
"""CD-01 C05: the proxy stamps the deployment's build commit on the business pages it serves, and nothing else.

REQ-CD01-PRODUCT-INFO -> RISK-CD01-MIXED-BUILD -> TEST-CD01-PROXY-STAMP.
The business pages are a checkout's files that Orthanc serves as they are, so they carry no build identity of their
own. The production overlay gives the proxy the same KIN_REVISION the API image is built with (VCS_REF), and the
proxy writes it into every HTML page under /worklist/ as <meta name="kin-build-revision">; the Product Information
panel compares it with GET /api/version's revision (product_info_dom_test 02), so a page from build A beside an API
from build B reads Mismatch.

Real nginx over the repository's proxy configuration, rendered as proxy_grant_log_test.py renders it (the real
15-kin-config.envsh snippets, the image's envsubst values, loopback ports, TLS lines removed). One local upstream plays
Orthanc: it answers an HTML page, a script and a stylesheet, gzip-encoded when the request accepts gzip (as an
upstream that compresses would), and records the request headers it was given. Each case: the value the deployment
gives -> the page, script and headers the browser receives -> the stamp asserted.

nginx and sh come from PATH or from KIN_PROXY_NGINX / KIN_PROXY_SH (a host without them fails here; it is never a skip).
"""
import gzip
import http.client
import http.server
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from proxy_grant_log_test import PRODUCTION_HOST, Proxy  # noqa: E402

SHA = "0123456789abcdef0123456789abcdef01234567"
PAGE = b'<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>SYN</title></head><body>SYN</body></html>'
SCRIPT = b"window.SYN = '</head>';"
STYLE = b"/* </head> */ body { color: #fff; }"
TYPES = {".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css"}
BODIES = {".html": PAGE, ".js": SCRIPT, ".css": STYLE}


def stamp(revision):
    return f'<meta name="kin-build-revision" content="{revision}"></head>'.encode()


class Orthanc(http.server.BaseHTTPRequestHandler):
    """The served folder: one page, one script and one stylesheet; gzip when the request accepts it."""
    protocol_version = "HTTP/1.1"
    seen = []

    def do_GET(self):
        Orthanc.seen.append((self.path, {k.lower(): v for k, v in self.headers.items()}))
        suffix = Path(self.path).suffix
        body = BODIES.get(suffix, b"")
        self.send_response(200 if body else 404)
        self.send_header("Content-Type", TYPES.get(suffix, "text/plain"))
        self.send_header("Last-Modified", "Mon, 02 Nov 2026 00:00:00 GMT")
        if "gzip" in self.headers.get("Accept-Encoding", ""):
            body = gzip.compress(body)
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class StaticBuildStampTests(unittest.TestCase):
    """Production, given a full commit: every page carries it once; scripts and styles are as Orthanc sent them."""
    mode = "production"
    deployment = {"KIN_BUILD_REVISION": SHA}
    expected = SHA

    @classmethod
    def setUpClass(cls):
        Orthanc.seen = []
        cls.upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Orthanc)
        threading.Thread(target=cls.upstream.serve_forever, daemon=True).start()
        cls.proxy = Proxy(cls.mode, cls.upstream.server_port, deployment=cls.deployment)
        cls.host = PRODUCTION_HOST if cls.mode == "production" else "localhost"

    @classmethod
    def tearDownClass(cls):
        cls.proxy.stop()
        cls.upstream.shutdown()
        cls.upstream.server_close()

    def fetch(self, path):
        """GET as a browser asks (gzip accepted); returns (status, headers, decoded body, headers Orthanc was given)."""
        before = len(Orthanc.seen)
        connection = http.client.HTTPConnection("127.0.0.1", self.proxy.p443, timeout=5)
        try:
            connection.request("GET", path, headers={"Host": self.host, "Accept-Encoding": "gzip, deflate"})
            answer = connection.getresponse()
            body = answer.read()
            headers = {k.lower(): v for k, v in answer.getheaders()}
        finally:
            connection.close()
        if headers.get("content-encoding") == "gzip":
            body = gzip.decompress(body)
        reached = Orthanc.seen[before:]
        self.assertEqual(1, len(reached), f"{path} reached the served folder once")
        return answer.status, headers, body, reached[0][1]

    def test_pages_carry_the_deployment_commit_once(self):
        for path in ("/worklist/hpacs-lite/main.html", "/worklist/hpacs-lite/admin.html",
                     "/worklist/hpacs-lite/clinician.html", "/worklist/legal/privacy.html"):
            with self.subTest(path=path):
                status, headers, body, given = self.fetch(path)
                self.assertEqual(200, status)
                if self.expected:
                    self.assertEqual(PAGE.replace(b"</head>", stamp(self.expected)), body)
                    # A compressed answer could not be rewritten: the folder is asked for the plain bytes.
                    self.assertNotIn("gzip", given.get("accept-encoding", ""))
                    # The rewritten page is not revalidated against the file's date as if it were the file.
                    self.assertNotIn("last-modified", headers)
                else:
                    self.assertEqual(PAGE, body)
                    self.assertNotIn(b"kin-build-revision", body)

    def test_scripts_and_styles_are_not_rewritten(self):
        for path, original in (("/worklist/hpacs-lite/product-info.js", SCRIPT), ("/worklist/hpacs-lite/main.css", STYLE)):
            with self.subTest(path=path):
                status, _, body, _ = self.fetch(path)
                self.assertEqual((200, original), (status, body))


class UnknownRevisionTests(StaticBuildStampTests):
    """The overlay's default when KIN_REVISION is unset: no commit is stamped, never the word as a build."""
    deployment = {"KIN_BUILD_REVISION": "unknown"}
    expected = None


class MalformedRevisionTests(StaticBuildStampTests):
    """A short SHA or a value that would close the attribute: nothing is stamped."""
    deployment = {"KIN_BUILD_REVISION": SHA[:12] + '"><script>alert(1)</script>'}
    expected = None


class UppercaseRevisionTests(StaticBuildStampTests):
    """A commit that is not the 40 lowercase hex the API reports (GET /api/version) is not stamped either."""
    deployment = {"KIN_BUILD_REVISION": SHA.upper()}
    expected = None


class DevelopmentWithoutRevisionTests(StaticBuildStampTests):
    """The stock development stack gives the proxy no commit: pages are served as they are."""
    mode = "development"
    deployment = {}
    expected = None


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
