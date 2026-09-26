# coding: utf-8
"""REQ-S5-U5b-ADMIN-AUDIT/MOVE-PROJECTION/UNCLEAR-HIDDEN -> RISK-S5-U5b-HIDDEN-COUNT/INVENTED-FIELDS/FAILURE-AS-EMPTY ->
TEST-S5-U5b-DOM.

The Members console (worklist-v0/hpacs-lite/admin.html) gains an Audit / Security section. It reads GET /api/admin/audit
(admin only; the server attributes each row by the institution recorded in it at write time and projects a member move
per side, see tests/admin_audit_attribution_test.cjs) and shows each row's time, actor, action, target, previous value,
reason and recorded detail. This harness loads the shipped admin.html, auth.js and study-access-admin.js unchanged from
a synthetic origin, answers /api/me, the member list, /api/admin/audit and the logout from in-test queues (an answer can
be held and released out of order) and records every request:

  01  opening Members reads only /api/me and the member list; the section says Not Loaded and Events Unknown with no
      table, and both fixed sentences are there (older rows without a recorded institution are not shown, with no count;
      access history is not collected).
  02  one answer in words: time, actor, action, target; a member move's other side reads "withheld: other institution"
      without a name; an absent value reads "not recorded", a recorded null or empty list reads None; Previous Value is a
      member row's before snapshot and otherwise not recorded; Reason only when the row recorded one; one GET with the
      CSRF header and limit=25.
  03  Load More sends the sealed continuation as it came and appends the next page; the last page hides the control.
  04  an empty answer says so in a sentence with no number; nothing about hidden rows is counted.
  05  a failed read is never "no events": a first failure shows no table and no empty sentence; later failures (500,
      malformed, a snapshot carrying email, 403 restricted and other, 409 cursor and access, 503) keep the last rows,
      dimmed, with a fixed sentence and no navigation; a failure after an empty read hides the empty sentence; server
      wording never shows; the next good answer restores the list.
  06  A->B->A: a late older Refresh never paints over a newer one; asking again paints. Control: the page without the
      sequence guard, served through the same route, paints the late answer.
  07  a Load More answer for a list that a Refresh has replaced is dropped. Control: without its guard it is appended.
  08  a 401 empties the section and turns it off before the logout answers; a late answer is received but never read
      or painted; one logout and one navigation.
  09  Log out and 10 a member-list 401 close the section the same way (the page's one session end): a held audit read
      answers late and paints nothing, the control forced on sends nothing.
  11  wording and layout: English heading, controls, headers and state words; Korean guidance and titles; no UXR-SP-34
      avoided word; nothing below 12px; the page's `thead th` stays the member table's; markup in recorded values stays
      text; keyboard; no browser dialog.
  12  the page model refuses what it cannot prove (email in a snapshot, a named withheld side, an unknown rule, more rows
      than the total, bad times and continuations) and never fills an absent value.

Synthetic data only (SYN-* names): no server, no network, no credentials. A request the harness does not answer is
aborted and fails the case, as does a page error or a browser dialog.
"""
from copy import deepcopy
from pathlib import Path
import re
import sys
import time
import unicodedata
import unittest
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"


def lf_text(path):
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


ADMIN_HTML = lf_text(HPACS / "admin.html")
ORIGIN = "https://members.test"
BASE = "/worklist/hpacs-lite/"
PAGE_PATH = BASE + "admin.html"
SCRIPTS = {BASE + name: lf_text(HPACS / name) for name in ("auth.js", "study-access-admin.js")}
INDEX = "<!doctype html><title>SYN index</title><p id=index>SYN INDEX</p>"
INSTITUTION = "SYN-INST-A"
ME = {"sub": "SYN-ADMIN-SUB", "user": "syn-admin", "displayName": "SYN Admin", "roles": ["admin"], "institution": INSTITUTION}
MEMBERS = {"page": 1, "pageSize": 25, "total": 1, "pendingCount": 0, "users": [
    {"id": "SYN-U-1", "username": "syn-member", "email": "syn-member@members.test", "emailVerified": True,
     "name": "SYN Member", "institution": INSTITUTION, "roles": ["technician"], "enabled": True, "approvalState": "APPROVED"}]}
LIST_PATH = "/api/admin/users"
AUDIT_PATH = "/api/admin/audit"
SERVER_WORDING = "SYN-SERVER-WORDING"

INIT = """(() => {
  window.__jsonDone = [];
  const json = Response.prototype.json;
  Response.prototype.json = function () {
    const path = new URL(this.url).pathname;
    return json.call(this).finally(() => { window.__jsonDone.push(path); });
  };
  // Every answer the page receives, read or not: after a session end an answer arrives but its body is never read.
  window.__fetchDone = [];
  const fetch = window.fetch;
  window.fetch = (...args) => fetch(...args).then(response => {
    window.__fetchDone.push(new URL(response.url).pathname);
    return response;
  });
})();"""

MEMBER_ID = "SYN-M-1"
STUDY = "1.2.826.0.1.3680043.10.5001.1"
NOT_RECORDED = "not recorded"
WITHHELD = "withheld: other institution"
TITLE_NOT_RECORDED = "이 행에 기록되지 않은 값입니다. 다른 값으로 짐작해 채우지 않습니다."
TITLE_WITHHELD = "다른 기관 쪽 기록이라 내용과 기관 이름을 보이지 않습니다."
FIXED_UNATTRIBUTED = "오래된 행 중 기록 시점 기관이 없는 행은 표시되지 않습니다."
FIXED_ACCESS_HISTORY = "접속 이력: 수집되지 않음"
EMPTY_SENTENCE = "이 기관에 귀속된 감사 기록이 없습니다."


def at(second):
    return "2026-09-26T00:00:%02d.000Z" % second


def shown_at(second):
    return "2026-09-26 00:00:%02d" % second


def snapshot(institution, state, **rest):
    base = {"id": MEMBER_ID, "username": "syn-m", "name": "SYN Member", "roles": ["technician"], "enabled": True,
            "approvalState": state, "emailVerified": True, "institution": institution}
    base.update(rest)
    return base


MOVE_BEFORE = snapshot(INSTITUTION, "APPROVED")
del MOVE_BEFORE["emailVerified"]   # a field the row did not record reads "not recorded"
MOVE = {"at": at(5), "actor": "syn-admin-z@members.test", "action": "admin.user.update", "target": MEMBER_ID,
        "rule": "member_snapshots", "detail": {"before": MOVE_BEFORE, "after": {"withheld": "other_institution"},
                                              "verificationOverride": True}}
ACCESS = {"at": at(4), "actor": "syn-admin@members.test", "action": "study.access", "target": MEMBER_ID,
          "rule": "field:detail.institution", "detail": {"institution": INSTITUTION, "subject": MEMBER_ID, "revision": 1,
                                                        "restricted": False, "reason": "SYN policy reason",
                                                        "requestId": "00000000-0000-4000-8000-000000000004"}}
APPROVE = {"at": at(3), "actor": "syn-admin@members.test", "action": "admin.user.approve", "target": MEMBER_ID,
           "rule": "member_snapshots", "detail": {"before": snapshot(None, "PENDING", roles=[], emailVerified=False),
                                                  "after": snapshot(INSTITUTION, "APPROVED"), "verificationOverride": True}}
PATCH = {"at": at(2), "actor": "syn-admin@members.test", "action": "state.patch", "target": STUDY, "rule": "field:detail.by",
         "detail": {"ward": "SYN-WARD", "by": INSTITUTION}}
CREATE = {"at": at(1), "actor": "syn-admin@members.test", "action": "admin.user.create", "target": MEMBER_ID,
          "rule": "member_snapshots", "detail": {"before": None, "after": snapshot(INSTITUTION, "APPROVED"),
                                                 "verificationOverride": True}}
CURSOR = "SYN-CURSOR_1-sealed"


def answer(rows, total, second=1, next_=None, institution=INSTITUTION):
    return {"institutionId": institution, "observedAt": at(second), "total": total, "rows": deepcopy(rows), "next": next_}


PAGE1 = answer([MOVE, ACCESS, APPROVE], 5, second=1, next_=CURSOR)
PAGE2 = answer([PATCH, CREATE], 5, second=2)
EMPTY = answer([], 0, second=3)

AFTER_LINES = ["after.id: SYN-M-1", "after.username: syn-m", "after.name: SYN Member", "after.roles: technician",
               "after.enabled: true", "after.approvalState: APPROVED", "after.emailVerified: true",
               "after.institution: SYN-INST-A"]
EXPECTED = {
    "admin.user.update": {
        "previous": ["id: SYN-M-1", "username: syn-m", "name: SYN Member", "roles: technician", "enabled: true",
                     "approvalState: APPROVED", "emailVerified: " + NOT_RECORDED, "institution: SYN-INST-A"],
        "reason": [NOT_RECORDED], "detail": ["after: " + WITHHELD, "verificationOverride: true"]},
    "study.access": {
        "previous": [NOT_RECORDED], "reason": ["SYN policy reason"],
        "detail": ["institution: SYN-INST-A", "subject: SYN-M-1", "revision: 1", "restricted: false",
                   "requestId: 00000000-0000-4000-8000-000000000004"]},
    "admin.user.approve": {
        "previous": ["id: SYN-M-1", "username: syn-m", "name: SYN Member", "roles: None", "enabled: true",
                     "approvalState: PENDING", "emailVerified: false", "institution: None"],
        "reason": [NOT_RECORDED], "detail": AFTER_LINES + ["verificationOverride: true"]},
    "state.patch": {"previous": [NOT_RECORDED], "reason": [NOT_RECORDED], "detail": ["ward: SYN-WARD", "by: SYN-INST-A"]},
    "admin.user.create": {"previous": [NOT_RECORDED], "reason": [NOT_RECORDED], "detail": AFTER_LINES + ["verificationOverride: true"]},
}

TABLE = """() => [...document.querySelectorAll('#audit-rows > tr')].map(tr => {
  const cells = [...tr.children];
  const lines = td => [...td.querySelectorAll('.aline')].map(line => line.textContent);
  const marks = td => [...td.querySelectorAll('.aval')].filter(v => !v.classList.contains('value')).map(v => [v.className, v.title]);
  return {action: tr.dataset.action, target: tr.dataset.target, time: cells[0].textContent, timeTitle: cells[0].title,
    actor: cells[1].textContent, act: cells[2].textContent, tgt: cells[3].textContent,
    previous: lines(cells[4]), reason: lines(cells[5]), detail: lines(cells[6]),
    marks: [...marks(cells[4]), ...marks(cells[5]), ...marks(cells[6])]}; })"""

SUMMARY = """() => { const q = s => document.querySelector(s), state = q('#audit-state');
  return {state: state.textContent, stateClass: state.className, stateTitle: state.title,
    counts: q('#audit-counts').textContent, countsTitle: q('#audit-counts').title,
    message: q('#audit-message').textContent, messageShown: q('#audit-message').classList.contains('show'),
    wrapHidden: q('#audit-wrap').hidden, stale: q('#audit-table').classList.contains('stale'),
    emptyHidden: q('#audit-empty').hidden, empty: q('#audit-empty').textContent, busy: !q('#audit-busy').hidden,
    rows: document.querySelectorAll('#audit-rows > tr').length, refreshDisabled: q('#audit-refresh').disabled,
    moreHidden: q('#audit-more').hidden, moreDisabled: q('#audit-more').disabled,
    fixed: [q('#audit-unattributed').textContent, q('#audit-access-history').textContent],
    openDialogs: document.querySelectorAll('dialog[open]').length}; }"""

AVOIDED = re.compile(r"진단|검출|판정|우선순위|diagnos|detect|priorit|\bAI\b", re.IGNORECASE)
REFRESH_GUARD = "        if (seq !== audit.seq) return;\n"
MORE_GUARD = "        if (seq !== audit.seq || audit.next !== cursor) return;\n"
FIXED = {
    "failed": "감사 기록을 불러오지 못했습니다.",
    "malformed": "조회 응답 형식을 확인할 수 없습니다.",
    "restricted": "검사 접근 범위가 제한된 계정은 감사 기록을 볼 수 없습니다.",
    "forbidden": "이 계정으로는 감사 기록을 조회할 수 없습니다.",
    "expired": "이어받기 유효기간이 지났거나 서버가 다시 시작되었습니다. Refresh Audit로 처음부터 다시 조회하세요.",
    "changed": "검사 접근 조건이 바뀌었습니다. 다시 조회하세요.",
    "busy": "서버가 바쁘거나 감사 기록 조회가 지연되었습니다. 잠시 후 다시 조회하세요.",
}


def has_hangul(text):
    return any(unicodedata.name(ch, "").startswith("HANGUL") for ch in text)


def variant(old, new=""):
    found = ADMIN_HTML.count(old)
    if found != 1:
        raise AssertionError(f"setup: {old!r} occurs {found} times in admin.html")
    return ADMIN_HTML.replace(old, new)


class AdminAuditDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.admin_body = ADMIN_HTML
        self.calls, self.unexpected, self.errors, self.dialogs = [], [], [], []
        self.replies, self.held = [], []
        self.member_replies = []
        self.logouts, self.held_logouts = 0, None
        self.context = self.browser.new_context(timezone_id="UTC", viewport={"width": 1280, "height": 900})
        self.context.add_init_script(INIT)
        self.page = self.context.new_page()
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", self.on_dialog)
        self.page.route("**/*", self.route)

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.unexpected, "requests the harness does not answer")
        self.assertEqual([], self.dialogs, "browser dialogs")

    def on_dialog(self, dialog):
        self.dialogs.append(dialog.message)
        dialog.dismiss()

    # ── synthetic origin ──
    def route(self, route):
        request = route.request
        url = urlparse(request.url)
        method, path = request.method, url.path
        if f"{url.scheme}://{url.netloc}" != ORIGIN:
            self.unexpected.append(f"{method} {request.url}")
            route.abort()
            return
        self.calls.append({"method": method, "path": path, "query": url.query, "csrf": request.headers.get("x-kin-csrf")})
        if method == "GET" and path == PAGE_PATH:
            route.fulfill(body=self.admin_body, content_type="text/html; charset=utf-8")
            return
        if method == "GET" and path in SCRIPTS:
            route.fulfill(body=SCRIPTS[path], content_type="application/javascript; charset=utf-8")
            return
        if method == "GET" and path == BASE + "index.html":
            route.fulfill(body=INDEX, content_type="text/html; charset=utf-8")
            return
        if path == "/favicon.ico":
            route.fulfill(status=404, body="")
            return
        if path.startswith("/api/") and request.headers.get("x-kin-csrf") != "1":
            self.unexpected.append(f"{method} {path} without X-KIN-CSRF")
            route.abort()
            return
        if method == "GET" and path == "/api/me":
            route.fulfill(json=ME)
            return
        if method == "GET" and path == LIST_PATH and url.query == "page=1":
            if self.member_replies:
                status, body = self.member_replies.pop(0)
                route.fulfill(status=status, json=body)
                return
            route.fulfill(json=MEMBERS)
            return
        if method == "GET" and path == AUDIT_PATH:
            if not self.replies:
                self.unexpected.append(f"{method} {request.url} (no answer queued)")
                route.abort()
                return
            reply = self.replies.pop(0)
            if reply == "hold":
                self.held.append(route)
                return
            status, body = reply
            route.fulfill(status=status, json=body)
            return
        if method == "POST" and path == "/api/auth/logout":
            self.logouts += 1
            if self.held_logouts is not None:
                self.held_logouts.append(route)
                return
            route.fulfill(status=204, body="")
            return
        self.unexpected.append(f"{method} {request.url}")
        route.abort()

    # ── page helpers ──
    def wait_until(self, predicate, what, timeout=10.0):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail(f"{what}: not observed within {timeout:.0f}s")
            self.page.wait_for_timeout(10)

    def json_done(self):
        return self.page.evaluate("path => window.__jsonDone.filter(item => item === path).length", AUDIT_PATH)

    def fetch_done(self):
        return self.page.evaluate("path => window.__fetchDone.filter(item => item === path).length", AUDIT_PATH)

    def open(self, body=None):
        self.admin_body = ADMIN_HTML if body is None else body
        self.calls, self.replies, self.held, self.logouts, self.held_logouts = [], [], [], 0, None
        self.page.goto(ORIGIN + PAGE_PATH)
        expect(self.page.locator("#users td.username")).to_have_count(1)
        expect(self.page.locator("#audit-refresh")).to_be_enabled()

    def summary(self):
        return self.page.evaluate(SUMMARY)

    def table(self):
        return self.page.evaluate(TABLE)

    def audit_gets(self):
        return [(c["query"], c["csrf"]) for c in self.calls if c["path"] == AUDIT_PATH]

    def refresh(self, reply):
        """Queue one audit answer (never a 401: that is judged before any body is read), press Refresh Audit and wait
        until the page has read it and finished drawing."""
        before = self.json_done()
        self.replies.append(reply)
        self.page.locator("#audit-refresh").click()
        self.wait_until(lambda: self.json_done() > before, "the audit answer read")
        self.wait_until(lambda: not self.summary()["busy"], "the load finished")

    def more(self, reply):
        before = self.json_done()
        self.replies.append(reply)
        self.page.locator("#audit-more").click()
        self.wait_until(lambda: self.json_done() > before, "the next page read")
        self.wait_until(lambda: not self.summary()["busy"], "the next page finished")

    def section_texts(self):
        return self.page.evaluate("""() => { const section = document.querySelector('#audit');
          return [section.textContent, ...[...section.querySelectorAll('[title]')].map(e => e.title)]; }""")

    def assert_rows(self, rows, actions):
        self.assertEqual(actions, [r["action"] for r in rows])
        for r in rows:
            with self.subTest(action=r["action"]):
                expected = EXPECTED[r["action"]]
                self.assertEqual((r["act"], r["previous"], r["reason"], r["detail"]),
                                 (r["action"], expected["previous"], expected["reason"], expected["detail"]))

    # ── cases ──
    def test_01_opening_members_reads_no_audit_until_asked(self):
        self.open()
        self.page.wait_for_timeout(300)
        self.assertEqual([("GET", "/api/me", ""), ("GET", LIST_PATH, "page=1")],
                         [(c["method"], c["path"], c["query"]) for c in self.calls if c["path"].startswith("/api/")])
        s = self.summary()
        self.assertEqual(("Not Loaded", "astate not_loaded", "Events Unknown", True, True, 0, False, True, False),
                         (s["state"], s["stateClass"], s["counts"], s["wrapHidden"], s["emptyHidden"], s["rows"],
                          s["messageShown"], s["moreHidden"], s["busy"]))
        self.assertEqual([FIXED_UNATTRIBUTED, FIXED_ACCESS_HISTORY], s["fixed"])
        self.assertIsNone(re.search(r"\d", s["fixed"][0]), "the unattributed-rows sentence carries no count")
        self.assertIsNotNone(self.page.evaluate("() => window.KinAdminAudit ?? null"))

    def test_02_rows_in_words_with_not_recorded_and_withheld(self):
        self.open()
        self.refresh((200, PAGE1))
        s = self.summary()
        self.assertEqual(("Loaded " + shown_at(1), "astate observed", "Showing 3 of 5 Events", False, True, False, False, False),
                         (s["state"], s["stateClass"], s["counts"], s["wrapHidden"], s["emptyHidden"], s["stale"],
                          s["moreHidden"], s["moreDisabled"]))
        self.assertEqual([("limit=25", "1")], self.audit_gets())
        rows = self.table()
        self.assert_rows(rows, ["admin.user.update", "study.access", "admin.user.approve"])
        move = rows[0]
        self.assertEqual((shown_at(5), "기록한 서버 시각 " + at(5), "syn-admin-z@members.test", MEMBER_ID),
                         (move["time"], move["timeTitle"], move["actor"], move["tgt"]))
        self.assertEqual([["aval not_recorded", TITLE_NOT_RECORDED], ["aval not_recorded", TITLE_NOT_RECORDED],
                          ["aval withheld", TITLE_WITHHELD]], move["marks"])
        # study.access recorded a reason, so only its previous value is not recorded.
        self.assertEqual([["aval not_recorded", TITLE_NOT_RECORDED]], rows[1]["marks"])
        approve_marks = [m[0] for m in rows[2]["marks"]]
        self.assertEqual(["aval none", "aval none", "aval not_recorded"], approve_marks, "recorded nulls read None, not 'not recorded'")
        text = self.section_texts()[0]
        self.assertNotIn("SYN-INST-B", text)
        self.assertNotIn("email:", text, "no email line: the server projects none and the page has no email field")

    def test_03_load_more_appends_the_next_page_with_the_sealed_continuation(self):
        self.open()
        self.refresh((200, PAGE1))
        self.more((200, PAGE2))
        self.assertEqual([("limit=25", "1"), ("limit=25&after=" + CURSOR, "1")], self.audit_gets())
        rows = self.table()
        self.assert_rows(rows, ["admin.user.update", "study.access", "admin.user.approve", "state.patch", "admin.user.create"])
        s = self.summary()
        self.assertEqual(("Showing 5 of 5 Events", True, "Loaded " + shown_at(1)), (s["counts"], s["moreHidden"], s["state"]))

    def test_04_an_empty_answer_says_so_without_a_number(self):
        self.open()
        self.refresh((200, EMPTY))
        s = self.summary()
        self.assertEqual((EMPTY_SENTENCE, False, True, 0, "Showing 0 of 0 Events", True, "Loaded " + shown_at(3)),
                         (s["empty"], s["emptyHidden"], s["wrapHidden"], s["rows"], s["counts"], s["moreHidden"], s["state"]))
        self.assertIsNone(re.search(r"\d", s["empty"]))
        self.assertEqual([FIXED_UNATTRIBUTED, FIXED_ACCESS_HISTORY], s["fixed"])
        self.assertNotRegex(s["countsTitle"], r"\d")

    def test_05_a_failed_read_is_never_no_events(self):
        self.open()
        self.refresh((503, {"message": SERVER_WORDING}))
        s = self.summary()
        self.assertEqual(("Query Failed · 아직 성공한 조회가 없습니다", "astate query_failed", FIXED["busy"], True, True, True, 0,
                          "Events Unknown", True),
                         (s["state"], s["stateClass"], s["message"], s["messageShown"], s["wrapHidden"], s["emptyHidden"],
                          s["rows"], s["counts"], s["moreHidden"]))
        self.refresh((200, PAGE1))
        self.assertEqual(3, self.summary()["rows"])
        email_row = deepcopy(MOVE)
        email_row["detail"]["before"]["email"] = "syn-m@members.test"
        for reply, sentence in (((500, {"message": SERVER_WORDING}), FIXED["failed"]),
                                ((200, {"rows": "SYN", "observedAt": at(4)}), FIXED["malformed"]),
                                ((200, answer([email_row], 1, second=4)), FIXED["malformed"]),
                                ((403, {"code": "ADMIN_AUDIT_RESTRICTED", "message": SERVER_WORDING}), FIXED["restricted"]),
                                ((403, {"message": SERVER_WORDING}), FIXED["forbidden"]),
                                ((409, {"code": "ADMIN_AUDIT_CURSOR_EXPIRED", "message": SERVER_WORDING}), FIXED["expired"]),
                                ((409, {"code": "STUDY_ACCESS_CHANGED", "message": SERVER_WORDING}), FIXED["changed"]),
                                ((503, {"code": "ADMIN_AUDIT_UNAVAILABLE", "message": SERVER_WORDING}), FIXED["busy"])):
            with self.subTest(status=reply[0], sentence=sentence):
                self.refresh(reply)
                s = self.summary()
                self.assertEqual(("Query Failed · 마지막 조회 기준 " + shown_at(1), "astate query_failed", sentence, True,
                                  False, True, True, 3, "Showing 3 of 5 Events", True),
                                 (s["state"], s["stateClass"], s["message"], s["messageShown"], s["wrapHidden"], s["stale"],
                                  s["emptyHidden"], s["rows"], s["counts"], s["moreDisabled"]))
                self.assertEqual(ORIGIN + PAGE_PATH, self.page.url, "a refusal never leaves the page")
        self.assertLess(float(self.page.evaluate("() => getComputedStyle(document.querySelector('#audit-rows')).opacity")), 1.0)
        self.assertFalse(any(SERVER_WORDING in text for text in self.section_texts()))
        self.assertNotIn("syn-m@members.test", self.section_texts()[0])
        self.refresh((200, PAGE1))
        s = self.summary()
        self.assertEqual(("Loaded " + shown_at(1), False, False, False), (s["state"], s["stale"], s["messageShown"], s["moreDisabled"]))
        # A failure after an empty read: the empty sentence goes, the failure stays a failure.
        self.refresh((200, EMPTY))
        self.assertFalse(self.summary()["emptyHidden"])
        self.refresh((500, {"message": SERVER_WORDING}))
        s = self.summary()
        self.assertEqual((True, "Query Failed · 마지막 조회 기준 " + shown_at(3), FIXED["failed"]),
                         (s["emptyHidden"], s["state"], s["message"]))

    def hold(self, n):
        """n audit Refresh reads in flight, oldest first."""
        self.replies += ["hold"] * n
        button = self.page.locator("#audit-refresh")
        for index in range(n):
            button.click()
            self.wait_until(lambda: len(self.held) == index + 1, f"read {index + 1} in flight")
        held, self.held = self.held, []
        return held

    def a_b(self):
        older = answer([ACCESS], 1, second=7)
        newer = answer([PATCH], 1, second=8)
        first, second = self.hold(2)
        second.fulfill(json=newer)
        self.wait_until(lambda: self.json_done() == 1, "the newer answer read")
        expect(self.page.locator("#audit-state")).to_have_text("Loaded " + shown_at(8))
        first.fulfill(json=older)
        self.wait_until(lambda: self.json_done() == 2, "the older answer read")
        self.page.wait_for_timeout(50)
        return older

    def test_06_a_late_older_refresh_never_paints_over_a_newer_one(self):
        self.open()
        older = self.a_b()
        self.assertEqual(("Loaded " + shown_at(8), ["state.patch"]), (self.summary()["state"], [r["action"] for r in self.table()]))
        self.refresh((200, older))
        self.assertEqual(("Loaded " + shown_at(7), ["study.access"]), (self.summary()["state"], [r["action"] for r in self.table()]))
        # Control: without the sequence guard the late older answer is painted over the newer one.
        self.open(variant(REFRESH_GUARD))
        self.page.evaluate("() => { window.__jsonDone = []; }")
        self.a_b()
        self.assertEqual(("Loaded " + shown_at(7), ["study.access"]), (self.summary()["state"], [r["action"] for r in self.table()]))

    def replaced_list(self, body=None):
        """Page 1 shown; a Load More held; a Refresh replaces the list; then the held page answers."""
        self.open(body)
        self.page.evaluate("() => { window.__jsonDone = []; }")
        self.refresh((200, PAGE1))
        self.replies.append("hold")
        self.page.locator("#audit-more").click()
        self.wait_until(lambda: len(self.held) == 1, "the Load More in flight")
        held = self.held.pop()
        self.refresh((200, answer([PATCH], 1, second=9)))
        self.assertEqual(["state.patch"], [r["action"] for r in self.table()])
        held.fulfill(json=PAGE2)
        self.wait_until(lambda: self.json_done() == 3, "the late page read")
        self.page.wait_for_timeout(50)
        return [r["action"] for r in self.table()]

    def test_07_a_load_more_for_a_replaced_list_is_dropped(self):
        self.assertEqual(["state.patch"], self.replaced_list())
        s = self.summary()
        self.assertEqual(("Showing 1 of 1 Event", True, "Loaded " + shown_at(9), False), (s["counts"], s["moreHidden"], s["state"], s["busy"]))
        # Control: without its guard the late page is appended to the list that replaced it.
        self.assertEqual(["state.patch", "state.patch", "admin.user.create"], self.replaced_list(variant(MORE_GUARD)))

    def assert_closed(self, what):
        s = self.summary()
        self.assertEqual((0, True, True, True, True, False, False, "Not Loaded", "astate not_loaded", "Events Unknown"),
                         (s["rows"], s["wrapHidden"], s["emptyHidden"], s["refreshDisabled"], s["moreHidden"], s["busy"],
                          s["messageShown"], s["state"], s["stateClass"], s["counts"]), what)
        self.assertEqual([FIXED_UNATTRIBUTED, FIXED_ACCESS_HISTORY], s["fixed"])
        self.assertIsNone(re.search(r"SYN|syn-|1\.2\.\d", self.section_texts()[0]), f"{what}: nothing of the ended session")

    def test_08_a_401_empties_the_section_before_logout_and_drops_late_answers(self):
        self.open()
        self.refresh((200, PAGE1))
        held = self.hold(1)[0]
        self.held_logouts = []
        self.replies.append((401, {"message": SERVER_WORDING}))
        self.page.locator("#audit-refresh").click()
        self.wait_until(lambda: self.logouts == 1, "the logout request")
        self.assert_closed("a 401 on an audit read")
        held.fulfill(json=PAGE2)
        self.wait_until(lambda: self.fetch_done() == 3, "the late answer received")
        self.page.wait_for_timeout(50)
        self.assert_closed("after the late answer")
        self.assertEqual(1, self.json_done(), "an answer that arrives after the session ended is never read")
        self.held_logouts.pop().fulfill(status=204, body="")
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        expect(self.page.locator("#index")).to_have_text("SYN INDEX")
        self.assertEqual(1, self.logouts)
        self.assertEqual(1, [c["path"] for c in self.calls].count(BASE + "index.html"), "one navigation")

    def end_elsewhere_closes_the_section(self, how):
        self.open()
        self.refresh((200, PAGE1))
        held = self.hold(1)[0]
        self.held_logouts = []
        if how == "logout":
            self.page.locator("#logout").click()
        else:
            self.member_replies.append((401, {"message": SERVER_WORDING}))
            self.page.locator("#refresh").click()
        self.wait_until(lambda: self.logouts == 1, f"the logout request ({how})")
        self.assert_closed(how)
        gets = len(self.audit_gets())
        self.page.evaluate("() => { const b = document.querySelector('#audit-refresh'); b.disabled = false; b.click(); b.disabled = true; }")
        self.page.evaluate("() => { const b = document.querySelector('#audit-more'); b.hidden = false; b.disabled = false; b.click(); }")
        held.fulfill(json=PAGE2)
        self.wait_until(lambda: self.fetch_done() == 2, f"{how}: the late answer received")
        self.page.wait_for_timeout(100)
        self.assertEqual(gets, len(self.audit_gets()), f"{how}: no audit request after the end")
        self.assertEqual((0, 1), (self.summary()["rows"], self.json_done()), f"{how}: the late answer is never read or painted")
        self.held_logouts.pop().fulfill(status=204, body="")
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        self.assertEqual(1, self.logouts)
        self.assertEqual(1, [c["path"] for c in self.calls].count(BASE + "index.html"), "one navigation")

    def test_09_log_out_closes_the_section_at_once(self):
        self.end_elsewhere_closes_the_section("logout")

    def test_10_a_member_list_401_closes_the_section_at_once(self):
        self.end_elsewhere_closes_the_section("members")

    def test_11_wording_layout_and_markup_stay_text(self):
        self.open()
        static = self.page.evaluate("""() => [...document.querySelectorAll('#audit h2, #audit button, #audit th, #audit .astate, #audit-counts')]
          .map(e => e.textContent)""")
        self.assertEqual(["Audit / Security", "Not Loaded", "Events Unknown", "Refresh Audit", "Time", "Actor", "Action", "Target",
                          "Previous Value", "Reason", "Recorded Detail", "Load More"], static)
        self.assertEqual([], [text for text in static if has_hangul(text)])
        hostile = {"at": at(6), "actor": "<b id=pwned-actor>SYN</b>", "action": "state.patch", "target": STUDY,
                   "rule": "field:detail.by", "detail": {"note": "<img src=x onerror=\"window.__pwned=1\">", "by": INSTITUTION}}
        self.replies.append((200, answer([hostile, ACCESS], 2, second=6)))
        self.page.locator("#audit-refresh").focus()
        self.page.keyboard.press("Enter")
        self.wait_until(lambda: self.json_done() == 1, "the keyboard read")
        self.wait_until(lambda: not self.summary()["busy"], "the keyboard load finished")
        rows = self.table()
        self.assertEqual(("<b id=pwned-actor>SYN</b>", ["note: <img src=x onerror=\"window.__pwned=1\">", "by: SYN-INST-A"]),
                         (rows[0]["actor"], rows[0]["detail"]))
        self.page.wait_for_timeout(100)
        self.assertEqual([0, 0, None], self.page.evaluate(
            "() => [document.querySelectorAll('#audit img').length, document.querySelectorAll('#pwned-actor').length, window.__pwned ?? null]"))
        korean = [self.page.evaluate("() => document.querySelector('.audit-hint').textContent"), *self.summary()["fixed"],
                  self.page.evaluate("() => document.querySelector('#audit-access-history').title"),
                  self.summary()["stateTitle"], self.summary()["countsTitle"], rows[0]["timeTitle"],
                  *[mark[1] for row in rows for mark in row["marks"]]]
        self.assertEqual([], [text for text in korean if not has_hangul(text)])
        self.assertEqual([], [text for text in self.section_texts() if AVOIDED.search(text)])
        english = self.page.evaluate("() => [...document.querySelectorAll('#audit h2, #audit button, #audit th, #audit-state')].map(e => e.textContent)")
        self.assertEqual([], [text for text in english if has_hangul(text)])
        sizes = self.page.evaluate("""() => [...document.querySelectorAll('#audit *')]
          .filter(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && e.getClientRects().length)
          .map(e => [e.tagName + '.' + e.className, parseFloat(getComputedStyle(e).fontSize)])""")
        self.assertTrue(sizes)
        self.assertEqual([], [entry for entry in sizes if entry[1] < 12])
        self.assertGreaterEqual(self.page.locator("#audit-refresh").bounding_box()["height"], 24)
        headers = self.page.evaluate("""() => [[...document.querySelectorAll('thead th')].map(th => th.textContent),
          document.querySelectorAll('#audit thead').length, [...document.querySelectorAll('#audit th')].map(th => th.scope)]""")
        self.assertEqual([["아이디", "이름 / 이메일", "기관", "역할", "상태", "작업"], 0, ["col"] * 7], headers)
        self.assertEqual(0, self.summary()["openDialogs"])

    def test_12_the_model_refuses_what_it_cannot_prove(self):
        self.open()
        verdicts = self.page.evaluate("""([good, move]) => {
          const M = window.KinAdminAudit, clone = v => JSON.parse(JSON.stringify(v));
          const with_ = (change) => { const a = clone(good); change(a); return M.readAnswer(a) === null; };
          return {
            good: M.readAnswer(clone(good)) !== null,
            email: with_(a => { a.rows[0].detail.before.email = 'x@y'; }),
            namedWithheld: with_(a => { a.rows[0].detail.after = {withheld: 'other_institution', institution: 'SYN-INST-B'}; }),
            wrongWithheld: with_(a => { a.rows[0].detail.after = {withheld: 'SYN-INST-B'}; }),
            unknownField: with_(a => { a.rows[0].detail.before.password = 'x'; }),
            snapshotWithoutInstitution: with_(a => { delete a.rows[0].detail.before.institution; }),
            noAfter: with_(a => { delete a.rows[0].detail.after; }),
            extraMemberKey: with_(a => { a.rows[0].detail.institution = 'SYN-INST-A'; }),
            unknownRule: with_(a => { a.rows[1].rule = 'hidden:unknown_action'; }),
            noRule: with_(a => { delete a.rows[1].rule; }),
            detailNotObject: with_(a => { a.rows[1].detail = '{"by":"SYN-INST-A"}'; }),
            emptyActor: with_(a => { a.rows[1].actor = ''; }),
            badTime: with_(a => { a.rows[1].at = '2026-09-26 00:00:01'; }),
            moreRowsThanTotal: with_(a => { a.total = 1; }),
            negativeTotal: with_(a => { a.total = -1; }),
            fractionalTotal: with_(a => { a.total = 2.5; }),
            noObservedAt: with_(a => { delete a.observedAt; }),
            emptyNext: with_(a => { a.next = ''; }),
            numericNext: with_(a => { a.next = 7; }),
            noInstitution: with_(a => { a.institutionId = ''; }),
            rowsNotArray: with_(a => { a.rows = {}; }),
            notAnObject: M.readAnswer([]) === null && M.readAnswer(null) === null && M.readAnswer('x') === null,
            lines: M.display(M.readAnswer(clone(good)).rows[0], iso => iso).previous.map(l => [l.label, l.text, l.state]),
            frozen: Object.isFrozen(M) && Object.isFrozen(M.SNAPSHOT_FIELDS) && Object.isFrozen(M.TITLES),
          };
        }""", [answer([MOVE, PATCH], 2), MOVE])
        lines = verdicts.pop("lines")
        self.assertEqual({key: True for key in verdicts}, verdicts)
        self.assertEqual([["id", MEMBER_ID, "value"], ["username", "syn-m", "value"], ["name", "SYN Member", "value"],
                          ["roles", "technician", "value"], ["enabled", "true", "value"], ["approvalState", "APPROVED", "value"],
                          ["emailVerified", NOT_RECORDED, "not_recorded"], ["institution", INSTITUTION, "value"]], lines)


if __name__ == "__main__":
    unittest.main(verbosity=2)
