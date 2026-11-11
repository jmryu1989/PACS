# coding: utf-8
"""FC-028 Batch Reading on the delivered split page (main.html, its bundle and every shipped asset); only HTTP is synthetic.

One of the reader's Reading Templates is saved to the selected Unread studies, one existing single-study commit (action save)
per study, in the visible order. BatchSite extends the report flow suite's FlowSite (several studies, each with its own
draft row, revision and report) with each study's version list (GET /studies/:uid/report/versions), which is what a lost
answer is checked against. No product file is modified.
"""
import sys
import time
import unittest

import auth_logout_dom_test as h
import report_flow_dom_test as rf
from playwright.sync_api import expect, sync_playwright

UIDS = [uid for uid, _, _ in rf.STUDIES]
NAMES = {uid: name for uid, name, _ in rf.STUDIES}
TEMPLATE = rf.TEMPLATE
TEXTS = {k: TEMPLATE[k] for k in rf.FIELDS}
REASON = "Batch Reading — " + TEMPLATE["title"]


class BatchSite(rf.FlowSite):
    """FlowSite plus each study's stored versions (newest first), as GET /studies/:uid/report/versions returns them."""

    def __init__(self, count=4):
        super().__init__(count)
        self.history = {uid: [] for uid, _, _ in self.flow}
        self.templates = [dict(TEMPLATE)]
        self.version_reads = []

    def commit_of(self, uid, body, account):
        status, answer = super().commit_of(uid, body, account)
        if status == 200:
            report = self.store[uid]["report"]
            self.history[uid].insert(0, {"id": len(self.history[uid]) + 1, "uid": uid, "version": report["version"],
                                         "action": body.get("action"), "reason": body.get("reason"),
                                         "author": account["actor"], "at": "2026-10-03T00:00:00.000Z",
                                         **{k: report.get(k, "") for k in rf.FIELDS}})
        return status, answer

    def saved_by_other(self, uid, texts, author="syn-rad2@synthetic.test", reason=None):
        """Another reader saves this study (the page has not seen it): the report, its version and the version list.
        This reader's own draft row and revision are untouched (drafts belong to their author)."""
        st = self.store[uid]
        st["report"] = {"version": st["report"]["version"] + 1, "rs": "T", **texts}
        self.history[uid].insert(0, {"id": 100 + st["report"]["version"], "uid": uid, "version": st["report"]["version"],
                                     "action": "save", "reason": reason, "author": author,
                                     "at": "2026-10-03T00:00:00.000Z", **texts})

    def api(self, route, request, method, path, query):
        prefix = "/api/studies/"
        if method == "GET" and path.startswith(prefix) and path.endswith("/report/versions"):
            uid = path[len(prefix):-len("/report/versions")]
            if uid in self.store:
                account, refused = self.authenticate(request)
                if refused:
                    return self.refuse(route, *refused)
                self.version_reads.append(uid)
                return route.fulfill(json=self.history[uid])
        return super().api(route, request, method, path, query)


class BatchReadingPage(unittest.TestCase):
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
        self.site = BatchSite(self.count)
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
        self.assertEqual([], self.site.violations, "requests the synthetic origin does not answer")

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
        return self.page.locator("#batch-report-dialog")

    def open_batch(self, *uids):
        self.choose(*uids)
        self.page.locator("#multi-selection-batch-read").click()
        expect(self.dialog()).to_be_visible()
        self.dialog().locator("[data-batch-template]").select_option("0")

    def save(self):
        self.dialog().locator("[data-batch-save]").click()

    def result_of(self, uid):
        return self.dialog().locator(f'tr[data-uid="{uid}"] [data-batch-result]')

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

    # ── ① the place: added after the existing entries, nothing renamed or moved ──
    def test_bar_and_selection_menu_add_batch_reading_after_the_existing_entries(self):
        self.open()
        self.choose(UIDS[0], UIDS[1])
        labels = self.page.evaluate("() => [...document.querySelectorAll('#worklist-selection > button')].map(b => b.textContent)")
        self.assertEqual(["Select Page", "Selection Details", "Clear Selection", "Open Selected Studies"],
                         [x for x in labels if x not in ("Preload", "Batch Reading")][:4])
        self.assertEqual("Batch Reading", labels[-1], labels)
        expect(self.page.locator("#multi-selection-batch-read")).to_be_enabled()
        self.right_click(UIDS[0])
        self.wait(lambda: self.menu_labels() is not None, "the selection menu")
        self.assertEqual(["Open Selected Studies", "Batch Reading"], self.menu_labels())
        before = len(self.site.calls)
        self.page.locator("#ctx [data-i]", has_text="Batch Reading").click()
        expect(self.dialog()).to_be_visible()
        self.assertEqual(None, self.target(), "the menu moved the Reading Target")
        self.assertEqual([], [c for c in self.site.calls[before:] if c[0] != "GET"], "opening the dialog wrote")
        # The Technician screen does not offer it.
        self.dialog().locator("[data-batch-cancel]").click()

    # ── ② W studies only, one save each, in the visible order, with the captured values ──
    def test_three_unread_studies_get_one_save_each_in_order_and_the_written_one_none(self):
        self.site.store[UIDS[3]]["report"] = {"version": 1, "rs": "T", "findings": "SYN written", "conclusion": "",
                                              "recommendation": ""}
        self.open()
        self.page.locator("#rows tr[data-uid]").first.click()
        self.wait(lambda: self.target() is not None, "a Reading Target")
        target = self.target()
        self.choose(UIDS[0])
        self.page.locator("#multi-selection-page").click()
        self.page.locator("#multi-selection-batch-read").click()
        expect(self.dialog()).to_be_visible()
        expect(self.result_of(UIDS[3])).to_have_text("Skipped — 이미 판독문이 있습니다")
        save = self.dialog().locator("[data-batch-save]")
        expect(save).to_be_disabled()   # no template chosen yet
        self.dialog().locator("[data-batch-template]").select_option("0")
        expect(self.dialog().locator('[data-batch-field="recommendation"]')).to_have_value(TEMPLATE["recommendation"])
        expect(save).to_have_text("Save to 3 Studies")
        visible = self.page.evaluate("() => [...document.querySelectorAll('#rows tr[data-uid]')].map(tr => tr.dataset.uid)")
        before = len(self.site.flow_commits)
        self.save()
        self.done()
        sent = self.site.flow_commits[before:]
        self.assertEqual([u for u in visible if u != UIDS[3]], [u for u, _ in sent])
        for uid, body in sent:
            self.assertEqual("save", body["action"])
            self.assertEqual(REASON, body["reason"])
            self.assertEqual(TEXTS, {k: body[k] for k in rf.FIELDS})
            self.assertEqual(0, body["baseVersion"])
            self.assertEqual(f"{self.site.epoch}:0", body["expectedRevision"])
            self.assertEqual(h.owner_of(h.RAD), body["expectedOwner"])
        self.assertEqual([], self.commits_for(UIDS[3]))
        expect(self.note()).to_have_text("Saved 3 · Skipped 1 · Failed 0 · Unconfirmed 0")
        self.assertEqual(target, self.target(), "the batch moved the Reading Target")
        for uid in UIDS[:3]:
            self.assertEqual("T", self.site.store[uid]["report"]["rs"])
            expect(self.row(uid)).to_have_class(rf.re.compile(r"st-t"))
        self.dialog().locator("[data-batch-close]").click()
        expect(self.dialog()).to_be_hidden()

    # ── ③ a 409 fails that row only; Retry re-reads it and does not send over text written meanwhile ──
    def test_a_conflict_fails_one_row_and_retry_skips_it_once_text_exists(self):
        self.open()
        self.open_batch(*UIDS[:3])
        # Another reader saves B after the dialog captured it.
        self.site.saved_by_other(UIDS[1], {"findings": "SYN other", "conclusion": "", "recommendation": ""})
        self.save()
        self.done()
        expect(self.result_of(UIDS[1])).to_contain_text("Failed")
        expect(self.result_of(UIDS[0])).to_have_text("Saved")
        expect(self.result_of(UIDS[2])).to_have_text("Saved")
        expect(self.note()).to_have_text("Saved 2 · Skipped 0 · Failed 1 · Unconfirmed 0")
        retry = self.dialog().locator("[data-batch-retry]")
        expect(retry).to_be_visible()
        self.wait(lambda: self.page.evaluate(f"() => appState['{UIDS[1]}']?.rs") == "T", "the list read after the run")
        before = len(self.site.flow_commits)
        retry.click()
        expect(self.result_of(UIDS[1])).to_have_text("Skipped — 이미 판독문이 있습니다")
        self.page.wait_for_timeout(200)
        self.assertEqual(before, len(self.site.flow_commits), "Retry sent over the text written meanwhile")
        self.assertEqual("SYN other", self.site.store[UIDS[1]]["report"]["findings"])

    def test_retry_sends_the_failed_row_only_and_never_the_unconfirmed_one(self):
        self.open()
        self.open_batch(*UIDS[:3])
        # A: the gateway answers for the server (result unknown, not stored); B: refused; C: saved.
        self.site.commit_answers = [(502, {"code": "SYN_GATEWAY", "message": "SYN"}),
                                    (503, {"code": "SYN_BUSY", "message": "SYN busy"}), "ok"]
        self.save()
        self.done()
        expect(self.result_of(UIDS[0])).to_contain_text("Unconfirmed")
        expect(self.result_of(UIDS[1])).to_contain_text("Failed")
        expect(self.result_of(UIDS[2])).to_have_text("Saved")
        self.assertIn(UIDS[0], self.site.version_reads, "the lost answer was not checked against the version list")
        expect(self.note()).to_have_text("Saved 1 · Skipped 0 · Failed 1 · Unconfirmed 1")
        before = len(self.site.flow_commits)
        self.dialog().locator("[data-batch-retry]").click()
        self.done()
        self.wait(lambda: len(self.site.flow_commits) > before, "the retried row")
        self.page.wait_for_timeout(200)
        self.assertEqual([UIDS[1]], [u for u, _ in self.site.flow_commits[before:]])
        expect(self.result_of(UIDS[1])).to_have_text("Saved")
        expect(self.result_of(UIDS[0])).to_contain_text("Unconfirmed")
        # The unconfirmed study is recorded: its next draft write or single commit reads the server first.
        self.assertTrue(self.page.evaluate(f"() => reportUnknownCommits.get('{UIDS[0]}')?.batch === true"))

    # ── ⑤ a draft made elsewhere, or an epoch change, after the dialog opened: no re-base, no re-send ──
    def test_a_draft_made_in_another_tab_skips_the_row_without_rebase(self):
        self.open()
        self.open_batch(UIDS[0], UIDS[1])
        # Another tab of the same reader writes a draft on B (revision moves; this page has not seen it).
        st = self.site.store[UIDS[1]]
        st["revs"] += 1
        st["row"] = {"findings": "SYN other tab", "conclusion": "", "recommendation": "", "baseVersion": 0,
                     "citations": [], "structured": []}
        reads = len(self.site.flow_draft_reads)
        self.save()
        self.done()
        expect(self.result_of(UIDS[1])).to_have_text("Skipped — 그 사이 초안이 바뀌었습니다")
        self.assertEqual(1, len(self.commits_for(UIDS[1])), "the conflicting row was sent again")
        self.assertNotIn(UIDS[1], self.site.flow_draft_reads[reads:], "the batch re-read the draft to re-base")
        self.assertEqual("SYN other tab", self.site.store[UIDS[1]]["row"]["findings"])
        expect(self.result_of(UIDS[0])).to_have_text("Saved")

    def test_an_epoch_change_seen_before_the_send_skips_every_row_without_a_request(self):
        self.open()
        self.open_batch(UIDS[0], UIDS[1])
        self.site.epoch = "SYN-EPOCH-2"
        self.page.evaluate("() => load()")
        self.wait(lambda: self.page.evaluate(f"() => appState['{UIDS[0]}']?.draftEpoch") == "SYN-EPOCH-2", "the new epoch")
        before = len(self.site.flow_commits)
        self.save()
        self.done()
        self.assertEqual(before, len(self.site.flow_commits))
        for uid in UIDS[:2]:
            expect(self.result_of(uid)).to_have_text("Skipped — 그 사이 초안이 바뀌었습니다")

    # ── ⑥ a lost answer: the version list decides, never a same-text save by someone else ──
    def test_a_lost_answer_found_in_the_version_list_is_saved(self):
        self.open()
        self.open_batch(UIDS[0])
        self.site.commit_answers = ["lost"]   # stored, then the connection drops
        self.save()
        self.done()
        expect(self.result_of(UIDS[0])).to_have_text("Saved")
        self.assertEqual([UIDS[0]], self.site.version_reads)
        self.assertEqual(1, len(self.commits_for(UIDS[0])))

    def test_someone_elses_same_text_save_is_not_counted_and_a_late_success_is_not_called_unsaved(self):
        self.open()
        self.open_batch(UIDS[0], UIDS[1])
        # A: another reader saved the very same template text (another reason); my request's answer is lost.
        self.site.saved_by_other(UIDS[0], dict(TEXTS), reason="SYN other batch")
        # B: my request's answer is lost and it has not landed yet.
        self.site.commit_answers = [(502, {"code": "SYN_GATEWAY"}), "hold"]
        self.save()
        self.wait(lambda: self.site.held_flow_commits, "B on the wire")
        self.site.finish_flow_commit(lost=True)   # B lands, its answer is lost
        self.done()
        expect(self.result_of(UIDS[0])).to_have_text("Failed — 그 사이 다른 판이 저장됐습니다")
        expect(self.result_of(UIDS[1])).to_have_text("Saved")

    def test_a_lost_answer_with_the_version_unchanged_stays_unconfirmed(self):
        self.open()
        self.open_batch(UIDS[0])
        self.site.commit_answers = [(504, {"code": "SYN_GATEWAY"})]
        self.save()
        self.done()
        expect(self.result_of(UIDS[0])).to_contain_text("Unconfirmed")
        expect(self.dialog().locator("[data-batch-retry]")).to_be_hidden()
        # It lands late (the server finished it after the gateway gave up): nothing ever called it unsaved.
        self.site.commit_of(UIDS[0], {**self.site.flow_commits[-1][1]}, h.RAD)
        self.assertNotIn("Failed", self.result_of(UIDS[0]).text_content())

    # ── ⑦ a success never overwrites the text being written in the editor ──
    def test_a_success_does_not_overwrite_the_study_being_edited(self):
        self.open()
        self.row(UIDS[2]).click()
        self.wait(lambda: self.target() == UIDS[2], "the Reading Target")
        expect(self.page.locator("#findings")).to_be_editable()
        self.page.locator("#findings").fill("SYN being written on C")
        self.open_batch(UIDS[0], UIDS[1], UIDS[2])
        expect(self.result_of(UIDS[2])).to_contain_text("Skipped")
        self.save()
        self.done()
        expect(self.result_of(UIDS[0])).to_have_text("Saved")
        expect(self.result_of(UIDS[1])).to_have_text("Saved")
        self.assertEqual([], self.commits_for(UIDS[2]))
        self.assertEqual(UIDS[2], self.target())
        expect(self.page.locator("#findings")).to_have_value("SYN being written on C")

    def test_a_to_b_to_a_while_a_is_on_the_wire_keeps_the_text_typed_after_return(self):
        self.open()
        self.open_batch(UIDS[0], UIDS[1])
        self.site.commit_answers = ["hold"]
        self.save()
        self.wait(lambda: self.site.held_flow_commits, "A on the wire")
        # A -> B -> A by the page's own select while A's save is out; the reader then types on A.
        self.page.evaluate(f"() => select('{UIDS[1]}')")
        self.wait(lambda: self.target() == UIDS[1], "B")
        self.page.evaluate(f"() => select('{UIDS[0]}')")
        self.wait(lambda: self.target() == UIDS[0], "A again")
        self.page.evaluate("() => { const f = document.querySelector('#findings'); f.value = 'SYN typed after return';"
                           " f.dispatchEvent(new Event('input', { bubbles: true })); }")
        origin = self.page.evaluate(f"() => reportBaseVersion('{UIDS[0]}', -1)")
        self.site.finish_flow_commit()
        self.done()
        expect(self.result_of(UIDS[0])).to_have_text("Saved")
        expect(self.page.locator("#findings")).to_have_value("SYN typed after return")
        self.assertEqual(origin, self.page.evaluate(f"() => reportBaseVersion('{UIDS[0]}', -1)"),
                         "the typed text was moved onto the template version it never showed")
        self.assertEqual("T", self.page.evaluate(f"() => appState['{UIDS[0]}'].rs"))

    # ── ⑨ while it runs: the single Approve is locked, the Reading Target stays ──
    def test_while_running_approve_is_locked_and_the_target_stays(self):
        self.open()
        self.row(UIDS[3]).click()
        self.wait(lambda: self.target() == UIDS[3], "the Reading Target")
        expect(self.page.locator("#b-approve")).to_be_enabled()
        self.open_batch(UIDS[0], UIDS[1])
        self.site.commit_answers = ["hold"]
        self.save()
        self.wait(lambda: self.site.held_flow_commits, "the first save on the wire")
        self.assertTrue(self.page.evaluate("() => document.querySelector('#b-approve').disabled"))
        self.assertTrue(self.page.evaluate("() => commitInFlight"))
        self.assertEqual(UIDS[3], self.target())
        self.site.finish_flow_commit()
        self.done()
        self.assertFalse(self.page.evaluate("() => commitInFlight"))
        self.assertEqual(UIDS[3], self.target())
        expect(self.page.locator("#b-approve")).to_be_enabled()

    # ── the selection changed after the dialog opened: nothing is sent ──
    def test_a_changed_selection_sends_nothing(self):
        self.open()
        self.open_batch(UIDS[0], UIDS[1])
        self.site.hidden.add(UIDS[1])   # B leaves the list; the selection drops it (a new generation)
        self.page.evaluate("() => load()")
        self.wait(lambda: not self.page.evaluate(f"() => studies.some(s => s.uid === '{UIDS[1]}')"), "B gone")
        self.save()
        expect(self.note()).to_have_text("선택이 바뀌었습니다 — 다시 여세요")
        self.page.wait_for_timeout(200)
        self.assertEqual([], self.site.flow_commits)

    def test_an_empty_template_is_not_offered_for_saving(self):
        self.site.templates = [{**TEMPLATE, "findings": "", "conclusion": " ", "recommendation": ""}]
        self.open()
        self.open_batch(UIDS[0])
        expect(self.dialog().locator("[data-batch-save]")).to_be_disabled()
        self.assertEqual([], self.site.flow_commits)


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    names = sys.argv[1:] or unittest.defaultTestLoader.getTestCaseNames(BatchReadingPage)
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(BatchReadingPage(n) for n in names))
    return 0 if result.wasSuccessful() and not result.skipped else 1


if __name__ == "__main__":
    raise SystemExit(main())
