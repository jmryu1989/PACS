"""D964: REQ-S9-U0a-PRE-ORDER -> RISK-LOAD-REGRESSION -> TEST-PRE-LOAD-BUDGET.

Exercise readiness/failure records, without Docker or product source assertions.
"""
import hashlib
import io
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import main_load_hosted as hosted


class Readiness(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.record = Path(self.directory.name) / "readiness.json"
        self.now = 0
        self.calls = []

    def sleep(self, seconds):
        self.now += seconds

    def poll(self, endpoint, timeout_s=3):
        def probe(origin, name, path, timeout, digest):
            self.calls.append((self.now, name, path, timeout))
            return endpoint(name, timeout)
        return hosted.poll_readiness("https://fixture", "document-sha", self.record,
            timeout_s=timeout_s, probe=probe, clock=lambda: self.now, sleep=self.sleep)

    def test_ready_requires_all_three_proxy_routes_and_records_duration(self):
        result = self.poll(lambda name, timeout: {"ready": True})
        self.assertTrue(result["ready"])
        self.assertEqual(0, result["duration_seconds"])
        self.assertEqual({"/api/health", "/auth/realms/kin/.well-known/openid-configuration",
                          "/worklist/hpacs-lite/main.html"}, {call[2] for call in self.calls})
        self.assertEqual(result, json.loads(self.record.read_text(encoding="utf-8")))

    def test_slow_auth_retries_before_any_readiness_success(self):
        result = self.poll(lambda name, timeout: {"ready": name != "auth_realm" or self.now >= 2})
        self.assertEqual(2, result["duration_seconds"])
        self.assertEqual(5, len(result["attempts"]))
        self.assertFalse(result["attempts"][0]["checks"]["auth_realm"]["ready"])

    def test_previously_ready_endpoint_must_still_be_healthy(self):
        def endpoint(name, timeout):
            return {"ready": self.now >= 2 or (name == "api" if self.now < 1 else name != "api")}
        result = self.poll(endpoint)
        self.assertEqual(2, result["duration_seconds"])

    def test_failed_endpoints_fail_closed_and_preserve_attempts(self):
        with self.assertRaisesRegex(AssertionError, "stack readiness"):
            self.poll(lambda name, timeout: {"ready": False, "error": "HTTP 503"})
        result = json.loads(self.record.read_text(encoding="utf-8"))
        self.assertFalse(result["ready"])
        self.assertEqual(3, result["duration_seconds"])
        self.assertEqual("HTTP 503", result["attempts"][-1]["checks"]["api"]["error"])

    def test_slow_probe_receives_only_remaining_deadline(self):
        def endpoint(name, timeout):
            self.sleep(timeout)
            return {"ready": False, "error": "connection timeout"}
        with self.assertRaisesRegex(AssertionError, "stack readiness"):
            self.poll(endpoint)
        self.assertEqual([2, 1], [call[3] for call in self.calls])
        self.assertEqual(3, self.now)

    def test_endpoint_checks_payload_status_and_connection_failure(self):
        origin = "https://fixture"
        document = b"Orthanc served page"
        cases = [("api", b'{"ok":true}', 200, True),
                 ("api", b'{"ok":false}', 200, False),
                 ("api", b'not json', 200, False),
                 ("api", b'[]', 200, False),
                 ("auth_realm", b'{"issuer":"https://fixture/auth/realms/kin"}', 200, True),
                 ("auth_realm", b'{"issuer":"https://wrong"}', 200, False),
                 ("orthanc", document, 200, True),
                 ("orthanc", b"wrong revision", 200, False),
                 ("orthanc", document, 503, False)]
        for name, body, status, ready in cases:
            with self.subTest(name=name, body=body, status=status):
                response = io.BytesIO(body)
                response.status, response.headers = status, {}
                with patch.object(hosted, "urlopen", return_value=response) as opened:
                    result = hosted.probe_endpoint(origin, name, hosted.READINESS_CHECKS[name],
                        1.5, hashlib.sha256(document).hexdigest())
                self.assertEqual(ready, result["ready"])
                self.assertEqual(origin + hosted.READINESS_CHECKS[name], opened.call_args.args[0])
                self.assertEqual(1.5, opened.call_args.kwargs["timeout"])
        with patch.object(hosted, "urlopen", side_effect=OSError("connection refused")):
            self.assertFalse(hosted.probe_endpoint(origin, "api", "/api/health", 1, "")["ready"])


class FirstAuthDiagnostic(unittest.TestCase):
    def test_success_before_deadline_does_not_record_a_timeout(self):
        now = [0]
        page, diagnostic = Mock(), Mock()
        page.wait_for_timeout.side_effect = lambda ms: now.__setitem__(0, now[0] + 1)
        with patch.object(hosted.time, "perf_counter", side_effect=lambda: now[0]):
            hosted.wait(page, lambda: now[0] >= 2, "first auth", timeout_s=3, on_timeout=diagnostic)
        self.assertEqual(2, now[0])
        diagnostic.assert_not_called()

    def test_visit_keeps_both_auth_conditions_and_records_timeout_before_close(self):
        # Either half alone must time out. A prior ready stack does not excuse
        # a missing browser request or a request that never reaches the server.
        for browser_request in (False, True):
            with self.subTest(browser_request=browser_request), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                record = root / "visit-01.json"
                event = threading.Event()
                if not browser_request:
                    event.set()
                stack = SimpleNamespace(root=root / "stack", side="baseline", origin="https://fixture",
                    url="https://fixture/worklist/hpacs-lite/main.html", me_received=event,
                    reset=Mock(), versions={"baseline": {"main.html": "sha"}})
                handlers = {}
                page = Mock(url=stack.url)
                page.main_frame = SimpleNamespace(url=stack.url)
                page.on.side_effect = lambda name, callback: handlers.setdefault(name, []).append(callback)

                def navigate(*args, **kwargs):
                    for handler in handlers["framenavigated"]:
                        handler(page.main_frame)
                    if browser_request:
                        for handler in handlers["request"]:
                            handler(SimpleNamespace(url="https://fixture/api/me"))
                page.goto.side_effect = navigate
                pending = {"id": "1", "url": "https://fixture/api/me"}
                waterfall = Mock(rows={"1": pending, "2": {"id": "2", "end": 1},
                                       "3": {"id": "3", "failed": {"error": "aborted"}}})
                captured = []
                page.close.side_effect = lambda: captured.append(json.loads(record.read_text(encoding="utf-8")))
                now = [0]
                page.wait_for_timeout.side_effect = lambda ms: now.__setitem__(0, now[0] + hosted.FIRST_AUTH_TIMEOUT_S)
                with patch.object(hosted, "Waterfall", return_value=waterfall), \
                        patch.object(hosted.time, "perf_counter", side_effect=lambda: now[0]), \
                        patch.object(hosted, "probe_endpoint", return_value={"ready": False, "error": "HTTP 502"}):
                    with self.assertRaisesRegex(AssertionError, "hosted timeout: first auth"):
                        hosted.visit(stack, Mock(new_page=Mock(return_value=page)), None, "patient",
                                     {"mode": "cold", "visit": 1})
                self.assertEqual(1, len(captured))
                self.assertFalse(captured[0]["valid"])
                diagnostic = captured[0]["first_auth_timeout"]
                self.assertEqual([pending], diagnostic["pending_requests"])
                self.assertEqual(stack.url, diagnostic["navigation"][-1]["url"])
                self.assertEqual(browser_request, diagnostic["auth_observed"])
                self.assertEqual(not browser_request, diagnostic["server_me_received"])
                self.assertEqual(set(hosted.READINESS_CHECKS), set(diagnostic["stack_health"]))
                self.assertTrue(all(c["error"] == "HTTP 502" for c in diagnostic["stack_health"].values()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
