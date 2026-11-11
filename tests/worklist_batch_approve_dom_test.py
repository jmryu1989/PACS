# coding: utf-8
"""FC-029 Batch Approve on the delivered split page (main.html, its bundle and every shipped asset); only HTTP is synthetic.

The selected saved reports are approved one existing single-study commit (action approve) per study, in the visible order,
each with exactly the text and version the dialog showed. ApproveSite extends the Batch Reading suite's BatchSite (several
studies, each with its own draft row, revision, report and version list) with Preliminary designations, the server's
designated-reviewer rule and a signing failure. No product file is modified.
"""
import sys
import time
import unittest

import auth_logout_dom_test as h
import report_flow_dom_test as rf
import worklist_batch_reading_dom_test as br
from playwright.sync_api import expect, sync_playwright

UIDS = br.UIDS
FIELDS = rf.FIELDS
REASON = "Batch Approve"


def report(version, rs="T", findings="", conclusion="", recommendation=""):
    return {"version": version, "rs": rs, "findings": findings, "conclusion": conclusion, "recommendation": recommendation}


class ApproveSite(br.BatchSite):
    """BatchSite plus Preliminary designations (uid -> (preDoc, preReviewer)) and studies whose signing fails."""

    def __init__(self, count=4):
        super().__init__(count)
        self.prelim = {}   # uid -> (preDoc, preReviewer, preReviewerSub or None): names as listed, the reviewer's account id
        self.unsigned = set()

    @staticmethod
    def designated(entry, account):
        """The server's designation rule: the account id when the designation has one, else the name."""
        _, reviewer, reviewer_sub = entry
        return account["sub"] == reviewer_sub if reviewer_sub else account["actor"] == reviewer

    def state_of(self, uid, account):
        st = super().state_of(uid, account)
        if st["rs"] == "P" and uid in self.prelim:
            doc, reviewer, _ = self.prelim[uid]
            hidden = account["actor"] != doc and not self.designated(self.prelim[uid], account)
            st.update(preDoc=doc, preReviewer=reviewer, prelimHidden=hidden)
            if hidden:
                st.update({k: "" for k in FIELDS}, draft=None)
        return st

    def commit_of(self, uid, body, account):
        refused = self.preconditions_of(uid, body, account)
        if refused:
            return refused
        if body.get("action") == "approve":
            if self.store[uid]["report"]["rs"] == "P" and not self.designated(self.prelim.get(uid, (None, None, None)), account):
                return 403, {"message": "SYN 예비 판독의 최종 승인은 지정된 상급 판독의만 할 수 있습니다"}
            if uid in self.unsigned and body.get("baseVersion") == self.store[uid]["report"]["version"]:
                return 503, {"code": "SYN_SIGNING_KEY", "message": "SYN 온라인 서명을 완료하지 못했습니다. 판독 입력은 보존됩니다."}
        return super().commit_of(uid, body, account)


class BatchApprovePage(unittest.TestCase):
    count = 4

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = ApproveSite(self.count)
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR",
                                                timezone_id="Asia/Seoul")
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.page.set_default_navigation_timeout(30000)
        self.errors, self.dialogs = [], []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", lambda dialog: (self.dialogs.append(dialog.message), dialog.accept()))

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.dialogs, "confirm/alert boxes")
        self.assertEqual([], self.site.violations, "requests the synthetic origin does not answer")

    # ── fixtures ──
    def saved(self, uid, version=1, author="syn-rad2@synthetic.test", rs="T", **texts):
        """A report saved before the page opened, in the study and its version list."""
        self.site.store[uid]["report"] = report(version, rs, **texts)
        self.site.history[uid].insert(0, {"id": version, "uid": uid, "version": version, "action": "save", "reason": None,
                                          "author": author, "at": "2026-10-02T00:00:00.000Z",
                                          **{k: texts.get(k, "") for k in FIELDS}})

    def texts_of(self, uid):
        return {k: self.site.store[uid]["report"].get(k, "") for k in FIELDS}

    # ── driving the page through its controls ──
    def open(self):
        self.page.goto(h.MAIN_URL)
        expect(self.page.locator("#rows")).to_contain_text(h.PATIENT)

    def row(self, uid):
        return self.page.locator(f'#rows tr[data-uid="{uid}"]')

    def choose(self, *uids):
        for uid in uids:
            self.row(uid).click(modifiers=["Control"])

    def wait(self, predicate, what, timeout=10.0):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > deadline:
                self.fail(f"{what}: not observed; last requests {self.site.calls[-8:]}")
            self.page.wait_for_timeout(20)

    def target(self):
        return self.page.evaluate("() => selectedUid")

    def dialog(self):
        return self.page.locator("#batch-approve-dialog")

    def open_batch(self, *uids):
        self.choose(*uids)
        self.page.locator("#multi-selection-batch-approve").click()
        expect(self.dialog()).to_be_visible()

    def approve(self):
        self.dialog().locator("[data-batch-save]").click()

    def result_of(self, uid):
        return self.dialog().locator(f'tr[data-uid="{uid}"] [data-batch-result]')

    def report_of(self, uid):
        return self.dialog().locator(f'tr[data-uid="{uid}"] [data-batch-report]')

    def done(self):
        expect(self.dialog().locator("[data-batch-close]")).to_be_visible()

    def note(self):
        return self.dialog().locator("[data-batch-note]")

    def commits_for(self, uid):
        return [body for u, body in self.site.flow_commits if u == uid]

    def right_click(self, uid):
        row = self.row(uid)
        box = row.evaluate("tr => { const r = tr.getBoundingClientRect(); return { x: r.x, y: r.y }; }")
        row.dispatch_event("contextmenu", {"clientX": box["x"] + 5, "clientY": box["y"] + 5, "button": 2})

    def menu_labels(self):
        return self.page.evaluate("() => getComputedStyle(document.querySelector('#ctx')).display === 'none' ? null"
                                  " : [...document.querySelectorAll('#ctx [data-i]')].map(e => e.textContent)")

    # ── ① the place: added after Batch Reading, nothing renamed or moved ──
    def test_bar_and_selection_menu_add_batch_approve_after_batch_reading(self):
        self.open()
        self.choose(UIDS[0], UIDS[1])
        labels = self.page.evaluate("() => [...document.querySelectorAll('#worklist-selection > button')].map(b => b.textContent)")
        self.assertEqual(["Select Page", "Selection Details", "Clear Selection", "Open Selected Studies"],
                         [x for x in labels if x not in ("Preload", "Batch Reading", "Batch Approve")][:4])
        self.assertEqual(["Batch Reading", "Batch Approve"], labels[-2:], labels)
        expect(self.page.locator("#multi-selection-batch-approve")).to_be_enabled()
        self.right_click(UIDS[0])
        self.wait(lambda: self.menu_labels() is not None, "the selection menu")
        self.assertEqual(["Open Selected Studies", "Batch Reading", "Batch Approve"], self.menu_labels())
        before = len(self.site.calls)
        self.page.locator("#ctx [data-i]", has_text="Batch Approve").click()
        expect(self.dialog()).to_be_visible()
        self.assertEqual(None, self.target(), "the menu moved the Reading Target")
        self.assertEqual([], [c for c in self.site.calls[before:] if c[0] != "GET"], "opening the dialog wrote")
        self.dialog().locator("[data-batch-cancel]").click()
        expect(self.dialog()).to_be_hidden()

    # ── ④ the approve bodies are the text and version the dialog showed; an Unread study sends nothing ──
    def test_three_saved_reports_are_approved_as_shown_and_the_unread_one_sends_nothing(self):
        for i, uid in enumerate(UIDS[:3]):
            self.saved(uid, version=i + 1, findings=f"SYN findings {i}\nSYN second line {i}", conclusion=f"SYN conclusion {i}",
                       recommendation=f"SYN recommendation {i}" if i == 0 else "")
        self.open()
        self.page.locator("#rows tr[data-uid]").first.click()
        self.wait(lambda: self.target() is not None, "a Reading Target")
        target = self.target()
        self.choose(UIDS[0])
        self.page.locator("#multi-selection-page").click()
        self.page.locator("#multi-selection-batch-approve").click()
        expect(self.dialog()).to_be_visible()
        expect(self.result_of(UIDS[3])).to_have_text("Skipped — 판독문이 없습니다")
        # The table shows Findings and Conclusion first lines; opening the row shows the three fields in full.
        expect(self.report_of(UIDS[0]).locator("summary")).to_have_text("Findings: SYN findings 0 · Conclusion: SYN conclusion 0")
        expect(self.report_of(UIDS[0]).locator('[data-batch-full="recommendation"]')).to_be_hidden()
        self.report_of(UIDS[0]).locator("summary").click()
        expect(self.report_of(UIDS[0]).locator('[data-batch-full="findings"] pre')).to_have_text("SYN findings 0\nSYN second line 0")
        expect(self.report_of(UIDS[0]).locator('[data-batch-full="recommendation"] pre')).to_have_text("SYN recommendation 0")
        shown = {uid: self.texts_of(uid) for uid in UIDS[:3]}
        approve = self.dialog().locator("[data-batch-save]")
        expect(approve).to_have_text("Approve 3 Studies")
        visible = self.page.evaluate("() => [...document.querySelectorAll('#rows tr[data-uid]')].map(tr => tr.dataset.uid)")
        before = len(self.site.flow_commits)
        self.approve()
        self.done()
        sent = self.site.flow_commits[before:]
        self.assertEqual([u for u in visible if u != UIDS[3]], [u for u, _ in sent])
        for uid, body in sent:
            self.assertEqual("approve", body["action"])
            self.assertEqual(REASON, body["reason"])
            self.assertEqual(shown[uid], {k: body[k] for k in FIELDS})
            self.assertEqual(UIDS.index(uid) + 1, body["baseVersion"])
            self.assertEqual(f"{self.site.epoch}:0", body["expectedRevision"])
            self.assertEqual(h.owner_of(h.RAD), body["expectedOwner"])
            for key in ("citationIds", "removeCitationIds", "structureIds"):
                self.assertNotIn(key, body)
        self.assertEqual([], self.commits_for(UIDS[3]))
        expect(self.note()).to_have_text("Approved 3 · Skipped 1 · Failed 0 · Unconfirmed 0")
        for uid in UIDS[:3]:
            expect(self.result_of(uid)).to_have_text("Approved")
            self.assertEqual("A", self.site.store[uid]["report"]["rs"])
            self.assertEqual({"action": "approve", "reason": REASON, "author": h.RAD["actor"]},
                             {k: self.site.history[uid][0][k] for k in ("action", "reason", "author")})
        self.assertEqual(target, self.target(), "the batch moved the Reading Target")
        self.dialog().locator("[data-batch-close]").click()
        expect(self.dialog()).to_be_hidden()

    def test_approved_on_hold_empty_and_my_draft_studies_send_nothing(self):
        self.saved(UIDS[0], version=2, rs="A", findings="SYN approved")
        self.saved(UIDS[1], version=1, rs="H", findings="SYN on hold")
        self.saved(UIDS[2], version=1, findings="  ", conclusion="\n")
        self.saved(UIDS[3], version=1, findings="SYN saved")
        st = self.site.store[UIDS[3]]
        st["revs"] += 1
        st["row"] = {"findings": "SYN my draft", "conclusion": "", "recommendation": "", "baseVersion": 1,
                     "citations": [], "structured": []}
        self.open()
        self.open_batch(*UIDS)
        expect(self.result_of(UIDS[0])).to_have_text("Skipped — 이미 승인된 검사입니다")
        expect(self.result_of(UIDS[1])).to_have_text("Skipped — 보류 중입니다")
        expect(self.result_of(UIDS[2])).to_have_text("Skipped — 판독문이 없습니다")
        expect(self.result_of(UIDS[3])).to_have_text("Skipped — 내 초안이 있습니다 — 열어서 확인하세요")
        approve = self.dialog().locator("[data-batch-save]")
        expect(approve).to_have_text("Approve 0 Studies")
        expect(approve).to_be_disabled()
        self.page.wait_for_timeout(200)
        self.assertEqual([], self.site.flow_commits)

    def test_a_preliminary_is_approved_only_by_its_designated_reviewer(self):
        me, other = h.RAD["actor"], h.RAD_OTHER["actor"]
        self.saved(UIDS[0], version=1, rs="P", author=other, findings="SYN prelim for me")
        self.site.prelim[UIDS[0]] = (other, me, None)
        self.saved(UIDS[1], version=1, rs="P", author=me, findings="SYN my prelim")
        self.site.prelim[UIDS[1]] = (me, other, None)
        self.saved(UIDS[2], version=1, rs="P", author=other, findings="SYN hidden prelim")
        self.site.prelim[UIDS[2]] = (other, "syn-rad3@synthetic.test", None)
        # Designated by account id: the listed reviewer name is this reader's former one, and the listed author name happens to
        # be this reader's current one. Names decide nothing on the page; the server's designation does.
        self.saved(UIDS[3], version=1, rs="P", author=other, findings="SYN prelim by account")
        self.site.prelim[UIDS[3]] = (me, "syn-rad-old-name@synthetic.test", h.RAD["sub"])
        self.open()
        self.open_batch(*UIDS)
        expect(self.result_of(UIDS[2])).to_have_text("Skipped — 다른 판독의의 예비 판독입니다")
        expect(self.dialog().locator("[data-batch-save]")).to_have_text("Approve 3 Studies")
        self.approve()
        self.done()
        self.assertEqual([UIDS[0], UIDS[1], UIDS[3]], [u for u, _ in self.site.flow_commits])
        self.assertEqual("SYN prelim for me", self.commits_for(UIDS[0])[0]["findings"])
        for uid in (UIDS[0], UIDS[3]):
            expect(self.result_of(uid)).to_have_text("Approved")
            self.assertEqual("A", self.site.store[uid]["report"]["rs"])
        # The author's own Preliminary: the server refuses it; that row alone fails and nothing is approved or signed.
        expect(self.result_of(UIDS[1])).to_have_text("Failed — SYN 예비 판독의 최종 승인은 지정된 상급 판독의만 할 수 있습니다")
        self.assertEqual("P", self.site.store[UIDS[1]]["report"]["rs"])
        self.assertEqual([], [v for v in self.site.history[UIDS[1]] if v["action"] == "approve"])

    # ── ⑤ a report saved after the dialog opened: 409, Failed, shown again, then approved as shown ──
    def test_a_report_saved_meanwhile_fails_and_is_shown_again_before_it_is_approved(self):
        self.saved(UIDS[0], version=1, findings="SYN A")
        self.saved(UIDS[1], version=1, findings="SYN B as first shown", conclusion="SYN B conclusion")
        self.open()
        self.open_batch(UIDS[0], UIDS[1])
        expect(self.report_of(UIDS[1]).locator("summary")).to_contain_text("SYN B as first shown")
        # Another reader saves B after the dialog captured it.
        self.site.saved_by_other(UIDS[1], {"findings": "SYN B rewritten", "conclusion": "SYN B new conclusion", "recommendation": ""})
        self.approve()
        self.done()
        expect(self.result_of(UIDS[0])).to_have_text("Approved")
        expect(self.result_of(UIDS[1])).to_contain_text("Failed")
        self.assertEqual("T", self.site.store[UIDS[1]]["report"]["rs"], "the text never shown was approved")
        expect(self.note()).to_have_text("Approved 1 · Skipped 0 · Failed 1 · Unconfirmed 0")
        before = len(self.site.flow_commits)
        self.dialog().locator("[data-batch-retry]").click()
        # Retry shows the new text and version first; it sends nothing by itself.
        expect(self.report_of(UIDS[1]).locator("summary")).to_have_text("Findings: SYN B rewritten · Conclusion: SYN B new conclusion")
        expect(self.result_of(UIDS[1])).to_have_text("Will Approve")
        expect(self.result_of(UIDS[0])).to_have_text("Approved")
        approve = self.dialog().locator("[data-batch-save]")
        expect(approve).to_have_text("Approve 1 Studies")
        self.page.wait_for_timeout(200)
        self.assertEqual(before, len(self.site.flow_commits), "Retry approved text it had not shown yet")
        approve.click()
        self.done()
        self.assertEqual([UIDS[1]], [u for u, _ in self.site.flow_commits[before:]])
        body = self.site.flow_commits[-1][1]
        self.assertEqual({"findings": "SYN B rewritten", "conclusion": "SYN B new conclusion", "recommendation": ""},
                         {k: body[k] for k in FIELDS})
        self.assertEqual(2, body["baseVersion"])
        expect(self.result_of(UIDS[1])).to_have_text("Approved")
        self.assertEqual("A", self.site.store[UIDS[1]]["report"]["rs"])
        self.assertEqual(1, len(self.commits_for(UIDS[0])), "the approved row was sent again")

    def test_a_draft_made_in_another_tab_skips_the_row_without_rebase(self):
        self.saved(UIDS[0], version=1, findings="SYN A")
        self.saved(UIDS[1], version=1, findings="SYN B")
        self.open()
        self.open_batch(UIDS[0], UIDS[1])
        st = self.site.store[UIDS[1]]
        st["revs"] += 1
        st["row"] = {"findings": "SYN other tab", "conclusion": "", "recommendation": "", "baseVersion": 1,
                     "citations": [], "structured": []}
        reads = len(self.site.flow_draft_reads)
        self.approve()
        self.done()
        expect(self.result_of(UIDS[1])).to_have_text("Skipped — 그 사이 초안이 바뀌었습니다")
        self.assertEqual(1, len(self.commits_for(UIDS[1])), "the conflicting row was sent again")
        self.assertNotIn(UIDS[1], self.site.flow_draft_reads[reads:], "the batch re-read the draft to re-base")
        self.assertEqual("T", self.site.store[UIDS[1]]["report"]["rs"])
        expect(self.result_of(UIDS[0])).to_have_text("Approved")

    # ── ⑥ a lost answer: the version list decides, never someone else's same-text save ──
    def test_a_lost_approve_found_in_the_version_list_is_approved(self):
        self.saved(UIDS[0], version=1, findings="SYN A")
        self.open()
        self.open_batch(UIDS[0])
        self.site.commit_answers = ["lost"]   # stored and signed, then the connection drops
        self.approve()
        self.done()
        expect(self.result_of(UIDS[0])).to_have_text("Approved")
        self.assertEqual([UIDS[0]], self.site.version_reads)
        self.assertEqual(1, len(self.commits_for(UIDS[0])))
        self.assertEqual("A", self.page.evaluate(f"() => appState['{UIDS[0]}'].rs"))

    def test_someone_elses_same_text_save_is_not_counted_as_my_approval(self):
        self.saved(UIDS[0], version=1, findings="SYN same text")
        self.open()
        self.open_batch(UIDS[0])
        # My approve's answer is lost and it never landed; another reader saved the very same text at the next version.
        self.site.saved_by_other(UIDS[0], {"findings": "SYN same text", "conclusion": "", "recommendation": ""})
        self.site.commit_answers = [(502, {"code": "SYN_GATEWAY"})]
        self.approve()
        self.done()
        expect(self.result_of(UIDS[0])).to_have_text("Failed — 그 사이 다른 판이 저장됐습니다")
        self.assertEqual("T", self.site.store[UIDS[0]]["report"]["rs"])
        # The failure is certain, so the study is not left "being confirmed": Retry shows it as it is now and it can be approved.
        self.assertFalse(self.page.evaluate(f"() => draftClient.uncertain('{UIDS[0]}')"))
        self.dialog().locator("[data-batch-retry]").click()
        expect(self.result_of(UIDS[0])).to_have_text("Will Approve")
        before = len(self.site.flow_commits)
        self.approve()
        self.done()
        self.assertEqual([UIDS[0]], [u for u, _ in self.site.flow_commits[before:]])
        self.assertEqual(2, self.site.flow_commits[-1][1]["baseVersion"])
        expect(self.result_of(UIDS[0])).to_have_text("Approved")

    def test_a_lost_answer_with_the_version_unchanged_stays_unconfirmed_and_a_late_success_is_not_called_failed(self):
        self.saved(UIDS[0], version=1, findings="SYN A")
        self.open()
        self.open_batch(UIDS[0])
        self.site.commit_answers = [(504, {"code": "SYN_GATEWAY"})]
        self.approve()
        self.done()
        expect(self.result_of(UIDS[0])).to_contain_text("Unconfirmed")
        expect(self.dialog().locator("[data-batch-retry]")).to_be_hidden()
        self.site.commit_of(UIDS[0], {**self.site.flow_commits[-1][1]}, h.RAD)   # it lands late
        self.page.wait_for_timeout(200)
        self.assertNotIn("Failed", self.result_of(UIDS[0]).text_content())
        self.assertTrue(self.page.evaluate(f"() => reportUnknownCommits.get('{UIDS[0]}')?.action === 'approve'"))

    # ── ⑧ a signing failure fails that row only; Retry never sends the Unconfirmed row (no second signature) ──
    def test_retry_sends_the_failed_row_only_and_never_the_unconfirmed_one(self):
        for uid in UIDS[:3]:
            self.saved(uid, version=1, findings=f"SYN {uid[-1]}")
        self.site.unsigned.add(UIDS[1])   # B's signing key is missing at first
        self.open()
        self.open_batch(*UIDS[:3])
        self.site.commit_answers = [(502, {"code": "SYN_GATEWAY", "message": "SYN"})]   # A: unknown, not stored
        self.approve()
        self.done()
        expect(self.result_of(UIDS[0])).to_contain_text("Unconfirmed")
        expect(self.result_of(UIDS[1])).to_contain_text("Failed")
        expect(self.result_of(UIDS[1])).to_contain_text("온라인 서명을 완료하지 못했습니다")
        expect(self.result_of(UIDS[2])).to_have_text("Approved")
        expect(self.note()).to_have_text("Approved 1 · Skipped 0 · Failed 1 · Unconfirmed 1")
        self.site.unsigned.clear()   # the key is registered
        self.dialog().locator("[data-batch-retry]").click()
        expect(self.result_of(UIDS[1])).to_have_text("Will Approve")
        expect(self.result_of(UIDS[0])).to_contain_text("Unconfirmed")
        before = len(self.site.flow_commits)
        self.approve()
        self.done()
        self.assertEqual([UIDS[1]], [u for u, _ in self.site.flow_commits[before:]])
        expect(self.result_of(UIDS[1])).to_have_text("Approved")
        self.assertEqual(1, len(self.commits_for(UIDS[0])), "the Unconfirmed row was sent twice")
        expect(self.note()).to_have_text("Approved 2 · Skipped 0 · Failed 0 · Unconfirmed 1")

    # ── ⑦ the study being edited is not part of the batch, and a success elsewhere never overwrites its text ──
    def test_the_study_being_edited_is_skipped_and_keeps_its_text(self):
        for uid in UIDS[:3]:
            self.saved(uid, version=1, findings=f"SYN saved {uid[-1]}")
        self.open()
        self.row(UIDS[2]).click()
        self.wait(lambda: self.target() == UIDS[2], "the Reading Target")
        expect(self.page.locator("#findings")).to_be_editable()
        self.page.locator("#findings").fill("SYN being written on C")
        self.open_batch(UIDS[0], UIDS[1], UIDS[2])
        expect(self.result_of(UIDS[2])).to_contain_text("Skipped")
        self.approve()
        self.done()
        expect(self.result_of(UIDS[0])).to_have_text("Approved")
        expect(self.result_of(UIDS[1])).to_have_text("Approved")
        self.assertEqual([], self.commits_for(UIDS[2]))
        self.assertEqual(UIDS[2], self.target())
        expect(self.page.locator("#findings")).to_have_value("SYN being written on C")


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    names = sys.argv[1:] or unittest.defaultTestLoader.getTestCaseNames(BatchApprovePage)
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(BatchApprovePage(n) for n in names))
    return 0 if result.wasSuccessful() and not result.skipped else 1


if __name__ == "__main__":
    raise SystemExit(main())
