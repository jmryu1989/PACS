# coding: utf-8
"""REQ-S5-U4b-QUESTION-UI -> RISK-S5-U4b-STALE -> TEST-S5-U4b-DOM.

Both screens of the S5-U4a question threads, loaded from a synthetic origin against an in-test server that keeps the
S5-U4a service rules the screens rely on (clinician-question.service.ts: exact body keys, expectedOwner, per-request
receipts that replay the stored `applied` result, revision before state, author/role rules, owner-only visibility):

  Clinician Home (clinician.html + clinician.js + auth.js, shipped bytes or a named control variant)
  01  the Questions section is one collapsed summary per selected study: no button, heading or request until it is
      opened; opened it reads GET studies/:uid/questions, shows empty/list states, and Ask posts exactly
      {requestId (new UUID v4), expectedOwner [institution, sub], body}; the new thread opens from a fresh read; the
      section stays open for the next study, unsent text stays with its own study, and it reads nothing once closed.
  02  thread view: author, time and state of every entry; follow-up (Reply) and author close with an empty reason post
      the thread's current revision; a Closed thread has no write fields; an answer whose reportAnchor differs from
      `current` says the report state changed after the answer, with both states.
  03  a failed read (the tele study's 404 with its reason, a 500) is a failure with Retry, never an empty list; write
      refusals are shown as the screen's Korean text plus the server message and code, never swallowed: 409
      QUESTION_CHANGED (a real concurrent answer, the thread is read again and the typed text stays), QUESTION_CLOSED,
      REQUEST_ID_REUSED, 404, 403, 400, a blank text refused before any request; the next send uses a new requestId.
  04  outcomes the screen cannot know - 503 QUESTION_BUSY, a dropped connection after the server applied the write,
      409 STUDY_ACCESS_CHANGED after commit, a 201 whose envelope names another request - keep the text read-only with
      Retry (the same requestId and body) and Discard; a Retry of an applied write shows the replayed result and adds
      no entry.
  05  A->B->A: a late list answer for A never paints over A's newer one or over B, a late thread answer of an earlier
      selection never paints, and a write answered after the user moved on changes nothing on B. Control: the same file
      checking only the selected UID paints A's first answer over its second.
  06  session policy: a 403 on a question read, another account's envelope and 409 OWNER_CHANGED lock the section with
      an explicit text, drop answers already on the way and send nothing more; Log out and another tab's session end
      while an answer is pending leave only the closing line.
  07  English controls and state names, Korean explanations, no avoided or acknowledgement words, text >= 12px, hit
      targets >= 24px, keyboard from the summary to Reply, aria wiring; no consultation route or report body is used.
  08  (Astra S5-U4b-R-001 F4) only a 201 whose `applied` is this request's step counts as saved (contract §3.4, §5.1):
      200 and 202, a missing entry/from/revision/at, another action, to, entry kind, entry id or entry seq, a revision
      or a from other than the request's own keep the text read-only with Retry; checked against the request as sent,
      so a Retry answered with the stored result after the thread moved on and closed is accepted and read again.
  09  (F2) a late Ask's 201 never moves the thread the user chose after sending it (A->B->A, another thread of the same
      study, Questions closed and opened again) and keeps the draft and focus there; an Ask nobody moved away from still
      opens its new thread. Control: the file that opens it whenever the study is still selected moves the user.
  09b (Astra S5-U4b-B-R-001 F2) the study's list is its latest 50: the open thread pushed out of it by the 51st Ask stays
      open with its typed reply and focus and is read again through GET questions/:id; an unknown Reply there keeps
      Retry across the next re-read; a 404 on that read is the thread's own failure with Retry and the typed text kept;
      a 403 locks the section with its text. Control: the file that drops a thread missing from the list closes it.
  09c (Astra S5-U4b-C-R-001 F1) unknown Replies in two threads pushed out of the latest 50 stay reachable from the
      section's pending rows after Questions is closed and opened again and after A->B->A: each row opens its thread
      through GET questions/:id, and Retry / Discard appear only after that read (hidden while it is held, and after an
      answer for another study); Retry sends the same requestId, revision and body and adds one entry; Discard keeps the
      text as a Draft row. A 403 or another account's envelope locks the section: no row, no thread, nothing sent, and
      nothing comes back after A->B->A or reopening. Control: the file without pending rows leaves no way to Retry.

  Reading screen (the S5-U4b block cut out of main.html and run as is, on main.html's own markup and styles with the
  page script stripped; the block sends its own requests and does not use api())
  10  (F4) the same envelope rule for Reply and Close on the reading screen.
  11  the Questions row follows the reading target: GET studies/:uid/questions once per target change and never for the
      same target; hidden (no layout change) for a target without threads, for a tele study (not read) and for a session
      that is neither radiologist nor admin (not read); visible with counts when threads exist; it sits after the report
      fields and before the footer row, outside .rbtns/.rfoot2.
  12  Reply and reason-required Close post the thread's revision; the OQ-11 notice sits beside the reply field and
      describes it; the anchor note; an admin-only session gets the server's 403 for Reply shown as sent, and can close
      with a reason.
  13  read failures (list 500 with Retry, thread 404), write refusals and unknown outcomes with Retry / Discard.
  14  A->B->A for the list, typed text kept per study and thread (never carried to another study), a write answered
      after the target changed paints nothing on the new target. Control: the UID-only file paints A's first answer.
  15  Inbox: GET questions?view=inbox&state=open, 50 per page with the signed cursor passed back verbatim, the state
      filter, a study missing from the loaded worklist is disabled with a Korean reason, Open Study selects the study
      and opens the chosen thread, empty and failed states.
  16  session policy: another tab's session end while a read is pending hides the row, stops the read and paints nothing;
      a 403 read and another account's envelope lock the row with an explicit text and nothing more is read; a 401 on a
      write ends the row and starts the logout.
  17  wording, fonts, hit targets and keyboard on the reading screen.
  18  (F1) with the shipped auth.js, whose logout() broadcasts only after POST /auth/logout: a 401 ends the row while
      that POST is held - nothing shown, drafts dropped, the requests on the way aborted, their answers paint nothing
      and nothing more is read - and calls the page's other registered end() once (window.kinOn401). Control: the block
      that leaves the end to the logout broadcast keeps the row.
  18b (Astra S5-U4b-B-R-001 F1) the same for a 401 on another request of the page (a report save through main.html's own
      api(), cut out as shipped): every registered end() runs before POST /auth/logout answers. Control: api() without
      the list call keeps the row up while that POST is held.
  18c (B-R-001 F1) the confirmed Log out (main.html's own handler, clicked): the row is ended before its first network
      wait - the draft write, the hold release and the logout POST, which keep their order. Control: the handler without
      the list call keeps the row up while the draft is written and while the logout POST is held.
  18d every place in main.html that starts KinAuth.logout() calls the end list first (api()'s 401, the dictation 401, the
      two owner-change exits, Log out before its draft write, the row's own 401); the one other is the membership
      screen, where no question row ever read. without_u4b() after without_u4c_main() leaves no kinOn401 behind.
  19  (F3) Inbox -> Open Study for a question outside its study's latest 50 opens it through GET questions/:id and keeps
      it after a reply re-reads the list; a late read of an earlier choice never paints; 404, another study's thread and
      403 are explicit.

Synthetic data only (SYN-* names): no server, no network, no credentials. A request the harness does not answer is
aborted and fails the case. The server half is tests/clinician_question_live.py (hosted synthetic stack only).
"""
import base64
import copy
import json
import re
import time
import unicodedata
import unittest
import uuid
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"


def lf_text(path):
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


ORIGIN = "https://clinician.test"
BASE = "/worklist/hpacs-lite/"
SHIPPED = {name: lf_text(HPACS / name) for name in ("clinician.html", "clinician.js", "auth.js")}
MAIN = lf_text(HPACS / "main.html")
EMBLEM = (HPACS / "kin-emblem-j1.svg").read_bytes()
INDEX_STAND_IN = ('<!doctype html><html><head><meta charset="utf-8"><title>SYN index stand-in</title></head>'
                  '<body><p id="stand-in">SYN index stand-in</p></body></html>')
BLANK = '<!doctype html><html><head><meta charset="utf-8"><title>SYN blank</title></head><body></body></html>'

INSTITUTION = "SYN-INST-A"
CLINICIAN = {"sub": "SYN-CLIN-SUB", "actor": "syn-clinician@kin", "name": "SYN Clinician"}
OTHER_CLINICIAN = {"sub": "SYN-CLIN2-SUB", "actor": "syn-clinician2@kin", "name": "SYN Clinician Two"}
RADIOLOGIST = {"sub": "SYN-RAD-SUB", "actor": "syn-rad@kin", "name": "SYN Radiologist"}
RADIOLOGIST_TWO = {"sub": "SYN-RAD2-SUB", "actor": "syn-rad2@kin", "name": "SYN Radiologist Two"}
ADMIN = {"sub": "SYN-ADMIN-SUB", "actor": "syn-admin@kin", "name": "SYN Admin"}


def me(person, roles):
    return {"sub": person["sub"], "actor": person["actor"], "user": person["actor"], "displayName": person["name"],
            "roles": roles, "institution": INSTITUTION, "kind": "member"}


PREFIX = "1.2.826.0.1.3680043.10.5432"
A, B, C, T = (f"{PREFIX}.{n}" for n in (51, 52, 53, 54))
HOSTILE = '<img src=x onerror="document.body.dataset.pwned=1">'


def clinician_row(u, name, date, tele=False):
    return {"uid": u, "id": f"SYN-P-{u[-2:]}", "name": name, "birth": "19800517", "sex": "M", "date": date,
            "acc": f"SYN-ACC-{u[-2:]}", "desc": f"SYN DESC {u[-2:]}", "modality": "CT", "count": 10, "series": 1,
            "sourcePatientKey": f"{INSTITUTION}|SYN-P-{u[-2:]}", "institutionName": "SYN Hospital A", "tele": tele,
            "report": {"final": False, "rs": "P"}}


CLINICIAN_ROWS = [clinician_row(A, "SYN ALPHA", "20260320"), clinician_row(B, "SYN BETA", "20260310"),
                  clinician_row(T, "SYN TELE", "20260301", tele=True)]
READER_STUDIES = [{"uid": A, "name": "SYN ALPHA", "id": "SYN-P-51", "date": "2026-03-20", "desc": "SYN CT A", "tele": False},
                  {"uid": B, "name": "SYN BETA", "id": "SYN-P-52", "date": "2026-03-10", "desc": "SYN CT B", "tele": False},
                  {"uid": C, "name": "SYN GAMMA", "id": "SYN-P-53", "date": "2026-03-05", "desc": "SYN CT C", "tele": False},
                  {"uid": T, "name": "SYN TELE", "id": "SYN-P-54", "date": "2026-03-01", "desc": "SYN CT T", "tele": True}]

# Product wording, verbatim (clinician.js QUESTION, main.html mountStudyQuestions TEXT).
C_EMPTY = "이 검사에 남긴 질문이 없습니다. 목록 조회는 성공했습니다."
C_READY = "이 검사에 남긴 질문 {n}건을 최신순으로 표시합니다."
C_FAILED = "질문 목록을 불러오지 못했습니다."
C_NOT_FOUND = "이 검사나 질문을 찾을 수 없습니다. 원격판독으로 받은 검사, 접근 조건이 바뀐 검사에는 질문을 남길 수 없습니다."
C_DISCARDED = "보낸 요청을 버렸습니다. 저장되었을 수 있으니 다시 불러온 목록에서 확인하세요."
C_CLOSED_NOTE = "닫힌 질문입니다. 새 답변·추가 질문·닫기는 서버가 거절합니다."
C_THREAD_FAILED = "질문 스레드를 불러오지 못했습니다."
C_MALFORMED = "질문 응답 형식을 확인할 수 없습니다. 다시 불러오세요."
C_PENDING = ("결과를 모르는 요청이나 보내지 않은 글이 남은 질문 {n}건입니다. 최신 50건 목록에 없어도 여기서 열 수 있습니다. "
             "화면을 새로 불러오거나 로그아웃하면 사라집니다.")
C_PENDING_STATES = {"Unconfirmed": "저장되었는지 알 수 없는 요청이 있습니다. 스레드를 열면 Retry·Discard가 있습니다.",
                    "Sending": "보내는 중인 요청이 있습니다.", "Draft": "보내지 않은 글이 있습니다."}
R_EMPTY = "이 검사에는 질문이 없습니다."
R_FAILED = "이 검사의 질문을 불러오지 못했습니다."
R_COUNTS = "이 검사의 질문 {n}건 · Open {o} · Answered {a} · Closed {c}"
R_READY = "이 검사의 질문 {n}건을 최신순으로 표시합니다."
R_NOT_FOUND = "검사나 질문을 찾을 수 없습니다. 접근 조건이 바뀌었거나 검사가 옮겨졌을 수 있습니다."
R_DISCARDED = "보낸 요청을 버렸습니다. 저장되었을 수 있으니 다시 불러온 스레드에서 확인하세요."
R_CLOSED_NOTE = "닫힌 질문입니다. 새 답변·닫기는 서버가 거절합니다."
R_THREAD_FAILED = "질문 스레드를 불러오지 못했습니다."
R_OTHER_STUDY = "이 질문은 판독 대상 검사의 질문이 아니어서 열지 않았습니다. Inbox를 다시 불러오세요."
R_INBOX_EMPTY = "이 조건의 질문이 없습니다."
R_INBOX_FAILED = "받은 질문을 불러오지 못했습니다."
R_INBOX_READY = "질문 {n}건을 최신순으로 표시합니다."
R_NOT_LISTED = "이 검사는 지금 워크리스트에 없어 열 수 없습니다. 목록을 새로고침하거나 검색 조건을 바꾸세요."
NON_FINAL = "확정 전 소견을 적으면 임상의에게 그대로 보입니다."
ANCHOR_CHANGED = "답변 이후 판독 상태가 바뀌었습니다."
CLOSE_EMPTY = "사유 없이 닫았습니다."
NO_TEXT = "1~2,000자의 내용을 입력하세요."
SENDING = "보내는 중입니다…"
SAVED = "저장했습니다."
REPLAYED = "이미 저장된 요청입니다. 서버가 처음 저장한 결과를 돌려주었습니다."
UNKNOWN = "저장되었는지 알 수 없습니다. Retry는 같은 요청 ID로 다시 보내 저장 결과를 확인하고, Discard는 이 요청을 버립니다."
WRITE_MALFORMED = "저장 응답의 형식을 확인할 수 없습니다. Retry는 같은 요청 ID로 다시 보내 저장 결과를 확인합니다."
REFUSED = "서버가 이 계정의 질문 읽기를 거절했습니다. 권한이 바뀌었다면 화면을 다시 불러오세요."
OWNER_CHANGED = "로그인한 계정이 바뀌었습니다. 이 화면에서는 질문을 더 읽거나 쓰지 않습니다. 화면을 다시 불러오세요."
REJECTED = "서버가 요청을 거절했습니다."
CODES = {
    "QUESTION_CHANGED": "그사이 이 질문이 바뀌었습니다. 스레드를 다시 불러왔으니 내용을 확인한 뒤 다시 보내세요.",
    "QUESTION_CLOSED": "이미 닫힌 질문이라 더 쓸 수 없습니다.",
    "REQUEST_ID_REUSED": "같은 요청 ID가 다른 내용에 이미 쓰였습니다. 다시 불러온 뒤 새로 보내세요.",
    "QUESTION_BUSY": "서버가 다른 요청을 처리하고 있어 저장하지 못했을 수 있습니다. Retry는 같은 요청 ID로 다시 보냅니다.",
    "STUDY_ACCESS_CHANGED": "요청 중 검사 접근 조건이 바뀌었습니다. 저장되었을 수 있으니 Retry로 같은 요청을 다시 보내 확인하세요.",
}
STATUSES = {400: "서버가 입력을 거절했습니다.", 403: "서버가 이 동작을 거절했습니다."}
NO_SERVER = "서버에 연결하지 못했습니다."
CLOSING = "세션을 닫았습니다. 로그인 화면으로 이동하는 중입니다…"

# UXR-SP-34 / UXR-G-18 avoided words and UXR-S5-15 acknowledgement words (as tests/clinician_home_dom_test.py).
AVOIDED = re.compile(r"진단|검출|판정|우선순위|diagnos|detect|priorit|\bAI\b", re.IGNORECASE)
ACKNOWLEDGED = re.compile(r"\bACK\b|acknowledg|\bsent\b|deliver|수신 확인|열어봄|읽음|전달됨", re.IGNORECASE)
UUID_V4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
# The service's own requestId rule (clinician-question.service.ts UUID).
SERVICE_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE)
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


def has_hangul(text):
    return any(unicodedata.name(ch, "").startswith("HANGUL") for ch in text)


def variant(source, edits, label):
    for old, new, count in edits:
        found = source.count(old)
        if found != count:
            raise AssertionError(f"setup: {old!r} occurs {found} times in {label}, expected {count}")
        source = source.replace(old, new)
    return source


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


def page_html(text):
    html = re.sub(r"<script\b[^>]*>.*?</script>", "", text, flags=re.S)
    html = re.sub(r'<link rel="stylesheet" href="([^"]+)">',
                  lambda m: "<style>" + (HPACS / m.group(1)).read_text(encoding="utf-8") + "</style>", html)
    return re.sub(r"<link\b[^>]*>", "", html)


# The S5-U4b block of main.html (mount + instantiation) and the one line renderClinical() calls.
BLOCK_START = "    // ── 임상의 질문 답변(S5-U4b) ──"
BLOCK_END = "    // ── 패널 크기 조절 ──"
HOOK = "      studyQuestions?.sync();\n"
READER_BLOCK = slice_between(MAIN, BLOCK_START, BLOCK_END)
CLINICIAN_BLOCK = slice_between(SHIPPED["clinician.js"], "  // ── 질문 스레드(S5-U4b) ──", "  // ── 세션 ──")

# Astra S5-U4b-B-R-001 F1: the page's end list. Every place in main.html that starts the logout first calls each end()
# registered in window.kinOn401, synchronously, before it waits on the network (the logout POST, Log out's draft write);
# the block registers the row's end() there. api()'s line is byte for byte S5-U4c's: the convention both units share.
END_401 = "(window.kinOn401 || []).forEach(end => { try { end(); } catch (_) {} });"
HOOK_401 = f"        {END_401}\n"
# Log out's call, after its comment line; the call alone is not unique (api()'s indented line contains it). Since the
# S5-U4b/U4c integration the comment line is the one both units share.
HOOK_LOG_OUT = ("      // S5-U4b/U4c 공유: 확정한 로그아웃도 401처럼 종료 목록", f"그려지지 않게.\n      {END_401}\n")

# The S5-U4b insertions into main.html, each contiguous: (name, first bytes, end marker, whether the end marker is part
# of the region). The markup's last line alone (`</section>`) is not unique, so its marker is the last two lines. A
# one-line hook is its own start and end.
U4B_REGIONS = [
    ("css", "    /* S5-U4b 질문 줄과 창.", "    #question-pane .question-detail:empty { display: none; }\n", True),
    ("markup", "        <!-- S5-U4b 임상의 질문 스레드(판독 대상 검사).",
     '          <div id="question-pane" role="region" aria-label="Question Threads" hidden></div>\n        </section>\n', True),
    ("hook", "      // S5-U4b: 판독 대상이 바뀐 때만 그 검사의 임상의 질문을 읽는다", HOOK, True),
    ("script", BLOCK_START + "\n", BLOCK_END, False),
]
# The five logout starts that call the list are shared with S5-U4c, byte for byte: api()'s 401 line, Log out's comment
# and call, and the three starts that call it inside their existing line. tests/clinician_request_dom_test.py
# without_u4c_main() is the one that cuts them (each exactly once); here each may only occur at most once - absent once
# that cut ran, present before it. The two owner-change lines differ only in indentation, so each carries the line
# break before it.
SHARED_401_TEXTS = [
    ("hook-401", HOOK_401),
    ("hook-log-out start", HOOK_LOG_OUT[0]),
    ("hook-log-out end", HOOK_LOG_OUT[1]),
    ("dictation-401", f"      onUnauthorized: () => {{ {END_401} return KinAuth.logout(); }},\n"),
    ("list-owner-change", f"\n        if (e.ownerChanged) {{ studyPageClient.clear(); {END_401} await KinAuth.logout(); return; }}\n"),
    ("poll-owner-change", f"\n          if (e.ownerChanged) {{ studyPageClient.clear(); {END_401} await KinAuth.logout(); return; }}\n"),
]


def without_u4b(text):
    """main.html (LF) with the S5-U4b regions cut: with without_u4c_main() (which cuts the five shared kinOn401 lines)
    the bytes S5-UI2's and S5-UI3's pins stand for, since tests/worklist_toolbar_dom_test.py and
    tests/report_actions_dom_test.py pin main.html outside their own regions. Raises if a region marker is missing or not
    unique, or a shared line occurs more than once, so a moved or doubled change fails instead of being half undone."""
    text = text.replace("\r\n", "\n")
    for name, shared in SHARED_401_TEXTS:
        if text.count(shared) > 1:
            raise AssertionError(f"S5-U4b/U4c shared {name} text {shared!r} occurs {text.count(shared)} times in main.html")
    for name, start, end, inclusive in U4B_REGIONS:
        for marker in (start, end):
            if text.count(marker) != 1:
                raise AssertionError(f"S5-U4b {name} marker {marker!r} occurs {text.count(marker)} times in main.html")
        first = text.index(start)
        last = text.index(end, first) + (len(end) if inclusive else 0)
        text = text[:first] + text[last:]
    return text


# The S5-U4b changes to clinician.js: (name, first bytes, end marker, whether the end marker is part of the region), then
# the two hook lines each put after its base neighbour line. tests/clinician_request_dom_test.py test_s01 takes them out
# with S5-U4c's to compare clinician.js with its base pin.
U4B_CLINICIAN_REGIONS = [
    ("header", " * S5-U4b 질문 스레드: REQ-S5-U4b-QUESTION-UI",
     " * 서버 S5-U4a route(studies/:uid/questions·questions/:id·entries·close)만 쓰고, 이 화면은 사용자가 Questions를 열 때만 읽는다.\n",
     True),
    ("text", "  // S5-U4b 질문 스레드 문구.", "  const QUESTION_TEXT_MAX = 2000;\n", True),
    ("state", "  // S5-U4b. Questions를 연 뒤에는", "  const questionNotes = new Map();\n", True),
    ("block", "  // ── 질문 스레드(S5-U4b) ──\n", "  // ── 세션 ──", False),
]
U4B_CLINICIAN_HOOKS = [
    ("clear", "    clearTimeline();\n    clearQuestions();\n", "    clearTimeline();\n"),
    ("paint", "    paintTimelineShell(row);\n    paintQuestionsShell(row);\n", "    paintTimelineShell(row);\n"),
]


def without_u4b_clinician(text):
    """clinician.js (LF) with the S5-U4b header lines, constants, state, block and two hook lines out. Raises if a marker
    or a hook is missing or not unique."""
    text = text.replace("\r\n", "\n")
    for name, start, end, inclusive in U4B_CLINICIAN_REGIONS:
        for marker in (start, end):
            if text.count(marker) != 1:
                raise AssertionError(f"S5-U4b clinician.js {name} marker {marker!r} occurs {text.count(marker)} times")
        first = text.index(start)
        last = text.index(end, first) + (len(end) if inclusive else 0)
        text = text[:first] + text[last:]
    for name, shipped, base in U4B_CLINICIAN_HOOKS:
        if text.count(shipped) != 1:
            raise AssertionError(f"S5-U4b clinician.js {name} hook {shipped!r} occurs {text.count(shipped)} times")
        text = text.replace(shipped, base)
    return text

# Everything the cut block reads from the page script, as small stand-ins. select() is the page's early return for the
# same study followed by renderClinical(), whose S5-U4b line is the shipped HOOK. KIN_AUTH is the KinAuth stand-in below,
# or nothing when the case loads the shipped auth.js first (test_18).
READER_PRELUDE = """
const $ = s => document.querySelector(s);
const API = location.origin + '/api';
let sess = window.synSession;
let serverMode = true, demoMode = false, offline = false;
let selectedUid = null;
let studies = window.synStudies;
const toast = (message, kind) => { window.synToasts.push([message, kind]); };
KIN_AUTH
function select(uid) { window.synSelects.push(uid); if (uid === selectedUid) return; selectedUid = uid; renderClinical(); }
function renderClinical() {
HOOK}
""".replace("HOOK", HOOK)
# Its logout broadcasts at once, as auth.js does after the logout POST has returned.
READER_STAND_IN = """const KinAuth = {
  session: () => window.synSession,
  has: role => { const s = window.synSession; return !!s && s.state === 'approved' && (s.roles.includes(role) || s.roles.includes('admin')); },
  logout: async () => { window.synLogouts += 1; const c = new BroadcastChannel('kin-session'); c.postMessage({ type: 'session-ended' }); c.close(); },
};"""
# Records the AbortSignal of every request the page starts with one (the question requests; auth.js's logout POST has none).
OBSERVE_SIGNALS = """() => { const real = window.fetch; window.synSignals = [];
  window.fetch = (input, init) => { if (init && init.signal) window.synSignals.push({url: String(input), signal: init.signal});
    return real(input, init); }; }"""
SIGNALS = "() => window.synSignals.map(s => [new URL(s.url).pathname, s.signal.aborted])"
READER_SETUP = """(session) => { window.synSession = session; window.synStudies = SYN_STUDIES; window.synToasts = []; window.synLogouts = 0;
  window.synSelects = []; }"""

# Astra S5-U4b-B-R-001 F1: main.html's own logout starts, cut out as shipped - api() and the Log out handler with the
# `let loggingOut` line before it - and run beside the block. What they call around the logout are stand-ins that record
# the order and the row's state when called; stashReport() waits, as the draft write it stands for, until the case lets
# it go. OTHER_PANEL registers another panel's end() in the list, so a case sees the list itself called.
API_FN = extract_function(MAIN, "api")
LOG_OUT_HANDLER = slice_between(MAIN, "    let loggingOut = false;\n", "    // 다른 사람이 잡거나 놓은 걸 보려면")
EXIT_STAND_INS = """
let insertInFlight = false;
window.synCalls = [];
const synRow = () => document.querySelector('#question-p').dataset.state;
window.confirm = () => { window.synCalls.push('confirm'); return true; };
const reportPreview = { close: () => { window.synCalls.push('reportPreview.close'); } };
function closeSR() { window.synCalls.push('closeSR'); }
function endPatientCopy() { window.synCalls.push('endPatientCopy'); }
async function stashReport() { window.synCalls.push('stashReport:' + synRow()); await new Promise(resolve => { window.synStashed = resolve; }); }
async function releaseHold() { window.synCalls.push('releaseHold:' + synRow()); }
"""
OTHER_PANEL = "() => { window.synOtherEnds = 0; window.kinOn401.push(() => { window.synOtherEnds += 1; }); }"
TOGGLES = """() => { for (const id of ['question-toggle', 'question-inbox', 'question-toggle'])
  document.getElementById(id).click(); }"""

# Another tab runs auth.js broadcastEnded(): one channel message, then a localStorage set and remove.
BROADCAST_ENDED = """() => { const c = new BroadcastChannel('kin-session'); c.postMessage({type: 'session-ended'}); c.close();
  localStorage.setItem('kin-session-ended', String(Date.now())); localStorage.removeItem('kin-session-ended'); }"""

CLINICIAN_VIEW = """() => { const s = document.querySelector('#questions'); if (!s) return null;
  const q = sel => s.querySelector(sel), text = e => e ? e.textContent : null, st = q('#questions-state'), th = q('#question-thread');
  return {uid: s.dataset.uid, open: s.open, state: s.dataset.state, body: !!q('#questions-body'),
    buttons: [...s.querySelectorAll('button')].map(b => b.textContent), headings: [...s.querySelectorAll('h1,h2,h3,h4')].map(h => h.textContent),
    list: st ? {state: st.dataset.state, role: st.getAttribute('role'), text: text(st.querySelector('.state-text')),
                detail: text(st.querySelector('.state-detail')), retry: !!q('#questions-retry') && !q('#questions-retry').hidden} : null,
    items: [...s.querySelectorAll('#question-list > li')].map(li => ({id: li.dataset.id, current: li.getAttribute('aria-current'),
      status: text(li.querySelector('.status')), text: li.textContent})),
    thread: th && !th.hidden ? {id: th.dataset.id, state: th.dataset.state, status: text(q('#question-thread-status')),
      meta: text(q('#question-thread-meta')), load: q('#question-thread-state').hidden ? null : [q('#question-thread-state').dataset.state,
        text(q('#question-thread-state .state-text')), text(q('#question-thread-state .state-detail'))],
      entries: [...q('#question-entries').children].map(li => ({seq: li.dataset.seq, kind: li.dataset.kind,
        lines: [...li.querySelectorAll(':scope > p')].map(p => p.textContent)})),
      closedNote: !q('#question-closed-note').hidden} : null,
    composers: [...s.querySelectorAll('.question-compose')].map(w => { const f = w.querySelector('[data-field]');
      return {action: w.dataset.action, state: w.dataset.state, hidden: w.hidden || !!w.closest('[hidden]'), value: f.value, readOnly: f.readOnly,
        send: !w.querySelector('[data-send]').disabled, retry: !w.querySelector('[data-retry]').hidden,
        discard: !w.querySelector('[data-discard]').hidden}; }),
    notes: [...s.querySelectorAll('[data-note-key]')].filter(b => !b.hidden && !b.closest('[hidden]')).map(b => ({state: b.dataset.state,
      text: text(b.querySelector('.state-text')), detail: text(b.querySelector('.state-detail'))}))}; }"""

READER_VIEW = """() => { const r = document.querySelector('#question-p'), pane = document.querySelector('#question-pane');
  const text = e => e ? e.textContent : null, seen = e => !!e && !e.hidden && !e.closest('[hidden]');
  const th = document.querySelector('#question-thread'), part = n => th.querySelector(`[data-part="${n}"]`);
  const box = e => e && seen(e) ? [e.dataset.state, text(e.querySelector('.question-text')), text(e.querySelector('.question-detail'))] : null;
  return {shown: !r.hidden, state: r.dataset.state, summary: text(document.querySelector('#question-summary')),
    toggle: [text(document.querySelector('#question-toggle')), document.querySelector('#question-toggle').getAttribute('aria-expanded')],
    inbox: document.querySelector('#question-inbox').getAttribute('aria-expanded'), mode: pane.hidden ? null : pane.dataset.mode,
    lock: box(document.querySelector('#question-lock')),
    list: box(document.querySelector('#question-list-state')),
    items: seen(document.querySelector('#question-list')) ? [...document.querySelectorAll('#question-list > li')].map(li => ({id: li.dataset.id,
      current: li.getAttribute('aria-current'), status: text(li.querySelector('.question-status')), text: li.textContent})) : [],
    thread: seen(th) ? {id: th.dataset.id, state: th.dataset.state, status: text(part('status')), meta: text(part('meta')),
      load: box(part('state')), entries: [...part('entries').children].map(li => ({seq: li.dataset.seq, kind: li.dataset.kind,
        lines: [...li.querySelectorAll(':scope > p')].map(p => p.textContent)})), closedNote: seen(part('closed'))} : null,
    composers: [...th.querySelectorAll('.question-compose')].map(w => { const f = w.querySelector('[data-field]');
      return {action: w.dataset.action, state: w.dataset.state, hidden: !seen(w), value: f.value, readOnly: f.readOnly,
        send: !w.querySelector('[data-send]').disabled, retry: seen(w.querySelector('[data-retry]')),
        discard: seen(w.querySelector('[data-discard]'))}; }),
    notes: [...th.querySelectorAll('[data-note-key]')].filter(seen).map(b => ({state: b.dataset.state,
      text: text(b.querySelector('.question-text')), detail: text(b.querySelector('.question-detail'))})),
    inboxLine: box(document.querySelector('#question-inbox-state')),
    inboxItems: seen(document.querySelector('#question-inbox-list')) ? [...document.querySelectorAll('#question-inbox-list > li')].map(li => {
      const b = li.querySelector('button'); return {id: li.dataset.id, uid: li.dataset.uid, text: li.textContent, open: !b.disabled, title: b.title}; }) : [],
    more: seen(document.querySelector('#question-inbox-more'))}; }"""

# Every text node's own element and every title / aria-label under a root (tooltips are explanations too).
TEXTS = """(selector) => { const root = document.querySelector(selector), out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) { const n = walker.currentNode, p = n.parentElement, t = n.textContent.trim();
    if (t && p && !p.closest('[hidden]') && p.getClientRects().length)
      out.push({text: t, tag: p.tagName, cls: String(p.className || ''), size: parseFloat(getComputedStyle(p).fontSize)}); }
  for (const e of root.querySelectorAll('[title], [aria-label]')) for (const a of ['title', 'aria-label'])
    if (e.hasAttribute(a) && e.getAttribute(a)) out.push({text: e.getAttribute(a), tag: e.tagName + '@' + a, cls: '', size: null});
  return out; }"""
TARGETS = """(selector) => [...document.querySelectorAll(selector)].filter(e => e.getClientRects().length && !e.closest('[hidden]'))
  .map(e => { const r = e.getBoundingClientRect(); return [e.tagName, e.textContent.trim(), r.width, r.height]; })"""
ACTIVE = """() => { const e = document.activeElement; return {id: e.id || null, tag: e.tagName, text: (e.textContent || '').trim(),
  send: e.dataset && 'send' in e.dataset, open: e.dataset && 'openThread' in e.dataset}; }"""
PENDING_VIEW = """() => { const box = document.querySelector('#question-pending'); if (!box) return null;
  return {shown: !box.closest('[hidden]'), text: document.querySelector('#question-pending-text').textContent,
    rows: [...document.querySelectorAll('#question-pending-list > li')].map(li => ({id: li.dataset.id, state: li.dataset.state,
      status: li.querySelector('.status').textContent, text: li.textContent}))}; }"""
CLOSED_VIEW = """() => ({children: [...document.body.children].map(e => `${e.tagName}@${e.getAttribute('role')}`),
  text: document.body.textContent})"""


def b64(value):
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")


class QuestionServer:
    """The S5-U4a service rules the two screens rely on, over an in-memory store (clinician-question.service.ts)."""

    MESSAGES = {
        "QUESTION_ROLE_REQUIRED": (403, "이 질문 동작에 필요한 역할이 없습니다"),
        "QUESTION_ACTION_FORBIDDEN": (403, "이 질문에 이 동작을 할 수 없습니다"),
        "STUDY_NOT_FOUND": (404, "검사를 찾을 수 없습니다"),
        "QUESTION_NOT_FOUND": (404, "질문을 찾을 수 없습니다"),
        "OWNER_CHANGED": (409, "로그인한 계정이 바뀌었습니다. 화면을 다시 불러오세요"),
        "REQUEST_ID_REUSED": (409, "다른 내용에 이미 쓰인 요청 ID입니다. 질문을 다시 불러오세요"),
        "QUESTION_CHANGED": (409, "질문이 변경되었습니다. 다시 불러온 뒤 확인하세요"),
        "QUESTION_CLOSED": (409, "닫힌 질문에는 더 쓸 수 없습니다"),
        "QUESTION_INPUT_INVALID": (400, "질문 요청의 형식을 확인하세요"),
        "QUESTION_BUSY": (503, "질문 처리 중입니다. 같은 요청으로 다시 시도하세요"),
        "STUDY_ACCESS_CHANGED": (409, "요청 중 접근 조건이 바뀌었습니다"),
    }

    def __init__(self, owned):
        self.owned = set(owned)
        self.threads = {}
        self.receipts = {}
        self.current = {}
        self.clock = 0

    @classmethod
    def error(cls, code, message=None):
        status, text = cls.MESSAGES[code]
        return status, {"code": code, "message": message or text}

    def at(self):
        self.clock += 1
        return f"2026-09-26T{self.clock // 60:02d}:{self.clock % 60:02d}:00.000Z"

    def anchor(self, u):
        return dict(self.current.get(u, {"rs": "W", "version": None}))

    @staticmethod
    def person(caller):
        return {"sub": caller["sub"], "actor": caller["actor"], "name": caller["displayName"]}

    def entry(self, eid, seq, kind, person, role, body, u, at):
        return {"id": eid, "seq": seq, "kind": kind, "body": body,
                "author": {"actor": person["actor"], "name": person["name"], "role": role}, "at": at, "reportAnchor": self.anchor(u)}

    def seed(self, u, person, body, qid=None):
        qid = qid or str(uuid.uuid4())
        at = self.at()
        thread = {"id": qid, "studyUid": u, "institution": INSTITUTION, "authorSub": person["sub"],
                  "author": {"actor": person["actor"], "name": person["name"]}, "state": "Open", "revision": 1,
                  "entries": [self.entry(qid, 1, "question", person, "clinician", body, u, at)], "createdAt": at, "updatedAt": at,
                  "closed": None}
        self.threads[qid] = thread
        return thread

    def step(self, thread, kind, person, role, body, eid=None):
        at, seq, before = self.at(), thread["revision"] + 1, thread["state"]
        thread["entries"].append(self.entry(eid or str(uuid.uuid4()), seq, kind, person, role, body, thread["studyUid"], at))
        thread["state"] = {"answer": "Answered", "followup": "Open", "close": "Closed"}[kind]
        thread["revision"], thread["updatedAt"] = seq, at
        if kind == "close":
            thread["closed"] = {"at": at, "by": {"actor": person["actor"], "name": person["name"], "role": role}}
        return before, at

    @staticmethod
    def summary(thread):
        return {"id": thread["id"], "studyUid": thread["studyUid"], "state": thread["state"], "revision": thread["revision"],
                "author": dict(thread["author"]), "entryCount": len(thread["entries"]), "lastEntryAt": thread["entries"][-1]["at"],
                "createdAt": thread["createdAt"], "updatedAt": thread["updatedAt"]}

    def dto(self, thread):
        return {**self.summary(thread), "closed": copy.deepcopy(thread["closed"]), "entries": copy.deepcopy(thread["entries"]),
                "current": self.anchor(thread["studyUid"])}

    @staticmethod
    def scope(caller):
        roles = caller["roles"]
        return "all" if "radiologist" in roles or "admin" in roles else "own" if "clinician" in roles else None

    def visible(self, caller, qid, scope):
        thread = self.threads.get(qid.lower())
        if (not thread or thread["institution"] != caller["institution"] or thread["studyUid"] not in self.owned
                or (scope == "own" and thread["authorSub"] != caller["sub"])):
            return None
        return thread

    def newest(self, rows):
        return sorted(rows, key=lambda t: (t["createdAt"], t["id"]), reverse=True)

    @staticmethod
    def text_ok(value):
        return isinstance(value, str) and value.strip() != "" and len(value) <= 2000 and not CONTROL.search(value)

    def replay(self, rid, mark, qid, owner):
        receipt = self.receipts[rid]
        if receipt["fingerprint"] != mark or receipt["questionId"] != qid:
            return self.error("REQUEST_ID_REUSED")
        return 201, {"owner": owner, "applied": copy.deepcopy(receipt["applied"]), "replayed": True}

    def handle(self, caller, method, path, query, body):
        owner = [caller["institution"], caller["sub"]]
        found = re.fullmatch(r"/api/studies/([^/]+)/questions", path)
        if found:
            u = unquote(found.group(1))
            return self.for_study(caller, owner, u) if method == "GET" else self.create(caller, owner, u, body)
        found = re.fullmatch(r"/api/questions/([^/]+)/(entries|close)", path)
        if found and method == "POST":
            return self.change(caller, owner, unquote(found.group(1)), found.group(2), body)
        found = re.fullmatch(r"/api/questions/([^/]+)", path)
        if found and method == "GET":
            return self.read(caller, owner, unquote(found.group(1)))
        if path == "/api/questions" and method == "GET":
            return self.inbox(caller, owner, query)
        raise AssertionError(f"no question route for {method} {path}")

    def for_study(self, caller, owner, u):
        scope = self.scope(caller)
        if scope is None:
            return self.error("QUESTION_ROLE_REQUIRED")
        if u not in self.owned:
            return self.error("STUDY_NOT_FOUND")
        rows = [t for t in self.threads.values() if t["studyUid"] == u and (scope == "all" or t["authorSub"] == caller["sub"])]
        return 200, {"owner": owner, "items": [self.summary(t) for t in self.newest(rows)[:50]]}

    def read(self, caller, owner, qid):
        scope = self.scope(caller)
        if scope is None:
            return self.error("QUESTION_ROLE_REQUIRED")
        thread = self.visible(caller, qid, scope)
        return (200, {"owner": owner, "item": self.dto(thread)}) if thread else self.error("QUESTION_NOT_FOUND")

    def inbox(self, caller, owner, query):
        if set(query) - {"view", "state", "cursor"} or any(len(v) != 1 for v in query.values()) or query.get("view") != ["inbox"]:
            return self.error("QUESTION_INPUT_INVALID")
        if "radiologist" not in caller["roles"] and "admin" not in caller["roles"]:
            return self.error("QUESTION_ROLE_REQUIRED")
        state = query.get("state", ["all"])[0]
        if state not in ("open", "answered", "closed", "all"):
            return self.error("QUESTION_INPUT_INVALID")
        rows = self.newest([t for t in self.threads.values() if t["institution"] == caller["institution"]
                            and t["studyUid"] in self.owned and (state == "all" or t["state"].lower() == state)])
        start = 0
        if "cursor" in query:
            try:
                start = json.loads(base64.urlsafe_b64decode(query["cursor"][0] + "==").decode())["i"]
            except Exception:
                return self.error("QUESTION_INPUT_INVALID")
        page = rows[start:start + 50]
        following = b64({"at": page[-1]["createdAt"], "i": start + 50, "r": 0}) if start + 50 < len(rows) else None
        return 200, {"owner": owner, "items": [self.summary(t) for t in page], "nextCursor": following}

    def create(self, caller, owner, u, body):
        if "clinician" not in caller["roles"]:
            return self.error("QUESTION_ROLE_REQUIRED")
        if (not isinstance(body, dict) or set(body) != {"requestId", "expectedOwner", "body"}
                or not SERVICE_UUID.match(str(body.get("requestId"))) or not self.text_ok(body.get("body"))):
            return self.error("QUESTION_INPUT_INVALID", "요청 ID와 1~2,000자의 질문을 입력하세요")
        if body["expectedOwner"] != owner:
            return self.error("OWNER_CHANGED")
        if u not in self.owned:
            return self.error("STUDY_NOT_FOUND")
        rid = body["requestId"].lower()
        mark = json.dumps([u, caller["institution"], caller["sub"], body["body"]])
        if rid in self.receipts:
            return self.replay(rid, mark, rid, owner)
        thread = self.seed(u, self.person(caller), body["body"], rid)
        applied = {"id": rid, "studyUid": u, "requestId": rid, "action": "create", "entry": {"id": rid, "seq": 1, "kind": "question"},
                   "from": None, "to": "Open", "revision": 1, "at": thread["createdAt"]}
        self.receipts[rid] = {"questionId": rid, "fingerprint": mark, "applied": applied}
        return 201, {"owner": owner, "applied": copy.deepcopy(applied), "replayed": False}

    def change(self, caller, owner, qid, route, body):
        roles, reply = caller["roles"], route == "entries"
        allowed = ("clinician", "radiologist") if reply else ("clinician", "radiologist", "admin")
        if not any(role in roles for role in allowed):
            return self.error("QUESTION_ROLE_REQUIRED")
        field = "body" if reply else "note"
        if (not isinstance(body, dict) or set(body) != {"requestId", "expectedOwner", "revision", field}
                or not SERVICE_UUID.match(str(body.get("requestId"))) or not isinstance(body.get("revision"), int)
                or body["revision"] < 1 or not (self.text_ok(body.get(field)) or (not reply and body.get(field) == ""))):
            return self.error("QUESTION_INPUT_INVALID")
        if body["expectedOwner"] != owner:
            return self.error("OWNER_CHANGED")
        thread = self.visible(caller, qid, self.scope(caller))
        if thread is None:
            return self.error("QUESTION_NOT_FOUND")
        rid = body["requestId"].lower()
        mark = json.dumps([thread["id"], caller["institution"], caller["sub"], body["revision"], "reply" if reply else "close",
                           body[field]])
        if rid in self.receipts:
            return self.replay(rid, mark, thread["id"], owner)
        if thread["revision"] != body["revision"]:
            return self.error("QUESTION_CHANGED")
        if thread["state"] == "Closed":
            return self.error("QUESTION_CLOSED")
        author = thread["authorSub"] == caller["sub"]
        if reply:
            if author and "clinician" not in roles or not author and "radiologist" not in roles:
                return self.error("QUESTION_ACTION_FORBIDDEN")
            kind, role = ("followup", "clinician") if author else ("answer", "radiologist")
        elif author and "clinician" in roles:
            kind, role = "close", "clinician"
        elif not author and ("radiologist" in roles or "admin" in roles):
            if body["note"] == "":
                return self.error("QUESTION_INPUT_INVALID", "작성자가 아닌 사람이 질문을 닫을 때는 사유를 입력하세요")
            kind, role = "close", "radiologist" if "radiologist" in roles else "admin"
        else:
            return self.error("QUESTION_ACTION_FORBIDDEN")
        before, at = self.step(thread, kind, self.person(caller), role, body[field], rid)
        applied = {"id": thread["id"], "studyUid": thread["studyUid"], "requestId": rid, "action": kind,
                   "entry": {"id": rid, "seq": thread["revision"], "kind": kind}, "from": before, "to": thread["state"],
                   "revision": thread["revision"], "at": at}
        self.receipts[rid] = {"questionId": thread["id"], "fingerprint": mark, "applied": applied}
        return 201, {"owner": owner, "applied": copy.deepcopy(applied), "replayed": False}


def kind_of(method, path):
    if re.fullmatch(r"/api/studies/[^/]+/questions", path):
        return "list" if method == "GET" else "create"
    if re.fullmatch(r"/api/questions/[^/]+/entries", path):
        return "reply"
    if re.fullmatch(r"/api/questions/[^/]+/close", path):
        return "close"
    if re.fullmatch(r"/api/questions/[^/]+", path):
        return "thread"
    if path == "/api/questions":
        return "inbox"
    return None


def bump_revision(payload):
    payload["applied"]["revision"] += 1
    payload["applied"]["entry"]["seq"] += 1


def flip_from(payload):
    payload["applied"]["from"] = "Answered" if payload["applied"]["from"] == "Open" else "Open"


# Astra S5-U4b-R-001 F4: answers to a Reply that the server applied, each changed in one way that makes it not this
# request's QuestionApplied (contract §3.4, §5.1). (name, fault fields, the unknown note's second line).
REPLY_ENVELOPES = [
    ("HTTP 200", {"http": 200}, "HTTP 200"),
    ("HTTP 202", {"http": 202}, "HTTP 202"),
    ("no entry", {"patch": lambda p: p["applied"].pop("entry")}, ""),
    ("no from", {"patch": lambda p: p["applied"].pop("from")}, ""),
    ("no revision", {"patch": lambda p: p["applied"].pop("revision")}, ""),
    ("no at", {"patch": lambda p: p["applied"].pop("at")}, ""),
    ("action close", {"patch": lambda p: p["applied"].update(action="close")}, ""),
    ("to Closed", {"patch": lambda p: p["applied"].update(to="Closed")}, ""),
    ("entry kind", {"patch": lambda p: p["applied"]["entry"].update(kind="question")}, ""),
    ("entry id", {"patch": lambda p: p["applied"]["entry"].update(id=str(uuid.uuid4()))}, ""),
    ("entry seq", {"patch": lambda p: p["applied"]["entry"].update(seq=p["applied"]["entry"]["seq"] + 1)}, ""),
    ("revision", {"patch": bump_revision}, ""),
    # Open and Answered are both possible before a reply; only the state the request was sent from is this request's.
    ("from", {"patch": flip_from}, ""),
]
ASK_ENVELOPES = [
    ("HTTP 202", {"http": 202}, "HTTP 202"),
    ("revision", {"patch": bump_revision}, ""),
    ("from", {"patch": lambda p: p["applied"].update({"from": "Open"})}, ""),
    ("id", {"patch": lambda p: p["applied"].update(id=str(uuid.uuid4()))}, ""),
]


class ClinicianQuestionDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        home = SHIPPED["clinician.js"]
        # The fresh check with only the selected study in it, for the list's late answers.
        cls.home_uid_only = variant(home, [
            ("    return !leaving && questionLock === null && epoch === questionEpoch && selected === uid;\n",
             "    return selected === uid;\n", 1),
            ("mine !== questionListSeq", "false", 2)], "clinician.js")
        cls.reader_uid_only = variant(READER_BLOCK, [
            ("      const fresh = (era, target) => !ended && lock === null && era === epoch && target === uid;\n",
             "      const fresh = (era, target) => target === uid;\n", 1),
            ("mine !== listSeq", "false", 2)], "main.html S5-U4b block")
        # F2 control: a late Ask opens its thread whenever the same study is still selected and the section open.
        cls.home_ask_any_screen = variant(home, [
            ("      if (attempt.action === 'ask' && epoch === questionEpoch && pick === questionPick) pickQuestionThread(sent.body.applied.id);\n",
             "      if (attempt.action === 'ask') pickQuestionThread(sent.body.applied.id);\n", 1)], "clinician.js")
        # F1 control: a 401 only starts the logout and leaves the row's end to auth.js's broadcast after the logout POST.
        cls.reader_end_on_broadcast = variant(READER_BLOCK, [
            ("        end();\n        (window.kinOn401 || []).forEach(done => { try { done(); } catch (_) {} });\n        logout();\n",
             "        logout();\n", 1)], "main.html S5-U4b block")
        # B-R-001 F2 control: the open thread is dropped when the latest-50 list lacks it (the file before fix2).
        cls.home_list_membership = variant(home, [
            ("    if (questionThread !== null) loadQuestionThread(uid, questionThread);\n    else hideQuestionThread();\n",
             "    if (questionThread !== null && items.some(item => item.id === questionThread)) loadQuestionThread(uid, questionThread);\n"
             "    else {\n      pickQuestionThread(null);\n      hideQuestionThread();\n    }\n", 1)], "clinician.js")
        # C-R-001 F1 control: no pending rows (the file before fix3 had no way back to a thread outside the list).
        cls.home_no_pending = variant(home, [
            ("    box.hidden = threads.size === 0;\n", "    box.hidden = true;\n", 1)], "clinician.js")
        # B-R-001 F1 controls: api() and the Log out handler without the end-list call.
        cls.api_without_list = variant(API_FN, [(HOOK_401, "", 1)], "main.html api()")
        cls.log_out_hook = slice_between(LOG_OUT_HANDLER, HOOK_LOG_OUT[0], "      try {\n")
        cls.log_out_without_list = variant(LOG_OUT_HANDLER, [(cls.log_out_hook, "", 1)], "main.html Log out handler")
        cls.reader_page = page_html(MAIN)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.server = QuestionServer([A, B, C])
        self.me = me(CLINICIAN, ["clinician", "default-roles-kin"])
        self.rows = copy.deepcopy(CLINICIAN_ROWS)
        self.files = dict(SHIPPED)
        self.faults = []
        self.holding = set()
        self.held = []
        self.q_requests = []
        self.logouts = []
        self.held_logouts = None
        # Answers for other API routes of the page, by (method, path): the F1 cases' report save.
        self.plain = {}
        self.envelope_owner = None
        self.unexpected, self.errors, self.dialogs, self.finished = [], [], [], []
        self.context = self.browser.new_context(viewport={"width": 1366, "height": 900}, timezone_id="Asia/Seoul", locale="ko-KR")
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
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
            if name == "index.html":
                route.fulfill(body=INDEX_STAND_IN, content_type="text/html; charset=utf-8")
                return
            if name == "blank.html":
                route.fulfill(body=BLANK, content_type="text/html; charset=utf-8")
                return
            if name == "main.html":
                route.fulfill(body=self.reader_page, content_type="text/html; charset=utf-8")
                return
            if name in self.files:
                kind = "text/html" if name.endswith(".html") else "application/javascript"
                route.fulfill(body=self.files[name], content_type=f"{kind}; charset=utf-8")
                return
            if name == "kin-emblem-j1.svg":
                route.fulfill(body=EMBLEM, content_type="image/svg+xml")
                return
            # main.html's own images and icons: not part of either screen under test.
            route.fulfill(status=404, body="")
            return
        if path.startswith("/kin-brand/") or path == "/favicon.ico":
            route.fulfill(status=404, body="")
            return
        if path.startswith("/api/") and request.headers.get("x-kin-csrf") != "1":
            self.unexpected.append(f"{method} {path} without X-KIN-CSRF")
            route.abort()
            return
        if method == "GET" and path == "/api/me":
            route.fulfill(json=self.me)
            return
        query = parse_qs(url.query, keep_blank_values=True)
        if method == "GET" and path == "/api/clinician/studies":
            ordered = sorted(self.rows, key=lambda row: row["uid"])
            route.fulfill(json={"studies": copy.deepcopy(ordered), "serverTime": "2026-09-26T00:00:00.000Z",
                                "pagination": {"next": None, "total": len(ordered), "offset": 0, "limit": 100}})
            return
        found = re.fullmatch(r"/api/clinician/studies/([^/]+)/report", path)
        if method == "GET" and found:
            target = unquote(found.group(1))
            route.fulfill(json={"uid": target, "report": {"final": False, "rs": "P"}, "keys": None})
            return
        if method == "POST" and path == "/api/auth/logout":
            self.logouts.append(request.headers.get("x-kin-csrf"))
            if self.held_logouts is not None:
                self.held_logouts.append(route)
                return
            route.fulfill(status=204, body="")
            return
        if (method, path) in self.plain:
            status, payload = self.plain[(method, path)]
            route.fulfill(status=status, json=payload)
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
        self.q_requests.append({"kind": kind, "method": method, "path": path, "query": query, "body": copy.deepcopy(body)})
        fault = next((f for f in self.faults if f["kind"] == kind), None)
        if fault is not None:
            self.faults.remove(fault)
        answer = None
        if fault is None or fault.get("apply"):
            answer = self.server.handle(self.me, method, path, query, body)
        if fault is not None and "status" in fault:
            answer = (fault["status"], fault["body"])
        if fault is not None and "patch" in fault:
            status, payload = answer
            payload = copy.deepcopy(payload)
            fault["patch"](payload)
            answer = (status, payload)
        if fault is not None and "http" in fault:
            answer = (fault["http"], answer[1])
        if self.envelope_owner is not None and answer is not None and isinstance(answer[1], dict) and "owner" in answer[1]:
            answer = (answer[0], {**answer[1], "owner": self.envelope_owner})
        abort = fault is not None and fault.get("abort")
        if kind in self.holding:
            self.held.append({"kind": kind, "route": route, "answer": answer, "abort": abort, "path": path})
            return
        self.answer(route, answer, abort)

    @staticmethod
    def answer(route, answer, abort=False):
        if abort:
            route.abort("connectionreset")
        else:
            route.fulfill(status=answer[0], json=answer[1])

    # ── helpers ──
    def wait_until(self, predicate, what, timeout=10.0):
        # Sync-API route handlers run on this thread while wait_for_timeout blocks.
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail(f"{what}: not observed within {timeout:.0f}s")
            self.page.wait_for_timeout(10)

    def settle(self, page=None):
        (page or self.page).evaluate("() => new Promise(resolve => setTimeout(resolve, 150))")

    def release(self, held):
        request = held["route"].request
        self.answer(held["route"], held["answer"], held["abort"])
        self.wait_until(lambda: any(item is request for item in self.finished), "the released answer reaching the page")
        self.settle()

    def release_after_end(self, held):
        """Answer a request that the row's end() may already have aborted; the page then has nothing to receive."""
        try:
            self.answer(held["route"], held["answer"], held["abort"])
        except PlaywrightError:
            pass
        self.settle()

    def take(self, kind, count=1):
        self.wait_until(lambda: len([h for h in self.held if h["kind"] == kind]) >= count, f"{count} held {kind} request(s)")
        picked = [h for h in self.held if h["kind"] == kind][:count]
        for h in picked:
            self.held.remove(h)
        return picked

    def requests(self, kind=None):
        return [r for r in self.q_requests if kind is None or r["kind"] == kind]

    # Clinician Home
    def open_home(self, script=None):
        self.files["clinician.js"] = SHIPPED["clinician.js"] if script is None else script
        self.page.goto(ORIGIN + BASE + "clinician.html")
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "ready")
        expect(self.page.locator("#studies tr[data-uid]")).to_have_count(len(self.rows))

    def pick(self, u):
        self.page.locator(f'#studies tr[data-uid="{u}"]').click()
        expect(self.page.locator("#detail")).to_have_attribute("data-uid", u)
        expect(self.page.locator("#report-state")).not_to_have_attribute("data-state", "loading")

    def view(self):
        return self.page.evaluate(CLINICIAN_VIEW)

    def open_questions(self, state="empty"):
        self.page.locator("#questions-summary").click()
        return self.listed(state)

    def listed(self, state):
        expect(self.page.locator("#questions-state")).to_have_attribute("data-state", state)
        return self.view()

    def open_thread(self, qid, state=None):
        self.page.locator(f'#question-list > li[data-id="{qid}"] button[data-open-thread]').click()
        return self.threaded(qid, state)

    def threaded(self, qid, state=None):
        expect(self.page.locator("#question-thread")).to_have_attribute("data-id", qid)
        if state:
            expect(self.page.locator("#question-thread")).to_have_attribute("data-state", state)
        return self.view()

    def write(self, action, text, press=True):
        field = self.page.locator(f"#question-{action}-text")
        field.fill(text)
        if press:
            self.page.locator(f'.question-compose[data-action="{action}"] button[data-send]').click()

    def settled_note(self, state, scope="#questions"):
        expect(self.page.locator(f"{scope} [data-note-key]:not([hidden])").first).to_have_attribute("data-state", state)

    # Reading screen
    def open_reader(self, session, studies=None, block=None, real_auth=False, extra=""):
        self.me = session
        self.page.goto(ORIGIN + BASE + "main.html")
        self.page.evaluate(READER_SETUP.replace("SYN_STUDIES", json.dumps(studies or READER_STUDIES)),
                           {**session, "state": "approved"})
        if real_auth:
            # The shipped auth.js in place of the stand-in; its session comes from GET /api/me (self.me).
            self.page.add_script_tag(content=SHIPPED["auth.js"])
            self.assertEqual("approved", self.page.evaluate("async () => (await KinAuth.init()).state"))
        prelude = READER_PRELUDE.replace("KIN_AUTH\n", "" if real_auth else READER_STAND_IN + "\n")
        self.page.add_script_tag(content=prelude + (block or READER_BLOCK) + extra + "\nwindow.synPick = uid => select(uid);\n")
        self.assertEqual([], self.page.evaluate("() => window.synToasts"), "the block mounted")

    def target(self, u):
        self.page.evaluate("u => window.synPick(u)", u)
        self.settle()

    def reader(self):
        return self.page.evaluate(READER_VIEW)

    def reader_state(self, state):
        expect(self.page.locator("#question-p")).to_have_attribute("data-state", state)
        return self.reader()

    def reader_thread(self, qid, state):
        self.page.locator(f'#question-list > li[data-id="{qid}"] button[data-open-thread]').click()
        expect(self.page.locator("#question-thread")).to_have_attribute("data-state", state)
        expect(self.page.locator("#question-thread")).to_have_attribute("data-id", qid)
        return self.reader()

    def reader_write(self, action, text, press=True):
        self.page.locator(f"#question-{action}-text").fill(text)
        if press:
            self.page.locator(f'#question-thread .question-compose[data-action="{action}"] button[data-send]').click()

    def reader_note(self, state):
        expect(self.page.locator("#question-thread [data-note-key]:not([hidden])").first).to_have_attribute("data-state", state)
        return self.reader()

    def seed_threads(self):
        """A: an Open thread, an Answered thread whose answer was written at Preliminary v1 (now Approved v2), a Closed one."""
        server = self.server
        server.current[A] = {"rs": "P", "version": 1}
        closed = server.seed(A, CLINICIAN, "SYN closed question")
        server.step(closed, "close", CLINICIAN, "clinician", "")
        answered = server.seed(A, CLINICIAN, "SYN answered question\nsecond line")
        server.step(answered, "answer", RADIOLOGIST, "radiologist", "SYN answer " + HOSTILE)
        server.current[A] = {"rs": "A", "version": 2}
        opened = server.seed(A, CLINICIAN, "SYN open question")
        return opened, answered, closed

    # ── Clinician Home cases ──
    def test_01_closed_section_reads_nothing_and_ask_creates_a_thread(self):
        self.open_home()
        for u in (A, B, A):
            self.pick(u)
            seen = self.view()
            self.assertEqual((u, False, "closed", False, [], []),
                             (seen["uid"], seen["open"], seen["state"], seen["body"], seen["buttons"], seen["headings"]))
        summary = self.page.locator("#questions-summary")
        self.assertEqual(("Questions", "이 검사에 대한 질문과 답변을 엽니다. 연 뒤에만 서버에서 읽습니다."),
                         (summary.text_content(), summary.get_attribute("title")))
        # After Key Images, the viewer line and the comparison place: the section is the last of the detail panel.
        self.assertEqual("questions", self.page.evaluate("() => document.querySelector('#detail').lastElementChild.id"))
        self.settle()
        self.assertEqual([], self.requests(), "selecting studies reads no question until the section is opened")

        seen = self.open_questions("empty")
        self.assertEqual([("list", "GET", f"/api/studies/{A}/questions")], [(r["kind"], r["method"], r["path"]) for r in self.requests()])
        self.assertEqual(({"state": "empty", "role": "status", "text": C_EMPTY, "detail": "", "retry": False}, [], None),
                         (seen["list"], seen["items"], seen["thread"]))
        self.assertEqual([{"action": "ask", "state": "idle", "hidden": False, "value": "", "readOnly": False, "send": True,
                           "retry": False, "discard": False}], seen["composers"])

        self.write("ask", "SYN first question\n" + HOSTILE)
        self.settled_note("saved")
        posts = self.requests("create")
        self.assertEqual(1, len(posts))
        sent = posts[0]["body"]
        self.assertEqual(["body", "expectedOwner", "requestId"], sorted(sent))
        self.assertRegex(sent["requestId"], UUID_V4)
        self.assertEqual(([INSTITUTION, CLINICIAN["sub"]], "SYN first question\n" + HOSTILE), (sent["expectedOwner"], sent["body"]))
        qid = sent["requestId"]
        # The new thread opens from a fresh read of the list and the thread, not from the write's answer.
        seen = self.threaded(qid, "Open")
        self.assertEqual(["list", "create", "list", "thread"], [r["kind"] for r in self.requests()])
        self.assertEqual([(qid, "true", "Open")], [(i["id"], i["current"], i["status"]) for i in seen["items"]])
        self.assertEqual({"id": qid, "state": "Open", "status": "Open", "meta": "2026-09-26 09:01 등록 · 작성 SYN Clinician", "load": None,
                          "entries": [{"seq": "1", "kind": "question",
                                       "lines": ["Question · SYN Clinician (Clinician) · 2026-09-26 09:01", "SYN first question\n" + HOSTILE]}],
                          "closedNote": False}, seen["thread"])
        self.assertEqual([{"state": "saved", "text": SAVED, "detail": ""}], [n for n in seen["notes"]])
        self.assertEqual(C_READY.format(n=1), seen["list"]["text"])
        ask = next(c for c in seen["composers"] if c["action"] == "ask")
        self.assertEqual(("", False, True), (ask["value"], ask["readOnly"], ask["send"]))
        self.assertIsNone(self.page.evaluate("() => document.body.dataset.pwned ?? null"))

        # Opened once, the section opens for the next study too and reads it. Unsent text stays with its own study.
        self.write("ask", "SYN unsent text for A", press=False)
        self.pick(B)
        seen = self.listed("empty")
        self.assertEqual((B, True, None, ""), (seen["uid"], seen["open"], seen["thread"], seen["composers"][0]["value"]))
        self.assertEqual(f"/api/studies/{B}/questions", self.requests()[-1]["path"])
        self.write("ask", "SYN unsent text for B", press=False)
        self.pick(A)
        self.assertEqual("SYN unsent text for A", self.listed("ready")["composers"][0]["value"])
        self.pick(B)
        self.assertEqual("SYN unsent text for B", self.listed("empty")["composers"][0]["value"])
        # Closed, it reads nothing and holds no control.
        self.page.locator("#questions-summary").click()
        expect(self.page.locator("#questions-body")).to_have_count(0)
        count = len(self.requests())
        self.pick(A)
        self.settle()
        seen = self.view()
        self.assertEqual((False, False, []), (seen["open"], seen["body"], seen["buttons"]))
        self.assertEqual(count, len(self.requests()))

    def test_02_thread_states_followup_close_and_report_anchor(self):
        opened, answered, closed = self.seed_threads()
        self.open_home()
        self.pick(A)
        seen = self.open_questions("ready")
        self.assertEqual(C_READY.format(n=3), seen["list"]["text"])
        self.assertEqual([(opened["id"], "Open"), (answered["id"], "Answered"), (closed["id"], "Closed")],
                         [(i["id"], i["status"]) for i in seen["items"]])
        self.assertEqual("Answered 2026-09-26 09:03 등록 · 항목 2개 · 최근 2026-09-26 09:04 Open Thread", seen["items"][1]["text"])

        seen = self.open_thread(answered["id"], "Answered")
        self.assertEqual([{"seq": "1", "kind": "question",
                           "lines": ["Question · SYN Clinician (Clinician) · 2026-09-26 09:03", "SYN answered question\nsecond line"]},
                          {"seq": "2", "kind": "answer",
                           "lines": ["Answer · SYN Radiologist (Radiologist) · 2026-09-26 09:04", "SYN answer " + HOSTILE,
                                     ANCHOR_CHANGED + " 답변 때 Preliminary · Version 1 → 지금 Approved · Version 2"]}],
                         seen["thread"]["entries"])
        self.assertEqual(["reply", "close"], [c["action"] for c in seen["composers"] if c["action"] != "ask"])

        # Follow-up: the author's reply posts the thread's current revision; the server makes it a follow-up (Open again).
        self.write("reply", "SYN follow-up")
        self.settled_note("saved")
        reply = self.requests("reply")[-1]
        self.assertEqual((f"/api/questions/{answered['id']}/entries", ["body", "expectedOwner", "requestId", "revision"], 2,
                          [INSTITUTION, CLINICIAN["sub"]], "SYN follow-up"),
                         (reply["path"], sorted(reply["body"]), reply["body"]["revision"], reply["body"]["expectedOwner"], reply["body"]["body"]))
        self.assertRegex(reply["body"]["requestId"], UUID_V4)
        seen = self.threaded(answered["id"], "Open")
        self.assertEqual(["question", "answer", "followup"], [e["kind"] for e in seen["thread"]["entries"]])
        self.assertEqual("Follow-up · SYN Clinician (Clinician) · 2026-09-26 09:06", seen["thread"]["entries"][2]["lines"][0])
        # The follow-up was written at the current report state, so only the old answer carries the note.
        self.assertEqual(2, len(seen["thread"]["entries"][2]["lines"]))

        # The author closes without a reason; the next post carries the new revision and a new requestId.
        self.write("close", "")
        expect(self.page.locator("#question-thread")).to_have_attribute("data-state", "Closed")
        close = self.requests("close")[-1]
        self.assertEqual((3, "", ["expectedOwner", "note", "requestId", "revision"]),
                         (close["body"]["revision"], close["body"]["note"], sorted(close["body"])))
        self.assertNotEqual(reply["body"]["requestId"], close["body"]["requestId"])
        seen = self.view()
        self.assertEqual(("Closed", True, [True, True]),
                         (seen["thread"]["status"], seen["thread"]["closedNote"],
                          [c["hidden"] for c in seen["composers"] if c["action"] != "ask"]))
        self.assertEqual(["Close · SYN Clinician (Clinician) · 2026-09-26 09:07", CLOSE_EMPTY], seen["thread"]["entries"][3]["lines"])
        self.assertEqual(C_CLOSED_NOTE, self.page.locator("#question-closed-note").text_content())
        seen = self.open_thread(closed["id"], "Closed")
        self.assertEqual((True, [True, True]), (seen["thread"]["closedNote"],
                                               [c["hidden"] for c in seen["composers"] if c["action"] != "ask"]))

    def test_03_read_failures_and_write_refusals_are_shown_with_their_code(self):
        opened, answered, _ = self.seed_threads()
        self.open_home()
        # A tele study: the server answers 404 (questions stay in the owning institution); failed, with Retry and no Ask.
        self.pick(T)
        seen = self.open_questions("failed")
        self.assertEqual({"state": "failed", "role": "status", "text": C_FAILED,
                          "detail": C_NOT_FOUND + "\n검사를 찾을 수 없습니다 (HTTP 404 · STUDY_NOT_FOUND)", "retry": True}, seen["list"])
        self.assertEqual(("failed", [], True), (seen["state"], seen["items"], seen["composers"][0]["hidden"]))
        # A 500 is a failure too, not an empty list; Retry reads again.
        self.faults.append({"kind": "list", "status": 500, "body": {"message": "SYN list failure"}})
        self.pick(A)
        seen = self.listed("failed")
        self.assertEqual((C_FAILED, "SYN list failure (HTTP 500)", True, []),
                         (seen["list"]["text"], seen["list"]["detail"], seen["list"]["retry"], seen["items"]))
        self.page.locator("#questions-retry").click()
        self.listed("ready")
        self.open_thread(opened["id"], "Open")
        # Blank text: refused on the page, nothing is sent.
        self.write("reply", "   ")
        self.settled_note("failed")
        self.assertEqual([{"state": "failed", "text": NO_TEXT, "detail": ""}], self.view()["notes"])
        self.assertEqual([], self.requests("reply"))

        # A real concurrent answer: the post carries revision 1, the server is at 2.
        self.server.step(opened, "answer", RADIOLOGIST, "radiologist", "SYN concurrent answer")
        self.write("reply", "SYN my follow-up")
        self.settled_note("failed")
        seen = self.threaded(opened["id"], "Answered")
        self.assertEqual([{"state": "failed", "text": CODES["QUESTION_CHANGED"],
                           "detail": "질문이 변경되었습니다. 다시 불러온 뒤 확인하세요 (HTTP 409 · QUESTION_CHANGED)"}], seen["notes"])
        self.assertEqual(["question", "answer"], [e["kind"] for e in seen["thread"]["entries"]], "the thread was read again")
        reply = next(c for c in seen["composers"] if c["action"] == "reply")
        self.assertEqual(("SYN my follow-up", False, True, "idle"), (reply["value"], reply["readOnly"], reply["send"], reply["state"]))
        ids = [self.requests("reply")[-1]["body"]["requestId"]]

        canned = [(409, "QUESTION_CLOSED", CODES["QUESTION_CLOSED"]), (409, "REQUEST_ID_REUSED", CODES["REQUEST_ID_REUSED"]),
                  (404, "QUESTION_NOT_FOUND", C_NOT_FOUND), (403, "QUESTION_ACTION_FORBIDDEN", STATUSES[403]),
                  (400, "QUESTION_INPUT_INVALID", STATUSES[400]), (409, "SYN_UNKNOWN_CODE", REJECTED)]
        for status, code, text in canned:
            with self.subTest(code=code):
                message = f"SYN server message for {code}"
                self.faults.append({"kind": "reply", "status": status, "body": {"code": code, "message": message}})
                self.page.locator('.question-compose[data-action="reply"] button[data-send]').click()
                expect(self.page.locator("#question-thread [data-note-key]")).to_have_attribute("data-state", "failed")
                expect(self.page.locator("#question-thread [data-note-key] .state-text")).to_have_text(text)
                self.settle()
                seen = self.view()
                self.assertEqual([{"state": "failed", "text": text, "detail": f"{message} (HTTP {status} · {code})"}], seen["notes"])
                reply = next(c for c in seen["composers"] if c["action"] == "reply")
                self.assertEqual(("SYN my follow-up", False, True), (reply["value"], reply["readOnly"], reply["send"]))
                ids.append(self.requests("reply")[-1]["body"]["requestId"])
        # Every refused post was a new request; none reused an earlier requestId.
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(["question", "answer"], [e["kind"] for e in self.view()["thread"]["entries"]])

    def test_04_unknown_outcomes_retry_with_the_same_request_id(self):
        opened, _, _ = self.seed_threads()
        self.open_home()
        self.pick(A)
        self.open_questions("ready")
        self.open_thread(opened["id"], "Open")

        # 503 QUESTION_BUSY (not applied): the text stays read-only with Retry and Discard; Retry applies it.
        self.faults.append({"kind": "reply", "status": 503, "body": {"code": "QUESTION_BUSY", "message": "SYN busy"}})
        self.write("reply", "SYN busy follow-up")
        self.settled_note("unknown")
        seen = self.view()
        self.assertEqual([{"state": "unknown", "text": CODES["QUESTION_BUSY"], "detail": "SYN busy (HTTP 503 · QUESTION_BUSY)"}], seen["notes"])
        reply = next(c for c in seen["composers"] if c["action"] == "reply")
        self.assertEqual(("unknown", "SYN busy follow-up", True, False, True, True),
                         (reply["state"], reply["value"], reply["readOnly"], reply["send"], reply["retry"], reply["discard"]))
        first = self.requests("reply")[-1]["body"]
        self.page.locator('.question-compose[data-action="reply"] button[data-retry]').click()
        self.settled_note("saved")
        second = self.requests("reply")[-1]["body"]
        self.assertEqual(first, second, "Retry sends the same requestId, revision and text")
        expect(self.page.locator("#question-entries > li")).to_have_count(2)
        seen = self.threaded(opened["id"], "Open")
        self.assertEqual([{"state": "saved", "text": SAVED, "detail": ""}], seen["notes"])
        self.assertEqual(["question", "followup"], [e["kind"] for e in seen["thread"]["entries"]])

        # The server applied the write and the connection dropped: Retry gets the stored result (replayed) and no entry.
        self.faults.append({"kind": "reply", "apply": True, "abort": True})
        self.write("reply", "SYN dropped follow-up")
        self.settled_note("unknown")
        seen = self.view()
        self.assertEqual("unknown", seen["notes"][0]["state"])
        self.assertEqual(UNKNOWN, seen["notes"][0]["text"])
        self.assertEqual(f"{NO_SERVER}", seen["notes"][0]["detail"])
        dropped = self.requests("reply")[-1]["body"]
        self.assertEqual(2, dropped["revision"])
        self.page.locator('.question-compose[data-action="reply"] button[data-retry]').click()
        self.settled_note("saved")
        self.assertEqual(dropped, self.requests("reply")[-1]["body"])
        expect(self.page.locator("#question-entries > li")).to_have_count(3)
        seen = self.threaded(opened["id"], "Open")
        self.assertEqual([{"state": "saved", "text": REPLAYED, "detail": ""}], seen["notes"])
        self.assertEqual(["question", "followup", "followup"], [e["kind"] for e in seen["thread"]["entries"]], "one entry, not two")

        # 409 STUDY_ACCESS_CHANGED after the commit: the same.
        self.faults.append({"kind": "reply", "apply": True, "status": 409,
                            "body": {"code": "STUDY_ACCESS_CHANGED", "message": "SYN access changed"}})
        self.write("reply", "SYN access follow-up")
        self.settled_note("unknown")
        self.assertEqual([{"state": "unknown", "text": CODES["STUDY_ACCESS_CHANGED"],
                           "detail": "SYN access changed (HTTP 409 · STUDY_ACCESS_CHANGED)"}], self.view()["notes"])
        self.page.locator('.question-compose[data-action="reply"] button[data-retry]').click()
        self.settled_note("saved")
        self.assertEqual(REPLAYED, self.view()["notes"][0]["text"])
        expect(self.page.locator("#question-entries > li")).to_have_count(4)

        # A 201 whose envelope names another request is not this write's result.
        self.faults.append({"kind": "reply", "apply": True, "patch": lambda p: p["applied"].update(requestId=str(uuid.uuid4()))})
        self.write("reply", "SYN odd envelope")
        self.settled_note("unknown")
        self.assertEqual([{"state": "unknown", "text": WRITE_MALFORMED, "detail": ""}], self.view()["notes"])
        odd = self.requests("reply")[-1]["body"]
        self.page.locator('.question-compose[data-action="reply"] button[data-retry]').click()
        self.settled_note("saved")
        self.assertEqual((odd, REPLAYED), (self.requests("reply")[-1]["body"], self.view()["notes"][0]["text"]))
        expect(self.page.locator("#question-entries > li")).to_have_count(5)

        # Discard: the request is dropped, the text stays editable, the list is read again, the next send is a new request.
        self.faults.append({"kind": "reply", "status": 503, "body": {"code": "QUESTION_BUSY", "message": "SYN busy"}})
        self.write("reply", "SYN discarded follow-up")
        self.settled_note("unknown")
        dropped = self.requests("reply")[-1]["body"]["requestId"]
        reads = len(self.requests("list"))
        self.page.locator('.question-compose[data-action="reply"] button[data-discard]').click()
        self.settled_note("discarded")
        self.wait_until(lambda: len(self.requests("list")) == reads + 1, "the list read after Discard")
        seen = self.threaded(opened["id"], "Open")
        reply = next(c for c in seen["composers"] if c["action"] == "reply")
        self.assertEqual(("SYN discarded follow-up", False, True, False),
                         (reply["value"], reply["readOnly"], reply["send"], reply["retry"]))
        self.assertEqual([{"state": "discarded", "text": C_DISCARDED, "detail": ""}], seen["notes"])
        self.page.locator('.question-compose[data-action="reply"] button[data-send]').click()
        self.settled_note("saved")
        self.assertNotEqual(dropped, self.requests("reply")[-1]["body"]["requestId"])

    def test_05_a_b_a_late_answers_never_paint(self):
        for label, script in (("shipped", None), ("uid-only control", self.home_uid_only)):
            with self.subTest(file=label):
                self.server = QuestionServer([A, B, C])
                self.q_requests, self.held, self.holding = [], [], set()
                first = self.server.seed(A, CLINICIAN, "SYN first")
                self.open_home(script)
                self.pick(A)
                self.open_questions("ready")
                self.holding = {"list"}
                self.pick(B)
                self.pick(A)
                b1, a1 = self.take("list", 2)
                # A's second read is answered from a later store than its first.
                second = self.server.seed(A, CLINICIAN, "SYN second")
                self.pick(B)
                self.pick(A)
                b2, a2 = self.take("list", 2)
                self.holding = set()
                self.assertEqual([f"/api/studies/{u}/questions" for u in (A, B, B, A)], [h["path"] for h in (a1, b1, b2, a2)])
                self.release(a2)
                self.assertEqual([second["id"], first["id"]], [i["id"] for i in self.view()["items"]])
                for late in (a1, b1, b2):
                    self.release(late)
                items = [i["id"] for i in self.view()["items"]]
                if script is None:
                    self.assertEqual([second["id"], first["id"]], items, "a late answer painted")
                else:
                    self.assertEqual([first["id"]], items, "control: the UID-only file paints A's first answer")

        # A late thread answer of an earlier selection, and a write answered after the user moved on.
        self.server = QuestionServer([A, B, C])
        self.q_requests, self.held = [], []
        thread = self.server.seed(A, CLINICIAN, "SYN thread")
        self.open_home()
        self.pick(A)
        self.open_questions("ready")
        self.holding = {"thread"}
        self.page.locator(f'#question-list > li[data-id="{thread["id"]}"] button[data-open-thread]').click()
        late_thread, = self.take("thread")
        self.holding = set()
        self.pick(B)
        self.listed("empty")
        self.pick(A)
        self.listed("ready")
        self.release(late_thread)
        seen = self.view()
        self.assertEqual((A, None), (seen["uid"], seen["thread"]), "the earlier selection's thread answer did not paint")

        self.open_thread(thread["id"], "Open")
        self.holding = {"reply"}
        self.write("reply", "SYN slow follow-up")
        post, = self.take("reply")
        self.holding = set()
        self.pick(B)
        before = self.listed("empty")
        reads = len(self.q_requests)
        self.release(post)
        self.assertEqual(before, self.view(), "B's section is unchanged by A's answer")
        self.assertEqual(reads, len(self.q_requests), "nothing is read for B or A")
        self.pick(A)
        self.listed("ready")
        self.open_thread(thread["id"], "Open")
        expect(self.page.locator("#question-entries > li")).to_have_count(2)
        seen = self.view()
        self.assertEqual(["question", "followup"], [e["kind"] for e in seen["thread"]["entries"]])
        self.assertEqual([{"state": "saved", "text": SAVED, "detail": ""}], seen["notes"])
        self.assertEqual("", next(c for c in seen["composers"] if c["action"] == "reply")["value"])

    def test_06_session_policy_locks_and_session_end_leave_nothing(self):
        # (a) A 403 on a question read while a thread answer is on the way.
        opened, answered, _ = self.seed_threads()
        self.open_home()
        self.pick(A)
        self.open_questions("ready")
        self.holding = {"thread"}
        self.page.locator(f'#question-list > li[data-id="{opened["id"]}"] button[data-open-thread]').click()
        pending, = self.take("thread")
        self.holding = set()
        self.faults.append({"kind": "list", "status": 403, "body": {"code": "QUESTION_ROLE_REQUIRED", "message": "SYN refused"}})
        self.write("ask", "SYN another question")
        expect(self.page.locator("#questions")).to_have_attribute("data-state", "locked")
        self.release(pending)
        seen = self.view()
        self.assertEqual(("locked", "failed", "alert", REFUSED, "SYN refused (HTTP 403 · QUESTION_ROLE_REQUIRED)"),
                         (seen["state"], seen["list"]["state"], seen["list"]["role"], seen["list"]["text"], seen["list"]["detail"]))
        self.assertEqual((None, [], [], ["Questions"]),
                         (seen["thread"], seen["items"], seen["composers"],
                          self.page.evaluate("() => [...document.querySelectorAll('#questions summary')].map(e => e.textContent)")))
        count = len(self.q_requests)
        self.pick(B)
        self.pick(A)
        self.settle()
        self.assertEqual(("locked", REFUSED), (self.view()["state"], self.view()["list"]["text"]))
        self.assertEqual(count, len(self.q_requests), "a locked section reads nothing more")

        # (b) Another account's envelope on a read.
        self.page.reload()
        self.q_requests = []
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "ready")
        self.envelope_owner = [INSTITUTION, "SYN-OTHER-SUB"]
        self.pick(A)
        seen = self.open_questions("failed")
        self.assertEqual(("locked", OWNER_CHANGED, "", []), (seen["state"], seen["list"]["text"], seen["list"]["detail"], seen["items"]))
        self.envelope_owner = None

        # (c) 409 OWNER_CHANGED on a write: explicit text, answers on the way dropped, nothing more sent.
        self.page.reload()
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "ready")
        self.pick(A)
        self.open_questions("ready")
        self.holding = {"thread"}
        self.page.locator(f'#question-list > li[data-id="{answered["id"]}"] button[data-open-thread]').click()
        pending, = self.take("thread")
        self.holding = set()
        self.faults.append({"kind": "create", "status": 409, "body": {"code": "OWNER_CHANGED", "message": "SYN owner changed"}})
        self.write("ask", "SYN owner question")
        expect(self.page.locator("#questions")).to_have_attribute("data-state", "locked")
        self.release(pending)
        seen = self.view()
        self.assertEqual((OWNER_CHANGED, "SYN owner changed (HTTP 409 · OWNER_CHANGED)", None),
                         (seen["list"]["text"], seen["list"]["detail"], seen["thread"]))

        # (d) Log out while a write's answer is on the way: the page keeps only the closing line.
        self.page.reload()
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "ready")
        self.pick(A)
        self.open_questions("ready")
        self.open_thread(opened["id"], "Open")
        self.holding = {"reply"}
        self.write("reply", "SYN reply at logout")
        post, = self.take("reply")
        self.holding = set()
        self.held_logouts = []
        self.page.locator("#logout").click()
        self.wait_until(lambda: self.held_logouts, "POST /auth/logout")
        self.release(post)
        self.assertEqual({"children": ["P@status"], "text": CLOSING}, self.page.evaluate(CLOSED_VIEW),
                         "the write's answer after Log out paints nothing")
        self.held_logouts[0].fulfill(status=204, body="")
        self.held_logouts = None
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        expect(self.page.locator("#stand-in")).to_be_visible()

        # (e) Another tab's session end while a thread answer is on the way.
        self.page.goto(ORIGIN + BASE + "clinician.html")
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "ready")
        self.pick(A)
        self.open_questions("ready")
        self.holding = {"thread"}
        self.page.locator(f'#question-list > li[data-id="{opened["id"]}"] button[data-open-thread]').click()
        pending, = self.take("thread")
        self.holding = set()
        other = self.context.new_page()
        other.goto(ORIGIN + BASE + "blank.html")
        other.evaluate(BROADCAST_ENDED)
        other.close()
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        try:
            self.answer(pending["route"], pending["answer"])
        except PlaywrightError:
            pass  # the navigation already cancelled the request
        expect(self.page.locator("#stand-in")).to_be_visible()

    def test_07_wording_fonts_targets_keyboard_and_boundaries(self):
        opened, answered, _ = self.seed_threads()
        self.open_home()
        self.pick(A)
        self.page.locator("#questions-summary").focus()
        self.page.keyboard.press("Enter")
        self.listed("ready")
        self.page.keyboard.press("Tab")
        self.assertEqual(("BUTTON", "Open Thread", True), tuple(self.page.evaluate(ACTIVE)[k] for k in ("tag", "text", "open")))
        self.page.keyboard.press("Tab")
        self.page.keyboard.press("Enter")
        seen = self.threaded(answered["id"], "Answered")
        self.assertEqual("true", next(i for i in seen["items"] if i["id"] == answered["id"])["current"])
        texts = self.page.evaluate(TEXTS, "#questions")
        labels = self.page.evaluate("""() => { const s = document.querySelector('#questions'), t = sel => [...s.querySelectorAll(sel)]
            .filter(e => e.getClientRects().length).map(e => e.textContent);
          return {summary: t('summary'), buttons: t('button'), headings: t('h4'), labels: t('label'), states: t('.status'), kinds: t('strong')}; }""")
        self.assertEqual(["Questions"], labels["summary"])
        self.assertEqual(["Open Thread", "Open Thread", "Open Thread", "Reply", "Close", "Ask"], labels["buttons"])
        self.assertEqual((["Thread"], ["Reply", "Close Reason", "New Question"]), (labels["headings"], labels["labels"]))
        self.assertEqual(["Open", "Answered", "Closed", "Answered"], labels["states"])
        self.assertEqual(["Question", "Answer", ANCHOR_CHANGED], labels["kinds"])
        for text in labels["summary"] + labels["buttons"] + labels["headings"] + labels["labels"] + labels["states"] + labels["kinds"][:2]:
            self.assertFalse(has_hangul(text), text)
        # Explanations: tooltips, state lines and the muted notes (an entry's "· author (Role) · time" tail is data, not wording).
        explanations = [t["text"] for t in texts if t["tag"].endswith("@title") or "state-" in t["cls"]
                        or ("muted" in t["cls"] and not t["text"].startswith("·"))]
        self.assertGreaterEqual(len(explanations), 6)
        for text in explanations:
            self.assertTrue(has_hangul(text), text)
        for item in texts:
            with self.subTest(text=item["text"][:60], tag=item["tag"]):
                self.assertIsNone(AVOIDED.search(item["text"]))
                self.assertIsNone(ACKNOWLEDGED.search(item["text"]))
                if item["size"] is not None:
                    self.assertGreaterEqual(item["size"], 12)
        targets = self.page.evaluate(TARGETS, "#questions button, #questions summary")
        self.assertGreaterEqual(len(targets), 6)
        for tag, text, width, height in targets:
            self.assertGreaterEqual(min(width, height), 24, f"{tag} {text}")
        aria = self.page.evaluate("""() => ({reply: document.querySelector('#question-reply-text').getAttribute('aria-describedby'),
          replyLabel: document.querySelector('label[for="question-reply-text"]').textContent,
          thread: document.querySelector('#question-thread').getAttribute('aria-labelledby'),
          state: [document.querySelector('#questions-state').getAttribute('role'), document.querySelector('#questions-state').getAttribute('aria-live')],
          max: document.querySelector('#question-reply-text').maxLength})""")
        self.assertEqual({"reply": "question-reply-hint", "replyLabel": "Reply", "thread": "question-thread-title",
                          "state": ["status", "polite"], "max": 2000}, aria)
        # Keyboard to the reply field and its button.
        self.page.locator("#question-reply-text").focus()
        self.page.keyboard.type("SYN typed by keyboard")
        self.page.keyboard.press("Tab")
        self.assertEqual(("BUTTON", "Reply", True), tuple(self.page.evaluate(ACTIVE)[k] for k in ("tag", "text", "send")))
        self.page.keyboard.press("Enter")
        self.settled_note("saved")
        self.assertEqual("SYN typed by keyboard", self.requests("reply")[-1]["body"]["body"])
        # Boundaries: its own routes only - no consultation route, no report body, no storage, text only.
        for needle in ("/consultation", "KinConsultations", "/report", "localStorage", "sessionStorage", "innerHTML", "KinAuth",
                       "findings"):
            self.assertNotIn(needle, CLINICIAN_BLOCK, needle)
        self.assertEqual({"list", "thread", "reply"}, {r["kind"] for r in self.requests()})

    def test_08_home_write_envelope_needs_201_and_the_applied_step(self):
        opened, _, _ = self.seed_threads()
        self.open_home()
        self.pick(A)
        self.open_questions("ready")
        ask_note = self.page.locator('.question-compose[data-action="ask"] [data-note-key]')
        # Ask (create: null -> Open, revision 1, entry seq 1 = the question). Each applied, each answer not this request's
        # result: unknown, text read-only, Retry and Discard; Retry gets the stored result and the new thread opens.
        for name, fault, detail in ASK_ENVELOPES:
            with self.subTest(ask=name):
                self.faults.append({"kind": "create", "apply": True, **fault})
                self.write("ask", f"SYN {name} question")
                expect(ask_note).to_have_attribute("data-state", "unknown")
                seen = self.view()
                self.assertEqual({"state": "unknown", "text": WRITE_MALFORMED, "detail": detail}, seen["notes"][-1])
                ask = next(c for c in seen["composers"] if c["action"] == "ask")
                self.assertEqual(("unknown", f"SYN {name} question", True, False, True, True),
                                 (ask["state"], ask["value"], ask["readOnly"], ask["send"], ask["retry"], ask["discard"]))
                sent = self.requests("create")[-1]["body"]
                self.page.locator('.question-compose[data-action="ask"] button[data-retry]').click()
                expect(ask_note).to_have_attribute("data-state", "saved")
                self.assertEqual(sent, self.requests("create")[-1]["body"])
                self.assertEqual({"state": "saved", "text": REPLAYED, "detail": ""}, self.view()["notes"][-1])
                self.threaded(sent["requestId"], "Open")
        # Reply (the author's follow-up: Open -> Open at the posted revision + 1).
        self.open_thread(opened["id"], "Open")
        for index, (name, fault, detail) in enumerate(REPLY_ENVELOPES):
            with self.subTest(reply=name):
                self.faults.append({"kind": "reply", "apply": True, **fault})
                self.write("reply", f"SYN {name} follow-up")
                self.settled_note("unknown")
                seen = self.view()
                self.assertEqual({"state": "unknown", "text": WRITE_MALFORMED, "detail": detail}, seen["notes"][0])
                reply = next(c for c in seen["composers"] if c["action"] == "reply")
                self.assertEqual(("unknown", f"SYN {name} follow-up", True, False, True, True),
                                 (reply["state"], reply["value"], reply["readOnly"], reply["send"], reply["retry"], reply["discard"]))
                sent = self.requests("reply")[-1]["body"]
                self.page.locator('.question-compose[data-action="reply"] button[data-retry]').click()
                self.settled_note("saved")
                self.assertEqual((sent, REPLAYED), (self.requests("reply")[-1]["body"], self.view()["notes"][0]["text"]))
                expect(self.page.locator("#question-entries > li")).to_have_count(2 + index)
        # A reply whose answer was lost; the thread then moved on and closed, and the screen read it (Closed). Retry's stored
        # result (Open -> Open at the revision the request was sent with) is this request's and is accepted; the thread
        # is read again, still Closed.
        self.faults.append({"kind": "reply", "apply": True, "abort": True})
        self.write("reply", "SYN follow-up before the close")
        self.settled_note("unknown")
        base = self.requests("reply")[-1]["body"]["revision"]
        self.server.step(opened, "close", CLINICIAN, "clinician", "")
        self.page.locator(f'#question-list > li[data-id="{opened["id"]}"] button[data-open-thread]').click()
        expect(self.page.locator("#question-thread")).to_have_attribute("data-state", "Closed")
        self.assertEqual(base + 2, len(self.view()["thread"]["entries"]))
        self.page.locator('.question-compose[data-action="reply"] button[data-retry]').click()
        self.settled_note("saved")
        seen = self.threaded(opened["id"], "Closed")
        self.assertEqual((REPLAYED, base + 2), (seen["notes"][0]["text"], len(seen["thread"]["entries"])))

    def test_09_home_late_ask_keeps_the_latest_thread_choice(self):
        # (a) The Ask's 201 arrives after A -> B -> A and another thread chosen there with a draft typed in it.
        for label, script in (("shipped", None), ("no-generation control", self.home_ask_any_screen)):
            with self.subTest(file=label):
                self.server = QuestionServer([A, B, C])
                self.q_requests, self.held, self.holding = [], [], set()
                chosen = self.server.seed(A, CLINICIAN, "SYN chosen thread")
                self.open_home(script)
                self.pick(A)
                self.open_questions("ready")
                self.holding = {"create"}
                self.write("ask", "SYN late question")
                post, = self.take("create")
                self.holding = set()
                asked = self.requests("create")[-1]["body"]["requestId"]
                self.pick(B)
                self.listed("empty")
                self.pick(A)
                self.listed("ready")
                self.open_thread(chosen["id"], "Open")
                self.write("reply", "SYN draft in the chosen thread", press=False)
                self.release(post)
                expect(self.page.locator("#question-list > li")).to_have_count(2)
                self.settle()
                if script is None:
                    seen = self.threaded(chosen["id"], "Open")
                    reply = next(c for c in seen["composers"] if c["action"] == "reply")
                    ask = next(c for c in seen["composers"] if c["action"] == "ask")
                    self.assertEqual(("SYN draft in the chosen thread", False, "", "idle"),
                                     (reply["value"], reply["readOnly"], ask["value"], ask["state"]))
                    self.assertEqual("question-reply-text", self.page.evaluate(ACTIVE)["id"])
                    self.assertEqual([(asked, None), (chosen["id"], "true")], [(i["id"], i["current"]) for i in seen["items"]])
                    self.assertEqual([{"state": "saved", "text": SAVED, "detail": ""}], seen["notes"])
                else:
                    self.threaded(asked, "Open")

        # (b)-(d) the shipped file.
        self.server = QuestionServer([A, B, C])
        self.q_requests, self.held, self.holding = [], [], set()
        first = self.server.seed(A, CLINICIAN, "SYN first thread")
        second = self.server.seed(A, CLINICIAN, "SYN second thread")
        self.open_home()
        self.pick(A)
        self.open_questions("ready")
        self.open_thread(first["id"], "Open")
        # (b) Another thread of the same study chosen while the Ask is on the way.
        self.holding = {"create"}
        self.write("ask", "SYN question then another thread")
        post, = self.take("create")
        self.holding = set()
        self.open_thread(second["id"], "Open")
        self.write("reply", "SYN draft in the second thread", press=False)
        self.release(post)
        expect(self.page.locator("#question-list > li")).to_have_count(3)
        self.settle()
        seen = self.threaded(second["id"], "Open")
        self.assertEqual("SYN draft in the second thread", next(c for c in seen["composers"] if c["action"] == "reply")["value"])
        self.assertEqual("question-reply-text", self.page.evaluate(ACTIVE)["id"])
        # (c) Questions closed and opened again while the Ask is on the way: no thread is opened for it.
        self.holding = {"create"}
        self.write("ask", "SYN question then reopen")
        post, = self.take("create")
        self.holding = set()
        self.page.locator("#questions-summary").click()
        expect(self.page.locator("#questions-body")).to_have_count(0)
        self.page.locator("#questions-summary").click()
        self.listed("ready")
        self.release(post)
        expect(self.page.locator("#question-list > li")).to_have_count(4)
        self.settle()
        self.assertIsNone(self.view()["thread"])
        # (d) Nothing moved while it was on the way: the late Ask opens its new thread, as an Ask answered at once does.
        self.holding = {"create"}
        self.write("ask", "SYN question and wait")
        post, = self.take("create")
        self.holding = set()
        self.release(post)
        self.threaded(self.requests("create")[-1]["body"]["requestId"], "Open")

    def test_09b_home_thread_outside_the_latest_fifty_stays_open(self):
        # Astra S5-U4b-B-R-001 F2. The list of a study is the clinician's latest 50 (forStudy LIMIT 50). The oldest of 50
        # threads is open with a reply typed when the 51st Ask's 201 re-reads the list without it.
        def composer(seen, action):
            return next(c for c in seen["composers"] if c["action"] == action)

        def reread(reads, kinds):
            self.wait_until(lambda: [r["kind"] for r in self.q_requests[reads:]] == kinds, " -> ".join(kinds))
            expect(self.page.locator("#question-thread-state")).to_have_attribute("data-state", re.compile("ready|failed"))

        def discard_ask(text, fault=None):
            """Reads the list again with the thread left open: an Ask applied but answered with a dropped connection is
            discarded (an Ask answered at once would open its own thread). `fault` is for the direct read that follows."""
            self.faults.append({"kind": "create", "apply": True, "abort": True})
            self.write("ask", text)
            expect(self.page.locator('.question-compose[data-action="ask"] [data-note-key]')).to_have_attribute("data-state", "unknown")
            if fault:
                self.faults.append(fault)
            reads = len(self.q_requests)
            self.page.locator('.question-compose[data-action="ask"] button[data-discard]').click()
            return reads

        # The control first, so the shipped file's page is the one (b)-(d) go on with.
        for label, script in (("list-membership control", self.home_list_membership), ("shipped", None)):
            with self.subTest(file=label):
                self.server = QuestionServer([A, B, C])
                self.q_requests, self.held, self.holding, self.faults = [], [], set(), []
                oldest = self.server.seed(A, CLINICIAN, "SYN oldest question")
                for n in range(49):
                    self.server.seed(A, CLINICIAN, f"SYN question {n}")
                self.open_home(script)
                self.pick(A)
                seen = self.open_questions("ready")
                self.assertEqual((50, oldest["id"]), (len(seen["items"]), seen["items"][-1]["id"]))
                self.holding = {"create"}
                self.write("ask", "SYN 51st question")
                post, = self.take("create")
                self.holding = set()
                asked = self.requests("create")[-1]["body"]["requestId"]
                self.open_thread(oldest["id"], "Open")
                self.write("reply", "SYN reply typed in the oldest thread", press=False)
                reads = len(self.q_requests)
                self.release(post)
                expect(self.page.locator(f'#question-list > li[data-id="{asked}"]')).to_have_count(1)
                if script is None:
                    reread(reads, ["list", "thread"])
                    seen = self.threaded(oldest["id"], "Open")
                    self.assertEqual(f"/api/questions/{oldest['id']}", self.q_requests[-1]["path"])
                    self.assertEqual(50, len(seen["items"]))
                    self.assertNotIn(oldest["id"], [i["id"] for i in seen["items"]])
                    reply, ask = composer(seen, "reply"), composer(seen, "ask")
                    self.assertEqual(("idle", "SYN reply typed in the oldest thread", False, True),
                                     (reply["state"], reply["value"], reply["readOnly"], reply["send"]))
                    self.assertEqual(("idle", ""), (ask["state"], ask["value"]))
                    self.assertEqual("question-reply-text", self.page.evaluate(ACTIVE)["id"])
                    self.assertEqual([{"state": "saved", "text": SAVED, "detail": ""}], seen["notes"])
                else:
                    self.wait_until(lambda: [r["kind"] for r in self.q_requests[reads:]] == ["list"], "the list read again")
                    self.settle()
                    self.assertEqual((None, ["list"]), (self.view()["thread"], [r["kind"] for r in self.q_requests[reads:]]),
                                     "control: the thread outside the list is closed with its reply field")

        # (b) A Reply there whose outcome is unknown (applied, the answer lost) keeps Retry across a re-read of the list.
        self.faults.append({"kind": "reply", "apply": True, "abort": True})
        self.page.locator('.question-compose[data-action="reply"] button[data-send]').click()
        self.settled_note("unknown")
        sent = self.requests("reply")[-1]["body"]
        reread(discard_ask("SYN 52nd question"), ["list", "thread"])
        seen = self.threaded(oldest["id"], "Open")
        self.assertNotIn(oldest["id"], [i["id"] for i in seen["items"]])
        reply = composer(seen, "reply")
        self.assertEqual(("unknown", "SYN reply typed in the oldest thread", True, False, True, True),
                         (reply["state"], reply["value"], reply["readOnly"], reply["send"], reply["retry"], reply["discard"]))
        self.assertEqual(["question", "followup"], [e["kind"] for e in seen["thread"]["entries"]])
        self.page.locator('.question-compose[data-action="reply"] button[data-retry]').click()
        self.settled_note("saved")
        self.assertEqual((sent, REPLAYED), (self.requests("reply")[-1]["body"], self.view()["notes"][0]["text"]))
        expect(self.page.locator("#question-entries > li")).to_have_count(2)
        # (c) A 404 on the direct read is the thread's own failure, with the reason and Retry; the typed text stays.
        self.write("reply", "SYN reply typed before the 404", press=False)
        reread(discard_ask("SYN 53rd question", {"kind": "thread", "status": 404,
                                                 "body": {"code": "QUESTION_NOT_FOUND", "message": "SYN gone"}}), ["list", "thread"])
        seen = self.threaded(oldest["id"], "failed")
        reply = composer(seen, "reply")
        self.assertEqual(["failed", C_THREAD_FAILED, C_NOT_FOUND + "\nSYN gone (HTTP 404 · QUESTION_NOT_FOUND)"], seen["thread"]["load"])
        self.assertEqual(("SYN reply typed before the 404", False, False), (reply["value"], reply["readOnly"], reply["send"]))
        self.page.locator("#question-thread-retry").click()
        seen = self.threaded(oldest["id"], "Open")
        self.assertEqual(("SYN reply typed before the 404", True), (composer(seen, "reply")["value"], composer(seen, "reply")["send"]))
        # (d) A 403 on the direct read locks the section with its text (the session policy of every question read).
        discard_ask("SYN 54th question", {"kind": "thread", "status": 403,
                                          "body": {"code": "QUESTION_ROLE_REQUIRED", "message": "SYN refused"}})
        expect(self.page.locator("#questions")).to_have_attribute("data-state", "locked")
        seen = self.view()
        self.assertEqual((REFUSED, "SYN refused (HTTP 403 · QUESTION_ROLE_REQUIRED)", None, []),
                         (seen["list"]["text"], seen["list"]["detail"], seen["thread"], seen["composers"]))

    def pending(self):
        return self.page.evaluate(PENDING_VIEW)

    def pending_row(self, state, text):
        return f"{state} {C_PENDING_STATES[state]} “{text}” Open Thread"

    def open_pending(self, qid):
        self.page.locator(f'#question-pending-list > li[data-id="{qid}"] button[data-open-pending]').click()

    def reopen_questions(self):
        self.page.locator("#questions-summary").click()
        expect(self.page.locator("#questions-body")).to_have_count(0)
        self.page.locator("#questions-summary").click()

    def pushed_out(self, script):
        """Two of study A's 50 threads each get a Reply whose outcome is unknown (one applied with the answer lost, one
        503 QUESTION_BUSY), then two newer threads push both out of the latest 50 and Questions is closed and opened."""
        self.server = QuestionServer([A, B, C])
        self.q_requests, self.held, self.holding, self.faults = [], [], set(), []
        one = self.server.seed(A, CLINICIAN, "SYN oldest one")
        two = self.server.seed(A, CLINICIAN, "SYN oldest two")
        for n in range(48):
            self.server.seed(A, CLINICIAN, f"SYN question {n}")
        self.open_home(script)
        self.pick(A)
        self.open_questions("ready")
        self.open_thread(one["id"], "Open")
        self.faults.append({"kind": "reply", "apply": True, "abort": True})
        self.write("reply", "SYN lost reply one")
        self.settled_note("unknown")
        sent_one = self.requests("reply")[-1]["body"]
        self.open_thread(two["id"], "Open")
        self.faults.append({"kind": "reply", "status": 503, "body": {"code": "QUESTION_BUSY", "message": "SYN busy"}})
        self.write("reply", "SYN busy reply two")
        self.settled_note("unknown")
        sent_two = self.requests("reply")[-1]["body"]
        if script is None:
            # The thread on screen has its own composer; only the other one is a row.
            self.assertEqual([one["id"]], [r["id"] for r in self.pending()["rows"]])
        for n in range(2):
            self.server.seed(A, CLINICIAN, f"SYN newer question {n}")
        self.reopen_questions()
        seen = self.listed("ready")
        self.assertEqual((None, 50), (seen["thread"], len(seen["items"])))
        self.assertFalse({one["id"], two["id"]} & {i["id"] for i in seen["items"]}, "both are outside the latest 50")
        return one, two, sent_one, sent_two

    def test_09c_home_pending_requests_outside_the_latest_fifty_stay_reachable(self):
        # Astra S5-U4b-C-R-001 F1. The control first, so the shipped file's page is the one (a)-(c) go on with.
        for label, script in (("no-pending control", self.home_no_pending), ("shipped", None)):
            with self.subTest(file=label):
                one, two, sent_one, sent_two = self.pushed_out(script)
                if script is not None:
                    seen = self.view()
                    self.assertEqual((False, None, ["ask"]), (self.pending()["shown"], seen["thread"],
                                                               [c["action"] for c in seen["composers"]]),
                                     "control: nothing on the section leads back to either unknown Reply")

        # (a) Questions closed and opened: one row per thread, each opened through GET questions/:id; its Retry and
        # Discard appear only once that read is answered.
        rows = self.pending()
        self.assertEqual((True, C_PENDING.format(n=2)), (rows["shown"], rows["text"]))
        self.assertEqual([(one["id"], "Unconfirmed", self.pending_row("Unconfirmed", "SYN lost reply one")),
                          (two["id"], "Unconfirmed", self.pending_row("Unconfirmed", "SYN busy reply two"))],
                         [(r["id"], r["state"], r["text"]) for r in rows["rows"]])
        self.holding = {"thread"}
        reads = len(self.q_requests)
        self.open_pending(one["id"])
        held, = self.take("thread")
        self.holding = set()
        self.assertEqual(f"/api/questions/{one['id']}", held["path"])
        seen = self.threaded(one["id"], "loading")
        self.assertEqual([True, True], [c["hidden"] for c in seen["composers"] if c["action"] != "ask"],
                         "no Retry or Discard before the thread is read")
        self.release(held)
        seen = self.threaded(one["id"], "Open")
        reply = next(c for c in seen["composers"] if c["action"] == "reply")
        self.assertEqual((False, "unknown", "SYN lost reply one", True, False, True, True),
                         (reply["hidden"], reply["state"], reply["value"], reply["readOnly"], reply["send"], reply["retry"],
                          reply["discard"]))
        self.assertEqual(["thread"], [r["kind"] for r in self.q_requests[reads:]], "opening a row sends nothing")
        self.assertEqual([two["id"]], [r["id"] for r in self.pending()["rows"]])
        self.page.locator('.question-compose[data-action="reply"] button[data-retry]').click()
        self.settled_note("saved")
        self.assertEqual((sent_one, REPLAYED), (self.requests("reply")[-1]["body"], self.view()["notes"][0]["text"]))
        expect(self.page.locator("#question-entries > li")).to_have_count(2)
        self.assertEqual(["question", "followup"], [e["kind"] for e in self.threaded(one["id"], "Open")["thread"]["entries"]])

        # (b) A -> B -> A: B has no row; back on A the other thread's row is there. An answer for another study is not
        # this thread's read: no Retry or Discard until the thread is read again.
        self.pick(B)
        self.listed("empty")
        self.assertFalse(self.pending()["shown"])
        self.pick(A)
        seen = self.listed("ready")
        self.assertIsNone(seen["thread"])
        self.assertEqual([(two["id"], "Unconfirmed")], [(r["id"], r["state"]) for r in self.pending()["rows"]])
        self.faults.append({"kind": "thread", "apply": True, "patch": lambda p: p["item"].update(studyUid=B)})
        self.open_pending(two["id"])
        seen = self.threaded(two["id"], "failed")
        self.assertEqual(["failed", C_THREAD_FAILED, C_MALFORMED], seen["thread"]["load"])
        self.assertEqual([True, True], [c["hidden"] for c in seen["composers"] if c["action"] != "ask"])
        self.page.locator("#question-thread-retry").click()
        seen = self.threaded(two["id"], "Open")
        reply = next(c for c in seen["composers"] if c["action"] == "reply")
        self.assertEqual((False, "unknown", "SYN busy reply two", True, True),
                         (reply["hidden"], reply["state"], reply["value"], reply["retry"], reply["discard"]))
        self.assertEqual(1, len(seen["thread"]["entries"]), "the 503 was not applied")

        # (c) Discard there: the text stays editable, and with Questions closed and opened it is that thread's Draft row.
        reads = len(self.q_requests)
        self.page.locator('.question-compose[data-action="reply"] button[data-discard]').click()
        self.settled_note("discarded")
        self.wait_until(lambda: [r["kind"] for r in self.q_requests[reads:]] == ["list", "thread"], "list -> thread")
        seen = self.threaded(two["id"], "Open")
        reply = next(c for c in seen["composers"] if c["action"] == "reply")
        self.assertEqual(("idle", "SYN busy reply two", False, True, False),
                         (reply["state"], reply["value"], reply["readOnly"], reply["send"], reply["retry"]))
        self.assertEqual([sent_two], [r["body"] for r in self.requests("reply") if r["body"]["requestId"] == sent_two["requestId"]],
                         "Discard sends nothing")
        self.reopen_questions()
        self.listed("ready")
        rows = self.pending()
        self.assertEqual((C_PENDING.format(n=1), [(two["id"], "Draft", self.pending_row("Draft", "SYN busy reply two"))]),
                         (rows["text"], [(r["id"], r["state"], r["text"]) for r in rows["rows"]]))
        # English state names, Korean explanations, no avoided or acknowledgement words, text >= 12px, targets >= 24px.
        for row in rows["rows"]:
            self.assertFalse(has_hangul(row["status"]))
        for text in [rows["text"], *C_PENDING_STATES.values()]:
            self.assertTrue(has_hangul(text))
            self.assertIsNone(AVOIDED.search(text))
            self.assertIsNone(ACKNOWLEDGED.search(text))
        for item in self.page.evaluate(TEXTS, "#question-pending"):
            if item["size"] is not None:
                self.assertGreaterEqual(item["size"], 12, item["text"])
        for tag, text, width, height in self.page.evaluate(TARGETS, "#question-pending button"):
            self.assertGreaterEqual(min(width, height), 24, f"{tag} {text}")

        # (d) A 403 or another account's envelope locks the section: no row, no thread, nothing sent, nothing comes back.
        lockers = (("403", {"kind": "list", "status": 403, "body": {"code": "QUESTION_ROLE_REQUIRED", "message": "SYN refused"}},
                    None, REFUSED),
                   ("account change", None, [INSTITUTION, "SYN-OTHER-SUB"], OWNER_CHANGED))
        for label, fault, other, text in lockers:
            with self.subTest(lock=label):
                self.pushed_out(None)
                self.assertEqual(2, len(self.pending()["rows"]))
                self.page.locator("#questions-summary").click()
                expect(self.page.locator("#questions-body")).to_have_count(0)
                if fault:
                    self.faults.append(fault)
                self.envelope_owner = other
                self.page.locator("#questions-summary").click()
                expect(self.page.locator("#questions")).to_have_attribute("data-state", "locked")
                self.envelope_owner = None
                count = len(self.q_requests)
                for step in ("locked", "A->B->A", "reopened"):
                    if step == "A->B->A":
                        self.pick(B)
                        self.pick(A)
                    elif step == "reopened":
                        self.reopen_questions()
                    self.settle()
                    seen = self.view()
                    self.assertEqual(("locked", text, None, [], [], None),
                                     (seen["state"], seen["list"]["text"], seen["thread"], seen["items"], seen["composers"],
                                      self.pending()), step)
                self.assertEqual(count, len(self.q_requests), "a locked section reads and sends nothing more")

    # ── Reading screen cases ──
    def test_10_reader_write_envelope_needs_201_and_the_applied_step(self):
        opened, answered, _ = self.seed_threads()
        self.open_reader(me(RADIOLOGIST, ["radiologist"]))
        self.target(A)
        self.reader_state("ready")
        self.page.locator("#question-toggle").click()
        self.reader_thread(opened["id"], "Open")
        # Reply (a radiologist's answer: Open -> Answered, then Answered -> Answered).
        for index, (name, fault, detail) in enumerate(REPLY_ENVELOPES):
            with self.subTest(reply=name):
                self.faults.append({"kind": "reply", "apply": True, **fault})
                self.reader_write("reply", f"SYN {name} answer")
                seen = self.reader_note("unknown")
                self.assertEqual([{"state": "unknown", "text": WRITE_MALFORMED, "detail": detail}], seen["notes"])
                reply = seen["composers"][0]
                self.assertEqual(("reply", "unknown", f"SYN {name} answer", True, False, True, True),
                                 (reply["action"], reply["state"], reply["value"], reply["readOnly"], reply["send"], reply["retry"],
                                  reply["discard"]))
                sent = self.requests("reply")[-1]["body"]
                self.page.locator('#question-thread .question-compose[data-action="reply"] button[data-retry]').click()
                seen = self.reader_note("saved")
                self.assertEqual((sent, REPLAYED), (self.requests("reply")[-1]["body"], seen["notes"][0]["text"]))
                expect(self.page.locator("#question-entries > li")).to_have_count(2 + index)
        # Close: an answer naming another action is not this close's result.
        self.reader_thread(answered["id"], "Answered")
        self.faults.append({"kind": "close", "apply": True, "patch": lambda p: p["applied"].update(action="answer")})
        self.reader_write("close", "SYN close reason")
        seen = self.reader_note("unknown")
        self.assertEqual([{"state": "unknown", "text": WRITE_MALFORMED, "detail": ""}], seen["notes"])
        self.page.locator('#question-thread .question-compose[data-action="close"] button[data-retry]').click()
        seen = self.reader_note("saved")
        self.assertEqual(REPLAYED, seen["notes"][0]["text"])
        expect(self.page.locator("#question-thread")).to_have_attribute("data-state", "Closed")
        # A reply whose answer was lost; the author then closed the thread and the screen read it (Closed). Retry's stored
        # result (from the state and revision the request was sent with) is accepted; the thread is read again, Closed.
        self.reader_thread(opened["id"], "Answered")
        self.faults.append({"kind": "reply", "apply": True, "abort": True})
        self.reader_write("reply", "SYN answer before the close")
        self.reader_note("unknown")
        base = self.requests("reply")[-1]["body"]["revision"]
        self.server.step(opened, "close", CLINICIAN, "clinician", "")
        self.page.locator(f'#question-list > li[data-id="{opened["id"]}"] button[data-open-thread]').click()
        expect(self.page.locator("#question-thread")).to_have_attribute("data-state", "Closed")
        self.assertEqual(base + 2, len(self.reader()["thread"]["entries"]))
        self.page.locator('#question-thread .question-compose[data-action="reply"] button[data-retry]').click()
        seen = self.reader_note("saved")
        self.assertEqual((REPLAYED, "Closed", base + 2),
                         (seen["notes"][0]["text"], seen["thread"]["state"], len(seen["thread"]["entries"])))

    def test_11_reader_row_follows_the_target_and_stays_out_of_the_layout(self):
        # Static: one hook in renderClinical, the block mounted once, the row between the report fields and the footer row.
        clinical = extract_function(MAIN, "renderClinical")
        self.assertEqual((1, 1), (clinical.count(HOOK), MAIN.count("studyQuestions?.sync();")))
        self.assertEqual(1, MAIN.count("function mountStudyQuestions("))
        for needle in ("/consultation", "KinConsultations", "consultations.", "/report", "#findings", "#conclusion", "#recommendation",
                       "localStorage", "sessionStorage", "innerHTML", "insertAdjacentHTML"):
            self.assertNotIn(needle, READER_BLOCK, needle)
        markup = slice_between(MAIN, '<div class="panel report-p">', "<!-- Order List (8.2.2)")
        self.assertLess(markup.index('<div class="redit">'), markup.index('<section id="question-p"'))
        self.assertLess(markup.index('<section id="question-p"'), markup.index('<div class="rfoot2">'))

        opened, answered, _ = self.seed_threads()
        self.open_reader(me(RADIOLOGIST, ["radiologist"]))
        place = self.page.evaluate("""() => { const s = document.querySelector('#question-p');
          return [s.previousElementSibling.className, s.nextElementSibling.className, !!s.closest('.rbtns, .rfoot2'), s.parentElement.className]; }""")
        self.assertEqual(["redit", "rfoot2", False, "panel report-p"], place)
        self.assertEqual((False, "idle"), (self.reader()["shown"], self.reader()["state"]))

        # A target without threads: read once, hidden, the report column's boxes are those of a page without the row.
        self.target(B)
        seen = self.reader_state("empty")
        self.assertEqual((False, R_EMPTY), (seen["shown"], seen["summary"]))
        self.assertEqual([("list", f"/api/studies/{B}/questions")], [(r["kind"], r["path"]) for r in self.requests()])
        for reading in (False, True):
            with self.subTest(reading=reading):
                boxes = self.page.evaluate("""(reading) => { document.body.classList.toggle('reading', reading);
                  const box = s => { const r = document.querySelector(s).getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
                  const measure = () => ['.report-p .rbtns', '.report-p .redit', '#findings', '#recommendation', '.report-p .rfoot2'].map(box);
                  const before = measure(), row = document.querySelector('#question-p'), next = row.nextElementSibling;
                  row.remove(); const after = measure(); next.before(row); document.body.classList.remove('reading');
                  return [before, after]; }""", reading)
                self.assertEqual(boxes[1], boxes[0])
        # The same target again: nothing is read.
        self.target(B)
        self.assertEqual(1, len(self.requests()))
        # A tele study: not read (questions stay in the owning institution), hidden.
        self.target(T)
        seen = self.reader()
        self.assertEqual((False, 1), (seen["shown"], len(self.requests())))
        # A target with threads: visible, one line, counts in words; the pane stays closed until asked.
        self.target(A)
        seen = self.reader_state("ready")
        self.assertEqual((True, R_COUNTS.format(n=3, o=1, a=1, c=1), ["Show Questions", "false"], "false", None),
                         (seen["shown"], seen["summary"], seen["toggle"], seen["inbox"], seen["mode"]))
        bar = self.page.evaluate("""() => { const r = document.querySelector('#question-p .question-bar').getBoundingClientRect();
          const s = getComputedStyle(document.querySelector('#question-summary')); return [r.height, s.whiteSpace, s.textOverflow]; }""")
        self.assertLessEqual(bar[0], 32)
        self.assertEqual(["nowrap", "ellipsis"], bar[1:])
        self.assertEqual(["list", "list"], [r["kind"] for r in self.requests()])

        # A session that is neither radiologist nor admin reads nothing and shows nothing.
        self.q_requests = []
        self.open_reader(me(ADMIN, ["technician"]))
        for u in (A, B):
            self.target(u)
        self.assertEqual(([], False), (self.requests(), self.reader()["shown"]))

    def test_12_reader_reply_close_oq11_anchor_and_admin_refusal(self):
        opened, answered, _ = self.seed_threads()
        self.open_reader(me(RADIOLOGIST, ["radiologist"]))
        self.target(A)
        self.reader_state("ready")
        self.page.locator("#question-toggle").click()
        seen = self.reader()
        self.assertEqual(("study", ["Hide Questions", "true"], ["ready", R_READY.format(n=3), ""]),
                         (seen["mode"], seen["toggle"], seen["list"]))
        seen = self.reader_thread(answered["id"], "Answered")
        self.assertEqual(["Answer · SYN Radiologist (Radiologist) · 2026-09-26 09:04", "SYN answer " + HOSTILE,
                          ANCHOR_CHANGED + " 답변 때 Preliminary · Version 1 → 지금 Approved · Version 2"], seen["thread"]["entries"][1]["lines"])
        self.assertEqual("2026-09-26 09:03 등록 · 질문 SYN Clinician", seen["thread"]["meta"])
        oq11 = self.page.evaluate("""() => { const f = document.querySelector('#question-reply-text'), n = document.querySelector('#question-nonfinal');
          return [n.textContent, f.getAttribute('aria-describedby'), n.nextElementSibling === f, n.closest('.question-compose').dataset.action]; }""")
        self.assertEqual([NON_FINAL, "question-reply-hint question-nonfinal", True, "reply"], oq11)

        seen = self.reader_thread(opened["id"], "Open")
        self.reader_write("reply", "SYN answer from the reading screen")
        seen = self.reader_note("saved")
        post = self.requests("reply")[-1]
        self.assertEqual((f"/api/questions/{opened['id']}/entries", ["body", "expectedOwner", "requestId", "revision"], 1,
                          [INSTITUTION, RADIOLOGIST["sub"]]),
                         (post["path"], sorted(post["body"]), post["body"]["revision"], post["body"]["expectedOwner"]))
        self.assertRegex(post["body"]["requestId"], UUID_V4)
        expect(self.page.locator("#question-thread")).to_have_attribute("data-state", "Answered")
        seen = self.reader()
        self.assertEqual(["question", "answer"], [e["kind"] for e in seen["thread"]["entries"]])
        self.assertEqual(R_COUNTS.format(n=3, o=0, a=2, c=1), seen["summary"])
        # A reason is required for someone else's question: the server's 400 is shown; with a reason it closes.
        self.reader_write("close", "")
        seen = self.reader_note("failed")
        self.assertEqual([{"state": "failed", "text": STATUSES[400],
                           "detail": "작성자가 아닌 사람이 질문을 닫을 때는 사유를 입력하세요 (HTTP 400 · QUESTION_INPUT_INVALID)"}], seen["notes"])
        self.reader_write("close", "SYN close reason")
        expect(self.page.locator("#question-thread")).to_have_attribute("data-state", "Closed")
        seen = self.reader()
        self.assertEqual((2, "SYN close reason", True, [True, True]),
                         (self.requests("close")[-1]["body"]["revision"], self.requests("close")[-1]["body"]["note"],
                          seen["thread"]["closedNote"], [c["hidden"] for c in seen["composers"]]))
        self.assertEqual(["Close · SYN Radiologist (Radiologist) · 2026-09-26 09:07", "SYN close reason"], seen["thread"]["entries"][2]["lines"])
        self.assertEqual(R_CLOSED_NOTE, self.page.locator('#question-thread [data-part="closed"]').text_content())

        # An admin-only session: Reply is not hidden, the server's 403 is shown as sent; a reasoned Close works.
        self.q_requests = []
        self.open_reader(me(ADMIN, ["admin"]))
        self.target(A)
        self.reader_state("ready")
        self.page.locator("#question-toggle").click()
        self.reader_thread(answered["id"], "Answered")
        self.reader_write("reply", "SYN admin answer")
        seen = self.reader_note("failed")
        self.assertEqual([{"state": "failed", "text": STATUSES[403],
                           "detail": "이 질문 동작에 필요한 역할이 없습니다 (HTTP 403 · QUESTION_ROLE_REQUIRED)"}], seen["notes"])
        self.assertNotEqual("locked", seen["state"], "a refused write does not lock the row")
        self.reader_write("close", "SYN admin reason")
        expect(self.page.locator("#question-thread")).to_have_attribute("data-state", "Closed")
        self.assertEqual("Close · SYN Admin (Admin) · 2026-09-26 09:08", self.reader()["thread"]["entries"][2]["lines"][0])

    def test_13_reader_failures_retry_and_discard(self):
        opened, answered, _ = self.seed_threads()
        self.open_reader(me(RADIOLOGIST, ["radiologist"]))
        # A failed list read shows the row with the failure; Retry reads again.
        self.faults.append({"kind": "list", "status": 500, "body": {"message": "SYN list failure"}})
        self.target(A)
        seen = self.reader_state("failed")
        self.assertEqual((True, R_FAILED), (seen["shown"], seen["summary"]))
        self.page.locator("#question-toggle").click()
        self.assertEqual(["failed", R_FAILED, "SYN list failure (HTTP 500)"], self.reader()["list"])
        self.page.locator("#question-list-retry").click()
        seen = self.reader_state("ready")
        self.assertEqual(["ready", R_READY.format(n=3), ""], seen["list"])
        # A failed thread read shows the failure with Retry and no write field can send.
        self.faults.append({"kind": "thread", "status": 404, "body": {"code": "QUESTION_NOT_FOUND", "message": "SYN gone"}})
        self.page.locator(f'#question-list > li[data-id="{opened["id"]}"] button[data-open-thread]').click()
        expect(self.page.locator("#question-thread")).to_have_attribute("data-state", "failed")
        seen = self.reader()
        self.assertEqual(["failed", R_THREAD_FAILED, R_NOT_FOUND + "\nSYN gone (HTTP 404 · QUESTION_NOT_FOUND)"], seen["thread"]["load"])
        self.assertEqual(([], [False, False]), (seen["thread"]["entries"], [c["send"] for c in seen["composers"]]))
        self.page.locator('#question-thread [data-part="retry"]').click()
        expect(self.page.locator("#question-thread")).to_have_attribute("data-state", "Open")

        # A real concurrent answer: 409 QUESTION_CHANGED, the thread is read again and the text stays.
        self.server.step(opened, "answer", RADIOLOGIST_TWO, "radiologist", "SYN other answer")
        self.reader_write("reply", "SYN late answer")
        seen = self.reader_note("failed")
        expect(self.page.locator("#question-thread")).to_have_attribute("data-state", "Answered")
        seen = self.reader()
        self.assertEqual([{"state": "failed", "text": CODES["QUESTION_CHANGED"],
                           "detail": "질문이 변경되었습니다. 다시 불러온 뒤 확인하세요 (HTTP 409 · QUESTION_CHANGED)"}], seen["notes"])
        self.assertEqual(("SYN late answer", True), (seen["composers"][0]["value"], seen["composers"][0]["send"]))
        # 404 on a write.
        self.faults.append({"kind": "reply", "status": 404, "body": {"code": "QUESTION_NOT_FOUND", "message": "SYN not found"}})
        self.page.locator('#question-thread .question-compose[data-action="reply"] button[data-send]').click()
        expect(self.page.locator("#question-thread [data-note-key] .question-text")).to_have_text(R_NOT_FOUND)
        # 503 then Retry with the same request.
        self.faults.append({"kind": "reply", "status": 503, "body": {"code": "QUESTION_BUSY", "message": "SYN busy"}})
        self.page.locator('#question-thread .question-compose[data-action="reply"] button[data-send]').click()
        seen = self.reader_note("unknown")
        self.assertEqual(("unknown", True, False, True, True),
                         (seen["composers"][0]["state"], seen["composers"][0]["readOnly"], seen["composers"][0]["send"],
                          seen["composers"][0]["retry"], seen["composers"][0]["discard"]))
        first = self.requests("reply")[-1]["body"]
        self.page.locator('#question-thread .question-compose[data-action="reply"] button[data-retry]').click()
        self.reader_note("saved")
        self.assertEqual(first, self.requests("reply")[-1]["body"])
        # Applied then dropped: Retry gets the stored result.
        self.faults.append({"kind": "reply", "apply": True, "abort": True})
        self.reader_write("reply", "SYN dropped answer")
        seen = self.reader_note("unknown")
        self.assertEqual([{"state": "unknown", "text": UNKNOWN, "detail": NO_SERVER}], seen["notes"])
        self.page.locator('#question-thread .question-compose[data-action="reply"] button[data-retry]').click()
        seen = self.reader_note("saved")
        self.assertEqual(REPLAYED, seen["notes"][0]["text"])
        expect(self.page.locator("#question-entries > li")).to_have_count(4)
        # Discard keeps the text, reads the list again and the next send is a new request.
        self.faults.append({"kind": "reply", "status": 502, "body": {"message": "SYN gateway"}})
        self.reader_write("reply", "SYN discarded answer")
        self.reader_note("unknown")
        dropped = self.requests("reply")[-1]["body"]["requestId"]
        reads = len(self.requests("list"))
        self.page.locator('#question-thread .question-compose[data-action="reply"] button[data-discard]').click()
        seen = self.reader_note("discarded")
        self.wait_until(lambda: len(self.requests("list")) == reads + 1, "the list read after Discard")
        self.assertEqual(([{"state": "discarded", "text": R_DISCARDED, "detail": ""}], "SYN discarded answer", False),
                         (seen["notes"], seen["composers"][0]["value"], seen["composers"][0]["readOnly"]))
        self.page.locator('#question-thread .question-compose[data-action="reply"] button[data-send]').click()
        self.reader_note("saved")
        self.assertNotEqual(dropped, self.requests("reply")[-1]["body"]["requestId"])

    def test_14_reader_a_b_a_drafts_and_late_writes(self):
        # A1 is answered from the store with one thread, A2 from the store with two; A2 arrives first, then A1, B and C.
        for label, block in (("shipped", None), ("uid-only control", self.reader_uid_only)):
            with self.subTest(file=label):
                self.server = QuestionServer([A, B, C])
                self.q_requests, self.held = [], []
                self.server.seed(A, CLINICIAN, "SYN first")
                self.open_reader(me(RADIOLOGIST, ["radiologist"]), block=block)
                self.holding = {"list"}
                self.target(A)
                self.target(B)
                self.target(C)
                self.server.seed(A, CLINICIAN, "SYN second")
                self.target(A)
                a1, b1, c1, a2 = self.take("list", 4)
                self.holding = set()
                self.assertEqual([f"/api/studies/{u}/questions" for u in (A, B, C, A)], [h["path"] for h in (a1, b1, c1, a2)])
                self.release(a2)
                self.assertEqual(R_COUNTS.format(n=2, o=2, a=0, c=0), self.reader()["summary"])
                for late in (a1, b1, c1):
                    self.release(late)
                expected = 2 if block is None else 1
                self.assertEqual(R_COUNTS.format(n=expected, o=expected, a=0, c=0), self.reader()["summary"],
                                 "shipped: A's newer answer stands; control: A's first answer paints over it")

        # Typed text stays with its study and thread; a write answered after the target changed paints nothing there.
        self.server = QuestionServer([A, B, C])
        self.q_requests, self.held = [], []
        thread_a = self.server.seed(A, CLINICIAN, "SYN A question")
        thread_b = self.server.seed(B, CLINICIAN, "SYN B question")
        self.open_reader(me(RADIOLOGIST, ["radiologist"]))
        self.target(A)
        self.reader_state("ready")
        self.page.locator("#question-toggle").click()
        self.reader_thread(thread_a["id"], "Open")
        self.reader_write("reply", "SYN draft for A", press=False)
        self.page.locator("#question-close-text").fill("SYN reason for A")
        self.target(B)
        seen = self.reader_state("ready")
        self.assertEqual((None, "study"), (seen["thread"], seen["mode"]), "A's thread is taken down, the pane follows the target")
        seen = self.reader_thread(thread_b["id"], "Open")
        self.assertEqual(["", ""], [c["value"] for c in seen["composers"]], "B's fields start empty")
        self.target(A)
        self.reader_state("ready")
        seen = self.reader_thread(thread_a["id"], "Open")
        self.assertEqual(["SYN draft for A", "SYN reason for A"], [c["value"] for c in seen["composers"]])

        self.holding = {"reply"}
        self.page.locator('#question-thread .question-compose[data-action="reply"] button[data-send]').click()
        post, = self.take("reply")
        self.holding = set()
        self.target(B)
        before = self.reader_state("ready")
        reads = len(self.q_requests)
        self.release(post)
        self.assertEqual(before, self.reader(), "B's row and pane are unchanged by A's answer")
        self.assertEqual(reads, len(self.q_requests))
        self.target(A)
        self.reader_state("ready")
        seen = self.reader_thread(thread_a["id"], "Answered")
        self.assertEqual((["question", "answer"], [{"state": "saved", "text": SAVED, "detail": ""}], ["", "SYN reason for A"]),
                         ([e["kind"] for e in seen["thread"]["entries"]], seen["notes"], [c["value"] for c in seen["composers"]]))

    def test_15_reader_inbox_paging_filter_and_open_study(self):
        target = self.server.seed(B, CLINICIAN, "SYN inbox target")
        answered = self.server.seed(C, CLINICIAN, "SYN answered in inbox")
        self.server.step(answered, "answer", RADIOLOGIST, "radiologist", "SYN answer")
        self.server.owned.add("1.2.826.0.1.3680043.10.5432.99")
        unlisted = self.server.seed("1.2.826.0.1.3680043.10.5432.99", CLINICIAN, "SYN not in the worklist")
        for n in range(50):
            self.server.seed(A, OTHER_CLINICIAN, f"SYN bulk {n}")
        self.open_reader(me(RADIOLOGIST, ["radiologist"]))
        self.target(A)
        self.reader_state("ready")
        self.page.locator("#question-inbox").click()
        expect(self.page.locator("#question-inbox-state")).to_have_attribute("data-state", "ready")
        seen = self.reader()
        inbox = self.requests("inbox")
        self.assertEqual([{"view": ["inbox"], "state": ["open"]}], [r["query"] for r in inbox])
        self.assertEqual(("inbox", "true", 50, True, ["ready", R_INBOX_READY.format(n=50) + " More로 이어서 읽습니다.", ""]),
                         (seen["mode"], seen["inbox"], len(seen["inboxItems"]), seen["more"], seen["inboxLine"]))
        self.page.locator("#question-inbox-more").click()
        expect(self.page.locator("#question-inbox-list > li")).to_have_count(52)
        self.assertEqual(json.loads(base64.urlsafe_b64decode(self.requests("inbox")[-1]["query"]["cursor"][0] + "==").decode())["i"], 50)
        seen = self.reader()
        self.assertEqual((False, ["ready", R_INBOX_READY.format(n=52), ""]), (seen["more"], seen["inboxLine"]))
        rows = {i["id"]: i for i in seen["inboxItems"]}
        self.assertEqual((False, R_NOT_LISTED), (rows[unlisted["id"]]["open"], rows[unlisted["id"]]["title"]))
        self.assertIn("워크리스트에 없는 검사 · 1.2.826.0.1.3680043.10.5432.99", rows[unlisted["id"]]["text"])
        self.assertIn("SYN BETA · SYN-P-52 · 2026-03-10 · SYN CT B", rows[target["id"]]["text"])
        self.assertEqual((True, ""), (rows[target["id"]]["open"], rows[target["id"]]["title"]))
        # The state filter reads again with the chosen state.
        self.page.locator("#question-inbox-filter").select_option("answered")
        expect(self.page.locator("#question-inbox-list > li")).to_have_count(1)
        self.assertEqual({"view": ["inbox"], "state": ["answered"]}, self.requests("inbox")[-1]["query"])
        self.page.locator("#question-inbox-filter").select_option("open")
        expect(self.page.locator("#question-inbox-list > li")).to_have_count(50)
        # The chosen thread is on the second page.
        self.page.locator("#question-inbox-more").click()
        expect(self.page.locator("#question-inbox-list > li")).to_have_count(52)
        # Open Study: the study becomes the reading target and the chosen thread opens.
        self.page.locator(f'#question-inbox-list > li[data-id="{target["id"]}"] button').click()
        expect(self.page.locator("#question-thread")).to_have_attribute("data-id", target["id"])
        expect(self.page.locator("#question-thread")).to_have_attribute("data-state", "Open")
        seen = self.reader()
        self.assertEqual((B, "study", R_COUNTS.format(n=1, o=1, a=0, c=0)),
                         (self.page.evaluate("() => window.synSelects.at(-1)"), seen["mode"], seen["summary"]))
        # Empty and failed.
        self.server.threads.clear()
        self.page.locator("#question-inbox").click()
        expect(self.page.locator("#question-inbox-state")).to_have_attribute("data-state", "empty")
        self.assertEqual(["empty", R_INBOX_EMPTY, ""], self.reader()["inboxLine"])
        self.faults.append({"kind": "inbox", "status": 500, "body": {"message": "SYN inbox failure"}})
        self.page.locator("#question-inbox-reload").click()
        expect(self.page.locator("#question-inbox-state")).to_have_attribute("data-state", "failed")
        self.assertEqual(["failed", R_INBOX_FAILED, "SYN inbox failure (HTTP 500)"], self.reader()["inboxLine"])
        self.page.locator("#question-inbox-retry").click()
        expect(self.page.locator("#question-inbox-state")).to_have_attribute("data-state", "empty")

    def test_16_reader_session_end_refusal_owner_and_401(self):
        opened, answered, _ = self.seed_threads()
        self.open_reader(me(RADIOLOGIST, ["radiologist"]))
        self.page.evaluate(OBSERVE_SIGNALS)
        self.target(A)
        self.reader_state("ready")
        # Another tab ends the session while a list answer is on the way: the row goes, the read is stopped, nothing
        # paints, nothing is read.
        self.holding = {"list"}
        self.target(B)
        pending, = self.take("list")
        self.holding = set()
        other = self.context.new_page()
        other.goto(ORIGIN + BASE + "blank.html")
        other.evaluate(BROADCAST_ENDED)
        other.close()
        expect(self.page.locator("#question-p")).to_have_attribute("data-state", "ended")
        self.assertEqual([[f"/api/studies/{A}/questions", False], [f"/api/studies/{B}/questions", True]], self.page.evaluate(SIGNALS))
        self.release_after_end(pending)
        count = len(self.q_requests)
        self.target(A)
        seen = self.reader()
        self.assertEqual((False, "ended", count), (seen["shown"], seen["state"], len(self.q_requests)))

        # A 403 read locks the row with an explicit text; nothing more is read.
        self.q_requests = []
        self.open_reader(me(RADIOLOGIST, ["radiologist"]))
        self.faults.append({"kind": "list", "status": 403, "body": {"code": "QUESTION_ROLE_REQUIRED", "message": "SYN refused"}})
        self.target(A)
        seen = self.reader_state("locked")
        self.assertEqual((True, REFUSED, "study", ["failed", REFUSED, "SYN refused (HTTP 403 · QUESTION_ROLE_REQUIRED)"]),
                         (seen["shown"], seen["summary"], seen["mode"], seen["lock"]))
        self.assertEqual("alert", self.page.locator("#question-lock").get_attribute("role"))
        self.target(B)
        self.page.locator("#question-inbox").click()
        self.settle()
        self.assertEqual(1, len(self.q_requests), "a locked row reads nothing more")

        # Another account's envelope on a thread read, while a list answer is on the way.
        self.q_requests = []
        self.open_reader(me(RADIOLOGIST, ["radiologist"]))
        self.target(A)
        self.reader_state("ready")
        self.page.locator("#question-toggle").click()
        self.faults.append({"kind": "thread", "apply": True, "patch": lambda p: p.update(owner=[INSTITUTION, "SYN-OTHER-SUB"])})
        self.page.locator(f'#question-list > li[data-id="{answered["id"]}"] button[data-open-thread]').click()
        seen = self.reader_state("locked")
        self.assertEqual((OWNER_CHANGED, ["failed", OWNER_CHANGED, ""], None, []),
                         (seen["summary"], seen["lock"], seen["thread"], seen["items"]))

        # A 401 on a write ends the row and starts the logout once (the logout POST held: test_18).
        self.q_requests = []
        self.open_reader(me(RADIOLOGIST, ["radiologist"]))
        self.target(A)
        self.reader_state("ready")
        self.page.locator("#question-toggle").click()
        self.reader_thread(opened["id"], "Open")
        self.faults.append({"kind": "reply", "status": 401, "body": {"statusCode": 401, "message": "SYN expired"}})
        self.reader_write("reply", "SYN reply at expiry")
        expect(self.page.locator("#question-p")).to_have_attribute("data-state", "ended")
        self.assertEqual((1, False), (self.page.evaluate("() => window.synLogouts"), self.reader()["shown"]))

    def test_17_reader_wording_fonts_targets_and_keyboard(self):
        opened, answered, _ = self.seed_threads()
        self.open_reader(me(RADIOLOGIST, ["radiologist"]))
        self.target(A)
        self.reader_state("ready")
        self.page.locator("#question-toggle").focus()
        self.page.keyboard.press("Enter")
        expect(self.page.locator("#question-pane")).to_be_visible()
        self.page.keyboard.press("Tab")
        self.assertEqual("question-inbox", self.page.evaluate(ACTIVE)["id"])
        self.page.keyboard.press("Tab")
        self.assertEqual(("BUTTON", "Open Thread", True), tuple(self.page.evaluate(ACTIVE)[k] for k in ("tag", "text", "open")))
        self.page.keyboard.press("Tab")
        self.page.keyboard.press("Enter")
        expect(self.page.locator("#question-thread")).to_have_attribute("data-state", "Answered")
        texts = self.page.evaluate(TEXTS, "#question-p")
        labels = self.page.evaluate("""() => { const s = document.querySelector('#question-p'), t = sel => [...s.querySelectorAll(sel)]
            .filter(e => e.getClientRects().length).map(e => e.textContent);
          return {bar: t('.question-bar b'), buttons: t('button'), headings: t('h4'), labels: t('label'), states: t('.question-status'),
            kinds: t('.question-muted > strong')}; }""")
        self.assertEqual(["Questions"], labels["bar"])
        self.assertEqual(["Hide Questions", "Inbox", "Open Thread", "Open Thread", "Open Thread", "Reply", "Close"], labels["buttons"])
        self.assertEqual((["Thread"], ["Reply", "Close Reason"]), (labels["headings"], labels["labels"]))
        self.assertEqual(["Open", "Answered", "Closed", "Answered"], labels["states"])
        self.assertEqual(["Question", "Answer"], labels["kinds"])
        for text in sum(labels.values(), []):
            self.assertFalse(has_hangul(text), text)
        # Explanations: tooltips, state lines, the OQ-11 notice, the anchor note, hints and the row summary.
        explanations = [t["text"] for t in texts if t["tag"].endswith("@title") or t["cls"] in (
            "question-text", "question-detail", "question-nonfinal", "question-anchor")
            or (t["cls"] == "question-muted" and not t["text"].startswith("·"))]
        explanations.append(self.page.locator("#question-summary").text_content())
        self.assertGreaterEqual(len(explanations), 6)
        for text in explanations:
            self.assertTrue(has_hangul(text), text)
        for item in texts:
            with self.subTest(text=item["text"][:60], tag=item["tag"]):
                self.assertIsNone(AVOIDED.search(item["text"]))
                self.assertIsNone(ACKNOWLEDGED.search(item["text"]))
                if item["size"] is not None:
                    self.assertGreaterEqual(item["size"], 12)
        targets = self.page.evaluate(TARGETS, "#question-p button, #question-p select")
        self.assertGreaterEqual(len(targets), 7)
        for tag, text, width, height in targets:
            self.assertGreaterEqual(min(width, height), 24, f"{tag} {text}")
        aria = self.page.evaluate("""() => ({toggle: document.querySelector('#question-toggle').getAttribute('aria-controls'),
          inbox: document.querySelector('#question-inbox').getAttribute('aria-controls'),
          summary: [document.querySelector('#question-summary').getAttribute('role'), document.querySelector('#question-summary').getAttribute('aria-live')],
          region: [document.querySelector('#question-pane').getAttribute('role'), document.querySelector('#question-pane').getAttribute('aria-label')],
          section: document.querySelector('#question-p').getAttribute('aria-label'),
          closeLabel: document.querySelector('label[for="question-close-text"]').textContent,
          max: [document.querySelector('#question-reply-text').maxLength, document.querySelector('#question-close-text').maxLength]})""")
        self.assertEqual({"toggle": "question-pane", "inbox": "question-pane", "summary": ["status", "polite"],
                          "region": ["region", "Question Threads"], "section": "Questions", "closeLabel": "Close Reason",
                          "max": [2000, 2000]}, aria)
        # Keyboard into the reply field and onto Reply.
        self.page.locator("#question-reply-text").focus()
        self.page.keyboard.type("SYN keyboard answer")
        self.page.keyboard.press("Tab")
        self.assertEqual(("BUTTON", "Reply", True), tuple(self.page.evaluate(ACTIVE)[k] for k in ("tag", "text", "send")))
        self.page.keyboard.press("Enter")
        self.reader_note("saved")
        self.assertEqual("SYN keyboard answer", self.requests("reply")[-1]["body"]["body"])

    def test_18_reader_401_ends_the_row_before_the_logout_post(self):
        # The block sends its own requests: api() awaits KinAuth.logout(), which broadcasts only after the logout POST.
        # (A call has arguments; the block's comments name `api()` to say why it is not used.)
        self.assertIsNone(re.search(r"\bapi\(\s*[^)\s]", READER_BLOCK), "the S5-U4b block calls api()")
        for label, block in (("shipped", None), ("end-on-broadcast control", self.reader_end_on_broadcast)):
            with self.subTest(file=label):
                self.server = QuestionServer([A, B, C])
                self.q_requests, self.held, self.holding, self.faults, self.logouts = [], [], set(), [], []
                opened, answered, _ = self.seed_threads()
                self.open_reader(me(RADIOLOGIST, ["radiologist"]), block=block, real_auth=True)
                self.page.evaluate(OBSERVE_SIGNALS)
                self.page.evaluate(OTHER_PANEL)
                self.target(A)
                self.reader_state("ready")
                self.page.locator("#question-toggle").click()
                self.reader_thread(opened["id"], "Open")
                self.page.locator("#question-close-text").fill("SYN reason typed before the expiry")
                # A write and a thread read are on the way when a list read gets the 401; the logout POST is held.
                self.holding = {"reply"}
                self.reader_write("reply", "SYN answer sent before the expiry")
                write, = self.take("reply")
                self.holding = {"thread"}
                self.page.locator(f'#question-list > li[data-id="{answered["id"]}"] button[data-open-thread]').click()
                read, = self.take("thread")
                self.holding = set()
                self.held_logouts = []
                self.faults.append({"kind": "list", "status": 401, "body": {"statusCode": 401, "message": "SYN expired"}})
                self.target(B)
                self.wait_until(lambda: self.held_logouts, "POST /auth/logout")
                self.settle()
                self.assertEqual((["1"], "approved", ORIGIN + BASE + "main.html"),
                                 (self.logouts, self.page.evaluate("() => KinAuth.session().state"), self.page.url),
                                 "auth.js is still waiting for its logout POST")
                seen = self.reader()
                if block is None:
                    self.assertEqual((False, "ended", None, [], None, [], []),
                                     (seen["shown"], seen["state"], seen["mode"], seen["items"], seen["thread"], seen["composers"],
                                      seen["notes"]))
                    self.assertEqual([[f"/api/studies/{A}/questions", False], [f"/api/questions/{opened['id']}", False],
                                      [f"/api/questions/{opened['id']}/entries", True], [f"/api/questions/{answered['id']}", True],
                                      [f"/api/studies/{B}/questions", True]], self.page.evaluate(SIGNALS))
                    # B-R-001 F1: the row's own 401 is one of the page's logout starts, so it ends the other panels too.
                    self.assertEqual(1, self.page.evaluate("() => window.synOtherEnds"), "the other registered end() ran once")
                    # The answers of the requests started before the 401 paint nothing, and nothing more is read or sent.
                    count = len(self.q_requests)
                    for held in (write, read):
                        self.release_after_end(held)
                    self.target(A)
                    self.page.evaluate(TOGGLES)
                    self.settle()
                    self.assertEqual(seen, self.reader())
                    self.assertEqual((count, ["1"]), (len(self.q_requests), self.logouts))
                else:
                    self.assertEqual((True, "loading", 0), (seen["shown"], seen["state"], self.page.evaluate("() => window.synOtherEnds")),
                                     "control: the row is still up while the logout POST is held")
                self.held_logouts[0].fulfill(status=204, body="")
                self.held_logouts = None
                self.page.wait_for_url(ORIGIN + BASE + "index.html")
                expect(self.page.locator("#stand-in")).to_be_visible()
                if block is not None:
                    for held in (write, read):
                        self.release_after_end(held)

    # ── B-R-001 F1: the page's other logout starts ──
    def exits_in_flight(self, api_fn=None, log_out=None):
        """The reading screen with the shipped auth.js, main.html's own api() and Log out handler (or a control of one) and
        another panel's end() in the list; a thread open with a close reason typed, a Reply write and another thread's
        read held, and POST /auth/logout to be held when it comes."""
        self.server = QuestionServer([A, B, C])
        self.q_requests, self.held, self.holding, self.faults, self.logouts = [], [], set(), [], []
        opened, answered, _ = self.seed_threads()
        extra = EXIT_STAND_INS + (api_fn or API_FN) + "\n" + (log_out or LOG_OUT_HANDLER)
        self.open_reader(me(RADIOLOGIST, ["radiologist"]), real_auth=True, extra=extra)
        self.page.evaluate(OBSERVE_SIGNALS)
        self.page.evaluate(OTHER_PANEL)
        self.target(A)
        self.reader_state("ready")
        self.page.locator("#question-toggle").click()
        self.reader_thread(opened["id"], "Open")
        self.page.locator("#question-close-text").fill("SYN reason typed before the session end")
        self.holding = {"reply"}
        self.reader_write("reply", "SYN answer sent before the session end")
        write, = self.take("reply")
        self.holding = {"thread"}
        self.page.locator(f'#question-list > li[data-id="{answered["id"]}"] button[data-open-thread]').click()
        read, = self.take("thread")
        self.holding = set()
        self.held_logouts = []
        return opened, answered, write, read

    def assert_row_ended_and_stays(self, opened, answered, write, read):
        """Already now: nothing shown, no drafts, the question requests on the way aborted, the other end() called once.
        Afterwards their answers paint nothing, and a new target and the row's buttons read nothing."""
        seen = self.reader()
        self.assertEqual((False, "ended", None, [], None, [], []),
                         (seen["shown"], seen["state"], seen["mode"], seen["items"], seen["thread"], seen["composers"], seen["notes"]))
        self.assertEqual([[f"/api/studies/{A}/questions", False], [f"/api/questions/{opened['id']}", False],
                          [f"/api/questions/{opened['id']}/entries", True], [f"/api/questions/{answered['id']}", True]],
                         self.page.evaluate(SIGNALS))
        self.assertEqual(1, self.page.evaluate("() => window.synOtherEnds"), "the other registered end() ran once")
        count = len(self.q_requests)
        for held in (write, read):
            self.release_after_end(held)
        self.target(B)
        self.page.evaluate(TOGGLES)
        self.settle()
        self.assertEqual(seen, self.reader())
        self.assertEqual(count, len(self.q_requests), "nothing more is read or sent")

    def leave_after_the_logout_post(self, write=None, read=None):
        self.held_logouts[0].fulfill(status=204, body="")
        self.held_logouts = None
        self.page.wait_for_url(ORIGIN + BASE + "index.html")
        expect(self.page.locator("#stand-in")).to_be_visible()
        for held in (write, read):
            if held is not None:
                self.release_after_end(held)

    def test_18b_reader_api_401_ends_the_row_before_the_logout_post(self):
        # A report save through main.html's own api() gets the 401; auth.js's POST /auth/logout is held.
        for label, api_fn in (("shipped", None), ("api() without the list control", self.api_without_list)):
            with self.subTest(file=label):
                opened, answered, write, read = self.exits_in_flight(api_fn=api_fn)
                self.plain[("PUT", f"/api/studies/{A}/report")] = (401, {"statusCode": 401, "message": "SYN expired"})
                self.page.evaluate("""u => { window.synSave = api('PUT', `/studies/${encodeURIComponent(u)}/report`,
                  {findings: 'SYN findings'}).then(() => 'saved', e => e.status); }""", A)
                self.wait_until(lambda: self.held_logouts, "POST /auth/logout")
                self.settle()
                self.assertEqual((["1"], "approved", ORIGIN + BASE + "main.html"),
                                 (self.logouts, self.page.evaluate("() => KinAuth.session().state"), self.page.url),
                                 "auth.js is still waiting for its logout POST")
                if api_fn is None:
                    self.assert_row_ended_and_stays(opened, answered, write, read)
                    self.assertEqual(["1"], self.logouts)
                    self.leave_after_the_logout_post()
                else:
                    seen = self.reader()
                    self.assertEqual((True, "ready", 0), (seen["shown"], seen["state"], self.page.evaluate("() => window.synOtherEnds")),
                                     "control: the row is still up while the logout POST is held")
                    self.leave_after_the_logout_post(write, read)

    def test_18c_reader_log_out_ends_the_row_before_any_network_wait(self):
        # The header's Log out, clicked: the handler's local closes, then the draft write (held), the hold release and
        # auth.js's POST /auth/logout (held).
        local = ["confirm", "reportPreview.close", "closeSR", "endPatientCopy"]
        for label, handler in (("shipped", None), ("Log out without the list control", self.log_out_without_list)):
            with self.subTest(file=label):
                opened, answered, write, read = self.exits_in_flight(log_out=handler)
                self.page.locator("#logout").click()
                self.wait_until(lambda: self.page.evaluate("() => typeof window.synStashed === 'function'"),
                                "the draft write (stashReport) on its way")
                self.assertEqual([], self.held_logouts, "the logout POST waits for the draft write")
                if handler is None:
                    self.assertEqual(local + ["stashReport:ended"], self.page.evaluate("() => window.synCalls"))
                    self.assert_row_ended_and_stays(opened, answered, write, read)
                else:
                    self.assertEqual(local + ["stashReport:ready"], self.page.evaluate("() => window.synCalls"),
                                     "control: the row is still up while the draft is written")
                self.page.evaluate("() => window.synStashed()")
                self.wait_until(lambda: self.held_logouts, "POST /auth/logout")
                self.settle()
                self.assertEqual((["1"], "approved"), (self.logouts, self.page.evaluate("() => KinAuth.session().state")))
                seen = self.reader()
                if handler is None:
                    self.assertEqual((local + ["stashReport:ended", "releaseHold:ended"], False, 1),
                                     (self.page.evaluate("() => window.synCalls"), seen["shown"],
                                      self.page.evaluate("() => window.synOtherEnds")))
                    self.leave_after_the_logout_post()
                else:
                    self.assertEqual((True, "ready", 0), (seen["shown"], seen["state"], self.page.evaluate("() => window.synOtherEnds")),
                                     "control: and while the logout POST is held")
                    self.leave_after_the_logout_post(write, read)

    def test_18d_every_logout_start_in_main_html_calls_the_end_list_first(self):
        # Every code line of main.html that starts KinAuth.logout(), in order (comment lines left out).
        starts = [line.strip() for line in MAIN.split("\n")
                  if "KinAuth.logout()" in line and not line.lstrip().startswith(("*", "//"))]
        self.assertEqual([
            "await KinAuth.logout();",  # api()
            f"onUnauthorized: () => {{ {END_401} return KinAuth.logout(); }},",  # the dictation controller's 401
            f"if (e.ownerChanged) {{ studyPageClient.clear(); {END_401} await KinAuth.logout(); return; }}",  # list load
            "await KinAuth.logout();",  # Log out
            f"if (e.ownerChanged) {{ studyPageClient.clear(); {END_401} await KinAuth.logout(); return; }}",  # polling
            "studyQuestions = mountStudyQuestions({ apiBase: API, logout: () => KinAuth.logout(), current: () => selectedUid,",
            'logout.addEventListener("click", () => KinAuth.logout());',  # the membership screen
        ], starts)
        # api(): on the 401 line, before the await.
        self.assertIn("      if (res.status === 401) {\n" + HOOK_401 + "        await KinAuth.logout();\n", API_FN)
        # Log out: after the confirmation and the local closes, before its first network wait; the order is kept.
        marks = [LOG_OUT_HANDLER.index(s) for s in ("if (!confirm(", "endPatientCopy();", END_401, "await stashReport();",
                                                     "await releaseHold();", "await KinAuth.logout();")]
        self.assertEqual(sorted(marks), marks)
        self.assertEqual((1, 1), (LOG_OUT_HANDLER.count(END_401), MAIN.count("    let loggingOut = false;\n")))
        self.assertTrue(self.log_out_hook.endswith(HOOK_LOG_OUT[1]))
        # The row's own 401 (its mount's logout runs only from expire()): end(), the list, then the logout once.
        self.assertIn("        if (ended) return;\n        end();\n"
                      "        (window.kinOn401 || []).forEach(done => { try { done(); } catch (_) {} });\n        logout();\n",
                      READER_BLOCK)
        self.assertEqual(1, READER_BLOCK.count("      (window.kinOn401 = window.kinOn401 || []).push(end);\n"))
        # The membership screen (a pending or invalid account) is the one start without the list: allowed() needs
        # KinAuth.has(), false for such a session, so the row never read, and the page body is replaced there.
        self.assertIn("document.body.replaceChildren(panel);", extract_function(MAIN, "showMembershipState"))
        # without_u4b() after without_u4c_main() (which cuts the five shared lines) takes every S5-U4b and S5-U4c change
        # back out (the UI2/UI3 byte pins).
        from clinician_request_dom_test import without_u4c_main
        self.assertNotIn("kinOn401", without_u4b(without_u4c_main(MAIN)))

    def test_19_reader_inbox_opens_a_thread_outside_the_latest_fifty(self):
        # B: the chosen question is the oldest; 50 newer ones (answered, so not in the Open Inbox) fill B's latest 50.
        oldest = self.server.seed(B, CLINICIAN, "SYN oldest question on B")
        newer = []
        for n in range(50):
            thread = self.server.seed(B, OTHER_CLINICIAN, f"SYN newer question on B {n}")
            self.server.step(thread, "answer", RADIOLOGIST_TWO, "radiologist", f"SYN answer {n}")
            newer.append(thread)
        on_a = self.server.seed(A, CLINICIAN, "SYN open question on A")
        self.open_reader(me(RADIOLOGIST, ["radiologist"]))

        def open_from_inbox(qid):
            self.page.locator("#question-inbox").click()
            expect(self.page.locator("#question-inbox-state")).to_have_attribute("data-state", "ready")
            self.page.locator(f'#question-inbox-list > li[data-id="{qid}"] button[data-open-study]').click()

        def failed_open(fault, load):
            self.target(A)
            self.reader_state("ready")
            self.faults.append(fault)
            open_from_inbox(oldest["id"])
            expect(self.page.locator("#question-thread")).to_have_attribute("data-state", "failed")
            seen = self.reader()
            self.assertEqual((oldest["id"], load), (seen["thread"]["id"], seen["thread"]["load"]))
            self.assertEqual([False, False], [c["send"] for c in seen["composers"]])

        self.target(A)
        self.reader_state("ready")
        # A late read of an earlier choice: the Inbox thread's read is held, another thread of B is opened meanwhile.
        self.holding = {"thread"}
        open_from_inbox(oldest["id"])
        late, = self.take("thread")
        self.holding = set()
        self.assertEqual(f"/api/questions/{oldest['id']}", late["path"])
        expect(self.page.locator("#question-list > li")).to_have_count(50)
        seen = self.reader()
        self.assertEqual((B, R_COUNTS.format(n=50, o=0, a=50, c=0)), (self.page.evaluate("() => window.synSelects.at(-1)"), seen["summary"]))
        self.assertNotIn(oldest["id"], [i["id"] for i in seen["items"]])
        self.reader_thread(newer[-1]["id"], "Answered")
        self.release(late)
        seen = self.reader()
        self.assertEqual((newer[-1]["id"], "Answered"), (seen["thread"]["id"], seen["thread"]["state"]))
        # Refusals of the direct read are explicit: 404, and a thread of another study than the one opened.
        failed_open({"kind": "thread", "status": 404, "body": {"code": "QUESTION_NOT_FOUND", "message": "SYN gone"}},
                    ["failed", R_THREAD_FAILED, R_NOT_FOUND + "\nSYN gone (HTTP 404 · QUESTION_NOT_FOUND)"])
        failed_open({"kind": "thread", "apply": True, "patch": lambda p: p["item"].update(studyUid=C)},
                    ["failed", R_THREAD_FAILED, R_OTHER_STUDY])
        # Open Study: B's list (its latest 50, without the chosen question), then GET questions/:id opens the chosen one.
        self.target(A)
        self.reader_state("ready")
        reads = len(self.q_requests)
        open_from_inbox(oldest["id"])
        expect(self.page.locator("#question-thread")).to_have_attribute("data-state", "Open")
        expect(self.page.locator("#question-thread")).to_have_attribute("data-id", oldest["id"])
        self.assertEqual([("inbox", "/api/questions"), ("list", f"/api/studies/{B}/questions"), ("thread", f"/api/questions/{oldest['id']}")],
                         [(r["kind"], r["path"]) for r in self.q_requests[reads:]])
        seen = self.reader()
        self.assertEqual(("study", "SYN oldest question on B"), (seen["mode"], seen["thread"]["entries"][0]["lines"][1]))
        self.assertNotIn(oldest["id"], [i["id"] for i in seen["items"]])
        # A reply, then the list read again after the write (still without it): the chosen thread stays open.
        self.reader_write("reply", "SYN answer to the oldest question")
        self.reader_note("saved")
        expect(self.page.locator("#question-thread")).to_have_attribute("data-state", "Answered")
        seen = self.reader()
        self.assertEqual((oldest["id"], ["question", "answer"]), (seen["thread"]["id"], [e["kind"] for e in seen["thread"]["entries"]]))
        self.assertNotIn(oldest["id"], [i["id"] for i in seen["items"]])
        self.assertEqual(["reply", "list", "thread"], [r["kind"] for r in self.q_requests[-3:]])
        # A 403 on the direct read locks the row with its explicit text.
        self.faults.append({"kind": "thread", "status": 403, "body": {"code": "QUESTION_ROLE_REQUIRED", "message": "SYN refused"}})
        open_from_inbox(on_a["id"])
        seen = self.reader_state("locked")
        self.assertEqual((REFUSED, ["failed", REFUSED, "SYN refused (HTTP 403 · QUESTION_ROLE_REQUIRED)"]), (seen["summary"], seen["lock"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
