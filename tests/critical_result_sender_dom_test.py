# coding: utf-8
"""REQ-S7-U1b-SENDER-UI / REQ-S7-U1b-FAILURE / REQ-S7-U1b-ABA
-> RISK-S7-U1b-SUCCESS-WITHOUT-RECORD / RISK-S7-U1b-STALE-A-B-A / RISK-S7-U1b-HIDE-AS-PERMISSION / RISK-S7-U1b-ANCHOR-DRIFT /
   RISK-S7-U1p-FALSE-UNDELIVERED
-> TEST-S7-U1b-DOM (contract S7-U1p §2.3 SD01-SD09, §8.1, §16.1).

The critical result (CVR) sender screen of main.html: the Mark CVR button, the Send Critical Result dialog and the Sent
Critical Results list. The shipped critical-result-send.js, the shipped S7-U1b block of main.html (cut out as is) and
main.html's own renderClinical() (handed out by the browser's parser, run as shipped; see TAIL) run on main.html's own
markup and styles with the page script stripped,
from a synthetic origin, against an in-test server that keeps the S7-U1a rules the screen relies on (critical-result
.service.ts: exact body keys, expectedOwner, per-request receipts that replay the stored `applied` result, pending
duplicates with the pending record's `id`, source version = head, terminal states with `replacedBy`, revision CAS,
owner-only list with a server `pending` count). Cases assert what a user sees and what reaches the server - names,
states, Korean explanations, which requests are sent and their bodies - never the file's internals.

  s00 every U1b change of main.html sits in its own regions, checked on two fixed commits (S7-PINS, AGENTS.md 1-B.14):
      the unit's base (main 96cb9cd) and the U1b commit that holds its main.html (RESULT_COMMIT). Without the regions the
      result is the base byte for byte, and with S5-U4c's and S5-U4b's regions cut too it is S5-U4c's base and, after
      without_ui3(), S5-UI3's base, script included. The live main.html is never held to these bytes: later units keep
      changing it (S7-U3a edits a page-script line), and the live page is held to what it must do by the cases below.
  sd01 Mark CVR follows #1: off (with a Korean reason) before the answer, on only for sendable:true, off with the §16.1
      reason for NO_PINNABLE_SOURCE / SOURCE_FORBIDDEN / NO_ELIGIBLE_RECIPIENT and "지금 확인할 수 없습니다" plus the
      server's own message for a refusal, a failure or a malformed answer; #1 is read once per target and report state
      (again after the version or RS changes, also when More is opened after a save the list never repainted); the
      button is never removed from its Status section (disabled is guidance, not the permission check).
  sd02 the dialog shows the pinned version from a fresh #1 read (v{n} · Action · author · time), offers only #1's
      candidates as Clinician / Radiologist, has no free recipient field and never fills Message with the report.
  sd03 nothing reads as delivered before the 201: a held POST leaves no "Delivered" and no saved sentence anywhere; the
      POST carries exactly {requestId (UUID v4), expectedOwner, recipientSub, sourceVersion, message} with X-KIN-CSRF.
  sd04 only the first request's confirmed rejections (400, 403, 404, the named 409s, 503 CRITICAL_RESULT_UNAVAILABLE)
      show "Not delivered" with a Korean reason and the server's message and code; a new send is a new requestId. Every
      unknown answer (409 STUDY_ACCESS_CHANGED, code-less 503, CRITICAL_RESULT_BUSY, 500, 502/504 pages, a reset
      connection, a 200, a 201 for another request, an unnamed 409) shows "Delivery status unknown" and Check Again and
      "Not delivered" nowhere on the page.
  sd05 Check Again resends the same bytes (same requestId and body); a replayed 201 is Delivered without a second record.
  sd06 A->B->A and session: a late #1 answer never overrides Mark CVR for a newer read (the late answer carries the other
      state - sendable, refused, failed - so applying it would show; returned while the newer read is out and returned
      last), a late dialog read or POST answer never paints another study's dialog, a pending send goes
      to the list line when the dialog closes; a session end, another tab's end and a 401 end the area before anything
      else and paint nothing later; another account's envelope and OWNER_CHANGED lock the area and drop the requests.
  sd07 the list: its line (Sent Critical Results, Show Sent) is there for every sender session, with nothing pending too,
      so the terminal history (Acknowledged / Cancelled / Superseded / All) opens by the user's own actions; the list
      itself stays folded until opened; a failed read shows instead of an empty list; `Pending ACK {pending}` from
      the server, columns Study / Recipient / Sent / State / Source, default filter Pending ACK, state names with their
      Korean descriptions, the Source Changed / Recipient Not Eligible / Status Unknown marks, More with the cursor as
      given, Cancel Delivery (reason required) and Supersede (the study's current head from #1, message required).
  sd08 English controls, headings, states and marks; Korean explanations; no UXR-SP-34 avoided word; text >= 12px in
      the list; the §17 limits in the dialog.
  sd09 §8.1 unknown outcomes (a)-(g), including the delayed original request whose retry meets another record's
      PENDING_EXISTS and which appears later in the list.
  sd10 roles: technician, admin-only and clinician + technician sessions never ask #1 or #3 and keep Mark CVR off.
  sd11 the periodic re-read (60 s, page clock) is one GET of the list: no write, no record changed, no notice; after the
      last pending delivery is acknowledged the line stays and the record with the server's acknowledgement time opens
      again; no periodic read while the document is not visible.
  sd12 a confirmed CRITICAL_RESULT_SOURCE_MOVED on the first Send (contract §8: the screen reads #1 again and the user
      confirms again): the open dialog reads the current head and candidates, Send stays locked while it reads, the
      new Source line is shown and the message kept, a recipient who is no longer a candidate is cleared with a Korean
      note, nothing is sent until the user's next Send, which is a new requestId on the new version. Check Again of an
      unknown request never takes this path (same requestId and body, §8.1 rule 2), and a late answer of the re-read
      never paints a dialog opened again.

Synthetic data only (SYN-* names): no server, no network, no credentials. A request the harness does not answer is
aborted and fails the case. The server half is tests/critical_result_service_test.cjs and tests/critical_result_live.py.
"""
import base64
import copy
import json
import re
import time
import unicodedata
import unittest
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright
from module_session_harness import CORE, STANDIN, setup_standin

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
JS_NAME = "critical-result-send.js"


def lf_text(path):
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


MAIN = lf_text(HPACS / "main.html")
SHIPPED_JS = lf_text(HPACS / JS_NAME)
ORIGIN = "https://reader.test"
BASE = "/worklist/hpacs-lite/"

# ── the S7-U1b regions of main.html ──
# s00 reads main.html at two fixed commits with tests/report_actions_dom_test.py fixed_file(): each must be readable
# (fetched from origin when this clone lacks it; .github/workflows/validate.yml fetches both before the S7-U1b step) and
# be the pinned LF sha256, or the case fails. The base is S7-U1b's base, main after S7-U1a; its main.html is the one the
# S5-U4b/U4c integration merged (tests/clinician_request_dom_test.py RESULT_MAIN_SHA256). The result is the U1b commit
# that last changed main.html (fix1; the merge-main round changed no main.html byte). A later U1b change to main.html
# moves RESULT_COMMIT to the commit that holds it.
REL_MAIN = "worklist-v0/hpacs-lite/main.html"
BASE_COMMIT = "96cb9cdb051dea86ee54484eb5e50ad0530712d4"
RESULT_COMMIT = "f2a88578cce40b3e5f4eff595c66c3f4c6a809ed"
BASE_MAIN_SHA256 = "f555807c9a21bfae532746a2bd4fd55b360d6f86d0af3be55dc2dc081bfd7644"
RESULT_MAIN_SHA256 = "78ac1072780849debc04bf4fed4d55b1d5f9d0a212c2507e5584c2f1f8338ad7"
# (name, first bytes, end marker, end included). Every marker occurs exactly once in main.html.
U1B_REGIONS = (
    ("css", "    /* ── S7-U1b 중요 결과 발신 ──", "    /* ── S7-U1b 끝 ── */\n", True),
    ("markup-sent", "        <!-- S7-U1b 보낸 중요 결과.",
     '            <button id="cvr-sent-more" type="button" hidden>More</button>\n          </div>\n        </section>\n', True),
    ("markup-dialog", "  <!--\n    S7-U1b 중요 결과 발신 창",
     '        <button id="cvr-send-submit" class="ok" type="button">Send</button>\n      </div>\n    </div>\n  </div>\n\n', True),
    ("script-tag", f'  <script src="{JS_NAME}"></script>\n', f'  <script src="{JS_NAME}"></script>\n', True),
    ("hook", "      // S7-U1b: 판독 대상이나 화면이 아는 판독 상태가 바뀐 때만", "      criticalResults?.sync();\n", True),
    ("block", "    // ── 중요 결과 발신(S7-U1b) ──\n",
     "    } catch (_) { toast('중요 결과 발신 화면을 준비하지 못했습니다. 판독 작업은 계속할 수 있습니다.', 'err'); }\n\n", True),
)
# The one base line S7-U1b edits in place (inside S5-UI3's row region): Mark CVR's tooltip. (shipped, base)
U1B_LINES = (
    ("mark-cvr",
     '                <button id="b-mark-cvr" disabled title="중요 결과(CVR) 보내기: 서버가 이 검사에서 보낼 수 있다고 답하기 전에는 '
     '켜지지 않습니다.">Mark CVR</button>\n',
     '                <button id="b-mark-cvr" disabled title="중요 결과(CVR) 표시: 아직 연결되지 않은 기능입니다(7/9단계 예정). '
     '권한 때문에 막힌 것이 아닙니다.">Mark CVR</button>\n'),
)


def without_u1b(text):
    """main.html (LF) with the S7-U1b regions cut and Mark CVR's base tooltip back. Raises if a marker is missing or not
    unique, so a moved or doubled change fails instead of being half undone. s00 applies it to the fixed RESULT_COMMIT
    only: the live main.html carries later units' changes, which are not this unit's to undo."""
    text = text.replace("\r\n", "\n")
    for name, start, end, inclusive in U1B_REGIONS:
        for marker in {start, end}:
            if text.count(marker) != 1:
                raise AssertionError(f"S7-U1b {name} marker {marker!r} occurs {text.count(marker)} times in main.html")
        first = text.index(start)
        last = text.index(end, first) + (len(end) if inclusive else 0)
        text = text[:first] + text[last:]
    for name, shipped, base in U1B_LINES:
        if text.count(shipped) != 1:
            raise AssertionError(f"S7-U1b {name} line occurs {text.count(shipped)} times in main.html")
        text = text.replace(shipped, base)
    return text


def slice_between(source, start, end):
    first = source.index(start)
    return source[first:source.index(end, first)]


def page_html(text):
    html = re.sub(r"<script\b[^>]*>.*?</script>", "", text, flags=re.S)
    html = re.sub(r'<link rel="stylesheet" href="([^"]+)">',
                  lambda m: "<style>" + (HPACS / m.group(1)).read_text(encoding="utf-8") + "</style>", html)
    return re.sub(r"<link\b[^>]*>", "", html)


def has_hangul(text):
    return any(unicodedata.name(ch, "").startswith("HANGUL") for ch in text)


# The shipped block (mount call), run as the page runs it. tests/clinician_question_dom_test.py test_18d cuts the same
# block out of its tagged page with BLOCK_MARKS.
BLOCK_MARKS = ("    // ── 중요 결과 발신(S7-U1b) ──", "    // ── 임상의 질문 답변(S5-U4b) ──")
BLOCK = slice_between(MAIN, *BLOCK_MARKS)
# main.html's inline page script (the <script> elements without a src), handed to the browser as text for TAIL.
PAGE_SCRIPT = "\n".join(re.findall(r"<script>(.*?)</script>", MAIN, flags=re.S))
# tests/report_actions_dom_test.py runs PRELUDE + BLOCK + TAIL.replace('HOOK', '\n'.join(HOOK_LINES)). TAIL now runs the
# shipped renderClinical() itself and has no HOOK placeholder, so there is nothing to put in.
HOOK_LINES = ()
# Everything the block reads from the page script, as stand-ins. KinAuth.has() admits admin to every role, as auth.js does.
# The page script travels in PRELUDE, not TAIL, so report_actions' replace() on TAIL never touches it.
PRELUDE = "\nconst synPageScript = " + json.dumps(PAGE_SCRIPT, ensure_ascii=False) + ";" + """
const API = location.origin + '/api';
const accountChangeHooks = [(reason) => window.synOtherEnds.push(reason)];
    function notifyAccountChanged(detail) {
      accountChangeHooks.forEach(done => { try { done('account-changed', detail); } catch (_) {} });
    }

let sess = window.synSession;
let serverMode = window.synMode.serverMode, demoMode = false, offline = window.synMode.offline;
let selectedUid = null;
let studies = window.synStudies;
let appState = window.synAppState;
const toast = (message, kind) => { window.synToasts.push([message, kind]); };
function displayActor(value) { return window.synNames[value] || value; }
const KinAuth = {
  session: () => window.synSession,
  has: role => { const s = window.synSession; return !!s && s.state === 'approved' && (s.roles.includes(role) || s.roles.includes('admin')); },
  logout: async () => { window.synLogouts += 1; },
};
"""
# renderClinical() is main.html's own, run as shipped: whatever it does for this unit runs as the page runs it, whatever
# the names inside. The browser's parser hands it out - the page script is compiled as the body of a function that
# returns renderClinical before its first statement (a function declaration exists from the start of its body), so
# nothing else of the page script runs. Every name it reads that this harness does not define (the page's other areas
# and helpers) resolves to an inert stand-in whose calls, reads and writes do nothing.
TAIL = """
const synInert = new Proxy(function () {}, {
  get: (_, key) => key === Symbol.toPrimitive ? () => '' : synInert,
  set: () => true, has: () => false, apply: () => synInert, construct: () => synInert,
});
const synScope = new Proxy({}, {
  has: (_, name) => {
    if (typeof name !== 'string') return false;
    try { (0, eval)(name); return false; } catch (error) { return error instanceof ReferenceError; }
  },
  get: (_, key) => key === Symbol.unscopables ? undefined : synInert,
  set: () => true,
});
const synShipped = String(new Function('return renderClinical;\\n' + synPageScript)());
let renderClinical;
with (synScope) { renderClinical = eval('(' + synShipped + ')'); }
window.synPick = uid => { KinWorkContext.select(uid); selectedUid = uid; renderClinical(); };
window.synReport = (uid, version, rs, repaint) => { appState[uid] = { ...appState[uid], version, rs }; if (repaint) renderClinical(); };
window.synOtherEnds = [];
KinWorkContext.onInvalidate(({reason,state}) => { if (reason === 'lifecycle' && state !== 'active') window.synOtherEnds.push('end'); });
"""
SETUP = """(v) => { window.synSession = v.session; window.synStudies = v.studies; window.synAppState = v.app; window.synNames = v.names;
  window.synMode = v.mode; window.synToasts = []; window.synLogouts = 0; }"""

INSTITUTION = "SYN-INST-A"
RAD = {"sub": "0b1f6a2e-4c1d-4b8e-9a61-2f3c4d5e6f70", "actor": "syn-rad@kin", "name": "SYN Radiologist"}
OTHER_ACCOUNT = ["SYN-INST-A", "7e2d1c3b-5a4f-4e6d-8c7b-9a0b1c2d3e4f"]
P = {"sub": "11111111-2222-4333-8444-555555555555", "actor": "syn-clinician@kin", "name": "SYN Clinician", "role": "clinician"}
X = {"sub": "66666666-7777-4888-9999-aaaaaaaaaaaa", "actor": "syn-rad2@kin", "name": "SYN Radiologist Two", "role": "radiologist"}
Y = {"sub": "bbbbbbbb-cccc-4ddd-aeee-ffffffffffff", "actor": "syn-clinician2@kin", "name": "SYN Clinician Two", "role": "clinician"}
PREFIX = "1.2.826.0.1.3680043.10.7701"
A, B, C = (f"{PREFIX}.{n}" for n in (1, 2, 3))
STUDIES = [{"uid": A, "name": "SYN ALPHA", "id": "SYN-P-01", "date": "2026-09-01", "birth": "1970-01-01", "tele": False},
           {"uid": B, "name": "SYN BETA", "id": "SYN-P-02", "date": "2026-09-02", "birth": "1971-02-02", "tele": False},
           {"uid": C, "name": "SYN GAMMA", "id": "SYN-P-03", "date": "2026-09-03", "birth": "1972-03-03", "tele": False}]
HEADS = {A: {"version": 3, "action": "approve", "author": "syn-rad@kin", "at": "2026-09-28T01:00:00.000Z"},
         B: {"version": 1, "action": "save", "author": "syn-rad@kin", "at": "2026-09-27T23:30:00.000Z"},
         C: {"version": 2, "action": "addendum", "author": "syn-rad2@kin", "at": "2026-09-27T22:00:00.000Z"}}
NAMES = {"syn-rad@kin": "SYN Radiologist", "syn-rad2@kin": "SYN Radiologist Two"}
REPORT_TEXT = "SYN findings text that must never become the message"

# Contract wording (S7-U1p §16.1, §8.1 rule 2 and 4, §17) and the work order's "cannot check now".
REASONS = {
    "NO_PINNABLE_SOURCE": "보낼 수 있는 판독 판이 없습니다(판독 전이거나 판독 취소됨)",
    "SOURCE_FORBIDDEN": "예비 판독 중이라 지정된 판독의만 보낼 수 있습니다",
    "NO_ELIGIBLE_RECIPIENT": "이 판독 판을 지금 읽을 수 있는 수신자가 없습니다(임상의는 승인·추가기재된 판독만 받을 수 있습니다)",
}
CANNOT_CHECK = "지금 확인할 수 없습니다"
DIALOG_HELP = "받는 사람이 KIN 화면에서 직접 확인(Acknowledge)해야 완료됩니다. 메일·문자·전화로 가지 않습니다."
DELIVERED_TEXT = "전달 기록이 저장되었습니다. 수신자가 확인(Acknowledge)하면 Acknowledged로 바뀝니다."
UNKNOWN_TEXT = "요청이 서버에 적용되었는지 확인하지 못했습니다. 전달되었을 수 있습니다. Check Again으로 확인하세요."
GUIDANCE = "보낸 목록에서 확인하거나 수신자에게 직접 확인하세요. 같은 수신자에게 다시 보내기 전에 보낸 목록을 확인하세요."
LATER = "지금 다시 보내면 거절되는 이유"
STATE_NAMES = {"created": "Pending ACK", "acknowledged": "Acknowledged", "cancelled": "Cancelled", "superseded": "Superseded"}
PENDING_HELP = "수신자가 아직 확인하지 않았습니다. 열어보았는지는 기록하지 않습니다."
MARKS = {
    "Source Changed": "판독이 바뀌어 수신자가 확인할 수 없습니다. 새 판으로 대체하거나 취소하세요.",
    "Recipient Not Eligible": ("수신자가 지금 이 전달을 볼 수 없습니다(수신자의 역할·기관·검사 접근이 바뀌었거나, 판독의 역할을 잃어 "
                               "서명 전 판을 더는 읽을 수 없음). 확인할 수 없으니 취소하고 다른 사람에게 보내세요."),
    "Status Unknown": "지금 수신자 상태를 확인할 수 없습니다.",
}
UNKNOWN_WORD, NOT_DELIVERED, DELIVERED = "Delivery status unknown", "Not delivered", "Delivered"
# UXR-SP-34 / UXR-G-18 avoided words (as tests/admin_member_roles_dom_test.py).
AVOIDED = re.compile(r"진단|검출|판정|우선순위|diagnos|detect|priorit|\bAI\b", re.IGNORECASE)
# What reads as delivered: the state word (not inside "Not delivered") or the saved sentence.
SUCCESS = re.compile(r"(?<!Not )Delivered|전달 기록이 저장")
UUID_V4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
CREATE_KEYS = ["expectedOwner", "message", "recipientSub", "requestId", "sourceVersion"]


def me(person, roles):
    return {"state": "approved", "institution": INSTITUTION, "sub": person["sub"], "user": person["actor"],
            "name": person["name"], "roles": roles}


def iso(minute):
    return f"2026-09-28T02:{minute:02d}:00.000Z"


class CvrServer:
    """The S7-U1a rules the sender screen relies on, for one sender (RAD) in one institution."""

    def __init__(self):
        self.owner = [INSTITUTION, RAD["sub"]]
        self.heads = copy.deepcopy(HEADS)
        self.candidates = {A: [P, X], B: [X], C: [P, X, Y]}
        self.reasons = {}
        self.records = {}
        self.seq = 0
        self.receipts = {}
        self.page_size = 50

    # #1
    def recipients(self, uid):
        if uid not in self.heads:
            return 404, {"code": "STUDY_NOT_FOUND", "message": "SYN study not found"}
        head, reason = self.heads[uid], self.reasons.get(uid)
        source = None if reason in ("NO_PINNABLE_SOURCE", "SOURCE_FORBIDDEN") else {**head, "final": head["action"] in ("approve", "addendum")}
        people = [] if reason else self.candidates.get(uid, [])
        return 200, {"owner": self.owner, "uid": uid, "sendable": reason is None and bool(people), "reason": reason or (None if people else "NO_ELIGIBLE_RECIPIENT"),
                     "source": source, "recipients": [{k: p[k] for k in ("sub", "actor", "name", "role")} for p in people]}

    def refuse(self, status, code, **extra):
        return status, {"code": code, "message": f"SYN {code} message", **extra}

    def add(self, uid, person, state="created", minute=None, current=True, delivery="readable", **extra):
        self.seq += 1
        rid = extra.pop("id", None) or f"{self.seq:08x}-0000-4000-8000-{self.seq:012x}"
        row = next(s for s in STUDIES if s["uid"] == uid)
        head = self.heads[uid]
        record = {"id": rid, "studyUid": uid, "state": state, "revision": 1 if state == "created" else 2, "seq": self.seq,
                  "createdAt": iso(minute if minute is not None else self.seq), "supersedes": extra.pop("supersedes", None),
                  "recipient": {"actor": person["actor"], "name": person["name"], "role": person["role"], "sub": person["sub"]},
                  "study": {"uid": uid, "name": row["name"], "id": row["id"], "birth": row["birth"], "date": row["date"]},
                  "message": extra.pop("message", "SYN message"),
                  "source": {"version": head["version"] if current else head["version"] - 1, "action": head["action"],
                             "author": head["author"], "at": head["at"]},
                  "delivery": delivery, "acknowledgedAt": None, "cancelledAt": None, "cancelReason": None, "supersededAt": None}
        record.update(extra)
        self.records[rid] = record
        return record

    def view(self, record):
        head = self.heads[record["studyUid"]]
        current = record["source"]["version"] == head["version"]
        replaced = next((r["id"] for r in self.records.values() if r["supersedes"] == record["id"]), None)
        return {"id": record["id"], "studyUid": record["studyUid"], "state": record["state"], "revision": record["revision"],
                "createdAt": record["createdAt"], "replacedBy": replaced, "supersedes": record["supersedes"], "view": "sender",
                "recipient": {k: record["recipient"][k] for k in ("actor", "name", "role")}, "study": dict(record["study"]),
                "message": record["message"], "source": {**record["source"], "current": current,
                                                         "reason": None if current else "head_moved"},
                "delivery": record["delivery"] if record["state"] == "created" else None,
                "acknowledgedAt": record["acknowledgedAt"], "cancelledAt": record["cancelledAt"],
                "cancelReason": record["cancelReason"], "supersededAt": record["supersededAt"]}

    def applied(self, rid, uid, request_id, action, frm, to, revision, replacement=None):
        return {"id": rid, "studyUid": uid, "requestId": request_id, "action": action, "from": frm, "to": to,
                "revision": revision, "replacement": replacement, "at": iso(59)}

    def replay(self, request_id, mark):
        stored = self.receipts[request_id]
        if stored["mark"] != mark:
            return self.refuse(409, "REQUEST_ID_REUSED")
        return 201, {"owner": self.owner, "applied": stored["applied"], "replayed": True}

    def terminal(self, record):
        if record["state"] == "acknowledged":
            return self.refuse(409, "CRITICAL_RESULT_ACKNOWLEDGED")
        if record["state"] == "cancelled":
            return self.refuse(409, "CRITICAL_RESULT_CANCELLED")
        if record["state"] == "superseded":
            replaced = next((r["id"] for r in self.records.values() if r["supersedes"] == record["id"]), None)
            return self.refuse(409, "CRITICAL_RESULT_SUPERSEDED", replacedBy=replaced)
        return None

    def create(self, uid, body):
        if not isinstance(body, dict) or sorted(body) != CREATE_KEYS:
            return self.refuse(400, "CRITICAL_RESULT_INPUT_INVALID")
        if body["expectedOwner"] != self.owner:
            return self.refuse(409, "OWNER_CHANGED")
        rid = body["requestId"].lower()
        mark = ("create", uid, body["recipientSub"], body["sourceVersion"], body["message"])
        if rid in self.receipts:
            return self.replay(rid, mark)
        pending = [r for r in self.records.values() if r["studyUid"] == uid and r["state"] == "created"
                   and r["recipient"]["sub"] == body["recipientSub"]]
        if pending:
            return self.refuse(409, "CRITICAL_RESULT_PENDING_EXISTS", id=pending[0]["id"])
        if body["sourceVersion"] != self.heads[uid]["version"]:
            return self.refuse(409, "CRITICAL_RESULT_SOURCE_MOVED")
        person = next((p for p in self.candidates.get(uid, []) if p["sub"] == body["recipientSub"]), None)
        if person is None:
            return self.refuse(409, "CRITICAL_RESULT_RECIPIENT_CANNOT_READ")
        self.add(uid, person, id=rid, message=body["message"])
        applied = self.applied(rid, uid, rid, "create", None, "created", 1)
        self.receipts[rid] = {"mark": mark, "applied": applied}
        return 201, {"owner": self.owner, "applied": applied, "replayed": False}

    def change(self, action, rid, body):
        keys = ["expectedOwner", "reason", "requestId", "revision"] if action == "cancel" else \
            ["expectedOwner", "message", "requestId", "revision", "sourceVersion"]
        if not isinstance(body, dict) or sorted(body) != keys:
            return self.refuse(400, "CRITICAL_RESULT_INPUT_INVALID")
        if body["expectedOwner"] != self.owner:
            return self.refuse(409, "OWNER_CHANGED")
        record = self.records.get(rid)
        if record is None:
            return self.refuse(404, "CRITICAL_RESULT_NOT_FOUND")
        request_id = body["requestId"].lower()
        mark = (action, rid, body["revision"], body.get("reason"), body.get("sourceVersion"), body.get("message"))
        if request_id in self.receipts:
            return self.replay(request_id, mark)
        refused = self.terminal(record)
        if refused:
            return refused
        if body["revision"] != record["revision"]:
            return self.refuse(409, "CRITICAL_RESULT_CHANGED")
        uid = record["studyUid"]
        if action == "cancel":
            record.update(state="cancelled", revision=2, cancelledAt=iso(58), cancelReason=body["reason"])
            applied = self.applied(rid, uid, request_id, "cancel", "created", "cancelled", 2)
        else:
            if body["sourceVersion"] != self.heads[uid]["version"]:
                return self.refuse(409, "CRITICAL_RESULT_SOURCE_MOVED")
            person = {**record["recipient"]}
            record.update(state="superseded", revision=2, supersededAt=iso(58))
            self.add(uid, person, id=request_id, message=body["message"], supersedes=rid)
            applied = self.applied(rid, uid, request_id, "supersede", "created", "superseded", 2,
                                   {"id": request_id, "revision": 1, "sourceVersion": self.heads[uid]["version"]})
        self.receipts[request_id] = {"mark": mark, "applied": applied}
        return 201, {"owner": self.owner, "applied": applied, "replayed": False}

    def listing(self, query):
        wanted = {"pending": "created", "acknowledged": "acknowledged", "cancelled": "cancelled", "superseded": "superseded",
                  "all": None}[query.get("state", ["all"])[0]]
        rows = sorted(self.records.values(), key=lambda r: -r["seq"])
        rows = [r for r in rows if wanted is None or r["state"] == wanted]
        offset = 0
        if "cursor" in query:
            offset = json.loads(base64.urlsafe_b64decode(query["cursor"][0] + "==").decode())["o"]
        page = rows[offset:offset + self.page_size]
        more = offset + self.page_size < len(rows)
        cursor = base64.urlsafe_b64encode(json.dumps({"o": offset + self.page_size}).encode()).decode().rstrip("=") if more else None
        return 200, {"owner": self.owner, "view": "sent", "items": [self.view(r) for r in page], "nextCursor": cursor,
                     "pending": sum(1 for r in self.records.values() if r["state"] == "created")}

    def handle(self, kind, path, query, body):
        if kind == "recipients":
            return self.recipients(unquote(path.split("/")[3]))
        if kind == "create":
            return self.create(unquote(path.split("/")[3]), body)
        if kind == "list":
            return self.listing(query)
        if kind == "read":
            record = self.records.get(unquote(path.split("/")[3]))
            return (200, {"owner": self.owner, "item": self.view(record)}) if record else self.refuse(404, "CRITICAL_RESULT_NOT_FOUND")
        return self.change(kind, unquote(path.split("/")[3]), body)


def kind_of(method, path):
    if method == "GET" and re.fullmatch(r"/api/studies/[^/]+/critical-result-recipients", path):
        return "recipients"
    if method == "POST" and re.fullmatch(r"/api/studies/[^/]+/critical-results", path):
        return "create"
    if method == "GET" and path == "/api/critical-results":
        return "list"
    if method == "GET" and re.fullmatch(r"/api/critical-results/[^/]+", path):
        return "read"
    found = re.fullmatch(r"/api/critical-results/[^/]+/(cancel|supersede)", path)
    return found.group(1) if method == "POST" and found else None


# What the page shows: the button, the dialog and the list, as a user reads them.
VIEW = """() => {
  const q = s => document.querySelector(s), t = e => e ? e.textContent : null;
  const shown = e => !!e && !e.closest('[hidden]') && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const entry = q('#b-mark-cvr'), dialog = q('#cvr-send'), panel = q('#cvr-sent-p'), rows = q('#cvr-sent-rows');
  return {
    entry: {disabled: entry.disabled, title: entry.title, text: entry.textContent, present: document.contains(entry),
      section: entry.closest('[role="group"][aria-label]') ? entry.closest('[role="group"][aria-label]').getAttribute('aria-label') : null},
    dialog: {open: shown(dialog), title: t(q('#cvr-send-title')), help: t(q('#cvr-send-help')), study: t(q('#cvr-send-study')),
      source: t(q('#cvr-send-source')), options: [...q('#cvr-send-recipient').options].map(o => [o.value, o.text]),
      recipientTag: q('#cvr-send-recipient').tagName, recipientDisabled: q('#cvr-send-recipient').disabled,
      recipient: q('#cvr-send-recipient').value,
      message: q('#cvr-send-message').value, messageReadOnly: q('#cvr-send-message').readOnly,
      sendDisabled: q('#cvr-send-submit').disabled, check: shown(q('#cvr-send-check')) && !q('#cvr-send-check').disabled,
      status: shown(dialog) ? q('#cvr-send-status').innerText : '',
      inputs: [...dialog.querySelectorAll('input')].length},
    panel: {shown: shown(panel), summary: t(q('#cvr-sent-summary')), toggle: t(q('#cvr-sent-toggle')), pane: shown(q('#cvr-sent-pane')),
      lines: [...q('#cvr-sent-attempts').children].filter(shown).map(li => ({request: li.dataset.request, text: li.innerText,
        check: shown(li.querySelector('button')) && !li.querySelector('button').disabled})),
      headers: [...panel.querySelectorAll('thead th')].map(t), filter: q('#cvr-sent-filter').value,
      rows: [...rows.children].filter(tr => tr.dataset.id).map(tr => ({id: tr.dataset.id, cells: [...tr.children].map(td => td.innerText),
        titled: [...tr.querySelectorAll('[title]')].map(e => [e.textContent, e.title]),
        buttons: [...tr.querySelectorAll('button')].map(b => [b.textContent, b.disabled])})),
      forms: [...rows.children].filter(tr => !tr.dataset.id).map(tr => tr.innerText),
      status: shown(q('#cvr-sent-status')) ? t(q('#cvr-sent-status')) : '', more: shown(q('#cvr-sent-more'))},
    body: document.body.innerText,
  };
}"""


class SenderRegionsTest(unittest.TestCase):
    """Stdlib side: every S7-U1b change of main.html was inside its own regions, on the fixed commits (module docstring)."""

    def test_s00_every_change_was_inside_the_u1b_regions_at_its_commit(self):
        from clinician_question_dom_test import without_u4b
        from clinician_request_dom_test import BASE_MAIN_SHA256 as U4C_BASE_MAIN_SHA256
        from clinician_request_dom_test import RESULT_MAIN_SHA256 as U4C_RESULT_MAIN_SHA256
        from clinician_request_dom_test import without_u4c_main
        from report_actions_dom_test import BASE_MAIN_SHA256 as UI3_BASE_MAIN_SHA256
        from report_actions_dom_test import BASE_SCRIPTS_SHA256 as UI3_BASE_SCRIPTS_SHA256
        from report_actions_dom_test import digest, fixed_file, scripts_digest, without_ui3
        # This unit started from the page the S5-U4b/U4c integration merged (main.html unchanged up to S7-U1a).
        self.assertEqual(U4C_RESULT_MAIN_SHA256, BASE_MAIN_SHA256)
        base = fixed_file(BASE_COMMIT, REL_MAIN, BASE_MAIN_SHA256)
        result = fixed_file(RESULT_COMMIT, REL_MAIN, RESULT_MAIN_SHA256)
        self.assertEqual(base, without_u1b(result), "a main.html byte outside the S7-U1b regions moved")
        restored = without_u4b(without_u4c_main(without_u1b(result)))
        self.assertEqual(U4C_BASE_MAIN_SHA256, digest(restored))
        self.assertEqual(UI3_BASE_MAIN_SHA256, digest(without_ui3(restored)))
        self.assertEqual(UI3_BASE_SCRIPTS_SHA256, scripts_digest(restored))
        # The order of the cuts does not matter: the U1b regions do not touch the other units' markers.
        self.assertEqual(restored, without_u1b(without_u4b(without_u4c_main(result))))


class CriticalResultSenderDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.page_markup = page_html(MAIN)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.server = CvrServer()
        self.js = SHIPPED_JS
        self.faults = {}
        self.held = []
        self.parked = []   # held requests a case took and has not answered yet
        self.log = []
        self.unexpected, self.errors, self.dialogs, self.finished = [], [], [], []
        self.envelope_owner = None
        self.context = self.browser.new_context(viewport={"width": 1366, "height": 900}, timezone_id="Asia/Seoul", locale="ko-KR")
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
        self.page.set_default_timeout(5000)
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", self.on_dialog)
        self.page.on("requestfinished", lambda request: self.finished.append(request))
        self.page.on("requestfailed", lambda request: self.finished.append(request))

    def tearDown(self):
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
                route.fulfill(body=self.page_markup, content_type="text/html; charset=utf-8")
            elif name == JS_NAME:
                route.fulfill(body=self.js, content_type="application/javascript; charset=utf-8")
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
        query = parse_qs(url.query, keep_blank_values=True)
        self.log.append({"kind": kind, "method": method, "path": path, "query": query, "body": copy.deepcopy(body),
                         "raw": request.post_data, "request": request})
        queue = self.faults.get(kind) or []
        fault = queue.pop(0) if queue else None
        answer = None
        if fault is None or fault.get("apply"):
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
        held = {"kind": kind, "route": route, "answer": answer, "fault": fault or {}, "body": copy.deepcopy(body), "path": path}
        if fault is not None and fault.get("hold"):
            self.held.append(held)
            return
        self.answer(held)

    @staticmethod
    def answer(held):
        fault, route = held["fault"], held["route"]
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
        """Answer a request the page may already have aborted; the page then has nothing to receive."""
        try:
            self.answer(held)
        except PlaywrightError:
            pass
        self.parked.remove(held["route"].request)
        self.settle()

    def requests(self, kind=None):
        return [r for r in self.log if kind is None or r["kind"] == kind]

    def fault(self, kind, **spec):
        self.faults.setdefault(kind, []).append(spec)

    def open_reader(self, session=None, mode=None, app=None, clock=False):
        self.page.goto(ORIGIN + BASE + "main.html")
        if clock:
            self.page.clock.install()
        self.page.evaluate(SETUP, {"session": session or me(RAD, ["radiologist"]), "studies": STUDIES,
                                   "app": app or {A: {"version": 3, "rs": "A"}, B: {"version": 1, "rs": "T"}, C: {"version": 2, "rs": "A"}},
                                   "names": NAMES, "mode": mode or {"serverMode": True, "offline": False}})
        self.page.add_script_tag(url=ORIGIN + BASE + JS_NAME)
        setup_standin(self.page)
        self.page.add_script_tag(content=PRELUDE + STANDIN + BLOCK + TAIL)
        self.assertEqual([], self.page.evaluate("() => window.synToasts"), "the block mounted")

    def pick(self, uid):
        self.page.evaluate("u => window.synPick(u)", uid)

    def view(self):
        return self.page.evaluate(VIEW)

    def open_more(self):
        if not self.page.evaluate("() => document.querySelector('#report-more').open"):
            self.page.locator("#report-more > summary").click()

    def entry_settled(self):
        """Wait until every #1 read the page started has been answered (held ones aside) and the answers have run."""
        self.settle()

        def answered():
            held = [h["route"].request for h in self.held] + self.parked
            asked = [r["request"] for r in self.log if r["kind"] == "recipients" and r["request"] not in held]
            return all(any(item is request for item in self.finished) for request in asked)
        self.wait_until(answered, "the Mark CVR server check")
        self.settle()

    def mark(self, ready=True):
        self.open_more()
        expect(self.page.locator("#b-mark-cvr")).to_be_enabled()
        self.page.locator("#b-mark-cvr").click()
        expect(self.page.locator("#cvr-send")).to_be_visible()
        if ready:
            expect(self.page.locator("#cvr-send-submit")).to_be_enabled()

    def compose(self, person=P, text="SYN critical finding: call the ward"):
        self.page.locator("#cvr-send-recipient").select_option(person["sub"])
        self.page.locator("#cvr-send-message").fill(text)

    def send(self, person=P, text="SYN critical finding: call the ward"):
        self.compose(person, text)
        self.page.locator("#cvr-send-submit").click()

    def dialog_says(self, word):
        expect(self.page.locator("#cvr-send-status")).to_contain_text(word)
        return self.view()["dialog"]

    def close_dialog(self):
        self.page.locator("#cvr-send-close").click()
        expect(self.page.locator("#cvr-send")).to_be_hidden()

    def show_sent(self):
        expect(self.page.locator("#cvr-sent-p")).to_be_visible()
        if self.page.locator("#cvr-sent-toggle").text_content() == "Show Sent":
            self.page.locator("#cvr-sent-toggle").click()
        expect(self.page.locator("#cvr-sent-pane")).to_be_visible()

    def ready_reader(self, **kwargs):
        self.open_reader(**kwargs)
        self.pick(A)
        self.entry_settled()

    # ── SD01 ──
    def test_u5_cancel_delivery_survives_cancelled_preparation_without_source_read(self):
        record = self.server.add(B, X)
        self.ready_reader()
        self.show_sent()
        self.page.locator(f'#cvr-sent-rows tr[data-id="{record["id"]}"]').get_by_role("button", name="Cancel Delivery").click()
        form = self.page.locator("#cvr-sent-rows tr:not([data-id])")
        reason = "SYN keep the typed cancellation reason"
        form.locator("textarea").fill(reason)
        self.server.reasons[B] = "NO_PINNABLE_SOURCE"
        reads = len(self.requests("recipients"))
        expect(form.get_by_role("button", name="Cancel Delivery")).to_be_enabled()
        self.page.evaluate("() => {const p=KinWorkContext.prepare({});KinWorkContext.cancelPreparation(p);}")
        self.settle()
        expect(form.get_by_role("button", name="Cancel Delivery")).to_be_enabled()
        expect(form.locator("textarea")).to_have_value(reason)
        self.assertEqual(reads, len(self.requests("recipients")))

    def test_u5_supersede_source_survives_selection_change(self):
        record = self.server.add(B, X)
        self.ready_reader()
        self.show_sent()
        self.fault("recipients", hold=True, apply=True)
        self.page.locator(f'#cvr-sent-rows tr[data-id="{record["id"]}"]').get_by_role("button", name="Supersede").click()
        held = self.take("recipients")
        self.pick(C)
        self.release(held)
        form = self.page.locator("#cvr-sent-rows tr:not([data-id])")
        expect(form).to_contain_text("Source: v1")
        expect(form.get_by_role("button", name="Supersede")).to_be_enabled()
        form.locator("textarea").fill("SYN pinned B after selecting C")
        form.get_by_role("button", name="Supersede").click()
        self.wait_until(lambda: len(self.requests("supersede")) == 1, "the pinned supersede")
        self.assertEqual(f'/api/critical-results/{record["id"]}/supersede', self.requests("supersede")[0]["path"])

    def test_u5_supersede_source_resumes_after_cancelled_preparation(self):
        record = self.server.add(B, X)
        self.ready_reader()
        self.show_sent()
        self.fault("recipients", hold=True, apply=True)
        self.page.locator(f'#cvr-sent-rows tr[data-id="{record["id"]}"]').get_by_role("button", name="Supersede").click()
        held = self.take("recipients")
        form = self.page.locator("#cvr-sent-rows tr:not([data-id])")
        form.locator("textarea").fill("SYN keep this message")
        self.page.evaluate("() => {const p=KinWorkContext.prepare({});KinWorkContext.cancelPreparation(p);}")
        expect(form.get_by_role("button", name="Supersede")).to_be_enabled()
        expect(form).to_contain_text("Source: v1")
        expect(form.locator("textarea")).to_have_value("SYN keep this message")
        self.release_late(held)
        expect(form.get_by_role("button", name="Supersede")).to_be_enabled()

    def test_sd01_mark_cvr_follows_the_server_answer_and_shows_its_refusals(self):
        self.fault("recipients", hold=True, apply=True)
        self.open_reader()
        self.pick(A)
        held = self.take("recipients")
        v = self.view()["entry"]
        self.assertTrue(v["disabled"], "on before the server answered")
        self.assertTrue(has_hangul(v["title"]), v["title"])
        # Disabled is not hidden: the control stays in its More section with its English name.
        self.assertEqual((True, "Status", "Mark CVR"), (v["present"], v["section"], v["text"]))
        self.release(held)
        expect(self.page.locator("#b-mark-cvr")).to_be_enabled()
        self.assertEqual([f"/api/studies/{A}/critical-result-recipients"], [r["path"] for r in self.requests("recipients")])
        # The same target in the same report state asks nothing more, the list repaint or More opening included.
        self.pick(A)
        self.open_more()
        self.settle()
        self.assertEqual(1, len(self.requests("recipients")))
        # A save the page records without a clinical repaint (commitReport) is seen when More is opened next.
        self.page.locator("#report-more > summary").click()
        self.page.evaluate("([u, n]) => window.synReport(u, n, 'T', false)", [A, 4])
        self.server.heads[A] = {**HEADS[A], "version": 4, "action": "save"}
        self.server.reasons[A] = "NO_ELIGIBLE_RECIPIENT"
        self.open_more()
        self.wait_until(lambda: len(self.requests("recipients")) == 2, "a #1 read when More opens after the save")
        self.entry_settled()
        self.assertEqual(2, len(self.requests("recipients")))
        v = self.view()["entry"]
        self.assertEqual((True, REASONS["NO_ELIGIBLE_RECIPIENT"]), (v["disabled"], v["title"]))
        # Each §16.1 reason, after the report state moves on (renderClinical after a commit or a poll).
        version = 4
        for reason in ("NO_PINNABLE_SOURCE", "SOURCE_FORBIDDEN", "NO_ELIGIBLE_RECIPIENT"):
            with self.subTest(reason=reason):
                version += 1
                self.server.reasons[A] = reason
                self.page.evaluate("([u, n]) => window.synReport(u, n, 'T', true)", [A, version])
                self.entry_settled()
                v = self.view()["entry"]
                self.assertEqual((True, REASONS[reason]), (v["disabled"], v["title"]))
                self.assertEqual((True, "Status"), (v["present"], v["section"]))
        # Refusals and failures are shown with the server's own words, never swallowed or read as "not allowed".
        self.server.reasons.pop(A)
        cases = [({"status": 403, "body": {"code": "CRITICAL_RESULT_ROLE_REQUIRED", "message": "SYN role refused"}},
                  ["SYN role refused", "CRITICAL_RESULT_ROLE_REQUIRED", "HTTP 403"]),
                 ({"status": 404, "body": {"code": "STUDY_NOT_FOUND", "message": "SYN study not found"}}, ["SYN study not found", "HTTP 404"]),
                 ({"status": 500, "body": {"message": "SYN failure"}}, ["SYN failure", "HTTP 500"]),
                 ({"abort": True}, []),
                 ({"patch": lambda p: p.update(recipients=[])}, []),
                 ({"patch": lambda p: p.update(source=None)}, []),
                 ({"patch": lambda p: p.update(uid=B)}, [])]
        for spec, words in cases:
            with self.subTest(spec=sorted(spec)):
                version += 1
                apply = "patch" in spec
                self.fault("recipients", apply=apply, **spec)
                self.page.evaluate("([u, n]) => window.synReport(u, n, 'A', true)", [A, version])
                self.entry_settled()
                v = self.view()["entry"]
                self.assertTrue(v["disabled"], spec)
                self.assertTrue(v["title"].startswith(CANNOT_CHECK), v["title"])
                for word in words:
                    self.assertIn(word, v["title"])
                self.assertEqual((True, "Status"), (v["present"], v["section"]))
        # And a later good answer turns it on again.
        self.page.evaluate("([u, n]) => window.synReport(u, n + 1, 'A', true)", [A, version])
        expect(self.page.locator("#b-mark-cvr")).to_be_enabled()

    # ── SD02 ──
    def test_sd02_the_dialog_shows_the_pinned_version_and_only_the_candidates_and_never_prefills(self):
        self.ready_reader(app={A: {"version": 2, "rs": "T"}})
        self.page.evaluate("t => { document.querySelector('#findings').value = t; }", REPORT_TEXT)
        before = len(self.requests("recipients"))
        self.mark()
        self.assertEqual(before + 1, len(self.requests("recipients")), "the dialog reads #1 afresh")
        d = self.view()["dialog"]
        self.assertEqual("Send Critical Result", d["title"])
        self.assertIn(DIALOG_HELP, d["help"])
        # §17 limits in the dialog: opening is not recorded, no automatic re-notification.
        self.assertRegex(d["help"], r"열어보았는지는 기록하지 않")
        self.assertRegex(d["help"], r"자동으로 다시 알리지 않")
        self.assertIn("SYN ALPHA", d["study"])
        self.assertIn("SYN-P-01", d["study"])
        # The server's head (v3), not the page's own version (2).
        self.assertTrue(d["source"].startswith("Source: v3 · Approve · SYN Radiologist · 2026-09-28"), d["source"])
        self.assertEqual("SELECT", d["recipientTag"])
        self.assertEqual(0, d["inputs"], "no free-text recipient field")
        values = [value for value, _ in d["options"] if value]
        self.assertEqual([P["sub"], X["sub"]], values)
        texts = dict(d["options"])
        self.assertIn("SYN Clinician", texts[P["sub"]])
        self.assertTrue(texts[P["sub"]].endswith("Clinician"), texts[P["sub"]])
        self.assertTrue(texts[X["sub"]].endswith("Radiologist"), texts[X["sub"]])
        self.assertEqual("", d["message"], "Message is never prefilled (with the report or anything else)")
        # Send is explicit: choosing and typing sends nothing.
        self.compose()
        self.settle()
        self.assertEqual([], self.requests("create"))
        # Without a recipient or with an empty message nothing is sent either.
        self.page.locator("#cvr-send-recipient").select_option("")
        self.page.locator("#cvr-send-submit").click()
        self.page.locator("#cvr-send-recipient").select_option(P["sub"])
        self.page.locator("#cvr-send-message").fill("   ")
        self.page.locator("#cvr-send-submit").click()
        self.settle()
        self.assertEqual([], self.requests("create"))
        self.assertTrue(has_hangul(self.view()["dialog"]["status"]))
        self.page.locator("#cvr-send-message").fill("SYN critical finding")
        self.page.locator("#cvr-send-submit").click()
        self.dialog_says(DELIVERED)
        self.assertEqual(3, self.requests("create")[0]["body"]["sourceVersion"])

    # ── SD03 ──
    def test_sd03_nothing_reads_as_delivered_before_the_201(self):
        self.ready_reader()
        self.fault("create", hold=True, apply=True)
        self.mark()
        self.send()
        held = self.take("create")
        v = self.view()
        self.assertIsNone(SUCCESS.search(v["body"]), "a success word before the 201")
        self.assertIsNone(SUCCESS.search(v["entry"]["title"]))
        self.assertNotIn(NOT_DELIVERED, v["body"])
        self.assertTrue(v["dialog"]["messageReadOnly"])
        self.assertTrue(v["dialog"]["recipientDisabled"])
        self.assertTrue(v["dialog"]["sendDisabled"])
        self.assertEqual([], self.page.evaluate("() => window.synToasts"))
        request = self.requests("create")[0]
        self.assertEqual(f"/api/studies/{A}/critical-results", request["path"])
        self.assertEqual(CREATE_KEYS, sorted(request["body"]))
        self.assertRegex(request["body"]["requestId"], UUID_V4)
        self.assertEqual({"expectedOwner": [INSTITUTION, RAD["sub"]], "recipientSub": P["sub"], "sourceVersion": 3,
                          "message": "SYN critical finding: call the ward"},
                         {k: request["body"][k] for k in ("expectedOwner", "recipientSub", "sourceVersion", "message")})
        self.release(held)
        d = self.dialog_says(DELIVERED)
        self.assertIn(DELIVERED_TEXT, d["status"])
        self.assertNotIn(NOT_DELIVERED, d["status"])
        self.assertTrue(d["sendDisabled"])
        self.assertFalse(d["check"])
        # The list is read again and the sent record is pending there.
        expect(self.page.locator("#cvr-sent-summary")).to_have_text("Pending ACK 1")

    # ── SD04 ──
    REFUSALS = [(400, "CRITICAL_RESULT_INPUT_INVALID"), (400, "CRITICAL_RESULT_RECIPIENT_INVALID"),
                (403, "CRITICAL_RESULT_ROLE_REQUIRED"), (403, "CRITICAL_RESULT_SOURCE_FORBIDDEN"), (403, "INSTITUTION_INVALID"),
                (403, None), (404, "STUDY_NOT_FOUND"), (409, "REQUEST_ID_REUSED"), (409, "CRITICAL_RESULT_PENDING_EXISTS"),
                (409, "CRITICAL_RESULT_SOURCE_MOVED"), (409, "CRITICAL_RESULT_SOURCE_INVALID"),
                (409, "CRITICAL_RESULT_RECIPIENT_CANNOT_READ"), (503, "CRITICAL_RESULT_UNAVAILABLE")]

    def test_sd04_only_confirmed_rejections_of_the_first_request_are_not_delivered(self):
        self.ready_reader()
        ids = []
        for status, code in self.REFUSALS:
            with self.subTest(status=status, code=code):
                body = {"message": f"SYN refusal {status} {code}"}
                if code:
                    body["code"] = code
                if code == "CRITICAL_RESULT_PENDING_EXISTS":
                    body["id"] = "99999999-9999-4999-8999-999999999999"
                self.fault("create", status=status, body=body)
                self.mark()
                self.send()
                self.dialog_says(NOT_DELIVERED)
                # A new send is allowed (after SOURCE_MOVED, once the dialog has read the current head again: sd12).
                expect(self.page.locator("#cvr-send-submit")).to_be_enabled()
                d = self.view()["dialog"]
                self.assertIn(f"SYN refusal {status} {code}", d["status"])
                self.assertIn(f"HTTP {status}", d["status"])
                if code:
                    self.assertIn(code, d["status"])
                self.assertTrue(has_hangul(d["status"]), d["status"])
                self.assertIsNone(SUCCESS.search(self.view()["body"]))
                self.assertFalse(d["check"], "no Check Again for a confirmed rejection")
                self.assertFalse(d["sendDisabled"], "a new send is allowed")
                ids.append(self.requests("create")[-1]["body"]["requestId"])
                if len(ids) == 1:
                    # A new send after a confirmed rejection is a new request.
                    self.page.locator("#cvr-send-submit").click()
                    self.dialog_says(DELIVERED)
                    self.assertNotEqual(ids[0], self.requests("create")[-1]["body"]["requestId"])
                    self.server.records.clear()
                self.close_dialog()
        self.assertEqual(len(ids), len(set(ids)))
        # Nothing about a confirmed rejection stays in the list area.
        self.assertEqual([], self.view()["panel"]["lines"])

    def test_sd04b_answers_that_may_follow_a_commit_are_unknown_never_not_delivered(self):
        self.ready_reader()
        other = {"patch": lambda p: p["applied"].update(requestId="99999999-9999-4999-8999-999999999999"), "apply": True}
        cases = [("409 STUDY_ACCESS_CHANGED after commit", {"apply": True, "status": 409,
                                                           "body": {"code": "STUDY_ACCESS_CHANGED", "message": "SYN access changed"}}),
                 ("code-less 503 after commit", {"apply": True, "status": 503, "body": {"statusCode": 503, "message": "SYN policy read failed"}}),
                 ("503 CRITICAL_RESULT_BUSY", {"status": 503, "body": {"code": "CRITICAL_RESULT_BUSY", "message": "SYN busy"}}),
                 ("500", {"status": 500, "body": {"message": "SYN internal"}}),
                 ("502 page", {"raw": (502, "<html>SYN bad gateway</html>")}),
                 ("504 page", {"raw": (504, "<html>SYN gateway timeout</html>")}),
                 ("reset after apply", {"apply": True, "abort": True}),
                 ("200 instead of 201", {"apply": True, "http": 200}),
                 ("201 for another request", other),
                 ("409 with a code this screen does not know", {"status": 409, "body": {"code": "SYN_NEW_CODE", "message": "SYN new"}})]
        for name, spec in cases:
            with self.subTest(name):
                self.fault("create", **spec)
                self.server.records.clear()
                self.mark()
                self.send()
                d = self.dialog_says(UNKNOWN_WORD)
                self.assertIn(UNKNOWN_TEXT, d["status"])
                self.assertTrue(d["check"], "Check Again is offered")
                self.assertTrue(d["messageReadOnly"] and d["recipientDisabled"] and d["sendDisabled"], "the request is kept as sent")
                body = self.view()["body"]
                self.assertNotIn(NOT_DELIVERED, body)
                self.assertIsNone(SUCCESS.search(body))
                self.close_dialog()
        # Each unknown request stays as a line above the list after its dialog closed.
        panel = self.view()["panel"]
        self.assertEqual(len(cases), len([line for line in panel["lines"] if UNKNOWN_WORD in line["text"]]))
        self.assertTrue(all(line["check"] for line in panel["lines"]))

    # ── SD05 ──
    def test_sd05_check_again_resends_the_same_request_and_a_replay_is_delivered_once(self):
        self.ready_reader()
        self.fault("create", apply=True, status=409, body={"code": "STUDY_ACCESS_CHANGED", "message": "SYN access changed"})
        self.mark()
        self.send()
        self.dialog_says(UNKNOWN_WORD)
        self.page.locator("#cvr-send-check").click()
        d = self.dialog_says(DELIVERED)
        self.assertIn(DELIVERED_TEXT, d["status"])
        first, again = self.requests("create")
        self.assertEqual(first["raw"], again["raw"], "Check Again sends the same bytes")
        self.assertEqual(1, len(self.server.records), "the replay adds no record")
        self.assertNotIn(NOT_DELIVERED, self.view()["body"])

    # ── SD06 ──
    def entry(self):
        v = self.view()["entry"]
        return v["disabled"], v["title"]

    def test_sd06a_a_late_mark_cvr_answer_never_overrides_a_newer_read(self):
        """A -> B -> A. The first A answer always carries the other state than the second (sendable against refused, a
        refusal or a failure against sendable), so applying it anywhere would show on the button. It comes back while
        the second A read is out, or after the second A answer (last)."""
        cases = [("a late sendable answer", {}, "NO_ELIGIBLE_RECIPIENT", (True, REASONS["NO_ELIGIBLE_RECIPIENT"])),
                 ("a late refusal", {"reason": "NO_ELIGIBLE_RECIPIENT"}, None, None),
                 ("a late failure", {"status": 500, "body": {"message": "SYN late failure"}}, None, None)]
        for name, first_answer, second_reason, refused in cases:
            for last in (False, True):
                with self.subTest(name, first_returned_last=last):
                    self.log.clear()
                    self.server = CvrServer()
                    if first_answer.get("reason"):
                        self.server.reasons[A] = first_answer["reason"]
                    spec = {k: v for k, v in first_answer.items() if k != "reason"}
                    self.fault("recipients", hold=True, apply="status" not in spec, **spec)
                    self.open_reader()
                    self.pick(A)
                    first = self.take("recipients")
                    self.server.reasons.pop(A, None)
                    self.server.reasons[B] = "NO_PINNABLE_SOURCE"
                    self.pick(B)
                    self.entry_settled()
                    self.assertEqual((True, REASONS["NO_PINNABLE_SOURCE"]), self.entry())
                    if second_reason:
                        self.server.reasons[A] = second_reason
                    self.fault("recipients", hold=True, apply=True)
                    self.pick(A)
                    second = self.take("recipients")
                    waiting = self.entry()
                    self.assertTrue(waiting[0], "off while the newer A read is out")
                    if not last:
                        self.release(first)
                        self.assertEqual(waiting, self.entry(), "the first A answer came back while the newer read was out")
                    self.release(second)
                    newer = self.entry()
                    if refused:
                        self.assertEqual(refused, newer)
                    else:
                        self.assertFalse(newer[0], "the newer A answer says the study can be sent")
                    if last:
                        self.release(first)
                        self.assertEqual(newer, self.entry(), "the first A answer came back last")
                    # Three #1 reads, A B A, and nothing written.
                    self.assertEqual([A, B, A], [unquote(r["path"].split("/")[3]) for r in self.requests("recipients")])
                    self.assertEqual([], [r for r in self.log if r["method"] != "GET"])

    def test_sd06b_late_dialog_answers_never_paint_another_study(self):
        self.ready_reader()
        # A dialog read answered after the target moved paints nothing.
        self.fault("recipients", hold=True, apply=True)
        self.mark(ready=False)
        held = self.take("recipients")
        self.pick(C)
        expect(self.page.locator("#cvr-send")).to_be_hidden()
        self.release(held)
        d = self.view()["dialog"]
        self.assertFalse(d["open"])
        self.assertEqual([["", "Choose Recipient"]], d["options"])
        # A send answered after the target moved paints nothing on the next study's dialog; its result goes to the line.
        self.entry_settled()
        self.pick(A)
        self.entry_settled()
        self.fault("create", hold=True, apply=True)
        self.mark()
        self.send()
        post = self.take("create")
        self.pick(C)
        expect(self.page.locator("#cvr-send")).to_be_hidden()
        self.entry_settled()
        self.mark()
        lines = self.view()["panel"]["lines"]
        self.assertEqual(1, len(lines))
        self.assertIsNone(SUCCESS.search(lines[0]["text"]))
        self.release(post)
        d = self.view()["dialog"]
        self.assertTrue(d["open"])
        self.assertIn("SYN GAMMA", d["study"])
        self.assertIsNone(SUCCESS.search(d["status"]), "A's 201 painted C's dialog")
        self.assertIsNone(SUCCESS.search(self.page.locator("#cvr-send").inner_text()))
        expect(self.page.locator("#cvr-sent-attempts")).to_contain_text(DELIVERED)
        self.assertIn("SYN ALPHA", self.view()["panel"]["lines"][0]["text"])

    def test_sd06c_a_session_end_ends_the_area_first_and_paints_nothing_later(self):
        for how in ("list call", "other tab", "401"):
            with self.subTest(how=how):
                self.log.clear()
                self.server = CvrServer()
                self.server.add(B, X)
                self.ready_reader()
                self.fault("create", hold=True, apply=True)
                self.mark()
                self.send()
                post = self.take("create")
                if how == "list call":
                    # What every logout start of main.html does before its first network wait.
                    self.page.evaluate("() => window.synEnd()")
                elif how == "other tab":
                    # auth.js broadcastEnded() of another tab: a message on the shared channel.
                    self.page.evaluate("() => window.synEnd()")
                else:
                    # A 401 on this area's own list read (the dialog is modal, so the list control is pressed in the DOM).
                    self.fault("list", status=401, body={"code": "AUTH_SESSION_ENDED", "message": "SYN expired"})
                    self.page.evaluate("() => document.querySelector('#cvr-sent-refresh').click()")
                self.wait_until(lambda: self.view()["entry"]["disabled"] and not self.view()["dialog"]["open"], "the area ended")
                v = self.view()
                self.assertFalse(v["panel"]["shown"])
                self.assertEqual("", v["dialog"]["status"])
                if how == "401":
                    self.assertEqual(0, self.page.evaluate("() => window.synLogouts"), "no logout from a response")
                    self.assertEqual(["end"], self.page.evaluate("() => window.synOtherEnds"), "the page's other areas ended once")
                count = len(self.log)
                self.release_late(post)
                v = self.view()
                self.assertFalse(v["dialog"]["open"] or v["panel"]["shown"])
                self.assertIsNone(SUCCESS.search(v["body"]))
                self.pick(C)
                self.open_more()
                self.settle()
                self.assertEqual(count, len(self.log), "nothing is read or sent after the end")
                self.assertTrue(self.view()["entry"]["disabled"])

    def test_sd06d_another_account_locks_the_area_and_drops_its_requests(self):
        # Another account's envelope on the list.
        self.server.add(B, X)
        self.ready_reader()
        expect(self.page.locator("#cvr-sent-p")).to_be_visible()
        self.fault("create", status=409, body={"code": "STUDY_ACCESS_CHANGED", "message": "SYN access changed"})
        self.mark()
        self.send()
        self.dialog_says(UNKNOWN_WORD)
        self.close_dialog()
        self.envelope_owner = OTHER_ACCOUNT
        self.page.locator("#cvr-sent-refresh").click()
        self.wait_until(lambda: self.view()["entry"]["disabled"] and not self.view()["panel"]["lines"], "the refused area locked")
        self.assertEqual(["account-changed"], self.page.evaluate("() => window.synOtherEnds"))
        self.assertEqual("active", self.page.evaluate("KinWorkContext.state()"))
        v = self.view()
        self.assertTrue(v["entry"]["disabled"])
        self.assertTrue(has_hangul(v["entry"]["title"]))
        self.assertEqual([], v["panel"]["lines"], "the unknown request of the other account is dropped")
        self.assertEqual([], v["panel"]["rows"])
        count = len(self.log)
        self.pick(C)
        self.open_more()
        self.settle()
        self.assertEqual(count, len(self.log), "nothing more is read")

    def test_sd06e_owner_changed_on_a_send_is_not_delivered_and_locks_the_area(self):
        self.ready_reader()
        self.fault("create", status=409, body={"code": "OWNER_CHANGED", "message": "SYN owner changed"})
        self.mark()
        self.send()
        d = self.dialog_says(NOT_DELIVERED)
        self.assertIn("OWNER_CHANGED", d["status"])
        self.assertTrue(d["sendDisabled"])
        self.assertEqual(["account-changed"], self.page.evaluate("() => window.synOtherEnds"))
        self.assertEqual("active", self.page.evaluate("KinWorkContext.state()"))

    # ── SD07 ──
    def seed_list(self):
        s = self.server
        # B's head moved on to v2 after R2 pinned v1: R2 is "Source Changed".
        s.heads[B] = {**HEADS[B], "version": 2, "action": "approve"}
        r1 = s.add(A, P)
        r2 = s.add(B, X, current=False, delivery="stub")
        r3 = s.add(C, Y, delivery="not_eligible")
        r4 = s.add(C, X, delivery="unknown")
        r5 = s.add(A, X, state="acknowledged", acknowledgedAt=iso(40))
        r6 = s.add(B, P, state="cancelled", cancelledAt=iso(41), cancelReason="SYN wrong patient")
        r7 = s.add(C, P, state="superseded", supersededAt=iso(42))
        r8 = s.add(C, P, supersedes=r7["id"])
        return r1, r2, r3, r4, r5, r6, r7, r8

    def test_sd07_the_sent_list_states_marks_and_actions(self):
        r1, r2, r3, r4, r5, r6, r7, r8 = self.seed_list()
        self.ready_reader()
        expect(self.page.locator("#cvr-sent-summary")).to_have_text("Pending ACK 5")
        self.assertEqual({"view": ["sent"], "state": ["pending"]}, self.requests("list")[0]["query"])
        self.show_sent()
        p = self.view()["panel"]
        self.assertEqual(["Study", "Recipient", "Sent", "State", "Source"], p["headers"])
        self.assertEqual("pending", p["filter"])
        self.assertEqual([r8["id"], r4["id"], r3["id"], r2["id"], r1["id"]], [row["id"] for row in p["rows"]])
        rows = {row["id"]: row for row in p["rows"]}
        for row in p["rows"]:
            self.assertIn("Pending ACK", row["cells"][3])
            self.assertIn(["Pending ACK", PENDING_HELP], row["titled"])
            self.assertEqual([["Supersede", False], ["Cancel Delivery", False]], row["buttons"])
        self.assertIn("SYN ALPHA (SYN-P-01)", rows[r1["id"]]["cells"][0])
        self.assertIn("SYN Clinician · Clinician", rows[r1["id"]]["cells"][1])
        self.assertTrue(rows[r1["id"]]["cells"][4].startswith("v3 · Approve · SYN Radiologist"), rows[r1["id"]]["cells"][4])
        for rid, mark in ((r2["id"], "Source Changed"), (r3["id"], "Recipient Not Eligible"), (r4["id"], "Status Unknown")):
            with self.subTest(mark=mark):
                self.assertIn([mark, MARKS[mark]], rows[rid]["titled"])
                self.assertIn(MARKS[mark], rows[rid]["cells"][3])
        self.assertFalse(any(mark in rows[r1["id"]]["cells"][3] for mark in MARKS))
        # All: the terminal states, with their names and descriptions, no actions, no marks.
        self.page.locator("#cvr-sent-filter").select_option("all")
        self.wait_until(lambda: len(self.view()["panel"]["rows"]) == 8, "the All list")
        self.assertEqual(["all"], self.requests("list")[-1]["query"]["state"])
        rows = {row["id"]: row for row in self.view()["panel"]["rows"]}
        for record, state in ((r5, "acknowledged"), (r6, "cancelled"), (r7, "superseded")):
            with self.subTest(state=state):
                cell = rows[record["id"]]["cells"][3]
                self.assertIn(STATE_NAMES[state], cell)
                self.assertTrue(any(name == STATE_NAMES[state] and has_hangul(tip) for name, tip in rows[record["id"]]["titled"]))
                self.assertEqual([], rows[record["id"]]["buttons"])
                self.assertFalse(any(mark in cell for mark in MARKS))
        self.assertIn("SYN wrong patient", rows[r6["id"]]["cells"][3])
        # More passes the server's cursor back as given.
        self.server.page_size = 3
        self.page.locator("#cvr-sent-refresh").click()
        self.wait_until(lambda: len(self.view()["panel"]["rows"]) == 3, "the first page")
        self.assertTrue(self.view()["panel"]["more"])
        cursor = self.server.listing({"state": ["all"]})[1]["nextCursor"]
        self.page.locator("#cvr-sent-more").click()
        self.wait_until(lambda: len(self.view()["panel"]["rows"]) == 6, "the second page")
        self.assertEqual([cursor], self.requests("list")[-1]["query"]["cursor"])
        self.server.page_size = 50
        self.page.locator("#cvr-sent-filter").select_option("pending")
        self.wait_until(lambda: len(self.view()["panel"]["rows"]) == 5, "the pending list")
        # Cancel Delivery needs a reason; the request carries exactly the contract keys.
        row = self.page.locator(f'#cvr-sent-rows tr[data-id="{r1["id"]}"]')
        row.get_by_role("button", name="Cancel Delivery").click()
        form = self.page.locator("#cvr-sent-rows tr:not([data-id])")
        form.get_by_role("button", name="Cancel Delivery").click()
        self.settle()
        self.assertEqual([], self.requests("cancel"))
        self.assertTrue(has_hangul(form.inner_text()))
        form.locator("textarea").fill("SYN sent to the wrong ward")
        form.get_by_role("button", name="Cancel Delivery").click()
        expect(self.page.locator("#cvr-sent-attempts")).to_contain_text("Cancelled")
        cancel = self.requests("cancel")[0]
        self.assertEqual(f"/api/critical-results/{r1['id']}/cancel", cancel["path"])
        self.assertEqual(["expectedOwner", "reason", "requestId", "revision"], sorted(cancel["body"]))
        self.assertEqual((1, "SYN sent to the wrong ward"), (cancel["body"]["revision"], cancel["body"]["reason"]))
        self.assertRegex(cancel["body"]["requestId"], UUID_V4)
        self.wait_until(lambda: r1["id"] not in [r["id"] for r in self.view()["panel"]["rows"]], "the cancelled record leaves Pending ACK")
        expect(self.page.locator("#cvr-sent-summary")).to_contain_text("Pending ACK 4")
        # Supersede reads the study's current head (B: v2) and sends it with a new message to the same recipient.
        row = self.page.locator(f'#cvr-sent-rows tr[data-id="{r2["id"]}"]')
        row.get_by_role("button", name="Supersede").click()
        form = self.page.locator("#cvr-sent-rows tr:not([data-id])")
        expect(form).to_contain_text("Source: v2 · Approve")
        self.assertEqual(f"/api/studies/{B}/critical-result-recipients", self.requests("recipients")[-1]["path"])
        form.locator("textarea").fill("SYN corrected message")
        form.get_by_role("button", name="Supersede").click()
        expect(self.page.locator("#cvr-sent-attempts")).to_contain_text(DELIVERED)
        supersede = self.requests("supersede")[0]
        self.assertEqual(["expectedOwner", "message", "requestId", "revision", "sourceVersion"], sorted(supersede["body"]))
        self.assertEqual((1, 2, "SYN corrected message"),
                         (supersede["body"]["revision"], supersede["body"]["sourceVersion"], supersede["body"]["message"]))
        new_id = supersede["body"]["requestId"]
        self.wait_until(lambda: new_id in [r["id"] for r in self.view()["panel"]["rows"]], "the new record in Pending ACK")
        self.assertNotIn(r2["id"], [r["id"] for r in self.view()["panel"]["rows"]])
        self.assertEqual("superseded", self.server.records[r2["id"]]["state"])
        # A cancel whose answer is lost is "Cancellation status unknown" and Check Again sends the same bytes.
        self.fault("cancel", apply=True, abort=True)
        row = self.page.locator(f'#cvr-sent-rows tr[data-id="{r3["id"]}"]')
        row.get_by_role("button", name="Cancel Delivery").click()
        form = self.page.locator("#cvr-sent-rows tr:not([data-id])")
        form.locator("textarea").fill("SYN recipient left")
        form.get_by_role("button", name="Cancel Delivery").click()
        line = self.page.locator("#cvr-sent-attempts li", has_text="Cancellation status unknown")
        expect(line).to_be_visible()
        self.assertNotIn("Not cancelled", self.view()["body"])
        line.get_by_role("button", name="Check Again").click()
        expect(self.page.locator("#cvr-sent-attempts li", has_text="SYN GAMMA").last).to_contain_text("Cancelled")
        first, again = self.requests("cancel")[1:]
        self.assertEqual(first["raw"], again["raw"])

    def test_sd07b_the_line_stays_with_nothing_pending_and_shows_a_failed_read(self):
        self.ready_reader()
        self.wait_until(lambda: len(self.requests("list")) == 1, "the first list read")
        expect(self.page.locator("#cvr-sent-summary")).to_have_text("Pending ACK 0")
        panel = self.view()["panel"]
        # Nothing pending: the line and its Show Sent stay (the way to the history); the list stays folded until opened.
        self.assertEqual((True, False, "Show Sent"), (panel["shown"], panel["pane"], panel["toggle"]))
        expect(self.page.locator("#cvr-sent-toggle")).to_be_enabled()
        # The page again, with its first list read failing: the line shows the failure instead of an empty list.
        self.fault("list", status=500, body={"message": "SYN list failure"})
        self.ready_reader()
        expect(self.page.locator("#cvr-sent-p")).to_be_visible()
        panel = self.view()["panel"]
        self.assertTrue(has_hangul(panel["summary"]), panel["summary"])
        self.assertNotIn("Pending ACK", panel["summary"])
        self.show_sent()
        self.assertIn("SYN list failure", self.view()["panel"]["status"])

    def test_sd07c_the_terminal_history_opens_with_nothing_pending(self):
        s = self.server
        r1 = s.add(A, X, state="acknowledged", acknowledgedAt=iso(40))
        r2 = s.add(B, P, state="cancelled", cancelledAt=iso(41), cancelReason="SYN wrong patient")
        r3 = s.add(C, P, state="superseded", supersededAt=iso(42))
        r4 = s.add(C, P, state="acknowledged", acknowledgedAt=iso(43), supersedes=r3["id"])
        self.ready_reader()
        expect(self.page.locator("#cvr-sent-summary")).to_have_text("Pending ACK 0")
        self.assertFalse(self.view()["panel"]["pane"])
        # From here only the user's own actions: Show Sent, then the State filter.
        self.page.locator("#cvr-sent-toggle").click()
        expect(self.page.locator("#cvr-sent-pane")).to_be_visible()
        self.assertEqual("Hide Sent", self.view()["panel"]["toggle"])
        self.assertEqual([], self.view()["panel"]["rows"], "nothing pending")
        for value, records in (("acknowledged", [r4, r1]), ("cancelled", [r2]), ("superseded", [r3]), ("all", [r4, r3, r2, r1])):
            with self.subTest(state=value):
                count = len(self.requests("list"))
                self.page.locator("#cvr-sent-filter").select_option(value)
                self.wait_until(lambda: len(self.requests("list")) > count, "the filtered read")
                ids = [record["id"] for record in records]
                self.wait_until(lambda: [row["id"] for row in self.view()["panel"]["rows"]] == ids, f"the {value} rows")
                self.assertEqual([value], self.requests("list")[-1]["query"]["state"])
                rows = {row["id"]: row for row in self.view()["panel"]["rows"]}
                for record in records:
                    self.assertIn(STATE_NAMES[record["state"]], rows[record["id"]]["cells"][3])
                    self.assertEqual([], rows[record["id"]]["buttons"], "no action on a terminal record")
        # The server's times (Asia/Seoul) and the cancel reason are there to read again.
        rows = {row["id"]: row["cells"][3] for row in self.view()["panel"]["rows"]}
        self.assertIn("2026-09-28 11:40", rows[r1["id"]])
        self.assertIn("2026-09-28 11:41", rows[r2["id"]])
        self.assertIn("SYN wrong patient", rows[r2["id"]])
        self.assertIn("2026-09-28 11:42", rows[r3["id"]])
        self.assertIn("2026-09-28 11:43", rows[r4["id"]])
        self.assertEqual([], [r for r in self.log if r["method"] != "GET"], "reading the history writes nothing")

    # ── SD08 ──
    def test_sd08_english_names_korean_explanations_and_no_avoided_word(self):
        self.seed_list()
        self.server.reasons[B] = "SOURCE_FORBIDDEN"
        self.ready_reader()
        self.fault("create", apply=True, status=409, body={"code": "STUDY_ACCESS_CHANGED", "message": "SYN access changed"})
        self.mark()
        self.send()
        dialog = self.dialog_says(UNKNOWN_WORD)
        # Controls, headings and labels of the dialog: English names (AGENTS §4). The state word is the contract's.
        dialog_names = self.page.evaluate("""() => [...document.querySelectorAll('#cvr-send h3, #cvr-send label, #cvr-send button')]
          .map(e => e.textContent.trim()).filter(Boolean)""")
        korean = [dialog["help"], self.view()["entry"]["title"]]
        dialog_text = self.page.locator("#cvr-send").text_content()
        self.close_dialog()
        self.show_sent()
        self.page.locator("#cvr-sent-filter").select_option("all")
        self.wait_until(lambda: len(self.view()["panel"]["rows"]) == 8, "the All list")
        view = self.view()["panel"]
        panel = self.page.evaluate("""() => {
          const p = document.querySelector('#cvr-sent-p');
          const names = [...p.querySelectorAll('b, button, th, label, option')].map(e => e.textContent.trim()).filter(Boolean);
          const sizes = [...p.querySelectorAll('*')].filter(e => e.getClientRects().length
            && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())).map(e => parseFloat(getComputedStyle(e).fontSize));
          return {names, sizes, text: p.innerText, help: document.querySelector('#cvr-sent-help').textContent,
                  refresh: document.querySelector('#cvr-sent-refresh').title}; }""")
        shown_names = [name for row in view["rows"] for name, _ in row["titled"]]
        tips = [tip for row in view["rows"] for _, tip in row["titled"]]
        english = dialog_names + panel["names"] + shown_names
        for text in english:
            self.assertFalse(has_hangul(text), f"English name expected: {text!r}")
        for name in ("Send Critical Result", "Recipient", "Message", "Send", "Close", "Check Again",
                     "Sent Critical Results", "Hide Sent", "Refresh", "Study", "Sent", "State", "Source", "Pending ACK",
                     "Acknowledged", "Cancelled", "Superseded", "Supersede", "Cancel Delivery", "All",
                     "Source Changed", "Recipient Not Eligible", "Status Unknown"):
            self.assertIn(name, english)
        self.assertIn(UNKNOWN_WORD, dialog["status"])
        for text in korean + [panel["help"], panel["refresh"]] + tips:
            self.assertTrue(has_hangul(text), f"Korean explanation expected: {text!r}")
        everything = "\n".join([dialog_text, panel["text"], panel["refresh"], *tips, *korean])
        self.assertIsNone(AVOIDED.search(everything), AVOIDED.search(everything))
        self.assertGreaterEqual(min(panel["sizes"]), 12)

    # ── SD09 ──
    def unknown_then(self, first):
        self.fault("create", **first)
        self.mark()
        self.send()
        self.dialog_says(UNKNOWN_WORD)
        return self.requests("create")[-1]

    def check_again(self, spec=None, read=None):
        if spec:
            self.fault("create", **spec)
        if read:
            self.fault("read", **read)
        count = len(self.requests("create"))
        self.page.locator("#cvr-send-check").click()
        self.wait_until(lambda: len(self.requests("create")) > count, "the Check Again request")
        self.settle()
        return self.view()["dialog"]

    def test_sd09a_retry_refusals_before_the_receipt_keep_it_unknown(self):
        self.ready_reader()
        first = self.unknown_then({"apply": True, "status": 409, "body": {"code": "STUDY_ACCESS_CHANGED", "message": "SYN access changed"}})
        lost = {"status": 404, "body": {"code": "CRITICAL_RESULT_NOT_FOUND", "message": "SYN not visible"}}
        for n, (status, code) in enumerate(((404, "STUDY_NOT_FOUND"), (403, "CRITICAL_RESULT_ROLE_REQUIRED"),
                                            (409, "STUDY_ACCESS_CHANGED"), (503, None)), start=1):
            with self.subTest(status=status, code=code):
                body = {"message": f"SYN retry {status}"}
                if code:
                    body["code"] = code
                self.check_again({"status": status, "body": body}, read=lost)
                # The record is read again (§8.1 rule 3 b); its 404 is not a proof of anything.
                self.wait_until(lambda: len(self.requests("read")) >= n, "the confirmation read")
                self.settle()
                d = self.view()["dialog"]
                self.assertIn(UNKNOWN_WORD, d["status"])
                self.assertIn(GUIDANCE, d["status"])
                self.assertNotIn(NOT_DELIVERED, self.view()["body"])
                self.assertTrue(d["check"])
                self.assertEqual(first["raw"], self.requests("create")[-1]["raw"])
                self.assertEqual(f"/api/critical-results/{first['body']['requestId']}", self.requests("read")[-1]["path"])
        d = self.check_again()
        self.assertIn(DELIVERED, d["status"])
        self.assertEqual(1, len(self.server.records))

    def test_sd09b_unknown_first_answers(self):
        self.ready_reader()
        for spec in ({"status": 503, "body": {"message": "SYN no code"}}, {"status": 503, "body": {"code": "CRITICAL_RESULT_BUSY", "message": "SYN busy"}},
                     {"raw": (502, "<html>SYN</html>")}, {"raw": (504, "<html>SYN</html>")}, {"abort": True}):
            with self.subTest(spec=str(spec)[:40]):
                self.unknown_then(spec)
                self.assertNotIn(NOT_DELIVERED, self.view()["body"])
                self.close_dialog()

    def test_sd09c_a_retry_that_applies_now_is_delivered(self):
        self.ready_reader()
        self.unknown_then({"status": 503, "body": {"code": "CRITICAL_RESULT_BUSY", "message": "SYN busy"}})
        self.assertEqual(0, len(self.server.records))
        d = self.check_again()
        self.assertIn(DELIVERED_TEXT, d["status"])
        self.assertEqual(1, len(self.server.records))

    def test_sd09d_a_retry_meeting_order_12_to_15_stays_unknown_with_the_reason(self):
        self.ready_reader()
        first = self.unknown_then({"status": 503, "body": {"message": "SYN no code"}})
        other = "99999999-9999-4999-8999-999999999999"
        for code, extra in (("CRITICAL_RESULT_SOURCE_MOVED", {}), ("CRITICAL_RESULT_PENDING_EXISTS", {"id": other}),
                            ("CRITICAL_RESULT_RECIPIENT_CANNOT_READ", {})):
            with self.subTest(code=code):
                d = self.check_again({"status": 409, "body": {"code": code, "message": f"SYN {code}", **extra}})
                self.assertIn(UNKNOWN_WORD, d["status"])
                self.assertIn(LATER, d["status"])
                self.assertIn(GUIDANCE, d["status"])
                self.assertNotIn(NOT_DELIVERED, self.view()["body"])
                self.assertEqual(first["raw"], self.requests("create")[-1]["raw"])
        # A PENDING_EXISTS naming this very request is the evidence it was applied.
        d = self.check_again({"status": 409, "body": {"code": "CRITICAL_RESULT_PENDING_EXISTS", "message": "SYN pending",
                                                      "id": first["body"]["requestId"]}})
        self.assertIn(DELIVERED, d["status"])
        self.assertNotIn(NOT_DELIVERED, d["status"])

    def test_sd09e_a_read_that_shows_the_record_ends_unknown(self):
        self.ready_reader()
        self.unknown_then({"apply": True, "abort": True})
        self.close_dialog()
        self.server.records.clear()
        # Not listed and #4 404: still unknown.
        self.page.locator("#cvr-sent-refresh").click()
        self.settle()
        self.assertIn(UNKNOWN_WORD, self.view()["panel"]["lines"][0]["text"])
        # Listed: delivered, with no request sent again.
        request_id = self.requests("create")[-1]["body"]["requestId"]
        self.server.add(A, P, id=request_id)
        creates = len(self.requests("create"))
        self.page.locator("#cvr-sent-refresh").click()
        expect(self.page.locator("#cvr-sent-attempts")).to_contain_text(DELIVERED)
        self.assertEqual(creates, len(self.requests("create")))

    def test_sd09f_supersede_and_cancel_unknowns_end_on_the_target_record(self):
        s = self.server
        r1 = s.add(A, P)
        r2 = s.add(C, X)
        self.ready_reader()
        self.show_sent()
        for record, then, expected in ((r1, "superseded by this request", DELIVERED), (r2, "acknowledged", NOT_DELIVERED)):
            with self.subTest(then=then):
                self.fault("supersede", status=503, body={"message": "SYN no code"})
                row = self.page.locator(f'#cvr-sent-rows tr[data-id="{record["id"]}"]')
                row.get_by_role("button", name="Supersede").click()
                form = self.page.locator("#cvr-sent-rows tr:not([data-id])")
                expect(form).to_contain_text("Source: v")
                form.locator("textarea").fill("SYN corrected")
                form.get_by_role("button", name="Supersede").click()
                line = self.page.locator("#cvr-sent-attempts li", has_text=UNKNOWN_WORD)
                expect(line).to_be_visible()
                request_id = self.requests("supersede")[-1]["body"]["requestId"]
                if then == "acknowledged":
                    record.update(state="acknowledged", revision=2, acknowledgedAt=iso(50))
                    self.fault("supersede", status=409, body={"code": "CRITICAL_RESULT_ACKNOWLEDGED", "message": "SYN acked"})
                else:
                    self.fault("supersede", apply=True, status=503, body={"message": "SYN no code"})
                self.fault("read", status=404, body={"code": "CRITICAL_RESULT_NOT_FOUND", "message": "SYN"})
                line.get_by_role("button", name="Check Again").click()
                target = self.page.locator(f'#cvr-sent-attempts li[data-request="{request_id}"]')
                expect(target).to_contain_text(expected)
                if expected == NOT_DELIVERED:
                    self.assertIn(STATE_NAMES["acknowledged"], target.inner_text())
        # A cancel of a record that was cancelled meanwhile ends as Cancelled.
        r3 = s.add(B, X)
        self.page.locator("#cvr-sent-refresh").click()
        self.wait_until(lambda: r3["id"] in [r["id"] for r in self.view()["panel"]["rows"]], "the new record")
        self.fault("cancel", status=503, body={"message": "SYN no code"})
        row = self.page.locator(f'#cvr-sent-rows tr[data-id="{r3["id"]}"]')
        row.get_by_role("button", name="Cancel Delivery").click()
        form = self.page.locator("#cvr-sent-rows tr:not([data-id])")
        form.locator("textarea").fill("SYN reason")
        form.get_by_role("button", name="Cancel Delivery").click()
        line = self.page.locator("#cvr-sent-attempts li", has_text="Cancellation status unknown")
        expect(line).to_be_visible()
        r3.update(state="cancelled", revision=2, cancelledAt=iso(51), cancelReason="SYN other tab")
        self.fault("cancel", status=409, body={"code": "CRITICAL_RESULT_CANCELLED", "message": "SYN cancelled"})
        line.get_by_role("button", name="Check Again").click()
        expect(self.page.locator("#cvr-sent-attempts li", has_text="SYN BETA").last).to_contain_text("Cancelled")

    def test_sd09g_a_delayed_original_stays_unknown_until_it_shows_up(self):
        self.ready_reader(clock=True)
        q = self.server.add(A, P, id="aaaaaaaa-0000-4000-8000-000000000001")   # another tab's pending record Q
        self.fault("create", hold=True)
        self.mark()
        self.send()
        held = self.take("create")
        r0 = self.requests("create")[-1]
        self.page.clock.fast_forward(61000)
        d = self.dialog_says(UNKNOWN_WORD)
        self.assertNotIn(NOT_DELIVERED, self.view()["body"])
        # The retry meets Q's pending record: unknown stays, with the reason and R0 kept.
        d = self.check_again()
        self.assertIn(UNKNOWN_WORD, d["status"])
        self.assertIn(LATER, d["status"])
        self.assertNotIn(NOT_DELIVERED, self.view()["body"])
        self.assertEqual(r0["raw"], self.requests("create")[-1]["raw"])
        # Q is acknowledged, then the delayed R0 is applied by the server.
        q.update(state="acknowledged", revision=2, acknowledgedAt=iso(52))
        self.assertEqual(201, self.server.create(A, held["body"])[0])
        self.release_late(held)
        self.close_dialog()
        self.page.locator("#cvr-sent-refresh").click()
        expect(self.page.locator("#cvr-sent-attempts")).to_contain_text(DELIVERED)

    # ── SD10 ──
    def test_sd10_sessions_without_the_radiologist_role_never_ask(self):
        cases = [("technician", me(RAD, ["technician"]), None), ("admin only", me(RAD, ["admin"]), None),
                 ("clinician + technician", me(RAD, ["clinician", "technician"]), None),
                 ("offline radiologist", me(RAD, ["radiologist"]), {"serverMode": True, "offline": True})]
        for name, session, mode in cases:
            with self.subTest(name):
                self.log.clear()
                self.open_reader(session=session, mode=mode)
                self.pick(A)
                self.open_more()
                self.settle()
                self.assertEqual([], self.log, "no #1 or list request")
                v = self.view()
                self.assertTrue(v["entry"]["disabled"])
                self.assertTrue(has_hangul(v["entry"]["title"]))
                self.assertEqual((True, "Status"), (v["entry"]["present"], v["entry"]["section"]))
                self.assertFalse(v["panel"]["shown"])

    # ── SD11 ──
    def test_sd11_the_periodic_re_read_only_reads_and_an_acknowledged_record_stays_reachable(self):
        r1 = self.server.add(A, P)
        self.ready_reader(clock=True)
        expect(self.page.locator("#cvr-sent-summary")).to_have_text("Pending ACK 1")
        before = copy.deepcopy(self.server.records)
        count = len(self.log)
        self.page.clock.fast_forward(60000)
        self.wait_until(lambda: len(self.log) > count, "the periodic read")
        self.settle()
        self.assertEqual(["list"], [r["kind"] for r in self.log[count:]])
        self.assertEqual(before, self.server.records)
        self.assertEqual([], self.page.evaluate("() => window.synToasts"))
        # The recipient acknowledged in between: the next read shows it, and nothing was written by the reader.
        r1.update(state="acknowledged", revision=2, acknowledgedAt=iso(53))
        count = len(self.log)
        self.page.clock.fast_forward(60000)
        self.wait_until(lambda: len(self.log) > count, "the second periodic read")
        self.settle()
        self.assertEqual(["list"], [r["kind"] for r in self.log[count:]])
        # The last pending delivery ended: the line stays, and the user opens its record and the server's
        # acknowledgement time (02:53Z, Asia/Seoul) again.
        expect(self.page.locator("#cvr-sent-summary")).to_have_text("Pending ACK 0")
        self.show_sent()
        self.page.locator("#cvr-sent-filter").select_option("acknowledged")
        self.wait_until(lambda: [row["id"] for row in self.view()["panel"]["rows"]] == [r1["id"]], "the acknowledged record")
        cell = self.view()["panel"]["rows"][0]["cells"][3]
        self.assertIn(STATE_NAMES["acknowledged"], cell)
        self.assertIn("2026-09-28 11:53", cell)
        # No periodic read while the document is not visible.
        self.page.evaluate("() => Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'})")
        count = len(self.log)
        self.page.clock.fast_forward(120000)
        self.settle()
        self.assertEqual(count, len(self.log), "no periodic read while the document is not visible")
        self.assertEqual([], [r for r in self.log if r["method"] != "GET"])

    # ── SD12 ──
    MOVED_TEXT = "SYN critical finding written before the report moved on"
    V4 = {"version": 4, "action": "addendum", "author": "syn-rad2@kin", "at": "2026-09-28T03:00:00.000Z"}

    def compose_then_move(self, head, **server):
        """Open the dialog on v3, write the message, then move the server's head before Send reaches it."""
        self.ready_reader()
        self.mark()
        self.assertTrue(self.view()["dialog"]["source"].startswith("Source: v3 · Approve"), self.view()["dialog"]["source"])
        self.compose(P, self.MOVED_TEXT)
        self.server.heads[A] = dict(head)
        for key, value in server.items():
            getattr(self.server, key)[A] = value

    def test_sd12a_a_moved_source_is_read_again_and_sent_only_on_the_next_send(self):
        self.compose_then_move(self.V4)
        reads = len(self.requests("recipients"))
        self.fault("recipients", hold=True, apply=True)
        self.page.locator("#cvr-send-submit").click()
        held = self.take("recipients")
        first = self.requests("create")[0]
        self.assertEqual(3, first["body"]["sourceVersion"])
        d = self.dialog_says(NOT_DELIVERED)
        self.assertIn("CRITICAL_RESULT_SOURCE_MOVED", d["status"])
        self.assertTrue(has_hangul(d["status"]), d["status"])
        # While the current head is read nothing can be sent, and nothing is sent again.
        self.assertTrue(d["sendDisabled"])
        self.assertEqual(self.MOVED_TEXT, d["message"])
        self.assertEqual(reads + 1, len(self.requests("recipients")))
        self.assertEqual(f"/api/studies/{A}/critical-result-recipients", self.requests("recipients")[-1]["path"])
        self.release(held)
        expect(self.page.locator("#cvr-send-source")).to_contain_text("Source: v4 · Addendum · SYN Radiologist Two")
        expect(self.page.locator("#cvr-send-submit")).to_be_enabled()
        self.settle()
        d = self.view()["dialog"]
        self.assertEqual(self.MOVED_TEXT, d["message"], "the message is kept")
        self.assertEqual(P["sub"], d["recipient"], "a recipient who is still a candidate stays chosen")
        self.assertIn(NOT_DELIVERED, d["status"], "the first request stays not delivered")
        self.assertEqual(1, len(self.requests("create")), "nothing is sent again by itself")
        self.assertIsNone(SUCCESS.search(self.view()["body"]))
        # The user's next Send is a new request on the new head.
        self.page.locator("#cvr-send-submit").click()
        self.dialog_says(DELIVERED)
        second = self.requests("create")[1]
        self.assertRegex(second["body"]["requestId"], UUID_V4)
        self.assertNotEqual(first["body"]["requestId"], second["body"]["requestId"])
        self.assertEqual({"recipientSub": P["sub"], "sourceVersion": 4, "message": self.MOVED_TEXT},
                         {k: second["body"][k] for k in ("recipientSub", "sourceVersion", "message")})
        self.assertEqual(4, self.server.records[second["body"]["requestId"]]["source"]["version"])

    def test_sd12b_a_recipient_who_cannot_read_the_new_head_is_cleared(self):
        self.compose_then_move(self.V4, candidates=[X])
        self.page.locator("#cvr-send-submit").click()
        self.dialog_says(NOT_DELIVERED)
        expect(self.page.locator("#cvr-send-source")).to_contain_text("Source: v4")
        expect(self.page.locator("#cvr-send-submit")).to_be_enabled()
        self.settle()
        d = self.view()["dialog"]
        self.assertEqual("", d["recipient"])
        self.assertEqual([X["sub"]], [value for value, _ in d["options"] if value])
        self.assertIn(P["name"], d["status"], "the cleared recipient is named")
        self.assertEqual(self.MOVED_TEXT, d["message"])
        # Send without a recipient sends nothing; a current candidate is sent on v4.
        self.page.locator("#cvr-send-submit").click()
        self.settle()
        self.assertEqual(1, len(self.requests("create")))
        self.page.locator("#cvr-send-recipient").select_option(X["sub"])
        self.page.locator("#cvr-send-submit").click()
        self.dialog_says(DELIVERED)
        second = self.requests("create")[-1]["body"]
        self.assertEqual((X["sub"], 4, self.MOVED_TEXT), (second["recipientSub"], second["sourceVersion"], second["message"]))

    def test_sd12c_a_new_head_that_cannot_be_sent_keeps_send_locked(self):
        self.compose_then_move({**self.V4, "action": "save"}, reasons="NO_ELIGIBLE_RECIPIENT")
        self.page.locator("#cvr-send-submit").click()
        expect(self.page.locator("#cvr-send-status")).to_contain_text(REASONS["NO_ELIGIBLE_RECIPIENT"])
        self.settle()
        v = self.view()
        self.assertIn(NOT_DELIVERED, v["dialog"]["status"])
        self.assertTrue(v["dialog"]["sendDisabled"])
        self.assertEqual(self.MOVED_TEXT, v["dialog"]["message"])
        self.assertEqual([], [value for value, _ in v["dialog"]["options"] if value])
        self.assertEqual((True, REASONS["NO_ELIGIBLE_RECIPIENT"]), (v["entry"]["disabled"], v["entry"]["title"]))
        self.assertEqual(1, len(self.requests("create")))

    def test_sd12d_check_again_keeps_the_unknown_request_as_it_was_sent(self):
        self.ready_reader()
        first = self.unknown_then({"status": 503, "body": {"message": "SYN no code"}})
        self.server.heads[A] = dict(self.V4)
        # The kept body pins v3, so the server now refuses it as moved (a retry's order 12-15 409: still unknown).
        self.assertEqual(409, self.server.create(A, first["body"])[0])
        reads = len(self.requests("recipients"))
        for _ in range(2):
            d = self.check_again()
            self.assertIn(UNKNOWN_WORD, d["status"])
            self.assertIn(LATER, d["status"])
            self.assertNotIn(NOT_DELIVERED, self.view()["body"])
            self.assertEqual(first["raw"], self.requests("create")[-1]["raw"], "the same requestId and body")
            self.assertTrue(d["source"].startswith("Source: v3 · Approve"), d["source"])
            self.assertTrue(d["sendDisabled"] and d["messageReadOnly"] and d["recipientDisabled"])
        self.assertEqual(reads, len(self.requests("recipients")), "Check Again reads no new head or candidates")

    def test_sd12e_a_late_re_read_never_paints_a_dialog_opened_again(self):
        self.compose_then_move(self.V4)
        self.fault("recipients", hold=True, apply=True)
        self.page.locator("#cvr-send-submit").click()
        held = self.take("recipients")      # the re-read, answered with v4 and the old candidates
        self.dialog_says(NOT_DELIVERED)
        self.close_dialog()
        self.server.heads[A] = {**self.V4, "version": 5}
        self.server.candidates[A] = [X]
        self.mark()
        expect(self.page.locator("#cvr-send-source")).to_contain_text("Source: v5")
        self.release(held)
        d = self.view()["dialog"]
        self.assertTrue(d["source"].startswith("Source: v5"), d["source"])
        self.assertEqual([X["sub"]], [value for value, _ in d["options"] if value])
        self.assertEqual("", d["message"], "a dialog opened again starts empty")
        self.assertNotIn(NOT_DELIVERED, d["status"])
        self.assertEqual(1, len(self.requests("create")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
