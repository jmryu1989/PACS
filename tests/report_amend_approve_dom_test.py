# coding: utf-8
"""FC-034 (sending side) -> RISK-SILENT-REAPPROVAL / RISK-STALE-FINALIZED -> the delivered split page.

Within 24 hours of the first approval the approving reader corrects the text and presses Approve again; the page sends
that as `amend` from the one common commit point (Approve, Approve & Next and Ctrl+S alike). Approve opens only for
the approver, inside the window, before any Addendum, and only when the text differs from the approved report. After
the window the RS word is Finalized, also on a page left open; a report whose approval time is unknown stays Approved.

The delivered page (main.html, its bundle and every shipped asset) against the synthetic origin of report_flow_dom_test;
no stack, no product file is modified. AmendSite adds what the server sends on this boundary (`approvedAt`, `amendUntil`,
`amendedAt`, `addendumAt`, `amendMine`) and answers an `amend` as the server does (RS stays A, `amendedAt` set).
Button descriptions are not pinned; the cases assert behaviour (enabled, the action sent, the RS word, the move).
"""
import datetime as dt
import sys
import time
import unittest

import auth_logout_dom_test as h
import report_flow_dom_test as rf
from playwright.sync_api import expect, sync_playwright

NOW = dt.datetime(2026, 11, 11, 1, 0, tzinfo=dt.timezone.utc)
HOUR = dt.timedelta(hours=1)


def iso(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%S.000Z")


class AmendSite(rf.FlowSite):
    """FlowSite plus the approval facts of the current approval and the server's answer to `amend`."""

    def __init__(self, count=3):
        super().__init__(count)
        self.approval = {}   # uid -> {"approvedAt": iso|None, "mine": bool, "addendumAt": iso|None, "amendedAt": iso|None}

    def approve(self, uid, *, at=NOW - HOUR, mine=True, addendum_at=None, findings="SYN approved"):
        self.store[uid]["report"] = {"version": 2, "rs": "A", "findings": findings, "conclusion": "SYN conclusion",
                                     "recommendation": ""}
        self.approval[uid] = {"approvedAt": iso(at) if at else None, "mine": mine,
                              "addendumAt": iso(addendum_at) if addendum_at else None, "amendedAt": None}

    def state_of(self, uid, account):
        state = super().state_of(uid, account)
        a = self.approval.get(uid) if state["rs"] == "A" else None
        approved_at = a and a["approvedAt"]
        until = iso(dt.datetime.strptime(approved_at, "%Y-%m-%dT%H:%M:%S.000Z").replace(tzinfo=dt.timezone.utc)
                    + 24 * HOUR) if approved_at else None
        return {**state, "approvedAt": approved_at or None, "amendUntil": until,
                "amendedAt": (a or {}).get("amendedAt"), "addendumAt": (a or {}).get("addendumAt"),
                "amendMine": bool(a and a["approvedAt"] and a["mine"])}

    def commit_of(self, uid, body, account):
        if body.get("action") != "amend":
            return super().commit_of(uid, body, account)
        refused = self.preconditions_of(uid, body, account)
        if refused:
            return refused
        st = self.store[uid]
        if st["report"]["rs"] != "A":
            return 400, {"code": "SYN_NOT_APPROVED", "message": "SYN-SERVER-WORDING not approved"}
        if body.get("baseVersion") != st["report"]["version"]:
            return 409, {"code": "REPORT_VERSION_CONFLICT", "message": "SYN 그 사이 다른 사용자가 저장했습니다"}
        st["revs"] += 1
        st["row"] = None
        st["report"] = {"version": st["report"]["version"] + 1, "rs": "A", **{k: body.get(k, "") for k in rf.FIELDS}}
        self.approval[uid]["amendedAt"] = iso(NOW)
        return 200, {**self.envelope_of(uid, account), "state": self.state_of(uid, account)}


class AmendApprovePage(unittest.TestCase):
    count = 3

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = AmendSite(self.count)
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR",
                                                timezone_id="Asia/Seoul")
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.page.set_default_navigation_timeout(30000)
        self.errors, self.dialogs = [], []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", lambda dialog: (self.dialogs.append(dialog.message), dialog.accept()))
        self.page.clock.install(time=NOW)

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.site.violations, "requests the synthetic origin does not answer")

    # ── driving the page ──
    def open(self, patient=h.PATIENT):
        self.page.goto(h.MAIN_URL)
        expect(self.page.locator("#rows")).to_contain_text(h.PATIENT)
        self.page.locator("#rows tr", has_text=patient).first.click()
        self.wait(lambda: self.selected() == patient, "the study opens")
        expect(self.page.locator("#findings")).to_be_editable()

    def selected(self):
        return self.page.evaluate("() => studies.find(s => s.uid === selectedUid)?.name ?? null")

    def wait(self, predicate, what, timeout=10.0):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > deadline:
                self.fail(f"{what}: not observed; last requests {self.site.calls[-8:]}")
            self.page.wait_for_timeout(20)

    def edit(self, text):
        self.page.locator("#findings").fill(text)

    def commits(self):
        return [(uid, body["action"]) for uid, body in self.site.flow_commits]

    def rs_cell(self, patient=h.PATIENT):
        return self.page.locator("#rows tr", has_text=patient).first.locator("span.rs")

    def approve(self):
        return self.page.locator("#b-approve")

    # ── Approve opens only for the approver, in the window, before any Addendum, with edited text ──
    def test_approver_in_the_window_approves_edited_text_as_amend_and_stays_approved(self):
        self.site.approve(h.UID)
        self.open()
        expect(self.rs_cell()).to_have_text("Approved")
        expect(self.page.locator("#report-editor-rs")).to_contain_text("Approved")
        expect(self.page.locator("#report-editor-rs")).to_contain_text("수정 가능")
        expect(self.approve()).to_be_disabled()            # nothing corrected yet
        expect(self.page.locator("#b-save")).to_be_disabled()
        expect(self.page.locator("#b-addendum")).to_be_enabled()
        self.edit("SYN approved, corrected")
        expect(self.approve()).to_be_enabled()
        expect(self.page.locator("#b-approve-next")).to_be_enabled()
        expect(self.page.locator("#b-save")).to_be_disabled()  # Save stays off on an approved report
        self.edit("SYN approved")                           # back to the approved text: nothing to approve again
        expect(self.approve()).to_be_disabled()
        self.edit("SYN approved, corrected")
        self.approve().click()
        self.wait(lambda: self.commits(), "the amend is sent")
        self.assertEqual([(h.UID, "amend")], self.commits())
        self.assertEqual("SYN approved, corrected", self.site.flow_commits[0][1]["findings"])
        expect(self.page.locator("#toast")).to_contain_text("다시 승인했습니다")
        self.wait(lambda: self.page.evaluate("() => appState[selectedUid].version") == 3, "the amended version is shown")
        expect(self.rs_cell()).to_have_text("Approved")
        expect(self.page.locator("#report-editor-rs")).to_contain_text("수정됨")
        expect(self.approve()).to_be_disabled()            # the editor shows the amended report: nothing corrected
        self.assertEqual(h.PATIENT, self.selected(), "Approve stays on the study")

    def test_approve_and_next_sends_amend_and_moves_after_the_accepted_answer(self):
        self.site.approve(h.UID)
        self.open()
        self.edit("SYN corrected before next")
        self.page.locator("#b-approve-next").click()
        self.wait(lambda: self.commits(), "the amend is sent")
        self.assertEqual([(h.UID, "amend")], self.commits())
        self.wait(lambda: self.selected() == h.PATIENT_B, "the move to the next study")

    def test_ctrl_s_sends_amend_through_the_same_path(self):
        self.site.approve(h.UID)
        self.open()
        self.assertFalse(self.page.evaluate(rf.CTRL_S), "nothing corrected: Finalize does not run")
        self.edit("SYN corrected by keyboard")
        self.page.locator("#findings").focus()
        self.assertTrue(self.page.evaluate(rf.CTRL_S), "the command runs")
        self.wait(lambda: self.commits(), "the amend by Ctrl+S")
        self.assertEqual([(h.UID, "amend")], self.commits())
        self.assertEqual(h.PATIENT, self.selected())

    def test_another_reader_than_the_approver_cannot_approve_again(self):
        self.site.approve(h.UID, mine=False)
        self.open()
        self.edit("SYN corrected by another reader")
        expect(self.approve()).to_be_disabled()
        expect(self.page.locator("#b-approve-next")).to_be_disabled()
        expect(self.page.locator("#b-addendum")).to_be_enabled()
        self.assertFalse(self.page.evaluate(rf.CTRL_S))
        self.assertEqual([], self.commits())

    def test_after_an_addendum_approve_stays_closed(self):
        self.site.approve(h.UID, addendum_at=NOW - HOUR / 2)
        self.open()
        self.edit("SYN corrected after an addendum")
        expect(self.approve()).to_be_disabled()
        expect(self.page.locator("#b-addendum")).to_be_enabled()
        self.assertNotIn("수정 가능", self.page.locator("#report-editor-rs").inner_text())

    def test_an_open_page_turns_finalized_when_the_window_passes(self):
        self.site.approve(h.UID, at=NOW - 23 * HOUR - 50 * dt.timedelta(minutes=1))   # 10 minutes left
        self.open()
        self.edit("SYN corrected near the end")
        expect(self.approve()).to_be_enabled()
        expect(self.rs_cell()).to_have_text("Approved")
        self.page.clock.fast_forward(11 * 60 * 1000)        # the window ends while the page stays open
        self.page.locator("#m-refresh").click()            # the next drawing of the list and the editor
        expect(self.rs_cell()).to_have_text("Finalized")
        expect(self.page.locator("#report-editor-rs")).to_contain_text("Finalized")
        expect(self.approve()).to_be_disabled()
        expect(self.page.locator("#b-addendum")).to_be_enabled()
        self.assertEqual("A", self.page.evaluate("() => studies.find(s => s.uid === selectedUid).rs"), "RS stays A")

    def test_a_report_without_a_known_approval_time_stays_approved_with_approve_closed(self):
        self.site.approve(h.UID, at=None)
        self.open()
        self.edit("SYN corrected on an old approval")
        expect(self.approve()).to_be_disabled()
        self.page.clock.fast_forward(48 * 3600 * 1000)
        self.page.locator("#m-refresh").click()
        self.page.wait_for_timeout(300)
        expect(self.rs_cell()).to_have_text("Approved")
        expect(self.page.locator("#report-editor-rs")).to_have_text("Approved")

    def test_the_finalized_word_is_a_pure_function_of_the_state_and_the_clock(self):
        self.site.approve(h.UID)
        self.open()
        until = iso(NOW)
        cases = self.page.evaluate("""(until) => {
          const t = Date.parse(until);
          return [
            reportFinalized({ rs: "A", amendUntil: until }, t - 1),
            reportFinalized({ rs: "A", amendUntil: until }, t),
            reportFinalized({ rs: "A", amendUntil: null }, t + 1e9),
            reportFinalized({ rs: "T", amendUntil: until }, t + 1),
            reportFinalized({ rs: "A", amendUntil: "not a time" }, t + 1),
            reportStatusWord({ rs: "A", amendUntil: until }, t),
            reportStatusWord({ rs: "A", amendUntil: null }, t),
            reportStatusWord({ rs: "W" }, t),
          ];
        }""", until)
        self.assertEqual([False, True, False, False, False, "Finalized", "Approved", "Unread"], cases)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main()
