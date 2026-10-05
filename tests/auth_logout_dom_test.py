# coding: utf-8
"""REQ-S7-U5-AUTH-AUDIT / U5S-REQ-04,06,08,09,11,12,13,15,17,22,23,24 -> U5S-RISK-SESSION, -APPLY, -DRAFT, -SUCCESS
-> TEST-S7-U5-LOGOUT-DOM (BR, DP) and U5S-TEST-S01..S04, S08..S11, D01, D02, D07, D12 (client side).

The browser half of S7-U5 after the U5S redesign. The pages are the shipped files, served byte for byte from the
repository: index.html, main.html, admin.html, clinician.html and every local file they reference (SERVED_FILES below).
An in-test server answers as the wire contract says (s7-u5-server-evidence/wire-contract.md v1): /api/me carries a
sessionId; every bound request names its session in X-KIN-Session and is refused 428/409/401 by code before any handler;
logout ends the bound session and never touches the cookie; an explicit login starts by POST bound to the session it may
replace and ends in a single-use entry proof in the URL fragment; a report draft is one row per author with a stored
revision - every write, discard and confirmation carries expectedOwner and expectedRevision and the full snapshot, and a
success answers the envelope {uid, owner, revision, present, snapshot}. The server can hold, drop, cut or mangle any
answer. No stack, network or credential is used. Cases drive the page by its controls (buttons, typing, selection, the
test clock) and read only what a person or the public module contract shows (KinAuth.session(), KinWorkContext.state()).

The 2026-10-04 amendments (spec-amendments-20261004.md, which take precedence over the spec) are what the cases hold the
pages to: the ordinary path shows no extra click, dialog or closed screen. The combinations of the gate itself run in
tests/session_work_gate_test.cjs; this file keeps one or two representative browser cases per kind of consumer.

Session (U5S-REQ-22):
  S01  Log out with unsaved text enters a preparation: the text is frozen, ordinary requests neither start nor apply,
       nothing claims an end (no record, no end notice, the identity stays) and the connected viewer is not disposed -
       it is told to pause, and to resume when the preparation is cancelled (amendment section 3).
  S02  The preparation's save refused, conflicting or of unknown outcome: the text stays, nothing is declared saved,
       nothing ends or moves by itself. A save whose answer was lost but that a read finds stored ends without a question.
  S03  The session ends during the preparation, or outside one with unsaved text (the server says this session ended,
       another document's end, a session replacement): the screen closes at once, the text is quarantined in this
       window, nothing is stored under another owner.
  S04  Back to Editing is a new work epoch: answers from before the preparation never apply (header, body, error);
       study A -> B -> A never shows the first A's late answer.
  S08  A new document with an end record or with storage it cannot verify stays closed (direct URLs, reload, new tab);
       an explicit login's entry proof enters once and a replayed proof enters nothing.
  S09  Reliable storage, no record, a valid session: normal entry by role. No session: the IdP login starts by itself
       (amendment 1) and its entry proof is consumed without a click (amendment 2); a tab that came back without a
       session is not sent out again.
  S10  Recover Draft stores only for the same owner and discards the capture only when the answer (or a full read after
       it) shows the same owner, revision and whole snapshot.
  S11  Notices are session-bound: a document closes only on its own session's end; crossed and duplicate notices neither
       close another session's document nor are re-posted, and no document sends a logout of its own.
  AM5  What closes a document (amendment 5): a 401 without the ended-session code, a missing binding (428), a 5xx, a
       dropped connection and a timeout close nothing - the screen, the typed text and the session stay.
  AM6  Log Out is one click (amendment 6): no confirmation, no "press again"; a save in flight is waited for by the
       program; Back to Editing returns at once with the work as it was.
Draft (U5S-REQ-23, what the client must show): D01 the loser of two same-revision writes keeps its text and is not
  declared saved - and the same content in two documents converges without a question (amendment 7); D02 a late answer
  of an earlier write does not replace a later one; D07 a lost or malformed answer is confirmed by a read before anyone
  is told, and is unknown (never re-sent by itself) when the read cannot confirm it (amendment 8); D12 the preparation
  and the recovery against the other writers.
Retained (diagnosis scenario 0.C; U5S-REQ-25): BR-01..BR-09 with the contract updates (codes instead of messages,
  session-bound records) and DP-01..DP-15 on the stored-revision protocol.

  BR-08  this file's own inputs: every local request is in SERVED_FILES (anything else fails the case) and the run prints
         the files it actually served on one line, `S7-U5-LOGOUT-DOM-SERVED <json>`.

Mutants (U5S-REQ-26) are one-off copies run outside this file; nothing here edits a product file.
"""
import json
import os
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
    "worklist-v0/hpacs-lite/work-context.js",
    "worklist-v0/hpacs-lite/session-transport.js",
    "worklist-v0/hpacs-lite/report-draft-client.js",
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
MAIN_URL = ORIGIN + BASE + "main.html"
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".svg": "image/svg+xml", ".png": "image/png"}
END_KEY = "kin-session-end"
PROBE_KEY = "kin-session-probe"
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
UID_B = "1.2.826.0.1.3680043.10.7707.2"
PATIENT = "SYN PATIENT ALPHA"
PATIENT_B = "SYN PATIENT BRAVO"
FIELDS = {"findings": "SYN-FINDINGS typed before Log out", "conclusion": "SYN-CONCLUSION", "recommendation": "SYN-REC"}
MORE = {k: v + " SYN-MORE" for k, v in FIELDS.items()}

# The landing's notices, as the shipped index.html words them (compared, never parsed).
CONFIRMED = "이 브라우저의 KIN 로그인 세션을 끝냈습니다. 다시 사용하려면 로그인해 주세요."
UNKNOWN = "로그아웃 상태를 확인할 수 없어 자동으로 로그인하지 않습니다. 로그인 버튼을 눌러 주세요."
SIGN_IN = "KIN 계정으로 로그인"

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
# Messages posted on the session channel by this document, recorded before any page script runs.
CHANNEL_RECORDER = """(() => {
  const posts = [];
  Object.defineProperty(window, '__synPosts', { value: posts });
  if (typeof BroadcastChannel !== 'function') return;
  const post = BroadcastChannel.prototype.postMessage;
  BroadcastChannel.prototype.postMessage = function (message) {
    posts.push([this.name, message]);
    return post.call(this, message);
  };
})();"""
# A document whose storage cannot be read (blocked site data): reading localStorage throws.
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
# The storage can be read (and finds nothing) but writing these keys throws, as a full storage does. The page's other
# keys are written as usual.
WRITES_FAIL = """(keys => { const set = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (keys.includes(String(key))) throw new DOMException('SYN storage full', 'QuotaExceededError');
    return set.call(this, key, value); }; })(%s);"""
# And the browser keeps no cookie a page script writes either (the server's cookies are untouched) - nothing a page
# could keep the end in survives the page.
COOKIE_DROPPED = """(() => { const jar = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  Object.defineProperty(Document.prototype, 'cookie', { configurable: true, get() { return jar.get.call(this); },
    set(value) {} }); })();"""
# The answer's status and headers arrive at once, but reading its body waits until the case releases it or fails it -
# for the listed paths, and only while the case has set window.__synHoldBodies.
HOLD_BODIES = """(paths => { const held = []; Object.defineProperty(window, '__synHeldBodies', { value: held });
  window.__synHoldBodies = false;
  for (const name of ['json', 'text', 'blob']) {
    const read = Response.prototype[name];
    Response.prototype[name] = function () {
      const reading = read.call(this), path = new URL(this.url).pathname;
      if (!window.__synHoldBodies || !paths.includes(path)) return reading;
      return new Promise((resolve, reject) => held.push({ path, release: () => reading.then(resolve, reject),
        fail: () => reading.then(() => reject(new TypeError('SYN body stream failed')), reject) }));
    };
  }
})(%s);"""
# The clipboard of a headless page, answered when the case says (readText) and recorded (writeText).
CLIPBOARD = """(() => { const reads = [], written = [];
  Object.defineProperty(window, '__synClipboard', { value: { reads, written } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    readText: () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
    writeText: text => new Promise((resolve, reject) => written.push({ text, resolve, reject })) } });
})();"""
# What the screen shows of a session: rendered text (hidden parts excluded), the editor's values, the identity and the
# states the modules publish.
SCREEN = """() => ({ text: document.body.innerText, values: [...document.querySelectorAll('textarea, input')].map(e => e.value),
  identity: typeof KinAuth === 'undefined' ? 'no auth.js' : KinAuth.session(),
  state: typeof KinWorkContext === 'undefined' ? null : KinWorkContext.state(),
  end: (() => { try { return localStorage.getItem('kin-session-end'); } catch (e) { return 'unreadable'; } })() })"""


def has_hangul(text):
    return any("가" <= ch <= "힣" for ch in text)


def owner_of(account):
    return {"institution": INSTITUTION, "sub": account["sub"], "author": account["actor"]}


class Site:
    """The synthetic origin: the shipped files from disk and an API that answers, holds or fails on the case's word."""

    def __init__(self):
        self.serial = 0
        self.sessions, self.ended, self.cookie = {}, set(), None   # session id -> account; revoked ids; the browser's kin_sid
        self.login_as = RAD             # the account a login leaves the browser with; None: the login sets no session
        self.proofs, self.logins, self.login_posts, self.entries = {}, 0, [], []
        self.logout_answers = []        # each: (status, body) | "hold" | "abort"; none queued ends the bound session: 204
        self.held_logouts, self.logouts = [], []            # logouts: (page url, X-KIN-Session)
        self.epoch, self.revs, self.rows, self.cids = "SYNEPOCH1", {}, {}, 0   # the draft rows of UID, by author
        self.report = {"version": 0, "rs": "W"}
        self.put_answers = []           # draft writes: (status, body) | "hold" | "abort" | "cut" | "lost" | "partial"
        self.held_puts, self.puts, self.cut_puts, self.put_sessions = [], [], [], []
        self.commit_answers, self.held_commits, self.commits, self.discards = [], [], [], []
        self.draft_reads, self.draft_read_answers = [], []
        self.list_answers, self.held_lists, self.held_me, self.me_answers = [], None, None, []
        self.held_gets, self.gets = {}, {}  # path -> held routes; path -> (status, body)
        self.second_study = False       # a second study row (A -> B -> A)
        self.releases, self.holds = [], []
        self.calls, self.violations, self.unbound = [], [], set()
        self.sign_in(RAD)

    # ── sessions (wire contract 1) ──
    def sign_in(self, account):
        self.serial += 1
        session = f"SYN-SESSION-{self.serial}"
        self.sessions[session] = account
        self.cookie = session
        return session

    @property
    def account(self):
        return None if self.cookie is None or self.cookie in self.ended else self.sessions[self.cookie]

    @account.setter
    def account(self, value):
        """The browser's session becomes `value`'s (a new login), or the browser has no session cookie (None)."""
        if value is None:
            self.cookie = None
        else:
            self.sign_in(value)

    def authenticate(self, request, bootstrap=False, strict=True):
        """The guard's decision before any handler: (account, None) or (None, (status, code))."""
        bound = request.headers.get("x-kin-session")
        if self.cookie is None:
            return None, (401, "AUTH_CREDENTIALS_MISSING")
        if bound is None:
            if strict and not bootstrap:
                return None, (428, "AUTH_SESSION_REQUIRED")
        elif bound != self.cookie:
            return None, (409, "AUTH_SESSION_MISMATCH")
        if self.cookie in self.ended:
            return None, (401, "AUTH_SESSION_ENDED")
        return self.sessions[self.cookie], None

    @staticmethod
    def refuse(route, status, code):
        try:
            route.fulfill(status=status, json={"code": code, "message": "SYN-SERVER-WORDING " + code},
                          headers={"X-KIN-Auth-Code": code} if code.startswith("AUTH_") else {})
        except PlaywrightError:
            pass

    @staticmethod
    def answer(route, status, body, headers=None):
        try:
            if body is None:
                route.fulfill(status=status, body="", headers=headers or {})
            else:
                route.fulfill(status=status, json=body, headers=headers or {})
        except PlaywrightError:
            pass  # the page has gone: nothing receives the answer

    def complete_login(self):
        """The OIDC round trip stands in as one step: the browser has a new session for login_as and the callback's
        redirect carries a single-use entry proof in the fragment (wire contract 3, 4)."""
        self.logins += 1
        if self.login_as is None:
            # The round trip came back without a session cookie (a blocked cookie, a failed callback without its error).
            return '<!doctype html><title>SYN login</title><script>location.replace("' + BASE + 'index.html")</script>'
        session = self.sign_in(self.login_as)
        proof = f"SYN-PROOF-{self.logins}"
        self.proofs[proof] = session
        return ('<!doctype html><title>SYN login</title><script>location.replace("' + BASE + 'main.html#kin-entry='
                + proof + '")</script>')

    # ── the draft row of UID (wire contract 5) ──
    def revision(self, author):
        return f"{self.epoch}:{self.revs.get(author, 0)}"

    def envelope(self, account):
        row = self.rows.get(account["actor"])
        return {"uid": UID, "owner": owner_of(account), "revision": self.revision(account["actor"]),
                "present": row is not None, "snapshot": dict(row) if row else None,
                "updatedAt": "2026-10-03T00:00:00.000Z" if row else None}

    def preconditions(self, body, account):
        """The named refusals of every draft mutation; None when the stored revision is the expected one."""
        if not isinstance(body, dict) or "expectedOwner" not in body or "expectedRevision" not in body:
            return 400, {"code": "REPORT_DRAFT_PRECONDITION_REQUIRED", "message": "SYN-SERVER-WORDING precondition"}
        if body["expectedOwner"] != owner_of(account):
            return 409, {"code": "REPORT_DRAFT_OWNER_CHANGED", "message": "SYN-SERVER-WORDING owner"}
        if body["expectedRevision"] != self.revision(account["actor"]):
            return 409, {"code": "REPORT_DRAFT_CONFLICT", "message": "SYN-SERVER-WORDING conflict"}
        return None

    def write(self, body, account):
        """PUT report when its turn comes: the full snapshot replaces the author's row and the revision advances by one;
        all three texts empty clears the row (the revision still advances)."""
        refused = self.preconditions(body, account)
        if refused:
            return refused
        if any(key not in body for key in (*FIELDS, "baseVersion", "citationIds", "structureIds")):
            return 400, {"code": "REPORT_DRAFT_PRECONDITION_REQUIRED", "message": "SYN-SERVER-WORDING snapshot"}
        author = account["actor"]
        self.revs[author] = self.revs.get(author, 0) + 1
        if all(not body[k] for k in FIELDS):
            self.rows.pop(author, None)
        else:
            self.rows[author] = {**{k: body[k] for k in FIELDS}, "baseVersion": body["baseVersion"],
                                 "citations": list(body["citationIds"]), "structured": list(body["structureIds"])}
        return 200, self.envelope(account)

    def state(self, account):
        row = self.rows.get(account["actor"]) if isinstance(account, dict) else None
        return {"rs": self.report["rs"], "ss": "Verified", "em": "N", "ts": "none", "matched": "U", "ward": "",
                "reqHosp": "SYN Hospital A", "institutionId": INSTITUTION, "teleInstitutionId": None, "preDoc": None,
                "preReviewer": None, "prelimHidden": False, "repDoc": None, "confirm": None, "ov": None, "orig": None,
                "oid": None, "holder": None, "holdReason": None, "version": self.report["version"],
                "findings": self.report.get("findings", ""), "conclusion": self.report.get("conclusion", ""),
                "recommendation": self.report.get("recommendation", ""),
                "draft": {**{k: row[k] for k in FIELDS}, "baseVersion": row["baseVersion"],
                          "at": "2026-10-03T00:00:00.000Z"} if row else None,
                "draftRevision": self.revision(account["actor"]) if isinstance(account, dict) else f"{self.epoch}:0",
                "draftEpoch": self.epoch}

    def study_row(self, account, uid=UID, name=PATIENT, patient="SYN-P-001"):
        """One /api/studies row in the server's shape, editable by a radiologist."""
        state = self.state(account)
        if uid != UID:
            state.update(draft=None, draftRevision=f"{self.epoch}:0")
        return {"uid": uid, "techNote": {"version": 0, "present": False}, "readerAssignment": {"revision": 0, "reader": None},
                "gatewayReceipt": None, "orderIdentity": None, "count": 10, "series": 1, "acc": "SYNACC" + patient[-4:],
                "id": patient, "sourcePatientKey": INSTITUTION + "|" + patient, "name": name, "birth": "19800101",
                "date": "20261003", "sex": "M", "modality": "CT", "desc": "SYN CT CHEST", "institutionName": "SYN Hospital A",
                "tele": False, "state": state}

    def list_body(self, account, rename=None):
        rows = [self.study_row(account)]
        if self.second_study:
            rows.append(self.study_row(account, UID_B, PATIENT_B, "SYN-P-002"))
        if rename:
            rows[0]["name"] = rename
        return {"studies": rows, "serverTime": "2026-10-03T00:00:00.000Z", "observedAt": "2026-10-03T00:00:00.000Z",
                "notObserved": [], "pagination": {"owner": [INSTITUTION, account["sub"]], "limit": 100, "offset": 0,
                                                  "total": len(rows), "next": None}}

    # ── routes ──
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
        if method == "GET" and path == "/auth/syn/login":
            # Keycloak's form and the callback, as one page.
            return route.fulfill(body=self.complete_login(), content_type="text/html; charset=utf-8")
        if path.startswith("/api/"):
            # Every write (the logout POST and the draft write among them) carries the CSRF header.
            if method != "GET" and request.headers.get("x-kin-csrf") != "1":
                self.violations.append(f"{method} {path} without X-KIN-CSRF")
                return route.abort()
            self.calls.append((method, path))
            return self.api(route, request, method, path, url.query)
        if method == "GET" and (path == "/statistics" or path.startswith("/dicom-web/") or path.startswith("/instances/")):
            if request.headers.get("x-kin-session") is not None:
                account, refused = self.authenticate(request)
                if refused:
                    # nginx's auth_request: binding problems are 403 with the code header, the rest 401.
                    status = 403 if refused[1] in ("AUTH_SESSION_REQUIRED", "AUTH_SESSION_MISMATCH") else 401
                    return route.fulfill(status=status, body="", headers={"X-KIN-Auth-Code": refused[1]})
            elif path == "/statistics":
                self.violations.append(f"{method} {path} without X-KIN-Session")
            else:
                self.unbound.add((urlparse(request.frame.page.url).path.rsplit("/", 1)[-1], method, path.split("/")[1]))
            if path in self.held_gets:
                return self.held_gets[path].append(route)
            if path in self.gets:
                status, body = self.gets[path]
                return route.fulfill(status=status, json=body)
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

    # Requests this unit's files send (auth.js, index.html, main.html's own script): each must name its session.
    STRICT = re.compile(r"/api/(auth/logout|bootstrap|studies|prefs|colleagues|templates.*|filters.*|unassigned"
                        r"|studies/[^/]+/(report|draft|hold|release|report/commit|report/citations|report/structure"
                        r"|report/versions.*|clinical-context|image-requests|questions|gateway-retry))$")

    def me(self, account):
        if account == "pending":
            return 403, {"code": "INSTITUTION_PENDING", "message": "SYN pending", "sessionId": self.cookie}
        return 200, {**account, "sessionId": self.cookie}

    def api(self, route, request, method, path, query):
        page = urlparse(request.frame.page.url).path.rsplit("/", 1)[-1]
        # ── public initiation and entry (wire contract 3, 4) ──
        if method == "GET" and path in ("/api/auth/login", "/api/auth/register"):
            if self.account is not None:
                return route.fulfill(body='<!doctype html><script>location.replace("' + BASE
                                     + 'index.html?auth_error=session_active")</script>', content_type="text/html; charset=utf-8")
            return route.fulfill(body=self.complete_login(), content_type="text/html; charset=utf-8")
        if method == "POST" and path in ("/api/auth/login", "/api/auth/register"):
            bound = request.headers.get("x-kin-session")
            self.login_posts.append(bound)
            if self.cookie is not None:
                if bound is None:
                    return self.refuse(route, 428, "AUTH_SESSION_REQUIRED")
                if bound != self.cookie:
                    return self.refuse(route, 409, "AUTH_SESSION_MISMATCH")
                self.ended.add(self.cookie)     # the replaced session is revoked with its audit before the IdP is reached
            return self.answer(route, 200, {"location": ORIGIN + "/auth/syn/login"})
        if method == "POST" and path == "/api/auth/entry":
            proof = (request.post_data_json or {}).get("proof")
            self.entries.append(proof)
            if proof in self.proofs and self.proofs[proof] == self.cookie and self.cookie not in self.ended:
                return self.answer(route, 200, {"sessionId": self.proofs.pop(proof)})
            return self.refuse(route, 403, "AUTH_ENTRY_REFUSED")
        # ── the guard ──
        bootstrap = method == "GET" and path == "/api/me"
        strict = bool(self.STRICT.match(path)) and page in ("main.html", "index.html")
        account, refused = self.authenticate(request, bootstrap=bootstrap, strict=strict)
        if request.headers.get("x-kin-session") is None and not bootstrap and not strict:
            self.unbound.add((page, method, re.sub(r"/[0-9][0-9.]+(?=/|$)", "/:uid", path)))
        if method == "GET" and path == "/api/me" and self.held_me is not None:
            return self.held_me.append(route)
        if method == "GET" and path == "/api/me" and self.me_answers:
            return self.answer(route, *self.me_answers.pop(0))
        if method == "POST" and path == "/api/auth/logout":
            self.logouts.append((request.frame.page.url, request.headers.get("x-kin-session")))
            reply = self.logout_answers.pop(0) if self.logout_answers else "end"
            if reply == "hold":
                return self.held_logouts.append(route)
            if reply == "abort":
                return route.abort("connectionreset")
            if reply != "end":
                return self.answer(route, reply[0], reply[1], {"X-KIN-Auth-Code": reply[1]["code"]}
                                   if reply[1] and str(reply[1].get("code", "")).startswith("AUTH_") else None)
            if refused and refused[1] != "AUTH_SESSION_ENDED":
                return self.refuse(route, *refused)
            self.ended.add(self.cookie)
            return self.answer(route, 204, None)
        if refused:
            return self.refuse(route, *refused)
        if method == "GET" and path == "/api/me":
            return self.answer(route, *self.me(account))
        if account == "pending":
            return self.refuse(route, 403, "INSTITUTION_PENDING")
        if method == "GET" and path in self.held_gets:
            return self.held_gets[path].append(route)
        if method == "GET" and path == "/api/bootstrap":
            return route.fulfill(json={"statesOmitted": True, "me": {"actor": account["actor"], "roles": account["roles"],
                                       "institution": INSTITUTION, "institutionName": "SYN Hospital A"},
                                       "filters": [], "templates": [], "institutions": [{"id": INSTITUTION,
                                       "name": "SYN Hospital A", "type": "hospital"}], "states": {}, "orders": [],
                                       "serverTime": "2026-10-03T00:00:00.000Z"})
        if method == "GET" and path == "/api/studies" and parse_qs(query).get("limit") == ["100"]:
            if self.held_lists is not None:
                return self.held_lists.append((route, account))
            if self.list_answers:
                reply = self.list_answers.pop(0)
                if reply == "abort":
                    return route.abort("connectionreset")
                status, body = reply
                return self.answer(route, status, body, {"X-KIN-Auth-Code": body["code"]}
                                   if str(body.get("code", "")).startswith("AUTH_") else None)
            return route.fulfill(json=self.list_body(account))
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
        found = re.fullmatch(r"/api/studies/([^/]+)/(hold|release|report|draft|report/commit)", path)
        if found and found.group(1) in (UID, UID_B):
            what = found.group(2)
            if method == "POST" and what == "hold":
                self.holds.append(path)
                return route.fulfill(json={"holder": account["user"], "conflict": False})
            if method == "POST" and what == "release":
                self.releases.append((path, request.headers.get("x-kin-session")))
                return route.fulfill(json={"ok": True})
            if found.group(1) == UID and method == "GET" and what == "draft":
                self.draft_reads.append(request.headers.get("x-kin-session"))
                if self.draft_read_answers:
                    reply = self.draft_read_answers.pop(0)
                    if reply == "abort":
                        return route.abort("connectionreset")
                    return self.answer(route, *reply)
                return route.fulfill(json=self.envelope(account))
            if found.group(1) == UID and method == "PUT" and what == "report":
                return self.put(route, request, account)
            if found.group(1) == UID and method == "DELETE" and what == "draft":
                body = request.post_data_json
                self.discards.append(body)
                refused_write = self.preconditions(body, account)
                if refused_write:
                    return self.answer(route, *refused_write)
                self.revs[account["actor"]] = self.revs.get(account["actor"], 0) + 1
                self.rows.pop(account["actor"], None)
                return route.fulfill(json={**self.envelope(account), "state": self.state(account)})
            if found.group(1) == UID and method == "POST" and what == "report/commit":
                body = request.post_data_json
                self.commits.append(body)
                reply = self.commit_answers.pop(0) if self.commit_answers else "ok"
                if reply == "hold":
                    return self.held_commits.append(route)
                if reply != "ok":
                    return self.answer(route, *reply)
                refused_write = self.preconditions(body, account)
                if refused_write:
                    return self.answer(route, *refused_write)
                self.revs[account["actor"]] = self.revs.get(account["actor"], 0) + 1
                self.rows.pop(account["actor"], None)
                self.report = {"version": self.report["version"] + 1, "rs": {"approve": "A"}.get(body.get("action"), "T"),
                               **{k: body.get(k, "") for k in FIELDS}}
                return route.fulfill(json={**self.envelope(account), "state": self.state(account)})
        if method == "GET" and path in self.gets:
            status, body = self.gets[path]
            return route.fulfill(status=status, json=body)
        if method == "GET":
            return route.fulfill(status=404, json={"code": "SYN_NOT_STUBBED", "message": "synthetic server: not stubbed"})
        self.violations.append(f"undeclared write: {method} {path}")
        return route.fulfill(status=405, json={"code": "SYN_NO_WRITE"})

    def put(self, route, request, account):
        body = request.post_data_json
        self.puts.append(body)
        self.put_sessions.append(request.headers.get("x-kin-session"))
        reply = self.put_answers.pop(0) if self.put_answers else "ok"
        if reply == "hold":
            return self.held_puts.append((route, body, account))
        if reply == "abort":            # the connection drops before the server has the write
            return route.abort("connectionreset")
        if reply == "cut":              # the browser loses the connection; the server still has the write to finish
            self.cut_puts.append((body, account))
            return route.abort("connectionreset")
        if reply == "lost":             # the server stores the write; its answer reaches nobody
            self.write(body, account)
            return route.abort("connectionreset")
        if reply == "partial":          # the server stores the write and answers 200 without the envelope
            self.write(body, account)
            return self.answer(route, 200, {"ok": True})
        if reply != "ok":
            return self.answer(route, *reply)
        return self.answer(route, *self.write(body, account))

    def finish_put(self, index=0, status=200):
        """Answer a held draft write; a 200 is the server reaching that write now (stored, or refused for its revision)."""
        route, body, account = self.held_puts.pop(index)
        status, answer = self.write(body, account) if status == 200 else (status, {"code": "SYN_FAILED", "message": "SYN"})
        self.answer(route, status, answer)
        return status

    def finish_cut(self):
        """The server reaches a write whose connection the browser lost; the status it would have answered is returned."""
        body, account = self.cut_puts.pop(0)
        return self.write(body, account)[0]

    def count(self, method, path):
        return sum(1 for call in self.calls if call == (method, path))

    def stored(self, account=RAD):
        row = self.rows.get(account["actor"])
        return {k: row[k] for k in FIELDS} if row else None


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
        UNBOUND.update(self.site.unbound)
        self.assertEqual([], sorted(item for item in self.site.unbound if item[0] == "main.html"), "all main document requests are session-bound")
        self.assertEqual([], self.site.violations, "requests the harness does not answer, unbound requests of this unit's "
                                                   "files, or local files outside the table")
        self.assertEqual([], self.errors, "page errors")

    def fresh_context(self, site=True):
        """A browser context of its own: the end state lives in the origin's storage until the next explicit login."""
        if self.context is not None:
            self.context.close()
        if site:
            self.site = Site()
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR",
                                                timezone_id="Asia/Seoul")
        self.context.add_init_script(STORAGE_RECORDER)
        self.context.add_init_script(CHANNEL_RECORDER)
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
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
                self.fail(f"{what}: not observed within {timeout:.0f}s; the last requests were {self.site.calls[-8:]}")
            (page or self.page).wait_for_timeout(20)

    def docs(self, page=None, name=None):
        found = [path for owner, path in self.documents if owner is (page or self.page)]
        return found if name is None else [path for path in found if path.endswith(name)]

    # ── pages ──
    def open_main(self, page=None, who=RAD):
        page = page or self.page
        page.goto(MAIN_URL)
        expect(page.locator("#rows")).to_contain_text(PATIENT)
        expect(page.locator("#user")).to_have_text(who["displayName"])
        return page

    # S8-CTX F01/F02: the shared note must preserve the worklist's close/escape
    # contract and tell apart a refused write and a missing receipt.
    def note_save_failure(self, failure):
        source = os.environ.get('KIN_CTX_TECH_NOTE_JS')
        if source:
            self.context.route('**/tech-note.js', lambda r: r.fulfill(body=Path(source).read_text(encoding='utf-8'), content_type='text/javascript'))
        self.open_main()
        self.page.locator('#rows tr').first.click()
        self.note_calls = []
        def reply(route):
            method = route.request.method
            self.note_calls.append(method)
            if method == 'GET' and len(self.note_calls) == 1:
                route.fulfill(json={'uid': UID, 'writable': True, 'note': None})
            elif method == 'POST' and failure != 'network':
                if failure == 'unreadable':
                    route.fulfill(status=400, body='{', content_type='application/json')
                else:
                    status, body = failure
                    route.fulfill(status=status, json=body)
            else:
                route.abort()
        self.context.route('**/api/studies/*/tech-note', reply)
        self.page.locator('#rows [data-tech-note]').first.click()
        expect(self.page.get_by_role('dialog', name='Tech Note', exact=True).get_by_label('Note', exact=True)).to_be_editable()
        self.page.get_by_role('dialog', name='Tech Note', exact=True).get_by_label('Note', exact=True).fill('SYN my note')
        self.page.get_by_role('button', name='Save Note', exact=True).click()
        expect(self.page.get_by_role('dialog', name='Tech Note', exact=True).get_by_role('button', name='Close', exact=True)).to_be_enabled()

    def test_ctx_note_409_refusal_sentence_and_original_reload_confirmation(self):
        self.note_save_failure((409, {'message': '다른 메모가 먼저 저장되었습니다. 최신 메모를 확인하세요.'}))
        expect(self.page.locator('#tech-note-status')).to_have_text('저장되지 않았습니다: 다른 메모가 먼저 저장되었습니다. 최신 메모를 확인하세요. · 입력은 유지했습니다. 최신 메모와 이력을 확인하세요.')
        self.assertEqual(self.note_calls, ['GET', 'POST'])
        self.dialog_answers.append(False)
        self.page.get_by_role('button', name='Reload Note', exact=True).click()
        self.assertIn('입력 중인 메모를 버리고', self.dialogs[-1])
        self.assertEqual(self.note_calls, ['GET', 'POST'])
        self.page.get_by_role('dialog', name='Tech Note', exact=True).get_by_role('button', name='Close', exact=True).click()
        expect(self.page.locator('#tech-note-dialog')).not_to_be_visible()
        expect(self.page.locator('#findings')).to_be_editable()

    def test_ctx_note_answered_refusal_closes_without_history(self):
        for code in (400, 403, 500):
            with self.subTest(status=code):
                if code != 400:
                    self.fresh_context()
                self.note_save_failure((code, {'message': 'SYN not stored', 'stored': False}))
                expect(self.page.locator('#tech-note-status')).to_contain_text('저장되지 않았습니다')
                expect(self.page.get_by_role('dialog', name='Tech Note', exact=True).get_by_label('Note', exact=True)).to_have_value('SYN my note')
                self.page.keyboard.press('Escape')
                expect(self.page.locator('#tech-note-dialog')).not_to_be_visible()
                self.assertEqual(self.note_calls, ['GET', 'POST'])
                expect(self.page.locator('#findings')).to_be_editable()

    def test_ctx_note_unknown_close_cancel_then_escape_during_minute_outage(self):
        self.note_save_failure('network')
        expect(self.page.locator('#tech-note-status')).to_contain_text('저장 결과를 알 수 없습니다')
        self.dialog_answers.append(False)
        self.page.get_by_role('dialog', name='Tech Note', exact=True).get_by_role('button', name='Close', exact=True).click()
        self.assertIn('저장 결과를 알 수 없습니다', self.dialogs[-1])
        expect(self.page.get_by_role('dialog', name='Tech Note', exact=True).get_by_label('Note', exact=True)).to_have_value('SYN my note')
        self.page.get_by_role('button', name='Reload Note', exact=True).click()
        expect(self.page.locator('#tech-note-status')).to_contain_text('저장 결과를 알 수 없습니다')
        self.page.keyboard.press('Escape')
        expect(self.page.locator('#tech-note-dialog')).not_to_be_visible()
        # Synthetic API outage covers all subsequent traffic; wall-clock passage
        # is simulated so the busy PC does not decide whether the dialog closes.
        self.context.route('**/api/**', lambda r: r.abort())
        self.page.clock.install()
        self.page.clock.run_for(61000)
        self.page.locator('#rows tr').first.click()
        self.page.locator('#findings').fill('SYN report remains usable')
        expect(self.page.locator('#findings')).to_have_value('SYN report remains usable')

    def test_ctx_note_unreadable_answer_keeps_unknown_sentence_and_closes(self):
        self.note_save_failure('unreadable')
        expect(self.page.locator('#tech-note-status')).to_contain_text('저장 결과를 알 수 없습니다')
        self.page.get_by_role('dialog', name='Tech Note', exact=True).get_by_role('button', name='Close', exact=True).click()
        expect(self.page.locator('#tech-note-dialog')).not_to_be_visible()

    def open_admin(self):
        self.site.account = ADMIN
        self.page.goto(ORIGIN + BASE + "admin.html")
        expect(self.page.locator("#users td.username")).to_have_count(1)

    def open_clinician(self):
        self.site.account = CLINICIAN
        self.page.goto(ORIGIN + BASE + "clinician.html")
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "ready")

    def select_and_type(self, page=None, fields=FIELDS, patient=PATIENT):
        page = page or self.page
        page.locator("#rows tr", has_text=patient).first.click()
        expect(page.locator("#findings")).to_be_editable()
        for name, value in fields.items():
            page.fill("#" + name, value)
        self.wait_until(lambda: self.site.holds, "the hold the typing starts", page=page)

    def refresh(self, page=None):
        (page or self.page).get_by_role("group", name="Refresh").get_by_role("button", name="Refresh", exact=True).click()

    def log_out_main(self, page=None):
        (page or self.page).evaluate("() => document.querySelector('#logout').click()")

    def panel_button(self, name, page=None):
        """A control of main.html's logout panel (the page has other buttons of the same name under it)."""
        return (page or self.page).locator("dialog.kin-logout").get_by_role("button", name=name, exact=True)

    def panel_title(self, page=None):
        return (page or self.page).locator("dialog.kin-logout h2")

    def panel_status(self, page=None):
        return (page or self.page).locator("dialog.kin-logout [role=status]")

    def editor(self, page=None):
        return {k: (page or self.page).locator("#" + k).input_value() for k in FIELDS}

    def screen(self, page=None):
        return (page or self.page).evaluate(SCREEN)

    def end_state(self, page=None):
        raw = self.screen(page)["end"]
        return json.loads(raw) if raw not in (None, "unreadable") else raw

    def writes(self, page=None):
        return (page or self.page).evaluate("() => window.__synWrites.slice()")

    def posts(self, page=None):
        return (page or self.page).evaluate("() => window.__synPosts.filter(p => p[0] === 'kin-session').map(p => p[1])")

    def assert_closed(self, what, page=None):
        seen = self.screen(page)
        self.assertNotIn("SYN", seen["text"], f"{what}: something of the session is still on screen")
        self.assertEqual([], [value for value in seen["values"] if "SYN" in value], f"{what}: a field keeps session text")
        self.assertIsNone(seen["identity"], f"{what}: auth.js still gives the identity")
        self.assertNotIn(seen["state"], ("active", "preparing"), f"{what}: the gate still admits work")

    def landing(self, page=None):
        page = page or self.page
        page.wait_for_url(INDEX_URL)
        expect(page.locator("#signin")).to_be_enabled()
        return page.locator("#msg").inner_text(), page.locator("#retry-logout").is_visible()

    def release_logout(self, status=204, body=None):
        route = self.site.held_logouts.pop(0)
        if status == 204:
            self.site.ended.add(self.site.logouts[-1][1])
        self.site.answer(route, status, body, {"X-KIN-Auth-Code": body["code"]}
                         if body and str(body.get("code", "")).startswith("AUTH_") else None)

    def sign_in_from_landing(self, page=None):
        """The explicit login: the control, the IdP stand-in, the entry proof, the work page."""
        page = page or self.page
        page.get_by_role("button", name=SIGN_IN).click()
        page.wait_for_url(MAIN_URL)
        expect(page.locator("#rows")).to_contain_text(PATIENT)

    # ── S09 / BR-07: entry without an end record ──
    def test_s09_no_session_starts_the_login_by_itself_and_enters_without_a_click(self):
        # The start of a day: no session in this browser, reliable storage, no end record. Nothing is pressed.
        for first in ("index.html", "main.html"):
            with self.subTest(opened=first):
                self.fresh_context()
                self.site.account = None
                self.page.goto(ORIGIN + BASE + first)
                self.page.wait_for_url(MAIN_URL)
                expect(self.page.locator("#rows")).to_contain_text(PATIENT)
                self.assertEqual((1, [], ["SYN-PROOF-1"]), (self.site.logins, self.site.login_posts, self.site.entries),
                                 "one login by itself (nothing to replace), its proof consumed by itself")
                self.assertEqual("", urlparse(self.page.url).fragment, "the entry proof left the address")
                self.assertEqual(([], "active", None), (self.dialogs, self.screen()["state"], self.screen()["end"]))
        # A login that comes back without a session is not started again by itself: the landing offers the control.
        self.fresh_context()
        self.site.account, self.site.login_as = None, None
        self.page.goto(INDEX_URL)
        expect(self.page.locator("#signin")).to_be_enabled()
        self.page.wait_for_timeout(500)
        self.assertEqual((1, "unknown", None), (self.site.logins, self.screen()["state"], self.screen()["end"]),
                         "one automatic attempt, then no loop")
        self.assertFalse(self.page.locator("#retry-logout").is_visible())
        # The control then starts the login; with no session to replace it is the plain link.
        self.site.login_as = RAD
        self.sign_in_from_landing()
        self.assertEqual((2, []), (self.site.logins, self.site.login_posts))

    def test_s09_a_login_error_or_a_failed_confirmation_starts_no_login_by_itself(self):
        for label, url, me in (("the callback's error", INDEX_URL + "?auth_error=stale", None),
                               ("the session read fails", INDEX_URL, (500, {"statusCode": 500, "message": "SYN"}))):
            with self.subTest(entry=label):
                self.fresh_context()
                if me:
                    self.site.me_answers = [me] * 2     # a live session whose read fails: neither entered nor replaced
                else:
                    self.site.account = None
                self.page.goto(url)
                expect(self.page.locator("#signin")).to_be_enabled()
                self.page.wait_for_timeout(400)
                message = self.page.locator("#msg").inner_text()
                self.assertTrue(has_hangul(message), message)
                self.assertEqual((0, [], None), (self.site.logins, self.docs(name="main.html"), self.screen()["end"]),
                                 "no login by itself, no end record written for a failed read")

    def test_s09_a_valid_session_lands_by_role_and_demo_asks_no_server(self):
        for account, landing in ((RAD, "main.html"), (CLINICIAN, "clinician.html"), ("pending", "main.html")):
            with self.subTest(session=landing if account != "pending" else "pending"):
                self.fresh_context()
                self.site.account = account
                self.page.goto(INDEX_URL)
                self.page.wait_for_url(ORIGIN + BASE + landing)
                if account == "pending":
                    expect(self.page.get_by_text("관리자 승인 대기")).to_be_visible()
                self.assertIsNone(self.screen()["end"])
                self.assertEqual((0, []), (self.site.logins, self.site.login_posts))
        with self.subTest(entry="demo"):
            self.fresh_context()
            self.site.account = None
            self.page.goto(INDEX_URL + "?auth_error=stale")
            calls = len(self.site.calls)
            self.page.get_by_role("button", name="데모 모드로 둘러보기 (서버 없이)").click()
            self.page.wait_for_url(MAIN_URL)
            expect(self.page.locator("#user")).to_have_text("demo")
            # The landing after the demo is an ordinary entry again (it reads the session; with none it would start the
            # login); that read is held so the landing stays to be read.
            self.site.held_me = []
            self.log_out_main()
            self.page.wait_for_url(INDEX_URL)
            self.wait_until(lambda: self.site.held_me, "the landing's session read")
            self.assertEqual(([], 0, None), (self.site.logouts, self.site.logins, self.screen()["end"]),
                             "demo sends no logout and writes no end state")
            self.assertEqual([], [c for c in self.site.calls[calls:] if c != ("GET", "/api/me")])

    # ── BR-01 ──
    def test_br01_main_log_out_closes_before_the_post_and_shares_it(self):
        self.open_main()
        session = self.site.cookie
        # A list read held from before the end, and the logout POST held.
        self.site.held_lists = []
        self.refresh()
        self.wait_until(lambda: self.site.held_lists, "the held list read")
        held_list, account = self.site.held_lists.pop()
        self.site.held_lists = None
        self.site.logout_answers = ["hold"]
        self.log_out_main()
        self.wait_until(lambda: self.site.held_logouts, "POST /api/auth/logout")
        self.assert_closed("main, Log out, POST held")
        self.assertEqual({"session": session, "status": "ending"}, {k: self.end_state()[k] for k in ("session", "status")})
        self.assertEqual("ending", self.screen()["state"])
        # Overlapping presses share the intent, and the late list answer paints nothing: no second POST.
        self.log_out_main()
        self.site.answer(held_list, 200, self.site.list_body(account, rename="SYN PATIENT LATE"))
        self.page.wait_for_timeout(300)
        self.assert_closed("main, after a late list answer")
        self.assertEqual([(MAIN_URL, session)], self.site.logouts, "one POST, naming the session it ends")
        self.assertEqual([], self.docs(name="index.html"), "no move before the POST answers")
        preparation = self.posts()[0]["preparation"]
        self.assertIsInstance(preparation, str)
        self.assertTrue(preparation.strip(), "preparation is a non-empty opaque id")
        self.assertEqual([{"type": "session-preparing", "session": session, "preparation": preparation},
                          {"type": "session-ended", "session": session, "operation": self.end_state()["operation"],
                           "status": "ending"}], self.posts(),
                         "the viewers' pause notice, then one end notice - each naming its session")
        self.release_logout(204)
        message, retry = self.landing()
        self.assertEqual((CONFIRMED, False), (message, retry))
        self.assertEqual((1, 1, 0), (len(self.site.logouts), len(self.docs(name="index.html")), self.site.logins))
        self.assertEqual([], self.dialogs, "Log out is one press: nothing is asked on the ordinary path")

    # ── AM5: what does not close a document ──
    def test_am5_a_failure_that_proves_no_end_closes_nothing(self):
        code = lambda status, name: (status, {"code": name, "message": "SYN-SERVER-WORDING"})
        failures = (("a 401 without a code", (401, {"statusCode": 401, "message": "SYN token rejected"})),
                    ("401 no credentials", code(401, "AUTH_CREDENTIALS_MISSING")),
                    ("428 no binding", code(428, "AUTH_SESSION_REQUIRED")),
                    ("409 a busy session", code(409, "AUTH_SESSION_BUSY")),
                    ("a 403", (403, {"statusCode": 403, "message": "SYN forbidden"})),
                    ("a 500", (500, {"statusCode": 500, "message": "SYN"})),
                    ("the connection drops", "abort"))
        self.page.clock.install()
        self.open_main()
        session = self.site.cookie
        self.select_and_type()
        for label, answer in failures:
            with self.subTest(failure=label):
                self.site.list_answers = [answer]
                self.refresh()
                expect(self.page.locator("#err")).to_contain_text("검사 목록을 불러오지 못했습니다")
                self.page.wait_for_timeout(200)
                seen = self.screen()
                self.assertEqual(("active", RAD["sub"], None), (seen["state"], seen["identity"]["sub"], seen["end"]), label)
                self.assertEqual((FIELDS, [], []), (self.editor(), self.site.logouts, self.posts()),
                                 "the typed text stays; no logout, no notice")
                expect(self.page.locator("#rows")).to_contain_text(PATIENT)
                self.assertEqual(0, self.panel_title().count(), "no window is raised for one failed request")
                # The next read works again: nothing was closed that would have to be reopened.
                self.refresh()
                expect(self.page.locator("#err")).to_have_text("")
        self.assertEqual(([], False, []), (self.docs(name="index.html"), session in self.site.ended, self.dialogs))
        # The same holds for a draft save: a 401 that proves nothing is that save's failure, the text stays on screen.
        self.site.put_answers = [(401, {"statusCode": 401, "message": "SYN token rejected"})]
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.puts, "the autosave")
        expect(self.page.locator("#toast")).to_contain_text("서버 저장 실패")
        self.assertEqual(("active", FIELDS, []), (self.screen()["state"], self.editor(), self.site.logouts))
        # And the next autosave stores it.
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.stored() == FIELDS, "the autosave after the failed one")

    def test_br01_a_401_that_names_the_session_ended_confirms_without_a_post(self):
        self.open_main()
        session = self.site.cookie
        self.site.ended.add(session)       # the server ended this session (idle, refresh refused, another device's logout)
        self.refresh()
        self.assertEqual((CONFIRMED, False), self.landing())
        self.assertEqual(([], "confirmed", session), (self.site.logouts, self.end_state()["status"], self.end_state()["session"]))

    def test_br01_admin_and_clinician_close_before_the_post(self):
        for page_name in ("admin", "clinician"):
            with self.subTest(page=page_name):
                self.fresh_context()
                (self.open_admin if page_name == "admin" else self.open_clinician)()
                session = self.site.cookie
                self.site.logout_answers = ["hold"]
                self.page.evaluate("() => document.querySelector('#logout').click()")
                self.wait_until(lambda: self.site.held_logouts, "POST /api/auth/logout")
                seen = self.screen()
                self.assertNotIn("SYN", seen["text"], f"{page_name}: something of the session is still on screen")
                self.assertIsNone(seen["identity"])
                self.page.evaluate("() => document.querySelector('#logout')?.click()")
                self.page.wait_for_timeout(200)
                self.assertEqual([session], [bound for _, bound in self.site.logouts])
                self.release_logout(204)
                self.assertEqual((CONFIRMED, False), self.landing())
                self.assertEqual(1, len(self.docs(name="index.html")), "one move")

    # ── BR-02 ──
    def test_br02_a_busy_session_and_the_fixed_500_stay_on_the_landing_with_retry(self):
        notices = {}
        for label, status, body in (("409", 409, {"code": "AUTH_SESSION_BUSY", "message": "SYN-SERVER-WORDING busy"}),
                                    ("500", 500, {"code": "AUTH_STORAGE_FAILURE", "message": "SYN-SERVER-WORDING storage"})):
            with self.subTest(answer=label):
                self.fresh_context()
                self.open_main()
                self.site.logout_answers = [(status, body)]
                self.log_out_main()
                message, retry = self.landing()
                notices[label] = message
                self.assertTrue(retry, "Retry Log Out is offered")
                self.assertTrue(has_hangul(message) and "SYN-SERVER-WORDING" not in message, message)
                self.assertEqual(("unconfirmed", "conflict" if status == 409 else "storage"),
                                 (self.end_state()["status"], self.end_state()["reason"]))
                # The server session remains (/api/me would answer 200), yet nothing enters it.
                self.page.wait_for_timeout(500)
                self.assertEqual(([], [], 0, 1), (self.docs(name="main.html")[1:], self.docs(name="clinician.html"),
                                                  self.site.logins, len(self.site.logouts)))
                # A work page opened directly goes back to the notice without any request.
                for direct in ("main.html", "admin.html", "clinician.html"):
                    calls = len(self.site.calls)
                    self.page.goto(ORIGIN + BASE + direct)
                    again, _ = self.landing()
                    self.assertEqual(message, again, direct)
                    self.assertEqual([], self.site.calls[calls:], f"{direct}: no API request while the end is unconfirmed")
                self.assertEqual(1, len(self.site.logouts), "no POST is sent again by itself")
        self.assertNotEqual(notices["409"], notices["500"], "a busy session and the fixed 500 say different things")

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
        self.release_logout(409, {"code": "AUTH_SESSION_BUSY", "message": "SYN"})
        message, retry = self.landing()
        self.assertTrue(retry)
        # The landing of the second tab follows the result written by the first.
        expect(second.locator("#msg")).to_have_text(message)
        # Reload, back and a later tab keep the notice; nothing is entered and nothing is sent again.
        self.page.reload()
        self.assertEqual((message, True), self.landing())
        self.page.goto(MAIN_URL)
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

    # ── BR-04 ──
    def test_br04_retry_confirms_and_the_landing_stays_until_login(self):
        self.open_main()
        first = self.site.cookie
        self.site.logout_answers = [(500, {"code": "AUTH_STORAGE_FAILURE", "message": "SYN storage"})]
        self.log_out_main()
        self.assertTrue(self.landing()[1])
        self.site.logout_answers = ["hold"]
        self.page.locator("#retry-logout").click()
        self.wait_until(lambda: self.site.held_logouts, "the retry POST")
        self.page.evaluate("() => document.querySelector('#retry-logout').click()")
        self.page.wait_for_timeout(200)
        self.assertEqual([first, first], [bound for _, bound in self.site.logouts],
                         "one POST per press, each naming the recorded session; overlapping presses share it")
        self.release_logout(204)
        expect(self.page.locator("#msg")).to_have_text(CONFIRMED)
        expect(self.page.locator("#retry-logout")).to_be_hidden()
        self.assertEqual("confirmed", self.end_state()["status"])
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
        # The login control leaves the landing. Pressing it erases nothing: the record is there until the login succeeded
        # and its entry proof was taken.
        self.site.account = None            # the ended session's cookie is gone: nothing to replace
        self.sign_in_from_landing()
        self.assertEqual((1, None, "active"), (self.site.logins, self.screen()["end"], self.screen()["state"]))
        self.assertNotEqual(first, self.site.cookie)

    def test_br04_a_login_press_erases_no_record_and_opens_no_work(self):
        self.open_main()
        first = self.site.cookie
        self.site.logout_answers = [(500, {"code": "AUTH_STORAGE_FAILURE", "message": "SYN storage"})]
        self.log_out_main()
        message, _ = self.landing()
        # The IdP is not reached (its page is held): the press alone changed nothing.
        self.context.route("**/auth/syn/login", lambda route: None)
        self.page.get_by_role("button", name=SIGN_IN).click()
        self.wait_until(lambda: self.site.login_posts, "the login initiation")
        self.page.wait_for_timeout(300)
        self.assertEqual([first], self.site.login_posts, "the initiation names the session it may replace")
        other = self.watch(self.context.new_page())
        other.goto(MAIN_URL)
        self.assertEqual((message, True), self.landing(other))
        self.assertEqual("unconfirmed", self.end_state(other)["status"], "the press erased no record")
        self.assertEqual(0, self.site.logins)

    # ── BR-05 ──
    def classify(self, answer, init=None, wait_ms=0):
        self.fresh_context()
        if init:
            self.page.add_init_script(init)
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
        code = lambda status, name: (status, {"code": name, "message": "SYN-SERVER-WORDING"})
        cases = [("204", "end", None, 0, ("confirmed", None)),
                 ("401 the session ended", code(401, "AUTH_SESSION_ENDED"), None, 0, ("confirmed", None)),
                 ("401 no credentials", code(401, "AUTH_CREDENTIALS_MISSING"), None, 0, ("unconfirmed", "credentials")),
                 ("401 without a code", (401, {"statusCode": 401, "message": "SYN-SERVER-WORDING token"}), None, 0,
                  ("unconfirmed", "refused")),
                 ("403 csrf", code(403, "AUTH_CSRF_REQUIRED"), None, 0, ("unconfirmed", "refused")),
                 ("428 no binding", code(428, "AUTH_SESSION_REQUIRED"), None, 0, ("unconfirmed", "refused")),
                 ("409 busy", code(409, "AUTH_SESSION_BUSY"), None, 0, ("unconfirmed", "conflict")),
                 ("500 storage", code(500, "AUTH_STORAGE_FAILURE"), None, 0, ("unconfirmed", "storage")),
                 ("500 other", (500, {"statusCode": 500, "message": "SYN-SERVER-WORDING"}), None, 0, ("unconfirmed", "refused")),
                 ("connection dropped", "abort", None, 0, ("unconfirmed", "network")),
                 ("no headers in 10 s", "hold", None, 10500, ("unconfirmed", "timeout")),
                 ("no body in 10 s", code(409, "AUTH_SESSION_BUSY"), HOLD_LOGOUT_BODY, 10500, ("unconfirmed", "timeout"))]
        messages = {}
        for label, answer, init, wait_ms, expected in cases:
            with self.subTest(answer=label):
                end, message = self.classify(answer, init, wait_ms)
                self.assertEqual(expected, (end["status"], end.get("reason")))
                self.assertEqual(1, len(self.site.logouts), "nothing is sent again by itself")
                if expected[0] == "confirmed":
                    self.assertEqual(CONFIRMED, message)
                else:
                    self.assertTrue(has_hangul(message) and "SYN" not in message and message != CONFIRMED, message)
                    expect(self.page.locator("#retry-logout")).to_be_visible()
                messages.setdefault(expected[1], set()).add(message)
        self.assertEqual(6, len({next(iter(m)) for reason, m in messages.items() if reason}),
                         "each failure kind has its own notice")

    def test_br05_a_logout_refused_for_another_login_ends_nothing_and_keeps_that_login(self):
        # The cookie is another login's by the time this document's logout arrives: the server refuses it by code, the
        # other session is untouched, and this document leaves no record that would keep that login's documents out.
        self.open_main()
        first = self.site.cookie
        self.site.account = RAD             # a later explicit login in this browser: session 2
        second = self.site.cookie
        self.log_out_main()
        self.wait_until(lambda: self.site.logouts, "POST /api/auth/logout")
        self.assertEqual(([(MAIN_URL, first)], set()), (self.site.logouts, self.site.ended & {second}))
        # The landing finds the other login's session and enters it (the page is read once it has settled there); no
        # record stays for a session this browser can no longer use, and no logout for the other login was ever sent.
        self.wait_until(lambda: len(self.docs(name="main.html")) == 2, "the entry into the other login's session")
        expect(self.page.locator("#rows")).to_contain_text(PATIENT)
        expect(self.page.locator("#user")).to_have_text(RAD["displayName"])
        self.assertIsNone(self.screen()["end"], "no record stays for a session this browser can no longer use")
        self.assertEqual((1, "active"), (len(self.site.logouts), self.screen()["state"]))

    # ── BR-06 ──
    def test_br06_a_late_session_answer_restores_nothing(self):
        for when in ("before its headers", "while its body is read"):
            with self.subTest(late=when):
                self.fresh_context()
                self.site.held_me = []
                if when == "while its body is read":
                    self.page.add_init_script("""(() => { const json = Response.prototype.json; window.__heldMe = [];
                      Response.prototype.json = function () { const read = json.call(this);
                        if (!this.url.endsWith('/api/me')) return read;
                        return new Promise((resolve, reject) => { window.__heldMe.push(() => read.then(resolve, reject)); }); };
                    })();""")
                self.page.goto(MAIN_URL)
                self.wait_until(lambda: self.site.held_me, "the session read")
                me = self.site.held_me.pop()
                self.site.held_me = None
                answer = self.site.me(RAD)[1]
                if when == "while its body is read":
                    me.fulfill(json=answer)
                    self.wait_until(lambda: self.page.evaluate("() => window.__heldMe.length") == 1, "the session body held")
                # Keep the old document alive until the held body settles; otherwise an
                # earlier navigation destroys the realm before the intended late continuation.
                if when == "while its body is read":
                    self.page.route(INDEX_URL, lambda route: route.fulfill(status=204, body=""))
                # Another document of the same session ends it while this one still waits for its identity.
                other = self.watch(self.context.new_page())
                self.open_main(other)
                self.site.logout_answers = ["hold"]
                self.log_out_main(other)
                self.wait_until(lambda: self.site.held_logouts, "POST /api/auth/logout", page=other)
                calls = len(self.site.calls)
                if when == "before its headers":
                    me.fulfill(json=answer)
                else:
                    self.page.evaluate("() => window.__heldMe.splice(0).forEach(release => release())")
                    self.assert_closed("the late body after another document ended the session")
                    self.assertTrue(self.docs(name="index.html"), "the page requested its landing")
                if when == "before its headers":
                    self.landing()
                self.page.wait_for_timeout(300)
                self.assertIsNone(self.screen()["identity"], f"the late /api/me ({when}) restored the identity")
                self.assertEqual([], self.site.calls[calls:], "no work read after the late session answer")
                self.assertEqual([], self.docs(name="main.html")[1:])
                self.release_logout(204)

    def test_br06_an_explicit_login_elsewhere_is_not_undone_by_a_late_result(self):
        self.open_main()
        first = self.site.cookie
        self.site.logout_answers = ["hold"]
        self.log_out_main()
        self.wait_until(lambda: self.site.held_logouts, "POST /api/auth/logout")
        other = self.watch(self.context.new_page())
        other.goto(INDEX_URL)
        expect(other.locator("#retry-logout")).to_be_visible()
        self.sign_in_from_landing(other)
        second = self.site.cookie
        self.assertEqual(([first], None), (self.site.login_posts, self.screen(other)["end"]),
                         "the login replaced the recorded session by name, and its entry cleared the record")
        # The earlier logout's answer comes late: by now the cookie is the new login's.
        self.site.answer(self.site.held_logouts.pop(0), 409, {"code": "AUTH_SESSION_MISMATCH", "message": "SYN"},
                         {"X-KIN-Auth-Code": "AUTH_SESSION_MISMATCH"})
        self.wait_until(lambda: self.docs(name="index.html"), "the move after the late logout result")
        other.wait_for_timeout(500)
        # The earlier logout's result wrote nothing over the new login, and the other tab stays in use.
        self.assertIsNone(self.screen(other)["end"])
        self.assertEqual(("active", RAD["sub"]), (self.screen(other)["state"], self.screen(other)["identity"]["sub"]))
        expect(other.locator("#rows")).to_contain_text(PATIENT)
        self.assertEqual(([], False), (self.docs(other, "index.html")[1:], second in self.site.ended))

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

    # ── S08 / BR-03 / BR-09: an end record, or storage that cannot be verified, keeps a new document closed ──
    def unwritable(self, cookie=True):
        """A fresh browser whose storage refuses the end record and the probe (and, unless `cookie`, keeps no script
        cookie): the session is still alive on the server (/api/me would answer 200)."""
        self.fresh_context()
        self.context.add_init_script(WRITES_FAIL % json.dumps([END_KEY, PROBE_KEY]))
        if not cookie:
            self.context.add_init_script(COOKIE_DROPPED)

    def test_s08_a_document_that_cannot_read_or_verify_its_storage_stays_closed(self):
        for label, init in (("reading the storage throws", NO_STORAGE),
                            ("the storage takes no write", WRITES_FAIL % json.dumps([END_KEY, PROBE_KEY]))):
            with self.subTest(storage=label):
                self.fresh_context()
                self.context.add_init_script(init)
                for direct in ("index.html", "main.html", "admin.html", "clinician.html"):
                    self.page.goto(ORIGIN + BASE + direct)
                    self.assertEqual((UNKNOWN, False), self.landing(), direct)
                    self.assertEqual("unknown", self.screen()["state"])
                later = self.watch(self.context.new_page())
                later.goto(MAIN_URL)
                self.assertEqual((UNKNOWN, False), self.landing(later))
                self.page.wait_for_timeout(300)
                self.assertEqual((0, [], []), (self.site.logins, self.site.calls, self.docs(name="main.html")[1:]),
                                 "the live session is not even read, and nothing is entered")
                # The explicit login's proof enters once, storage or not; the next new document is closed again.
                self.sign_in_from_landing()
                self.assertEqual(("active", RAD["sub"]), (self.screen()["state"], self.screen()["identity"]["sub"]))
                entered = self.watch(self.context.new_page())
                entered.goto(MAIN_URL)
                self.assertEqual((UNKNOWN, False), self.landing(entered))

    def test_s08_an_entry_proof_enters_once_and_a_replayed_or_foreign_proof_enters_nothing(self):
        self.open_main()
        self.site.logout_answers = [(500, {"code": "AUTH_STORAGE_FAILURE", "message": "SYN"})]
        self.log_out_main()
        self.landing()
        self.sign_in_from_landing()
        self.assertEqual((None, "active", ["SYN-PROOF-1"]), (self.screen()["end"], self.screen()["state"], self.site.entries))
        self.assertNotIn("kin-entry", self.page.url)
        self.assertEqual([], self.dialogs, "the proof was consumed without a click")
        # That session's logout is not confirmed either: the browser holds an end record again, the session lives on.
        self.site.logout_answers = [(500, {"code": "AUTH_STORAGE_FAILURE", "message": "SYN"})]
        self.log_out_main()
        notice, _ = self.landing()
        # The address with the used proof again (history, a copied link): refused - the end record still keeps the
        # document closed, and no login starts by itself.
        replay = self.watch(self.context.new_page())
        replay.goto(MAIN_URL + "#kin-entry=SYN-PROOF-1")
        self.assertEqual((notice, True), self.landing(replay))
        self.assertEqual((None, ["SYN-PROOF-1", "SYN-PROOF-1"]), (self.screen(replay)["identity"], self.site.entries))
        self.assertNotIn("kin-entry", replay.url)
        # A proof issued for another session (the cookie changed since): refused too, and not consumed.
        self.site.proofs["SYN-PROOF-FOREIGN"] = "SYN-SESSION-OTHER"
        foreign = self.watch(self.context.new_page())
        foreign.goto(MAIN_URL + "#kin-entry=SYN-PROOF-FOREIGN")
        self.assertEqual((notice, True), self.landing(foreign))
        self.assertIn("SYN-PROOF-FOREIGN", self.site.proofs, "a refused proof consumed nothing")
        self.page.wait_for_timeout(300)
        self.assertEqual((1, []), (self.site.logins, self.docs(replay, "main.html")[1:] + self.docs(foreign, "main.html")[1:]),
                         "nothing was entered and no login started by itself")

    def test_br09_an_end_record_that_cannot_be_written_still_keeps_the_session_out(self):
        notices = set()
        for label, answer in (("409", (409, {"code": "AUTH_SESSION_BUSY", "message": "SYN"})),
                              ("500 storage", (500, {"code": "AUTH_STORAGE_FAILURE", "message": "SYN storage"})),
                              ("connection dropped", "abort")):
            with self.subTest(answer=label):
                # The storage worked when the documents entered; it is full by the time of the logout.
                self.fresh_context()
                self.open_main()
                second = self.open_main(self.watch(self.context.new_page()))
                for page in (self.page, second):
                    page.evaluate(WRITES_FAIL % json.dumps([END_KEY, PROBE_KEY]))
                self.context.add_init_script(WRITES_FAIL % json.dumps([END_KEY, PROBE_KEY]))
                self.site.logout_answers = [answer]
                self.log_out_main()
                message, retry = self.landing()
                notices.add(message)
                self.assertTrue(retry and has_hangul(message) and message != CONFIRMED, message)
                self.assertIsNone(self.screen()["end"], "the premise: the end record is not in the storage")
                # The tab already open closes on the notice alone and moves once, sending nothing; returning to it shows
                # the result the first tab recorded (in the cookie the record fell back to).
                second_message, second_retry = self.landing(second)
                self.assertTrue(second_retry and second_message != CONFIRMED, second_message)
                second.evaluate("() => window.dispatchEvent(new Event('focus'))")
                expect(second.locator("#msg")).to_have_text(message)
                self.page.wait_for_timeout(500)
                self.assertEqual(([], [], 0, 1, 1), (self.docs(name="main.html")[1:], self.docs(second, "main.html")[1:],
                                                     self.site.logins, len(self.site.logouts),
                                                     len(self.docs(second, "index.html"))))
                # Reload, work pages opened directly and a later tab: the notice, never the live session.
                self.page.reload()
                self.assertEqual((message, True), self.landing())
                for direct in ("main.html", "admin.html", "clinician.html"):
                    calls = len(self.site.calls)
                    self.page.goto(ORIGIN + BASE + direct)
                    self.assertEqual((message, True), self.landing(), direct)
                    self.assertEqual([], self.site.calls[calls:], f"{direct}: no API request while the end is unconfirmed")
                later = self.watch(self.context.new_page())
                later.goto(INDEX_URL)
                self.assertEqual((message, True), self.landing(later))
                later.wait_for_timeout(300)
                self.assertEqual((0, 1), (self.site.logins, len(self.site.logouts)), "nothing goes on by itself")
        self.assertEqual(3, len(notices), "each failure keeps its own notice")
        # Only Retry Log Out and the login control go on: one POST per press.
        self.page.locator("#retry-logout").click()
        expect(self.page.locator("#msg")).to_have_text(CONFIRMED)
        self.page.reload()
        self.assertEqual((CONFIRMED, False), self.landing())
        self.assertEqual((2, 0), (len(self.site.logouts), self.site.logins))

    def test_br09_when_nothing_can_be_stored_a_new_document_is_unknown_and_enters_nothing(self):
        self.fresh_context()
        self.open_main()
        second = self.open_main(self.watch(self.context.new_page()))
        for script in (WRITES_FAIL % json.dumps([END_KEY, PROBE_KEY]), COOKIE_DROPPED):
            for page in (self.page, second):
                page.evaluate(script)
            self.context.add_init_script(script)
        self.site.logout_answers = [(409, {"code": "AUTH_SESSION_BUSY", "message": "SYN"})]
        self.log_out_main()
        # No record of the failed logout survives this document. The new document cannot verify its storage, so it does
        # not take "no record" for "never ended": it stays closed and offers the login only.
        self.assertEqual((UNKNOWN, False), self.landing())
        self.assertEqual((None, ""), (self.screen()["end"], self.page.evaluate("() => document.cookie")),
                         "the premise: nothing in the storage, no script cookie")
        # The tab already open closed on the notice (the channel still carried it).
        self.assertEqual((UNKNOWN, False), self.landing(second))
        self.page.reload()
        self.assertEqual((UNKNOWN, False), self.landing())
        self.page.wait_for_timeout(300)
        self.assertEqual(([], [], 0, 1), (self.docs(name="main.html")[1:], self.docs(second, "main.html")[1:],
                                          self.site.logins, len(self.site.logouts)), "nothing entered or started by itself")
        # Work pages opened directly come back to the same notice, asking the server nothing.
        for direct in ("main.html", "admin.html", "clinician.html"):
            calls = len(self.site.calls)
            self.page.goto(ORIGIN + BASE + direct)
            self.assertEqual((UNKNOWN, False), self.landing(), direct)
            self.assertEqual([], self.site.calls[calls:], f"{direct}: no API request from a document that cannot verify its storage")
        self.assertEqual((0, 1), (self.site.logins, len(self.site.logouts)))

    # ── S11: notices are session-bound ──
    def test_s11_crossed_and_duplicate_notices_close_only_the_matching_session(self):
        a = self.open_main()
        first = self.site.cookie
        # A later login in the same browser: the cookie is session 2's, and document B belongs to it.
        self.site.account = RAD
        second = self.site.cookie
        b = self.open_main(self.watch(self.context.new_page()))
        b.locator("#rows tr", has_text=PATIENT).first.click()
        b.fill("#findings", "SYN-B typed in the second session")
        calls = len(self.site.calls)
        # Session 1's end, announced twice, plus a notice that names no session and one that names a third.
        # A bound background read may already have closed A after the cookie changed.
        # An independent same-origin sender keeps injected notices out of B's product-send log.
        sender = self.context.new_page()
        sender.route(ORIGIN + '/notice-fixture', lambda route: route.fulfill(body='<!doctype html>', content_type='text/html'))
        sender.goto(ORIGIN + '/notice-fixture')
        sender.evaluate("""first => { for (const data of [
            { type: 'session-ended', session: first, operation: 1, status: 'ending' },
            { type: 'session-ended', session: first, operation: 1, status: 'ending' },
            { type: 'session-ended' },
            { type: 'session-ended', session: 'SYN-SESSION-NOBODY', operation: 2, status: 'confirmed' }]) {
          const channel = new BroadcastChannel('kin-session'); channel.postMessage(data); channel.close(); } }""", first)
        sender.close()
        a.wait_for_url(re.compile(re.escape(ORIGIN + BASE) + r"(index|main)\.html$"))
        b.wait_for_timeout(500)
        seen = self.screen(b)
        self.assertEqual(("active", RAD["sub"], "SYN-B typed in the second session"),
                         (seen["state"], seen["identity"]["sub"], b.locator("#findings").input_value()),
                         "session 2's document was closed or changed by session 1's notices")
        expect(b.locator("#user")).to_have_text(RAD["displayName"])
        self.assertEqual([], self.docs(b, "index.html"))
        self.assertEqual(([], []), (self.site.logouts, self.posts(b)), "no logout and no re-posted notice")
        self.assertEqual(False, second in self.site.ended)
        # And the other way: session 2's own end closes B (its typed text saved first), with one POST that names session 2.
        self.site.logout_answers = ["hold"]
        self.log_out_main(b)
        self.wait_until(lambda: self.site.held_logouts, "session 2's logout", page=b)
        self.assertEqual([second], [bound for _, bound in self.site.logouts])
        self.assertEqual(["session-ended"], [post["type"] for post in self.posts(b) if post["type"] == "session-ended"],
                         "one end notice for the one end")
        self.assertEqual("SYN-B typed in the second session", self.site.stored()["findings"])
        self.release_logout(204)
        self.landing(b)

    # ── S01 / DP-01 / DP-08 ──
    def test_s01_log_out_prepares_freezes_the_text_and_claims_no_end(self):
        # The page's timers run on the page clock: the autosave (20 s), the poll (30 s), the hold refresh (60 s) and the
        # panels' periodic reads all pass their periods while the preparation's save is held.
        self.page.clock.install()
        self.open_main()
        session = self.site.cookie
        self.select_and_type()
        self.site.put_answers = ["hold"]
        self.site.logout_answers = ["hold"]
        writes, calls = len(self.writes()), len(self.site.calls)
        self.log_out_main()
        self.wait_until(lambda: self.site.held_puts, "the preparation's save")
        expect(self.panel_title()).to_have_text("Saving Draft")
        # The preparation is not the end: no hold release, no logout, no end record or end notice, the identity stays.
        # The viewers of this session are told to pause - not to close (amendment section 3).
        seen = self.screen()
        self.assertEqual(("preparing", RAD["sub"], None), (seen["state"], seen["identity"]["sub"], seen["end"]))
        preparation = self.posts()[0]["preparation"]
        self.assertIsInstance(preparation, str)
        self.assertTrue(preparation.strip(), "preparation is a non-empty opaque id")
        # One notice per preparation: the pause is held by a Web Lock, not renewed by a timer.
        self.assertEqual(([], [], [{"type": "session-preparing", "session": session, "preparation": preparation}]),
                         (self.site.releases, self.site.logouts, self.posts()))
        self.assertEqual([], [w for w in self.writes()[writes:] if w[2] == END_KEY])
        self.assertEqual([], self.dialogs, "one press: no confirmation")
        # The save: the owner, the revision the text stands on, the whole snapshot - and the session it belongs to.
        sent = self.site.puts[0]
        self.assertEqual({**FIELDS, "baseVersion": 0, "citationIds": [], "structureIds": [], "expectedOwner": owner_of(RAD),
                          "expectedRevision": "SYNEPOCH1:0"}, sent)
        self.assertEqual([session], self.site.put_sessions)
        # Later changes to the editor under the panel are not what is saved or kept.
        self.page.evaluate("() => { document.querySelector('#findings').value = 'SYN late overwrite'; }")
        self.page.clock.run_for(65000)
        # Past the save's deadline the program reads the stored draft (twice at most) before anyone is told; ordinary
        # work of this unit's files - the autosave, the poll, the hold refresh, the panels' reads - sent nothing while the
        # preparation stood. (Modules that still send their own requests are the breadth-wiring job's; see UNBOUND.)
        draft = ("GET", f"/api/studies/{UID}/draft")
        self.assertEqual([("PUT", f"/api/studies/{UID}/report"), draft, draft],
                         [call for call in self.site.calls[calls:] if Site.STRICT.match(call[1])],
                         "nothing but the preparation's save and its confirming reads leaves while it is out")
        # The reads did not find it: its result is unknown. Nothing is declared, nothing ends.
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        self.assertEqual(([], None, "preparing"), (self.site.logouts, self.screen()["end"], self.screen()["state"]))
        # The server finishes that write late; Retry reads the stored draft, finds the frozen text there and ends.
        self.assertEqual(200, self.site.finish_put())
        self.assertEqual(FIELDS, self.site.stored())
        self.panel_button("Retry").click()
        self.wait_until(lambda: self.site.held_logouts, "POST /api/auth/logout")
        self.assert_closed("after the stored draft, POST held")
        self.assertEqual(1, len(self.site.puts), "the frozen text was already stored: no second write")
        self.assertEqual([(f"/api/studies/{UID}/release", session)], self.site.releases, "the hold is released before the POST")
        self.release_logout(204)
        self.assertEqual((CONFIRMED, False), self.landing())

    def test_dp01_the_draft_is_saved_before_the_end(self):
        self.open_main()
        self.select_and_type()
        self.site.logout_answers = ["hold"]
        self.log_out_main()
        self.wait_until(lambda: self.site.held_logouts, "POST /api/auth/logout")
        self.assert_closed("after the stored draft, POST held")
        self.assertEqual(FIELDS, self.site.stored())
        # The order: the draft write, the hold release, the logout POST.
        order = [c for c in self.site.calls if c[0] in ("PUT", "POST") and c[1] != f"/api/studies/{UID}/hold"]
        self.assertEqual([("PUT", f"/api/studies/{UID}/report"), ("POST", f"/api/studies/{UID}/release"),
                          ("POST", "/api/auth/logout")], order)
        self.release_logout(204)
        self.assertEqual((CONFIRMED, False), self.landing())

    # ── S02 / DP-02 / D07 ──
    def test_s02_a_save_that_is_refused_or_of_unknown_outcome_keeps_the_text_and_ends_nothing(self):
        held = (409, {"code": "REPORT_HELD", "holder": "syn-other@synthetic.test", "message": "SYN held"})
        for label, answer, stored_after in (("500", (500, {"statusCode": 500, "message": "SYN"}), None),
                                            ("503 unavailable", (503, {"code": "REPORT_DRAFT_UNAVAILABLE", "message": "SYN"}), None),
                                            ("a 401 that proves no end", (401, {"statusCode": 401, "message": "SYN"}), None),
                                            ("REPORT_HELD", held, None),
                                            ("connection dropped", "abort", None),
                                            ("the answer is lost", "lost", FIELDS),
                                            ("a 200 without the envelope", "partial", FIELDS)):
            with self.subTest(write=label):
                self.fresh_context()
                self.open_main()
                self.select_and_type()
                self.site.put_answers = [answer]
                if label in ("the answer is lost", "a 200 without the envelope"):
                    # The confirming read fails too: the outcome stays unknown.
                    self.site.draft_read_answers = ["abort"]
                self.log_out_main()
                expect(self.panel_title()).to_have_text("Draft Not Saved")
                note = self.page.locator("dialog.kin-logout p").first.inner_text()
                self.assertTrue(has_hangul(note) and "로그아웃하지 않았" in note and "SYN" not in note, note)
                seen = self.screen()
                self.assertEqual(([], [], None, "preparing", RAD["sub"]),
                                 (self.site.releases, self.site.logouts, seen["end"], seen["state"], seen["identity"]["sub"]))
                self.assertEqual(FIELDS, self.editor(), "the text is still in the editor")
                self.assertEqual(stored_after, self.site.stored())
                self.page.wait_for_timeout(300)
                self.assertEqual([], self.docs(name="index.html"), "nothing moves by itself")
                if label == "REPORT_HELD":
                    # Another reader holds the study now: only an explicit discard leaves.
                    puts = len(self.site.puts)
                    self.dialog_answers = [True]
                    self.panel_button("Discard and Log Out").click()
                    self.landing()
                    self.assertEqual((puts, 1), (len(self.site.puts), len(self.site.logouts)))
                    continue
                # Retry: the stored draft is read first. Where the lost or partial write is found there whole, nothing is
                # written again; otherwise the same frozen text is sent on the revision the read showed.
                puts = len(self.site.puts)
                self.panel_button("Retry").click()
                self.landing()
                self.assertEqual(FIELDS, self.site.stored())
                self.assertEqual(puts if stored_after else puts + 1, len(self.site.puts))
                self.assertEqual({**FIELDS, "baseVersion": 0}, {k: self.site.puts[-1][k] for k in (*FIELDS, "baseVersion")})
                self.assertEqual(1, len(self.site.logouts))

    def test_s02_d07_a_save_whose_answer_is_lost_but_is_found_stored_ends_without_a_question(self):
        # The program confirms before anyone is asked (amendment 8): the answer is lost or malformed, the read that
        # follows shows the whole frozen text stored - the logout goes on by itself, with no second write.
        for answer in ("lost", "partial"):
            with self.subTest(answer=answer):
                self.fresh_context()
                self.open_main()
                self.select_and_type()
                self.site.put_answers = [answer]
                self.log_out_main()
                self.assertEqual((CONFIRMED, False), self.landing())
                self.assertEqual((FIELDS, 1, 1, []), (self.site.stored(), len(self.site.puts), len(self.site.logouts),
                                                      self.dialogs))

    def test_s02_d01_a_save_that_conflicts_keeps_the_text_and_never_resends_by_itself(self):
        self.page.clock.install()
        self.open_main()
        self.select_and_type()
        # Another document of the same reader stored its own draft first (same starting revision): this one's save loses.
        other_text = {"findings": "SYN-OTHER-TAB findings", "conclusion": "", "recommendation": ""}
        self.site.write({**other_text, "baseVersion": 0, "citationIds": [], "structureIds": [], "expectedOwner": owner_of(RAD),
                         "expectedRevision": "SYNEPOCH1:0"}, RAD)
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        note = self.page.locator("dialog.kin-logout p").first.inner_text()
        self.assertIn("Overwrite Server Draft", note)
        self.assertEqual((other_text, FIELDS, [], "preparing"),
                         (self.site.stored(), self.editor(), self.site.logouts, self.screen()["state"]))
        # No blind retry: time passes and nothing is sent; Retry reads and still refuses to overwrite by itself.
        puts = len(self.site.puts)
        self.page.clock.run_for(65000)
        self.panel_button("Retry").click()
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        self.page.wait_for_timeout(200)
        self.assertEqual((puts, other_text), (len(self.site.puts), self.site.stored()),
                         "the loser was sent again on a new revision without the person's word")
        # The person's one choice: pressing Overwrite Server Draft is the decision (no second confirmation).
        self.panel_button("Overwrite Server Draft").click()
        self.landing()
        self.assertEqual((FIELDS, "SYNEPOCH1:1", []), (self.site.stored(), self.site.puts[-1]["expectedRevision"], self.dialogs))

    # ── S03 / DP-04 / DP-12 ──
    def test_s03_the_session_ending_during_the_preparation_closes_at_once_and_quarantines_the_text(self):
        for cause in ("this session's 401", "another tab's end", "a binding refusal"):
            with self.subTest(cause=cause):
                self.fresh_context()
                self.open_main()
                session = self.site.cookie
                other = self.open_main(self.watch(self.context.new_page())) if cause == "another tab's end" else None
                self.select_and_type()
                self.site.put_answers = ["hold"]
                self.log_out_main()
                self.wait_until(lambda: self.site.held_puts, "the preparation's save")
                route, body, account = self.site.held_puts.pop()
                if cause == "this session's 401":
                    self.site.ended.add(session)
                    self.site.refuse(route, 401, "AUTH_SESSION_ENDED")
                elif cause == "another tab's end":
                    self.log_out_main(other)
                    other.wait_for_url(INDEX_URL)
                else:
                    # The browser's cookie becomes another reader's login; the save is refused by code before any handler.
                    self.site.account = RAD_OTHER
                    self.site.refuse(route, 409, "AUTH_SESSION_MISMATCH")
                expect(self.panel_title()).to_have_text("Session Ended")
                self.assert_closed(f"{cause} while the save is out")
                self.page.wait_for_timeout(300)
                self.assertEqual([], self.docs(name="index.html"), "no move: the text would be lost")
                self.assertEqual(1 if cause == "another tab's end" else 0, len(self.site.logouts),
                                 "this document sends no logout for a session that ended elsewhere or is another login's")
                if cause == "another tab's end":
                    self.site.answer(route, 401, {"code": "AUTH_SESSION_ENDED", "message": "SYN"},
                                     {"X-KIN-Auth-Code": "AUTH_SESSION_ENDED"})
                    self.page.wait_for_timeout(200)
                    self.assert_closed("the late save answer")
                self.assertIsNone(self.site.stored(RAD_OTHER), "nothing is stored under another owner")
                # Recover Draft: no session, then another owner - nothing is written; then the same owner.
                puts = len(self.site.puts)
                self.site.account = None
                self.panel_button("Recover Draft").click()
                expect(self.panel_status()).to_contain_text("로그인한 세션이 없습니다")
                self.site.account = RAD_OTHER
                self.panel_button("Recover Draft").click()
                expect(self.panel_status()).to_contain_text("같은 계정")
                self.assertEqual((puts, None), (len(self.site.puts), self.site.stored(RAD_OTHER)),
                                 "nothing is written for no session or another owner")
                self.site.account = RAD
                recovery = self.site.cookie
                self.panel_button("Recover Draft").click()
                self.page.wait_for_url(INDEX_URL)
                self.assertEqual((FIELDS, puts + 1, owner_of(RAD)),
                                 (self.site.stored(), len(self.site.puts), self.site.puts[-1]["expectedOwner"]))
                self.assertEqual(recovery, self.site.put_sessions[-1], "the recovery is bound to the present login's session")
                self.assertEqual(False, recovery in self.site.ended)

    def test_s03_a_session_that_ends_outside_a_preparation_keeps_unsaved_text_in_this_window(self):
        # No Log out was pressed: the server ends this session (idle, another device) or another document of the session
        # logs out while this one holds text the server does not have. Closing must not lose it.
        for cause in ("the server says the session ended", "another tab's end"):
            with self.subTest(cause=cause):
                self.fresh_context()
                self.open_main()
                session = self.site.cookie
                other = self.open_main(self.watch(self.context.new_page())) if cause == "another tab's end" else None
                self.select_and_type()
                if cause == "another tab's end":
                    self.log_out_main(other)
                    other.wait_for_url(INDEX_URL)
                else:
                    self.site.ended.add(session)
                    self.refresh()
                expect(self.panel_title()).to_have_text("Session Ended")
                self.assert_closed(cause)
                self.page.wait_for_timeout(300)
                self.assertEqual([], self.docs(name="index.html"), "no move: the text would be lost")
                self.assertEqual(1 if other else 0, len(self.site.logouts), "this document sends no logout of its own")
                # The same reader logs in again elsewhere; Recover Draft stores the text and only then leaves.
                self.site.account = RAD
                self.panel_button("Recover Draft").click()
                self.page.wait_for_url(INDEX_URL)
                self.assertEqual((FIELDS, self.site.cookie), (self.site.stored(), self.site.put_sessions[-1]))

    def test_dp05_an_explicit_discard_after_the_session_ended(self):
        self.open_main()
        self.select_and_type()
        self.site.put_answers = ["hold"]
        self.log_out_main()
        self.wait_until(lambda: self.site.held_puts, "the preparation's save")
        self.site.ended.add(self.site.cookie)
        self.site.refuse(self.site.held_puts.pop()[0], 401, "AUTH_SESSION_ENDED")
        expect(self.panel_title()).to_have_text("Session Ended")
        self.dialog_answers = [False]
        self.panel_button("Discard Draft").click()
        self.page.wait_for_timeout(200)
        self.assertEqual([], self.docs(name="index.html"), "a dismissed discard keeps the text")
        self.dialog_answers = [True]
        self.panel_button("Discard Draft").click()
        self.assertEqual((CONFIRMED, False), self.landing())
        self.assertIsNone(self.site.stored())

    def test_dp06_with_nothing_to_write_the_end_follows_at_once(self):
        self.open_main()
        self.page.locator("#rows tr", has_text=PATIENT).first.click()
        expect(self.page.locator("#findings")).to_be_editable()
        self.log_out_main()
        self.assertEqual((CONFIRMED, False), self.landing())
        self.assertEqual(([], 1, []), (self.site.puts, len(self.site.logouts), self.dialogs),
                         "one press, no question, no write")

    def test_dp07_am6_log_out_waits_for_a_save_in_flight_and_goes_on_by_itself(self):
        # A Save is out: its answer changes both the screen and the stored draft, so the text is captured after it. The
        # person is not told to press again - the program waits and continues.
        for outcome in ("the save succeeds", "the save fails", "the person goes back to editing"):
            with self.subTest(save=outcome):
                self.fresh_context()
                self.open_main()
                self.select_and_type()
                self.site.commit_answers = ["hold"]
                self.page.locator("#b-save").click()
                self.wait_until(lambda: self.site.held_commits, "the confirmation request")
                self.assertEqual((owner_of(RAD), "SYNEPOCH1:0"),
                                 (self.site.commits[0]["expectedOwner"], self.site.commits[0]["expectedRevision"]),
                                 "the confirmation carries the draft's owner and revision")
                self.dialogs.clear()
                self.log_out_main()
                expect(self.panel_title()).to_have_text("Logging Out")
                self.page.wait_for_timeout(200)
                # Waiting is not the preparation: work is not paused, nothing is claimed, nothing was sent.
                self.assertEqual(([], [], [], None, "active"), (self.dialogs, self.site.puts, self.site.logouts,
                                                               self.screen()["end"], self.screen()["state"]))
                route = self.site.held_commits.pop()
                if outcome == "the person goes back to editing":
                    self.panel_button("Back to Editing").click()
                    expect(self.page.locator("dialog.kin-logout")).to_have_count(0)
                    self.site.answer(route, 500, {"statusCode": 500, "message": "SYN"})
                    self.page.wait_for_timeout(300)
                    self.assertEqual((FIELDS, [], "active", None), (self.editor(), self.site.logouts,
                                                                   self.screen()["state"], self.screen()["end"]))
                    continue
                if outcome == "the save succeeds":
                    body = self.site.commits[0]
                    self.site.revs[RAD["actor"]] = self.site.revs.get(RAD["actor"], 0) + 1
                    self.site.report = {"version": 1, "rs": "T", **{k: body.get(k, "") for k in FIELDS}}
                    self.site.answer(route, 200, {**self.site.envelope(RAD), "state": self.site.state(RAD)})
                else:
                    self.site.answer(route, 500, {"statusCode": 500, "message": "SYN"})
                self.assertEqual((CONFIRMED, False), self.landing())
                self.assertEqual(1, len(self.site.logouts))
                if outcome == "the save succeeds":
                    self.assertEqual(([], FIELDS["findings"]), (self.site.puts, self.site.report["findings"]),
                                     "the saved report needs no draft write")
                else:
                    self.assertEqual(FIELDS, self.site.stored(), "the text the failed save left is kept as a draft first")
                self.assertEqual([], self.dialogs)

    # ── S04 / DP-03 / DP-09 / DP-10 / DP-11 / DP-13 ──
    CITATIONS, CONTEXT = f"/api/studies/{UID}/report/citations", f"/api/studies/{UID}/clinical-context"
    LATE_CITATIONS = {"version": 0, "draftRevision": "SYNEPOCH1:0", "head": [], "draft": [{
        "v": 2, "cid": "SYN-CID-LATE", "field": "findings", "findingId": "f-0", "findingRevision": 1, "sourceIndex": 0,
        "sourceRef": {"kind": "item", "itemId": "i-0", "sourceRevision": 1}, "linkStateAtInsert": "current",
        "headRevisionAtInsert": None, "insertedText": FIELDS["findings"], "insertedAt": "2026-10-03T00:00:00.000Z",
        "insertedBy": RAD["actor"], "sameTextCount": 1}]}

    def fail_the_save_and_go_back(self):
        """Log out, a refused save, Back to Editing: the preparation is cancelled and the editor is back in use - at
        once, with no request and no question (amendment 6)."""
        self.site.put_answers = [(500, {"statusCode": 500, "message": "SYN"})]
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        calls, dialogs = len(self.site.calls), len(self.dialogs)
        self.panel_button("Back to Editing").click()
        expect(self.page.locator("dialog.kin-logout")).to_have_count(0)
        self.assertEqual("active", self.screen()["state"])
        self.assertEqual(([], dialogs), ([c for c in self.site.calls[calls:] if c == ("GET", "/api/me")], len(self.dialogs)),
                         "going back asks the server nothing and the person nothing")

    def test_s04_cancelling_is_a_new_epoch_answers_from_before_never_apply(self):
        for cut in ("before the headers", "after the headers, before the body", "the request fails"):
            with self.subTest(cut=cut):
                self.fresh_context()
                self.page.clock.install()
                if cut == "after the headers, before the body":
                    self.context.add_init_script(HOLD_BODIES % json.dumps([self.CITATIONS, self.CONTEXT, "/api/studies"]))
                else:
                    self.site.held_gets = {self.CITATIONS: [], self.CONTEXT: []}
                self.open_main()
                self.select_and_type()
                if cut == "after the headers, before the body":
                    # From here on the listed answers arrive (status and headers) but their bodies are held.
                    self.site.gets = {self.CITATIONS: (200, self.LATE_CITATIONS), self.CONTEXT: (200, {"code": "SYN_LATE_PANEL"})}
                    self.page.evaluate("() => { window.__synHoldBodies = true; }")
                    self.page.locator("#clinical-context-refresh").evaluate("button => button.click()")
                else:
                    self.wait_until(lambda: self.site.held_gets[self.CITATIONS] and self.site.held_gets[self.CONTEXT],
                                    "the report and panel reads")
                # A list read is out too.
                if cut == "after the headers, before the body":
                    self.refresh()
                    self.wait_until(lambda: "/api/studies" in self.page.evaluate(
                        "() => window.__synHeldBodies.map(h => h.path)"), "the list body held")
                else:
                    self.site.held_lists = []
                    self.refresh()
                    self.wait_until(lambda: self.site.held_lists, "the list read")
                rows, panel = self.page.locator("#rows").inner_text(), self.page.locator("#clinical-context").inner_text()
                bar = self.page.locator("#citebar").inner_text()
                self.fail_the_save_and_go_back()
                self.assertEqual(("active", FIELDS), (self.screen()["state"], self.editor()))
                # The reads were made again for the new epoch; let them answer plainly.
                self.page.wait_for_timeout(300)
                now = (self.page.locator("#rows").inner_text(), self.page.locator("#clinical-context").inner_text())
                # Now the answers from before the preparation arrive: success and failure alike apply nothing.
                if cut == "before the headers":
                    route, account = self.site.held_lists.pop(0)
                    self.site.held_lists = None
                    self.site.answer(route, 200, self.site.list_body(account, rename="SYN PATIENT LATE"))
                    self.site.answer(self.site.held_gets[self.CITATIONS].pop(0), 200, self.LATE_CITATIONS)
                    self.site.answer(self.site.held_gets[self.CONTEXT].pop(0), 200, {"code": "SYN_LATE_PANEL"})
                elif cut == "the request fails":
                    route, account = self.site.held_lists.pop(0)
                    self.site.held_lists = None
                    for held in (route, self.site.held_gets[self.CITATIONS].pop(0), self.site.held_gets[self.CONTEXT].pop(0)):
                        held.abort("connectionreset")
                else:
                    self.page.evaluate("""() => window.__synHeldBodies.filter(h => !h.done).forEach((h, i) => {
                      h.done = true; (i % 2 ? h.fail : h.release)(); })""")
                self.page.wait_for_timeout(400)
                seen = self.screen()
                self.assertNotIn("LATE", seen["text"])
                self.assertNotIn("SYN body stream failed", seen["text"])
                self.assertNotIn("검사 목록 실패", self.page.locator("#toast").inner_text())
                self.assertNotIn("관측 불가", self.page.locator("#rows").inner_text())
                self.assertEqual(now[0], self.page.locator("#rows").inner_text(), "a late list answer changed the list")
                self.assertEqual((FIELDS, "active", RAD["sub"]), (self.editor(), seen["state"], seen["identity"]["sub"]))
                # The viewers were told to pause, then to resume - and never that the session ended.
                self.assertEqual(["session-preparing", "session-resumed"], [post["type"] for post in self.posts()])
                preparing, resumed = self.posts()
                self.assertIsInstance(preparing["preparation"], str)
                self.assertTrue(preparing["preparation"].strip(), "preparation is a non-empty opaque id")
                self.assertEqual(preparing["preparation"], resumed["preparation"])
                self.assertEqual([self.site.cookie, self.site.cookie], [post["session"] for post in self.posts()])
                # The next save keeps what the server's draft has, not the ids a late citation answer would have named.
                self.page.fill("#findings", "SYN-FINDINGS after Back to Editing")
                puts = len(self.site.puts)
                self.page.clock.run_for(21000)
                self.wait_until(lambda: len(self.site.puts) == puts + 1, "the autosave after Back to Editing")
                self.assertEqual(([], "SYN-FINDINGS after Back to Editing"),
                                 (self.site.puts[-1]["citationIds"], self.site.stored()["findings"]))
                self.assertEqual(([], None), (self.site.logouts, self.screen()["end"]))
                del rows, panel, bar

    def test_dp03_back_to_editing_and_an_explicit_discard(self):
        self.open_main()
        self.select_and_type()
        self.fail_the_save_and_go_back()
        self.assertEqual((FIELDS, [], None, "active"), (self.editor(), self.site.logouts, self.screen()["end"], self.screen()["state"]))
        # Log out again; the write fails again; a dismissed discard keeps it, a confirmed one ends without a write.
        self.site.put_answers = [(500, {"statusCode": 500, "message": "SYN"})] * 3
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        self.dialog_answers = [False]
        self.panel_button("Discard and Log Out").click()
        self.page.wait_for_timeout(200)
        self.assertEqual([], self.site.logouts)
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        puts = len(self.site.puts)
        self.dialog_answers = [True]
        self.panel_button("Discard and Log Out").click()
        self.landing()
        self.assertEqual((puts, 1), (len(self.site.puts), len(self.site.logouts)), "no write after the discard")

    def test_dp10_am7_a_slow_autosave_under_the_preparation_is_settled_without_asking_after_back_to_editing(self):
        self.page.clock.install()
        self.open_main()
        self.select_and_type()
        # An autosave is out when Log out starts: the preparation waits behind it (commands of one study go in order).
        self.site.put_answers = ["hold", (500, {"statusCode": 500, "message": "SYN"})]
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.held_puts, "the autosave")
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Saving Draft")
        # The autosave's deadline passes and the confirming reads do not find it; the preparation's own save is refused.
        self.page.clock.run_for(15000)
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        self.assertEqual(([], None), (self.site.logouts, self.screen()["end"]))
        # The server stores that autosave after all. Back to Editing returns at once - no request, no question.
        self.assertEqual(200, self.site.finish_put())
        calls = len(self.site.calls)
        self.panel_button("Back to Editing").click()
        expect(self.page.locator("dialog.kin-logout")).to_have_count(0)
        self.assertEqual(([], FIELDS, "active"), ([c for c in self.site.calls[calls:] if c[0] != "GET" or c[1] == "/api/me"],
                                                  self.editor(), self.screen()["state"]),
                         "no session check and no write: only the panels' own reads start again")
        # New typing meets the late autosave on the server: the stored text is this document's own, so the program moves
        # the base and saves - no conflict bar, no failure notice, no click (amendment 7).
        self.page.fill("#findings", "SYN-FINDINGS typed after Back to Editing")
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.stored()["findings"] == "SYN-FINDINGS typed after Back to Editing",
                        "the autosave after Back to Editing")
        self.assertEqual("SYNEPOCH1:1", self.site.puts[-1]["expectedRevision"])
        expect(self.page.locator("#b-draft-keep")).to_be_hidden()
        self.assertNotIn("저장하지 않았습니다", self.page.locator("#toast").inner_text())
        self.assertNotIn("서버 저장 실패", self.page.locator("#toast").inner_text())
        self.page.clock.run_for(31000)      # past the next list poll, which redraws the draft bar from the stored state
        expect(self.page.locator("#draftmsg")).to_contain_text("자동 저장됨")
        self.assertEqual(([], None, []), (self.site.logouts, self.screen()["end"], self.dialogs))

    def test_dp11_am6_back_to_editing_asks_nothing_and_a_session_that_ended_meanwhile_keeps_the_text(self):
        for label in ("the server is unreachable", "the session ended meanwhile"):
            with self.subTest(session=label):
                self.fresh_context()
                self.page.clock.install()
                self.open_main()
                session = self.site.cookie
                self.select_and_type()
                self.site.put_answers = ["abort"]
                self.site.draft_read_answers = ["abort"]
                self.log_out_main()
                expect(self.panel_title()).to_have_text("Draft Not Saved")
                if label == "the session ended meanwhile":
                    self.site.ended.add(session)
                calls = len(self.site.calls)
                self.panel_button("Back to Editing").click()
                if label == "the server is unreachable":
                    # Even with the server out of reach the person is back in the editor with the text as it was.
                    expect(self.page.locator("dialog.kin-logout")).to_have_count(0)
                    self.assertEqual(([], FIELDS, "active", []),
                                     ([c for c in self.site.calls[calls:] if c[0] != "GET" or c[1] == "/api/me"], self.editor(),
                                      self.screen()["state"], self.site.logouts))
                    continue
                # Going back asked nothing; the reads that start again learn from the server that this session ended: the
                # screen closes and the text is kept in this window.
                expect(self.panel_title()).to_have_text("Session Ended")
                self.assertEqual([], [c for c in self.site.calls[calls:] if c == ("GET", "/api/me")])
                self.assert_closed("the end learned after Back to Editing")
                self.page.wait_for_timeout(300)
                self.assertEqual(([], []), (self.docs(name="index.html"), self.site.logouts))
                self.site.account = RAD
                self.panel_button("Recover Draft").click()
                self.page.wait_for_url(INDEX_URL)
                self.assertEqual(FIELDS, self.site.stored())

    # ── S10 / DP-14 / DP-15 / D12 ──
    def end_during_the_preparation(self, earlier):
        """An autosave of the typed text leaves (`earlier`: "hold" keeps it out, "cut" drops the browser's connection
        while the server still has it to finish); more is typed; Log out; the session ends during the preparation."""
        self.fresh_context()
        self.page.clock.install()
        self.open_main()
        self.select_and_type()
        self.site.put_answers = [earlier]
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.puts, "the earlier draft write")
        for name, value in MORE.items():
            self.page.fill("#" + name, value)
        self.site.ended.add(self.site.cookie)
        self.log_out_main()
        if earlier == "hold":
            # The preparation waits behind the write that is out; that write meets the ended session.
            expect(self.panel_title()).to_have_text("Saving Draft")
            self.site.refuse(self.site.held_puts.pop()[0], 401, "AUTH_SESSION_ENDED")
        expect(self.panel_title()).to_have_text("Session Ended")
        self.assert_closed("the session ended during the preparation")

    def test_s10_recover_draft_discards_the_capture_only_on_an_exact_match(self):
        for label, answer in (("stored and answered whole", "ok"), ("stored, the answer lost, the read fails", "lost"),
                              ("stored, a 200 without the envelope, the read fails", "partial"),
                              ("refused 500", (500, {"statusCode": 500, "message": "SYN"})),
                              ("the connection dropped before the server", "abort")):
            with self.subTest(recovery=label):
                self.end_during_the_preparation("cut")
                self.assertEqual(200, self.site.finish_cut(), "the cut-off autosave finished on the server before the recovery")
                self.site.account = RAD
                self.site.put_answers = [answer]
                if answer in ("lost", "partial"):
                    # The read before the write answers; the read that should confirm the lost answer fails.
                    self.site.draft_read_answers = [(200, self.site.envelope(RAD)), "abort"]
                self.panel_button("Recover Draft").click()
                if answer == "ok":
                    self.page.wait_for_url(INDEX_URL)
                    self.assertEqual((MORE, "SYNEPOCH1:1"), (self.site.stored(), self.site.puts[-1]["expectedRevision"]))
                    continue
                # Not declared: the capture stays in this window, nothing moves.
                expect(self.panel_status()).to_contain_text("그대로 있습니다")
                self.page.wait_for_timeout(300)
                expect(self.panel_title()).to_have_text("Session Ended")
                self.assertEqual([], self.docs(name="index.html"))
                self.assert_closed("the recovery kept undeclared")
                self.assertEqual(0, self.site.count("POST", f"/api/studies/{UID}/report/commit"))
                # Another press reads the stored draft: where the capture is there whole it is disposed of without a second
                # write; where it is not, it is written on the revision the read showed.
                puts = len(self.site.puts)
                self.panel_button("Recover Draft").click()
                self.page.wait_for_url(INDEX_URL)
                self.assertEqual(MORE, self.site.stored())
                self.assertEqual(puts if answer in ("lost", "partial") else puts + 1, len(self.site.puts))

    def test_s10_d12_a_differing_owner_or_snapshot_retains_the_capture(self):
        self.end_during_the_preparation("hold")
        # Another reader's login: the capture is neither shown nor stored.
        self.site.account = RAD_OTHER
        self.panel_button("Recover Draft").click()
        expect(self.panel_status()).to_contain_text("같은 계정")
        self.assertEqual((None, None), (self.site.stored(RAD_OTHER), self.site.stored()))
        self.assert_closed("another owner's login")
        # The same reader again, but the stored draft is something else by now (another document wrote it): a conflict.
        self.site.account = RAD
        other_text = {"findings": "SYN-OTHER-TAB findings", "conclusion": "", "recommendation": ""}
        self.site.write({**other_text, "baseVersion": 0, "citationIds": [], "structureIds": [], "expectedOwner": owner_of(RAD),
                         "expectedRevision": self.site.revision(RAD["actor"])}, RAD)
        self.panel_button("Recover Draft").click()
        expect(self.panel_status()).to_contain_text("Overwrite Server Draft")
        self.page.wait_for_timeout(300)
        self.assertEqual((other_text, []), (self.site.stored(), self.docs(name="index.html")),
                         "the capture was written over another draft without the person's word")
        expect(self.panel_title()).to_have_text("Session Ended")
        # Recover Draft again does not overwrite either (and sends no write); only the explicit control does - one press.
        puts = len(self.site.puts)
        self.panel_button("Recover Draft").click()
        expect(self.panel_status()).to_contain_text("Overwrite Server Draft")
        self.assertEqual((other_text, puts), (self.site.stored(), len(self.site.puts)))
        self.dialogs.clear()
        self.panel_button("Overwrite Server Draft").click()
        self.page.wait_for_url(INDEX_URL)
        self.assertEqual((MORE, []), (self.site.stored(), self.dialogs))

    def test_dp15_d12_a_cut_off_write_finishing_late_never_replaces_the_recovery(self):
        for order in ("the cut-off write finishes after the recovery", "the cut-off write finishes before the recovery"):
            with self.subTest(order=order):
                self.end_during_the_preparation("cut")
                if order == "the cut-off write finishes before the recovery":
                    self.assertEqual(200, self.site.finish_cut())
                    self.assertEqual(FIELDS, self.site.stored(), "the server finished the earlier write first")
                self.site.account = RAD
                self.panel_button("Recover Draft").click()
                self.page.wait_for_url(INDEX_URL)
                self.assertEqual(MORE, self.site.stored())
                if order == "the cut-off write finishes after the recovery":
                    # The server reaches the cut-off write only now: its revision is gone, the recovery stays.
                    self.assertEqual(409, self.site.finish_cut())
                    self.assertEqual(MORE, self.site.stored(), "the cut-off write replaced the recovery")
                self.assertEqual(0, self.site.count("POST", f"/api/studies/{UID}/report/commit"))

    def test_dp15_d12_a_cut_off_autosave_never_replaces_the_preparation_save(self):
        self.page.clock.install()
        self.open_main()
        self.select_and_type()
        self.site.put_answers = ["cut"]
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.cut_puts, "the autosave whose connection is cut")
        for name, value in MORE.items():
            self.page.fill("#" + name, value)
        # Log out: the preparation reads the stored draft (the cut-off write is not there), saves and ends.
        self.log_out_main()
        self.assertEqual((CONFIRMED, False), self.landing())
        self.assertEqual((2, MORE), (len(self.site.puts), self.site.stored()))
        # The server reaches the cut-off autosave after the page has gone: refused, the draft stays what Log out saved.
        self.assertEqual(409, self.site.finish_cut())
        self.assertEqual(MORE, self.site.stored(), "the cut-off autosave replaced the draft Log out saved")

    def test_dp15_d02_a_cut_off_autosave_never_replaces_the_next_autosave(self):
        # Typing and the page clock only (U5S-REQ-25): two autosaves of one page, the first one's connection cut.
        self.page.clock.install()
        self.open_main()
        self.select_and_type()
        self.site.put_answers = ["cut"]
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.cut_puts, "the autosave whose connection is cut")
        self.page.fill("#findings", "SYN-FINDINGS typed after the cut")
        self.page.clock.run_for(21000)
        self.wait_until(lambda: (self.site.stored() or {}).get("findings") == "SYN-FINDINGS typed after the cut",
                        "the next autosave stored")
        self.assertEqual(409, self.site.finish_cut())
        self.assertEqual("SYN-FINDINGS typed after the cut", self.site.stored()["findings"],
                         "the cut-off autosave replaced the next one")
        self.assertEqual(([], None, "active"), (self.site.logouts, self.screen()["end"], self.screen()["state"]))
        # The other order: the earlier write lands first, and the next autosave goes on from the revision it made.
        self.site.put_answers = ["cut"]
        self.page.fill("#findings", "SYN-FINDINGS cut again")
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.cut_puts, "the second cut-off autosave")
        self.assertEqual(200, self.site.finish_cut())
        self.page.fill("#findings", "SYN-FINDINGS the last word")
        self.page.clock.run_for(21000)
        self.wait_until(lambda: (self.site.stored() or {}).get("findings") == "SYN-FINDINGS the last word",
                        "the autosave after the earlier one landed")
        self.assertNotIn("서버 저장 실패", self.page.locator("#toast").inner_text())

    def two_documents_autosave(self, second_fields):
        """Two documents of one reader on the same study, both with unsaved text. The context's one clock runs both, so
        both autosaves leave on the same tick with the same starting revision; the server takes one of them first."""
        self.page.clock.install()
        first = self.open_main()
        second = self.open_main(self.watch(self.context.new_page()))
        self.select_and_type(first)
        self.select_and_type(second, fields=second_fields)
        first.clock.run_for(21000)
        self.wait_until(lambda: len(self.site.puts) == 2, "both documents' autosaves")
        self.assertEqual(["SYNEPOCH1:0", "SYNEPOCH1:0"], [put["expectedRevision"] for put in self.site.puts])
        return first, second

    def test_d01_two_documents_on_the_same_revision_the_loser_keeps_its_text_and_is_not_saved(self):
        other = {"findings": "SYN-SECOND-TAB findings", "conclusion": "", "recommendation": ""}
        first, second = self.two_documents_autosave(other)
        self.wait_until(lambda: self.site.stored() in (FIELDS, other), "the winner's draft")
        winner, loser, lost = (first, second, other) if self.site.stored() == FIELDS else (second, first, FIELDS)
        stored = self.site.stored()
        # The loser: nothing stored, nothing claimed, the text kept, and no further write by itself.
        expect(loser.locator("#draftmsg")).to_contain_text("서버의 초안이 이 화면과 다릅니다")
        self.assertEqual((stored, lost), (self.site.stored(), self.editor(loser)))
        self.assertNotIn("자동 저장됨", loser.locator("#draftmsg").inner_text())
        expect(winner.locator("#b-draft-keep")).to_be_hidden()
        loser.clock.run_for(65000)
        self.assertEqual((2, stored), (len(self.site.puts), self.site.stored()), "the loser was sent again by itself")
        # The person chooses once: keep this text (overwrite) - the press is the decision, one write on the revision read.
        loser.locator("#b-draft-keep").click()
        self.wait_until(lambda: self.site.stored() == lost, "the person's overwrite", page=loser)
        self.assertEqual(("SYNEPOCH1:1", []), (self.site.puts[-1]["expectedRevision"], self.dialogs))
        expect(loser.locator("#b-draft-keep")).to_be_hidden()

    def test_d01_am7_the_same_content_in_two_documents_converges_without_a_question(self):
        first, second = self.two_documents_autosave(FIELDS)     # the same text in both documents
        # The server refused one of them for its revision; the program read the stored draft and found the same text:
        # nothing to ask in either document, and nothing sent again.
        first.clock.run_for(31000)          # past the list poll, which redraws the draft bars from the stored state
        for page in (first, second):
            expect(page.locator("#draftmsg")).to_contain_text("자동 저장됨")
            expect(page.locator("#b-draft-keep")).to_be_hidden()
            self.assertNotIn("저장하지 않았습니다", page.locator("#toast").inner_text())
            self.assertEqual(0, self.panel_title(page).count())
        self.assertEqual((2, FIELDS, []), (len(self.site.puts), self.site.stored(), self.dialogs),
                         "no further write, no dialog: the documents converged")
        # And the refused document goes on from the stored revision: its next edit is saved without a conflict.
        second.fill("#findings", "SYN-FINDINGS and more in the second document")
        second.clock.run_for(21000)
        self.wait_until(lambda: self.site.stored()["findings"] == "SYN-FINDINGS and more in the second document",
                        "the second document's next autosave", page=second)
        self.assertEqual("SYNEPOCH1:1", self.site.puts[-1]["expectedRevision"])

    def test_d07_am8_a_lost_or_malformed_answer_is_confirmed_by_a_read_before_anyone_is_told(self):
        for answer in ("lost", "partial"):
            for reading in ("the read finds it stored", "the read fails too"):
                with self.subTest(answer=answer, reading=reading):
                    self.fresh_context()
                    self.page.clock.install()
                    self.open_main()
                    self.select_and_type()
                    self.site.put_answers = [answer]
                    if reading == "the read fails too":
                        self.site.draft_read_answers = ["abort"]
                    reads = len(self.site.draft_reads)
                    self.page.clock.run_for(21000)
                    self.wait_until(lambda: len(self.site.draft_reads) == reads + 1, "the confirming read")
                    self.assertEqual(FIELDS, self.site.stored())
                    if reading == "the read finds it stored":
                        # Saved, and nobody is told anything: no failure notice, no window, no second write.
                        self.page.wait_for_timeout(200)
                        self.assertNotIn("확인하지 못했습니다", self.page.locator("#toast").inner_text())
                        self.assertEqual(0, self.panel_title().count())
                        self.page.clock.run_for(21000)      # past the list poll, which redraws the draft bar
                        expect(self.page.locator("#draftmsg")).to_contain_text("자동 저장됨")
                        self.assertEqual(1, len(self.site.puts), "nothing is written again")
                        continue
                    # Not confirmed: not shown as saved, one line says so, and nothing is re-sent by itself.
                    expect(self.page.locator("#toast")).to_contain_text("확인하지 못했습니다")
                    self.assertNotIn("자동 저장됨", self.page.locator("#draftmsg").inner_text())
                    self.assertEqual(0, self.panel_title().count(), "one line, not a window")
                    # The next autosave first reads the stored draft and finds its own write there whole: the save is
                    # confirmed by that read, and no second write is sent.
                    self.page.clock.run_for(21000)
                    self.wait_until(lambda: len(self.site.draft_reads) == reads + 2, "the read before the next save")
                    expect(self.page.locator("#draftmsg")).to_contain_text("자동 저장됨")
                    self.assertEqual(1, len(self.site.puts), "the write was never sent again")

    def test_d07_am8_a_slow_save_past_its_deadline_is_not_a_failure_and_never_ends_the_session(self):
        self.page.clock.install()
        self.open_main()
        self.select_and_type()
        self.site.put_answers = ["hold"]
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.held_puts, "the autosave")
        reads = len(self.site.draft_reads)
        # 10 s pass without an answer: the program reads (the write is not there yet); the server then finishes it, and
        # the second, later read finds it. Nothing was re-sent and nobody was told anything.
        self.page.clock.run_for(10500)
        self.wait_until(lambda: len(self.site.draft_reads) == reads + 1, "the first confirming read")
        self.assertEqual(200, self.site.finish_put())
        self.page.clock.run_for(3500)
        self.wait_until(lambda: len(self.site.draft_reads) == reads + 2, "the second confirming read")
        expect(self.page.locator("#draftmsg")).to_contain_text("자동 저장됨")
        self.assertNotIn("확인하지 못했습니다", self.page.locator("#toast").inner_text())
        seen = self.screen()
        self.assertEqual(("active", RAD["sub"], None, FIELDS, 1, []),
                         (seen["state"], seen["identity"]["sub"], seen["end"], self.editor(), len(self.site.puts), self.site.logouts))

    # ── U5S-REQ-24 / S04: the cuts of other completions (clipboard, decoded body, error/finally), and A -> B -> A ──
    def test_s04_cut_a_clipboard_read_finishing_after_the_text_changed_or_a_b_a_writes_nothing(self):
        self.site.second_study = True
        self.context.add_init_script(CLIPBOARD)
        self.fresh_page = self.watch(self.context.new_page())
        page = self.open_main(self.fresh_page)
        self.select_and_type(page)
        paste = lambda text: page.evaluate("text => window.__synClipboard.reads.splice(0).forEach(r => r.resolve(text))", text)
        # Paste sits in the report toolbar's More menu: the menu is opened, then the control pressed.
        def press():
            if not page.locator("#b-paste").is_visible():
                page.locator("#report-more > summary").click()
            page.locator("#b-paste").click()
        # Control: with nothing in between, the paste lands.
        press()
        paste(" SYN-PASTED")
        expect(page.locator("#findings")).to_have_value(FIELDS["findings"] + " SYN-PASTED")
        # The person types while the clipboard is read: the late text is not appended over what they typed.
        press()
        page.fill("#findings", "SYN typed while the clipboard was read")
        paste(" SYN-LATE-PASTE")
        page.wait_for_timeout(200)
        self.assertEqual("SYN typed while the clipboard was read", page.locator("#findings").input_value())
        # The study changes while the clipboard is read (A -> B -> A): the second A is not the first A's selection, and
        # nothing lands in either study.
        press()
        page.locator("#rows tr", has_text=PATIENT_B).first.click()
        expect(page.locator("#clinical")).to_contain_text(PATIENT_B)
        page.locator("#rows tr", has_text=PATIENT).first.click()
        expect(page.locator("#clinical")).to_contain_text(PATIENT)
        paste(" SYN-LATE-PASTE")
        page.wait_for_timeout(200)
        self.assertNotIn("SYN-LATE-PASTE", " ".join(self.editor(page).values()))
        # Log out with the read still out, then Back to Editing: the paste from before the preparation does not land.
        page.fill("#conclusion", "SYN typed before the preparation")
        press()
        self.site.put_answers = [(500, {"statusCode": 500, "message": "SYN"})]
        self.log_out_main(page)
        expect(self.panel_title(page)).to_have_text("Draft Not Saved")
        self.panel_button("Back to Editing", page).click()
        expect(page.locator("dialog.kin-logout")).to_have_count(0)
        before = self.editor(page)
        paste(" SYN-LATE-PASTE")
        page.wait_for_timeout(200)
        self.assertEqual(before, self.editor(page))

    def test_cut_the_patient_id_copy_finishing_after_the_end_paints_nothing(self):
        self.context.add_init_script(CLIPBOARD)
        page = self.open_main(self.watch(self.context.new_page()))
        page.locator("#rows tr", has_text=PATIENT).first.click()
        expect(page.locator("#copy-patient-id")).to_be_enabled()
        page.locator("#copy-patient-id").click()
        self.wait_until(lambda: page.evaluate("() => window.__synClipboard.written.length") == 1, "the clipboard write", page=page)
        self.site.logout_answers = ["hold"]
        self.log_out_main(page)
        self.wait_until(lambda: self.site.held_logouts, "POST /api/auth/logout", page=page)
        # The write settles (success, then a second one failing) after the session ended: no status line is painted.
        page.evaluate("() => window.__synClipboard.written.splice(0).forEach(w => w.resolve())")
        page.wait_for_timeout(200)
        self.assertEqual("", page.locator("#copy-patient-status").inner_text())
        self.assert_closed("the clipboard completion after the end", page)
        self.release_logout(204)
        self.landing(page)


    def check_note_after_cancel(self, stored):
        page = self.open_main()
        self.select_and_type()
        note = {"studyUid": UID, "version": 1, "text": "SYN saved note", "reason": "", "author": RAD["actor"], "createdAt": "2026-10-05T00:00:00Z"}
        held, reads, writes = [], [], []
        def answer(route):
            request = route.request
            self.assertEqual(self.site.cookie, request.headers.get("x-kin-session"))
            if request.method == "GET":
                reads.append(note["version"])
                return route.fulfill(json={"uid": UID, "writable": True, "note": dict(note)})
            body = request.post_data_json
            writes.append(body)
            self.assertEqual(note["version"], body["baseVersion"], "the next Save uses the reconciled version")
            if len(writes) == 1:
                if stored:
                    note.update(version=note["version"] + 1, text=body["text"], reason=body["reason"].strip())
                held.append(route)
            else:
                note.update(version=note["version"] + 1, text=body["text"], reason=body["reason"].strip())
                route.fulfill(json={"uid": UID, "writable": True, "note": dict(note)})
        page.route("**/api/studies/*/tech-note", answer)
        page.locator("#tech-note-open").click()
        expect(page.locator("#tech-note-text")).to_have_value("SYN saved note")
        page.fill("#tech-note-text", "SYN note before preparation")
        page.fill("#tech-note-reason", "  SYN correction  ")
        page.locator("#tech-note-save").click()
        self.wait_until(lambda: bool(held), "the overlapping note save")
        self.site.put_answers = [(500, {"message": "SYN draft unavailable"})]
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        self.panel_button("Back to Editing").click()
        expect(page.locator("dialog.kin-logout")).to_have_count(0)
        expect(page.locator("#tech-note-save")).to_be_disabled()
        held.pop().fulfill(status=200 if stored else 503,
                           json={"uid": UID, "writable": True, "note": dict(note)} if stored else {"message": "SYN not stored"})
        self.wait_until(lambda: len(reads) == 2, "the automatic note confirmation")
        expect(page.locator("#tech-note-status")).to_have_text(
            "저장되었습니다. v2" if stored else "저장되지 않았습니다 · 입력은 유지했습니다. 다시 Save Note를 누르세요.")
        expect(page.locator("#tech-note-text")).to_have_value("SYN note before preparation")
        expect(page.locator("#tech-note-reason")).to_have_value("" if stored else "  SYN correction  ")
        expect(page.locator("#tech-note-save")).to_be_enabled()
        if stored:
            page.fill("#tech-note-text", "SYN next edit")
            page.fill("#tech-note-reason", "SYN next correction")
        page.locator("#tech-note-save").click()
        expect(page.locator("#tech-note-status")).to_contain_text("저장되었습니다")
        self.assertEqual(2, len(writes))
        self.assertEqual([], self.site.logouts)
        self.assertEqual(FIELDS, self.editor())

    def test_note_stored_across_cancel_confirms_itself_before_the_next_save(self):
        self.check_note_after_cancel(True)

    def test_note_not_stored_across_cancel_keeps_input_and_the_next_save_works(self):
        self.check_note_after_cancel(False)


def tearDownModule():
    print("S7-U5-LOGOUT-DOM-SERVED " + json.dumps(sorted(SERVED)))
    print("S7-U5-LOGOUT-DOM-UNBOUND " + json.dumps(sorted(UNBOUND)))


UNBOUND = set()


if __name__ == "__main__":
    unittest.main(verbosity=2)
