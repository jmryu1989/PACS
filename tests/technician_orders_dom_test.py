# coding: utf-8
"""Technician Order List additions on the delivered split page (technician-orders.js, technician-scheduled.js,
technician-report.js): the Scheduled and Report tabs, the action row (Search Orders, Delete Order, Match…, Unmatch…).

The delivered page (main.html, its bundle and every shipped asset) against the synthetic origin of report_flow_dom_test;
no stack, no product file is modified. OrdersSite adds the order routes (Scheduled, remove/restore, match/unmatch) with
synthetic orders and keeps what the page sent.

  - Search Orders filters the order rows at once with the panel's own boxes; Reset clears; Close only closes the bar and,
    while a condition is set, the action row says so (the rows stay filtered);
  - Delete Order: a matched order is refused in the window (Esc closes it, nothing is sent); an unmatched one needs a
    reason, leaves the list, and Undo brings it back;
  - Match…: the comparison marks each field ✓ / ≠ and never refuses for a difference (another patient included); the
    result is the list read back from the server (the order's accession shown while matched); no browser confirm/alert;
  - Unmatch…: a reason is required and sent; the result is the list read back (the archive's accession again); a
    server refusal is shown in the window;
  - Report: no selection / Approved (text and Copy Report) / not final (status, no text, no copy) / Unread;
  - Scheduled: each order keeps its own state (a failed lookup is Not checked, never No images yet); Retry Check reads
    that order again; Open Match… selects the study and the order and opens Match….
"""
import json
import re
import unittest

import auth_logout_dom_test as h
import report_flow_dom_test as rf
from playwright.sync_api import expect, sync_playwright

TECH = {**h.RAD, "sub": "SYN-TECH-SUB", "actor": "syn-tech@synthetic.test", "user": "syn-tech@synthetic.test",
        "displayName": "SYN Technician", "roles": ["technician"]}
ORDER = {"sex": "M", "birth": "1980-01-01", "modality": "CT", "studyUid": None}
CLIPBOARD = """(() => { window.__synCopied = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async text => { window.__synCopied.push(text); }, readText: async () => '' } }); })()"""


class OrdersSite(rf.FlowSite):
    def __init__(self):
        super().__init__(3)
        self.orders = [
            {**ORDER, "oid": "SYN-O-1", "id": "SYN-P-001", "name": h.PATIENT, "sched": "2026-10-03 09:00", "desc": "SYN CT ABDOMEN",
             "ward": "NR", "reqDoc": "SYN DOC PARK", "matched": "U", "accession": "SYN-ORDER-ACC-1"},
            {**ORDER, "oid": "SYN-O-2", "id": "SYN-P-009", "name": "SYN ORDER NINE", "sched": "2026-10-04 10:00", "desc": "SYN CT CHEST",
             "ward": "ER", "reqDoc": "SYN DOC KIM", "matched": "U", "accession": None},
            {**ORDER, "oid": "SYN-O-3", "id": "SYN-P-003", "name": rf.PATIENT_C, "sched": "2026-10-03 11:00", "desc": "SYN CT CHEST",
             "ward": "NR", "reqDoc": "SYN DOC KIM", "matched": "M", "studyUid": rf.UID_C, "accession": None}]
        self.removed = {}
        self.sent = []                  # (method, path, body) of every order write
        self.scheduled = []
        self.scheduled_reads = []       # query strings
        self.retry_answers = {}         # oid -> entry for the next one-order read
        self.unmatch_refusal = None
        # Reports: A approved, B preliminary, C unread.
        self.store[h.UID]["report"] = {"version": 2, "rs": "A", "findings": "SYN FINDINGS ALPHA", "conclusion": "SYN CONCLUSION ALPHA", "recommendation": ""}
        self.store[h.UID_B]["report"] = {"version": 1, "rs": "P", "findings": "SYN PRELIM BRAVO", "conclusion": "SYN PRELIM CONCLUSION", "recommendation": ""}

    def matched_order(self, uid):
        return next((o for o in self.orders if o["studyUid"] == uid and o["matched"] == "M"), None)

    def state_of(self, uid, account):
        state = super().state_of(uid, account)
        order = self.matched_order(uid)
        if order:
            state.update(matched="M", oid=order["oid"], ward=order["ward"], ov={"id": order["id"], "name": order["name"], "sex": order["sex"],
                         "birth": order["birth"], "age": "", "desc": order["desc"], "ward": order["ward"]})
        if state["rs"] == "A":
            state["approvedAt"] = "2026-10-03T01:00:00.000Z"
        return state

    def list_body(self, account, rename=None):
        body = super().list_body(account, rename)
        for row in body["studies"]:
            order = self.matched_order(row["uid"])
            row["orderAccession"] = order["accession"] if order else None
        return body

    def api(self, route, request, method, path, query):
        account = None
        if path.startswith("/api/orders") or path in ("/api/match", "/api/unmatch"):
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
        if method == "GET" and path == "/api/orders/scheduled":
            self.scheduled_reads.append(query)
            oid = re.search(r"oid=([^&]+)", query)
            if oid:
                entry = self.retry_answers.pop(oid.group(1), None) or next(o for o in self.scheduled if o["oid"] == oid.group(1))
                return route.fulfill(json={"source": "engineering_only", "day": "x", "orders": [entry]})
            return route.fulfill(json={"source": "engineering_only", "day": "x", "orders": self.scheduled})
        found = re.fullmatch(r"/api/orders/([^/]+)/(remove|restore)", path)
        if method == "POST" and found:
            oid, what = found.groups()
            body = request.post_data_json
            self.sent.append((method, path, body))
            if what == "remove":
                order = next(o for o in self.orders if o["oid"] == oid)
                if order["matched"] == "M":
                    return self.answer(route, 409, {"message": "SYN matched order"})
                self.removed[oid] = (self.orders.index(order), order)
                self.orders = [o for o in self.orders if o["oid"] != oid]
                return route.fulfill(json={"oid": oid, "removed": True})
            at, order = self.removed.pop(oid)
            self.orders.insert(at, order)
            return route.fulfill(json={"oid": oid, "removed": False})
        if method == "POST" and path == "/api/match":
            body = request.post_data_json
            self.sent.append((method, path, body))
            order = next(o for o in self.orders if o["oid"] == body["oid"])
            order.update(matched="M", studyUid=body["uid"])
            return route.fulfill(json=self.state_of(body["uid"], account))
        if method == "POST" and path == "/api/unmatch":
            body = request.post_data_json
            self.sent.append((method, path, body))
            if self.unmatch_refusal:
                return self.answer(route, 400, {"message": self.unmatch_refusal})
            order = self.matched_order(body["uid"])
            order.update(matched="U", studyUid=None)
            return route.fulfill(json=self.state_of(body["uid"], account))
        return super().api(route, request, method, path, query)


class TechnicianOrders(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = OrdersSite()
        self.site.account = TECH
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR", timezone_id="Asia/Seoul")
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.errors, self.dialogs = [], []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", lambda dialog: (self.dialogs.append(dialog.message), dialog.accept()))
        self.page.add_init_script(CLIPBOARD)
        self.page.goto(h.MAIN_URL)
        expect(self.page.locator("#rows")).to_contain_text(h.PATIENT)
        tab = self.page.locator("[data-tab=Technician]")
        if tab.is_visible():
            tab.click()
        expect(self.page.locator("#orderrows tr[data-oid]")).to_have_count(3)

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.site.violations, "requests the synthetic origin does not answer")
        self.assertEqual([], self.dialogs, "no browser confirm or alert")

    # ── helpers ──
    def action(self, label):
        return self.page.locator("#order-actions > button", has_text=re.compile("^" + re.escape(label) + "$"))

    def order_rows(self):
        return self.page.eval_on_selector_all("#orderrows tr[data-oid]", "rows => rows.map(r => r.dataset.oid)")

    def pick_order(self, oid):
        self.page.locator(f"#orderrows tr[data-oid='{oid}']").click()
        expect(self.page.locator(f"#orderrows tr[data-oid='{oid}']")).to_have_class(re.compile("sel"))

    def pick_study(self, patient):
        self.page.locator("#rows tr", has_text=patient).first.click()
        self.page.wait_for_function(f"() => studies.find(s => s.uid === selectedUid)?.name === {json.dumps(patient)}")

    def window(self, name):
        return self.page.locator(f"dialog[data-order-window='{name}']")

    def cells(self, window):
        return window.locator("table tbody tr").evaluate_all("rows => rows.map(r => [...r.children].map(td => td.textContent))")

    def tab(self, label):
        return self.page.locator(".order-p .reltabs > div", has_text=re.compile("^" + re.escape(label) + "$"))

    # ── the tabs and the action row ──
    def test_tabs_and_action_row_are_in_place(self):
        self.assertEqual(["Order List (RIS)", "Scheduled", "Report"],
                         self.page.eval_on_selector_all(".order-p .reltabs > div:not(.spacer)", "d => d.map(x => x.textContent.trim())"))
        self.assertEqual(["Search Orders", "Delete Order", "Match…", "Unmatch…"],
                         self.page.eval_on_selector_all("#order-actions > button", "b => b.map(x => x.textContent)"))
        expect(self.page.locator("#order-search")).to_be_hidden()

    # ── Search Orders ──
    def test_search_filters_at_once_reset_clears_and_close_keeps_the_conditions(self):
        self.action("Search Orders").click()
        bar = self.page.locator("#order-search")
        expect(bar).to_be_visible()
        expect(bar.locator(".order-count")).to_have_text("3 orders")
        bar.get_by_label("Scheduled from").fill("2026-10-04")
        self.assertEqual(["SYN-O-2"], self.order_rows(), "filtered at once, without another click")
        expect(bar.locator(".order-count")).to_have_text("1 orders")
        bar.get_by_role("button", name="Close").click()
        expect(bar).to_be_hidden()
        self.assertEqual(["SYN-O-2"], self.order_rows(), "Close keeps the condition")
        condition = self.page.locator("#order-actions .order-condition")
        expect(condition).to_contain_text("from 2026-10-04")
        condition.get_by_role("button", name="Reset").click()
        self.assertEqual(["SYN-O-1", "SYN-O-2", "SYN-O-3"], self.order_rows())
        expect(condition).to_be_hidden()
        self.action("Search Orders").click()
        expect(bar.get_by_label("Scheduled from")).to_have_value("")
        bar.get_by_label("Ward").fill("nr")
        self.assertEqual(["SYN-O-1", "SYN-O-3"], self.order_rows())
        bar.get_by_label("State").select_option("M")
        self.assertEqual(["SYN-O-3"], self.order_rows())
        bar.get_by_label("ReqDoc").fill("park")
        self.assertEqual([], self.order_rows())
        expect(self.page.locator("#orderrows")).to_contain_text("오더 없음")
        bar.get_by_role("button", name="Reset").click()
        self.assertEqual(["SYN-O-1", "SYN-O-2", "SYN-O-3"], self.order_rows())
        # The panel's own boxes apply together with the search.
        self.page.locator(".order-p .filters input[data-o=id]").fill("SYN-P-009")
        bar.get_by_label("Ward").fill("NR")
        self.assertEqual([], self.order_rows())
        bar.get_by_label("Ward").fill("ER")
        self.assertEqual(["SYN-O-2"], self.order_rows())

    # ── Delete Order ──
    def test_delete_order_refuses_a_matched_order_needs_a_reason_and_undo_restores(self):
        self.pick_order("SYN-O-3")
        self.action("Delete Order").click()
        w = self.window("order-delete")
        expect(w).to_be_visible()
        expect(w).to_contain_text("A matched order cannot be deleted. Unmatch it first.")
        self.page.keyboard.press("Escape")
        expect(w).to_have_count(0)
        self.assertEqual([], self.site.sent)
        self.assertEqual(["SYN-O-1", "SYN-O-2", "SYN-O-3"], self.order_rows())

        self.pick_order("SYN-O-2")
        self.action("Delete Order").click()
        w = self.window("order-delete")
        expect(w).to_contain_text("the hospital RIS order is not cancelled")
        go = w.get_by_role("button", name="Delete Order")
        expect(go).to_be_disabled()
        w.get_by_label("Reason").fill("  Duplicate order, cancelled by ward  ")
        go.click()
        expect(w).to_have_count(0)
        self.assertEqual([("POST", "/api/orders/SYN-O-2/remove", {"reason": "Duplicate order, cancelled by ward"})], self.site.sent)
        self.page.wait_for_function("() => !document.querySelector(\"#orderrows tr[data-oid='SYN-O-2']\")")
        status = self.page.locator("#order-actions .order-status")
        expect(status).to_contain_text("Order SYN-O-2 removed from the list.")
        status.get_by_role("button", name="Undo").click()
        expect(status).to_contain_text("Order SYN-O-2 is back on the list.")
        self.assertEqual(("POST", "/api/orders/SYN-O-2/restore", None), self.site.sent[-1])
        self.assertEqual(["SYN-O-1", "SYN-O-2", "SYN-O-3"], self.order_rows())

    # ── Match… / Unmatch… ──
    def test_match_compares_without_refusing_and_shows_the_values_read_back(self):
        # Another patient's order: every difference is marked, and Match stays available.
        self.pick_study(h.PATIENT)
        self.pick_order("SYN-O-2")
        self.action("Match…").click()
        w = self.window("order-match")
        rows = {r[0]: r for r in self.cells(w)}
        self.assertEqual("≠", rows["Patient ID"][3])
        self.assertEqual("—", rows["Accession"][3], "the order has no accession: not compared")
        expect(w.get_by_role("button", name="Match")).to_be_enabled()
        w.get_by_role("button", name="Close").click()
        expect(w).to_have_count(0)

        self.pick_order("SYN-O-1")
        self.action("Match…").click()
        w = self.window("order-match")
        rows = {r[0]: r for r in self.cells(w)}
        self.assertEqual(["✓", "✓", "✓", "✓", "≠", "✓", "≠"], [rows[k][3] for k in ("Patient ID", "Name", "Sex", "BirthDate", "Exam", "Date", "Accession")])
        self.assertEqual(["SYNACC-001", "SYN-ORDER-ACC-1"], rows["Accession"][1:3])
        w.get_by_role("button", name="Match").click()
        expect(w).to_contain_text("After (read back)")
        result = {r[0]: r[1:] for r in self.cells(w)}
        self.assertEqual(["SYNACC-001", "SYN-ORDER-ACC-1"], result["Accession"])
        self.assertEqual(["SYN CT CHEST", "SYN CT ABDOMEN"], result["StudyDesc"])
        self.assertEqual(["U", "M"], result["Mt"])
        self.assertEqual(("POST", "/api/match"), self.site.sent[-1][:2])
        self.assertEqual({"uid": h.UID, "oid": "SYN-O-1"}, {k: self.site.sent[-1][2][k] for k in ("uid", "oid")})
        w.get_by_role("button", name="Close").click()
        self.assertEqual(["SYN-ORDER-ACC-1", "SYNACC-001"], self.page.evaluate(
            f"() => {{ const s = studies.find(x => x.uid === {json.dumps(h.UID)}); return [s.acc, s.sourceAcc]; }}"))

        # Unmatch…: a reason is required and sent; the result is what the list reads back.
        self.action("Unmatch…").click()
        w = self.window("order-unmatch")
        now = {r[0]: r[1:] for r in self.cells(w)}
        self.assertEqual(["SYN-ORDER-ACC-1", "SYNACC-001"], now["Accession"], "Now / Restored (from the images)")
        go = w.get_by_role("button", name="Unmatch")
        expect(go).to_be_disabled()
        w.get_by_label("Reason").fill("Wrong order of the same patient")
        go.click()
        expect(w).to_contain_text("Restored (read back)")
        expect(w).to_contain_text("Order SYN-O-1 is Unmatched again.")
        result = {r[0]: r[1:] for r in self.cells(w)}
        self.assertEqual(["SYN-ORDER-ACC-1", "SYNACC-001"], result["Accession"])
        self.assertEqual(["M", "U"], result["Mt"])
        self.assertEqual(("POST", "/api/unmatch", {"uid": h.UID, "reason": "Wrong order of the same patient"}), self.site.sent[-1])

    def test_unmatch_refusal_is_shown_in_the_window(self):
        self.pick_study(rf.PATIENT_C)
        self.site.unmatch_refusal = "SYN 판독 전(RS: W)인 검사만 매칭을 풀 수 있습니다"
        self.action("Unmatch…").click()
        w = self.window("order-unmatch")
        w.get_by_label("Reason").fill("SYN reason")
        w.get_by_role("button", name="Unmatch").click()
        expect(w.locator(".order-note.err")).to_contain_text("SYN 판독 전(RS: W)인 검사만 매칭을 풀 수 있습니다")
        expect(w.get_by_role("button", name="Unmatch")).to_be_enabled()

    # ── Report ──
    def test_report_tab_shows_approved_text_only_and_copies_it(self):
        self.tab("Report").click()
        pane = self.page.locator("#order-pane")
        expect(pane).to_be_visible()
        expect(self.page.locator(".order-p .grid2")).to_be_hidden()
        expect(pane).to_contain_text("Technologists cannot edit or approve reports.")
        expect(pane).to_contain_text("Select a study in Study List.")
        self.pick_study(h.PATIENT)
        expect(pane.locator("[data-report-state=approved]")).to_have_text("Approved")
        expect(pane).to_contain_text("SYN FINDINGS ALPHA")
        self.assertEqual(0, pane.locator("textarea, input, [contenteditable=true]").count(), "nothing editable")
        pane.get_by_role("button", name="Copy Report").click()
        expect(pane).to_contain_text("Report copied to the clipboard.")
        copied = self.page.evaluate("() => window.__synCopied")
        self.assertEqual(1, len(copied))
        self.assertIn("SYN FINDINGS ALPHA", copied[0])
        self.assertIn("SYN CONCLUSION ALPHA", copied[0])

        self.pick_study(h.PATIENT_B)
        expect(pane.locator("[data-report-state=not-final]")).to_have_text("Preliminary · Not Approved")
        expect(pane).to_contain_text("The report is not final yet.")
        expect(pane).not_to_contain_text("SYN PRELIM")
        self.assertEqual(0, pane.get_by_role("button", name="Copy Report").count())

        self.pick_study(rf.PATIENT_C)
        expect(pane.locator("[data-report-state=unread]")).to_have_text("No report has been written yet (Unread).")
        self.assertEqual(0, pane.get_by_role("button", name="Copy Report").count())

        self.tab("Order List (RIS)").click()
        expect(pane).to_be_hidden()
        expect(self.page.locator(".order-p .grid2")).to_be_visible()
        expect(self.page.locator("#order-actions")).to_be_visible()

    # ── Scheduled ──
    def test_scheduled_keeps_each_state_retries_one_order_and_opens_match(self):
        day = self.page.evaluate("() => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }")
        base = {"modality": "CT", "desc": "SYN CT", "accession": None, "studyUid": None, "images": None, "candidates": []}
        self.site.scheduled = [
            {**base, "oid": "SYN-O-3", "sched": day + " 09:00", "id": "SYN-P-003", "name": rf.PATIENT_C, "matched": "M", "state": "matched", "studyUid": rf.UID_C, "images": 20},
            {**base, "oid": "SYN-O-4", "sched": day + " 09:10", "id": "SYN-P-010", "name": "SYN ORDER TEN", "matched": "U", "state": "no_images"},
            {**base, "oid": "SYN-O-5", "sched": day + " 09:20", "id": "SYN-P-011", "name": "SYN ORDER ELEVEN", "matched": "U", "state": "lookup_failed"},
            {**base, "oid": "SYN-O-1", "sched": day + " 09:30", "id": "SYN-P-001", "name": h.PATIENT, "matched": "U", "state": "images_found",
             "accession": "SYN-ORDER-ACC-1", "candidates": [{"uid": h.UID, "accession": "SYNACC-001", "images": 10, "desc": "SYN CT CHEST", "relation": "mismatch"}]},
            {**base, "oid": "SYN-O-6", "sched": day + " 09:40", "id": " ", "name": "SYN ORDER TWELVE", "matched": "U", "state": "not_checkable"}]
        self.site.retry_answers["SYN-O-5"] = {**self.site.scheduled[2], "state": "no_images"}
        self.tab("Scheduled").click()
        pane = self.page.locator("#order-pane")
        expect(pane.locator("tbody tr[data-oid]")).to_have_count(5)
        self.assertIn("day=" + day, self.site.scheduled_reads[0])
        expect(pane).to_contain_text("Scheduled Studies — " + day)
        expect(pane).to_contain_text("Engineering Only")
        table = pane.locator("tbody tr[data-oid]").evaluate_all("rows => rows.map(r => [r.dataset.oid, r.children[4].textContent, r.children[5].textContent])")
        self.assertEqual([["SYN-O-3", "20 images", "Matched"], ["SYN-O-4", "—", "No images yet"], ["SYN-O-5", "—", "Not checked"],
                          ["SYN-O-1", "—", "Accession differs"], ["SYN-O-6", "—", "Not checked"]], table)

        pane.locator("tr[data-oid='SYN-O-5']").click()
        detail = pane.locator(".order-detail")
        expect(detail).to_contain_text("Lookup failed")
        expect(detail).not_to_contain_text("No images yet")
        detail.get_by_role("button", name="Retry Check").click()
        expect(detail).to_contain_text("No images yet")
        expect(detail).to_contain_text("Checked again just now.")
        self.assertIn("oid=SYN-O-5", self.site.scheduled_reads[-1])

        pane.locator("tr[data-oid='SYN-O-6']").click()
        expect(detail).to_contain_text("Not checked")
        self.assertEqual(0, detail.get_by_role("button", name="Retry Check").count())

        pane.locator("tr[data-oid='SYN-O-1']").click()
        expect(detail).to_contain_text("Accession SYNACC-001 (differs from the order's SYN-ORDER-ACC-1)")
        detail.get_by_role("button", name="Open Match…").click()
        expect(pane).to_be_hidden()
        w = self.window("order-match")
        expect(w).to_be_visible()
        expect(w).to_contain_text("Order (SYN-O-1)")
        self.assertEqual(h.PATIENT, self.page.evaluate("() => studies.find(s => s.uid === selectedUid)?.name"))
        w.get_by_role("button", name="Close").click()


if __name__ == "__main__":
    unittest.main()
