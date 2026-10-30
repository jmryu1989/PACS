"""SCN-S9-FAIL-04/05: real service loss, observation and recovery.

REQ-S9-U3-NO-FALSE-SUCCESS/RECOVERY -> RISK-S9-U3-FALSE-SUCCESS/STUCK
-> TEST-S9-U3-ORTHANC/KEYCLOAK. Use the guarded live runner, only after the
operator hands over an isolated disposable synthetic stack and its Compose
project. LiveStack supplies accounts, DICOM and cleanup; this file creates no
stack and must never stop a shared or original-data service.

Actual served main/admin pages and public HTTP boundaries only. No route mocks,
page assembly, product hooks or inherited test selection. Gateway retry and
post-session document ownership belong to the existing Gateway/SESSION cases.
Transient IdP failure is AUTH_IDP_UNAVAILABLE, not invalid_grant/session end.

Readiness polling (180 s / 1 s) reuses measurement_ci.main's stack readiness;
Compose commands (120 s) reuse invariants_live's Orthanc restart case. These
are harness waits, not recovery SLOs. Browser waits use WorklistE2E's existing
30 s login bound. See the unit case-map for execution status and evidence.
"""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import Request

from playwright.sync_api import Error as PlaywrightError, TimeoutError as PlaywrightTimeoutError, expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "live"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from invariants_live import LiveStack, ROOT, psql
from session_support import Session, cleanup_sessions
import test_worklist as worklist


def event(stage, **result):
    print("S9-U3-SERVICES " + json.dumps({"stage": stage, **result}), flush=True)


class CancelledRecoveryRead(Exception):
    pass


class FailureServicesE2E(unittest.TestCase):
    service_restored = True
    # Reuse fixture/UI helpers without inheriting WorklistE2E's unrelated cases.
    login = worklist.WorklistE2E.login
    login_page = worklist.WorklistE2E.login_page
    select = worklist.WorklistE2E.select
    close_contexts = worklist.WorklistE2E.close_contexts
    cleanup_fixtures = worklist.WorklistE2E.cleanup_fixtures

    @classmethod
    def setUpClass(cls):
        if os.environ.get("KIN_SYNTHETIC_REALM") != "1" or not os.environ.get("COMPOSE_PROJECT_NAME"):
            raise RuntimeError("NOT_RUN_ENV: operator-owned synthetic realm and Compose project required")
        cls.stack = LiveStack()
        worklist.require_local_targets(cls.stack)
        cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.addClassCleanup(cleanup_sessions, cls.stack)
        cls.addClassCleanup(cls.stack.cleanup_all)
        cls.stack.require_stack()
        cls.pw = sync_playwright().start()
        cls.addClassCleanup(cls.pw.stop)
        cls.browser = cls.pw.chromium.launch()
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.assertTrue(type(self).service_restored, "Previous service restoration failed; inspect owned stack")
        self.contexts = []
        self.addCleanup(self.clean_owned_fixtures)
        self.addCleanup(self.close_contexts)

    def clean_owned_fixtures(self):
        self.cleanup_fixtures()
        event("fixture_cleanup", result="PASS")

    def running(self, container):
        result = subprocess.run(
            ["docker", "inspect", "--format", "{{.State.Running}}", container],
            cwd=ROOT, capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(result.returncode, 0, "Service state inspection failed")
        self.assertIn(result.stdout.strip(), ("true", "false"))
        return result.stdout.strip() == "true"

    def health(self, service):
        if service == "orthanc":
            return self.stack._orthanc_request("GET", "/system").status
        return Session(self.stack).call("GET", "/auth/realms/kin/.well-known/openid-configuration")[0]

    def wait_healthy(self, service):
        deadline = time.monotonic() + 180
        while True:
            try:
                if self.health(service) == 200:
                    return
            except (URLError, OSError):
                pass
            if time.monotonic() >= deadline:
                self.fail(service + " did not recover within the existing fixture readiness wait")
            time.sleep(1)

    @contextmanager
    def stopped(self, service):
        result = subprocess.run(
            ["docker", "compose", "ps", "-q", service],
            cwd=ROOT, capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(result.returncode, 0, "Owned Compose command failed: ps")
        container = result.stdout.strip()
        self.assertTrue(container and len(container.splitlines()) == 1, "Expected one owned service")
        self.assertTrue(self.running(container))
        self.assertEqual(self.health(service), 200)
        event("healthy_before", service=service)
        # Register restoration before stop: a failed command may already have stopped it.
        try:
            type(self).service_restored = False
            result = subprocess.run(
                ["docker", "compose", "stop", service],
                cwd=ROOT, capture_output=True, text=True, timeout=120,
            )
            self.assertEqual(result.returncode, 0, "Owned Compose command failed: stop")
            self.assertFalse(self.running(container))
            event("stopped", service=service, running=False)
            yield
        finally:
            result = subprocess.run(
                ["docker", "compose", "start", service],
                cwd=ROOT, capture_output=True, text=True, timeout=120,
            )
            self.assertEqual(result.returncode, 0, "Owned Compose command failed: start")
            self.wait_healthy(service)
            self.assertTrue(self.running(container))
            type(self).service_restored = True
            event("restored", service=service, running=True, health=200)

    @contextmanager
    def read_response(self, page, matches, *, recovery=False, method="GET"):
        # Only a new matching read on this page can explain its missing response.
        # DICOM lookup uses POST; all other reads here use GET.
        # A click/selection failure or a completed HTTP/data/UI check stays fatal.
        requests = []
        action_completed = False

        def requested(request):
            if request.method == method and matches(request):
                requests.append(request)

        page.on("request", requested)
        try:
            try:
                with page.expect_response(lambda r: r.request in requests) as response:
                    yield response
                    action_completed = True
            except PlaywrightTimeoutError as error:
                cancelled = [r.url for r in requests if r.failure == "net::ERR_NETWORK_CHANGED"]
                if recovery and action_completed and cancelled:
                    raise CancelledRecoveryRead(json.dumps(cancelled) + ": " + str(error)) from error
                raise
        finally:
            page.remove_listener("request", requested)

    def metrics(self, page, *, recovery=False):
        url = self.stack.proxy + "/api/admin/metrics"
        started = time.monotonic()

        def failed(request):
            if request.url == url:
                event("admin_metrics_request_failed", failure=request.failure)

        page.on("requestfailed", failed)
        try:
            with self.read_response(page, lambda r: r.url == url, recovery=recovery) as response:
                page.get_by_role("button", name="Refresh Operations", exact=True).click()
        except (PlaywrightError, CancelledRecoveryRead):
            # A browser response wait alone cannot distinguish a server stall
            # from a cancelled read on this Docker/browser host. Preserve both
            # observations while retaining the original test failure.
            try:
                probe_started = time.monotonic()
                # Send the session binding the page's own read sends: without
                # X-KIN-Session the route answers 428 AUTH_SESSION_REQUIRED, which
                # says nothing about the route itself.
                probe = page.request.get(url, timeout=30000, headers={
                    "X-KIN-Session": page.evaluate("KinAuth.sessionId()") or ""})
                event("admin_metrics_direct_probe", status=probe.status,
                      elapsed=time.monotonic() - probe_started)
            except PlaywrightError as error:
                event("admin_metrics_direct_probe_failed", error=str(error))
            raise
        finally:
            page.remove_listener("requestfailed", failed)
        self.assertEqual(response.value.status, 200)
        body = response.value.json()
        storage = next(row for row in body["metrics"] if row["key"] == "storage.server")
        event("admin_metrics_response", status=response.value.status,
              state=storage["state"], value=storage["value"], elapsed=time.monotonic() - started)
        return storage

    def test_orthanc_observation_thumbnail_storage_and_recovery(self):
        fixture = self.stack.create_fixture()
        other = self.stack.create_fixture()
        page = self.login("jmryu")
        self.select(page, other)
        page.wait_for_function("""() => [...document.querySelectorAll('#thumbwrap img')]
            .some(img => img.complete && img.naturalWidth > 0)""")
        # Learn this fixture's preview URL from the healthy served page, so an
        # unrelated study's cancelled preview cannot authorize recovery later.
        with page.expect_response(lambda r: r.url.startswith(self.stack.proxy + "/instances/")
                                  and r.url.endswith("/preview")) as preview_control:
            self.select(page, fixture)
        self.assertEqual(preview_control.value.status, 200)
        preview_url = preview_control.value.url
        # Images must have decoded, not merely acquired an <img> element.
        page.wait_for_function("""() => [...document.querySelectorAll('#thumbwrap img')]
            .some(img => img.complete && img.naturalWidth > 0)""")
        admin = page.context.new_page()
        admin.set_default_timeout(30000)
        admin.goto(self.stack.proxy + "/worklist/hpacs-lite/admin.html")
        storage_row = admin.get_by_role("row").filter(has_text="Storage Used (Server-wide)")
        normal = self.metrics(admin)
        self.assertEqual(normal["state"], "observed")
        self.assertGreater(normal["value"], 0, "Synthetic DICOM supplies a nonzero storage control")
        expect(storage_row).to_contain_text("Observed")
        # Selecting the same study is deliberately a no-op. Change study before
        # the outage so the later click really requests its thumbnails again.
        self.select(page, other)
        page.wait_for_function("""() => [...document.querySelectorAll('#thumbwrap img')]
            .some(img => img.complete && img.naturalWidth > 0)""")
        table = page.locator("#rows").locator("xpath=..")
        count_column = table.get_by_role("columnheader", name="Count", exact=True).evaluate("el => el.cellIndex")
        other_row = page.locator(f'#rows tr[data-uid="{other.uid}"]')
        last_count = other_row.locator("td").nth(count_column).inner_text()
        self.assertGreater(int(last_count), 0)

        with self.stopped("orthanc"):
            with self.subTest(boundary="list_and_arrival_observation"):
                with page.expect_response(lambda r: "/api/studies?" in r.url) as response:
                    page.get_by_role("group", name="Refresh", exact=True).get_by_role("button", name="Refresh", exact=True).click()
                self.assertGreaterEqual(response.value.status, 500)
                expect(page.locator("#err")).not_to_be_empty()
                expect(page.locator("#observation-status")).to_contain_text("관측 불가")
                expect(other_row).to_be_visible()
                expect(other_row.locator("td").nth(count_column)).to_have_text(last_count)
                event("orthanc_list_and_arrivals", status=response.value.status, stale_row_preserved=True)
            with self.subTest(boundary="thumbnail"):
                # Selection requests the actual DICOM boundary again while Orthanc is stopped.
                with page.expect_response(lambda r: f"/dicom-web/studies/{fixture.uid}/instances" in r.url) as response:
                    self.select(page, fixture)
                # The DICOM auth_request boundary maps unavailable source identity
                # to 403 (pacs/dicom-gateway.ts); it cannot forward a 503 body.
                self.assertEqual(response.value.status, 403)
                expect(page.locator("#thumbwrap")).to_contain_text("실패")
                self.assertEqual(page.locator("#thumbwrap img").count(), 0)
                event("orthanc_thumbnail", result="unavailable")
            with self.subTest(boundary="admin_storage"):
                lost = self.metrics(admin)
                self.assertEqual((lost["state"], lost["value"]), ("unobservable", None))
                expect(storage_row).to_contain_text("Unobservable")
                expect(storage_row.locator(".metric-value")).not_to_contain_text(re.compile(r"\d"))
                event("orthanc_admin_storage", state=lost["state"], value=lost["value"])

        # Docker's restarted interface can invalidate Chromium reads on the same
        # host, even after Orthanc is healthy: Chromium cancels whatever read of
        # either page is in flight with net::ERR_NETWORK_CHANGED (observed on G3's
        # admin metrics read and the VM's thumbnail instance read). Keep the existing
        # one-repeat policy; these samples do not establish a one-event upper bound.
        # Only a missing response to the required read can trigger it. Assertions
        # and other browser failures escape, even alongside an unrelated cancel.

        def network_changed(request):
            if request.failure == "net::ERR_NETWORK_CHANGED" and request.url.startswith(self.stack.proxy + "/"):
                event("browser_network_changed", url=request.url)

        page.context.on("requestfailed", network_changed)
        try:
            for repeat in (False, True):
                try:
                    # Selecting the same study is a no-op. Move away on each attempt
                    # so the fixture selection below owns a fresh thumbnail read.
                    self.select(page, other)
                    with self.read_response(page, lambda r: r.url.startswith(
                            self.stack.proxy + "/api/studies?"), recovery=True) as response:
                        page.get_by_role("group", name="Refresh", exact=True).get_by_role("button", name="Refresh", exact=True).click()
                    self.assertEqual(response.value.status, 200)
                    returned = response.value.json()
                    observed = next(row for row in returned["studies"] if row["uid"] == fixture.uid)
                    self.assertGreater(observed["count"], 0)
                    # Arm the dependent reads before selection, then consume them
                    # in source order. A cancelled upstream read need not produce
                    # a downstream request; a completed bad answer remains fatal.
                    with self.read_response(page, lambda r: r.url == preview_url, recovery=True) as preview:
                        with self.read_response(page, lambda r: r.url == self.stack.proxy + "/api/dicom/lookup"
                                and r.post_data_json.get("studyUid") == fixture.uid,
                                recovery=True, method="POST") as lookup:
                            with self.read_response(page, lambda r: r.url == self.stack.proxy +
                                    f"/dicom-web/studies/{fixture.uid}/instances", recovery=True) as thumbnails:
                                self.select(page, fixture)
                            self.assertEqual(thumbnails.value.status, 200)
                        self.assertEqual(lookup.value.status, 200)
                    self.assertEqual(preview.value.status, 200)
                    page.wait_for_function("""() => [...document.querySelectorAll('#thumbwrap img')]
                        .some(img => img.complete && img.naturalWidth > 0)""")
                    expect(page.locator("#err")).to_be_empty()
                    expect(page.locator("#observation-status")).not_to_contain_text("관측 불가")
                    recovered = self.metrics(admin, recovery=True)
                    self.assertEqual(recovered["state"], "observed")
                    self.assertGreater(recovered["value"], 0)
                    expect(storage_row).to_contain_text("Observed")
                    break
                except CancelledRecoveryRead as error:
                    if repeat:
                        raise
                    event("orthanc_host_network_changed",
                          error_type=type(error).__name__, error=str(error), retry="recovery_step")
        finally:
            page.context.remove_listener("requestfailed", network_changed)
        event("orthanc_workflow_recovered", list_status=200, count=observed["count"], thumbnail=True, repeated=repeat)

    def test_keycloak_login_refresh_failure_and_recovery(self):
        session = Session(self.stack).login(self)
        fresh = Session(self.stack)
        # Existing session fixtures move only their owned row into the refresh branch;
        # no realm lifespan, product clock or other account is changed.
        def require_refresh():
            rows = psql('UPDATE "AuthSession" SET "atExpiresAt" = now() - interval \'1 minute\' '
                        f'WHERE sub=\'{session.me["sub"]}\' RETURNING sub;')
            self.assertEqual(rows, [session.me["sub"]], "Exactly this fixture's single session must be expired")

        require_refresh()
        self.assertEqual(session.json("GET", "/api/me")[0], 200, "Healthy refresh control")
        with self.stopped("keycloak"):
            with self.subTest(boundary="login"):
                status, headers, _ = fresh.call("GET", "/api/auth/login")
                if status == 302:
                    # A stopped upstream can outlast Session.call's 30 s read
                    # wait. Use the existing 180 s fixture wait to observe the
                    # actual proxy response, never count a client timeout as it.
                    try:
                        with fresh.opener.open(Request(headers["Location"]), timeout=180) as response:
                            status = response.status
                    except HTTPError as error:
                        status = error.code
                self.assertGreaterEqual(status, 500, "Stopped provider cannot complete login")
                self.assertIsNone(fresh.sid())
                self.assertEqual(fresh.json("GET", "/api/me")[0], 401)
                event("keycloak_login", status=status, authenticated=False)
            with self.subTest(boundary="refresh"):
                require_refresh()
                status, _, body = session.json("GET", "/api/me")
                self.assertEqual(status, 503)
                self.assertEqual(body["code"], "AUTH_IDP_UNAVAILABLE")
                event("keycloak_refresh", status=status, code=body["code"])

        self.assertEqual(session.json("GET", "/api/me")[0], 200, "Transient failure recovers")
        Session(self.stack).login(self)
        # Also complete the real served browser login and list path after restart.
        page = self.login()
        expect(page.locator("#dbstat")).to_contain_text("DB Connected")
        event("keycloak_workflow_recovered", login=True, refresh=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
