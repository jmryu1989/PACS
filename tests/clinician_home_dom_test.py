# coding: utf-8
"""REQ-S5-U2a-CLINICIAN-HOME -> RISK-S5-U2a-STALE-A-B-A / HIDE-AS-PERMISSION / STATE-CONFUSION -> TEST-S5-U2a-DOM.

The clinician home (worklist-v0/hpacs-lite/clinician.html + clinician.js) and its landing (index.html, auth.js) are
loaded unchanged from a synthetic origin. /api/me, GET /api/clinician/studies (paged exactly as study-page.ts pages:
limit 100, a signed `next` handed back as `after`) and GET /api/clinician/studies/:uid/report are answered from
in-test stores shaped as clinician-policy.ts shapes them (clinicianList / clinicianReport / clinicianKeyImage), with
extra writer-side fields planted in the stubs that the real serializer never sends:

  01  landing: from index.html a clinician-only session (Keycloak default roles ignored) opens clinician.html and every
      mixed, radiologist, technician, admin or pending session opens main.html as before; on main.html itself (where
      the OIDC callback sends every login) a clinician-only session is handed to clinician.html and main.html's boot
      never runs past `await KinAuth.init()`, while a mixed session boots there. The three source lines this relies
      on are pinned.
  02  identifiers (name, ID, sex / age at study, birth date, study date, institution) from the list row; a final
      answer shows its version, type, signer, date, three body fields and key images, in that order before anything
      else; data is text, never markup or translated; no planted field reaches the page.
  03  non-final answers (P, W, T, H, unknown) show the status only, even when the stub carries a body; a final answer
      without its body or key list, an answer for another study, 404 and 403 are failures shown as the server wrote
      them, with Retry.
  04  A->B->A: a late answer for A never paints while A's newer request is pending, nor over B.
  05  controls: the same file with a UID-only guard and with no guard is served through the same route and must paint
      the late answer exactly as the risk says, so 04 cannot pass on a harness that misses late answers.
  06  the list's loading / empty / failed states are distinct in text and state; 409, 403 with and without a message
      are shown as sent; a late earlier list never replaces a newer one (and its no-guard control does).
  07  paging passes each signed cursor verbatim, shows progress, rejects a malformed page and re-reads /me: another
      account in the same browser clears the page.
  08  English controls / Korean explanations, no avoided words, no acknowledgement wording, no browser dialogs,
      text >= 12px, hit targets >= 24px, one tab stop for the list, arrows/Home/End/Enter/Space.
  09  Log out, a session ended in another tab, pending and invalid membership, and no session. Log out, two 401s and
      another tab's log out (a channel message and the storage events of a set and a remove) each leave with one
      navigation, counted as document requests while the first is held; the same file without the guard navigates
      again, or logs out again, inside the same window (control).

Synthetic data only (SYN-* names): no server, no network, no credentials. A request the harness does not answer is
aborted and fails the case. The service half is tests/clinician_read_live.py (hosted synthetic stack only).
"""
import copy
from pathlib import Path
import re
import sys
import time
import unicodedata
import unittest
from urllib.parse import parse_qs, unquote, urlparse

from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"


def lf_text(path):
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


ORIGIN = "https://clinician.test"
BASE = "/worklist/hpacs-lite/"
SHIPPED = {name: lf_text(HPACS / name) for name in ("clinician.html", "clinician.js", "index.html", "auth.js")}
MAIN_HTML = lf_text(HPACS / "main.html")
AUTH_CONTROLLER = lf_text(ROOT / "api" / "src" / "auth.controller.ts")
EMBLEM = (HPACS / "kin-emblem-j1.svg").read_bytes()

# main.html at its own path: the shipped auth.js, then main.html's boot opening (pinned in test_01). The beacon says
# whether boot went past init() and with which roles.
MAIN_STAND_IN = """<!doctype html><html><head><meta charset="utf-8"><title>SYN main stand-in</title></head><body>
<script src="auth.js"></script>
<script>
(async () => {
  try { await KinAuth.init(); } catch (e) { fetch('/harness/booted?error=1'); return; }
  const s = KinAuth.session();
  fetch('/harness/booted?roles=' + encodeURIComponent(((s && s.roles) || []).join(',')));
})();
</script></body></html>"""
INDEX_STAND_IN = ('<!doctype html><html><head><meta charset="utf-8"><title>SYN index stand-in</title></head>'
                  '<body><p id="stand-in">SYN index stand-in</p></body></html>')
BLANK = '<!doctype html><html><head><meta charset="utf-8"><title>SYN blank</title></head><body></body></html>'

INSTITUTION = "SYN-INST-A"
KEYCLOAK_DEFAULTS = ["default-roles-kin", "offline_access", "uma_authorization"]


def me(roles, sub="SYN-CLIN-SUB", user="syn-clinician", name="SYN Clinician"):
    return {"sub": sub, "actor": user, "roles": roles, "institution": INSTITUTION, "kind": "member", "user": user,
            "displayName": name}


PREFIX = "1.2.826.0.1.3680043.10.5432"


def uid(n):
    return f"{PREFIX}.{n}"


HOSTILE = '<img src=x onerror="document.body.dataset.pwned=1">'
# Writer-side fields listStudies / report-preview carry and clinician-policy.ts never copies. Planted here only to
# show the page draws named DTO fields, not whatever arrives.
PLANTED = {"draft": {"findings": "SYN-LEAK-DRAFT"}, "state": {"holdReason": "SYN-LEAK-STATE", "rs": "A"},
           "techNote": {"text": "SYN-LEAK-NOTE"}, "readerAssignment": {"reader": {"name": "SYN-LEAK-READER"}},
           "orderIdentity": {"order": "SYN-LEAK-ORDER"}, "gatewayReceipt": {"note": "SYN-LEAK-RECEIPT"},
           "holdReason": "SYN-LEAK-HOLD", "preReviewer": "SYN-LEAK-REVIEWER"}


def study(n, name, pid, sex, birth, date, report, **extra):
    row = {"uid": uid(n), "id": pid, "name": name, "birth": birth, "sex": sex, "date": date, "acc": f"SYN-ACC-{n}",
           "desc": f"SYN DESC {n}", "modality": "CT", "count": 120, "series": 3,
           "sourcePatientKey": f"{INSTITUTION}|{pid}", "institutionName": "SYN Hospital A", "tele": False,
           "report": report}
    row.update(extra)
    return row


FINAL_A = {"final": True, "rs": "A", "action": "approve", "version": 3, "repDoc": "syn-rad", "confirm": "2026-09-20"}
FINAL_B = {"final": True, "rs": "A", "action": "addendum", "version": 5, "repDoc": "syn-rad2", "confirm": "2026-09-22"}
ROWS = [
    study(1, "SYN ALPHA", "SYN-P-001", "M", "19800517", "20260320", FINAL_A, **PLANTED),
    study(2, "홍길동 SYN", "SYN-P-002", "F", "1990-01-02", "20260321", FINAL_B),
    study(3, "SYN GAMMA", "SYN-P-003", "O", "20000229", "20260322", {"final": False, "rs": "P"}, **PLANTED),
    study(4, "SYN DELTA", "SYN-P-004", "", "", "20260101", {"final": False, "rs": None}),
    study(5, "SYN EPSILON", "SYN-P-005", "M", "19700101", "", {"final": False, "rs": "W"}),
    study(6, HOSTILE, "SYN-P-006", "F", "19991231", "20260310", {"final": False, "rs": "H"}, tele=True),
    study(7, "SYN ETA", "SYN-P-007", "M", "19850615", "20260201", {"final": False, "rs": "T"}),
]
ORDER = [uid(3), uid(2), uid(1), uid(6), uid(7), uid(4), uid(5)]


def key(k, title, description, frame):
    return {"id": f"00000000-0000-4000-8000-00000000000{k}", "revision": 1,
            "item": {"schemaVersion": 1, "kind": "key", "seriesUid": f"{PREFIX}.9{k}", "sopUid": f"{PREFIX}.9{k}.1",
                     "frame": frame, "title": title, "description": description}}


def final_report(n, version, action, findings, conclusion, recommendation, keys, **planted):
    report = {"final": True, "rs": "A", "action": action, "version": version, "repDoc": "syn-rad",
              "confirm": "2026-09-20", "findings": findings, "conclusion": conclusion, "recommendation": recommendation}
    return {"uid": uid(n), "report": report, "keys": keys, **planted}


def open_report(n, rs, **planted):
    return {"uid": uid(n), "report": {"final": False, "rs": rs, **planted}, "keys": None}


REPORTS = {
    uid(1): final_report(1, 3, "approve", "SYN-A findings line 1\nline 2", "SYN-A conclusion", "",
                         [key(1, "SYN key one", "SYN key one note", 12), key(2, HOSTILE, "", 1)],
                         draft="SYN-LEAK-REPORT-DRAFT", author="SYN-LEAK-AUTHOR", citations=[{"f": "SYN-LEAK-CITE"}]),
    uid(2): final_report(2, 5, "addendum", "SYN-B findings", "SYN-B conclusion", "SYN-B recommendation", []),
    uid(3): open_report(3, "P", findings="SYN-LEAK-PRELIM", conclusion="SYN-LEAK-PRELIM"),
    uid(4): open_report(4, None),
    uid(5): open_report(5, "W"),
    uid(6): open_report(6, "H"),
    uid(7): open_report(7, "T"),
}

# Product wording, verbatim (clinician.js TEXT / OPEN_NOTE / FINAL_ONLY).
FINAL_ONLY = "확정된 판독문(승인 또는 Addendum)만 본문과 키 이미지를 표시합니다."
LIST_LOADING = "검사 목록을 불러오는 중입니다…"
LIST_EMPTY = "표시할 검사가 없습니다. 목록 조회는 성공했습니다."
LIST_FAILED = "검사 목록을 불러오지 못했습니다."
REPORT_FAILED = "판독문을 불러오지 못했습니다."
KEYS_LOADING = "키 이미지를 불러오는 중입니다…"
KEYS_WITHHELD = "확정 전에는 키 이미지를 표시하지 않습니다."
KEYS_NONE = "이 판독문에 지정된 키 이미지가 없습니다."
KEYS_FAILED = "판독문을 불러오지 못해 키 이미지도 표시하지 않았습니다."
CHANGED = "검사 목록 또는 판독 상태가 바뀌었습니다. 새로고침하세요."

# UXR-SP-34 / UXR-G-18 core-screen avoided words (as tests/admin_member_roles_dom_test.py), and UXR-S5-15: nothing on
# this screen may read as a critical-result delivery or acknowledgement state.
AVOIDED = re.compile(r"진단|검출|판정|우선순위|diagnos|detect|priorit|\bAI\b", re.IGNORECASE)
ACKNOWLEDGED = re.compile(r"\bACK\b|acknowledg|\bsent\b|deliver|수신 확인|열어봄|읽음|전달됨", re.IGNORECASE)

REPORT_VIEW = """() => {
  const q = s => document.querySelector(s), state = q('#report-state');
  const pairs = root => Object.fromEntries([...root.querySelectorAll('.field')].map(f =>
    [f.querySelector('dt').textContent, f.querySelector('dd').textContent]));
  return {detailUid: q('#detail').dataset.uid ?? null, reportUid: q('#report').dataset.uid ?? null,
    state: state.dataset.state, text: state.querySelector('.state-text').textContent,
    detail: state.querySelector('.state-detail').textContent, retry: !q('#report-retry').hidden,
    status: q('#report-status').textContent, metaHidden: q('#report-meta').hidden, meta: pairs(q('#report-meta')),
    bodyHidden: q('#report-body').hidden,
    sections: [...q('#report-body').querySelectorAll('.body-section')].map(s =>
      [s.querySelector('h4').textContent, s.querySelector('p').textContent]),
    keysState: q('#keys-state').textContent, keysHidden: q('#key-list').hidden,
    keys: [...q('#key-list').querySelectorAll('li')].map(li => [...li.querySelectorAll('p')].map(p => p.textContent))}; }"""
IDENTITY = """() => Object.fromEntries([...document.querySelectorAll('#identity .field')].map(f =>
  [f.querySelector('dt').textContent, f.querySelector('dd').textContent]))"""
LIST_VIEW = """() => { const box = document.querySelector('#list-state');
  return {state: box.dataset.state, text: box.querySelector('.state-text').textContent,
    detail: box.querySelector('.state-detail').textContent, retry: !document.querySelector('#list-retry').hidden,
    busy: document.querySelector('#studies').closest('table').getAttribute('aria-busy'),
    rows: [...document.querySelectorAll('#studies tr[data-uid]')].map(tr => tr.dataset.uid)}; }"""
# Every text node's own element, and every title / aria-label (tooltips are explanations too).
PAGE_TEXT = """() => { const out = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) { const node = walker.currentNode, parent = node.parentElement, text = node.textContent.trim();
    if (text && parent && !['SCRIPT', 'STYLE'].includes(parent.tagName))
      out.push({text, tag: parent.tagName, size: parseFloat(getComputedStyle(parent).fontSize)}); }
  for (const element of document.querySelectorAll('[title], [aria-label]'))
    for (const name of ['title', 'aria-label']) if (element.hasAttribute(name))
      out.push({text: element.getAttribute(name), tag: element.tagName + '@' + name, size: null});
  out.push({text: document.title, tag: 'TITLE', size: null});
  return out; }"""
LABELS = """() => { const texts = selector => [...document.querySelectorAll(selector)].map(e => e.textContent);
  return {buttons: texts('button'), headings: texts('h1, h2, h3, h4'), th: texts('th'), dt: texts('dt'),
    status: texts('.status'), tags: texts('.tag'), title: document.title}; }"""


def has_hangul(text):
    return any(unicodedata.name(ch, "").startswith("HANGUL") for ch in text)


def variant(edits):
    text = SHIPPED["clinician.js"]
    for old, new in edits:
        found = text.count(old)
        if found != 1:
            raise AssertionError(f"setup: {old!r} occurs {found} times in clinician.js")
        text = text.replace(old, new)
    return text


REPORT_GUARD = "    return mine === reportSeq && selected === uid;\n"
LIST_GUARD = "    return mine === listSeq;\n"
GO_GUARD = "    if (leaving) return;\n    leaving = true;\n    location.replace(url);\n"
LOGOUT_GUARD = "    if (leaving) return;\n    leaving = true;\n    KinAuth.logout();\n"

# auth.js broadcastEnded() as another tab runs it (pinned in test_09): one channel message, then a localStorage set
# and remove, each a storage event in every other tab of this origin.
BROADCAST_ENDED = """() => { const c = new BroadcastChannel('kin-session'); c.postMessage({type: 'session-ended'}); c.close();
  localStorage.setItem('kin-session-ended', String(Date.now())); localStorage.removeItem('kin-session-ended'); }"""
# Installed in the page under test before its navigation is held. While a navigation is held, evaluate and
# wait_for_function on that page do not return until it ends, so each session-ended that reaches the page is
# reported as a request instead. Registered after clinician.js's listeners, and a BroadcastChannel delivers to the
# oldest object first, so a report means the page has already handled that signal. It changes nothing the page does.
WATCH_SIGNALS = """() => { const report = kind => fetch('/harness/signal?kind=' + kind);
  window.synChannel = new BroadcastChannel('kin-session');
  window.synChannel.onmessage = e => { if (e.data && e.data.type === 'session-ended') report('channel'); };
  addEventListener('storage', e => { if (e.key === 'kin-session-ended') report('storage'); }); }"""
# After the last signal, time for a second navigation to reach the harness. The nav-no-guard control in test_09 must
# show its second navigation inside the same window, so the window is long enough.
WINDOW_MS = 500
EXPIRED = (401, {"statusCode": 401, "message": "인증 정보가 없습니다"})


class ClinicianHomeDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.variants = {
            "uid-only": variant([(REPORT_GUARD, "    return selected === uid;\n")]),
            "no-guard": variant([(REPORT_GUARD, "    return true;\n")]),
            "list-no-guard": variant([(LIST_GUARD, "    return true;\n")]),
            "nav-no-guard": variant([(GO_GUARD, "    location.replace(url);\n"), (LOGOUT_GUARD, "    KinAuth.logout();\n")]),
        }
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.me = me(["clinician", *KEYCLOAK_DEFAULTS])
        self.me_queue = []
        self.rows = copy.deepcopy(ROWS)
        self.reports = copy.deepcopy(REPORTS)
        self.files = dict(SHIPPED)
        self.index_stand_in = False
        self.list_errors = []
        self.page_patch = None
        self.held_lists = None
        self.held_reports = None
        self.held_documents = None
        self.documents, self.failed_documents, self.signals = [], [], []
        self.cursors = {}
        self.list_requests, self.report_requests, self.logouts, self.booted = [], [], [], []
        self.me_requests = 0
        self.unexpected, self.errors, self.dialogs, self.finished = [], [], [], []
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 900})
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", self.on_dialog)
        self.page.on("requestfinished", lambda request: self.finished.append(request))
        # Main-frame document requests. A second location.replace cancels the first navigation before it commits, so
        # framenavigated counts one either way; the requests show both.
        self.page.on("request", lambda request: self.documents.append(request.url) if self.is_document(request) else None)
        self.page.on("requestfailed", lambda request: self.failed_documents.append(f"{request.url} {request.failure}")
                     if self.is_document(request) else None)

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.unexpected, "requests the harness does not answer")
        self.assertEqual([], self.dialogs, "browser dialogs")

    def on_dialog(self, dialog):
        self.dialogs.append(f"{dialog.type}: {dialog.message}")
        dialog.dismiss()

    def is_document(self, request):
        return request.is_navigation_request() and request.frame == self.page.main_frame

    # ── synthetic origin ──
    def route(self, route):
        request = route.request
        url = urlparse(request.url)
        method, path = request.method, url.path
        if f"{url.scheme}://{url.netloc}" != ORIGIN:
            self.unexpected.append(f"{method} {request.url}")
            route.abort()
            return
        if method == "GET" and path.startswith(BASE):
            name = path[len(BASE):]
            if name == "index.html" and self.index_stand_in:
                if self.held_documents is not None:
                    self.held_documents.append(route)
                    return
                route.fulfill(body=INDEX_STAND_IN, content_type="text/html; charset=utf-8")
                return
            if name in ("main.html", "blank.html"):
                route.fulfill(body=MAIN_STAND_IN if name == "main.html" else BLANK, content_type="text/html; charset=utf-8")
                return
            if name in self.files:
                kind = "text/html" if name.endswith(".html") else "application/javascript"
                route.fulfill(body=self.files[name], content_type=f"{kind}; charset=utf-8")
                return
            if name == "kin-emblem-j1.svg":
                route.fulfill(body=EMBLEM, content_type="image/svg+xml")
                return
        if path.startswith("/kin-brand/") or path == "/favicon.ico":
            route.fulfill(status=404, body="")
            return
        if method == "GET" and path == "/harness/booted":
            self.booted.append(parse_qs(url.query, keep_blank_values=True))
            route.fulfill(status=204, body="")
            return
        if method == "GET" and path == "/harness/signal":
            self.signals.append(parse_qs(url.query).get("kind", [""])[0])
            route.fulfill(status=204, body="")
            return
        if path.startswith("/api/") and request.headers.get("x-kin-csrf") != "1":
            self.unexpected.append(f"{method} {path} without X-KIN-CSRF")
            route.abort()
            return
        if method == "GET" and path == "/api/me":
            self.me_requests += 1
            answer = self.me_queue.pop(0) if self.me_queue else self.me
            if isinstance(answer, tuple):
                route.fulfill(status=answer[0], json=answer[1])
            else:
                route.fulfill(json=answer)
            return
        if method == "GET" and path == "/api/clinician/studies":
            query = parse_qs(url.query, keep_blank_values=True)
            if set(query) - {"limit", "after"} or query.get("limit") != ["100"] or len(query.get("after", [""])) != 1:
                self.unexpected.append(f"{method} {request.url}")
                route.abort()
                return
            self.list_requests.append(query)
            if self.held_lists is not None:
                self.held_lists.append(route)
                return
            route.fulfill(**self.list_reply(query))
            return
        found = re.fullmatch(r"/api/clinician/studies/([^/]+)/report", path)
        if method == "GET" and found and not url.query:
            target = unquote(found.group(1))
            self.report_requests.append(target)
            if self.held_reports is not None:
                self.held_reports.append((target, route))
                return
            answer = self.reports.get(target, (404, {"statusCode": 404, "message": "검사를 찾을 수 없습니다", "error": "Not Found"}))
            if isinstance(answer, tuple):
                route.fulfill(status=answer[0], json=answer[1])
            else:
                route.fulfill(json=answer)
            return
        if method == "POST" and path == "/api/auth/logout":
            self.logouts.append(request.headers.get("x-kin-csrf"))
            route.fulfill(status=204, body="")
            return
        self.unexpected.append(f"{method} {request.url}")
        route.abort()

    def listing(self, after, rows=None):
        # study-page.ts studyPageSlice: UID order, `next` only when rows remain, total = every visible study.
        ordered = sorted(self.rows if rows is None else rows, key=lambda row: row["uid"])
        start = 0 if after is None else self.cursors[after]
        picked = ordered[start:start + 100]
        following = None
        if start + len(picked) < len(ordered):
            # base64url payload '.' base64url signature, like the server's continuation.
            following = f"eyJ2IjoxLCJTWU4iOnsib2Zmc2V0Ijo{start + len(picked)}.SYN-sig_{len(self.cursors)}-Q"
            self.cursors[following] = start + len(picked)
        reply = {"studies": copy.deepcopy(picked), "serverTime": "2026-09-26T00:00:00.000Z",
                 "pagination": {"next": following, "total": len(ordered), "offset": start, "limit": 100}}
        if self.page_patch:
            self.page_patch(reply)
        return reply

    def list_reply(self, query):
        if self.list_errors:
            status, body = self.list_errors.pop(0)
            return {"status": status, "json": body}
        after = query.get("after", [None])[0]
        if after is not None and after not in self.cursors:
            self.unexpected.append(f"unknown cursor {after!r}")
            return {"status": 409, "json": {"code": "STUDY_LIST_CHANGED", "message": CHANGED}}
        return {"json": self.listing(after)}

    # ── page helpers ──
    def wait_until(self, predicate, what, timeout=10.0):
        # Sync-API route handlers run on this thread while wait_for_timeout blocks.
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail(f"{what}: not observed within {timeout:.0f}s")
            self.page.wait_for_timeout(10)

    def settle(self):
        # After the response body has finished loading, let the page run the tasks that consume it. The controls
        # in test_05 and test_06 paint a late answer after exactly this wait, so it is long enough.
        self.page.evaluate("() => new Promise(resolve => setTimeout(resolve, 150))")

    def release(self, route, payload):
        request = route.request
        route.fulfill(json=payload)
        self.wait_until(lambda: any(item is request for item in self.finished), "the released answer reaching the page")
        self.settle()

    def open_home(self, count=len(ROWS)):
        self.page.goto(ORIGIN + BASE + "clinician.html")
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "ready")
        expect(self.page.locator("#studies tr[data-uid]")).to_have_count(count)

    def row(self, n):
        return self.page.locator(f'#studies tr[data-uid="{uid(n)}"]')

    def cells(self, n):
        return self.row(n).locator("td").all_text_contents()

    def report(self):
        return self.page.evaluate(REPORT_VIEW)

    def identity(self):
        return self.page.evaluate(IDENTITY)

    def listed(self):
        return self.page.evaluate(LIST_VIEW)

    def pick(self, n, state="final"):
        self.row(n).click()
        expect(self.page.locator("#report-state")).to_have_attribute("data-state", state)
        return self.report()

    def active(self):
        return self.page.evaluate("""() => { const e = document.activeElement;
          return {id: e.id || null, row: e.closest('tr[data-uid]')?.dataset.uid ?? null, text: e.textContent}; }""")

    def hold_documents(self):
        # Every navigation to index.html waits here, so a second location.replace lands while the first is in flight
        # and shows up as a second document request instead of racing its commit. Nothing may evaluate in the page
        # until land(): the harness only waits and reads what reached the routes.
        self.held_documents, self.signals = [], []
        return len(self.documents)

    def navigations_after(self, start, channel=1, storage=0):
        self.wait_until(lambda: self.held_documents, "the navigation to index.html")
        self.wait_until(lambda: self.signals.count("channel") >= channel and self.signals.count("storage") >= storage,
                        f"session-ended reaching the page (channel >= {channel}, storage >= {storage})")
        self.page.wait_for_timeout(WINDOW_MS)
        return self.documents[start:]

    def signal_counts(self):
        return {kind: self.signals.count(kind) for kind in ("channel", "storage")}

    def log_out_here(self):
        # auth.js navigates, then its session-ended comes back on this page's channel (a BroadcastChannel skips only
        # the object that sent it).
        self.open_home()
        self.pick(1)
        self.page.evaluate(WATCH_SIGNALS)
        start = self.hold_documents()
        self.page.locator("#logout").click()
        return self.navigations_after(start)

    def two_expired(self):
        # The list answers 401 while a report request is pending, then the report answers 401 too.
        self.open_home()
        self.pick(1)
        self.held_reports = []
        self.row(2).click()
        self.wait_until(lambda: len(self.held_reports) == 1, "the pending report request")
        report = self.held_reports[0][1]
        self.held_reports = None
        self.page.evaluate(WATCH_SIGNALS)
        start, logouts, self.list_errors = self.hold_documents(), len(self.logouts), [EXPIRED]
        self.page.locator("#refresh").click()
        first = self.navigations_after(start)
        report.fulfill(status=EXPIRED[0], json=EXPIRED[1])
        self.wait_until(lambda: any(item is report.request for item in self.finished), "the second 401 reaching the page")
        self.page.wait_for_timeout(WINDOW_MS)
        return first, self.documents[start:], len(self.logouts) - logouts

    def log_out_elsewhere(self):
        # Another tab runs auth.js broadcastEnded(): one channel message and the storage events of a set and a remove.
        self.open_home()
        self.pick(1)
        other = self.context.new_page()
        other.goto(ORIGIN + BASE + "blank.html")
        self.page.evaluate(WATCH_SIGNALS)
        start = self.hold_documents()
        other.evaluate(BROADCAST_ENDED)
        seen = self.navigations_after(start, storage=1)
        other.close()
        return seen, self.signal_counts()

    def land(self):
        held, self.held_documents = self.held_documents, None
        # Only the newest can still be live: each later navigation cancelled the one before it. Answering the older
        # ones only releases the harness's hold, and a request the browser already dropped may refuse the answer.
        for route in held[:-1]:
            try:
                route.abort()
            except PlaywrightError:
                pass
        held[-1].fulfill(body=INDEX_STAND_IN, content_type="text/html; charset=utf-8")
        if len(held) == 1:
            self.page.wait_for_url(ORIGIN + BASE + "index.html")
        else:
            # Controls only: the cancelled navigations may report their abort while this waits.
            self.wait_until(lambda: self.page.url == ORIGIN + BASE + "index.html", "the control landing on index.html")
        expect(self.page.locator("#stand-in")).to_be_visible()

    # ── cases ──
    def test_01_landing_follows_the_guard_rule_and_main_html_hands_clinician_only_over(self):
        # Why the hand-over sits in auth.js: the callback sends every login to main.html, main.html loads auth.js and
        # its boot starts by awaiting KinAuth.init(). api/ and main.html are outside this unit.
        self.assertEqual(2, AUTH_CONTROLLER.count("res.redirect(302, `${origin}/worklist/hpacs-lite/main.html`);"))
        self.assertEqual(1, MAIN_HTML.count('<script src="auth.js"></script>'))
        self.assertIn("    async function boot() {\n      try { await KinAuth.init(); }\n", MAIN_HTML)
        self.assertLess(MAIN_HTML.index('<script src="auth.js"></script>'), MAIN_HTML.index("    async function boot() {"))

        cases = (("clinician only", ["clinician", *KEYCLOAK_DEFAULTS], "clinician.html"),
                 ("clinician + radiologist", ["clinician", "radiologist"], "main.html"),
                 ("technician + clinician", ["technician", "clinician"], "main.html"),
                 ("admin + clinician", ["admin", "clinician"], "main.html"),
                 ("radiologist", ["radiologist", *KEYCLOAK_DEFAULTS], "main.html"),
                 ("technician", ["technician"], "main.html"),
                 ("admin", ["admin"], "main.html"))
        for label, roles, target in cases:
            with self.subTest(entry="index.html", session=label):
                self.me, self.booted = me(roles), []
                self.page.goto(ORIGIN + BASE + "index.html")
                self.page.wait_for_url(ORIGIN + BASE + target)
                if target == "main.html":
                    self.wait_until(lambda: self.booted, "main.html boot past init()")
                    self.assertEqual([{"roles": [",".join(roles)]}], self.booted)
                else:
                    expect(self.page.locator("#list-state")).to_have_attribute("data-state", "ready")
        with self.subTest(entry="index.html", session="pending"):
            self.me, self.booted = (403, {"code": "INSTITUTION_PENDING"}), []
            self.page.goto(ORIGIN + BASE + "index.html")
            self.page.wait_for_url(ORIGIN + BASE + "main.html")
            self.wait_until(lambda: self.booted, "main.html boot past init() for a pending session")
            self.assertEqual([{"roles": [""]}], self.booted)

        # The callback's landing page: clinician-only leaves before main.html's boot continues.
        self.me, self.booted = me(["clinician", *KEYCLOAK_DEFAULTS]), []
        lists = len(self.list_requests)
        self.page.goto(ORIGIN + BASE + "main.html")
        self.page.wait_for_url(ORIGIN + BASE + "clinician.html")
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "ready")
        self.assertEqual([], self.booted, "main.html boot must not run past init() for clinician-only")
        self.assertEqual(lists + 1, len(self.list_requests))
        self.me = me(["clinician", "radiologist"])
        self.page.goto(ORIGIN + BASE + "main.html")
        self.wait_until(lambda: self.booted, "main.html boot for a mixed session")
        self.assertEqual([{"roles": ["clinician,radiologist"]}], self.booted)
        self.assertEqual(ORIGIN + BASE + "main.html", self.page.url)

    def test_02_identifiers_final_report_and_key_images_come_from_the_dto_only(self):
        self.open_home()
        listed = self.listed()
        self.assertEqual(("ready", "검사 7건을 표시합니다.", "false", ORDER),
                         (listed["state"], listed["text"], listed["busy"], listed["rows"]))
        self.assertEqual(["View", "SYN ALPHA", "SYN-P-001", "M / 45Y", "1980-05-17", "2026-03-20", "CT", "SYN DESC 1",
                          "SYN Hospital A", "Final"], self.cells(1))
        self.assertEqual(["View", "홍길동 SYN", "SYN-P-002", "F / 36Y", "1990-01-02", "2026-03-21", "CT", "SYN DESC 2",
                          "SYN Hospital A", "Final · Addendum"], self.cells(2))
        self.assertEqual("O / 26Y", self.cells(3)[3])
        self.assertEqual(["— / —", "—", "2026-01-01", "Unknown"], [self.cells(4)[i] for i in (3, 4, 5, 9)])
        self.assertEqual(["M / —", "1970-01-01", "—", "Awaiting Report"], [self.cells(5)[i] for i in (3, 4, 5, 9)])
        self.assertEqual([HOSTILE, "SYN Hospital A Tele", "On Hold"], [self.cells(6)[i] for i in (1, 8, 9)])
        self.assertEqual("In Progress", self.cells(7)[9])

        seen = self.pick(1)
        self.assertEqual({"Name": "SYN ALPHA", "Patient ID": "SYN-P-001", "Sex / Age at Study": "M / 45Y",
                          "Birth Date": "1980-05-17", "Study Date": "2026-03-20", "Institution": "SYN Hospital A",
                          "Accession": "SYN-ACC-1", "Modality": "CT", "Description": "SYN DESC 1",
                          "Series / Images": "3 / 120"}, self.identity())
        self.assertEqual({"detailUid": uid(1), "reportUid": uid(1), "state": "final", "text": "승인된 확정 판독문입니다.",
                          "detail": "", "retry": False, "status": "Final", "metaHidden": False,
                          "meta": {"Version": "3", "Type": "Approved", "Signed By": "syn-rad", "Signed On": "2026-09-20"},
                          "bodyHidden": False,
                          "sections": [["Findings", "SYN-A findings line 1\nline 2"], ["Conclusion", "SYN-A conclusion"],
                                       ["Recommendation", "기재된 내용이 없습니다."]],
                          "keysState": "키 이미지 2건", "keysHidden": False,
                          "keys": [["SYN key one", "SYN key one note", f"Series {PREFIX}.91 · Instance {PREFIX}.91.1 · Frame 12"],
                                   [HOSTILE, f"Series {PREFIX}.92 · Instance {PREFIX}.92.1 · Frame 1"]]}, seen)
        # Identifiers, then the final report, then key images, then the (inactive) viewer slot.
        self.assertEqual(["identity", "report", "keys", "viewer-slot"], self.page.evaluate(
            "() => [...document.querySelectorAll('#identity, #report, #keys, #viewer-slot')].map(e => e.id)"))
        self.assertEqual("Sex / Age at Study", self.page.locator("#identity dt").nth(2).text_content())
        self.assertTrue(has_hangul(self.page.locator("#identity dt").nth(2).get_attribute("title")))
        expect(self.page.locator("#open-viewer")).to_be_disabled()
        self.assertTrue(has_hangul(self.page.locator("#viewer-note").text_content()))
        self.assertEqual(("true", "Viewing"), (self.row(1).get_attribute("aria-current"), self.row(1).locator("button").text_content()))
        self.assertEqual((None, "View"), (self.row(2).get_attribute("aria-current"), self.row(2).locator("button").text_content()))

        seen = self.pick(2)
        self.assertEqual(("Final · Addendum", "Addendum이 반영된 확정 판독문입니다.", {"Version": "5", "Type": "Addendum",
                          "Signed By": "syn-rad", "Signed On": "2026-09-20"}, KEYS_NONE, True, []),
                         (seen["status"], seen["text"], seen["meta"], seen["keysState"], seen["keysHidden"], seen["keys"]))
        self.assertEqual("홍길동 SYN", self.identity()["Name"])
        self.assertEqual("F / 36Y", self.identity()["Sex / Age at Study"])
        self.pick(6, "status")
        self.assertEqual((HOSTILE, "SYN Hospital A · Tele"), (self.identity()["Name"], self.identity()["Institution"]))

        self.assertIsNone(self.page.evaluate("() => document.body.dataset.pwned ?? null"))
        self.assertNotIn("SYN-LEAK", self.page.content())
        self.assertEqual([uid(1), uid(2), uid(6)], self.report_requests)

    def test_03_non_final_answers_show_status_only_and_failures_are_shown_as_sent(self):
        self.open_home()
        notes = {3: ("Preliminary", "예비 판독 단계입니다."), 4: ("Unknown", "판독 상태를 확인할 수 없습니다."),
                 5: ("Awaiting Report", "아직 판독되지 않은 검사입니다."), 6: ("On Hold", "판독이 보류된 검사입니다."),
                 7: ("In Progress", "판독이 진행 중입니다.")}
        for n, (status, note) in notes.items():
            with self.subTest(study=n, status=status):
                seen = self.pick(n, "status")
                self.assertEqual({"detailUid": uid(n), "reportUid": uid(n), "state": "status", "text": f"{note} {FINAL_ONLY}",
                                  "detail": "", "retry": False, "status": status, "metaHidden": True, "meta": {},
                                  "bodyHidden": True, "sections": [], "keysState": KEYS_WITHHELD, "keysHidden": True,
                                  "keys": []}, seen)
        self.assertNotIn("SYN-LEAK", self.page.content())

        failures = (
            ("final without body or keys", {"uid": uid(7), "report": {"final": True, "rs": "A", "action": "approve", "version": 2}, "keys": None},
             "판독 응답 형식을 확인할 수 없습니다."),
            ("final with an unknown action", final_report(7, 2, "save", "SYN-X", "", "", []), "판독 응답 형식을 확인할 수 없습니다."),
            ("another study's answer", REPORTS[uid(1)], "응답의 검사가 요청한 검사와 다릅니다."),
            ("404", (404, {"statusCode": 404, "message": "검사를 찾을 수 없습니다", "error": "Not Found"}),
             "검사를 찾을 수 없습니다 (HTTP 404)"),
            ("403 with a code only", (403, {"code": "CLINICIAN_ROUTE_DENIED"}),
             "서버가 요청을 거절했습니다. (HTTP 403 · CLINICIAN_ROUTE_DENIED)"),
        )
        for label, answer, detail in failures:
            with self.subTest(failure=label):
                self.reports[uid(7)] = answer
                seen = self.pick(7, "failed")
                self.assertEqual((uid(7), None, REPORT_FAILED, detail, True, "", True, True, KEYS_FAILED),
                                 (seen["detailUid"], seen["reportUid"], seen["text"], seen["detail"], seen["retry"],
                                  seen["status"], seen["metaHidden"], seen["bodyHidden"], seen["keysState"]))
                self.assertEqual("SYN ETA", self.identity()["Name"])
        # Retry reads again and paints the answer the server gives now.
        self.reports[uid(7)] = final_report(7, 4, "approve", "SYN-T findings", "SYN-T conclusion", "SYN-T recommendation", [])
        self.page.locator("#report-retry").click()
        expect(self.page.locator("#report-state")).to_have_attribute("data-state", "final")
        self.assertEqual(("Final", "4", ["Findings", "SYN-T findings"]),
                         (self.report()["status"], self.report()["meta"]["Version"], self.report()["sections"][0]))

    def test_04_a_b_a_late_answers_never_paint_over_the_current_study(self):
        self.open_home()
        self.held_reports = []
        for n in (1, 2, 1):
            self.row(n).click()
        self.wait_until(lambda: len(self.held_reports) == 3, "three report requests A, B, A")
        (_, first_a), (_, b), (_, second_a) = self.held_reports
        self.assertEqual([uid(1), uid(2), uid(1)], [target for target, _ in self.held_reports])
        self.assertEqual((uid(1), None, "loading"), tuple(self.report()[k] for k in ("detailUid", "reportUid", "state")))

        self.release(b, self.reports[uid(2)])
        self.release(first_a, final_report(1, 3, "approve", "SYN-A-FIRST-ANSWER", "", "", []))
        seen = self.report()
        self.assertEqual((uid(1), None, "loading", [], KEYS_LOADING),
                         (seen["detailUid"], seen["reportUid"], seen["state"], seen["sections"], seen["keysState"]))
        self.assertEqual("SYN ALPHA", self.identity()["Name"])
        self.release(second_a, final_report(1, 4, "addendum", "SYN-A-SECOND-ANSWER", "", "", []))
        expect(self.page.locator("#report-state")).to_have_attribute("data-state", "final")
        seen = self.report()
        self.assertEqual((uid(1), uid(1), "4", ["Findings", "SYN-A-SECOND-ANSWER"]),
                         (seen["detailUid"], seen["reportUid"], seen["meta"]["Version"], seen["sections"][0]))
        self.assertNotIn("SYN-A-FIRST-ANSWER", self.page.content())

        # A then B; A answers last.
        self.held_reports = []
        self.row(1).click()
        self.row(2).click()
        self.wait_until(lambda: len(self.held_reports) == 2, "report requests A, B")
        (_, late_a), (_, current_b) = self.held_reports
        self.release(current_b, self.reports[uid(2)])
        expect(self.page.locator("#report-state")).to_have_attribute("data-state", "final")
        self.release(late_a, final_report(1, 5, "addendum", "SYN-A-LATE-ANSWER", "", "", []))
        seen = self.report()
        self.assertEqual((uid(2), uid(2), "final", ["Findings", "SYN-B findings"], "홍길동 SYN"),
                         (seen["detailUid"], seen["reportUid"], seen["state"], seen["sections"][0], self.identity()["Name"]))
        self.assertNotIn("SYN-A-LATE-ANSWER", self.page.content())
        self.assertEqual(("true", None), (self.row(2).get_attribute("aria-current"), self.row(1).get_attribute("aria-current")))

    def test_05_controls_a_uid_only_or_absent_guard_paints_the_late_answer(self):
        # The expected outputs are the defect, asserted exactly: a harness that never delivers a late answer fails here.
        self.files["clinician.js"] = self.variants["uid-only"]
        self.open_home()
        self.held_reports = []
        for n in (1, 2, 1):
            self.row(n).click()
        self.wait_until(lambda: len(self.held_reports) == 3, "three report requests A, B, A")
        (_, first_a), (_, b), (_, second_a) = self.held_reports
        self.release(b, self.reports[uid(2)])
        self.release(first_a, final_report(1, 3, "approve", "SYN-A-FIRST-ANSWER", "", "", []))
        seen = self.report()
        self.assertEqual(("final", ["Findings", "SYN-A-FIRST-ANSWER"]), (seen["state"], seen["sections"][0]),
                         "uid-only: A's first answer paints while A's second request is pending")
        second_a.fulfill(json=final_report(1, 4, "addendum", "SYN-A-SECOND-ANSWER", "", "", []))

        self.files["clinician.js"] = self.variants["no-guard"]
        self.open_home()
        self.held_reports = []
        self.row(1).click()
        self.row(2).click()
        self.wait_until(lambda: len(self.held_reports) == 2, "report requests A, B")
        (_, late_a), (_, current_b) = self.held_reports
        self.release(current_b, self.reports[uid(2)])
        self.release(late_a, final_report(1, 5, "addendum", "SYN-A-LATE-ANSWER", "", "", []))
        seen = self.report()
        self.assertEqual((uid(2), uid(1), ["Findings", "SYN-A-LATE-ANSWER"], "홍길동 SYN"),
                         (seen["detailUid"], seen["reportUid"], seen["sections"][0], self.identity()["Name"]),
                         "no-guard: A's late report paints under B's identifiers")

    def test_06_list_states_are_distinct_and_refusals_are_shown_as_sent(self):
        self.held_lists = []
        self.page.goto(ORIGIN + BASE + "clinician.html")
        self.wait_until(lambda: len(self.held_lists) == 1, "the first list request")
        loading = self.listed()
        self.assertEqual(("loading", LIST_LOADING, "", False, "true", []),
                         tuple(loading[k] for k in ("state", "text", "detail", "retry", "busy", "rows")))
        held, self.held_lists = self.held_lists, None
        held[0].fulfill(json=self.listing(None, rows=[]))
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "empty")
        empty = self.listed()
        self.assertEqual(("empty", LIST_EMPTY, "", False, "false", []),
                         tuple(empty[k] for k in ("state", "text", "detail", "retry", "busy", "rows")))

        self.list_errors = [(409, {"code": "STUDY_LIST_CHANGED", "message": CHANGED})]
        self.page.locator("#refresh").click()
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "failed")
        failed = self.listed()
        self.assertEqual(("failed", LIST_FAILED, f"{CHANGED} (HTTP 409 · STUDY_LIST_CHANGED)", True, []),
                         tuple(failed[k] for k in ("state", "text", "detail", "retry", "rows")))
        self.assertEqual(3, len({loading["text"], empty["text"], failed["text"]}))
        self.assertEqual(3, len({loading["state"], empty["state"], failed["state"]}))
        self.page.locator("#list-retry").click()
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "ready")
        self.assertEqual(ORDER, self.listed()["rows"])

        # A radiologist-only session on this page: the page asks, the server refuses, the refusal is the state. No
        # control is hidden in its place.
        refusals = ((["radiologist"], (403, {"statusCode": 403, "message": "임상의 조회은(는) clinician 권한이 필요합니다", "error": "Forbidden"}),
                     "임상의 조회은(는) clinician 권한이 필요합니다 (HTTP 403)"),
                    (["clinician"], (403, {"code": "CLINICIAN_ROUTE_DENIED"}),
                     "서버가 요청을 거절했습니다. (HTTP 403 · CLINICIAN_ROUTE_DENIED)"))
        for roles, error, detail in refusals:
            with self.subTest(roles=roles, status=error[0]):
                self.me, self.list_errors = me(roles), [error]
                requests = len(self.list_requests)
                self.page.goto(ORIGIN + BASE + "clinician.html")
                expect(self.page.locator("#list-state")).to_have_attribute("data-state", "failed")
                self.assertEqual((LIST_FAILED, detail, []), tuple(self.listed()[k] for k in ("text", "detail", "rows")))
                self.assertEqual(requests + 1, len(self.list_requests))
                expect(self.page.locator("#refresh")).to_be_enabled()
                expect(self.page.locator("#logout")).to_be_visible()

        # A late earlier list never replaces a newer one.
        self.me = me(["clinician"])
        self.held_lists = []
        self.page.goto(ORIGIN + BASE + "clinician.html")
        self.wait_until(lambda: len(self.held_lists) == 1, "the first list request")
        self.page.locator("#refresh").click()
        self.wait_until(lambda: len(self.held_lists) == 2, "the refreshed list request")
        first, second = self.held_lists
        self.held_lists = None
        before = self.me_requests
        self.release(second, self.listing(None))
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "ready")
        self.release(first, self.listing(None, rows=[self.rows[0]]))
        self.assertEqual(("ready", "검사 7건을 표시합니다.", ORDER), tuple(self.listed()[k] for k in ("state", "text", "rows")))
        self.assertEqual(before + 1, self.me_requests, "the late list goes no further")

        # Control: without the list guard the late one-row answer replaces the list.
        self.files["clinician.js"] = self.variants["list-no-guard"]
        self.held_lists = []
        self.page.goto(ORIGIN + BASE + "clinician.html")
        self.wait_until(lambda: len(self.held_lists) == 1, "the first list request")
        self.page.locator("#refresh").click()
        self.wait_until(lambda: len(self.held_lists) == 2, "the refreshed list request")
        first, second = self.held_lists
        self.held_lists = None
        self.release(second, self.listing(None))
        expect(self.page.locator("#studies tr[data-uid]")).to_have_count(7)
        self.release(first, self.listing(None, rows=[self.rows[0]]))
        expect(self.page.locator("#studies tr[data-uid]")).to_have_count(1)
        self.assertEqual("검사 1건을 표시합니다.", self.listed()["text"], "list-no-guard: the late list replaces the newer one")

    def test_07_paging_passes_each_signed_cursor_verbatim_and_rechecks_the_account(self):
        filler = [study(100 + i, f"SYN FILLER {i:03d}", f"SYN-F-{i:03d}", "F", "19600101", "20240101",
                        {"final": False, "rs": "W"}) for i in range(198)]
        self.rows.extend(filler)
        self.held_lists = []
        self.page.goto(ORIGIN + BASE + "clinician.html")
        for page in range(3):
            self.wait_until(lambda: len(self.held_lists) == page + 1, f"list page {page + 1}")
            if page:
                self.assertEqual((f"{LIST_LOADING} ({page * 100} / 205)", []),
                                 (self.listed()["text"], self.listed()["rows"]))
            query = self.list_requests[page]
            self.held_lists[page].fulfill(json=self.listing(query.get("after", [None])[0]))
        self.held_lists = None
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "ready")
        cursors = list(self.cursors)
        self.assertEqual([{"limit": ["100"]}, {"limit": ["100"], "after": [cursors[0]]},
                          {"limit": ["100"], "after": [cursors[1]]}], self.list_requests)
        listed = self.listed()
        self.assertEqual(("검사 205건을 표시합니다.", 205), (listed["text"], len(listed["rows"])))
        # Study date, newest first, across pages; the study without a date is last.
        self.assertEqual((ORDER[:6], uid(5)), (listed["rows"][:6], listed["rows"][-1]))
        self.assertEqual(2, self.me_requests, "init, then the account re-check after the last page")

        # A malformed page (limit other than asked) is a failure, not a shorter list.
        self.page_patch = lambda reply: reply["pagination"].update(limit=50)
        self.page.locator("#refresh").click()
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "failed")
        self.assertEqual(("목록 페이지 형식을 확인할 수 없습니다. 새로고침하세요.", []),
                         (self.listed()["detail"], self.listed()["rows"]))
        self.page_patch = None
        self.page.locator("#list-retry").click()
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "ready")

        # Another account took over this browser while the list was read: the page clears and leaves.
        self.pick(1)
        self.index_stand_in = True
        self.me_queue = [me(["clinician"], sub="SYN-OTHER-SUB", user="syn-other", name="SYN Other")]
        self.page.locator("#refresh").click()
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        expect(self.page.locator("#stand-in")).to_have_text("SYN index stand-in")

    def test_08_wording_dialogs_fonts_hit_targets_and_keyboard(self):
        for name in ("clinician.js", "clinician.html"):
            for needle in ("alert(", "confirm(", "prompt(", "<dialog", "showModal", "innerHTML", "insertAdjacentHTML",
                           "outerHTML", "document.write", "contextmenu"):
                with self.subTest(source=name, needle=needle):
                    self.assertNotIn(needle, SHIPPED[name])
        # RISK-S5-U2a-HIDE-AS-PERMISSION: nothing on this page reads the role list; the server answers decide.
        self.assertNotIn("KinAuth.has(", SHIPPED["clinician.js"])
        self.assertNotIn(".roles", SHIPPED["clinician.js"])

        self.open_home()
        # Keyboard from the top: header, Refresh, then the list's single tab stop.
        self.page.keyboard.press("Tab")
        self.assertEqual("logout", self.active()["id"])
        self.page.keyboard.press("Tab")
        self.assertEqual("refresh", self.active()["id"])
        self.page.keyboard.press("Tab")
        self.assertEqual((uid(3), "View"), (self.active()["row"], self.active()["text"]))
        self.assertEqual(1, self.page.evaluate("() => [...document.querySelectorAll('#studies button')].filter(b => b.tabIndex === 0).length"))
        for pressed, expected in (("ArrowDown", uid(2)), ("End", uid(5)), ("Home", uid(3)), ("ArrowDown", uid(2)),
                                  ("ArrowDown", uid(1)), ("ArrowUp", uid(2)), ("ArrowDown", uid(1))):
            self.page.keyboard.press(pressed)
            self.assertEqual(expected, self.active()["row"], pressed)
        self.assertEqual([], self.report_requests, "moving between rows does not open a study")
        self.page.keyboard.press("Enter")
        expect(self.page.locator("#report-state")).to_have_attribute("data-state", "final")
        self.assertEqual(("true", "Viewing"), (self.row(1).get_attribute("aria-current"), self.row(1).locator("button").text_content()))
        self.page.keyboard.press("ArrowUp")
        self.page.keyboard.press(" ")
        expect(self.row(2)).to_have_attribute("aria-current", "true")
        expect(self.page.locator("#report-status")).to_have_text("Final · Addendum")
        self.assertEqual([uid(1), uid(2)], self.report_requests)
        self.assertEqual(1, self.page.evaluate("() => [...document.querySelectorAll('#studies button')].filter(b => b.tabIndex === 0).length"))

        states = []
        states.append(self.page.evaluate(PAGE_TEXT))
        labels = self.page.evaluate(LABELS)
        self.pick(3, "status")
        states.append(self.page.evaluate(PAGE_TEXT))
        self.reports[uid(7)] = (404, {"statusCode": 404, "message": "검사를 찾을 수 없습니다", "error": "Not Found"})
        self.pick(7, "failed")
        states.append(self.page.evaluate(PAGE_TEXT))
        failed_labels = self.page.evaluate(LABELS)

        self.assertEqual("Clinician Home — KIN", labels["title"])
        # DOM order: header, list Retry (hidden), rows in ORDER (B selected), report Retry (hidden), viewer slot,
        # membership card (hidden).
        self.assertEqual(["Log out", "Refresh", "Retry", "View", "Viewing", "View", "View", "View", "View", "View", "Retry",
                          "Open Viewer", "Log out"], labels["buttons"])
        self.assertEqual(["Clinician Home", "Studies", "Study", "Report", "Findings", "Conclusion", "Recommendation",
                          "Key Images", ""], labels["headings"])
        self.assertEqual(["Action", "Name", "Patient ID", "Sex / Age", "Birth Date", "Study Date", "Modality", "Description",
                          "Institution", "Report"], labels["th"])
        self.assertEqual(["Name", "Patient ID", "Sex / Age at Study", "Birth Date", "Study Date", "Institution", "Accession",
                          "Modality", "Description", "Series / Images", "Version", "Type", "Signed By", "Signed On"],
                         labels["dt"])
        self.assertEqual({"Preliminary", "Final · Addendum", "Final", "On Hold", "In Progress", "Unknown", "Awaiting Report"},
                         set(labels["status"]))
        self.assertEqual(["Tele"], labels["tags"])
        for group in (labels, failed_labels):
            for kind in ("buttons", "headings", "th", "dt", "status", "tags"):
                for text in group[kind]:
                    self.assertFalse(has_hangul(text), f"{kind}: {text}")
        # Explanations stay Korean.
        for selector in (".hint", "#list-state .state-text", "#viewer-note", "#report-state .state-text", "#keys-state"):
            self.assertTrue(has_hangul(self.page.locator(selector).text_content()), selector)

        for texts in states:
            for item in texts:
                with self.subTest(text=item["text"][:60], tag=item["tag"]):
                    self.assertIsNone(AVOIDED.search(item["text"]))
                    self.assertIsNone(ACKNOWLEDGED.search(item["text"]))
                    if item["size"] is not None:
                        self.assertGreaterEqual(item["size"], 12)
        targets = self.page.evaluate("""() => [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null)
          .map(b => { const r = b.getBoundingClientRect(); return [b.textContent, r.width, r.height]; })""")
        self.assertGreaterEqual(len(targets), 10)
        for text, width, height in targets:
            self.assertGreaterEqual(min(width, height), 24, text)

    def test_09_log_out_session_end_membership_and_no_session(self):
        self.assertIn("      channel.postMessage({ type: 'session-ended' });\n", SHIPPED["auth.js"])
        self.assertIn("      localStorage.setItem('kin-session-ended', String(Date.now()));\n"
                      "      localStorage.removeItem('kin-session-ended');\n", SHIPPED["auth.js"])
        index = ORIGIN + BASE + "index.html"
        self.index_stand_in = True

        # Log out: the page's own session-ended clears it and does not navigate again.
        self.assertEqual([index], self.log_out_here(), "Log out: one navigation")
        self.assertEqual(["1"], self.logouts)
        self.land()

        # Two 401s: one POST /auth/logout, one navigation.
        first, after, logouts = self.two_expired()
        self.assertEqual(([index], [index], 1), (first, after, logouts), "two 401s: one log out, one navigation")
        self.land()

        # Log out in another tab of this browser: every signal calls leave(); the page navigates once.
        seen, counts = self.log_out_elsewhere()
        self.assertEqual(1, counts["channel"])
        self.assertGreaterEqual(counts["storage"], 1)
        self.assertEqual([index], seen, f"another tab's log out ({counts}): one navigation")
        self.land()

        for code, title, text in (("INSTITUTION_PENDING", "Pending Approval",
                                   "가입 신청이 접수되었습니다. 관리자가 기관과 역할을 확인한 뒤 사용할 수 있습니다."),
                                  ("INSTITUTION_INVALID", "Account Setup Required",
                                   "기관 또는 업무 역할 설정이 올바르지 않습니다. 관리자에게 문의해 주세요.")):
            with self.subTest(membership=code):
                self.me = (403, {"code": code})
                lists = len(self.list_requests)
                self.page.goto(ORIGIN + BASE + "clinician.html")
                expect(self.page.locator("#membership")).to_be_visible()
                self.assertEqual((title, text), (self.page.locator("#membership-title").text_content(),
                                                 self.page.locator("#membership-text").text_content()))
                expect(self.page.locator("#home")).to_be_hidden()
                expect(self.page.locator("#membership-logout")).to_have_text("Log out")
                self.assertEqual(lists, len(self.list_requests))

        self.me = (401, {"statusCode": 401, "message": "인증 정보가 없습니다"})
        start = len(self.documents)
        self.page.goto(ORIGIN + BASE + "clinician.html")
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        expect(self.page.locator("#stand-in")).to_be_visible()
        self.assertEqual([ORIGIN + BASE + "clinician.html", index], self.documents[start:], "no session: one navigation")
        self.assertEqual([], self.failed_documents, "no navigation was cancelled")

        # Control: the same steps on the same file without the guard, inside the same window. The page's own
        # session-ended navigates again, the second 401 logs out again, and the signals from another tab navigate
        # more than once, so the single counts above are not a harness that misses them. Only these are asserted:
        # what the second log out's navigation and echo add to the held requests is not pinned.
        self.files["clinician.js"] = self.variants["nav-no-guard"]
        self.me = me(["clinician", *KEYCLOAK_DEFAULTS])
        self.assertEqual([index, index], self.log_out_here(), "nav-no-guard: Log out navigates twice")
        self.land()

        first, _, logouts = self.two_expired()
        self.assertEqual(([index, index], 2), (first, logouts), "nav-no-guard: the second 401 logs out again")
        self.land()

        seen, counts = self.log_out_elsewhere()
        self.assertEqual([index] * len(seen), seen)
        self.assertGreaterEqual(len(seen), 2, f"nav-no-guard: another tab's signals ({counts}) navigate again")
        self.land()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
