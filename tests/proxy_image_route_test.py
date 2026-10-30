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
frame route is the API's frame range reader (MG-LOADING, api/src/dicom-frame.controller.ts): the API runs the DICOMweb
gate itself and records the study delivery (api/src/image-delivery-record.ts) before the first byte, so a fresh install
shows its images (batch-2 B1) without an unrecorded frame path (D1877, 의료법 제23조④; R244-GPT-FIX5-01: the
authorization-subrequest-then-Orthanc detour is reached by no frame request in either rendering). Both renderings are
asserted.

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
# Without the catalog: the API's frame range reader, given the request line as written (MG-LOADING); the recorded relay
# for the other image representations (MG-08).
FRAME_READER = "/api"
RELAY = "/api/image-relay"
AUTHZ = "/api/authz/dicom"
ORTHANC_BASIC = "Basic " + base64.b64encode(b"syn-user:syn-pass").decode()


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
        self.send_response(int(self.headers.get("X-Probe-Status", "200")))
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", "5")
        if self.headers.get("X-Probe-CSP"):
            self.send_header("Content-Security-Policy", self.headers["X-Probe-CSP"])
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

    def test_only_the_pinned_decoder_worker_response_allows_javascript_eval(self):
        worker = "/ohif/1927.bundle.497fe7ce9f85fada0cc8.js"

        def request(method, target, headers=None):
            connection = http.client.HTTPConnection("127.0.0.1", self.proxy.p443, timeout=10)
            try:
                connection.request(method, target, headers={"Host": self.host, **(headers or {})})
                response = connection.getresponse()
                response.read()
                return response.status, response.headers
            finally:
                connection.close()

        def directives(policy):
            return {parts[0]: parts[1:] for d in policy.split(';') if (parts := d.split())}

        status, page_headers = request("GET", "/ohif/viewer?StudyInstanceUIDs=2.25.1")
        self.assertEqual(status, 200)
        self.assertEqual(len(page_headers.get_all("Content-Security-Policy", [])), 1)
        page_policy = directives(page_headers["Content-Security-Policy"])
        self.assertIn("'wasm-unsafe-eval'", page_policy["script-src"])
        self.assertNotIn("'unsafe-eval'", [s for sources in page_policy.values() for s in sources])
        expected_worker = {**page_policy, "script-src": page_policy["script-src"] + ["'unsafe-eval'"]}

        for method in ("GET", "HEAD"):
            for status in (200, 404, 503):
                for target in (worker, worker + "?v=pinned"):
                    with self.subTest(method=method, status=status, target=target):
                        # An upstream CSP must not add a second, intersecting policy that blocks the codec.
                        got, headers = request(method, target, {"X-Probe-Status": str(status),
                                               "X-Probe-CSP": "script-src 'self'"})
                        self.assertEqual(got, status, Recorder.seen[-1])
                        self.assertEqual(len(headers.get_all("Content-Security-Policy", [])), 1)
                        self.assertEqual(directives(headers["Content-Security-Policy"]), expected_worker)
                        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
                        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
                        self.assertEqual(headers.get_all("Strict-Transport-Security"),
                                         page_headers.get_all("Strict-Transport-Security"))
                        self.assertEqual(Recorder.seen[-1][1], target)
                        self.assertEqual(Recorder.seen[-1][2].get("authorization"), ORTHANC_BASIC)

        # Nearby names, imported codec chunks, other workers, app scripts and documents retain their own policy.
        for target in ("/ohif/", "/ohif/viewer", "/ohif/app-config.js", "/ohif/init-service-worker.js",
                       "/ohif/4571.bundle.3b1691730b3c57bf4d35.js", "/ohif/another-worker.js",
                       worker + ".map", worker + "/extra", worker.replace("497fe", "597fe"),
                       "/worklist/hpacs-lite/main.html", "/api/health", "/auth/"):
            with self.subTest(target=target):
                status, headers = request("GET", target)
                self.assertEqual(status, 200)
                for policy in headers.get_all("Content-Security-Policy", []):
                    self.assertNotIn("'unsafe-eval'", [s for sources in directives(policy).values() for s in sources])
                if target.startswith("/ohif/"):
                    self.assertEqual(headers.get_all("Content-Security-Policy"),
                                     page_headers.get_all("Content-Security-Policy"))

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
        # Descriptions without the image (DICOMweb metadata, the QIDO study query): authorization subrequest, then Orthanc.
        for target in (f"{INSTANCE}/metadata", f"/dicom-web/studies/{STUDY}/series/{SERIES}/metadata",
                       f"/dicom-web/studies?StudyInstanceUID={STUDY}"):
            with self.subTest(target=target):
                status, _, seen = self.send("GET", target)
                self.assertEqual(200, status)
                self.assertEqual([("GET", AUTHZ), ("GET", target)], [(m, p) for m, p, _ in seen])
                self.assertEqual(target, seen[0][2].get("x-original-uri"))
                self.assertEqual(ORTHANC_BASIC, seen[1][2].get("authorization"))
        # A rendered frame is an image representation: the API's recorded relay (MG-08), no authorization subrequest and
        # no Orthanc credential from the proxy.
        rendered = f"{INSTANCE}/frames/1/rendered"
        status, _, seen = self.send("GET", rendered)
        self.assertEqual(200, status)
        self.assertEqual([("GET", RELAY + rendered)], [(m, p) for m, p, _ in seen])
        self.assertIsNone(seen[0][2].get("authorization"))
        # The Gateway's study-UID STOW still goes to Orthanc after the authorization subrequest.
        status, _, seen = self.send("POST", f"/dicom-web/studies/{STUDY}", body=b"dicom")
        self.assertEqual(200, status)
        self.assertEqual([("GET", AUTHZ), ("POST", f"/dicom-web/studies/{STUDY}")], [(m, p) for m, p, _ in seen])
        self.assertEqual("POST", seen[0][2].get("x-original-method"))
        self.assertEqual(ORTHANC_BASIC, seen[1][2].get("authorization"))


class ProductionImageRouteTests(ImageRouteTests):
    """The same contract on the production rendering (default servers, ACME, HSTS, admin guards)."""
    mode = "production"

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.host = "pacs.koreaimagingnetwork.com"


class WithoutAssetCatalogImageRouteTests(ImageRouteTests):
    """A deployment without the viewer/decoder asset catalog (the stock docker-compose): E cannot build a manifest
    there, so a frame request reaches only the API's frame range reader, which runs the DICOMweb gate itself and records
    the study delivery before the first byte (no authorization subrequest, no Orthanc credential from the proxy, no byte
    from Orthanc without the API in between); the E image route is reached by nothing. Writes and the derived
    representations are as with E."""
    deployment = {}

    def assertFrameReaderRoute(self, method, target, headers=None):
        status, data, seen = self.send(method, target, headers)
        self.assertEqual(200, status, target)
        self.assertEqual([(method, FRAME_READER + target)], [(m, p) for m, p, _ in seen],
                         "without the catalog a frame request reaches only the API's recorded frame reader, as written")
        self.assertIsNone(seen[0][2].get("authorization"), "the proxy adds no Orthanc credential on the API route")
        self.assertEqual(b"" if method == "HEAD" else b"FRAME", data)
        return seen[0][2]

    def test_frame_requests_reach_the_e_boundary_with_the_exact_target(self):
        for frames in ("1", "2", "1,2,3", "10"):
            with self.subTest(frames=frames):
                self.assertFrameReaderRoute("GET", f"{INSTANCE}/frames/{frames}")
        self.assertFrameReaderRoute("HEAD", f"{INSTANCE}/frames/1")

    def test_request_and_session_headers_reach_the_boundary_and_the_peer_is_the_proxy_view(self):
        sent = {"Cookie": "kin_sid=synthetic-session", "X-KIN-Session": "authref:synthetic",
                "Accept": 'multipart/related; type="application/octet-stream"; transfer-syntax=*',
                "X-Real-IP": "203.0.113.9", "X-Forwarded-For": "203.0.113.9"}
        got = self.assertFrameReaderRoute("GET", f"{INSTANCE}/frames/1", sent)
        self.assertEqual("kin_sid=synthetic-session", got.get("cookie"))
        self.assertEqual("authref:synthetic", got.get("x-kin-session"))
        self.assertEqual(sent["Accept"], got.get("accept"))
        self.assertEqual("127.0.0.1", got.get("x-real-ip"))
        self.assertEqual("127.0.0.1", got.get("x-forwarded-for"))
        self.assertEqual(self.host, got.get("host"))
        self.assertEqual("https", got.get("x-forwarded-proto"))

    def test_spellings_nginx_normalizes_reach_the_boundary_canonical(self):
        # The frame reader is handed the request line as written; the API's own route parsing names the frames. A query
        # travels with it (the reader has no query of its own); the normalized spellings are matched by nginx and arrive
        # as sent.
        for target in (f"{INSTANCE}/frames/1%2C2", f"{INSTANCE}/frames/1?accept=x",
                       f"/dicom-web/studies/{STUDY}/series/{SERIES}//instances/{SOP}/frames/1"):
            with self.subTest(target=target):
                self.assertFrameReaderRoute("GET", target)

    def test_no_frame_request_reaches_e_or_the_authorization_detour(self):
        # Neither E (no manifest without the catalog) nor the authorization-subrequest-then-Orthanc route (whose 204 is
        # no delivery record) answers a frame request; the one request the upstream sees is the API's own.
        for target in (f"{INSTANCE}/frames/1", f"{INSTANCE}/frames/1,2", f"{INSTANCE}/frames/1%2C2"):
            for method in ("GET", "HEAD"):
                with self.subTest(target=target, method=method):
                    status, _, seen = self.send(method, target)
                    self.assertEqual(200, status)
                    self.assertEqual(1, len(seen))
                    self.assertFalse([p for _, p, _ in seen if p.startswith("/api/images/") or p.startswith(AUTHZ)], target)
                    self.assertTrue(seen[0][1].startswith(FRAME_READER + "/dicom-web/"), seen[0][1])
        # The descriptions keep the detour; a rendered frame keeps the relay.
        for target in (f"{INSTANCE}/metadata", f"/dicom-web/studies/{STUDY}/series/{SERIES}/metadata"):
            with self.subTest(target=target):
                _, _, seen = self.send("GET", target)
                self.assertEqual([AUTHZ, target], [p for _, p, _ in seen])


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
