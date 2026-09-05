"""Run B2: real local Keycloak/BFF, C-STORE, worklist and OHIF browser tests.

Run from the repository: python tests/e2e/test_worklist.py
Only fixture setup and assertions use the API; workflows use real UI actions.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
import uuid

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from invariants_live import LiveStack, ROOT, psql  # noqa: E402


def require_local_targets(stack):
    """Fail before creating/deleting anything, including with a remote Docker context."""
    for name in ("proxy", "api", "keycloak", "orthanc"):
        parsed = urlsplit(getattr(stack, name))
        if (parsed.scheme not in ("http", "https")
                or parsed.hostname not in ("localhost", "127.0.0.1", "::1")
                or parsed.username or parsed.password):
            raise RuntimeError(f"E2E refuses non-local {name}")
    if os.environ.get("KIN_TEST_INGEST", "cstore").strip().lower() != "cstore":
        raise RuntimeError("E2E requires local cstore fixtures")
    compose_file = os.environ.get("COMPOSE_FILE", "")
    if compose_file and Path(compose_file).resolve() != ROOT / "docker-compose.yml":
        raise RuntimeError("E2E requires the repository's local Compose file")
    docker_host = os.environ.get("DOCKER_HOST", "")
    if docker_host and not docker_host.startswith(("npipe:////./pipe/", "unix:///")):
        raise RuntimeError("E2E refuses remote DOCKER_HOST")
    endpoint = subprocess.run(
        ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
        cwd=ROOT, capture_output=True, text=True, check=True, timeout=15,
    ).stdout.strip()
    if not endpoint.startswith(("npipe:////./pipe/", "unix:///")):
        raise RuntimeError("E2E requires a local Docker socket")


class LocalTargetGuardTests(unittest.TestCase):
    def targets(self, **changes):
        values = dict(proxy="https://localhost:9443", api="https://localhost:9443/api",
                      keycloak="http://127.0.0.1:8080/auth", orthanc="http://127.0.0.1:8042")
        values.update(changes)
        return SimpleNamespace(**values)

    def test_12a_remote_urls_rejected_before_any_command(self):
        """E2E-B2-12a: neither HTTP targets nor disguised localhost credentials are allowed."""
        for name in ("proxy", "api", "keycloak", "orthanc"):
            for url in ("https://pacs.example.test", "https://localhost.evil.test",
                        "https://localhost@evil.test", "https://secret@localhost"):
                with self.subTest(target=name, url=url), patch.object(subprocess, "run") as command:
                    with self.assertRaisesRegex(RuntimeError, "non-local"):
                        require_local_targets(self.targets(**{name: url}))
                    command.assert_not_called()

    def test_12b_remote_docker_and_gateway_rejected(self):
        """E2E-B2-12b: fixture writes cannot use a remote Docker daemon or Gateway."""
        for overrides in ({"DOCKER_HOST": "ssh://remote"}, {"DOCKER_HOST": "tcp://127.0.0.1:2375"},
                          {"DOCKER_HOST": "npipe:////remote/pipe/docker_engine"},
                          {"KIN_TEST_INGEST": "gateway"}, {"COMPOSE_FILE": "docker-compose.prod.yml"}):
            with self.subTest(env=overrides), patch.dict(os.environ, overrides, clear=True), patch.object(subprocess, "run") as command:
                with self.assertRaises(RuntimeError):
                    require_local_targets(self.targets())
                command.assert_not_called()

    def test_12c_remote_context_rejected(self):
        """E2E-B2-12c: selecting a remote Docker context also fails before fixture creation."""
        with patch.dict(os.environ, {}, clear=True), patch.object(subprocess, "run", return_value=SimpleNamespace(stdout="ssh://remote")):
            with self.assertRaisesRegex(RuntimeError, "local Docker socket"):
                require_local_targets(self.targets())


class WorklistE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stack = LiveStack()
        require_local_targets(cls.stack)
        cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.addClassCleanup(cls.cleanup_sessions)
        cls.addClassCleanup(cls.stack.cleanup_all)
        cls.stack.require_stack()
        cls.pw = sync_playwright().start()
        cls.addClassCleanup(cls.pw.stop)
        cls.browser = cls.pw.chromium.launch(
            headless=os.environ.get("KIN_E2E_HEADED") != "1",
            args=["--enable-unsafe-swiftshader"],
        )
        cls.addClassCleanup(cls.browser.close)
        expect.set_options(timeout=15000)

    @classmethod
    def cleanup_sessions(cls):
        # AuthSession has no FK to Keycloak. Delete only this run's subjects.
        ids = list(cls.stack.user_ids.values())
        for sub in ids:
            if str(uuid.UUID(sub)) != sub:
                raise RuntimeError("Invalid temporary subject; refusing session cleanup")
        if ids:
            quoted = ",".join("'" + sub + "'" for sub in ids)
            psql(f'DELETE FROM "AuthSession" WHERE sub IN ({quoted});')
            if psql(f'SELECT count(*) FROM "AuthSession" WHERE sub IN ({quoted});') != ["0"]:
                raise RuntimeError("E2E session cleanup failed")

    def setUp(self):
        self.contexts = []
        self.addCleanup(self.cleanup_fixtures)
        self.addCleanup(self.close_contexts)

    def cleanup_fixtures(self):
        uids = list(self.stack.active)
        self.stack.cleanup_all()
        for uid in uids:
            if not re.fullmatch(r"[0-9.]+", uid):
                raise RuntimeError("Invalid fixture UID in cleanup verification")
            lookup = self.stack._orthanc_request("POST", "/tools/lookup", uid.encode("ascii"))
            self.assertEqual(lookup.status, 200)
            self.assertEqual(lookup.body, [], "An owned Orthanc fixture remains")
            for table in ("StudyState", "Report", "ReportDraft", "ReportVersion"):
                self.assertEqual(psql(f'SELECT count(*) FROM "{table}" WHERE uid=\'{uid}\';'), ["0"], table)
            self.assertEqual(psql(f'SELECT count(*) FROM "AuditLog" WHERE target=\'{uid}\';'), ["0"])

    def close_contexts(self):
        # Close JS timers before deleting fixture rows. No traces/auth storage are saved.
        failures = []
        for context in self.contexts:
            try:
                context.close()
            except Exception as error:
                failures.append(type(error).__name__)
        if failures:
            raise RuntimeError("Browser cleanup failed: " + ",".join(failures))

    def tearDown(self):
        # Capture only authenticated app pages after a failure, never login forms.
        result = self._outcome.result
        failures = result.failures + result.errors + [
            (test, error) for test, error in getattr(self._outcome, "errors", []) if error
        ]
        if any(test is self for test, _ in failures):
            folder = Path(__file__).parent / "artifacts"
            folder.mkdir(exist_ok=True)
            for i, context in enumerate(self.contexts):
                for j, page in enumerate(context.pages):
                    if "/worklist/hpacs-lite/main.html" in page.url:
                        page.screenshot(path=str(folder / f"{self._testMethodName}-{i}-{j}.png"))

    def login(self, actor="doctor"):
        context = self.browser.new_context(ignore_https_errors=True, viewport={"width": 1600, "height": 1050})
        self.contexts.append(context)
        page = context.new_page()
        page.set_default_timeout(20000)
        page.goto(self.stack.proxy + "/")
        try:
            page.locator("#username").fill(self.stack.username(actor))
            page.locator("#password").fill(self.stack.passwords[actor])
            page.locator("#kc-login").click()
        except Exception:
            # Playwright's call log can include fill() values; never print credentials.
            raise RuntimeError("Real BFF login form could not be submitted") from None
        page.wait_for_url("**/worklist/hpacs-lite/main.html", timeout=30000)
        expect(page.locator("#dbstat")).to_contain_text("DB 연결됨")
        expect(page.locator("#roles")).to_contain_text("technician" if actor == "tech" else "radiologist")
        return page

    def fixture(self, **kwargs):
        return self.stack.create_fixture(**kwargs)

    def select(self, page, fixture):
        page.locator("#quick").fill(fixture.patient_id)
        row = page.locator(f'#rows tr[data-uid="{fixture.uid}"]')
        expect(row).to_be_visible()
        row.click()
        expect(row).to_have_class(re.compile(r"\bsel\b"))
        return row

    def state(self, fixture, actor="doctor"):
        result = self.stack.request("GET", "/bootstrap", actor)
        self.assertEqual(result.status, 200)
        return result.body["states"][fixture.uid]

    def versions(self, fixture):
        result = self.stack.request("GET", f"/studies/{fixture.uid}/report/versions", "doctor")
        self.assertEqual(result.status, 200)
        return sorted(result.body, key=lambda row: row["version"])

    def patch(self, fixture, **body):
        result = self.stack.request("PATCH", f"/studies/{fixture.uid}", "tech", body)
        self.assertEqual(result.status, 200)

    def seed_report(self, fixture, action="save", findings=None):
        result = self.stack.request("POST", f"/studies/{fixture.uid}/report/commit", "doctor", {
            "action": action, "baseVersion": 0,
            "findings": findings or fixture.secret, "conclusion": "E2E conclusion", "recommendation": "",
        })
        self.assertEqual(result.status, 201)

    def wait_state(self, page, fixture, predicate, actor="doctor", timeout=15000):
        deadline = time.monotonic() + timeout / 1000
        while time.monotonic() < deadline:
            state = self.state(fixture, actor)
            if predicate(state):
                return state
            page.wait_for_timeout(150)
        self.fail("Server state did not reach the expected condition")

    def commit(self, page, fixture, button, rs):
        with page.expect_response(lambda r: r.request.method == "POST"
                                  and r.url.endswith(f"/studies/{fixture.uid}/report/commit")) as reply:
            page.locator(button).click()
        self.assertEqual(reply.value.status, 201)
        self.assertEqual(reply.value.json()["rs"], rs)
        self.assertEqual(self.state(fixture)["rs"], rs)

    def locked(self, page):
        expect(page.locator("#findings")).to_have_js_property("readOnly", True)
        for button in ("#b-save", "#b-transcribe", "#b-approve"):
            expect(page.locator(button)).to_be_disabled()

    def context_action(self, page, fixture, label):
        page.locator(f'#rows tr[data-uid="{fixture.uid}"]').click(button="right")
        page.locator("#ctx").get_by_text(label, exact=True).click()

    def test_01_bff_login_logout(self):
        """E2E-B2-01: real PKCE login, cookie flags, browser logout revokes session."""
        page = self.login()
        response = page.context.request.get(self.stack.api + "/me")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.json()["actor"], self.stack.actor("doctor"))
        sid = next(c for c in page.context.cookies() if c["name"] == "kin_sid")
        self.assertTrue(sid["httpOnly"] and sid["secure"])
        self.assertEqual(sid["sameSite"], "Strict")
        # Read-only JS assertions: access tokens must never be browser storage data.
        self.assertEqual(page.evaluate("['kin-at','kin-rt','kin-it'].map(k => sessionStorage.getItem(k))"), [None]*3)
        self.assertNotIn("kin_sid=", page.evaluate("document.cookie"))
        page.once("dialog", lambda dialog: dialog.accept())
        with page.expect_response(lambda r: r.request.method == "POST" and r.url.endswith("/auth/logout")) as reply:
            page.locator("#logout").click()
        self.assertIn(reply.value.status, (200, 204))
        self.assertEqual(page.context.request.get(self.stack.api + "/me").status, 401)

    def test_02_selection_draft_isolation(self):
        """E2E-B2-02: changing the selected exam preserves the draft under its own UID."""
        first, second = self.fixture(), self.fixture()
        self.seed_report(first)
        self.seed_report(second)
        page = self.login()
        self.select(page, first)
        expect(page.locator("#findings")).to_have_value(first.secret)
        draft = first.secret + " edited in browser"
        page.locator("#findings").fill(draft)
        with page.expect_response(lambda r: r.request.method == "PUT" and r.url.endswith(f"/studies/{first.uid}/report")) as reply:
            self.select(page, second)
        self.assertEqual(reply.value.status, 200)
        expect(page.locator("#findings")).to_have_value(second.secret)
        self.assertEqual(self.state(first)["draft"]["findings"], draft)
        self.assertEqual(self.state(first)["findings"], first.secret)
        self.assertEqual(self.state(second)["findings"], second.secret)
        self.assertIsNone(self.state(second).get("draft"))
        self.select(page, first)
        expect(page.locator("#findings")).to_have_value(draft)

    def test_03_filming_locks_non_emergency(self):
        """E2E-B2-03: Unverified non-emergency cannot be edited or committed."""
        fixture = self.fixture()
        self.patch(fixture, ss="Unverified", em="N")
        page = self.login()
        row = self.select(page, fixture)
        expect(row).to_have_class(re.compile(r"\bunv\b"))
        self.locked(page)
        self.assertEqual(self.state(fixture)["ss"], "Unverified")

    def test_04_technician_verify_enables_save(self):
        """E2E-B2-04: technician Verify propagates to the radiologist's browser."""
        fixture = self.fixture()
        self.patch(fixture, ss="Unverified", em="N")
        doctor = self.login()
        self.select(doctor, fixture)
        self.locked(doctor)
        tech = self.login("tech")
        tech.locator('[data-tab="Technician"]').click()
        self.select(tech, fixture)
        with tech.expect_response(lambda r: r.request.method == "PATCH" and r.url.endswith(f"/studies/{fixture.uid}")) as reply:
            tech.locator("#t-verify").click()
        self.assertEqual(reply.value.status, 200)
        self.assertEqual(self.state(fixture)["ss"], "Verified")
        doctor.locator("#refresh").click()
        for button in ("#b-save", "#b-transcribe", "#b-approve"):
            expect(doctor.locator(button)).to_be_enabled()
        expect(doctor.locator("#findings")).to_have_js_property("readOnly", False)
        doctor.locator("#findings").fill(fixture.secret)
        self.commit(doctor, fixture, "#b-save", "T")

    def test_05_emergency_only_unlocks_target(self):
        """E2E-B2-05: Emergency bypasses filming while another normal exam remains locked."""
        emergency, normal = self.fixture(), self.fixture()
        for fixture in (emergency, normal):
            self.patch(fixture, ss="Unverified", em="N")
        tech = self.login("tech")
        tech.locator('[data-tab="Technician"]').click()
        self.select(tech, emergency)
        with tech.expect_response(lambda r: r.request.method == "PATCH" and r.url.endswith(f"/studies/{emergency.uid}")) as reply:
            self.context_action(tech, emergency, "Switch to Emergency")
        self.assertEqual(reply.value.status, 200)
        self.assertEqual((self.state(emergency)["ss"], self.state(emergency)["em"]), ("Unverified", "E"))
        doctor = self.login()
        self.select(doctor, emergency)
        expect(doctor.locator("#b-save")).to_be_enabled()
        doctor.locator("#findings").fill(emergency.secret)
        self.commit(doctor, emergency, "#b-save", "T")
        self.select(doctor, normal)
        self.locked(doctor)

    def test_06_prior_preview_and_comparison_viewer(self):
        """E2E-B2-06: prior double-click loads both studies without changing report target."""
        patient = "E2E-" + uuid.uuid4().hex[:16]
        current, prior = self.fixture(patient_id=patient), self.fixture(patient_id=patient)
        self.seed_report(current)
        self.seed_report(prior, action="approve")
        page = self.login()
        self.select(page, current)
        related = page.locator(f'#relrows tr[data-uid="{prior.uid}"]')
        related.click()
        expect(page.locator("#prior-findings")).to_contain_text(prior.secret)
        expect(page.locator("#findings")).to_have_value(current.secret)
        frames_loaded = set()

        def record_frame(response):
            if response.status == 200 and "/frames/" in response.url:
                for fixture in (current, prior):
                    if f"/studies/{fixture.uid}/" in response.url:
                        frames_loaded.add(fixture.uid)

        page.context.on("response", record_frame)
        with page.context.expect_page() as opened:
            related.dblclick()
        viewer = opened.value
        viewer.wait_for_url("**/ohif/viewer?**", timeout=30000)
        query = parse_qs(urlsplit(viewer.url).query)
        self.assertEqual(query["StudyInstanceUIDs"], [current.uid + "," + prior.uid])
        self.assertEqual(query["hangingProtocolId"], ["@ohif/hpCompare"])
        expect(page.locator(f'#rows tr[data-uid="{current.uid}"]')).to_have_class(re.compile(r"\bsel\b"))
        expect(page.locator("#findings")).to_have_value(current.secret)
        # Require actual loaded image viewports, not just a correctly constructed URL.
        expect(viewer.locator(".cornerstone-canvas")).to_have_count(2, timeout=60000)
        for canvas in viewer.locator(".cornerstone-canvas").all():
            expect(canvas).to_be_visible()
        # Cornerstone draws to 2D viewport canvases. An allocated but blank canvas
        # must not pass: real CT pixels have a range of grayscale intensities.
        viewer.wait_for_function("""() => {
            const canvases = [...document.querySelectorAll('.cornerstone-canvas')];
            return canvases.length === 2 && canvases.every(canvas => {
                const context = canvas.getContext('2d');
                if (!context || !canvas.width || !canvas.height) return false;
                const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
                let min = 255, max = 0;
                for (let i = 0; i < data.length; i += 16) {
                    min = Math.min(min, data[i]); max = Math.max(max, data[i]);
                }
                return max - min > 40;
            });
        }""", timeout=60000)
        self.assertEqual(frames_loaded, {current.uid, prior.uid})

    def test_07_two_accounts_hold_and_draft(self):
        """E2E-B2-07: second account cannot overwrite the current writer's draft."""
        fixture = self.fixture()
        first, second = self.login(), self.login("doctor2")
        self.select(first, fixture)
        first.locator("#findings").fill(fixture.secret)
        self.wait_state(first, fixture, lambda s: s.get("holder") == self.stack.actor("doctor"))
        self.select(second, fixture)
        second.locator("#refresh").click()
        expect(second.locator("#holdbar")).to_be_visible()
        self.locked(second)
        second.locator(f'#rows tr[data-uid="{fixture.uid}"]').click(button="right")
        expect(second.locator("#ctx").get_by_text("점유 강제 해제 (관리자)", exact=True)).to_have_count(0)
        second.locator("#quick").click()
        self.wait_state(first, fixture, lambda s: (s.get("draft") or {}).get("findings") == fixture.secret, timeout=25000)
        self.assertIsNone(self.state(fixture, "doctor2").get("draft"))
        self.assertEqual(self.state(fixture)["findings"], "")

    def test_08_admin_force_release_keeps_draft(self):
        """E2E-B2-08: audited admin UI release allows a new writer, retains old draft."""
        fixture = self.fixture()
        first = self.login()
        self.select(first, fixture)
        first.locator("#findings").fill(fixture.secret)
        self.wait_state(first, fixture, lambda s: (s.get("draft") or {}).get("findings") == fixture.secret, timeout=25000)
        admin = self.login("jmryu")
        self.select(admin, fixture)
        admin.once("dialog", lambda dialog: dialog.accept())
        with admin.expect_response(lambda r: r.url.endswith(f"/studies/{fixture.uid}/release/force")) as reply:
            self.context_action(admin, fixture, "점유 강제 해제 (관리자)")
        self.assertEqual(reply.value.status, 200)
        self.assertIsNone(self.state(fixture).get("holder"))
        audit = self.stack.request("GET", f"/audit?uid={fixture.uid}", "jmryu")
        self.assertEqual(audit.status, 200)
        releases = [r for r in audit.body if r["action"] == "hold.force-release"]
        self.assertEqual(len(releases), 1)
        self.assertEqual(json.loads(releases[0]["detail"])["holder"], self.stack.actor("doctor"))
        second = self.login("doctor2")
        self.select(second, fixture)
        second.locator("#findings").fill("Second writer after administrator release")
        self.wait_state(second, fixture, lambda s: s.get("holder") == self.stack.actor("doctor2"))
        self.assertEqual(self.state(fixture)["draft"]["findings"], fixture.secret)
        first.locator("#refresh").click()
        self.locked(first)

    def test_09_defer_reason_cancel_and_commit(self):
        """E2E-B2-09: reason is mandatory, cancel is inert, H carries the reason/history."""
        fixture = self.fixture()
        page = self.login()
        self.select(page, fixture)
        page.locator("#b-defer").click()
        expect(page.locator("#reasonmodal")).to_be_visible()
        expect(page.locator("#reason-ok")).to_be_disabled()
        page.locator("#reason-cancel").click()
        expect(page.locator("#reasonmodal")).to_be_hidden()
        self.assertEqual(self.state(fixture)["rs"], "W")
        self.assertEqual(self.versions(fixture), [])
        page.locator("#findings").fill(fixture.secret)
        page.locator("#b-defer").click()
        page.locator("#reason-choices").get_by_text("기타", exact=True).click()
        expect(page.locator("#reason-ok")).to_be_disabled()
        page.locator("#reason-extra").fill("Public fixture prior required")
        self.commit(page, fixture, "#reason-ok", "H")
        reason = "기타 — Public fixture prior required"
        expect(page.locator("#defermsg")).to_contain_text(reason)
        self.assertEqual(self.state(fixture)["holdReason"], reason)
        self.assertEqual(self.versions(fixture)[-1]["reason"], reason)
        self.assertIsNone(self.state(fixture).get("holder"))

    def test_10_reset_keeps_approved_history(self):
        """E2E-B2-10: cancel preserves A; reasoned Reset appends W, never deletes A."""
        fixture = self.fixture()
        self.seed_report(fixture, action="approve")
        before = self.versions(fixture)
        page = self.login()
        self.select(page, fixture)
        page.locator("#b-unread").click()
        expect(page.locator("#reason-ok")).to_be_disabled()
        page.locator("#reason-cancel").click()
        self.assertEqual(self.versions(fixture), before)
        self.assertEqual(self.state(fixture)["rs"], "A")
        page.locator("#b-unread").click()
        page.locator("#reason-choices").get_by_text("내용 정정 필요", exact=True).click()
        self.commit(page, fixture, "#reason-ok", "W")
        after = self.versions(fixture)
        self.assertEqual(after[:len(before)], before)
        self.assertEqual([row["action"] for row in after[len(before):]], ["discarded", "reset"])
        self.assertEqual((after[-1]["action"], after[-1]["reason"]), ("reset", "내용 정정 필요"))
        expect(page.locator("#findings")).to_have_value("")

    def test_11_approved_buttons_stay_disabled_after_reload(self):
        """E2E-B2-11: UI Approve turns off save/transcribe/approve, including after reload."""
        fixture = self.fixture()
        page = self.login()
        self.select(page, fixture)
        page.locator("#findings").fill(fixture.secret)
        self.commit(page, fixture, "#b-approve", "A")
        for reload in (False, True):
            if reload:
                page.reload()
                self.select(page, fixture)
            for button in ("#b-save", "#b-transcribe", "#b-approve"):
                expect(page.locator(button)).to_be_disabled()
            for button in ("#b-addendum", "#b-unread"):
                expect(page.locator(button)).to_be_enabled()
            expect(page.locator("#findings")).to_have_value(fixture.secret)
        self.assertEqual(len(self.versions(fixture)), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
