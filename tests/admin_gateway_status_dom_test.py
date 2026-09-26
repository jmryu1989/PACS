# coding: utf-8
"""REQ-S5-U6a-GATEWAY-STATUS -> RISK-S5-U6a-TENANT/FALSE-DELIVERY/OVERSIZED-CLAIM -> TEST-S5-U6a-DOM.

The Members console (worklist-v0/hpacs-lite/admin.html) gains a Gateway Status section. Its list is the existing
GET /api/studies answer: rows and Not Observed items carry the own-institution receipt the server projected. The
tenant filter is the server's and is proved over the compiled service by tests/gateway_receipt_server_test.cjs; this
page filters nothing itself. Its one action is the existing POST /api/studies/:uid/gateway-retry (technician-or-admin,
decision D10). This harness loads the shipped admin.html, auth.js, study-access-admin.js and study-arrivals.js
unchanged from a synthetic origin, answers /api/me, the member list, /api/studies, the retry POST and the logout from
in-test queues (an answer can be held and released out of order) and records every request:

  01  opening Members reads only /api/me and the member list: no /api/studies, and study-arrivals.js is not loaded
      until Refresh Gateway Status; the section says Not Loaded and Counts Unknown, never 0.
  02  five states in words and colours from one answer: Report Received (sending, complete: no phase word), Transfer
      Failed (retry with Now Retry; failed with the 24 MiB reason and the F-01 sentence and no control), Unknown (an
      unreadable receipt); rows without a receipt, tele rows and absent items without one are not listed; one GET with
      no query. Now Retry: one POST with an empty body and nothing shown before the answer; requested ->
      Retry Requested (stored, not retried) kept across a refresh of the same receipt; 409/503 -> fixed sentences, the
      control stays; server wording never shows.
  03  Query Failed keeps the last list (same nodes) as the last observation, withdraws Now Retry and names the failure
      in a fixed sentence (500, malformed answer, 409); the next good answer restores the list and the control.
  04  unknown is never 0: a first failed read says so with Counts Unknown and no rows; an undecided absence list adds
      Not Observed Unknown; a decided empty answer is a known 0.
  05  A->B->A of list reads: a late older answer never paints over a newer one; a later request for the older content
      paints. Control: the page without the sequence guard, served through the same route, paints the late answer.
  06  A->B->A of a retry answer: a newer receipt and the old one coming back both drop the request, so its late answer
      writes nothing; an item that leaves the list and comes back is a new node and ignores its late answer; one POST
      each. Control: the page without the token guard writes Retry Requested over the drawn receipt.
  07  a 401 on the list read empties the section and disables it before the logout request answers; a late retry
      answer is not written; one logout and one navigation.
  08  wording and layout: English controls, headings and state words with no Hangul; Korean guidance, titles, reasons
      and notes; no delivery or completion word; no UXR-SP-34 avoided word; nothing below 12px; no browser dialog or
      open <dialog>; the retry control works from the keyboard and keeps focus across a refresh.
  09  the pure rules in the page: every phase, requested key, unreadable receipt, error-code echo, malformed answers
      and the summary before, during and after failure.

One end for the page session (Astra S5-U6a-F01/F02). At cafc72c only the Gateway section's own 401 emptied it: Log out
and the member API 401 called KinAuth.logout() directly, which clears and moves only after POST /auth/logout answers,
nothing listened for another tab's end, and a 401 of an older list read was dropped by the sequence check. Each case
has a control that serves the cafc72c behaviour through the same route and must keep the list:

  10  Log out and a member-list 401 empty the section (rows, counts, state, control) before the logout answers; a list
      read and a retry held from before come back as successes and paint nothing; no request leaves the page after
      the end; Log out again and the page's own end broadcast add no POST and no move. Control: Log out wired to
      KinAuth.logout() keeps the list while the POST is out.
  11  another tab's end (the auth.js BroadcastChannel message; the storage pair with BroadcastChannel missing here)
      empties the section, drops the late answers, sends no logout POST and moves once, also when the signals repeat.
      Control: the page without the two listeners keeps the list and stays.
  12  an end while /api/me is still out: its later answer (200 or 401) enables nothing, reads no member list, sends no
      logout POST and makes no second move.
      In 11 and 12 the move to index.html is answered 204: the browser cancels it and the old document stays to be read
      (Playwright cannot evaluate a page whose move is held). Every move is still one request, so a second is counted.
  13  two list reads out; the older answers 401 first: the section empties before the logout answers, the newer 200
      paints nothing, a second 401 (the retry) adds no POST and no move. Control: the 401 judged after the sequence
      check (cafc72c) keeps the list and never logs out.

Synthetic data only (SYN-* names, 1.2.* UIDs): no server, no network, no credentials. A request the harness does not
answer is aborted and fails the case, as does a page error or a browser dialog.
"""
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
SCRIPTS = {BASE + name: lf_text(HPACS / name) for name in ("auth.js", "study-access-admin.js", "study-arrivals.js")}
INDEX = "<!doctype html><title>SYN index</title><p id=index>SYN INDEX</p>"
INSTITUTION = "SYN-INST-A"
ME = {"sub": "SYN-ADMIN-SUB", "user": "syn-admin", "displayName": "SYN Admin", "roles": ["admin"], "institution": INSTITUTION}
MEMBERS = {"page": 1, "pageSize": 25, "total": 1, "pendingCount": 0, "users": [
    {"id": "SYN-U-1", "username": "syn-member", "email": "syn-member@members.test", "emailVerified": True,
     "name": "SYN Member", "institution": INSTITUTION, "roles": ["technician"], "enabled": True, "approvalState": "APPROVED"}]}
EPOCH = "0a1b2c3d-0000-4000-8000-00000000000a"
SERVER_WORDING = "SYN-SERVER-WORDING"

# Counts the bodies the page read, by path. A continuation that awaits response.json() has run by the time the
# next evaluate sees the count, so a late answer that paints nothing can still be waited for. __fetchDone does the
# same for answers whose body is never read (a 401).
INIT = """(() => {
  window.__jsonDone = [];
  const json = Response.prototype.json;
  Response.prototype.json = function () {
    const path = new URL(this.url).pathname;
    return json.call(this).finally(() => { window.__jsonDone.push(path); });
  };
  window.__fetchDone = [];
  const fetch0 = window.fetch;
  window.fetch = function (input, init) {
    const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
    return fetch0.call(window, input, init).finally(() => { window.__fetchDone.push(path); });
  };
})();"""


def at(minute):
    return "2026-09-24T01:%02d:00.000Z" % minute


def shown(minute):
    return "2026-09-24 01:%02d:00" % minute


def receipt(phase, seq, minute, success=3, local=12, attempt=1, epoch=EPOCH):
    code = {"retry": "stow_http", "failed": "instance_exceeds_budget"}.get(phase)
    return {"phase": phase, "successCount": success, "localCount": local, "attempt": attempt, "errorCode": code,
            "serverReceivedAt": at(minute), "agentSeq": seq, "epoch": epoch}


def study(uid, gateway, tele=False):
    tail = uid.rsplit(".", 1)[1]
    return {"uid": uid, "count": 3, "series": 1, "acc": "SYN-ACC-" + tail, "id": "SYN-PID-" + tail,
            "name": "SYN PATIENT " + tail, "birth": "19800101", "date": "20260924", "sex": "O", "modality": "CT",
            "desc": "SYN", "institutionName": INSTITUTION, "tele": tele, "gatewayReceipt": gateway, "state": {"rs": "W"}}


def absent(uid, gateway=None):
    item = {"uid": uid, "origin": "gateway", "createdAt": "2026-09-24T00:30:00.000Z"}
    if gateway is not None:
        item["gatewayReceipt"] = gateway
    return item


def listing(rows, not_observed=(), minute=6):
    return {"studies": list(rows), "serverTime": at(minute), "observedAt": at(minute),
            "notObserved": None if not_observed is None else list(not_observed)}


FIVE = listing(
    [study("1.2.10", receipt("sending", 4, 4)), study("1.2.11", receipt("complete", 9, 3, success=12, local=12)),
     study("1.2.12", receipt("retry", 7, 4)), study("1.2.13", receipt("failed", 3, 3, success=0, local=1)),
     study("1.2.14", {"phase": "mystery", "successCount": 1, "localCount": 2, "serverReceivedAt": at(2)}),
     study("1.2.15", None), study("1.2.16", None, tele=True)],
    [absent("1.2.20", receipt("retry", 3, 2, success=0, local=2)), absent("1.2.21")])

F01 = "같은 바이트로는 성공할 수 없습니다 — 지원 범위 밖(F-01)"
OVERSIZED = "단일 DICOM 인스턴스가 Gateway 전송 상한(최대 24 MiB)을 넘어 보낼 수 없습니다"
NOT_RETRY = "지금은 재시도 대기 상태가 아니어서 요청하지 않았습니다. 목록이 갱신되면 다시 확인하세요."
BUSY = "요청이 겹쳐 처리하지 못했습니다. 잠시 후 다시 시도하세요."
RETRY_REASON = "Gateway 자동 재시도 대기 · 시도 1회 · 오류 코드 stow_http"


def reported(minute, success, local):
    return "Gateway 보고(%s): 병원 보유 %d건 중 %d건 전송" % (shown(minute), local, success)


# (uid, status, chip, study line, detail, Now Retry shown, note), in the order the page lists them.
EXPECTED_FIVE = [
    ("1.2.12", "failed", "Transfer Failed", "SYN PATIENT 12 · SYN-PID-12 · 20260924 · SYN-ACC-12",
     reported(4, 3, 12) + " · " + RETRY_REASON, True, ""),
    ("1.2.13", "failed", "Transfer Failed", "SYN PATIENT 13 · SYN-PID-13 · 20260924 · SYN-ACC-13",
     reported(3, 0, 1) + " · " + OVERSIZED + " · 오류 코드 instance_exceeds_budget", False, F01),
    ("1.2.20", "failed", "Transfer Failed", "Not Observed · gateway · 2026-09-24 00:30:00",
     reported(2, 0, 2) + " · " + RETRY_REASON, True, ""),
    ("1.2.14", "unknown", "Unknown", "SYN PATIENT 14 · SYN-PID-14 · 20260924 · SYN-ACC-14",
     "Gateway 보고 형식을 확인할 수 없습니다", False, ""),
    ("1.2.10", "received", "Report Received", "SYN PATIENT 10 · SYN-PID-10 · 20260924 · SYN-ACC-10",
     reported(4, 3, 12), False, ""),
    ("1.2.11", "received", "Report Received", "SYN PATIENT 11 · SYN-PID-11 · 20260924 · SYN-ACC-11",
     reported(3, 12, 12), False, ""),
]

ROWS = """() => [...document.querySelectorAll('#gateway-rows > li')].map(li => {
  const chip = li.children[0], button = li.querySelector('button'), note = li.querySelector('.gw-note');
  return {uid: li.dataset.uid, status: li.dataset.status, chip: chip.textContent, chipTitle: chip.title,
    chipClass: chip.className, study: li.querySelector('.gw-study').textContent,
    uidLine: li.querySelector('.gw-uid').textContent, detail: li.querySelector('.gw-detail').textContent,
    button: !button.hidden, disabled: button.disabled, buttonText: button.textContent, buttonTitle: button.title,
    note: note.textContent, noteTitle: note.title, background: getComputedStyle(chip).backgroundColor}; })"""

SUMMARY = """() => { const q = s => document.querySelector(s), state = q('#gateway-list-state'), empty = q('#gateway-empty');
  return {state: state.textContent, stateClass: state.className, stateTitle: state.title, counts: q('#gateway-counts').textContent,
    message: q('#gateway-message').textContent, messageShown: q('#gateway-message').classList.contains('show'),
    empty: empty.hidden ? null : empty.textContent, stale: q('#gateway-rows').classList.contains('stale'),
    busy: !q('#gateway-busy').hidden, rows: document.querySelectorAll('#gateway-rows > li').length,
    refreshDisabled: q('#gateway-refresh').disabled, openDialogs: document.querySelectorAll('dialog[open]').length}; }"""

# UXR-SP-34 / UXR-G-18, the same pattern as tests/admin_member_roles_dom_test.py.
AVOIDED = re.compile(r"진단|검출|판정|우선순위|diagnos|detect|priorit|\bAI\b", re.IGNORECASE)
# RISK-S5-U6a-FALSE-DELIVERY: a stored receipt or a stored request is never a delivery, completion or retry that ran.
DELIVERY = re.compile(r"전송됨|재전송|재시도됨|전송 완료|수신 완료|완료|retried|resent|delivered|complete|stable", re.IGNORECASE)

SEQUENCE_GUARD = "        if (seq !== gateway.seq) return;\n"
TOKEN_GUARD = "        if (item.dataset.request !== token || item.dataset.key !== key || gateway.items.get(uid) !== item) return;\n"

# S5-U6a-F01/F02 controls: the shipped lines and the cafc72c behaviour they replaced.
LOGOUT_WIRING = '      $("#logout").addEventListener("click", () => KinConsoleSession.end());\n'
CAFC72C_LOGOUT_WIRING = '      $("#logout").addEventListener("click", () => KinAuth.logout());\n'
END_LISTENERS = (
    '      try {\n'
    '        const channel = new BroadcastChannel("kin-session");\n'
    '        channel.onmessage = event => { if (event.data?.type === "session-ended") endedElsewhere(); };\n'
    '      } catch (_) {}\n'
    '      // The fallback where BroadcastChannel is missing; auth.js sends both, and both land here idempotently.\n'
    '      addEventListener("storage", event => { if (event.key === "kin-session-ended") endedElsewhere(); });\n')
GATEWAY_401 = (
    '        if (response.status === 401) {\n'
    '          KinConsoleSession.end();\n'
    '          throw Object.assign(new Error("session"), { status: 401 });\n'
    '        }\n')
CAFC72C_GATEWAY_401 = '        if (response.status === 401) throw Object.assign(new Error("session"), { status: 401 });\n'
AFTER_SEQUENCE = SEQUENCE_GUARD + '        $("#gateway-busy").hidden = true;\n'
CAFC72C_AFTER_SEQUENCE = AFTER_SEQUENCE + '        if (error?.status === 401) { KinConsoleSession.end(); return; }\n'

# What auth.js broadcastEnded() sends when a session ends; a second tab sends the same, one kind at a time.
AUTH_SIGNALS = ("channel.postMessage({ type: 'session-ended' });",
                "localStorage.setItem('kin-session-ended', String(Date.now()));",
                "localStorage.removeItem('kin-session-ended');")
CHANNEL_SIGNAL = """() => { const channel = new BroadcastChannel('kin-session');
  channel.postMessage({ type: 'session-ended' }); channel.close(); }"""
STORAGE_SIGNAL = """() => { localStorage.setItem('kin-session-ended', String(Date.now()));
  localStorage.removeItem('kin-session-ended'); }"""
# Registered after the page's own listeners, so a count seen here means the page's listener has already run.
PROBE = """() => { window.__signals = {channel: 0, storage: 0};
  addEventListener('storage', event => { if (event.key === 'kin-session-ended') window.__signals.storage++; });
  try { window.__probe = new BroadcastChannel('kin-session');
    window.__probe.onmessage = event => { if (event.data?.type === 'session-ended') window.__signals.channel++; };
  } catch (_) {} }"""
OTHER_PATH = BASE + "other-tab.html"
OTHER = "<!doctype html><title>SYN other tab</title><p id=other>SYN OTHER TAB</p>"
ENDED = "세션이 종료되었습니다"


def has_hangul(text):
    return any(unicodedata.name(ch, "").startswith("HANGUL") for ch in text)


def edited(edits):
    text = ADMIN_HTML
    for old, new in edits:
        found = text.count(old)
        if found != 1:
            raise AssertionError(f"setup: {old!r} occurs {found} times in admin.html")
        text = text.replace(old, new)
    return text


def variant(old):
    return edited([(old, "")])


def retry_path(uid):
    return f"/api/studies/{uid}/gateway-retry"


class AdminGatewayStatusDOMTest(unittest.TestCase):
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
        self.study_replies, self.retry_replies = [], []
        self.held_studies, self.held_retries = [], []
        self.retry_posts = []
        self.logouts, self.held_logouts = 0, None
        self.member_replies = []
        self.held_me, self.cancel_moves = None, False
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
        self.calls.append({"method": method, "path": path, "query": url.query, "csrf": request.headers.get("x-kin-csrf"),
                           "type": request.headers.get("content-type"), "body": request.post_data})
        if method == "GET" and path == PAGE_PATH:
            route.fulfill(body=self.admin_body, content_type="text/html; charset=utf-8")
            return
        if method == "GET" and path in SCRIPTS:
            route.fulfill(body=SCRIPTS[path], content_type="application/javascript; charset=utf-8")
            return
        if method == "GET" and path == BASE + "index.html":
            if self.cancel_moves:
                # Playwright cannot evaluate a page while its move is held, so the move is answered 204: the browser
                # cancels it and the old document stays to be read. The request is the move being counted, and a second
                # location.replace() would send a second one.
                route.fulfill(status=204, body="")
                return
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
            if self.held_me is not None:
                self.held_me.append(route)
                return
            route.fulfill(json=ME)
            return
        if method == "GET" and path == "/api/admin/users" and url.query == "page=1":
            status, body = self.member_replies.pop(0) if self.member_replies else (200, MEMBERS)
            route.fulfill(status=status, json=body)
            return
        if method == "GET" and path == "/api/studies" and url.query == "":
            self.answer(route, self.study_replies, self.held_studies)
            return
        found = re.fullmatch(r"/api/studies/([0-9.]+)/gateway-retry", path)
        if method == "POST" and found:
            self.retry_posts.append((found.group(1), request.post_data))
            self.answer(route, self.retry_replies, self.held_retries)
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

    def answer(self, route, replies, held):
        if not replies:
            self.unexpected.append(f"{route.request.method} {route.request.url} (no answer queued)")
            route.abort()
            return
        reply = replies.pop(0)
        if reply == "hold":
            held.append(route)
            return
        status, body = reply
        route.fulfill(status=status, json=body)

    # ── page helpers ──
    def wait_until(self, predicate, what, timeout=10.0):
        # Sync-API route handlers run on this thread while wait_for_timeout blocks.
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail(f"{what}: not observed within {timeout:.0f}s")
            self.page.wait_for_timeout(10)

    def json_done(self, path):
        return self.page.evaluate("path => window.__jsonDone.filter(item => item === path).length", path)

    def open(self, body=None):
        if body is not None:
            self.admin_body = body
        self.page.goto(ORIGIN + PAGE_PATH)
        expect(self.page.locator("#users td.username")).to_have_count(1)
        expect(self.page.locator("#gateway-refresh")).to_be_enabled()

    def refresh(self, reply, keep_focus=False):
        """Queue one /api/studies answer, press the control and wait until the page has read that answer.
        keep_focus presses it from script, so the focused element stays where the case put it."""
        before = self.json_done("/api/studies")
        self.study_replies.append(reply)
        if keep_focus:
            self.page.evaluate("() => document.querySelector('#gateway-refresh').click()")
        else:
            self.page.locator("#gateway-refresh").click()
        self.wait_until(lambda: self.json_done("/api/studies") > before, "the /api/studies answer read")

    def rows(self):
        return self.page.evaluate(ROWS)

    def row(self, uid):
        return next(row for row in self.rows() if row["uid"] == uid)

    def item(self, uid):
        return self.page.locator(f'#gateway-rows > li[data-uid="{uid}"]')

    def summary(self):
        return self.page.evaluate(SUMMARY)

    def section_texts(self):
        return self.page.evaluate("""() => { const section = document.querySelector('#gateway');
          return [section.textContent, ...[...section.querySelectorAll('[title]')].map(e => e.title)]; }""")

    def api_calls(self):
        return [(c["method"], c["path"], c["query"]) for c in self.calls if c["path"].startswith("/api/")]

    # ── session end helpers (cases 10-13) ──
    def fetch_done(self, path):
        return self.page.evaluate("path => window.__fetchDone.filter(item => item === path).length", path)

    def count(self, method, path):
        return sum(1 for c in self.calls if c["method"] == method and c["path"] == path)

    def moves(self):
        """Requests for the entry page: each location.replace() to it is one."""
        return self.count("GET", BASE + "index.html")

    def other_tab(self):
        """A second tab of the same origin. It only sends what auth.js broadcastEnded() sends."""
        for statement in AUTH_SIGNALS:
            self.assertIn(statement, SCRIPTS[BASE + "auth.js"], "the harness signal is the one auth.js sends")
        other = self.context.new_page()

        def serve(route):
            url = urlparse(route.request.url)
            if f"{url.scheme}://{url.netloc}" == ORIGIN and url.path == OTHER_PATH:
                route.fulfill(body=OTHER, content_type="text/html; charset=utf-8")
            elif f"{url.scheme}://{url.netloc}" == ORIGIN and url.path == "/favicon.ico":
                route.fulfill(status=404, body="")
            else:
                self.unexpected.append(f"other tab: {route.request.method} {route.request.url}")
                route.abort()

        other.route("**/*", serve)
        other.goto(ORIGIN + OTHER_PATH)
        return other

    def signals(self):
        return self.page.evaluate("() => window.__signals")

    def send(self, other, signal):
        """Send one end signal from the other tab and wait until this page's listeners have run on it."""
        before = self.signals()
        other.evaluate(signal)
        key = "channel" if signal == CHANNEL_SIGNAL else "storage"
        # The storage pair is two events (set, remove); a missing BroadcastChannel here never counts one.
        want = before[key] + (1 if key == "channel" else 2)
        self.wait_until(lambda: self.signals()[key] >= want, f"the {key} signal here")

    def list_and_retry_in_flight(self):
        """FIVE drawn, then a Now Retry and a list read both held: the answers a session end must drop."""
        self.refresh((200, FIVE))
        self.retry_replies.append("hold")
        self.item("1.2.12").locator("button").click()
        self.wait_until(lambda: len(self.held_retries) == 1, "the retry POST")
        self.study_replies.append("hold")
        self.page.locator("#gateway-refresh").click()
        self.wait_until(lambda: len(self.held_studies) == 1, "the list read")
        summary = self.summary()
        self.assertEqual((6, False), (summary["rows"], summary["refreshDisabled"]))

    def two_reads(self):
        """Two list reads held, in the order they were sent."""
        self.study_replies += ["hold", "hold"]
        button = self.page.locator("#gateway-refresh")
        button.click()
        self.wait_until(lambda: len(self.held_studies) == 1, "the first read")
        button.click()
        self.wait_until(lambda: len(self.held_studies) == 2, "the second read")
        older, newer = self.held_studies
        self.held_studies = []
        return older, newer

    def arrive_at_index(self):
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        expect(self.page.locator("#index")).to_have_text("SYN INDEX")

    def assert_closed_away(self, logouts, moves):
        self.assertEqual((logouts, moves), (self.logouts, self.moves()), "logout POSTs and moves, counted since the start")

    def assert_closed(self):
        summary = self.summary()
        self.assertEqual((0, True, False, False, False, None),
                         (summary["rows"], summary["refreshDisabled"], summary["busy"], summary["messageShown"],
                          summary["stale"], summary["empty"]), "the section is emptied and its control is off")
        self.assertEqual(("Not Loaded", "gstate not_loaded", "아직 조회하지 않았습니다.", "Counts Unknown"),
                         (summary["state"], summary["stateClass"], summary["stateTitle"], summary["counts"]),
                         "the last session's counts are gone")
        text = self.page.evaluate("() => document.querySelector('#gateway').textContent")
        self.assertIsNone(re.search(r"SYN|1\.2\.\d", text), "no patient, study or UID of the last session")

    def release_late(self):
        """The list read and the retry held from before the end come back as successes; neither may paint."""
        studies, retries = self.json_done("/api/studies"), self.json_done(retry_path("1.2.12"))
        self.held_studies.pop().fulfill(json=FIVE)
        self.held_retries.pop().fulfill(json={"studyUid": "1.2.12", "result": "requested", "requestedAt": at(7)})
        self.wait_until(lambda: self.json_done("/api/studies") > studies and self.json_done(retry_path("1.2.12")) > retries,
                        "the late answers read")
        self.assert_closed()

    # ── cases ──
    def test_01_opening_members_reads_nothing_until_asked(self):
        self.open()
        # Anything the boot would still send has had time to arrive; the member harness answers only these two.
        self.page.wait_for_timeout(300)
        self.assertEqual([("GET", "/api/me", ""), ("GET", "/api/admin/users", "page=1")], self.api_calls())
        self.assertNotIn(ARRIVALS_PATH, [c["path"] for c in self.calls])
        self.assertIsNone(self.page.evaluate("() => window.KinStudyArrivals ?? null"))
        summary = self.summary()
        self.assertEqual(("Not Loaded", "gstate not_loaded", "Counts Unknown", 0, None, False, False),
                         (summary["state"], summary["stateClass"], summary["counts"], summary["rows"], summary["empty"],
                          summary["messageShown"], summary["busy"]))

    def test_02_five_states_and_the_retry_rule(self):
        self.open()
        self.refresh((200, FIVE))
        expect(self.page.locator("#gateway-list-state")).to_have_text("Observed " + shown(6))
        rows = self.rows()
        self.assertEqual([expected[0] for expected in EXPECTED_FIVE], [row["uid"] for row in rows],
                         "listed: receipts only (no null, tele or receipt-less absent item), failures first")
        for (uid, status, chip, study_line, detail, retry, note), row in zip(EXPECTED_FIVE, rows):
            with self.subTest(uid=uid):
                self.assertEqual((status, chip, "gstate " + status, study_line, uid, detail, retry, note),
                                 (row["status"], row["chip"], row["chipClass"], row["study"], row["uidLine"], row["detail"],
                                  row["button"], row["note"]))
                if retry:
                    self.assertEqual(("Now Retry", False), (row["buttonText"], row["disabled"]))
                    self.assertTrue(has_hangul(row["buttonTitle"]))
                self.assertIsNone(re.search(r"pending|announcing|sending|complete|mystery", row["detail"] + row["chipTitle"]))
        summary = self.summary()
        self.assertEqual(("Transfer Failed 3 · Retry Requested 0 · Unknown 1 · Report Received 2", "gstate observed", False),
                         (summary["counts"], summary["stateClass"], summary["stale"]))
        colours = {row["status"]: row["background"] for row in rows}
        self.assertEqual(3, len(set(colours.values())), colours)
        gets = [c for c in self.calls if c["path"] == "/api/studies"]
        self.assertEqual([("GET", "", "1")], [(c["method"], c["query"], c["csrf"]) for c in gets])

        # Now Retry: one POST with an empty body; nothing is shown before the answer.
        self.retry_replies.append("hold")
        self.item("1.2.12").locator("button").click()
        self.wait_until(lambda: len(self.held_retries) == 1, "the retry POST")
        self.assertEqual([("1.2.12", "{}")], self.retry_posts)
        post = [c for c in self.calls if c["path"] == retry_path("1.2.12")][0]
        self.assertEqual(("1", "application/json", ""), (post["csrf"], post["type"], post["query"]))
        waiting = self.row("1.2.12")
        self.assertEqual(("failed", "Transfer Failed", "", True, True),
                         (waiting["status"], waiting["chip"], waiting["note"], waiting["button"], waiting["disabled"]))
        self.held_retries.pop().fulfill(json={"studyUid": "1.2.12", "result": "requested", "requestedAt": at(7)})
        expect(self.item("1.2.12").locator(".gw-note")).to_have_text("Retry Requested (%s)" % shown(7))
        requested = self.row("1.2.12")
        self.assertEqual(("retry_requested", "Retry Requested", "gstate retry_requested", False),
                         (requested["status"], requested["chip"], requested["chipClass"], requested["button"]))
        for title in (requested["chipTitle"], requested["noteTitle"]):
            self.assertIn("재시도가 실행됐다는 뜻은 아닙니다", title)
        self.assertNotEqual(colours["failed"], requested["background"])
        self.assertEqual("Transfer Failed 2 · Retry Requested 1 · Unknown 1 · Report Received 2", self.summary()["counts"])
        self.assertEqual([expected[0] for expected in EXPECTED_FIVE], [row["uid"] for row in self.rows()],
                         "a request this page made never moves a row")

        # A refusal is a fixed sentence and the control stays; the server wording never shows.
        for status, code, sentence in ((409, "GATEWAY_RETRY_NOT_RETRY", NOT_RETRY), (503, "GATEWAY_RETRY_BUSY", BUSY)):
            with self.subTest(status=status):
                done = self.json_done(retry_path("1.2.20"))
                self.retry_replies.append((status, {"code": code, "message": SERVER_WORDING}))
                self.item("1.2.20").locator("button").click()
                self.wait_until(lambda: self.json_done(retry_path("1.2.20")) > done, "the refused retry answer")
                refused = self.row("1.2.20")
                self.assertEqual(("failed", sentence, True, False),
                                 (refused["status"], refused["note"], refused["button"], refused["disabled"]))

        # The same receipt read again keeps the stored request and the last answers.
        self.refresh((200, FIVE))
        again = {row["uid"]: row for row in self.rows()}
        self.assertEqual(("retry_requested", "Retry Requested (%s)" % shown(7), False),
                         (again["1.2.12"]["status"], again["1.2.12"]["note"], again["1.2.12"]["button"]))
        self.assertEqual(BUSY, again["1.2.20"]["note"])
        self.assertEqual(1, [c["path"] for c in self.calls].count(ARRIVALS_PATH), "the shared rules load once")
        self.assertEqual([("1.2.12", "{}"), ("1.2.20", "{}"), ("1.2.20", "{}")], self.retry_posts)
        self.assertFalse(any(SERVER_WORDING in text for text in self.section_texts()))

    def test_03_query_failed_keeps_the_last_list_and_withdraws_the_control(self):
        self.open()
        self.refresh((200, FIVE))
        self.page.evaluate("() => document.querySelectorAll('#gateway-rows > li').forEach(li => { li.dataset.harnessKept = li.dataset.uid; })")
        before = self.rows()
        for reply, sentence in (((500, {"message": SERVER_WORDING}), "검사 목록을 불러오지 못했습니다."),
                                ((200, {"studies": "SYN", "observedAt": at(7)}), "조회 응답 형식을 확인할 수 없습니다."),
                                ((409, {"code": "STUDY_LIST_CHANGED", "message": SERVER_WORDING}), "검사 접근 범위가 바뀌었습니다. 다시 조회하세요.")):
            with self.subTest(reply=reply[0]):
                self.refresh(reply)
                summary = self.summary()
                self.assertEqual(("Query Failed · 마지막 관측 기준 " + shown(6), "gstate query_failed", sentence, True, True),
                                 (summary["state"], summary["stateClass"], summary["message"], summary["messageShown"], summary["stale"]))
                self.assertIn("마지막으로 성공한 조회 기준", summary["stateTitle"])
                self.assertEqual("Transfer Failed 3 · Retry Requested 0 · Unknown 1 · Report Received 2", summary["counts"])
                kept = self.rows()
                self.assertEqual([row["uid"] for row in before], [row["uid"] for row in kept])
                self.assertEqual([row["detail"] for row in before], [row["detail"] for row in kept])
                self.assertEqual([], [row["uid"] for row in kept if row["button"]], "no Now Retry over a failed list read")
                self.assertEqual(6, self.page.evaluate("() => document.querySelectorAll('#gateway-rows > li[data-harness-kept]').length"),
                                 "the same nodes are kept")
        self.assertFalse(any(SERVER_WORDING in text for text in self.section_texts()))

        recovered = listing([study("1.2.12", receipt("retry", 7, 4))], [], minute=8)
        self.refresh((200, recovered))
        summary = self.summary()
        self.assertEqual(("Observed " + shown(8), False, False, "Transfer Failed 1 · Retry Requested 0 · Unknown 0 · Report Received 0"),
                         (summary["state"], summary["messageShown"], summary["stale"], summary["counts"]))
        self.assertEqual([("1.2.12", True)], [(row["uid"], row["button"]) for row in self.rows()])

    def test_04_unknown_is_never_zero(self):
        self.open()
        self.refresh((503, {"code": "SYN", "message": SERVER_WORDING}))
        summary = self.summary()
        self.assertEqual(("Query Failed · 아직 성공한 조회가 없습니다", "gstate query_failed", "Counts Unknown", 0, None),
                         (summary["state"], summary["stateClass"], summary["counts"], summary["rows"], summary["empty"]))
        self.assertEqual("서버가 바쁘거나 원본 조회가 지연되었습니다. 잠시 후 다시 조회하세요.", summary["message"])

        undecided = "영상이 관측되지 않은 검사의 Gateway 보고는 이번 조회로 확인하지 못했습니다."
        self.refresh((200, listing([study("1.2.10", receipt("sending", 4, 4))], None)))
        summary = self.summary()
        self.assertEqual(("Observed " + shown(6), "Transfer Failed 0 · Retry Requested 0 · Unknown 0 · Report Received 1 · Not Observed Unknown"),
                         (summary["state"], summary["counts"]))
        self.assertIn(undecided, summary["stateTitle"])

        self.refresh((200, listing([study("1.2.15", None)], [absent("1.2.21")])))
        summary = self.summary()
        self.assertEqual(("Transfer Failed 0 · Retry Requested 0 · Unknown 0 · Report Received 0", 0,
                          "이 기관 Gateway 보고가 있는 검사가 없습니다."), (summary["counts"], summary["rows"], summary["empty"]))
        self.assertNotIn(undecided, summary["stateTitle"])

        self.refresh((200, listing([study("1.2.15", None)], None)))
        summary = self.summary()
        self.assertTrue(summary["counts"].endswith(" · Not Observed Unknown"), summary["counts"])
        self.assertEqual("목록에 있는 검사에는 Gateway 보고가 없습니다. " + undecided, summary["empty"])

    def list_a_b(self):
        """Two reads in flight; the newer (B) answers first, then the older (A)."""
        older = listing([study("1.2.12", receipt("retry", 7, 4))], [], minute=6)
        newer = listing([study("1.2.10", receipt("sending", 4, 4))], [], minute=7)
        self.study_replies += ["hold", "hold"]
        button = self.page.locator("#gateway-refresh")
        button.click()
        self.wait_until(lambda: len(self.held_studies) == 1, "the first read")
        button.click()
        self.wait_until(lambda: len(self.held_studies) == 2, "the second read")
        first, second = self.held_studies
        second.fulfill(json=newer)
        self.wait_until(lambda: self.json_done("/api/studies") == 1, "the newer answer read")
        expect(self.page.locator("#gateway-list-state")).to_have_text("Observed " + shown(7))
        first.fulfill(json=older)
        self.wait_until(lambda: self.json_done("/api/studies") == 2, "the older answer read")
        return older

    def test_05_a_late_list_answer_never_paints_over_a_newer_one(self):
        self.open()
        older = self.list_a_b()
        summary = self.summary()
        self.assertEqual(("Observed " + shown(7), False), (summary["state"], summary["busy"]))
        self.assertEqual(["1.2.10"], [row["uid"] for row in self.rows()])
        # A->B->A: asking again for the older content is a new request, and it paints.
        self.refresh((200, older))
        self.assertEqual("Observed " + shown(6), self.summary()["state"])
        self.assertEqual(["1.2.12"], [row["uid"] for row in self.rows()])

        # Control: without the sequence guard the late older answer is painted over the newer one.
        self.held_studies = []
        self.open(variant(SEQUENCE_GUARD))
        self.list_a_b()
        self.assertEqual("Observed " + shown(6), self.summary()["state"])
        self.assertEqual(["1.2.12"], [row["uid"] for row in self.rows()])

    def retry_a_b_a(self):
        """Now Retry on 1.2.12 at key seq 7, then the list shows seq 8 and then seq 7 again; then the answer comes."""
        first = listing([study("1.2.12", receipt("retry", 7, 4))], [absent("1.2.20", receipt("retry", 3, 2, success=0, local=2))])
        newer = listing([study("1.2.12", receipt("retry", 8, 5))], [absent("1.2.20", receipt("retry", 3, 2, success=0, local=2))])
        self.refresh((200, first))
        self.retry_replies.append("hold")
        self.item("1.2.12").locator("button").click()
        self.wait_until(lambda: len(self.held_retries) == 1, "the retry POST")
        self.refresh((200, newer))
        moved = self.row("1.2.12")
        self.assertEqual(("failed", "", True, False), (moved["status"], moved["note"], moved["button"], moved["disabled"]),
                         "a newer receipt is drawn fresh: no token, no mark, no note")
        self.refresh((200, first))
        back = self.row("1.2.12")
        self.assertEqual(("failed", "", True, False), (back["status"], back["note"], back["button"], back["disabled"]))
        self.held_retries.pop().fulfill(json={"studyUid": "1.2.12", "result": "requested", "requestedAt": at(7)})
        self.wait_until(lambda: self.json_done(retry_path("1.2.12")) == 1, "the late retry answer read")
        return first

    def test_06_a_retry_answer_is_written_only_over_the_receipt_it_was_requested_for(self):
        self.open()
        first = self.retry_a_b_a()
        late = self.row("1.2.12")
        self.assertEqual(("failed", "Transfer Failed", "", True, False),
                         (late["status"], late["chip"], late["note"], late["button"], late["disabled"]))
        self.assertEqual("Transfer Failed 2 · Retry Requested 0 · Unknown 0 · Report Received 0", self.summary()["counts"])

        # An item that leaves the list and comes back is a new node and never takes the answer of the old one.
        self.page.evaluate("() => { window.__leaving = document.querySelector('#gateway-rows > li[data-uid=\"1.2.20\"]'); }")
        self.retry_replies.append("hold")
        self.item("1.2.20").locator("button").click()
        self.wait_until(lambda: len(self.held_retries) == 1, "the second retry POST")
        self.refresh((200, listing([study("1.2.12", receipt("retry", 7, 4))], [])))
        self.assertEqual(["1.2.12"], [row["uid"] for row in self.rows()])
        self.refresh((200, first))
        self.assertFalse(self.page.evaluate(
            "() => window.__leaving.isSameNode(document.querySelector('#gateway-rows > li[data-uid=\"1.2.20\"]'))"))
        self.held_retries.pop().fulfill(json={"studyUid": "1.2.20", "result": "requested", "requestedAt": at(8)})
        self.wait_until(lambda: self.json_done(retry_path("1.2.20")) == 1, "the late answer of the item that left")
        returned = self.row("1.2.20")
        self.assertEqual(("failed", "", True, False), (returned["status"], returned["note"], returned["button"], returned["disabled"]))
        self.assertEqual([("1.2.12", "{}"), ("1.2.20", "{}")], self.retry_posts, "one POST each")

        # Control: without the token guard the late answer is written over the receipt drawn now.
        self.open(variant(TOKEN_GUARD))
        self.retry_a_b_a()
        expect(self.item("1.2.12").locator(".gw-note")).to_have_text("Retry Requested (%s)" % shown(7))
        self.assertEqual("retry_requested", self.row("1.2.12")["status"])

    def test_07_a_401_empties_the_section_before_logout_and_drops_late_answers(self):
        self.open()
        self.refresh((200, FIVE))
        self.retry_replies.append("hold")
        self.item("1.2.12").locator("button").click()
        self.wait_until(lambda: len(self.held_retries) == 1, "the retry POST")
        self.held_logouts = []
        self.study_replies.append((401, {"message": SERVER_WORDING}))
        self.page.locator("#gateway-refresh").click()
        self.wait_until(lambda: self.logouts == 1, "the logout request")
        summary = self.summary()
        self.assertEqual((0, True, False, False), (summary["rows"], summary["refreshDisabled"], summary["busy"], summary["messageShown"]))
        self.held_retries.pop().fulfill(json={"studyUid": "1.2.12", "result": "requested", "requestedAt": at(7)})
        self.wait_until(lambda: self.json_done(retry_path("1.2.12")) == 1, "the late retry answer read")
        self.assertEqual(0, self.summary()["rows"], "nothing is painted after the session ended")
        self.held_logouts.pop().fulfill(status=204, body="")
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        expect(self.page.locator("#index")).to_have_text("SYN INDEX")
        self.assertEqual(1, self.logouts)
        self.assertEqual(1, [c["path"] for c in self.calls].count(BASE + "index.html"), "one navigation")

    def test_08_wording_sizes_keyboard_and_no_dialog(self):
        self.open()
        static = self.page.evaluate("""() => [...document.querySelectorAll('#gateway h2, #gateway button, #gateway .gstate, #gateway-counts')]
          .map(e => e.textContent)""")
        self.assertEqual(["Gateway Status", "Not Loaded", "Counts Unknown", "Refresh Gateway Status"], static)
        self.refresh((200, FIVE))
        english = self.page.evaluate("""() => [...document.querySelectorAll('#gateway h2, #gateway button, #gateway .gstate, #gateway-counts')]
          .map(e => e.textContent)""")
        self.assertEqual([], [text for text in english if has_hangul(text)])
        korean = self.page.evaluate("""() => { const q = s => [...document.querySelectorAll(s)];
          return [document.querySelector('.gateway-hint').textContent, ...q('#gateway .gstate').map(e => e.title),
            ...q('#gateway-rows button').filter(e => !e.hidden).map(e => e.title), ...q('#gateway-rows .gw-detail').map(e => e.textContent),
            ...q('#gateway-rows .gw-note').map(e => e.textContent).filter(Boolean)]; }""")
        self.assertEqual([], [text for text in korean if not has_hangul(text)])
        texts = self.section_texts()
        self.assertEqual([], [text for text in texts if AVOIDED.search(text)])
        self.assertEqual([], [text for text in texts if DELIVERY.search(text)])
        # "received" is only the state word Report Received (a report KIN received), never a claim about images.
        leftover = [re.sub(r"Report Received", "", text) for text in texts]
        self.assertEqual([], [text for text in leftover if re.search(r"received", text, re.IGNORECASE)])
        sizes = self.page.evaluate("""() => [...document.querySelectorAll('#gateway *')]
          .filter(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && e.getClientRects().length)
          .map(e => [e.tagName + '.' + e.className, parseFloat(getComputedStyle(e).fontSize)])""")
        self.assertTrue(sizes)
        self.assertEqual([], [entry for entry in sizes if entry[1] < 12])

        # Keyboard: the control is a real button; focus survives a refresh of the same list (the node is kept).
        control = self.item("1.2.20").locator("button")
        control.focus()
        self.refresh((200, FIVE), keep_focus=True)
        self.assertTrue(self.page.evaluate(
            "() => document.activeElement === document.querySelector('#gateway-rows > li[data-uid=\"1.2.20\"] button')"))
        self.retry_replies.append((200, {"studyUid": "1.2.20", "result": "already_requested", "requestedAt": at(5)}))
        self.page.keyboard.press("Enter")
        expect(self.item("1.2.20").locator(".gw-note")).to_have_text("Retry Requested (%s)" % shown(5))
        self.assertEqual([("1.2.20", "{}")], self.retry_posts)
        self.assertEqual(0, self.summary()["openDialogs"])

    def test_09_pure_rules_in_the_page(self):
        self.open()
        self.refresh((200, listing([])))
        result = self.page.evaluate("""epoch => { const A = window.KinStudyArrivals, same = v => v;
          const r = (phase, extra) => ({phase, successCount: phase === 'complete' ? 4 : 1, localCount: 4, attempt: 2,
            errorCode: phase === 'retry' ? 'stow_http' : phase === 'failed' ? 'instance_exceeds_budget' : null,
            serverReceivedAt: '2026-09-24T01:04:00.000Z', agentSeq: 5, epoch, ...extra});
          const phases = Object.fromEntries(A.PHASES.map(p => { const s = A.gatewayStatus(r(p), null, same);
            return [p, [s.key, s.retry && s.retry.kind]]; }));
          const requested = A.gatewayStatus(r('retry'), epoch + '|5', same).key;
          const otherKey = A.gatewayStatus(r('retry'), epoch + '|4', same).key;
          const requestedFailed = A.gatewayStatus(r('failed'), epoch + '|5', same).key;
          const unbindable = A.gatewayStatus(r('retry', {epoch: 'SYN'}), null, same);
          const unreadable = [r('mystery'), r('sending', {successCount: 5}), r('sending', {serverReceivedAt: 'soon'}), null, 'SYN',
            r('sending', {localCount: -1})].map(x => A.gatewayStatus(x, null, same).key);
          const echo = A.gatewayStatus(r('failed', {errorCode: '<b>SYN</b>'}), null, same).reason;
          const otherCode = A.gatewayStatus(r('failed', {errorCode: 'stow_http'}), null, same).reason;
          const rows = A.gatewayStatusRows;
          const valid = {studies: [], observedAt: '2026-09-24T01:06:00.000Z', notObserved: []};
          const malformed = [null, [], {}, {...valid, studies: 'SYN'}, {...valid, observedAt: 'soon'},
            {...valid, studies: [{uid: 'SYN'}]}, {...valid, studies: [{uid: '1.2.3'}, {uid: '1.2.3'}]},
            {...valid, notObserved: 'SYN'}, {...valid, notObserved: [{uid: '1.2.9'}]},
            {...valid, studies: [{uid: '1.2.3', gatewayReceipt: null}], notObserved: [{uid: '1.2.3', origin: 'gateway', createdAt: '2026-09-24T00:30:00.000Z'}]}
          ].map(x => rows(x));
          const undecided = rows({...valid, notObserved: null}), absent = rows({...valid, notObserved: undefined});
          const summaries = [A.gatewayStatusSummary(null, same), A.gatewayStatusSummary({failed: true}, same),
            A.gatewayStatusSummary({observedAt: '2026-09-24T01:06:00.000Z', absentKnown: true, statuses: ['failed', 'received', 'SYN']}, same),
            A.gatewayStatusSummary({observedAt: '2026-09-24T01:06:00.000Z', failed: true, absentKnown: false, statuses: []}, same)]
            .map(s => [s.key, s.text, s.counts]);
          return {phases, requested, otherKey, requestedFailed, unbindable: [unbindable.key, unbindable.retry], unreadable, echo,
            otherCode, malformed, undecided: [undecided.absentKnown, undecided.rows.length], absent: absent.absentKnown, summaries,
            frozen: Object.isFrozen(A.GATEWAY_STATUS) && Object.values(A.GATEWAY_STATUS).every(Object.isFrozen)}; }""", EPOCH)
        self.assertEqual({"pending": ["received", None], "announcing": ["received", None], "sending": ["received", None],
                          "retry": ["failed", "now_retry"], "failed": ["failed", "unsupported_f01"], "complete": ["received", None]},
                         result["phases"])
        self.assertEqual(("retry_requested", "failed", "failed"), (result["requested"], result["otherKey"], result["requestedFailed"]))
        self.assertEqual(["failed", None], result["unbindable"])
        self.assertEqual(["unknown"] * 6, result["unreadable"])
        self.assertEqual("", result["echo"], "an error code outside the closed shape is not echoed")
        self.assertEqual("오류 코드 stow_http", result["otherCode"], "the size reason belongs to instance_exceeds_budget only")
        self.assertEqual([None] * 10, result["malformed"])
        self.assertEqual(([False, 0], False), (result["undecided"], result["absent"]))
        self.assertEqual([
            ["not_loaded", "Not Loaded", "Counts Unknown"],
            ["query_failed", "Query Failed · 아직 성공한 조회가 없습니다", "Counts Unknown"],
            ["observed", "Observed 2026-09-24T01:06:00.000Z", "Transfer Failed 1 · Retry Requested 0 · Unknown 0 · Report Received 1"],
            ["query_failed", "Query Failed · 마지막 관측 기준 2026-09-24T01:06:00.000Z",
             "Transfer Failed 0 · Retry Requested 0 · Unknown 0 · Report Received 0 · Not Observed Unknown"],
        ], result["summaries"])
        self.assertTrue(result["frozen"])

    def test_10_log_out_and_a_member_401_empty_the_section_before_the_logout_answers(self):
        for how in ("Log out", "member list 401"):
            with self.subTest(how=how):
                self.open()
                self.list_and_retry_in_flight()
                logouts, moves = self.logouts, self.moves()
                self.held_logouts = []
                if how == "Log out":
                    self.page.locator("#logout").click()
                else:
                    self.member_replies.append((401, {"message": SERVER_WORDING}))
                    self.page.locator("#refresh").click()
                self.wait_until(lambda: self.logouts == logouts + 1, "the logout request")
                self.assert_closed()
                self.release_late()
                # Nothing leaves the page after its end: the member console's Refresh says so and reads nothing.
                reads = self.count("GET", "/api/admin/users")
                self.page.locator("#refresh").click()
                expect(self.page.locator("#message")).to_have_text(ENDED)
                self.assertEqual(reads, self.count("GET", "/api/admin/users"))
                # Log out again adds nothing; after the POST answers, auth.js's end broadcast reaches this page too.
                self.page.locator("#logout").click()
                self.assertEqual((logouts + 1, moves), (self.logouts, self.moves()))
                self.held_logouts.pop().fulfill(status=204, body="")
                self.held_logouts = None
                self.arrive_at_index()
                self.assert_closed_away(logouts + 1, moves + 1)

        # Control: Log out wired to KinAuth.logout() with no end listener (cafc72c) keeps the list and the control
        # while the POST is out.
        self.open(edited([(LOGOUT_WIRING, CAFC72C_LOGOUT_WIRING), (END_LISTENERS, "")]))
        self.refresh((200, FIVE))
        logouts = self.logouts
        self.held_logouts = []
        self.page.locator("#logout").click()
        self.wait_until(lambda: self.logouts == logouts + 1, "the control's logout request")
        summary = self.summary()
        self.assertEqual((6, False, "gstate observed"), (summary["rows"], summary["refreshDisabled"], summary["stateClass"]))
        self.held_logouts.pop().fulfill(status=204, body="")
        self.held_logouts = None
        self.arrive_at_index()

    def test_11_another_tabs_end_empties_the_section_without_a_logout_post(self):
        other = self.other_tab()
        # Control first, both signals: the page without the two listeners keeps the list and stays.
        self.open(variant(END_LISTENERS))
        self.page.evaluate(PROBE)
        self.refresh((200, FIVE))
        moves, logouts = self.moves(), self.logouts
        self.send(other, CHANNEL_SIGNAL)
        self.send(other, STORAGE_SIGNAL)
        self.page.wait_for_timeout(200)
        summary = self.summary()
        self.assertEqual((6, False, moves, logouts), (summary["rows"], summary["refreshDisabled"], self.moves(), self.logouts))

        for signal, channel_here in ((CHANNEL_SIGNAL, True), (STORAGE_SIGNAL, False)):
            with self.subTest(signal="BroadcastChannel" if channel_here else "storage, no BroadcastChannel here"):
                if not channel_here:
                    # From here on this tab has no BroadcastChannel: the storage pair is the only signal it can get.
                    self.page.add_init_script("delete window.BroadcastChannel;")
                self.open(ADMIN_HTML)
                self.assertEqual(channel_here, self.page.evaluate("() => typeof BroadcastChannel === 'function'"))
                self.page.evaluate(PROBE)
                self.list_and_retry_in_flight()
                moves, logouts, reads = self.moves(), self.logouts, self.count("GET", "/api/admin/users")
                self.cancel_moves = True
                self.send(other, signal)
                self.wait_until(lambda: self.moves() == moves + 1, "the move to the entry page")
                self.assert_closed()
                self.release_late()
                self.page.locator("#refresh").click()
                expect(self.page.locator("#message")).to_have_text(ENDED)
                # The signals again: no second move, no logout POST, no request.
                for again in (CHANNEL_SIGNAL, STORAGE_SIGNAL) if channel_here else (STORAGE_SIGNAL,):
                    self.send(other, again)
                self.page.wait_for_timeout(200)
                self.assertEqual(reads, self.count("GET", "/api/admin/users"))
                self.assert_closed()
                self.assert_closed_away(logouts, moves + 1)
                self.cancel_moves = False

    def test_12_an_end_while_the_session_is_read_starts_nothing(self):
        other = self.other_tab()
        for status in (200, 401):
            with self.subTest(me=status):
                moves, logouts, reads = self.moves(), self.logouts, self.count("GET", "/api/admin/users")
                self.held_me, self.cancel_moves = [], True
                self.page.goto(ORIGIN + PAGE_PATH)
                self.wait_until(lambda: len(self.held_me) == 1, "the session read")
                self.page.evaluate(PROBE)
                self.send(other, CHANNEL_SIGNAL)
                self.wait_until(lambda: self.moves() == moves + 1, "the move to the entry page")
                me, self.held_me = self.held_me.pop(), None
                if status == 200:
                    me.fulfill(json=ME)
                    self.wait_until(lambda: self.json_done("/api/me") == 1, "the session answer read")
                else:
                    me.fulfill(status=401, json={"message": SERVER_WORDING})
                    self.wait_until(lambda: self.fetch_done("/api/me") == 1, "the session answer")
                self.page.wait_for_timeout(200)
                summary = self.summary()
                self.assertEqual((True, 0, "Not Loaded", "Counts Unknown"),
                                 (summary["refreshDisabled"], summary["rows"], summary["state"], summary["counts"]))
                self.assertEqual(["", ""], self.page.evaluate(
                    "() => [document.querySelector('#actor').textContent, document.querySelector('#message').textContent]"))
                self.assertEqual(reads, self.count("GET", "/api/admin/users"))
                self.assert_closed_away(logouts, moves + 1)
                self.cancel_moves = False

    def test_13_an_older_reads_401_ends_the_session_whatever_the_order(self):
        self.open()
        self.refresh((200, FIVE))
        self.retry_replies.append("hold")
        self.item("1.2.12").locator("button").click()
        self.wait_until(lambda: len(self.held_retries) == 1, "the retry POST")
        older, newer = self.two_reads()
        logouts, moves = self.logouts, self.moves()
        self.held_logouts = []
        older.fulfill(status=401, json={"message": SERVER_WORDING})
        self.wait_until(lambda: self.logouts == logouts + 1, "the logout request")
        self.assert_closed()
        done = self.json_done("/api/studies")
        newer.fulfill(json=FIVE)
        self.wait_until(lambda: self.json_done("/api/studies") > done, "the newer answer read")
        self.assert_closed()
        # A second 401 (the retry answer) adds no POST and no move.
        self.held_retries.pop().fulfill(status=401, json={"message": SERVER_WORDING})
        self.wait_until(lambda: self.fetch_done(retry_path("1.2.12")) == 1, "the retry 401")
        self.assert_closed()
        self.assertEqual((logouts + 1, moves), (self.logouts, self.moves()))
        self.held_logouts.pop().fulfill(status=204, body="")
        self.held_logouts = None
        self.arrive_at_index()
        self.assert_closed_away(logouts + 1, moves + 1)

        # Control: the 401 judged after the sequence check (cafc72c) drops the older read's 401 with its answer.
        self.open(edited([(GATEWAY_401, CAFC72C_GATEWAY_401), (AFTER_SEQUENCE, CAFC72C_AFTER_SEQUENCE)]))
        self.refresh((200, FIVE))
        older, newer = self.two_reads()
        logouts = self.logouts
        done = self.fetch_done("/api/studies")
        older.fulfill(status=401, json={"message": SERVER_WORDING})
        self.wait_until(lambda: self.fetch_done("/api/studies") > done, "the control's older 401")
        summary = self.summary()
        self.assertEqual((6, False, logouts), (summary["rows"], summary["refreshDisabled"], self.logouts))
        done = self.json_done("/api/studies")
        newer.fulfill(json=FIVE)
        self.wait_until(lambda: self.json_done("/api/studies") > done, "the control's newer answer read")
        summary = self.summary()
        self.assertEqual((6, False, logouts), (summary["rows"], summary["refreshDisabled"], self.logouts))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
