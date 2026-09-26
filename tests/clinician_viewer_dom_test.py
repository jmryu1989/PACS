# coding: utf-8
"""REQ-S5-U2b-READONLY-VIEWER -> RISK-S5-U2b-WRITE-CONTROL / RISK-S5-U2b-WRONG-PRIOR -> TEST-S5-U2b-DOM.

Two shipped surfaces, each loaded unchanged (or as a named control variant) from a synthetic origin.

Clinician Home (clinician.html + clinician.js + auth.js) against S5-U1b-shaped list and report answers:
  01  Open Viewer is enabled only for a selected study and opens the fixed OHIF path for that study in one named
      viewer window with the opener cut; Compare sends the same window to current + candidate with hpCompare; a
      blocked popup and a study UID the viewer path cannot carry are stated, and nothing is opened.
  02  comparison candidates are the listed studies with the same server patient key (sourcePatientKey) and nothing
      else: a same-name patient, a study whose displayed ID an overlay made equal, a tele study of another institution
      with the same original ID and a keyless study are never offered; an overlay-renamed study of the same key is.
      No key and no candidate are stated. Controls: the same file matching by name or by displayed ID offers the
      wrong studies.
  03  A->B->A and refresh: the candidates always belong to the selected study; a Compare button kept from before a
      list refresh re-checks the key at click time and opens nothing when the new list no longer shows one patient.
      Control: the same file without that click-time check opens the wrong pair.
  04  English controls / Korean explanations, no avoided words, text >= 12px, hit targets >= 24px, keyboard (Enter on
      Compare), external strings as text.

Viewer (config/ohif.js, the kinCreate* extensions) in a stub OHIF page (cornerstone, grid and services are in-page
stubs; tool groups, the tool group service, the toolbar, the cornerstone commands and the longitudinal mode that builds
them are modelled on the pinned bundle; the Findings / Job / Tech Note / Hanging Protocol modules are stubs that only
record a mount):
  05  a clinician-only session (/me, Keycloak default roles ignored): Measurements & Key Images reads
      GET studies/:uid/viewer-items with limit=100 and the signed cursor verbatim (never includeHidden or recheck),
      shows the saved key image and measurements as Read-only rows (the verified saved measurement drawn locked, the
      unverified one marked 재확인 필요), and offers no create / link / save control; the manual tool refuses a new
      measurement and both SR commands refuse; no Findings, Job or Tech Note module is mounted; the layout panel keeps
      only its status line. Controls: radiologist and mixed sessions get the writer panel and every module; an
      unanswered /me leaves the panel without controls and mounts no write module (Astra S5-U2b-R-001 F02 changed
      this expectation: an error is neither permission nor refusal); the same file without the read-only toolbar, or
      with the modules un-gated, offers them to the clinician.
  06  states: loading, empty (final, no item), withheld (not final), failed (404, 409 and a 400 as sent; another
      study's answer and a page of another report version refused whole) and a 403 denial; Refresh reads again.
      Control: the same file without the report-version pin paints the mixed pages.
  07  A->B->A across the comparison study: a late answer for A never paints while A's newer read is pending, nor
      over the prior. Control: the same file with only the UID check paints it.
  08  (F01) the viewer's own authoring paths are closed for a clinician-only document: the Measurements split button
      and every authoring item of More Tools leave the toolbar (viewing items stay and run); every authoring tool is
      refused through the toolbar command, the hotkey command, the tool group itself and a tool group created later,
      and a tool activated around the guard is taken down at once; only viewing tools stay Active/Passive (drawn marks
      stay Enabled) and no mark is drawn; the annotation menu, label/measurement edits, the arrow text prompt and the
      measurement panel's rename/lock refuse. Controls: a radiologist keeps the toolbar and draws; the same file with
      the policy switched off lets the clinician draw.
  09  (F02) the write-module gate: errors (500, 503, network, bad JSON) mount nothing and a later successful /me of
      the document decides (writer mounts, clinician-only does not); a document the panel confirmed clinician-only
      mounts nothing when the gate's own /me fails, and keeps that through mode re-entry with /me failing (toolbar
      trimmed, tools demoted, layout panel status only). Control: the previous gate (own read only, error = writer).
  10  (F03) the periodic/focus check follows the final report: final:false takes rows and marks down to withheld at
      once, a new version takes them down and reads the whole version again (a held then failed read leaves nothing),
      and a check answer held across A->B->A never takes the new A down. Control: the same file that drops the check
      answer keeps the retracted rows.
  11  (Astra S5-U2b-R-002 F01) authoring waits for a verified writer: with /me held, and with /me failing (500, 503,
      network, bad JSON), the toolbar is trimmed and every authoring tool through every path (toolbar, toolbar command,
      hotkey, tool group, programmatic addNewAnnotation) is refused, the menu / edits / SR refuse with the unconfirmed
      wording, and a mark made outside every guard is gone at the next tick; the delayed clinician answer leaves no mark
      but the saved one; after a passing /me failure a focus asks again and a writer answer opens tools and modules; the
      delayed radiologist answer gives back exactly the toolbar and the tool modes the mode set, and drawing works; a
      writer whose later /me is refused (403) closes authoring again, takes every write module down and loses its local
      marks. Control: the policy as it was at R-002 (closed only once clinician-only, no clean-up) lets the unconfirmed
      clinician draw, and that mark stays after the clinician answer.
  12  (R-002 F02) the final list is rechecked without an identified source frame: the list says it is not matched to the
      shown image; final:false on the focus check takes rows and marks down; a new version on the periodic (15 s) check
      is read whole, page by page with its cursor; the frame's return is checked at once and the saved mark is drawn; a
      frameless check held across A->B->A never takes the new A down. Control: the check behind frame identification
      (as at R-002) keeps the retracted rows and asks nothing.
  13  VIEWER_STATE_MATRIX: every write/mark entry point, every recheck path, the list's saved mark and Go to Image observed
      in each session state (unconfirmed, refused, read-only, writer, read-only over a writer's held work, refused with the
      other extensions' writer /me answers arriving after the refusal, and refused by the layout panel seeing another account
      first).
  14  (Astra S5-U2b-R-003 F01) the change to clinician-only voids the reads a writer had in flight: the writer's first author
      page held, another extension's /me (the module gate) answers the same account clinician-only and the page arrives late:
      no row or mark of it, only the final read verified whole, and its final:false check takes that down; a new final read
      that says final:false shows withheld only, and final:true is shown only after every page of one version (a second page
      of another version is refused whole); Refresh held across the change with no source frame (rows and marks down at
      once, the late page shows nothing); A->B->A with both of A's author pages held. Controls: the change as at R-003
      (skipped while a read was loading) with the display check alone asks no final read; with neither, the late author page
      is painted and the final:false check leaves it (Astra's reproduction).
  15  SESSION_CHANGE_MATRIX: what the panel does with reads and writes in flight across unconfirmed->writer,
      writer->read-only and read-only->writer (read-only never goes back), each row observed.
  16  (Astra S5-U2b-X-R-001 F01) a writer's held work never blocks the clinician-only final list: a writer adds a key image
      on A without saving and goes A->B->A (Resume / Discard Held Work, nothing of A drawn, Go to Image busy), then another
      extension's /me answers the same account clinician-only: the final list, its verified mark drawn locked and Go to
      Image are exactly as without held work, through Refresh, the source frame's loss and return, and final:false then
      final again; no write control and nothing of the held work is shown, and the work stays held (the unload guard).
      The writer side is unchanged (Resume gives the key image back), and a session that could leave read-only (a probe; the
      shipped one never does) gets the same key image back after the clinician-only interval. Control: the file at X-R-001
      (held work stopped every read path) shows no mark, stays suspended, answers Go to Image busy, also after Refresh.
  17  (Astra S5-U2b-X2-R-001 F01) a refusal or a real session end is the end of the document's session: every /me held, one
      producer's /me refused (the Measurements panel's 403 or 401, the module gate's 401, the layout panel's 403), then the other
      producers' writer answers, asked before it, arrive (also with only their bodies completing after the refusal): the session
      stays refused, the toolbar trimmed, every authoring path (toolbar, toolbar command, hotkey, tool group, programmatic), the
      edits and SR refuse with the ended wording, no write module mounts, the layout panel ends, a stray mark goes, and nothing asks
      /me or a list again; mode re-entry with /me answering a writer keeps it so without asking. A writer document ends the same way
      on a logout broadcast (its /me asked before it answers a writer afterwards) and on another account's answer: write modules
      come down and local marks go. Control: the file at X2-R-001 for this path (Astra's reproduction: session writer again, the
      Measurements split button back, Bidirectional made). Probes: either half of the fix alone keeps that path closed.
  18  (Astra S5-U2b-X3-R-001 F01) another account seen first by the layout panel is the end of the document's session: a writer
      document with the Measurements panel's focus /me held, then Save Recent Layout's /me or the Hanging Protocol editor's
      access check answers another writer account (or a clinician-only one): at once the session is refused, the Measurements
      panel has ended, every write module is down, the local mark is gone and nothing is stored; the held first account's writer
      answer and a mode re-entry with /me answering the other account ask nothing and open nothing (mark, edit, SR, write module,
      layout buttons, editor). The Measurements panel's own /me answering a clinician-only other account ends it the same way.
      Control: the file at X3-R-001 for these paths (Astra's reproduction: the session stays writer and the Measurements panel
      open, Bidirectional makes a mark after the held answer, and the re-entry gives the account buttons, the editor and the write
      modules back; a clinician-only other account leaves the document read-only through either panel).

Synthetic data only (SYN-* names): no server, no network, no credentials. A request the harness does not answer is
aborted and fails the case. The server half is S5-U1b (tests/clinician_read_live.py, hosted synthetic stack only).
"""
from collections import Counter
import copy
from pathlib import Path
import re
import time
import unicodedata
import unittest
from urllib.parse import parse_qs, unquote, urlparse

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"


def lf_text(path):
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


ORIGIN = "https://clinician.test"
BASE = "/worklist/hpacs-lite/"
SHIPPED = {name: lf_text(HPACS / name) for name in ("clinician.html", "clinician.js", "auth.js")}
CONFIG = lf_text(ROOT / "config" / "ohif.js")
EMBLEM = (HPACS / "kin-emblem-j1.svg").read_bytes()

INST_A, INST_B = "SYN-INST-A", "SYN-INST-B"
KEYCLOAK_DEFAULTS = ["default-roles-kin", "offline_access", "uma_authorization"]


def me(roles, sub="SYN-CLIN-SUB", user="syn-clinician", name="SYN Clinician"):
    return {"sub": sub, "actor": user, "roles": roles, "institution": INST_A, "kind": "member", "user": user,
            "displayName": name}


CLINICIAN = me(["clinician", *KEYCLOAK_DEFAULTS])
RADIOLOGIST = me(["radiologist", *KEYCLOAK_DEFAULTS], sub="SYN-RAD-SUB", user="syn-radiologist", name="SYN Radiologist")
MIXED = me(["clinician", "radiologist"], sub="SYN-MIX-SUB", user="syn-mixed", name="SYN Mixed")
# test_14/15: the same accounts after a role change (the same sub answers). MIXED loses radiologist: clinician-only. CLINICIAN
# gains radiologist: the document stays read-only.
MIXED_NOW_CLINICIAN = me(["clinician", *KEYCLOAK_DEFAULTS], sub="SYN-MIX-SUB", user="syn-mixed", name="SYN Mixed")
CLINICIAN_NOW_MIXED = me(["clinician", "radiologist"])

PREFIX = "1.2.826.0.1.3680043.10.5432"


def uid(n):
    return f"{PREFIX}.{n}"


def patient(inst, pid):
    return f"{inst}|{pid}"


HOSTILE = '<img src=x onerror="document.body.dataset.pwned=1">'
FINAL = {"final": True, "rs": "A", "action": "approve", "version": 4, "repDoc": "syn-rad", "confirm": "2026-09-20"}
OPEN = {"final": False, "rs": "W"}

# ── Clinician Home fixture ──
A, P1, P2, N, O, T, K, B = (uid(n) for n in range(11, 19))
BAD = f"{PREFIX}.19x"  # a UID the viewer path cannot carry; sorts after the others.


def study(u, name, pid, key, date, report, **extra):
    row = {"uid": u, "id": pid, "name": name, "birth": "19800517", "sex": "M", "date": date, "acc": f"SYN-ACC-{u[-2:]}",
           "desc": f"SYN DESC {u[-2:]}", "modality": "CT", "count": 10, "series": 1, "sourcePatientKey": key,
           "institutionName": "SYN Hospital A", "tele": False, "report": report}
    row.update(extra)
    return row


ROWS = [
    study(A, "SYN KIM", "SYN-P-100", patient(INST_A, "SYN-P-100"), "20260320", FINAL),
    study(P1, "SYN KIM", "SYN-P-100", patient(INST_A, "SYN-P-100"), "20250101", OPEN, desc=HOSTILE),
    # The same server key; a technician's overlay changed what is displayed.
    study(P2, "SYN KIM (EDITED)", "SYN-P-100-EDIT", patient(INST_A, "SYN-P-100"), "20240101", OPEN, modality="MR"),
    # Same name, another patient.
    study(N, "SYN KIM", "SYN-P-200", patient(INST_A, "SYN-P-200"), "20260101", OPEN),
    # Another patient whose displayed ID an overlay made equal to A's.
    study(O, "SYN LEE", "SYN-P-100", patient(INST_A, "SYN-P-300"), "20251201", OPEN),
    # Tele study from another institution with the same original PatientID.
    study(T, "SYN KIM", "SYN-P-100", patient(INST_B, "SYN-P-100"), "20251115", OPEN, tele=True,
          institutionName="SYN Hospital B"),
    study(K, "SYN NOKEY", "", None, "20250601", OPEN),
    study(B, "SYN PARK", "SYN-P-400", patient(INST_A, "SYN-P-400"), "20250301", OPEN),
    study(BAD, "SYN BADUID", "SYN-P-500", patient(INST_A, "SYN-P-500"), "20250201", OPEN),
]


def report_of(row):
    if row["report"]["final"]:
        return {"uid": row["uid"], "report": {**row["report"], "findings": "SYN findings", "conclusion": "SYN conclusion",
                                              "recommendation": ""}, "keys": []}
    return {"uid": row["uid"], "report": {"final": False, "rs": "W"}, "keys": None}


# Product wording, verbatim (clinician.js TEXT).
VIEWER = "영상은 새 창의 뷰어에서 읽기 전용으로 엽니다. 측정·키 이미지를 만들거나 저장하지 않으며 서버도 쓰기를 거절합니다."
VIEWER_ASKED = "뷰어 창에 이 검사를 열도록 요청했습니다. 영상 표시는 그 창에서 확인하세요."
COMPARE_ASKED = "뷰어 창에 이 검사와 고른 비교 검사를 나란히 열도록 요청했습니다. 영상 표시는 그 창에서 확인하세요."
BLOCKED = "브라우저가 새 창을 막아 뷰어를 열지 못했습니다. 이 사이트의 팝업을 허용한 뒤 다시 누르세요."
BAD_UID = "검사 UID 형식을 확인할 수 없어 뷰어를 열지 않았습니다."
GONE = "비교할 검사를 지금 목록에서 같은 환자로 확인할 수 없어 열지 않았습니다. 목록을 새로고침하세요."
NONE = "같은 환자 키의 다른 검사가 목록에 없어 나란히 비교할 검사가 없습니다."
NO_KEY = "이 검사에는 서버 환자 키가 없어 비교할 검사를 찾지 않습니다."
VIEWER_WINDOW = "kin-clinician-viewer"

# UXR-SP-34 / UXR-G-18 avoided words (as tests/clinician_home_dom_test.py).
AVOIDED = re.compile(r"진단|검출|판정|우선순위|diagnos|detect|priorit|\bAI\b", re.IGNORECASE)

STAND_IN = '<!doctype html><html><head><meta charset="utf-8"><title>SYN viewer stand-in</title></head><body></body></html>'

COMPARE_VIEW = """() => { const s = document.querySelector('#compare');
  return {note: document.querySelector('#viewer-note').textContent, section: s ? s.dataset.uid : null,
    candidates: s ? [...s.querySelectorAll('#compare-list li')].map(li => li.dataset.uid) : [],
    enabled: !document.querySelector('#open-viewer').disabled}; }"""

# ── Viewer fixture ──
VA, VP, VW, VE, VX, VY, VZ, VO, VQ = (uid(n) for n in range(21, 30))
VIEWER_URL = f"{ORIGIN}/ohif/viewer?StudyInstanceUIDs={VA},{VP}&hangingProtocolId=@ohif/hpCompare"
SERIES, SOP = uid(900), uid("900.1")


def item_id(n):
    return f"a0000000-0000-4000-8000-{n:012d}"


def key_item(n, title, description="", frame=1):
    return {"id": item_id(n), "revision": 1, "createdAt": "2026-09-20T00:00:00.000Z",
            "updatedAt": "2026-09-20T00:00:00.000Z",
            "item": {"schemaVersion": 1, "kind": "key", "seriesUid": SERIES, "sopUid": SOP, "frame": frame,
                     "title": title, "description": description}}


def mark_item(n, kind, label, status="verified", frame=1, revision=1):
    points = {"length": [[0, 0, 0], [1, 1, 0]], "angle": [[0, 0, 0], [1, 0, 0], [1, 1, 0]],
              "arrow": [[0, 0, 0], [1, 1, 0]]}[kind]
    item = {"schemaVersion": 1, "kind": kind, "seriesUid": SERIES, "sopUid": SOP, "frame": frame,
            "frameOfReferenceUid": "SYN-FOR", "label": label, "points": points}
    if kind != "arrow":
        item.update(viewPlaneNormal=[0, 0, -1], viewUp=[0, -1, 0],
                    baseline={"calculator": "kin-native-manual-v1", "values": [12.3]})
    row = {"id": item_id(n), "revision": revision, "createdAt": "2026-09-20T00:00:00.000Z",
           "updatedAt": "2026-09-20T00:00:00.000Z", "item": item}
    if kind != "arrow":
        row["referenceStatus"] = status
    return row


A_PAGES = [[key_item(1, "SYN-A key", "SYN-A key note"), mark_item(2, "length", "SYN-A length", revision=2)],
           [mark_item(3, "angle", "SYN-A angle", status="unverified"), mark_item(4, "arrow", "SYN-A arrow", frame=2)]]
NOT_FOUND = (404, {"statusCode": 404, "message": "검사를 찾을 수 없습니다", "error": "Not Found"})
CHANGED = (409, {"code": "VIEWER_REPORT_CHANGED", "message": "판독 상태가 바뀌었습니다. 새로고침하세요."})
DENIED = (403, {"statusCode": 403, "message": "열람 권한이 없습니다", "error": "Forbidden"})
HIDDEN_REFUSED = (400, {"statusCode": 400, "message": "숨긴 표시 항목이나 형식이 잘못된 이어받기 값으로는 조회할 수 없습니다",
                        "error": "Bad Request"})
ITEMS = {
    VA: {"version": 4, "pages": A_PAGES},
    VP: {"version": 2, "pages": [[key_item(11, "SYN-P key")]]},
    VW: "withheld",
    VE: {"version": 3, "pages": [[]]},
    VX: NOT_FOUND,
    VY: CHANGED,
    VZ: DENIED,
    VO: {"version": 5, "pages": [[key_item(21, "SYN-O key")]], "answer_uid": VA},
    VQ: {"version": 6, "pages": [[key_item(31, "SYN-Q key one")], [key_item(32, "SYN-Q key two")]], "versions": {1: 7}},
}
WRITER_HEAD = {"id": item_id(41), "revision": 1, "hidden": False, "authorSub": None, "authorActor": "SYN Radiologist",
               "referenceStatus": "verified",
               "item": {"schemaVersion": 1, "kind": "key", "seriesUid": SERIES, "sopUid": SOP, "frame": 1,
                        "title": "SYN writer key", "description": "", "hidden": False}}
# The writer list over two pages (test_13): the second page is asked with this cursor exactly.
WRITER_HEAD_2 = {**WRITER_HEAD, "id": item_id(42), "item": {**WRITER_HEAD["item"], "title": "SYN writer key two"}}
WRITER_CURSOR = "SYN-W-CURSOR_1"


def author_page(*items, cursor=None):
    # A writer (author) list answer as viewer.service lists heads, for the MIXED account's own items.
    heads = []
    for item in items:
        head = copy.deepcopy(item)
        head.update(hidden=False, authorSub=MIXED["sub"], authorActor="SYN Mixed")
        head["item"]["hidden"] = False
        heads.append(head)
    return {"items": heads, "nextCursor": cursor}


# test_14/15: author items. SHOWN_* are on screen before a change; LATE_* only ever arrive late (asked before the change). The
# verified length on the shown frame is what the panel draws when a list with it is displayed.
SHOWN_MARK, SHOWN_KEY = mark_item(81, "length", "SYN WRITER SHOWN LENGTH"), key_item(82, "SYN WRITER SHOWN KEY")
LATE_MARK, LATE_KEY = mark_item(83, "length", "SYN LATE WRITER LENGTH"), key_item(84, "SYN LATE WRITER KEY")
LATE_WRITE = key_item(85, "SYN LATE WRITTEN KEY")
# test_13/16: the title of the writer's unsaved key image the panel holds (never saved, never on a read-only screen).
HELD_TITLE = "SYN HELD WRITER KEY"

# config/ohif.js wording, verbatim (kinCreateViewerHistory READ_ONLY and its statuses).
RO_NOTE = ("읽기 전용 · 확정 판독문에 저장된 측정·키 이미지만 표시합니다. 이 화면에서는 측정·키 이미지를 만들거나 저장하지 않으며 "
           "서버도 쓰기를 거절합니다.")
RO_WITHHELD = "확정 판독문이 아니어서 저장된 측정·키 이미지를 표시하지 않습니다 · 읽기 전용"
RO_TOOL = "읽기 전용 화면입니다. 측정을 만들지 않습니다."
RO_EDIT = "읽기 전용 화면입니다. 측정·표식을 편집하지 않습니다."
RO_SR = "읽기 전용 화면에서는 SR을 만들거나 저장하지 않습니다."
RO_DENIED = "이 검사의 저장 항목을 읽을 수 없습니다(HTTP 403). 서버가 거절했습니다."
RO_UNMATCHED = ("현재 화면에서 원본 프레임을 확인할 수 없어 이 목록을 표시 영상과 맞추지 않았습니다. 마지막으로 확인한 검사 기준이며 "
                "확정 여부는 계속 다시 확인합니다.")
# (UNCONFIRMED: no successful /me yet, an error, or a 401/403.)
UNCONFIRMED_TOOL = "계정이 확인되기 전에는 영상 조작만 할 수 있습니다. 측정·표식을 만들지 않습니다."
UNCONFIRMED_EDIT = "계정이 확인되기 전에는 측정·표식을 편집하지 않습니다."
UNCONFIRMED_SR = "계정이 확인되기 전에는 SR을 만들거나 저장하지 않습니다."
# A writer's SR command reaches its own flow, which asks for a selection first.
WRITER_SR = "직접 작성한 측정을1~16개 선택하세요."
# A panel that ended (401/403 /me, logout) says so on every refused path.
ENDED = "로그인이 종료되었습니다. 다시 로그인한 뒤 뷰어를 여세요."
LOADING = "저장 항목 확인 중…"
UNVERIFIED = "재확인 필요: 원본 영상의 동일성을 확인할 수 없습니다."
WRITER_CONTROLS = {"Download SR", "Store SR", "Length", "Angle", "Ellipse ROI", "Add Key Image", "Edit", "Save", "Hide",
                   "Restore", "History", "Recheck Source", "Retry Request", "Use Latest & Keep Changes",
                   "Discard Held Changes", "Resume Held Work", "Discard Held Work"}
MODULES = {"findings", "jobs", "tech-note", "hanging-protocol"}
WRITE_MODULES = {"findings", "jobs", "tech-note"}
LATER = ["kin.viewer-findings", "kin.viewer-layout", "kin.viewer-jobs", "kin.viewer-tech-note"]

# Pinned longitudinal mode (modes/longitudinal toolbarButtons + moreTools, initToolGroups); see VIEWER_HARNESS.
PRIMARY_SECTION = ["MeasurementTools", "Zoom", "Pan", "TrackballRotate", "WindowLevel", "Capture", "Layout", "Crosshairs",
                   "MoreTools"]
VIEW_SECTION = [x for x in PRIMARY_SECTION if x != "MeasurementTools"]
MORE_TOOLS = ["Reset", "rotate-right", "flipHorizontal", "ImageSliceSync", "ReferenceLines", "ImageOverlayViewer",
              "StackScroll", "invert", "Probe", "Cine", "Angle", "CobbAngle", "Magnify", "CalibrationLine", "TagBrowser",
              "AdvancedMagnify", "UltrasoundDirectionalTool", "WindowLevelRegion"]
VIEW_MORE = ["Reset", "rotate-right", "flipHorizontal", "ImageSliceSync", "ReferenceLines", "ImageOverlayViewer",
             "StackScroll", "invert", "Cine", "Magnify", "TagBrowser"]
VIEWING = {"WindowLevel", "Pan", "Zoom", "StackScroll", "TrackballRotate", "Crosshairs", "Magnify"}
AUTHORING = ["ArrowAnnotate", "Length", "Angle", "Bidirectional", "RectangleROI", "EllipticalROI", "CircleROI", "Probe",
             "DragProbe", "CobbAngle", "CalibrationLine", "PlanarFreehandROI", "SplineROI", "LivewireContour",
             "UltrasoundDirectionalTool", "WindowLevelRegion", "PlanarFreehandContourSegmentation", "AdvancedMagnify"]
ALL_GROUPS = ["default", "mpr", "SRToolGroup", "volume3d"]

# test_13. The viewer document's session states (kinViewerSession): unconfirmed (no successful /me: none yet, 5xx, network,
# bad JSON), refused (401/403), read-only (/me says clinician only), writer (a member /me with any other app role), and
# read-only+held (Astra S5-U2b-X-R-001 F01): read-only reached from a writer whose unsaved key image on A is held
# (hold_writer_work), observed from the change on; refused+late-writer (Astra S5-U2b-X2-R-001 F01): the Measurements panel's
# /me refused (403) while the module gate's and the layout panel's /me were in flight, and those then answer a writer
# (refusal_then_late_writers). The session stays refused. refused+layout-account (Astra S5-U2b-X3-R-001 F01): a writer document
# whose layout panel sees another writer account first (Save Recent Layout's /me) while the Measurements panel's /me is held, that
# held first-account answer arriving after it (layout_sees_account_change); observed from the change on. The session is refused.
STATES = ("unconfirmed", "refused", "read-only", "writer", "read-only+held", "refused+late-writer", "refused+layout-account")
WRITER_ONLY = (False, False, False, True, False, False, False)
VIEWER_STATE_MATRIX = {
    # The list on screen: its verified saved length drawn locked (the writer list here holds key images only), and Go to Image
    # of the shown source frame through the navigation API (unconfirmed: busy; refused: ended).
    "list_mark": (False, False, True, False, True, False, False),
    "go_to_image": (False, False, True, True, True, False, False),
    # Write and mark entry points: True = works in that state, False = not offered or refused (nothing drawn, sent or mounted).
    "toolbar_offer": WRITER_ONLY,        # the Measurements split button and the authoring items of More Tools
    "toolbar_press": WRITER_ONLY,        # a press on the rendered toolbar (Bidirectional), then a primary drag
    "toolbar_command": WRITER_ONLY,      # setToolActiveToolbar over every tool group (ArrowAnnotate), then a drag
    "hotkey": WRITER_ONLY,               # the setToolActive command a hotkey runs (RectangleROI), then a drag
    "tool_group": WRITER_ONLY,           # the tool group's own setToolActive (CircleROI), then a drag
    "around_guard": WRITER_ONLY,         # an activation around the guard (the class method) stays Active
    "later_group": WRITER_ONLY,          # a tool group created later keeps its authoring tool Passive
    "tool_modes": WRITER_ONLY,           # any authoring tool Active/Passive in the mode's tool groups
    "programmatic_add": WRITER_ONLY,     # addNewAnnotation called on the tool instance (SplineROI)
    "context_menu": WRITER_ONLY,         # showCornerstoneContextMenu
    "annotation_commands": WRITER_ONLY,  # deleteMeasurement, setMeasurementLabel, updateMeasurement
    "arrow_text": WRITER_ONLY,           # a new arrow's text prompt answered with the typed text
    "measurement_panel": WRITER_ONLY,    # the measurement panel's rename (update ..., true) and lock toggle
    "sr_commands": WRITER_ONLY,          # storeMeasurements / downloadReport reach the writer's SR flow
    "panel_controls": WRITER_ONLY,       # Download SR, Store SR, Length, Angle, Ellipse ROI, Add Key Image
    "row_controls": WRITER_ONLY,         # Edit, Save, Hide, Restore, History, Recheck Source
    "findings": WRITER_ONLY,             # the Findings section (finding create and saved-item link) mounted
    "jobs": WRITER_ONLY,                 # the Job panel mounted
    "tech_note": WRITER_ONLY,            # the Tech Note bridge connected
    "layout_account": WRITER_ONLY,       # Recent Layout buttons enabled / the Hanging Protocol editor mounted
    "marks_present": WRITER_ONLY,        # any native mark left after all of the attempts above
    "stray_mark_kept": WRITER_ONLY,      # a mark made outside every guard survives the next observation tick
    "viewing": (True, True, True, True, True, True, True),  # Zoom from the toolbar, then a drag: image viewing in every state
    # Recheck paths, as the viewer-items requests the panel makes: read = the clinician list (limit=100), read-all = the writer
    # list (includeHidden=true), check = limit=1 (the clinician final check / the writer's access probe), cursor = the next
    # page asked with the handed-out cursor verbatim, none = no list request (unconfirmed: /me is asked again on focus and
    # every 15 s, and nothing is read until an answer; refused: the panel has ended).
    "initial_read": ("none", "none", "read", "read-all", "read", "none", "none"),
    "page_continuation": ("none", "none", "cursor", "cursor", "cursor", "none", "none"),
    "focus": ("none", "none", "check", "check", "check", "none", "none"),
    "me_on_focus": (True, False, True, True, True, False, False),                  # the same focus asks /me (the retry, the check, the probe)
    "periodic": ("none", "none", "check", "check", "check", "none", "none"),       # the clock moved past 15 s since the last /me
    "frame_lost": ("none", "none", "none", "none", "none", "none", "none"),        # the active viewport stops showing a source frame
    "frame_return": ("none", "none", "check", "none", "check", "none", "none"),    # the source frame comes back (clinician: checked at once)
    "frameless_focus": ("none", "none", "check", "none", "check", "none", "none"),  # focus with no source frame (writer probe stays frame-bound)
    "study_change": ("none", "none", "read", "read-all", "read", "none", "none"),  # the frame of another study
}

# test_15 (Astra S5-U2b-R-003 F01). Answers that arrive while the document's session state changes. A change is made by another
# extension's /me (the layout panel's) or by the Measurements panel's own /me. Reads: read-all = the author list
# (includeHidden=true), read = the final list, "+" joins the first pages asked in order (a duplicate read would show twice),
# "me+" = the panel asked /me again first. In flight: none = no such request can be pending in the state before the change;
# dropped = its answer arrives and nothing of it is shown; shown = it is shown; not sent = it never leaves the page.
SESSION_CHANGES = ("unconfirmed->writer", "writer->read-only", "read-only->writer")
SESSION_CHANGE_MATRIX = {
    "state_after": ("writer", "read-only", "read-only"),   # read-only is never left: a later writer /me is noted, nothing changes
    "shown_at_change": ("kept", "taken down", "kept"),     # the rows and marks on screen when the state changes
    "reads_by_other_me": ("none", "me+read", "none"),      # what the change by another extension's /me starts
    "reads_by_own_me": ("read-all", "read", "read"),       # the panel's own /me made (or met) it: that answer is the read's /me
    "read_awaiting_me": ("read-all", "read", "read"),      # the panel's read waiting for its /me when another /me changed it
    "author_first_page": ("none", "dropped", "none"),      # the author list's first page asked before, answered after
    "author_next_page": ("none", "dropped", "none"),       # a later author page (the handed-out cursor) asked before
    "author_refresh": ("none", "dropped", "none"),         # a Refresh of the shown author list asked before
    "final_page": ("none", "none", "shown"),               # a final-list page asked before, answered after
    "write_awaiting_me": ("none", "not sent", "none"),     # a Save waiting for the /me whose answer makes the change
    "write_sent": ("none", "dropped", "none"),             # a Save already sent (the server decides the write itself)
}

# Script assets the wrappers load, answered with stubs that only record a mount (the real modules have their own tests).
MODULE_STUBS = {
    "finding-link-model.js": "window.kinFindingLinkModel = { SCHEMA: 2 };",
    "viewer-findings.js": "window.kinViewerFindings = () => window.synModule('findings', ['New Finding', 'Link Saved Items'], '#kin-viewer-history');",
    "viewer-volume-job.js": "/* SYN: no volume job module */",
    "viewer-jobs.js": "window.kinViewerJobs = () => window.synModule('jobs', ['Save New Job']);",
    "tech-note.css": "",
}

VIEWER_HARNESS = r"""<!doctype html><html><head><meta charset="utf-8"><title>SYN viewer harness</title></head><body>
<script>
window.synMounted = []; window.synStopped = []; window.synNative = []; window.synNotices = []; window.synStudy = null;
// synFrameless: the active viewport shows no identifiable source frame (an MPR/volume view, an image that failed to load).
window.synFrameless = false;
// The clock the panel reads; synAdvance moves it so the 15 s periodic check falls due without waiting.
const realNow = Date.now.bind(Date); let skew = 0; Date.now = () => realNow() + skew; window.synAdvance = ms => { skew += ms; };
const SERIES = '%SERIES%', SOP = '%SOP%';
window.synImage = () => `wadors:${location.origin}/dicom-web/studies/${window.synStudy}/series/${SERIES}/instances/${SOP}/frames/1`;
const element = document.createElement('div'); document.body.append(element);
const viewport = { id: 'syn-vp', renderingEngineId: 'syn-engine', type: 'stack', element,
  getCurrentImageId: () => window.synFrameless ? undefined : window.synImage(), getImageIds: () => [window.synImage()], setImageIdIndex: async () => {},
  getCamera: () => ({ viewPlaneNormal: [0, 0, -1], viewUp: [0, -1, 0] }), render() {} };
const annotations = new Map(), locks = new Map();
window.synEdits = [];
window.cornerstone = { Enums: { Events: { STACK_NEW_IMAGE: 'syn-stack-new-image' } },
  metaData: { get: (type) => type === 'imagePlaneModule' ? { frameOfReferenceUID: 'SYN-FOR' } : undefined },
  cache: { getImage: () => null }, getEnabledElement: () => ({ viewport }), getEnabledElements: () => [] };
// A tool's own mouse-down creation: a new unlocked mark in the annotation state (the harness counts these as syn-native-*).
let drawn = 0;
const tool = name => ({ configuration: name === 'EllipticalROI'
    ? { statsCalculator: { statsCallback() {}, getStatistics: () => ({ array: [] }) }, getTextLines: () => [] } : { getTextLines: () => [] },
  addNewAnnotation() {
    window.synNative.push('add ' + name);
    const uid = 'syn-native-' + (++drawn);
    annotations.set(uid, { annotationUID: uid, metadata: { toolName: name, referencedImageId: window.synImage() }, data: { handles: { points: [] }, text: '' } });
    return { annotationUID: uid }; } });
window.synTools = { EllipticalROI: tool('EllipticalROI') };
// A mark made by a path outside every guard (a script writing the annotation state); synHas says whether it is still there.
window.synRawMark = name => { const uid = 'syn-native-' + (++drawn);
  annotations.set(uid, { annotationUID: uid, metadata: { toolName: name, referencedImageId: window.synImage() }, data: { handles: { points: [] }, text: '' } });
  return uid; };
window.synHas = uid => annotations.has(uid);

// ── The pinned OHIF around config/ohif.js: cornerstone3D tool groups (modes, primary binding, setToolPassive keeping a
// tool with another binding Active), extension-cornerstone ToolGroupService (TOOLGROUP_CREATED before tools and modes,
// TOOL_ACTIVATED), core ToolbarService (add only if absent, remove, sections) and the setToolActive / setToolActiveToolbar
// actions, and the longitudinal mode's initToolGroups + toolbarButtons + moreTools, built after the extensions' onModeEnter.
const PRIMARY = 1, SECONDARY = 2, AUXILIARY = 4, WHEEL = 524288;
const bus = () => { const handlers = new Map(); return {
  subscribe: (event, fn) => { const set = handlers.get(event) || new Set(); set.add(fn); handlers.set(event, set); return { unsubscribe: () => set.delete(fn) }; },
  emit: (event, detail) => { for (const fn of [...(handlers.get(event) || [])]) fn(detail); } }; };
const groupBus = bus(), barBus = bus(), groups = new Map();
class SynGroup {
  constructor(id) { this.id = id; this.toolOptions = {}; this.instances = {}; }
  hasTool(name) { return Object.hasOwn(this.instances, name); }
  addTool(name) { if (!this.hasTool(name)) { this.instances[name] = window.synTools[name] ||= tool(name); this.toolOptions[name] = { mode: 'Disabled', bindings: [] }; } }
  getToolInstance(name) { return this.instances[name]; }
  getToolOptions(name) { return this.toolOptions[name]; }
  setToolActive(name, options = {}) {
    if (!this.hasTool(name)) return;
    this.toolOptions[name] = { mode: 'Active', bindings: [...(options.bindings || [])] };
    groupBus.emit('syn-tool-activated', { toolGroupId: this.id, toolName: name, toolBindingsOptions: options });
  }
  setToolPassive(name) {
    if (!this.hasTool(name)) return;
    const bindings = (this.toolOptions[name].bindings || []).filter(b => b.mouseButton !== PRIMARY || b.modifierKey);
    this.toolOptions[name] = { mode: bindings.length ? 'Active' : 'Passive', bindings };
  }
  setToolEnabled(name) { if (this.hasTool(name)) this.toolOptions[name] = { mode: 'Enabled', bindings: [] }; }
  setToolDisabled(name) { if (this.hasTool(name)) this.toolOptions[name] = { mode: 'Disabled', bindings: [] }; }
  getActivePrimaryMouseButtonTool() {
    return Object.keys(this.toolOptions).find(name => this.toolOptions[name].mode === 'Active' &&
      this.toolOptions[name].bindings.some(b => b.mouseButton === PRIMARY && !b.modifierKey));
  }
}
window.SynGroup = SynGroup;
const toolGroupService = {
  EVENTS: { TOOLGROUP_CREATED: 'syn-toolgroup-created', TOOL_ACTIVATED: 'syn-tool-activated' }, subscribe: groupBus.subscribe,
  getToolGroup: id => groups.get(id || 'default'), getToolGroupIds: () => [...groups.keys()],
  createToolGroupAndAddTools(id, tools) {
    const group = new SynGroup(id); groups.set(id, group); groupBus.emit('syn-toolgroup-created', { toolGroupId: id });
    for (const mode of ['active', 'passive', 'enabled', 'disabled']) for (const t of tools[mode] || []) group.addTool(t.toolName);
    for (const t of tools.active || []) group.setToolActive(t.toolName, { bindings: t.bindings });
    for (const t of tools.passive || []) group.setToolPassive(t.toolName);
    for (const t of tools.enabled || []) group.setToolEnabled(t.toolName);
    for (const t of tools.disabled || []) group.setToolDisabled(t.toolName);
    return group;
  },
  destroy() { groups.clear(); },
};
const bar = { buttons: {}, buttonSections: {} }, barChanged = () => barBus.emit('syn-toolbar-modified');
const toolbarService = {
  EVENTS: { TOOL_BAR_MODIFIED: 'syn-toolbar-modified' }, state: bar, subscribe: barBus.subscribe,
  reset() { bar.buttons = {}; bar.buttonSections = {}; },
  addButtons(buttons) { for (const b of buttons) if (!bar.buttons[b.id]) bar.buttons[b.id] = b; barChanged(); },
  removeButton(id) { delete bar.buttons[id]; barChanged(); },
  createButtonSection(key, ids) { if (bar.buttonSections[key]) bar.buttonSections[key].push(...ids); else bar.buttonSections[key] = ids; barChanged(); },
  clearButtonSection(key) { bar.buttonSections[key] = []; barChanged(); },
  getButtons: () => bar.buttons, getButton: id => bar.buttons[id], refreshToolbarState() { barChanged(); },
};
const activeTools = { toolGroupIds: ['default', 'mpr', 'SRToolGroup', 'volume3d'] };
const toolbarCommand = { commandName: 'setToolActiveToolbar', commandOptions: activeTools };
const item = (id, commands = toolbarCommand) => ({ id, label: id, commands });
const toolbarButtons = () => [
  { id: 'MeasurementTools', uiType: 'ohif.splitButton', props: { groupId: 'MeasurementTools', primary: item('Length'),
    items: ['Length', 'Bidirectional', 'ArrowAnnotate', 'EllipticalROI', 'RectangleROI', 'CircleROI', 'PlanarFreehandROI', 'SplineROI', 'LivewireContour'].map(id => item(id)) } },
  ...['Zoom', 'WindowLevel', 'Pan', 'TrackballRotate'].map(id => ({ id, uiType: 'ohif.radioGroup', props: { commands: toolbarCommand } })),
  { id: 'Capture', uiType: 'ohif.radioGroup', props: { commands: 'showDownloadViewportModal' } },
  { id: 'Layout', uiType: 'ohif.layoutSelector', props: { rows: 3, columns: 4 } },
  { id: 'Crosshairs', uiType: 'ohif.radioGroup', props: { commands: { commandName: 'setToolActiveToolbar', commandOptions: { toolGroupIds: ['mpr'] } } } },
  { id: 'MoreTools', uiType: 'ohif.splitButton', props: { groupId: 'MoreTools', primary: item('Reset', 'resetViewport'), items: [
    item('Reset', 'resetViewport'), item('rotate-right', 'rotateViewportCW'), item('flipHorizontal', 'flipViewportHorizontal'),
    item('ImageSliceSync', { commandName: 'toggleSynchronizer', commandOptions: { type: 'imageSlice' } }),
    item('ReferenceLines', 'toggleEnabledDisabledToolbar'), item('ImageOverlayViewer', 'toggleEnabledDisabledToolbar'), item('StackScroll'),
    item('invert', 'invertViewport'), item('Probe'), item('Cine', 'toggleCine'), item('Angle'), item('CobbAngle'), item('Magnify'),
    item('CalibrationLine'), item('TagBrowser', 'openDICOMTagViewer'), item('AdvancedMagnify', 'toggleActiveDisabledToolbar'),
    item('UltrasoundDirectionalTool'), item('WindowLevelRegion')] } }];
const names = list => list.map(toolName => ({ toolName }));
const viewing = [{ toolName: 'WindowLevel', bindings: [{ mouseButton: PRIMARY }] }, { toolName: 'Pan', bindings: [{ mouseButton: AUXILIARY }] },
  { toolName: 'Zoom', bindings: [{ mouseButton: SECONDARY }] }, { toolName: 'StackScroll', bindings: [{ mouseButton: WHEEL }] }];
window.synMode = () => {
  toolbarService.reset();
  toolGroupService.createToolGroupAndAddTools('default', { active: viewing, passive: names(['Length', 'ArrowAnnotate', 'Bidirectional',
    'DragProbe', 'Probe', 'EllipticalROI', 'CircleROI', 'RectangleROI', 'StackScroll', 'Angle', 'CobbAngle', 'Magnify', 'CalibrationLine',
    'PlanarFreehandContourSegmentation', 'UltrasoundDirectionalTool', 'PlanarFreehandROI', 'SplineROI', 'LivewireContour', 'WindowLevelRegion']),
    enabled: names(['ImageOverlayViewer', 'ReferenceLines', 'SRSCOORD3DPoint']), disabled: names(['AdvancedMagnify']) });
  toolGroupService.createToolGroupAndAddTools('SRToolGroup', { active: viewing, passive: names(['SRLength', 'SRArrowAnnotate', 'SRBidirectional',
    'SREllipticalROI', 'SRCircleROI', 'SRPlanarFreehandROI', 'SRRectangleROI', 'WindowLevelRegion']), enabled: names(['DICOMSRDisplay']) });
  toolGroupService.createToolGroupAndAddTools('mpr', { active: viewing, passive: names(['Length', 'ArrowAnnotate', 'Bidirectional', 'DragProbe',
    'Probe', 'EllipticalROI', 'CircleROI', 'RectangleROI', 'StackScroll', 'Angle', 'CobbAngle', 'PlanarFreehandROI', 'WindowLevelRegion',
    'PlanarFreehandContourSegmentation']), disabled: names(['Crosshairs', 'AdvancedMagnify', 'ReferenceLines']) });
  toolGroupService.createToolGroupAndAddTools('volume3d', { active: [{ toolName: 'TrackballRotate', bindings: [{ mouseButton: PRIMARY }] },
    { toolName: 'Zoom', bindings: [{ mouseButton: SECONDARY }] }, { toolName: 'Pan', bindings: [{ mouseButton: AUXILIARY }] }] });
  toolbarService.addButtons(toolbarButtons());
  toolbarService.createButtonSection('primary', ['MeasurementTools', 'Zoom', 'Pan', 'TrackballRotate', 'WindowLevel', 'Capture', 'Layout', 'Crosshairs', 'MoreTools']);
};
window.cornerstoneTools = {
  annotation: {
    locking: { setAnnotationLocked: (uid, value) => { locks.set(uid, value); }, isAnnotationLocked: uid => locks.get(uid) === true },
    state: { getAnnotation: uid => annotations.get(uid), getAllAnnotations: () => [...annotations.values()],
      removeAnnotation: uid => { annotations.delete(uid); }, addAnnotation: a => { annotations.set(a.annotationUID, a); } },
    selection: { setAnnotationSelected() {} } },
  ToolGroupManager: { getToolGroupForViewport: () => groups.get('default'), getToolGroup: id => groups.get(id), getAllToolGroups: () => [...groups.values()] },
  Enums: { MouseBindings: { Primary: PRIMARY } } };
window.synDrawn = () => [...annotations.values()].filter(a => !String(a.annotationUID).startsWith('syn-native-'))
  .map(a => [a.metadata.toolName, a.data.label, locks.get(a.annotationUID) === true]);
window.synMarks = () => [...annotations.values()].filter(a => String(a.annotationUID).startsWith('syn-native-')).map(a => a.metadata.toolName);
window.synClearMarks = () => { for (const uid of [...annotations.keys()]) if (uid.startsWith('syn-native-')) annotations.delete(uid); };
window.synGroup = id => groups.get(id);
window.synModes = id => Object.fromEntries(Object.entries(groups.get(id)?.toolOptions || {}).map(([name, o]) => [name, o.mode]));
window.synToolbar = () => ({ primary: [...(bar.buttonSections.primary || [])], buttons: Object.keys(bar.buttons).sort(),
  more: bar.buttons.MoreTools ? bar.buttons.MoreTools.props.items.map(i => i.id) : null, morePrimary: bar.buttons.MoreTools?.props.primary?.id ?? null });
// A press on the rendered primary section, as ToolbarService.recordInteraction runs it; 'missing' when the section offers no such control.
window.synClick = id => {
  const offered = (bar.buttonSections.primary || []).flatMap(key => { const b = bar.buttons[key]; if (!b) return [];
    return Array.isArray(b.props.items) ? [b.props.primary, ...b.props.items].filter(Boolean) : [{ id: key, ...b.props }]; });
  const found = offered.find(x => x.id === id);
  if (!found) return 'missing';
  commandsManager.run(found.commands, { ...found, itemId: found.id }); return 'ran';
};
// A primary-button drag on the viewport: the active primary tool of that group handles it.
window.synDraw = (id = 'default') => {
  const group = groups.get(id), name = group && group.getActivePrimaryMouseButtonTool();
  if (!name) return 'none';
  if (['WindowLevel', 'Pan', 'Zoom', 'StackScroll', 'TrackballRotate', 'Crosshairs', 'Magnify'].includes(name)) return 'view ' + name;
  return group.getToolInstance(name).addNewAnnotation({ detail: { element } }) ? 'mark ' + name : 'refused ' + name;
};
const services = {
  cornerstoneViewportService: { getCornerstoneViewport: () => viewport },
  viewportGridService: { EVENTS: { ACTIVE_VIEWPORT_ID_CHANGED: 'syn-active' }, getActiveViewportId: () => 'syn-vp',
    getState: () => ({ activeViewportId: 'syn-vp', layout: { numRows: 1, numCols: 1, layoutType: 'grid' },
      viewports: new Map([['syn-vp', { viewportId: 'syn-vp', x: 0, y: 0, width: 1, height: 1, displaySetInstanceUIDs: [] }]]) }),
    subscribe: () => ({ unsubscribe() {} }), setDisplaySetsForViewport() {}, setActiveViewportId() {} },
  displaySetService: { getActiveDisplaySets: () => [], getDisplaySetByUID: () => undefined },
  measurementService: { getMeasurements: () => [], getMeasurement: () => undefined, remove() {}, getSourceMappings: () => [],
    update: (uid, measurement, notYetUpdatedAtSource) => { window.synEdits.push(['update', uid, notYetUpdatedAtSource === true]); },
    toggleLockMeasurement: uid => { window.synEdits.push(['lock', uid]); } },
  uiNotificationService: { show: notice => { window.synNotices.push(notice.message); } },
  toolGroupService, toolbarService,
};
window.synServices = services;
const commands = new Map(['downloadReport', 'storeMeasurements'].map(name => [name, { commandFn: () => { window.synNative.push('sr ' + name); } }]));
// The CORNERSTONE context: the tool activation actions as the pinned extension runs them, the viewing actions, and the
// annotation menu / label / measurement / arrow-text commands (recorded so a refusal is visible as their absence).
const cornerstoneCommands = new Map(), native = (name, fn) => cornerstoneCommands.set(name, { commandFn: fn });
const setToolActive = ({ toolName, toolGroupId = null }) => {
  const group = toolGroupService.getToolGroup(toolGroupId);
  if (!group || !group.hasTool(toolName)) return;
  const current = group.getActivePrimaryMouseButtonTool();
  if (current) group.setToolPassive(current);
  group.setToolActive(toolName, { bindings: [{ mouseButton: PRIMARY }] });
};
native('setToolActive', setToolActive);
native('setToolActiveToolbar', ({ value, itemId, toolName, toolGroupIds = [] }) => {
  toolName = toolName || itemId || value;
  (toolGroupIds.length ? toolGroupIds : toolGroupService.getToolGroupIds()).forEach(toolGroupId => setToolActive({ toolName, toolGroupId }));
});
native('toggleActiveDisabledToolbar', ({ value, itemId, toolGroupId }) => {
  const toolName = itemId || value, group = toolGroupService.getToolGroup(toolGroupId);
  if (!group || !group.hasTool(toolName)) return;
  if (['Active', 'Passive', 'Enabled'].includes(group.getToolOptions(toolName).mode)) group.setToolDisabled(toolName); else setToolActive({ toolName, toolGroupId });
});
for (const name of ['resetViewport', 'rotateViewportCW', 'flipViewportHorizontal', 'toggleSynchronizer', 'toggleEnabledDisabledToolbar',
  'invertViewport', 'toggleCine', 'openDICOMTagViewer', 'showDownloadViewportModal']) native(name, () => { window.synNative.push('view ' + name); });
native('showCornerstoneContextMenu', () => { window.synNative.push('menu'); });
native('deleteMeasurement', ({ uid }) => { window.synNative.push('delete ' + uid); });
native('setMeasurementLabel', ({ uid }) => { window.synNative.push('label ' + uid); });
native('updateMeasurement', ({ uid }) => { window.synNative.push('update ' + uid); });
native('arrowTextCallback', ({ callback }) => { window.synNative.push('arrow-text'); callback('SYN typed'); });
const commandsManager = {
  getCommand: (name, context) => context === 'CORNERSTONE_STRUCTURED_REPORT' ? commands.get(name)
    : context === 'CORNERSTONE' || context === undefined ? cornerstoneCommands.get(name) : undefined,
  registerCommand: (context, name, command) => {
    if (context === 'CORNERSTONE_STRUCTURED_REPORT') commands.set(name, command); else if (context === 'CORNERSTONE') cornerstoneCommands.set(name, command); },
  runCommand: (name, options = {}, context) => { const command = commandsManager.getCommand(name, context); return command?.commandFn({ ...(command.options || {}), ...options }); },
  run: (toRun, options = {}) => { for (const c of [toRun].flat().filter(Boolean))
    typeof c === 'string' ? commandsManager.runCommand(c, options) : commandsManager.runCommand(c.commandName, { ...(c.commandOptions || {}), ...options }, c.context); },
};
window.synRun = (name, options) => commandsManager.runCommand(name, options);
// A writer's SR command is the async manual SR flow: its refusal is a rejected promise, awaited here.
window.synSR = name => { try { const result = commands.get(name).commandFn({ measurementData: [] });
  return typeof result?.then === 'function' ? result.then(() => 'ran', error => 'refused: ' + error.message) : 'ran'; }
  catch (error) { return 'refused: ' + error.message; } };
window.synAddLength = () => String(window.synTools.Length.addNewAnnotation({ detail: { element } }));
// addNewAnnotation called on a tool instance directly (no mode, no toolbar): 'true' when a mark was made.
window.synAdd = name => window.synTools[name] ? String(Boolean(window.synTools[name].addNewAnnotation({ detail: { element } }))) : 'missing';
// The Tech Note bridge's dependencies as if loaded; the bridge itself and the Hanging Protocol editor record a mount.
for (const name of ['KinVolumeOrientation', 'KinVolumeDisplay', 'KinVolumeMarks', 'KinVolumePreferences', 'KinVolumeCrosshair',
  'KinVolumeBatch', 'KinVolumeBatchScout', 'KinVolumeCurved', 'KinVolumePath', 'KinWorkspaceShortcuts', 'KinViewerWindows',
  'KinViewerIdentity', 'KinHangingProtocolModel']) window[name] = {};
for (const name of ['kinCreateVolumeOrientation', 'kinCreateVolumeDisplay', 'kinCreateVolumeSync', 'kinCreateVolumeProgressive',
  'kinCreateVolumeMarks', 'kinCreateVolumePreferences', 'kinCreateVolumeCrosshair', 'kinRenderVolumeScout', 'kinCreateVolumeBatch',
  'kinCreateVolumeCurved', 'kinCreateVolumePath', 'KinTechNote', 'KinViewerWorkspaceDock']) window[name] = () => {};
window.synModule = (name, labels, host) => ({ mount() {
  window.synMounted.push(name);
  const box = document.createElement('section'); box.dataset.synModule = name;
  for (const label of labels) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; box.append(b); }
  ((host && document.querySelector(host)) || document.body).append(box); return true; }, stop() { window.synStopped.push(name); } });
window.kinViewerTechNote = () => window.synModule('tech-note', ['Tech Note']);
// Its end() disables its control, as the real editor's end() does (viewer-hanging-protocol.js refresh() with ended). synHpAccess
// is the access check the layout panel hands it (its /me and study read), as the real editor runs it before an apply or a save.
window.KinViewerHangingProtocol = { mount: options => { window.synMounted.push('hanging-protocol'); window.synHpAccess = options.access;
  const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Save to Account'; options.host.append(b);
  return { end() { b.disabled = true; } }; } };
const IDS = ['kin.viewer-history', 'kin.viewer-findings', 'kin.viewer-layout', 'kin.viewer-jobs', 'kin.viewer-tech-note'];
let extensions = [];
// As the viewer route does: extension onModeEnter first, then the mode builds its tool groups and toolbar. `enter` lets a
// case enter the other extensions later (synEnter) in the same mode.
window.synBoot = (study, enter = IDS) => {
  window.synStudy = study;
  extensions = IDS.map(id => window.config.extensions.find(e => e.id === id));
  for (const e of extensions) e.preRegistration({ servicesManager: { services }, commandsManager, extensionManager: {} });
  window.synEnter(enter);
  window.synMode();
};
window.synEnter = ids => { for (const e of extensions) if (ids.includes(e.id)) e.onModeEnter(); };
// Mode exit and re-entry in the same document: extensions leave, the mode destroys its tool groups, and all of it is built again.
window.synReenter = () => {
  for (const e of extensions) e.onModeExit();
  toolGroupService.destroy();
  window.synEnter(IDS); window.synMode();
};
window.synSwitch = study => { window.synStudy = study; document.dispatchEvent(new Event('syn-stack-new-image')); };
window.synFocus = () => { window.dispatchEvent(new Event('focus')); };
</script>
<script src="/harness/ohif.js"></script>
</body></html>""".replace("%SERIES%", SERIES).replace("%SOP%", SOP)

# The panel's own controls; a stub module mounted inside it (Findings) is counted by synMounted instead.
PANEL = """() => { const p = document.querySelector('#kin-viewer-history');
  return {state: p.dataset.readOnly ?? null, uid: p.dataset.studyUid ?? null, frame: p.dataset.frame ?? null,
    status: p.querySelector('[role=status]').textContent,
    buttons: [...p.querySelectorAll('button')].filter(b => !b.closest('[data-syn-module]')).map(b => b.textContent),
    links: [...p.querySelectorAll('a')].map(a => a.textContent), inputs: p.querySelectorAll('input, textarea').length,
    notes: [...p.querySelectorAll(':scope > div > p')].map(e => e.textContent),
    rows: [...p.querySelectorAll('section[data-item-id]')].map(s => [...s.children].map(c => c.textContent))}; }"""
# The annotation menu, the label / measurement edits, both arrow text prompts and the measurement panel's rename, sync and
# lock (as test_08 runs them); returns the arrow prompts' answers.
EDIT_ATTEMPTS = """() => { const answers = [];
  synRun('showCornerstoneContextMenu', { requireNearbyToolData: true, menuId: 'measurementsContextMenu' });
  synRun('deleteMeasurement', { uid: 'syn-uid' }); synRun('setMeasurementLabel', { uid: 'syn-uid' });
  synRun('updateMeasurement', { uid: 'syn-uid', textLabel: 'SYN' });
  synRun('arrowTextCallback', { callback: text => answers.push(['new', text ?? null]) });
  synRun('arrowTextCallback', { data: { uid: 'syn-uid' }, callback: text => answers.push(['edit', text ?? null]) });
  const m = synServices.measurementService;
  m.update('syn-uid', { label: 'SYN renamed' }, true); m.update('syn-uid', { label: 'synced' }, false); m.toggleLockMeasurement('syn-uid');
  return answers; }"""
# test_13: each write/mark entry point of VIEWER_STATE_MATRIX tried once; each tool attempt ends with a primary drag and the
# viewing tool put back (the native toolbar command), so the next attempt starts from the same place.
PROBE_WRITES = """async authoring => {
  const ALL = ['default', 'mpr', 'SRToolGroup', 'volume3d'], PRIMARY = [{ mouseButton: 1 }];
  const marked = () => [synDraw('default'), synDraw('mpr')].some(x => x.startsWith('mark '));
  const back = () => synRun('setToolActiveToolbar', { itemId: 'WindowLevel', toolGroupIds: ALL });
  const seen = {}, bar = synToolbar(), g = synGroup('default');
  seen.toolbar_offer = bar.primary.includes('MeasurementTools') || (bar.more || []).some(id => authoring.includes(id));
  seen.tool_modes = ALL.some(id => Object.entries(synModes(id)).some(([n, m]) => authoring.includes(n) && ['Active', 'Passive'].includes(m)));
  seen.viewing = synClick('Zoom') === 'ran' && synDraw('default') === 'view Zoom'; back();
  seen.toolbar_press = synClick('Bidirectional') === 'ran' && marked(); back();
  synRun('setToolActiveToolbar', { itemId: 'ArrowAnnotate', toolGroupIds: ALL }); seen.toolbar_command = marked(); back();
  synRun('setToolActive', { toolName: 'RectangleROI' }); seen.hotkey = marked(); back();
  const previous = g.getActivePrimaryMouseButtonTool(); if (previous) g.setToolPassive(previous);
  g.setToolActive('CircleROI', { bindings: PRIMARY }); seen.tool_group = marked(); back();
  SynGroup.prototype.setToolActive.call(g, 'CobbAngle', { bindings: PRIMARY });
  seen.around_guard = synModes('default').CobbAngle === 'Active'; g.setToolPassive('CobbAngle'); back();
  synServices.toolGroupService.createToolGroupAndAddTools('syn-late', { active: [{ toolName: 'WindowLevel', bindings: PRIMARY }],
    passive: [{ toolName: 'DragProbe' }] });
  seen.later_group = ['Active', 'Passive'].includes(synModes('syn-late').DragProbe);
  seen.programmatic_add = synAdd('SplineROI') === 'true';
  let from = synNative.length; synRun('showCornerstoneContextMenu', {}); seen.context_menu = synNative.slice(from).includes('menu');
  from = synNative.length;
  synRun('deleteMeasurement', { uid: 'syn-uid' }); synRun('setMeasurementLabel', { uid: 'syn-uid' }); synRun('updateMeasurement', { uid: 'syn-uid' });
  seen.annotation_commands = ['delete syn-uid', 'label syn-uid', 'update syn-uid'].every(x => synNative.slice(from).includes(x));
  let typed = null; synRun('arrowTextCallback', { callback: text => { typed = text ?? null; } }); seen.arrow_text = typed === 'SYN typed';
  from = synEdits.length; const m = synServices.measurementService;
  m.update('syn-uid', {}, true); m.toggleLockMeasurement('syn-uid');
  seen.measurement_panel = JSON.stringify(synEdits.slice(from)) === JSON.stringify([['update', 'syn-uid', true], ['lock', 'syn-uid']]);
  seen.sr = [await synSR('storeMeasurements'), await synSR('downloadReport')];
  return seen; }"""
LAYOUT = """() => { const p = document.querySelector('#kin-viewer-layout');
  return {summary: p.querySelector('summary').textContent, buttons: [...p.querySelectorAll('button')].map(b => b.textContent),
    note: p.querySelector(':scope > p').textContent}; }"""
# test_13/16: the saved items' display set, so Go to Image can reach the source frame (the stub has none); every frame change
# Go to Image asks for is recorded in synIndexed.
NAVIGABLE = """([series, sop]) => { const v = synServices.cornerstoneViewportService.getCornerstoneViewport('syn-vp');
  window.synIndexed = []; v.setImageIdIndex = async index => { window.synIndexed.push(index); };
  synServices.displaySetService.getActiveDisplaySets = () => [{ StudyInstanceUID: window.synStudy, SeriesInstanceUID: series,
    displaySetInstanceUID: 'syn-ds', images: [{ SOPInstanceUID: sop }] }]; }"""
# The navigation API the Findings section uses (kinViewerHistoryNavigate), to frame 1, highlighting `item` when given.
NAVIGATE = """([study, series, sop, item]) => window.kinViewerHistoryNavigate({ studyUid: study, seriesUid: series, sopUid: sop,
  frame: 1, ...(item ? { itemId: item } : {}) })"""


def has_hangul(text):
    return any(unicodedata.name(ch, "").startswith("HANGUL") for ch in text)


def variant(source, edits, label):
    for old, new, count in edits:
        found = source.count(old)
        if found != count:
            raise AssertionError(f"setup: {old!r} occurs {found} times in {label}, expected {count}")
        source = source.replace(old, new)
    return source


KEY_RULE = "    return row && typeof row.sourcePatientKey === 'string' && row.sourcePatientKey ? row.sourcePatientKey : null;\n"
CLICK_CHECK = ("    if (otherUid !== null && (!other || other.uid === row.uid || patientKey(row) === null || "
               "patientKey(other) !== patientKey(row))) {\n")
RO_TOOLBAR = "      if (!writer()) { if (readOnly()) text(actions, 'p', READ_ONLY.note); return; }\n"
MODULE_GATE = "kinViewerSession.decide().then(session => session === 'writer' ? ready : null)"
NOTE_GATE = "if(session==='writer'){state='stopped';connect();}else state=session;"
NOTE_CONNECT = "if(!active||state==='loading'||state==='ready'||!kinViewerSession.writer())return;"
MODULE_WATCH = "  kinViewerSession.onChange(next => { if (next !== 'writer') { epoch++; current?.stop(); current = null; } });\n"
NOTE_WATCH = ("  kinViewerSession.onChange(next=>{if(next==='writer')return;epoch++;if(active)state=next;current?.stop();"
              "current=null;});\n")
VERSION_PIN = "(version !== null && page.reportVersion !== version) ||"
VALID = "    const valid = ticket => !ended && ticket === generation && (!current() || current().study === scope);\n"
# Every list answer's display check (the page, the whole read, its failure, the final check's answer): generation, sequence and
# the read policy it was asked under.
ASKED = "    const asked = (ticket, seq, policy) => valid(ticket) && seq === readSequence && readPolicy() === policy;\n"
BOUNDARY = "      if (next === 'read-only') clinicianBoundary(own);\n"
# The change to read-only as it was at R-003: skipped while a read was loading.
R003_CHANGE = "      if (next === 'read-only') { if (!loading) { reset('저장 항목 확인 중…'); load(); } }\n"
HISTORY = "kin.viewer-history"
# test_14/15: "another extension's /me" is the layout panel's (one /me at its mount, in every session state).
OTHER = ["kin.viewer-layout"]
# test_17: the module gate (Findings, Jobs and Tech Note share one /me read) and the layout panel, entered one at a time.
GATES = ["kin.viewer-findings", "kin.viewer-jobs", "kin.viewer-tech-note"]
LAYOUT_ID = "kin.viewer-layout"
# The layout panel's wording once the document's login ended (config/ohif.js kinCreateViewerLayout end()).
LAYOUT_ENDED = "세션이 변경되었습니다. 다시 로그인한 뒤 뷰어를 여세요."
# Another writer account answering /me in the same browser (another sub): the document's login ended.
OTHER_WRITER = me(["radiologist", *KEYCLOAK_DEFAULTS], sub="SYN-RAD2-SUB", user="syn-radiologist-2", name="SYN Radiologist Two")
# test_17 late bodies: every /me response's body is held in the page until the case releases it (its status is known at once).
SLOW_ME_BODIES = """() => { const real = window.fetch.bind(window); window.synBodies = [];
  window.fetch = async (url, options) => { const response = await real(url, options);
    if (url !== '/api/me') return response;
    let release; const released = new Promise(resolve => { release = resolve; }); window.synBodies.push(release);
    return { status: response.status, ok: response.ok, json: () => released.then(() => response.json()) }; }; }"""
POLICY = "    const nativeAuthoringClosed = () => ended || !writer();\n"
# test_17 (Astra S5-U2b-X2-R-001 F01). The authoring policy and the panel's session watcher as at X2-R-001 (no ended guard, no
# end on a refusal by another extension), and the session's refused stickiness.
X2_POLICY = "    const nativeAuthoringClosed = () => !writer();\n"
ENDED_WATCH = ("      if (next === 'refused' && !ended) end();\n"
               "      if (next === 'writer' && !ended) reopenAuthoring(); else closeAuthoring();\n")
X2_WATCH = "      if (next === 'writer') reopenAuthoring(); else closeAuthoring();\n"
STICKY_REFUSED = "    if (state === 'refused') return state;\n"
# The authoring policy as it was at R-002: closed only once clinician-only, and no clean-up of marks made before that.
R002_POLICY = "    const nativeAuthoringClosed = () => readOnly();\n"
DROP_MARKS = "enforceToolbar(); dropLocalMarks(); } }"
# The final check as it was at R-002: behind the frame identification.
FRAME_FREE_CHECK = ("      if (readOnly()) { frameMatch(r); recheckShown(); }\n"
                    "      // Switching display sets briefly removes the viewport. Mode exit, not\n"
                    "      // that loading gap, owns teardown of drafts and in-flight commands.\n"
                    "      if (!r) return;\n")
FRAME_BOUND_CHECK = ("      // Switching display sets briefly removes the viewport. Mode exit, not\n"
                     "      // that loading gap, owns teardown of drafts and in-flight commands.\n"
                     "      if (!r) return;\n"
                     "      if (readOnly()) { frameMatch(r); recheckShown(); }\n")
DECIDE = "    decide() {\n      if (state === 'read-only') return Promise.resolve(state);\n"
# The gate as it was before F02: its own /me only, and an error or a non-clinician answer counts as a writer.
OLD_DECIDE = ("    decide() {\n      return fetch('/api/me', { credentials: 'same-origin', cache: 'no-store', headers: { 'X-KIN-CSRF': '1' } })\n"
              "        .then(response => response.ok ? response.json() : null)\n"
              "        .then(me => kinViewerClinicianOnly(me) ? 'read-only' : 'writer', () => 'writer');\n")
FINAL_CHECK = ("\n        .then(page => confirmShown(ticket, seq, study, page, null), "
               "error => confirmShown(ticket, seq, study, null, error))")
# test_16. The held-work gate of the read paths (marks, Go to Image, the scan, the history state): held work stops them only in a
# document that is not clinician-only. As at X-R-001 it stopped them in every session.
HELD_GATE = "    const held = () => recovery.has(scope) && !readOnly();\n"
# The session never leaves read-only; without this line a later writer /me would (a probe of the held work, not a product mode).
STICKY = "    if (state === 'read-only') return state;\n"
# test_18 (Astra S5-U2b-X3-R-001 F01). The layout panel's and the Measurements panel's account-change checks, made before note(),
# and the same authenticate() lines as at X3-R-001: note() first, then the layout panel ended only itself and the Measurements
# panel's refusal came after a verdict it could not leave (read-only).
LAYOUT_CHANGE = ("      if (confirmed && next !== confirmed) { sessionEnded(); "
                 "throw new Error('계정이 변경되어 배치를 적용하지 않았습니다.'); }\n")
LAYOUT_END = "      if (!live() || !next) { end(); throw new Error('계정이 변경되어 배치를 적용하지 않았습니다.'); }\n"
X3_LAYOUT_END = ("      if (!live() || !next || (key && next !== key)) { end(); "
                 "throw new Error('계정이 변경되어 배치를 적용하지 않았습니다.'); }\n")
PANEL_CHANGE = "      if (subject && subject !== user.sub) { sessionEnded(); throw { stale: true }; }\n"
PANEL_END = "      if (ended || !user.sub) { sessionEnded(); throw { stale: true }; }\n"
X3_PANEL_END = "      if (ended || !user.sub || (subject && subject !== user.sub)) { sessionEnded(); throw { stale: true }; }\n"
# config/ohif.js kinCreateViewerLayout wording and controls: run()'s status while it asks, the error authenticate() throws on
# another account (what the Hanging Protocol editor's access check ends with), the account buttons and the stored layout's prefix.
LAYOUT_CHECKING = "계정과 검사 접근 확인 중…"
ACCOUNT_CHANGED = "계정이 변경되어 배치를 적용하지 않았습니다."
LAYOUT_BUTTONS = ["Save Recent Layout", "Restore Recent Layout", "Delete Recent Layout"]
LAYOUT_PREFIX = "kin-viewer-layout-v1:"


class ClinicianViewerDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        home = SHIPPED["clinician.js"]
        cls.home_variants = {
            "name-key": variant(home, [(KEY_RULE, "    return row && row.name ? row.name : null;\n", 1)], "clinician.js"),
            "id-key": variant(home, [(KEY_RULE, "    return row && row.id ? row.id : null;\n", 1)], "clinician.js"),
            "no-click-check": variant(home, [(CLICK_CHECK, "    if (otherUid !== null && !other) {\n", 1)], "clinician.js"),
        }
        cls.config_variants = {
            "writer-toolbar": variant(CONFIG, [(RO_TOOLBAR, "", 1)], "config/ohif.js"),
            "modules-open": variant(CONFIG, [(MODULE_GATE, "kinViewerSession.decide().then(() => ready)", 2),
                                             (NOTE_GATE, "state='stopped';connect();", 1),
                                             (NOTE_CONNECT, "if(!active||state==='loading'||state==='ready')return;", 1),
                                             (MODULE_WATCH, "", 2), (NOTE_WATCH, "", 1)],
                                    "config/ohif.js"),
            "no-version-pin": variant(CONFIG, [(VERSION_PIN, "", 1)], "config/ohif.js"),
            "uid-only": variant(CONFIG, [(VALID, "    const valid = ticket => !ended;\n", 1),
                                         (ASKED, "    const asked = () => !ended;\n", 1)],
                                "config/ohif.js"),
            # test_14 controls: the change as at R-003 with the display check kept, and with neither (the file at R-003).
            "no-boundary": variant(CONFIG, [(BOUNDARY, R003_CHANGE, 1)], "config/ohif.js"),
            "as-r003": variant(CONFIG, [(BOUNDARY, R003_CHANGE, 1),
                                        (ASKED, "    const asked = (ticket, seq) => valid(ticket) && seq === readSequence;\n", 1)],
                               "config/ohif.js"),
            "policy-off": variant(CONFIG, [(POLICY, "    const nativeAuthoringClosed = () => false;\n", 1)], "config/ohif.js"),
            "gate-as-before": variant(CONFIG, [(DECIDE, OLD_DECIDE, 1),
                                               (NOTE_CONNECT, "if(!active||state==='loading'||state==='ready')return;", 1)],
                                      "config/ohif.js"),
            "no-final-check": variant(CONFIG, [(FINAL_CHECK, "", 1)], "config/ohif.js"),
            "as-r002": variant(CONFIG, [(POLICY, R002_POLICY, 1), (DROP_MARKS, "enforceToolbar(); } }", 1)], "config/ohif.js"),
            "frame-bound-check": variant(CONFIG, [(FRAME_FREE_CHECK, FRAME_BOUND_CHECK, 1)], "config/ohif.js"),
            # test_16: the file at X-R-001 (held work stops every read path), and a session that can leave read-only.
            "held-blocks": variant(CONFIG, [(HELD_GATE, "    const held = () => recovery.has(scope);\n", 1)], "config/ohif.js"),
            "session-leaves-read-only": variant(CONFIG, [(STICKY, "", 1)], "config/ohif.js"),
            # test_17: the file at X2-R-001 for this path, and each half of the fix alone.
            "as-x2": variant(CONFIG, [(STICKY_REFUSED, "", 1), (POLICY, X2_POLICY, 1), (ENDED_WATCH, X2_WATCH, 1)],
                             "config/ohif.js"),
            "refusal-reversible": variant(CONFIG, [(STICKY_REFUSED, "", 1)], "config/ohif.js"),
            "no-ended-guard": variant(CONFIG, [(POLICY, X2_POLICY, 1), (ENDED_WATCH, X2_WATCH, 1)], "config/ohif.js"),
            # test_18: the file at X3-R-001 for the account-change paths of both panels.
            "as-x3": variant(CONFIG, [(LAYOUT_CHANGE, "", 1), (LAYOUT_END, X3_LAYOUT_END, 1), (PANEL_CHANGE, "", 1),
                                      (PANEL_END, X3_PANEL_END, 1)], "config/ohif.js"),
        }
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.me = CLINICIAN
        self.me_status = None
        self.hold_me = False
        self.held_me = []
        self.writer_paged = False
        self.rows = copy.deepcopy(ROWS)
        self.files = dict(SHIPPED)
        self.config = CONFIG
        self.viewer_page = False
        self.items = copy.deepcopy(ITEMS)
        self.cursors = {}
        self.hold_items = set()
        self.held_items = []
        self.hold_probes = set()
        self.held_probes = []
        # test_14/15: (study, "first"|"next") writer list pages kept unanswered while the case holds them; the final list's
        # cursor pages of a study; the account the viewer-items routes serve when it is not self.me (the server's view of the
        # roles when a /me answer and a list are asked at different times); Save requests (POST) the case answers itself.
        self.hold_writer = set()
        self.held_writer = []
        self.hold_next = set()
        self.held_next = []
        self.list_me = None
        self.accept_writes = False
        self.held_writes = []
        self.writes = []
        self.item_requests = []
        self.viewer_opens = []
        self.me_requests = 0
        self.unexpected, self.errors, self.dialogs, self.finished = [], [], [], []
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 900})
        self.context.route("**/*", self.route)
        self.page = self.watched_page()

    def watched_page(self):
        page = self.context.new_page()
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.on("dialog", self.on_dialog)
        page.on("requestfinished", lambda request: self.finished.append(request))
        return page

    def fresh_page(self):
        # The next viewer document in a new page. Closing the old one runs no beforeunload handler: a document that still guards
        # held work (kinViewerHistoryHasUnsaved) would otherwise ask to stay when a goto leaves it.
        self.page.close()
        self.page = self.watched_page()

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
            if name in self.files:
                kind = "text/html" if name.endswith(".html") else "application/javascript"
                route.fulfill(body=self.files[name], content_type=f"{kind}; charset=utf-8")
                return
            if name in MODULE_STUBS:
                kind = "text/css" if name.endswith(".css") else "application/javascript"
                route.fulfill(body=MODULE_STUBS[name], content_type=f"{kind}; charset=utf-8")
                return
            if name == "kin-emblem-j1.svg":
                route.fulfill(body=EMBLEM, content_type="image/svg+xml")
                return
        if path.startswith("/kin-brand/") or path == "/favicon.ico":
            route.fulfill(status=404, body="")
            return
        if method == "GET" and path == "/ohif/viewer":
            if self.viewer_page:
                route.fulfill(body=VIEWER_HARNESS, content_type="text/html; charset=utf-8")
            else:
                self.viewer_opens.append(parse_qs(url.query, keep_blank_values=True))
                route.fulfill(body=STAND_IN, content_type="text/html; charset=utf-8")
            return
        if method == "GET" and path == "/harness/ohif.js" and self.viewer_page:
            route.fulfill(body=self.config, content_type="application/javascript; charset=utf-8")
            return
        if path.startswith("/api/") and request.headers.get("x-kin-csrf") != "1":
            self.unexpected.append(f"{method} {path} without X-KIN-CSRF")
            route.abort()
            return
        if method == "GET" and path == "/api/me":
            self.me_requests += 1
            # hold_me keeps every /me unanswered until release_me (a slow /me). me_status: None answers self.me; an HTTP
            # status, "abort" (a network failure the case asks for) or "bad-json" (200 that is not JSON) fails this /me.
            if self.hold_me:
                self.held_me.append(route)
            elif self.me_status == "abort":
                route.abort()
            elif self.me_status == "bad-json":
                route.fulfill(status=200, body="<html>SYN not JSON</html>", content_type="text/html; charset=utf-8")
            elif self.me_status:
                route.fulfill(status=self.me_status, json={"statusCode": self.me_status, "message": "SYN unavailable"})
            else:
                route.fulfill(json=self.me)
            return
        if method == "GET" and path == "/api/clinician/studies":
            query = parse_qs(url.query, keep_blank_values=True)
            if query != {"limit": ["100"]}:
                self.unexpected.append(f"{method} {request.url}")
                route.abort()
                return
            rows = sorted(self.rows, key=lambda row: row["uid"])
            route.fulfill(json={"studies": copy.deepcopy(rows), "serverTime": "2026-09-26T00:00:00.000Z",
                                "pagination": {"next": None, "total": len(rows), "offset": 0, "limit": 100}})
            return
        found = re.fullmatch(r"/api/clinician/studies/([^/]+)/report", path)
        if method == "GET" and found and not url.query:
            target = unquote(found.group(1))
            row = next((row for row in self.rows if row["uid"] == target), None)
            if row is None:
                self.unexpected.append(f"{method} {request.url}")
                route.abort()
                return
            route.fulfill(json=report_of(row))
            return
        found = re.fullmatch(r"/api/studies/([^/]+)/viewer-items", path)
        if method == "GET" and found:
            self.viewer_items(route, unquote(found.group(1)), parse_qs(url.query, keep_blank_values=True))
            return
        found = re.fullmatch(r"/api/studies/([^/]+)/viewer-items(/[^?]*)?", path)
        if method == "POST" and found and self.accept_writes:
            # test_15: a Save on the wire, held for the case to answer (late).
            self.writes.append((unquote(found.group(1)), found.group(2) or ""))
            self.held_writes.append(route)
            return
        self.unexpected.append(f"{method} {request.url}")
        route.abort()

    def clinician_session(self, account=None):
        # api/src/clinician-policy.ts clinicianOnly: app roles only, all of them clinician.
        app = [role for role in (account or self.me)["roles"] if role in ("radiologist", "technician", "admin", "clinician")]
        return bool(app) and all(role == "clinician" for role in app)

    def viewer_items(self, route, target, query):
        self.item_requests.append((target, query))
        if set(query) - {"limit", "cursor", "includeHidden", "recheck"}:
            self.unexpected.append(f"viewer-items query {query}")
            route.abort()
            return
        account = self.list_me or self.me
        if not self.clinician_session(account):
            # The writer route (viewer.service list): every head, hidden ones included; the panel's access probe reads one.
            if query == {"limit": ["1"]}:
                route.fulfill(json={"items": [], "nextCursor": None})
                return
            first = {"includeHidden": ["true"], "limit": ["100"]}
            following = {**first, "cursor": [WRITER_CURSOR]}
            if query != first and not (self.writer_paged and query == following):
                self.unexpected.append(f"writer viewer-items query {query}")
                route.abort()
                return
            if (target, "first" if query == first else "next") in self.hold_writer:
                self.held_writer.append((target, "first" if query == first else "next", route))
                return
            head = copy.deepcopy(WRITER_HEAD if query == first else WRITER_HEAD_2)
            head["authorSub"] = account["sub"]
            route.fulfill(json={"items": [head], "nextCursor": WRITER_CURSOR if self.writer_paged and query == first else None})
            return
        # clinicianViewerQuery: includeHidden only absent or 'false'; a cursor never with recheck.
        if ("includeHidden" in query and query["includeHidden"] != ["false"]) or ("cursor" in query and "recheck" in query):
            route.fulfill(status=HIDDEN_REFUSED[0], json=HIDDEN_REFUSED[1])
            return
        if query.get("limit") not in (["100"], ["1"]):
            self.unexpected.append(f"clinician viewer-items limit {query}")
            route.abort()
            return
        if query.get("limit") == ["100"] and "cursor" not in query and target in self.hold_items:
            self.held_items.append((target, route))
            return
        if query.get("limit") == ["100"] and "cursor" in query and target in self.hold_next:
            self.held_next.append((target, query["cursor"][0], route))
            return
        if query.get("limit") == ["1"] and target in self.hold_probes:
            self.hold_probes.discard(target)
            self.held_probes.append((target, route))
            return
        # The panel's periodic access probe (limit=1) is answered without handing out a cursor.
        route.fulfill(**self.clinician_page(target, query.get("cursor", [None])[0], issue=query.get("limit") == ["100"]))

    def clinician_page(self, target, cursor, issue=True):
        spec = self.items.get(target, NOT_FOUND)
        if isinstance(spec, tuple):
            return {"status": spec[0], "json": spec[1]}
        if spec == "withheld":
            return {"json": {"uid": target, "final": False, "items": None, "nextCursor": None}}
        index = 0
        if cursor is not None:
            if self.cursors.get(cursor, (None,))[0] != target:
                self.unexpected.append(f"unknown cursor {cursor!r} for {target}")
                return {"status": CHANGED[0], "json": CHANGED[1]}
            index = self.cursors[cursor][1]
        pages = spec["pages"]
        following = None
        if issue and index + 1 < len(pages):
            # base64url payload '.' base64url signature, like clinicianViewerCursor.
            following = f"eyJ2IjoxLCJTWU4iOnsicGFnZSI6{index + 1}.SYN-sig_{target[-2:]}-{len(self.cursors)}_Q"
            self.cursors[following] = (target, index + 1)
        return {"json": {"uid": spec.get("answer_uid", target), "final": True,
                         "reportVersion": spec.get("versions", {}).get(index, spec["version"]),
                         "items": copy.deepcopy(pages[index]), "nextCursor": following}}

    # ── helpers ──
    def wait_until(self, predicate, what, timeout=10.0):
        # Sync-API route handlers run on this thread while wait_for_timeout blocks.
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail(f"{what}: not observed within {timeout:.0f}s")
            self.page.wait_for_timeout(10)

    def settle(self, page=None):
        (page or self.page).evaluate("() => new Promise(resolve => setTimeout(resolve, 300))")

    def release(self, route, payload, status=200):
        request = route.request
        route.fulfill(status=status, json=payload)
        self.wait_until(lambda: any(item is request for item in self.finished), "the released answer reaching the page")
        self.settle()

    # Clinician Home
    def open_home(self, script=None):
        if script is not None:
            self.files["clinician.js"] = script
        self.page.goto(ORIGIN + BASE + "clinician.html")
        expect(self.page.locator("#list-state")).to_have_attribute("data-state", "ready")
        expect(self.page.locator("#studies tr[data-uid]")).to_have_count(len(self.rows))

    def pick(self, u):
        self.page.locator(f'#studies tr[data-uid="{u}"]').click()
        expect(self.page.locator("#detail")).to_have_attribute("data-uid", u)
        expect(self.page.locator("#report-state")).not_to_have_attribute("data-state", "loading")
        return self.page.evaluate(COMPARE_VIEW)

    def opened(self, count):
        self.wait_until(lambda: len(self.viewer_opens) >= count, f"viewer window request {count}")
        self.settle()
        self.assertEqual(count, len(self.viewer_opens), "viewer window requests")
        return self.viewer_opens[-1]

    # Viewer
    def open_viewer(self, config=None, study=VA, uncancellable=False, enter=None, before_boot=None):
        self.viewer_page = True
        self.config = CONFIG if config is None else config
        self.page.goto(VIEWER_URL)
        if uncancellable:
            # An answer already on the wire when the study changes: the panel aborts its reads on a study change, so the
            # harness drops the abort signal to let that answer arrive late, as it does once its response has started.
            self.page.evaluate("""() => { const real = window.fetch.bind(window);
              window.fetch = (url, options = {}) => { const { signal, ...rest } = options; return real(url, rest); }; }""")
        if before_boot:
            self.page.evaluate(before_boot)
        self.page.evaluate("([study, enter]) => enter ? synBoot(study, enter) : synBoot(study)", [study, enter])

    def panel(self):
        return self.page.evaluate(PANEL)

    def wait_panel(self, state, study):
        self.wait_until(lambda: (lambda p: (p["state"], p["uid"]) == (state, study))(self.panel()),
                        f"panel {state} for {study}")
        return self.panel()

    def reads(self):
        return [(target, query) for target, query in self.item_requests if query.get("limit") != ["1"]]

    def note_state(self):
        return self.page.evaluate("() => window.kinViewerNoteConnectionState()")

    def modules_settled(self):
        # The module gate answered: the Tech Note bridge left 'stopped'/'unconfirmed'.
        self.wait_until(lambda: self.note_state() not in ("stopped", "unconfirmed"), "the module gate answer")
        self.settle()

    def layout(self):
        return self.page.evaluate("""() => { const p = document.querySelector('#kin-viewer-layout');
          return {summary: p.querySelector('summary').textContent,
            buttons: [...p.querySelectorAll('button')].map(b => [b.textContent, b.disabled])}; }""")

    def probes(self):
        return len([1 for _, query in self.item_requests if query.get("limit") == ["1"]])

    def focus(self):
        # The window focus the panel listens for: its next observation tick runs the access and version check.
        self.page.evaluate("synFocus()")

    def session(self):
        return self.page.evaluate("() => kinViewerSession.state()")

    def release_me(self, answer):
        # Every /me the case held gets the same late answer; later ones are answered at once.
        self.me, self.hold_me = answer, False
        held, self.held_me = self.held_me, []
        for route in held:
            route.fulfill(json=answer)

    def frameless(self, on):
        self.page.evaluate("on => { window.synFrameless = on; }", on)

    def open_state(self, state):
        # test_13: one viewer document in the given session state, settled. read-only+held: the writer's work held for A, then
        # the same account clinician-only by the other extensions' /me; the requests are counted from that change.
        self.fresh_page()
        if state == "refused+late-writer":
            self.refusal_then_late_writers("panel", 403)
            self.settle()
            self.assertEqual("refused", self.session())
            return
        if state == "refused+layout-account":
            held, _ = self.layout_sees_account_change("save", OTHER_WRITER)
            self.release(held, RADIOLOGIST)
            # Observed from the change on: the writer document's reads and module mounts before it are not counted (test_18
            # checks that the modules came down).
            self.item_requests, self.cursors = [], {}
            self.page.evaluate("() => { synMounted.length = 0; synStopped.length = 0; }")
            self.assertEqual("refused", self.session())
            return
        if state == "read-only+held":
            self.hold_writer_work()
            start = len(self.item_requests)
            self.to_clinician_only(LATER)
            self.wait_panel("ready", VA)
            self.modules_settled()
            self.item_requests = self.item_requests[start:]
            self.settle()
            self.assertEqual("read-only", self.session())
            return
        self.me = RADIOLOGIST if state == "writer" else CLINICIAN
        self.me_status = {"unconfirmed": 503, "refused": 403}.get(state)
        self.writer_paged = state == "writer"
        self.item_requests, self.cursors, self.me_requests = [], {}, 0
        self.open_viewer()
        if state == "writer":
            self.wait_until(lambda: len(self.panel()["rows"]) == 2, "the writer list's two pages")
            self.wait_until(lambda: set(self.page.evaluate("synMounted")) == MODULES, "every module mounted")
            self.wait_until(lambda: any(not disabled for _, disabled in self.layout()["buttons"]), "the layout buttons")
        elif state == "read-only":
            self.wait_panel("ready", VA)
            self.modules_settled()
        else:
            self.wait_until(lambda: self.me_requests >= 3, "the panel's, the module gate's and the layout panel's /me")
        self.settle()
        self.assertEqual(state, self.session())

    def observe(self, action):
        # The viewer-items requests an action leads to within a few observation ticks.
        start = len(self.item_requests)
        self.page.evaluate(action)
        self.page.wait_for_timeout(900)
        return self.item_requests[start:]

    @staticmethod
    def kind(requests):
        kinds = {"check" if query.get("limit") == ["1"] else "read-all" if query.get("includeHidden") == ["true"] else "read"
                 for _, query in requests}
        return "+".join(sorted(kinds)) or "none"

    def observe_writes(self, state):
        seen = self.page.evaluate(PROBE_WRITES, AUTHORING)
        sr = tuple(seen.pop("sr"))
        refusal = {"read-only": RO_SR, "read-only+held": RO_SR, "refused": ENDED,
                   "refused+late-writer": ENDED, "refused+layout-account": ENDED}.get(state, UNCONFIRMED_SR)
        seen["sr_commands"] = {(f"refused: {WRITER_SR}",) * 2: True, (f"refused: {refusal}",) * 2: False}.get(sr, f"unexpected {sr}")
        buttons, mounted = set(self.panel()["buttons"]), set(self.page.evaluate("synMounted"))
        seen["panel_controls"] = bool(buttons & {"Download SR", "Store SR", "Length", "Angle", "Ellipse ROI", "Add Key Image"})
        seen["row_controls"] = bool(buttons & {"Edit", "Save", "Hide", "Restore", "History", "Recheck Source"})
        seen.update(findings="findings" in mounted, jobs="jobs" in mounted, tech_note=self.note_state() == "ready",
                    layout_account="hanging-protocol" in mounted or any(not disabled for _, disabled in self.layout()["buttons"]))
        seen["marks_present"] = bool(self.page.evaluate("synMarks()"))
        stray = self.page.evaluate("synRawMark('Bidirectional')")
        self.settle()
        seen["stray_mark_kept"] = self.page.evaluate("uid => synHas(uid)", stray)
        return seen

    def observe_list(self):
        self.page.evaluate(NAVIGABLE, [SERIES, SOP])
        outcome = self.page.evaluate(NAVIGATE, [VA, SERIES, SOP, None])
        return {"list_mark": ["Length", "SYN-A length", True] in self.page.evaluate("synDrawn()"),
                "go_to_image": outcome.get("ok") is True}

    def observe_rechecks(self, state):
        initial = list(self.item_requests)
        handed = [WRITER_CURSOR] if state == "writer" else list(self.cursors)
        continued = [query["cursor"][0] for _, query in initial if "cursor" in query]
        asked = self.me_requests
        seen = {"initial_read": self.kind([r for r in initial if r[1].get("limit") != ["1"]]),
                "page_continuation": "none" if not continued else "cursor" if continued == handed else f"unexpected {continued}",
                "focus": self.kind(self.observe("synFocus()")),
                "me_on_focus": self.me_requests > asked,
                "periodic": self.kind(self.observe("synAdvance(16000)")),
                "frame_lost": self.kind(self.observe("window.synFrameless = true")),
                "frame_return": self.kind(self.observe("window.synFrameless = false"))}
        self.observe("window.synFrameless = true")
        seen["frameless_focus"] = self.kind(self.observe("synFocus()"))
        seen["study_change"] = self.kind([r for r in self.observe(f"window.synFrameless = false, synSwitch('{VP}')") if r[0] == VP])
        return seen

    # ── Clinician Home ──
    def test_01_open_viewer_and_compare_use_one_named_window_with_the_opener_cut(self):
        self.open_home()
        expect(self.page.locator("#open-viewer")).to_be_disabled()
        seen = self.pick(A)
        self.assertTrue(seen["enabled"])
        with self.page.expect_popup() as info:
            self.page.locator("#open-viewer").click()
        popup = info.value
        self.assertEqual({"StudyInstanceUIDs": [A]}, self.opened(1))
        popup.wait_for_url(f"{ORIGIN}/ohif/viewer?StudyInstanceUIDs={A}")
        self.assertEqual([VIEWER_WINDOW, True], popup.evaluate("() => [window.name, window.opener === null]"))
        self.assertEqual(VIEWER_ASKED, self.page.locator("#viewer-note").text_content())

        # Compare navigates the same named window: current first, candidate second, compare hanging protocol.
        self.page.locator(f'#compare-list li[data-uid="{P1}"] button').click()
        self.assertEqual({"StudyInstanceUIDs": [f"{A},{P1}"], "hangingProtocolId": ["@ohif/hpCompare"]}, self.opened(2))
        popup.wait_for_url(f"{ORIGIN}/ohif/viewer?StudyInstanceUIDs={A},{P1}&hangingProtocolId=@ohif/hpCompare")
        self.assertEqual(2, len(self.context.pages), "one viewer window, reused")
        self.assertEqual(COMPARE_ASKED, self.page.locator("#viewer-note").text_content())

        # A UID the viewer path cannot carry and a blocked popup are stated; nothing is opened.
        self.pick(BAD)
        self.page.locator("#open-viewer").click()
        self.settle()
        self.assertEqual(BAD_UID, self.page.locator("#viewer-note").text_content())
        self.page.evaluate("() => { window.open = () => null; }")
        self.pick(A)
        self.page.locator("#open-viewer").click()
        self.assertEqual(BLOCKED, self.page.locator("#viewer-note").text_content())
        self.page.locator(f'#compare-list li[data-uid="{P2}"] button').click()
        self.assertEqual(BLOCKED, self.page.locator("#viewer-note").text_content())
        self.settle()
        self.assertEqual(2, len(self.viewer_opens))

    def test_02_candidates_are_the_same_server_patient_key_only(self):
        self.open_home()
        seen = self.pick(A)
        self.assertEqual({"note": VIEWER, "section": A, "candidates": [P1, P2], "enabled": True}, seen)
        parts = self.page.evaluate("""() => [...document.querySelectorAll('#compare-list li')].map(li =>
          [li.querySelector('span:not(.status)').textContent, li.querySelector('.status').textContent,
           li.querySelector('button').textContent, li.querySelector('p').textContent])""")
        self.assertEqual([[f"2025-01-01 · CT · {HOSTILE}", "Awaiting Report", "Compare", "SYN KIM · SYN-P-100 · SYN Hospital A"],
                          ["2024-01-01 · MR · SYN DESC 13", "Awaiting Report", "Compare",
                           "SYN KIM (EDITED) · SYN-P-100-EDIT · SYN Hospital A"]], parts)
        self.assertIsNone(self.page.evaluate("() => document.body.dataset.pwned ?? null"))
        # From the other side the relation holds too; the same-name, equal-display-ID and tele studies stand alone.
        self.assertEqual([A, P2], self.pick(P1)["candidates"])
        for lone in (N, O, T, B, BAD):
            with self.subTest(study=lone):
                self.assertEqual({"note": f"{VIEWER} {NONE}", "section": None, "candidates": [], "enabled": True},
                                 self.pick(lone))
        self.assertEqual({"note": f"{VIEWER} {NO_KEY}", "section": None, "candidates": [], "enabled": True}, self.pick(K))

        # Controls: the same file grouping by name or by displayed ID offers another patient's studies.
        for name, wrong in (("name-key", [N, P1, T]), ("id-key", [O, T, P1])):
            with self.subTest(control=name):
                self.open_home(self.home_variants[name])
                self.assertEqual(sorted(wrong), sorted(self.pick(A)["candidates"]), name)

    def test_03_a_b_a_and_refresh_keep_candidates_to_the_selected_study(self):
        for name in ("shipped", "no-click-check"):
            with self.subTest(file=name):
                self.rows = copy.deepcopy(ROWS)
                self.viewer_opens = []
                self.open_home(SHIPPED["clinician.js"] if name == "shipped" else self.home_variants[name])
                self.assertEqual([P1, P2], self.pick(A)["candidates"])
                self.page.evaluate(f"""() => {{ window.synStale = document.querySelector('#compare-list li[data-uid="{P2}"] button'); }}""")
                self.assertEqual({"note": f"{VIEWER} {NONE}", "section": None, "candidates": [], "enabled": True},
                                 self.pick(B))
                self.assertEqual({"note": VIEWER, "section": A, "candidates": [P1, P2], "enabled": True}, self.pick(A))
                # The server's patient key for P2 changes (the list now says it is another patient). Refresh takes the
                # selection down and reads A again from the new list.
                next(row for row in self.rows if row["uid"] == P2)["sourcePatientKey"] = patient(INST_A, "SYN-P-999")
                self.page.locator("#refresh").click()
                self.wait_until(lambda: self.page.evaluate(COMPARE_VIEW)["candidates"] == [P1], "A read again from the new list")
                expect(self.page.locator("#report-state")).to_have_attribute("data-state", "final")
                self.assertEqual({"note": VIEWER, "section": A, "candidates": [P1], "enabled": True},
                                 self.page.evaluate(COMPARE_VIEW))
                self.assertFalse(self.page.evaluate("() => window.synStale.isConnected"))
                # The Compare button kept from before the refresh is clicked anyway.
                self.page.evaluate("() => window.synStale.click()")
                if name == "shipped":
                    self.settle()
                    self.assertEqual([], self.viewer_opens, "a stale Compare opens nothing")
                    self.assertEqual(GONE, self.page.locator("#viewer-note").text_content())
                else:
                    self.wait_until(lambda: self.viewer_opens, "control: the wrong pair opening")
                    self.assertEqual([{"StudyInstanceUIDs": [f"{A},{P2}"], "hangingProtocolId": ["@ohif/hpCompare"]}],
                                     self.viewer_opens, "control: without the click-time check the wrong pair opens")
                for page in self.context.pages[1:]:
                    page.close()

    def test_04_wording_font_targets_and_keyboard(self):
        self.open_home()
        self.pick(A)
        labels = self.page.evaluate("""() => ({buttons: [...document.querySelectorAll('#viewer-slot button, #compare button')]
          .map(b => b.textContent), headings: [...document.querySelectorAll('#compare h3')].map(h => h.textContent)})""")
        self.assertEqual({"buttons": ["Open Viewer", "Compare", "Compare"], "headings": ["Comparison"]}, labels)
        for text in labels["buttons"] + labels["headings"]:
            self.assertFalse(has_hangul(text), text)
        explanations = [self.page.locator("#viewer-note").text_content(),
                        self.page.locator("#compare > p.muted").text_content()]
        for text in explanations:
            self.assertTrue(has_hangul(text), text)
        states = [self.page.evaluate("""() => [...document.querySelectorAll('#viewer-slot, #viewer-slot *, #compare, #compare *')]
          .filter(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()))
          .map(e => ({text: e.textContent, size: parseFloat(getComputedStyle(e).fontSize)}))""")]
        for message in (NONE, NO_KEY, BLOCKED, BAD_UID, GONE, VIEWER_ASKED, COMPARE_ASKED):
            states.append([{"text": message, "size": None}])
        for texts in states:
            for item in texts:
                with self.subTest(text=item["text"][:60]):
                    self.assertIsNone(AVOIDED.search(item["text"]))
                    if item["size"] is not None:
                        self.assertGreaterEqual(item["size"], 12)
        targets = self.page.evaluate("""() => [...document.querySelectorAll('#viewer-slot button, #compare button')]
          .map(b => { const r = b.getBoundingClientRect(); return [b.textContent, r.width, r.height]; })""")
        for text, width, height in targets:
            self.assertGreaterEqual(min(width, height), 24, text)
        # Keyboard: a Compare button is a native button; Enter on it opens the pair.
        self.page.locator(f'#compare-list li[data-uid="{P2}"] button').focus()
        with self.page.expect_popup():
            self.page.keyboard.press("Enter")
        self.assertEqual({"StudyInstanceUIDs": [f"{A},{P2}"], "hangingProtocolId": ["@ohif/hpCompare"]}, self.opened(1))
        self.assertEqual("polite", self.page.locator("#viewer-note").get_attribute("aria-live"))

    # ── Viewer ──
    def test_05_clinician_viewer_offers_no_create_link_or_save_control(self):
        self.open_viewer()
        seen = self.wait_panel("ready", VA)
        self.assertEqual("확정 판독문 r4의 저장 항목 4개 · 읽기 전용", seen["status"])
        self.assertEqual(["Refresh", "Go to Image", "Go to Image", "Go to Image", "Go to Image"], seen["buttons"])
        self.assertEqual(([], 0, [RO_NOTE]), (seen["links"], seen["inputs"], seen["notes"]))
        self.assertEqual([["Key Image · Saved r1", "Read-only", "SYN-A key", "SYN-A key note", "프레임 1", "Go to Image"],
                          ["Length · Saved r2", "Read-only", "SYN-A length", "프레임 1", "Go to Image"],
                          ["Angle · Saved r1", "Read-only", "SYN-A angle", "프레임 1", UNVERIFIED, "Go to Image"],
                          ["Arrow · Saved r1", "Read-only", "SYN-A arrow", "프레임 2", "Go to Image"]], seen["rows"])
        # The verified saved measurement on the shown frame is drawn and locked; nothing else is drawn.
        self.assertEqual([["Length", "SYN-A length", True]], self.page.evaluate("synDrawn()"))
        # Reads: the first page with limit=100 only, the next with the signed cursor exactly as it was handed back.
        cursor = next(iter(self.cursors))
        self.assertEqual([(VA, {"limit": ["100"]}), (VA, {"limit": ["100"], "cursor": [cursor]})], self.reads())
        for _, query in self.item_requests:
            self.assertNotIn("includeHidden", query)
            self.assertNotIn("recheck", query)
        # The manual tool refuses a new measurement; both SR commands refuse without running the native one.
        self.assertEqual("undefined", self.page.evaluate("synAddLength()"))
        self.assertEqual(RO_TOOL, self.panel()["status"])
        self.assertEqual([f"refused: {RO_SR}"] * 2, [self.page.evaluate("name => synSR(name)", name)
                                                      for name in ("storeMeasurements", "downloadReport")])
        self.assertEqual([], self.page.evaluate("synNative"))
        self.assertEqual([RO_SR, RO_SR], self.page.evaluate("synNotices"))
        # No Findings, Job or Tech Note module; the layout panel keeps only its status line.
        self.modules_settled()
        self.wait_until(lambda: self.page.evaluate(LAYOUT)["summary"] == "Viewer Status", "the layout panel's account")
        self.assertEqual("read-only", self.page.evaluate("kinViewerNoteConnectionState()"))
        self.assertEqual([], self.page.evaluate("synMounted"))
        self.assertEqual({"summary": "Viewer Status", "buttons": [],
                          "note": "읽기 전용 화면입니다. 배치 저장·복원과 Hanging Protocol은 제공하지 않습니다. "
                                  "화면 배치는 뷰어의 기본 레이아웃 도구로 바꿀 수 있습니다."}, self.page.evaluate(LAYOUT))
        self.assertEqual(0, self.page.locator("[data-syn-module]").count())
        for text in [seen["status"], RO_NOTE, RO_TOOL, RO_SR, RO_WITHHELD, RO_DENIED, *sum(seen["rows"], [])]:
            self.assertIsNone(AVOIDED.search(text), text)

    def test_05b_writer_sessions_unanswered_me_and_controls(self):
        # Radiologist and mixed sessions keep the writer panel and every module (the rule is the server's clinicianOnly).
        for session in (RADIOLOGIST, MIXED):
            with self.subTest(session=session["roles"]):
                self.me = session
                self.item_requests, self.cursors = [], {}
                self.open_viewer()
                self.wait_until(lambda: "SYN writer key" in str(self.panel()["rows"]), "writer panel")
                self.wait_until(lambda: set(self.page.evaluate("synMounted")) == MODULES, "every module mounted")
                seen = self.panel()
                self.assertTrue({"Download SR", "Store SR", "Length", "Angle", "Ellipse ROI", "Add Key Image", "Edit",
                                 "Hide", "History"} <= set(seen["buttons"]), seen["buttons"])
                self.assertEqual(4, len(self.page.evaluate("synMounted")))
                self.assertEqual([(VA, {"includeHidden": ["true"], "limit": ["100"]})], self.reads())
                self.page.evaluate("synAddLength()")
                self.assertNotEqual(RO_TOOL, self.panel()["status"])
        # An unanswered /me: the panel draws no control at all and no write module mounts. (Before Astra
        # S5-U2b-R-001 F02 this expected the modules to mount as before; an error is neither permission nor refusal,
        # so the gate now waits for a successful answer: test_09.) The Tech Note bridge stays unconfirmed and the layout
        # panel, which has no account, keeps its buttons disabled.
        self.me, self.me_status, self.item_requests, self.me_requests = CLINICIAN, 500, [], 0
        self.open_viewer()
        self.wait_until(lambda: self.me_requests >= 3, "the panel's, the module gate's and the layout panel's /me")
        self.settle()
        self.assertEqual([], self.page.evaluate("synMounted"))
        self.assertEqual("unconfirmed", self.note_state())
        self.assertEqual([], self.panel()["buttons"])
        self.assertEqual([], self.reads())
        self.assertTrue(all(disabled for _, disabled in self.layout()["buttons"]), self.layout())
        # Controls: the clinician is offered the writer toolbar, or the modules, by the same file without each gate.
        self.me, self.me_status = CLINICIAN, None
        self.open_viewer(self.config_variants["writer-toolbar"])
        self.wait_panel("ready", VA)
        self.assertTrue({"Download SR", "Store SR", "Length", "Angle", "Ellipse ROI", "Add Key Image"}
                        <= set(self.panel()["buttons"]), "control: writer toolbar")
        self.open_viewer(self.config_variants["modules-open"])
        self.wait_panel("ready", VA)
        self.wait_until(lambda: len(self.page.evaluate("synMounted")) >= 3, "control: modules mounted")
        self.assertEqual({"findings", "jobs", "tech-note"}, set(self.page.evaluate("synMounted")))

    def test_06_states_loading_empty_withheld_failed_and_denied(self):
        self.hold_items = {VA}
        self.open_viewer()
        self.wait_until(lambda: self.held_items, "the held first read")
        seen = self.panel()
        self.assertEqual(("loading", LOADING, ["Refresh"], []), (seen["state"], seen["status"], seen["buttons"], seen["rows"]))
        self.hold_items = set()
        self.release(self.held_items.pop()[1], {"uid": VA, "final": True, "reportVersion": 4, "items": [], "nextCursor": None})
        self.assertEqual("empty", self.panel()["state"])
        cases = [
            (VE, "empty", "확정 판독문 r3에 저장된 측정·키 이미지가 없습니다 · 읽기 전용", ["Refresh"]),
            (VW, "withheld", RO_WITHHELD, ["Refresh"]),
            (VX, "failed", "저장 항목을 불러오지 못했습니다. 검사를 찾을 수 없습니다 (HTTP 404) Refresh로 다시 읽으세요.", ["Refresh"]),
            (VY, "failed", "저장 항목을 불러오지 못했습니다. 판독 상태가 바뀌었습니다. 새로고침하세요. (HTTP 409 · VIEWER_REPORT_CHANGED) "
                           "Refresh로 다시 읽으세요.", ["Refresh"]),
            (VO, "failed", "저장 항목을 불러오지 못했습니다. 응답 형식을 확인할 수 없습니다. Refresh로 다시 읽으세요.", ["Refresh"]),
            (VQ, "failed", "저장 항목을 불러오지 못했습니다. 응답 형식을 확인할 수 없습니다. Refresh로 다시 읽으세요.", ["Refresh"]),
            (VZ, "denied", RO_DENIED, ["Recheck Access"]),
        ]
        for target, state, status, buttons in cases:
            with self.subTest(study=target, state=state):
                self.page.evaluate("study => synSwitch(study)", target)
                self.wait_panel(state, target)
                self.settle()
                seen = self.panel()
                self.assertEqual((state, status, buttons, []), (seen["state"], seen["status"], seen["buttons"], seen["rows"]))
        # The mixed-version pages were both requested and neither painted.
        self.assertEqual(2, len([1 for target, _ in self.reads() if target == VQ]))
        # A 400 as sent: the harness refuses what the server would, e.g. a hidden-item read.
        self.items[VE] = HIDDEN_REFUSED
        self.page.evaluate("study => synSwitch(study)", VE)
        self.wait_panel("failed", VE)
        self.assertEqual("저장 항목을 불러오지 못했습니다. 숨긴 표시 항목이나 형식이 잘못된 이어받기 값으로는 조회할 수 없습니다 "
                         "(HTTP 400) Refresh로 다시 읽으세요.", self.panel()["status"])
        # Refresh reads again.
        self.items[VE] = {"version": 3, "pages": [[key_item(51, "SYN-E key")]]}
        self.page.get_by_role("button", name="Refresh", exact=True).click()
        seen = self.wait_panel("ready", VE)
        self.assertEqual([["Key Image · Saved r1", "Read-only", "SYN-E key", "프레임 1", "Go to Image"]], seen["rows"])
        # Control: without the report-version pin the page of another version is painted onto the first.
        self.item_requests, self.cursors = [], {}
        self.open_viewer(self.config_variants["no-version-pin"], study=VQ)
        seen = self.wait_panel("ready", VQ)
        self.assertEqual(["SYN-Q key one", "SYN-Q key two"], [row[2] for row in seen["rows"]], "control: mixed pages painted")

    def test_07_a_b_a_across_the_comparison_study(self):
        old = {"uid": VA, "final": True, "reportVersion": 4, "items": [key_item(61, "SYN-A-OLD")], "nextCursor": None}
        for name in ("shipped", "uid-only"):
            with self.subTest(file=name):
                self.item_requests, self.cursors, self.held_items = [], {}, []
                self.hold_items = {VA}
                self.open_viewer(CONFIG if name == "shipped" else self.config_variants[name], uncancellable=True)
                self.wait_until(lambda: len(self.held_items) == 1, "A's first read held")
                first = self.held_items[0][1]
                self.page.evaluate("study => synSwitch(study)", VP)
                seen = self.wait_panel("ready", VP)
                self.assertEqual([["Key Image · Saved r1", "Read-only", "SYN-P key", "프레임 1", "Go to Image"]], seen["rows"])
                self.page.evaluate("study => synSwitch(study)", VA)
                self.wait_until(lambda: len(self.held_items) == 2, "A's second read held")
                second = self.held_items[1][1]
                self.release(first, old)
                seen = self.panel()
                if name == "shipped":
                    self.assertEqual(("loading", LOADING, []), (seen["state"], seen["status"], seen["rows"]),
                                     "A's late first answer does not paint while its newer read is pending")
                else:
                    self.assertEqual([["Key Image · Saved r1", "Read-only", "SYN-A-OLD", "프레임 1", "Go to Image"]],
                                     seen["rows"], "control: a UID-only guard paints A's late first answer")
                    # Leave no read held when the context closes.
                    self.release(second, {"uid": VA, "final": True, "reportVersion": 4, "items": [], "nextCursor": None})
                    continue
                self.hold_items = set()
                self.release(second, self.clinician_page(VA, None)["json"])
                seen = self.wait_panel("ready", VA)
                self.assertEqual(["SYN-A key", "SYN-A length", "SYN-A angle", "SYN-A arrow"], [row[2] for row in seen["rows"]])
                self.assertNotIn("SYN-A-OLD", str(seen))
                self.assertNotIn("SYN-P", str(seen))

    # ── Astra S5-U2b-R-001 regressions ──
    def attempt_every_authoring_tool(self):
        # Every way the pinned viewer turns a tool on: the rendered toolbar, the toolbar command over all tool groups,
        # the setToolActive command a hotkey runs, and the tool group itself. Each attempt is followed by a primary drag.
        outcomes = {}
        for name in AUTHORING:
            outcomes[name] = self.page.evaluate("""name => {
              const drag = () => [synDraw('default'), synDraw('mpr')];
              const seen = { click: synClick(name) }; seen.afterClick = drag();
              synRun('setToolActiveToolbar', { itemId: name, toolGroupIds: ['default', 'mpr', 'SRToolGroup', 'volume3d'] }); seen.toolbar = drag();
              synRun('setToolActive', { toolName: name }); seen.hotkey = drag();
              synGroup('default').setToolActive(name, { bindings: [{ mouseButton: 1 }] }); seen.group = drag();
              synGroup('default').setToolPassive(name); seen.passive = synModes('default')[name];
              return seen; }""", name)
        return outcomes

    def test_08_native_authoring_paths_are_closed_for_a_clinician(self):
        self.open_viewer()
        self.wait_panel("ready", VA)
        self.wait_until(lambda: self.page.evaluate("synToolbar()")["primary"] == VIEW_SECTION, "the trimmed toolbar")
        bar = self.page.evaluate("synToolbar()")
        self.assertEqual((VIEW_SECTION, VIEW_MORE, "Reset"), (bar["primary"], bar["more"], bar["morePrimary"]))
        self.assertNotIn("MeasurementTools", bar["buttons"])
        # Only viewing tools stay Active or Passive in any tool group; the others only show what is drawn (Enabled).
        for group in ALL_GROUPS:
            with self.subTest(group=group):
                modes = self.page.evaluate("id => synModes(id)", group)
                self.assertEqual({}, {n: m for n, m in modes.items() if m in ("Active", "Passive") and n not in VIEWING})
        self.assertEqual(["view WindowLevel", "view WindowLevel"], self.page.evaluate("[synDraw('default'), synDraw('mpr')]"))
        # Every authoring tool through every path: not offered, refused, and the viewing tool the refusal left is back.
        for name, seen in self.attempt_every_authoring_tool().items():
            with self.subTest(tool=name):
                view = ["view WindowLevel", "view WindowLevel"]
                self.assertEqual({"click": "missing", "afterClick": view, "toolbar": view, "hotkey": view, "group": view},
                                 {k: v for k, v in seen.items() if k != "passive"})
                self.assertIn(seen["passive"], ("Enabled", "Disabled"))
        self.assertEqual(RO_TOOL, self.panel()["status"])
        # Viewing stays: Zoom, Stack Scroll, Crosshairs (MPR) and Reset still run from the toolbar.
        self.assertEqual(["ran", "view Zoom", "ran", "view StackScroll", "ran", "view Crosshairs", "ran"], self.page.evaluate(
            """() => [synClick('Zoom'), synDraw('default'), synClick('StackScroll'), synDraw('default'), synClick('Crosshairs'),
                     synDraw('mpr'), synClick('Reset')]"""))
        self.page.evaluate("synRun('setToolActive', { toolName: 'WindowLevel' })")
        # A tool group created after the confirmation is guarded from its first mode; an activation around the guard (the
        # tool group's own method) is taken down at once.
        late = self.page.evaluate("""() => { synServices.toolGroupService.createToolGroupAndAddTools('syn-late', {
            active: [{ toolName: 'WindowLevel', bindings: [{ mouseButton: 1 }] }], passive: [{ toolName: 'Length' }, { toolName: 'ArrowAnnotate' }] });
          synGroup('syn-late').setToolActive('ArrowAnnotate', { bindings: [{ mouseButton: 1 }] });
          const created = [synModes('syn-late'), synDraw('syn-late')];
          SynGroup.prototype.setToolActive.call(synGroup('default'), 'Bidirectional', { bindings: [{ mouseButton: 1 }] });
          return [...created, synModes('default').Bidirectional, synDraw('default')]; }""")
        self.assertEqual([{"WindowLevel": "Active", "Length": "Enabled", "ArrowAnnotate": "Enabled"}, "view WindowLevel",
                          "Enabled", "view WindowLevel"], late)
        # The annotation menu, the label / measurement edits and the measurement panel's rename and lock refuse; a new
        # arrow's text prompt answers empty (the native tool cancels that drawing), an existing arrow's is left unanswered.
        answers = self.page.evaluate("""() => { const answers = [];
          synRun('showCornerstoneContextMenu', { requireNearbyToolData: true, menuId: 'measurementsContextMenu' });
          synRun('deleteMeasurement', { uid: 'syn-uid' }); synRun('setMeasurementLabel', { uid: 'syn-uid' });
          synRun('updateMeasurement', { uid: 'syn-uid', textLabel: 'SYN' });
          synRun('arrowTextCallback', { callback: text => answers.push(['new', text ?? null]) });
          synRun('arrowTextCallback', { data: { uid: 'syn-uid' }, callback: text => answers.push(['edit', text ?? null]) });
          const m = synServices.measurementService;
          m.update('syn-uid', { label: 'SYN renamed' }, true); m.update('syn-uid', { label: 'synced' }, false); m.toggleLockMeasurement('syn-uid');
          return answers; }""")
        self.assertEqual([["new", None]], answers)
        self.assertEqual([["update", "syn-uid", False]], self.page.evaluate("synEdits"))
        self.assertEqual(RO_EDIT, self.panel()["status"])
        self.assertEqual(["view resetViewport"], self.page.evaluate("synNative"))
        self.assertEqual([], self.page.evaluate("synMarks()"))
        # The saved marks the panel drew are still shown, locked.
        self.assertEqual([["Length", "SYN-A length", True]], self.page.evaluate("synDrawn()"))
        self.assertIsNone(AVOIDED.search(RO_EDIT))

        # Control: a radiologist keeps the whole toolbar, draws, and the menu and edits run.
        self.me, self.item_requests, self.cursors = RADIOLOGIST, [], {}
        self.open_viewer()
        self.wait_until(lambda: "SYN writer key" in str(self.panel()["rows"]), "writer panel")
        bar = self.page.evaluate("synToolbar()")
        self.assertEqual((PRIMARY_SECTION, MORE_TOOLS), (bar["primary"], bar["more"]))
        self.assertEqual(["ran", "mark ArrowAnnotate"], self.page.evaluate("[synClick('ArrowAnnotate'), synDraw('default')]"))
        self.page.evaluate("""() => { synRun('showCornerstoneContextMenu', {}); synRun('setMeasurementLabel', { uid: 'syn-uid' });
          synServices.measurementService.update('syn-uid', {}, true); }""")
        self.assertEqual(["ArrowAnnotate"], self.page.evaluate("synMarks()"))
        self.assertEqual(["add ArrowAnnotate", "menu", "label syn-uid"], self.page.evaluate("synNative"))
        self.assertEqual([["update", "syn-uid", True]], self.page.evaluate("synEdits"))
        self.page.evaluate("synClearMarks()")

        # Control: the same file with the policy switched off lets the clinician draw from the default toolbar.
        self.me, self.item_requests, self.cursors = CLINICIAN, [], {}
        self.open_viewer(self.config_variants["policy-off"])
        self.wait_panel("ready", VA)
        self.settle()
        self.assertIn("MeasurementTools", self.page.evaluate("synToolbar()")["primary"], "control: toolbar kept")
        self.assertEqual(["ran", "mark Bidirectional"], self.page.evaluate("[synClick('Bidirectional'), synDraw('default')]"),
                         "control: the clinician draws")
        self.page.evaluate("synClearMarks()")

    def test_09_module_gate_waits_for_a_confirmed_writer_and_keeps_clinician_only(self):
        # Errors are neither permission nor refusal: nothing mounts, and the document's next successful /me decides.
        for failure in (500, 503, "abort", "bad-json"):
            with self.subTest(every_me=failure):
                self.me, self.me_status, self.me_requests, self.item_requests = CLINICIAN, failure, 0, []
                self.open_viewer()
                self.wait_until(lambda: self.me_requests >= 3, "every /me asked")
                self.settle()
                self.assertEqual(([], "unconfirmed"), (self.page.evaluate("synMounted"), self.note_state()))
        for session, mounted, state in ((RADIOLOGIST, WRITE_MODULES, "ready"), (CLINICIAN, set(), "read-only")):
            with self.subTest(later=session["roles"][0]):
                self.me, self.me_status, self.me_requests, self.item_requests, self.cursors = session, 503, 0, [], {}
                self.open_viewer()
                self.wait_until(lambda: self.me_requests >= 3, "every /me asked")
                self.settle()
                self.assertEqual([], self.page.evaluate("synMounted"))
                # The panel reads the next study with /me answering again; that answer decides the waiting modules.
                self.me_status = None
                self.page.evaluate("study => synSwitch(study)", VP)
                self.wait_until(lambda: self.note_state() == state, f"the bridge {state}")
                self.settle()
                self.assertEqual(mounted, set(self.page.evaluate("synMounted")))

        # The panel confirmed clinician-only; the modules enter afterwards and their gate's own /me fails.
        for name, failures in (("shipped", (500, 503, "abort", "bad-json")), ("gate-as-before", (503,))):
            for failure in failures:
                with self.subTest(file=name, gate=failure):
                    self.me, self.me_status, self.me_requests, self.item_requests, self.cursors = CLINICIAN, None, 0, [], {}
                    self.open_viewer(CONFIG if name == "shipped" else self.config_variants[name], enter=["kin.viewer-history"])
                    self.wait_panel("ready", VA)
                    self.me_status = failure
                    self.page.evaluate("ids => synEnter(ids)", LATER)
                    if name == "shipped":
                        self.wait_until(lambda: self.note_state() == "read-only", "the bridge read-only")
                        self.wait_until(lambda: self.layout()["summary"] == "Viewer Status", "the layout panel status only")
                        self.settle()
                        self.assertEqual(([], []), (self.page.evaluate("synMounted"), self.layout()["buttons"]))
                    else:
                        self.wait_until(lambda: len(self.page.evaluate("synMounted")) >= 3, "control: modules mounted")
                        self.assertEqual(WRITE_MODULES, set(self.page.evaluate("synMounted")),
                                         "control: the previous gate mounts write modules on an error")

        # Mode exit and re-entry of that document with /me failing: still clinician-only everywhere.
        for name in ("shipped", "gate-as-before"):
            with self.subTest(reenter=name):
                self.me, self.me_status, self.me_requests, self.item_requests, self.cursors = CLINICIAN, None, 0, [], {}
                self.open_viewer(CONFIG if name == "shipped" else self.config_variants[name])
                self.wait_panel("ready", VA)
                self.modules_settled()
                self.me_status, self.me_requests = 503, 0
                after = self.page.evaluate("""() => { synReenter();
                  return [synToolbar().primary, Object.entries(synModes('default')).filter(([n, m]) => ['Active', 'Passive'].includes(m)).map(([n]) => n).sort()]; }""")
                if name == "shipped":
                    # Built again after re-entry and already trimmed and guarded, before any /me of the new entry answered.
                    self.assertEqual([VIEW_SECTION, ["Magnify", "Pan", "StackScroll", "WindowLevel", "Zoom"]], after)
                    self.wait_until(lambda: self.me_requests >= 2, "the re-entered panels' /me (the gate asks none)")
                    self.settle()
                    self.assertEqual(([], "read-only"), (self.page.evaluate("synMounted"), self.note_state()))
                    self.assertEqual(("Viewer Status", []), (self.layout()["summary"], self.layout()["buttons"]))
                    self.assertFalse(WRITER_CONTROLS & set(self.panel()["buttons"]), self.panel()["buttons"])
                else:
                    self.wait_until(lambda: len(self.page.evaluate("synMounted")) >= 3, "control: modules on re-entry")
                    self.assertEqual(WRITE_MODULES, set(self.page.evaluate("synMounted")), "control: re-entry mounts them")

    def test_10_periodic_and_focus_checks_follow_the_final_report(self):
        self.open_viewer()
        self.wait_panel("ready", VA)
        self.assertEqual([["Length", "SYN-A length", True]], self.page.evaluate("synDrawn()"))
        # The final report is retracted (final:false): rows and marks go at once, the panel says withheld.
        self.items[VA] = "withheld"
        self.focus()
        seen = self.wait_panel("withheld", VA)
        self.assertEqual((RO_WITHHELD, [], ["Refresh"]), (seen["status"], seen["rows"], seen["buttons"]))
        self.assertEqual([], self.page.evaluate("synDrawn()"))
        # Final again as r5: the whole r5 is read and verified before anything is shown.
        self.items[VA] = {"version": 5, "pages": [[key_item(71, "SYN-A r5 key")]]}
        self.focus()
        seen = self.wait_panel("ready", VA)
        self.assertEqual(("확정 판독문 r5의 저장 항목 1개 · 읽기 전용",
                          [["Key Image · Saved r1", "Read-only", "SYN-A r5 key", "프레임 1", "Go to Image"]]), (seen["status"], seen["rows"]))
        # r5 is shown; the check answers r6 and the r6 read is held, then fails: r5 is never left as the current final.
        self.hold_items, self.items[VA] = {VA}, {"version": 6, "pages": [[key_item(72, "SYN-A r6 key")]]}
        self.focus()
        self.wait_until(lambda: self.held_items, "the r6 read held")
        seen = self.panel()
        self.assertEqual(("loading", []), (seen["state"], seen["rows"]))
        self.hold_items = set()
        request = self.held_items[0][1].request
        self.held_items.pop()[1].fulfill(status=CHANGED[0], json=CHANGED[1])
        self.wait_until(lambda: any(item is request for item in self.finished), "the failed r6 read reaching the page")
        seen = self.wait_panel("failed", VA)
        self.assertEqual([], seen["rows"])
        self.assertEqual([], self.page.evaluate("synDrawn()"))

        # A->B->A with the check's answer held: that late final:false for the old A never takes the new A down.
        self.items, self.item_requests, self.cursors = copy.deepcopy(ITEMS), [], {}
        self.open_viewer(uncancellable=True)
        self.wait_panel("ready", VA)
        self.hold_probes = {VA}
        self.focus()
        self.wait_until(lambda: self.held_probes, "A's check held")
        self.page.evaluate("study => synSwitch(study)", VP)
        self.wait_panel("ready", VP)
        self.page.evaluate("study => synSwitch(study)", VA)
        self.wait_panel("ready", VA)
        self.release(self.held_probes.pop()[1], {"uid": VA, "final": False, "items": None, "nextCursor": None})
        seen = self.panel()
        self.assertEqual(("ready", ["SYN-A key", "SYN-A length", "SYN-A angle", "SYN-A arrow"]),
                         (seen["state"], [row[2] for row in seen["rows"]]))

        # Control: the same file that drops the check's answer keeps the retracted final rows.
        self.items, self.item_requests, self.cursors = copy.deepcopy(ITEMS), [], {}
        self.open_viewer(self.config_variants["no-final-check"])
        self.wait_panel("ready", VA)
        before = self.probes()
        self.items[VA] = "withheld"
        self.focus()
        self.wait_until(lambda: self.probes() > before, "control: the check asked")
        self.settle()
        seen = self.panel()
        self.assertEqual(("ready", 4), (seen["state"], len(seen["rows"])), "control: retracted rows kept")

    # ── Astra S5-U2b-R-002 regressions ──
    def authoring_closed(self, status):
        # What test_08 fixes for a clinician-only document, for a document that is not a confirmed writer.
        bar = self.page.evaluate("synToolbar()")
        self.assertEqual((VIEW_SECTION, VIEW_MORE), (bar["primary"], bar["more"]))
        for group in ALL_GROUPS:
            modes = self.page.evaluate("id => synModes(id)", group)
            self.assertEqual({}, {n: m for n, m in modes.items() if m in ("Active", "Passive") and n not in VIEWING}, group)
        view = ["view WindowLevel", "view WindowLevel"]
        for name, seen in self.attempt_every_authoring_tool().items():
            with self.subTest(tool=name):
                self.assertEqual({"click": "missing", "afterClick": view, "toolbar": view, "hotkey": view, "group": view},
                                 {k: v for k, v in seen.items() if k != "passive"})
                self.assertIn(seen["passive"], ("Enabled", "Disabled"))
        # Programmatic addNewAnnotation on the tool instances (no mode, no toolbar) refuses too.
        self.assertEqual(["false", "false", "false", "undefined"], self.page.evaluate(
            "[synAdd('Bidirectional'), synAdd('ArrowAnnotate'), synAdd('SplineROI'), synAddLength()]"))
        self.assertEqual(status, self.panel()["status"])
        self.assertEqual([], self.page.evaluate("synMarks()"))

    def test_11_authoring_waits_for_a_verified_writer(self):
        # /me held (Astra reproduced Bidirectional here): only viewing reaches a tool before the answer; no mark is made.
        self.hold_me = True
        self.open_viewer()
        self.wait_until(lambda: len(self.held_me) >= 3, "the panel's, the module gate's and the layout panel's /me held")
        self.assertEqual("unconfirmed", self.session())
        self.authoring_closed(UNCONFIRMED_TOOL)
        self.assertEqual([f"refused: {UNCONFIRMED_SR}"] * 2, [self.page.evaluate("name => synSR(name)", name)
                                                              for name in ("storeMeasurements", "downloadReport")])
        self.assertEqual([["new", None]], self.page.evaluate(EDIT_ATTEMPTS))
        self.assertEqual(UNCONFIRMED_EDIT, self.panel()["status"])
        self.assertEqual(([], [["update", "syn-uid", False]]), (self.page.evaluate("synNative"), self.page.evaluate("synEdits")))
        # A mark made outside every guard is gone at the next observation tick.
        stray = self.page.evaluate("synRawMark('Bidirectional')")
        self.wait_until(lambda: not self.page.evaluate("uid => synHas(uid)", stray), "the stray mark removed")
        # The late clinician answer: the final list is read, the saved mark is the only one drawn, authoring stays closed.
        self.release_me(CLINICIAN)
        self.wait_panel("ready", VA)
        self.assertEqual("read-only", self.session())
        self.assertEqual(([], [["Length", "SYN-A length", True]]),
                         (self.page.evaluate("synMarks()"), self.page.evaluate("synDrawn()")))
        self.assertEqual(["missing", "view WindowLevel"], self.page.evaluate("[synClick('Bidirectional'), synDraw('default')]"))
        for text in (UNCONFIRMED_TOOL, UNCONFIRMED_EDIT, UNCONFIRMED_SR):
            self.assertIsNone(AVOIDED.search(text), text)

        # A failing /me is not an answer either: the toolbar, the hotkey and the toolbar command draw nothing.
        for failure in (500, 503, "abort", "bad-json"):
            with self.subTest(every_me=failure):
                self.me_status, self.me_requests, self.item_requests, self.cursors = failure, 0, [], {}
                self.open_viewer()
                self.wait_until(lambda: self.me_requests >= 3, "every /me asked")
                self.settle()
                self.assertEqual("unconfirmed", self.session())
                self.assertEqual(VIEW_SECTION, self.page.evaluate("synToolbar()")["primary"])
                self.assertEqual(["missing", "view WindowLevel", "view WindowLevel", "view WindowLevel", "view WindowLevel"],
                                 self.page.evaluate("""() => { const seen = [synClick('Bidirectional'), synDraw('default')];
                                   synRun('setToolActive', { toolName: 'ArrowAnnotate' }); seen.push(synDraw('default'));
                                   synRun('setToolActiveToolbar', { itemId: 'EllipticalROI', toolGroupIds: ['default', 'mpr'] });
                                   return [...seen, synDraw('default'), synDraw('mpr')]; }"""))
                self.assertEqual([], self.page.evaluate("synMarks()"))
        # A passing failure: focus asks /me again (no study change needed); a writer answer then opens the tools and the modules.
        self.me, self.me_status, self.me_requests, self.item_requests, self.cursors = RADIOLOGIST, 503, 0, [], {}
        self.open_viewer()
        self.wait_until(lambda: self.me_requests >= 3, "every /me asked")
        self.settle()
        self.assertEqual(("unconfirmed", VIEW_SECTION), (self.session(), self.page.evaluate("synToolbar()")["primary"]))
        self.me_status = None
        self.focus()
        self.wait_until(lambda: "SYN writer key" in str(self.panel()["rows"]), "the writer panel after the focus retry")
        self.wait_until(lambda: set(self.page.evaluate("synMounted")) >= WRITE_MODULES, "the write modules after the retry")
        self.assertEqual(("writer", PRIMARY_SECTION), (self.session(), self.page.evaluate("synToolbar()")["primary"]))
        self.assertEqual(["ran", "mark Bidirectional"], self.page.evaluate("[synClick('Bidirectional'), synDraw('default')]"))
        self.me = CLINICIAN

        # The late radiologist answer gives back exactly the toolbar and the tool modes the mode set (as a document with no
        # policy at all has them), and drawing works; a writer's own local mark stays.
        self.me, self.item_requests, self.cursors = RADIOLOGIST, [], {}
        self.open_viewer(self.config_variants["policy-off"])
        self.wait_until(lambda: "SYN writer key" in str(self.panel()["rows"]), "writer panel (no policy)")
        native_bar = self.page.evaluate("synToolbar()")
        native_modes = {group: self.page.evaluate("id => synModes(id)", group) for group in ALL_GROUPS}
        self.assertEqual((PRIMARY_SECTION, MORE_TOOLS), (native_bar["primary"], native_bar["more"]))
        self.hold_me, self.me, self.item_requests, self.cursors = True, CLINICIAN, [], {}
        self.open_viewer()
        self.wait_until(lambda: len(self.held_me) >= 3, "every /me held")
        self.assertEqual(VIEW_SECTION, self.page.evaluate("synToolbar()")["primary"])
        self.release_me(RADIOLOGIST)
        self.wait_until(lambda: "SYN writer key" in str(self.panel()["rows"]), "writer panel")
        self.assertEqual("writer", self.session())
        self.assertEqual(native_bar, self.page.evaluate("synToolbar()"))
        self.assertEqual(native_modes, {group: self.page.evaluate("id => synModes(id)", group) for group in ALL_GROUPS})
        self.assertEqual(["ran", "mark Bidirectional", "true"],
                         self.page.evaluate("[synClick('Bidirectional'), synDraw('default'), synAdd('ArrowAnnotate')]"))
        stray = self.page.evaluate("synRawMark('CircleROI')")
        self.settle()
        self.assertTrue(self.page.evaluate("uid => synHas(uid)", stray), "a writer's local mark stays")
        # That writer's later /me is refused (403): authoring closes again, every write module comes down, local marks go.
        self.wait_until(lambda: set(self.page.evaluate("synMounted")) >= WRITE_MODULES, "the write modules mounted")
        self.me_status = 403
        self.focus()
        self.wait_until(lambda: self.session() == "refused", "the refused /me")
        self.settle()
        self.assertEqual(VIEW_SECTION, self.page.evaluate("synToolbar()")["primary"])
        self.assertEqual([], self.page.evaluate("synMarks()"))
        self.assertEqual((WRITE_MODULES, "refused"), (set(self.page.evaluate("synStopped")), self.note_state()))
        self.assertEqual(["missing", "view WindowLevel"], self.page.evaluate("[synClick('Bidirectional'), synDraw('default')]"))
        self.me_status = None

        # Control: the policy as it was at R-002 lets the unconfirmed clinician draw, and the mark stays after the answer.
        self.hold_me, self.me, self.item_requests, self.cursors = True, CLINICIAN, [], {}
        self.open_viewer(self.config_variants["as-r002"])
        self.wait_until(lambda: len(self.held_me) >= 3, "every /me held (control)")
        self.assertEqual(["ran", "mark Bidirectional"], self.page.evaluate("[synClick('Bidirectional'), synDraw('default')]"),
                         "control: the unconfirmed clinician draws")
        self.release_me(CLINICIAN)
        self.wait_panel("ready", VA)
        self.settle()
        self.assertEqual(["Bidirectional"], self.page.evaluate("synMarks()"), "control: the mark stays after the answer")

    def test_12_final_list_is_rechecked_without_a_source_frame(self):
        self.open_viewer()
        ready = self.wait_panel("ready", VA)["status"]
        # The active viewport stops showing an identified source frame: the list says it is not matched; nothing is asked yet.
        before = self.probes()
        self.frameless(True)
        self.wait_until(lambda: self.panel()["frame"] == "unmatched", "the list marked unmatched")
        self.settle()
        seen = self.panel()
        self.assertEqual(("ready", 4, f"{ready} · {RO_UNMATCHED}"), (seen["state"], len(seen["rows"]), seen["status"]))
        self.assertEqual(before, self.probes())
        # The final report is retracted: the focus check runs without a frame and takes the rows and marks down.
        self.items[VA] = "withheld"
        self.focus()
        seen = self.wait_panel("withheld", VA)
        self.assertEqual(([], f"{RO_WITHHELD} · {RO_UNMATCHED}", "unmatched"), (seen["rows"], seen["status"], seen["frame"]))
        self.assertEqual([], self.page.evaluate("synDrawn()"))
        # Final again as r5 over two pages: the periodic (15 s) check runs without a frame, and r5 is read whole with its cursor.
        self.items[VA] = {"version": 5, "pages": [[key_item(71, "SYN-A r5 key")], [mark_item(72, "length", "SYN-A r5 length")]]}
        reads = len(self.reads())
        self.page.evaluate("synAdvance(16000)")
        seen = self.wait_panel("ready", VA)
        cursor = list(self.cursors)[-1]
        self.assertEqual([(VA, {"limit": ["100"]}), (VA, {"limit": ["100"], "cursor": [cursor]})], self.reads()[reads:])
        self.assertEqual((["SYN-A r5 key", "SYN-A r5 length"], "unmatched", []),
                         ([row[2] for row in seen["rows"]], seen["frame"], self.page.evaluate("synDrawn()")))
        # The frame comes back: matched again and checked at once; the verified saved mark is drawn.
        before = self.probes()
        self.frameless(False)
        self.wait_until(lambda: self.probes() > before and self.panel()["frame"] is None, "the check on the frame's return")
        self.settle()
        seen = self.panel()
        self.assertEqual(("ready", "확정 판독문 r5의 저장 항목 2개 · 읽기 전용"), (seen["state"], seen["status"]))
        self.assertEqual([["Length", "SYN-A r5 length", True]], self.page.evaluate("synDrawn()"))
        self.assertIsNone(AVOIDED.search(RO_UNMATCHED))

        # A->B->A while A's frameless check is held: its late final:false never takes the new A down.
        self.items, self.item_requests, self.cursors = copy.deepcopy(ITEMS), [], {}
        self.open_viewer(uncancellable=True)
        self.wait_panel("ready", VA)
        self.frameless(True)
        self.wait_until(lambda: self.panel()["frame"] == "unmatched", "A unmatched")
        self.hold_probes = {VA}
        self.focus()
        self.wait_until(lambda: self.held_probes, "A's frameless check held")
        self.page.evaluate(f"() => {{ window.synFrameless = false; synSwitch('{VP}'); }}")
        self.wait_panel("ready", VP)
        self.page.evaluate("study => synSwitch(study)", VA)
        self.wait_panel("ready", VA)
        self.release(self.held_probes.pop()[1], {"uid": VA, "final": False, "items": None, "nextCursor": None})
        seen = self.panel()
        self.assertEqual(("ready", None, ["SYN-A key", "SYN-A length", "SYN-A angle", "SYN-A arrow"]),
                         (seen["state"], seen["frame"], [row[2] for row in seen["rows"]]))

        # Control: the same file with the check behind frame identification (as at R-002) keeps the retracted rows unasked.
        self.items, self.item_requests, self.cursors = copy.deepcopy(ITEMS), [], {}
        self.open_viewer(self.config_variants["frame-bound-check"])
        self.wait_panel("ready", VA)
        self.frameless(True)
        self.settle()
        before = self.probes()
        self.items[VA] = "withheld"
        self.focus()
        self.page.evaluate("synAdvance(16000)")
        for _ in range(3):
            self.settle()
        seen = self.panel()
        self.assertEqual((before, "ready", 4), (self.probes(), seen["state"], len(seen["rows"])),
                         "control: the retracted rows kept and nothing asked")

    def test_13_viewer_state_matrix(self):
        for state in STATES:
            with self.subTest(state=state):
                self.open_state(state)
                seen = self.observe_list()
                seen.update(self.observe_writes(state))
                seen.update(self.observe_rechecks(state))
                self.assertEqual(set(VIEWER_STATE_MATRIX), set(seen))
                for row, expected in VIEWER_STATE_MATRIX.items():
                    with self.subTest(state=state, row=row):
                        self.assertEqual(expected[STATES.index(state)], seen[row])
        self.me_status, self.writer_paged = None, False

    # ── Astra S5-U2b-R-003 regressions ──
    def writer_open(self, config=None, hold=(), paged=False):
        # A writer (MIXED) document with only the Measurements panel entered; what the case holds arrives late (uncancellable).
        self.me, self.me_status, self.list_me, self.writer_paged, self.hold_me, self.held_me = MIXED, None, None, paged, False, []
        self.hold_writer, self.held_writer, self.hold_items, self.held_items = set(hold), [], set(), []
        self.hold_next, self.held_next, self.accept_writes, self.held_writes, self.writes = set(), [], False, [], []
        self.items, self.item_requests, self.cursors, self.me_requests = copy.deepcopy(ITEMS), [], {}, 0
        self.open_viewer(config, uncancellable=True, enter=[HISTORY])

    def to_clinician_only(self, ids=None, hold_final=False):
        # Another extension's /me answers the same account clinician-only (the layout panel's; LATER adds the module gate's).
        self.hold_writer, self.me = set(), MIXED_NOW_CLINICIAN
        if hold_final:
            self.hold_items = {VA}
        self.page.evaluate("ids => synEnter(ids)", ids or OTHER)
        self.wait_until(lambda: self.session() == "read-only", "the clinician-only answer")

    def snapshot(self):
        seen = self.panel()
        return seen["state"], seen["rows"], self.page.evaluate("synDrawn()")

    def labels(self):
        return [row[2] for row in self.panel()["rows"]]

    def first_reads(self, start):
        # The list reads asked since `start` (first pages, in order): a read asked twice shows twice.
        return "+".join(self.kind([request]) for request in self.item_requests[start:]
                        if request[1].get("limit") != ["1"] and "cursor" not in request[1]) or "none"

    @staticmethod
    def change_effect(before, after):
        if after[1:] == before[1:]:
            return "kept"
        return "taken down" if after[1:] == ([], []) else f"changed {after}"

    def late(self, route, payload, marker):
        # Answer a request asked before the change. shown: its item appears (given 2 s); dropped: the screen did not change.
        before = self.snapshot()
        self.release(route, payload)
        deadline = time.monotonic() + 2
        while marker not in str(self.snapshot()) and time.monotonic() < deadline:
            self.page.wait_for_timeout(50)
        after = self.snapshot()
        return "shown" if marker in str(after) else "dropped" if after == before else f"changed {after}"

    def test_14_clinician_only_change_voids_in_flight_writer_reads(self):
        a_labels, a_drawn = ["SYN-A key", "SYN-A length", "SYN-A angle", "SYN-A arrow"], [["Length", "SYN-A length", True]]
        late = ["SYN LATE WRITER LENGTH", "SYN LATE WRITER KEY"]
        # (a) Astra's reproduction: the writer's first author page is held; the module gate's /me (and the layout panel's)
        # answer the same account clinician-only; the final read is held; then the author page arrives.
        for name in ("shipped", "no-boundary", "as-r003"):
            with self.subTest(step="a", file=name):
                self.writer_open(None if name == "shipped" else self.config_variants[name], hold={(VA, "first")})
                self.wait_until(lambda: self.held_writer, "the first author page held")
                self.assertEqual("writer", self.session())
                self.to_clinician_only(LATER, hold_final=True)
                if name == "shipped":
                    self.wait_until(lambda: self.held_items, "the final read held")
                else:
                    self.settle()
                self.release(self.held_writer.pop()[2], author_page(LATE_MARK, LATE_KEY))
                seen, drawn = self.panel(), self.page.evaluate("synDrawn()")
                if name == "as-r003":
                    # Control: the file at R-003 paints the late author page (no data-read-only) and draws its mark ...
                    self.assertEqual((None, VA, late, {"Read-only"}), (seen["state"], seen["uid"], [row[2] for row in seen["rows"]],
                                                                        {row[1] for row in seen["rows"]}), "control: late page painted")
                    self.assertEqual([["Length", "SYN LATE WRITER LENGTH", True]], drawn, "control: its mark drawn")
                    # ... and the final:false check leaves it: that list has no verified final version to compare with.
                    self.items[VA], before = "withheld", self.probes()
                    self.focus()
                    self.wait_until(lambda: self.probes() > before, "control: the final:false check asked")
                    self.settle()
                    self.assertEqual(late, self.labels(), "control: kept after final:false")
                    continue
                self.assertEqual(([], []), (seen["rows"], drawn), "nothing of the late author page")
                if name == "no-boundary":
                    # Control: the display check alone drops the page, but nothing asks the final list: the panel stays empty.
                    self.assertEqual(["read-all"], [self.kind([r]) for r in self.reads()], "control: no final read")
                    continue
                self.assertEqual("loading", seen["state"])
                self.hold_items = set()
                self.release(self.held_items.pop()[1], self.clinician_page(VA, None)["json"])
                seen = self.wait_panel("ready", VA)
                self.assertEqual((a_labels, a_drawn), ([row[2] for row in seen["rows"]], self.page.evaluate("synDrawn()")))
                cursor = next(iter(self.cursors))
                self.assertEqual([(VA, {"includeHidden": ["true"], "limit": ["100"]}), (VA, {"limit": ["100"]}),
                                  (VA, {"limit": ["100"], "cursor": [cursor]})], self.reads())
                # Astra's next step: the final:false check takes those rows and the mark down.
                self.items[VA] = "withheld"
                self.focus()
                seen = self.wait_panel("withheld", VA)
                self.assertEqual((RO_WITHHELD, [], []), (seen["status"], seen["rows"], self.page.evaluate("synDrawn()")))

        # (c) The new final read: final:false shows withheld with no row or mark and the late author page changes nothing;
        # final:true is shown only after every page of one version (a second page of another version refuses the whole read).
        with self.subTest(step="c"):
            self.writer_open(hold={(VA, "first")})
            self.wait_until(lambda: self.held_writer, "the first author page held")
            self.items[VA] = "withheld"
            self.to_clinician_only()
            seen = self.wait_panel("withheld", VA)
            self.assertEqual((RO_WITHHELD, [], []), (seen["status"], seen["rows"], self.page.evaluate("synDrawn()")))
            self.assertEqual("dropped", self.late(self.held_writer.pop()[2], author_page(LATE_MARK, LATE_KEY), "SYN LATE"))
            self.items[VA], self.hold_next = copy.deepcopy(ITEMS[VA]), {VA}
            self.focus()
            self.wait_until(lambda: self.held_next, "the second final page held")
            self.assertEqual(("loading", [], []), self.snapshot())
            _, cursor, route = self.held_next.pop()
            self.release(route, {**self.clinician_page(VA, cursor)["json"], "reportVersion": 5})
            seen = self.wait_panel("failed", VA)
            self.assertEqual(([], []), (seen["rows"], self.page.evaluate("synDrawn()")))
            self.hold_next = set()
            self.page.get_by_role("button", name="Refresh", exact=True).click()
            seen = self.wait_panel("ready", VA)
            self.assertEqual((a_labels, a_drawn), ([row[2] for row in seen["rows"]], self.page.evaluate("synDrawn()")))

        # (d) The author list on screen, no source frame, Refresh asked as a writer and held across the change: rows and marks
        # go at once, the late page shows nothing, the final list is shown unmatched and drawn when the frame returns.
        with self.subTest(step="d: refresh, frameless"):
            self.writer_open(hold={(VA, "first")})
            self.wait_until(lambda: self.held_writer, "the first author page held")
            self.release(self.held_writer.pop()[2], author_page(SHOWN_MARK, SHOWN_KEY))
            self.wait_until(lambda: self.page.evaluate("synDrawn()") == [["Length", "SYN WRITER SHOWN LENGTH", True]],
                            "the author mark drawn")
            self.frameless(True)
            self.settle()
            self.page.get_by_role("button", name="Refresh", exact=True).click()
            self.wait_until(lambda: self.held_writer, "the Refresh page held")
            self.to_clinician_only(hold_final=True)
            self.assertEqual(([], []), self.snapshot()[1:], "rows and marks taken down at once")
            self.wait_until(lambda: self.held_items, "the final read held")
            self.assertEqual("dropped", self.late(self.held_writer.pop()[2], author_page(LATE_MARK, LATE_KEY), "SYN LATE"))
            self.hold_items = set()
            self.release(self.held_items.pop()[1], self.clinician_page(VA, None)["json"])
            seen = self.wait_panel("ready", VA)
            self.assertEqual(("unmatched", a_labels, []),
                             (seen["frame"], [row[2] for row in seen["rows"]], self.page.evaluate("synDrawn()")))
            self.frameless(False)
            self.wait_until(lambda: self.page.evaluate("synDrawn()") == a_drawn, "the final mark drawn with the frame back")
            self.assertIsNone(self.panel()["frame"])

        # (d) A->B->A as a writer with both of A's author pages held, then the change: neither late page of A is shown.
        with self.subTest(step="d: a-b-a"):
            self.writer_open(hold={(VA, "first")})
            self.wait_until(lambda: len(self.held_writer) == 1, "A's first author page held")
            self.page.evaluate("study => synSwitch(study)", VP)
            self.wait_until(lambda: "SYN writer key" in str(self.panel()["rows"]), "B's author list")
            self.page.evaluate("study => synSwitch(study)", VA)
            self.wait_until(lambda: len(self.held_writer) == 2, "A's second author page held")
            self.to_clinician_only()
            self.wait_panel("ready", VA)
            held, self.held_writer = self.held_writer, []
            for _, _, route in held:
                self.assertEqual("dropped", self.late(route, author_page(LATE_MARK, LATE_KEY), "SYN LATE"))
            self.assertEqual((a_labels, a_drawn), (self.labels(), self.page.evaluate("synDrawn()")))

    def test_15_session_change_matrix(self):
        seen = {change: {} for change in SESSION_CHANGES}
        authors = lambda requests: [r for r in requests if r[1].get("includeHidden") == ["true"]]
        finals = lambda requests: [r for r in requests if "includeHidden" not in r[1] and r[1].get("limit") == ["100"]]
        offered = lambda buttons: "none" if not set(buttons) & WRITER_CONTROLS else f"offered {buttons}"

        # unconfirmed -> writer: the panel's /me held, the layout panel's /me answers writer, then the panel's.
        u = seen["unconfirmed->writer"]
        self.me, self.hold_me = RADIOLOGIST, True
        self.open_viewer(uncancellable=True, enter=[HISTORY])
        self.wait_until(lambda: len(self.held_me) == 1, "the panel's /me held")
        self.assertEqual("unconfirmed", self.session())
        before, asked, buttons = self.snapshot(), list(self.item_requests), self.panel()["buttons"]
        start, me_before, self.hold_me = len(self.item_requests), self.me_requests, False
        self.page.evaluate("ids => synEnter(ids)", OTHER)
        self.wait_until(lambda: self.session() == "writer", "the layout panel's writer answer")
        self.settle()
        u["shown_at_change"] = self.change_effect(before, self.snapshot())
        u["reads_by_other_me"] = ("me+" if self.me_requests - me_before > 1 else "") + self.first_reads(start)
        self.release(self.held_me.pop(), RADIOLOGIST)
        self.wait_until(lambda: "SYN writer key" in str(self.panel()["rows"]), "the author list after the panel's /me")
        u["read_awaiting_me"] = self.first_reads(start)
        u["state_after"] = self.session()
        for row in ("author_first_page", "author_next_page", "author_refresh"):
            u[row] = "none" if not authors(asked) else "asked"
        u["final_page"] = "none" if not finals(asked) else "asked"
        u["write_awaiting_me"] = u["write_sent"] = offered(buttons)
        # The panel's own /me makes the change (a document opened as a writer).
        self.item_requests, self.cursors, self.me_requests = [], {}, 0
        self.open_viewer(uncancellable=True, enter=[HISTORY])
        self.wait_until(lambda: "SYN writer key" in str(self.panel()["rows"]), "the author list")
        self.settle()
        u["reads_by_own_me"] = ("me+" if self.me_requests > 1 else "") + self.first_reads(0)

        # writer -> read-only. Another extension's /me with the first author page held.
        w = seen["writer->read-only"]
        self.writer_open(hold={(VA, "first")})
        self.wait_until(lambda: self.held_writer, "the first author page held")
        start, me_before = len(self.item_requests), self.me_requests
        w["final_page"] = "none" if not finals(self.item_requests) else "asked"
        self.to_clinician_only()
        self.wait_panel("ready", VA)
        w["reads_by_other_me"] = ("me+" if self.me_requests - me_before > 1 else "") + self.first_reads(start)
        w["author_first_page"] = self.late(self.held_writer.pop()[2], author_page(LATE_MARK, LATE_KEY), "SYN LATE")
        w["state_after"] = self.session()
        # A later author page (the handed-out cursor) held.
        self.writer_open(hold={(VA, "next")}, paged=True)
        self.wait_until(lambda: self.held_writer, "the next author page held")
        self.to_clinician_only()
        self.wait_panel("ready", VA)
        w["author_next_page"] = self.late(self.held_writer.pop()[2], author_page(LATE_MARK), "SYN LATE")
        # The author list and its mark on screen; Refresh held; the change; the final read held, then answered.
        self.writer_open(hold={(VA, "first")})
        self.wait_until(lambda: self.held_writer, "the first author page held")
        self.release(self.held_writer.pop()[2], author_page(SHOWN_MARK, SHOWN_KEY))
        self.wait_until(lambda: self.page.evaluate("synDrawn()") == [["Length", "SYN WRITER SHOWN LENGTH", True]],
                        "the author mark drawn")
        self.page.get_by_role("button", name="Refresh", exact=True).click()
        self.wait_until(lambda: self.held_writer, "the Refresh page held")
        before = self.snapshot()
        self.to_clinician_only(hold_final=True)
        w["shown_at_change"] = self.change_effect(before, self.snapshot())
        self.wait_until(lambda: self.held_items, "the final read held")
        w["author_refresh"] = self.late(self.held_writer.pop()[2], author_page(LATE_MARK, LATE_KEY), "SYN LATE")
        self.hold_items = set()
        self.release(self.held_items.pop()[1], self.clinician_page(VA, None)["json"])
        self.wait_panel("ready", VA)
        # Refresh waiting for its /me when another extension's /me makes the change; that given-up /me answers writer late.
        self.writer_open()
        self.wait_until(lambda: "SYN writer key" in str(self.panel()["rows"]), "the author list")
        self.hold_me = True
        self.page.get_by_role("button", name="Refresh", exact=True).click()
        self.wait_until(lambda: self.held_me, "the Refresh /me held")
        start, self.hold_me = len(self.item_requests), False
        self.to_clinician_only()
        self.wait_panel("ready", VA)
        self.release(self.held_me.pop(), MIXED)
        self.settle()
        self.assertEqual(("read-only", "ready"), (self.session(), self.panel()["state"]))
        w["read_awaiting_me"] = self.first_reads(start)
        # Refresh whose own /me answers clinician-only.
        self.writer_open()
        self.wait_until(lambda: "SYN writer key" in str(self.panel()["rows"]), "the author list")
        self.hold_me = True
        self.page.get_by_role("button", name="Refresh", exact=True).click()
        self.wait_until(lambda: self.held_me, "the Refresh /me held")
        start, me_before, self.hold_me, self.me = len(self.item_requests), self.me_requests, False, MIXED_NOW_CLINICIAN
        self.release(self.held_me.pop(), MIXED_NOW_CLINICIAN)
        self.wait_panel("ready", VA)
        w["reads_by_own_me"] = ("me+" if self.me_requests > me_before else "") + self.first_reads(start)
        # A Save of a new key image waiting for its /me, which answers clinician-only.
        history = self.page.locator("#kin-viewer-history")
        self.writer_open()
        self.wait_until(lambda: "SYN writer key" in str(self.panel()["rows"]), "the author list")
        self.accept_writes = True
        history.get_by_role("button", name="Add Key Image", exact=True).click()
        self.wait_until(lambda: "Save" in self.panel()["buttons"], "the new key image's Save")
        self.hold_me = True
        history.get_by_role("button", name="Save", exact=True).click()
        self.wait_until(lambda: self.held_me, "the Save's /me held")
        self.hold_me, self.me = False, MIXED_NOW_CLINICIAN
        self.release(self.held_me.pop(), MIXED_NOW_CLINICIAN)
        self.wait_panel("ready", VA)
        self.settle()
        w["write_awaiting_me"] = "not sent" if not self.writes else f"sent {self.writes}"
        for route in self.held_writes:
            self.release(route, author_page(LATE_WRITE)["items"][0])
        # A Save already sent, answered after the change.
        self.writer_open()
        self.wait_until(lambda: "SYN writer key" in str(self.panel()["rows"]), "the author list")
        self.accept_writes = True
        history.get_by_role("button", name="Add Key Image", exact=True).click()
        self.wait_until(lambda: "Save" in self.panel()["buttons"], "the new key image's Save")
        history.get_by_role("button", name="Save", exact=True).click()
        self.wait_until(lambda: self.held_writes, "the Save on the wire")
        self.to_clinician_only()
        self.wait_panel("ready", VA)
        w["write_sent"] = self.late(self.held_writes.pop(), author_page(LATE_WRITE)["items"][0], "SYN LATE WRITTEN")

        # read-only -> writer: the same clinician account gains radiologist. The lists stay served as the clinician's (list_me),
        # so a writer read would show as read-all. A final page held across the layout panel's writer /me.
        r = seen["read-only->writer"]
        self.me, self.list_me, self.hold_items, self.held_items = CLINICIAN, CLINICIAN, {VA}, []
        self.item_requests, self.cursors, self.me_requests, self.accept_writes = [], {}, 0, False
        self.open_viewer(uncancellable=True, enter=[HISTORY])
        self.wait_until(lambda: self.held_items, "the final read held")
        self.assertEqual("read-only", self.session())
        me_before, self.me = self.me_requests, CLINICIAN_NOW_MIXED
        self.page.evaluate("ids => synEnter(ids)", OTHER)
        self.wait_until(lambda: self.me_requests > me_before, "the layout panel's /me")
        self.settle()
        self.hold_items = set()
        r["final_page"] = self.late(self.held_items.pop()[1], self.clinician_page(VA, None)["json"], "SYN-A key")
        asked = list(self.item_requests)
        # The final list on screen, Refresh waiting for the panel's /me, the layout panel's writer /me, then the panel's.
        self.me, self.item_requests, self.cursors, self.me_requests = CLINICIAN, [], {}, 0
        self.open_viewer(uncancellable=True, enter=[HISTORY])
        self.wait_panel("ready", VA)
        buttons, self.hold_me = self.panel()["buttons"], True
        self.page.get_by_role("button", name="Refresh", exact=True).click()
        self.wait_until(lambda: self.held_me, "the Refresh /me held")
        before, start, me_before = self.snapshot(), len(self.item_requests), self.me_requests
        self.me, self.hold_me = CLINICIAN_NOW_MIXED, False
        self.page.evaluate("ids => synEnter(ids)", OTHER)
        self.wait_until(lambda: self.me_requests > me_before, "the layout panel's /me")
        self.settle()
        r["shown_at_change"] = self.change_effect(before, self.snapshot())
        r["reads_by_other_me"] = ("me+" if self.me_requests - me_before > 1 else "") + self.first_reads(start)
        self.release(self.held_me.pop(), CLINICIAN_NOW_MIXED)
        self.wait_until(lambda: self.first_reads(start) != "none", "the read after the panel's /me")
        self.wait_panel("ready", VA)
        r["read_awaiting_me"] = self.first_reads(start)
        start, me_before = len(self.item_requests), self.me_requests
        self.page.get_by_role("button", name="Refresh", exact=True).click()
        self.wait_until(lambda: self.first_reads(start) != "none", "the Refresh read")
        self.wait_panel("ready", VA)
        r["reads_by_own_me"] = ("me+" if self.me_requests - me_before > 1 else "") + self.first_reads(start)
        r["state_after"] = self.session()
        asked += self.item_requests
        for row in ("author_first_page", "author_next_page", "author_refresh"):
            r[row] = "none" if not authors(asked) else "asked"
        r["write_awaiting_me"] = r["write_sent"] = offered(buttons)
        for change in SESSION_CHANGES:
            self.assertEqual(set(SESSION_CHANGE_MATRIX), set(seen[change]), change)
            for row, expected in SESSION_CHANGE_MATRIX.items():
                with self.subTest(change=change, row=row):
                    self.assertEqual(expected[SESSION_CHANGES.index(change)], seen[change][row])

    # ── Astra S5-U2b-X-R-001 regression ──
    def hold_writer_work(self, config=None):
        # Astra's setup: a writer (MIXED) adds a key image on A and leaves it unsaved, then goes A->B->A. The panel holds that
        # work for A (Resume / Discard Held Work) and draws and navigates nothing of A until the writer decides.
        history = self.page.locator("#kin-viewer-history")
        self.writer_open(config)
        self.wait_until(lambda: "SYN writer key" in str(self.panel()["rows"]), "A's author list")
        history.get_by_role("button", name="Add Key Image", exact=True).click()
        history.get_by_label("Key Title", exact=True).fill(HELD_TITLE)
        self.page.evaluate("study => synSwitch(study)", VP)
        self.wait_until(lambda: (lambda p: p["uid"] == VP and "SYN writer key" in str(p["rows"]))(self.panel()),
                        "B's author list")
        self.page.evaluate("study => synSwitch(study)", VA)
        self.wait_until(lambda: (lambda p: p["uid"] == VA and "Resume Held Work" in p["buttons"])(self.panel()),
                        "A's work held")
        self.page.evaluate(NAVIGABLE, [SERIES, SOP])

    def on_screen(self):
        return self.page.evaluate("() => document.body.innerText + ' ' + "
                                  "[...document.querySelectorAll('input, textarea')].map(e => e.value).join(' ')")

    def list_view(self, item):
        # What the viewer shows and does for the list: the panel, the drawn saved marks, the history state the Findings section
        # reads, the row's Go to Image (a frame change asked) and the navigation API asked to highlight the item.
        seen, drawn = self.panel(), self.page.evaluate("synDrawn()")
        suspended, before = self.page.evaluate("kinViewerHistoryState().suspended"), self.page.evaluate("synIndexed.length")
        self.page.locator(f'#kin-viewer-history section[data-item-id="{item}"]').get_by_role(
            "button", name="Go to Image", exact=True).click()
        self.settle()
        clicked = self.page.evaluate("synIndexed.length") > before
        return {"panel": seen, "drawn": drawn, "suspended": suspended, "go_to_image": clicked,
                "navigate": self.page.evaluate(NAVIGATE, [VA, SERIES, SOP, item])}

    def refresh_final(self):
        reads = len(self.reads())
        self.page.get_by_role("button", name="Refresh", exact=True).click()
        # The final list of A is two pages.
        self.wait_until(lambda: len(self.reads()) >= reads + 2 and self.panel()["state"] == "ready", "the Refresh read")
        self.settle()

    def test_16_held_writer_work_never_blocks_the_final_list(self):
        a_labels, length = ["SYN-A key", "SYN-A length", "SYN-A angle", "SYN-A arrow"], item_id(2)
        arrived = {"ok": True, "highlighted": True, "annotation": "shown", "present": True, "revision": 2, "hidden": False,
                   "working": False}
        unsaved = "() => kinViewerHistoryHasUnsaved()"

        # (a) Astra's control, no held work: the same account turns clinician-only by the other extensions' /me; the final
        # list's verified length is drawn locked and Go to Image reaches its frame.
        self.writer_open()
        self.wait_until(lambda: "SYN writer key" in str(self.panel()["rows"]), "A's author list")
        self.page.evaluate(NAVIGABLE, [SERIES, SOP])
        self.to_clinician_only(LATER)
        self.wait_panel("ready", VA)
        clear = self.list_view(length)
        self.assertEqual((a_labels, [["Length", "SYN-A length", True]], False, True, arrived),
                         ([row[2] for row in clear["panel"]["rows"]], clear["drawn"], clear["suspended"],
                          clear["go_to_image"], clear["navigate"]))
        self.assertEqual(({"Refresh", "Go to Image"}, [RO_NOTE], 0),
                         (set(clear["panel"]["buttons"]), clear["panel"]["notes"], clear["panel"]["inputs"]))
        self.assertFalse(self.page.evaluate(unsaved))

        # (b) Astra's reproduction: the writer's unsaved key image is held for A (the writer's pause: nothing drawn, Go to
        # Image busy), then the same change. The clinician gets exactly what (a) shows, and none of the held work.
        self.fresh_page()
        self.hold_writer_work()
        self.assertEqual(([], True, {"ok": False, "reason": "busy"}),
                         (self.page.evaluate("synDrawn()"), self.page.evaluate("kinViewerHistoryState().suspended"),
                          self.page.evaluate(NAVIGATE, [VA, SERIES, SOP, None])), "the writer's held-work pause")
        self.to_clinician_only(LATER)
        self.wait_panel("ready", VA)
        self.assertEqual(clear, self.list_view(length))
        # The work stays held: the unload guard still counts it.
        self.assertTrue(self.page.evaluate(unsaved))
        for step in ("refresh", "frame lost and back", "final:false, then final"):
            with self.subTest(step=step):
                if step == "refresh":
                    self.refresh_final()
                elif step == "frame lost and back":
                    self.frameless(True)
                    self.wait_until(lambda: self.panel()["frame"] == "unmatched", "the list unmatched")
                    before = self.probes()
                    self.frameless(False)
                    self.wait_until(lambda: self.probes() > before and self.panel()["frame"] is None,
                                    "the check on the frame's return")
                    self.settle()
                else:
                    self.items[VA] = "withheld"
                    self.focus()
                    seen = self.wait_panel("withheld", VA)
                    self.assertEqual((RO_WITHHELD, [], [], ["Refresh"]),
                                     (seen["status"], seen["rows"], self.page.evaluate("synDrawn()"), seen["buttons"]))
                    self.items[VA] = copy.deepcopy(ITEMS[VA])
                    self.focus()
                    self.wait_panel("ready", VA)
                    self.settle()
                self.assertEqual(clear, self.list_view(length))
                self.assertNotIn(HELD_TITLE, self.on_screen())
                self.assertNotIn("Unsaved", str(self.panel()["rows"]))
                self.assertTrue(self.page.evaluate(unsaved))

        # (c) The writer's side is unchanged: in a document that stays writer, Resume Held Work gives the key image back.
        self.fresh_page()
        self.hold_writer_work()
        history = self.page.locator("#kin-viewer-history")
        history.get_by_role("button", name="Resume Held Work", exact=True).click()
        self.wait_until(lambda: "Key Image · Unsaved" in str(self.panel()["rows"]), "the held key image resumed")
        resumed = self.panel()["rows"]
        self.assertEqual(HELD_TITLE, history.get_by_label("Key Title", exact=True).input_value())
        self.assertFalse({"Resume Held Work", "Discard Held Work"} & set(self.panel()["buttons"]))

        # (d) The clinician-only interval leaves the held work untouched. The shipped session never leaves read-only, so a
        # session that can (a probe of the panel, not a product mode) answers writer after it: Resume gives back what (c) did.
        self.fresh_page()
        self.hold_writer_work(self.config_variants["session-leaves-read-only"])
        self.to_clinician_only(LATER)
        self.wait_panel("ready", VA)
        self.assertEqual(clear, self.list_view(length))
        self.refresh_final()
        self.me = MIXED
        self.focus()
        self.wait_until(lambda: "Resume Held Work" in self.panel()["buttons"], "the held work offered to the writer again")
        self.assertEqual("writer", self.session())
        history = self.page.locator("#kin-viewer-history")
        history.get_by_role("button", name="Resume Held Work", exact=True).click()
        self.wait_until(lambda: "Key Image · Unsaved" in str(self.panel()["rows"]), "the held key image resumed")
        self.assertEqual((resumed, HELD_TITLE),
                         (self.panel()["rows"], history.get_by_label("Key Title", exact=True).input_value()))

        # Control: the file at X-R-001 (held work stops every read path in any session) is Astra's observation: the final
        # list ready but no mark drawn, suspended, Go to Image busy, and Refresh changes nothing.
        self.fresh_page()
        self.hold_writer_work(self.config_variants["held-blocks"])
        self.to_clinician_only(LATER)
        self.wait_panel("ready", VA)
        blocked = self.list_view(length)
        self.assertEqual(([], True, False, {"ok": False, "reason": "busy"}, {"Refresh", "Go to Image"}, a_labels),
                         (blocked["drawn"], blocked["suspended"], blocked["go_to_image"], blocked["navigate"],
                          set(blocked["panel"]["buttons"]), [row[2] for row in blocked["panel"]["rows"]]), "control: blocked")
        self.refresh_final()
        self.assertEqual(blocked, self.list_view(length), "control: Refresh changes nothing")

    # ── Astra S5-U2b-X2-R-001 regression ──
    def refusal_then_late_writers(self, refuser, status, config=None, late_bodies=False):
        # Every /me is held and the extensions enter one at a time, so each held /me is known by its producer: the Measurements
        # panel's, the module gate's (one read Findings, Jobs and Tech Note share) and the layout panel's. The refuser's /me is
        # answered `status`, then every other one answers a writer (RADIOLOGIST): asked before the refusal, arriving after it
        # (uncancellable). late_bodies: those writer answers arrive (200) before the refusal and only their bodies complete after it.
        self.me, self.me_status, self.hold_me, self.held_me = RADIOLOGIST, None, True, []
        self.item_requests, self.cursors, self.me_requests, self.writer_paged = [], {}, 0, False
        self.open_viewer(config, uncancellable=True, enter=[HISTORY], before_boot=SLOW_ME_BODIES if late_bodies else None)
        producers = {}
        for name, ids in (("panel", []), ("gate", GATES), ("layout", [LAYOUT_ID])):
            if ids:
                self.page.evaluate("ids => synEnter(ids)", ids)
            self.wait_until(lambda: len(self.held_me) > len(producers), f"the {name}'s /me held")
            producers[name] = self.held_me[-1]
        self.assertEqual((3, "unconfirmed"), (len(self.held_me), self.session()))
        self.hold_me, self.held_me = False, []
        writers = [route for name, route in producers.items() if name != refuser]
        if late_bodies:
            for route in writers:
                self.release(route, RADIOLOGIST)
            self.assertEqual("unconfirmed", self.session(), "the writer answers are in, their bodies are not")
        self.release(producers[refuser], {"statusCode": status, "message": "SYN refused"}, status=status)
        self.wait_until(lambda: self.session() == "refused", "the refusal")
        if late_bodies:
            self.page.evaluate("() => window.synBodies.forEach(release => release())")
            self.settle()
        else:
            for route in writers:
                self.release(route, RADIOLOGIST)

    def writer_document(self, config=None):
        # A radiologist document with every extension entered: the writer list, every module, the layout buttons, a local mark.
        self.me, self.me_status, self.hold_me, self.held_me = RADIOLOGIST, None, False, []
        self.item_requests, self.cursors, self.me_requests, self.writer_paged = [], {}, 0, False
        self.open_viewer(config, uncancellable=True)
        self.wait_until(lambda: "SYN writer key" in str(self.panel()["rows"]), "the writer panel")
        self.wait_until(lambda: set(self.page.evaluate("synMounted")) == MODULES, "every module mounted")
        self.wait_until(lambda: any(not disabled for _, disabled in self.layout()["buttons"]), "the layout buttons")
        self.assertEqual(("writer", ["ran", "mark Bidirectional"]),
                         (self.session(), self.page.evaluate("[synClick('Bidirectional'), synDraw('default')]")))

    def layout_status(self):
        return self.page.evaluate("() => document.querySelector('#kin-viewer-layout-status').textContent")

    def ended_after_refusal(self):
        # What a document whose login ended shows and refuses, whatever /me answered after the end.
        native = self.page.evaluate("synNative.length")
        self.assertEqual("refused", self.session())
        self.authoring_closed(ENDED)
        self.assertEqual([f"refused: {ENDED}"] * 2, [self.page.evaluate("name => synSR(name)", name)
                                                     for name in ("storeMeasurements", "downloadReport")])
        edits = self.page.evaluate("synEdits.length")
        self.assertEqual([["new", None]], self.page.evaluate(EDIT_ATTEMPTS))
        seen = self.panel()
        self.assertEqual((ENDED, [], [], [], [["update", "syn-uid", False]]),
                         (seen["status"], seen["rows"], seen["buttons"], self.page.evaluate("n => synNative.slice(n)", native),
                          self.page.evaluate("n => synEdits.slice(n)", edits)))
        mounted, stopped = self.page.evaluate("[synMounted, synStopped]")
        self.assertEqual({}, {m: n for m, n in (Counter(mounted) - Counter(stopped)).items() if m in WRITE_MODULES})
        self.assertEqual("refused", self.note_state())
        self.assertTrue(all(disabled for _, disabled in self.layout()["buttons"]), self.layout())
        self.assertEqual(LAYOUT_ENDED, self.layout_status())
        stray = self.page.evaluate("synRawMark('Bidirectional')")
        self.wait_until(lambda: not self.page.evaluate("uid => synHas(uid)", stray), "the stray mark removed")
        # Nothing asks /me or a list afterwards: not a focus, not the 15 s clock.
        asked, reads = self.me_requests, len(self.item_requests)
        self.page.evaluate("synFocus(), synAdvance(16000)")
        self.page.wait_for_timeout(900)
        self.assertEqual((asked, reads), (self.me_requests, len(self.item_requests)))

    def test_17_a_refusal_or_session_end_is_the_end_of_the_documents_session(self):
        # (a) One producer's /me refused, then the other producers' writer answers asked before it (Astra's order first; then a
        # 401, a refusal by another producer, and writer answers whose bodies complete after the refusal).
        orders = (("panel", 403, False), ("panel", 401, False), ("gate", 401, False), ("layout", 403, False),
                  ("panel", 403, True), ("gate", 401, True))
        for refuser, status, late_bodies in orders:
            with self.subTest(refuser=refuser, status=status, late_bodies=late_bodies):
                self.fresh_page()
                self.refusal_then_late_writers(refuser, status, late_bodies=late_bodies)
                self.assertEqual(([], []), (self.item_requests, self.page.evaluate("synMounted")))
                self.ended_after_refusal()
        # (b) Mode exit and re-entry of that document with /me answering a writer: nothing asks /me, nothing mounts, still closed.
        with self.subTest(step="re-entry"):
            asked = self.me_requests
            self.assertEqual(VIEW_SECTION, self.page.evaluate("() => { synReenter(); return synToolbar().primary; }"))
            self.settle()
            self.assertEqual((asked, "refused", ENDED, LAYOUT_ENDED, [], [["new", None]]),
                             (self.me_requests, self.note_state(), self.panel()["status"], self.layout_status(),
                              self.page.evaluate("synMounted"), self.page.evaluate(EDIT_ATTEMPTS)))
            self.assertEqual(["missing", "view WindowLevel", "false", f"refused: {ENDED}"], self.page.evaluate(
                "async () => [synClick('Bidirectional'), synDraw('default'), synAdd('Bidirectional'), await synSR('storeMeasurements')]"))

        # (c) A writer document's real session end: a logout broadcast while the panel's /me (asked on focus) is in flight, that
        # /me then answering a writer; and another account's answer. Every write module comes down and the local mark goes.
        for how in ("logout", "another account"):
            with self.subTest(session_end=how):
                self.fresh_page()
                self.writer_document()
                if how == "logout":
                    self.hold_me = True
                    self.focus()
                    self.wait_until(lambda: len(self.held_me) == 1, "the panel's /me asked on focus, held")
                    self.page.evaluate("() => new BroadcastChannel('kin-session').postMessage({ type: 'session-ended' })")
                    self.wait_until(lambda: self.session() == "refused", "the logout")
                    self.hold_me = False
                    self.release(self.held_me.pop(), RADIOLOGIST)
                else:
                    self.me = OTHER_WRITER
                    self.focus()
                    self.wait_until(lambda: self.session() == "refused", "the other account's answer")
                self.assertEqual([], self.page.evaluate("synMarks()"), "the writer's local mark is gone")
                self.assertEqual(WRITE_MODULES, set(self.page.evaluate("synStopped")))
                self.ended_after_refusal()

        # Control: the file at X2-R-001 for this path, Astra's reproduction: the late writer answer of the module gate makes the
        # session writer again, the ended panel gives the Measurements split button back and Bidirectional makes a mark.
        self.fresh_page()
        self.refusal_then_late_writers("panel", 403, self.config_variants["as-x2"])
        self.assertEqual(("writer", True, "true", ["Bidirectional"]),
                         (self.session(), "MeasurementTools" in self.page.evaluate("synToolbar()")["primary"],
                          self.page.evaluate("synAdd('Bidirectional')"), self.page.evaluate("synMarks()")),
                         "control: authoring reopened after the refusal")
        # Probes: either half of the fix alone keeps that path closed — a session that can leave refused (the ended panel still
        # refuses), and a panel without the ended guard (the session stays refused).
        for name, session in (("refusal-reversible", "writer"), ("no-ended-guard", "refused")):
            with self.subTest(probe=name):
                self.fresh_page()
                self.refusal_then_late_writers("panel", 403, self.config_variants[name])
                self.assertEqual((session, VIEW_SECTION, "false", []),
                                 (self.session(), self.page.evaluate("synToolbar()")["primary"],
                                  self.page.evaluate("synAdd('Bidirectional')"), self.page.evaluate("synMarks()")))

    # ── Astra S5-U2b-X3-R-001 regression ──
    def layout_sees_account_change(self, via, account, config=None):
        # A writer document; the Measurements panel's /me asked on focus is held (the first account's answer comes later), and the
        # layout panel's own /me, asked by Save Recent Layout or by the Hanging Protocol editor's access check, answers `account`
        # first. Returns the held route and what the layout panel's request ended with (its status line, or the access error).
        self.writer_document(config)
        self.hold_me = True
        self.focus()
        self.wait_until(lambda: len(self.held_me) == 1, "the Measurements panel's /me asked on focus, held")
        held, self.hold_me, self.held_me, self.me = self.held_me[0], False, [], account
        asked = self.me_requests
        if via == "save":
            self.page.evaluate("""() => [...document.querySelectorAll('#kin-viewer-layout button')]
              .find(b => b.textContent === 'Save Recent Layout').click()""")
            self.wait_until(lambda: self.me_requests > asked and self.layout_status() != LAYOUT_CHECKING,
                            "Save Recent Layout's /me answered")
            outcome = self.layout_status()
        else:
            self.page.evaluate("""() => { window.synHpOutcome = null;
              synHpAccess({ signal: new AbortController().signal }).then(() => 'ok', error => error.message)
                .then(outcome => { window.synHpOutcome = outcome; }); }""")
            self.wait_until(lambda: self.page.evaluate("window.synHpOutcome") is not None, "the editor's access check answered")
            outcome = self.page.evaluate("window.synHpOutcome")
        self.settle()
        return held, outcome

    def reentry_stays_ended(self):
        # Mode exit and re-entry of the ended document with /me answering the other account (self.me): nothing asks /me or a list,
        # nothing mounts, the new layout panel starts ended with its account buttons disabled and no editor, authoring refuses.
        asked, reads, mounted = self.me_requests, len(self.item_requests), len(self.page.evaluate("synMounted"))
        self.assertEqual(VIEW_SECTION, self.page.evaluate("() => { synReenter(); return synToolbar().primary; }"))
        self.settle()
        self.assertEqual((asked, reads, mounted, "refused", "refused", ENDED, LAYOUT_ENDED, [[n, True] for n in LAYOUT_BUTTONS]),
                         (self.me_requests, len(self.item_requests), len(self.page.evaluate("synMounted")), self.session(),
                          self.note_state(), self.panel()["status"], self.layout_status(), self.layout()["buttons"]))
        self.assertEqual([["new", None]], self.page.evaluate(EDIT_ATTEMPTS))
        self.assertEqual(["missing", "view WindowLevel", "false", f"refused: {ENDED}"], self.page.evaluate(
            "async () => [synClick('Bidirectional'), synDraw('default'), synAdd('Bidirectional'), await synSR('storeMeasurements')]"))

    def test_18_another_account_seen_first_by_the_layout_panel_ends_the_documents_session(self):
        # (a) Astra's order: the layout panel sees another account first (Save Recent Layout, the editor's access check; another
        # writer, and a clinician-only account that noted first would have made the document read-only instead of ended).
        outcomes = {"save": LAYOUT_ENDED, "hanging-protocol": ACCOUNT_CHANGED}
        for via, account in (("save", OTHER_WRITER), ("hanging-protocol", OTHER_WRITER), ("save", CLINICIAN)):
            with self.subTest(via=via, account=account["user"]):
                self.fresh_page()
                held, outcome = self.layout_sees_account_change(via, account)
                # At once, before the first account's held answer: the document's session is refused, the Measurements panel has
                # ended, the write modules are down, the local mark is gone and nothing was stored.
                self.assertEqual((outcomes[via], "refused", ENDED, LAYOUT_ENDED, VIEW_SECTION, "false", []),
                                 (outcome, self.session(), self.panel()["status"], self.layout_status(),
                                  self.page.evaluate("synToolbar()")["primary"], self.page.evaluate("synAdd('Bidirectional')"),
                                  self.page.evaluate("synMarks()")))
                self.assertEqual(WRITE_MODULES, set(self.page.evaluate("synStopped")))
                self.assertEqual([], [key for key in self.page.evaluate("Object.keys(localStorage)") if key.startswith(LAYOUT_PREFIX)])
                # The first account's writer answer, asked before the change, arrives after it: nothing reopens.
                self.release(held, RADIOLOGIST)
                self.ended_after_refusal()
                self.reentry_stays_ended()
        # (b) The Measurements panel's own /me answering a clinician-only other account ends the document the same way.
        with self.subTest(via="measurements", account=CLINICIAN["user"]):
            self.fresh_page()
            self.writer_document()
            self.me = CLINICIAN
            self.focus()
            self.wait_until(lambda: self.session() != "writer", "the other account's answer")
            self.settle()
            self.assertEqual(("refused", ENDED, WRITE_MODULES), (self.session(), self.panel()["status"],
                                                                 set(self.page.evaluate("synStopped"))))
            self.ended_after_refusal()
            self.reentry_stays_ended()

        # Control: the file at X3-R-001 for these paths, Astra's reproduction. The layout panel ends only itself: the session stays
        # writer and the Measurements panel open, Bidirectional makes a mark after the held answer, and a mode re-entry with /me
        # answering the other account gives the account buttons, the editor and the write modules back.
        self.fresh_page()
        held, outcome = self.layout_sees_account_change("save", OTHER_WRITER, self.config_variants["as-x3"])
        self.assertEqual((LAYOUT_ENDED, "writer", True), (outcome, self.session(), self.panel()["status"] != ENDED),
                         "control: only the layout panel ended")
        self.release(held, RADIOLOGIST)
        self.assertEqual(("writer", True, "true"),
                         (self.session(), "MeasurementTools" in self.page.evaluate("synToolbar()")["primary"],
                          self.page.evaluate("synAdd('Bidirectional')")), "control: authoring kept")
        self.page.evaluate("synReenter()")
        self.wait_until(lambda: self.layout()["buttons"] == [[n, False] for n in LAYOUT_BUTTONS + ["Save to Account"]] and
                        Counter(self.page.evaluate("synMounted"))["findings"] == 2,
                        "control: the account buttons, the editor and the write modules back after the re-entry")
        # Control: a clinician-only other account noted first leaves the document read-only (not ended), through either panel.
        for via in ("save", "measurements"):
            with self.subTest(control=via):
                self.fresh_page()
                if via == "save":
                    held, _ = self.layout_sees_account_change("save", CLINICIAN, self.config_variants["as-x3"])
                    self.release(held, RADIOLOGIST)
                else:
                    self.writer_document(self.config_variants["as-x3"])
                    self.me = CLINICIAN
                    self.focus()
                self.wait_until(lambda: self.session() != "writer", "control: the other account's answer")
                self.settle()
                self.assertEqual("read-only", self.session(), "control: read-only, not ended")


if __name__ == "__main__":
    unittest.main(verbosity=2)
