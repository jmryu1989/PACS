# coding: utf-8
"""REQ-S5-U6b-OPS-METRICS -> RISK-S5-U6b-UNKNOWN-AS-ZERO/INVENTED-THRESHOLD/TENANT-AGGREGATE -> TEST-S5-U6b-DOM.

The Members console (worklist-v0/hpacs-lite/admin.html) gains an Operations section. It reads GET /api/admin/metrics
(admin only; the server scopes every count to the caller's institution and reads only TotalDiskSize from Orthanc, see
tests/admin_metrics_test.cjs) and shows each row with its state, value, unit, denominator, scope, source and observation
time. This harness loads the shipped admin.html, auth.js and study-access-admin.js unchanged from a synthetic origin,
answers /api/me, the member list, /api/admin/metrics and the logout from in-test queues (an answer can be held and
released out of order; the F04 cases also queue a member-list answer and serve study-arrivals.js and the Gateway list)
and records every request:

  01  opening Members reads only /api/me and the member list: no metrics read and no Gateway rules until asked; the
      section says Not Loaded with no table.
  02  one observed answer: every row's eight cells (label, state word, value, unit, denominator, scope, source, observed
      time) in words; Korean titles on every cell; one GET with the CSRF header and no query.
  03  unknown is never 0: failed, timed-out, missing-source, missing and malformed rows read Unobservable with no digit
      in their value, denominator or time; a zero denominator reads No Studies over a known 0 Studies.
  04  Query Failed: a first failure shows no table; later failures (500, malformed, 403 restricted and other, 409 access
      and 409 scope, 503) keep the last table, dimmed, as the last observation with a fixed sentence and no navigation;
      server wording never shows; the next good answer restores it.
  05  A->B->A: a late older answer never paints over a newer one; a later request for the older content paints.
      Control: the page without the sequence guard, served through the same route, paints the late answer.
  06  a 401 empties the section and disables it before the logout request answers; a late answer is received but never
      read or painted; one logout and one navigation.
  07  wording and layout: English controls, headings, labels, state words and units with no Hangul; Korean guidance and
      titles; no UXR-SP-34 avoided word; nothing below 12px; no threshold: a tiny and a huge value share every style,
      only the state chip colour follows the state (with its word); keyboard; no browser dialog.
  08  the Gateway Status section is untouched by Refresh Operations (no /api/studies, no study-arrivals.js).
  09  S5-U6b-F03: with three reads out, the OLDEST read's 401 empties the section at once (Not Loaded, control off) and
      logs out once; the newer 200 and a second 401 neither repaint nor log out again; one navigation. Control: the 401
      judged after the sequence check (the order before the fix) keeps the table, never logs out, and paints the newer.
  10  S5-U6b-F04: with Operations showing a table and two reads out, a 401 on the member list empties the section and
      turns its control off at once (Gateway Status's control too), before the logout answers; the late newer 200 and
      older 401 neither repaint nor log out again; the control forced back on and pressed sends nothing; Log out pressed
      again posts nothing; one logout and one navigation. Control: that 401 straight to KinAuth.logout() (the call before
      the fix) keeps the table and its control, and the late 200 paints over it.
  11  the same for Log out. Control: the button straight to KinAuth.logout() (the handler before the fix).
  12  the same for a 401 on the Gateway Status list read. Control: Operations' closer kept off the page's session end
      (the F04 state: a panel with an end of its own) keeps the ended session's table and control.
  13  an object that already exists (S5-U6a's top-level const above this page's block, as when the two units meet) stays
      the page's one: nothing is put on window, Gateway Status and Operations register with it, Log out ends through it.

WorklistStorageDOMTest (S5-U6b-F02) slices main.html's shipped #storage element and refreshStorage() into a page with a
queued fetch: S01 the default names no number; S02 network failure, bad JSON, a missing or malformed TotalDiskSize, 403
and 500 each read Unobservable with their reason, never 0 or NaN; S03 an observed value and a source-reported 0 carry the
server-wide scope, the source, the raw bytes and the time; S04 a failure after a success reads Unobservable, the last value
only in the title with its time; S05 A->B->A with a control (no sequence guard paints the late answer); S06 the same
units as the Operations row (KinAdminMetrics.formatBytes).

Synthetic data only (SYN-* names): no server, no network, no credentials. A request the harness does not answer is
aborted and fails the case, as does a page error or a browser dialog.
"""
from copy import deepcopy
import json
from pathlib import Path
import re
import sys
import time
import unicodedata
import unittest
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"


def lf_text(path):
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


ADMIN_HTML = lf_text(HPACS / "admin.html")
ORIGIN = "https://members.test"
BASE = "/worklist/hpacs-lite/"
PAGE_PATH = BASE + "admin.html"
ARRIVALS_PATH = BASE + "study-arrivals.js"
# study-arrivals.js is served only once a case asks for Gateway Status (serve_arrivals): anywhere else a request for it
# is unexpected and fails the case.
SCRIPTS = {BASE + name: lf_text(HPACS / name) for name in ("auth.js", "study-access-admin.js")}
INDEX = "<!doctype html><title>SYN index</title><p id=index>SYN INDEX</p>"
INSTITUTION = "SYN-INST-A"
ME = {"sub": "SYN-ADMIN-SUB", "user": "syn-admin", "displayName": "SYN Admin", "roles": ["admin"], "institution": INSTITUTION}
MEMBERS = {"page": 1, "pageSize": 25, "total": 1, "pendingCount": 0, "users": [
    {"id": "SYN-U-1", "username": "syn-member", "email": "syn-member@members.test", "emailVerified": True,
     "name": "SYN Member", "institution": INSTITUTION, "roles": ["technician"], "enabled": True, "approvalState": "APPROVED"}]}
SERVER_WORDING = "SYN-SERVER-WORDING"
METRICS_PATH = "/api/admin/metrics"

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

NOW = "2026-09-26T00:00:00.000Z"
DISK_AT = "2026-09-25T23:59:59.500Z"
DAY = {"from": "2026-09-25T00:00:00.000Z", "to": NOW}
WEEK = {"from": "2026-09-19T00:00:00.000Z", "to": NOW}
SRC = {"disk": "Orthanc GET /statistics TotalDiskSize", "studies": "KIN DB StudyState",
       "registered": "KIN DB StudyState.createdAt",
       "tat": "KIN DB StudyState.createdAt, ReportVersion(action=approve).at, StudyState.em",
       "waiting": "KIN DB StudyState.createdAt, StudyState.rs, StudyState.em"}


def generated(second):
    return "2026-09-26T00:00:%02d.000Z" % second


def shown_generated(second):
    return "2026-09-26 00:00:%02d" % second


def row(key, unit, scope="institution", state="observed", **rest):
    base = {"key": key, "state": state, "reason": None, "scope": scope, "source": None, "observedAt": None, "unit": unit,
            "value": None, "max": None, "denominator": None, "excluded": None, "window": None}
    base.update(rest)
    return base


def count(key, value, **rest):
    source = SRC["registered"] if key.startswith("studies.registered") else SRC["studies"]
    return row(key, "study", source=source, observedAt=NOW, value=value, **rest)


def duration(key, value, top, n, excluded, **rest):
    family = key.split(".")[0]
    return row(key, "second", source=SRC[family], observedAt=NOW, value=value, max=top,
               denominator={"unit": "study", "value": n}, excluded=excluded, **rest)


ROWS = [
    row("storage.server", "byte", scope="server", source=SRC["disk"], observedAt=DISK_AT, value=13421772800,
        denominator={"unit": "byte", "value": None}),
    row("storage.institution", "byte", state="unobservable", reason="no_source", denominator={"unit": "byte", "value": None}),
    count("studies.own", 10), count("studies.tele", 1), count("studies.flag_unreadable", 1),
    count("studies.registered_24h", 7, excluded=0, window=DAY), count("studies.registered_7d", 9, excluded=0, window=WEEK),
    duration("tat.emergency", 14400, 86400, 3, 0, window=WEEK), duration("tat.normal", 86400, 86400, 1, 1, window=WEEK),
    duration("waiting.emergency", 3600, 3600, 1, 0), duration("waiting.normal", 12600, 18000, 2, 1),
]


def answer(second=1, rows=None, institution=INSTITUTION):
    return {"institutionId": institution, "generatedAt": generated(second), "metrics": deepcopy(ROWS if rows is None else rows)}


def replace(rows, target, /, **change):
    # Positional-only target: a whole replacement row carries its own "key" field in change.
    return [dict(r, **change) if r["key"] == target else r for r in deepcopy(rows)]


SCOPE = "Institution " + INSTITUTION
T0, TD = "2026-09-26 00:00:00", "2026-09-25 23:59:59"
BYTES_UNIT, STUDIES, ELAPSED = "Bytes (1 GiB = 1024³ B)", "Studies", "Elapsed Time (Median · Max)"
# (label, state, value, unit, denominator, scope, source, observed) in page order.
EXPECTED = [
    ("Storage Used (Server-wide)", "Observed", "12.50 GiB", BYTES_UNIT, "Capacity Unobservable", "Server-wide", SRC["disk"], TD),
    ("Storage Used (This Institution)", "Unobservable", "Unobservable", BYTES_UNIT, "Capacity Unobservable", SCOPE, "No Source", "Not Observed"),
    ("Studies Owned", "Observed", "10", STUDIES, "Not a Ratio", SCOPE, SRC["studies"], T0),
    ("Studies Received for Tele-reading", "Observed", "1", STUDIES, "Not a Ratio", SCOPE, SRC["studies"], T0),
    ("Emergency Flag Unreadable", "Observed", "1", STUDIES, "Not a Ratio", SCOPE, SRC["studies"], T0),
    ("Registered in KIN (Last 24 h)", "Observed", "7", STUDIES, "Not a Ratio", SCOPE, SRC["registered"], T0),
    ("Registered in KIN (Last 7 d)", "Observed", "9", STUDIES, "Not a Ratio", SCOPE, SRC["registered"], T0),
    ("Report TAT (Emergency)", "Observed", "Median 4 h 00 min · Max 24 h 00 min", ELAPSED, "3 Studies", SCOPE, SRC["tat"], T0),
    ("Report TAT (Normal)", "Observed", "Median 24 h 00 min · Max 24 h 00 min", ELAPSED, "1 Study · 1 Excluded", SCOPE, SRC["tat"], T0),
    ("Waiting (Emergency)", "Observed", "Median 1 h 00 min · Max 1 h 00 min", ELAPSED, "1 Study", SCOPE, SRC["waiting"], T0),
    ("Waiting (Normal)", "Observed", "Median 3 h 30 min · Max 5 h 00 min", ELAPSED, "2 Studies · 1 Excluded", SCOPE, SRC["waiting"], T0),
]
KEYS = [r["key"] for r in ROWS]

TABLE = """() => [...document.querySelectorAll('#metrics-rows > tr')].map(tr => {
  const cells = [...tr.children], chip = cells[1].querySelector('.mstate');
  return {key: tr.dataset.key, state: tr.dataset.state, chipClass: chip.className, chipTitle: chip.title,
    cells: cells.map((td, i) => i === 1 ? chip.textContent : td.textContent),
    titles: cells.map((td, i) => i === 1 ? chip.title : td.title),
    chipBackground: getComputedStyle(chip).backgroundColor,
    valueStyle: (s => [s.color, s.backgroundColor, s.fontWeight, s.fontSize, s.opacity])(getComputedStyle(cells[2]))}; })"""

SUMMARY = """() => { const q = s => document.querySelector(s), state = q('#metrics-state');
  return {state: state.textContent, stateClass: state.className, stateTitle: state.title,
    message: q('#metrics-message').textContent, messageShown: q('#metrics-message').classList.contains('show'),
    wrapHidden: q('#metrics-wrap').hidden, stale: q('#metrics-table').classList.contains('stale'),
    busy: !q('#metrics-busy').hidden, rows: document.querySelectorAll('#metrics-rows > tr').length,
    refreshDisabled: q('#metrics-refresh').disabled, openDialogs: document.querySelectorAll('dialog[open]').length}; }"""

AVOIDED = re.compile(r"진단|검출|판정|우선순위|diagnos|detect|priorit|\bAI\b", re.IGNORECASE)
SEQUENCE_GUARD = "        if (seq !== ops.seq) return;\n"
FIXED = {
    "failed": "운영 지표를 불러오지 못했습니다.",
    "malformed": "조회 응답 형식을 확인할 수 없습니다.",
    "restricted": "검사 접근 범위가 제한된 계정은 기관 운영 지표를 볼 수 없습니다.",
    "forbidden": "이 계정으로는 운영 지표를 조회할 수 없습니다.",
    "changed": "검사 접근 조건이 바뀌었습니다. 다시 조회하세요.",
    "scope_changed": "집계하는 동안 검사의 기관 범위(원격판독 포함)가 바뀌었습니다. 다시 조회하세요.",
    "busy": "서버가 바쁘거나 원천 조회가 지연되었습니다. 잠시 후 다시 조회하세요.",
}
# S5-U6b-F03 control: the 401 judged after the sequence check, as before the fix, so an older read's 401 is dropped.
END_IN_REQUEST = """        if (response.status === 401) {
          KinConsoleSession.end();
          throw Object.assign(new Error("session"), { status: 401 });
        }
"""
END_AFTER_SEQUENCE = """        if (response.status === 401) throw Object.assign(new Error("session"), { status: 401 });
"""
# S5-U6b-F04 controls. The member list's 401 and Log out as they were before the page's one session end (straight to
# KinAuth.logout()), and Operations' closer built but never registered on that end (a panel with an end of its own).
MEMBERS_END = '          KinConsoleSession.end();\n          throw new Error("세션이 만료되었습니다");\n'
MEMBERS_END_BEFORE = '          await KinAuth.logout();\n          throw new Error("세션이 만료되었습니다");\n'
LOGOUT_BUTTON = '$("#logout").addEventListener("click", () => KinConsoleSession.end());'
LOGOUT_BUTTON_BEFORE = '$("#logout").addEventListener("click", () => KinAuth.logout());'
OPS_ON_END = "      KinConsoleSession.onEnd(() => {\n        ops.seq++;\n"
OPS_OFF_END = "      void (() => {\n        ops.seq++;\n"
# S5-U6a (b95bc17) defines the object as a top-level const in a script right after study-access-admin.js. This stand-in
# has the same three calls and counts what reaches it.
STUDY_ACCESS_SCRIPT = '  <script src="study-access-admin.js"></script>\n'
EARLIER_SESSION = """  <script>
    const KinConsoleSession = (() => {
      const closers = [];
      let ended = false;
      window.__earlier = { closers, ends: 0 };
      return {
        ended: () => ended,
        onEnd(closer) { if (ended) closer(); else closers.push(closer); },
        end() { window.__earlier.ends++; if (ended) return; ended = true; for (const closer of closers) closer(); KinAuth.logout(); },
      };
    })();
  </script>
"""


def has_hangul(text):
    return any(unicodedata.name(ch, "").startswith("HANGUL") for ch in text)


def variant(old, new="", body=ADMIN_HTML, name="admin.html"):
    found = body.count(old)
    if found != 1:
        raise AssertionError(f"setup: {old!r} occurs {found} times in {name}")
    return body.replace(old, new)


class AdminMetricsDOMTest(unittest.TestCase):
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
        self.member_replies, self.study_replies, self.serve_arrivals = [], [], False
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
        if method == "GET" and path == ARRIVALS_PATH and self.serve_arrivals:
            # ARRIVALS_JS is the shipped study-arrivals.js (read at module level, below this class).
            route.fulfill(body=ARRIVALS_JS, content_type="application/javascript; charset=utf-8")
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
        if method == "GET" and path == "/api/admin/users" and url.query == "page=1":
            if self.member_replies:
                status, body = self.member_replies.pop(0)
                route.fulfill(status=status, json=body)
                return
            route.fulfill(json=MEMBERS)
            return
        if method == "GET" and path == "/api/studies" and url.query == "" and self.study_replies:
            status, body = self.study_replies.pop(0)
            route.fulfill(status=status, json=body)
            return
        if method == "GET" and path == METRICS_PATH and url.query == "":
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
        return self.page.evaluate("path => window.__jsonDone.filter(item => item === path).length", METRICS_PATH)

    def fetch_done(self):
        return self.page.evaluate("path => window.__fetchDone.filter(item => item === path).length", METRICS_PATH)

    def open(self, body=None):
        if body is not None:
            self.admin_body = body
        self.page.goto(ORIGIN + PAGE_PATH)
        expect(self.page.locator("#users td.username")).to_have_count(1)
        expect(self.page.locator("#metrics-refresh")).to_be_enabled()

    def refresh(self, reply):
        """Queue one metrics answer (never a 401: that is judged before any body is read), press the control and
        wait until the page has read it and finished drawing."""
        before = self.json_done()
        self.replies.append(reply)
        self.page.locator("#metrics-refresh").click()
        self.wait_until(lambda: self.json_done() > before, "the metrics answer read")
        self.wait_until(lambda: not self.summary()["busy"], "the load finished")

    def table(self):
        return self.page.evaluate(TABLE)

    def summary(self):
        return self.page.evaluate(SUMMARY)

    def section_texts(self):
        return self.page.evaluate("""() => { const section = document.querySelector('#metrics');
          return [section.textContent, ...[...section.querySelectorAll('[title]')].map(e => e.title)]; }""")

    def api_calls(self):
        return [(c["method"], c["path"], c["query"]) for c in self.calls if c["path"].startswith("/api/")]

    def assert_observed(self, second=1):
        summary = self.summary()
        self.assertEqual(("Observed " + shown_generated(second), "mstate observed", False, False, False),
                         (summary["state"], summary["stateClass"], summary["wrapHidden"], summary["stale"], summary["messageShown"]))

    # ── cases ──
    def test_01_opening_members_reads_nothing_until_asked(self):
        self.open()
        self.page.wait_for_timeout(300)
        self.assertEqual([("GET", "/api/me", ""), ("GET", "/api/admin/users", "page=1")], self.api_calls())
        self.assertNotIn(ARRIVALS_PATH, [c["path"] for c in self.calls])
        summary = self.summary()
        self.assertEqual(("Not Loaded", "mstate not_loaded", True, 0, False, False),
                         (summary["state"], summary["stateClass"], summary["wrapHidden"], summary["rows"],
                          summary["messageShown"], summary["busy"]))
        self.assertIsNotNone(self.page.evaluate("() => window.KinAdminMetrics ?? null"))

    def test_02_one_observed_answer_in_words(self):
        self.open()
        self.refresh((200, answer()))
        self.assert_observed()
        rows = self.table()
        self.assertEqual(KEYS, [r["key"] for r in rows])
        self.assertEqual([list(e) for e in EXPECTED], [r["cells"] for r in rows])
        self.assertEqual(["observed", "unobservable"] + ["observed"] * 9, [r["state"] for r in rows])
        self.assertEqual(["mstate row-" + r["state"] for r in rows], [r["chipClass"] for r in rows])
        for r in rows:
            with self.subTest(key=r["key"]):
                self.assertEqual([], [t for t in r["titles"] if not has_hangul(t)], "every cell explains itself in Korean")
        titles = {r["key"]: r["titles"] for r in rows}
        self.assertIn("기간: 2026-09-25 00:00:00 ~ 2026-09-26 00:00:00.", titles["studies.registered_24h"][0])
        self.assertIn("모든 기관", titles["storage.server"][5])
        self.assertEqual("원천 값 13421772800바이트", titles["storage.server"][2])
        self.assertEqual("중앙값 12600초 · 최댓값 18000초", titles["waiting.normal"][2])
        gets = [c for c in self.calls if c["path"] == METRICS_PATH]
        self.assertEqual([("GET", "", "1")], [(c["method"], c["query"], c["csrf"]) for c in gets])

    def test_03_unknown_is_never_zero(self):
        self.open()
        rows = [dict(r, state="unobservable", reason="source_failed", value=None, max=None, observedAt=None, excluded=None,
                     window=None, denominator={"unit": "study", "value": None} if r["unit"] == "second" else r["denominator"])
                for r in deepcopy(ROWS)]
        rows = replace(rows, "storage.server", reason="timeout")
        rows = replace(rows, "tat.normal", **duration("tat.normal", None, None, 0, 2, state="empty", window=WEEK))
        rows = replace(rows, "studies.tele", **count("studies.tele", "0"))
        rows = [r for r in rows if r["key"] != "waiting.normal"]
        self.refresh((200, answer(rows=rows)))
        self.assert_observed()
        table = {r["key"]: r for r in self.table()}
        self.assertEqual(KEYS, list(table))
        empty = table.pop("tat.normal")
        self.assertEqual(("empty", "No Studies", "No Studies", "0 Studies · 2 Excluded"),
                         (empty["state"], empty["cells"][1], empty["cells"][2], empty["cells"][4]))
        self.assertIn("0분이 아닙니다", empty["chipTitle"])
        reasons = {"storage.server": "원천이 제한 시간 안에 답하지 않았습니다.", "storage.institution": "원천 조회에 실패했습니다.",
                   "studies.tele": "응답 형식을 확인할 수 없습니다.", "waiting.normal": "응답 형식을 확인할 수 없습니다."}
        for key, r in table.items():
            with self.subTest(key=key):
                self.assertEqual(("unobservable", "Unobservable", "Unobservable", "Not Observed"),
                                 (r["state"], r["cells"][1], r["cells"][2], r["cells"][7]))
                for index in (2, 4, 7):
                    self.assertIsNone(re.search(r"\d", r["cells"][index]), r["cells"])
                self.assertTrue(r["chipTitle"].endswith(reasons.get(key, "원천 조회에 실패했습니다.")), r["chipTitle"])
        self.assertEqual("Unknown", table["studies.tele"]["cells"][6], "a malformed row names no source")
        self.assertEqual(SRC["disk"], table["storage.server"]["cells"][6], "the source it tried is still named")
        self.refresh((200, answer(second=2)))
        self.assert_observed(2)
        self.assertEqual([list(e) for e in EXPECTED], [r["cells"] for r in self.table()])

    def test_04_query_failed_keeps_the_last_table_as_the_last_observation(self):
        self.open()
        self.refresh((503, {"message": SERVER_WORDING}))
        summary = self.summary()
        self.assertEqual(("Query Failed · 아직 성공한 조회가 없습니다", "mstate query_failed", FIXED["busy"], True, True, 0),
                         (summary["state"], summary["stateClass"], summary["message"], summary["messageShown"],
                          summary["wrapHidden"], summary["rows"]))
        self.refresh((200, answer()))
        self.assert_observed()
        for reply, sentence in (((500, {"message": SERVER_WORDING}), FIXED["failed"]),
                                ((200, {"metrics": "SYN", "generatedAt": generated(3)}), FIXED["malformed"]),
                                ((200, dict(answer(3), institutionId="")), FIXED["malformed"]),
                                ((403, {"code": "ADMIN_METRICS_RESTRICTED", "message": SERVER_WORDING}), FIXED["restricted"]),
                                ((403, {"message": SERVER_WORDING}), FIXED["forbidden"]),
                                ((409, {"code": "STUDY_ACCESS_CHANGED", "message": SERVER_WORDING}), FIXED["changed"]),
                                ((409, {"code": "STUDY_LIST_CHANGED", "message": SERVER_WORDING}), FIXED["scope_changed"]),
                                ((503, {"message": SERVER_WORDING}), FIXED["busy"])):
            with self.subTest(status=reply[0], sentence=sentence):
                self.refresh(reply)
                summary = self.summary()
                self.assertEqual(("Query Failed · 마지막 관측 기준 " + shown_generated(1), "mstate query_failed", sentence,
                                  True, False, True), (summary["state"], summary["stateClass"], summary["message"],
                                                       summary["messageShown"], summary["wrapHidden"], summary["stale"]))
                self.assertIn("마지막으로 성공한 조회 기준", summary["stateTitle"])
                self.assertEqual([list(e) for e in EXPECTED], [r["cells"] for r in self.table()])
                self.assertEqual(ORIGIN + PAGE_PATH, self.page.url, "a refusal never leaves the page")
        stale_opacity = self.page.evaluate("() => getComputedStyle(document.querySelector('#metrics-rows')).opacity")
        self.assertLess(float(stale_opacity), 1.0)
        self.assertFalse(any(SERVER_WORDING in text for text in self.section_texts()))
        self.refresh((200, answer(second=4)))
        self.assert_observed(4)
        self.assertEqual([list(e) for e in EXPECTED], [r["cells"] for r in self.table()])

    def a_b(self):
        """Two reads in flight; the newer (B) answers first, then the older (A)."""
        older = answer(second=5, rows=replace(ROWS, "studies.own", value=5))
        newer = answer(second=6, rows=replace(ROWS, "studies.own", value=6))
        self.replies += ["hold", "hold"]
        button = self.page.locator("#metrics-refresh")
        button.click()
        self.wait_until(lambda: len(self.held) == 1, "the first read")
        button.click()
        self.wait_until(lambda: len(self.held) == 2, "the second read")
        first, second = self.held
        self.held = []
        second.fulfill(json=newer)
        self.wait_until(lambda: self.json_done() == 1, "the newer answer read")
        expect(self.page.locator("#metrics-state")).to_have_text("Observed " + shown_generated(6))
        first.fulfill(json=older)
        self.wait_until(lambda: self.json_done() == 2, "the older answer read")
        self.page.wait_for_timeout(50)
        return older

    def own_cell(self):
        return next(r for r in self.table() if r["key"] == "studies.own")["cells"][2]

    def test_05_a_late_answer_never_paints_over_a_newer_one(self):
        self.open()
        older = self.a_b()
        self.assert_observed(6)
        self.assertEqual("6", self.own_cell())
        # A->B->A: asking again for the older content is a new request, and it paints.
        self.refresh((200, older))
        self.assert_observed(5)
        self.assertEqual("5", self.own_cell())

        # Control: without the sequence guard the late older answer is painted over the newer one.
        self.open(variant(SEQUENCE_GUARD))
        self.page.evaluate("() => { window.__jsonDone = []; }")
        self.a_b()
        self.assertEqual(("Observed " + shown_generated(5), "5"), (self.summary()["state"], self.own_cell()))

    def test_06_a_401_empties_the_section_before_logout_and_drops_late_answers(self):
        self.open()
        self.refresh((200, answer()))
        self.replies.append("hold")
        self.page.locator("#metrics-refresh").click()
        self.wait_until(lambda: len(self.held) == 1, "the held read")
        held = self.held.pop()
        self.held_logouts = []
        self.replies.append((401, {"message": SERVER_WORDING}))
        self.page.locator("#metrics-refresh").click()
        self.wait_until(lambda: self.logouts == 1, "the logout request")
        summary = self.summary()
        self.assertEqual((0, True, True, False, False),
                         (summary["rows"], summary["wrapHidden"], summary["refreshDisabled"], summary["busy"], summary["messageShown"]))
        held.fulfill(json=answer(second=7))
        self.wait_until(lambda: self.fetch_done() == 3, "the late answer received")
        self.page.wait_for_timeout(50)
        summary = self.summary()
        self.assertEqual((0, True), (summary["rows"], summary["wrapHidden"]), "nothing is painted after the session ended")
        self.assertNotIn(shown_generated(7), summary["state"])
        self.assertEqual(1, self.json_done(), "an answer that arrives after the session ended is never read")
        self.held_logouts.pop().fulfill(status=204, body="")
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        expect(self.page.locator("#index")).to_have_text("SYN INDEX")
        self.assertEqual(1, self.logouts)
        self.assertEqual(1, [c["path"] for c in self.calls].count(BASE + "index.html"), "one navigation")

    def test_07_wording_sizes_no_threshold_keyboard_and_no_dialog(self):
        self.open()
        static = self.page.evaluate("""() => [...document.querySelectorAll('#metrics h2, #metrics button, #metrics .mstate, #metrics th')]
          .map(e => e.textContent)""")
        self.assertEqual(["Operations", "Not Loaded", "Refresh Operations", "Metric", "State", "Value", "Unit", "Denominator",
                          "Scope", "Source", "Observed At"], static)
        tiny_and_huge = replace(replace(ROWS, "tat.emergency", value=60, max=120), "waiting.normal", value=900000, max=3600000)
        tiny_and_huge = replace(tiny_and_huge, "tat.normal", **duration("tat.normal", None, None, 0, 0, state="empty", window=WEEK))
        # Keyboard: the control is a real button.
        self.replies.append((200, answer(rows=tiny_and_huge)))
        self.page.locator("#metrics-refresh").focus()
        self.page.keyboard.press("Enter")
        self.wait_until(lambda: self.json_done() == 1, "the keyboard read")
        self.assert_observed()
        rows = self.table()
        by_key = {r["key"]: r for r in rows}
        self.assertEqual("Median 1 min · Max 2 min", by_key["tat.emergency"]["cells"][2])
        self.assertEqual("Median 250 h 00 min · Max 1000 h 00 min", by_key["waiting.normal"]["cells"][2])
        # No threshold: every value cell has one style whatever its size or state; only the chip follows the state.
        self.assertEqual(1, len({tuple(r["valueStyle"]) for r in rows}), [r["valueStyle"] for r in rows])
        chips = {}
        for r in rows:
            chips.setdefault(r["state"], set()).add(r["chipBackground"])
        self.assertEqual({"observed", "unobservable", "empty"}, set(chips))
        self.assertTrue(all(len(colours) == 1 for colours in chips.values()), chips)
        self.assertEqual(3, len({next(iter(colours)) for colours in chips.values()}), chips)
        english = [text for r in rows for text in (r["cells"][0], r["cells"][1], r["cells"][3])]
        english += self.page.evaluate("() => [...document.querySelectorAll('#metrics h2, #metrics button, #metrics th, #metrics-state')].map(e => e.textContent)")
        self.assertEqual([], [text for text in english if has_hangul(text)])
        korean = [self.page.evaluate("() => document.querySelector('.ops-hint').textContent"), self.summary()["stateTitle"]]
        korean += [title for r in rows for title in r["titles"]]
        self.assertEqual([], [text for text in korean if not has_hangul(text)])
        texts = self.section_texts()
        self.assertEqual([], [text for text in texts if AVOIDED.search(text)])
        sizes = self.page.evaluate("""() => [...document.querySelectorAll('#metrics *')]
          .filter(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && e.getClientRects().length)
          .map(e => [e.tagName + '.' + e.className, parseFloat(getComputedStyle(e).fontSize)])""")
        self.assertTrue(sizes)
        self.assertEqual([], [entry for entry in sizes if entry[1] < 12])
        self.assertGreaterEqual(self.page.locator("#metrics-refresh").bounding_box()["height"], 24)
        self.assertEqual(0, self.summary()["openDialogs"])

    def test_08_the_gateway_section_is_untouched(self):
        self.open()
        self.refresh((200, answer()))
        self.assertEqual([("GET", "/api/me", ""), ("GET", "/api/admin/users", "page=1"), ("GET", METRICS_PATH, "")],
                         self.api_calls())
        self.assertNotIn(ARRIVALS_PATH, [c["path"] for c in self.calls])
        gateway = self.page.evaluate("""() => [document.querySelector('#gateway-list-state').textContent,
          document.querySelector('#gateway-counts').textContent, document.querySelectorAll('#gateway-rows > li').length]""")
        self.assertEqual(["Not Loaded", "Counts Unknown", 0], gateway)
        self.assertEqual(1, self.page.locator("#users td.username").count())
        # The page's `thead th` is still the member table's six headers (tests/admin_member_roles_dom_test.py pins it);
        # the Operations headers are th scope="col" in their own tbody.
        headers = self.page.evaluate("""() => [[...document.querySelectorAll('thead th')].map(th => th.textContent),
          document.querySelectorAll('#metrics thead').length,
          [...document.querySelectorAll('#metrics th')].map(th => th.scope)]""")
        self.assertEqual([["아이디", "이름 / 이메일", "기관", "역할", "상태", "작업"], 0, ["col"] * 8], headers)

    def hold_reads(self, n):
        """n metrics reads in flight, oldest first."""
        self.replies += ["hold"] * n
        button = self.page.locator("#metrics-refresh")
        for index in range(n):
            button.click()
            self.wait_until(lambda: len(self.held) == index + 1, f"read {index + 1} in flight")
        held, self.held = self.held, []
        return held

    def test_09_an_older_read_401_ends_the_session_at_once(self):
        self.open()
        self.refresh((200, answer()))
        oldest, newer, newest = self.hold_reads(3)
        self.held_logouts = []
        oldest.fulfill(status=401, json={"message": SERVER_WORDING})
        self.wait_until(lambda: self.logouts == 1, "the logout request")
        summary = self.summary()
        self.assertEqual((0, True, True, False, False, "Not Loaded", "mstate not_loaded"),
                         (summary["rows"], summary["wrapHidden"], summary["refreshDisabled"], summary["busy"],
                          summary["messageShown"], summary["state"], summary["stateClass"]),
                         "the oldest read's 401 empties the section while two newer reads are still out")
        newer.fulfill(json=answer(second=8))
        self.wait_until(lambda: self.fetch_done() == 3, "the newer 200 received")
        newest.fulfill(status=401, json={"message": SERVER_WORDING})
        self.wait_until(lambda: self.fetch_done() == 4, "the newest 401 received")
        self.page.wait_for_timeout(50)
        summary = self.summary()
        self.assertEqual((0, True, "Not Loaded"), (summary["rows"], summary["wrapHidden"], summary["state"]),
                         "no answer repaints after the end")
        self.assertEqual(1, self.json_done(), "no answer after the end is read")
        self.assertEqual(1, self.logouts, "a second 401 logs out no second time")
        self.held_logouts.pop().fulfill(status=204, body="")
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        expect(self.page.locator("#index")).to_have_text("SYN INDEX")
        self.assertEqual(1, self.logouts)
        self.assertEqual(1, [c["path"] for c in self.calls].count(BASE + "index.html"), "one navigation")

        # Control: the 401 judged after the sequence check (the order before S5-U6b-F03) drops an older read's 401 —
        # the table stays, nobody logs out, and the newer answer paints.
        self.logouts, self.held_logouts = 0, None
        self.open(variant(SEQUENCE_GUARD, SEQUENCE_GUARD + "        if (error?.status === 401) { KinConsoleSession.end(); return; }\n",
                          body=variant(END_IN_REQUEST, END_AFTER_SEQUENCE)))
        self.refresh((200, answer()))
        older, newer = self.hold_reads(2)
        older.fulfill(status=401, json={"message": SERVER_WORDING})
        self.wait_until(lambda: self.fetch_done() == 2, "the older 401 received")
        self.page.wait_for_timeout(50)
        self.assertEqual((11, 0), (self.summary()["rows"], self.logouts), "control: the older 401 was dropped")
        newer.fulfill(json=answer(second=8))
        self.wait_until(lambda: self.json_done() == 2, "control: the newer answer read")
        self.wait_until(lambda: not self.summary()["busy"], "control: the load finished")
        self.assert_observed(8)

    # ── S5-U6b-F04: every end path of the page closes Operations ──
    def metrics_gets(self):
        return sum(1 for c in self.calls if c["path"] == METRICS_PATH)

    def five_on_screen_and_two_reads_out(self, body=None):
        """Operations shows the table with Studies Owned 5, and two more reads are out (oldest first)."""
        self.open(body)
        self.refresh((200, answer(rows=replace(ROWS, "studies.own", value=5))))
        self.assertEqual("5", self.own_cell())
        return self.hold_reads(2)

    def end_elsewhere(self, path):
        """End the page session through `path`, never through an Operations read, with the logout answer held."""
        self.held_logouts = []
        if path == "members":
            self.member_replies.append((401, {"message": SERVER_WORDING}))
            self.page.locator("#refresh").click()
        elif path == "logout":
            self.page.locator("#logout").click()
        elif path == "gateway":
            self.serve_arrivals = True
            self.study_replies.append((401, {"message": SERVER_WORDING}))
            self.page.locator("#gateway-refresh").click()
        else:
            raise AssertionError(f"setup: unknown end path {path!r}")
        self.wait_until(lambda: self.logouts == 1, f"the logout request ({path})")

    def assert_the_end_closes_operations(self, path):
        older, newer = self.five_on_screen_and_two_reads_out()
        self.end_elsewhere(path)
        summary = self.summary()
        self.assertEqual((0, True, True, False, False, "Not Loaded", "mstate not_loaded"),
                         (summary["rows"], summary["wrapHidden"], summary["refreshDisabled"], summary["busy"],
                          summary["messageShown"], summary["state"], summary["stateClass"]),
                         f"{path}: Operations empties at once, with the logout still unanswered")
        self.assertTrue(self.page.locator("#gateway-refresh").is_disabled(), f"{path}: Gateway Status closes too")
        # The two reads sent before the end answer late: the newer with a 200 (Studies Owned 6), the older with a 401.
        newer.fulfill(json=answer(second=8, rows=replace(ROWS, "studies.own", value=6)))
        self.wait_until(lambda: self.fetch_done() == 2, f"{path}: the late 200 received")
        older.fulfill(status=401, json={"message": SERVER_WORDING})
        self.wait_until(lambda: self.fetch_done() == 3, f"{path}: the late 401 received")
        # No new read, no second logout: the control forced back on and pressed, then Log out pressed again.
        self.page.evaluate("() => { const b = document.querySelector('#metrics-refresh'); b.disabled = false; b.click(); }")
        self.page.locator("#logout").click()
        self.page.wait_for_timeout(100)
        summary = self.summary()
        self.assertEqual((0, True, "Not Loaded", False), (summary["rows"], summary["wrapHidden"], summary["state"], summary["busy"]),
                         f"{path}: no answer repaints after the end")
        self.assertEqual(1, self.json_done(), f"{path}: no answer after the end is read")
        self.assertEqual(3, self.metrics_gets(), f"{path}: no metrics read after the end")
        self.assertEqual(1, self.logouts, f"{path}: one logout")
        self.held_logouts.pop().fulfill(status=204, body="")
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        expect(self.page.locator("#index")).to_have_text("SYN INDEX")
        self.assertEqual(1, self.logouts)
        self.assertEqual(1, [c["path"] for c in self.calls].count(BASE + "index.html"), "one navigation")

    def control_the_end_leaves_operations(self, path, body, shared_end_ran):
        """The same end with its path, or Operations, off the page's one session end: the ended session's table and its
        control stay. When the end never reached the shared object, the late 200 paints and the late 401 logs out again."""
        self.logouts, self.held_logouts = 0, None
        older, newer = self.five_on_screen_and_two_reads_out(body)
        self.end_elsewhere(path)
        summary = self.summary()
        self.assertEqual((11, False, False, "5"), (summary["rows"], summary["wrapHidden"], summary["refreshDisabled"], self.own_cell()),
                         f"control ({path}): the ended session's table and control stay")
        newer.fulfill(json=answer(second=8, rows=replace(ROWS, "studies.own", value=6)))
        self.wait_until(lambda: self.fetch_done() == 2, f"control ({path}): the late 200 received")
        self.wait_until(lambda: not self.summary()["busy"], f"control ({path}): the late load finished")
        self.assertEqual((11, "5" if shared_end_ran else "6"), (self.summary()["rows"], self.own_cell()))
        older.fulfill(status=401, json={"message": SERVER_WORDING})
        self.wait_until(lambda: self.fetch_done() == 3, f"control ({path}): the late 401 received")
        self.wait_until(lambda: self.logouts == (1 if shared_end_ran else 2), f"control ({path}): the logouts")
        self.page.wait_for_timeout(50)
        self.assertEqual(1 if shared_end_ran else 2, self.logouts)
        for route in self.held_logouts:
            route.fulfill(status=204, body="")
        self.page.wait_for_url(ORIGIN + BASE + "index.html")

    def test_10_a_member_list_401_closes_operations_at_once(self):
        self.assert_the_end_closes_operations("members")
        self.control_the_end_leaves_operations("members", variant(MEMBERS_END, MEMBERS_END_BEFORE), shared_end_ran=False)

    def test_11_log_out_closes_operations_at_once(self):
        self.assert_the_end_closes_operations("logout")
        self.control_the_end_leaves_operations("logout", variant(LOGOUT_BUTTON, LOGOUT_BUTTON_BEFORE), shared_end_ran=False)

    def test_12_a_gateway_list_401_closes_operations_at_once(self):
        self.assert_the_end_closes_operations("gateway")
        self.control_the_end_leaves_operations("gateway", variant(OPS_ON_END, OPS_OFF_END), shared_end_ran=True)

    def test_13_an_earlier_session_object_stays_the_page_one(self):
        # S5-U6a's object as it sits when the units meet: a top-level const in a script above this page's block.
        self.open(variant(STUDY_ACCESS_SCRIPT, STUDY_ACCESS_SCRIPT + EARLIER_SESSION))
        self.assertEqual(["undefined", False, 2], self.page.evaluate(
            "() => [typeof window.KinConsoleSession, 'KinConsoleSession' in window, window.__earlier.closers.length]"),
            "this page's block defines nothing; Gateway Status and Operations register with the earlier object")
        self.refresh((200, answer()))
        self.held_logouts = []
        self.page.locator("#logout").click()
        self.wait_until(lambda: self.logouts == 1, "the logout request")
        summary = self.summary()
        self.assertEqual((0, True, True, "Not Loaded"),
                         (summary["rows"], summary["wrapHidden"], summary["refreshDisabled"], summary["state"]))
        self.assertEqual(1, self.page.evaluate("() => window.__earlier.ends"), "Log out ends through the earlier object")
        self.held_logouts.pop().fulfill(status=204, body="")
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        self.assertEqual(1, self.logouts)


# ── S5-U6b-F02: the worklist menubar storage figure (main.html #storage) ──

MAIN_HTML = lf_text(HPACS / "main.html")
ARRIVALS_JS = lf_text(HPACS / "study-arrivals.js")
MODEL_OPEN = '<script id="admin-metrics-model">'
METRICS_MODEL = ADMIN_HTML[ADMIN_HTML.index(MODEL_OPEN) + len(MODEL_OPEN):ADMIN_HTML.index("</script>", ADMIN_HTML.index(MODEL_OPEN))]


def extract_function(source, name):
    """The shipped function text by brace matching (the tests/worklist_arrivals_dom_test.py slicing), with strings and
    also comments skipped: an apostrophe in a comment must not open a string."""
    start = source.index(f"function {name}(")
    depth, quote, escaped, index = 0, None, False, source.index("{", start)
    while index < len(source):
        char = source[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
        elif source.startswith("//", index):
            index = source.index("\n", index)
            continue
        elif source.startswith("/*", index):
            index = source.index("*/", index) + 2
            continue
        elif char in "'\"`":
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
        index += 1
    raise ValueError(name)


STORAGE_ELEMENT = re.search(r'<div class="mright" id="storage"[^>]*>[^<]*</div>', MAIN_HTML).group(0)
STORAGE_STATE = "    let storageSeq = 0, storageLast = null;\n"
STORAGE_GUARD = "      if (seq !== storageSeq) return;\n"
REFRESH_STORAGE = "async " + extract_function(MAIN_HTML, "refreshStorage")
# The page's `$`; fetch answers from a queue the case settles, in any order.
STORAGE_HARNESS = """<!doctype html><html><body><div class="menubar">ELEMENT</div><script>
const $ = s => document.querySelector(s);
window.pending = [];
window.fetch = url => new Promise((resolve, reject) => window.pending.push({ url, resolve, reject }));
window.settle = (index, status, body) => window.pending[index].resolve(new Response(body, { status }));
window.fail = index => window.pending[index].reject(new TypeError('SYN network down'));
window.box = () => { const b = $('#storage'); return { text: b.textContent, title: b.title, state: b.dataset.state }; };
STATE
REFRESH
</script></body></html>"""
BYTES = 13421772800   # 12.50 GiB
NO_ZERO = "0으로 두지 않습니다"


class WorklistStorageDOMTest(unittest.TestCase):
    """S01 the shipped default names no number; S02 every first failure is Unobservable with its reason; S03 an
    observed value and a real 0 carry scope, source and time; S04 a failure after a success does not keep the number as
    current; S05 A->B->A with a control; S06 the same units as the Operations row. The shipped `#storage` element and
    refreshStorage() are sliced from main.html; study-arrivals.js and the admin metrics model are loaded as shipped."""

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.errors, self.page = [], None
        self.load(REFRESH_STORAGE)

    def tearDown(self):
        self.page.close()
        self.assertEqual([], self.errors, "page errors")

    def load(self, refresh):
        """A fresh page for every load: set_content on a used page keeps its top-level const/let, so a second harness
        would fail on `const $` and the previous refreshStorage would silently stay."""
        if self.page is not None:
            self.page.close()
        self.page = self.browser.new_page()
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.set_content(STORAGE_HARNESS.replace("ELEMENT", STORAGE_ELEMENT).replace("STATE", STORAGE_STATE)
                              .replace("REFRESH", refresh))
        self.page.add_script_tag(content=ARRIVALS_JS)
        self.page.add_script_tag(content=METRICS_MODEL)

    def read(self, settle):
        """One refreshStorage(); `settle` answers its request (JS taking the request index `i`)."""
        return self.page.evaluate(f"""async () => {{ const run = refreshStorage(), i = window.pending.length - 1;
          {settle}; await run; return box(); }}""")

    def ok(self, body):
        return self.read(f"settle(i, 200, {json.dumps(json.dumps(body))})")

    def assert_unobservable(self, shown, reason, last=None):
        self.assertEqual(("Storage Unobservable", "unobservable"), (shown["text"], shown["state"]))
        self.assertIsNone(re.search(r"\d", shown["text"]), shown["text"])
        self.assertIn(NO_ZERO, shown["title"])
        self.assertIn(reason, shown["title"])
        if last is None:
            self.assertNotIn("마지막으로 관측한 값", shown["title"])
        else:
            self.assertIn(f"마지막으로 관측한 값은 {last}(", shown["title"])
            self.assertIn("지금 값이 아닐 수 있습니다", shown["title"])

    def assert_observed(self, shown, text, raw):
        self.assertEqual((text, "observed"), (shown["text"], shown["state"]))
        for part in ("Orthanc 서버 전체(모든 기관)", "이 기관 몫이 아닙니다", "원천: Orthanc GET /statistics TotalDiskSize",
                     f"원천 값 {raw}바이트", "이 화면이 답을 받은 시각", "사용률(%)을 보이지 않습니다"):
            self.assertIn(part, shown["title"])
        self.assertRegex(shown["title"], r"관측 시각: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\(")

    def test_s01_the_shipped_default_names_no_number(self):
        shown = self.page.evaluate("() => box()")
        self.assertEqual(("Storage Unobservable", "not_loaded"), (shown["text"], shown["state"]))
        self.assertIsNone(re.search(r"\d", shown["text"]))
        self.assertIn("아직 관측하지 않았습니다", shown["title"])
        self.assertIn(NO_ZERO, shown["title"])
        # The old default text and the old write ('0.0GB / -', `+ "GB used"`) are gone; the comment may still name them.
        self.assertNotIn(">0.0GB / -<", MAIN_HTML)
        self.assertNotIn('"GB used"', MAIN_HTML)
        # One writer: every /statistics read and every #storage write is refreshStorage().
        self.assertEqual(1, MAIN_HTML.count('fetch("/statistics")'))
        self.assertEqual(1, MAIN_HTML.count('$("#storage")') + MAIN_HTML.count("$('#storage')"))
        self.assertIn('$("#storage")', REFRESH_STORAGE)

    def test_s02_every_first_failure_is_unobservable_with_its_reason(self):
        failed, shape = "원천 조회에 실패했습니다.", "응답 형식을 확인할 수 없습니다."
        cases = [
            ("fail(i)", failed),
            ("settle(i, 200, 'SYN not json')", shape),
            ("settle(i, 200, JSON.stringify({ TotalDiskSizeMB: 12800, CountStudies: 987654 }))", shape),
            ("settle(i, 200, JSON.stringify({ TotalDiskSize: '-1' }))", shape),
            ("settle(i, 200, JSON.stringify({ TotalDiskSize: '1.5' }))", shape),
            ("settle(i, 200, JSON.stringify({ TotalDiskSize: '1e3' }))", shape),
            ("settle(i, 200, JSON.stringify({ TotalDiskSize: '99999999999999999999' }))", shape),
            ("settle(i, 200, JSON.stringify({ TotalDiskSize: null }))", shape),
            ("settle(i, 200, JSON.stringify(['SYN']))", shape),
            ("settle(i, 200, 'null')", shape),
            ("settle(i, 403, JSON.stringify({ TotalDiskSizeMB: 1, message: 'SYN' }))", "이 계정으로는 서버 전체 저장량을 볼 수 없습니다."),
            ("settle(i, 500, JSON.stringify({ TotalDiskSize: '42' }))", "원천이 HTTP 500로 답했습니다."),
        ]
        for settle, reason in cases:
            with self.subTest(settle=settle):
                self.load(REFRESH_STORAGE)
                shown = self.read(settle)
                self.assert_unobservable(shown, reason)
                self.assertNotIn("NaN", shown["text"] + shown["title"])

    def test_s03_an_observed_value_and_a_real_zero_carry_scope_source_and_time(self):
        first = self.ok({"TotalDiskSize": str(BYTES), "TotalDiskSizeMB": 1, "CountStudies": 987654})
        self.assert_observed(first, "Storage 12.50 GiB (Server-wide)", BYTES)
        self.assertNotIn("987654", first["text"] + first["title"], "only TotalDiskSize is read")
        # A source that says 0 is a known 0: a number, marked observed, never the Unobservable words.
        self.assert_observed(self.ok({"TotalDiskSize": "0"}), "Storage 0 B (Server-wide)", 0)
        self.assert_observed(self.ok({"TotalDiskSize": 42}), "Storage 42 B (Server-wide)", 42)
        self.assert_observed(self.ok({"TotalDiskSize": " 1536 "}), "Storage 1.50 KiB (Server-wide)", 1536)

    def test_s04_a_failure_after_a_success_does_not_keep_the_number_as_current(self):
        self.assert_observed(self.ok({"TotalDiskSize": str(BYTES)}), "Storage 12.50 GiB (Server-wide)", BYTES)
        self.assert_unobservable(self.read("fail(i)"), "원천 조회에 실패했습니다.", last="12.50 GiB")
        self.assert_unobservable(self.read("settle(i, 200, 'SYN not json')"), "응답 형식을 확인할 수 없습니다.", last="12.50 GiB")
        self.assert_observed(self.ok({"TotalDiskSize": "0"}), "Storage 0 B (Server-wide)", 0)
        self.assert_unobservable(self.read("settle(i, 503, '{}')"), "원천이 HTTP 503로 답했습니다.", last="0 B")

    AB = """async () => {
      const a = refreshStorage(), ia = window.pending.length - 1, b = refreshStorage(), ib = window.pending.length - 1;
      settle(ib, 200, JSON.stringify({ TotalDiskSize: String(2 ** 30) }));
      await b;
      const newer = box();
      LATE;
      await a;
      return [newer, box()];
    }"""

    def test_s05_a_late_answer_never_paints_over_a_newer_one(self):
        for late in ("settle(ia, 200, JSON.stringify({ TotalDiskSize: String(2 * 2 ** 30) }))", "fail(ia)"):
            with self.subTest(late=late):
                self.load(REFRESH_STORAGE)
                newer, after = self.page.evaluate(self.AB.replace("LATE", late))
                self.assertEqual(("Storage 1.00 GiB (Server-wide)", "observed"), (newer["text"], newer["state"]))
                self.assertEqual(newer, after, "the older answer is dropped")
        # A->B->A: asking again for the older content is a new request, and it paints.
        self.assert_observed(self.ok({"TotalDiskSize": str(2 * 2 ** 30)}), "Storage 2.00 GiB (Server-wide)", 2 * 2 ** 30)
        # Control: without the sequence guard the late older answer paints over the newer one.
        self.load(variant(STORAGE_GUARD, body=REFRESH_STORAGE, name="refreshStorage"))
        newer, after = self.page.evaluate(self.AB.replace("LATE", "fail(ia)"))
        self.assertEqual(("Storage 1.00 GiB (Server-wide)", "Storage Unobservable"), (newer["text"], after["text"]))

    def test_s06_the_same_units_as_the_operations_row(self):
        values = [0, 1023, 1024, 1536, 2 ** 20, BYTES, 3 * 2 ** 40]
        shown = [self.ok({"TotalDiskSize": str(value)})["text"] for value in values]
        expected = self.page.evaluate("values => values.map(v => `Storage ${KinAdminMetrics.formatBytes(v)} (Server-wide)`)", values)
        self.assertEqual(expected, shown)
        self.assertEqual(["Storage 0 B (Server-wide)", "Storage 1023 B (Server-wide)", "Storage 1.00 KiB (Server-wide)",
                          "Storage 1.50 KiB (Server-wide)", "Storage 1.00 MiB (Server-wide)", "Storage 12.50 GiB (Server-wide)",
                          "Storage 3.00 TiB (Server-wide)"], shown)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
