# coding: utf-8
"""W4-PAGE-01..12 -> RISK-LOST-TEXT / WRONG-STUDY / HIDDEN-RECOMMENDATION / FIRST-ROW-JUMP -> W4 report flow.

The delivered split page (main.html, its bundle and every shipped asset) against a synthetic origin; no stack, no
product file is modified. FlowSite extends the logout suite's wire boundary (auth_logout_dom_test.Site) from one study
to several, each with its own stored draft row, revision and report, so the queue, a filter and A -> B -> A can be
driven through the page's own controls.

Setup-only, documented where used: FINALIZE_STAND_IN gives the delivered shortcut model the fixed W4-SC interface (D1358,
D1371: readV2 with `finalize`) while the W4-SC model is not on this branch, and installs nothing once it is; the hook case
marks an insertion as out (`insertInFlight`), which the citation and structure suites drive for real.
"""
import io
import json
import re
import sys
import time
import unittest
from pathlib import Path

import auth_logout_dom_test as h
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
LITE = ROOT / "worklist-v0/hpacs-lite"
UID_C = "1.2.826.0.1.3680043.10.7707.3"
UID_D = "1.2.826.0.1.3680043.10.7707.4"
PATIENT_C = "SYN PATIENT CHARLIE"
PATIENT_D = "SYN PATIENT DELTA"
STUDIES = ((h.UID, h.PATIENT, "SYN-P-001"), (h.UID_B, h.PATIENT_B, "SYN-P-002"),
           (UID_C, PATIENT_C, "SYN-P-003"), (UID_D, PATIENT_D, "SYN-P-004"))
FIELDS = tuple(h.FIELDS)
RS_OF = {"save": "T", "approve": "A", "addendum": "A", "reset": "W", "defer": "H", "preliminary": "P"}
TEMPLATE = {"id": "SYN-TPL-1", "title": "SYN REC TEMPLATE", "shortcut": "", "modality": "", "bodypart": "", "ord": 0,
            "findings": "SYN template findings", "conclusion": "SYN template conclusion",
            "recommendation": "SYN template recommendation: follow-up CT in 3 months"}


class FlowSite(h.Site):
    """Several studies, each with the author's own draft row (revision, snapshot) and its report."""

    def __init__(self, count=3):
        super().__init__()
        self.flow = STUDIES[:count]
        self.store = {uid: {"revs": 0, "row": None, "report": {"version": 0, "rs": "W"}} for uid, _, _ in self.flow}
        self.flow_puts = []             # (uid, body) of every draft write that reached the server
        self.flow_commits = []          # (uid, body) of every commit
        self.held_flow_puts = []        # (route, uid, body, account)
        self.held_flow_commits = []     # (route, uid, body, account)
        self.templates = []
        self.hidden = set()

    # ── one study's stored state ──
    def revision_of(self, uid):
        return f"{self.epoch}:{self.store[uid]['revs']}"

    def envelope_of(self, uid, account):
        row = self.store[uid]["row"]
        return {"uid": uid, "owner": h.owner_of(account), "revision": self.revision_of(uid), "present": row is not None,
                "snapshot": dict(row) if row else None, "updatedAt": "2026-10-03T00:00:00.000Z" if row else None}

    def state_of(self, uid, account):
        st = self.store[uid]
        row, report = st["row"], st["report"]
        approved = report["rs"] == "A"
        return {"rs": report["rs"], "ss": "Verified", "em": "N", "ts": "none", "matched": "U", "ward": "",
                "reqHosp": "SYN Hospital A", "institutionId": h.INSTITUTION, "teleInstitutionId": None, "preDoc": None,
                "preReviewer": None, "prelimHidden": False, "repDoc": account["actor"] if approved else None,
                "confirm": "20261003" if approved else None, "ov": None, "orig": None, "oid": None, "holder": None,
                "holdReason": None, "version": report["version"],
                **{k: report.get(k, "") for k in FIELDS},
                "draft": {**{k: row[k] for k in FIELDS}, "baseVersion": row["baseVersion"],
                          "at": "2026-10-03T00:00:00.000Z"} if row else None,
                "draftRevision": self.revision_of(uid), "draftEpoch": self.epoch}

    def preconditions_of(self, uid, body, account):
        if not isinstance(body, dict) or "expectedOwner" not in body or "expectedRevision" not in body:
            return 400, {"code": "REPORT_DRAFT_PRECONDITION_REQUIRED", "message": "SYN-SERVER-WORDING precondition"}
        if body["expectedOwner"] != h.owner_of(account):
            return 409, {"code": "REPORT_DRAFT_OWNER_CHANGED", "message": "SYN-SERVER-WORDING owner"}
        if body["expectedRevision"] != self.revision_of(uid):
            return 409, {"code": "REPORT_DRAFT_CONFLICT", "message": "SYN-SERVER-WORDING conflict"}
        return None

    def write_of(self, uid, body, account):
        refused = self.preconditions_of(uid, body, account)
        if refused:
            return refused
        if any(key not in body for key in (*FIELDS, "baseVersion", "citationIds", "structureIds")):
            return 400, {"code": "REPORT_DRAFT_PRECONDITION_REQUIRED", "message": "SYN-SERVER-WORDING snapshot"}
        st = self.store[uid]
        st["revs"] += 1
        st["row"] = None if all(not body[k] for k in FIELDS) else {
            **{k: body[k] for k in FIELDS}, "baseVersion": body["baseVersion"],
            "citations": list(body["citationIds"]), "structured": list(body["structureIds"])}
        return 200, self.envelope_of(uid, account)

    def commit_of(self, uid, body, account):
        refused = self.preconditions_of(uid, body, account)
        if refused:
            return refused
        st = self.store[uid]
        action = body.get("action")
        if st["report"]["rs"] == "A" and action in ("save", "approve"):
            return 400, {"code": "REPORT_APPROVED", "message": "SYN-SERVER-WORDING approved"}
        if body.get("baseVersion") != st["report"]["version"]:
            return 409, {"code": "REPORT_VERSION_CONFLICT", "message": "SYN 그 사이 다른 사용자가 저장했습니다"}
        st["revs"] += 1
        st["row"] = None
        texts = {k: "" for k in FIELDS} if action == "reset" else {k: body.get(k, "") for k in FIELDS}
        st["report"] = {"version": st["report"]["version"] + 1, "rs": RS_OF.get(action, "T"), **texts}
        return 200, {**self.envelope_of(uid, account), "state": self.state_of(uid, account)}

    def stored_of(self, uid):
        row = self.store[uid]["row"]
        return {k: row[k] for k in FIELDS} if row else None

    # ── the list ──
    def list_body(self, account, rename=None):
        rows = []
        for uid, name, patient in self.flow:
            if uid in self.hidden:
                continue
            row = self.study_row(account, h.UID, name, patient)
            row["uid"] = uid
            row["state"] = self.state_of(uid, account)
            rows.append(row)
        return {"studies": rows, "serverTime": "2026-10-03T00:00:00.000Z", "observedAt": "2026-10-03T00:00:00.000Z",
                "notObserved": [], "pagination": {"owner": [h.INSTITUTION, account["sub"]], "limit": 100, "offset": 0,
                                                  "total": len(rows), "next": None}}

    def api(self, route, request, method, path, query):
        if method == "GET" and path == "/api/bootstrap":
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            states = {} if "states=omit" in query else {uid: self.state_of(uid, account) for uid, _, _ in self.flow}
            return route.fulfill(json={"statesOmitted": "states=omit" in query, "me": {
                "actor": account["actor"], "roles": account["roles"], "institution": h.INSTITUTION,
                "institutionName": "SYN Hospital A"}, "filters": [], "templates": self.templates,
                "institutions": [{"id": h.INSTITUTION, "name": "SYN Hospital A", "type": "hospital"}],
                "states": states, "orders": [], "serverTime": "2026-10-03T00:00:00.000Z"})
        found = re.fullmatch(r"/api/studies/([^/]+)/(hold|release|report|draft|report/commit|report/versions)", path)
        if not found or found.group(1) not in self.store:
            return super().api(route, request, method, path, query)
        account, refused = self.authenticate(request)
        if refused:
            return self.refuse(route, *refused)
        uid, what = found.groups()
        if method == "POST" and what == "hold":
            self.holds.append(path)
            return route.fulfill(json={"holder": account["user"], "conflict": False})
        if method == "POST" and what == "release":
            self.releases.append((path, request.headers.get("x-kin-session")))
            return route.fulfill(json={"ok": True})
        if method == "GET" and what == "report/versions":
            return route.fulfill(json=[])
        if method == "GET" and what == "draft":
            self.draft_reads.append(request.headers.get("x-kin-session"))
            if self.draft_read_answers:
                reply = self.draft_read_answers.pop(0)
                return route.abort("connectionreset") if reply == "abort" else self.answer(route, *reply)
            return route.fulfill(json=self.envelope_of(uid, account))
        if method == "PUT" and what == "report":
            body = request.post_data_json
            self.puts.append(body)
            self.flow_puts.append((uid, body))
            reply = self.put_answers.pop(0) if self.put_answers else "ok"
            if reply == "hold":
                return self.held_flow_puts.append((route, uid, body, account))
            if reply == "abort":
                return route.abort("connectionreset")
            if reply == "lost":
                self.write_of(uid, body, account)
                return route.abort("connectionreset")
            if reply != "ok":
                return self.answer(route, *reply)
            return self.answer(route, *self.write_of(uid, body, account))
        if method == "DELETE" and what == "draft":
            body = request.post_data_json
            self.discards.append(body)
            refused_write = self.preconditions_of(uid, body, account)
            if refused_write:
                return self.answer(route, *refused_write)
            self.store[uid]["revs"] += 1
            self.store[uid]["row"] = None
            return route.fulfill(json={**self.envelope_of(uid, account), "state": self.state_of(uid, account)})
        if method == "POST" and what == "report/commit":
            body = request.post_data_json
            self.commits.append(body)
            self.flow_commits.append((uid, body))
            reply = self.commit_answers.pop(0) if self.commit_answers else "ok"
            if reply == "hold":
                return self.held_flow_commits.append((route, uid, body, account))
            if reply == "lost":
                self.commit_of(uid, body, account)
                return route.abort("connectionreset")
            if reply != "ok":
                return self.answer(route, *reply)
            return self.answer(route, *self.commit_of(uid, body, account))
        self.violations.append(f"undeclared write: {method} {path}")
        return route.fulfill(status=405, json={"code": "SYN_NO_WRITE"})

    def finish_flow_put(self, index=0, status=200):
        route, uid, body, account = self.held_flow_puts.pop(index)
        answer = self.write_of(uid, body, account) if status == 200 else (status, {"code": "SYN_FAILED", "message": "SYN"})
        self.answer(route, *answer)
        return answer[0]

    def finish_flow_commit(self, index=0, lost=False):
        route, uid, body, account = self.held_flow_commits.pop(index)
        answer = self.commit_of(uid, body, account)
        if lost:
            route.abort("connectionreset")
        else:
            self.answer(route, *answer)
        return answer[0]


# Setup-only stand-in for the W4-SC shortcut model (fixed interface D1358 + D1371). Until fable/w4-sc lands on this branch
# the delivered model has no readV2, the v2 map that holds `finalize`. The stand-in then gives it one - a fixture map: the
# v1 defaults as whole chords plus finalize = Control+KeyS, as the v2 defaults are - and answers a v2 map's chords the way the
# interface fixes them (a v2 value is the whole chord); a v1-shaped map still goes to the delivered model. Once the W4-SC
# model is on the page it has readV2 and nothing is installed: the same cases then run on the shipped model. Everything
# after the model's answer - the page dispatcher, KinReportCommands and the Finalize (Approve) command - is shipped code.
FINALIZE_STAND_IN = """(() => {
  const model = KinWorkspaceShortcuts;
  if (model.readV2) return 'shipped model';
  const fixture = { version: 2, finalize: 'Control+KeyS',
    ...Object.fromEntries(Object.entries(model.defaults).map(([id, key]) => [id, 'Control+Alt+' + key])) };
  const v1 = model.action;
  model.readV2 = () => ({ ...fixture });
  model.action = (map, e) => {
    if (map?.version !== 2) return v1(map, e);
    if (e.defaultPrevented || e.repeat || e.isComposing || !e.ctrlKey || e.shiftKey || e.metaKey) return null;
    const chord = 'Control+' + (e.altKey ? 'Alt+' : '') + e.code;
    return Object.keys(map).find(id => id !== 'version' && map[id] === chord) ?? null;
  };
  return 'stand-in';
})()"""
# One Ctrl+S keydown in Findings, as the keyboard sends it; returns whether a listener prevented the browser default
# (the page's dispatcher stops the event at the window, so nothing after it could observe the flag).
CTRL_S = """() => { const e = new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true });
  document.querySelector('#findings').dispatchEvent(e); return e.defaultPrevented; }"""


class ReportFlowPage(unittest.TestCase):
    """REQ W4-PAGE-01/04/05/06/08/10/12 on the delivered split page; only HTTP is synthetic."""
    count = 3
    bundle_source = None
    html_source = None

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = FlowSite(self.count)
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR",
                                                timezone_id="Asia/Seoul")
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
        if self.bundle_source is not None:
            self.context.route("**/main-split.bundle.js", lambda route: route.fulfill(
                body=self.bundle_source, content_type="text/javascript; charset=utf-8"))
        if self.html_source is not None:
            self.context.route("**/main.html", lambda route: route.fulfill(
                body=self.html_source, content_type="text/html; charset=utf-8"))
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.page.set_default_navigation_timeout(30000)
        self.errors, self.dialogs = [], []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", lambda dialog: (self.dialogs.append(dialog.message), dialog.accept()))
        # The page's timers (autosave, polling, the navigation wait bound) run only when a case advances them.
        self.page.clock.install()

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.site.violations, "requests the synthetic origin does not answer")

    # ── driving the page through its controls ──
    def open(self):
        self.page.goto(h.MAIN_URL)
        expect(self.page.locator("#rows")).to_contain_text(h.PATIENT)

    def row(self, patient):
        return self.page.locator("#rows tr", has_text=patient).first

    def pick(self, patient):
        self.row(patient).click()

    def open_study(self, patient):
        self.pick(patient)
        self.wait(lambda: self.selected() == patient, "the study opens")
        expect(self.page.locator("#findings")).to_be_editable()

    def type(self, text, field="findings"):
        self.page.locator("#" + field).fill(text)

    def selected(self):
        return self.page.evaluate("() => studies.find(s => s.uid === selectedUid)?.name ?? null")

    def editor_of(self):
        """The study whose report the editor holds (the frame's opening)."""
        return self.page.evaluate("() => studies.find(s => s.uid === reportOpening?.uid)?.name ?? null")

    def wait(self, predicate, what, timeout=10.0):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > deadline:
                self.fail(f"{what}: not observed; last requests {self.site.calls[-8:]}")
            self.page.wait_for_timeout(20)

    def settle(self, ms=150):
        """Real time for in-flight answers to reach the page (the page's own timers stay frozen)."""
        self.page.wait_for_timeout(ms)

    def notice(self):
        return self.page.locator("#report-notice")

    def compose(self):
        self.page.locator("#findings").focus()
        cdp = self.context.new_cdp_session(self.page)
        cdp.send("Input.imeSetComposition", {"text": "한", "selectionStart": 1, "selectionEnd": 1})
        return cdp

    def filter_waiting(self):
        self.page.select_option("#filterrow [data-f=rs]", "W")

    def stored(self, uid):
        return self.site.stored_of(uid)

    # ── SAVE-OUTCOME (W4-PAGE-01/03/06) ──
    def test_save_outcome_applied_moves_only_after_the_write_is_confirmed(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A typed")
        self.site.put_answers = ["hold"]
        self.pick(h.PATIENT_B)
        self.wait(lambda: self.site.held_flow_puts, "the draft write of A")
        self.settle()
        self.assertEqual(h.PATIENT, self.selected(), "the switch waits for the write's answer")
        self.assertEqual("SYN A typed", self.page.locator("#findings").input_value())
        self.site.finish_flow_put()
        self.wait(lambda: self.selected() == h.PATIENT_B, "the switch after the confirmed write")
        self.assertEqual(h.PATIENT_B, self.editor_of())
        self.assertEqual({"findings": "SYN A typed", "conclusion": "", "recommendation": ""}, self.stored(h.UID))
        expect(self.notice()).to_be_hidden()
        self.assertEqual([], self.dialogs)

    def test_save_outcome_refused_stays_with_notice_and_retry_moves_after_the_cause_is_gone(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A refused")
        self.site.put_answers = [(403, {"code": "REPORT_FORBIDDEN", "message": "SYN refused write"})]
        self.pick(h.PATIENT_B)
        expect(self.notice()).to_be_visible()
        expect(self.notice()).to_contain_text("Save Failed")
        expect(self.notice()).to_contain_text("SYN refused write")
        expect(self.page.locator("#report-notice-retry")).to_be_visible()
        expect(self.page.locator("#report-notice-stay")).to_be_visible()
        self.assertEqual(h.PATIENT, self.selected())
        self.assertEqual("SYN A refused", self.page.locator("#findings").input_value())
        expect(self.page.locator("#draftmsg")).to_contain_text("Save Failed")
        self.assertIsNone(self.stored(h.UID))
        # The cause is resolved on the server; Retry saves and continues the same move.
        self.page.locator("#report-notice-retry").click()
        self.wait(lambda: self.selected() == h.PATIENT_B, "Retry continues the move once saved")
        self.assertEqual({"findings": "SYN A refused", "conclusion": "", "recommendation": ""}, self.stored(h.UID))
        expect(self.notice()).to_be_hidden()

    def test_save_outcome_unknown_stays_and_check_confirms_from_the_server_then_moves(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A unknown")
        # The connection drops before the server has the write, and the confirming read fails too.
        self.site.put_answers = ["abort"]
        self.site.draft_read_answers = ["abort"]
        self.pick(h.PATIENT_B)
        expect(self.notice()).to_contain_text("Result Unknown")
        expect(self.page.locator("#report-notice-check")).to_be_visible()
        expect(self.page.locator("#report-notice-retry")).to_be_hidden()
        self.assertEqual(h.PATIENT, self.selected())
        self.assertEqual("SYN A unknown", self.page.locator("#findings").input_value())
        expect(self.page.locator("#draftmsg")).to_contain_text("Result Unknown")
        writes = len(self.site.flow_puts)
        self.page.locator("#report-notice-check").click()
        self.wait(lambda: self.selected() == h.PATIENT_B, "Check confirms the save and continues the move")
        self.assertGreater(len(self.site.flow_puts), writes)
        self.assertEqual({"findings": "SYN A unknown", "conclusion": "", "recommendation": ""}, self.stored(h.UID))

    def test_wait_bound_stops_as_unknown_and_a_late_confirmation_is_shown_without_moving(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A slow")
        self.site.put_answers = ["hold"]
        self.pick(h.PATIENT_B)
        self.wait(lambda: self.site.held_flow_puts, "the draft write of A")
        self.page.clock.run_for(3001)
        expect(self.notice()).to_contain_text("Result Unknown")
        self.assertEqual(h.PATIENT, self.selected())
        self.site.finish_flow_put()
        expect(self.notice()).to_contain_text("Draft Saved")
        self.settle()
        self.assertEqual(h.PATIENT, self.selected(), "a late answer does not move by itself")
        self.page.locator("#report-notice-check").click()
        self.wait(lambda: self.selected() == h.PATIENT_B, "Check moves once the save is known")

    def test_stay_closes_the_notice_and_keeps_the_text(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A stay")
        self.site.put_answers = [(503, {"code": "REPORT_DRAFT_UNAVAILABLE", "message": "SYN unavailable"})]
        self.pick(h.PATIENT_B)
        expect(self.notice()).to_contain_text("Save Failed")
        self.page.locator("#report-notice-stay").click()
        expect(self.notice()).to_be_hidden()
        self.assertEqual((h.PATIENT, "SYN A stay"), (self.selected(), self.page.locator("#findings").input_value()))

    def test_conflict_stays_and_points_to_the_draft_bar_choice(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A mine")
        # Another document of this account stored a different draft first.
        self.site.write_of(h.UID, {"findings": "SYN other window", "conclusion": "", "recommendation": "", "baseVersion": 0,
                                   "citationIds": [], "structureIds": [], "expectedOwner": h.owner_of(h.RAD),
                                   "expectedRevision": self.site.revision_of(h.UID)}, h.RAD)
        self.pick(h.PATIENT_B)
        expect(self.notice()).to_contain_text("서버의 초안이 이 화면과 다릅니다")
        expect(self.page.locator("#b-draft-keep")).to_be_visible()
        self.assertEqual((h.PATIENT, "SYN A mine"), (self.selected(), self.page.locator("#findings").input_value()))
        self.assertEqual("SYN other window", self.stored(h.UID)["findings"])

    def test_doctor_path_without_unconfirmed_text_switches_synchronously(self):
        self.open()
        self.open_study(h.PATIENT)
        # Nothing typed: the row click switches inside the same event, as before W4.
        moved = self.page.evaluate("""uid => { document.querySelector(`#rows tr[data-uid="${uid}"]`).click();
                                                return selectedUid; }""", h.UID_B)
        self.assertEqual(h.UID_B, moved)
        # Typed text that the autosave already confirmed: still the same synchronous switch.
        self.type("SYN B saved")
        self.page.clock.run_for(20001)
        self.wait(lambda: self.stored(h.UID_B) is not None, "the autosave")
        self.wait(lambda: not self.page.evaluate("reportConverge.has(selectedUid)"), "the confirmed autosave")
        writes = len(self.site.flow_puts)
        moved = self.page.evaluate("""() => { document.querySelector('#b-next').click(); return selectedUid; }""")
        self.assertEqual(UID_C, moved)
        self.assertEqual(writes, len(self.site.flow_puts), "no extra write on the doctor's path")
        expect(self.notice()).to_be_hidden()

    def test_composition_open_row_click_and_next_stay_and_say_so(self):
        self.open()
        self.open_study(h.PATIENT)
        cdp = self.compose()
        self.row(h.PATIENT_B).dispatch_event("click")
        expect(self.notice()).to_contain_text("Not Moved")
        expect(self.notice()).to_contain_text("조합")
        self.assertEqual(h.PATIENT, self.selected())
        self.page.locator("#b-next").dispatch_event("click")
        self.assertEqual(h.PATIENT, self.selected())
        self.assertTrue(self.page.evaluate("reportFrame.isComposing()"), "the composition stays open")
        cdp.send("Input.insertText", {"text": "한"})
        cdp.detach()
        self.pick(h.PATIENT_B)
        self.wait(lambda: self.selected() == h.PATIENT_B, "the move once the composition ended and was saved")
        self.assertEqual("한", self.stored(h.UID)["findings"])

    def test_composition_started_while_the_save_is_out_keeps_the_study(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A typed")
        self.site.put_answers = ["hold"]
        self.pick(h.PATIENT_B)
        self.wait(lambda: self.site.held_flow_puts, "the draft write of A")
        cdp = self.compose()
        self.site.finish_flow_put()
        expect(self.notice()).to_contain_text("Not Moved")
        self.assertEqual(h.PATIENT, self.selected(), "no move while the reader is composing")
        cdp.send("Input.insertText", {"text": "한"})
        cdp.detach()

    # ── QUEUE-ANCHOR (W4-PAGE-04/05/08) ──
    def approve_next(self):
        self.page.locator("#b-approve-next").click()

    def test_approve_and_next_under_a_w_filter_goes_to_the_following_row_not_the_first(self):
        self.open()
        self.filter_waiting()
        self.open_study(h.PATIENT_B)
        self.type("SYN B report")
        self.approve_next()
        self.wait(lambda: self.selected() == PATIENT_C, "Approve & Next to the row after B")
        self.assertEqual("A", self.site.store[h.UID_B]["report"]["rs"])
        self.assertEqual("SYN B report", self.site.store[h.UID_B]["report"]["findings"])
        self.assertEqual(PATIENT_C, self.editor_of())
        self.assertNotIn(h.PATIENT_B, self.page.locator("#rows").inner_text(), "the approved study left the W filter")

    def test_approve_and_next_follows_the_sorted_order_the_reader_sees(self):
        self.open()
        self.page.locator("#heads th[data-key=name]").click()
        self.page.locator("#heads th[data-key=name]").click()   # descending: CHARLIE, BRAVO, ALPHA
        self.filter_waiting()
        self.open_study(h.PATIENT_B)
        self.type("SYN B report")
        self.approve_next()
        self.wait(lambda: self.selected() == h.PATIENT, "the next row in the sorted queue")

    def test_plain_approve_stays_and_next_continues_from_the_anchor(self):
        self.open()
        self.filter_waiting()
        self.open_study(h.PATIENT_B)
        self.type("SYN B report")
        self.page.locator("#b-approve").click()
        self.wait(lambda: self.site.store[h.UID_B]["report"]["rs"] == "A", "the approval")
        self.wait(lambda: h.PATIENT_B not in self.page.locator("#rows").inner_text(), "B left the filter")
        self.settle()
        self.assertEqual(h.PATIENT_B, self.selected(), "Approve stays on the study")
        self.page.locator("#b-next").click()
        self.wait(lambda: self.selected() is not None and self.selected() != h.PATIENT_B, "Next")
        self.assertEqual(PATIENT_C, self.selected(), "Next continues after B, not the first row")

    def test_refresh_between_press_and_answer_keeps_the_anchor(self):
        self.open()
        self.filter_waiting()
        self.open_study(h.PATIENT_B)
        self.type("SYN B report")
        self.site.commit_answers = ["hold"]
        self.approve_next()
        self.wait(lambda: self.site.held_flow_commits, "the commit")
        lists = self.site.count("GET", "/api/studies")
        self.page.get_by_role("group", name="Refresh").get_by_role("button", name="Refresh", exact=True).click()
        self.wait(lambda: self.site.count("GET", "/api/studies") > lists, "the refresh")
        self.settle(300)
        self.assertEqual(h.PATIENT_B, self.selected(), "no move before the approval's answer is applied")
        self.site.finish_flow_commit()
        self.wait(lambda: self.selected() == PATIENT_C, "the move after the accepted commit")

    def test_approve_and_next_unknown_or_refused_never_moves(self):
        self.open()
        self.open_study(h.PATIENT_B)
        self.type("SYN B report")
        # Refused: the server's version moved on (another reader saved).
        self.site.store[h.UID_B]["report"]["version"] = 3
        self.site.commit_answers = [(409, {"code": "REPORT_VERSION_CONFLICT", "message": "SYN refused commit"})]
        self.approve_next()
        self.wait(lambda: self.site.flow_commits, "the refused commit")
        self.settle(300)
        self.assertEqual(h.PATIENT_B, self.selected())
        self.site.store[h.UID_B]["report"]["version"] = 0
        # Unknown: the server stores the approval but its answer is lost; the page reads the state afterwards.
        self.site.commit_answers = ["lost"]
        self.approve_next()
        self.wait(lambda: self.site.store[h.UID_B]["report"]["rs"] == "A", "the server stored the approval")
        self.settle(500)
        self.assertEqual(h.PATIENT_B, self.selected(), "an approval whose answer was lost does not move")

    def test_late_commit_answer_cannot_move_after_the_reader_chose_another_study(self):
        self.open()
        self.open_study(h.PATIENT_B)
        self.type("SYN B report")
        self.site.commit_answers = ["hold"]
        self.approve_next()
        self.wait(lambda: self.site.held_flow_commits, "the commit")
        self.pick(h.PATIENT)                       # the reader asks for A while the approval is out
        self.page.clock.run_for(3001)
        expect(self.notice()).to_contain_text("Result Unknown")
        self.site.finish_flow_commit()
        self.wait(lambda: self.site.store[h.UID_B]["report"]["rs"] == "A", "the accepted approval")
        self.settle(400)
        self.assertEqual(h.PATIENT_B, self.selected(), "the late answer neither goes to C nor jumps to A by itself")
        self.page.locator("#report-notice-check").click()
        self.wait(lambda: self.selected() == h.PATIENT, "the reader's own choice, confirmed")

    def test_a_b_a_late_commit_answer_cannot_move_another_selection(self):
        self.open()
        self.open_study(h.PATIENT_B)
        self.type("SYN B report")
        self.site.commit_answers = ["hold"]
        self.approve_next()
        self.wait(lambda: self.site.held_flow_commits, "the commit")
        # The reader's own A -> B while the answer is out (the wait ends with the accepted answer).
        self.pick(h.PATIENT)
        self.site.finish_flow_commit()
        self.wait(lambda: self.selected() == h.PATIENT, "the reader's move after the accepted answer")
        self.pick(h.PATIENT_B)
        self.wait(lambda: self.selected() == h.PATIENT_B, "back to B")
        self.settle(400)
        self.assertEqual(h.PATIENT_B, self.selected(), "the earlier Approve & Next does not move this selection")

    def test_approve_and_next_pressed_during_a_composition_approves_and_stays_with_the_notice(self):
        self.open()
        self.open_study(h.PATIENT_B)
        self.type("SYN B report")
        cdp = self.compose()
        # Pressed by script while the composition is open (a real press would end it first).
        self.page.locator("#b-approve-next").dispatch_event("click")
        self.wait(lambda: self.site.store[h.UID_B]["report"]["rs"] == "A", "the accepted approval")
        self.assertEqual("SYN B report한", self.site.store[h.UID_B]["report"]["findings"])
        expect(self.notice()).to_contain_text("Not Moved")
        self.assertEqual(h.PATIENT_B, self.selected(), "no move while the composition is open")
        cdp.send("Input.insertText", {"text": ""})
        cdp.detach()

    def test_approved_study_keeps_approve_and_next_disabled_with_the_reason(self):
        self.site.store[h.UID_B]["report"] = {"version": 2, "rs": "A", "findings": "SYN approved", "conclusion": "",
                                             "recommendation": ""}
        self.open()
        self.open_study(h.PATIENT_B)
        for button in ("#b-approve", "#b-approve-next", "#b-save"):
            expect(self.page.locator(button)).to_be_disabled()
            expect(self.page.locator(button)).to_have_attribute("title", re.compile("Addendum"))

    # ── RECOMMENDATION-ROUNDTRIP (W4-PAGE-12) ──
    def insert_template(self):
        if not self.page.locator("#tplrows tr", has_text=TEMPLATE["title"]).first.is_visible():
            self.page.locator("[data-study-panel-tab=templates]").first.click()
        self.page.locator("#tplrows tr", has_text=TEMPLATE["title"]).first.dblclick()

    def test_recommendation_from_a_template_is_announced_read_only_saved_and_shown_again(self):
        self.site.templates = [TEMPLATE]
        self.open()
        self.open_study(h.PATIENT)
        expect(self.page.locator("#recnote")).to_be_hidden()
        self.insert_template()
        note = self.page.locator("#recnote")
        expect(note).to_be_visible()
        expect(note.locator("summary")).to_have_text("Recommendation (existing value · read only)")
        self.page.locator("#recnote summary").click()
        expect(self.page.locator("#recnote-text")).to_have_text(TEMPLATE["recommendation"])
        # Read only: no editor in the notice, the hidden field stays hidden and out of reach.
        self.assertEqual(0, note.locator("textarea, input, [contenteditable=true]").count())
        hidden = self.page.locator("#recommendation")
        self.assertEqual(("true", "-1"), (hidden.get_attribute("aria-hidden"), hidden.get_attribute("tabindex")))
        self.page.locator("#recnote summary").focus()
        self.page.keyboard.press("Tab")
        self.assertNotEqual("recommendation", self.page.evaluate("document.activeElement?.id"))
        # Saved with the other two fields (the autosave's whole snapshot), and shown again when the study reopens.
        self.page.clock.run_for(20001)
        self.wait(lambda: self.stored(h.UID) is not None, "the autosave")
        self.assertEqual(TEMPLATE["recommendation"], self.site.flow_puts[-1][1]["recommendation"])
        self.assertEqual({k: TEMPLATE[k] for k in FIELDS}, self.stored(h.UID))
        self.pick(h.PATIENT_B)
        self.wait(lambda: self.selected() == h.PATIENT_B, "B")
        expect(note).to_be_hidden()
        self.pick(h.PATIENT)
        self.wait(lambda: self.selected() == h.PATIENT, "A again")
        expect(note).to_be_visible()
        self.page.goto(h.MAIN_URL)
        self.open_study(h.PATIENT)
        expect(note).to_be_visible()
        self.page.locator("#recnote summary").click()
        expect(self.page.locator("#recnote-text")).to_have_text(TEMPLATE["recommendation"])
        # The approval carries the three fields.
        self.page.locator("#b-approve").click()
        self.wait(lambda: self.site.flow_commits, "the approval")
        self.assertEqual(TEMPLATE["recommendation"], self.site.flow_commits[-1][1]["recommendation"])

    # ── MENU-TARGET (W4-PAGE-10) ──
    def right_click(self, patient):
        """A context menu on the row as the mouse opens it (dispatched: a real right press would end a composition)."""
        row = self.row(patient)
        box = row.evaluate("tr => { const r = tr.getBoundingClientRect(); return { x: r.x, y: r.y }; }")
        row.dispatch_event("contextmenu", {"clientX": box["x"] + 5, "clientY": box["y"] + 5, "button": 2})

    def menu_shown(self):
        return self.page.evaluate("getComputedStyle(document.querySelector('#ctx')).display !== 'none'")

    def test_menu_during_composition_does_not_open_for_another_row(self):
        self.open()
        self.open_study(h.PATIENT)
        cdp = self.compose()
        self.right_click(h.PATIENT_B)
        self.assertFalse(self.menu_shown(), "no menu of B while A stays selected")
        self.assertEqual(h.PATIENT, self.selected())
        expect(self.notice()).to_contain_text("Not Moved")
        cdp.send("Input.insertText", {"text": "한"})
        cdp.detach()

    def test_menu_on_a_non_selected_row_opens_after_the_move_and_acts_on_that_row(self):
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A typed")
        self.site.put_answers = ["hold"]
        self.right_click(h.PATIENT_B)
        self.wait(lambda: self.site.held_flow_puts, "the draft write of A")
        self.assertFalse(self.menu_shown(), "the menu waits for the move")
        self.site.finish_flow_put()
        self.wait(self.menu_shown, "the menu of B once B is selected")
        self.assertEqual(h.PATIENT_B, self.selected())
        self.page.locator("#ctx [data-i]", has_text="판독문 작성으로").click()
        self.assertEqual("findings", self.page.evaluate("document.activeElement?.id"))
        self.assertEqual(h.PATIENT_B, self.editor_of())

    def test_menu_item_bound_to_its_row_does_nothing_after_the_selection_moved(self):
        self.open()
        self.open_study(h.PATIENT)
        self.right_click(h.PATIENT_B)
        self.wait(self.menu_shown, "the menu of B")
        # The selection moves on (keyboard Next) while the menu is still open.
        self.page.evaluate("() => select(studies.find(s => s.name === 'SYN PATIENT CHARLIE').uid)")
        self.page.locator("#ctx [data-i]", has_text="판독문 작성으로").dispatch_event("click")
        self.assertNotEqual("findings", self.page.evaluate("document.activeElement?.id"))

    # ── Ctrl+S dispatch to Finalize (Approve) ──
    def test_ctrl_s_runs_finalize_and_prevents_save_page_only_when_it_runs(self):
        self.open()
        self.page.evaluate(FINALIZE_STAND_IN)
        self.open_study(h.PATIENT)
        self.type("SYN A by keyboard")
        self.page.locator("#findings").focus()
        self.assertTrue(self.page.evaluate(CTRL_S), "the command runs: the browser's Save Page is prevented")
        self.wait(lambda: self.site.flow_commits, "the approval by Ctrl+S")
        self.assertEqual("approve", self.site.flow_commits[-1][1]["action"])
        self.assertEqual("SYN A by keyboard", self.site.flow_commits[-1][1]["findings"])
        self.wait(lambda: self.site.store[h.UID]["report"]["rs"] == "A", "the approval")
        self.settle(300)
        self.assertEqual(h.PATIENT, self.selected(), "Finalize stays on the study")
        # Approved: the command cannot run, so the browser keeps its own Ctrl+S.
        expect(self.page.locator("#b-approve")).to_be_disabled()
        self.assertFalse(self.page.evaluate(CTRL_S), "nothing ran: the browser default is left alone")
        self.settle()
        self.assertEqual(1, len(self.site.flow_commits))

    def test_report_commands_finalize_answers_true_only_when_the_command_ran(self):
        """D1371: the hook a bound viewer frame forwards its Finalize key to (the frame keeps the browser's Ctrl+S
        unless it answers true)."""
        self.open()
        self.open_study(h.PATIENT)
        self.type("SYN A by the hook")
        self.site.commit_answers = ["hold"]
        self.assertIs(True, self.page.evaluate("KinReportCommands.finalize()"))
        self.wait(lambda: self.site.held_flow_commits, "the approval by the hook")
        self.assertEqual("SYN A by the hook", self.site.flow_commits[-1][1]["findings"])
        # While that approval is out the command does not run again.
        self.assertIs(False, self.page.evaluate("KinReportCommands.finalize()"))
        self.site.finish_flow_commit()
        self.wait(lambda: self.site.store[h.UID]["report"]["rs"] == "A", "the approval")
        expect(self.page.locator("#b-approve")).to_be_disabled()
        self.assertIs(False, self.page.evaluate("KinReportCommands.finalize()"), "approved (A): Approve is refused")
        # Another study with an insertion out (setup only, see the module header): Approve's button stays as it is, but
        # the commit would return without doing anything, so the hook does not say it ran.
        self.open_study(h.PATIENT_B)
        expect(self.page.locator("#b-approve")).to_be_enabled()
        self.page.evaluate("insertInFlight = true")
        self.assertIs(False, self.page.evaluate("KinReportCommands.finalize()"))
        self.page.evaluate("insertInFlight = false")
        self.settle()
        self.assertEqual([h.UID], [uid for uid, _ in self.site.flow_commits], "one approval, by the first call")
        self.assertEqual(h.PATIENT_B, self.selected())

    def test_study_info_and_templates_keys_on_the_v2_map(self):
        """The dispatcher reads the v2 map (D1371): Ctrl+Alt+5 still opens Study Info & Templates and Ctrl+Alt+T its
        Templates tab, as with the v1 map."""
        self.open()
        self.page.evaluate(FINALIZE_STAND_IN)
        self.open_study(h.PATIENT)
        drawer = self.page.get_by_role("complementary", name="Study Panel", exact=True)
        self.page.keyboard.press("Control+Alt+5")
        expect(drawer).to_be_visible()
        self.page.keyboard.press("Escape")
        expect(drawer).to_have_count(0)
        self.page.keyboard.press("Control+Alt+t")
        expect(drawer.get_by_role("tab", name="Templates", exact=True)).to_have_attribute("aria-selected", "true")


# Each mutant is a one-off copy of one bundle source (or main.html) served to the page; the product tree is never written.
MUTANTS = [
    ("gate-bypass-on-unknown", "current-study.js", 'if (result.status !== "saved") {',
     'if (result.status !== "saved" && result.status !== "unknown") {',
     "test_save_outcome_unknown_stays_and_check_confirms_from_the_server_then_moves"),
    ("gate-bypass-on-refused", "current-study.js",
     'const why = leaveSaveBlock(uid);\n        if (why) return { status: why.status, reason: why.reason };\n'
     '        const written = await leaveWithin(stashReport(), left);',
     'const why = leaveSaveBlock(uid);\n        if (why) return { status: why.status, reason: why.reason };\n'
     '        const written = await leaveWithin(stashReport(), left); if (written === "refused") return { status: "saved" };',
     "test_save_outcome_refused_stays_with_notice_and_retry_moves_after_the_cause_is_gone"),
    ("doctor-path-waits", "current-study.js", 'if (!uid || !reportConverge.has(uid)) return { status: "clear", uid, selectionSeq: seq };',
     'if (!uid || !reportConverge.has(uid)) return Promise.resolve({ status: "saved", uid, selectionSeq: seq });',
     "test_doctor_path_without_unconfirmed_text_switches_synchronously"),
    ("composition-silent", "current-study.js", 'showReportNotice({ status: "composing", uid, seq, reason });', '',
     "test_composition_open_row_click_and_next_stay_and_say_so"),
    ("composition-during-wait-moves", "current-study.js",
     'if (reportFrame?.isComposing()) {\n          showReportNotice({ status: "composing", uid: leave.from.uid',
     'if (false) {\n          showReportNotice({ status: "composing", uid: leave.from.uid',
     "test_composition_started_while_the_save_is_out_keeps_the_study"),
    ("anchor-from-current-list", "report-toolbar.js", "if (at === -1) return", "if (true) return",
     "test_plain_approve_stays_and_next_continues_from_the_anchor"),
    ("approve-next-first-row", "report-toolbar.js", "if (at === -1) return", "if (true) return",
     "test_approve_and_next_under_a_w_filter_goes_to_the_following_row_not_the_first"),
    # The acceptance rule as a whole: accepted, nothing typed after the press, the same selection, the approval on screen.
    ("move-on-any-answer", "report-commit.js",
     "if (!done?.accepted || done.lateText || done.uid !== selectedUid || done.seq !== selectionSeq || !reportShowsAccepted(done.uid)) return;",
     "if (false) return;", "test_approve_and_next_unknown_or_refused_never_moves"),
    ("late-answer-moves", "report-commit.js", "if (studyRequests !== asked) return;", "",
     "test_late_commit_answer_cannot_move_after_the_reader_chose_another_study"),
    ("notice-hidden-for-recommendation", "report-editor.js", "box.hidden = !value;", "box.hidden = true;",
     "test_recommendation_from_a_template_is_announced_read_only_saved_and_shown_again"),
    ("menu-acts-on-old-selection", "context-menu.js", "whenSelected(select(uid), uid, () => showRowMenu(e, uid));",
     "select(uid); showRowMenu(e, uid);", "test_menu_during_composition_does_not_open_for_another_row"),
    ("menu-waits-not", "context-menu.js", "whenSelected(select(uid), uid, () => showRowMenu(e, uid));",
     "select(uid); showRowMenu(e, uid);", "test_menu_on_a_non_selected_row_opens_after_the_move_and_acts_on_that_row"),
    ("menu-item-unbound", "context-menu.js", "act: () => { if (selectedUid === uid) $(\"#findings\").focus(); } },",
     "act: () => $(\"#findings\").focus() },", "test_menu_item_bound_to_its_row_does_nothing_after_the_selection_moved"),
    ("ctrl-s-prevents-when-not-run", "page-boot.js",
     "if (KinReportCommands.finalize() === true) { event.preventDefault(); event.stopImmediatePropagation(); }",
     "KinReportCommands.finalize(); event.preventDefault(); event.stopImmediatePropagation();",
     "test_ctrl_s_runs_finalize_and_prevents_save_page_only_when_it_runs"),
    # D1371: the dispatcher reads the v2 map; the v1 view has no Finalize key.
    ("dispatcher-reads-v1-map", "page-boot.js", "(KinWorkspaceShortcuts.readV2 ?? KinWorkspaceShortcuts.read)(workspaceStorage, owner)",
     "KinWorkspaceShortcuts.read(workspaceStorage, owner)", "test_ctrl_s_runs_finalize_and_prevents_save_page_only_when_it_runs"),
    ("templates-chord-merged-into-v2-map", "page-boot.js", "KinWorkspaceShortcuts.action({ context: 'KeyT' }, event)",
     "KinWorkspaceShortcuts.action({ ...bindings, context: 'KeyT' }, event)", "test_study_info_and_templates_keys_on_the_v2_map"),
    ("finalize-hook-always-true", "page-boot.js", "finalize: () => finalizeCommand()", "finalize: () => (finalizeCommand(), true)",
     "test_report_commands_finalize_answers_true_only_when_the_command_ran"),
    ("finalize-hook-ran-during-insertion", "report-commit.js",
     'if (mode !== "Radiology" || commitInFlight || insertInFlight || reportCommandBlocked("finalize")) return false;',
     'if (mode !== "Radiology" || reportCommandBlocked("finalize")) return false;',
     "test_report_commands_finalize_answers_true_only_when_the_command_ran"),
]


def run_mutants():
    case = ReportFlowPage
    names = sorted({row[-1] for row in MUTANTS})
    baseline = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(case(n) for n in names))
    if not baseline.wasSuccessful() or baseline.skipped:
        print("W4 FLOW BASELINE FAILED; no kills claimed")
        return 1
    order = json.loads((ROOT / "scripts/main-split-order.json").read_text(encoding="utf-8"))["sources"]
    originals = {row["file"]: (LITE / row["file"]).read_text(encoding="utf-8") for row in order}
    killed = 0
    for label, file, old, new, name in MUTANTS:
        source = originals[file] if file in originals else (LITE / file).read_text(encoding="utf-8")
        if source.count(old) != 1:
            raise AssertionError("mutation location not unique: " + label)
        changed = source.replace(old, new, 1)
        case.bundle_source = "".join(changed if row["file"] == file else originals[row["file"]] for row in order)
        case.html_source = changed if file == "main.html" else None
        output = io.StringIO()
        result = unittest.TextTestRunner(stream=output, verbosity=2).run(unittest.TestSuite([case(name)]))
        caught = result.testsRun == 1 and bool(result.failures) and not result.errors and not result.skipped
        print(label, file, "KILLED" if caught else "NOT PROVEN", flush=True)
        print(output.getvalue(), end="")
        killed += int(caught)
    case.bundle_source = None
    case.html_source = None
    print("W4 FLOW mutants killed: %s/%s" % (killed, len(MUTANTS)))
    return 0 if killed == len(MUTANTS) else 1


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    args = sys.argv[1:]
    if args == ["--mutants"]:
        return run_mutants()
    names = args or unittest.defaultTestLoader.getTestCaseNames(ReportFlowPage)
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(ReportFlowPage(n) for n in names))
    return 0 if result.wasSuccessful() and not result.skipped else 1


if __name__ == "__main__":
    raise SystemExit(main())
