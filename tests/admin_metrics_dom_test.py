# coding: utf-8
"""REQ-S5-U6b-OPS-METRICS -> RISK-S5-U6b-UNKNOWN-AS-ZERO/INVENTED-THRESHOLD/TENANT-AGGREGATE -> TEST-S5-U6b-DOM.

The Members console (worklist-v0/hpacs-lite/admin.html) gains an Operations section. It reads GET /api/admin/metrics
(admin only; the server scopes every count to the caller's institution and reads only TotalDiskSize from Orthanc, see
tests/admin_metrics_test.cjs) and shows each row with its state, value, unit, denominator, scope, source and observation
time. This harness loads the shipped admin.html, auth.js and study-access-admin.js unchanged from a synthetic origin,
answers /api/me, the member list, /api/admin/metrics and the logout from in-test queues (an answer can be held and
released out of order) and records every request:

  01  opening Members reads only /api/me and the member list: no metrics read and no Gateway rules until asked; the
      section says Not Loaded with no table.
  02  one observed answer: every row's eight cells (label, state word, value, unit, denominator, scope, source, observed
      time) in words; Korean titles on every cell; one GET with the CSRF header and no query.
  03  unknown is never 0: failed, timed-out, missing-source, missing and malformed rows read Unobservable with no digit
      in their value, denominator or time; a zero denominator reads No Studies over a known 0 Studies.
  04  Query Failed: a first failure shows no table; later failures (500, malformed, 403 restricted and other, 409, 503)
      keep the last table, dimmed, as the last observation with a fixed sentence and no navigation; server wording never
      shows; the next good answer restores it.
  05  A->B->A: a late older answer never paints over a newer one; a later request for the older content paints.
      Control: the page without the sequence guard, served through the same route, paints the late answer.
  06  a 401 empties the section and disables it before the logout request answers; a late answer is not painted; one
      logout and one navigation.
  07  wording and layout: English controls, headings, labels, state words and units with no Hangul; Korean guidance and
      titles; no UXR-SP-34 avoided word; nothing below 12px; no threshold: a tiny and a huge value share every style,
      only the state chip colour follows the state (with its word); keyboard; no browser dialog.
  08  the Gateway Status section is untouched by Refresh Operations (no /api/studies, no study-arrivals.js).

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


ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"


def lf_text(path):
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


ADMIN_HTML = lf_text(HPACS / "admin.html")
ORIGIN = "https://members.test"
BASE = "/worklist/hpacs-lite/"
PAGE_PATH = BASE + "admin.html"
ARRIVALS_PATH = BASE + "study-arrivals.js"
# study-arrivals.js is deliberately not served: a request for it is unexpected and fails the case.
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
    "busy": "서버가 바쁘거나 원천 조회가 지연되었습니다. 잠시 후 다시 조회하세요.",
}


def has_hangul(text):
    return any(unicodedata.name(ch, "").startswith("HANGUL") for ch in text)


def variant(old):
    found = ADMIN_HTML.count(old)
    if found != 1:
        raise AssertionError(f"setup: {old!r} occurs {found} times in admin.html")
    return ADMIN_HTML.replace(old, "")


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
        if method == "GET" and path == "/api/admin/users" and url.query == "page=1":
            route.fulfill(json=MEMBERS)
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
        self.wait_until(lambda: self.json_done() == 2, "the late answer read")
        self.page.wait_for_timeout(50)
        summary = self.summary()
        self.assertEqual((0, True), (summary["rows"], summary["wrapHidden"]), "nothing is painted after the session ended")
        self.assertNotIn(shown_generated(7), summary["state"])
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


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
