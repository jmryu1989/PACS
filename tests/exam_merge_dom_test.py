# coding: utf-8
"""Merge Exam · Split / Unmerge on the delivered split page (exam-merge.js and the list's merged-exam row).

The delivered page (main.html, its bundle and every shipped asset) against the synthetic origin of report_flow_dom_test;
no stack, no product file is modified. MergeSite adds the exam-group routes and answers the list as the server does: a
merged exam is its base row with server examScope and sourceMetadata, and the other source rows are hidden.

  - the two buttons sit right after Unverify in the Technician button row;
  - Merge Exam: the selected study is Base, the same patient's same-day study is ticked, another patient's is not; ticking
    it refuses on the spot (orange line, Merge off) and unticking brings the result line back; the Base can be changed; Merge
    sends the ticked studies and the Base, the list is read again and the base row shows `Merged ×N · M img`;
  - a server refusal is shown in the window, which stays open;
  - Split / Unmerge: the original studies with their own Series / Images, the server's checks (✓ / ✗, Unmerge off while one
    fails), Unmerge sends the group's id and the list shows the studies again; an original exam can split whole series;
  - filters find either original, scope changes invalidate old dialogs, and original export requires an explicit choice.
"""
import json
import re
import unittest
from urllib.parse import urlparse, parse_qs

import auth_logout_dom_test as h
import report_flow_dom_test as rf
from playwright.sync_api import expect, sync_playwright

TECH = {**h.RAD, "sub": "SYN-TECH-SUB", "actor": "syn-tech@synthetic.test", "user": "syn-tech@synthetic.test",
        "displayName": "SYN Technician", "roles": ["technician"]}
ACC = {h.UID: "SYNACC-A1", h.UID_B: "SYNACC-A2", rf.UID_C: "SYNACC-C1"}
COUNT = {h.UID: 8, h.UID_B: 12, rf.UID_C: 5}
GROUP_ID = "00000000-0000-4000-8000-00000000b001"
SPLIT_UID = "1.2.826.0.1.3680043.10.777.200"
SERIES = [h.UID + ".101", h.UID + ".102"]


class MergeSite(rf.FlowSite):
    def __init__(self):
        super().__init__(3)
        # Two studies of one patient on one day, and another patient's.
        self.flow = ((h.UID, h.PATIENT, "SYN-P-001"), (h.UID_B, h.PATIENT, "SYN-P-001"), (rf.UID_C, rf.PATIENT_C, "SYN-P-003"))
        self.groups = {}                # base uid -> [uids, base first]
        self.split = None
        self.generation = 0
        self.held_scope = None
        self.dissolve_refusal = None
        self.sent = []                  # (method, path, body)
        self.merge_refusal = None       # (status, body) of the next merge
        self.checks = [{"rule": "approved", "ok": True, "message": "합친 검사에 지금 승인된 판독문이 없습니다.", "uids": []},
                       {"rule": "transfer", "ok": True, "message": "이 검사들의 전송·내보내기가 진행 중이지 않습니다.", "uids": []},
                       {"rule": "held", "ok": True, "message": "합친 검사의 판독문을 쓰는 사람이 없습니다.", "uids": []}]
        self.report_groups = {}         # uid -> reportGroup of the row (a report written on a merged exam)

    def scope(self, uid):
        if self.split and uid in (self.split["uid"], SPLIT_UID):
            part = int(uid == SPLIT_UID)
            return {"reportUid": uid, "groupId": GROUP_ID, "kind": "split", "active": True, "part": part,
                    "generation": str(self.generation), "sources": [{"studyUid": self.split["uid"],
                    "series": {"mode": "include" if part else "exclude", "uids": self.split["seriesUids"]}}]}
        return {"reportUid": uid, "groupId": GROUP_ID if uid in self.groups else None,
                "kind": "merge" if uid in self.groups else "single", "part": None, "active": True,
                "generation": str(self.generation), "sources": [{"studyUid": source, "series": {"mode": "all", "uids": []}}
                                                               for source in self.groups.get(uid, [uid])]}

    def handle(self, route, request):
        path = urlparse(request.url).path
        if path == f"/dicom-web/studies/{h.UID}/series":
            return route.fulfill(json=[{"0020000D": {"Value": [h.UID]}, "0020000E": {"Value": [uid]},
                                       "00200011": {"Value": [i + 1]}, "0008103E": {"Value": [f"SYN Series {i + 1}"]},
                                       "00080060": {"Value": ["CT"]}, "00201209": {"Value": [4]}}
                                      for i, uid in enumerate(SERIES)])
        if path == f"/dicom-web/studies/{rf.UID_C}/series":
            return route.fulfill(json=[])
        return super().handle(route, request)

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
            row["examScope"] = self.scope(base)
            row["sourceMetadata"] = row["group"]["members"]
        if self.split:
            source = rows[self.split["uid"]]
            original = {**source}
            second = {**source, "uid": SPLIT_UID, "state": {**source["state"]}}
            for row in (source, second):
                row.update(examScope=self.scope(row["uid"]), sourceMetadata=[original], count=4, series=1)
            body["studies"].append(second)
        for uid, group in self.report_groups.items():
            if uid in rows:
                rows[uid]["reportGroup"] = group
                if group.get("readable"):
                    rows[uid]["reportScope"] = {**self.scope(uid), "kind": "merge", "groupId": group["id"], "active": group["active"],
                        "sources": [{"studyUid": u, "series": {"mode": "all", "uids": []}} for u in group["studies"]]}
        body["studies"] = [row for row in body["studies"] if row["uid"] not in hidden]
        body["pagination"]["total"] = len(body["studies"])
        return body

    def api(self, route, request, method, path, query):
        found = re.fullmatch(r"/api/studies/([^/]+)/exam-scope", path)
        if found and method == "GET":
            if self.held_scope is not None:
                self.held_scope.append((route,self.scope(found.group(1))))
                return None
            return route.fulfill(json=self.scope(found.group(1)))
        if path.startswith("/api/exam-groups") or re.fullmatch(r"/api/studies/[^/]+/exam-group", path):
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            body = request.post_data_json if method == "POST" else None
            self.sent.append((method, path, body))
            if method == "POST" and path == "/api/exam-groups/split":
                self.split = body
                self.generation += 1
                return route.fulfill(json={"group": {"id": GROUP_ID, "kind": "split"}})
            if method == "POST" and path == "/api/exam-groups":
                if self.merge_refusal:
                    return self.answer(route, *self.merge_refusal)
                self.groups[body["baseUid"]] = [body["baseUid"], *[u for u in body["uids"] if u != body["baseUid"]]]
                self.generation += 1
                return route.fulfill(json={"group": {"id": GROUP_ID, "kind": "merge", "baseUid": body["baseUid"], "members": []}})
            found = re.fullmatch(r"/api/studies/([^/]+)/exam-group", path)
            if method == "GET" and found:
                base = found.group(1)
                if self.split and base in (self.split["uid"], SPLIT_UID):
                    return route.fulfill(json={"group": {"id": GROUP_ID, "kind": "split"}, "checks": self.checks})
                if base not in self.groups:
                    return route.fulfill(json={"group": None})
                return route.fulfill(json={"group": {"id": GROUP_ID, "kind": "merge", "baseUid": base, "members": [
                    {"logicalUid": u, "studyUid": u, "part": i, "seriesUids": []} for i, u in enumerate(self.groups[base])]},
                    "checks": self.checks})
            if method == "POST" and path == f"/api/exam-groups/{GROUP_ID}/dissolve":
                if self.dissolve_refusal:
                    return self.answer(route, *self.dissolve_refusal)
                self.groups.clear()
                self.split = None
                self.generation += 1
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
        expect(self.result(win)).to_contain_text("결과: 검사 1건 (기준 SYNACC-A1, 2026-10-03) · 시리즈 2 · 영상 20.")
        expect(self.result(win)).to_contain_text("원래 검사 2건의 연결은 보존합니다.")
        expect(self.result(win)).to_contain_text("Query/Retrieve와 원본 내보내기는 원래 검사 단위입니다.")
        merge = win.locator(".order-dialog-foot button", has_text=re.compile("^Merge$"))
        expect(merge).to_be_enabled()
        # Another patient's study: refused at once.
        other.locator("input[type=checkbox]").check()
        expect(self.result(win)).to_have_text("다른 환자의 검사는 합칠 수 없습니다 (SYN-P-001, SYN-P-003).")
        expect(merge).to_be_disabled()
        other.locator("input[type=checkbox]").uncheck()
        expect(self.result(win)).to_contain_text("· 시리즈 2 · 영상 20.")
        expect(merge).to_be_enabled()
        # The Base moves to the second study.
        base_b.locator("input[type=radio]").check()
        expect(self.result(win)).to_contain_text("(기준 SYNACC-A2, 2026-10-03)")
        merge.click()
        expect(win).to_contain_text("합쳤습니다: 검사 2건 → SYNACC-A2 · 20장.")
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
                                         "refusals": [{"uid": h.UID_B, "rule": "reported", "message": "판독문이 있습니다(RS T). 먼저 판독 취소(Reset)를 하세요."}]})
        self.pick(h.UID)
        self.page.locator("#t-merge-exam").click()
        win = self.window("merge")
        win.locator(".order-dialog-foot button", has_text=re.compile("^Merge$")).click()
        expect(win.locator(".exam-merge-refused")).to_have_text("SYNACC-A2: 판독문이 있습니다(RS T). 먼저 판독 취소(Reset)를 하세요.")
        expect(win.locator(".order-dialog-foot button", has_text=re.compile("^Merge$"))).to_be_enabled()
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(3)

    def test_split_unmerge_restores_a_merged_exam_and_says_so_for_others(self):
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        self.page.evaluate("() => load()")
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(2)
        self.pick(rf.UID_C)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        expect(win).to_contain_text("나눌 수 있는 영상 시리즈가 두 개 이상 필요합니다.")
        expect(win.get_by_role("button", name="Split", exact=True)).to_be_disabled()
        win.locator("button", has_text="Close").click()
        self.pick(h.UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        cells = win.locator("table tbody tr").evaluate_all("rows => rows.map(r => [...r.children].map(td => td.textContent))")
        self.assertEqual([["SYNACC-A1", "2026-10-03", "SYN CT CHEST", "1 / 8"], ["SYNACC-A2", "2026-10-03", "SYN CT CHEST", "1 / 12"]], cells)
        expect(win.locator(".exam-merge-checks li")).to_have_text([
            "✓ 합친 검사에 지금 승인된 판독문이 없습니다.", "✓ 이 검사들의 전송·내보내기가 진행 중이지 않습니다.",
            "✓ 합친 검사의 판독문을 쓰는 사람이 없습니다."])
        unmerge = win.locator(".order-dialog-foot button", has_text="Unmerge")
        expect(unmerge).to_be_enabled()
        unmerge.click()
        expect(win).to_contain_text("원본 영상과 기존 판독 이력은 보존했습니다.")
        self.assertIn(("POST", f"/api/exam-groups/{GROUP_ID}/dissolve", None), self.site.sent)
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(3)
        expect(self.page.locator("#rows .exam-merged")).to_have_count(0)

    def test_unmerge_is_off_while_a_check_fails(self):
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        self.site.checks[0] = {"rule": "approved", "ok": False, "uids": [h.UID],
                               "message": "승인된 판독문이 있습니다. 먼저 판독 취소(Reset)를 하세요."}
        self.page.evaluate("() => load()")
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(2)
        self.pick(h.UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        expect(win.locator(".exam-merge-checks li").first).to_have_text("✗ 승인된 판독문이 있습니다. 먼저 판독 취소(Reset)를 하세요.")
        expect(win.locator(".order-dialog-foot button", has_text="Unmerge")).to_be_disabled()
        self.assertFalse(any(m == "POST" for m, _, _ in self.site.sent))

    def test_accession_filter_finds_the_merged_exam_by_either_original(self):
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        self.page.evaluate("() => load()")
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(2)
        self.page.evaluate("() => { fval.acc = 'SYNACC-A2'; render(); }")
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(1)
        expect(self.page.locator(f"#rows tr[data-uid='{h.UID}']")).to_have_count(1)
        self.page.evaluate("() => { fval.acc = ''; render(); }")

    def test_report_scope_line_says_which_exam_the_report_is_written_on(self):
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        self.site.report_groups[rf.UID_C] = {"id": GROUP_ID, "active": False, "readable": True, "studies": [rf.UID_C, h.UID]}
        self.page.evaluate("() => load()")
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(2)
        scope = self.page.locator(".exam-report-scope")
        self.pick(h.UID)
        self.page.evaluate("() => setMode('Radiology')")
        expect(scope).to_be_visible()
        expect(scope).to_contain_text("Merged exam — SYNACC-A1 + SYNACC-A2")
        expect(scope.get_by_role("button", name="Report History · SYNACC-A2")).to_be_visible()
        self.pick(rf.UID_C)
        expect(scope).to_contain_text("지금은 되돌린 범위의 판독입니다.")
        self.site.report_groups[rf.UID_C] = {"id": GROUP_ID, "active": False, "readable": False, "studies": []}
        self.page.evaluate("() => load()")
        expect(scope).to_contain_text("저장된 판독 범위 일부를 볼 수 없어 본문을 보이지 않습니다.")

    def test_split_selects_whole_series_and_unsplit_restores_one_original(self):
        self.pick(h.UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        go = win.get_by_role("button", name="Split", exact=True)
        expect(go).to_be_disabled()
        win.get_by_role("checkbox", name="Split SYN Series 2").check()
        expect(go).to_be_enabled()
        expect(win).to_contain_text("Exam 1: 시리즈 1 · 영상 4 / Exam 2: 시리즈 1 · 영상 4")
        go.click()
        expect(win).to_contain_text("나눴습니다.")
        self.assertIn(("POST", "/api/exam-groups/split", {"uid": h.UID, "seriesUids": [SERIES[1]]}), self.site.sent)
        win.get_by_role("button", name="Close", exact=True).click()
        expect(self.page.locator("#rows .exam-merged")).to_have_text(["Split 1/2", "Split 2/2"])
        self.pick(SPLIT_UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        win.get_by_role("button", name="Unsplit", exact=True).click()
        expect(win).to_contain_text("기존 판독 이력은 보존했습니다.")
        expect(self.page.locator(f"#rows tr[data-uid='{SPLIT_UID}']")).to_have_count(0)

    def test_split_rechecks_generation_before_sending_without_losing_selection(self):
        self.pick(h.UID)
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        win.get_by_role("checkbox", name="Split SYN Series 2").check()
        self.site.generation += 1
        win.get_by_role("button", name="Split", exact=True).click()
        expect(win.locator(".exam-merge-refused")).to_contain_text("검사 범위가 바뀌었습니다")
        expect(win.get_by_role("checkbox", name="Split SYN Series 2")).to_be_checked()
        self.assertFalse(any(m == "POST" for m, _, _ in self.site.sent))

    def test_old_split_scope_reply_is_dropped_after_selection_returns_to_the_same_uid(self):
        self.pick(h.UID)
        self.site.held_scope=[]
        with self.page.expect_request(re.compile(r"/exam-scope\?")):
            self.page.locator("#t-split-unmerge").click()
        self.assertEqual(1,len(self.site.held_scope))
        self.page.evaluate("async uids => { await select(uids[0]); await select(uids[1]); }",[rf.UID_C,h.UID])
        route,scope=self.site.held_scope[0]
        route.fulfill(json=scope)
        expect(self.window("unmerge")).to_have_count(0)
        self.assertFalse(any(m=="POST" for m,_,_ in self.site.sent))

    def test_download_originals_requires_explicit_sources_for_a_merged_exam(self):
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        self.page.evaluate("() => load()")
        self.pick(h.UID)
        self.page.locator(f"#rows tr[data-uid='{h.UID}']").click(button="right")
        self.page.get_by_text("Download Originals", exact=True).click()
        dialog=self.page.get_by_role("dialog").filter(has_text="Download Originals")
        expect(dialog.get_by_role("checkbox")).to_have_count(2)
        expect(dialog.get_by_role("button",name="Continue",exact=True)).to_be_disabled()
        dialog.get_by_role("checkbox").nth(1).check()
        expect(dialog.get_by_role("button",name="Continue",exact=True)).to_be_enabled()
        expect(dialog).to_contain_text("SYNACC-A2")
        dialog.get_by_role("button",name="Cancel",exact=True).click()
        self.assertFalse(any(m=="POST" for m,_,_ in self.site.sent))

    def test_unmerge_refusal_can_be_retried_and_selection_change_closes_old_dialog(self):
        self.site.groups[h.UID] = [h.UID, h.UID_B]
        self.page.evaluate("() => load()")
        self.pick(h.UID)
        self.site.dissolve_refusal = (409, {"message": "SYN draft is occupied"})
        self.page.locator("#t-split-unmerge").click()
        win = self.window("unmerge")
        go = win.get_by_role("button", name="Unmerge", exact=True)
        go.click()
        expect(win.locator(".exam-merge-refused")).to_contain_text("SYN draft is occupied")
        expect(go).to_be_enabled()
        self.page.evaluate(f"() => select({json.dumps(rf.UID_C)})")
        expect(win).to_have_count(0)
        self.assertEqual(1, sum(m == "POST" for m, _, _ in self.site.sent))


if __name__ == "__main__":
    unittest.main()
