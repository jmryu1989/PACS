# coding: utf-8
"""REQ-S7-U2a-RECIPIENT-LIST / REQ-S7-U2a-EXPLICIT-ACK / REQ-S7-U2a-WORDING
-> RISK-S7-U2a-FALSE-ACK-UI / RISK-S7-U2a-STALE / RISK-S7-U2a-BADGE-LEAK / RISK-S7-U2a-GUARD-WEAKENED /
   RISK-S7-U2a-BODY-SUBSTITUTE / RISK-S7-U1p-FALSE-ACK / RISK-S7-U1p-FALSE-UNDELIVERED
-> TEST-S7-U2a-DOM (contract S7-U1p §2.3 RD01-RD10, §3.3, §5.3, §6.1-§6.2, §8.1, §13, §16.2, §16.3, §17).

The critical result (CVR) recipient screens: the Critical Results region of Clinician Home (the shipped clinician.html,
clinician.js, auth.js and critical-result-inbox.js, booted as shipped) and the Critical Results panel of the reading screen
(main.html's own markup and styles with the page script stripped, the shipped critical-result-inbox.js and main.html's
S7-U2a block cut out as is, over stand-ins for the names that block reads). Both run from a synthetic origin against an
in-test server that keeps the S7-U1a rules the screens rely on (critical-result.service.ts / critical-result-policy.ts: the
received list with its own `pending` count, full and stub recipient views by case, one record read, the ACK's exact body
keys, expectedOwner, per-request receipts that replay the stored `applied`, terminal codes with `replacedBy`, revision).
Cases assert what a user sees and what reaches the server - names, states, contract sentences, Korean explanations, which
requests are sent and their bytes - never the file's internals. Every case ends by checking that no inbox value (record id,
cursor, the requestIds the page sent, the markers put in messages, bodies, reasons and sender names) is in any write to
the origin's storage or in what the origin's storage holds (contract §13's writes that are not there; scenario S-11).

  rd01 C2: message, From, Sent, identity, Source line and the pinned body from the answer; one Acknowledge; one read.
  rd02 C3 stub: Source Changed and the contract sentence, no message / version / body, and nothing more is read, also
       when the same study's report is open in Studies.
  rd03 C4 stub, the same whatever the reason.       rd04 C5: the row leaves after Refresh, the badge is the server's.
  rd05 only the click posts; Acknowledged {time} is the 201's server time; nothing before it; one POST per click.
  rd06 cancel or supersede first: the refusal, the server state and Open Replacement; the replacement acknowledged.
  rd07 the badge is the server `pending`.
  rd08 late answers, log out, another tab, account change, the storage observer, inbox values never stored, and the
       product's session-end signal.
  rd09 the reading panel's R3/R4 full rows: the contract sentence and the pinned body, no Acknowledge.
  rd10 unknown outcomes, Check Again with the same bytes, and how they end.
  rx11 the 60 s read changes nothing.  rx12 empty, Show All, More, terminal rows.  rx13 confirmed refusals by code.
  rx14 the reading panel's R2 ACK, roles and session end.  rx15 wording, fonts, targets, keyboard, external strings.
  rx16 sessions that never read.  rx17 read failures are failures.  rx18 the panel's summary line, history and one bar.
  rx19 server changes apply under focus and focus lands safely.
  rx20-rx23 (Astra S7-U2a-R-001 F01-F04, each with its counterexample and the preserved normal order): a row shows the
       newest valid recipient projection - newest by when its request was sent, not when the answer came - and the page's
       ACK results only add Acknowledged and the server time to it. rx20 the record read after Check Again sets the row
       (terminal, stub, full current:false) on both hosts; rx21 a late record read loses to a later list, a later read of
       the same record, Refresh and Show All; rx22 a row opened outside the list goes on exclusion by a list that covers it,
       a refused read or a failed list, not on a page boundary or a filter that does not hold its state; rx23 a 201 or a
       replayed receipt brings back no message, version or body.

Synthetic data only (SYN-* names): no server, no network, no credentials. A request the harness does not answer is
aborted and fails the case.
"""
import copy
import json
import re
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright

from clinician_home_dom_test import ACKNOWLEDGED, AVOIDED, BROADCAST_ENDED, CLOSED_VIEW, PAGE_TEXT, acknowledgement_outside
from critical_result_sender_dom_test import has_hangul, page_html, slice_between

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
INBOX = "critical-result-inbox.js"


def lf_text(path):
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


MAIN = lf_text(HPACS / "main.html")
INBOX_JS = lf_text(HPACS / INBOX)
HOME_FILES = {name: lf_text(HPACS / name) for name in ("clinician.html", "clinician.js", "auth.js", INBOX)}
ORIGIN = "https://recipient.test"
BASE = "/worklist/hpacs-lite/"

# main.html's S7-U2a block (the mount), run as the page runs it. tests/clinician_question_dom_test.py test_18d cuts the same
# block out of its tagged page.
BLOCK_MARKS = ("    // ── 중요 결과 수신(S7-U2a) ──", "    // ── 중요 결과 발신(S7-U1b) ──")
BLOCK = slice_between(MAIN, *BLOCK_MARKS)
# The names the block reads from the page script, as stand-ins. synBoot is what main.html's boot does after the block has
# run: KinAuth.init() gives the session and goOnline() connects the server. test_18d replaces the logout line.
PRELUDE = """
const API = location.origin + '/api';
let sess = window.synSession, serverMode = !!window.synMode.serverMode, demoMode = !!window.synMode.demoMode;
let offline = !!window.synMode.offline, selectedUid = null;
const toast = (message, kind) => { window.synToasts.push([message, kind]); };
const KinAuth = {
  session: () => window.synSession,
  logout: async () => { window.synLogouts += 1; },
};
window.synBoot = session => { window.synSession = session; sess = session; serverMode = true; offline = false; };
window.synPick = uid => { selectedUid = uid; };
"""
# The page's other areas in its end list (window.kinOn401): what each call told them.
TAIL = """
window.synOtherEnds = [];
(window.kinOn401 = window.kinOn401 || []).push(reason => { window.synOtherEnds.push(reason || 'end'); });
"""
SETUP = """(v) => { window.synSession = v.session; window.synMode = v.mode; window.synToasts = []; window.synLogouts = 0; }"""

INSTITUTION = "SYN-INST-A"
CLIN = {"sub": "c1a2b3c4-0000-4000-8000-00000000c11a", "actor": "syn-clinician@kin", "name": "SYN Clinician"}
CLIN_B = {"sub": "c1a2b3c4-0000-4000-8000-00000000c11b", "actor": "syn-clinician-b@kin", "name": "SYN Clinician B"}
RAD = {"sub": "a1b2c3d4-0000-4000-8000-0000000000ad", "actor": "syn-rad2@kin", "name": "SYN Reader"}
OTHER_OWNER = [INSTITUTION, "e7e7e7e7-0000-4000-8000-0000000000e7"]
PREFIX = "1.2.826.0.1.3680043.10.7702"
T0 = datetime(2026, 9, 28, 1, 0, tzinfo=timezone.utc)
# The server's clock and the browser's differ, so a time on screen shows which clock it came from.
SERVER_NOW = "2026-09-28T03:15:00.000Z"
BROWSER_TIME = "2030-05-05T05:05:00Z"

# Contract wording (S7-U1p §16.2, §17 with the parenthesised internal ids removed - OP-2, D128).
STUB_SENTENCE = "판독이 바뀌어 발신자의 대체 또는 취소를 기다립니다. 확인할 수 없습니다."
UNKNOWN_SENTENCE = "확인이 저장되었는지 확인하지 못했습니다. Check Again으로 확인하세요."
UNKNOWN_WORD = "Acknowledgement status unknown"
LATER = "지금 다시 보내면 거절되는 이유"
LIMITS = [
    "발신자는 수신자가 '아직 열지 않음'과 '열었지만 확인하지 않음'을 구분할 수 없다. 둘 다 Pending ACK로 보인다.",
    "수신자는 KIN 화면을 열고 있을 때만 알 수 있다(열기·Refresh·열려 있는 동안 주기 갱신). 메일·문자·푸시·전화로 가지 않고, "
    "미확인이어도 자동으로 다시 알리거나 윗선에 올리지 않는다. 미확인이 이어지면 발신자가 보낸 목록에서 보고 다른 수단으로 직접 연락해야 한다.",
    "서명 전(임시저장·예비 판독·보류) 판독에 대한 중요 결과는 임상의에게 보낼 수 없다 — radiologist 수신자에게만 갈 수 있다. "
    "보낸 뒤 판독이 추가기재·재승인·판독 취소로 바뀌면 임상의 수신자는 기록이 있다는 것(stub)만 보고 확인할 수 없으며, "
    "발신자가 새 확정 판으로 대체하거나 취소해야 한다. 발신자가 조치하지 않으면 stub이 확인 대기에 남는다.",
    'ACK는 수신자가 KIN에서 "받았다"고 명시한 기록이며 임상 조치의 증명이 아니다.',
]
ENGLISH_NAMES = ("Critical Results", "Show All", "Refresh", "More", "Acknowledge", "Check Again", "Open Replacement",
                 "Pending ACK", "Acknowledged", "Cancelled", "Superseded", "Source Changed", UNKNOWN_WORD)
# The state word Acknowledged as a user reads it (not inside "Acknowledgement" nor a server code in capitals).
ACKED = re.compile(r"\bAcknowledged\b")
UUID_V4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
ACK_KEYS = ["expectedOwner", "requestId", "revision"]
MARKER = re.compile(r"SYN-(?:MSG|BODY|REASON|SENDER)-[A-Za-z0-9]+")

INDEX_STAND_IN = ('<!doctype html><html><head><meta charset="utf-8"><title>SYN index stand-in</title></head>'
                  '<body><p id="stand-in">SYN index stand-in</p></body></html>')
MAIN_STAND_IN = ('<!doctype html><html><head><meta charset="utf-8"><title>SYN main stand-in</title></head>'
                 '<body><p id="main-stand-in">SYN main stand-in</p></body></html>')
BLANK = '<!doctype html><html><head><meta charset="utf-8"><title>SYN blank</title></head><body></body></html>'


def iso(minutes):
    return (T0 + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def kst(value):
    """An ISO time as the page shows it in Asia/Seoul: its date and hour:minute."""
    moment = datetime.fromisoformat(value.replace("Z", "+00:00")) + timedelta(hours=9)
    return moment.strftime("%Y-%m-%d %H:%M")


def rid(n):
    return f"{n:08x}-0000-4000-8000-{n:012x}"


def suid(n):
    return f"{PREFIX}.{n}"


def rec(n, case="C2", state="created", **extra):
    """One critical result for the signed-in recipient. case: the recipient case of S7-U1p §4.2 (C2..C5, R2..R5); for R3/R4
    `full` says whether the legacy reading rule still gives the pinned version (full) or not (stub)."""
    record = {"id": rid(n), "studyUid": suid(n), "state": state, "revision": 1 if state == "created" else 2, "createdAt": iso(n),
              "replacedBy": None, "case": case, "full": True, "sender": f"SYN Sender SYN-SENDER-{n:02d}",
              "study": {"uid": suid(n), "name": f"SYN-PT-{n:02d}", "id": f"SYN-ID-{n:02d}", "birth": "19700101", "date": "20260927"},
              "message": f"SYN critical message SYN-MSG-{n:02d}",
              "source": {"version": 1, "action": "approve", "author": "syn-rad@kin", "at": "2026-09-28T00:30:00.000Z"},
              "body": {"findings": f"SYN findings SYN-BODY-{n:02d}F", "conclusion": f"SYN conclusion SYN-BODY-{n:02d}C",
                       "recommendation": f"SYN recommendation SYN-BODY-{n:02d}R"},
              "acknowledgedAt": None, "cancelledAt": None, "cancelReason": None, "supersededAt": None}
    if state == "acknowledged":
        record["acknowledgedAt"] = iso(n + 30)
    if state == "cancelled":
        record.update(cancelledAt=iso(n + 30), cancelReason=f"SYN reason SYN-REASON-{n:02d}")
    if state == "superseded":
        record["supersededAt"] = iso(n + 30)
    record.update(extra)
    return record


def me(person, roles):
    return {"sub": person["sub"], "actor": person["actor"], "roles": roles, "institution": INSTITUTION, "kind": "member",
            "user": person["actor"], "displayName": person["name"]}


def session(person, roles, state="approved", demo=False):
    """KinAuth.session() of main.html for the reading panel."""
    return {"state": state, "sub": person["sub"], "user": person["actor"], "displayName": person["name"], "roles": roles,
            "institution": INSTITUTION, **({"demo": True} if demo else {})}


def home_row(n):
    """GET clinician/studies row (clinician-policy.ts clinicianList) for a study of rec(n)."""
    return {"uid": suid(n), "id": f"SYN-ID-{n:02d}", "name": f"SYN-PT-{n:02d}", "birth": "19700101", "sex": "F", "date": "20260927",
            "acc": f"SYN-ACC-{n}", "desc": f"SYN DESC {n}", "modality": "CT", "count": 10, "series": 1,
            "sourcePatientKey": f"{INSTITUTION}|SYN-ID-{n:02d}", "institutionName": "SYN Hospital A", "tele": False,
            "report": {"final": True, "rs": "A", "action": "addendum", "version": 2, "repDoc": "syn-rad", "confirm": "2026-09-28"}}


class RecipientServer:
    """The S7-U1a rules the recipient screens rely on, for one signed-in recipient."""

    def __init__(self, owner):
        self.owner = list(owner)
        self.records = {}
        self.receipts = {}
        self.cursors = {}
        self.page_size = 50
        # RD07: a pending count reported apart from the rows (the server counts what the page cannot see).
        self.pending = None
        # False: the recipient cannot read the replacement, so replacedBy is withheld (§13).
        self.replacements = True
        # rd01: writer-side fields the real serializer never sends.
        self.plant = False
        self.now = SERVER_NOW

    def add(self, *records):
        for record in records:
            self.records[record["id"]] = record
        return records[0] if len(records) == 1 else records

    @staticmethod
    def refuse(status, code, **extra):
        return status, {"code": code, "message": f"SYN {code} message", **extra}

    @staticmethod
    def visible(record):
        return record["case"] not in ("C5", "R5")

    def replaced_by(self, record):
        target = self.records.get(record["replacedBy"]) if record["replacedBy"] else None
        return target["id"] if target and self.replacements and self.visible(target) else None

    def view(self, record):
        case = record["case"]
        current = case in ("C2", "R2")
        reason = None if current else ("reset" if case in ("C4", "R4") else "head_moved")
        full = current or (case in ("R3", "R4") and record["full"])
        base = {"id": record["id"], "studyUid": record["studyUid"], "state": record["state"], "revision": record["revision"],
                "createdAt": record["createdAt"], "replacedBy": self.replaced_by(record), "sender": {"name": record["sender"]},
                "study": dict(record["study"]), "acknowledgedAt": record["acknowledgedAt"], "cancelledAt": record["cancelledAt"],
                "supersededAt": record["supersededAt"]}
        if full:
            item = {**base, "view": "full", "message": record["message"],
                    "source": {**record["source"], "current": current, "reason": reason}, "body": dict(record["body"]),
                    "cancelReason": record["cancelReason"]}
        else:
            item = {**base, "view": "stub", "source": {"current": False, "reason": reason}}
        if self.plant:
            item.update(draft={"findings": "SYN-PLANTED-DRAFT"}, recipientSub="SYN-PLANTED-SUB", fingerprint="SYN-PLANTED-PRINT")
        return item

    def ordered(self):
        return sorted(self.records.values(), key=lambda r: (r["createdAt"], r["id"]), reverse=True)

    def listing(self, query):
        if set(query) - {"view", "state", "cursor"} or any(len(v) != 1 for v in query.values()) or query.get("view") != ["received"]:
            return self.refuse(400, "CRITICAL_RESULT_INPUT_INVALID")
        wanted = {"pending": "created", "acknowledged": "acknowledged", "cancelled": "cancelled", "superseded": "superseded",
                  "all": None}.get(query.get("state", ["all"])[0], "bad")
        if wanted == "bad":
            return self.refuse(400, "CRITICAL_RESULT_INPUT_INVALID")
        rows = [r for r in self.ordered() if self.visible(r) and (wanted is None or r["state"] == wanted)]
        offset = 0
        if "cursor" in query:
            if query["cursor"][0] not in self.cursors:
                return self.refuse(400, "CRITICAL_RESULT_INPUT_INVALID")
            offset = self.cursors[query["cursor"][0]]
        page = rows[offset:offset + self.page_size]
        cursor = None
        if offset + self.page_size < len(rows):
            cursor = f"SYN-CURSOR-{chr(65 + len(self.cursors))}"
            self.cursors[cursor] = offset + self.page_size
        pending = self.pending if self.pending is not None else \
            sum(1 for r in self.records.values() if self.visible(r) and r["state"] == "created")
        return 200, {"owner": self.owner, "view": "received", "items": [self.view(r) for r in page], "nextCursor": cursor,
                     "pending": pending}

    def read(self, record_id):
        record = self.records.get(record_id)
        if record is None or not self.visible(record):
            return self.refuse(404, "CRITICAL_RESULT_NOT_FOUND")
        return 200, {"owner": self.owner, "item": self.view(record)}

    def ack(self, record_id, body):
        if not isinstance(body, dict) or sorted(body) != ACK_KEYS:
            return self.refuse(400, "CRITICAL_RESULT_INPUT_INVALID")
        if body["expectedOwner"] != self.owner:
            return self.refuse(409, "OWNER_CHANGED")
        record = self.records.get(record_id)
        if record is None or not self.visible(record):
            return self.refuse(404, "CRITICAL_RESULT_NOT_FOUND")
        request_id = str(body["requestId"]).lower()
        mark = (record_id, body["revision"])
        if request_id in self.receipts:
            stored = self.receipts[request_id]
            if stored["mark"] != mark:
                return self.refuse(409, "REQUEST_ID_REUSED")
            return 201, {"owner": self.owner, "applied": stored["applied"], "replayed": True}
        if record["state"] == "acknowledged":
            return self.refuse(409, "CRITICAL_RESULT_ACKNOWLEDGED")
        if record["state"] == "cancelled":
            return self.refuse(409, "CRITICAL_RESULT_CANCELLED")
        if record["state"] == "superseded":
            following = self.replaced_by(record)
            return self.refuse(409, "CRITICAL_RESULT_SUPERSEDED", **({"replacedBy": following} if following else {}))
        if body["revision"] != record["revision"]:
            return self.refuse(409, "CRITICAL_RESULT_CHANGED")
        if record["case"] not in ("C2", "R2"):
            return self.refuse(409, "CRITICAL_RESULT_SOURCE_CHANGED")
        record.update(state="acknowledged", revision=2, acknowledgedAt=self.now)
        applied = {"id": record_id, "studyUid": record["studyUid"], "requestId": request_id, "action": "ack", "from": "created",
                   "to": "acknowledged", "revision": 2, "replacement": None, "at": self.now}
        self.receipts[request_id] = {"mark": mark, "applied": applied}
        return 201, {"owner": self.owner, "applied": applied, "replayed": False}

    def handle(self, kind, path, query, body):
        if kind == "list":
            return self.listing(query)
        record_id = path.split("/")[3]
        return self.read(record_id) if kind == "read" else self.ack(record_id, body)


def kind_of(method, path):
    if method == "GET" and path == "/api/critical-results":
        return "list"
    if method == "GET" and re.fullmatch(r"/api/critical-results/[^/]+", path):
        return "read"
    if method == "POST" and re.fullmatch(r"/api/critical-results/[^/]+/ack", path):
        return "ack"
    return None


# ── storage observer (scenario S-11, S-12; test-plan §2) ──
# Installed before every document's first script. Every write to the origin's storage is handed to the test process at
# the moment it is made (window.synStore is an exposed binding), before the write runs, so no navigation loses one; the
# page's call then runs unchanged. window.synSnapshot reads what the origin's storage holds with the functions as they
# were before the wrappers.
STORE_WATCH = r"""(() => {
  if (window.__synStoreWatch) return;
  Object.defineProperty(window, '__synStoreWatch', { value: true });
  const post = record => { try { window.synStore(Object.assign({ url: String(location.href) }, record)); } catch (_) {} };
  const decode = view => {
    const bytes = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    let utf16 = '';
    try { utf16 = new TextDecoder('utf-16le').decode(bytes.length % 2 ? bytes.slice(0, -1) : bytes); } catch (_) {}
    return new TextDecoder('utf-8').decode(bytes) + ' | ' + utf16;
  };
  const flat = (value, later, memo) => {
    if (value === null || value === undefined) return String(value);
    if (typeof value === 'string') return value;
    if (typeof value !== 'object') return String(value);
    if (value instanceof ArrayBuffer) return decode(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) return decode(value);
    if (typeof Blob !== 'undefined' && value instanceof Blob) { later.push(value); return '[blob]'; }
    if (typeof Response !== 'undefined' && value instanceof Response) { try { later.push(value.clone()); } catch (_) {} return '[response]'; }
    if (typeof Request !== 'undefined' && value instanceof Request) return value.url;
    if (value instanceof Date) return value.toISOString();
    if (memo.has(value)) return '[cycle]';
    memo.add(value);
    if (value instanceof Map) return 'Map{' + [...value].map(([k, v]) => flat(k, later, memo) + ':' + flat(v, later, memo)).join(',') + '}';
    if (value instanceof Set) return 'Set{' + [...value].map(v => flat(v, later, memo)).join(',') + '}';
    if (Array.isArray(value)) return '[' + value.map(v => flat(v, later, memo)).join(',') + ']';
    return '{' + Object.keys(value).map(k => k + ':' + flat(value[k], later, memo)).join(',') + '}';
  };
  const record = (kind, op, names, parts) => {
    const later = [], memo = new WeakSet();
    post({ kind, op, names: names.map(String), text: parts.map(part => flat(part, later, memo)).join(' | ') });
    for (const item of later) Promise.resolve().then(() => item.text())
      .then(text => post({ kind, op: op + ':content', names: names.map(String), text }), () => {});
  };
  const wrap = (proto, name, describe) => {
    if (!proto || typeof proto[name] !== 'function') return;
    const original = proto[name];
    proto[name] = function (...args) {
      try { describe(this, args); } catch (_) {}
      return original.apply(this, args);
    };
  };
  const storageKind = target => { try { return target === window.localStorage ? 'localStorage' : 'sessionStorage'; } catch (_) { return 'storage'; } };
  const realOpen = IDBFactory.prototype.open;
  const realCacheOpen = typeof CacheStorage !== 'undefined' ? CacheStorage.prototype.open : null;
  wrap(Storage.prototype, 'setItem', (t, a) => record(storageKind(t), 'setItem', [a[0]], [a[1]]));
  wrap(Storage.prototype, 'removeItem', (t, a) => record(storageKind(t), 'removeItem', [a[0]], []));
  wrap(Storage.prototype, 'clear', t => record(storageKind(t), 'clear', [], []));
  const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  Object.defineProperty(Document.prototype, 'cookie', { configurable: true, enumerable: cookie.enumerable,
    get() { return cookie.get.call(this); },
    set(value) { try { record('cookie', 'set', [], [value]); } catch (_) {} cookie.set.call(this, value); } });
  if (typeof CookieStore !== 'undefined') {
    wrap(CookieStore.prototype, 'set', (t, a) => record('cookieStore', 'set', [], a));
    wrap(CookieStore.prototype, 'delete', (t, a) => record('cookieStore', 'delete', [], a));
  }
  wrap(IDBFactory.prototype, 'open', (t, a) => record('indexedDB', 'open', [a[0]], []));
  wrap(IDBFactory.prototype, 'deleteDatabase', (t, a) => record('indexedDB', 'deleteDatabase', [a[0]], []));
  wrap(IDBDatabase.prototype, 'createObjectStore', (t, a) => record('indexedDB', 'createObjectStore', [t.name, a[0]], [a[1]]));
  wrap(IDBDatabase.prototype, 'deleteObjectStore', (t, a) => record('indexedDB', 'deleteObjectStore', [t.name, a[0]], []));
  const where = store => [store.transaction && store.transaction.db ? store.transaction.db.name : '', store.name];
  wrap(IDBObjectStore.prototype, 'put', (t, a) => record('indexedDB', 'put', where(t), [a[1], a[0]]));
  wrap(IDBObjectStore.prototype, 'add', (t, a) => record('indexedDB', 'add', where(t), [a[1], a[0]]));
  wrap(IDBObjectStore.prototype, 'delete', (t, a) => record('indexedDB', 'delete', where(t), [a[0]]));
  wrap(IDBObjectStore.prototype, 'clear', t => record('indexedDB', 'clear', where(t), []));
  wrap(IDBObjectStore.prototype, 'createIndex', (t, a) => record('indexedDB', 'createIndex', where(t), a));
  wrap(IDBCursor.prototype, 'update', (t, a) => record('indexedDB', 'cursor.update', [], [a[0]]));
  wrap(IDBCursor.prototype, 'delete', () => record('indexedDB', 'cursor.delete', [], []));
  if (typeof CacheStorage !== 'undefined') {
    wrap(CacheStorage.prototype, 'open', (t, a) => record('cache', 'open', [a[0]], []));
    wrap(CacheStorage.prototype, 'delete', (t, a) => record('cache', 'delete', [a[0]], []));
  }
  if (typeof Cache !== 'undefined') {
    wrap(Cache.prototype, 'put', (t, a) => record('cache', 'put', [], a));
    wrap(Cache.prototype, 'add', (t, a) => record('cache', 'add', [], a));
    wrap(Cache.prototype, 'addAll', (t, a) => record('cache', 'addAll', [], a));
  }
  if (typeof FileSystemDirectoryHandle !== 'undefined') {
    wrap(FileSystemDirectoryHandle.prototype, 'getFileHandle', (t, a) => { if (a[1] && a[1].create) record('opfs', 'getFileHandle', [t.name, a[0]], []); });
    wrap(FileSystemDirectoryHandle.prototype, 'getDirectoryHandle', (t, a) => { if (a[1] && a[1].create) record('opfs', 'getDirectoryHandle', [t.name, a[0]], []); });
  }
  if (typeof FileSystemFileHandle !== 'undefined') wrap(FileSystemFileHandle.prototype, 'createWritable', t => record('opfs', 'createWritable', [t.name], []));
  if (typeof FileSystemWritableFileStream !== 'undefined') wrap(FileSystemWritableFileStream.prototype, 'write', (t, a) => record('opfs', 'write', [], a));
  wrap(History.prototype, 'pushState', (t, a) => record('history', 'pushState', [], a));
  wrap(History.prototype, 'replaceState', (t, a) => record('history', 'replaceState', [], a));

  const wait = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const deep = async value => {
    const later = [], text = flat(value, later, new WeakSet()), extra = [];
    for (const item of later) { try { extra.push(await item.text()); } catch (error) { extra.push('[unreadable ' + error + ']'); } }
    return [text, ...extra].join(' | ');
  };
  Object.defineProperty(window, 'synSnapshot', { value: async () => {
    const out = [], add = (where, text) => out.push(where + ': ' + text);
    for (const [name, store] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]])
      for (let i = 0; i < store.length; i++) { const key = store.key(i); add(name, key + '=' + store.getItem(key)); }
    add('document.cookie', document.cookie);
    try {
      for (const info of await indexedDB.databases()) {
        add('indexedDB', info.name);
        const db = await wait(realOpen.call(indexedDB, info.name));
        try {
          for (const name of [...db.objectStoreNames]) {
            const store = () => db.transaction(name, 'readonly').objectStore(name);
            add('indexedDB store', `${info.name}/${name} keyPath=${JSON.stringify(store().keyPath)} indexes=${[...store().indexNames].join(',')}`);
            for (const key of await wait(store().getAllKeys())) add('indexedDB key', await deep(key));
            for (const value of await wait(store().getAll())) add('indexedDB value', await deep(value));
          }
        } finally { db.close(); }
      }
    } catch (error) { add('error indexedDB', String(error)); }
    try {
      for (const name of await caches.keys()) {
        add('cache', name);
        const cache = await realCacheOpen.call(caches, name);
        for (const request of await cache.keys()) {
          add('cache url', request.url);
          const response = await cache.match(request);
          add('cache body', response ? await response.text() : '');
        }
      }
    } catch (error) { add('error cache', String(error)); }
    try {
      const walk = async (dir, path) => {
        for await (const [name, handle] of dir.entries()) {
          add('opfs', path + name);
          if (handle.kind === 'file') add('opfs file', await (await handle.getFile()).text());
          else await walk(handle, path + name + '/');
        }
      };
      await walk(await navigator.storage.getDirectory(), '/');
    } catch (error) { add('error opfs', String(error)); }
    add('window.name', window.name);
    add('history.state', await deep(history.state));
    return out;
  } });
})();"""
# Harness-only document for the observer's fitness pair: it writes one value through every write path above (IndexedDB
# under neutral names, the value as a string, an object, bytes and a Blob), then leaves at once.
STORE_FIXTURE = """<!doctype html><html><head><meta charset="utf-8"><title>SYN store fixture</title></head><body><script>
(async () => {
  const value = new URLSearchParams(location.search).get('value');
  localStorage.setItem('syn-l', value);
  sessionStorage.setItem('syn-s', value);
  document.cookie = 'syn-c=' + value + '; Path=/; Secure; SameSite=Strict';
  if (window.cookieStore) await cookieStore.set('syn-cs', value);
  const db = await new Promise(resolve => { const r = indexedDB.open('cache', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('pending'); r.onsuccess = () => resolve(r.result); });
  await new Promise(resolve => { const tx = db.transaction('pending', 'readwrite'), store = tx.objectStore('pending');
    store.put(value, 'string'); store.put({ request: value, nested: [value] }, 'object');
    store.put(new TextEncoder().encode(value), 'bytes'); store.put(new Blob([JSON.stringify({ value })]), 'blob');
    tx.oncomplete = resolve; });
  db.close();
  const cache = await caches.open('syn-cache');
  await cache.put('/worklist/hpacs-lite/syn-cached', new Response('cached ' + value));
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle('syn-file', { create: true });
  const writable = await file.createWritable();
  await writable.write('file ' + value);
  await writable.close();
  history.replaceState({ value }, '');
  window.name = 'name ' + value;
  location.replace('blank.html');
})();
</script></body></html>"""

# What the region shows, as a user reads it. rows: the received list; lines: the unconfirmed or refused acknowledgements.
VIEW = """(root) => {
  const r = document.querySelector(root);
  if (!r) return null;
  const shown = e => !!e && e.getClientRects().length > 0;
  const entries = name => { const list = r.querySelector(`[aria-label="${name}"]`);
    return list && shown(list) ? [...list.children].filter(shown).map(li => ({ text: li.innerText,
      buttons: [...li.querySelectorAll('button')].filter(shown).map(b => [b.textContent, b.disabled]) })) : []; };
  return { shown: shown(r), text: shown(r) ? r.innerText : '',
    statuses: [...r.querySelectorAll('[role="status"]')].filter(shown).map(e => e.innerText.trim()),
    rows: entries('Received Critical Results'), lines: entries('Unconfirmed Acknowledgements'),
    buttons: [...r.querySelectorAll('button')].filter(shown).map(b => [b.textContent, b.disabled, b.getAttribute('aria-pressed'),
      b.getAttribute('aria-expanded')]) };
}"""
# Where focus is: inside the region or not, a button or not, its text and the text of the row or line it belongs to.
FOCUS = """(root) => { const e = document.activeElement, r = document.querySelector(root);
  let item = e;
  while (item && item.parentElement && !item.parentElement.matches('[aria-label="Received Critical Results"], [aria-label="Unconfirmed Acknowledgements"]'))
    item = item.parentElement;
  if (item && !item.parentElement) item = null;
  return { inside: !!r && r.contains(e), tag: e ? e.tagName : null, text: e ? (e.innerText || e.textContent || '').trim() : '',
    item: item && r && r.contains(item) ? item.innerText : null, body: e === document.body }; }"""


class CriticalResultRecipientDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.panel_markup = page_html(MAIN)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.host = "home"
        self.root = "#critical-results"
        self.server = RecipientServer([INSTITUTION, CLIN["sub"]])
        self.servers = [self.server]
        self.me = me(CLIN, ["clinician"])
        self.me_queue = []
        self.rows = [home_row(n) for n in (1, 2, 3)]
        self.files = dict(HOME_FILES)
        self.faults = {}
        self.held = []
        self.parked = []
        self.log = []
        self.logouts = []
        self.hold_logouts = False
        self.held_logouts = []
        self.hold_documents = False
        self.held_documents = []
        self.documents = []
        self.report_requests = []
        self.envelope_owner = None
        self.writes = []
        self.snapshots = []
        # Inbox values a case showed and then took out of its server's records (they still must not be stored).
        self.extra_needles = set()
        self.unexpected, self.errors, self.dialogs, self.finished = [], [], [], []
        self.context = self.new_context()
        self.page = self.watch_page(self.context.new_page())
        self.page.clock.install(time=BROWSER_TIME)

    def new_context(self, writes=None):
        context = self.browser.new_context(viewport={"width": 1366, "height": 768}, timezone_id="Asia/Seoul", locale="ko-KR")
        log = self.writes if writes is None else writes
        context.expose_binding("synStore", lambda source, entry: log.append(entry))
        context.add_init_script(STORE_WATCH)
        context.route("**/*", self.route)
        return context

    def watch_page(self, page):
        page.set_default_timeout(5000)
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.on("dialog", self.on_dialog)
        page.on("requestfinished", lambda request: self.finished.append(request))
        page.on("requestfailed", lambda request: self.finished.append(request))
        page.on("request", lambda request: self.documents.append((page, request.url))
                if request.is_navigation_request() and request.frame == page.main_frame else None)
        return page

    def tearDown(self):
        try:
            if not self.page.is_closed():
                self.snapshots.append(("end of case", self.snapshot(self.page)))
            self.assert_not_stored("end of case")
        finally:
            self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.unexpected, "requests the harness does not answer")
        self.assertEqual([], self.dialogs, "browser dialogs")

    def on_dialog(self, dialog):
        self.dialogs.append(f"{dialog.type}: {dialog.message}")
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
        if method == "GET" and path.startswith(BASE):
            name = path[len(BASE):]
            if name == "main.html":
                route.fulfill(body=self.panel_markup if self.host == "panel" else MAIN_STAND_IN, content_type="text/html; charset=utf-8")
            elif name in ("index.html", "blank.html"):
                if name == "index.html" and self.hold_documents:
                    self.held_documents.append(route)
                    return
                route.fulfill(body=INDEX_STAND_IN if name == "index.html" else BLANK, content_type="text/html; charset=utf-8")
            elif name == "syn-store-fixture.html":
                route.fulfill(body=STORE_FIXTURE, content_type="text/html; charset=utf-8")
            elif name in self.files and (self.host == "home" or name == INBOX):
                kind = "text/html" if name.endswith(".html") else "application/javascript"
                route.fulfill(body=self.files[name], content_type=f"{kind}; charset=utf-8")
            else:
                route.fulfill(status=404, body="")
            return
        if path.startswith("/kin-brand/") or path == "/favicon.ico":
            route.fulfill(status=404, body="")
            return
        if path.startswith("/api/") and request.headers.get("x-kin-csrf") != "1":
            self.unexpected.append(f"{method} {path} without X-KIN-CSRF")
            route.abort()
            return
        query = parse_qs(url.query, keep_blank_values=True)
        if self.host == "home" and method == "GET" and path == "/api/me":
            answer = self.me_queue.pop(0) if self.me_queue else self.me
            route.fulfill(**({"status": answer[0], "json": answer[1]} if isinstance(answer, tuple) else {"json": answer}))
            return
        if self.host == "home" and method == "GET" and path == "/api/clinician/studies" and query == {"limit": ["100"]}:
            rows = sorted(self.rows, key=lambda row: row["uid"])
            route.fulfill(json={"studies": copy.deepcopy(rows), "serverTime": "2026-09-28T00:00:00.000Z",
                                "pagination": {"next": None, "total": len(rows), "offset": 0, "limit": 100}})
            return
        found = re.fullmatch(r"/api/clinician/studies/([^/]+)/report", path)
        if self.host == "home" and method == "GET" and found and not url.query:
            self.report_requests.append(found.group(1))
            # The current head's report - what a recipient must never see in a stub row (RISK-S7-U2a-BODY-SUBSTITUTE).
            route.fulfill(json={"uid": found.group(1), "keys": [], "report": {"final": True, "rs": "A", "action": "addendum",
                                "version": 2, "repDoc": "syn-rad", "confirm": "2026-09-28", "findings": "SYN-HEAD-BODY findings",
                                "conclusion": "SYN-HEAD-BODY conclusion", "recommendation": ""}})
            return
        if method == "POST" and path == "/api/auth/logout":
            self.logouts.append(request.headers.get("x-kin-csrf"))
            if self.hold_logouts:
                self.held_logouts.append(route)
                return
            route.fulfill(status=204, body="")
            return
        kind = kind_of(method, path)
        if kind is None:
            self.unexpected.append(f"{method} {request.url}")
            route.abort()
            return
        body = None
        if method == "POST":
            if request.headers.get("content-type", "").split(";")[0] != "application/json":
                self.unexpected.append(f"{method} {path} without a JSON body")
            body = request.post_data_json
        self.log.append({"kind": kind, "method": method, "path": path, "query": query, "body": copy.deepcopy(body),
                         "raw": request.post_data, "request": request, "page": request.frame.page})
        queue = self.faults.get(kind) or []
        fault = queue.pop(0) if queue else None
        answer = None
        # The server acts unless the fault replaces its answer; apply=True makes it act even then (a write committed
        # before the answer that reaches the page); later=True makes it act only when the held request is released.
        if fault is None or fault.get("apply") or not {"status", "abort", "raw", "later"} & set(fault):
            answer = self.server.handle(kind, path, query, body)
        if fault is not None and "status" in fault:
            answer = (fault["status"], fault.get("body"))
        if fault is not None and "patch" in fault:
            status, payload = answer
            payload = copy.deepcopy(payload)
            fault["patch"](payload)
            answer = (status, payload)
        if fault is not None and "http" in fault:
            answer = (fault["http"], answer[1])
        if self.envelope_owner is not None and answer and isinstance(answer[1], dict) and "owner" in answer[1]:
            answer = (answer[0], {**answer[1], "owner": self.envelope_owner})
        held = {"kind": kind, "route": route, "answer": answer, "fault": fault or {}, "body": copy.deepcopy(body), "path": path,
                "query": query, "server": self.server}
        if fault is not None and fault.get("hold"):
            self.held.append(held)
            return
        self.answer(held)

    @staticmethod
    def answer(held):
        fault, route = held["fault"], held["route"]
        if fault.get("later"):
            held["answer"] = held["server"].handle(held["kind"], held["path"], held["query"], held["body"])
        if fault.get("abort") or held["answer"] is None:
            route.abort("connectionreset")
        elif "raw" in fault:
            route.fulfill(status=fault["raw"][0], body=fault["raw"][1], content_type="text/html; charset=utf-8")
        elif held["answer"][1] is None:
            route.fulfill(status=held["answer"][0], body="")
        else:
            route.fulfill(status=held["answer"][0], json=held["answer"][1])

    # ── helpers ──
    def wait_until(self, predicate, what, timeout=10.0):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail(f"{what}: not observed within {timeout:.0f}s")
            self.page.wait_for_timeout(10)

    def settle(self):
        self.page.wait_for_timeout(150)

    def fault(self, kind, **spec):
        self.faults.setdefault(kind, []).append(spec)

    def requests(self, kind=None, method=None):
        return [r for r in self.log if (kind is None or r["kind"] == kind) and (method is None or r["method"] == method)]

    def posts(self):
        return self.requests("ack")

    def take(self, kind, count=1):
        self.wait_until(lambda: len([h for h in self.held if h["kind"] == kind]) >= count, f"{count} held {kind} request(s)")
        picked = [h for h in self.held if h["kind"] == kind][:count]
        for h in picked:
            self.held.remove(h)
            self.parked.append(h["route"].request)
        return picked[0] if count == 1 else picked

    def release(self, held):
        request = held["route"].request
        self.answer(held)
        self.parked.remove(request)
        self.wait_until(lambda: any(item is request for item in self.finished), "the released answer reaching the page")
        self.settle()

    def release_late(self, held):
        """Answer a request the page may already have stopped; the page then has nothing to receive."""
        try:
            self.answer(held)
        except PlaywrightError:
            pass
        self.parked.remove(held["route"].request)
        self.settle()

    def reads_settled(self):
        """Wait until every critical-result request the page started (held ones aside) has been answered and run."""
        self.settle()

        def answered():
            held = [h["route"].request for h in self.held] + self.parked
            asked = [r["request"] for r in self.log if r["request"] not in held]
            return all(any(item is request for item in self.finished) for request in asked)
        self.wait_until(answered, "the critical-result answers")
        self.settle()

    def view(self, page=None):
        return (page or self.page).evaluate(VIEW, self.root)

    def badge(self, page=None):
        """The region's English status word (Pending ACK {n} or what stands for it); the list's status line is Korean."""
        found = [text for text in self.view(page)["statuses"] if text and not has_hangul(text)]
        self.assertEqual(1, len(found), self.view(page)["statuses"])
        return found[0]

    def assert_no_count(self, what):
        """A failed read or a locked region shows no number where Pending ACK {n} stands (0 would read as a result)."""
        badge = self.badge()
        self.assertTrue(badge and not re.search(r"\d", badge) and not has_hangul(badge), (what, badge))

    def status(self):
        return "\n".join(text for text in self.view()["statuses"] if has_hangul(text))

    def row(self, marker, view=None):
        found = [row for row in (view or self.view())["rows"] if marker in row["text"]]
        self.assertEqual(1, len(found), f"one row with {marker}: {[row['text'][:80] for row in (view or self.view())['rows']]}")
        return found[0]

    def line(self, marker, view=None):
        found = [line for line in (view or self.view())["lines"] if marker in line["text"]]
        self.assertEqual(1, len(found), f"one line with {marker}: {(view or self.view())['lines']}")
        return found[0]

    def line_text(self, marker):
        """The text of the line of this record, or '' while there is none."""
        return "\n".join(line["text"] for line in self.view()["lines"] if marker in line["text"])

    def row_text(self, marker):
        return "\n".join(row["text"] for row in self.view()["rows"] if marker in row["text"])

    def region(self):
        return self.page.locator(self.root)

    def press(self, name):
        self.region().get_by_role("button", name=name, exact=True).click()

    def row_locator(self, marker):
        return self.page.locator(f'{self.root} [aria-label="Received Critical Results"] > *', has_text=marker)

    def line_locator(self, marker):
        return self.page.locator(f'{self.root} [aria-label="Unconfirmed Acknowledgements"] > *', has_text=marker)

    def acknowledge(self, marker):
        self.row_locator(marker).get_by_role("button", name="Acknowledge", exact=True).click()

    def check_again(self, marker):
        self.line_locator(marker).get_by_role("button", name="Check Again", exact=True).click()

    def open_home(self, rows=None, wait=True):
        if rows is not None:
            self.rows = rows
        self.page.goto(ORIGIN + BASE + "clinician.html")
        if wait:
            expect(self.page.locator("#list-state")).to_have_attribute("data-state", "ready")
            self.wait_until(lambda: self.requests("list"), "the Critical Results read")
            self.reads_settled()

    def open_panel(self, person=RAD, roles=("radiologist",), mode=None, boot=True, fold_open=False):
        self.host, self.root = "panel", "#cvr-inbox-p"
        self.page.goto(ORIGIN + BASE + "main.html")
        self.page.evaluate(SETUP, {"session": session(person, list(roles)) if boot else None,
                                   "mode": mode or {"serverMode": boot, "offline": False, "demoMode": False}})
        self.page.add_script_tag(url=ORIGIN + BASE + INBOX)
        self.page.add_script_tag(content=PRELUDE + BLOCK + TAIL)
        self.assertEqual([], self.page.evaluate("() => window.synToasts"), "the block mounted")
        self.reads_settled()
        if fold_open and self.view()["shown"]:
            self.open_body()

    def open_body(self):
        toggle = self.region().get_by_role("button", name="Show Received", exact=True)
        if toggle.count():
            toggle.click()
        expect(self.region().get_by_role("button", name="Hide Received", exact=True)).to_be_visible()

    def tick(self, ms=60000):
        count = len(self.log)
        self.page.clock.fast_forward(ms)
        self.settle()
        self.reads_settled()
        return self.log[count:]

    # ── storage (S-11) ──
    def snapshot(self, page):
        return page.evaluate("() => window.synSnapshot()") + [f"context cookie: {c['name']}={c['value']} {c['path']}"
                                                              for c in self.context.cookies()]

    def needles(self):
        """Every inbox value of this case: record ids, cursors, the requestIds the page sent, and the markers put in the
        messages, bodies, cancel reasons and sender names the stub gave. Letters, digits and hyphens only, so they read
        the same inside JSON and URL encodings."""
        found = set()
        for server in self.servers:
            for record in server.records.values():
                found.add(record["id"])
                for text in (record["message"], record["sender"], record["cancelReason"] or "", *record["body"].values()):
                    found.update(MARKER.findall(text))
            found.update(server.cursors)
        found.update(str(r["body"]["requestId"]) for r in self.log if r["kind"] == "ack" and isinstance(r["body"], dict)
                     and "requestId" in r["body"])
        return found | self.extra_needles

    def assert_not_stored(self, what):
        needles = self.needles()
        self.assertTrue(needles, "the case has inbox values")
        written = [entry for entry in self.writes if any(n in json.dumps(entry, ensure_ascii=False) for n in needles)]
        self.assertEqual([], written, f"{what}: an inbox value written to the origin's storage")
        for label, taken in self.snapshots:
            self.assertEqual([], [line for line in taken if line.startswith("error ")], f"{label}: the snapshot read every store")
            held = [line for line in taken if any(n in line for n in needles)]
            self.assertEqual([], held, f"{label}: an inbox value held in the origin's storage")

    # ── Clinician Home session ──
    def log_out_home(self):
        self.page.locator("#logout").click()

    def closed(self, page=None):
        return (page or self.page).evaluate(CLOSED_VIEW)

    def assert_closed(self, what, page=None):
        """Clinician Home after close(): only the closing line, nothing of the account (clinician_home_dom_test CLOSED_VIEW)."""
        seen = self.closed(page)
        self.assertEqual(["P@status"], seen["children"], what)
        self.assertNotIn("SYN", seen["text"], what)

    # ── RD01-RD04: rows as the server's view draws them ──
    def test_rd01_c2_full_row_shows_the_pinned_version_and_offers_acknowledge(self):
        r = self.server.add(rec(1, source={"version": 3, "action": "approve", "author": "syn-rad@kin", "at": "2026-09-28T00:30:00.000Z"}))
        self.server.plant = True
        self.open_home()
        seen = self.row("SYN-PT-01")
        for text in (r["message"], f"From {r['sender']}", f"Sent {kst(r['createdAt'])}", "SYN-PT-01", "SYN-ID-01", "19700101",
                     "20260927", f"Source: v3 · Approve · syn-rad@kin · {kst('2026-09-28T00:30:00.000Z')}", "Findings",
                     r["body"]["findings"], "Conclusion", r["body"]["conclusion"], "Recommendation", r["body"]["recommendation"]):
            self.assertIn(text, seen["text"])
        self.assertEqual([["Acknowledge", False]], seen["buttons"])
        self.assertNotIn("2030", seen["text"], "the times are the server's, not the browser clock's")
        # One read, the received pending list asked for explicitly (the server's default is all).
        self.assertEqual([("GET", "/api/critical-results", {"view": ["received"], "state": ["pending"]})],
                         [(q["method"], q["path"], q["query"]) for q in self.log])
        content = self.page.content()
        for planted in ("SYN-PLANTED-DRAFT", "SYN-PLANTED-SUB", "SYN-PLANTED-PRINT"):
            self.assertNotIn(planted, content)
        first = self.view()["rows"]

        # Preserving variants: the same answer with its keys in another order, and 300 ms late - the same row.
        def reorder(payload):
            payload["items"] = [dict(reversed(list(item.items()))) for item in payload["items"]]
            return payload
        self.fault("list", patch=reorder)
        self.open_home()
        self.assertEqual(first, self.view()["rows"])
        self.fault("list", hold=True)
        self.open_home(wait=False)
        held = self.take("list")
        self.page.wait_for_timeout(300)
        self.release(held)
        self.assertEqual(first, self.view()["rows"])

        # The pair: the same record with its pinned version no longer current (full, current:false) has no Acknowledge -
        # the button follows the answer's `current`, not only its view.
        r["case"] = "R3"
        self.open_home()
        moved = self.row("SYN-PT-01")
        self.assertEqual([], moved["buttons"])
        self.assertIn("Source Changed", moved["text"])
        # Empty body fields: the three titles with nothing filled in from anywhere else, and no other request.
        self.extra_needles.update(MARKER.findall(json.dumps(r["body"])))
        r.update(case="C2", body={"findings": "", "conclusion": "", "recommendation": ""})
        self.log.clear()
        self.open_home()
        empty = self.row("SYN-PT-01")
        for title in ("Findings", "Conclusion", "Recommendation"):
            self.assertIn(title, empty["text"])
        self.assertIsNone(MARKER.search(empty["text"].replace(r["message"], "").replace(r["sender"], "")))
        self.assertEqual(["list"], [q["kind"] for q in self.log])

    def test_rd02_c3_stub_shows_no_message_or_body_and_reads_nothing_more(self):
        r = self.server.add(rec(2, case="C3"))
        self.open_home()
        seen = self.row("SYN-PT-02")
        self.assertIn("Source Changed", seen["text"])
        self.assertIn(STUB_SENTENCE, seen["text"])
        for present in (f"From {r['sender']}", f"Sent {kst(r['createdAt'])}", "SYN-PT-02", "SYN-ID-02", "19700101", "20260927"):
            self.assertIn(present, seen["text"])
        for absent in ("SYN-MSG-02", "SYN-BODY-02", "Source: v", "v1", "Findings", "SYN-HEAD-BODY"):
            self.assertNotIn(absent, seen["text"])
        self.assertEqual([], seen["buttons"])
        # Every focusable thing in the row focused and Enter pressed, the row clicked: nothing is read for it.
        row = self.row_locator("SYN-PT-02")
        row.click()
        for handle in row.locator("[tabindex], button, a").all():
            handle.focus()
            self.page.keyboard.press("Enter")
        self.settle()
        # The same study opened in Studies shows the current report there; the stub row is not filled from it.
        self.page.locator(f'#studies tr[data-uid="{suid(2)}"]').click()
        expect(self.page.locator("#report-state")).to_have_attribute("data-state", "final")
        expect(self.page.locator("#report-body")).to_contain_text("SYN-HEAD-BODY")
        self.settle()
        self.assertEqual(seen, self.row("SYN-PT-02"))
        self.assertEqual(["list"], [q["kind"] for q in self.log], "only the list read: no record read, no report for the row")
        self.assertEqual([suid(2)], self.report_requests, "the one report the user opened in Studies")
        # The pair: the same record as full shows its message and pinned body - the stub view is the answer's view.
        r["case"] = "C2"
        self.report_requests.clear()
        self.open_home()
        full = self.row("SYN-PT-02")
        for text in ("SYN-MSG-02", "SYN-BODY-02F", "Source: v1 · Approve"):
            self.assertIn(text, full["text"])
        self.assertNotIn("SYN-HEAD-BODY", full["text"])
        self.assertEqual(["list", "list"], [q["kind"] for q in self.log], "a full row reads nothing more either")
        self.assertEqual([], self.report_requests)

    def test_rd03_c4_reset_stub(self):
        r = self.server.add(rec(3, case="C4"))
        self.open_home()
        reset = self.row("SYN-PT-03")
        self.assertIn("Source Changed", reset["text"])
        self.assertIn(STUB_SENTENCE, reset["text"])
        self.assertEqual([], reset["buttons"])
        self.assertNotIn("SYN-MSG-03", reset["text"])
        # The same record with reason head_moved: the same screen (the reason is not shown apart, §16.2).
        r["case"] = "C3"
        self.open_home()
        self.assertEqual(reset, self.row("SYN-PT-03"))

    def test_rd04_c5_row_leaves_after_refresh_and_the_badge_follows_the_server(self):
        r = self.server.add(rec(4))
        self.open_home()
        self.assertEqual("Pending ACK 1", self.badge())
        # The pair first: while the record is still there, Refresh keeps its row.
        self.press("Refresh")
        self.reads_settled()
        self.row("SYN-PT-04")
        # The recipient lost it (C5): the next read has no row and the server's pending, and nothing guesses why.
        r["case"] = "C5"
        self.press("Refresh")
        self.reads_settled()
        seen = self.view()
        self.assertEqual([], seen["rows"])
        self.assertEqual("Pending ACK 0", self.badge())
        for guess in ("권한", "숨김", "숨겨", "사라"):
            self.assertNotIn(guess, seen["text"])
        self.assertTrue(has_hangul(self.status()))

    # ── RD05: only the click writes ──
    def test_rd05_only_the_click_posts_and_acknowledged_is_the_server_time(self):
        s = self.server
        s.add(rec(5), rec(6))
        s.page_size = 1
        self.open_home()
        # Opening, scrolling, Refresh, Show All, More, focus and a minute passing write nothing and acknowledge nothing.
        self.region().scroll_into_view_if_needed()
        for name in ("Refresh", "Show All", "More", "Show All"):
            self.press(name)
            self.reads_settled()
        self.row_locator("SYN-PT-06").get_by_role("button", name="Acknowledge", exact=True).focus()
        self.tick(60000)
        self.assertEqual([], self.posts())
        self.assertIsNone(ACKED.search(self.view()["text"]))
        # One click, one POST with exactly the contract's body and the CSRF header.
        self.fault("ack", hold=True)
        self.acknowledge("SYN-PT-06")
        held = self.take("ack")
        post = self.posts()[0]
        self.assertEqual(f"/api/critical-results/{rid(6)}/ack", post["path"])
        self.assertEqual(ACK_KEYS, sorted(post["body"]))
        self.assertRegex(post["body"]["requestId"], UUID_V4)
        self.assertEqual(([INSTITUTION, CLIN["sub"]], 1), (post["body"]["expectedOwner"], post["body"]["revision"]))
        self.assertEqual("1", post["request"].headers.get("x-kin-csrf"))
        # While the answer is held nothing reads as acknowledged, and the button sends nothing more.
        waiting = self.view()
        self.assertIsNone(ACKED.search(waiting["text"]))
        self.assertEqual([["Acknowledge", True]], self.row("SYN-PT-06", waiting)["buttons"])
        self.row_locator("SYN-PT-06").get_by_role("button", name="Acknowledge", exact=True).click(force=True)
        self.settle()
        self.assertEqual(1, len(self.posts()))
        at = len(self.log)
        self.release(held)
        self.reads_settled()
        done = self.row("SYN-PT-06")
        self.assertIn(f"Acknowledged {kst(SERVER_NOW)}", done["text"])
        self.assertNotIn("2030", done["text"])
        self.assertEqual([], done["buttons"])
        self.assertEqual(["list"], [q["kind"] for q in self.log[at:]], "the list is read again after the 201")
        # Two clicks on the same button before any answer: one POST.
        self.press("Refresh")
        self.reads_settled()
        self.page.evaluate("""(root) => { const row = [...document.querySelector(root + ' [aria-label="Received Critical Results"]').children]
          .find(item => item.innerText.includes('SYN-PT-05'));
          const b = [...row.querySelectorAll('button')].find(b => b.textContent === 'Acknowledge'); b.click(); b.click(); }""", self.root)
        self.reads_settled()
        self.assertEqual(2, len(self.posts()))
        self.assertIn(f"Acknowledged {kst(SERVER_NOW)}", self.row("SYN-PT-05")["text"])
        # A replayed 201 (the stored result) reads the same.
        s.add(rec(7))
        self.press("Refresh")
        self.reads_settled()
        self.fault("ack", patch=lambda payload: payload.update(replayed=True))
        self.acknowledge("SYN-PT-07")
        self.reads_settled()
        self.assertIn(f"Acknowledged {kst(SERVER_NOW)}", self.row("SYN-PT-07")["text"])
        # The pair: a 201 whose applied is another request's is not this request's result - unknown, not Acknowledged.
        s.add(rec(8))
        self.press("Refresh")
        self.reads_settled()
        self.fault("ack", patch=lambda payload: payload["applied"].update(requestId="99999999-9999-4999-8999-999999999999"))
        self.acknowledge("SYN-PT-08")
        self.wait_until(lambda: self.view()["lines"], "the unknown line")
        seen = self.view()
        self.assertIn(UNKNOWN_WORD, self.line("SYN-PT-08", seen)["text"])
        self.assertNotIn("Acknowledged", self.row("SYN-PT-08", seen)["text"].replace(UNKNOWN_WORD, ""))
        self.assertEqual([], self.row("SYN-PT-08", seen)["buttons"])

    # ── RD06: cancel or supersede first ──
    def test_rd06_cancel_or_supersede_first_shows_the_refusal_and_open_replacement(self):
        s = self.server
        a, b, c, d, e, f = (s.add(rec(n)) for n in (11, 12, 13, 14, 15, 16))
        self.open_home()
        # W-01: the sender cancelled after this screen read the list. The refusal, then the server's state read once.
        a.update(state="cancelled", revision=2, cancelledAt=iso(40), cancelReason="SYN reason SYN-REASON-11")
        reads = len(self.requests("read"))
        self.acknowledge("SYN-PT-11")
        self.wait_until(lambda: "Cancelled" in self.line_text("SYN-PT-11"), "the server state")
        self.reads_settled()
        line = self.line("SYN-PT-11")
        for text in ("CRITICAL_RESULT_CANCELLED", "SYN CRITICAL_RESULT_CANCELLED message", "SYN-REASON-11"):
            self.assertIn(text, line["text"])
        self.assertTrue(has_hangul(line["text"]))
        self.assertEqual([], line["buttons"])
        self.assertEqual([f"/api/critical-results/{a['id']}"], [q["path"] for q in self.requests("read")[reads:]])
        self.assertIsNone(ACKED.search(self.view()["text"]))
        # W-02, W-03: superseded by a record this recipient can read - Open Replacement opens it, and it is acknowledged
        # with a new requestId and its own revision.
        g = s.add(rec(17))
        b.update(state="superseded", revision=2, supersededAt=iso(41), replacedBy=g["id"])
        self.acknowledge("SYN-PT-12")
        self.wait_until(lambda: [line for line in self.view()["lines"] if "SYN-PT-12" in line["text"]], "the refusal line")
        self.reads_settled()
        line = self.line("SYN-PT-12")
        self.assertIn("Superseded", line["text"])
        self.assertEqual([["Open Replacement", False]], line["buttons"])
        reads = len(self.requests("read"))
        self.line_locator("SYN-PT-12").get_by_role("button", name="Open Replacement", exact=True).click()
        self.wait_until(lambda: [row for row in self.view()["rows"] if "SYN-PT-17" in row["text"]], "the replacement's row")
        self.assertEqual([f"/api/critical-results/{g['id']}"], [q["path"] for q in self.requests("read")[reads:]])
        self.assertEqual([["Acknowledge", False]], self.row("SYN-PT-17")["buttons"])
        self.acknowledge("SYN-PT-17")
        self.wait_until(lambda: "Acknowledged" in self.row("SYN-PT-17")["text"], "the replacement acknowledged")
        first, replacement = self.posts()[1], self.posts()[-1]
        self.assertNotEqual(first["body"]["requestId"], replacement["body"]["requestId"])
        self.assertEqual((f"/api/critical-results/{g['id']}/ack", 1), (replacement["path"], replacement["body"]["revision"]))
        # The pair: a replacement this recipient cannot read comes without replacedBy - no Open Replacement.
        s.replacements = False
        h = s.add(rec(18))
        c.update(state="superseded", revision=2, supersededAt=iso(42), replacedBy=h["id"])
        self.acknowledge("SYN-PT-13")
        self.wait_until(lambda: [line for line in self.view()["lines"] if "SYN-PT-13" in line["text"]], "the refusal line")
        self.reads_settled()
        self.assertIn("CRITICAL_RESULT_SUPERSEDED", self.line("SYN-PT-13")["text"])
        self.assertEqual([], self.line("SYN-PT-13")["buttons"])
        s.replacements = True
        # The pair: the replacement's read fails - a failure, and no other request.
        k = s.add(rec(19))
        d.update(state="superseded", revision=2, supersededAt=iso(43), replacedBy=k["id"])
        self.acknowledge("SYN-PT-14")
        self.wait_until(lambda: [line for line in self.view()["lines"] if "SYN-PT-14" in line["text"] and line["buttons"]], "the line")
        self.reads_settled()
        self.fault("read", status=404, body={"code": "CRITICAL_RESULT_NOT_FOUND", "message": "SYN gone"})
        at = len(self.log)
        self.line_locator("SYN-PT-14").get_by_role("button", name="Open Replacement", exact=True).click()
        self.wait_until(lambda: "SYN gone" in self.line_text("SYN-PT-14"), "the failure")
        self.settle()
        self.assertEqual(["read"], [q["kind"] for q in self.log[at:]])
        self.assertIn("CRITICAL_RESULT_NOT_FOUND", self.line("SYN-PT-14")["text"])
        self.assertTrue(has_hangul(self.line("SYN-PT-14")["text"]))
        # W-05: the cancel commits while the ACK is held; its late 409 reads as W-01, and nothing is acknowledged meanwhile.
        self.fault("ack", hold=True, later=True)
        self.acknowledge("SYN-PT-15")
        held = self.take("ack")
        self.assertNotIn("Acknowledged", self.row("SYN-PT-15")["text"])
        e.update(state="cancelled", revision=2, cancelledAt=iso(44), cancelReason="SYN reason SYN-REASON-15")
        self.release(held)
        self.wait_until(lambda: "SYN-REASON-15" in self.line_text("SYN-PT-15"), "the cancelled state")
        self.assertIn("CRITICAL_RESULT_CANCELLED", self.line("SYN-PT-15")["text"])
        # The same race won by the ACK (the server applies it first): Acknowledged.
        self.fault("ack", hold=True)
        self.acknowledge("SYN-PT-16")
        held = self.take("ack")
        self.release(held)
        self.reads_settled()
        self.assertIn(f"Acknowledged {kst(SERVER_NOW)}", self.row("SYN-PT-16")["text"])

    # ── RD07: the badge ──
    def test_rd07_badge_is_the_server_pending_count(self):
        s = self.server
        s.add(rec(21), rec(22))
        s.pending = 7
        self.open_home()
        self.assertEqual(("Pending ACK 7", 2), (self.badge(), len(self.view()["rows"])))
        s.pending = 2
        self.press("Refresh")
        self.reads_settled()
        self.assertEqual("Pending ACK 2", self.badge())
        # Show All: ten records, three of them pending; the badge is the server's 3.
        s.records.clear()
        s.pending = None
        s.add(*[rec(30 + n) for n in range(3)], *[rec(40 + n, state="acknowledged") for n in range(7)])
        self.press("Show All")
        self.reads_settled()
        self.assertEqual(("Pending ACK 3", 10), (self.badge(), len(self.view()["rows"])))
        # The pair: pending 0 while two created rows are on screen - the badge is 0 (a count of rows would say 3).
        s.pending = 0
        self.press("Refresh")
        self.reads_settled()
        self.assertEqual("Pending ACK 0", self.badge())
        self.assertEqual(3, sum(1 for row in self.view()["rows"] if ["Acknowledge", False] in row["buttons"]))
        # More: the badge is the last answer's.
        s.page_size, s.pending = 5, 5
        self.press("Refresh")
        self.reads_settled()
        self.assertEqual("Pending ACK 5", self.badge())
        s.pending = 6
        self.press("More")
        self.reads_settled()
        self.assertEqual(("Pending ACK 6", 10), (self.badge(), len(self.view()["rows"])))

    # ── RD08: late answers, session ends, account changes, and nothing of the inbox kept ──
    def test_rd08_late_answers_logout_other_tab_account_change_and_no_inbox_persistence(self):
        self.observer_fits()
        self.late_list_answers()
        self.ack_answer_after_log_out()
        self.another_tab_ends_the_session()
        self.account_recheck_leaves()
        self.another_accounts_envelope_locks()
        self.session_end_signal_reaches_the_second_tab()
        self.inbox_values_do_not_outlive_the_account()

    def observer_fits(self):
        """The observer sees every write path and every store: a harness-only document (not a product file) writes one value
        through each - IndexedDB under the neutral names cache/pending, the value as a string, an object, bytes and a Blob -
        and leaves at once. Every write is in the log and what stays is in the next document's snapshot. The same document
        with another value: that needle is nowhere, so the check reads values, not names or APIs."""
        needle = "SYN-FIXTURE-NEEDLE"
        for value in (needle, "SYN-FIXTURE-OTHER"):
            with self.subTest(fixture=value):
                writes = []
                context = self.new_context(writes)
                try:
                    page = self.watch_page(context.new_page())
                    page.goto(ORIGIN + BASE + f"syn-store-fixture.html?value={value}")
                    page.wait_for_url(ORIGIN + BASE + "blank.html")
                    self.wait_until(lambda: any(w["op"] == "put:content" for w in writes)
                                    and any(w["op"] == "put:content" and w["kind"] == "cache" for w in writes), "the Blob and Response contents")
                    taken = page.evaluate("() => window.synSnapshot()") + [f"context cookie: {c['name']}={c['value']}"
                                                                           for c in context.cookies()]
                finally:
                    context.close()
                self.assertEqual([], [line for line in taken if line.startswith("error ")])
                written = {(w["kind"], w["op"]) for w in writes if value in json.dumps(w)}
                kept = {line.split(":")[0] for line in taken if value in line}
                self.assertTrue({("localStorage", "setItem"), ("sessionStorage", "setItem"), ("cookie", "set"),
                                 ("indexedDB", "put"), ("indexedDB", "put:content"), ("cache", "put:content"), ("opfs", "write"),
                                 ("history", "replaceState")} <= written, written)
                self.assertTrue({"localStorage", "sessionStorage", "document.cookie", "context cookie", "indexedDB value",
                                 "cache body", "opfs file", "window.name"} <= kept, kept)
                # Bytes and a Blob under neutral names are read as text.
                self.assertTrue(any("indexedDB value" in line and value in line and "[blob]" in line for line in taken))
                if value != needle:
                    self.assertEqual([], [w for w in writes if needle in json.dumps(w)])
                    self.assertEqual([], [line for line in taken if needle in line])

    def late_list_answers(self):
        s = self.server
        s.add(rec(51))
        self.open_home()
        # S-01: two Refresh reads; the first answers last. Only the second's list is left.
        self.fault("list", hold=True)
        self.press("Refresh")
        first = self.take("list")
        s.add(rec(52))
        self.fault("list", hold=True)
        self.press("Refresh")
        second = self.take("list")
        self.release(second)
        self.assertEqual(2, len(self.view()["rows"]))
        self.release(first)
        self.assertEqual(2, len(self.view()["rows"]), "the late one-row answer does not replace the newer list")
        # The pair: a held answer that is still the newest read does reach the page.
        s.add(rec(53))
        self.fault("list", hold=True)
        self.press("Refresh")
        self.release(self.take("list"))
        self.assertEqual(3, len(self.view()["rows"]))
        # L-07: Show All while the pending read is held; the pending answer arrives after the change and is dropped.
        s.add(rec(54, state="acknowledged"))
        self.fault("list", hold=True)
        self.press("Refresh")
        pending = self.take("list")
        self.press("Show All")
        self.reads_settled()
        self.assertIn("Acknowledged", self.row_text("SYN-PT-54"))
        self.release(pending)
        self.assertIn("Acknowledged", self.row_text("SYN-PT-54"), "the pending list's late answer is dropped")

    def ack_answer_after_log_out(self):
        # S-02: the ACK's answer arrives while POST /auth/logout is held: the page is closed and stays closed.
        self.server.add(rec(55))
        self.open_home()
        self.fault("ack", hold=True)
        self.acknowledge("SYN-PT-55")
        held = self.take("ack")
        self.hold_logouts = True
        self.log_out_home()
        self.wait_until(lambda: self.held_logouts, "POST /auth/logout")
        self.assert_closed("Log out pending")
        count = len(self.log)
        self.release_late(held)
        self.assert_closed("the ACK answer after Log out")
        self.page.wait_for_timeout(300)
        self.assertEqual(count, len(self.log), "nothing read or sent after the end")
        self.hold_logouts = False
        self.held_logouts.pop().fulfill(status=204, body="")
        self.page.wait_for_url(ORIGIN + BASE + "index.html")

    def another_tab_ends_the_session(self):
        # S-03: another tab of this browser logs out while a list read is held: one navigation, nothing painted or read.
        self.open_home()
        self.fault("list", hold=True)
        self.press("Refresh")
        held = self.take("list")
        count, documents = len(self.log), len(self.documents)
        other = self.watch_page(self.context.new_page())
        other.goto(ORIGIN + BASE + "blank.html")
        other.evaluate(BROADCAST_ENDED)
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        self.release_late(held)
        self.page.wait_for_timeout(300)
        other.close()
        self.assertEqual(count, len(self.log))
        self.assertEqual([ORIGIN + BASE + "index.html"], [url for page, url in self.documents[documents:] if page is self.page])

    def account_recheck_leaves(self):
        # S-04: Studies' account re-check finds another account while the inbox read is held: the page leaves, nothing more.
        self.me_queue = [me(CLIN, ["clinician"]), me(CLIN_B, ["clinician"])]
        self.fault("list", hold=True)
        self.page.goto(ORIGIN + BASE + "clinician.html")
        held = self.take("list")
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        count = len(self.log)
        self.release_late(held)
        self.page.wait_for_timeout(300)
        self.assertEqual(count, len(self.log))
        self.me_queue = []

    def another_accounts_envelope_locks(self):
        # S-07: the list answers for another account. The region locks, and so do the question and image request areas of
        # the same page (accountChanged): opening them reads nothing, and the inbox reads nothing more.
        s = self.server
        s.add(rec(56))
        self.envelope_owner = OTHER_OWNER
        self.open_home()
        seen = self.view()
        self.assertEqual(([], []), (seen["rows"], seen["lines"]))
        self.assertTrue(has_hangul(self.status()))
        self.assert_no_count("locked")
        self.assertEqual({("Show All", True), ("Refresh", True)}, {(b[0], b[1]) for b in seen["buttons"]})
        count = len(self.log)
        self.page.locator(f'#studies tr[data-uid="{suid(1)}"]').click()
        expect(self.page.locator("#report-state")).to_have_attribute("data-state", "final")
        # Opening them reads nothing: a question or image request read would reach the harness unanswered and fail the case.
        self.page.locator("#questions-summary").click()
        self.page.locator("#image-requests-summary").click()
        self.tick(60000)
        self.assertEqual(count, len(self.log))
        self.envelope_owner = None
        # A-08: OWNER_CHANGED on the ACK locks the same way.
        self.open_home()
        self.fault("ack", status=409, body={"code": "OWNER_CHANGED", "message": "SYN owner changed"})
        self.acknowledge("SYN-PT-56")
        self.wait_until(lambda: not self.view()["rows"], "the lock")
        count = len(self.log)
        self.page.locator(f'#studies tr[data-uid="{suid(1)}"]').click()
        expect(self.page.locator("#report-state")).to_have_attribute("data-state", "final")
        self.page.locator("#questions-summary").click()
        self.tick(60000)
        self.assertEqual(count, len(self.log))
        self.assert_no_count("locked")

    def session_end_signal_reaches_the_second_tab(self):
        # S-12: the product's session-end signal as auth.js sends it, read from the same write log: one setItem of
        # kin-session-ended with the time in decimal milliseconds, then its removeItem; the second tab of the same account
        # closes on it and its inbox reads nothing more.
        self.server.add(rec(57))
        self.open_home()
        second = self.watch_page(self.context.new_page())
        second.goto(ORIGIN + BASE + "clinician.html")
        expect(second.locator("#critical-results")).to_contain_text("SYN-PT-57")
        writes, before = len(self.writes), self.page.evaluate("() => Date.now()")
        self.log_out_home()
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        second.wait_for_url(ORIGIN + BASE + "index.html")
        after = second.evaluate("() => Date.now()")
        count = len(self.log)
        signal = [w for w in self.writes[writes:] if w["kind"] == "localStorage" and w["names"] == ["kin-session-ended"]]
        self.assertEqual(["setItem", "removeItem"], [w["op"] for w in signal])
        self.assertRegex(signal[0]["text"], r"^\d+$")
        self.assertTrue(before <= int(signal[0]["text"]) <= after, (before, signal[0]["text"], after))
        second.wait_for_timeout(300)
        self.assertEqual(count, len(self.log))
        second.close()

    def inbox_values_do_not_outlive_the_account(self):
        # S-11: account A leaves an unknown attempt and rows on screen; Log out; account B signs in to the same browser.
        # No A value is in any write or in what the origin's storage holds at four moments, and B's page shows none of A.
        s = RecipientServer([INSTITUTION, CLIN["sub"]])
        self.server = s
        self.servers.append(s)
        s.add(rec(61, message="SYN critical message SYN-MSG-A", sender="SYN Sender SYN-SENDER-A",
                  body={"findings": "SYN findings SYN-BODY-A", "conclusion": "", "recommendation": ""}),
              rec(62), rec(63, state="cancelled", cancelReason="SYN reason SYN-REASON-A"))
        s.page_size = 2
        self.me = me(CLIN, ["clinician"])
        self.open_home()
        self.press("Show All")
        self.reads_settled()
        self.press("More")
        self.reads_settled()
        self.assertIn("SYN-CURSOR-A", s.cursors)
        self.assertIn("SYN-REASON-A", self.row_text("SYN-PT-63"))
        self.fault("ack", status=503, body={"code": "CRITICAL_RESULT_BUSY", "message": "SYN busy"})
        self.acknowledge("SYN-PT-61")
        self.wait_until(lambda: UNKNOWN_WORD in self.line_text("SYN-PT-61"), "the unknown attempt")
        request_id = self.posts()[-1]["body"]["requestId"]
        self.snapshots.append(("after the unknown attempt", self.snapshot(self.page)))
        self.snapshots.append(("before Log out", self.snapshot(self.page)))
        self.log_out_home()
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        self.snapshots.append(("after the Log out navigation", self.snapshot(self.page)))
        b = RecipientServer([INSTITUTION, CLIN_B["sub"]])
        self.server = b
        self.servers.append(b)
        b.add(rec(64))
        self.me = me(CLIN_B, ["clinician"])
        count = len(self.log)
        self.open_home()
        self.row("SYN-PT-64")
        self.snapshots.append(("account B's document", self.snapshot(self.page)))
        seen = self.view()
        for a_value in ("SYN-PT-61", "SYN-PT-62", "SYN-PT-63", "SYN-MSG-A", UNKNOWN_WORD, "Check Again"):
            self.assertNotIn(a_value, seen["text"])
        self.assertEqual([], seen["lines"])
        self.assertEqual([], [q for q in self.log[count:] if q["kind"] != "list"], "no record read or ACK for A's records")
        self.assertIn(request_id, self.needles())
        self.assert_not_stored("S-11")

    # ── RD09: the reading panel's rows for a radiologist recipient ──
    def test_rd09_reader_panel_r3_r4_full_note_and_no_acknowledge(self):
        s = self.server = RecipientServer([INSTITUTION, RAD["sub"]])
        self.servers = [s]
        moved = s.add(rec(31, case="R3"))
        s.add(rec(32, case="R4"), rec(33, case="R3", full=False), rec(34, case="R4", full=False))
        self.open_panel()
        for marker in ("SYN-PT-31", "SYN-PT-32"):
            seen = self.row(marker)
            self.assertIn("Source Changed", seen["text"])
            self.assertIn("판독이 바뀌었습니다 — 보낸 당시의 판(v1)입니다", seen["text"])
            n = marker[-2:]
            for text in (f"SYN-MSG-{n}", f"SYN-BODY-{n}F", f"SYN-BODY-{n}C", "Source: v1 · Approve"):
                self.assertIn(text, seen["text"])
            self.assertEqual([], seen["buttons"])
        for marker in ("SYN-PT-33", "SYN-PT-34"):
            seen = self.row(marker)
            self.assertIn(STUB_SENTENCE, seen["text"])
            self.assertNotIn(f"SYN-MSG-{marker[-2:]}", seen["text"])
            self.assertNotIn("SYN-BODY", seen["text"])
            self.assertEqual([], seen["buttons"])
        self.assertEqual(["list"], [q["kind"] for q in self.log])
        # The pair: the same record while its pinned version is the head (R2) - no sentence, and Acknowledge.
        moved["case"] = "R2"
        self.press("Refresh")
        self.reads_settled()
        current = self.row("SYN-PT-31")
        self.assertNotIn("판독이 바뀌었습니다", current["text"])
        self.assertEqual([["Acknowledge", False]], current["buttons"])

    # ── RD10: unknown outcomes and how they end ──
    def test_rd10_unknown_outcomes_check_again_and_their_endings(self):
        s = self.server
        s.add(*[rec(n) for n in range(101, 118)])
        self.open_home()

        def not_applied(n, change):
            # A 201 that is not this request's result; the server did not apply anything.
            def patch(payload):
                change(payload["applied"])
                s.records[rid(n)].update(state="created", revision=1, acknowledgedAt=None)
                s.receipts.pop(payload["applied"]["requestId"], None)
            return patch
        first = {
            101: {"apply": True, "status": 409, "body": {"code": "STUDY_ACCESS_CHANGED", "message": "SYN access changed"}},
            102: {"status": 503, "body": {"statusCode": 503, "message": "SYN policy read failed"}},
            103: {"status": 503, "body": {"code": "CRITICAL_RESULT_BUSY", "message": "SYN busy"}},
            104: {"status": 500, "body": {"message": "SYN internal"}},
            105: {"raw": (502, "<html>SYN bad gateway</html>")},
            106: {"raw": (504, "<html>SYN gateway timeout</html>")},
            107: {"status": 409, "body": {"code": "SYN_NEW_CODE", "message": "SYN new"}},
            108: {"status": 200, "body": {"owner": [INSTITUTION, CLIN["sub"]], "applied": None, "replayed": False}},
            109: {"patch": not_applied(109, lambda applied: applied.update(studyUid=suid(1)))},
            110: {"patch": not_applied(110, lambda applied: applied.update(id=rid(1)))},
            111: {"abort": True},
            117: {"apply": True, "abort": True},
        }
        for n, spec in first.items():
            with self.subTest(first=n):
                self.fault("ack", **spec)
                self.acknowledge(f"SYN-PT-{n}")
                self.wait_until(lambda: UNKNOWN_WORD in self.line_text(f"SYN-PT-{n}"), f"the unknown line of {n}")
                line = self.line(f"SYN-PT-{n}")
                self.assertIn(UNKNOWN_SENTENCE, line["text"])
                self.assertEqual([["Check Again", False]], line["buttons"])
                self.assertNotIn("Acknowledged", self.row_text(f"SYN-PT-{n}"))
                self.assertEqual([], self.row(f"SYN-PT-{n}")["buttons"], "no Acknowledge while the attempt is unknown")
        def resend(n, ack=None, read=None):
            if ack:
                self.fault("ack", **ack)
            if read:
                self.fault("read", **read)
            posts, reads = len(self.posts()), len(self.requests("read"))
            self.check_again(f"SYN-PT-{n}")
            self.wait_until(lambda: len(self.posts()) > posts, "the Check Again request")
            self.reads_settled()
            again = self.posts()[-1]
            original = [p for p in self.posts()[:posts] if p["path"] == again["path"]][0]
            self.assertEqual(original["raw"], again["raw"], "Check Again sends the same bytes")
            return self.requests("read")[reads:]

        # U-01: the first request was applied (the answer came after the commit): the same bytes replay it - Acknowledged.
        resend(101)
        self.assertIn(f"Acknowledged {kst(SERVER_NOW)}", self.row_text("SYN-PT-101"))
        self.assertEqual("", self.line_text("SYN-PT-101"))
        # The list read after that 201 reads each unknown attempt's record once (U-08): 117, applied while its answer was
        # lost, ends there with the server's acknowledgement; the others stay unknown.
        self.assertIn(f"Acknowledged {kst(SERVER_NOW)}", self.row_text("SYN-PT-117"))
        self.assertEqual("", self.line_text("SYN-PT-117"))
        self.assertIn(UNKNOWN_WORD, self.line_text("SYN-PT-102"))
        # U-02: it was not applied; the resend applies now.
        resend(102)
        self.assertIn("Acknowledged", self.row_text("SYN-PT-102"))
        # U-03 -> U-04: acknowledged meanwhile (another tab of the same person): the resend meets 409 and the record read
        # shows acknowledged - Acknowledged with the server's time.
        s.records[rid(103)].update(state="acknowledged", revision=2, acknowledgedAt=iso(90))
        reads = resend(103)
        self.assertEqual([f"/api/critical-results/{rid(103)}"], [q["path"] for q in reads if q["path"].endswith(rid(103))],
                         "the record read once")
        self.assertIn(f"Acknowledged {kst(iso(90))}", self.row_text("SYN-PT-103"))
        # U-03 -> U-05: cancelled meanwhile; superseded meanwhile - the server state, and Open Replacement.
        s.records[rid(104)].update(state="cancelled", revision=2, cancelledAt=iso(91), cancelReason="SYN reason SYN-REASON-104")
        resend(104)
        self.wait_until(lambda: "Cancelled" in self.line_text("SYN-PT-104"), "the cancelled state")
        line = self.line("SYN-PT-104")
        self.assertIn("SYN-REASON-104", line["text"])
        self.assertEqual([], line["buttons"])
        self.assertNotIn("Acknowledged", line["text"])
        s.records[rid(105)].update(state="superseded", revision=2, supersededAt=iso(92), replacedBy=rid(114))
        resend(105)
        self.wait_until(lambda: "Superseded" in self.line_text("SYN-PT-105"), "the superseded state")
        self.assertEqual([["Open Replacement", False]], self.line("SYN-PT-105")["buttons"])
        # U-07: the head moved (still created): the resend meets SOURCE_CHANGED, the read shows created - still unknown,
        # with the reason a new send would be refused now.
        s.records[rid(106)]["case"] = "C3"
        resend(106)
        line = self.line("SYN-PT-106")
        self.assertIn(UNKNOWN_WORD, line["text"])
        self.assertIn(LATER, line["text"])
        self.assertEqual([["Check Again", False]], line["buttons"])
        # U-06: 404, 403, 503 and no answer to the resend: still unknown, the same request kept, the record read once.
        for n, answer in ((107, {"status": 404, "body": {"code": "CRITICAL_RESULT_NOT_FOUND", "message": "SYN hidden"}}),
                          (108, {"status": 403, "body": {"code": "CRITICAL_RESULT_ROLE_REQUIRED", "message": "SYN role"}}),
                          (109, {"status": 503, "body": {"message": "SYN no code"}}), (110, {"abort": True})):
            with self.subTest(resend=n):
                reads = resend(n, ack=answer, read={"status": 404, "body": {"code": "CRITICAL_RESULT_NOT_FOUND", "message": "SYN"}})
                self.assertEqual([f"/api/critical-results/{rid(n)}"], [q["path"] for q in reads if q["path"].endswith(rid(n))])
                self.assertIn(UNKNOWN_WORD, self.line_text(f"SYN-PT-{n}"))
        # S-09: a read answering for another record says nothing about this one.
        reads = resend(111, ack={"status": 503, "body": {"message": "SYN no code"}},
                       read={"patch": lambda p: p["item"].update(id=rid(1))})
        self.assertIn(UNKNOWN_WORD, self.line_text("SYN-PT-111"))
        # U-08, G-03: the minute's read, then one record read per unknown attempt - and nothing sent. A record gone from the
        # list (C5) is no evidence: its line stays.
        s.records[rid(107)]["case"] = "C5"
        unknown = [n for n in range(101, 118) if UNKNOWN_WORD in self.line_text(f"SYN-PT-{n}")]
        new = self.tick(60000)
        self.assertEqual("list", new[0]["kind"])
        self.assertEqual(sorted(f"/api/critical-results/{rid(n)}" for n in unknown),
                         sorted(q["path"] for q in new if q["kind"] == "read"), "one record read per unknown attempt")
        self.assertEqual([], [q for q in new if q["kind"] == "ack"], "nothing is sent again by itself")
        self.assertIn(UNKNOWN_WORD, self.line_text("SYN-PT-107"))
        self.assertEqual("", self.row_text("SYN-PT-107"))

        # U-09: another record's ACK works on its own; the unknown lines keep their requests.
        self.acknowledge("SYN-PT-115")
        self.wait_until(lambda: "Acknowledged" in self.row_text("SYN-PT-115"), "the other record acknowledged")
        self.assertIn(UNKNOWN_WORD, self.line_text("SYN-PT-106"))
        # The pair: the same 409s of order 12-15 as the answer to a first request are confirmed refusals, not unknown.
        s.add(rec(116))
        self.press("Refresh")
        self.reads_settled()
        s.records[rid(116)]["case"] = "C3"
        self.acknowledge("SYN-PT-116")
        self.wait_until(lambda: self.line_text("SYN-PT-116"), "the refusal")
        line = self.line("SYN-PT-116")
        self.assertIn("CRITICAL_RESULT_SOURCE_CHANGED", line["text"])
        self.assertNotIn(UNKNOWN_WORD, line["text"])
        self.assertEqual([], line["buttons"])
        # A-16 (last: the minute that times a request out is also the minute of the periodic read): no answer within 60 s
        # is unknown; the pair - the 201 that comes at 59 s is applied.
        self.reads_settled()
        self.fault("ack", hold=True)
        self.acknowledge("SYN-PT-112")
        held = self.take("ack")
        self.page.clock.fast_forward(59000)
        self.settle()
        self.assertEqual("", self.line_text("SYN-PT-112"), "at 59 s the request is still waiting")
        self.release(held)
        self.reads_settled()
        self.assertIn(f"Acknowledged {kst(SERVER_NOW)}", self.row_text("SYN-PT-112"))
        self.fault("ack", hold=True, later=True)
        self.acknowledge("SYN-PT-113")
        held = self.take("ack")
        self.page.clock.fast_forward(60000)
        self.wait_until(lambda: UNKNOWN_WORD in self.line_text("SYN-PT-113"), "the timed-out attempt")
        self.release_late(held)
        self.reads_settled()
        self.assertIn(UNKNOWN_SENTENCE, self.line_text("SYN-PT-113"))

    # ── RX11: the minute's read ──
    def test_rx11_periodic_read_is_one_get_per_minute_and_changes_nothing(self):
        self.context.add_init_script("""(() => { window.synNotified = 0; const Real = window.Notification;
          function Counted(...args) { window.synNotified += 1; return Real ? new Real(...args) : {}; }
          Counted.requestPermission = () => { window.synNotified += 1; return Promise.resolve('denied'); };
          Object.defineProperty(Counted, 'permission', { get: () => 'default' });
          window.Notification = Counted; })()""")
        s = self.server
        s.add(rec(71), rec(72, case="C3"))
        # The clock stands still, so a minute is exactly what the case moves it by.
        self.page.clock.pause_at("2030-05-05T06:00:00Z")
        self.open_home()
        rows, badge, title = self.view()["rows"], self.badge(), self.page.title()
        records = copy.deepcopy(s.records)
        pending = ("list", {"view": ["received"], "state": ["pending"]})
        self.assertEqual([], self.tick(59000), "no read before the minute")
        self.assertEqual([pending], [(q["kind"], q["query"]) for q in self.tick(1000)])
        for _ in range(3):
            self.assertEqual([pending], [(q["kind"], q["query"]) for q in self.tick(60000)])
        self.assertEqual(records, s.records, "no record changed")
        self.assertEqual((rows, badge, title), (self.view()["rows"], self.badge(), self.page.title()))
        self.assertIsNone(ACKED.search(self.view()["text"]))
        self.assertEqual(0, self.page.evaluate("() => window.synNotified"), "no notification")
        # Not while the document is hidden; again once it is visible.
        self.page.evaluate("() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })")
        self.assertEqual([], self.tick(120000))
        self.page.evaluate("() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })")
        self.assertEqual([pending], [(q["kind"], q["query"]) for q in self.tick(60000)])
        self.assertEqual([], self.posts())

    # ── RX12: empty state, Show All, More, terminal rows ──
    def test_rx12_empty_show_all_more_and_cursor_end(self):
        s = self.server
        self.open_home()
        empty = self.status()
        self.assertEqual("Pending ACK 0", self.badge())
        self.assertTrue(has_hangul(empty) and empty, empty)
        self.assertEqual([], self.view()["rows"])
        # Show All: the terminal rows with their state names; Acknowledge only on the pending one.
        s.add(rec(71, state="acknowledged"), rec(72, state="cancelled"), rec(73, state="superseded", replacedBy=rid(74)), rec(74),
              rec(75, state="superseded"))
        self.press("Show All")
        self.reads_settled()
        self.assertEqual({"view": ["received"], "state": ["all"]}, self.requests("list")[-1]["query"])
        self.assertIn(["Show All", False, "true", None], self.view()["buttons"])
        self.assertIn(f"Acknowledged {kst(iso(101))}", self.row("SYN-PT-71")["text"])
        self.assertIn("Cancelled", self.row("SYN-PT-72")["text"])
        self.assertIn("SYN reason SYN-REASON-72", self.row("SYN-PT-72")["text"])
        self.assertIn("Superseded", self.row("SYN-PT-73")["text"])
        self.assertEqual([["Open Replacement", False]], self.row("SYN-PT-73")["buttons"])
        self.assertEqual([], self.row("SYN-PT-75")["buttons"], "no Open Replacement without replacedBy")
        for marker in ("SYN-PT-71", "SYN-PT-72"):
            self.assertEqual([], self.row(marker)["buttons"])
        self.assertEqual([["Acknowledge", False]], self.row("SYN-PT-74")["buttons"])
        # W-04: Open Replacement from a list row reads the replacement once.
        reads = len(self.requests("read"))
        self.row_locator("SYN-PT-73").get_by_role("button", name="Open Replacement", exact=True).click()
        self.reads_settled()
        self.assertEqual([f"/api/critical-results/{rid(74)}"], [q["path"] for q in self.requests("read")[reads:]])
        self.assertEqual([["Acknowledge", False]], self.row("SYN-PT-74")["buttons"])
        self.press("Show All")
        self.reads_settled()
        self.assertEqual({"view": ["received"], "state": ["pending"]}, self.requests("list")[-1]["query"])
        self.assertIn(["Show All", False, "false", None], self.view()["buttons"])
        # More passes the cursor as given, adds no duplicate, and is gone after the last page.
        s.add(rec(76), rec(77))
        s.page_size = 2
        self.press("Refresh")
        self.reads_settled()
        cursor = self.requests("list")[-1]
        self.assertEqual(2, len(self.view()["rows"]))
        token = list(s.cursors)[-1]
        self.press("More")
        self.reads_settled()
        self.assertEqual({"view": ["received"], "state": ["pending"], "cursor": [token]}, self.requests("list")[-1]["query"])
        self.assertEqual(3, len(self.view()["rows"]))
        self.assertNotIn("More", [b[0] for b in self.view()["buttons"]])
        self.assertIsNot(cursor, self.requests("list")[-1])
        # The pair: a first page without nextCursor offers no More.
        s.page_size = 50
        self.press("Refresh")
        self.reads_settled()
        self.assertNotIn("More", [b[0] for b in self.view()["buttons"]])
        # The pair: the same empty list refused (500) is a failure, not the empty state.
        s.records.clear()
        self.press("Refresh")
        self.reads_settled()
        self.assertEqual(empty, self.status())
        self.fault("list", status=500, body={"message": "SYN failure"})
        self.press("Refresh")
        self.reads_settled()
        self.assertNotEqual(empty, self.status())
        self.assert_no_count("failed")

    # ── RX13: confirmed refusals ──
    def test_rx13_confirmed_refusals_by_code(self):
        s = self.server
        refusal = lambda status, code: {"status": status, "body": {"code": code, "message": "SYN refusal"}}
        cases = [(121, refusal(400, "CRITICAL_RESULT_INPUT_INVALID"), "CRITICAL_RESULT_INPUT_INVALID", "HTTP 400"),
                 (122, refusal(403, "CRITICAL_RESULT_ROLE_REQUIRED"), "CRITICAL_RESULT_ROLE_REQUIRED", "HTTP 403"),
                 (123, refusal(403, "CLINICIAN_ROUTE_DENIED"), "CLINICIAN_ROUTE_DENIED", "HTTP 403"),
                 (124, refusal(403, "INSTITUTION_INVALID"), "INSTITUTION_INVALID", "HTTP 403"),
                 (125, {"status": 403, "body": {"statusCode": 403, "message": "SYN refusal", "error": "Forbidden"}}, None, "HTTP 403"),
                 (126, refusal(404, "CRITICAL_RESULT_NOT_FOUND"), "CRITICAL_RESULT_NOT_FOUND", "HTTP 404"),
                 (127, None, "CRITICAL_RESULT_CHANGED", "HTTP 409"),
                 (128, None, "CRITICAL_RESULT_SOURCE_CHANGED", "HTTP 409"),
                 (129, None, "CRITICAL_RESULT_ACKNOWLEDGED", "HTTP 409"),
                 (130, refusal(409, "REQUEST_ID_REUSED"), "REQUEST_ID_REUSED", "HTTP 409"),
                 (131, refusal(503, "CRITICAL_RESULT_UNAVAILABLE"), "CRITICAL_RESULT_UNAVAILABLE", "HTTP 503")]
        s.add(*[rec(n) for n, *_ in cases], rec(132), rec(133))
        self.open_home()
        # What changes on the server after this screen read the list, just before the click: A-12 the record's revision,
        # A-13 its head moved, A-14 acknowledged in another tab.
        changes = {127: lambda: s.records[rid(127)].update(revision=2), 128: lambda: s.records[rid(128)].update(case="C3"),
                   129: lambda: s.records[rid(129)].update(state="acknowledged", revision=2, acknowledgedAt=iso(80))}
        reasons = {}
        for n, spec, code, status in cases:
            with self.subTest(record=n, code=code):
                if spec:
                    self.fault("ack", **spec)
                if n in changes:
                    changes[n]()
                lists = len(self.requests("list"))
                self.acknowledge(f"SYN-PT-{n}")
                self.wait_until(lambda: self.line_text(f"SYN-PT-{n}"), "the refusal")
                self.reads_settled()
                line = self.line(f"SYN-PT-{n}")
                for part in [status, "SYN refusal" if spec else f"SYN {code} message"] + ([code] if code else []):
                    self.assertIn(part, line["text"])
                self.assertTrue(has_hangul(line["text"]))
                self.assertNotIn(UNKNOWN_WORD, line["text"])
                self.assertEqual([], line["buttons"], "no Check Again for a confirmed refusal")
                self.assertIsNone(ACKED.search(line["text"] + self.row_text(f"SYN-PT-{n}")))
                self.assertGreater(len(self.requests("list")), lists, "the list is read again")
                reasons[n] = " ".join(re.findall(r"[^\n]*[가-힣][^\n]*", line["text"]))
        self.assertEqual(len(reasons), len(set(reasons.values())), "each refusal says why in its own words")
        # A-13: the list read again shows the stub; A-14: the record left the pending list.
        self.assertIn("Source Changed", self.row_text("SYN-PT-128"))
        self.assertEqual("", self.row_text("SYN-PT-129"))
        # G-04: after a confirmed refusal the next click is a new request, with the revision the list shows now.
        for n, revision in ((121, 1), (127, 2)):
            before = [p["body"]["requestId"] for p in self.posts()]
            self.acknowledge(f"SYN-PT-{n}")
            self.wait_until(lambda: len(self.posts()) > len(before), "the new request")
            self.reads_settled()
            again = self.posts()[-1]["body"]
            self.assertNotIn(again["requestId"], before)
            self.assertEqual(revision, again["revision"])
        self.assertIn("Acknowledged", self.row_text("SYN-PT-127"))
        # The pairs: a 403 whose body is not JSON, and a 503 without a code, are unknown.
        for n, spec in ((132, {"raw": (403, "<html>SYN forbidden</html>")}), (133, {"status": 503, "body": {"message": "SYN no code"}})):
            self.fault("ack", **spec)
            self.acknowledge(f"SYN-PT-{n}")
            self.wait_until(lambda: UNKNOWN_WORD in self.line_text(f"SYN-PT-{n}"), "the unknown line")

    # ── RX14: the reading panel ──
    def test_rx14_reader_panel_r2_ack_visibility_roles_and_session_end(self):
        s = self.server = RecipientServer([INSTITUTION, RAD["sub"]])
        self.servers = [s]
        s.add(rec(141, case="R2", source={"version": 1, "action": "save", "author": "syn-rad@kin", "at": "2026-09-28T00:30:00.000Z"}))
        self.open_panel()
        # The body opened by itself: the first read has a pending record.
        expect(self.region().get_by_role("button", name="Hide Received", exact=True)).to_be_visible()
        seen = self.row("SYN-PT-141")
        self.assertIn(f"Source: v1 · Save · syn-rad@kin · {kst('2026-09-28T00:30:00.000Z')}", seen["text"])
        self.assertEqual([["Acknowledge", False]], seen["buttons"])
        self.acknowledge("SYN-PT-141")
        self.wait_until(lambda: "Acknowledged" in self.row_text("SYN-PT-141"), "Acknowledged")
        self.reads_settled()
        self.assertIn(f"Acknowledged {kst(SERVER_NOW)}", self.row_text("SYN-PT-141"), "the row stays until Refresh")
        self.assertEqual("Pending ACK 0", self.badge())
        self.press("Refresh")
        self.reads_settled()
        self.assertEqual([], self.view()["rows"])
        expect(self.region().get_by_role("button", name="Hide Received", exact=True)).to_be_visible()
        self.assertTrue(has_hangul(self.status()))
        self.press("Show All")
        self.reads_settled()
        self.assertIn(f"Acknowledged {kst(SERVER_NOW)}", self.row("SYN-PT-141")["text"])
        # P-04: the reading target changes (A, B, A): the panel reads nothing.
        count = len(self.log)
        self.page.evaluate(f"() => {{ synPick('{suid(1)}'); synPick('{suid(2)}'); synPick('{suid(1)}'); }}")
        self.settle()
        self.assertEqual(count, len(self.log))
        # Hide Received folds the body only: the summary line and Refresh stay.
        self.press("Hide Received")
        seen = self.view()
        self.assertEqual([], seen["rows"])
        self.assertEqual({"Show Received", "Refresh"}, {b[0] for b in seen["buttons"]})
        # M-12 and R-05: a clinician + technician member gets the C rows; admin + radiologist reads as a radiologist.
        for person, roles, cases in ((CLIN, ["clinician", "technician"], ("C2", "C3")), (RAD, ["admin", "radiologist"], ("R2",))):
            with self.subTest(roles=roles):
                s = self.server = RecipientServer([INSTITUTION, person["sub"]])
                self.servers.append(s)
                for n, case in enumerate(cases, start=142):
                    s.add(rec(n, case=case))
                self.log.clear()
                self.open_panel(person, roles, fold_open=True)
                self.assertEqual([{"view": ["received"], "state": ["pending"]}], [q["query"] for q in self.log])
                self.assertEqual([["Acknowledge", False]], self.row("SYN-PT-142")["buttons"])
                if len(cases) > 1:
                    self.assertIn(STUB_SENTENCE, self.row("SYN-PT-143")["text"])
        # S-05: a logout start of the page calls the end list while a read is held: the panel ends first, and the late
        # answer paints nothing. The pair: the same held answer with no end paints.
        for end in (False, True):
            with self.subTest(end_list=end):
                s = self.server = RecipientServer([INSTITUTION, RAD["sub"]])
                self.servers.append(s)
                s.add(rec(144, case="R2"))
                self.open_panel(fold_open=True)
                s.add(rec(145, case="R2"))
                self.fault("list", hold=True)
                self.press("Refresh")
                held = self.take("list")
                if end:
                    self.page.evaluate("() => (window.kinOn401 || []).forEach(done => { try { done(); } catch (_) {} })")
                    self.assertFalse(self.view()["shown"], "the panel ended before the network answered")
                    self.release_late(held)
                    count = len(self.log)
                    self.tick(60000)
                    self.assertFalse(self.view()["shown"])
                    self.assertEqual(count, len(self.log))
                else:
                    self.release(held)
                    self.row("SYN-PT-145")
        # S-06: another area's account change reaches this panel through the end list: locked, nothing more read.
        s = self.server = RecipientServer([INSTITUTION, RAD["sub"]])
        self.servers.append(s)
        s.add(rec(146, case="R2"))
        self.open_panel(fold_open=True)
        self.page.evaluate("() => (window.kinOn401 || []).forEach(done => { try { done('account-changed', 'SYN other'); } catch (_) {} })")
        self.assertEqual([], self.view()["rows"])
        self.assert_no_count("locked")
        count = len(self.log)
        self.tick(60000)
        self.assertEqual(count, len(self.log))
        # S-10: leaving the document ends the panel.
        self.open_panel(fold_open=True)
        self.page.evaluate("() => window.dispatchEvent(new Event('pagehide'))")
        self.assertFalse(self.view()["shown"])
        # A-17: a 401 on each of the panel's requests ends the panel, calls the end list once, then the logout option once.
        for kind in ("pending", "all", "more", "read", "ack"):
            with self.subTest(expired=kind):
                s = self.server = RecipientServer([INSTITUTION, RAD["sub"]])
                self.servers.append(s)
                self.faults.clear()
                s.add(rec(146, case="R2"), rec(147, case="R2"), rec(148, case="R2"),
                      rec(149, case="R2", state="superseded", replacedBy=rid(148)))
                s.page_size = 2
                expired = {"status": 401, "body": {"statusCode": 401, "message": "SYN expired"}}
                if kind == "pending":
                    self.fault("list", **expired)
                    self.open_panel()
                else:
                    self.open_panel(fold_open=True)
                    if kind == "all":
                        self.fault("list", **expired)
                        self.press("Show All")
                    elif kind == "more":
                        self.fault("list", **expired)
                        self.press("More")
                    elif kind == "read":
                        self.press("Show All")
                        self.reads_settled()
                        self.fault("read", **expired)
                        self.row_locator("SYN-PT-149").get_by_role("button", name="Open Replacement", exact=True).click()
                    else:
                        self.fault("ack", **expired)
                        self.acknowledge("SYN-PT-148")
                self.wait_until(lambda: self.page.evaluate("() => window.synLogouts") == 1, "the logout option")
                self.settle()
                self.assertFalse(self.view()["shown"])
                self.assertEqual((["end"], 1), (self.page.evaluate("() => window.synOtherEnds"),
                                                self.page.evaluate("() => window.synLogouts")))

    # ── RX15: wording, fonts, targets, keyboard, external strings ──
    def hostile_records(self, hostile):
        s = self.server
        bad = ('<img src=x onerror="window.synXss=1">', "<script>window.synXss=2</script>", '"><svg onload="window.synXss=3">')
        text = (lambda i, marker: f"{bad[i % 3]} {marker}") if hostile else (lambda i, marker: f"plain words {i} {marker}")
        made = []
        for i, (n, state, case) in enumerate(((151, "created", "C2"), (152, "created", "C3"), (153, "acknowledged", "C2"),
                                              (154, "cancelled", "C2"), (155, "superseded", "C2"), (156, "created", "C2"),
                                              (157, "created", "C2"))):
            record = rec(n, state=state, case=case, message=text(i, f"SYN-MSG-{n}"), sender=text(i + 1, f"SYN-SENDER-{n}"),
                         body={"findings": text(i + 2, f"SYN-BODY-{n}F"), "conclusion": "", "recommendation": ""})
            record["study"]["name"] = text(i, f"SYN-PT-{n}")
            if state == "cancelled":
                record["cancelReason"] = text(i, f"SYN-REASON-{n}")
            if state == "superseded":
                record["replacedBy"] = rid(156)
            made.append(s.add(record))
        return made

    ELEMENTS = """(root) => ['img', 'script', 'svg'].map(tag => document.querySelector(root).querySelectorAll(tag).length)"""

    def test_rx15_wording_limits_fonts_targets_keyboard_and_external_text(self):
        counts = {}
        for hostile in (False, True):
            with self.subTest(hostile=hostile):
                self.server = RecipientServer([INSTITUTION, CLIN["sub"]])
                self.servers.append(self.server)
                self.server.page_size = 6
                self.hostile_records(hostile)
                self.open_home()
                self.fault("ack", status=503, body={"code": "CRITICAL_RESULT_BUSY", "message": "SYN busy"})
                self.acknowledge("SYN-PT-157")
                self.wait_until(lambda: UNKNOWN_WORD in self.line_text("SYN-PT-157"), "an unknown attempt")
                self.fault("ack", status=409, body={"code": "CRITICAL_RESULT_CANCELLED",
                                                    "message": '<img src=x onerror="window.synXss=4"> SYN server words'})
                self.acknowledge("SYN-PT-151")
                self.wait_until(lambda: "SYN server words" in self.line_text("SYN-PT-151"), "the refusal")
                self.press("Show All")
                self.reads_settled()
                seen = self.view()
                counts[hostile] = self.page.evaluate(self.ELEMENTS, self.root)
                self.assertIsNone(self.page.evaluate("() => window.synXss ?? null"), "nothing the server sent ran")
                if hostile:
                    for fragment in ('<img src=x onerror="window.synXss=1">', "<script>window.synXss=2</script>",
                                     '"><svg onload="window.synXss=3">', '<img src=x onerror="window.synXss=4"> SYN server words'):
                        self.assertIn(fragment, seen["text"], "external text is shown as the letters it is")
                    self.english_names_korean_explanations_and_limits(seen)
                    self.page_wording_fonts_and_targets()
                    self.keyboard_from_the_top()
                    self.log_out_signal()
        self.assertEqual(counts[False], counts[True], "the external strings made no element")
        # The reading panel: the same strings as text, its own names, nothing ran.
        s = self.server = RecipientServer([INSTITUTION, RAD["sub"]])
        self.servers.append(s)
        self.hostile_records(True)
        for record in s.records.values():
            record["case"] = {"C2": "R2", "C3": "R3"}[record["case"]]
            record["full"] = record["case"] == "R2"
        self.open_panel(fold_open=True)
        self.press("Show All")
        self.reads_settled()
        panel = self.view()
        self.assertIn('<img src=x onerror="window.synXss=1">', panel["text"])
        self.assertEqual([0, 0, 0], self.page.evaluate(self.ELEMENTS, self.root))
        self.assertIsNone(self.page.evaluate("() => window.synXss ?? null"))
        names = [b[0] for b in panel["buttons"]]
        for name in ("Hide Received", "Refresh", "Show All", "Acknowledge"):
            self.assertIn(name, names)
        self.assertEqual([], [n for n in names if has_hangul(n)])
        for sentence in LIMITS:
            self.assertIn(sentence, panel["text"])

    def english_names_korean_explanations_and_limits(self, seen):
        names = [b[0] for b in seen["buttons"]] + [self.badge()]
        names.append(self.region().get_by_role("heading", name="Critical Results", exact=True).text_content())
        self.assertEqual([], [name for name in names if has_hangul(name)], "controls, state names and the title are English")
        for name in ENGLISH_NAMES:
            self.assertIn(name, seen["text"])
        for sentence in LIMITS:
            self.assertIn(sentence, seen["text"])
        titles = self.page.evaluate("""(root) => [...document.querySelector(root).querySelectorAll('[title]')].map(e => e.title)""",
                                    self.root)
        self.assertTrue(titles and all(has_hangul(title) for title in titles), titles)
        self.assertTrue(has_hangul(self.status()))

    def page_wording_fonts_and_targets(self):
        texts = self.page.evaluate(PAGE_TEXT)
        self.assertEqual([], [item["text"] for item in texts if AVOIDED.search(item["text"])])
        self.assertEqual([], [(item["text"], item["tag"]) for item in texts if acknowledgement_outside(item)])
        self.assertTrue([item for item in texts if item["inside"] and ACKNOWLEDGED.search(item["text"])])
        small = [(item["text"][:40], item["size"]) for item in texts if item["inside"] and item["size"] is not None and item["size"] < 12]
        self.assertEqual([], small)
        targets = self.page.evaluate("""(root) => [...document.querySelector(root).querySelectorAll('button')]
          .filter(b => b.getClientRects().length).map(b => { const r = b.getBoundingClientRect(); return [b.textContent, r.width, r.height]; })""",
                                     self.root)
        self.assertGreaterEqual(len(targets), 5)
        for name, width, height in targets:
            self.assertGreaterEqual(min(width, height), 24, name)

    def keyboard_from_the_top(self):
        # T-06: Log out, then the region's controls, then Studies' Refresh.
        self.page.locator("#logout").focus()
        stops = []
        self.page.keyboard.press("Tab")
        while len(stops) < 40 and self.page.evaluate(FOCUS, self.root)["inside"]:
            stops.append(self.page.evaluate(FOCUS, self.root)["text"])
            self.page.keyboard.press("Tab")
        self.assertEqual("refresh", self.page.evaluate("() => document.activeElement.id"))
        for name in ("Show All", "Refresh", "Acknowledge", "Check Again", "Open Replacement"):
            self.assertIn(name, stops)

    def log_out_signal(self):
        writes = len(self.writes)
        self.log_out_home()
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        signal = [w for w in self.writes[writes:] if w["kind"] == "localStorage" and w["names"] == ["kin-session-ended"]]
        self.assertEqual(["setItem", "removeItem"], [w["op"] for w in signal])
        self.assertRegex(signal[0]["text"], r"^\d+$")

    # ── RX16: sessions that never read ──
    def test_rx16_sessions_that_never_read(self):
        for code in ("INSTITUTION_PENDING", "INSTITUTION_INVALID"):
            with self.subTest(membership=code):
                self.me = (403, {"code": code})
                self.page.goto(ORIGIN + BASE + "clinician.html")
                expect(self.page.locator("#membership")).to_be_visible()
                expect(self.page.locator("#home")).to_be_hidden()
                self.settle()
                self.assertEqual([], self.log)
        # A demo session goes to the worklist's demo and reads nothing here.
        self.me = me(CLIN, ["clinician"])
        self.page.goto(ORIGIN + BASE + "blank.html")
        self.page.evaluate("() => sessionStorage.setItem('kin-demo', '1')")
        self.page.goto(ORIGIN + BASE + "clinician.html")
        self.page.wait_for_url(ORIGIN + BASE + "main.html")
        self.settle()
        self.assertEqual([], self.log)
        self.page.evaluate("() => sessionStorage.removeItem('kin-demo')")
        # R-06: Clinician Home reads the list for any approved member and draws what the server answers.
        self.server.add(rec(161))
        self.me = me(CLIN, ["clinician", "technician"])
        self.open_home()
        self.assertEqual(1, len(self.requests("list")))
        self.row("SYN-PT-161")
        # The reading panel: technician only, admin only, a demo session, offline - no read, no panel.
        cases = [("technician", CLIN, ["technician"], None), ("admin", CLIN, ["admin"], None),
                 ("demo", RAD, ["radiologist"], {"serverMode": False, "offline": False, "demoMode": True}),
                 ("offline", RAD, ["radiologist"], {"serverMode": False, "offline": True, "demoMode": False})]
        for name, person, roles, mode in cases:
            with self.subTest(panel=name):
                self.log.clear()
                self.open_panel(person, roles, mode=mode)
                self.tick(60000)
                self.assertEqual([], self.log)
                self.assertFalse(self.view()["shown"])
        # The pair: the same technician with radiologist added reads once.
        self.server = RecipientServer([INSTITUTION, CLIN["sub"]])
        self.servers.append(self.server)
        self.log.clear()
        self.open_panel(CLIN, ["technician", "radiologist"])
        self.assertEqual(1, len(self.log))
        self.assertTrue(self.view()["shown"])
        # The page's own order: the panel is mounted before boot gives the session and connects the server. It reads
        # nothing then, and reads once as soon as the session is a receiving one.
        self.server = RecipientServer([INSTITUTION, RAD["sub"]])
        self.servers.append(self.server)
        self.log.clear()
        self.open_panel(boot=False)
        self.tick(5000)
        self.assertEqual(([], False), (self.log, self.view()["shown"]))
        self.page.evaluate("s => window.synBoot(s)", session(RAD, ["radiologist"]))
        self.tick(2000)
        self.assertEqual(1, len(self.log))
        self.assertTrue(self.view()["shown"])

    # ── RX17: read failures ──
    def test_rx17_read_failures_are_failures_not_empty(self):
        s = self.server
        self.open_home()
        empty = self.status()
        failures = [
            ({"status": 500, "body": {"message": "SYN failure"}}, ["SYN failure", "HTTP 500"]),
            ({"status": 403, "body": {"code": "CRITICAL_RESULT_ROLE_REQUIRED", "message": "SYN role"}}, ["SYN role", "CRITICAL_RESULT_ROLE_REQUIRED"]),
            ({"status": 409, "body": {"code": "STUDY_ACCESS_CHANGED", "message": "SYN access"}}, ["SYN access", "STUDY_ACCESS_CHANGED"]),
            ({"patch": lambda p: p.update(items={"rows": []})}, []),
            ({"patch": lambda p: p.pop("pending")}, []),
            ({"patch": lambda p: p.update(view="sent")}, []),
            ({"patch": lambda p: p["items"].append({**RecipientServer([]).view(rec(162, state="cancelled"))})}, []),
            ({"patch": lambda p: p["items"].append({**RecipientServer([]).view(rec(163)), "revision": 3})}, []),
            ({"patch": lambda p: p.update(owner=[INSTITUTION])}, []),
        ]
        for spec, words in failures:
            with self.subTest(spec=str(spec)[:60]):
                self.fault("list", **spec)
                self.press("Refresh")
                self.reads_settled()
                status = self.status()
                self.assertNotEqual(empty, status)
                self.assertTrue(has_hangul(status))
                for word in words:
                    self.assertIn(word, status)
                if not words:
                    self.assertNotIn("HTTP", status, "a malformed 200 is not a refusal")
                self.assert_no_count("failed")
                self.assertEqual([], self.view()["rows"])
                # Refresh reads again and recovers.
                self.press("Refresh")
                self.reads_settled()
                self.assertEqual((empty, "Pending ACK 0"), (self.status(), self.badge()))
        # More refused (a cursor the server no longer takes): a failure; Refresh starts from the first page.
        s.add(rec(164), rec(165))
        s.page_size = 1
        self.press("Refresh")
        self.reads_settled()
        self.fault("list", status=400, body={"code": "CRITICAL_RESULT_INPUT_INVALID", "message": "SYN cursor"})
        self.press("More")
        self.reads_settled()
        self.assertIn("CRITICAL_RESULT_INPUT_INVALID", self.status())
        self.assert_no_count("failed")
        self.press("Refresh")
        self.reads_settled()
        self.assertEqual({"view": ["received"], "state": ["pending"]}, self.requests("list")[-1]["query"])
        self.assertEqual(1, len(self.view()["rows"]))
        # A 401 ends the session the way the page does: closed, one POST /auth/logout, one navigation.
        self.fault("list", status=401, body={"statusCode": 401, "message": "SYN expired"})
        logouts, documents = len(self.logouts), len(self.documents)
        self.press("Refresh")
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        self.assertEqual(1, len(self.logouts) - logouts)
        self.assertEqual([ORIGIN + BASE + "index.html"], [url for page, url in self.documents[documents:] if page is self.page])

    # ── RX18: the reading panel's summary line, history and one bar ──
    GEOMETRY = """() => { const q = s => document.querySelector(s), box = e => e.getBoundingClientRect();
      const panel = q('#cvr-inbox-p'), toggle = [...panel.querySelectorAll('button')].find(b => /^(Show|Hide) Received$/.test(b.textContent));
      const fields = [...q('.redit').querySelectorAll('textarea')];
      const shown = { panel: box(panel).height, button: box(toggle).height, redit: box(q('.redit')).height,
        rbtns: [box(q('.rbtns')).top, box(q('.rbtns')).height], sent: q('#cvr-sent-p').outerHTML,
        reditMin: parseFloat(getComputedStyle(q('.redit')).minHeight) || 0,
        fields: fields.map(f => [box(f).height, parseFloat(getComputedStyle(f).minHeight) || 0]) };
      panel.hidden = true;
      const hidden = { redit: box(q('.redit')).height, rbtns: [box(q('.rbtns')).top, box(q('.rbtns')).height], sent: q('#cvr-sent-p').outerHTML };
      panel.hidden = false;
      return { shown, hidden }; }"""

    def test_rx18_reader_panel_summary_history_refresh_and_one_bar(self):
        s = self.server = RecipientServer([INSTITUTION, RAD["sub"]])
        self.servers = [s]
        s.add(rec(171, case="R2", state="acknowledged"), rec(172, case="R2", state="cancelled"),
              rec(173, case="R2", state="superseded", replacedBy=rid(174)), rec(174, case="R2", state="acknowledged"))
        self.open_panel()
        # P-01: nothing pending, history there: the summary line with Refresh, the body folded.
        seen = self.view()
        self.assertEqual("Pending ACK 0", self.badge())
        self.assertEqual({("Show Received", "false"), ("Refresh", None)}, {(b[0], b[3]) for b in seen["buttons"]})
        self.assertEqual([], seen["rows"])
        sent = self.page.locator("#cvr-sent-p").evaluate("e => e.outerHTML")
        for layout in ("plain", "reading"):
            with self.subTest(layout=layout):
                if layout == "reading":
                    self.page.evaluate("() => document.body.classList.add('reading')")
                g = self.page.evaluate(self.GEOMETRY)
                self.assertLess(g["shown"]["panel"], 2 * g["shown"]["button"], "the panel is one row: its summary line")
                self.assertAlmostEqual(g["hidden"]["redit"] - g["shown"]["redit"], g["shown"]["panel"], delta=1)
                self.assertEqual((g["hidden"]["rbtns"], g["hidden"]["sent"]), (g["shown"]["rbtns"], g["shown"]["sent"]))
                self.assertGreaterEqual(g["shown"]["redit"], g["shown"]["reditMin"])
                for height, minimum in g["shown"]["fields"]:
                    self.assertGreaterEqual(height, minimum)
        self.page.evaluate("() => document.body.classList.remove('reading')")
        # P-09: the history is reachable with nothing pending.
        self.press("Show Received")
        self.assertTrue(has_hangul(self.status()))
        self.press("Show All")
        self.reads_settled()
        self.assertIn("Acknowledged", self.row("SYN-PT-171")["text"])
        self.assertIn("Cancelled", self.row("SYN-PT-172")["text"])
        self.row_locator("SYN-PT-173").get_by_role("button", name="Open Replacement", exact=True).click()
        self.reads_settled()
        self.assertEqual([f"/api/critical-results/{rid(174)}"], [q["path"] for q in self.requests("read")])
        self.press("Hide Received")
        self.assertEqual({"Show Received", "Refresh"}, {b[0] for b in self.view()["buttons"]})
        # P-02: a failed read shows a word with no number, and opens the body with the failure and Refresh.
        self.server = RecipientServer([INSTITUTION, RAD["sub"]])
        self.servers.append(self.server)
        self.fault("list", status=500, body={"message": "SYN failure"})
        self.open_panel()
        self.assert_no_count("failed")
        self.assertIn("SYN failure", self.status())
        self.assertIn(["Hide Received", False, None, "true"], self.view()["buttons"])
        # The pair: pending 1 opens the body, and the panel is then more than its summary line.
        s = self.server = RecipientServer([INSTITUTION, RAD["sub"]])
        self.servers.append(s)
        s.add(rec(175, case="R2"))
        self.open_panel()
        g = self.page.evaluate(self.GEOMETRY)
        self.assertGreater(g["shown"]["panel"], 2 * g["shown"]["button"], "the open body is measured too")
        # P-07: the body opens by itself only on its four triggers and never closes by itself; nothing about it is kept.
        self.press("Hide Received")
        self.tick(60000)
        self.assertIn(["Show Received", False, None, "false"], self.view()["buttons"], "the same pending: stays folded")
        s.add(rec(176, case="R2"))
        self.tick(60000)
        self.assertIn(["Hide Received", False, None, "true"], self.view()["buttons"], "pending rose: opens")
        s.records.pop(rid(176))
        self.tick(60000)
        self.assertIn(["Hide Received", False, None, "true"], self.view()["buttons"], "pending fell: stays open")
        self.press("Hide Received")
        self.fault("list", status=500, body={"message": "SYN failure"})
        self.tick(60000)
        self.assertIn(["Hide Received", False, None, "true"], self.view()["buttons"], "a failed read opens it")
        self.press("Refresh")
        self.reads_settled()
        self.fault("ack", hold=True, status=503, body={"code": "CRITICAL_RESULT_BUSY", "message": "SYN busy"})
        self.acknowledge("SYN-PT-175")
        held = self.take("ack")
        self.press("Hide Received")
        self.release(held)
        self.assertIn(["Hide Received", False, None, "true"], self.view()["buttons"], "an unknown acknowledgement opens it")
        # P-06: the minute's read with the body folded and open alike; none while the document is hidden.
        self.press("Hide Received")
        for label in ("folded", "open"):
            new = self.tick(60000)
            self.assertEqual("list", new[0]["kind"], label)
            self.assertEqual([], [q for q in new if q["kind"] == "ack"])
            if label == "folded":
                self.press("Show Received")
        self.page.evaluate("() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })")
        self.assertEqual([], self.tick(120000))
        self.page.evaluate("() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })")
        # P-08, T-07: the keyboard reaches Show Received and Refresh, and Show All in the open body.
        self.page.locator("#b-next").focus()
        reached = []
        for _ in range(4):
            self.page.keyboard.press("Tab")
            reached.append(self.page.evaluate(FOCUS, self.root)["text"])
        self.assertEqual(["Hide Received", "Refresh", "Show All"], reached[:3])
        # T-05: the acknowledgement words of the reading screen stand inside the critical result areas only (S7-U1b's Mark
        # CVR tooltip is the dialog's entry, D128 OP-3); a line outside them is reported.
        outside = """() => { const allowed = e => !!e.closest('#cvr-inbox-p, #cvr-send, #cvr-sent-p, #b-mark-cvr'), out = [];
          const words = /\\bACK\\b|acknowledg|수신 확인/i, walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) { const p = walker.currentNode.parentElement;
            if (p && !['SCRIPT', 'STYLE'].includes(p.tagName) && words.test(walker.currentNode.textContent) && !allowed(p)) out.push(walker.currentNode.textContent.trim()); }
          for (const e of document.querySelectorAll('[title], [aria-label]')) for (const n of ['title', 'aria-label'])
            if (e.hasAttribute(n) && words.test(e.getAttribute(n)) && !allowed(e)) out.push(e.getAttribute(n));
          return out; }"""
        self.assertEqual([], self.page.evaluate(outside))
        self.page.evaluate("() => { const p = document.createElement('p'); p.textContent = 'Pending ACK 1'; document.querySelector('.redit').append(p); }")
        self.assertEqual(["Pending ACK 1"], self.page.evaluate(outside))
        # P-05: the panel wrote nothing into the sender's areas.
        self.assertEqual(sent, self.page.locator("#cvr-sent-p").evaluate("e => e.outerHTML"))

    # ── RX19: server changes apply under focus; focus lands safely ──
    def focus_on(self, marker, name="Acknowledge"):
        self.row_locator(marker).get_by_role("button", name=name, exact=True).focus()
        self.page.evaluate("(root) => { window.synFocusOut = 0; document.querySelector(root).addEventListener('focusout', () => { window.synFocusOut += 1; }); }",
                           self.root)

    def landed(self, marker, words):
        """Focus after the change: inside the region, not a button, on the element that shows the record's new state."""
        focus = self.page.evaluate(FOCUS, self.root)
        self.assertTrue(focus["inside"], focus)
        self.assertNotEqual("BUTTON", focus["tag"], focus)
        self.assertIn(words, focus["text"])
        self.assertIn(marker, focus["item"] or "", focus)

    def test_rx19_server_changes_apply_under_focus_and_focus_lands_safely(self):
        s = self.server
        s.add(*[rec(n) for n in range(181, 190)])
        self.open_home()
        # L-08: the same answer: the focused row is not made again - focus stays and no focusout happens.
        self.focus_on("SYN-PT-181")
        self.tick(60000)
        self.assertEqual(0, self.page.evaluate("() => window.synFocusOut"))
        self.assertEqual(("BUTTON", "Acknowledge"), tuple(self.page.evaluate(FOCUS, self.root)[k] for k in ("tag", "text")))
        self.assertIn("SYN-PT-181", self.page.evaluate(FOCUS, self.root)["item"])
        # Another record changed: that row changes, the focused one stays.
        s.records[rid(182)]["case"] = "C3"
        self.tick(60000)
        self.assertIn("Source Changed", self.row_text("SYN-PT-182"))
        self.assertEqual(0, self.page.evaluate("() => window.synFocusOut"))
        # L-09: the focused record became a stub (head moved; reset): at once, no Acknowledge, and focus on its state.
        for marker, case in (("SYN-PT-181", "C3"), ("SYN-PT-183", "C4")):
            with self.subTest(stub=case):
                self.focus_on(marker)
                s.records[rid(int(marker[-3:]))]["case"] = case
                self.tick(60000)
                seen = self.row(marker)
                self.assertEqual([], seen["buttons"])
                self.assertIn(STUB_SENTENCE, seen["text"])
                self.assertNotIn(f"SYN-MSG-{marker[-3:]}", seen["text"])
                self.landed(marker, "Source Changed")
        # L-10: the focused record left the list (C5): the row goes, focus to the list's heading, the badge follows.
        self.focus_on("SYN-PT-184")
        s.records[rid(184)]["case"] = "C5"
        self.tick(60000)
        self.assertEqual("", self.row_text("SYN-PT-184"))
        focus = self.page.evaluate(FOCUS, self.root)
        self.assertEqual((True, None, "Critical Results"), (focus["inside"], focus["item"], focus["text"]))
        self.assertEqual(f"Pending ACK {sum(1 for r in s.records.values() if s.visible(r) and r['state'] == 'created')}", self.badge())
        # L-12: under Show All the focused record is cancelled, superseded, acknowledged in another tab: at once.
        self.press("Show All")
        self.reads_settled()
        for n, change, words in ((185, dict(state="cancelled", revision=2, cancelledAt=iso(95), cancelReason="SYN reason SYN-REASON-185"), "Cancelled"),
                                 (186, dict(state="superseded", revision=2, supersededAt=iso(96), replacedBy=rid(187)), "Superseded"),
                                 (188, dict(state="acknowledged", revision=2, acknowledgedAt=iso(97)), "Acknowledged")):
            with self.subTest(terminal=words):
                self.focus_on(f"SYN-PT-{n}")
                s.records[rid(n)].update(change)
                self.tick(60000)
                self.assertNotIn(["Acknowledge", False], self.row(f"SYN-PT-{n}")["buttons"])
                self.landed(f"SYN-PT-{n}", words)
        # L-13: an unknown attempt's record turns into a stub, then leaves the list: its line, Check Again and request stay,
        # the minute reads the record once, and while the line is the same the focus on Check Again stays.
        self.fault("ack", status=503, body={"code": "CRITICAL_RESULT_BUSY", "message": "SYN busy"})
        self.acknowledge("SYN-PT-189")
        self.wait_until(lambda: UNKNOWN_WORD in self.line_text("SYN-PT-189"), "the unknown line")
        sent = self.posts()[-1]["raw"]
        self.line_locator("SYN-PT-189").get_by_role("button", name="Check Again", exact=True).focus()
        self.page.evaluate("(root) => { window.synFocusOut = 0; document.querySelector(root).addEventListener('focusout', () => { window.synFocusOut += 1; }); }", self.root)
        for case in ("C3", "C5"):
            with self.subTest(unknown=case):
                s.records[rid(189)]["case"] = case
                new = self.tick(60000)
                self.assertEqual([f"/api/critical-results/{rid(189)}"], [q["path"] for q in new if q["kind"] == "read"])
                self.assertEqual([], [q for q in new if q["kind"] == "ack"])
                self.assertIn(UNKNOWN_WORD, self.line_text("SYN-PT-189"))
                self.assertEqual(0, self.page.evaluate("() => window.synFocusOut"))
                self.assertEqual("Check Again", self.page.evaluate(FOCUS, self.root)["text"])
        self.check_again("SYN-PT-189")
        self.wait_until(lambda: len(self.posts()) > 1, "Check Again")
        self.assertEqual(sent, self.posts()[-1]["raw"])
        # L-11 (the reading panel): the focused R2 record's head moved (R3 full): Acknowledge goes at once, the sentence and
        # the pinned body come, focus on its state.
        p = self.server = RecipientServer([INSTITUTION, RAD["sub"]])
        self.servers.append(p)
        p.add(rec(190, case="R2"), rec(191, case="R2"))
        self.open_panel(fold_open=True)
        posts = len(self.posts())
        self.focus_on("SYN-PT-190")
        p.records[rid(190)]["case"] = "R3"
        self.tick(60000)
        seen = self.row("SYN-PT-190")
        self.assertEqual([], seen["buttons"])
        self.assertIn("판독이 바뀌었습니다 — 보낸 당시의 판(v1)입니다", seen["text"])
        self.assertIn("SYN-BODY-190F", seen["text"])
        self.landed("SYN-PT-190", "Source Changed")
        self.assertEqual(posts, len(self.posts()), "nothing was sent while the focus stood on Acknowledge")

    # ── RX20-RX23: a row shows the newest valid recipient projection; ACK results only add to it (S7-U2a-R-001 F01-F04) ──
    def release_delivered(self, held):
        """Release a held answer and check that the page received it (the page did not stop the request first)."""
        self.release(held)
        request = held["route"].request
        self.assertIsNone(request.failure, "the held answer reached the page")
        self.assertIsNotNone(request.response())

    def unknown_then_check_again(self, n, change):
        """Record n's ACK answered 503 CRITICAL_RESULT_BUSY (nothing applied, so the outcome is unknown); the server then changes
        the record (change), focus goes to the line's Check Again and it is pressed. Returns the first POST; the resend carried
        the same bytes."""
        self.fault("ack", status=503, body={"code": "CRITICAL_RESULT_BUSY", "message": "SYN busy"})
        self.acknowledge(f"SYN-PT-{n}")
        self.wait_until(lambda: UNKNOWN_WORD in self.line_text(f"SYN-PT-{n}"), f"the unknown line of {n}")
        first = self.posts()[-1]
        change(self.server.records[rid(n)])
        self.line_locator(f"SYN-PT-{n}").get_by_role("button", name="Check Again", exact=True).focus()
        posts = len(self.posts())
        self.check_again(f"SYN-PT-{n}")
        self.wait_until(lambda: len(self.posts()) > posts, "the Check Again request")
        self.reads_settled()
        self.assertEqual(first["raw"], self.posts()[-1]["raw"], "Check Again sends the same bytes")
        return first

    def test_rx20_the_record_read_after_check_again_sets_the_row_at_once(self):
        # F01: the record read that ends or keeps an unknown attempt is what the row shows from then on - a terminal state
        # with no Acknowledge, a stub with no message, version or body - on both hosts; the line keeps its own verdict.
        for host in ("home", "panel"):
            with self.subTest(host=host):
                base = 210 if host == "home" else 220
                person, head, stub = (CLIN, "C2", {"case": "C3"}) if host == "home" else (RAD, "R2", {"case": "R3", "full": False})
                s = self.server = RecipientServer([INSTITUTION, person["sub"]])
                self.servers.append(s)
                s.add(*[rec(base + k, case=head) for k in range(1, 8)])
                if host == "home":
                    self.open_home()
                else:
                    self.open_panel(fold_open=True)
                # Cancelled meanwhile: the resend meets CRITICAL_RESULT_CANCELLED and the record read says cancelled. The row
                # is Cancelled with the reason at once - not Pending ACK with an Acknowledge beside the refusal - and focus
                # stands on the line that ended.
                n = base + 1
                self.unknown_then_check_again(n, lambda r: r.update(state="cancelled", revision=2, cancelledAt=iso(300),
                                                                    cancelReason=f"SYN reason SYN-REASON-{n}"))
                self.wait_until(lambda: "Cancelled" in self.line_text(f"SYN-PT-{n}"), "the cancelled state")
                row, line = self.row(f"SYN-PT-{n}"), self.line(f"SYN-PT-{n}")
                self.assertIn("Cancelled", row["text"])
                self.assertIn(f"SYN-REASON-{n}", row["text"])
                self.assertIsNone(re.search(r"Pending ACK|Source Changed", row["text"]))
                self.assertEqual(([], []), (row["buttons"], line["buttons"]))
                self.landed(f"SYN-PT-{n}", "Cancelled")
                # Superseded meanwhile: the row is Superseded with Open Replacement, as the line is.
                n = base + 2
                self.unknown_then_check_again(n, lambda r: r.update(state="superseded", revision=2, supersededAt=iso(301),
                                                                    replacedBy=rid(base + 6)))
                self.wait_until(lambda: "Superseded" in self.line_text(f"SYN-PT-{n}"), "the superseded state")
                row, line = self.row(f"SYN-PT-{n}"), self.line(f"SYN-PT-{n}")
                self.assertIn("Superseded", row["text"])
                self.assertEqual(([["Open Replacement", False]], [["Open Replacement", False]]), (row["buttons"], line["buttons"]))
                self.landed(f"SYN-PT-{n}", "Superseded")
                # Still created, now a stub: the resend meets SOURCE_CHANGED and the read gives the stub. The row loses its
                # message, version and body at once; the line stays unknown with the same request, and nothing is sent by
                # itself - only the next Check Again sends, the same bytes again.
                n = base + 3
                first = self.unknown_then_check_again(n, lambda r: r.update(**stub))
                row, line = self.row(f"SYN-PT-{n}"), self.line(f"SYN-PT-{n}")
                self.assertIn(STUB_SENTENCE, row["text"])
                for absent in (f"SYN-MSG-{n}", f"SYN-BODY-{n}", "Source: v", "Findings"):
                    self.assertNotIn(absent, row["text"])
                self.assertEqual([], row["buttons"])
                for words in (UNKNOWN_WORD, LATER):
                    self.assertIn(words, line["text"])
                self.assertEqual([["Check Again", False]], line["buttons"])
                self.landed(f"SYN-PT-{n}", UNKNOWN_WORD)
                posts = len(self.posts())
                self.tick(60000)
                self.assertEqual(posts, len(self.posts()), "nothing is sent by itself")
                self.assertIn(STUB_SENTENCE, self.row_text(f"SYN-PT-{n}"))
                self.check_again(f"SYN-PT-{n}")
                self.wait_until(lambda: len(self.posts()) > posts, "Check Again")
                self.reads_settled()
                self.assertEqual(first["raw"], self.posts()[-1]["raw"])
                self.assertIn(UNKNOWN_WORD, self.line_text(f"SYN-PT-{n}"))
                if host == "panel":
                    # The reading panel's full, current:false (R3): the sentence and the pinned body come, Acknowledge goes.
                    n = base + 4
                    self.unknown_then_check_again(n, lambda r: r.update(case="R3"))
                    row = self.row(f"SYN-PT-{n}")
                    for present in ("Source Changed", "판독이 바뀌었습니다 — 보낸 당시의 판(v1)입니다", f"SYN-BODY-{n}F"):
                        self.assertIn(present, row["text"])
                    self.assertEqual([], row["buttons"])
                    self.assertIn(UNKNOWN_WORD, self.line_text(f"SYN-PT-{n}"))
                # The pair: nothing changed meanwhile, the resend is applied - Acknowledged with the server's time, line gone.
                n = base + 5
                self.unknown_then_check_again(n, lambda r: None)
                self.wait_until(lambda: f"Acknowledged {kst(SERVER_NOW)}" in self.row_text(f"SYN-PT-{n}"), "Acknowledged")
                self.assertEqual(("", []), (self.line_text(f"SYN-PT-{n}"), self.row(f"SYN-PT-{n}")["buttons"]))
                if host == "home":
                    # A first request refused as cancelled: until a read sent after the refusal shows the record, its old row
                    # offers no Acknowledge (the list read again and the record read are held here); then it is Cancelled.
                    n = base + 7
                    s.records[rid(n)].update(state="cancelled", revision=2, cancelledAt=iso(302), cancelReason=f"SYN reason SYN-REASON-{n}")
                    self.fault("list", hold=True)
                    self.fault("read", hold=True)
                    self.acknowledge(f"SYN-PT-{n}")
                    listed, read = self.take("list"), self.take("read")
                    self.wait_until(lambda: "CRITICAL_RESULT_CANCELLED" in self.line_text(f"SYN-PT-{n}"), "the refusal")
                    self.assertEqual([], self.row(f"SYN-PT-{n}")["buttons"])
                    self.release_delivered(listed)
                    self.release_delivered(read)
                    self.reads_settled()
                    self.assertIn("Cancelled", self.row_text(f"SYN-PT-{n}"))
                    self.assertEqual([], self.row(f"SYN-PT-{n}")["buttons"])

    def open_replacement(self, marker, hold=True):
        """Open Replacement on the row with marker; with hold, the record read is held and returned."""
        if hold:
            self.fault("read", hold=True)
        self.row_locator(marker).get_by_role("button", name="Open Replacement", exact=True).click()
        return self.take("read") if hold else None

    def half_minute(self):
        """With the page clock paused at the minute's read, move it half a minute: a request sent now is still waiting (its
        limit is 60 s) when tick(30000) brings the next minute's read. Moving a whole minute would also stop a held request."""
        self.page.clock.fast_forward(30000)
        self.settle()

    def test_rx21_a_late_record_read_does_not_undo_newer_evidence(self):
        # F02: a record read answers for the moment it was sent. A list read sent after it, a later read of the same record,
        # Refresh and Show All all win over it, however late it arrives.
        s = self.server
        for old in (231, 233, 235, 237, 239):
            s.add(rec(old + 1), rec(old, state="superseded", replacedBy=rid(old + 1)))
        s.records[rid(240)].update(state="acknowledged", revision=2, acknowledgedAt=iso(300))
        self.page.clock.pause_at("2030-05-05T06:00:00Z")
        self.open_home()
        self.press("Show All")
        self.reads_settled()
        # The replacement's full answer is held; its head moves and the minute's read shows the stub; the held answer then
        # arrives and changes nothing.
        self.half_minute()
        held = self.open_replacement("SYN-PT-231")
        s.records[rid(232)]["case"] = "C3"
        self.tick(30000)
        stub = self.row("SYN-PT-232")
        self.assertIn(STUB_SENTENCE, stub["text"])
        self.release_delivered(held)
        self.assertEqual(stub, self.row("SYN-PT-232"), "the late full answer does not undo the stub")
        # The replacement leaves the list (C5) before the held answer arrives: the row stays gone.
        self.half_minute()
        held = self.open_replacement("SYN-PT-233")
        s.records[rid(234)]["case"] = "C5"
        self.tick(30000)
        self.assertEqual("", self.row_text("SYN-PT-234"))
        self.release_delivered(held)
        self.assertEqual("", self.row_text("SYN-PT-234"), "the late answer does not bring the row back")
        # The same record read twice, the second answered first: the second (a stub) shows at once over the older list's full
        # row - the newest read is drawn - and the first, arriving last, changes nothing.
        first = self.open_replacement("SYN-PT-235")
        s.records[rid(236)]["case"] = "C3"
        second = self.open_replacement("SYN-PT-235")
        self.assertIn("SYN-MSG-236", self.row_text("SYN-PT-236"), "the list still shows the full row")
        self.release_delivered(second)
        stub = self.row("SYN-PT-236")
        self.assertIn(STUB_SENTENCE, stub["text"])
        self.release_delivered(first)
        self.assertEqual(stub, self.row("SYN-PT-236"))
        # Refresh after the read was sent: its late answer is dropped even where the new list says nothing about the record
        # (a first page of three that ends before it) - the rows outside the list went with Refresh.
        s.add(rec(229), rec(241, state="superseded", replacedBy=rid(229)))
        s.page_size = 3
        self.press("Refresh")
        self.reads_settled()
        held = self.open_replacement("SYN-PT-241")
        self.press("Refresh")
        self.reads_settled()
        self.release_delivered(held)
        self.assertEqual("", self.row_text("SYN-PT-229"))
        self.assertIn("SYN-PT-239", self.row_text("SYN-PT-239"), "the list's own rows stay")
        # A filter change after the read was sent: the acknowledged replacement is not in the Pending list, and its late
        # answer does not add it there.
        held = self.open_replacement("SYN-PT-239")
        self.press("Show All")
        self.reads_settled()
        self.release_delivered(held)
        self.assertEqual("", self.row_text("SYN-PT-240"))
        self.assertEqual({"view": ["received"], "state": ["pending"]}, self.requests("list")[-1]["query"])

    def test_rx22_rows_outside_the_list_follow_exclusion_refusal_and_failure(self):
        # F03: a record opened outside the list keeps no body or Acknowledge once the server leaves it out of a list that
        # covers it, refuses its read, or the list read fails. A page that ends before it, a filter that does not hold its
        # state, and the page's own ACK result are not such evidence.
        s = self.server
        s.add(rec(248), rec(249), rec(250), rec(252), rec(256), rec(257), rec(259, state="superseded", replacedBy=rid(252)))
        self.open_home()
        self.press("Show All")
        self.reads_settled()

        def reopen():
            self.press("Refresh")
            self.reads_settled()
            self.open_replacement("SYN-PT-259", hold=False)
            self.reads_settled()
            opened = self.row("SYN-PT-252")
            self.assertIn("SYN-MSG-252", opened["text"])
            self.assertEqual([["Acknowledge", False]], opened["buttons"])
            self.focus_on("SYN-PT-252")

        def at_heading():
            focus = self.page.evaluate(FOCUS, self.root)
            self.assertEqual((True, None, "Critical Results"), (focus["inside"], focus["item"], focus["text"]))

        # A complete all list without it (items [], no nextCursor, pending 0): the row goes with its body and Acknowledge,
        # the empty state and Pending ACK 0 are what is shown, focus to the heading.
        reopen()
        self.fault("list", patch=lambda p: p.update(items=[], nextCursor=None, pending=0))
        self.tick(60000)
        self.assertEqual([], self.view()["rows"])
        self.assertEqual("Pending ACK 0", self.badge())
        at_heading()
        # A refused list read (403): Load Failed with no row under it.
        reopen()
        self.fault("list", status=403, body={"code": "CRITICAL_RESULT_ROLE_REQUIRED", "message": "SYN role"})
        self.tick(60000)
        self.assertEqual([], self.view()["rows"])
        self.assert_no_count("failed")
        self.assertIn("CRITICAL_RESULT_ROLE_REQUIRED", self.status())
        at_heading()
        # Its read refused (404, 403): the row goes - the list's row of it too - and the Open Replacement row says why.
        for status, code in ((404, "CRITICAL_RESULT_NOT_FOUND"), (403, "CRITICAL_RESULT_ROLE_REQUIRED")):
            with self.subTest(read=status):
                reopen()
                self.fault("read", status=status, body={"code": code, "message": "SYN refused"})
                self.open_replacement("SYN-PT-259", hold=False)
                self.reads_settled()
                self.assertEqual("", self.row_text("SYN-PT-252"))
                self.assertIn(code, self.row_text("SYN-PT-259"))
        # A page of four (nextCursor) that covers it and leaves it out (C5): gone. The pair: a page of two ends before it -
        # no evidence, the opened row stays as it was.
        s.page_size = 4
        reopen()
        s.records[rid(252)]["case"] = "C5"
        self.tick(60000)
        self.assertEqual("", self.row_text("SYN-PT-252"))
        s.records[rid(252)]["case"] = "C2"
        s.page_size = 2
        reopen()
        opened = self.row("SYN-PT-252")
        self.tick(60000)
        self.assertEqual(opened, self.row("SYN-PT-252"))
        # The pair: a stub in the minute's read replaces the opened row at once, focus to its state.
        s.page_size = 50
        reopen()
        s.records[rid(252)]["case"] = "C3"
        self.tick(60000)
        self.assertIn(STUB_SENTENCE, self.row("SYN-PT-252")["text"])
        self.assertEqual([], self.row("SYN-PT-252")["buttons"])
        self.landed("SYN-PT-252", "Source Changed")
        # Pending: a replacement that is already acknowledged is not in the pending list - no evidence, it stays open.
        s.add(rec(262, state="acknowledged"), rec(261))
        self.press("Show All")
        self.reads_settled()
        s.records[rid(261)].update(state="superseded", revision=2, supersededAt=iso(320), replacedBy=rid(262))
        self.acknowledge("SYN-PT-261")
        self.wait_until(lambda: [line for line in self.view()["lines"] if "SYN-PT-261" in line["text"] and line["buttons"]],
                        "Open Replacement on the refusal")
        self.reads_settled()
        self.line_locator("SYN-PT-261").get_by_role("button", name="Open Replacement", exact=True).click()
        self.reads_settled()
        opened = self.row("SYN-PT-262")
        self.assertIn("SYN-MSG-262", opened["text"])
        self.tick(60000)
        self.assertEqual(opened, self.row("SYN-PT-262"))
        # The page's own ACK result stays through the minute's read (until Refresh), as Acknowledged {server time}.
        s.add(rec(263))
        self.press("Refresh")
        self.reads_settled()
        self.acknowledge("SYN-PT-263")
        self.wait_until(lambda: "Acknowledged" in self.row_text("SYN-PT-263"), "Acknowledged")
        self.tick(60000)
        self.assertIn(f"Acknowledged {kst(SERVER_NOW)}", self.row_text("SYN-PT-263"))
        self.assertEqual([], self.row("SYN-PT-263")["buttons"])

    def test_rx23_an_ack_result_does_not_bring_back_a_removed_body(self):
        # F04: the 201 (and a replayed receipt) is the evidence of the acknowledgement and its server time only. Message,
        # version and body come from the newest projection; with none left, only the record's name and the result stay.
        s = self.server
        s.add(*[rec(n) for n in (271, 272, 273, 274, 275)])
        self.page.clock.pause_at("2030-05-05T06:00:00Z")
        self.open_home()
        self.press("Show All")
        self.reads_settled()
        absent = lambda n: (f"SYN-MSG-{n}", f"SYN-BODY-{n}", "Source: v", "Findings")
        # The ACK commits and its 201 is held; the head moves and the minute's read shows it acknowledged as a stub. The 201
        # then changes nothing on the row: Acknowledged with the server's time, no message, version or body.
        self.half_minute()
        self.fault("ack", hold=True)
        self.acknowledge("SYN-PT-271")
        held = self.take("ack")
        s.records[rid(271)]["case"] = "C3"
        self.tick(30000)
        stub = self.row("SYN-PT-271")
        self.assertEqual("", self.line_text("SYN-PT-271"), "the ACK is still waiting for its answer")
        # The list read that the 201 starts is held, so the row is seen as the 201 alone leaves it, then after that read.
        self.fault("list", hold=True)
        self.release_delivered(held)
        listed = self.take("list")
        done = self.row("SYN-PT-271")
        self.assertEqual(stub, done)
        self.assertIn(f"Acknowledged {kst(SERVER_NOW)}", done["text"])
        for text in absent(271):
            self.assertNotIn(text, done["text"])
        self.release_delivered(listed)
        self.reads_settled()
        self.assertEqual(stub, self.row("SYN-PT-271"))
        # The record leaves the list (C5) while the 201 is held: the 201 leaves only the record's name and Acknowledged.
        self.half_minute()
        self.fault("ack", hold=True)
        self.acknowledge("SYN-PT-272")
        held = self.take("ack")
        s.records[rid(272)]["case"] = "C5"
        self.tick(30000)
        self.assertEqual("", self.row_text("SYN-PT-272"))
        self.release_delivered(held)
        self.reads_settled()
        done = self.row("SYN-PT-272")
        for text in (f"Acknowledged {kst(SERVER_NOW)}", "SYN-ID-272", f"From {s.records[rid(272)]['sender']}"):
            self.assertIn(text, done["text"])
        for text in absent(272):
            self.assertNotIn(text, done["text"])
        self.assertEqual([], done["buttons"])
        # Check Again's replayed receipt after the row became a stub (the first ACK applied, its answer 503; the record read
        # after the minute's list fails, so the attempt is still unknown): Acknowledged, and still no body.
        self.fault("ack", apply=True, status=503, body={"code": "CRITICAL_RESULT_BUSY", "message": "SYN busy"})
        self.acknowledge("SYN-PT-273")
        self.wait_until(lambda: UNKNOWN_WORD in self.line_text("SYN-PT-273"), "the unknown line")
        first = self.posts()[-1]
        s.records[rid(273)]["case"] = "C3"
        self.fault("read", status=503, body={"message": "SYN no code"})
        self.tick(60000)
        self.assertIn(UNKNOWN_WORD, self.line_text("SYN-PT-273"))
        stub = self.row("SYN-PT-273")
        self.fault("list", hold=True)
        self.check_again("SYN-PT-273")
        listed = self.take("list")
        self.assertEqual("", self.line_text("SYN-PT-273"), "the replayed receipt ended the attempt")
        self.assertEqual(first["raw"], self.posts()[-1]["raw"])
        done = self.row("SYN-PT-273")
        self.assertEqual(stub, done)
        self.assertIn(f"Acknowledged {kst(SERVER_NOW)}", done["text"])
        for text in absent(273):
            self.assertNotIn(text, done["text"])
        self.release_delivered(listed)
        self.reads_settled()
        self.assertEqual(stub, self.row("SYN-PT-273"))
        # The pair: nothing changed while the 201 was held - Acknowledged with the server's time, the body as the list has it.
        self.fault("ack", hold=True)
        self.acknowledge("SYN-PT-274")
        self.release_delivered(self.take("ack"))
        self.reads_settled()
        done = self.row("SYN-PT-274")
        for text in (f"Acknowledged {kst(SERVER_NOW)}", "SYN-MSG-274", "SYN-BODY-274F"):
            self.assertIn(text, done["text"])
        # Pending: the acknowledged record leaves the pending list; what stays until Refresh is its name and the result.
        self.press("Show All")
        self.reads_settled()
        self.acknowledge("SYN-PT-275")
        self.wait_until(lambda: "Acknowledged" in self.row_text("SYN-PT-275"), "Acknowledged")
        self.reads_settled()
        done = self.row("SYN-PT-275")
        self.assertIn(f"Acknowledged {kst(SERVER_NOW)}", done["text"])
        for text in absent(275):
            self.assertNotIn(text, done["text"])
        self.assertEqual([], done["buttons"])


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
