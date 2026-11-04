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
        first = self.open_main(context)
        self.select(first, fixture)
        self.type_and_save(first, fixture, secret)
        # The second tab opens after the save, so its list carries the saved draft (as a tab opened later does).
        second = self.open_main(context)
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
        # Deliver the held answers first, then stop intercepting (unroute would hand the held routes on by itself).
        for route in held:
            route.continue_()
        page.unroute(of_a)
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


class DraftPurposeScreenR3(DraftPurposeScreen):
    """CD-09-P r3 on the real HTTPS entry (consult-cd09p-r3-precheck-report.md C9-C11; review attachment 3).

    Interception only keeps or loses a real answer: `route.fetch()` sends the request to the server and the case then
    either delivers that real answer later or drops it (abort), so the server has acted and only the page did not hear.
    Each case checks that the branch happened (the request reached the server, the page saw the loss, the state it
    shows) before it asserts the product's outcome.
    """

    def click_row(self, page, fixture):
        """The person's click on a study row, without requiring that the page moved (the leave gate may keep it)."""
        page.locator('#filterrow [data-f="id"]').fill(fixture.patient_id)
        row = page.locator(f'#rows tr[data-uid="{fixture.uid}"]')
        expect(row).to_be_visible()
        row.click()

    def requests_of(self, page, fixture):
        seen = []
        page.on("request", lambda r: seen.append((time.monotonic(), r.method, urlsplit(r.url).path, r.post_data or ""))
                if f"/{fixture.uid}/" in r.url and r.method in ("GET", "PUT", "DELETE") else None)
        return seen

    def test_c10a_a_write_with_only_a_replaced_epoch_is_refused_and_writes_nothing_without_a_choice(self):
        fixture = self.fixture()
        secret = "SYN-C10a " + uuid.uuid4().hex
        page = self.open_main(self.profile("doctor"))
        self.select(page, fixture)
        self.type_and_save(page, fixture, secret)
        with page.expect_response(lambda r: r.request.method == "DELETE" and r.url.endswith(f"/{fixture.uid}/draft")) as gone:
            page.locator("#b-draft-discard").click()
        self.assertEqual(gone.value.status, 200, gone.value.text())
        self.wait_no_ended_rows(fixture)
        old_epoch, revision = self.server_draft(fixture)["revision"].split(":")
        versions = psql(f'SELECT count(*) FROM "ReportVersion" WHERE uid={sql_text(fixture.uid)}')
        # The administrator's forced release with no draft to keep: only the epoch changes.
        forced = self.stack.request("DELETE", f"/studies/{quote(fixture.uid)}/draft/force", "jmryu", {})
        self.assertEqual((forced.status, forced.body.get("count")), (200, 0), forced.text)
        new_epoch, new_revision = self.server_draft(fixture)["revision"].split(":")
        self.assertNotEqual(new_epoch, old_epoch)
        self.assertEqual(new_revision, revision, "the revision did not move: only the epoch is stale")
        puts = []
        page.on("response", lambda r: puts.append((r.status, (r.request.post_data_json or {}).get("expectedRevision")))
                if r.request.method == "PUT" and r.url.endswith(f"/{fixture.uid}/report") else None)
        typed = "SYN-C10a new " + uuid.uuid4().hex
        page.locator("#findings").fill(typed)
        expect(page.locator("#draftmsg")).to_contain_text("서버의 초안이 이 화면과 다릅니다", timeout=35000)
        expect(page.locator("#b-draft-keep")).to_have_text("Keep This Text")
        expect(page.locator("#b-draft-load")).to_have_text("Load Server Draft")
        self.assertIn((409, f"{old_epoch}:{revision}"), puts, puts)
        self.assertFalse([p for p in puts if p[0] == 200], puts)
        page.wait_for_timeout(3000)
        server = self.server_draft(fixture)
        self.assertEqual((server["present"], server["snapshot"]), (False, None))
        self.assertEqual(psql(f'SELECT count(*) FROM "ReportVersion" WHERE uid={sql_text(fixture.uid)}'), versions)
        self.shot(page, "c10a-epoch-conflict")
        # The explicit choice: load the server's state, then a new work under the new epoch.
        page.locator("#b-draft-load").click()
        expect(page.locator("#findings")).not_to_have_value(typed)
        self.type_and_save(page, fixture, "SYN-C10a after load")
        self.assertTrue(any(p[0] == 200 and str(p[1]).startswith(new_epoch + ":") for p in puts), puts)
        self.assertTrue(self.work_unit(fixture).startswith("disposal:"))
        self.shot(page, "c10a-new-work-after-load")

    def test_c11_an_end_the_server_cannot_confirm_is_re_read_and_explained_in_korean(self):
        import test_draft_purpose as served
        fixture = self.fixture()
        secret = "SYN-C11 " + uuid.uuid4().hex
        page = self.open_main(self.profile("doctor"))
        self.select(page, fixture)
        self.type_and_save(page, fixture, secret)
        unit = self.work_unit(fixture)
        seen = self.requests_of(page, fixture)
        observer, holder = served.Session("O"), served.Session("K")
        lock = None
        self.addCleanup(observer.close)
        self.addCleanup(holder.close)
        key = 0x4b0000 + int(uuid.uuid4().hex[:4], 16)
        holder.query(f"BEGIN; SELECT pg_advisory_xact_lock({key})")
        psql("CREATE OR REPLACE FUNCTION public.cd09p_t1() RETURNS trigger LANGUAGE plpgsql AS "
             f"$$BEGIN IF NEW.\"disposalUnitId\" = {sql_text(unit)} THEN PERFORM pg_advisory_xact_lock({key}); END IF; RETURN NULL; END$$")
        psql('CREATE CONSTRAINT TRIGGER cd09p_t1 AFTER INSERT ON "ReportDraftPurposeEnd" DEFERRABLE INITIALLY DEFERRED '
             "FOR EACH ROW EXECUTE FUNCTION public.cd09p_t1()")
        self.addCleanup(lambda: psql('DROP TRIGGER IF EXISTS cd09p_t1 ON "ReportDraftPurposeEnd"'))

        def poll(sql, what, timeout=30):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                rows = [r for r in observer.query(sql) if r]
                if rows:
                    return rows
                time.sleep(0.05)
            self.fail("not observed: " + what)
        with page.expect_response(lambda r: r.request.method == "DELETE" and r.url.endswith(f"/{fixture.uid}/draft"),
                                  timeout=90000) as gone:
            page.locator("#b-draft-discard").click()
            p_c = int(poll("SELECT pid FROM pg_stat_activity WHERE query = 'COMMIT' AND wait_event_type = 'Lock' "
                           f"AND {holder.pid} = ANY(pg_blocking_pids(pid))", "the end's COMMIT waiting on K")[0])
            lock = served.Session("L")
            self.addCleanup(lock.close)
            lock.query("BEGIN; SET LOCAL lock_timeout = '120s'")
            lock.start(f'SELECT 1 FROM "StudyState" WHERE uid = {sql_text(fixture.uid)} FOR UPDATE')
            poll(f"SELECT pid FROM pg_stat_activity WHERE pid = {lock.pid} AND {p_c} = ANY(pg_blocking_pids(pid))", "L behind P_C")
            holder.query("COMMIT")
            lock.answered(30)
            p_r = int(poll(f"SELECT pid FROM pg_stat_activity WHERE pid NOT IN ({holder.pid}, {lock.pid}, {observer.pid}) "
                           f"AND {lock.pid} = ANY(pg_blocking_pids(pid))", "the confirmation read waiting on L")[0])
        answered_at = time.monotonic()
        self.assertEqual(gone.value.status, 503, gone.value.text())
        self.assertEqual(gone.value.json().get("code"), "REPORT_DRAFT_END_UNCONFIRMED")
        self.assertNotEqual(p_r, p_c)
        # The page treats it as an unknown result: it re-reads the server's draft after that answer.
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and not [s for s in seen if s[0] > answered_at and s[1] == "GET" and s[2].endswith("/draft")]:
            page.wait_for_timeout(200)
        self.assertTrue([s for s in seen if s[0] > answered_at and s[1] == "GET" and s[2].endswith("/draft")], seen[-5:])
        expect(page.locator("#toast")).to_contain_text("버렸습니다", timeout=20000)
        self.assertRegex(page.locator("#toast").inner_text(), "[가-힣]")
        expect(page.locator("#findings")).not_to_have_value(secret)
        expect(page.locator("#b-draft-discard")).to_have_text("Discard Draft")
        self.shot(page, "c11-unconfirmed-end-re-read")
        lock.query("COMMIT")
        self.wait_no_ended_rows(fixture)
        self.assertEqual(self.server_draft(fixture)["present"], False)
        print("CD09P-SCREEN " + json.dumps({"c11": {"p_c": p_c, "p_r": p_r, "answer": 503}}), flush=True)

    def test_c9_an_old_answer_of_a_kept_before_its_end_is_delivered_after_a_new_a_and_changes_nothing(self):
        a, b = self.fixture(), self.fixture()
        secret, text_b = "SYN-C9-A " + uuid.uuid4().hex, "SYN-C9-B " + uuid.uuid4().hex
        saved = self.stack.request("PUT", f"/studies/{quote(b.uid)}/report", "doctor",
                                   {"findings": text_b, "conclusion": "", "recommendation": "", "baseVersion": 0})
        self.assertEqual(saved.status, 200, saved.text)
        page = self.open_main(self.profile("doctor"))
        self.select(page, a)
        self.type_and_save(page, a, secret)
        original = self.work_unit(a)
        finished, failed = [], []
        page.on("requestfinished", lambda r: finished.append(r))
        page.on("requestfailed", lambda r: failed.append(r))
        draft_path, report_path = f"/api/studies/{a.uid}/draft", f"/api/studies/{a.uid}/report"
        state = {"phase": "leave"}
        kept, log, puts, early, learned = [], [], [], [], []

        def control(route):
            request = route.request
            path, method, phase = urlsplit(request.url).path, request.method, state["phase"]
            log.append((phase, method, path))
            if method == "PUT":
                puts.append((phase, request.post_data or ""))
            if phase == "leave" and (method == "PUT" and path == report_path or method == "GET" and path == draft_path):
                route.fetch(); route.abort(); return               # the server acted; the page never hears
            if phase == "check" and method == "GET" and path == draft_path:
                kept.append((route, route.fetch())); return         # the old A answer, kept
            if phase == "discard" and method == "DELETE" and path == draft_path:
                state["phase"] = "lost-discard"
                route.fetch(); route.abort(); return
            if phase == "lost-discard" and method == "GET" and path == draft_path:
                route.fetch(); route.abort(); return
            if phase == "away" and method == "GET" and path == draft_path:
                early.append(request)
                route.abort(); return                                # an early learn read is ended, not applied
            if phase == "learn" and method == "GET" and path == draft_path:
                response = route.fetch()                             # the new read of A: its real answer, passed on
                try:
                    body = json.loads(response.body().decode("utf-8"))
                except ValueError:
                    body = None
                learned.append((request, response.status, body))
                route.fulfill(response=response); return
            route.continue_()
        page.route(lambda url: urlsplit(url).path in (draft_path, report_path), control)
        # ① saved ② one more line, then B: the leave gate's save of A reaches the server, its answer and checks are lost.
        page.locator("#findings").fill(secret + "\nSYN-C9 more")
        self.click_row(page, b)
        expect(page.locator("#report-notice-check")).to_be_visible(timeout=30000)
        expect(page.locator("#report-notice-msg")).to_contain_text("Result Unknown")
        self.assertTrue([e for e in log if e[0] == "leave" and e[1] == "PUT"], log)
        # ③ Check: its read of A is sent and its real answer kept.
        state["phase"] = "check"
        page.locator("#report-notice-check").click()
        deadline = time.monotonic() + 20
        while not kept and time.monotonic() < deadline:
            page.wait_for_timeout(100)
        self.assertTrue(kept, "the Check read of A was not sent")
        old = kept[0][1]
        old_body = json.loads(old.body().decode("utf-8"))
        self.assertEqual((old.status, old_body.get("uid")), (200, a.uid))
        self.assertIn(secret, json.dumps(old_body))
        # ④ Discard Draft on A: its settle read passes, the DELETE reaches the server and its answer is lost.
        state["phase"] = "discard"
        expect(page.locator("#b-draft-discard")).to_be_enabled(timeout=10000)
        page.locator("#b-draft-discard").click()
        deadline = time.monotonic() + 30
        while state["phase"] != "lost-discard" and time.monotonic() < deadline:
            page.wait_for_timeout(100)
        self.assertEqual(state["phase"], "lost-discard", "the DELETE was not sent")
        page.wait_for_timeout(5000)
        # ⑤ the server ended and destroyed A's work.
        self.wait_no_ended_rows(a)
        ended = self.server_draft(a)
        self.assertEqual(ended["present"], False)
        # ⑥ B, then A again; only after A is selected again may the new read of A pass. A read of A sent while B is shown
        # is aborted, and its end is the page's own requestfailed for that request.
        state["phase"] = "away"
        self.click_row(page, b)
        expect(page.locator("#findings")).to_have_value(text_b)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not all(any(f is r for f in failed) for r in early):
            page.wait_for_timeout(100)
        early_ended = [r for r in early if any(f is r for f in failed)]
        self.assertEqual(len(early_ended), len(early), "an aborted early read of A did not end on the page")
        state["phase"] = "learn"
        self.select(page, a)
        # The new read of A is answered (A, the ended work's revision, no draft), the page receives that answer, and it is
        # applied to the screen (the unknown discard is reported as done, the editor holds no ended text) - all before the
        # old answer is delivered.
        def received():
            return [entry for entry in learned if any(f is entry[0] for f in finished)]
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline and not received():
            page.wait_for_timeout(200)
        self.assertTrue(received(), f"no new read of A was answered and received after A was selected again: {learned}")
        answers = [(status, (body or {}).get("uid"), (body or {}).get("revision"), (body or {}).get("present"))
                   for _, status, body in received()]
        self.assertIn((200, a.uid, ended["revision"], False), answers, answers)
        self.assertFalse([e for e in learned if any(f is e[0] for f in failed)], "a new read of A failed instead of finishing")
        expect(page.locator("#toast")).to_contain_text("서버에서 처리된 것을 확인했습니다", timeout=20000)
        expect(page.locator("#findings")).not_to_have_value(secret + "\nSYN-C9 more")
        self.assertNotIn(secret, page.locator("#findings").input_value())
        self.assertFalse(any(r is kept[0][0].request for r in finished + failed), "the old answer ended before the new read was applied")
        self.shot(page, "c9-new-a-applied-before-old-answer")
        # ⑦ the old answer is delivered now, and the page receives it (finished, not failed or cancelled).
        route, response = kept[0]
        request = route.request
        route.fulfill(response=response)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not any(r is request for r in finished + failed):
            page.wait_for_timeout(100)
        self.assertTrue(any(r is request for r in finished), "the kept answer was not delivered to the page")
        self.assertFalse(any(r is request for r in failed), "the kept answer's request failed instead of finishing")
        delivered = time.monotonic()
        page.wait_for_timeout(3000)
        self.assertGreaterEqual(time.monotonic() - delivered, 2)
        self.assertNotIn(secret, page.locator("#findings").input_value())
        self.assertFalse([p for p in puts if p[0] in ("away", "learn") and secret in p[1]], "a write carried the ended text")
        self.assertEqual(self.server_draft(a)["present"], False)
        self.shot(page, "c9-old-answer-after-new-a")
        print("CD09P-SCREEN " + json.dumps({"c9": {"early_reads_aborted": len(early), "early_reads_ended": len(early_ended),
                                                   "new_a_answers_before_old": answers,
                                                   "lost_discard_reads": len([e for e in log if e[0] == "lost-discard" and e[1] == "GET"])}}),
              flush=True)
        # ⑧ NEW-A is a new work; the ended work is not created again; B's text is as it was.
        self.type_and_save(page, a, "SYN-C9 NEW-A")
        self.assertEqual(self.server_draft(a)["snapshot"]["findings"], "SYN-C9 NEW-A")
        fresh = self.work_unit(a)
        self.assertTrue(fresh.startswith("disposal:") and fresh != original, (fresh, original))
        self.assertEqual(psql(f'SELECT count(*) FROM "ReportDraft" WHERE "workUnit"={sql_text(original)}'), ["0"])
        self.assertEqual(self.server_draft(b)["snapshot"]["findings"], text_b)


import test_related_report_mode as related


class DraftPurposeRelatedR3(related.RelatedReportModeE2E):
    """CD-09-P r3 C10-b: a Related Report insertion into a Target whose work then ends (the author's other session) and
    is destroyed. The existing Related fixture (test_related_report_mode.py) with the insertion's real answer kept or
    read-and-lost; nothing is faked."""

    def open_related(self, on_put):
        patient = "W5-" + uuid.uuid4().hex[:16]
        target, source = self.fixture(patient_id=patient), self.fixture(patient_id=patient)
        self.seed_report(source, action="approve", findings=related.SOURCE_FINDINGS)
        page = self.login()
        if not page.locator(".left").is_visible():
            page.get_by_role("button", name="Worklist", exact=True).click()
        self.select(page, target)
        page.locator("#findings").fill(related.TARGET_OWN)
        page.route(lambda url: url.endswith(f"/studies/{target.uid}/report"), on_put)
        row = page.locator(f'#relrows tr[data-uid="{source.uid}"]')
        expect(row).to_be_visible()
        row.locator("td").first.click()
        expect(page.locator("#related-mode")).to_be_visible()
        source_text = page.locator('#related-mode [data-related-source="findings"]')
        expect(source_text).to_have_text(related.SOURCE_FINDINGS)
        source_text.evaluate("""(node, length) => {
            const range = document.createRange(); range.setStart(node.firstChild, 0); range.setEnd(node.firstChild, length);
            const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        }""", len(related.SOURCE_LINE))
        page.locator("#related-mode-insert").click()
        return page, target, source

    def end_target(self, target):
        ended = self.stack.request("DELETE", f"/studies/{target.uid}/draft", "doctor", {})
        self.assertEqual(ended.status, 200, ended.text)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if psql(f'SELECT count(*) FROM "ReportDraftPurposeEnd" WHERE uid={sql_text(target.uid)}') == ["0"]:
                return
            time.sleep(0.5)
        self.fail("the Target's ended work was not destroyed")

    def receipt(self, request_id):
        return psql(f'SELECT state || \'|\' || "receiptRevision" FROM "ReportDraftInsertReceipt" '
                    f'WHERE "insertRequestId"={sql_text(request_id)}::uuid')

    @staticmethod
    def related_body(request):
        try:
            body = request.post_data_json if request.method == "PUT" and request.post_data else None
        except Exception:
            return None
        return body if isinstance(body, dict) and "relatedInsert" in body else None

    def test_c10b1_a_late_insert_answer_delivered_after_the_end_writes_nothing_back(self):
        kept, sent = [], []

        def keep(route):
            body = self.related_body(route.request)
            if body is None:
                route.fallback(); return
            sent.append(body)
            kept.append((route, route.fetch()))                      # the server applied it; the page waits
        page, target, source = self.open_related(keep)
        source_versions = self.versions(source)
        deadline = time.monotonic() + 30
        while not kept and time.monotonic() < deadline:
            page.wait_for_timeout(100)
        self.assertTrue(kept, "the insertion was not sent")
        route, response = kept[0]
        self.assertEqual(response.status, 200, response.text())
        request_id = sent[0]["relatedInsert"]["insertRequestId"]
        # While the answer is kept: the server wrote the inserted line and an applied receipt.
        answer = response.json()
        # The author's own draft row, whole (row_to_json keeps a multi-line findings on one output line).
        stored = [json.loads(line) for line in psql(
            'SELECT row_to_json(d)::text FROM (SELECT author, findings FROM "ReportDraft" '
            f'WHERE uid={sql_text(target.uid)} AND author={sql_text(self.stack.actor("doctor"))}) d')]
        print("CD09P-SCREEN " + json.dumps({"c10b1-kept": {"answer": {k: answer.get(k) for k in ("revision", "present", "relatedInsert")},
                                                           "rows": stored, "receipt": self.receipt(request_id)}}), flush=True)
        self.assertEqual(answer["relatedInsert"]["result"], "applied", answer)
        self.assertEqual(len(stored), 1, stored)
        self.assertIn(related.SOURCE_LINE, stored[0]["findings"])
        self.assertIn(related.TARGET_OWN, stored[0]["findings"])
        self.assertEqual(self.receipt(request_id)[0].split("|")[0], "applied")
        self.end_target(target)
        puts, finished, failed = [], [], []
        page.on("response", lambda r: puts.append((time.monotonic(), r.status, r.request.post_data or ""))
                if r.request.method == "PUT" and r.url.endswith(f"/studies/{target.uid}/report") else None)
        page.on("requestfinished", lambda r: finished.append(r))
        page.on("requestfailed", lambda r: failed.append(r))
        request = route.request

        def editor():
            return {field: page.locator("#" + field).input_value() for field in ("findings", "conclusion", "recommendation")}
        # The editor just before the late answer: the text this page already holds (the Target's own and the inserted line).
        before = editor()
        self.assertIn(related.TARGET_OWN, before["findings"])
        route.fulfill(response=response)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not any(r is request for r in finished + failed):
            page.wait_for_timeout(100)
        self.assertTrue(any(r is request for r in finished), "the kept answer was not delivered")
        delivered = time.monotonic()
        # Every second for at least one autosave period (20 s) after the delivery, still before any new input, the editor
        # shows either the text it already held or the server's state (the ended work: no draft, the Target has no report).
        # Anything else, or the held text coming back after the server's state was shown, is the late answer re-applied.
        shown = {"held": before, "server": {field: "" for field in before}}
        readings = []
        while time.monotonic() - delivered < 45:
            reading = editor()
            readings.append((round(time.monotonic() - delivered, 1),
                             next((name for name, value in shown.items() if value == reading), None), reading))
            page.wait_for_timeout(1000)
        changes = [(at, state) for index, (at, state, _) in enumerate(readings) if index == 0 or state != readings[index - 1][1]]
        print("CD09P-SCREEN " + json.dumps({"c10b1-editor": {"before": before, "changes": changes, "last": readings[-1][2]}}), flush=True)
        self.assertFalse([r for r in readings if r[1] is None][:1], "the editor showed a text that was neither held nor the server's")
        states = [state for _, state, _ in readings]
        if "server" in states:
            self.assertNotIn("held", states[states.index("server"):], "the ended text came back after the server's state was shown")
        later = [p for p in puts if p[0] >= delivered]
        self.assertFalse([p for p in later if p[1] == 200], later)
        self.assertFalse([p for p in later if related.SOURCE_LINE in p[2]], "a write after the end carried the inserted line")
        server = self.draft(target)
        self.assertEqual((server["present"], server["snapshot"]), (False, None))
        self.assertEqual(self.versions(source), source_versions)
        print("CD09P-SCREEN " + json.dumps({"c10b1": {"puts_after_delivery": len(later)}}), flush=True)

    def test_c10b3_old_related_check_finishes_only_after_new_a_is_applied(self):
        # Input: a committed insert with its PUT answer lost. Check's real applied
        # body is held, then the author ends the work in another session.
        def lose(route):
            if self.related_body(route.request) is None:
                route.fallback(); return
            real = route.fetch()
            self.assertEqual(real.status, 200, real.text())
            route.abort("connectionreset")
        page, target, source = self.open_related(lose)
        expect(page.locator("#report-notice")).to_contain_text("Result Unknown")
        kept, fresh, finished, failed, writes = [], [], [], [], []
        phase = {"value": "old"}
        path = f"/api/studies/{target.uid}/draft"
        page.on("requestfinished", lambda r: finished.append(r))
        page.on("requestfailed", lambda r: failed.append(r))
        page.on("request", lambda r: writes.append(r.post_data or "")
                if r.method == "PUT" and r.url.endswith(f"/studies/{target.uid}/report") else None)

        def keep_check(route):
            request = route.request
            if request.method != "GET":
                route.fallback(); return
            response = route.fetch()
            body = response.json()
            if phase["value"] == "old" and not kept and "insertRequestId=" in request.url:
                kept.append((route, response, body)); return
            if phase["value"] == "new-a":
                fresh.append((request, body))
            route.fulfill(response=response)
        page.route(lambda url: urlsplit(url).path == path, keep_check)
        page.locator("#report-notice-check").click()
        deadline = time.monotonic() + 20
        while not kept and time.monotonic() < deadline:
            page.wait_for_timeout(100)
        self.assertTrue(kept, "the old Related Check response was not captured")
        route, response, old = kept[0]
        self.assertEqual((response.status, old["uid"]), (200, target.uid))
        self.assertEqual(old["relatedInsert"]["state"], "applied")
        self.assertIn(related.SOURCE_LINE, old["snapshot"]["findings"])
        self.assertIn(related.TARGET_OWN, old["snapshot"]["findings"])
        self.end_target(target)
        ended = self.draft(target)
        self.assertFalse(ended["present"])
        self.assertNotEqual(ended["revision"], old["revision"])
        phase["value"] = "away"
        if page.locator("#related-mode-back").is_visible():
            page.locator("#related-mode-back").click()
        self.select(page, source)
        expect(page.locator("#findings")).to_have_value(related.SOURCE_FINDINGS)
        phase["value"] = "new-a"
        self.select(page, target)
        deadline = time.monotonic() + 30
        def new_answer_finished():
            return any(r in finished and (b["uid"], b["revision"], b["present"]) ==
                       (target.uid, ended["revision"], False) for r, b in fresh)
        while time.monotonic() < deadline and not new_answer_finished():
            page.wait_for_timeout(100)
        self.assertTrue(new_answer_finished(), "the exact ended A answer must finish first")
        expect(page.locator("#findings")).to_have_value("")
        expect(page.locator("#conclusion")).to_have_value("")
        expect(page.locator("#recommendation")).to_have_value("")
        self.assertNotIn(route.request, finished + failed)
        page.screenshot(path=str(EVIDENCE / "c10b3-new-a-before-old-related.png"))
        # Observation precedes outcome: deliver the exact old body and require
        # requestfinished, not cancellation, after the new A screen above.
        route.fulfill(response=response)
        deadline = time.monotonic() + 15
        while route.request not in finished + failed and time.monotonic() < deadline:
            page.wait_for_timeout(100)
        self.assertIn(route.request, finished)
        self.assertNotIn(route.request, failed)
        page.wait_for_timeout(22000)
        for field in ("findings", "conclusion", "recommendation"):
            expect(page.locator("#" + field)).to_have_value("")
        self.assertFalse(any(related.SOURCE_LINE in body or related.TARGET_OWN in body for body in writes))
        self.assertFalse(self.draft(target)["present"])
        print("CD09P-SCREEN " + json.dumps({"c10b3": {"uid": target.uid, "old_revision": old["revision"],
            "ended_revision": ended["revision"],
            "new_a_revisions": [b["revision"] for r, b in fresh if r in finished],
            "old_finished_after_new_screen": True, "writes": len(writes)}}), flush=True)

    def test_c10b2_a_replayed_insert_after_the_end_is_checked_and_never_writes_the_draft_again(self):
        sent, answers = [], []

        def read_then_lose(route):
            body = self.related_body(route.request)
            if body is None:
                route.fallback(); return
            sent.append(body)
            try:
                real = route.fetch()
                answers.append((real.status, real.text()))
            except Exception as error:   # recorded apart: a fetch that failed is not an answer read
                answers.append(("fetch-failed", repr(error)[:500]))
            try:
                route.abort("connectionreset")
            except Exception as error:
                answers.append(("abort-failed", repr(error)[:500]))
        page, target, source = self.open_related(read_then_lose)
        notice = page.locator("#report-notice")
        expect(notice).to_contain_text("Result Unknown")
        self.assertEqual((len(sent), answers[0][0]), (1, 200), "the server applied the first insertion")
        request_id = sent[0]["relatedInsert"]["insertRequestId"]
        receipt = self.receipt(request_id)
        self.end_target(target)
        statuses, reads, finished = [], [], []
        page.on("response", lambda r: statuses.append(r.status)
                if r.request.method == "PUT" and r.url.endswith(f"/studies/{target.uid}/report") else None)
        page.on("request", lambda r: reads.append((time.monotonic(), r))
                if r.method == "GET" and f"/studies/{target.uid}/draft" in r.url and "insertRequestId" in r.url else None)
        page.on("requestfinished", lambda r: finished.append(r))
        # Retry: the same ID and body reach the server; its answer (the receipt's replay) is read, then lost.
        page.locator("#report-notice-retry").click()
        deadline = time.monotonic() + 30
        while len(sent) < 2 and time.monotonic() < deadline:
            page.wait_for_timeout(100)
        self.assertEqual(len(sent), 2)
        page.wait_for_timeout(1000)
        print("CD09P-SCREEN " + json.dumps({"c10b2-answers": [(a[0], str(a[1])[:300]) for a in answers]}), flush=True)
        self.assertEqual(sent[1], sent[0])
        self.assertEqual(self.receipt(request_id), receipt, "the replay wrote no receipt row")
        self.assertEqual(len(answers), 2, answers)
        replay = answers[1]
        self.assertIn(replay[0], (200, 409), replay)
        # The operation stays unknown: Check is shown and enabled before it is pressed, and its read goes after the press.
        check = page.locator("#report-notice-check")
        expect(check).to_be_visible(timeout=20000)
        expect(check).to_be_enabled()
        before_press = len(reads)
        pressed = time.monotonic()
        check.click()
        deadline = time.monotonic() + 20
        while not [r for t, r in reads if t >= pressed] and time.monotonic() < deadline:
            page.wait_for_timeout(100)
        sent_by_click = [r for t, r in reads if t >= pressed]
        self.assertTrue(sent_by_click, "Check sent no read")
        # The answer to that very read, as the page received it.
        clicked = sent_by_click[0]
        answer = clicked.response()
        self.assertIsNotNone(answer, "the Check read got no answer")
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not any(r is clicked for r in finished):
            page.wait_for_timeout(100)
        self.assertTrue(any(r is clicked for r in finished), "the page did not receive the Check answer")
        self.assertEqual(answer.status, 200, answer.text())
        body = answer.json()
        self.assertEqual((body["uid"], body["present"], body["relatedInsert"]["insertRequestId"], body["relatedInsert"]["currentMatches"]),
                         (target.uid, False, request_id, False), body)
        # The screen after that answer: the insertion is handed to the explicit choice, never applied again.
        notice = page.locator("#report-notice-msg")
        expect(notice).to_contain_text("Draft Conflict", timeout=20000)
        self.assertRegex(notice.inner_text(), "[가-힣]")
        expect(check).to_be_hidden()
        expect(page.locator("#b-draft-keep")).to_have_text("Keep This Text")
        expect(page.locator("#b-draft-load")).to_have_text("Load Server Draft")
        expect(page.locator("#b-draft-load")).to_be_visible()
        page.screenshot(path=str(EVIDENCE / "c10b2-check-answer-on-screen.png"))
        page.wait_for_timeout(3000)
        # Server comparison only (the test process's own read, not the page's Check).
        checked = self.draft(target, request_id)
        self.assertEqual((checked["present"], checked["relatedInsert"]["currentMatches"]), (False, False))
        self.assertFalse([s for s in statuses if s == 200], statuses)
        print("CD09P-SCREEN " + json.dumps({"c10b2": {"replay": replay[0], "receipt": receipt, "reads_before_press": before_press,
                                                      "check_answer": {"status": answer.status, "present": body["present"],
                                                                       "relatedInsert": body["relatedInsert"]},
                                                      "notice": notice.inner_text()}}, ensure_ascii=True), flush=True)


def load_tests(loader, tests, pattern):
    suite = loader.loadTestsFromTestCase(DraftPurposeScreen)
    # The r3 classes reuse the screen and Related helpers; only their own cases run under them.
    for case in (DraftPurposeScreenR3, DraftPurposeRelatedR3):
        suite.addTests(case(name) for name in sorted(vars(case)) if name.startswith("test_"))
    return suite


if __name__ == "__main__":
    unittest.main()
