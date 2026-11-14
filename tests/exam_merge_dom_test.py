# coding: utf-8
"""Merge Exam · Split / Unmerge on the delivered split page (exam-merge.js and the list's merged-exam row).

The delivered page (main.html, its bundle and every shipped asset) against the synthetic origin of report_flow_dom_test;
no stack, no product file is modified. MergeSite adds the exam-group routes and answers the list as the server does: a
merged exam is its base row (Count and Series of all its studies, `group` with each study) and the other studies are gone.

  - the two buttons sit right after Unverify in the Technician button row;
  - Merge Exam: the selected study is Base, the same patient's same-day study is ticked, another patient's is not; ticking
    it refuses on the spot (orange line, Merge off) and unticking brings the result line back; the Base can be changed; Merge
    sends the ticked studies and the Base, the list is read again and the base row shows `Merged ×N · M img`;
  - a server refusal is shown in the window, which stays open;
  - Split / Unmerge: the original studies with their own Series / Images, the server's checks (✓ / ✗, Unmerge off while one
    fails), Unmerge sends the group's id and the list shows the studies again; a study that is not merged says so;
  - the Accession No filter finds a merged exam by a merged study's number; the viewer opens all its studies as one.
"""
import json
import re
import unittest

import auth_logout_dom_test as h
import report_flow_dom_test as rf
from playwright.sync_api import expect, sync_playwright

TECH = {**h.RAD, "sub": "SYN-TECH-SUB", "actor": "syn-tech@synthetic.test", "user": "syn-tech@synthetic.test",
        "displayName": "SYN Technician", "roles": ["technician"]}
ACC = {h.UID: "SYNACC-A1", h.UID_B: "SYNACC-A2", rf.UID_C: "SYNACC-C1"}
COUNT = {h.UID: 8, h.UID_B: 12, rf.UID_C: 5}
GROUP_ID = "00000000-0000-4000-8000-00000000b001"


class MergeSite(rf.FlowSite):
    def __init__(self):
        super().__init__(3)
        # Two studies of one patient on one day, and another patient's.
        self.flow = ((h.UID, h.PATIENT, "SYN-P-001"), (h.UID_B, h.PATIENT, "SYN-P-001"), (rf.UID_C, rf.PATIENT_C, "SYN-P-003"))
        self.groups = {}                # base uid -> [uids, base first]
        self.sent = []                  # (method, path, body)
        self.merge_refusal = None       # (status, body) of the next merge
        self.checks = [{"rule": "approved", "ok": True, "message": "No report of the merged exam is approved now.", "uids": []},
                       {"rule": "transfer", "ok": True, "message": "No transfer or export of these studies is in progress.", "uids": []},
                       {"rule": "held", "ok": True, "message": "No one is writing a report on the merged exam now.", "uids": []}]

    def list_body(self, account, rename=None):
        body = super().list_body(account, rename)
        rows = {row["uid"]: row for row in body["studies"]}
        for uid, row in rows.items():
            row.update(acc=ACC[uid], count=COUNT[uid], series=1)
        hidden = {uid for members in self.groups.values() for uid in members[1:]}
        for base, members in self.groups.items():
            row = rows[base]
            row["group"] = {"id": GROUP_ID, "kind": "merge", "baseUid": base, "members": [
                {"uid": uid, "acc": ACC[uid], "date": "20261003", "time": "", "desc": "SYN CT CHEST", "modality": "CT",
                 "count": COUNT[uid], "series": 1} for uid in members]}
            row["count"] = sum(COUNT[uid] for uid in members)
            row["series"] = len(members)
        body["studies"] = [row for row in body["studies"] if row["uid"] not in hidden]
        body["pagination"]["total"] = len(body["studies"])
        return body

    def api(self, route, request, method, path, query):
        if path.startswith("/api/exam-groups") or re.fullmatch(r"/api/studies/[^/]+/exam-group", path):
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            body = request.post_data_json if method == "POST" else None
            self.sent.append((method, path, body))
            if method == "POST" and path == "/api/exam-groups":
                if self.merge_refusal:
                    return self.answer(route, *self.merge_refusal)
                self.groups[body["baseUid"]] = [body["baseUid"], *[u for u in body["uids"] if u != body["baseUid"]]]
                return route.fulfill(json={"group": {"id": GROUP_ID, "kind": "merge", "baseUid": body["baseUid"], "members": []}})
            found = re.fullmatch(r"/api/studies/([^/]+)/exam-group", path)
            if method == "GET" and found:
                base = found.group(1)
                if base not in self.groups:
                    return route.fulfill(json={"group": None})
                return route.fulfill(json={"group": {"id": GROUP_ID, "kind": "merge", "baseUid": base, "members": [
                    {"logicalUid": u, "studyUid": u, "part": i, "seriesUids": []} for i, u in enumerate(self.groups[base])]},
                    "checks": self.checks})
            if method == "POST" and path == f"/api/exam-groups/{GROUP_ID}/dissolve":
                self.groups.clear()
                return route.fulfill(json={"group": {"id": GROUP_ID, "dissolvedAt": "2026-10-03T01:00:00.000Z"}})
        return super().api(route, request, method, path, query)


class ExamMerge(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = MergeSite()
        self.site.account = TECH
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR", timezone_id="Asia/Seoul")
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.errors, self.dialogs = [], []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", lambda dialog: (self.dialogs.append(dialog.message), dialog.accept()))
        self.page.goto(h.MAIN_URL)
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(3)
        tab = self.page.locator("[data-tab=Technician]")
        if tab.is_visible():
            tab.click()

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.site.violations, "requests the synthetic origin does not answer")
        self.assertEqual([], self.dialogs, "no browser confirm or alert")

    # ── helpers ──
    def pick(self, uid):
        self.page.locator(f"#rows tr[data-uid='{uid}']").click()
        self.page.wait_for_function(f"() => selectedUid === {json.dumps(uid)}")

    def window(self, name):
        return self.page.locator(f"dialog[data-exam-window='{name}']")

    def row_of(self, window, uid):
        return window.locator(f"tbody tr[data-uid='{uid}']")

    def result(self, window):
        return window.locator(".exam-merge-result")

    # ── cases ──
    def test_buttons_sit_right_after_unverify(self):
        labels = self.page.eval_on_selector_all("#ctxbtns > button:not([hidden])", "b => b.map(x => x.textContent.trim())")
        at = labels.index("Unverify")
        self.assertEqual(["Unverify", "Merge Exam", "Split / Unmerge"], labels[at:at + 3])
        expect(self.page.locator("#t-merge-exam")).to_be_enabled()
        # The old hidden Split Exam button is left as it was.
        self.assertEqual(1, self.page.locator("#ctxbtns > button[hidden][disabled]", has_text="Split Exam").count())

    def test_merge_window_refuses_another_patient_on_the_spot_then_merges_on_the_chosen_base(self):
        self.pick(h.UID)
        self.page.locator("#t-merge-exam").click()
        win = self.window("merge")
        expect(win).to_be_visible()
        base_a, base_b, other = (self.row_of(win, u) for u in (h.UID, h.UID_B, rf.UID_C))
        expect(base_a.locator("input[type=radio]")).to_be_checked()
        expect(base_a.locator("input[type=checkbox]")).to_be_checked()
        expect(base_b.locator("input[type=checkbox]")).to_be_checked()
        expect(other.locator("input[type=checkbox]")).not_to_be_checked()
        expect(base_b).to_contain_text("1 / 12")
        expect(self.result(win)).to_contain_text("Result: 1 exam (base SYNACC-A1, 2026-10-03) with 2 series, 20 images.")
        expect(self.result(win)).to_contain_text("The original grouping of 2 studies is kept so Unmerge can restore it.")
        expect(self.result(win)).to_contain_text("Query/Retrieve, export and the hospital EMR keep the original studies.")
        merge = win.locator(".order-dialog-foot button", has_text=re.compile("^Merge$"))
        expect(merge).to_be_enabled()
        # Another patient's study: refused at once.
        other.locator("input[type=checkbox]").check()
        expect(self.result(win)).to_have_text("Cannot merge studies from different patients (SYN-P-001, SYN-P-003).")
        expect(merge).to_be_disabled()
        other.locator("input[type=checkbox]").uncheck()
        expect(self.result(win)).to_contain_text("with 2 series, 20 images")
        expect(merge).to_be_enabled()
        # The Base moves to the second study.
        base_b.locator("input[type=radio]").check()
        expect(self.result(win)).to_contain_text("(base SYNACC-A2, 2026-10-03)")
        merge.click()
        expect(win).to_contain_text("Merged: 2 exams → SYNACC-A2 (SYNACC-A1 8 images + SYNACC-A2 12 images = 20 images).")
        self.assertEqual([("POST", "/api/exam-groups", {"baseUid": h.UID_B, "uids": [h.UID, h.UID_B]})], self.site.sent)
        win.locator("button", has_text="Close").click()
        expect(win).to_have_count(0)
        # The list: the merged exam's base row only, with its badge next to its Accession No.
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(2)
        badge = self.page.locator(f"#rows tr[data-uid='{h.UID_B}'] td.acc .exam-merged")
        expect(badge).to_have_text("Merged ×2 · 20 img")
        self.assertIn("SYNACC-A1", badge.get_attribute("title"))
        expect(self.page.locator("#countlist")).to_contain_text("Total 2")

    def test_server_refusal_is_shown_and_the_window_stays_open(self):
        self.site.merge_refusal = (409, {"code": "EXAM_GROUP_REFUSED", "message": "SYN refused",
                                         "refusals": [{"uid": h.UID_B, "rule": "reported", "message": "This study has a report (RS T). Reset the report to Unread first."}]})
        self.pick(h.UID)
        self.page.locator("#t-merge-exam").click()
        win = self.window("merge")
        win.locator(".order-dialog-foot button", has_text=re.compile("^Merge$")).click()
        expect(win.locator(".exam-merge-refused")).to_have_text("This study has a report (RS T). Reset the report to Unread first.")
        expect(win.locator(".order-dialog-foot button", has_text=re.compile("^Merge$"))).to_be_enabled()
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(3)

    def test_split_unmerge_restores_a_merged_exam_and_says_so_for_others(self):
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        self.page.evaluate("() => load()")
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(2)
        self.pick(rf.UID_C)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        expect(win).to_contain_text(f"{rf.PATIENT_C} SYN-P-003: this study is not a merged exam.")
        win.locator("button", has_text="Close").click()
        self.pick(h.UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        cells = win.locator("table tbody tr").evaluate_all("rows => rows.map(r => [...r.children].map(td => td.textContent))")
        self.assertEqual([["SYNACC-A1", "20261003", "SYN CT CHEST", "1 / 8"], ["SYNACC-A2", "20261003", "SYN CT CHEST", "1 / 12"]], cells)
        expect(win.locator(".exam-merge-checks li")).to_have_text([
            "✓ No report of the merged exam is approved now.", "✓ No transfer or export of these studies is in progress.",
            "✓ No one is writing a report on the merged exam now."])
        unmerge = win.locator(".order-dialog-foot button", has_text="Unmerge")
        expect(unmerge).to_be_enabled()
        unmerge.click()
        expect(win).to_contain_text("Unmerged: 2 original exams restored (SYNACC-A1 8 images, SYNACC-A2 12 images).")
        self.assertIn(("POST", f"/api/exam-groups/{GROUP_ID}/dissolve", None), self.site.sent)
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(3)
        expect(self.page.locator("#rows .exam-merged")).to_have_count(0)

    def test_unmerge_is_off_while_a_check_fails(self):
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        self.site.checks[0] = {"rule": "approved", "ok": False, "uids": [h.UID],
                               "message": "This study has an approved report. Reset the report to Unread first."}
        self.page.evaluate("() => load()")
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(2)
        self.pick(h.UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        expect(win.locator(".exam-merge-checks li").first).to_have_text("✗ This study has an approved report. Reset the report to Unread first.")
        expect(win.locator(".order-dialog-foot button", has_text="Unmerge")).to_be_disabled()
        self.assertFalse(any(m == "POST" for m, _, _ in self.site.sent))

    def test_accession_filter_finds_the_merged_exam_and_the_viewer_opens_all_its_studies(self):
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        self.page.evaluate("() => load()")
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(2)
        self.page.evaluate("() => { fval.acc = 'SYNACC-A2'; render(); }")
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(1)
        expect(self.page.locator(f"#rows tr[data-uid='{h.UID}']")).to_have_count(1)
        self.page.evaluate("() => { fval.acc = ''; render(); }")
        self.assertEqual([h.UID, h.UID_B], self.page.evaluate(f"() => mergedStudies({json.dumps(h.UID)})"))
        self.assertIsNone(self.page.evaluate(f"() => mergedStudies({json.dumps(rf.UID_C)})"))


if __name__ == "__main__":
    unittest.main()
