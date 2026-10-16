# coding: utf-8
"""WORKLIST-SPLIT-UID (spec-worklist-split-uid-20261016) REQ-WSU-02/06/08 -> RISK-WSU-02/06/08 -> TEST-WSU-07 and the
DOM part of TEST-WSU-12.

The shipped worklist and clinician pages, served byte for byte by tests/auth_logout_dom_test.py's synthetic origin (every
route intercepted; no stack, database, Orthanc or credential). The synthetic API answers as the server does when a Study
UID is answered by two patient resources: the UID is not a normal row, and the page that completes the list names it in
identityIssues (UID and code only). Cases drive the page by its controls and the test clock and assert only what a person
sees (the notice, rows, editor values and their editability) and what reaches the server (draft writes, commits,
image-opening calls).
"""
import sys
import time
import unittest

from playwright.sync_api import expect, sync_playwright

import auth_logout_dom_test as auth

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
TITLE = "Patient Identity Conflict"
NOTICE = "1 · 환자 식별 불일치로 검사 1건을 목록에서 제외했습니다. 원본 확인이 필요합니다."
UNOBSERVED = "관측 불가 · 마지막 관측 기준입니다."
ISSUE = "STUDY_IDENTITY_UNRESOLVED"


class SplitSite(auth.Site):
    """The auth harness server, plus the UIDs it now answers as unresolved (excluded from rows, named as issues)."""

    def __init__(self):
        super().__init__()
        self.second_study = True
        self.split = set()

    def list_body(self, account, rename=None):
        body = super().list_body(account, rename)
        body["studies"] = [row for row in body["studies"] if row["uid"] not in self.split]
        body["pagination"]["total"] = len(body["studies"])
        body["identityIssues"] = [{"uid": uid, "code": ISSUE} for uid in sorted(self.split)]
        return body

    def api(self, route, request, method, path, query):
        if method == "GET" and path == "/api/clinician/studies":
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            rows = [] if auth.UID in self.split else [{"uid": auth.UID, "id": "SYN-P-001", "name": auth.PATIENT,
                    "birth": "19800101", "sex": "M", "date": "20261003", "acc": "SYNACC0001", "desc": "SYN CT CHEST",
                    "modality": "CT", "count": 10, "series": 1, "sourcePatientKey": auth.INSTITUTION + "|SYN-P-001",
                    "institutionName": "SYN Hospital A", "tele": False, "report": {"final": False, "rs": "W"}}]
            return route.fulfill(json={"studies": rows, "serverTime": "2026-10-03T00:00:00.000Z",
                                       "identityIssues": [{"uid": uid, "code": ISSUE} for uid in sorted(self.split)],
                                       "pagination": {"next": None, "total": len(rows), "offset": 0, "limit": 100}})
        return super().api(route, request, method, path, query)


class WorklistSplitUidDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = SplitSite()
        self.errors, self.dialogs, self.popups = [], [], []
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR", timezone_id="Asia/Seoul")
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", lambda dialog: (self.dialogs.append(dialog.message), dialog.dismiss()))
        self.page.on("popup", lambda popup: self.popups.append(popup.url))
        self.page.clock.install()

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.site.violations)
        self.assertEqual([], self.errors)

    def wait_until(self, predicate, what):
        deadline = time.monotonic() + 10
        while not predicate():
            if time.monotonic() > deadline:
                self.fail(what + " not observed; last requests " + repr(self.site.calls[-8:]))
            self.page.wait_for_timeout(20)

    def open_main(self, patient=auth.PATIENT):
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator("#rows")).to_contain_text(patient)

    def refresh(self):
        before = self.site.count("GET", "/api/studies")
        self.page.get_by_role("group", name="Refresh").get_by_role("button", name="Refresh", exact=True).click()
        self.wait_until(lambda: self.site.count("GET", "/api/studies") > before, "the list read")

    def notice(self):
        box = self.page.locator("#identity-issues")
        return None if box.is_hidden() else box.inner_text()

    def type_report(self):
        self.page.locator("#rows tr", has_text=auth.PATIENT).first.click()
        expect(self.page.locator("#findings")).to_be_editable()
        for name, value in auth.FIELDS.items():
            self.page.fill("#" + name, value)
        self.wait_until(lambda: self.site.holds, "the hold typing starts")

    def editor(self):
        return {k: self.page.locator("#" + k).input_value() for k in auth.FIELDS}

    def test_wsu07_01_notice_is_counted_apart_and_shows_no_patient_of_the_unresolved_uid(self):
        self.site.split = {auth.UID_B}
        self.open_main()
        expect(self.page.locator("#identity-issues")).to_be_visible()
        expect(self.page.locator("#identity-issues")).to_have_text(TITLE + " " + NOTICE)
        expect(self.page.locator("#identity-issues")).to_have_attribute("role", "status")
        # The list count is the normal rows only; the excluded study is its own sentence.
        expect(self.page.locator("#page-status")).to_contain_text("/ 1건")
        text = self.page.locator("body").inner_text()
        for leak in (auth.PATIENT_B, "SYN-P-002", auth.UID_B):
            self.assertNotIn(leak, text)
        self.assertEqual(1, self.page.locator("#rows tr[data-uid]").count())
        # A completed list without issues clears the notice; a list that does not say leaves it as it was.
        self.site.split = set()
        self.refresh()
        expect(self.page.locator("#identity-issues")).to_be_hidden()

    def test_wsu07_02_open_study_that_becomes_unresolved_keeps_text_caret_and_locks_every_write(self):
        self.open_main()
        self.type_report()
        self.page.evaluate("() => document.querySelector('#findings').setSelectionRange(4, 7)")
        puts, commits = len(self.site.puts), len(self.site.commits)
        self.site.split = {auth.UID}
        self.refresh()
        expect(self.page.locator("#identity-issues")).to_have_text(TITLE + " " + NOTICE)
        self.assertEqual(auth.FIELDS, self.editor())
        self.assertEqual([4, 7], self.page.evaluate("() => { const f = document.querySelector('#findings'); return [f.selectionStart, f.selectionEnd]; }"))
        for name in auth.FIELDS:
            self.assertTrue(self.page.locator("#" + name).evaluate("e => e.readOnly"), name)
        for button in ("#b-save", "#b-approve", "#b-clear", "#b-paste", "#b-defer", "#b-prelim", "#b-transcribe"):
            expect(self.page.locator(button)).to_be_disabled()
        # Autosave, a programmatic commit and an image launch send nothing for this study.
        self.page.clock.run_for(20001)
        self.page.wait_for_timeout(100)
        self.page.evaluate("() => commitReport('approve')")
        self.assertEqual(False, self.page.evaluate("uid => openFilmbox(uid)", auth.UID))
        self.page.wait_for_timeout(100)
        self.assertEqual((puts, commits), (len(self.site.puts), len(self.site.commits)))
        self.assertEqual([], self.popups)
        self.assertEqual(auth.FIELDS, self.editor())
        # Another normal study still opens, without discarding the kept text or choosing a study by itself.
        self.page.locator("#rows tr", has_text=auth.PATIENT_B).first.click()
        expect(self.page.locator("#findings")).to_be_editable()
        expect(self.page.locator("#findings")).to_have_value("")
        self.assertEqual((puts, commits), (len(self.site.puts), len(self.site.commits)), "leaving the locked study writes nothing")

    def test_wsu07_03_failed_cancelled_and_late_list_answers_never_overwrite_the_notice(self):
        self.site.split = {auth.UID_B}
        self.open_main()
        expect(self.page.locator("#identity-issues")).to_have_text(TITLE + " " + NOTICE)
        # A failed observation keeps the last notice and says it is the last observation.
        self.site.list_answers = [(503, {"code": "SYN_DOWN", "message": "SYN unavailable"})]
        self.refresh()
        expect(self.page.locator("#identity-issues")).to_contain_text(NOTICE)
        expect(self.page.locator("#identity-issues")).to_contain_text(UNOBSERVED)
        # An answer held past a cancel (A), then a newer list (B) without the issue: the late A changes nothing.
        self.site.held_lists = []
        self.refresh()
        self.wait_until(lambda: self.site.held_lists, "the held list")
        stale_route, account = self.site.held_lists.pop(0)
        stale = self.site.list_body(account)
        self.page.locator("#study-fetch-cancel").click()
        self.site.held_lists = None
        self.site.split = set()
        self.refresh()
        expect(self.page.locator("#identity-issues")).to_be_hidden()
        stale_route.fulfill(json=stale)
        self.page.wait_for_timeout(200)
        expect(self.page.locator("#identity-issues")).to_be_hidden()
        expect(self.page.locator("#rows")).to_contain_text(auth.PATIENT_B)

    def test_wsu12_04_external_resolution_returns_the_study_without_an_automatic_save_or_commit(self):
        self.open_main()
        self.type_report()
        puts, commits = len(self.site.puts), len(self.site.commits)
        self.site.split = {auth.UID}
        self.refresh()
        expect(self.page.locator("#identity-issues")).to_be_visible()
        # The originals are corrected outside the product: the next list has the study as one resource again.
        self.site.split = set()
        self.refresh()
        expect(self.page.locator("#identity-issues")).to_be_hidden()
        expect(self.page.locator("#rows")).to_contain_text(auth.PATIENT)
        expect(self.page.locator("#findings")).to_be_editable()
        self.assertEqual(auth.FIELDS, self.editor())
        self.page.clock.run_for(20001)
        self.page.wait_for_timeout(200)
        self.assertEqual((puts, commits), (len(self.site.puts), len(self.site.commits)), "no automatic save or commit on return")
        # The reader's next edit is saved as usual.
        self.page.locator("#findings").press("End")
        self.page.locator("#findings").type(" SYN-AFTER")
        self.page.clock.run_for(20001)
        self.wait_until(lambda: len(self.site.puts) > puts, "the edit after the return")
        self.assertEqual(auth.FIELDS["findings"] + " SYN-AFTER", self.site.puts[-1]["findings"])
        self.assertEqual(commits, len(self.site.commits))

    def poll(self):
        """One periodic list read on the test clock (no Refresh click)."""
        before = self.site.count("GET", "/api/studies")
        self.page.clock.run_for(30001)
        self.wait_until(lambda: self.site.count("GET", "/api/studies") > before, "the periodic list read")
        self.page.wait_for_timeout(200)

    def test_wsu07_06_the_periodic_list_read_announces_locks_and_returns_like_refresh(self):
        self.open_main()
        self.type_report()
        self.page.clock.run_for(20001)
        self.page.wait_for_timeout(200)
        # The open study becomes unresolved between two periodic reads; nobody presses Refresh.
        self.site.split = {auth.UID}
        self.poll()
        expect(self.page.locator("#identity-issues")).to_have_text(TITLE + " " + NOTICE)
        self.assertEqual(auth.FIELDS, self.editor())
        for name in auth.FIELDS:
            self.assertTrue(self.page.locator("#" + name).evaluate("e => e.readOnly"), name)
        for button in ("#b-save", "#b-approve", "#b-clear"):
            expect(self.page.locator(button)).to_be_disabled()
        puts, commits = len(self.site.puts), len(self.site.commits)
        self.page.clock.run_for(20001)
        self.page.wait_for_timeout(200)
        self.assertEqual((puts, commits), (len(self.site.puts), len(self.site.commits)), "a locked study sends no draft write")
        # Resolved outside the product: the next periodic read clears the notice and unlocks, still without a write.
        self.site.split = set()
        self.poll()
        expect(self.page.locator("#identity-issues")).to_be_hidden()
        expect(self.page.locator("#findings")).to_be_editable()
        self.assertEqual(auth.FIELDS, self.editor())
        self.assertEqual(commits, len(self.site.commits))

    def test_wsu07_05_clinician_list_tells_no_normal_study_apart_from_an_excluded_one(self):
        self.site.account = auth.CLINICIAN
        self.site.split = {auth.UID_B}
        self.page.goto(auth.ORIGIN + auth.BASE + "clinician.html")
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "ready")
        expect(self.page.locator("#list-state .state-detail")).to_have_text(TITLE + " " + NOTICE)
        self.assertNotIn(auth.UID_B, self.page.locator("body").inner_text())
        # Only the excluded study: an empty list that still says why.
        self.site.split = {auth.UID, auth.UID_B}
        self.page.locator("#refresh").click()
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "empty")
        expect(self.page.locator("#list-state .state-detail")).to_contain_text("환자 식별 불일치로 검사 2건을 목록에서 제외했습니다.")


if __name__ == "__main__":
    unittest.main(verbosity=2)
