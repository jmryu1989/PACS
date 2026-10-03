# coding: utf-8
"""REQ-S7-U5-AUTH-AUDIT -> RISK-S7-U5-SESSION-END-UNCONFIRMED -> TEST-S7-U5-LOGOUT-DOM.

The browser half of the S7-U5 logout (diagnosis scenario §0.C, Astra S7-U5-SPEC-R-001 F03 as amended by
S7-U5-SPEC-B-R-001 F01/F02). The pages are the shipped files, served byte for byte from the repository: index.html,
main.html, admin.html and clinician.html and every local file they reference (SERVED_FILES below, the CI-17 step records
exactly these). An in-test server answers the API from synthetic data (SYN-* names) and can hold or fail any answer: the
logout POST, the draft write, /api/me and the work reads. No stack, network or credential is used.

  BR-01  a logout intent closes the screen before the network: main (Log out and a request's 401), admin and clinician
         each show nothing of the session (identity, list, report text) while POST /api/auth/logout is held; auth.js
         gives no identity; overlapping Log out presses and 401s share that one POST; a work answer held from before
         paints nothing; then one move to the landing.
  BR-02  409 and the fixed 500 leave the landing on its own notice (different for each, no server wording) with Retry
         Log Out; /api/me would still answer 200, yet no work page is entered, no login starts and no second POST is
         sent; a work page opened directly (main, admin, clinician) goes back to the notice without a work request.
  BR-03  the unconfirmed end survives reload, back and a later tab; a second work tab of the same browser closes and moves
         once on the end notice (BroadcastChannel and storage, and storage alone) and sends no POST; a landing that
         cannot read its storage enters nothing and offers the manual login.
  BR-04  Retry Log Out sends one POST per press (overlapping presses share it) and a 204 confirms the end: the landing
         stays (reload, a new tab, a work page opened directly) until the login control is pressed.
  BR-05  how the answer is read: 204 and the 401s that name the request's own session as absent or ended (no row, a
         committed idle end, a committed refresh end) confirm; the general 401 of a request without session credentials
         (Astra S7-U5-SPEC-C-F03: the server looked up no session), a token or configuration 401, 403, 409, the fixed 500,
         another 500, a dropped connection and no answer within 10 s (headers held, or the body held) leave it unconfirmed
         with their own notice; nothing is sent again by itself.
  BR-06  late answers: an /api/me answered after the end (before its headers, and while its body was read) restores
         no identity and starts no work read; an explicit login in another tab is not undone by the earlier logout's
         late result.
  BR-07  without an end intent the landing behaves as before: first entry logs in, a session lands by role (radiologist
         main.html, clinician-only clinician.html, pending main.html), and demo leaves with no server request.
  DP-01..DP-07 (Astra S7-U5-SPEC-B-F02, scenario §0.C 8): main.html's Log out with an unsaved report first saves the
         draft through the existing draft write. While it is out nothing ends (no logout, no end state, no notice, the
         identity stays); once it is stored the end follows: hold release, then the logout POST. A failed, refused,
         dropped or timed-out write logs nothing out and keeps the text (Retry, Back to Editing, an explicit discard);
         a session end during the preparation (a 401, another tab's end, an account change) closes the screen at once
         and keeps the text only in this window's memory, with no move until Recover Draft (same account only) or an
         explicit discard. With nothing to write the end follows at once; a confirmation (Save) in flight refuses Log out.
  DP-08..DP-12 (Astra S7-U5-SPEC-C-F01/F02): while the preparation is out the page sends nothing but its draft write - the
         autosave, the poll, the hold refresh and the panels' periodic reads pass their periods unsent; answers to reads
         sent before it (the list, the report's citation read, a panel) change neither what is saved nor the screen; a
         write whose result is unknown keeps Back to Editing and every new save away until it answers; Back to Editing
         asks the server for the session and reopens only for the same account with the reading role (another account or
         no session closes the screen, the text kept in memory). Every draft write carries the account the page was
         opened for ([institution, subject, author]); the synthetic server refuses another session's write as the API
         does (409 REPORT_DRAFT_OWNER_CHANGED), which closes the page and keeps the text, during the preparation and
         between Recover Draft's session check and its write alike.
  BR-08  this file's own inputs: every local request is in SERVED_FILES (anything else fails the case) and the run
         prints the files it actually served on one line, `S7-U5-LOGOUT-DOM-SERVED <json>`, which
         ci_rec_check --mode candidate compares with SERVED_FILES, the pages' references and the CI-17 step.

Mutants (MU-27..MU-34 and the F02 counterexamples) are one-off copies run outside this file; nothing here edits a
product file.
"""
import json
import re
import sys
import time
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parents[1]

# The four pages and every local file they reference (script src, link href, img src; /kin-brand/ is proxy/branding/),
# in document order. CI-17 records exactly these with this file.
SERVED_FILES = (
    "worklist-v0/hpacs-lite/index.html",
    "proxy/branding/kin-emblem-j1.svg",
    "proxy/branding/kin-favicon-32.png",
    "worklist-v0/hpacs-lite/kin-emblem-j1.svg",
    "worklist-v0/hpacs-lite/auth.js",
    "worklist-v0/hpacs-lite/main.html",
    "worklist-v0/hpacs-lite/saved-filter-manager.css",
    "worklist-v0/hpacs-lite/consultations.css",
    "worklist-v0/hpacs-lite/worklist-columns.css",
    "worklist-v0/hpacs-lite/reading-workspace.css",
    "worklist-v0/hpacs-lite/reading-panel-layout.js",
    "worklist-v0/hpacs-lite/viewer-opening.js",
    "worklist-v0/hpacs-lite/worklist-startup.js",
    "worklist-v0/hpacs-lite/related-parts.js",
    "worklist-v0/hpacs-lite/worklist-body-parts.js",
    "worklist-v0/hpacs-lite/study-priority.js",
    "worklist-v0/hpacs-lite/worklist-alerts.js",
    "worklist-v0/hpacs-lite/study-access-status.js",
    "worklist-v0/hpacs-lite/worklist-selection.js",
    "worklist-v0/hpacs-lite/worklist-image-preview.js",
    "worklist-v0/hpacs-lite/worklist-image-thumbnails.js",
    "worklist-v0/hpacs-lite/worklist-search.js",
    "worklist-v0/hpacs-lite/worklist-row-navigation.js",
    "worklist-v0/hpacs-lite/viewer-display-layout.js",
    "worklist-v0/hpacs-lite/worklist-refresh.js",
    "worklist-v0/hpacs-lite/study-arrivals.js",
    "worklist-v0/hpacs-lite/order-reconciliation.js",
    "worklist-v0/hpacs-lite/study-identity.js",
    "worklist-v0/hpacs-lite/clinical-context.js",
    "worklist-v0/hpacs-lite/viewer-windows.js",
    "worklist-v0/hpacs-lite/workspace-layout.js",
    "worklist-v0/hpacs-lite/viewer-identity.js",
    "worklist-v0/hpacs-lite/volume-preferences.js",
    "worklist-v0/hpacs-lite/reading-appearance.js",
    "worklist-v0/hpacs-lite/reading-appearance-account.js",
    "worklist-v0/hpacs-lite/workspace-roaming.js",
    "worklist-v0/hpacs-lite/report-preview.js",
    "worklist-v0/hpacs-lite/viewer-workspace-dock.js",
    "worklist-v0/hpacs-lite/workspace-shortcuts.js",
    "worklist-v0/hpacs-lite/reading-workspace.js",
    "worklist-v0/hpacs-lite/finding-link-model.js",
    "worklist-v0/hpacs-lite/finding-command.js",
    "worklist-v0/hpacs-lite/report-citation.js",
    "worklist-v0/hpacs-lite/report-structure.js",
    "worklist-v0/hpacs-lite/dictation-session.js",
    "worklist-v0/hpacs-lite/dictation-capture.js",
    "worklist-v0/hpacs-lite/dictation.js",
    "worklist-v0/hpacs-lite/reading-findings.js",
    "worklist-v0/hpacs-lite/tech-note.css",
    "worklist-v0/hpacs-lite/tech-note.js",
    "worklist-v0/hpacs-lite/reading-preferences.js",
    "worklist-v0/hpacs-lite/compound-filter.js",
    "worklist-v0/hpacs-lite/worklist-columns.js",
    "worklist-v0/hpacs-lite/study-pages.js",
    "worklist-v0/hpacs-lite/shared-filter-manager.js",
    "worklist-v0/hpacs-lite/saved-filter-manager.js",
    "worklist-v0/hpacs-lite/favorites.css",
    "worklist-v0/hpacs-lite/favorite-list.js",
    "worklist-v0/hpacs-lite/favorites.js",
    "worklist-v0/hpacs-lite/study-tags.css",
    "worklist-v0/hpacs-lite/study-tags.js",
    "worklist-v0/hpacs-lite/reader-assignment.css",
    "worklist-v0/hpacs-lite/reader-assignment.js",
    "worklist-v0/hpacs-lite/consultations.js",
    "worklist-v0/hpacs-lite/critical-result-send.js",
    "worklist-v0/hpacs-lite/critical-result-inbox.js",
    "worklist-v0/hpacs-lite/admin.html",
    "worklist-v0/hpacs-lite/study-access-admin.js",
    "worklist-v0/hpacs-lite/clinician.html",
    "worklist-v0/hpacs-lite/clinician.js",
)
SERVED = set()

ORIGIN = "https://syn.test"
BASE = "/worklist/hpacs-lite/"
INDEX_URL = ORIGIN + BASE + "index.html"
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".svg": "image/svg+xml", ".png": "image/png"}
END_KEY = "kin-session-end"
INSTITUTION = "SYN-INST-A"
RAD = {"sub": "SYN-RAD-SUB", "actor": "syn-rad@synthetic.test", "user": "syn-rad@synthetic.test",
       "displayName": "SYN Reader Kim", "roles": ["radiologist"], "institution": INSTITUTION, "kind": "member"}
RAD_OTHER = {**RAD, "sub": "SYN-RAD2-SUB", "actor": "syn-rad2@synthetic.test", "user": "syn-rad2@synthetic.test",
             "displayName": "SYN Reader Lee"}
ADMIN = {**RAD, "sub": "SYN-ADMIN-SUB", "actor": "syn-admin@synthetic.test", "user": "syn-admin@synthetic.test",
         "displayName": "SYN Admin Park", "roles": ["admin"]}
CLINICIAN = {**RAD, "sub": "SYN-CLIN-SUB", "actor": "syn-clin@synthetic.test", "user": "syn-clin@synthetic.test",
             "displayName": "SYN Clinician Choi", "roles": ["clinician", "default-roles-kin"]}
UID = "1.2.826.0.1.3680043.10.7707.1"
PATIENT = "SYN PATIENT ALPHA"
FIELDS = {"findings": "SYN-FINDINGS typed before Log out", "conclusion": "SYN-CONCLUSION", "recommendation": "SYN-REC"}

# The landing's notices, as the shipped index.html words them (compared, never parsed).
CONFIRMED = "이 브라우저의 KIN 로그인 세션을 끝냈습니다. 다시 사용하려면 로그인해 주세요."
UNKNOWN = "로그아웃 상태를 확인할 수 없어 자동으로 로그인하지 않습니다. 로그인 버튼을 눌러 주세요."
# 401 bodies that name the request's own session as absent or ended (auth.service.ts) - the only 401s that confirm - and
# the general 401 of a request that carried no session at all (auth.guard.ts), which proves nothing about any session.
ENDED = ["인증 세션이 없습니다", "인증 세션이 만료되었습니다", "인증 세션을 갱신할 수 없습니다"]
NO_CREDENTIALS = "인증 정보가 없습니다"

# Writes to either storage, recorded before any page script runs (the recorder is this harness's).
STORAGE_RECORDER = """(() => {
  const writes = [];
  Object.defineProperty(window, '__synWrites', { value: writes });
  for (const name of ['setItem', 'removeItem']) {
    const original = Storage.prototype[name];
    Storage.prototype[name] = function (...args) {
      let area = 'other';
      try { area = this === window.localStorage ? 'local' : 'session'; } catch (_) {}
      writes.push([area, name, String(args[0])]);
      return original.apply(this, args);
    };
  }
})();"""
# A landing whose storage cannot be read (blocked site data): reading localStorage throws.
NO_STORAGE = """Object.defineProperty(window, 'localStorage', { configurable: true,
  get() { throw new DOMException('SYN storage blocked', 'SecurityError'); } });"""
# The logout answer's body held after its headers (BR-05): the page gets a Response whose body never comes; aborting the
# request (as the browser does for an aborted fetch) errors that body. Any other request passes through.
HOLD_LOGOUT_BODY = """(() => {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await real(input, init);
    if (!String(input).endsWith('/api/auth/logout')) return response;
    const body = new ReadableStream({ start(controller) {
      if (init && init.signal) init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
    } });
    return new Response(body, { status: response.status, headers: response.headers });
  };
})();"""
# What the screen shows of a session: rendered text (hidden parts excluded), the editor's values and the identity.
SCREEN = """() => ({ text: document.body.innerText, values: [...document.querySelectorAll('textarea, input')].map(e => e.value),
  identity: typeof KinAuth === 'undefined' ? 'no auth.js' : KinAuth.session(),
  end: (() => { try { return localStorage.getItem('kin-session-end'); } catch (e) { return 'unreadable'; } })() })"""


def has_hangul(text):
    return any("가" <= ch <= "힣" for ch in text)


def study_row():
    """One /api/studies row in the server's shape, editable by a radiologist."""
    return {"uid": UID, "techNote": {"version": 0, "present": False}, "readerAssignment": {"revision": 0, "reader": None},
            "gatewayReceipt": None, "orderIdentity": None, "count": 10, "series": 1, "acc": "SYNACC0001", "id": "SYN-P-001",
            "sourcePatientKey": INSTITUTION + "|SYN-P-001", "name": PATIENT, "birth": "19800101", "date": "20261003",
            "sex": "M", "modality": "CT", "desc": "SYN CT CHEST", "institutionName": "SYN Hospital A", "tele": False,
            "state": {"rs": "W", "ss": "Verified", "em": "N", "ts": "none", "matched": "U", "ward": "",
                      "reqHosp": "SYN Hospital A", "institutionId": INSTITUTION, "teleInstitutionId": None, "preDoc": None,
                      "preReviewer": None, "prelimHidden": False, "repDoc": None, "confirm": None, "ov": None, "orig": None,
                      "oid": None, "holder": None, "holdReason": None, "version": 0, "findings": "", "conclusion": "",
                      "recommendation": "", "draft": None}}


class Site:
    """The synthetic origin: the shipped files from disk and an API that answers, holds or fails on the case's word."""

    def __init__(self):
        self.account = RAD              # what /api/me answers: an account, "pending", or None (no session: 401)
        self.login_as = RAD             # the account an explicit login (GET /api/auth/login) leaves the browser with
        self.logins = 0
        self.logout_answers = []        # each: (status, body) | "hold" | "abort"; none queued answers 204
        self.held_logouts, self.logouts = [], []
        self.put_answers = []           # draft writes: (status, body) | "hold" | "abort"; none queued answers 200
        self.held_puts, self.puts = [], []
        self.drafts = {}                # the draft rows the synthetic server stored, by author (the API's (uid, author) key)
        self.held_gets = {}             # path -> held routes, for reads a case answers late
        self.swap_after_me = None       # the account the browser has right after the next /api/me answer (a session swap)
        self.held_me, self.held_lists = None, None
        self.releases, self.holds, self.held_commits = [], [], []
        self.calls, self.violations = [], []

    def handle(self, route, request):
        url = urlparse(request.url)
        method, path = request.method, url.path
        if f"{url.scheme}://{url.netloc}" != ORIGIN:
            self.violations.append(f"other origin: {method} {request.url}")
            return route.abort()
        if path.startswith(BASE) or path.startswith("/kin-brand/"):
            return self.static(route, path)
        if path == "/favicon.ico":
            return route.fulfill(status=404, body="")
        if method == "GET" and path == "/auth/realms/kin/.well-known/openid-configuration":
            return route.fulfill(json={"issuer": ORIGIN + "/auth/realms/kin"})
        if method == "GET" and path == "/api/auth/login":
            # The OIDC round trip stands in as one page: the browser now has the login_as session and the callback's
            # landing (main.html, which hands a clinician-only session over to clinician.html).
            self.logins += 1
            self.account = self.login_as
            return route.fulfill(body='<!doctype html><title>SYN login</title><script>location.replace("'
                                      + BASE + 'main.html")</script>', content_type="text/html; charset=utf-8")
        if path.startswith("/api/"):
            # Every write (the logout POST and the draft write among them) carries the CSRF header.
            if method != "GET" and request.headers.get("x-kin-csrf") != "1":
                self.violations.append(f"{method} {path} without X-KIN-CSRF")
                return route.abort()
            self.calls.append((method, path))
            return self.api(route, request, method, path, url.query)
        if method == "GET" and (path == "/statistics" or path.startswith("/dicom-web/") or path.startswith("/instances/")):
            return route.fulfill(status=404, json={"code": "SYN_NOT_STUBBED"})
        self.violations.append(f"unexpected: {method} {path}")
        return route.abort()

    def static(self, route, path):
        rel = ("proxy/branding/" + path[len("/kin-brand/"):] if path.startswith("/kin-brand/")
               else "worklist-v0/hpacs-lite/" + path[len(BASE):])
        if rel not in SERVED_FILES:
            self.violations.append("local file outside SERVED_FILES: " + rel)
            return route.fulfill(status=404, body="")
        SERVED.add(rel)
        return route.fulfill(status=200, content_type=TYPES[Path(rel).suffix], body=(ROOT / rel).read_bytes())

    def me(self):
        if self.account is None:
            return 401, {"statusCode": 401, "message": "인증 정보가 없습니다"}
        if self.account == "pending":
            return 403, {"code": "INSTITUTION_PENDING", "message": "SYN pending"}
        return 200, self.account

    def answer(self, route, status, body):
        try:
            route.fulfill(status=status, json=body)
        except PlaywrightError:
            pass  # the page has gone: nothing receives the answer

    def api(self, route, request, method, path, query):
        account = self.account if isinstance(self.account, dict) else RAD
        if method == "GET" and path == "/api/me":
            if self.held_me is not None:
                return self.held_me.append(route)
            self.answer(route, *self.me())
            if self.swap_after_me is not None:
                self.account, self.swap_after_me = self.swap_after_me, None
            return None
        if method == "GET" and path in self.held_gets:
            return self.held_gets[path].append(route)
        if method == "POST" and path == "/api/auth/logout":
            self.logouts.append(request.frame.page.url)
            reply = self.logout_answers.pop(0) if self.logout_answers else (204, None)
            if reply == "hold":
                return self.held_logouts.append(route)
            if reply == "abort":
                return route.abort("connectionreset")
            status, body = reply
            if body is None:
                return route.fulfill(status=status, body="")
            return route.fulfill(status=status, json=body)
        if method == "GET" and path == "/api/bootstrap":
            return route.fulfill(json={"statesOmitted": True, "me": {"actor": account["actor"], "roles": account["roles"],
                                       "institution": INSTITUTION, "institutionName": "SYN Hospital A"},
                                       "filters": [], "templates": [], "institutions": [{"id": INSTITUTION,
                                       "name": "SYN Hospital A", "type": "hospital"}], "states": {}, "orders": [],
                                       "serverTime": "2026-10-03T00:00:00.000Z"})
        if method == "GET" and path == "/api/studies" and parse_qs(query).get("limit") == ["100"]:
            if self.held_lists is not None:
                return self.held_lists.append(route)
            return route.fulfill(json=self.list_body())
        if method == "GET" and path == "/api/colleagues":
            return route.fulfill(json=[])
        if method == "GET" and path == "/api/prefs":
            return route.fulfill(json={"filters": [], "templates": []})
        if method == "GET" and path == "/api/worklist-columns":
            return route.fulfill(json={"owner": [INSTITUTION, account["sub"]], "revision": 0, "columns": None,
                                       "updatedAt": None})
        if method == "GET" and path == "/api/admin/users" and query == "page=1":
            return route.fulfill(json={"page": 1, "pageSize": 25, "total": 1, "pendingCount": 0, "users": [
                {"id": "SYN-U-1", "username": "syn-member", "email": "syn-member@synthetic.test", "emailVerified": True,
                 "name": "SYN Member Jung", "institution": INSTITUTION, "roles": ["technician"], "enabled": True,
                 "approvalState": "APPROVED"}]})
        if method == "GET" and path == "/api/clinician/studies":
            return route.fulfill(json={"studies": [{"uid": UID, "id": "SYN-P-001", "name": PATIENT, "birth": "19800101",
                                                    "sex": "M", "date": "20261003", "acc": "SYNACC0001",
                                                    "desc": "SYN CT CHEST", "modality": "CT", "count": 10, "series": 1,
                                                    "sourcePatientKey": INSTITUTION + "|SYN-P-001",
                                                    "institutionName": "SYN Hospital A", "tele": False,
                                                    "report": {"final": False, "rs": "W"}}],
                                       "serverTime": "2026-10-03T00:00:00.000Z",
                                       "pagination": {"next": None, "total": 1, "offset": 0, "limit": 100}})
        if method == "GET" and path == "/api/syn/expired":
            return route.fulfill(status=401, json={"statusCode": 401, "message": "인증 세션이 만료되었습니다"})
        if method == "POST" and path == f"/api/studies/{UID}/report/commit":
            # A confirmation (Save) of the report: held while a case needs it out, then refused.
            return self.held_commits.append(route)
        found = re.fullmatch(r"/api/studies/([^/]+)/(hold|release|report)", path)
        if found and found.group(1) == UID:
            if method == "POST" and found.group(2) == "hold":
                self.holds.append(path)
                return route.fulfill(json={"holder": account["user"], "conflict": False})
            if method == "POST" and found.group(2) == "release":
                self.releases.append(path)
                return route.fulfill(json={"ok": True})
            if method == "PUT" and found.group(2) == "report":
                body = request.post_data_json
                self.puts.append(body)
                # The API's rule (pacs.service.ts putReport): a write bound to an account must come from that account's
                # session, or it is refused before anything is read or written.
                owner = body.get("expectedOwner", None)
                if owner is not None and owner != [INSTITUTION, account["sub"], account["actor"]]:
                    return route.fulfill(status=409, json={"code": "REPORT_DRAFT_OWNER_CHANGED", "message": "SYN other account"})
                reply = self.put_answers.pop(0) if self.put_answers else (200, {"ok": True})
                if reply == "hold":
                    return self.held_puts.append(route)
                if reply == "abort":
                    return route.abort("connectionreset")
                if reply[0] == 200:
                    self.drafts[account["actor"]] = {k: body.get(k) for k in FIELDS}
                return route.fulfill(status=reply[0], json=reply[1])
        if method == "GET":
            return route.fulfill(status=404, json={"code": "SYN_NOT_STUBBED", "message": "synthetic server: not stubbed"})
        self.violations.append(f"undeclared write: {method} {path}")
        return route.fulfill(status=405, json={"code": "SYN_NO_WRITE"})

    @staticmethod
    def list_body():
        return {"studies": [study_row()], "serverTime": "2026-10-03T00:00:00.000Z", "observedAt": "2026-10-03T00:00:00.000Z",
                "notObserved": [], "pagination": {"owner": [INSTITUTION, RAD["sub"]], "limit": 100, "offset": 0, "total": 1,
                                                  "next": None}}

    def count(self, method, path):
        return sum(1 for call in self.calls if call == (method, path))


class LogoutDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = Site()
        self.errors, self.dialogs, self.documents = [], [], []
        self.dialog_answers = []
        self.context = None
        self.fresh_context()

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.site.violations, "requests the harness does not answer, or local files outside the table")
        self.assertEqual([], self.errors, "page errors")

    def fresh_context(self):
        """A browser context of its own: the end state lives in the origin's storage until the next explicit login."""
        if self.context is not None:
            self.context.close()
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR",
                                                timezone_id="Asia/Seoul")
        self.context.add_init_script(STORAGE_RECORDER)
        self.context.route("**/*", self.site.handle)
        self.page = self.watch(self.context.new_page())

    def watch(self, page):
        page.set_default_timeout(10000)
        page.on("pageerror", lambda error: self.errors.append(f"{page.url}: {error}"))
        page.on("dialog", self.on_dialog)
        page.on("request", lambda request: self.documents.append((page, urlparse(request.url).path))
                if request.is_navigation_request() and request.frame == page.main_frame else None)
        return page

    def on_dialog(self, dialog):
        self.dialogs.append(dialog.message)
        if dialog.type == "confirm" and (not self.dialog_answers or self.dialog_answers.pop(0)):
            dialog.accept()
        else:
            dialog.dismiss()

    def wait_until(self, predicate, what, timeout=10.0, page=None):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail(f"{what}: not observed within {timeout:.0f}s")
            (page or self.page).wait_for_timeout(20)

    def docs(self, page=None, name=None):
        found = [path for owner, path in self.documents if owner is (page or self.page)]
        return found if name is None else [path for path in found if path.endswith(name)]

    # ── pages ──
    def open_main(self, page=None):
        page = page or self.page
        page.goto(ORIGIN + BASE + "main.html")
        expect(page.locator("#rows")).to_contain_text(PATIENT)
        expect(page.locator("#user")).to_have_text(RAD["displayName"])
        return page

    def open_admin(self):
        self.site.account = ADMIN
        self.page.goto(ORIGIN + BASE + "admin.html")
        expect(self.page.locator("#users td.username")).to_have_count(1)

    def open_clinician(self):
        self.site.account = CLINICIAN
        self.page.goto(ORIGIN + BASE + "clinician.html")
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "ready")

    def select_and_type(self, page=None):
        page = page or self.page
        page.locator("#rows tr", has_text=PATIENT).first.click()
        expect(page.locator("#findings")).to_be_editable()
        for name, value in FIELDS.items():
            page.fill("#" + name, value)
        self.wait_until(lambda: self.site.holds, "the hold the typing starts", page=page)

    def log_out_main(self, page=None):
        (page or self.page).evaluate("() => document.querySelector('#logout').click()")

    def panel_button(self, name, page=None):
        """A control of main.html's logout panel (the page has other buttons of the same name under it)."""
        return (page or self.page).locator("dialog.kin-logout").get_by_role("button", name=name, exact=True)

    def screen(self, page=None):
        return (page or self.page).evaluate(SCREEN)

    def end_state(self, page=None):
        raw = self.screen(page)["end"]
        return json.loads(raw) if raw not in (None, "unreadable") else raw

    def writes(self, page=None):
        return (page or self.page).evaluate("() => window.__synWrites.slice()")

    def assert_closed(self, what, page=None):
        seen = self.screen(page)
        self.assertNotIn("SYN", seen["text"], f"{what}: something of the session is still on screen")
        self.assertEqual([], [value for value in seen["values"] if "SYN" in value], f"{what}: a field keeps session text")
        self.assertIsNone(seen["identity"], f"{what}: auth.js still gives the identity")

    def landing(self, page=None):
        page = page or self.page
        page.wait_for_url(INDEX_URL)
        expect(page.locator("#signin")).to_be_enabled()
        return page.locator("#msg").inner_text(), page.locator("#retry-logout").is_visible()

    def release_logout(self, status=204, body=None):
        route = self.site.held_logouts.pop(0)
        if body is None:
            route.fulfill(status=status, body="")
        else:
            route.fulfill(status=status, json=body)

    # ── BR-01 ──
    def test_br01_main_log_out_closes_before_the_post_and_shares_it(self):
        self.open_main()
        # A list read held from before the end, and the logout POST held.
        self.site.held_lists = []
        self.page.get_by_role("group", name="Refresh").get_by_role("button", name="Refresh", exact=True).click()
        self.wait_until(lambda: self.site.held_lists, "the held list read")
        held_list = self.site.held_lists.pop()
        self.site.held_lists = None
        self.site.logout_answers = ["hold"]
        self.log_out_main()
        self.wait_until(lambda: self.site.held_logouts, "POST /api/auth/logout")
        self.assert_closed("main, Log out, POST held")
        self.assertEqual("ending", self.end_state()["state"])
        # Overlapping presses and a 401 of the page share the intent: no second POST.
        self.log_out_main()
        self.page.evaluate("() => { api('GET', '/syn/expired').catch(() => {}); }")
        self.wait_until(lambda: self.site.count("GET", "/api/syn/expired") == 1, "the 401")
        held_list.fulfill(json=Site.list_body())
        self.page.wait_for_timeout(300)
        self.assert_closed("main, after a late list answer and a 401")
        self.assertEqual(1, len(self.site.logouts))
        self.assertEqual([], self.docs(name="index.html"), "no move before the POST answers")
        self.release_logout(204)
        message, retry = self.landing()
        self.assertEqual((CONFIRMED, False), (message, retry))
        self.assertEqual((1, 1, 0), (len(self.site.logouts), len(self.docs(name="index.html")), self.site.logins))

    def test_br01_main_401_closes_before_the_post(self):
        self.open_main()
        self.site.logout_answers = ["hold"]
        self.page.evaluate("() => { api('GET', '/syn/expired').catch(() => {}); }")
        self.wait_until(lambda: self.site.held_logouts, "POST /api/auth/logout")
        self.assert_closed("main, a request's 401, POST held")
        self.page.evaluate("() => { api('GET', '/syn/expired').catch(() => {}); }")
        self.page.wait_for_timeout(200)
        self.assertEqual(1, len(self.site.logouts), "a second 401 shares the intent")
        # The server expired the cookie with the request's 401, so the logout POST carries no session and gets the general
        # 401: no session was looked up, so the end is not confirmed (F03) - the landing offers Retry Log Out, enters nothing.
        self.release_logout(401, {"statusCode": 401, "message": NO_CREDENTIALS})
        message, retry = self.landing()
        self.assertTrue(retry and message != CONFIRMED, message)
        self.assertEqual(("unconfirmed", "credentials"), (self.end_state()["state"], self.end_state()["reason"]))
        self.page.wait_for_timeout(300)
        self.assertEqual((0, 1, []), (self.site.logins, len(self.site.logouts), self.docs(name="main.html")[1:]))

    def test_br01_admin_and_clinician_close_before_the_post(self):
        for page_name in ("admin", "clinician"):
            with self.subTest(page=page_name):
                self.fresh_context()
                self.site.logouts, self.site.held_logouts = [], []
                (self.open_admin if page_name == "admin" else self.open_clinician)()
                self.site.logout_answers = ["hold"]
                self.page.evaluate("() => document.querySelector('#logout').click()")
                self.wait_until(lambda: self.site.held_logouts, "POST /api/auth/logout")
                self.assert_closed(f"{page_name}, Log out, POST held")
                self.page.evaluate("() => document.querySelector('#logout')?.click()")
                self.page.wait_for_timeout(200)
                self.assertEqual(1, len(self.site.logouts))
                self.release_logout(204)
                self.assertEqual((CONFIRMED, False), self.landing())
                self.assertEqual(1, len(self.docs(name="index.html")), "one move")

    # ── BR-02 ──
    def test_br02_409_and_500_stay_on_the_landing_with_retry(self):
        notices = {}
        for label, status, body in (("409", 409, {"statusCode": 409, "message": "SYN-SERVER-WORDING conflict"}),
                                    ("500", 500, {"code": "AUTH_STORAGE_FAILURE", "message": "SYN-SERVER-WORDING storage"})):
            with self.subTest(answer=label):
                self.fresh_context()
                self.site.account, self.site.logouts = RAD, []
                self.open_main()
                self.site.logout_answers = [(status, body)]
                self.log_out_main()
                message, retry = self.landing()
                notices[label] = message
                self.assertTrue(retry, "Retry Log Out is offered")
                self.assertTrue(has_hangul(message) and "SYN-SERVER-WORDING" not in message, message)
                self.assertEqual(("unconfirmed", "conflict" if status == 409 else "storage"),
                                 (self.end_state()["state"], self.end_state()["reason"]))
                # The server session remains (/api/me would answer 200), yet nothing enters it.
                self.page.wait_for_timeout(500)
                self.assertEqual(([], [], 0, 1), (self.docs(name="main.html")[1:], self.docs(name="clinician.html"),
                                                  self.site.logins, len(self.site.logouts)))
                # A work page opened directly goes back to the notice without a work request.
                for direct in ("main.html", "admin.html", "clinician.html"):
                    calls = len(self.site.calls)
                    self.page.goto(ORIGIN + BASE + direct)
                    again, _ = self.landing()
                    self.assertEqual(message, again, direct)
                    self.assertEqual([], [c for c in self.site.calls[calls:] if c[1] != "/api/auth/logout"],
                                     f"{direct}: no API request while the end is unconfirmed")
                self.assertEqual(1, len(self.site.logouts), "no POST is sent again by itself")
        self.assertNotEqual(notices["409"], notices["500"], "409 and the fixed 500 say different things")

    # ── BR-03 ──
    def test_br03_the_unconfirmed_end_persists_and_a_second_tab_moves_once(self):
        self.open_main()
        second = self.open_main(self.watch(self.context.new_page()))
        self.site.logout_answers = ["hold"]
        self.log_out_main()
        self.wait_until(lambda: self.site.held_logouts, "POST /api/auth/logout")
        # The second tab closes and moves while the POST is held, once, and sends no POST of its own.
        second.wait_for_url(INDEX_URL)
        second.wait_for_timeout(500)
        self.assertEqual((1, 1), (len(self.site.logouts), len(self.docs(second, "index.html"))))
        self.release_logout(409, {"statusCode": 409, "message": "SYN conflict"})
        message, retry = self.landing()
        self.assertTrue(retry)
        # The landing of the second tab follows the result written by the first.
        expect(second.locator("#msg")).to_have_text(message)
        # Reload, back and a later tab keep the notice; nothing is entered and nothing is sent again.
        self.page.reload()
        self.assertEqual((message, True), self.landing())
        self.page.goto(ORIGIN + BASE + "main.html")
        self.assertEqual((message, True), self.landing())
        self.page.go_back()
        self.assertEqual((message, True), self.landing())
        later = self.watch(self.context.new_page())
        later.goto(INDEX_URL)
        self.assertEqual((message, True), self.landing(later))
        self.assertEqual((1, 0), (len(self.site.logouts), self.site.logins))

    def test_br03_a_second_tab_without_broadcastchannel_moves_once_on_storage(self):
        self.open_main()
        second = self.watch(self.context.new_page())
        second.add_init_script("delete window.BroadcastChannel;")
        self.open_main(second)
        self.assertEqual("undefined", second.evaluate("() => typeof BroadcastChannel"))
        self.site.logout_answers = ["hold"]
        self.log_out_main()
        self.wait_until(lambda: self.site.held_logouts, "POST /api/auth/logout")
        second.wait_for_url(INDEX_URL)
        second.wait_for_timeout(500)
        self.assertEqual((1, 1), (len(self.site.logouts), len(self.docs(second, "index.html"))))
        self.release_logout(204)
        self.landing()

    def test_br03_a_landing_that_cannot_read_its_storage_enters_nothing(self):
        self.page.add_init_script(NO_STORAGE)
        self.page.goto(INDEX_URL)
        expect(self.page.locator("#signin")).to_be_enabled()
        self.page.wait_for_timeout(500)
        self.assertEqual((UNKNOWN, False), (self.page.locator("#msg").inner_text(), self.page.locator("#retry-logout").is_visible()))
        self.assertEqual((0, [], []), (self.site.logins, self.docs(name="main.html"), self.docs(name="clinician.html")))
        self.assertEqual(0, self.site.count("GET", "/api/me"), "the session is not even read")

    # ── BR-04 ──
    def test_br04_retry_confirms_and_the_landing_stays_until_login(self):
        self.open_main()
        self.site.logout_answers = [(500, {"code": "AUTH_STORAGE_FAILURE", "message": "SYN storage"})]
        self.log_out_main()
        self.assertTrue(self.landing()[1])
        self.site.logout_answers = ["hold"]
        self.page.locator("#retry-logout").click()
        self.wait_until(lambda: self.site.held_logouts, "the retry POST")
        self.page.evaluate("() => { document.querySelector('#retry-logout').click(); KinAuth.retryLogout(); }")
        self.page.wait_for_timeout(200)
        self.assertEqual(2, len(self.site.logouts), "one POST per press; overlapping presses share it")
        self.release_logout(204)
        expect(self.page.locator("#msg")).to_have_text(CONFIRMED)
        expect(self.page.locator("#retry-logout")).to_be_hidden()
        self.assertEqual("confirmed", self.end_state()["state"])
        for step in ("reload", "new tab", "main.html", "admin.html", "clinician.html"):
            with self.subTest(step=step):
                if step == "reload":
                    self.page.reload()
                    page = self.page
                elif step == "new tab":
                    page = self.watch(self.context.new_page())
                    page.goto(INDEX_URL)
                else:
                    page = self.page
                    page.goto(ORIGIN + BASE + step)
                self.assertEqual((CONFIRMED, False), self.landing(page))
                page.wait_for_timeout(300)
                self.assertEqual(0, self.site.logins, "no login starts by itself")
        self.assertEqual(2, len(self.site.logouts))
        # Only the login control leaves the landing; it forgets the end state and the role landing follows.
        self.page.get_by_role("button", name="KIN 계정으로 로그인").click()
        expect(self.page.locator("#rows")).to_contain_text(PATIENT)
        self.assertEqual((1, None), (self.site.logins, self.screen()["end"]))

    # ── BR-05 ──
    def classify(self, answer, init=None, wait_ms=0):
        self.fresh_context()
        if init:
            self.page.add_init_script(init)
        self.site.logouts, self.site.held_logouts = [], []
        self.open_admin()
        if wait_ms:
            self.page.clock.install()
        self.site.logout_answers = [answer]
        self.page.evaluate("() => document.querySelector('#logout').click()")
        self.wait_until(lambda: self.site.logouts, "POST /api/auth/logout")
        if wait_ms:
            self.page.clock.run_for(wait_ms)
        self.page.wait_for_url(INDEX_URL)
        return self.end_state(), self.page.locator("#msg").inner_text()

    def test_br05_how_the_answer_is_read(self):
        cases = [("204", (204, None), None, 0, ("confirmed", None))]
        cases += [(f"401 {m}", (401, {"statusCode": 401, "message": m}), None, 0, ("confirmed", None)) for m in ENDED]
        cases += [("401 no credentials", (401, {"statusCode": 401, "message": NO_CREDENTIALS}), None, 0,
                   ("unconfirmed", "credentials")),
                  ("401 token", (401, {"statusCode": 401, "message": "토큰 검증 실패: SYN"}), None, 0, ("unconfirmed", "refused")),
                  ("401 config", (401, {"statusCode": 401, "message": "서버에 KC_JWKS_URL이 설정되지 않았습니다"}), None, 0,
                   ("unconfirmed", "refused")),
                  ("403", (403, {"statusCode": 403, "message": "SYN CSRF"}), None, 0, ("unconfirmed", "refused")),
                  ("409", (409, {"statusCode": 409, "message": "SYN"}), None, 0, ("unconfirmed", "conflict")),
                  ("500 storage", (500, {"code": "AUTH_STORAGE_FAILURE"}), None, 0, ("unconfirmed", "storage")),
                  ("500 other", (500, {"statusCode": 500, "message": "SYN"}), None, 0, ("unconfirmed", "refused")),
                  ("connection dropped", "abort", None, 0, ("unconfirmed", "network")),
                  ("no headers in 10 s", "hold", None, 10500, ("unconfirmed", "timeout")),
                  ("no body in 10 s", (409, {"statusCode": 409, "message": "SYN"}), HOLD_LOGOUT_BODY, 10500,
                   ("unconfirmed", "timeout"))]
        messages = {}
        for label, answer, init, wait_ms, expected in cases:
            with self.subTest(answer=label):
                end, message = self.classify(answer, init, wait_ms)
                self.assertEqual(expected, (end["state"], end.get("reason")))
                self.assertEqual(1, len(self.site.logouts), "nothing is sent again by itself")
                if expected[0] == "confirmed":
                    self.assertEqual(CONFIRMED, message)
                else:
                    self.assertTrue(has_hangul(message) and "SYN" not in message and message != CONFIRMED, message)
                    expect(self.page.locator("#retry-logout")).to_be_visible()
                messages.setdefault(expected[1], set()).add(message)
        self.assertEqual(6, len({next(iter(m)) for reason, m in messages.items() if reason}),
                         "each failure kind has its own notice")

    # ── BR-06 ──
    def test_br06_a_late_session_answer_restores_nothing(self):
        for when in ("before its headers", "while its body is read"):
            with self.subTest(late=when):
                self.fresh_context()
                self.site.logouts, self.site.held_logouts = [], []
                self.site.held_me = []
                if when == "while its body is read":
                    self.page.add_init_script("""(() => { const json = Response.prototype.json; window.__heldMe = [];
                      Response.prototype.json = function () { const read = json.call(this);
                        if (!this.url.endsWith('/api/me')) return read;
                        return new Promise((resolve, reject) => { window.__heldMe.push(() => read.then(resolve, reject)); }); };
                    })();""")
                self.page.goto(ORIGIN + BASE + "main.html")
                self.wait_until(lambda: self.site.held_me, "the session read")
                me = self.site.held_me.pop()
                self.site.held_me = None
                if when == "while its body is read":
                    me.fulfill(json=RAD)
                    self.wait_until(lambda: self.page.evaluate("() => window.__heldMe.length") == 1, "the session body held")
                self.site.logout_answers = ["hold"]
                self.log_out_main()
                self.wait_until(lambda: self.site.held_logouts, "POST /api/auth/logout")
                calls = len(self.site.calls)
                if when == "before its headers":
                    me.fulfill(json=RAD)
                else:
                    self.page.evaluate("() => window.__heldMe.splice(0).forEach(release => release())")
                self.page.wait_for_timeout(500)
                self.assert_closed(f"the late /api/me ({when})")
                self.assertEqual([], [c for c in self.site.calls[calls:] if c[1] != "/api/auth/logout"],
                                 "no work read after the late session answer")
                self.release_logout(204)
                self.assertEqual((CONFIRMED, False), self.landing())
                self.assertEqual(1, len(self.docs(name="index.html")), "one move")

    def test_br06_an_explicit_login_elsewhere_is_not_undone_by_a_late_result(self):
        self.open_main()
        self.site.logout_answers = ["hold"]
        self.log_out_main()
        self.wait_until(lambda: self.site.held_logouts, "POST /api/auth/logout")
        other = self.watch(self.context.new_page())
        other.goto(INDEX_URL)
        expect(other.locator("#retry-logout")).to_be_visible()
        other.get_by_role("button", name="KIN 계정으로 로그인").click()
        self.open_main_after_login(other)
        self.assertIsNone(self.screen(other)["end"], "the explicit login forgot the end state")
        self.release_logout(204)
        # This tab then goes to the landing (which, with no end state left, enters by itself again).
        self.wait_until(lambda: self.docs(name="index.html"), "the move after the late logout result")
        other.wait_for_timeout(500)
        # The earlier logout's result wrote nothing over the new login, and the other tab stays in use.
        self.assertIsNone(self.screen(other)["end"])
        expect(other.locator("#rows")).to_contain_text(PATIENT)
        self.assertEqual([], self.docs(other, "index.html")[1:])

    def open_main_after_login(self, page):
        page.wait_for_url(ORIGIN + BASE + "main.html")
        expect(page.locator("#rows")).to_contain_text(PATIENT)

    # ── BR-07 ──
    def test_br07_without_an_end_intent_the_landing_is_as_before(self):
        with self.subTest(entry="first entry logs in"):
            self.site.account = None
            self.page.goto(INDEX_URL)
            self.open_main_after_login(self.page)
            self.assertEqual(1, self.site.logins)
        for account, landing in ((RAD, "main.html"), (CLINICIAN, "clinician.html"), ("pending", "main.html")):
            with self.subTest(session=landing if account != "pending" else "pending"):
                self.fresh_context()
                self.site.account = account
                self.page.goto(INDEX_URL)
                self.page.wait_for_url(ORIGIN + BASE + landing)
                if account == "pending":
                    expect(self.page.get_by_text("관리자 승인 대기")).to_be_visible()
                self.assertIsNone(self.screen()["end"])
        with self.subTest(entry="demo"):
            self.fresh_context()
            logouts, logins = len(self.site.logouts), self.site.logins
            self.site.account = None
            self.page.goto(INDEX_URL + "?auth_error=stale")
            self.page.get_by_role("button", name="데모 모드로 둘러보기 (서버 없이)").click()
            self.page.wait_for_url(ORIGIN + BASE + "main.html")
            expect(self.page.locator("#user")).to_have_text("demo")
            # The landing after the demo reads the session as before; that read is held so the landing stays to be read.
            self.site.held_me = []
            self.log_out_main()
            self.page.wait_for_url(INDEX_URL)
            self.wait_until(lambda: self.site.held_me, "the landing's session read")
            self.assertEqual((logouts, logins, None), (len(self.site.logouts), self.site.logins, self.screen()["end"]),
                             "demo sends no logout and writes no end state")

    # ── BR-08 ──
    def test_br08_the_icons_the_pages_declare_come_from_the_table(self):
        # Headless Chromium does not fetch a page's icon links by itself; each one is requested here as the page names it,
        # so every local file the pages declare is served from SERVED_FILES (any other path fails the case).
        self.site.account = None
        self.page.goto(INDEX_URL + "?auth_error=stale")
        expect(self.page.locator("#signin")).to_be_enabled()
        icons = self.page.evaluate("() => [...document.querySelectorAll('link[rel~=icon]')].map(l => l.getAttribute('href'))")
        self.assertEqual(2, len(icons), icons)
        self.assertEqual([200, 200], self.page.evaluate("hrefs => Promise.all(hrefs.map(h => fetch(h).then(r => r.status)))", icons))

    # ── DP: Log out keeps the report draft (F02) ──
    def test_dp01_the_draft_is_saved_before_the_end(self):
        self.open_main()
        self.select_and_type()
        self.site.put_answers = ["hold"]
        self.site.logout_answers = ["hold"]
        writes = len(self.writes())
        self.log_out_main()
        self.wait_until(lambda: self.site.held_puts, "the draft write")
        expect(self.page.locator("dialog.kin-logout h2")).to_have_text("Saving Draft")
        # The preparation is not the end: no hold release, no logout, no end state or notice, the identity stays.
        self.assertEqual(([], [], None), (self.site.releases, self.site.logouts, self.screen()["end"]))
        self.assertEqual([], [w for w in self.writes()[writes:] if w[2] in (END_KEY, "kin-session-ended")])
        self.assertEqual(RAD["sub"], self.screen()["identity"]["sub"])
        self.assertEqual({**FIELDS, "baseVersion": 0}, {k: self.site.puts[0][k] for k in (*FIELDS, "baseVersion")})
        self.site.held_puts.pop().fulfill(json={"ok": True})
        self.wait_until(lambda: self.site.held_logouts, "POST /api/auth/logout")
        self.assert_closed("after the stored draft, POST held")
        # The order: the draft write, the hold release, the logout POST.
        order = [c for c in self.site.calls if c[0] in ("PUT", "POST") and c[1] != f"/api/studies/{UID}/hold"]
        self.assertEqual([("PUT", f"/api/studies/{UID}/report"), ("POST", f"/api/studies/{UID}/release"),
                          ("POST", "/api/auth/logout")], order)
        self.release_logout(204)
        self.assertEqual((CONFIRMED, False), self.landing())

    def test_dp02_a_failed_write_logs_nothing_out_and_keeps_the_text(self):
        for label, answer in (("500", (500, {"statusCode": 500, "message": "SYN"})),
                              ("REPORT_HELD", (409, {"code": "REPORT_HELD", "holder": "syn-other@synthetic.test",
                                                     "message": "SYN held"})),
                              ("connection dropped", "abort"), ("no answer in 15 s", "hold")):
            with self.subTest(write=label):
                self.fresh_context()
                self.site.puts, self.site.held_puts, self.site.releases, self.site.logouts = [], [], [], []
                self.open_main()
                self.select_and_type()
                self.site.put_answers = [answer]
                if label == "no answer in 15 s":
                    self.page.clock.install()
                self.log_out_main()
                self.wait_until(lambda: self.site.puts, "the draft write")
                if label == "no answer in 15 s":
                    self.page.clock.run_for(15500)
                expect(self.page.locator("dialog.kin-logout h2")).to_have_text("Draft Not Saved")
                note = self.page.locator("dialog.kin-logout p").first.inner_text()
                self.assertTrue(has_hangul(note) and "로그아웃하지 않았" in note, note)
                self.assertEqual(([], [], None), (self.site.releases, self.site.logouts, self.screen()["end"]))
                self.assertEqual(RAD["sub"], self.screen()["identity"]["sub"])
                self.assertEqual(list(FIELDS.values()), [self.page.locator("#" + k).input_value() for k in FIELDS])
                if label == "no answer in 15 s":
                    # The earlier write's result is still unknown: Retry does not race it.
                    self.panel_button("Retry").click()
                    self.page.clock.run_for(15500)
                    expect(self.page.locator("dialog.kin-logout p").first).to_contain_text("결과를 아직 모릅니다")
                    self.assertEqual(1, len(self.site.puts))
                    self.site.held_puts.pop().fulfill(json={"ok": True})
                    self.page.wait_for_timeout(200)
                self.site.logout_answers = [(204, None)]
                if label == "REPORT_HELD":
                    # Another reader holds the study now: Retry sends nothing and logs nothing out; only an explicit
                    # discard leaves.
                    puts = len(self.site.puts)
                    self.panel_button("Retry").click()
                    expect(self.page.locator("dialog.kin-logout h2")).to_have_text("Draft Not Saved")
                    self.page.wait_for_timeout(200)
                    self.assertEqual((puts, []), (len(self.site.puts), self.site.logouts))
                    self.dialog_answers = [True]
                    self.panel_button("Discard and Log Out").click()
                    self.landing()
                    self.assertEqual((puts, 1), (len(self.site.puts), len(self.site.logouts)))
                    continue
                # Retry with a stored write goes on to the end.
                self.panel_button("Retry").click()
                self.landing()
                self.assertEqual({**FIELDS, "baseVersion": 0}, {k: self.site.puts[-1][k] for k in (*FIELDS, "baseVersion")})
                self.assertEqual(1, len(self.site.logouts))

    def test_dp03_back_to_editing_and_an_explicit_discard(self):
        self.open_main()
        self.select_and_type()
        self.site.put_answers = [(500, {"statusCode": 500, "message": "SYN"})]
        self.log_out_main()
        expect(self.page.locator("dialog.kin-logout h2")).to_have_text("Draft Not Saved")
        # Late text changes under the panel do not change what is kept: Back to Editing puts the kept text back.
        self.page.evaluate("() => { document.querySelector('#findings').value = 'SYN late overwrite'; }")
        self.panel_button("Back to Editing").click()
        expect(self.page.locator("dialog.kin-logout")).to_have_count(0)
        self.assertEqual(list(FIELDS.values()), [self.page.locator("#" + k).input_value() for k in FIELDS])
        self.assertEqual(([], None), (self.site.logouts, self.screen()["end"]))
        # Log out again; the write fails again; a dismissed discard keeps it, a confirmed one ends without a write.
        self.site.put_answers = [(500, {"statusCode": 500, "message": "SYN"})] * 3
        self.log_out_main()
        expect(self.page.locator("dialog.kin-logout h2")).to_have_text("Draft Not Saved")
        self.dialog_answers = [False]
        self.panel_button("Discard and Log Out").click()
        self.page.wait_for_timeout(200)
        self.assertEqual([], self.site.logouts)
        expect(self.page.locator("dialog.kin-logout h2")).to_have_text("Draft Not Saved")
        puts = len(self.site.puts)
        self.dialog_answers = [True]
        self.panel_button("Discard and Log Out").click()
        self.landing()
        self.assertEqual((puts, 1), (len(self.site.puts), len(self.site.logouts)), "no write after the discard")

    def test_dp04_a_session_end_while_saving_keeps_the_text_in_memory(self):
        for cause in ("a 401", "another tab's end", "an account change"):
            with self.subTest(cause=cause):
                self.fresh_context()
                self.site.account, self.site.login_as = RAD, RAD
                self.site.puts, self.site.held_puts, self.site.logouts, self.site.held_logouts = [], [], [], []
                self.open_main()
                other = self.open_main(self.watch(self.context.new_page())) if cause == "another tab's end" else None
                self.select_and_type()
                if cause == "a 401":
                    # The paused page sends no new request (F02), so the 401 is the answer to one sent before Log out.
                    self.out_before_log_out()
                self.site.put_answers = ["hold"]
                self.log_out_main()
                self.wait_until(lambda: self.site.held_puts, "the draft write")
                if cause == "a 401":
                    self.expire_the_request_out()
                elif cause == "another tab's end":
                    self.log_out_main(other)
                    other.wait_for_url(INDEX_URL)
                else:
                    # A panel of the page that saw another account says so through the shared end list.
                    self.page.evaluate("() => (window.kinOn401 || []).forEach(end => { try { end('account-changed', ''); } catch (_) {} })")
                expect(self.page.locator("dialog.kin-logout h2")).to_have_text("Session Ended")
                self.assert_closed(f"{cause} while the draft write is out")
                self.page.wait_for_timeout(300)
                self.assertEqual([], self.docs(name="index.html"), "no move: the text would be lost")
                self.assertEqual(1, len(self.site.logouts), "one POST for the intent")
                # The held write answers late: nothing comes back on screen.
                self.site.held_puts.pop().fulfill(json={"ok": True})
                self.page.wait_for_timeout(300)
                self.assert_closed(f"{cause}: the late write answer")
                expect(self.page.locator("dialog.kin-logout h2")).to_have_text("Session Ended")
                # Recover Draft: no session, then another account - nothing is written; then the same account.
                puts = len(self.site.puts)
                self.site.account = None
                self.panel_button("Recover Draft").click()
                expect(self.page.locator("dialog.kin-logout [role=status]")).to_contain_text("로그인한 세션이 없습니다")
                self.site.account = RAD_OTHER
                self.panel_button("Recover Draft").click()
                expect(self.page.locator("dialog.kin-logout [role=status]")).to_contain_text("같은 계정")
                self.assertEqual(puts, len(self.site.puts), "nothing is written for no session or another account")
                self.site.account = RAD
                self.panel_button("Recover Draft").click()
                self.page.wait_for_url(INDEX_URL)
                self.assertEqual({**FIELDS, "baseVersion": 0}, {k: self.site.puts[-1][k] for k in (*FIELDS, "baseVersion")})
                self.assertEqual(puts + 1, len(self.site.puts))

    def out_before_log_out(self):
        """A work read sent before Log out and held by the server (the paused page sends no new one, F02)."""
        self.site.held_gets["/api/syn/expired"] = []
        self.page.evaluate("() => { api('GET', '/syn/expired').catch(() => {}); }")
        self.wait_until(lambda: self.site.held_gets["/api/syn/expired"], "the work read sent before Log out")

    def expire_the_request_out(self):
        """That read answered 401 while the preparation is out: a 401 passes the pause (8-e)."""
        self.site.held_gets.pop("/api/syn/expired").pop().fulfill(
            status=401, json={"statusCode": 401, "message": "인증 세션이 만료되었습니다"})

    def test_dp05_an_explicit_discard_after_the_session_ended(self):
        self.open_main()
        self.select_and_type()
        self.out_before_log_out()
        self.site.put_answers = ["hold"]
        self.log_out_main()
        self.wait_until(lambda: self.site.held_puts, "the draft write")
        self.expire_the_request_out()
        expect(self.page.locator("dialog.kin-logout h2")).to_have_text("Session Ended")
        self.dialog_answers = [False]
        self.panel_button("Discard Draft").click()
        self.page.wait_for_timeout(200)
        self.assertEqual([], self.docs(name="index.html"), "a dismissed discard keeps the text")
        self.dialog_answers = [True]
        self.panel_button("Discard Draft").click()
        self.page.wait_for_url(INDEX_URL)
        self.site.held_puts.pop().fulfill(json={"ok": True})

    def test_dp06_with_nothing_to_write_the_end_follows_at_once(self):
        # No change to write: the end follows at once, with no draft write.
        self.open_main()
        self.page.locator("#rows tr", has_text=PATIENT).first.click()
        expect(self.page.locator("#findings")).to_be_editable()
        self.log_out_main()
        self.landing()
        self.assertEqual(([], 1), (self.site.puts, len(self.site.logouts)))

    def test_dp07_log_out_waits_for_a_confirmation_in_flight(self):
        # A Save is out: its draft would race the confirmation, so Log out refuses with the reason and starts nothing.
        self.open_main()
        self.select_and_type()
        self.page.locator("#b-save").click()
        self.wait_until(lambda: self.site.held_commits, "the confirmation request")
        self.dialogs.clear()
        self.log_out_main()
        expect(self.page.locator("#toast")).to_contain_text("판독문을 확정하는 중입니다")
        self.page.wait_for_timeout(200)
        self.assertEqual(([], [], [], 0, None), (self.dialogs, self.site.puts, self.site.logouts,
                                                 self.page.locator("dialog.kin-logout").count(), self.screen()["end"]))
        self.site.held_commits.pop().fulfill(status=500, json={"statusCode": 500, "message": "SYN"})
        self.page.wait_for_timeout(300)

    # ── DP-08..DP-12: the paused page and the bound draft write (Astra S7-U5-SPEC-C-F01/F02) ──
    def panel_title(self):
        return self.page.locator("dialog.kin-logout h2")

    def panel_status(self):
        return self.page.locator("dialog.kin-logout [role=status]")

    def editor(self):
        return [self.page.locator("#" + k).input_value() for k in FIELDS]

    def test_dp08_the_preparation_sends_nothing_but_its_draft_write(self):
        # The page's timers run on the page clock: the autosave (20 s), the poll (30 s), the hold refresh (60 s) and the
        # panels' periodic reads all pass their periods while the draft write is held, and so does the write's 15 s limit.
        self.page.clock.install()
        self.open_main()
        self.select_and_type()
        self.site.put_answers = ["hold"]
        calls = len(self.site.calls)
        self.log_out_main()
        self.wait_until(lambda: self.site.held_puts, "the draft write")
        self.page.clock.run_for(65000)
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        self.assertEqual([("PUT", f"/api/studies/{UID}/report")], self.site.calls[calls:],
                         "nothing but the draft write leaves while the preparation is out")
        # The write answers late; the failed preparation still sends nothing by itself (no autosave over it, no poll).
        self.site.held_puts.pop().fulfill(json={"ok": True})
        self.page.wait_for_timeout(200)
        self.page.clock.run_for(65000)
        self.assertEqual([("PUT", f"/api/studies/{UID}/report")], self.site.calls[calls:])
        self.assertEqual((list(FIELDS.values()), [], None), (self.editor(), self.site.logouts, self.screen()["end"]))

    def test_dp09_answers_to_reads_sent_before_it_change_nothing(self):
        citations, context = f"/api/studies/{UID}/report/citations", f"/api/studies/{UID}/clinical-context"
        self.open_main()
        self.site.held_gets = {citations: [], context: []}
        self.select_and_type()
        self.wait_until(lambda: self.site.held_gets[citations] and self.site.held_gets[context], "the report and panel reads")
        self.site.held_lists = []
        self.page.get_by_role("group", name="Refresh").get_by_role("button", name="Refresh", exact=True).click()
        self.wait_until(lambda: self.site.held_lists, "the list read")
        # An earlier draft write is out too, so the preparation waits for it while the late answers come in.
        self.site.put_answers = ["hold", "hold"]
        self.page.evaluate("() => { stashReport(); }")
        self.wait_until(lambda: self.site.held_puts, "the earlier draft write")
        rows, panel = self.page.locator("#rows").inner_text(), self.page.locator("#clinical-context").inner_text()
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Saving Draft")
        late = Site.list_body()
        late["studies"][0]["name"] = "SYN PATIENT LATE"
        self.site.held_lists.pop().fulfill(json=late)
        # A confirmed citation read: answered before the preparation, it would make the draft's keep list known (and the
        # preparation's write would carry it).
        self.site.held_gets[citations].pop().fulfill(json={"version": 0, "head": [], "draft": [{
            "v": 2, "cid": "SYN-CID-LATE", "field": "findings", "findingId": "f-0", "findingRevision": 1, "sourceIndex": 0,
            "sourceRef": {"kind": "item", "itemId": "i-0", "sourceRevision": 1}, "linkStateAtInsert": "current",
            "headRevisionAtInsert": None, "insertedText": FIELDS["findings"], "insertedAt": "2026-10-03T00:00:00.000Z",
            "insertedBy": RAD["actor"], "sameTextCount": 1}]})
        self.site.held_gets[context].pop().fulfill(json={"code": "SYN_LATE_PANEL", "message": "SYN late panel answer"})
        self.page.wait_for_timeout(300)
        self.site.held_puts.pop().fulfill(json={"ok": True})
        self.wait_until(lambda: len(self.site.puts) == 2, "the preparation's own draft write")
        sent = self.site.puts[1]
        self.assertEqual(FIELDS, {k: sent[k] for k in FIELDS}, "the preparation sends the text it took")
        self.assertNotIn("citationIds", sent, "a late citation answer changed what the preparation saves")
        self.assertEqual((rows, panel), (self.page.locator("#rows").inner_text(), self.page.locator("#clinical-context").inner_text()),
                         "a late answer changed the screen under the preparation")
        self.assertNotIn("LATE", self.screen()["text"])
        self.site.held_puts.pop().fulfill(json={"ok": True})
        self.assertEqual((CONFIRMED, False), self.landing())

    def test_dp10_a_write_of_unknown_result_keeps_editing_and_new_saves_away(self):
        self.page.clock.install()
        self.open_main()
        self.select_and_type()
        self.site.put_answers = ["hold"]
        self.log_out_main()
        self.wait_until(lambda: self.site.held_puts, "the draft write")
        self.page.clock.run_for(15500)
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        calls = len(self.site.calls)
        self.panel_button("Back to Editing").click()
        expect(self.panel_status()).to_contain_text("결과를 아직 모릅니다")
        self.page.clock.run_for(25000)
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        self.assertEqual([], self.site.calls[calls:], "no return and no new write while the earlier write is unknown")
        # The earlier write answers late; only now does Back to Editing ask the server and reopen the editor.
        self.site.held_puts.pop().fulfill(json={"ok": True})
        self.page.wait_for_timeout(200)
        self.panel_button("Back to Editing").click()
        expect(self.page.locator("dialog.kin-logout")).to_have_count(0)
        self.assertEqual([("GET", "/api/me")], self.site.calls[calls:])
        self.assertEqual(list(FIELDS.values()), self.editor())
        # New typing is saved by the autosave after the earlier write is known, never beside it.
        self.page.fill("#findings", "SYN-FINDINGS typed after Back to Editing")
        self.page.clock.run_for(21000)
        self.wait_until(lambda: len(self.site.puts) == 2, "the autosave after Back to Editing")
        self.assertEqual("SYN-FINDINGS typed after Back to Editing", self.site.puts[-1]["findings"])
        self.assertEqual(([], None), (self.site.logouts, self.screen()["end"]))

    def test_dp11_back_to_editing_reopens_only_for_the_same_account_with_the_reading_role(self):
        for label, account in (("another account", RAD_OTHER), ("no session", None),
                               ("no reading role", {**RAD, "roles": ["technician"]}), ("the same reader", RAD)):
            with self.subTest(session=label):
                self.fresh_context()
                self.site.account = RAD
                self.site.puts, self.site.held_puts, self.site.logouts, self.site.held_logouts = [], [], [], []
                self.open_main()
                self.select_and_type()
                self.site.put_answers = [(500, {"statusCode": 500, "message": "SYN"})]
                self.log_out_main()
                expect(self.panel_title()).to_have_text("Draft Not Saved")
                self.site.account = account
                self.panel_button("Back to Editing").click()
                if label == "the same reader":
                    expect(self.page.locator("dialog.kin-logout")).to_have_count(0)
                    self.assertEqual((list(FIELDS.values()), []), (self.editor(), self.site.logouts))
                elif label == "no reading role":
                    expect(self.panel_status()).to_contain_text("판독 권한")
                    expect(self.panel_title()).to_have_text("Draft Not Saved")
                    self.assertEqual((list(FIELDS.values()), []), (self.editor(), self.site.logouts))
                else:
                    # Another account or no session: the end comes first (8-e). The screen closes, the text stays only in
                    # this window's memory and the page does not move.
                    expect(self.panel_title()).to_have_text("Session Ended")
                    self.assert_closed(f"Back to Editing with {label}")
                    self.wait_until(lambda: self.site.logouts, "the end's logout POST")
                    self.page.wait_for_timeout(300)
                    self.assertEqual([], self.docs(name="index.html"))

    def test_dp12_the_draft_write_is_bound_to_the_page_account(self):
        owner = [INSTITUTION, RAD["sub"], RAD["actor"]]
        self.open_main()
        self.select_and_type()
        # An earlier draft write is out when Log out starts; it carries the account the page was opened for.
        self.site.put_answers = ["hold"]
        self.page.evaluate("() => { stashReport(); }")
        self.wait_until(lambda: self.site.held_puts, "the earlier draft write")
        self.assertEqual(owner, self.site.puts[0].get("expectedOwner"))
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Saving Draft")
        # The browser's session becomes another reader's before the preparation's own write leaves: the server refuses it,
        # the screen closes and the text stays in this window's memory. Nothing is written as the other reader.
        self.site.account = RAD_OTHER
        self.site.held_puts.pop().fulfill(json={"ok": True})
        expect(self.panel_title()).to_have_text("Session Ended")
        self.assert_closed("a draft write refused for another account")
        self.assertEqual((2, owner), (len(self.site.puts), self.site.puts[1].get("expectedOwner")))
        self.assertNotIn(RAD_OTHER["actor"], self.site.drafts)
        self.page.wait_for_timeout(300)
        self.assertEqual([], self.docs(name="index.html"), "no move: the text would be lost")
        # Recover Draft: its session check names the same reader, and the session changes before its write: refused, kept.
        self.site.account, self.site.swap_after_me = RAD, RAD_OTHER
        self.panel_button("Recover Draft").click()
        expect(self.panel_status()).to_contain_text("같은 계정")
        self.assertEqual((3, owner), (len(self.site.puts), self.site.puts[2].get("expectedOwner")))
        self.assertNotIn(RAD_OTHER["actor"], self.site.drafts)
        self.assertEqual([], self.docs(name="index.html"))
        # With the same reader's session the text is written as that reader's draft, and only then does the page leave.
        self.site.account = RAD
        self.panel_button("Recover Draft").click()
        self.page.wait_for_url(INDEX_URL)
        self.assertEqual((FIELDS, owner), (self.site.drafts.get(RAD["actor"]), self.site.puts[-1].get("expectedOwner")))
        self.assertNotIn(RAD_OTHER["actor"], self.site.drafts)


def tearDownModule():
    print("S7-U5-LOGOUT-DOM-SERVED " + json.dumps(sorted(SERVED)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
