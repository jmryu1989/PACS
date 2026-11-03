"""CD-09-P acceptance 4 on the real HTTPS entry: the screen around a private draft whose purpose ended.

REQ: consult-cd09-split-report.md section 5 acceptance 4 -> RISK: an ended draft comes back on the screen and is
written again without its author choosing it, a late answer of one study is drawn into another, a late dictation result
re-creates an ended draft, another author's draft is shown -> TEST: this file.

Real main document, BFF session, Keycloak, PostgreSQL and the P destruction; the browser is Chromium. Interception only
delays a real answer (A->B->A) or answers the dictation request in place of an ASR engine the synthetic stack does not
run (the transcript body the real endpoint returns, with the stack's own pins); it never fakes a draft or a save. The
server truth is read back through the API and the database after each step. Screenshots go to KIN_SCREEN_EVIDENCE.
Menus and states are English and explanations Korean (AGENTS.md 4): the visible labels and messages are asserted.
"""
import json
import os
from pathlib import Path
import sys
import time
import unittest
import uuid
from urllib.parse import quote, urlsplit

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "live"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_worklist as worklist
from session_support import Session, setup_stack
from invariants_live import psql

EVIDENCE = Path(os.environ.get("KIN_SCREEN_EVIDENCE", "tmp/cd-09p/screens"))
CAPABILITY_KEYS = {"available", "maxBytes", "timeoutMs", "languagePin", "enginePin", "modelPin"}


def sql_text(value):
    return "'" + str(value).replace("'", "''") + "'"


class DraftPurposeScreen(worklist.WorklistE2E):
    @classmethod
    def setUpClass(cls):
        setup_stack(cls)
        worklist.require_local_targets(cls.stack)
        cls.pw = sync_playwright().start()
        cls.addClassCleanup(cls.pw.stop)
        cls.browser = cls.pw.chromium.launch(args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])
        cls.addClassCleanup(cls.browser.close)
        EVIDENCE.mkdir(parents=True, exist_ok=True)

    def profile(self, actor="doctor"):
        session = Session(self.stack).login(self, actor)
        context = self.browser.new_context(ignore_https_errors=True, viewport={"width": 1600, "height": 1050})
        self.contexts.append(context)
        context.add_cookies([{"name": "kin_sid", "value": session.sid(), "url": self.stack.proxy,
                              "httpOnly": True, "secure": True, "sameSite": "Strict"}])
        return context

    def open_main(self, context):
        page = context.new_page()
        page.set_default_timeout(20000)
        page.on("dialog", lambda d: d.accept())
        page.goto(self.stack.proxy + "/worklist/hpacs-lite/main.html")
        expect(page.locator("#dbstat")).to_contain_text("DB Connected")
        return page

    def shot(self, page, name):
        path = EVIDENCE / (name + ".png")
        page.screenshot(path=str(path), full_page=False)
        print("CD09P-SCREEN " + json.dumps({"screenshot": str(path)}), flush=True)

    def type_and_save(self, page, fixture, text):
        with page.expect_response(lambda r: r.request.method == "PUT" and r.url.endswith(f"/{fixture.uid}/report"),
                                  timeout=35000) as saved:
            page.locator("#findings").fill(text)
        self.assertEqual(saved.value.status, 200, saved.value.text())
        return saved.value.json()

    def server_draft(self, fixture, actor="doctor"):
        result = self.stack.request("GET", f"/studies/{quote(fixture.uid)}/draft", actor)
        self.assertEqual(result.status, 200, result.text)
        return result.body

    def work_unit(self, fixture, actor="doctor"):
        rows = psql(f'SELECT coalesce("workUnit", \'\') FROM "ReportDraft" WHERE uid={sql_text(fixture.uid)} '
                    f'AND author={sql_text(self.stack.actor(actor))}')
        return rows[0] if rows else ""

    def wait_no_ended_rows(self, fixture, timeout=60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if psql(f'SELECT count(*) FROM "ReportDraftPurposeEnd" WHERE uid={sql_text(fixture.uid)}') == ["0"]:
                return
            time.sleep(0.5)
        self.fail("the ended work was not destroyed")

    def test_s1_end_then_reopen_shows_nothing_other_author_never_sees_it_and_a_new_work_is_explicit(self):
        fixture = self.fixture()
        secret = "SYN-S1 private " + uuid.uuid4().hex
        doctor = self.open_main(self.profile("doctor"))
        self.select(doctor, fixture)
        self.type_and_save(doctor, fixture, secret)
        unit = self.work_unit(fixture)
        self.assertTrue(unit.startswith("disposal:"))
        # Another author on the same study: the draft is not on their screen nor in their answers.
        colleague = self.open_main(self.profile("doctor2"))
        self.select(colleague, fixture)
        expect(colleague.locator("#findings")).not_to_have_value(secret)
        self.assertFalse(self.server_draft(fixture, "doctor2")["present"])
        self.assertNotIn(secret, colleague.content())
        self.shot(colleague, "s1-other-author-does-not-see")
        # The author's own Discard (English button, Korean explanation in its title).
        button = doctor.locator("#b-draft-discard")
        expect(button).to_have_text("Discard Draft")
        self.assertRegex(button.get_attribute("title") or "", "[가-힣]")
        with doctor.expect_response(lambda r: r.request.method == "DELETE" and r.url.endswith(f"/{fixture.uid}/draft")) as gone:
            button.click()
        self.assertEqual(gone.value.status, 200, gone.value.text())
        expect(doctor.locator("#findings")).not_to_have_value(secret)
        self.wait_no_ended_rows(fixture)
        self.assertEqual(self.server_draft(fixture)["present"], False)
        # Reopen after the end (a full reload): nothing of the ended work comes back.
        doctor.reload()
        expect(doctor.locator("#dbstat")).to_contain_text("DB Connected")
        self.select(doctor, fixture)
        expect(doctor.locator("#findings")).not_to_have_value(secret)
        self.assertNotIn(secret, doctor.content())
        self.shot(doctor, "s1-reopened-after-end")
        # A new work is the author's explicit act (typing), with its own unit.
        self.type_and_save(doctor, fixture, "SYN-S1 new work")
        fresh = self.work_unit(fixture)
        self.assertTrue(fresh.startswith("disposal:") and fresh != unit, (fresh, unit))
        self.shot(doctor, "s1-new-work-started")

    def test_s2_a_write_of_the_ended_revision_from_another_tab_is_refused_and_needs_an_explicit_choice(self):
        fixture = self.fixture()
        secret = "SYN-S2 " + uuid.uuid4().hex
        context = self.profile("doctor")
        first, second = self.open_main(context), self.open_main(context)
        self.select(first, fixture)
        self.type_and_save(first, fixture, secret)
        self.select(second, fixture)
        expect(second.locator("#findings")).to_have_value(secret)
        with second.expect_response(lambda r: r.request.method == "DELETE" and r.url.endswith(f"/{fixture.uid}/draft")) as gone:
            second.locator("#b-draft-discard").click()
        self.assertEqual(gone.value.status, 200)
        self.wait_no_ended_rows(fixture)
        # The first tab still holds the ended text and writes with the revision it last saw: refused, never re-created.
        statuses = []
        first.on("response", lambda r: statuses.append(r.status) if r.request.method == "PUT" and r.url.endswith(f"/{fixture.uid}/report") else None)
        first.locator("#findings").fill(secret + " typed later")
        bar = first.locator("#draftmsg")
        expect(bar).to_contain_text("서버의 초안이 이 화면과 다릅니다", timeout=35000)
        expect(first.locator("#b-draft-keep")).to_have_text("Keep This Text")
        expect(first.locator("#b-draft-load")).to_have_text("Load Server Draft")
        self.assertIn(409, statuses)
        first.wait_for_timeout(5000)
        self.assertEqual(self.server_draft(fixture)["present"], False, "the ended draft was written back without a choice")
        self.assertNotIn(200, statuses)
        self.shot(first, "s2-stale-revision-conflict")
        # The author chooses the server's state: the screen shows no draft.
        expect(first.locator("#b-draft-load")).to_be_enabled()
        first.locator("#b-draft-load").click()
        expect(first.locator("#findings")).not_to_have_value(secret + " typed later")
        first.wait_for_timeout(3000)
        self.assertEqual(self.server_draft(fixture)["present"], False)
        self.shot(first, "s2-loaded-server-state")

    def test_s3_a_late_answer_of_study_a_is_not_drawn_into_b_and_does_not_bring_the_ended_draft_back(self):
        a, b = self.fixture(), self.fixture()
        secret_a, text_b = "SYN-S3-A " + uuid.uuid4().hex, "SYN-S3-B " + uuid.uuid4().hex
        for fixture, text in ((a, secret_a), (b, text_b)):
            saved = self.stack.request("PUT", f"/studies/{quote(fixture.uid)}/report", "doctor",
                                       {"findings": text, "conclusion": "", "recommendation": "", "baseVersion": 0})
            self.assertEqual(saved.status, 200, saved.text)
        context = self.profile("doctor")
        page = self.open_main(context)
        held, writes = [], []
        prefix = f"/api/studies/{a.uid}/"

        def hold(route):
            held.append(route)

        def of_a(url):
            return urlsplit(url).path.startswith(prefix) and "/report/" in urlsplit(url).path
        page.route(of_a, hold)
        page.on("response", lambda r: writes.append((r.status, r.url)) if r.request.method in ("PUT", "DELETE")
                and f"/{a.uid}/" in r.url else None)
        self.select(page, a)
        deadline = time.monotonic() + 20
        while not held and time.monotonic() < deadline:
            page.wait_for_timeout(100)
        self.assertTrue(held, "no answer of study A was in flight")
        self.select(page, b)
        expect(page.locator("#findings")).to_have_value(text_b)
        # A's work ends elsewhere (the author's other session) while A's answers are still in flight.
        ended = self.stack.request("DELETE", f"/studies/{quote(a.uid)}/draft", "doctor", {})
        self.assertEqual(ended.status, 200, ended.text)
        self.wait_no_ended_rows(a)
        page.unroute(of_a)
        for route in held:
            route.continue_()
        page.wait_for_timeout(2000)
        expect(page.locator("#findings")).to_have_value(text_b)
        self.assertNotIn(secret_a, page.locator("#findings").input_value())
        self.shot(page, "s3-late-answer-not-in-b")
        # Back to A: whatever the screen shows, nothing writes the ended work back without the author's choice.
        self.select(page, a)
        page.wait_for_timeout(8000)
        self.assertEqual(self.server_draft(a)["present"], False)
        self.assertFalse([w for w in writes if w[0] == 200], writes)
        self.shot(page, "s3-back-to-a")

    def test_s4_a_dictation_result_arriving_after_the_end_is_only_reviewed_never_written(self):
        fixture = self.fixture()
        secret = "SYN-S4 " + uuid.uuid4().hex
        context = self.profile("doctor")
        context.grant_permissions(["microphone"], origin=self.stack.proxy)
        capability = {}

        def replace_bootstrap(route):
            real = route.fetch()
            body = json.loads(real.body().decode("utf-8")) if real.status == 200 else None
            cap = body.get("dictation") if isinstance(body, dict) else None
            if not isinstance(cap, dict) or set(cap) != CAPABILITY_KEYS:
                route.fulfill(response=real)
                return
            capability.update(cap)
            body["dictation"] = dict(cap, available=True)
            route.fulfill(response=real, json=body)
        context.route(lambda url: urlsplit(url).path == "/api/bootstrap", replace_bootstrap)
        page = self.open_main(context)
        self.select(page, fixture)
        self.type_and_save(page, fixture, secret)
        self.assertTrue(capability, "the stack's dictation capability was not read")
        held = []
        dictation_path = f"/api/studies/{fixture.uid}/dictation"
        page.route(lambda url: urlsplit(url).path == dictation_path, lambda route: held.append(route))
        expect(page.locator("#b-dictate")).to_be_enabled()
        page.locator("#b-dictate").click()
        page.wait_for_timeout(2500)
        page.locator("#dictation-stop").click()
        deadline = time.monotonic() + 20
        while not held and time.monotonic() < deadline:
            page.wait_for_timeout(100)
        self.assertTrue(held, "the dictation request was not sent")
        # The author ends the work (another session) while the transcript is on its way.
        ended = self.stack.request("DELETE", f"/studies/{quote(fixture.uid)}/draft", "doctor", {})
        self.assertEqual(ended.status, 200, ended.text)
        self.wait_no_ended_rows(fixture)
        transcript = "SYN-S4 late transcript " + uuid.uuid4().hex
        held[0].fulfill(status=200, content_type="application/json", body=json.dumps({
            "text": transcript, "seconds": 1.0, "languagePin": capability.get("languagePin"),
            "enginePin": capability.get("enginePin"), "modelPin": capability.get("modelPin")}))
        page.wait_for_timeout(3000)
        # The late result is a review the author may insert; it is not in the report and nothing was saved.
        self.assertNotIn(transcript, page.locator("#findings").input_value())
        self.assertEqual(self.server_draft(fixture)["present"], False)
        expect(page.locator("#dictation-insert")).to_have_text("Insert")
        self.shot(page, "s4-late-dictation-in-review")
        # Inserting is the author's explicit act; on this screen it meets the ended work's moved boundary and stops
        # for a choice - the ended draft is not written back by it.
        page.locator("#dictation-insert").click()
        page.wait_for_timeout(8000)
        server = self.server_draft(fixture)
        self.assertFalse(server["present"] and secret in json.dumps(server), "the ended text was written back by a late Insert")
        self.shot(page, "s4-after-explicit-insert")


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromTestCase(DraftPurposeScreen)


if __name__ == "__main__":
    unittest.main()
