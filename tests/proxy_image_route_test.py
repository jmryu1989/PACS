# coding: utf-8
"""EMR-E E_ROUTE (E-01/E-02/E-03): the viewer's WADO-RS frame requests reach the API's E image boundary, not Orthanc.

Real nginx over the repository's own proxy configuration, rendered exactly as proxy_grant_log_test.py renders it (the
image's envsubst step, the real 15-kin-config.envsh snippets, loopback ports, TLS lines removed, every upstream host
pointed at one local recorder). The recorder answers like the services would: 204 for the DICOM authorization
subrequest, 200 with a small body for anything else, and keeps what each request looked like when it arrived.

What is asserted is the routing contract, not nginx text: which service a request reaches, with which target, method and
forwarded headers; that the frame route never takes the authorization-subrequest-then-Orthanc detour (whose 204 is not a
delivery record); that writes are refused before any upstream; and that metadata, rendered frames and the Gateway's
STOW keep their existing routes.

The E route exists only in a deployment that gives the proxy the viewer/decoder asset catalog value E's manifest
needs (KIN_EMR_IMAGE_ASSET_CATALOG, the same value the API reads). The stock docker-compose gives none, and there the
frame route is the one before E_ROUTE (authorization subrequest, then Orthanc): a fresh install shows its images instead
of E's 503 for every frame (batch-2 B1). Both renderings are asserted.

nginx and sh come from PATH or from KIN_PROXY_NGINX / KIN_PROXY_SH (a host without them fails here; it is never a skip).
"""
import base64
import http.client
import http.server
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from proxy_grant_log_test import Proxy  # noqa: E402

STUDY, SERIES, SOP = "1.2.826.0.1.3680043.8.498.1", "1.2.826.0.1.3680043.8.498.2", "1.2.826.0.1.3680043.8.498.3"
INSTANCE = f"/dicom-web/studies/{STUDY}/series/{SERIES}/instances/{SOP}"
E_ROUTE = "/api/images/dicom-web?target="
AUTHZ = "/api/authz/dicom"


class Recorder(http.server.BaseHTTPRequestHandler):
    """Every proxied service on one port; keeps (method, path, headers) of each request it was given."""
    protocol_version = "HTTP/1.1"
    seen = []

    def answer(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        Recorder.seen.append((self.command, self.path, {k.lower(): v for k, v in self.headers.items()}))
        if self.path.startswith(AUTHZ):
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = b"" if self.command == "HEAD" else b"FRAME"
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", "5")
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = do_PATCH = answer

    def log_message(self, *args):
        pass


class ImageRouteTests(unittest.TestCase):
    """The deployment gives the proxy the same viewer/decoder asset catalog value as the API: the E route is on."""
    mode = "development"
    deployment = {"KIN_EMR_IMAGE_ASSET_CATALOG": "/run/kin-image-assets/catalog.json"}

    @classmethod
    def setUpClass(cls):
        cls.upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
        threading.Thread(target=cls.upstream.serve_forever, daemon=True).start()
        cls.proxy = Proxy(cls.mode, cls.upstream.server_port, deployment=cls.deployment)
        cls.host = "localhost"

    @classmethod
    def tearDownClass(cls):
        cls.proxy.stop()
        cls.upstream.shutdown()
        cls.upstream.server_close()

    def send(self, method, target, headers=None, body=None):
        """One request as written (nothing re-encodes the target); (status, body, what the upstream saw)."""
        Recorder.seen = []
        connection = http.client.HTTPConnection("127.0.0.1", self.proxy.p443, timeout=10)
        try:
            connection.putrequest(method, target, skip_host=True, skip_accept_encoding=True)
            connection.putheader("Host", self.host)
            for name, value in (headers or {}).items():
                connection.putheader(name, value)
            if body is not None:
                connection.putheader("Content-Length", str(len(body)))
            connection.endheaders(body)
            answer = connection.getresponse()
            data = answer.read()
            return answer.status, data, list(Recorder.seen)
        finally:
            connection.close()

    def assertERoute(self, method, target, expected_target, headers=None):
        status, data, seen = self.send(method, target, headers)
        self.assertEqual(200, status, target)
        self.assertEqual([(method, E_ROUTE + expected_target)], [(m, p) for m, p, _ in seen],
                         "a frame request reaches only the E image route, with the normalized path as its target")
        self.assertEqual(b"" if method == "HEAD" else b"FRAME", data)
        return seen[0][2]

    def test_frame_requests_reach_the_e_boundary_with_the_exact_target(self):
        for frames in ("1", "2", "1,2,3", "10"):
            with self.subTest(frames=frames):
                self.assertERoute("GET", f"{INSTANCE}/frames/{frames}", f"{INSTANCE}/frames/{frames}")
        self.assertERoute("HEAD", f"{INSTANCE}/frames/1", f"{INSTANCE}/frames/1")

    def test_request_and_session_headers_reach_the_boundary_and_the_peer_is_the_proxy_view(self):
        sent = {"Cookie": "kin_sid=synthetic-session", "X-KIN-Session": "authref:synthetic",
                "Accept": 'multipart/related; type="application/octet-stream"; transfer-syntax=*',
                "Range": "bytes=0-3", "X-Real-IP": "203.0.113.9", "X-Forwarded-For": "203.0.113.9"}
        got = self.assertERoute("GET", f"{INSTANCE}/frames/1", f"{INSTANCE}/frames/1", sent)
        for name in ("cookie", "x-kin-session", "accept", "range"):
            self.assertEqual(sent[{"cookie": "Cookie", "x-kin-session": "X-KIN-Session", "accept": "Accept",
                                   "range": "Range"}[name]], got.get(name), name)
        # The API reads the client address only from X-Real-IP; the client's own value never reaches it.
        self.assertEqual("127.0.0.1", got.get("x-real-ip"))
        self.assertEqual("127.0.0.1", got.get("x-forwarded-for"))
        self.assertEqual(self.host, got.get("host"))
        self.assertEqual("https", got.get("x-forwarded-proto"))

    def test_spellings_nginx_normalizes_reach_the_boundary_canonical(self):
        cases = {
            f"{INSTANCE}/frames/1%2C2": f"{INSTANCE}/frames/1,2",
            f"{INSTANCE}/frames/1?accept=x&target=/instances/x/file": f"{INSTANCE}/frames/1",
            f"/dicom-web/studies/{STUDY}/series/{SERIES}/instances/9.9/../{SOP}/frames/1": f"{INSTANCE}/frames/1",
            f"/dicom-web/studies/{STUDY}/series/{SERIES}//instances/{SOP}/frames/1": f"{INSTANCE}/frames/1",
            f"/dicom-web/studies/{STUDY}%2Fseries/{SERIES}/instances/{SOP}/frames/1": f"{INSTANCE}/frames/1",
        }
        for target, expected in cases.items():
            with self.subTest(target=target):
                self.assertERoute("GET", target, expected)

    def test_frame_writes_are_refused_before_any_upstream(self):
        for method in ("POST", "PUT", "DELETE", "PATCH"):
            with self.subTest(method=method):
                status, _, seen = self.send(method, f"{INSTANCE}/frames/1", body=b"x")
                self.assertEqual(403, status)
                self.assertEqual([], seen)

    def test_derived_representations_and_stow_keep_their_routes(self):
        # Metadata and rendered frames are derived representations (E_DISPLAY): authorization subrequest, then Orthanc.
        for target in (f"{INSTANCE}/metadata", f"{INSTANCE}/frames/1/rendered", f"/dicom-web/studies/{STUDY}/series/{SERIES}/metadata",
                       f"/dicom-web/studies?StudyInstanceUID={STUDY}"):
            with self.subTest(target=target):
                status, _, seen = self.send("GET", target)
                self.assertEqual(200, status)
                self.assertEqual([("GET", AUTHZ), ("GET", target)], [(m, p) for m, p, _ in seen])
                self.assertEqual(target, seen[0][2].get("x-original-uri"))
        # The Gateway's study-UID STOW still goes to Orthanc after the authorization subrequest.
        status, _, seen = self.send("POST", f"/dicom-web/studies/{STUDY}", body=b"dicom")
        self.assertEqual(200, status)
        self.assertEqual([("GET", AUTHZ), ("POST", f"/dicom-web/studies/{STUDY}")], [(m, p) for m, p, _ in seen])
        self.assertEqual("POST", seen[0][2].get("x-original-method"))


class ProductionImageRouteTests(ImageRouteTests):
    """The same contract on the production rendering (default servers, ACME, HSTS, admin guards)."""
    mode = "production"

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.host = "pacs.koreaimagingnetwork.com"


class WithoutAssetCatalogImageRouteTests(ImageRouteTests):
    """A deployment without the viewer/decoder asset catalog (the stock docker-compose): E cannot build a manifest
    there, so the frame route is the one before E_ROUTE (authorization subrequest, then Orthanc) and the viewer shows
    its images; the E image route is reached by nothing. Writes and the derived representations are as with E."""
    deployment = {}

    def assertDirectRoute(self, method, target):
        status, data, seen = self.send(method, target)
        self.assertEqual(200, status, target)
        self.assertEqual([("GET", AUTHZ), (method, target)], [(m, p) for m, p, _ in seen],
                         "without the catalog a frame request takes the existing authorization-then-Orthanc route")
        self.assertEqual(target, seen[0][2].get("x-original-uri"))
        self.assertEqual(method, seen[0][2].get("x-original-method"))
        self.assertEqual(b"" if method == "HEAD" else b"FRAME", data)
        self.assertEqual(seen[1][2].get("authorization"), "Basic " + base64.b64encode(b"syn-user:syn-pass").decode())

    def test_frame_requests_reach_the_e_boundary_with_the_exact_target(self):
        for frames in ("1", "2", "1,2,3", "10"):
            with self.subTest(frames=frames):
                self.assertDirectRoute("GET", f"{INSTANCE}/frames/{frames}")
        self.assertDirectRoute("HEAD", f"{INSTANCE}/frames/1")

    def test_request_and_session_headers_reach_the_boundary_and_the_peer_is_the_proxy_view(self):
        status, _, seen = self.send("GET", f"{INSTANCE}/frames/1", {"Cookie": "kin_sid=synthetic-session",
                                                                    "X-KIN-Session": "authref:synthetic"})
        self.assertEqual(200, status)
        self.assertEqual([AUTHZ, f"{INSTANCE}/frames/1"], [p for _, p, _ in seen])
        self.assertEqual("kin_sid=synthetic-session", seen[0][2].get("cookie"))
        self.assertEqual("authref:synthetic", seen[0][2].get("x-kin-session"))

    def test_spellings_nginx_normalizes_reach_the_boundary_canonical(self):
        # The existing route hands Orthanc the request as written (a proxy_pass without a URI part); only E's target
        # is the normalized path.
        status, _, seen = self.send("GET", f"{INSTANCE}/frames/1%2C2")
        self.assertEqual(200, status)
        self.assertEqual([AUTHZ, f"{INSTANCE}/frames/1%2C2"], [p for _, p, _ in seen])

    def test_e_image_route_is_reached_by_nothing(self):
        for target in (f"{INSTANCE}/frames/1", f"{INSTANCE}/metadata", f"/dicom-web/studies/{STUDY}/series/{SERIES}/metadata"):
            with self.subTest(target=target):
                _, _, seen = self.send("GET", target)
                self.assertFalse([p for _, p, _ in seen if p.startswith("/api/images/")], target)


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite()
    for case in (ImageRouteTests, ProductionImageRouteTests, WithoutAssetCatalogImageRouteTests):
        suite.addTests(loader.loadTestsFromTestCase(case))
    return suite


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    result = unittest.TextTestRunner(verbosity=2).run(load_tests(unittest.defaultTestLoader, None, None))
    return 0 if result.wasSuccessful() and not result.skipped and result.testsRun else 1


if __name__ == "__main__":
    raise SystemExit(main())
