# coding: utf-8
"""REQ-S5-U4c-REQUEST-UI -> RISK-S5-U4c-STALE -> TEST-S5-U4c-DOM.

S5-U4c 2/2: the image request screens over the S5-U4c routes (#7-#11, api/src/image-request.controller.ts). An in-test
stand-in answers as image-request.service.ts does: the DTO of U4p §3.3, the write envelope of §3.4 ({owner, applied,
replayed}) with one receipt per requestId, and the §13 codes. No stack, network or credentials; synthetic data only.

Structure (stdlib):
  s01  every S5-U4c change sits in named regions: with them taken out, main.html and clinician.js are the base commit
       (aaf53dc) byte for byte, and tests/report_actions_dom_test.py's pins (which tests/worklist_toolbar_dom_test.py
       reads) hold on that result.
  s02  the hooks are one line each (renderClinical, and api()'s 401 list before the logout is awaited); the queue lives in
       the Order List panel and the reading line after the report footer row; neither block reads a question, consultation
       or Connect route or writes markup strings.

Clinician Home (clinician.html + clinician.js + auth.js served unchanged):
  c01  closed until opened (no read, button or heading); opened: #9 once, the five states, Closed with its note, handler
       and note lines, cancel only on Requested/Accepted; a tele study is not read; empty, 404, 503 and Retry.
  c02  #10: exact body keys, a new v4 requestId, expectedOwner = [institution, sub], counterpartyInstitutionId null; the
       list is read again after the write; a lost reply keeps the request and Retry sends the same requestId and body
       and shows the stored result (replayed); Discard; 409 IMAGE_REQUEST_ACTIVE_EXISTS; blank fields are not sent.
  c03  #11 cancel: a reason is required and the revision comes from the last read; 409 CHANGED / STATE, 404, 403, 503
       and 409 STUDY_ACCESS_CHANGED are each shown with their code; 503 / STUDY_ACCESS_CHANGED keep Retry.
  c04  A->B->A: a late list answer for A or B never paints over A's newer read; the guard-less file does (control).
  c05  another account's answer, a 403 read and OWNER_CHANGED lock the area for the document; a session ended in another
       tab while a read and a write are held draws neither.
  c06  drafts are kept per study (A->B->A); keyboard reach; English controls, Korean explanations, avoided words, 12px
       text, 24px targets, no 'transfer' on screen.
  c07  (B-R-001 F2) a receipt that is not the sent write (to, revision, from, kind or at wrong or missing) stays unknown:
       the fields and requestId are kept and Retry sends the same body; a correct replayed receipt is accepted after the
       request moved on; the fix1 check (control) took a wrong receipt as saved.
  c08  (B-R-001 F3) a mixed-role account (clinician+radiologist, clinician+technician) sees Cancel only on its own
       requests, matched by the token actor and not by the display name; nothing is sent for the others.

main.html (its markup and CSS as shipped with the scripts stripped; the page's own api() and setMode() and the S5-U4c
block cut from main.html and run over small stand-ins):
  m01  Technician mode shows the queue and Radiology mode hides it; closed until opened; #7 view=queue&state=active,
       More with the cursor verbatim, State and Kind filters.
  m02  #8 and #11: Accept (note ''), Close / Decline (note required), the revision of the last read, the envelope, the
       request and the queue read again; Closed with its note; finished requests keep their buttons disabled.
  m03  write failures by code; an unknown result keeps Retry with the same requestId and body; replayed.
  m04  role guidance: a radiologist reads only, a technician processes, an admin also cancels; a 403 read locks.
  m05  A->B->A for the request and for the page; the guard-less block paints the late request (control).
  m06  the reading line: #9 for the reading study, shown only with requests or a failure, read only, tele not read,
       A->B->A, 404 with Retry, 403 locks; (B-R-001 F4) folded, a Closed request brings its required note on its own
       wrapping line, whole inside the section even when the panel is narrow (an ellipsis on that line is seen: control).
  m07  session ended, another account's answer and OWNER_CHANGED: nothing is drawn afterwards.
  m08  wording, 12px text, 24px targets and keyboard reach for both areas.
  m09  (B-R-001 F1) the page's api() over the shipped auth.js with POST /auth/logout held: a 401 on a queue read or on a
       write ends the area before the logout answers; a held read and a held write answered afterwards draw nothing and
       nothing new is read or sent; api() without the hook line (fix1, control) paints the late read.
  m10  (B-R-001 F2) the queue's receipts, as c07 (accept and an admin's cancel).
  m11  (B-R-001 F3) Cancel is enabled for an admin (note still required) or for a clinician who is the requester (token
       actor); a mixed-role account on another's request, or one whose actor is unknown, gets it disabled and sends nothing.
"""
import copy
import hashlib
import json
import re
import subprocess
import time
import unicodedata
import unittest
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from playwright.sync_api import expect, sync_playwright
from report_actions_dom_test import BASE_MAIN_SHA256 as UI3_BASE_MAIN_SHA256
from report_actions_dom_test import BASE_SCRIPTS_SHA256 as UI3_BASE_SCRIPTS_SHA256
from report_actions_dom_test import scripts_digest, without_ui3

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"


def lf_text(path):
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


ORIGIN = "https://clinician.test"
BASE = "/worklist/hpacs-lite/"
SHIPPED = {name: lf_text(HPACS / name) for name in ("clinician.html", "clinician.js", "auth.js")}
MAIN = lf_text(HPACS / "main.html")

# The commit this unit started from (main after S5-UI3). A shallow CI clone does not have it, so what it held is pinned
# (LF-normalized UTF-8 sha256); where the commit is present the pins are checked against it first.
BASE_COMMIT = "aaf53dccad2ed140b4a2c6610e9690d33fbab2dc"
BASE_MAIN_SHA256 = "1c112d4b3b0c598a6fb15dd952e85445b0839077ee9a39618f8d6dd1bab7b47a"
BASE_CLINICIAN_SHA256 = "f406be3ae3226c473eaadd0161230ea0295b15b812d7c168b29e4181f40a0775"

# ── the S5-U4c regions ──
# Every start and end marker occurs exactly once in main.html: the markup ends carry their last inner line because a bare
# '</section>' or '</details>' line is not unique. The UI2/UI3 byte-pin tests strip these regions through
# without_u4c_main() before comparing, as they do with without_ui3().
MAIN_CSS = ("    /* ── S5-U4c 영상 요청 ──", "    /* ── S5-U4c 끝 ── */\n")
MAIN_READING = ("        <!-- S5-U4c 판독 대상 검사의",
                '          <div id="image-request-pane" role="region" aria-label="Image Requests of the Reading Study" hidden>'
                "</div>\n        </section>\n")
MAIN_QUEUE = ("        <!-- S5-U4c 임상의 영상 요청 대기열.",
              '          <div id="image-request-queue-body" role="region" aria-label="Image Request Queue"></div>\n'
              "        </details>\n")
MAIN_BLOCK = ("    // ── 영상 요청(S5-U4c) ──\n", "    // ── Match / Unmatch (8.1.2.1.1 ~ 2) ──")
HOOK = "      imageRequests?.sync();\n"
# B-R-001 F1: api() calls every end() registered in window.kinOn401 as soon as it sees a 401, before it awaits the logout.
# The list is the shared convention (S5-U4b registers its own end() the same way); the line is generic, not U4c's.
HOOK_401 = "        (window.kinOn401 || []).forEach(end => { try { end(); } catch (_) {} });\n"
LOGOUT_AWAIT = "        await KinAuth.logout();\n"
# (name, start, end, end included). A hook is one line, so it is its own start and end.
U4C_REGIONS = (
    ("css", *MAIN_CSS, True),
    ("markup-reading", *MAIN_READING, True),
    ("markup-queue", *MAIN_QUEUE, True),
    ("hook-401", HOOK_401, HOOK_401, True),
    ("hook", HOOK, HOOK, True),
    ("script", *MAIN_BLOCK, False),
)
CLINICIAN_BLOCK_MARKS = ("  // ── 영상 요청(S5-U4c) ──\n", "  // ── 환자 타임라인(S5-U3) ──")
CLINICIAN_HOOKS = ("    $('#viewer-note').textContent = TEXT.viewer;\n    clearRequests();\n",
                   "    setKeys(TEXT.keysLoading, null);\n    paintRequestsShell(row);\n")


def cut(text, start, end, inclusive):
    if text.count(start) != 1:
        raise AssertionError(f"region start {start!r} occurs {text.count(start)} times")
    first = text.index(start)
    last = text.index(end, first) + (len(end) if inclusive else 0)
    return text[:first] + text[last:]


def without_u4c_main(text):
    """main.html (LF) with the S5-U4c CSS block, the two markup regions, api()'s 401 hook line, the renderClinical hook and
    the script block out.

    Each marker must occur exactly once in the text it is cut from, so a text already stripped (or one where a later
    edit duplicated a marker) is refused rather than cut at the wrong place."""
    text = text.replace("\r\n", "\n")
    for name, start, end, inclusive in U4C_REGIONS:
        for marker in {start, end}:
            if text.count(marker) != 1:
                raise AssertionError(f"S5-U4c {name} marker {marker!r} occurs {text.count(marker)} times, expected 1")
        text = cut(text, start, end, inclusive)
    return text


def without_u4c_clinician(text):
    """clinician.js (LF) with the S5-U4c block and its two hook lines out."""
    text = text.replace("\r\n", "\n")
    for pair in CLINICIAN_HOOKS:
        if text.count(pair) != 1:
            raise AssertionError(f"hook {pair!r} must occur once")
        text = text.replace(pair, pair.split("\n")[0] + "\n")
    return cut(text, *CLINICIAN_BLOCK_MARKS, False)


def base_text(rel):
    try:
        run = subprocess.run(["git", "show", f"{BASE_COMMIT}:{rel}"], cwd=str(ROOT), capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return run.stdout.decode("utf-8").replace("\r\n", "\n") if run.returncode == 0 else None


def slice_between(source, start, end):
    first = source.index(start)
    return source[first:source.index(end, first)]


def extract_function(source, name):
    """`[async ]function name(...) {...}` by brace matching outside string literals (tests/worklist_arrivals_dom_test.py)."""
    start = source.index(f"function {name}(")
    if source[max(0, start - 6):start] == "async ":
        start -= 6
    depth, quote, escaped = 0, None, False
    for index in range(source.index("{", start), len(source)):
        char = source[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in "'\"`":
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise ValueError(name)


def variant(source, edits, label):
    for old, new, count in edits:
        found = source.count(old)
        if found != count:
            raise AssertionError(f"setup: {old!r} occurs {found} times in {label}, expected {count}")
        source = source.replace(old, new)
    return source


def page_html(text):
    html = re.sub(r"<script\b[^>]*>.*?</script>", "", text, flags=re.S)
    html = re.sub(r'<link rel="stylesheet" href="([^"]+)">',
                  lambda m: "<style>" + (HPACS / m.group(1)).read_text(encoding="utf-8") + "</style>", html)
    return re.sub(r"<link\b[^>]*>", "", html)


BLOCK = slice_between(MAIN, *MAIN_BLOCK)
CLINICIAN_BLOCK = slice_between(SHIPPED["clinician.js"], *CLINICIAN_BLOCK_MARKS)
API_FN = extract_function(MAIN, "api")
SET_MODE = extract_function(MAIN, "setMode")
MAIN_PAGE = page_html(MAIN)
# Control files: the same code without the late-answer guards.
CLINICIAN_NO_GUARD = variant(SHIPPED["clinician.js"], [
    ("    return !leaving && requestsLock === null && epoch === requestsEpoch && selected === uid;\n", "    return !leaving;\n", 1),
    ("      if (!requestsFresh(epoch, uid) || mine !== requestsSeq) return;\n", "      if (!requestsFresh(epoch, uid)) return;\n", 2),
], "clinician.js")
BLOCK_NO_GUARD = variant(BLOCK, [
    ("if (ended || lock !== null || mine !== detailSeq || detailId !== id) return;", "if (ended || lock !== null) return;", 2),
], "the S5-U4c block")
# B-R-001 controls: api() as fix1 shipped it (no 401 hook line), and the fix1 receipt checks (revision >= 1, `to` any state).
API_FN_NO_HOOK = variant(API_FN, [(HOOK_401, "", 1)], "api()")
BLOCK_FIX1_RECEIPT = variant(BLOCK, [(
    "          && applied.kind === attempt.kind && applied.from === attempt.from && applied.to === TARGET[attempt.action]\n"
    "          && applied.revision === attempt.payload.revision + 1\n"
    "          && !!at && !Number.isNaN(at.getTime()) && at.toISOString() === applied.at;\n",
    "          && Number.isSafeInteger(applied.revision) && applied.revision >= 1 && STATES.includes(applied.to);\n", 1),
], "the S5-U4c block")
CLINICIAN_FIX1_RECEIPT = variant(SHIPPED["clinician.js"], [(
    "      && applied.id === (create ? attempt.requestId : attempt.itemId) && applied.kind === attempt.kind\n"
    "      && applied.from === attempt.from && applied.to === (create ? 'Requested' : 'Cancelled')\n"
    "      && applied.revision === (create ? 1 : attempt.payload.revision + 1)\n"
    "      && !!at && !Number.isNaN(at.getTime()) && at.toISOString() === applied.at;\n",
    "      && applied.id === (attempt.action === 'create' ? attempt.requestId : attempt.itemId)\n"
    "      && Number.isSafeInteger(applied.revision) && applied.revision >= 1 && REQUEST_STATES.includes(applied.to);\n", 1),
], "clinician.js")

# Everything the cut block and the shipped api()/setMode() read from the page script, as small stand-ins. The page's
# renderClinical() is the shipped HOOK line (pinned in s02); synPick() is a selection followed by it.
PRELUDE = """
const $ = s => document.querySelector(s);
const API = location.origin + '/api';
let sess = window.synSession;
let serverMode = true, demoMode = false, offline = false;
let selectedUid = null, appState = {}, warnedFor = null;
let studies = window.synStudies;
let institutions = window.synInstitutions;
let mode = 'Radiology', sortKey = null, sortDir = 0;
const COLS = { Radiology: [], Technician: [] };
const worklistSearch = null;
const syncStudy = () => {}, updateReportButtons = () => {}, loadReport = () => {}, displayActor = value => value;
function renderHeads() {} function render() {} function renderOrders() {} function renderRelated() {} function applyLayout() {}
const toast = (message, kind) => { window.synToasts.push([message, kind]); };
const KinAuth = {
  session: () => window.synSession,
  has: role => { const s = window.synSession; return !!s && s.state === 'approved' && (s.roles.includes(role) || s.roles.includes('admin')); },
  logout: async () => { window.synLogouts += 1; },
};
function renderClinical() {
HOOK}
window.synPick = uid => { selectedUid = uid; renderClinical(); };
window.synSetMode = m => setMode(m);
""".replace("HOOK", HOOK)
# m09 runs the shipped auth.js instead of the KinAuth stand-in: its logout() awaits POST /auth/logout before it clears the
# session and broadcasts the end, which is the wait the 401 hook must not depend on.
_STUB_AUTH = PRELUDE[PRELUDE.index("const KinAuth = {\n"):PRELUDE.index("};\n", PRELUDE.index("const KinAuth = {\n")) + 3]
PRELUDE_REAL_AUTH = variant(PRELUDE, [(_STUB_AUTH, "", 1)], "PRELUDE")

INSTITUTION = "SYN-INST-A"
CLIN_SUB = "SYN-CLIN-SUB"
PREFIX = "1.2.826.0.1.3680043.10.5432"
V4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
HOSTILE = '<img src=x onerror="document.body.dataset.pwned=1">'
STAFF = {"actor": "syn-staff", "name": "SYN Staff"}
ACTIVE = ["Requested", "Accepted"]
STATES = ["Requested", "Accepted", "Closed", "Declined", "Cancelled"]


def uid(n):
    return f"{PREFIX}.{n}"


def rid(n):
    return f"00000000-0000-4000-8000-{n:012d}"


def item(n, study, state, kind="external-image", revision=1, handler=None, note=None, reason=None, counterparty=None,
         institution=None, at=0):
    created = f"2026-09-26T{10 + at:02d}:00:00.000Z"
    return {"id": rid(n), "studyUid": study, "kind": kind, "state": state, "revision": revision,
            "requester": {"actor": "syn-clinician", "name": "SYN Clinician"},
            "counterparty": {"text": counterparty or f"SYN Hospital {n}", "institutionId": institution},
            "reason": reason or f"SYN reason {n}", "handler": handler, "note": note, "createdAt": created,
            "updatedAt": created}


def err(code, message):
    return {"code": code, "message": message}


DROP = object()


def bad_receipt(changes):
    """A write answer whose `applied` has these fields replaced; DROP removes the field (B-R-001 F2)."""
    def mangle(reply):
        for key, value in changes.items():
            if value is DROP:
                reply["applied"].pop(key)
            else:
                reply["applied"][key] = value
        return reply
    return mangle


class RequestServer:
    """The S5-U4c routes as image-request.service.ts answers them, over in-test rows (no roles or tenancy: the page is
    what is under test). Every applied write keeps a receipt; a requestId sent again with the same content gets the
    stored `applied` back with replayed: true."""

    def __init__(self, owner, actor, name, staff, page=50):
        self.owner, self.actor, self.name, self.staff, self.page = list(owner), actor, name, staff, page
        self.items, self.receipts, self.tick = {}, {}, 0

    def add(self, row):
        self.items[row["id"]] = copy.deepcopy(row)

    def stamp(self):
        self.tick += 1
        return f"2026-09-27T01:00:{self.tick:02d}.000Z"

    def envelope(self, applied, replayed):
        return {"owner": list(self.owner), "applied": copy.deepcopy(applied), "replayed": replayed}

    def ordered(self, rows):
        return sorted(rows, key=lambda row: (row["createdAt"], row["id"]), reverse=True)

    def study(self, target):
        rows = self.ordered([row for row in self.items.values() if row["studyUid"] == target])[:50]
        return {"owner": list(self.owner), "items": copy.deepcopy(rows)}

    def queue(self, query):
        state = query.get("state", "active")
        states = {"active": ACTIVE, "all": STATES}.get(state, [state.capitalize()])
        rows = self.ordered([row for row in self.items.values()
                             if row["state"] in states and ("kind" not in query or row["kind"] == query["kind"])])
        start = int(query["cursor"].rsplit("_", 1)[1]) if "cursor" in query else 0
        following = f"SYN-CURSOR_{start + self.page}" if start + self.page < len(rows) else None
        return {"owner": list(self.owner), "items": copy.deepcopy(rows[start:start + self.page]), "nextCursor": following}

    def read(self, id_):
        row = self.items.get(id_)
        if row is None:
            return 404, err("IMAGE_REQUEST_NOT_FOUND", "영상 요청을 찾을 수 없습니다")
        return 200, {"owner": list(self.owner), "item": copy.deepcopy(row)}

    def create(self, target, body):
        keys = {"requestId", "expectedOwner", "kind", "counterparty", "counterpartyInstitutionId", "reason"}
        if not isinstance(body, dict) or set(body) != keys:
            return 400, err("IMAGE_REQUEST_INPUT_INVALID", "요청 ID·종류, 1~256자의 상대 기관과 1~2,000자의 사유를 입력하세요")
        if body["expectedOwner"] != self.owner:
            return 409, err("OWNER_CHANGED", "로그인한 계정이 바뀌었습니다. 화면을 다시 불러오세요")
        request_id = body["requestId"].lower()
        mark = json.dumps(["create", target, body["kind"], body["counterparty"], body["counterpartyInstitutionId"],
                           body["reason"]], ensure_ascii=False)
        if request_id in self.receipts:
            stored, applied = self.receipts[request_id]
            if stored != mark:
                return 409, err("REQUEST_ID_REUSED", "다른 내용에 이미 쓰인 요청 ID입니다. 영상 요청을 다시 불러오세요")
            return 201, self.envelope(applied, True)
        if any(row["studyUid"] == target and row["kind"] == body["kind"] and row["state"] in ACTIVE
               for row in self.items.values()):
            return 409, err("IMAGE_REQUEST_ACTIVE_EXISTS", "같은 검사·종류로 처리 중인 요청이 이미 있습니다")
        at = self.stamp()
        self.items[request_id] = {
            "id": request_id, "studyUid": target, "kind": body["kind"], "state": "Requested", "revision": 1,
            "requester": {"actor": self.actor, "name": self.name},
            "counterparty": {"text": body["counterparty"], "institutionId": body["counterpartyInstitutionId"]},
            "reason": body["reason"], "handler": None, "note": None, "createdAt": at, "updatedAt": at}
        applied = {"id": request_id, "studyUid": target, "requestId": request_id, "kind": body["kind"], "action": "create",
                   "from": None, "to": "Requested", "revision": 1, "at": at}
        self.receipts[request_id] = (mark, applied)
        return 201, self.envelope(applied, False)

    def change(self, id_, body):
        keys = {"requestId", "expectedOwner", "revision", "action", "note"}
        if (not isinstance(body, dict) or set(body) != keys or body["action"] not in ("accept", "close", "decline", "cancel")
                or (body["action"] == "accept") != (body["note"] == "")):
            return 400, err("IMAGE_REQUEST_INPUT_INVALID", "요청 ID·기준 revision·동작과 note를 확인하세요(accept는 빈 note, 그 밖은 1~2,000자)")
        if body["expectedOwner"] != self.owner:
            return 409, err("OWNER_CHANGED", "로그인한 계정이 바뀌었습니다. 화면을 다시 불러오세요")
        row = self.items.get(id_)
        if row is None:
            return 404, err("IMAGE_REQUEST_NOT_FOUND", "영상 요청을 찾을 수 없습니다")
        request_id = body["requestId"].lower()
        mark = json.dumps([id_, body["revision"], body["action"], body["note"]], ensure_ascii=False)
        if request_id in self.receipts:
            stored, applied = self.receipts[request_id]
            if stored != mark:
                return 409, err("REQUEST_ID_REUSED", "다른 내용에 이미 쓰인 요청 ID입니다. 영상 요청을 다시 불러오세요")
            return 201, self.envelope(applied, True)
        if row["revision"] != body["revision"]:
            return 409, err("IMAGE_REQUEST_CHANGED", "영상 요청이 변경되었습니다. 다시 불러온 뒤 확인하세요")
        allowed = ["Requested"] if body["action"] == "accept" else ACTIVE
        if row["state"] not in allowed:
            return 409, err("IMAGE_REQUEST_STATE", "지금 상태에서 할 수 없는 영상 요청 동작입니다")
        to = {"accept": "Accepted", "close": "Closed", "decline": "Declined", "cancel": "Cancelled"}[body["action"]]
        at = self.stamp()
        applied = {"id": id_, "studyUid": row["studyUid"], "requestId": request_id, "kind": row["kind"],
                   "action": body["action"], "from": row["state"], "to": to, "revision": row["revision"] + 1, "at": at}
        row.update(state=to, revision=row["revision"] + 1, note=None if body["action"] == "accept" else body["note"],
                   updatedAt=at)
        # The requester's own cancel leaves the handler as it was (image-request.service.ts apply()).
        if self.staff:
            row["handler"] = {"actor": self.actor, "name": self.name}
        self.receipts[request_id] = (mark, applied)
        return 201, self.envelope(applied, False)


# Product wording, verbatim (clinician.js REQUEST, main.html mountImageRequests TEXT).
CLOSED_NOTE = "이 기록은 실제 전송 여부를 나타내지 않습니다"
C_READY = "이 검사에 남긴 영상 요청 {n}건을 최신순으로 표시합니다."
C_EMPTY = "이 검사에 남긴 영상 요청이 없습니다. 목록 조회는 성공했습니다."
C_FAILED = "영상 요청을 불러오지 못했습니다."
C_TELE = "원격판독으로 받은 검사에는 영상 요청을 남기거나 읽지 않습니다. 요청은 검사를 소유한 기관 안에서만 오갑니다."
C_NOT_FOUND = ("이 검사나 요청을 찾을 수 없습니다. 원격판독으로 받은 검사나 접근 조건이 바뀐 검사에서는 영상 요청을 읽거나 남길 수 "
               "없습니다.")
C_NO_TEXT = "Counterparty(1~256자)와 Reason(1~2,000자)을 입력하세요."
C_NO_CANCEL = "취소 사유를 1~2,000자로 입력하세요."
C_CREATED = "요청을 등록했습니다."
C_CANCELLED = "요청을 취소했습니다."
REPLAYED = "이미 저장된 요청입니다. 서버가 처음 저장한 결과를 돌려주었습니다."
UNKNOWN = "저장되었는지 알 수 없습니다. Retry는 같은 요청 ID로 다시 보내 저장 결과를 확인하고, Discard는 이 요청을 버립니다."
WRITE_MALFORMED = "저장 응답의 형식을 확인할 수 없습니다. Retry는 같은 요청 ID로 다시 보내 저장 결과를 확인합니다."
C_DISCARDED = "보낸 요청을 버렸습니다. 저장되었을 수 있으니 다시 불러온 목록에서 확인하세요."
C_REFUSED = "서버가 이 계정의 영상 요청 읽기를 거절했습니다. 권한이 바뀌었다면 화면을 다시 불러오세요."
OWNER_CHANGED = "로그인한 계정이 바뀌었습니다. 이 화면에서는 영상 요청을 더 읽거나 쓰지 않습니다. 화면을 다시 불러오세요."
NO_SERVER = "서버에 연결하지 못했습니다."
C_CODES = {
    "IMAGE_REQUEST_ACTIVE_EXISTS": "같은 검사·같은 종류로 처리 중인 요청이 이미 있습니다. 그 요청을 취소한 뒤 다시 남기거나 사유에 함께 적으세요.",
    "IMAGE_REQUEST_CHANGED": "그사이 이 요청이 바뀌었습니다. 목록을 다시 불러왔으니 상태를 확인한 뒤 다시 보내세요.",
    "IMAGE_REQUEST_STATE": "지금 요청 상태에서는 할 수 없는 동작입니다. 이미 처리가 끝났을 수 있어 목록을 다시 불러왔습니다.",
    "IMAGE_REQUEST_ACTION_FORBIDDEN": "이 요청에는 이 동작을 할 수 없습니다. 요청을 남긴 본인만 취소할 수 있습니다.",
    "IMAGE_REQUEST_BUSY": "서버가 다른 요청을 처리하고 있어 저장하지 못했을 수 있습니다. Retry는 같은 요청 ID로 다시 보냅니다.",
    "STUDY_ACCESS_CHANGED": "요청 중 검사 접근 조건이 바뀌었습니다. 저장되었을 수 있으니 Retry로 같은 요청을 다시 보내 확인하세요.",
}
M_QUEUE_READY = "영상 요청 {n}건을 최신순으로 표시합니다.{more}"
M_MORE = " More로 다음 요청을 이어서 읽습니다."
M_QUEUE_EMPTY = "이 조건의 영상 요청이 없습니다. 목록 조회는 성공했습니다."
M_NOT_FOUND = "요청이나 검사를 찾을 수 없습니다. 접근 조건이 바뀌었거나 검사가 옮겨졌을 수 있습니다."
M_NO_NOTE = "이 동작에는 note(1~2,000자)가 필요합니다."
M_SAVED = {"accept": "Accepted로 기록했습니다.", "close": "Closed로 기록했습니다. 이 기록은 실제 전송 여부를 나타내지 않습니다.",
           "decline": "Declined로 기록했습니다.", "cancel": "Cancelled로 기록했습니다."}
M_DISCARDED = "보낸 요청을 버렸습니다. 저장되었을 수 있으니 다시 불러온 요청에서 확인하세요."
M_ENDED = "세션이 끝났습니다. 영상 요청을 더 읽거나 쓰지 않습니다."
M_ROLE_STAFF = "방사선사(technician) 또는 관리자 권한이 필요합니다."
M_ROLE_CANCEL = "요청한 임상의 또는 관리자만 취소할 수 있습니다."
M_STATE_ACCEPT = "Requested 상태의 요청만 Accept할 수 있습니다."
M_STATE_DONE = "처리가 끝난 요청입니다."
M_TIPS = {"accept": "요청을 받아 처리 중(Accepted)으로 기록합니다.",
          "close": "처리를 마쳤다고(Closed) 기록합니다. 실제 전송 여부를 나타내지 않습니다.",
          "decline": "요청을 거절(Declined)로 기록합니다.", "cancel": "요청을 취소(Cancelled)로 기록합니다."}
M_READ_FAILED = "이 검사의 영상 요청을 불러오지 못했습니다."
M_CODES = {
    "IMAGE_REQUEST_CHANGED": "그사이 이 요청이 바뀌었습니다. 요청을 다시 불러왔으니 상태를 확인한 뒤 다시 보내세요.",
    "IMAGE_REQUEST_STATE": "지금 요청 상태에서는 할 수 없는 동작입니다. 이미 처리가 끝났을 수 있어 요청을 다시 불러왔습니다.",
    "IMAGE_REQUEST_INPUT_INVALID": "서버가 입력 형식을 거절했습니다. note의 길이와 줄바꿈·탭 외의 제어 문자를 확인하세요.",
    "IMAGE_REQUEST_ROLE_REQUIRED": "이 계정에는 이 동작에 필요한 역할이 없습니다.",
    "IMAGE_REQUEST_BUSY": "서버가 다른 요청을 처리하고 있어 저장하지 못했을 수 있습니다. Retry는 같은 요청 ID로 다시 보냅니다.",
}
CLOSING = "세션을 닫았습니다. 로그인 화면으로 이동하는 중입니다…"

# UXR-SP-34 / UXR-G-18 avoided words and UXR-S5-15 acknowledgement wording (as tests/clinician_home_dom_test.py), plus
# U4p R06: the Connect word is not the name of a request.
AVOIDED = re.compile(r"진단|검출|판정|우선순위|diagnos|detect|priorit|\bAI\b", re.IGNORECASE)
ACKNOWLEDGED = re.compile(r"\bACK\b|acknowledg|\bsent\b|deliver|수신 확인|열어봄|읽음|전달됨", re.IGNORECASE)
TRANSFER = re.compile(r"transfer", re.IGNORECASE)

BROADCAST_ENDED = """() => { const c = new BroadcastChannel('kin-session'); c.postMessage({type: 'session-ended'}); c.close();
  localStorage.setItem('kin-session-ended', String(Date.now())); localStorage.removeItem('kin-session-ended'); }"""
CLOSED_VIEW = """() => ({children: [...document.body.children].map(e => `${e.tagName}@${e.getAttribute('role')}`),
  text: document.body.textContent})"""
ACTIVE_ELEMENT = """() => { const e = document.activeElement; return {id: e.id || null, tag: e.tagName, text: e.textContent.trim()}; }"""
# Visible text nodes with their element's font size, and every title / aria-label (tooltips are explanations too).
TEXTS_IN = """(selector) => { const root = document.querySelector(selector), out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) { const node = walker.currentNode, parent = node.parentElement, text = node.textContent.trim();
    if (text && parent && parent.checkVisibility()) out.push({text, tag: parent.tagName, size: parseFloat(getComputedStyle(parent).fontSize)}); }
  for (const element of [root, ...root.querySelectorAll('[title], [aria-label]')]) for (const name of ['title', 'aria-label'])
    if (element.hasAttribute(name) && element.getAttribute(name)) out.push({text: element.getAttribute(name), tag: element.tagName + '@' + name, size: null});
  return out; }"""
LABELS_IN = """(selector) => { const root = document.querySelector(selector), texts = s => [...root.querySelectorAll(s)].map(e => e.textContent.trim());
  return {buttons: texts('button'), headings: texts('h1, h2, h3, h4, summary, b, strong'), labels: texts('label'), options: texts('option'),
    status: texts('.status, .image-request-status')}; }"""
TARGETS_IN = """(selector) => [...document.querySelectorAll(selector)].flatMap(root => [...root.querySelectorAll('button, select, summary, input, textarea')])
  .filter(e => e.checkVisibility()).map(e => { const r = e.getBoundingClientRect(); return [e.id || e.textContent.trim().slice(0, 30), r.width, r.height]; })"""

CLINICIAN_VIEW = """() => { const s = document.querySelector('#image-requests'); if (!s) return null;
  const q = sel => s.querySelector(sel), text = e => e ? e.textContent : null, st = q('#image-requests-state');
  const note = b => b && !b.hidden ? [b.dataset.state, text(b.querySelector('.state-text')), text(b.querySelector('.state-detail'))] : null;
  const form = q('#image-request-new'), field = (w, n) => w.querySelector(`[data-field="${n}"]`);
  const compose = w => w ? {state: w.dataset.state, value: field(w, 'note').value, readOnly: field(w, 'note').readOnly,
    send: !w.querySelector('[data-send]').disabled, retry: !w.querySelector('[data-retry]').hidden,
    discard: !w.querySelector('[data-discard]').hidden} : null;
  return {uid: s.dataset.uid, open: s.open, state: s.dataset.state, body: !!q('#image-requests-body'),
    buttons: [...s.querySelectorAll('button')].map(b => b.textContent),
    headings: [...s.querySelectorAll('h1, h2, h3, h4')].map(h => h.textContent),
    list: st ? [st.dataset.state, text(st.querySelector('.state-text')), text(st.querySelector('.state-detail')),
                !!q('#image-requests-retry') && !q('#image-requests-retry').hidden, st.getAttribute('role')] : null,
    listHidden: q('#image-request-list') ? q('#image-request-list').hidden : null,
    items: [...s.querySelectorAll('#image-request-list > li')].map(li => ({id: li.dataset.id, state: li.dataset.state,
      status: text(li.querySelector('.status')), closed: text(li.querySelector('[data-closed-note]')),
      lines: [...li.querySelectorAll('[data-part="info"] > p')].map(p => p.textContent),
      cancel: compose(li.querySelector('.request-compose')), note: note(li.querySelector('[data-request-note]'))})),
    form: form ? {hidden: form.hidden, state: form.dataset.state, kind: field(form, 'kind').value,
      kindDisabled: field(form, 'kind').disabled, counterparty: field(form, 'counterparty').value,
      reason: field(form, 'reason').value, readOnly: field(form, 'reason').readOnly && field(form, 'counterparty').readOnly,
      send: !form.querySelector('[data-send]').disabled, retry: !form.querySelector('[data-retry]').hidden,
      discard: !form.querySelector('[data-discard]').hidden, note: note(form.querySelector('[data-request-note]'))} : null,
    pwned: document.body.dataset.pwned ?? null}; }"""

QUEUE_VIEW = """() => { const q = s => document.querySelector(s), text = e => e ? e.textContent : null, seen = e => !!e && e.checkVisibility();
  const box = e => e ? [e.dataset.state, text(e.querySelector('.image-request-line')), text(e.querySelector('.image-request-detail')), seen(e)] : null;
  const detail = q('#image-request-detail');
  return {shown: seen(q('#image-request-queue-summary')), open: q('#image-request-queue').open,
    lock: box(q('#image-request-queue-lock')), status: box(q('#image-request-queue-status')),
    retry: seen(q('#image-request-queue-retry')), more: seen(q('#image-request-queue-more')),
    filters: [q('#image-request-queue-state').value, q('#image-request-queue-kind').value],
    items: [...document.querySelectorAll('#image-request-queue-list > li')].map(li => ({id: li.dataset.id, state: li.dataset.state,
      current: li.getAttribute('aria-current'), lines: [...li.querySelectorAll('[data-part="info"] > p')].map(p => p.textContent),
      closed: text(li.querySelector('[data-closed-note]'))})),
    detail: seen(detail) ? {id: detail.dataset.id, state: detail.dataset.state, write: detail.dataset.write,
      read: box(detail.querySelector('[data-part="read"]')),
      lines: [...detail.querySelectorAll('[data-part="lines"] > p')].map(p => p.textContent),
      closed: [...detail.querySelectorAll('[data-closed-note]')].map(text),
      actions: [...detail.querySelectorAll('button[data-action]')].map(b => [b.dataset.action, b.disabled, b.title]),
      note: q('#image-request-note').value, noteReadOnly: q('#image-request-note').readOnly,
      retry: seen(detail.querySelector('[data-write="retry"]')), discard: seen(detail.querySelector('[data-write="discard"]')),
      result: box(detail.querySelector('[data-part="write"]'))} : null}; }"""

READ_VIEW = """() => { const q = s => document.querySelector(s), text = e => e ? e.textContent : null, seen = e => !!e && e.checkVisibility();
  const r = q('#image-request-p'), line = q('#image-request-read-status'), closed = r.querySelector(':scope > [data-part="closed"]');
  return {shown: seen(r), state: r.dataset.state, summary: text(q('#image-request-summary')),
    closedLine: seen(closed) ? text(closed) : null,
    toggle: [text(q('#image-request-toggle')), q('#image-request-toggle').getAttribute('aria-expanded'), seen(q('#image-request-toggle'))],
    pane: seen(q('#image-request-pane')),
    line: [line.dataset.state, text(line.querySelector('.image-request-line')), text(line.querySelector('.image-request-detail')), seen(line)],
    items: [...document.querySelectorAll('#image-request-read-list > li')].map(li => ({id: li.dataset.id, state: li.dataset.state,
      lines: [...li.querySelectorAll(':scope > p')].map(p => p.textContent), closed: text(li.querySelector('[data-closed-note]'))})),
    controls: [...r.querySelectorAll('button, input, select, textarea')].filter(e => seen(e)).map(e => e.tagName + ':' + e.textContent)}; }"""
# The folded Closed note at a given section width: every line box of the note inside the section, and the line not
# clipped sideways (an ellipsis leaves scrollWidth > clientWidth). `style` is applied to the line first (the control).
NARROW_CLOSED = """([width, style]) => { const r = document.querySelector('#image-request-p'), line = r.querySelector(':scope > [data-part="closed"]');
  const note = line.querySelector('[data-closed-note]');
  r.style.width = width ? `${width}px` : ''; line.style.cssText = style;
  const box = r.getBoundingClientRect(), rects = [...note.getClientRects()];
  const out = {visible: note.checkVisibility(), lines: rects.length, clipped: line.scrollWidth > line.clientWidth,
    inside: rects.length > 0 && rects.every(e => e.left >= box.left - .5 && e.right <= box.right + .5 && e.top >= box.top - .5
      && e.bottom <= box.bottom + .5), width: Math.round(box.width)};
  r.style.width = ''; line.style.cssText = ''; return out; }"""


def has_hangul(text):
    return any(unicodedata.name(ch, "").startswith("HANGUL") for ch in text)


class ImageRequestStructureTest(unittest.TestCase):
    """Stdlib side: where the change is, and that nothing else moved."""

    def test_s01_every_change_is_in_the_u4c_regions_and_the_ui2_ui3_pins_hold_without_them(self):
        main = without_u4c_main(MAIN)
        clinician = without_u4c_clinician(SHIPPED["clinician.js"])
        self.assertEqual(BASE_MAIN_SHA256, digest(main), "a main.html byte outside the S5-U4c regions moved")
        self.assertEqual(BASE_CLINICIAN_SHA256, digest(clinician), "a clinician.js byte outside the S5-U4c block moved")
        for rel, restored in (("worklist-v0/hpacs-lite/main.html", main), ("worklist-v0/hpacs-lite/clinician.js", clinician)):
            base = base_text(rel)
            if base is None:
                print("base commit", BASE_COMMIT, "absent in this clone; pinned values used")
                continue
            self.assertEqual(base, restored, rel)
        # tests/report_actions_dom_test.py (and through it tests/worklist_toolbar_dom_test.py) pin main.html outside their
        # own regions; those pins hold on main.html without the S5-U4c regions.
        self.assertEqual(UI3_BASE_MAIN_SHA256, digest(without_ui3(main)))
        self.assertEqual(UI3_BASE_SCRIPTS_SHA256, scripts_digest(main))

    def test_s02_hooks_regions_and_boundaries(self):
        self.assertEqual(1, MAIN.count(HOOK))
        # The hook sits in renderClinical(), which the report_* harnesses replace with a stub; they run select() and
        # refreshRight() as shipped, so a name there that they do not declare would throw a ReferenceError.
        self.assertIn(HOOK, slice_between(MAIN, "    function renderClinical() {", "    function applyObservation("))
        self.assertNotIn("imageRequests", slice_between(MAIN, "    function select(uid, {", "    function renderClinical()"))
        # B-R-001 F1: api() calls the 401 list synchronously, before it awaits the logout (whose POST has no time limit and
        # whose session-ended notice only follows it). The line is generic; the block puts its own end() in the list.
        self.assertEqual(1, MAIN.count(HOOK_401))
        self.assertIn("      if (res.status === 401) {\n" + HOOK_401 + LOGOUT_AWAIT, API_FN)
        self.assertEqual(1, BLOCK.count("      (window.kinOn401 = window.kinOn401 || []).push(end);\n"))
        order = slice_between(MAIN, '      <div class="panel order-p"', "      </div><!-- /workrow -->")
        self.assertIn('<details id="image-request-queue">', order)
        self.assertLess(order.index('<details id="image-request-queue">'), order.index('<div class="statusbar">'))
        report = slice_between(MAIN, '      <div class="panel report-p">', "      <!-- Order List (8.2.2)")
        self.assertLess(report.index('<div class="rfoot2">'), report.index('<section id="image-request-p"'))
        self.assertNotIn("image-request", slice_between(report, '<div class="rbtns">', '<div class="draftbar"'))
        for label, block in (("main.html", BLOCK), ("clinician.js", CLINICIAN_BLOCK)):
            for needle in ("innerHTML", "insertAdjacentHTML", "outerHTML", "document.write", "/questions", "/consultations",
                           "/transfers", "/basis"):
                with self.subTest(block=label, needle=needle):
                    self.assertNotIn(needle, block)
        # Clinician Home never reads the role list (S5-U2a); main.html's role guidance is applyRoleUi's, and the server decides.
        self.assertNotIn("KinAuth.has(", CLINICIAN_BLOCK)
        self.assertEqual(1, BLOCK.count("KinAuth.has("))
        # The routes each block calls, and nothing else.
        self.assertEqual(sorted({"/image-requests?${query}", "/image-requests/${encodeURIComponent(id)}",
                                 "/image-requests/${encodeURIComponent(attempt.id)}",
                                 "/studies/${encodeURIComponent(target)}/image-requests"}),
                         sorted(set(re.findall(r"`(/[^`$]*(?:\$\{[^}]*\}[^`$]*)*)`", BLOCK))))
        self.assertEqual(sorted({"/studies/${encodeURIComponent(uid)}/image-requests", "/image-requests/${encodeURIComponent(id)}"}),
                         sorted(set(re.findall(r"`(/(?:studies|image-requests)[^`]*)`", CLINICIAN_BLOCK))))


class Harness(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.read_errors, self.write_errors = [], []
        # Each applied (or replayed) write answer passes through the next of these first: a receipt that is not the one
        # the page sent (B-R-001 F2). The server itself stores and replays the correct one.
        self.mangles = []
        self.lose_replies = 0
        self.held_reads = self.held_writes = None
        self.reads, self.writes = [], []
        self.unexpected, self.errors, self.dialogs, self.finished = [], [], [], []
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 900}, timezone_id="UTC")
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
        self.page.set_default_timeout(5000)
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", self.on_dialog)
        self.page.on("requestfinished", lambda request: self.finished.append(request))

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.unexpected, "requests the harness does not answer")
        self.assertEqual([], self.dialogs, "browser dialogs")

    def on_dialog(self, dialog):
        self.dialogs.append(f"{dialog.type}: {dialog.message}")
        dialog.dismiss()

    def wait_until(self, predicate, what, timeout=10.0):
        # Sync-API route handlers run on this thread while wait_for_timeout blocks.
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail(f"{what}: not observed within {timeout:.0f}s")
            self.page.wait_for_timeout(10)

    def settle(self):
        # After a response body has loaded, let the page run the tasks that consume it. The guard-less controls paint a
        # late answer after exactly this wait, so it is long enough.
        self.page.evaluate("() => new Promise(resolve => setTimeout(resolve, 150))")

    def release(self, route, payload, status=200):
        request = route.request
        route.fulfill(status=status, json=payload)
        self.wait_until(lambda: any(entry is request for entry in self.finished), "the released answer reaching the page")
        self.settle()

    def origin_ok(self, route, url):
        if f"{url.scheme}://{url.netloc}" != ORIGIN:
            self.unexpected.append(f"{route.request.method} {route.request.url}")
            route.abort()
            return False
        if url.path.startswith("/api/") and route.request.headers.get("x-kin-csrf") != "1":
            self.unexpected.append(f"{route.request.method} {url.path} without X-KIN-CSRF")
            route.abort()
            return False
        return True

    def answer_read(self, route, target, reply):
        self.reads.append(target)
        if self.held_reads is not None:
            self.held_reads.append((target, route))
            return
        if self.read_errors:
            status, body = self.read_errors.pop(0)
            route.fulfill(status=status, json=body)
            return
        route.fulfill(json=reply())

    def answer_write(self, route, path, apply):
        body = route.request.post_data_json
        self.writes.append((path, body))
        if self.held_writes is not None:
            self.held_writes.append((route, apply, body))
            return
        if self.write_errors:
            status, reply = self.write_errors.pop(0)
            route.fulfill(status=status, json=reply)
            return
        status, reply = apply(body)
        if self.mangles and status == 201:
            reply = self.mangles.pop(0)(copy.deepcopy(reply))
        if self.lose_replies:
            # Applied and committed, but the reply never arrives (a network failure after the commit).
            self.lose_replies -= 1
            route.abort()
            return
        route.fulfill(status=status, json=reply)

    def wording(self, selector, labels):
        texts = self.page.evaluate(TEXTS_IN, selector)
        self.assertGreater(len(texts), 5)
        for entry in texts:
            with self.subTest(text=entry["text"][:60], tag=entry["tag"]):
                self.assertIsNone(AVOIDED.search(entry["text"]))
                self.assertIsNone(ACKNOWLEDGED.search(entry["text"]))
                self.assertIsNone(TRANSFER.search(entry["text"]))
                if entry["size"] is not None:
                    self.assertGreaterEqual(entry["size"], 12)
        found = self.page.evaluate(LABELS_IN, selector)
        for kind in ("buttons", "headings", "labels", "options", "status"):
            for text in found[kind]:
                self.assertFalse(has_hangul(text), f"{kind}: {text}")
        for expected in labels:
            self.assertIn(expected, [text for group in found.values() for text in group])
        for name, width, height in self.page.evaluate(TARGETS_IN, selector):
            self.assertGreaterEqual(min(width, height), 24, name)
        return texts

    def tab_until(self, target, limit=16):
        for _ in range(limit):
            self.page.keyboard.press("Tab")
            if self.page.evaluate(ACTIVE_ELEMENT)["id"] == target:
                return
        self.fail(f"{target} not reached by Tab")

    def tab_walk(self, count):
        seen = []
        for _ in range(count):
            self.page.keyboard.press("Tab")
            active = self.page.evaluate(ACTIVE_ELEMENT)
            seen.append(active["id"] or f"{active['tag']}:{active['text']}")
        return seen


class ClinicianRequestDOMTest(Harness):
    def setUp(self):
        super().setUp()
        self.me = {"sub": CLIN_SUB, "actor": "syn-clinician", "roles": ["clinician"], "institution": INSTITUTION,
                   "kind": "member", "user": "syn-clinician", "displayName": "SYN Clinician"}
        self.rows = [self.study_row(1, "SYN ALPHA"), self.study_row(2, "SYN BETA"), self.study_row(3, "SYN TELE", tele=True)]
        self.server = RequestServer([INSTITUTION, CLIN_SUB], "syn-clinician", "SYN Clinician", staff=False)
        self.files = dict(SHIPPED)
        self.navigations = []

    @staticmethod
    def study_row(n, name, tele=False):
        return {"uid": uid(n), "id": f"SYN-P-00{n}", "name": name, "birth": "19800101", "sex": "M", "date": f"2026032{n}",
                "acc": f"SYN-ACC-{n}", "desc": f"SYN DESC {n}", "modality": "CT", "count": 10, "series": 1,
                "sourcePatientKey": f"{INSTITUTION}|SYN-P-00{n}", "institutionName": "SYN Hospital A", "tele": tele,
                "report": {"final": False, "rs": "W"}}

    def route(self, route):
        request = route.request
        url = urlparse(request.url)
        method, path = request.method, url.path
        if not self.origin_ok(route, url):
            return
        if method == "GET" and path.startswith(BASE):
            name = path[len(BASE):]
            if name == "index.html":
                # 204 keeps the leaving document readable (a held navigation would stall evaluate()).
                self.navigations.append(name)
                route.fulfill(status=204, body="")
                return
            if name in self.files:
                kind = "text/html" if name.endswith(".html") else "application/javascript"
                route.fulfill(body=self.files[name], content_type=f"{kind}; charset=utf-8")
                return
        if method == "GET" and (path.startswith("/kin-brand/") or path == "/favicon.ico"):
            route.fulfill(status=404, body="")
            return
        if method == "GET" and path == "/api/me":
            route.fulfill(json=self.me)
            return
        if method == "GET" and path == "/api/clinician/studies":
            rows = sorted(self.rows, key=lambda row: row["uid"])
            route.fulfill(json={"studies": copy.deepcopy(rows), "serverTime": "2026-09-27T00:00:00.000Z",
                                "pagination": {"next": None, "total": len(rows), "offset": 0, "limit": 100}})
            return
        found = re.fullmatch(r"/api/clinician/studies/([^/]+)/report", path)
        if method == "GET" and found:
            route.fulfill(json={"uid": unquote(found.group(1)), "report": {"final": False, "rs": "W"}, "keys": None})
            return
        found = re.fullmatch(r"/api/studies/([^/]+)/image-requests", path)
        if found and not url.query:
            target = unquote(found.group(1))
            if method == "GET":
                self.answer_read(route, target, lambda: self.server.study(target))
                return
            if method == "POST":
                self.answer_write(route, path, lambda body: self.server.create(target, body))
                return
        found = re.fullmatch(r"/api/image-requests/([^/]+)", path)
        if found and method == "POST" and not url.query:
            target = unquote(found.group(1))
            self.answer_write(route, path, lambda body: self.server.change(target, body))
            return
        if method == "POST" and path == "/api/auth/logout":
            route.fulfill(status=204, body="")
            return
        self.unexpected.append(f"{method} {request.url}")
        route.abort()

    # ── page helpers ──
    def open_home(self, script=None):
        self.files["clinician.js"] = SHIPPED["clinician.js"] if script is None else script
        self.page.goto(ORIGIN + BASE + "clinician.html")
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "ready")

    def pick(self, n):
        self.page.locator(f'#studies tr[data-uid="{uid(n)}"]').click()
        expect(self.page.locator("#report-state")).to_have_attribute("data-state", "status")

    def view(self):
        return self.page.evaluate(CLINICIAN_VIEW)

    def list_state(self, state):
        expect(self.page.locator("#image-requests-state")).to_have_attribute("data-state", state)

    def open_requests(self, state="ready"):
        self.page.locator("#image-requests-summary").click()
        self.list_state(state)

    def fill(self, kind, counterparty, reason):
        self.page.locator("#image-request-kind-new").select_option(kind)
        self.page.locator("#image-request-counterparty-new").fill(counterparty)
        self.page.locator("#image-request-reason-new").fill(reason)

    def item_locator(self, n):
        return self.page.locator(f'#image-request-list > li[data-id="{rid(n)}"]')

    def note_state(self, locator, state):
        expect(locator.locator("[data-request-note]")).to_have_attribute("data-state", state)

    def test_c01_closed_until_opened_states_and_read_failures(self):
        a, b = uid(1), uid(2)
        self.server.add(item(1, a, "Requested", counterparty=HOSTILE, reason="SYN reason 1\nline 2", at=5))
        self.server.add(item(2, a, "Accepted", kind="image-transfer", revision=2, handler=STAFF, at=4))
        self.server.add(item(3, a, "Closed", revision=3, handler=STAFF, note="SYN handled", at=3))
        self.server.add(item(4, a, "Declined", kind="image-transfer", revision=2, handler=STAFF, note="SYN declined", at=2))
        self.server.add(item(5, a, "Cancelled", revision=2, note="SYN cancelled", at=1))
        self.open_home()
        self.pick(1)
        seen = self.view()
        self.assertEqual((a, False, "closed", False, [], []),
                         (seen["uid"], seen["open"], seen["state"], seen["body"], seen["buttons"], seen["headings"]))
        self.assertEqual("Image Requests", self.page.locator("#image-requests-summary").text_content())
        self.assertEqual([], self.reads, "nothing is read before Image Requests is opened")

        self.open_requests()
        self.assertEqual([a], self.reads)
        seen = self.view()
        self.assertEqual(["ready", C_READY.format(n=5), "", False, "status"], seen["list"])
        self.assertEqual([rid(n) for n in range(1, 6)], [entry["id"] for entry in seen["items"]])
        self.assertEqual(STATES, [entry["status"] for entry in seen["items"]])
        self.assertEqual([None, None, CLOSED_NOTE, None, None], [entry["closed"] for entry in seen["items"]])
        self.assertEqual([True, True, False, False, False], [entry["cancel"] is not None for entry in seen["items"]])
        self.assertEqual(["Requested External Images · 2026-09-26 15:00", f"Counterparty {HOSTILE}",
                          "Reason SYN reason 1\nline 2"], seen["items"][0]["lines"])
        self.assertEqual(["Accepted Send Images · 2026-09-26 14:00", "Counterparty SYN Hospital 2", "Reason SYN reason 2",
                          "Handler SYN Staff"], seen["items"][1]["lines"])
        self.assertEqual([f"Closed {CLOSED_NOTE} External Images · 2026-09-26 13:00", "Counterparty SYN Hospital 3",
                          "Reason SYN reason 3", "Handler SYN Staff", "Handling Note SYN handled"], seen["items"][2]["lines"])
        self.assertEqual(["Handler SYN Staff", "Decline Reason SYN declined"], seen["items"][3]["lines"][3:])
        self.assertEqual(["Cancel Reason SYN cancelled"], seen["items"][4]["lines"][3:])
        self.assertIsNone(seen["pwned"])
        self.assertEqual((False, "idle", "external-image", "", "", True), (seen["form"]["hidden"], seen["form"]["state"],
                         seen["form"]["kind"], seen["form"]["counterparty"], seen["form"]["reason"], seen["form"]["send"]))
        self.assertEqual(["New Request"], seen["headings"])

        # Another study opens straight away (Image Requests stays open in this document) and reads its own list.
        self.pick(2)
        self.list_state("empty")
        seen = self.view()
        self.assertEqual((b, True, [a, b]), (seen["uid"], seen["open"], self.reads))
        self.assertEqual(["empty", C_EMPTY, "", False, "status"], seen["list"])
        self.assertEqual(([], False), (seen["items"], seen["form"]["hidden"]))

        # A study received for remote reading: nothing is read and nothing can be written.
        self.pick(3)
        self.list_state("tele")
        seen = self.view()
        self.assertEqual(("tele", C_TELE, None, [a, b]), (seen["state"], seen["list"][1], seen["form"], self.reads))
        self.assertEqual(["Retry"], seen["buttons"])

        # 404 and a codeless 503 are failures with their wording and Retry; the form waits for a list.
        self.read_errors = [(404, err("STUDY_NOT_FOUND", "검사를 찾을 수 없습니다")),
                            (503, {"statusCode": 503, "message": "SYN 원본 서버 응답 없음"})]
        self.pick(1)
        self.list_state("failed")
        seen = self.view()
        self.assertEqual(["failed", C_FAILED, f"{C_NOT_FOUND}\n검사를 찾을 수 없습니다 (HTTP 404 · STUDY_NOT_FOUND)", True, "status"],
                         seen["list"])
        self.assertEqual((True, True), (seen["listHidden"], seen["form"]["hidden"]))
        self.page.locator("#image-requests-retry").click()
        self.wait_until(lambda: len(self.reads) == 4, "the Retry read")
        self.list_state("failed")
        self.assertEqual(["failed", C_FAILED, "SYN 원본 서버 응답 없음 (HTTP 503)", True, "status"], self.view()["list"])
        self.page.locator("#image-requests-retry").click()
        self.list_state("ready")
        seen = self.view()
        self.assertEqual((5, False, False), (len(seen["items"]), seen["listHidden"], seen["form"]["hidden"]))

    def test_c02_create_envelope_lost_reply_retry_discard_and_refusal(self):
        a = uid(1)
        self.open_home()
        self.pick(1)
        self.open_requests("empty")
        form = self.page.locator("#image-request-new")
        send = form.locator("[data-send]")

        send.click()
        self.assertEqual(["failed", C_NO_TEXT, ""], self.view()["form"]["note"])
        self.page.locator("#image-request-counterparty-new").fill("   ")
        self.page.locator("#image-request-reason-new").fill("SYN reason")
        send.click()
        self.assertEqual([], self.writes, "blank or whitespace fields are not sent")

        self.fill("image-transfer", "SYN Hospital B", "SYN reason for sending")
        send.click()
        self.wait_until(lambda: len(self.reads) == 2, "the list read again after the write")
        self.list_state("ready")
        path, body = self.writes[0]
        self.assertEqual(f"/api/studies/{a}/image-requests", path)
        self.assertEqual({"requestId", "expectedOwner", "kind", "counterparty", "counterpartyInstitutionId", "reason"}, set(body))
        self.assertRegex(body["requestId"], V4)
        self.assertEqual([INSTITUTION, CLIN_SUB], body["expectedOwner"])
        self.assertEqual(("image-transfer", "SYN Hospital B", None, "SYN reason for sending"),
                         (body["kind"], body["counterparty"], body["counterpartyInstitutionId"], body["reason"]))
        seen = self.view()
        self.assertEqual(["saved", C_CREATED, ""], seen["form"]["note"])
        self.assertEqual(("external-image", "", "", True, False, False), (seen["form"]["kind"], seen["form"]["counterparty"],
                         seen["form"]["reason"], seen["form"]["send"], seen["form"]["retry"], seen["form"]["discard"]))
        self.assertEqual([(body["requestId"], "Requested")], [(entry["id"], entry["status"]) for entry in seen["items"]])

        # The write is applied but its reply is lost: the result is unknown, the fields stay as sent, and Retry sends the
        # same requestId and body; the stand-in answers with the stored result, so one request exists.
        self.lose_replies = 1
        self.fill("external-image", "SYN Hospital C", "SYN reason C")
        send.click()
        self.note_state(form, "unknown")
        seen = self.view()["form"]
        self.assertEqual((["unknown", UNKNOWN, NO_SERVER], True, True, False, True, True),
                         (seen["note"], seen["readOnly"], seen["kindDisabled"], seen["send"], seen["retry"], seen["discard"]))
        form.locator("[data-retry]").click()
        self.note_state(form, "saved")
        self.assertEqual(["saved", REPLAYED, ""], self.view()["form"]["note"])
        self.assertEqual(3, len(self.writes))
        self.assertEqual(self.writes[1], self.writes[2], "Retry sends the same requestId and body")
        self.assertNotEqual(self.writes[0][1]["requestId"], self.writes[1][1]["requestId"], "a new write has a new requestId")
        self.assertEqual(2, len(self.server.items))
        self.wait_until(lambda: len(self.reads) == 3, "the list read again after the replayed write")
        self.list_state("ready")
        self.assertEqual(2, len(self.view()["items"]))

        # IMAGE_REQUEST_BUSY is unknown too; Discard drops the request, keeps the text editable and reads the list again.
        self.write_errors = [(503, err("IMAGE_REQUEST_BUSY", "영상 요청 처리 중입니다. 같은 요청으로 다시 시도하세요"))]
        self.fill("external-image", "SYN Hospital D", "SYN reason D")
        send.click()
        self.note_state(form, "unknown")
        self.assertEqual(["unknown", C_CODES["IMAGE_REQUEST_BUSY"],
                          "영상 요청 처리 중입니다. 같은 요청으로 다시 시도하세요 (HTTP 503 · IMAGE_REQUEST_BUSY)"], self.view()["form"]["note"])
        form.locator("[data-discard]").click()
        self.note_state(form, "discarded")
        self.wait_until(lambda: len(self.reads) == 4, "the list read again after Discard")
        seen = self.view()["form"]
        self.assertEqual((["discarded", C_DISCARDED, ""], False, "SYN Hospital D", "SYN reason D", True, False),
                         (seen["note"], seen["readOnly"], seen["counterparty"], seen["reason"], seen["send"], seen["retry"]))

        # A refusal says why with the server's code and keeps the text; 409 reads the list again.
        send.click()
        self.note_state(form, "failed")
        seen = self.view()["form"]
        self.assertEqual(["failed", C_CODES["IMAGE_REQUEST_ACTIVE_EXISTS"],
                          "같은 검사·종류로 처리 중인 요청이 이미 있습니다 (HTTP 409 · IMAGE_REQUEST_ACTIVE_EXISTS)"], seen["note"])
        self.assertEqual(("SYN Hospital D", False, True), (seen["counterparty"], seen["readOnly"], seen["send"]))
        self.wait_until(lambda: len(self.reads) == 5, "the list read again after a 409")
        self.assertEqual(2, len(self.server.items))

    def test_c03_cancel_revision_and_each_refusal_by_code(self):
        a = uid(1)
        self.server.add(item(1, a, "Requested", at=3))
        self.server.add(item(2, a, "Accepted", kind="image-transfer", revision=2, handler=STAFF, at=2))
        self.open_home()
        self.pick(1)
        self.open_requests("ready")
        first, second = self.item_locator(1), self.item_locator(2)

        first.locator("[data-send]").click()
        self.assertEqual(["failed", C_NO_CANCEL, ""], self.view()["items"][0]["note"])
        self.assertEqual([], self.writes)
        first.locator('[data-field="note"]').fill("SYN no longer needed")
        first.locator("[data-send]").click()
        self.note_state(first, "saved")
        path, body = self.writes[0]
        self.assertEqual(f"/api/image-requests/{rid(1)}", path)
        self.assertEqual({"requestId", "expectedOwner", "revision", "action", "note"}, set(body))
        self.assertRegex(body["requestId"], V4)
        self.assertEqual(([INSTITUTION, CLIN_SUB], 1, "cancel", "SYN no longer needed"),
                         (body["expectedOwner"], body["revision"], body["action"], body["note"]))
        self.wait_until(lambda: len(self.reads) == 2, "the list read again after the cancel")
        expect(first).to_have_attribute("data-state", "Cancelled")
        seen = self.view()["items"][0]
        self.assertEqual(("Cancelled", None, ["saved", C_CANCELLED, ""]), (seen["status"], seen["cancel"], seen["note"]))
        self.assertEqual("Cancel Reason SYN no longer needed", seen["lines"][-1])

        cases = [
            (409, err("IMAGE_REQUEST_CHANGED", "영상 요청이 변경되었습니다. 다시 불러온 뒤 확인하세요"), "failed", C_CODES["IMAGE_REQUEST_CHANGED"], True),
            (409, err("IMAGE_REQUEST_STATE", "지금 상태에서 할 수 없는 영상 요청 동작입니다"), "failed", C_CODES["IMAGE_REQUEST_STATE"], True),
            (404, err("IMAGE_REQUEST_NOT_FOUND", "영상 요청을 찾을 수 없습니다"), "failed", C_NOT_FOUND, True),
            (403, err("IMAGE_REQUEST_ACTION_FORBIDDEN", "이 영상 요청에 이 동작을 할 수 없습니다"), "failed",
             C_CODES["IMAGE_REQUEST_ACTION_FORBIDDEN"], False),
            (503, err("IMAGE_REQUEST_BUSY", "영상 요청 처리 중입니다. 같은 요청으로 다시 시도하세요"), "unknown", C_CODES["IMAGE_REQUEST_BUSY"], False),
            (409, err("STUDY_ACCESS_CHANGED", "검사 접근 조건이 바뀌었습니다"), "unknown", C_CODES["STUDY_ACCESS_CHANGED"], False),
        ]
        second.locator('[data-field="note"]').fill("SYN changed plans")
        for status, reply, state, text, reread in cases:
            with self.subTest(code=reply["code"]):
                reads, writes = len(self.reads), len(self.writes)
                self.write_errors = [(status, reply)]
                second.locator("[data-send]").click()
                self.note_state(second, state)
                seen = self.view()["items"][1]
                self.assertEqual([state, text, f"{reply['message']} (HTTP {status} · {reply['code']})"], seen["note"])
                self.assertEqual(writes + 1, len(self.writes))
                if reread:
                    self.wait_until(lambda: len(self.reads) == reads + 1, "the list read again after the refusal")
                else:
                    self.settle()
                    self.assertEqual(reads, len(self.reads))
                cancel = self.view()["items"][1]["cancel"]
                if state == "unknown":
                    self.assertEqual(("unknown", True, False, True, True),
                                     (cancel["state"], cancel["readOnly"], cancel["send"], cancel["retry"], cancel["discard"]))
                else:
                    self.assertEqual(("idle", "SYN changed plans", False, True),
                                     (cancel["state"], cancel["value"], cancel["readOnly"], cancel["send"]))
                if reply["code"] == "IMAGE_REQUEST_BUSY":
                    second.locator("[data-discard]").click()
                    self.note_state(second, "discarded")
                    self.wait_until(lambda: len(self.reads) == reads + 1, "the list read again after Discard")
                    self.list_state("ready")
        # The last unknown one: Retry sends the same requestId and body, and this time the server applies it.
        second.locator("[data-retry]").click()
        self.note_state(second, "saved")
        self.assertEqual(self.writes[-2], self.writes[-1])
        self.assertEqual(["saved", C_CANCELLED, ""], self.view()["items"][1]["note"])
        expect(second).to_have_attribute("data-state", "Cancelled")
        self.assertEqual((3, "Cancelled"), (self.server.items[rid(2)]["revision"], self.server.items[rid(2)]["state"]))

    def test_c04_a_b_a_late_list_answers_never_paint(self):
        a, b = uid(1), uid(2)
        owner = [INSTITUTION, CLIN_SUB]
        for label, script in (("shipped", None), ("no-guard", CLINICIAN_NO_GUARD)):
            with self.subTest(label):
                self.reads.clear()
                self.held_reads = []
                self.open_home(script)
                self.pick(1)
                self.page.locator("#image-requests-summary").click()
                self.wait_until(lambda: len(self.held_reads) == 1, "A's first read")
                self.pick(2)
                self.wait_until(lambda: len(self.held_reads) == 2, "B's read")
                self.pick(1)
                self.wait_until(lambda: len(self.held_reads) == 3, "A's second read")
                self.assertEqual([a, b, a], [target for target, _ in self.held_reads])
                self.release(self.held_reads[0][1], {"owner": owner, "items": [item(7, a, "Requested", reason="SYN-LATE-A")]})
                after_first = self.view()
                self.release(self.held_reads[1][1], {"owner": owner, "items": [item(8, b, "Requested", reason="SYN-LATE-B")]})
                after_second = self.view()
                self.release(self.held_reads[2][1], {"owner": owner, "items": [item(9, a, "Accepted", revision=2, handler=STAFF,
                                                                                     reason="SYN-FRESH-A")]})
                self.held_reads = None
                if label == "shipped":
                    for seen in (after_first, after_second):
                        self.assertEqual((a, "loading", []), (seen["uid"], seen["list"][0], seen["items"]))
                    self.list_state("ready")
                    self.assertEqual([rid(9)], [entry["id"] for entry in self.view()["items"]])
                else:
                    self.assertEqual([rid(7)], [entry["id"] for entry in after_first["items"]],
                                     "the guard-less control paints A's late answer, so the harness sees late answers")
                    self.assertEqual([rid(8)], [entry["id"] for entry in after_second["items"]])

    def test_c05_lock_on_other_account_or_refusal_and_nothing_after_session_end(self):
        a = uid(1)
        self.server.add(item(1, a, "Requested", at=1))
        self.read_errors = [(200, {"owner": [INSTITUTION, "SYN-OTHER-SUB"], "items": []})]
        self.open_home()
        self.pick(1)
        self.open_requests("failed")
        seen = self.view()
        self.assertEqual(("locked", ["failed", OWNER_CHANGED, "", False, "alert"], None), (seen["state"], seen["list"], seen["form"]))
        # The lock holds for the document: another study shows it at once and reads nothing.
        self.pick(2)
        self.list_state("failed")
        self.assertEqual(("locked", OWNER_CHANGED, [a]), (self.view()["state"], self.view()["list"][1], self.reads))

        self.read_errors = [(403, err("IMAGE_REQUEST_ROLE_REQUIRED", "이 영상 요청 동작에 필요한 역할이 없습니다"))]
        self.open_home()
        self.pick(1)
        self.open_requests("failed")
        self.assertEqual(("locked", ["failed", C_REFUSED, "이 영상 요청 동작에 필요한 역할이 없습니다 (HTTP 403 · IMAGE_REQUEST_ROLE_REQUIRED)",
                                     False, "alert"]), (self.view()["state"], self.view()["list"]))

        # OWNER_CHANGED on a write locks the area and drops what was typed.
        self.open_home()
        self.pick(1)
        self.open_requests("ready")
        self.fill("image-transfer", "SYN-DRAFT", "SYN draft")
        self.write_errors = [(409, err("OWNER_CHANGED", "로그인한 계정이 바뀌었습니다. 화면을 다시 불러오세요"))]
        self.item_locator(1).locator('[data-field="note"]').fill("SYN reason")
        self.item_locator(1).locator("[data-send]").click()
        self.list_state("failed")
        seen = self.view()
        self.assertEqual(("locked", OWNER_CHANGED, "로그인한 계정이 바뀌었습니다. 화면을 다시 불러오세요 (HTTP 409 · OWNER_CHANGED)", None, []),
                         (seen["state"], seen["list"][1], seen["list"][2], seen["form"], seen["items"]))
        self.page.locator("#image-requests-summary").click()
        self.page.locator("#image-requests-summary").click()
        self.list_state("failed")
        self.assertIsNone(self.view()["form"])

        # Another tab ends the session while a write and a read are held: the page closes and draws neither answer.
        self.open_home()
        self.pick(1)
        self.open_requests("ready")
        self.fill("image-transfer", "SYN Hospital E", "SYN reason E")
        self.held_writes = []
        self.page.locator("#image-request-new [data-send]").click()
        self.wait_until(lambda: len(self.held_writes) == 1, "the held write")
        self.held_reads = []
        self.page.locator("#image-requests-summary").click()
        self.page.locator("#image-requests-summary").click()
        self.wait_until(lambda: len(self.held_reads) == 1, "the held read")
        self.page.evaluate(BROADCAST_ENDED)
        self.wait_until(lambda: self.navigations, "the navigation to index.html")
        route, apply, body = self.held_writes[0]
        status, reply = apply(body)
        self.release(route, reply, status)
        self.release(self.held_reads[0][1], self.server.study(a))
        self.assertEqual({"children": ["P@status"], "text": CLOSING}, self.page.evaluate(CLOSED_VIEW))
        self.assertEqual(["index.html"], self.navigations)

    def test_c06_drafts_per_study_keyboard_and_wording(self):
        a = uid(1)
        self.server.add(item(1, a, "Requested", at=3))
        self.server.add(item(2, a, "Closed", revision=3, handler=STAFF, note="SYN handled", at=2))
        self.open_home()
        self.pick(1)
        self.open_requests("ready")
        self.fill("image-transfer", "SYN-DRAFT-A", "SYN draft reason A")
        self.item_locator(1).locator('[data-field="note"]').fill("SYN-CANCEL-DRAFT-A")
        self.pick(2)
        self.list_state("empty")
        seen = self.view()["form"]
        self.assertEqual(("external-image", "", ""), (seen["kind"], seen["counterparty"], seen["reason"]))
        self.fill("external-image", "SYN-DRAFT-B", "SYN draft reason B")
        self.pick(1)
        self.list_state("ready")
        seen = self.view()
        self.assertEqual(("image-transfer", "SYN-DRAFT-A", "SYN draft reason A"),
                         (seen["form"]["kind"], seen["form"]["counterparty"], seen["form"]["reason"]))
        self.assertEqual("SYN-CANCEL-DRAFT-A", seen["items"][0]["cancel"]["value"])
        self.pick(2)
        self.list_state("empty")
        self.assertEqual(("SYN-DRAFT-B", "SYN draft reason B"), (self.view()["form"]["counterparty"], self.view()["form"]["reason"]))
        self.assertEqual([], self.writes)

        # Keyboard: from Open Viewer, Tab reaches the summary; Enter closes and opens it; Tab walks the list and the form.
        self.pick(1)
        self.list_state("ready")
        self.page.locator("#open-viewer").focus()
        self.tab_until("image-requests-summary")
        reads = len(self.reads)
        self.page.keyboard.press("Enter")
        expect(self.page.locator("#image-requests")).to_have_attribute("data-state", "closed")
        self.page.keyboard.press("Enter")
        self.wait_until(lambda: len(self.reads) == reads + 1, "the read after opening with Enter")
        self.list_state("ready")
        self.assertEqual([f"image-request-note-{rid(1)}", "BUTTON:Cancel", "image-request-kind-new", "image-request-counterparty-new",
                          "image-request-reason-new", "BUTTON:Request"], self.tab_walk(6))
        # Enter on Request sends A's kept draft.
        self.page.keyboard.press("Enter")
        self.note_state(self.page.locator("#image-request-new"), "saved")
        self.assertEqual(("image-transfer", "SYN-DRAFT-A", "SYN draft reason A"),
                         tuple(self.writes[0][1][key] for key in ("kind", "counterparty", "reason")))

        self.write_errors = [(409, err("IMAGE_REQUEST_STATE", "지금 상태에서 할 수 없는 영상 요청 동작입니다"))]
        self.item_locator(1).locator('[data-field="note"]').fill("SYN reason")
        self.item_locator(1).locator("[data-send]").click()
        self.note_state(self.item_locator(1), "failed")
        texts = self.wording("#image-requests", ["Image Requests", "New Request", "Kind", "Counterparty", "Reason", "Request",
                                                 "Cancel Reason", "Cancel", "External Images", "Send Images", "Requested", "Closed"])
        # Explanations, tooltips and results stay Korean.
        self.assertTrue(has_hangul(self.page.locator("#image-requests-summary").get_attribute("title")))
        for locator in (self.page.locator("#image-requests-body > .muted"), self.page.locator("#image-request-new-hint"),
                        self.item_locator(1).locator("[data-request-note] .state-text"),
                        self.item_locator(2).locator("[data-closed-note]")):
            self.assertTrue(has_hangul(locator.text_content()))
        self.assertIn(CLOSED_NOTE, [entry["text"] for entry in texts])

    def test_c07_a_receipt_that_is_not_the_sent_write_stays_unknown(self):
        a = uid(1)
        self.server.add(item(1, a, "Requested", at=3))
        form = self.page.locator("#image-request-new")
        # Control: the fix1 check took a receipt of another state and revision as saved.
        self.open_home(CLINICIAN_FIX1_RECEIPT)
        self.pick(1)
        self.open_requests("ready")
        self.mangles = [bad_receipt({"to": "Accepted", "revision": 2})]
        self.fill("image-transfer", "SYN Hospital F", "SYN reason F")
        form.locator("[data-send]").click()
        self.note_state(form, "saved")
        self.assertEqual(["saved", C_CREATED, ""], self.view()["form"]["note"], "the fix1 check accepts the wrong receipt")

        self.server.items = {rid(1): self.server.items[rid(1)]}
        self.server.receipts.clear()
        self.writes.clear()
        self.open_home()
        self.pick(1)
        self.open_requests("ready")
        create = [
            {"to": "Accepted", "revision": 2}, {"from": "Requested"}, {"from": DROP}, {"kind": DROP},
            {"kind": "external-image"}, {"at": DROP}, {"at": "2026-09-27T10:00:01+09:00"}, {"at": "SYN-NOT-A-DATE"},
            {"revision": DROP}, {"to": DROP}, {"kind": DROP, "from": DROP, "at": DROP},
        ]
        self.mangles = [bad_receipt(changes) for changes in create]
        self.fill("image-transfer", "SYN Hospital G", "SYN reason G")
        form.locator("[data-send]").click()
        for index, changes in enumerate(create):
            with self.subTest(create=repr(changes)):
                if index:
                    form.locator("[data-retry]").click()
                self.wait_until(lambda: len(self.writes) == index + 1, "the write")
                self.note_state(form, "unknown")
                seen = self.view()["form"]
                self.assertEqual((["unknown", WRITE_MALFORMED, ""], "image-transfer", "SYN Hospital G", "SYN reason G", True, False,
                                  True, True), (seen["note"], seen["kind"], seen["counterparty"], seen["reason"], seen["readOnly"],
                                                seen["send"], seen["retry"], seen["discard"]))
                self.assertEqual(self.writes[0], self.writes[-1], "Retry sends the same requestId and body")
        # The request has moved on at the server; the stored receipt of the create is still the create's, and is accepted.
        created = self.writes[0][1]["requestId"]
        self.server.items[created].update(state="Accepted", revision=2, handler=STAFF)
        form.locator("[data-retry]").click()
        self.note_state(form, "saved")
        self.assertEqual(["saved", REPLAYED, ""], self.view()["form"]["note"])
        self.assertEqual((len(create) + 1, 2), (len(self.writes), len(self.server.items)))

        # Cancel: a receipt of another state or revision (U4p §5.2, §3.4) is not a cancel of this request at this revision.
        cancel = [{"to": "Requested", "revision": 999}, {"from": "Accepted"}, {"revision": 1}, {"kind": DROP}, {"at": DROP}]
        first = self.item_locator(1)
        first.locator('[data-field="note"]').fill("SYN no longer needed")
        self.mangles = [bad_receipt(changes) for changes in cancel]
        writes = len(self.writes)
        first.locator("[data-send]").click()
        for index, changes in enumerate(cancel):
            with self.subTest(cancel=repr(changes)):
                if index:
                    first.locator("[data-retry]").click()
                self.wait_until(lambda: len(self.writes) == writes + index + 1, "the cancel")
                self.note_state(first, "unknown")
                seen = self.view()["items"]
                mine = next(entry for entry in seen if entry["id"] == rid(1))
                self.assertEqual((["unknown", WRITE_MALFORMED, ""], "unknown", "SYN no longer needed", True, True),
                                 (mine["note"], mine["cancel"]["state"], mine["cancel"]["value"], mine["cancel"]["readOnly"],
                                  mine["cancel"]["retry"]))
                self.assertEqual(self.writes[writes], self.writes[-1])
        first.locator("[data-retry]").click()
        self.note_state(first, "saved")
        self.assertEqual("Cancelled", self.server.items[rid(1)]["state"])

    def test_c08_cancel_only_on_my_own_requests_for_a_mixed_role_account(self):
        a = uid(1)
        for roles in (["clinician", "radiologist"], ["clinician", "technician"]):
            with self.subTest(roles=roles):
                self.me = {"sub": "SYN-MIXED-SUB", "actor": "syn-mixed", "roles": roles, "institution": INSTITUTION, "kind": "member",
                           "user": "syn-mixed", "displayName": "SYN Mixed"}
                self.server = RequestServer([INSTITUTION, "SYN-MIXED-SUB"], "syn-mixed", "SYN Mixed", staff=False)
                self.writes.clear()
                # Another clinician's requests, one of them under the same display name: the actor decides, not the name.
                other = item(1, a, "Requested", at=3)
                other["requester"] = {"actor": "syn-clinician", "name": "SYN Mixed"}
                self.server.add(other)
                self.server.add(item(2, a, "Accepted", kind="image-transfer", revision=2, handler=STAFF, at=2))
                own = item(3, a, "Requested", kind="image-transfer", at=1, reason="SYN own reason")
                own["requester"] = {"actor": "syn-mixed", "name": "SYN Mixed"}
                self.server.add(own)
                self.open_home()
                self.pick(1)
                self.open_requests("ready")
                seen = self.view()
                self.assertEqual([rid(1), rid(2), rid(3)], [entry["id"] for entry in seen["items"]])
                self.assertEqual([False, False, True], [entry["cancel"] is not None for entry in seen["items"]])
                self.assertEqual(0, self.item_locator(1).locator("input, button").count())
                self.assertEqual(0, self.item_locator(2).locator("input, button").count())
                self.item_locator(3).locator('[data-field="note"]').fill("SYN mine to cancel")
                self.item_locator(3).locator("[data-send]").click()
                self.note_state(self.item_locator(3), "saved")
                self.assertEqual([(f"/api/image-requests/{rid(3)}", "cancel", 1)],
                                 [(path, body["action"], body["revision"]) for path, body in self.writes])
                self.assertEqual(["Requested", "Accepted", "Cancelled"], [self.server.items[rid(n)]["state"] for n in (1, 2, 3)])


class MainRequestDOMTest(Harness):
    STUDIES = [
        {"uid": uid(11), "name": "SYN ALPHA", "id": "SYN-P-011", "date": "20260320", "desc": "SYN CT CHEST", "tele": False},
        {"uid": uid(12), "name": "SYN BETA", "id": "SYN-P-012", "date": "20260321", "desc": "SYN MR BRAIN", "tele": False},
        {"uid": uid(13), "name": "SYN TELE", "id": "SYN-P-013", "date": "20260322", "desc": "SYN CT ABD", "tele": True},
    ]
    INSTITUTIONS = [{"id": INSTITUTION, "name": "SYN Hospital A"}, {"id": "SYN-INST-B", "name": "SYN Hospital B Registered"}]

    def setUp(self):
        super().setUp()
        self.queue_errors, self.detail_errors = [], []
        self.held_queue = self.held_detail = None
        self.queue_calls, self.detail_calls = [], []
        # POST /auth/logout from the shipped auth.js (m09): held until the test answers it.
        self.logouts = []
        self.html = None
        self.use("technician", "SYN-TECH-SUB")
        a, b = uid(11), uid(12)
        self.server.add(item(21, a, "Requested", at=5))
        self.server.add(item(22, a, "Accepted", kind="image-transfer", revision=2, handler=STAFF, counterparty="SYN Hospital B",
                             institution="SYN-INST-B", at=4))
        self.server.add(item(23, b, "Requested", kind="image-transfer", at=3))
        self.server.add(item(24, uid(19), "Requested", at=2))
        self.server.add(item(25, b, "Accepted", revision=2, handler=STAFF, at=1))
        self.server.add(item(26, a, "Closed", revision=3, handler=STAFF, note="SYN handled", at=0))

    def use(self, role, sub):
        self.use_roles([role], sub, f"syn-{role}", f"SYN {role.capitalize()}")

    def use_roles(self, roles, sub, user, name="SYN Member"):
        # `user` is the token actor (/api/me `user`); None is a session whose actor is not known.
        self.session = {"state": "approved", "sub": sub, "user": user, "displayName": name, "roles": list(roles),
                        "institution": INSTITUTION}
        items = getattr(self, "server", None)
        self.server = RequestServer([INSTITUTION, sub], user, name, staff=True, page=3)
        if items is not None:
            self.server.items = items.items

    def route(self, route):
        request = route.request
        url = urlparse(request.url)
        method, path = request.method, url.path
        if not self.origin_ok(route, url):
            return
        if method == "GET" and path == "/harness/main.html":
            route.fulfill(body=self.html, content_type="text/html; charset=utf-8")
            return
        if method == "GET" and not path.startswith("/api/"):
            route.fulfill(status=404, body="")
            return
        if method == "GET" and path == "/api/me":
            route.fulfill(json={"sub": self.session["sub"], "actor": self.session["user"], "user": self.session["user"],
                                "displayName": self.session["displayName"], "roles": self.session["roles"],
                                "institution": self.session["institution"], "kind": "member"})
            return
        if method == "POST" and path == "/api/auth/logout":
            self.logouts.append(route)
            return
        query = {key: values[0] for key, values in parse_qs(url.query, keep_blank_values=True).items()}
        if method == "GET" and path == "/api/image-requests":
            self.queue_calls.append(url.query)
            if self.held_queue is not None:
                self.held_queue.append(route)
                return
            if self.queue_errors:
                status, body = self.queue_errors.pop(0)
                route.fulfill(status=status, json=body)
                return
            route.fulfill(json=self.server.queue(query))
            return
        found = re.fullmatch(r"/api/image-requests/([^/]+)", path)
        if found and not url.query:
            target = unquote(found.group(1))
            if method == "GET":
                self.detail_calls.append(target)
                if self.held_detail is not None:
                    self.held_detail.append((target, route))
                    return
                if self.detail_errors:
                    status, body = self.detail_errors.pop(0)
                    route.fulfill(status=status, json=body)
                    return
                status, body = self.server.read(target)
                route.fulfill(status=status, json=body)
                return
            if method == "POST":
                self.answer_write(route, path, lambda body: self.server.change(target, body))
                return
        found = re.fullmatch(r"/api/studies/([^/]+)/image-requests", path)
        if found and method == "GET" and not url.query:
            target = unquote(found.group(1))
            self.answer_read(route, target, lambda: self.server.study(target))
            return
        self.unexpected.append(f"{method} {request.url}")
        route.abort()

    # ── page helpers ──
    def open_main(self, block=BLOCK, api_fn=API_FN, real_auth=False):
        head = ("<script>window.synSession = " + json.dumps(self.session) + "; window.synStudies = " + json.dumps(self.STUDIES)
                + "; window.synInstitutions = " + json.dumps(self.INSTITUTIONS) + "; window.synToasts = []; window.synLogouts = 0;</script>")
        if real_auth:
            head += "<script>\n" + SHIPPED["auth.js"] + "\n</script>"
        script = "<script>\n" + (PRELUDE_REAL_AUTH if real_auth else PRELUDE) + api_fn + "\n" + SET_MODE + "\n" + block + "\n</script>"
        at = MAIN_PAGE.rindex("</body>")
        self.html = MAIN_PAGE[:at] + head + script + MAIN_PAGE[at:]
        self.queue_calls.clear()
        self.detail_calls.clear()
        self.reads.clear()
        self.writes.clear()
        self.page.goto(ORIGIN + "/harness/main.html")
        expect(self.page.locator("#image-request-queue-status")).to_have_count(1)

    def mode(self, name):
        self.page.evaluate("m => window.synSetMode(m)", name)

    def pick(self, n):
        self.page.evaluate("uid => window.synPick(uid)", uid(n))

    def queue(self):
        return self.page.evaluate(QUEUE_VIEW)

    def reading(self):
        return self.page.evaluate(READ_VIEW)

    def queue_state(self, state):
        expect(self.page.locator("#image-request-queue-status")).to_have_attribute("data-state", state)

    def open_queue(self, state="ready"):
        """Technician mode, open the queue and wait for its first read; state None waits for nothing more (held or locked)."""
        self.mode("Technician")
        calls = len(self.queue_calls)
        self.page.locator("#image-request-queue-summary").click()
        self.wait_until(lambda: len(self.queue_calls) > calls, "the queue read")
        if state is not None:
            self.queue_state(state)

    def open_item(self, n, state):
        calls = len(self.detail_calls)
        self.page.locator(f'#image-request-queue-list > li[data-id="{rid(n)}"] [data-open]').click()
        self.wait_until(lambda: len(self.detail_calls) > calls, "the request read")
        if self.held_detail is None:
            expect(self.page.locator("#image-request-detail")).to_have_attribute("data-state", state)

    def act(self, action):
        self.page.locator(f'#image-request-detail button[data-action="{action}"]').click()

    def result(self, state):
        expect(self.page.locator('#image-request-detail [data-part="write"]')).to_have_attribute("data-state", state)

    def test_m01_queue_follows_technician_mode_reads_when_opened_pages_and_filters(self):
        self.open_main()
        seen = self.queue()
        self.assertEqual((False, False), (seen["shown"], seen["open"]))
        self.mode("Technician")
        self.assertEqual((True, False), (self.queue()["shown"], self.queue()["open"]))
        self.assertEqual([], self.queue_calls, "nothing is read before Image Requests is opened")
        self.page.locator("#image-request-queue-summary").click()
        self.wait_until(lambda: self.queue_calls, "the queue read")
        self.queue_state("ready")
        seen = self.queue()
        self.assertEqual(["view=queue&state=active"], self.queue_calls)
        self.assertEqual([rid(21), rid(22), rid(23)], [entry["id"] for entry in seen["items"]])
        self.assertEqual(["ready", M_QUEUE_READY.format(n=3, more=M_MORE), "", True], seen["status"])
        self.assertEqual((True, False, ["active", ""]), (seen["more"], seen["retry"], seen["filters"]))
        self.assertEqual(["Requested External Images · 2026-09-26 15:00 요청 · SYN Clinician",
                          "Study SYN ALPHA · SYN-P-011 · 20260320 · SYN CT CHEST", "Counterparty SYN Hospital 21",
                          "Reason SYN reason 21"], seen["items"][0]["lines"])
        self.assertEqual("Counterparty SYN Hospital B (등록 기관: SYN Hospital B Registered)", seen["items"][1]["lines"][2])
        self.assertEqual("Handler SYN Staff", seen["items"][1]["lines"][4])

        self.page.locator("#image-request-queue-more").click()
        self.wait_until(lambda: len(self.queue_calls) == 2, "the next page")
        expect(self.page.locator("#image-request-queue-list > li")).to_have_count(5)
        seen = self.queue()
        self.assertEqual("view=queue&state=active&cursor=SYN-CURSOR_3", self.queue_calls[1])
        self.assertEqual([rid(n) for n in range(21, 26)], [entry["id"] for entry in seen["items"]])
        self.assertEqual((False, ["ready", M_QUEUE_READY.format(n=5, more=""), "", True]), (seen["more"], seen["status"]))
        self.assertEqual(f"Study 워크리스트에 없는 검사 · {uid(19)}", seen["items"][3]["lines"][1])

        self.page.locator("#image-request-queue-state").select_option("closed")
        self.wait_until(lambda: len(self.queue_calls) == 3, "the closed filter")
        expect(self.page.locator("#image-request-queue-list > li")).to_have_count(1)
        seen = self.queue()
        self.assertEqual("view=queue&state=closed", self.queue_calls[2])
        self.assertEqual([(rid(26), "Closed", CLOSED_NOTE)], [(e["id"], e["state"], e["closed"]) for e in seen["items"]])
        self.assertEqual(f"Closed {CLOSED_NOTE} External Images · 2026-09-26 10:00 요청 · SYN Clinician", seen["items"][0]["lines"][0])
        self.page.locator("#image-request-queue-kind").select_option("image-transfer")
        self.wait_until(lambda: len(self.queue_calls) == 4, "the kind filter")
        self.queue_state("empty")
        self.assertEqual("view=queue&state=closed&kind=image-transfer", self.queue_calls[3])
        self.assertEqual(["empty", M_QUEUE_EMPTY, "", True], self.queue()["status"])

        self.mode("Radiology")
        self.assertFalse(self.queue()["shown"])
        self.mode("Technician")
        self.assertEqual((True, True), (self.queue()["shown"], self.queue()["open"]))
        self.assertEqual([], self.reads, "no reading target was picked")

    def test_m02_accept_close_decline_envelope_and_read_again(self):
        self.open_main()
        self.open_queue()
        self.open_item(21, "Requested")
        seen = self.queue()["detail"]
        self.assertEqual((rid(21), "idle", ["ready", "", "", False]), (seen["id"], seen["write"], seen["read"]))
        self.assertEqual([["accept", False, M_TIPS["accept"]], ["close", False, M_TIPS["close"]], ["decline", False, M_TIPS["decline"]],
                          ["cancel", True, M_ROLE_CANCEL]], seen["actions"])
        self.assertEqual("Study SYN ALPHA · SYN-P-011 · 20260320 · SYN CT CHEST", seen["lines"][1])

        queue_calls = len(self.queue_calls)
        self.act("accept")
        self.result("saved")
        path, body = self.writes[0]
        self.assertEqual(f"/api/image-requests/{rid(21)}", path)
        self.assertEqual({"requestId", "expectedOwner", "revision", "action", "note"}, set(body))
        self.assertRegex(body["requestId"], V4)
        self.assertEqual(([INSTITUTION, "SYN-TECH-SUB"], 1, "accept", ""),
                         (body["expectedOwner"], body["revision"], body["action"], body["note"]))
        expect(self.page.locator("#image-request-detail")).to_have_attribute("data-state", "Accepted")
        self.wait_until(lambda: len(self.queue_calls) == queue_calls + 1, "the queue read again")
        seen = self.queue()["detail"]
        self.assertEqual(["saved", M_SAVED["accept"], "", True], seen["result"])
        self.assertEqual([["accept", True, M_STATE_ACCEPT], ["close", False, M_TIPS["close"]], ["decline", False, M_TIPS["decline"]],
                          ["cancel", True, M_ROLE_CANCEL]], seen["actions"])

        self.act("close")
        self.result("failed")
        self.assertEqual(["failed", M_NO_NOTE, "", True], self.queue()["detail"]["result"])
        self.assertEqual(1, len(self.writes))
        self.page.locator("#image-request-note").fill("SYN handled via the existing path")
        self.act("close")
        expect(self.page.locator("#image-request-detail")).to_have_attribute("data-state", "Closed")
        self.result("saved")
        path, body = self.writes[1]
        self.assertEqual((2, "close", "SYN handled via the existing path"), (body["revision"], body["action"], body["note"]))
        self.assertNotEqual(self.writes[0][1]["requestId"], body["requestId"])
        seen = self.queue()["detail"]
        self.assertEqual([CLOSED_NOTE, CLOSED_NOTE], seen["closed"])
        self.assertEqual(["Handler SYN Technician", "Handling Note SYN handled via the existing path"], seen["lines"][-2:])
        self.assertEqual(["saved", M_SAVED["close"], "", True], seen["result"])
        self.assertEqual(("", False), (seen["note"], seen["noteReadOnly"]))
        self.assertEqual([["accept", True, M_STATE_ACCEPT], ["close", True, M_STATE_DONE], ["decline", True, M_STATE_DONE],
                          ["cancel", True, M_ROLE_CANCEL]], seen["actions"])
        self.wait_until(lambda: rid(21) not in [entry["id"] for entry in self.queue()["items"]], "the closed request leaving the active queue")

        self.open_item(23, "Requested")
        self.assertEqual("", self.queue()["detail"]["note"])
        self.page.locator("#image-request-note").fill("SYN outside this institution's scope")
        self.act("decline")
        expect(self.page.locator("#image-request-detail")).to_have_attribute("data-state", "Declined")
        path, body = self.writes[2]
        self.assertEqual((f"/api/image-requests/{rid(23)}", 1, "decline"), (path, body["revision"], body["action"]))
        self.assertEqual("Decline Reason SYN outside this institution's scope", self.queue()["detail"]["lines"][-1])

    def test_m03_write_failures_by_code_unknown_retry_and_replay(self):
        self.open_main()
        self.open_queue()
        self.open_item(22, "Accepted")
        self.page.locator("#image-request-note").fill("SYN note")
        cases = [
            (409, err("IMAGE_REQUEST_CHANGED", "영상 요청이 변경되었습니다. 다시 불러온 뒤 확인하세요"), "failed", M_CODES["IMAGE_REQUEST_CHANGED"], True),
            (409, err("IMAGE_REQUEST_STATE", "지금 상태에서 할 수 없는 영상 요청 동작입니다"), "failed", M_CODES["IMAGE_REQUEST_STATE"], True),
            (404, err("IMAGE_REQUEST_NOT_FOUND", "영상 요청을 찾을 수 없습니다"), "failed", M_NOT_FOUND, True),
            (403, err("IMAGE_REQUEST_ROLE_REQUIRED", "이 영상 요청 동작에 필요한 역할이 없습니다"), "failed", M_CODES["IMAGE_REQUEST_ROLE_REQUIRED"], False),
            (400, err("IMAGE_REQUEST_INPUT_INVALID", "요청 ID·기준 revision·동작과 note를 확인하세요"), "failed", M_CODES["IMAGE_REQUEST_INPUT_INVALID"], False),
            (503, err("IMAGE_REQUEST_BUSY", "영상 요청 처리 중입니다. 같은 요청으로 다시 시도하세요"), "unknown", M_CODES["IMAGE_REQUEST_BUSY"], False),
        ]
        for status, reply, state, text, reread in cases:
            with self.subTest(code=reply["code"]):
                reads, writes = len(self.detail_calls), len(self.writes)
                self.write_errors = [(status, reply)]
                self.act("close")
                self.result(state)
                seen = self.queue()["detail"]
                self.assertEqual([state, text, f"{reply['message']} (HTTP {status} · {reply['code']})", True], seen["result"])
                self.assertEqual(writes + 1, len(self.writes))
                if reread:
                    self.wait_until(lambda: len(self.detail_calls) == reads + 1, "the request read again")
                    expect(self.page.locator("#image-request-detail")).to_have_attribute("data-state", "Accepted")
                else:
                    self.settle()
                    self.assertEqual(reads, len(self.detail_calls))
                seen = self.queue()["detail"]
                if state == "unknown":
                    self.assertEqual(("unknown", "SYN note", True, True, True), (seen["write"], seen["note"], seen["noteReadOnly"],
                                                                                 seen["retry"], seen["discard"]))
                    self.assertTrue(all(disabled for _, disabled, _ in seen["actions"]))
                    self.page.locator('#image-request-detail [data-write="discard"]').click()
                    self.result("discarded")
                    self.assertEqual(["discarded", M_DISCARDED, "", True], self.queue()["detail"]["result"])
                    self.wait_until(lambda: len(self.detail_calls) == reads + 1, "the request read again after Discard")
                    expect(self.page.locator("#image-request-detail")).to_have_attribute("data-state", "Accepted")
                self.assertEqual(("SYN note", False), (self.queue()["detail"]["note"], self.queue()["detail"]["noteReadOnly"]))
        # Applied, reply lost: unknown, and Retry sends the same requestId and body and gets the stored result back.
        self.lose_replies = 1
        self.act("close")
        self.result("unknown")
        self.assertEqual(["unknown", UNKNOWN, NO_SERVER, True], self.queue()["detail"]["result"])
        self.page.locator('#image-request-detail [data-write="retry"]').click()
        self.result("saved")
        self.assertEqual(["saved", REPLAYED, "", True], self.queue()["detail"]["result"])
        self.assertEqual(self.writes[-2], self.writes[-1])
        self.assertEqual((3, "Closed"), (self.server.items[rid(22)]["revision"], self.server.items[rid(22)]["state"]))
        expect(self.page.locator("#image-request-detail")).to_have_attribute("data-state", "Closed")

    def test_m04_role_guidance_and_a_refused_read_locks(self):
        self.use("radiologist", "SYN-RAD-SUB")
        self.open_main()
        self.open_queue()
        self.open_item(21, "Requested")
        self.assertEqual([["accept", True, M_ROLE_STAFF], ["close", True, M_ROLE_STAFF], ["decline", True, M_ROLE_STAFF],
                          ["cancel", True, M_ROLE_CANCEL]], self.queue()["detail"]["actions"])

        self.use("admin", "SYN-ADMIN-SUB")
        self.open_main()
        self.open_queue()
        self.open_item(21, "Requested")
        self.assertEqual([["accept", False, M_TIPS["accept"]], ["close", False, M_TIPS["close"]], ["decline", False, M_TIPS["decline"]],
                          ["cancel", False, M_TIPS["cancel"]]], self.queue()["detail"]["actions"])
        self.page.locator("#image-request-note").fill("SYN duplicate of another request")
        self.act("cancel")
        expect(self.page.locator("#image-request-detail")).to_have_attribute("data-state", "Cancelled")
        self.assertEqual(([INSTITUTION, "SYN-ADMIN-SUB"], "cancel", 1),
                         (self.writes[0][1]["expectedOwner"], self.writes[0][1]["action"], self.writes[0][1]["revision"]))
        self.assertEqual("Cancel Reason SYN duplicate of another request", self.queue()["detail"]["lines"][-1])

        self.use("technician", "SYN-TECH-SUB")
        self.queue_errors = [(403, err("IMAGE_REQUEST_ROLE_REQUIRED", "이 영상 요청 동작에 필요한 역할이 없습니다"))]
        self.open_main()
        self.open_queue(None)
        expect(self.page.locator("#image-request-queue-lock")).to_be_visible()
        seen = self.queue()
        self.assertEqual(["failed", C_REFUSED, "이 영상 요청 동작에 필요한 역할이 없습니다 (HTTP 403 · IMAGE_REQUEST_ROLE_REQUIRED)", True], seen["lock"])
        self.assertEqual((False, None, []), (seen["status"][3], seen["detail"], seen["items"]))
        # The lock holds for the document: the reading line says so and reads nothing.
        self.mode("Radiology")
        self.pick(11)
        seen = self.reading()
        self.assertEqual((True, "locked", C_REFUSED, False, False, []), (seen["shown"], seen["state"], seen["summary"],
                                                                        seen["toggle"][2], seen["pane"], self.reads))

    def test_m05_a_b_a_for_the_request_and_the_page(self):
        owner = [INSTITUTION, "SYN-TECH-SUB"]
        for label, block in (("shipped", BLOCK), ("no-guard", BLOCK_NO_GUARD)):
            with self.subTest(label):
                self.held_detail = None
                self.open_main(block)
                self.open_queue()
                self.held_detail = []
                self.open_item(21, None)
                self.open_item(23, None)
                self.open_item(21, None)
                self.assertEqual([rid(21), rid(23), rid(21)], [target for target, _ in self.held_detail])
                self.release(self.held_detail[0][1], {"owner": owner, "item": item(21, uid(11), "Requested", reason="SYN-LATE-21", at=5)})
                after_first = self.queue()["detail"]
                self.release(self.held_detail[1][1], {"owner": owner, "item": item(23, uid(12), "Requested", kind="image-transfer", at=3)})
                after_second = self.queue()["detail"]
                self.release(self.held_detail[2][1], {"owner": owner, "item": item(21, uid(11), "Requested", reason="SYN-FRESH-21", at=5)})
                self.held_detail = None
                if label == "shipped":
                    for seen in (after_first, after_second):
                        self.assertEqual((rid(21), "loading", []), (seen["id"], seen["state"], seen["lines"]))
                    expect(self.page.locator("#image-request-detail")).to_have_attribute("data-state", "Requested")
                    self.assertEqual("Reason SYN-FRESH-21", self.queue()["detail"]["lines"][3])
                else:
                    self.assertEqual("Reason SYN-LATE-21", after_first["lines"][3],
                                     "the guard-less control paints the late answer, so the harness sees late answers")
        # The page: a filter change while the first page is held; the late page never paints.
        self.open_main()
        self.held_queue = []
        self.open_queue(None)
        self.page.locator("#image-request-queue-state").select_option("closed")
        self.wait_until(lambda: len(self.held_queue) == 2, "the second page read")
        self.release(self.held_queue[0], self.server.queue({"state": "active"}))
        seen = self.queue()
        self.assertEqual(("loading", [], ["closed", ""]), (seen["status"][0], seen["items"], seen["filters"]))
        self.release(self.held_queue[1], self.server.queue({"state": "closed"}))
        self.held_queue = None
        self.queue_state("ready")
        self.assertEqual([rid(26)], [entry["id"] for entry in self.queue()["items"]])

    def test_m06_reading_line_is_read_only_and_follows_the_reading_study(self):
        self.use("radiologist", "SYN-RAD-SUB")
        a, b = uid(11), uid(12)
        self.open_main()
        seen = self.reading()
        self.assertEqual((False, "idle"), (seen["shown"], seen["state"]))
        self.pick(11)
        self.wait_until(lambda: self.reads == [a], "the reading study's read")
        expect(self.page.locator("#image-request-p")).to_have_attribute("data-state", "ready")
        seen = self.reading()
        # Folded (Show Requests not pressed): Closed comes with its required note as visible text next to the summary
        # (B-R-001 F4), not only in the title or in the list behind Show Requests.
        self.assertEqual((True, "이 검사의 영상 요청 3건 · Requested 1 · Accepted 1 · Closed 1", f"Closed {CLOSED_NOTE}",
                          ["Show Requests", "false", True], False),
                         (seen["shown"], seen["summary"], seen["closedLine"], seen["toggle"], seen["pane"]))
        # A narrow reading panel wraps the note instead of cutting it; the same line with an ellipsis is seen as cut.
        for width in (None, 240):
            with self.subTest(width=width):
                narrow = self.page.evaluate(NARROW_CLOSED, [width, ""])
                self.assertEqual((True, True, False), (narrow["visible"], narrow["inside"], narrow["clipped"]), narrow)
        self.assertGreater(self.page.evaluate(NARROW_CLOSED, [240, ""])["lines"], 1, "the note wraps at 240px")
        control = self.page.evaluate(NARROW_CLOSED, [240, "white-space:nowrap;overflow:hidden;text-overflow:ellipsis"])
        self.assertTrue(control["clipped"], control)
        self.page.locator("#image-request-toggle").click()
        seen = self.reading()
        self.assertEqual((True, ["Hide Requests", "true", True]), (seen["pane"], seen["toggle"]))
        self.assertEqual([rid(21), rid(22), rid(26)], [entry["id"] for entry in seen["items"]])
        self.assertEqual([None, None, CLOSED_NOTE], [entry["closed"] for entry in seen["items"]])
        self.assertEqual(["BUTTON:Hide Requests"], seen["controls"], "read only: no note, filter or processing control")
        self.assertEqual("Handling Note SYN handled", seen["items"][2]["lines"][-1])

        self.pick(12)
        self.wait_until(lambda: self.reads == [a, b], "the next reading study's read")
        expect(self.page.locator("#image-request-p")).to_have_attribute("data-state", "ready")
        self.assertEqual(("이 검사의 영상 요청 2건 · Requested 1 · Accepted 1", None),
                         (self.reading()["summary"], self.reading()["closedLine"]), "no Closed, no note line")
        self.pick(13)
        self.settle()
        self.assertEqual(([a, b], False, "idle"), (self.reads, self.reading()["shown"], self.reading()["state"]))

        # A->B->A: only the newest read of the current study paints.
        self.held_reads = []
        self.pick(11)
        self.pick(12)
        self.pick(11)
        self.wait_until(lambda: len(self.held_reads) == 3, "three held reads")
        owner = [INSTITUTION, "SYN-RAD-SUB"]
        self.release(self.held_reads[0][1], {"owner": owner, "items": [item(31, a, "Requested", reason="SYN-LATE-A")]})
        first = self.reading()
        self.release(self.held_reads[1][1], {"owner": owner, "items": [item(32, b, "Requested", reason="SYN-LATE-B")]})
        second = self.reading()
        self.release(self.held_reads[2][1], {"owner": owner, "items": [item(33, a, "Declined", revision=2, handler=STAFF,
                                                                             note="SYN declined", reason="SYN-FRESH-A")]})
        self.held_reads = None
        for seen in (first, second):
            self.assertEqual((False, "loading", []), (seen["shown"], seen["state"], seen["items"]))
        expect(self.page.locator("#image-request-p")).to_have_attribute("data-state", "ready")
        self.assertEqual([rid(33)], [entry["id"] for entry in self.reading()["items"]])

        # 404: the line stays up with its reason and Retry; 403 locks it.
        self.read_errors = [(404, err("STUDY_NOT_FOUND", "검사를 찾을 수 없습니다"))]
        self.pick(12)
        expect(self.page.locator("#image-request-p")).to_have_attribute("data-state", "failed")
        seen = self.reading()
        self.assertEqual((True, M_READ_FAILED), (seen["shown"], seen["summary"]))
        self.assertEqual(["failed", M_READ_FAILED, f"{M_NOT_FOUND}\n검사를 찾을 수 없습니다 (HTTP 404 · STUDY_NOT_FOUND)", True], seen["line"])
        self.page.locator("#image-request-read-status button").click()
        expect(self.page.locator("#image-request-p")).to_have_attribute("data-state", "ready")
        self.read_errors = [(403, err("IMAGE_REQUEST_ROLE_REQUIRED", "이 영상 요청 동작에 필요한 역할이 없습니다"))]
        self.pick(11)
        expect(self.page.locator("#image-request-p")).to_have_attribute("data-state", "locked")
        seen = self.reading()
        self.assertEqual((True, C_REFUSED, False, False), (seen["shown"], seen["summary"], seen["toggle"][2], seen["pane"]))

    def test_m07_nothing_is_drawn_after_session_end_or_another_account(self):
        self.open_main()
        self.open_queue()
        self.open_item(21, "Requested")
        self.held_writes = []
        self.act("accept")
        self.wait_until(lambda: len(self.held_writes) == 1, "the held write")
        self.held_queue = []
        self.page.locator("#image-request-queue-reload").click()
        self.wait_until(lambda: len(self.held_queue) == 1, "the held page")
        self.page.evaluate(BROADCAST_ENDED)
        expect(self.page.locator("#image-request-queue-lock")).to_be_visible()
        route, apply, body = self.held_writes[0]
        status, reply = apply(body)
        self.release(route, reply, status)
        self.release(self.held_queue[0], self.server.queue({"state": "active"}))
        self.held_writes = self.held_queue = None
        seen = self.queue()
        self.assertEqual((["failed", M_ENDED, "", True], [], None), (seen["lock"], seen["items"], seen["detail"]))
        self.mode("Radiology")
        self.pick(11)
        self.settle()
        self.assertEqual(([], False), (self.reads, self.reading()["shown"]))

        self.queue_errors = [(200, {"owner": [INSTITUTION, "SYN-OTHER-SUB"], "items": [], "nextCursor": None})]
        self.open_main()
        self.open_queue(None)
        expect(self.page.locator("#image-request-queue-lock")).to_be_visible()
        self.assertEqual(["failed", OWNER_CHANGED, "", True], self.queue()["lock"])

        self.open_main()
        self.open_queue()
        self.open_item(22, "Accepted")
        self.page.locator("#image-request-note").fill("SYN note")
        self.write_errors = [(409, err("OWNER_CHANGED", "로그인한 계정이 바뀌었습니다. 화면을 다시 불러오세요"))]
        self.act("close")
        expect(self.page.locator("#image-request-queue-lock")).to_be_visible()
        seen = self.queue()
        self.assertEqual((["failed", OWNER_CHANGED, "로그인한 계정이 바뀌었습니다. 화면을 다시 불러오세요 (HTTP 409 · OWNER_CHANGED)", True], None),
                         (seen["lock"], seen["detail"]))
        self.mode("Radiology")
        self.pick(11)
        self.settle()
        self.assertEqual(([], True, OWNER_CHANGED), (self.reads, self.reading()["shown"], self.reading()["summary"]))

    def test_m08_wording_targets_and_keyboard(self):
        self.open_main()
        self.mode("Technician")
        self.page.locator("#o-clear").focus()
        self.tab_until("image-request-queue-summary")
        calls = len(self.queue_calls)
        self.page.keyboard.press("Enter")
        self.wait_until(lambda: len(self.queue_calls) == calls + 1, "the queue read after Enter")
        self.queue_state("ready")
        self.assertEqual(["image-request-queue-state", "image-request-queue-kind", "image-request-queue-reload", "BUTTON:Open",
                          "BUTTON:Open", "BUTTON:Open", "image-request-queue-more"], self.tab_walk(7))
        self.page.locator(f'#image-request-queue-list > li[data-id="{rid(21)}"] [data-open]').focus()
        self.page.keyboard.press("Enter")
        expect(self.page.locator("#image-request-detail")).to_have_attribute("data-state", "Requested")
        self.page.locator("#image-request-queue-more").focus()
        self.assertEqual(["image-request-note", "BUTTON:Accept", "BUTTON:Close", "BUTTON:Decline"], self.tab_walk(4))
        # Enter on Decline with no note: refused here, nothing sent.
        self.page.keyboard.press("Enter")
        self.result("failed")
        self.assertEqual((["failed", M_NO_NOTE, "", True], []), (self.queue()["detail"]["result"], self.writes))
        texts = self.wording("#image-request-queue", ["Image Requests", "State", "Kind", "Reload", "Open", "More", "Request", "Note",
                                                      "Accept", "Close", "Decline", "Cancel", "Active", "All Kinds", "External Images",
                                                      "Send Images", "Requested", "Accepted"])
        self.assertTrue(any(has_hangul(entry["text"]) for entry in texts if entry["tag"] == "P"))
        self.page.locator("#image-request-queue-state").select_option("closed")
        self.queue_state("ready")
        self.wording("#image-request-queue", ["Closed"])

        self.mode("Radiology")
        self.pick(11)
        expect(self.page.locator("#image-request-p")).to_have_attribute("data-state", "ready")
        self.page.locator("#image-request-toggle").focus()
        self.page.keyboard.press("Enter")
        self.assertTrue(self.reading()["pane"])
        texts = self.wording("#image-request-p", ["Image Requests", "Hide Requests", "Requested", "Accepted", "Closed"])
        self.assertIn(CLOSED_NOTE, [entry["text"] for entry in texts])
        self.assertTrue(has_hangul(self.page.locator("#image-request-summary").text_content()))

    def test_m09_a_401_ends_the_area_before_the_logout_answers(self):
        a = uid(11)
        cases = (("queue read", "shipped", API_FN), ("write", "shipped", API_FN), ("queue read", "no-hook", API_FN_NO_HOOK))
        for trigger, label, api_fn in cases:
            with self.subTest(trigger=trigger, api=label):
                self.logouts = []
                self.held_writes = self.held_reads = None
                self.write_errors = []
                self.server.items[rid(21)].update(state="Requested", revision=1, note=None, handler=None)
                self.open_main(api_fn=api_fn, real_auth=True)
                self.page.evaluate("() => KinAuth.init()")
                self.open_queue()
                self.open_item(21, "Requested")
                self.page.locator("#image-request-note").fill("SYN note before the 401")
                reads = len(self.reads)
                # A reading read, and for the queue case an Accept, are in flight when the 401 arrives.
                self.held_reads = []
                self.pick(11)
                self.wait_until(lambda: len(self.held_reads) == 1, "the held reading read")
                if trigger == "queue read":
                    self.held_writes = []
                    self.act("accept")
                    self.wait_until(lambda: len(self.held_writes) == 1, "the held write")
                    self.queue_errors = [(401, {"statusCode": 401, "message": "Unauthorized"})]
                    self.page.locator("#image-request-queue-state").select_option("all")
                else:
                    self.write_errors = [(401, {"statusCode": 401, "message": "Unauthorized"})]
                    self.act("close")
                self.wait_until(lambda: len(self.logouts) == 1, "POST /auth/logout (held)")
                self.settle()
                at_401 = self.queue()
                self.release(self.held_reads[0][1], self.server.study(a))
                late_read_paints = int(self.reading()["state"] == "ready")
                # Reads are answered from here on: the control's saved write reads the request, the queue and the line again.
                self.held_reads = None
                late_write_paints = 0
                if self.held_writes:
                    route, apply, body = self.held_writes[0]
                    status, reply = apply(body)
                    self.release(route, reply, status)
                    late_write_paints = int((self.queue()["detail"] or {}).get("result", [None])[0] == "saved")
                self.held_writes = None
                if label == "no-hook":
                    self.assertEqual((1, 1), (late_read_paints, late_write_paints),
                                     "without the hook the late read and write paint while the logout is held")
                else:
                    self.assertEqual((["failed", M_ENDED, "", True], [], None), (at_401["lock"], at_401["items"], at_401["detail"]),
                                     "ended at the 401, before the logout answered")
                    self.assertEqual((0, 0), (late_read_paints, late_write_paints))
                    seen, reading = self.queue(), self.reading()
                    self.assertEqual((["failed", M_ENDED, "", True], [], None, False, "ended"),
                                     (seen["lock"], seen["items"], seen["detail"], reading["shown"], reading["state"]))
                    # Nothing new is read or sent: another reading study, the page's controls are gone.
                    writes, queue_calls = len(self.writes), len(self.queue_calls)
                    self.pick(12)
                    self.settle()
                    self.assertEqual((reads + 1, writes, queue_calls), (len(self.reads), len(self.writes), len(self.queue_calls)))
                    self.assertEqual(0, self.page.locator("#image-request-queue button:visible, #image-request-p button:visible").count())
                self.assertTrue(self.page.url.endswith("/harness/main.html"), "the logout has not answered yet")
                self.logouts[0].fulfill(status=204, body="")
                self.page.wait_for_url("**/harness/index.html")

    def test_m10_a_receipt_that_is_not_the_sent_write_stays_unknown(self):
        # Control: the fix1 check took an Accept receipt of another state and revision as saved.
        self.open_main(BLOCK_FIX1_RECEIPT)
        self.open_queue()
        self.open_item(21, "Requested")
        self.mangles = [bad_receipt({"to": "Closed", "revision": 99})]
        self.act("accept")
        self.result("saved")
        self.assertEqual(["saved", M_SAVED["accept"], "", True], self.queue()["detail"]["result"],
                         "the fix1 check accepts the wrong receipt")

        self.server.items[rid(21)].update(state="Requested", revision=1, handler=None)
        self.server.receipts.clear()
        self.open_main()
        self.open_queue()
        self.open_item(21, "Requested")
        accept = [
            {"to": "Closed", "revision": 99}, {"kind": DROP, "from": DROP, "at": DROP}, {"kind": DROP}, {"from": DROP},
            {"at": DROP}, {"to": DROP}, {"revision": DROP}, {"kind": "image-transfer"}, {"from": "Accepted"},
            {"to": "Requested"}, {"revision": 1}, {"revision": "2"}, {"at": "2026-09-27 01:00:01"}, {"at": "SYN-NOT-A-DATE"},
        ]
        self.mangles = [bad_receipt(changes) for changes in accept]
        self.page.locator("#image-request-note").fill("SYN kept note")
        self.act("accept")
        for index, changes in enumerate(accept):
            with self.subTest(accept=repr(changes)):
                if index:
                    self.page.locator('#image-request-detail [data-write="retry"]').click()
                self.wait_until(lambda: len(self.writes) == index + 1, "the write")
                self.result("unknown")
                seen = self.queue()["detail"]
                self.assertEqual((["unknown", WRITE_MALFORMED, "", True], "unknown", "SYN kept note", True, True, True),
                                 (seen["result"], seen["write"], seen["note"], seen["noteReadOnly"], seen["retry"], seen["discard"]))
                self.assertTrue(all(disabled for _, disabled, _ in seen["actions"]))
                self.assertEqual(self.writes[0], self.writes[-1], "Retry sends the same requestId and body")
        # Another member has closed the request since; the stored receipt of this Accept is still accepted as replayed.
        self.server.items[rid(21)].update(state="Closed", revision=3, note="SYN closed by another", handler=STAFF)
        self.page.locator('#image-request-detail [data-write="retry"]').click()
        self.result("saved")
        self.assertEqual(["saved", REPLAYED, "", True], self.queue()["detail"]["result"])
        expect(self.page.locator("#image-request-detail")).to_have_attribute("data-state", "Closed")

        # An admin's cancel (Astra's case: to Requested, revision 999) and a receipt of another from state.
        self.use("admin", "SYN-ADMIN-SUB")
        self.open_main()
        self.open_queue()
        self.open_item(23, "Requested")
        cancel = [{"to": "Requested", "revision": 999}, {"from": "Cancelled"}, {"at": DROP}]
        self.mangles = [bad_receipt(changes) for changes in cancel]
        self.page.locator("#image-request-note").fill("SYN duplicate")
        self.act("cancel")
        for index, changes in enumerate(cancel):
            with self.subTest(cancel=repr(changes)):
                if index:
                    self.page.locator('#image-request-detail [data-write="retry"]').click()
                self.wait_until(lambda: len(self.writes) == index + 1, "the cancel")
                self.result("unknown")
                self.assertEqual((["unknown", WRITE_MALFORMED, "", True], "SYN duplicate"),
                                 (self.queue()["detail"]["result"], self.queue()["detail"]["note"]))
                self.assertEqual(self.writes[0], self.writes[-1])
        self.page.locator('#image-request-detail [data-write="retry"]').click()
        self.result("saved")
        expect(self.page.locator("#image-request-detail")).to_have_attribute("data-state", "Cancelled")

    def test_m11_cancel_is_the_requester_s_or_an_admin_s(self):
        cases = [
            # roles, token actor, cancel enabled, staff actions enabled
            (["clinician", "radiologist"], "syn-mixed", False, False),
            (["clinician", "technician"], "syn-mixed", False, True),
            (["clinician", "radiologist"], None, False, False),
            (["clinician", "radiologist"], "syn-clinician", True, False),
            (["admin"], "syn-admin", True, True),
        ]
        for roles, actor, cancel, staff in cases:
            with self.subTest(roles=roles, actor=actor):
                self.use_roles(roles, "SYN-MEMBER-SUB", actor, "SYN Clinician")
                self.open_main()
                self.open_queue()
                self.open_item(21, "Requested")
                actions = {name: (disabled, title) for name, disabled, title in self.queue()["detail"]["actions"]}
                self.assertEqual((not cancel, M_TIPS["cancel"] if cancel else M_ROLE_CANCEL), actions["cancel"])
                for name in ("accept", "close", "decline"):
                    self.assertEqual(not staff, actions[name][0], name)
                self.page.locator("#image-request-note").fill("SYN cancel reason")
                if not cancel:
                    # A disabled Cancel does nothing, whoever clicks it.
                    self.page.evaluate("() => document.querySelector('#image-request-detail button[data-action=\"cancel\"]').click()")
                    self.settle()
                    self.assertEqual([], self.writes)
                    continue
                if roles == ["admin"]:
                    self.page.locator("#image-request-note").fill("")
                    self.act("cancel")
                    self.result("failed")
                    self.assertEqual((["failed", M_NO_NOTE, "", True], []), (self.queue()["detail"]["result"], self.writes))
                    self.page.locator("#image-request-note").fill("SYN cancel reason")
                self.act("cancel")
                expect(self.page.locator("#image-request-detail")).to_have_attribute("data-state", "Cancelled")
                self.assertEqual([("cancel", 1, "SYN cancel reason")],
                                 [(body["action"], body["revision"], body["note"]) for _, body in self.writes])
                self.server.items[rid(21)].update(state="Requested", revision=1, note=None, handler=None)


if __name__ == "__main__":
    unittest.main(verbosity=2)
