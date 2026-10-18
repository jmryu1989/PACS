"""Run B2: real local Keycloak/BFF, C-STORE, worklist and OHIF browser tests.

Run from the repository: python tests/e2e/test_worklist.py
Only fixture setup and assertions use the API; workflows use real UI actions.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import sys
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen
import uuid
import zipfile

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from invariants_live import LiveStack, ROOT, psql, s9u4_cleanup, s9u4_dicom, s9u4_uid  # noqa: E402
from document_session import document_request


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
    browser_channel = None

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
            channel=cls.browser_channel,
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
        expect(page.locator("#dbstat")).to_contain_text("DB Connected")
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

    def open_toolbar_group(self, page, selector):
        # S5-UI2: the worklist toolbar keeps most controls in <details> groups (Filters, View, More, the Auto Refresh
        # menu). Open each closed group holding `selector`, outermost first, by clicking its summary as a user does.
        # A control in view needs nothing; an open group is left open.
        groups = page.locator(selector).first.evaluate("""e => {
            const out = [];
            for (let d = (e.tagName === 'SUMMARY' ? e.parentElement : e).parentElement.closest('details'); d;
                 d = d.parentElement.closest('details')) out.unshift(d.id);
            return out;
        }""")
        for group in groups:
            menu = page.locator('#' + group)
            if menu.get_attribute('open') is None:
                menu.locator(':scope > summary').click()

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
        self.assertEqual(reply.value.json()["state"]["rs"], rs)
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
        response = document_request(page, "GET", self.stack.api + "/me")
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
        canvases = viewer.locator(".cornerstone-canvas")
        expect(canvases).to_have_count(2, timeout=60000)
        # Locator.all() reads the element count once without retrying and returns that
        # many nth() locators. A canvas that lives only while the compare layout settles
        # raises that count to three, and the loop then waits out its whole timeout on an
        # nth(2) the settled compare layout never has. Bind the loop to the count this
        # contract asserts, not to whatever happened to be in the DOM at that instant.
        for index in range(2):
            expect(canvases.nth(index)).to_be_visible()
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
        try:
            expect(second.locator("#holdbar")).to_be_visible()
        except AssertionError:
            diagnostic = second.evaluate("""() => ({
                error: document.querySelector('#err')?.textContent,
                holdDisplay: document.querySelector('#holdbar')?.style.display,
                holdMessage: document.querySelector('#holdmsg')?.textContent,
                selected: document.querySelector('#rows tr.sel')?.dataset.uid,
                findingsReadOnly: document.querySelector('#findings')?.readOnly,
                visibility: document.visibilityState,
                ancestors: (() => { const result=[]; for(let el=document.querySelector('#holdbar');el;el=el.parentElement)
                    result.push({id:el.id,display:getComputedStyle(el).display,visibility:getComputedStyle(el).visibility}); return result; })()
            })""")
            diagnostic['ownerState'] = self.state(fixture)
            diagnostic['secondState'] = self.state(fixture, 'doctor2')
            print('TWO_ACCOUNT_HOLD_DIAGNOSTIC ' + json.dumps(diagnostic, ensure_ascii=True), flush=True)
            evidence = Path(os.environ.get('KIN_EVIDENCE_DIR', str(ROOT.parent / 'tmp' / 'worklist')))
            evidence.mkdir(parents=True, exist_ok=True)
            second.screenshot(path=str(evidence / 'two-account-hold-failure.png'))
            raise
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
        self.open_toolbar_group(page, "#b-defer")
        page.locator("#b-defer").click()
        expect(page.locator("#reasonmodal")).to_be_visible()
        expect(page.locator("#reason-ok")).to_be_disabled()
        page.locator("#reason-cancel").click()
        expect(page.locator("#reasonmodal")).to_be_hidden()
        self.assertEqual(self.state(fixture)["rs"], "W")
        self.assertEqual(self.versions(fixture), [])
        page.locator("#findings").fill(fixture.secret)
        self.open_toolbar_group(page, "#b-defer")
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
        self.open_toolbar_group(page, "#b-unread")
        page.locator("#b-unread").click()
        expect(page.locator("#reason-ok")).to_be_disabled()
        page.locator("#reason-cancel").click()
        self.assertEqual(self.versions(fixture), before)
        self.assertEqual(self.state(fixture)["rs"], "A")
        self.open_toolbar_group(page, "#b-unread")
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

    def test_12_stale_draft_addendum_rebase_keeps_both_versions(self):
        """E2E-B2-12 (REQ-S3-U3, contract test 21): a draft written against v1 cannot
        replace the v2 somebody else approved. The refusal carries that approved text,
        the pane shows those same bytes, an explicit rebase keeps every typed byte, and
        both addenda survive in the history."""
        fixture = self.fixture()
        self.seed_report(fixture, action="approve")                       # v1 by doctor
        # Seed the draft through the API: the row must exist with baseVersion 1 and a
        # draft-less addendum would legitimately meet the old optimistic lock instead.
        draft_text = f"{fixture.secret} addendum draft"
        put = self.stack.request("PUT", f"/studies/{fixture.uid}/report", "doctor", {
            "findings": draft_text, "conclusion": "", "recommendation": "", "baseVersion": 1,
        })
        self.assertEqual(put.status, 200)
        head_text = "SECOND READER LINE 1\nSECOND READER LINE 2"
        other = self.stack.request("POST", f"/studies/{fixture.uid}/report/commit", "doctor2", {
            "action": "addendum", "baseVersion": 1,
            "findings": head_text, "conclusion": "", "recommendation": "",
        })
        self.assertEqual(other.status, 201)
        self.assertEqual(other.body["version"], 2)

        page = self.login()
        self.select(page, fixture)
        expect(page.locator("#findings")).to_have_value(draft_text)
        self.open_toolbar_group(page, "#b-addendum")
        with page.expect_response(lambda r: r.request.method == "POST"
                                  and r.url.endswith(f"/studies/{fixture.uid}/report/commit")) as reply:
            page.locator("#b-addendum").click()
        self.assertEqual(reply.value.status, 409)
        body = reply.value.json()
        self.assertEqual(body["code"], "REPORT_DRAFT_STALE")
        self.assertEqual((body["draftBaseVersion"], body["head"]["version"]), (1, 2))
        self.assertEqual(body["head"]["findings"], head_text)
        # An old tab routes on this substring and then overwrites its editor.
        self.assertNotIn("저장했습니다", body["message"])
        expect(page.locator("#stalemodal")).to_be_visible()
        # The pane shows the server's own bytes, not the client's cached report.
        self.assertEqual(page.locator("#stale-head-findings").text_content(), body["head"]["findings"])
        expect(page.locator("#stale-head-title")).to_contain_text("v2")
        expect(page.locator("#stale-draft-findings")).to_have_text(draft_text)
        # Nothing was rewritten while the reader reads.
        expect(page.locator("#findings")).to_have_value(draft_text)
        self.assertEqual(self.state(fixture)["draft"]["baseVersion"], 1)
        self.assertEqual([row["version"] for row in self.versions(fixture)], [1, 2])

        with page.expect_response(lambda r: r.request.method == "PUT"
                                  and r.url.endswith(f"/studies/{fixture.uid}/report")) as rebase:
            page.locator("#stale-rebase").click()
        self.assertEqual(rebase.value.status, 200)
        sent = rebase.value.request.post_data_json
        self.assertEqual((sent["baseVersion"], sent["findings"]), (2, draft_text))
        expect(page.locator("#stalemodal")).to_be_hidden()
        expect(page.locator("#findings")).to_have_value(draft_text)
        self.wait_state(page, fixture, lambda s: (s.get("draft") or {}).get("baseVersion") == 2)
        audit = self.stack.request("GET", f"/audit?uid={fixture.uid}", "jmryu")
        self.assertEqual(audit.status, 200)
        rebases = [json.loads(row["detail"]) for row in audit.body if row["action"] == "report.draft.rebase"]
        self.assertEqual(rebases, [{"from": 1, "to": 2}])

        final_text = f"{draft_text} — written after reading v2"
        page.locator("#findings").fill(final_text)
        self.open_toolbar_group(page, "#b-addendum")
        self.commit(page, fixture, "#b-addendum", "A")
        rows = self.versions(fixture)
        self.assertEqual([row["action"] for row in rows], ["approve", "addendum", "addendum"])
        self.assertEqual([row["version"] for row in rows], [1, 2, 3])
        self.assertEqual(rows[1]["findings"], head_text)
        self.assertEqual(rows[2]["findings"], final_text)
        state = self.state(fixture)
        self.assertEqual(state["findings"], final_text)
        self.assertIsNone(state.get("draft"))

    # ── S9-U4b part (c): the transfer panel on the real stack (REQ-S9-U4-09/10; contract S9-U4p 4.4, 4.6, 5.3, 6) ──
    TRANSFER_KEY = "kin-study-transfer-local"
    SENT = "서버가 이 검사의 모든 원본을 보냈습니다. 내 컴퓨터에 저장됐는지는 브라우저의 다운로드 목록에서 확인하세요."

    def transfer_box(self, page, operation):
        return page.locator(f'#study-transfer section[data-operation="{operation}"]')

    def transfer_requests(self, page):
        """Every request of this page to the transfer routes, as (method, path): the panel's own traffic."""
        seen = []
        page.on("request", lambda request: seen.append((request.method, urlsplit(request.url).path))
                if re.search(r"/api/(dicom-import|admin/dicom-import|studies/[^/]+/original-downloads)", request.url) else None)
        return seen

    def download_operation(self, page, fixture, operations):
        """Download Originals from the row menu; the preparation's operation id, shown Ready."""
        page.locator(f'#rows tr[data-uid="{fixture.uid}"]').click(button="right")
        with page.expect_response(lambda r: r.request.method == "POST"
                                  and r.url.endswith(f"/studies/{fixture.uid}/original-downloads")) as prepared:
            page.locator("#ctx").get_by_text("Download Originals", exact=True).click()
        self.assertEqual(prepared.value.status, 200, prepared.value.text())
        operation = prepared.value.json()["operationId"]
        operations.append(operation)
        expect(self.transfer_box(page, operation).locator(".study-transfer-state")).to_have_text("Ready")
        return operation

    def download_row(self, operation):
        self.assertRegex(operation, r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        rows = psql(f"SELECT status || '|' || jsonb_array_length(download->'attempts') FROM \"ImportOperation\" WHERE id='{operation}';")
        self.assertEqual(len(rows), 1)
        return rows[0]

    def sign_in_again(self, page, actor):
        """Log Out in this tab, then the real login form again: a new session in the same tab (its sessionStorage stays).
        After a Log Out the landing keeps its end notice and never signs in by itself (index.html boot: an end record
        stops the automatic login), so the person presses its Login button; Keycloak then shows its form - with the
        username field, or, while its own SSO is still known, the attempted username and its restart-login link."""
        page.once("dialog", lambda dialog: dialog.accept())
        page.locator("#logout").click()
        page.wait_for_url("**/index.html**", timeout=30000)
        name = self.stack.username(actor)
        try:
            page.locator("#signin").click()
            page.locator("#password").wait_for(state="visible", timeout=30000)
            attempted = page.locator("#kc-attempted-username")
            if not page.locator("#username").is_visible() and attempted.count() and attempted.inner_text().strip() != name:
                with page.expect_navigation():
                    page.locator("#reset-login").click()
            if page.locator("#username").is_visible():
                page.locator("#username").fill(name)
            page.locator("#password").fill(self.stack.passwords[actor])
            page.locator("#kc-login").click()
        except Exception:
            # Playwright's call log can include fill() values; never print credentials.
            raise RuntimeError("Real BFF login form could not be submitted") from None
        page.wait_for_url("**/worklist/hpacs-lite/main.html", timeout=30000)
        expect(page.locator("#dbstat")).to_contain_text("DB Connected")

    def native_download(self, page, fixture, operation):
        """One Download press on the real stack (D1489): one bound grant POST answered 200, then the browser's own GET of the
        archive with that grant only - the doctor's BFF cookie is the only credential the browser adds, nothing injected.
        Returns the Playwright download and the grant value read from its URL. No assertion message prints the URL or the
        value (DG-T05: the raw grant appears in no CI output)."""
        with page.expect_download() as started:
            with page.expect_response(lambda r: r.request.method == "POST"
                                      and r.url.endswith(f"/original-downloads/{operation}/archive/grant")) as granted:
                self.transfer_box(page, operation).get_by_role("button", name="Download", exact=True).click()
        self.assertEqual(granted.value.status, 200, "the grant request")
        download = started.value
        url = urlsplit(download.url)
        self.assertEqual(url.path, f"/api/studies/{fixture.uid}/original-downloads/{operation}/archive", "nothing but the UID and the id")
        found = re.fullmatch(r"grant=([A-Za-z0-9_-]{43})", url.query)
        self.assertTrue(found, "the query is exactly one grant: no PHI, name, cookie, token or session id")
        self.assertFalse(fixture.patient_id in download.url, "no patient value in the archive URL")
        self.assertEqual(download.suggested_filename, f"KIN-originals-{operation[:8]}.zip", "the server's filename (an archive.json here is the refusal body)")
        self.assertIsNone(download.failure(), "the archive reached the browser's download list")
        return download, found.group(1)

    def archive_supplied(self, path, operation, number):
        """The saved file is the server's whole ZIP of the prepared manifest: the ZIP signature, every central-directory
        entry in manifest order and then manifest.json, each object's length and MD5 as prepared and its CRC-32, the final
        manifest's per-object SHA-256 equal to the saved bytes and to the attempt's recorded objects, the archive SHA-256
        the attempt's. Attempt <number> is Sent with the writer's own finish and was opened by a consumed grant."""
        with open(path, "rb") as saved:
            data = saved.read()
        self.assertEqual(data[:4], b"PK\x03\x04")
        [stored] = psql(f"SELECT download::text FROM \"ImportOperation\" WHERE id='{operation}';")
        download = json.loads(stored)
        manifest = json.loads(download["manifestCanonical"])["objects"]
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            self.assertIsNone(archive.testzip(), "every entry's CRC-32")
            self.assertEqual([info.filename for info in archive.infolist()], [o["path"] for o in manifest] + ["manifest.json"],
                             "the whole central directory in manifest order")
            final = json.loads(archive.read("manifest.json"))
            bodies = [archive.read(o["path"]) for o in manifest]
        self.assertEqual([(len(b), hashlib.md5(b).hexdigest()) for b in bodies], [(o["bytes"], o["md5"]) for o in manifest])
        sha = [hashlib.sha256(b).hexdigest() for b in bodies]
        self.assertEqual([(o["sopUid"], o["sha256"]) for o in final["objects"]], [(o["sopUid"], s) for o, s in zip(manifest, sha)])
        attempt = download["attempts"][number - 1]
        self.assertEqual((len(download["attempts"]), attempt["state"], attempt["responseFinished"]), (number, "sent", True))
        self.assertEqual(([o["sha256"] for o in attempt["objects"]], attempt["archiveSha256"]), (sha, hashlib.sha256(data).hexdigest()))
        self.assertEqual((download["schemaVersion"], download["activeArchiveGrant"]), (2, None), "format 2, the grant consumed")
        use = download["archiveGrantUses"][-1]
        self.assertEqual(use["attemptId"], attempt["attemptId"], "the grant opened this attempt")
        return stored, attempt, use

    def download_audit(self, operation):
        rows = psql(f"SELECT action || E'\\t' || detail FROM \"AuditLog\" WHERE detail::jsonb->>'operationId'='{operation}' ORDER BY id;")
        return [(action, json.loads(detail)) for action, detail in (line.split("\t", 1) for line in rows)]

    def test_s9_u4_download_states(self):
        """REQ-S9-U4-09 with the D1489 grant (REQ-S9-U4-DG-01..06): Download Originals in an authenticated member session
        with no terminal registration: Ready, one bound grant request and the browser's own download of the archive with
        that grant, then Sent with the note that saving is checked in the browser. The saved file is checked as a whole
        ZIP against the prepared manifest; the row and the audit link prepare, grant, intent and result; the raw grant is
        in no stored row, audit row, proxy or API log. A client that drops the stream leaves Incomplete; an attempt a
        stopped server left sending is Unconfirmed; both are downloaded again for the same operation with a new grant;
        Sent only by a new preparation; no Range/resume, no text saying the file was saved."""
        fixture = self.fixture()
        operations = []
        try:
            page = self.login("doctor")
            self.select(page, fixture)
            operation = self.download_operation(page, fixture, operations)
            box = self.transfer_box(page, operation)
            since = str(int(time.time()) - 5)
            download, grant = self.native_download(page, fixture, operation)
            stored, attempt, use = self.archive_supplied(download.path(), operation, 1)
            self.assertEqual(use["hash"], hashlib.sha256(("kin-original-download-grant-v1:" + grant).encode()).hexdigest(),
                             "the row keeps the domain-separated hash of this grant")
            audit = self.download_audit(operation)
            self.assertEqual([action for action, _ in audit], ["original.download.prepare", "original.download.grant",
                                                               "original.download.intent", "original.download.result"])
            issued, intent, result = audit[1][1], audit[2][1], audit[3][1]
            self.assertEqual((issued["phase"], issued["grantId"], issued["grantHash"]), ("issued", use["grantId"], use["hash"]))
            self.assertEqual((intent["attemptId"], intent["grantId"], intent["bindingMethod"], intent["destination"]),
                             (attempt["attemptId"], use["grantId"], "archive-grant", "browser-download"))
            self.assertEqual((result["attemptId"], result["state"]), (attempt["attemptId"], "sent"))
            self.assertEqual(len({detail["institutionId"] for _, detail in audit}), 1, "one record-time institution")
            self.assertFalse(grant in stored or any(grant in json.dumps(detail) for _, detail in audit), "the raw grant is stored nowhere")
            status = self.stack.request("GET", f"/studies/{fixture.uid}/original-downloads/{operation}", "doctor")
            self.assertEqual((status.body["state"], status.body["archiveRequest"]["state"], status.body["archiveRequest"]["attemptId"]),
                             ("sent", "consumed", attempt["attemptId"]))
            # SRU4-1: the same grant on the non-canonical spellings never reaches the API's general log path - the proxy
            # refuses each with 400 before any location and logs it in the archive format (no query).
            base = f"/api/studies/{fixture.uid}/original-downloads/{operation}"
            origin = "{0.scheme}://{0.netloc}".format(urlsplit(page.url))
            aliases = [f"/api/studies/{fixture.uid}/original-downloads/{operation.upper()}/archive", base + "/archive/",
                       "/API" + base[len("/api"):] + "/archive", base]
            for path in aliases:
                self.assertEqual(page.request.get(origin + path + "?grant=" + grant).status, 400, "a grant outside the archive path")
            # U4C-01: the proxy's privacy filter is broader than what the API admits. The API takes a grant only as the literal
            # whole query `grant=<43 base64url characters>` (lower-case key, no percent or case alias); the proxy treats any
            # spelling a receiver could decode to the key (another case, a percent-encoded letter) as a grant, refuses it
            # outside the archive path and logs it without the query, so a mistyped grant never lands in a log (U4C3-2).
            for path, key in ((base, "%67rant="), ("/api/health", "Gr%61nt=")):
                self.assertEqual(page.request.get(origin + path + "?" + key + grant).status, 400, "an encoded grant key outside the archive path")
            logs = subprocess.run(["docker", "compose", "logs", "--no-color", "--since", since, "proxy", "api"], cwd=ROOT,
                                  capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
            self.assertEqual(logs.returncode, 0, "the proxy and API logs could be read")
            self.assertFalse(grant in logs.stdout + logs.stderr, "the raw grant is in no proxy or API log line")
            self.assertIn(f'"GET /api/studies/{fixture.uid}/original-downloads/{operation}/archive" 200 ', logs.stdout,
                          "the archive GET is logged by the archive location's format (method, path, status)")
            for path in aliases + ["/api/health"]:
                self.assertIn(f'"GET {path}" 400 ', logs.stdout, "each refused spelling is logged by the archive format")
            expect(box.locator(".study-transfer-state")).to_have_text("Sent", timeout=30000)
            expect(box.locator(".study-transfer-reason")).to_have_text(self.SENT)
            for claim in ("저장했습니다", "저장되었습니다", "보관했습니다"):
                self.assertNotIn(claim, page.locator("#study-transfer").inner_text(), "no text says the file was saved")
            self.assertEqual(box.get_by_role("button", name="Download", exact=True).count(), 0, "Sent is not downloaded again")
            self.assertEqual(page.locator("#study-transfer").get_by_role("button", name=re.compile("Resume|Range")).count(), 0)
            self.assertEqual(self.download_row(operation), "sent|1")
            again = self.stack.bearer_request("GET", f"/studies/{fixture.uid}/original-downloads/{operation}/archive",
                                              self.stack.token("doctor"), headers={"Range": "bytes=10-"})
            self.assertEqual((again.status, (again.body or {}).get("code")), (409, "DOWNLOAD_ALREADY_SENT"), "no Range resume")
            with page.expect_response(lambda r: r.request.method == "POST" and r.url.endswith("/original-downloads")) as fresh:
                box.get_by_role("button", name="Prepare Again").click()
            operations.append(fresh.value.json()["operationId"])
            self.assertNotEqual(operations[-1], operation, "after Sent a new operation is prepared")

            # Incomplete (5.2 step 6): a client that takes the headers and drops the stream. Offered again, same operation.
            dropped = self.download_operation(page, fixture, operations)
            insecure = ssl.create_default_context()
            insecure.check_hostname, insecure.verify_mode = False, ssl.CERT_NONE
            request = Request(self.stack.api + f"/studies/{fixture.uid}/original-downloads/{dropped}/archive",
                              headers={"Authorization": "Bearer " + self.stack.token("doctor")})
            with urlopen(request, context=insecure, timeout=30) as stream:
                stream.read(64)
            deadline = time.monotonic() + 30
            while self.download_row(dropped) != "incomplete|1" and time.monotonic() < deadline:
                time.sleep(0.5)
            self.assertEqual(self.download_row(dropped), "incomplete|1")
            page.reload()
            expect(page.locator("#dbstat")).to_contain_text("DB Connected")
            expect(self.transfer_box(page, dropped).locator(".study-transfer-state")).to_have_text("Incomplete", timeout=30000)
            expect(self.transfer_box(page, dropped).get_by_role("button", name="Download", exact=True)).to_be_visible()
            # The same operation again, with a new grant: a second attempt, Sent.
            again, _ = self.native_download(page, fixture, dropped)
            self.archive_supplied(again.path(), dropped, 2)
            expect(self.transfer_box(page, dropped).locator(".study-transfer-state")).to_have_text("Sent", timeout=30000)
            self.assertEqual(self.download_row(dropped), "sent|2")

            # Unconfirmed (5.2 step 7): an attempt a stopped server left sending, its lease run out; the status read closes it.
            stopped = self.download_operation(page, fixture, operations)
            [row] = psql(f"SELECT download::text || '|' || \"manifestSha256\" FROM \"ImportOperation\" WHERE id='{stopped}';")
            stored, manifest = row.rsplit("|", 1)
            body = json.loads(stored)
            body["attempts"].append({"attemptId": str(uuid.uuid4()), "number": 1, "ownerSubject": self.stack.user_ids["doctor"],
                                     "actor": self.stack.actor("doctor"), "manifestSha256": manifest,
                                     "destination": "browser-download", "state": "sending",
                                     "startedAt": "2026-01-01T00:00:00.000Z", "endedAt": None, "ownerInstance": str(uuid.uuid4()),
                                     "leaseUntil": "2026-01-01T00:00:30.000Z", "objects": [], "archiveSha256": None,
                                     "responseFinished": False})
            psql(f"UPDATE \"ImportOperation\" SET download = '{json.dumps(body).replace(chr(39), chr(39) * 2)}'::jsonb, "
                 f"status = 'sending' WHERE id='{stopped}';")
            page.reload()
            expect(page.locator("#dbstat")).to_contain_text("DB Connected")
            expect(self.transfer_box(page, stopped).locator(".study-transfer-state")).to_have_text("Unconfirmed", timeout=30000)
            expect(self.transfer_box(page, stopped).get_by_role("button", name="Download", exact=True)).to_be_visible()
            again, _ = self.native_download(page, fixture, stopped)
            self.archive_supplied(again.path(), stopped, 2)
            expect(self.transfer_box(page, stopped).locator(".study-transfer-state")).to_have_text("Sent", timeout=30000)
            self.assertEqual(self.download_row(stopped), "sent|2")
        finally:
            # The download rows of this case; the fixture's own cleanup removes its study, originals and audit rows.
            ids = [op for op in operations if re.fullmatch(r"[0-9a-f-]{36}", op)]
            if ids:
                psql("DELETE FROM \"ImportOperation\" WHERE kind='download' AND id IN (" + ",".join(f"'{op}'" for op in ids) + ");")

    def test_s9_u4_import_retry_and_account_change(self):
        """REQ-S9-U4-10: a file left Retry Needed (another attempt holds its study) is resumed by the same person after a new
        login - fresh authorisation, the same operation, index and bytes - and stored once the holder is gone. A network
        error never logs out. Another person signing in in the same tab never reads, sees or resumes that operation."""
        study = s9u4_uid()
        studies, operations = [study], []
        patient = "S9U4C-" + study[-6:]
        first = s9u4_dicom(study=study, series=study + ".1", sop=s9u4_uid(), patient_id=patient)
        data = s9u4_dicom(study=study, series=study + ".1", sop=s9u4_uid(), patient_id=patient)
        upload = ROOT / "tmp" / ("s9u4c-" + study[-8:] + ".dcm")
        lost_file = ROOT / "tmp" / ("s9u4c-lost-" + study[-8:] + ".dcm")
        upload.parent.mkdir(parents=True, exist_ok=True)
        upload.write_bytes(data)
        try:
            # Another file of the study, stored through the route; its attempt is then made a live dispatching one that
            # holds the study, as a running worker would (the live suite's s9u4_set_attempt / s9u4_hold form, DB only).
            held_op = str(uuid.uuid4())
            operations.append(held_op)
            stored = self.stack.bearer_request("POST", "/dicom-import", self.stack.token("tech"), first, headers={
                "Content-Type": "application/dicom", "X-KIN-Operation-Id": held_op, "X-KIN-File-Index": "0"})
            self.assertEqual(stored.status, 200, stored.text)
            [results] = psql(f"SELECT results::text FROM \"ImportOperation\" WHERE id='{held_op}';")
            original = json.loads(results)
            entry = json.loads(results)[0]
            entry["attempts"][-1].update(phase="dispatching", leaseUntil="2099-01-01T00:00:00.000Z", finishedAt=None,
                                         transport=None, outcome="unconfirmed", code="IMPORT_UNCONFIRMED")
            entry["outcome"], entry["code"] = "unconfirmed", "IMPORT_UNCONFIRMED"
            quote = lambda value: json.dumps(value).replace(chr(39), chr(39) * 2)
            psql(f"UPDATE \"ImportOperation\" SET results = '{quote([entry])}'::jsonb, status = 'open' WHERE id='{held_op}';")
            keys = (f"study:{study}", f"sop:{entry['sopUid']}")
            psql("UPDATE \"ImportOperation\" SET claim = jsonb_set(claim, '{heldByAttemptId}', "
                 f"'\"{entry['attempts'][-1]['attemptId']}\"') WHERE \"claimKey\" IN ('{keys[0]}', '{keys[1]}');")
            page = self.login("tech")
            seen = self.transfer_requests(page)
            page.locator("[data-tab=Technician]").click()
            with page.expect_file_chooser() as chooser:
                page.locator("#t-import").click()
            chooser.value.set_files(str(upload))
            row = page.locator('#study-transfer li[data-index="0"]')
            expect(row.locator(".study-transfer-state")).to_have_text("Retry Needed", timeout=30000)
            posts = [path for method, path in seen if method == "POST"]
            self.assertEqual(posts, ["/api/dicom-import"])
            operation = page.locator("#study-transfer section[data-operation]").first.get_attribute("data-operation")
            operations.append(operation)
            # D1566: a lost answer of a RETRY of this pre-attempt refusal cannot be resolved by the server's row (it stays
            # generation 0, which cannot speak for the later request), so it would leave the file undecided for good; the
            # resume below needs the settled Retry Needed. The lost-answer cases are the replaced-answer oracle further down
            # (a 502 after the server stored the file: never Not Sent, the session kept) and the DOM suite's
            # test_r4_a03_a_lost_retry_of_a_pre_attempt_retryable_stays_undecided.
            self.assertEqual(document_request(page, "GET", self.stack.api + "/me").status, 200, "the session is live")
            # The same person signs in again in this tab: the operation is read with the new session and resumed.
            self.sign_in_again(page, "tech")
            expect(page.locator("#study-transfer section[data-operation]")).to_have_count(1, timeout=30000)
            row = page.locator('#study-transfer li[data-index="0"]')
            expect(row.locator(".study-transfer-state")).to_have_text("Retry Needed")
            # The other worker finishes: its stored result and the free claims come back exactly as they were.
            psql(f"UPDATE \"ImportOperation\" SET results = '{quote(original)}'::jsonb, status = 'settled' WHERE id='{held_op}';")
            psql("UPDATE \"ImportOperation\" SET claim = jsonb_set(claim, '{heldByAttemptId}', 'null') "
                 f"WHERE \"claimKey\" IN ('{keys[0]}', '{keys[1]}');")
            with page.expect_file_chooser() as chooser:
                page.locator("#study-transfer").get_by_role("button", name="Choose Files Again").click()
            chooser.value.set_files(str(upload))
            expect(row.locator(".study-transfer-state")).to_have_text("Stored", timeout=60000)
            [results] = psql(f"SELECT results::text FROM \"ImportOperation\" WHERE id='{operation}';")
            [entry] = json.loads(results)
            self.assertEqual((entry["index"], entry["outcome"], entry["sha256"]), (0, "stored", hashlib.sha256(data).hexdigest()),
                             "the same operation, index and bytes were resumed")
            # D1566 (R4-A01/A02, live): another file reaches the API and is stored, but the answer the browser gets is a
            # proxy's 502 page. The panel never says Not Sent and never offers Retry; its status read shows Stored; the
            # server holds one result and one original for it; the same person's new login keeps it Stored, nothing resent.
            lost = s9u4_dicom(study=study, series=study + ".1", sop=s9u4_uid(), patient_id=patient)
            lost_file.write_bytes(lost)
            posted = []
            def replaced(route):
                posted.append(route.request.headers.get("x-kin-operation-id"))
                route.fetch()
                route.fulfill(status=502, content_type="text/html", body="<html><body>502 Bad Gateway</body></html>")
            page.evaluate("""() => { const seen = window.__s9u4States = [];
              new MutationObserver(() => { for (const n of document.querySelectorAll('#study-transfer .study-transfer-state')) seen.push(n.textContent); })
                .observe(document.body, { subtree: true, childList: true, characterData: true }); }""")
            page.route("**/api/dicom-import", replaced)
            try:
                with page.expect_file_chooser() as chooser:
                    page.locator("#t-import").click()
                chooser.value.set_files(str(lost_file))
                newest = page.locator("#study-transfer section[data-operation]").first
                expect(newest.locator('li[data-index="0"] .study-transfer-state')).to_have_text("Stored", timeout=60000)
            finally:
                page.unroute("**/api/dicom-import")
            lost_op = newest.get_attribute("data-operation")
            operations.append(lost_op)
            self.assertEqual(posted, [lost_op], "one POST of the lost file")
            self.assertNotIn("Not Sent", page.evaluate("window.__s9u4States"), "never Not Sent after a replaced answer")
            self.assertEqual(newest.get_by_role("button", name="Retry", exact=True).count(), 0, "no Retry after a replaced answer")
            self.assertEqual(document_request(page, "GET", self.stack.api + "/me").status, 200, "a lost or replaced answer never logs out")
            [results] = psql(f"SELECT results::text FROM \"ImportOperation\" WHERE id='{lost_op}';")
            [kept] = json.loads(results)
            self.assertEqual((kept["outcome"], kept["sha256"]), ("stored", hashlib.sha256(lost).hexdigest()), "one stored result, the bytes as sent")
            self.sign_in_again(page, "tech")
            again = page.locator(f'#study-transfer section[data-operation="{lost_op}"]')
            expect(again.locator('li[data-index="0"] .study-transfer-state')).to_have_text("Stored", timeout=30000)
            self.assertEqual(again.get_by_role("button", name="Choose Files Again", exact=True).count(), 0)
            # Another person in the same tab: the kept record is dropped and the operation is never read or shown.
            self.sign_in_again(page, "jmryu")
            before = len(seen)
            page.wait_for_timeout(5000)
            self.assertEqual([r for r in seen[before:] if operation in r[1]], [], "another person never queries the operation")
            self.assertEqual(page.locator("#study-transfer section[data-operation]").count(), 0)
            self.assertIsNone(page.evaluate(f"sessionStorage.getItem('{self.TRANSFER_KEY}')"))
        finally:
            upload.unlink(missing_ok=True)
            lost_file.unlink(missing_ok=True)
            deleted = []
            failures = s9u4_cleanup(self.stack._orthanc_request, psql, studies, operations, deleted)
            if failures:
                raise RuntimeError("S9-U4 (c) cleanup failed; rows kept for inspection: " + "; ".join(failures))


if __name__ == "__main__":
    unittest.main(verbosity=2)
