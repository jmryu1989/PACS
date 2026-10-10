"""D964/D970: REQ-S9-U0a-PRE-ORDER -> RISK-LOAD-REGRESSION -> TEST-PRE-LOAD-BUDGET.

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
                    me_release=threading.Event(), visit_violations=[],
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
                self.assertTrue(captured[0]["wait_failed"])
                self.assertTrue(stack.me_release.is_set())


def sample(metadata, side="baseline", network=False):
    return {**metadata, "side": side, "valid": not network,
            "console_errors": ["Failed to load resource: net::ERR_NETWORK_CHANGED"] if network else [],
            "waterfall": [{"url": "https://fixture/api/critical-results", "status": None}] if network else [],
            "navigation_to_auth_ms": 100, "auth_to_usable_ms": 200}


class Warmups(unittest.TestCase):
    def run_attempts(self, visit_fn):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        stack = SimpleNamespace(root=Path(directory.name) / "stack", side=None)
        stack.activate = lambda side: setattr(stack, "side", side)
        self.result, self.browser = {}, Mock()
        hosted.run_warmups(stack, self.browser, None, "patient", self.result, visit_fn)

    def test_first_wait_failure_is_kept_then_revision_is_retried(self):
        def visit(stack, context, clock, patient, metadata):
            result = sample(metadata, stack.side)
            if metadata["visit"] == -1:
                result.update(valid=False, wait_failed=True)
                raise hosted.VisitFailure(hosted.WaitTimeout("first auth"), result)
            return result
        self.run_attempts(visit)
        self.assertEqual(["baseline", "baseline", "candidate"], [r["side"] for r in self.result["warmups"]])
        self.assertEqual([-1, -2, -3], [r["visit"] for r in self.result["warmups"]])
        self.assertEqual(3, self.browser.new_context.return_value.close.call_count)

    def test_network_change_or_incomplete_request_retries_even_returned_visit(self):
        for cause in ("network", "pending"):
            with self.subTest(cause=cause):
                def visit(stack, context, clock, patient, metadata):
                    result = sample(metadata, stack.side, network=metadata["visit"] == -1 and cause == "network")
                    if cause == "pending" and metadata["visit"] == -1:
                        result["waterfall"] = [{"url": "https://fixture/api/studies", "status": 200}]
                    return result
                self.run_attempts(visit)
                self.assertEqual(3, len(self.result["warmups"]))

    def test_retry_is_bounded_and_preserves_all_attempts(self):
        for cause in ("wait", "network"):
            with self.subTest(cause=cause):
                def visit(stack, context, clock, patient, metadata):
                    result = sample(metadata, stack.side, network=cause == "network")
                    if cause == "wait":
                        result.update(valid=False, wait_failed=True)
                        raise hosted.VisitFailure(hosted.WaitTimeout("usable list"), result)
                    return result
                with self.assertRaisesRegex(AssertionError, "warmup exhausted"):
                    self.run_attempts(visit)
                self.assertEqual(hosted.WARMUP_ATTEMPTS, len(self.result["warmups"]))

    def test_non_transport_failure_is_not_retried(self):
        def visit(stack, context, clock, patient, metadata):
            result = sample(metadata, stack.side)
            result.update(valid=False)
            raise hosted.VisitFailure(AssertionError("body hash differs"), result)
        with self.assertRaisesRegex(hosted.VisitFailure, "body hash differs"):
            self.run_attempts(visit)
        self.assertEqual(1, len(self.result["warmups"]))

    def test_non_network_assertion_with_pending_request_is_not_retried(self):
        def visit(stack, context, clock, patient, metadata):
            result = sample(metadata, stack.side)
            result.update(valid=False, waterfall=[{"url": "https://fixture/pending"}])
            raise hosted.VisitFailure(AssertionError("body hash differs"), result)
        with self.assertRaisesRegex(hosted.VisitFailure, "body hash differs"):
            self.run_attempts(visit)
        self.assertEqual(1, len(self.result["warmups"]))

    def test_normally_cancelled_request_is_not_pending(self):
        def visit(stack, context, clock, patient, metadata):
            result = sample(metadata, stack.side)
            result["waterfall"] = [{"failed": {"errorText": "net::ERR_ABORTED"}}]
            return result
        self.run_attempts(visit)
        self.assertEqual(2, len(self.result["warmups"]))


class NetworkSettle(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "settle.json"
        self.now = 0
        self.handlers = {}
        self.page = Mock()
        self.page.on.side_effect = lambda event, handler: self.handlers.setdefault(event, handler)
        self.page.wait_for_timeout.side_effect = lambda ms: setattr(self, "now", self.now + ms / 1000)
        self.browser = Mock()
        self.browser.new_context.return_value.new_page.return_value = self.page

    def settle(self):
        return hosted.settle_network(self.browser, "https://fixture", self.path, clock=lambda: self.now)

    def test_stable_browser_records_window_and_closes_disposable_context(self):
        self.page.goto.return_value = SimpleNamespace(status=200)
        result = self.settle()
        self.assertTrue(result["ready"])
        self.assertEqual(hosted.NETWORK_SETTLE_WINDOW_S, result["duration_seconds"])
        self.assertEqual(result, json.loads(self.path.read_text(encoding="utf-8")))
        self.browser.new_context.return_value.close.assert_called_once()
        self.assertTrue(all(c.args[0] == "https://fixture/api/health" for c in self.page.goto.call_args_list))

    def test_event_resets_stable_window(self):
        def navigate(*args, **kwargs):
            if self.now == 1:
                self.handlers["console"](SimpleNamespace(text=hosted.NETWORK_CHANGED))
            return SimpleNamespace(status=200)
        self.page.goto.side_effect = navigate
        result = self.settle()
        self.assertEqual(hosted.NETWORK_SETTLE_WINDOW_S + 1, result["duration_seconds"])
        self.assertEqual(1, len(result["events"]))

    def test_never_stable_fails_bounded_and_records_all_failures(self):
        def navigate(*args, **kwargs):
            self.handlers["requestfailed"](SimpleNamespace(failure="net::ERR_ABORTED"))
            return SimpleNamespace(status=200)
        self.page.goto.side_effect = navigate
        with self.assertRaisesRegex(AssertionError, "network settle"):
            self.settle()
        result = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertFalse(result["ready"])
        self.assertEqual(hosted.NETWORK_SETTLE_TIMEOUT_S, result["duration_seconds"])
        self.assertTrue(result["events"])
        self.browser.new_context.return_value.close.assert_called_once()

    def test_hung_navigation_uses_remaining_deadline(self):
        def navigate(*args, **kwargs):
            self.now += kwargs["timeout"] / 1000
            raise hosted.BrowserTimeoutError("navigation timed out")
        self.page.goto.side_effect = navigate
        with self.assertRaisesRegex(AssertionError, "network settle"):
            self.settle()
        self.assertEqual(hosted.NETWORK_SETTLE_TIMEOUT_S, self.now)
        self.assertFalse(json.loads(self.path.read_text(encoding="utf-8"))["ready"])

    def test_page_creation_failure_still_records_and_closes_context(self):
        self.browser.new_context.return_value.new_page.side_effect = RuntimeError("page unavailable")
        with self.assertRaisesRegex(RuntimeError, "page unavailable"):
            self.settle()
        self.assertFalse(json.loads(self.path.read_text(encoding="utf-8"))["ready"])
        self.browser.new_context.return_value.close.assert_called_once()


class StartupCollection(unittest.TestCase):
    def test_delayed_response_after_two_poll_intervals_keeps_frozen_metrics(self):
        self.assertGreaterEqual(hosted.STARTUP_COLLECTION_TIMEOUT_S, 60)
        now = [0]
        page = Mock()
        rows = {"1": {"url": "https://fixture/api/critical-results?view=received&state=pending", "status": 200}}
        def advance(ms):
            now[0] += 10
            if now[0] == 60:
                rows["1"]["end"] = now[0]
        page.wait_for_timeout.side_effect = advance
        result = sample({})
        with tempfile.TemporaryDirectory() as directory, patch.object(hosted.time, "perf_counter", side_effect=lambda: now[0]):
            hosted.collect_startup_requests(page, SimpleNamespace(rows=rows), result, Path(directory) / "visit.json")
        self.assertEqual(60, now[0])
        self.assertEqual((100, 200), (result["navigation_to_auth_ms"], result["auth_to_usable_ms"]))
        self.assertNotIn("startup_collection_timeout", result)

    def test_timeout_records_pending_console_waterfall_before_teardown(self):
        now = [0]
        page = Mock()
        page.wait_for_timeout.side_effect = lambda ms: now.__setitem__(0, now[0] + 1)
        rows = {"pending": {"url": "https://fixture/pending"},
                "failed": {"failed": {"errorText": hosted.NETWORK_CHANGED}}, "done": {"end": 1}}
        result = sample({}, network=True)
        with tempfile.TemporaryDirectory() as directory, patch.object(hosted.time, "perf_counter", side_effect=lambda: now[0]):
            path = Path(directory) / "visit.json"
            with self.assertRaisesRegex(hosted.WaitTimeout, "first received-inbox response"):
                hosted.collect_startup_requests(page, SimpleNamespace(rows=rows), result, path)
            saved = json.loads(path.read_text(encoding="utf-8"))
        diagnostic = saved["startup_collection_timeout"]
        self.assertEqual(hosted.STARTUP_COLLECTION_TIMEOUT_S, now[0])
        self.assertEqual(now[0], diagnostic["timeout_s"])
        self.assertEqual([rows["pending"]], diagnostic["pending_requests"])
        self.assertEqual(list(rows.values()), diagnostic["waterfall"])
        self.assertEqual(result["console_errors"], diagnostic["console_errors"])
        self.assertEqual(200, saved["auth_to_usable_ms"])


class MeasuredPairs(unittest.TestCase):
    def collect(self, alter=lambda result: None):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        stack = SimpleNamespace(root=Path(directory.name) / "stack", side=None)
        stack.activate = lambda side: setattr(stack, "side", side)
        self.result = {"cold": [], "warm": [], "visits": [], "valid_pairs": {"cold": 0, "warm": 0}}
        def visit(stack, context, clock, patient, metadata):
            result = sample(metadata, stack.side)
            alter(result)
            hosted.save(stack.root.parent / f"visit-{metadata['visit']:02d}.json", result)
            if result.get("raise_failure"):
                raise hosted.VisitFailure(hosted.WaitTimeout("collection"), result)
            return result
        hosted.collect_pairs(stack, Mock(), None, "patient", self.result, visit)
        records = list(Path(directory.name).glob("visit-*.json"))
        self.assertEqual(len(self.result["visits"]), len(records))
        return self.result

    def test_network_change_replaces_entire_pair_at_end_including_dependent_warm(self):
        def alter(result):
            if result["visit"] == 1:
                result.update(sample(result, result["side"], network=True), raise_failure=True)
        result = self.collect(alter)
        self.assertEqual({"cold": 5, "warm": 5}, result["valid_pairs"])
        for mode in ("cold", "warm"):
            self.assertEqual([2, 3, 4, 5, 6], [p["baseline"]["pair"] for p in result[mode]])
        self.assertEqual({"cold": 1, "warm": 1}, result["replacements"])
        self.assertFalse(result["visits"][0]["valid"])
        self.assertEqual(24, len(result["visits"]))

    def test_only_deficient_phase_accepts_supplemental_pair(self):
        def alter(result):
            if result["visit"] == 2:
                result.update(sample(result, result["side"], network=True))
        result = self.collect(alter)
        self.assertEqual([1, 2, 3, 4, 5], [p["baseline"]["pair"] for p in result["cold"]])
        self.assertEqual([2, 3, 4, 5, 6], [p["baseline"]["pair"] for p in result["warm"]])
        self.assertEqual(["warm"], result["pair_attempts"][-1]["eligible_phases"])

    def test_slow_timing_kept_without_replacement(self):
        result = self.collect(lambda r: r.update(navigation_to_auth_ms=100000, auth_to_usable_ms=200000))
        self.assertEqual(20, len(result["visits"]))
        self.assertEqual({"cold": 0, "warm": 0}, result["replacements"])
        self.assertEqual([200000] * 5, [p["candidate"]["auth_to_usable_ms"] for p in result["warm"]])

    def test_network_replacement_budget_exhaustion_retains_shortfall(self):
        result = self.collect(lambda r: r.update(sample(r, r["side"], network=True)))
        self.assertEqual({"cold": 0, "warm": 0}, result["valid_pairs"])
        self.assertEqual({"cold": hosted.MAX_REPLACED_PAIRS_PER_PHASE,
                          "warm": hosted.MAX_REPLACED_PAIRS_PER_PHASE}, result["replacements"])
        self.assertEqual(5 + hosted.MAX_REPLACED_PAIRS_PER_PHASE, len(result["pair_attempts"]))

    def test_measured_timeout_without_network_evidence_fails_without_retry(self):
        def alter(result):
            result.update(valid=False, wait_failed=True, raise_failure=True)
        with self.assertRaises(hosted.VisitFailure):
            self.collect(alter)
        self.assertEqual(1, len(self.result["visits"]))
        self.assertEqual({"cold": 0, "warm": 0}, self.result["replacements"])

    def test_invalidity_requires_unanswered_request_and_network_error(self):
        result = sample({}, network=True)
        self.assertTrue(hosted.network_changed(result))
        result["waterfall"][0].update(status=200)
        self.assertFalse(hosted.network_changed(result))
        result["waterfall"][0].update(status=None, end=1)
        self.assertFalse(hosted.network_changed(result))
        result["waterfall"] = [{"failed": {"errorText": hosted.NETWORK_CHANGED}}]
        result["console_errors"] = []
        self.assertTrue(hosted.network_changed(result))
        result["waterfall"][0]["failed"]["errorText"] = "net::ERR_CONNECTION_RESET"
        self.assertFalse(hosted.network_changed(result))
        result["waterfall"] = [{"status": None}]
        self.assertFalse(hosted.network_changed(result))


class VisitLifecycle(unittest.TestCase):
    def test_network_failure_does_not_poison_next_visit_and_raw_rows_are_frozen(self):
        with tempfile.TemporaryDirectory() as directory:
            stack = hosted.HostedStack(Path(directory) / "stack", lambda: Mock(), "baseline-sha", Path(directory))
            stack.side, stack.origin = "baseline", "https://fixture"
            stack.url = stack.origin + "/worklist/hpacs-lite/main.html"
            stack.versions = {"baseline": {"main.html": hashlib.sha256(b"document").hexdigest()}}
            context, page = Mock(), Mock(url=stack.url)
            context.new_page.return_value = page
            handlers = {}
            page.on.side_effect = lambda event, fn: handlers.setdefault(event, []).append(fn)
            page.locator.return_value.inner_text.return_value = "patient"
            page.locator.return_value.count.return_value = 1
            resource = {"name": stack.origin + "/api/me", "startTime": 1, "responseEnd": 2}
            static = Mock(url=stack.url)
            static.body.return_value = b"document"
            static.all_headers.return_value = {}
            visit_number = [0]
            pending = {"url": stack.origin + "/api/lost", "failed": {"errorText": hosted.NETWORK_CHANGED}}

            def observer(*args):
                rows = {"document": {"url": stack.url, "status": 200, "protocol": "h2", "end": 1, "cache": {}, "transfer_size": 10}}
                rows.update({str(i): {"url": stack.origin + f"/worklist/hpacs-lite/{i}.js", "status": 200,
                             "protocol": "h2", "end": 1, "cache": {}, "transfer_size": 10, "type": "Script", "method": "GET"}
                             for i in range(56)})
                rows["inbox"] = {"url": stack.origin + "/api/critical-results?view=received&state=pending", "status": 200, "end": 1}
                if visit_number[0] == 0:
                    rows["lost"] = pending
                waterfall = Mock(rows=rows)
                waterfall.performance.return_value = {"now": 3, "resources": [resource], "navigation": [{"type": "navigate"}]}
                # Late CDP mutations during detach must not change saved decisions.
                waterfall.close.side_effect = lambda: pending.update(status=200, end=2, failed={})
                return waterfall

            def navigate(*args, **kwargs):
                stack.me_received.set()
                for fn in handlers["request"]:
                    fn(SimpleNamespace(url=stack.origin + "/api/me"))
                for fn in handlers["response"]:
                    fn(static)
                if visit_number[0] == 0:
                    stack.visit_violations.append("BrokenPipeError from aborted visit")
                    stack.violations.append("BrokenPipeError from aborted visit")
                    for fn in handlers["console"]:
                        fn(SimpleNamespace(type="error", text=hosted.NETWORK_CHANGED))
                visit_number[0] += 1
            page.goto.side_effect = navigate
            with patch.object(hosted, "Waterfall", side_effect=observer):
                with self.assertRaises(hosted.VisitFailure) as failure:
                    hosted.visit(stack, context, None, "patient", {"mode": "cold", "visit": 1})
                failed = failure.exception.result
                self.assertTrue(failed["network_changed"])
                self.assertTrue(hosted.network_changed(failed))
                self.assertEqual(["BrokenPipeError from aborted visit"], failed["fixture_violations"])
                self.assertEqual(json.loads(json.dumps(failed)),
                                 json.loads((Path(directory) / "visit-01.json").read_text(encoding="utf-8")))
                old_release, old_requests = stack.me_release, stack.requests
                handlers.clear()
                success = hosted.visit(stack, context, None, "patient", {"mode": "cold", "visit": 2})
                self.assertTrue(success["valid"])
                self.assertFalse(success["network_changed"])
                self.assertEqual([], success["fixture_violations"])
                self.assertEqual(["BrokenPipeError from aborted visit"], stack.violations)
                self.assertTrue(old_release.is_set())
                self.assertIsNot(old_release, stack.me_release)
                self.assertIsNot(old_requests, stack.requests)

    def test_late_handler_retains_its_visit_site_requests_and_errors_after_reset(self):
        with tempfile.TemporaryDirectory() as directory:
            stack = hosted.HostedStack(Path(directory) / "stack", lambda: Mock(), "sha", Path(directory))
            with patch.object(hosted, "ThreadingHTTPServer") as server, patch.object(hosted.threading, "Thread"):
                stack.start_api()
            handler_type = server.call_args.args[1]
            handler = object.__new__(handler_type)
            handler.path, handler.headers, handler.fulfill = "/api/me", {}, Mock()
            old_site, old_requests, old_violations = stack.site, stack.requests, stack.visit_violations
            old_site.api.side_effect = BrokenPipeError("closed page")
            old_release = Mock()
            old_release.wait.side_effect = lambda timeout: (stack.reset(), True)[1]
            stack.me_release = old_release
            handler.do_GET()
            old_site.api.assert_called_once()
            stack.site.api.assert_not_called()
            self.assertEqual(1, len(old_requests))
            self.assertEqual([], stack.requests)
            self.assertEqual(["BrokenPipeError('closed page')"], old_violations)
            self.assertEqual(old_violations, stack.violations)
            self.assertEqual([], stack.visit_violations)


if __name__ == "__main__":
    unittest.main(verbosity=2)
