"""Clinician viewer behaviour on the shipped session boundary.

U5S-REQ-04/08/12 -> U5S-RISK-SESSION/WRITE -> TEST-CLINICIAN-VIEWER.
Only OHIF rendering services and server responses are synthetic. The gate, transport,
viewer authority and clinician window.name handoff are shipped assets.
Negative controls are served copies in clinician_viewer_mutants.py; this baseline serves the shipped assets.
"""
from collections import Counter

import copy
import json

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

SHIPPED = {name: lf_text(HPACS / name) for name in ("clinician.html", "clinician.js", "auth.js", "work-context.js", "session-transport.js", "viewer-resources.js", "viewer-session.js", "critical-result-inbox.js")}

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

A, P1, P2, N, O, T, K, B = (uid(n) for n in range(11, 19))

BAD = f"{PREFIX}.19x"

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

VIEWER = "영상은 새 창의 뷰어에서 읽기 전용으로 엽니다. 측정·키 이미지를 만들거나 저장하지 않으며 서버도 쓰기를 거절합니다."

VIEWER_ASKED = "뷰어 창에 이 검사를 열도록 요청했습니다. 영상 표시는 그 창에서 확인하세요."

COMPARE_ASKED = "뷰어 창에 이 검사와 고른 비교 검사를 나란히 열도록 요청했습니다. 영상 표시는 그 창에서 확인하세요."

BLOCKED = "브라우저가 새 창을 막아 뷰어를 열지 못했습니다. 이 사이트의 팝업을 허용한 뒤 다시 누르세요."

BAD_UID = "검사 UID 형식을 확인할 수 없어 뷰어를 열지 않았습니다."

GONE = "비교할 검사를 지금 목록에서 같은 환자로 확인할 수 없어 열지 않았습니다. 목록을 새로고침하세요."

NONE = "같은 환자 키의 다른 검사가 목록에 없어 나란히 비교할 검사가 없습니다."

NO_KEY = "이 검사에는 서버 환자 키가 없어 비교할 검사를 찾지 않습니다."

VIEWER_WINDOW = "kin-clinician-viewer"

AVOIDED = re.compile(r"진단|검출|판정|우선순위|diagnos|detect|priorit|\bAI\b", re.IGNORECASE)

STAND_IN = '<!doctype html><html><head><meta charset="utf-8"><title>SYN viewer stand-in</title></head><body></body></html>'

COMPARE_VIEW = """() => { const s = document.querySelector('#compare');
  return {note: document.querySelector('#viewer-note').textContent, section: s ? s.dataset.uid : null,
    candidates: s ? [...s.querySelectorAll('#compare-list li')].map(li => li.dataset.uid) : [],
    enabled: !document.querySelector('#open-viewer').disabled}; }"""

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

SHOWN_MARK, SHOWN_KEY = mark_item(81, "length", "SYN WRITER SHOWN LENGTH"), key_item(82, "SYN WRITER SHOWN KEY")

LATE_MARK, LATE_KEY = mark_item(83, "length", "SYN LATE WRITER LENGTH"), key_item(84, "SYN LATE WRITER KEY")

LATE_WRITE = key_item(85, "SYN LATE WRITTEN KEY")

HELD_TITLE = "SYN HELD WRITER KEY"

RO_NOTE = ("읽기 전용 · 확정 판독문에 저장된 측정·키 이미지만 표시합니다. 이 화면에서는 측정·키 이미지를 만들거나 저장하지 않으며 "
           "서버도 쓰기를 거절합니다.")

RO_WITHHELD = "확정 판독문이 아니어서 저장된 측정·키 이미지를 표시하지 않습니다 · 읽기 전용"

RO_TOOL = "읽기 전용 화면입니다. 측정을 만들지 않습니다."

RO_EDIT = "읽기 전용 화면입니다. 측정·표식을 편집하지 않습니다."

RO_SR = "읽기 전용 화면에서는 SR을 만들거나 저장하지 않습니다."

RO_DENIED = "이 검사의 저장 항목을 읽을 수 없습니다(HTTP 403). 서버가 거절했습니다."

RO_UNMATCHED = ("현재 화면에서 원본 프레임을 확인할 수 없어 이 목록을 표시 영상과 맞추지 않았습니다. 마지막으로 확인한 검사 기준이며 "
                "확정 여부는 계속 다시 확인합니다.")

UNCONFIRMED_TOOL = "계정이 확인되기 전에는 영상 조작만 할 수 있습니다. 측정·표식을 만들지 않습니다."

UNCONFIRMED_EDIT = "계정이 확인되기 전에는 측정·표식을 편집하지 않습니다."

UNCONFIRMED_SR = "계정이 확인되기 전에는 SR을 만들거나 저장하지 않습니다."

WRITER_SR = "직접 작성한 측정을1~16개 선택하세요."

ENDED = "로그인이 종료되었습니다. 다시 로그인한 뒤 뷰어를 여세요."

LOADING = "저장 항목 확인 중…"

UNVERIFIED = "재확인 필요: 원본 영상의 동일성을 확인할 수 없습니다."

WRITER_CONTROLS = {"Download SR", "Store SR", "Length", "Angle", "Ellipse ROI", "Add Key Image", "Edit", "Save", "Hide",
                   "Restore", "History", "Recheck Source", "Retry Request", "Use Latest & Keep Changes",
                   "Discard Held Changes", "Resume Held Work", "Discard Held Work"}

MODULES = {"findings", "jobs", "tech-note", "hanging-protocol"}

WRITE_MODULES = {"findings", "jobs", "tech-note"}

LATER = ["kin.viewer-findings", "kin.viewer-layout", "kin.viewer-jobs", "kin.viewer-tech-note"]

PRIMARY_SECTION = ["MeasurementTools", "Zoom", "Pan", "TrackballRotate", "WindowLevel", "Capture", "Layout", "Crosshairs",
                   "MoreTools"]

VIEW_SECTION = [x for x in PRIMARY_SECTION if x not in ("MeasurementTools", "Capture")]

ENDED_WRITER_SECTION = [x for x in PRIMARY_SECTION if x != "MeasurementTools"]

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

STATES = ("unconfirmed", "refused", "read-only", "writer", "read-only+held", "refused+late-writer", "refused+layout-account",
          "ended+reenter", "read-only+ended")

WRITER_ONLY = (False, False, False, True, False, False, False, False, False)

CAPTURE_OFFERED = (False, False, False, True, False, False, True, True, False)

VIEWER_STATE_MATRIX = {
    # The list on screen: its verified saved length drawn locked (the writer list here holds key images only), and Go to Image
    # of the shown source frame through the navigation API (unconfirmed: busy; refused: ended).
    "list_mark": (False, False, True, False, True, False, False, False, False),
    "go_to_image": (False, False, True, True, True, False, False, False, False),
    # Write and mark entry points: True = works in that state, False = not offered or refused (nothing drawn, sent or mounted).
    "toolbar_offer": WRITER_ONLY,        # the Measurements split button and the authoring items of More Tools
    "capture": CAPTURE_OFFERED,          # Capture offered in the primary section and its press reaching showDownloadViewportModal
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
    "viewing": (True, True, True, True, True, True, True, True, True),  # Zoom from the toolbar, then a drag: image viewing in every state
    # Recheck paths, as the viewer-items requests the panel makes: read = the clinician list (limit=100), read-all = the writer
    # list (includeHidden=true), check = limit=1 (the clinician final check / the writer's access probe), cursor = the next
    # page asked with the handed-out cursor verbatim, none = no list request (unconfirmed: /me is asked again on focus and
    # every 15 s, and nothing is read until an answer; refused: the panel has ended).
    "initial_read": ("none", "none", "read", "read-all", "read", "none", "none", "none", "none"),
    "page_continuation": ("none", "none", "cursor", "cursor", "cursor", "none", "none", "none", "none"),
    "focus": ("none", "none", "check", "check", "check", "none", "none", "none", "none"),
    "me_on_focus": (True, False, True, True, True, False, False, False, False),    # the same focus asks /me (the retry, the check, the probe)
    "periodic": ("none", "none", "check", "check", "check", "none", "none", "none", "none"),  # the clock moved past 15 s since the last /me
    "frame_lost": ("none", "none", "none", "none", "none", "none", "none", "none", "none"),  # the active viewport stops showing a source frame
    "frame_return": ("none", "none", "check", "none", "check", "none", "none", "none", "none"),  # the source frame comes back (clinician: checked at once)
    "frameless_focus": ("none", "none", "check", "none", "check", "none", "none", "none", "none"),  # focus with no source frame (writer probe stays frame-bound)
    "study_change": ("none", "none", "read", "read-all", "read", "none", "none", "none", "none"),  # the frame of another study
}

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

MODULE_STUBS = {
    "finding-link-model.js": "window.kinFindingLinkModel = { SCHEMA: 2 };",
    "viewer-findings.js": "window.kinViewerFindings = (services, model, session) => window.synModule('findings', ['New Finding', 'Link Saved Items'], '#kin-viewer-history', session);",
    "viewer-volume-job.js": "/* SYN: no volume job module */",
    "viewer-stack-restore.js": "/* SYN: no stack restore in the role-only fixture */",
    "viewer-jobs.js": "window.kinViewerJobs = (services, model, session) => window.synModule('jobs', ['Save New Job'], null, session);",
    "tech-note.css": "",
}

REAL_MODULES = {"jobs": ("viewer-stack-restore.js", "viewer-jobs.js"), "findings": ("finding-link-model.js", "viewer-findings.js"),
                "tech-note": ("viewer-tech-note.js",)}

VIEWER_HARNESS = r"""<!doctype html><html><head><meta charset="utf-8"><title>SYN viewer harness</title></head><body>
<script>
window.synMounted = []; window.synStopped = []; window.synEnded = []; window.synNative = []; window.synNotices = []; window.synStudy = null;
// synFrameless: the active viewport shows no identifiable source frame (an MPR/volume view, an image that failed to load).
window.synFrameless = false;
// The clock the panel reads; synAdvance moves it so the 15 s periodic check falls due without waiting.
const realNow = Date.now.bind(Date); let skew = 0; Date.now = () => realNow() + skew; window.synAdvance = ms => { skew += ms; };
// The observation tick: config/ohif.js runs the Measurements panel's scan() on a 250 ms interval (the real Findings section's sync
// too). synTick(n) runs every live 250 ms interval callback n times now, as its next n ticks would, so a case sees what those ticks
// do without waiting for them; the intervals keep running on their own as well.
const realSetInterval = window.setInterval.bind(window), realClearInterval = window.clearInterval.bind(window), ticking = new Map();
window.setInterval = (fn, ms, ...args) => { const id = realSetInterval(fn, ms, ...args);
  if (ms === 250 && typeof fn === 'function') ticking.set(id, () => fn(...args)); return id; };
window.clearInterval = id => { ticking.delete(id); realClearInterval(id); };
window.synTick = (n = 1) => { for (let i = 0; i < n; i++) for (const tick of [...ticking.values()]) tick(); };
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
// A write module's stub: a stop takes its controls away, as the real modules' stop removes their panel; the document's end (the
// session's onEnd, Astra S5-U2b-X5-R-001 F01) ends it in place, as the real modules do: its controls stay, disabled.
window.synModule = (name, labels, host, session) => { let box = null, off = () => {}; return { mount() {
  window.synMounted.push(name);
  box = document.createElement('section'); box.dataset.synModule = name;
  for (const label of labels) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; box.append(b); }
  ((host && document.querySelector(host)) || document.body).append(box);
  off = session?.onEnd?.(() => { window.synEnded.push(name); for (const b of box.querySelectorAll('button')) b.disabled = true; }) || (() => {});
  return true; }, stop() { off(); window.synStopped.push(name); box?.remove(); } }; };
window.kinViewerTechNote = (services, session) => window.synModule('tech-note', ['Tech Note'], null, session);
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
// test_23: the same two halves with the case acting in between (every extension down, the document still open).
window.synLeave = () => { for (const e of extensions) e.onModeExit(); toolGroupService.destroy(); };
window.synComeBack = () => { window.synEnter(IDS); window.synMode(); };
// The write-module controls on the page that still work (a stub's, or a real module's own buttons).
window.synWriteControls = () => [...document.querySelectorAll('[data-syn-module] button, #kin-viewer-jobs button, #kin-viewer-findings button, #kin-viewer-tech-note button')]
  .filter(b => !b.disabled && !b.hidden).map(b => b.textContent);
window.synSwitch = study => { window.synStudy = study; document.dispatchEvent(new Event('syn-stack-new-image')); };
window.synFocus = () => { window.dispatchEvent(new Event('focus')); };
</script>
<script src="/harness/ohif.js"></script>
</body></html>""".replace("%SERIES%", SERIES).replace("%SOP%", SOP)

PANEL = """() => { const p = document.querySelector('#kin-viewer-history');
  return {state: p.dataset.readOnly ?? null, uid: p.dataset.studyUid ?? null, frame: p.dataset.frame ?? null,
    status: p.querySelector('[role=status]').textContent,
    buttons: [...p.querySelectorAll('button')].filter(b => !b.closest('[data-syn-module], #kin-viewer-findings')).map(b => b.textContent),
    links: [...p.querySelectorAll('a')].map(a => a.textContent), inputs: p.querySelectorAll('input, textarea').length,
    notes: [...p.querySelectorAll(':scope > div > p')].map(e => e.textContent),
    rows: [...p.querySelectorAll('section[data-item-id]')].map(s => [...s.children].map(c => c.textContent))}; }"""

EDIT_ATTEMPTS = """() => { const answers = [];
  synRun('showCornerstoneContextMenu', { requireNearbyToolData: true, menuId: 'measurementsContextMenu' });
  synRun('deleteMeasurement', { uid: 'syn-uid' }); synRun('setMeasurementLabel', { uid: 'syn-uid' });
  synRun('updateMeasurement', { uid: 'syn-uid', textLabel: 'SYN' });
  synRun('arrowTextCallback', { callback: text => answers.push(['new', text ?? null]) });
  synRun('arrowTextCallback', { data: { uid: 'syn-uid' }, callback: text => answers.push(['edit', text ?? null]) });
  const m = synServices.measurementService;
  m.update('syn-uid', { label: 'SYN renamed' }, true); m.update('syn-uid', { label: 'synced' }, false); m.toggleLockMeasurement('syn-uid');
  return answers; }"""

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
  from = synNative.length;
  seen.capture = bar.primary.includes('Capture') && synClick('Capture') === 'ran' && synNative.slice(from).includes('view showDownloadViewportModal');
  seen.sr = [await synSR('storeMeasurements'), await synSR('downloadReport')];
  return seen; }"""

LAYOUT = """() => { const p = document.querySelector('#kin-viewer-layout');
  return {summary: p.querySelector('summary').textContent, buttons: [...p.querySelectorAll('button')].map(b => b.textContent),
    note: p.querySelector(':scope > p').textContent}; }"""

NAVIGABLE = """([series, sop]) => { const v = synServices.cornerstoneViewportService.getCornerstoneViewport('syn-vp');
  window.synIndexed = []; v.setImageIdIndex = async index => { window.synIndexed.push(index); };
  synServices.displaySetService.getActiveDisplaySets = () => [{ StudyInstanceUID: window.synStudy, SeriesInstanceUID: series,
    displaySetInstanceUID: 'syn-ds', images: [{ SOPInstanceUID: sop }] }]; }"""

NAVIGATE = """([study, series, sop, item]) => window.kinViewerHistoryNavigate({ studyUid: study, seriesUid: series, sopUid: sop,
  frame: 1, ...(item ? { itemId: item } : {}) })"""

def has_hangul(text):
    return any(unicodedata.name(ch, "").startswith("HANGUL") for ch in text)

HISTORY = "kin.viewer-history"

OTHER = ["kin.viewer-layout"]

GATES = ["kin.viewer-findings", "kin.viewer-jobs", "kin.viewer-tech-note"]

LAYOUT_ID = "kin.viewer-layout"

LAYOUT_ENDED = "세션이 변경되었습니다. 다시 로그인한 뒤 뷰어를 여세요."

OTHER_WRITER = me(["radiologist", *KEYCLOAK_DEFAULTS], sub="SYN-RAD2-SUB", user="syn-radiologist-2", name="SYN Radiologist Two")

SLOW_ME_BODIES = """() => { const real = window.fetch.bind(window); window.synBodies = [];
  window.fetch = async (url, options) => { const response = await real(url, options);
    if (url !== '/api/me') return response;
    let release; const released = new Promise(resolve => { release = resolve; }); window.synBodies.push(release);
    return { status: response.status, ok: response.ok, json: () => released.then(() => response.json()) }; }; }"""

EXTRA_BUTTONS = """() => { const bar = synServices.toolbarService;
  bar.addButtons([{ id: 'SYN-Download', uiType: 'ohif.radioGroup', props: { commands: [{ commandName: 'showDownloadViewportModal' }] } },
                  { id: 'SYN-Reset', uiType: 'ohif.radioGroup', props: { commands: [{ commandName: 'resetViewport' }] } }]);
  bar.createButtonSection('primary', ['SYN-Download', 'SYN-Reset']); }"""

EXTRA_PRESSED = """() => { const from = synNative.length, offered = synToolbar().primary.filter(id => id.startsWith('SYN-'));
  return [offered, synClick('SYN-Download'), synClick('SYN-Reset'), synNative.slice(from)]; }"""

OTHER_CLINICIAN = me(["clinician", *KEYCLOAK_DEFAULTS], sub="SYN-CLIN2-SUB", user="syn-clinician-2", name="SYN Clinician Two")

LOGOUT = "() => window.dispatchEvent(new StorageEvent('storage', { key: 'kin-session-ended' }))"

QUIET = 0.15

LAYOUT_CHECKING = "계정과 검사 접근 확인 중…"

ACCOUNT_CHANGED = "계정이 변경되어 배치를 적용하지 않았습니다."

LAYOUT_BUTTONS = ["Save Recent Layout", "Restore Recent Layout", "Delete Recent Layout"]

LAYOUT_PREFIX = "kin-viewer-layout-v1:"

MODULE_NOTICE = {"jobs": ("#kin-viewer-jobs-status", "세션이 변경되었습니다. 다시 로그인한 뒤 뷰어를 여세요."),
                 "findings": ("#kin-viewer-findings-status", "로그인이 종료되었습니다. 다시 로그인한 뒤 뷰어를 여세요."),
                 "tech-note": ("#kin-viewer-note-status", "세션이나 영상창이 변경되었습니다. 뷰어를 새로 여세요.")}

MODULE_READY = {"jobs": ("#kin-viewer-jobs-status", "현재 판독 대상의 저장 작업 목록입니다."),
                "findings": ("#kin-viewer-findings-status", "0개 소견"),
                "tech-note": ("#kin-viewer-note-status", "선택한 영상 칸의 검사 메모")}

MODULE_CONTROL = {"jobs": "Save New Job", "findings": "New Finding", "tech-note": "Tech Note"}

MODULE_ME_HEADER = {"jobs": "x-kin-subject", "findings": "x-kin-finding-schema", "tech-note": "x-kin-institution"}

REAL_NOTE_DEPS = """() => { delete window.kinViewerTechNote;
  window.KinViewerWindows = { connect: () => ({ dispose() {} }) }; window.KinViewerIdentity = { mount: () => ({ dispose() {} }) };
  window.KinViewerWorkspaceDock = () => null;
  window.KinWorkspaceShortcuts = { read: () => ({ image: 'Control+Alt+2', report: 'Control+Alt+4', note: 'Control+Alt+6',
    tools: 'Control+Alt+7', nativeTools: 'Control+Alt+9' }), display: value => String(value), action: () => null };
  window.KinTechNote = options => { window.synNoteApi = options.api; return { open() {}, dispose() {} }; }; }"""

MODULE_RECHECK = {
    "jobs": "() => synAdvance(16000)",
    "findings": "() => [...document.querySelectorAll('#kin-viewer-findings button')].find(b => b.textContent === 'Reload Findings').click()",
    "tech-note": """() => { window.synNoteOutcome = null;
      synNoteApi('GET', '/syn-note').then(() => 'sent', error => error.message).then(outcome => { window.synNoteOutcome = outcome; }); }""",
}

BROADCAST_LOGOUT = "() => { const c = new BroadcastChannel('kin-session'); c.postMessage({ type: 'session-ended' }); c.close(); }"

END_REASONS = "() => { window.synEndReasons = []; kinViewerSession.onEnded(reason => { window.synEndReasons.push(reason); }); }"

CT_SYNC_TEXT = {
    "ended": "세션이 변경되었거나 종료되어 위치 동기를 중지했습니다. 다시 로그인한 뒤 뷰어를 여세요",
    "confirmed": "검사 접근 정보를 확인했습니다. 위치 동기를 사용할 수 있습니다",
    "failed": "검사 접근 정보를 확인하지 못해 위치 동기를 멈췄습니다. 연결 상태를 확인한 뒤 다시 확인하세요",
    "denied": "이 계정으로 검사 접근 정보를 확인할 수 없어 위치 동기를 멈췄습니다. 권한을 확인한 뒤 다시 확인하세요",
    "synced": "같은 좌표계의 CT 위치 동기",
}

CT_SYNC_HOLD_IMAGES = """() => { window.synCtImages = [];
  cornerstone.imageLoader.loadAndCacheImage = () => new Promise(resolve => window.synCtImages.push(resolve)); }"""

CT_SYNC_RELEASE_IMAGES = """() => { cornerstone.imageLoader.loadAndCacheImage = async () => ({});
  window.synCtImages.splice(0).forEach(resolve => resolve({})); }"""

CT_SYNC_BOOT = """([current, prior]) => {
  const CT = '1.2.840.10008.5.1.4.1.1.2', ENGINE = 'syn-ct-engine', planes = new Map(), viewports = new Map(), grid = new Map(), sets = new Map();
  const stack = (vp, study, series, zs) => {
    const ids = zs.map((z, i) => `wadors:${location.origin}/dicom-web/studies/${study}/series/${series}/instances/${series}.${i}/frames/1`);
    ids.forEach((id, i) => planes.set(id, { frameOfReferenceUID: 'SYN-FOR-1', imagePositionPatient: [0, 0, zs[i]], rowCosines: [1, 0, 0], columnCosines: [0, 1, 0] }));
    sets.set('syn-ds-' + vp, { StudyInstanceUID: study, SeriesInstanceUID: series, Modality: 'CT', SOPClassUID: CT, images: ids.map(() => ({ SOPClassUID: CT })) });
    grid.set(vp, { viewportId: vp, displaySetInstanceUIDs: ['syn-ds-' + vp] });
    viewports.set(vp, { id: vp, type: 'stack', index: 0, ids, getRenderingEngine: () => ({ id: ENGINE }), getImageIds() { return this.ids; },
      getCurrentImageIdIndex() { return this.index; }, getCurrentImageId() { return this.ids[this.index]; } });
  };
  stack('syn-ct-a', current, current + '.1', Array.from({ length: 16 }, (_, i) => i * 2));
  stack('syn-ct-b', prior, prior + '.1', Array.from({ length: 8 }, (_, i) => i * 4));
  const z = id => planes.get(id)?.imagePositionPatient[2];
  window.cornerstone.imageLoader = { loadAndCacheImage: async () => ({}) };
  window.cornerstone.metaData = { get: (type, id) => type === 'imagePlaneModule' ? planes.get(id) : undefined };
  window.cornerstone.utilities = { spatialRegistrationMetadataProvider: { add() {} } };
  class NativeSync {
    constructor() { this.targets = []; this.options = {}; this.enabled = true; }
    add(info) { this.targets.push(info); }
    getTargetViewports() { return this.targets.map(t => ({ ...t })); }
    hasTargetViewport(engine, id) { return this.targets.some(t => t.renderingEngineId === engine && t.viewportId === id); }
    isDisabled() { return !this.enabled; }
    setEnabled(value) { this.enabled = value; }
    getOptions(id) { return this.options[id]; }
    setOptions(id, value) { this.options[id] = value; }
    destroy() { this.targets = []; }
    async fireEvent(info) {
      const sz = z(viewports.get(info.viewportId).getCurrentImageId());
      for (const t of this.targets) {
        if (t.viewportId === info.viewportId || this.options[t.viewportId]?.disabled) continue;
        const target = viewports.get(t.viewportId), zs = target.ids.map(z);
        target.index = zs.reduce((best, value, i) => Math.abs(value - sz) < Math.abs(zs[best] - sz) ? i : best, 0);
      }
    }
  }
  const creators = new Map(['imageSlice', 'stackimage'].map(type => [type, () => new NativeSync()]));
  const services = {
    syncGroupService: { getSyncCreatorForType: type => creators.get(type), addSynchronizerType: (type, fn) => { creators.set(type, fn); } },
    cornerstoneViewportService: { getCornerstoneViewport: id => viewports.get(id) },
    viewportGridService: { getState: () => ({ viewports: grid }) },
    displaySetService: { getDisplaySetByUID: uid => sets.get(uid) } };
  const extension = window.config.extensions.find(e => e && e.id === 'kin.ct-sync');
  extension.preRegistration({ servicesManager: { services } });
  let sync = null;
  window.synCt = {
    enter() { extension.onModeEnter(); sync = creators.get('imageSlice')('IMAGE_SLICE_SYNC', {});
      for (const viewportId of viewports.keys()) sync.add({ viewportId, renderingEngineId: ENGINE }); },
    exit() { extension.onModeExit(); },
    scroll(vp, index) { viewports.get(vp).index = index; sync.fireEvent({ viewportId: vp, renderingEngineId: ENGINE }, {}); },
    z: vp => z(viewports.get(vp).getCurrentImageId()),
    notice() { const n = document.querySelector('#kin-ct-sync-status'), b = document.querySelector('#kin-ct-sync-recheck');
      return n ? { visible: !n.hidden, text: n.hidden ? '' : n.querySelector('span').textContent, recheck: !!b && !n.hidden && !b.hidden } : null; },
  };
  window.synCt.enter();
}"""

CT_SYNC_BESIDE_PANELS = ("([current, prior]) => { const panels = window.cornerstone.metaData.get;\n  (" + CT_SYNC_BOOT + ")([current, prior]);\n"
                         "  const ct = window.cornerstone.metaData.get;\n"
                         "  window.cornerstone.metaData.get = (type, id) => ct(type, id) ?? panels(type, id); }")

CT_SYNC_HIT = """() => { const n = document.querySelector('#kin-ct-sync-status'), b = document.querySelector('#kin-ct-sync-recheck');
  const at = r => document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2), rb = b.getBoundingClientRect();
  return { button: at(rb) === b, words_pass: !n.contains(at(n.querySelector('span').getBoundingClientRect())), height: rb.height,
    font: parseFloat(getComputedStyle(b).fontSize) }; }"""

class ClinicianViewerDOMTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.me = CLINICIAN
        self.bootstrap = False
        self.entry_reads = []
        self.held_navigation = []
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
        self.inbox_reads = []
        self.real_api = False
        self.module_requests = []
        self.module_status = {}
        self.last_request = 0.0
        self.unexpected, self.errors, self.dialogs, self.finished = ([], [], [], [])
        self.context = self.browser.new_context(viewport={'width': 1400, 'height': 900})
        self.context.route('**/*', self.route)
        self.page = self.watched_page()

    def watched_page(self):
        page = self.context.new_page()
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.on('dialog', self.on_dialog)
        page.on('requestfinished', lambda request: self.finished.append(request))
        return page

    def release_routes(self):
        routes=list(self.held_navigation)+list(self.held_me)+list(self.held_writes)
        routes += [row[-1] for row in self.held_items+self.held_writer]
        for route in routes:
            try:route.abort()
            except Exception:pass
        self.page.wait_for_timeout(20)

    def fresh_page(self):
        self.release_routes()
        if getattr(self, 'observer', None) and not self.observer.is_closed():
            self.observer.evaluate("localStorage.removeItem('kin-session-end')")
            self.observer.close()
        self.held_me=[];self.held_writer=[];self.held_items=[];self.held_writes=[];self.held_navigation=[]
        self.page.close()
        self.page = self.watched_page()

    def tearDown(self):
        self.release_routes()
        self.context.close()
        self.assertEqual([], self.errors, 'page errors')
        self.assertEqual([], self.unexpected, 'requests the harness does not answer')
        self.assertEqual([], self.dialogs, 'browser dialogs')

    def on_dialog(self, dialog):
        self.dialogs.append(f'{dialog.type}: {dialog.message}')
        dialog.dismiss()

    def route(self, route):
        request = route.request
        self.last_request = time.monotonic()
        url = urlparse(request.url)
        method, path = (request.method, url.path)
        if f'{url.scheme}://{url.netloc}' != ORIGIN:
            self.unexpected.append(f'{method} {request.url}')
            route.abort()
            return
        if path == '/harness/observer':
            return route.fulfill(body='<html><body>Observer</body></html>', content_type='text/html')
        if path == BASE + 'index.html':
            self.held_navigation.append(route)
            return
        if method == 'GET' and path.startswith(BASE):
            name = path[len(BASE):]
            if name in self.files:
                kind = 'text/html' if name.endswith('.html') else 'application/javascript'
                route.fulfill(body=self.files[name], content_type=f'{kind}; charset=utf-8')
                return
            if name in MODULE_STUBS:
                kind = 'text/css' if name.endswith('.css') else 'application/javascript'
                route.fulfill(body=MODULE_STUBS[name], content_type=f'{kind}; charset=utf-8')
                return
        if path.startswith('/kin-brand/') or path == '/favicon.ico':
            route.fulfill(status=404, body='')
            return
        if method == 'GET' and path == '/ohif/viewer':
            if self.viewer_page:
                route.fulfill(body=VIEWER_HARNESS.replace('<script>', '<script>window.name='+json.dumps('kin-viewer-entry:'+json.dumps({'session':'SYN-SESSION-'+self.me['sub'],'name':VIEWER_WINDOW}))+';</script><script>',1), content_type='text/html; charset=utf-8')
            else:
                self.viewer_opens.append(parse_qs(url.query, keep_blank_values=True))
                route.fulfill(body=STAND_IN.replace('</body>', '<script src="/harness/ohif.js"></script><script>kinCreateSessionBoundary().preRegistration().then(()=>window.verified=true)</script></body>'), content_type='text/html; charset=utf-8')
            return
        if method == 'GET' and path == '/harness/ohif.js':
            route.fulfill(body=self.config, content_type='application/javascript; charset=utf-8')
            return
        if path.startswith('/api/') and request.headers.get('x-kin-csrf') != '1':
            self.unexpected.append(f'{method} {path} without X-KIN-CSRF')
            route.abort()
            return
        if method == 'GET' and path == '/api/me':
            if self.bootstrap or not self.viewer_page and request.frame.page is not self.page:
                self.entry_reads.append(request.headers.get('x-kin-session'))
                route.fulfill(json={**self.me,'sessionId':'SYN-SESSION-'+self.me['sub']})
                return
            self.me_requests += 1
            if self.hold_me:
                self.held_me.append(route)
            elif self.me_status == 'abort':
                route.abort()
            elif self.me_status == 'bad-json':
                route.fulfill(status=200, body='<html>SYN not JSON</html>', content_type='text/html; charset=utf-8')
            elif self.me_status:
                route.fulfill(status=self.me_status, json={'statusCode': self.me_status, 'message': 'SYN unavailable'})
            else:
                route.fulfill(json={**self.me, 'sessionId': 'SYN-SESSION-' + str(self.me.get('sub'))})
            return
        if method == 'GET' and path == '/api/clinician/studies':
            query = parse_qs(url.query, keep_blank_values=True)
            if query != {'limit': ['100']}:
                self.unexpected.append(f'{method} {request.url}')
                route.abort()
                return
            rows = sorted(self.rows, key=lambda row: row['uid'])
            route.fulfill(json={'studies': copy.deepcopy(rows), 'serverTime': '2026-09-26T00:00:00.000Z', 'pagination': {'next': None, 'total': len(rows), 'offset': 0, 'limit': 100}})
            return
        found = re.fullmatch('/api/clinician/studies/([^/]+)/report', path)
        if method == 'GET' and found and (not url.query):
            target = unquote(found.group(1))
            row = next((row for row in self.rows if row['uid'] == target), None)
            if row is None:
                self.unexpected.append(f'{method} {request.url}')
                route.abort()
                return
            route.fulfill(json=report_of(row))
            return
        found = re.fullmatch('/api/studies/([^/]+)/viewer-items', path)
        if method == 'GET' and found:
            self.viewer_items(route, unquote(found.group(1)), parse_qs(url.query, keep_blank_values=True))
            return
        found = re.fullmatch('/api/studies/([^/]+)/(viewer-jobs|findings)', path)
        if method == 'GET' and found and self.real_api:
            kind = found.group(2)
            self.module_requests.append((kind, unquote(found.group(1)), parse_qs(url.query, keep_blank_values=True)))
            status = self.module_status.get(kind)
            if status:
                route.fulfill(status=status, json={'statusCode': status, 'message': 'SYN refused'})
            elif kind == 'viewer-jobs':
                route.fulfill(json={'jobs': []})
            else:
                route.fulfill(status=200, headers={'content-type': 'application/json', 'X-KIN-Finding-Schema': '2'}, body='{"items":[],"nextCursor":null}')
            return
        if method == 'GET' and path == '/api/syn-note' and self.real_api:
            self.module_requests.append(('note', None, {}))
            route.fulfill(json={'ok': True})
            return
        found = re.fullmatch('/api/studies/([^/]+)/viewer-items(/[^?]*)?', path)
        if method == 'POST' and found and self.accept_writes:
            self.writes.append((unquote(found.group(1)), found.group(2) or ''))
            self.held_writes.append(route)
            return
        if method == 'GET' and path == '/api/critical-results' and (parse_qs(url.query, keep_blank_values=True) == {'view': ['received'], 'state': ['pending']}):
            account = self.me if isinstance(self.me, dict) else {}
            self.inbox_reads.append(request.url)
            route.fulfill(json={'owner': [account.get('institution'), account.get('sub')], 'view': 'received', 'items': [], 'nextCursor': None, 'pending': 0})
            return
        self.unexpected.append(f'{method} {request.url}')
        route.abort()

    def clinician_session(self, account=None):
        app = [role for role in (account or self.me)['roles'] if role in ('radiologist', 'technician', 'admin', 'clinician')]
        return bool(app) and all((role == 'clinician' for role in app))

    def viewer_items(self, route, target, query):
        self.item_requests.append((target, query))
        if set(query) - {'limit', 'cursor', 'includeHidden', 'recheck'}:
            self.unexpected.append(f'viewer-items query {query}')
            route.abort()
            return
        account = self.list_me or self.me
        if not self.clinician_session(account):
            if query == {'limit': ['1']}:
                route.fulfill(json={'items': [], 'nextCursor': None})
                return
            if self.real_api and target == VP and (query == {'limit': ['100']}):
                route.fulfill(json={'items': [], 'nextCursor': None})
                return
            first = {'includeHidden': ['true'], 'limit': ['100']}
            following = {**first, 'cursor': [WRITER_CURSOR]}
            if query != first and (not (self.writer_paged and query == following)):
                self.unexpected.append(f'writer viewer-items query {query}')
                route.abort()
                return
            if (target, 'first' if query == first else 'next') in self.hold_writer:
                self.held_writer.append((target, 'first' if query == first else 'next', route))
                return
            head = copy.deepcopy(WRITER_HEAD if query == first else WRITER_HEAD_2)
            head['authorSub'] = account['sub']
            route.fulfill(json={'items': [head], 'nextCursor': WRITER_CURSOR if self.writer_paged and query == first else None})
            return
        if 'includeHidden' in query and query['includeHidden'] != ['false'] or ('cursor' in query and 'recheck' in query):
            route.fulfill(status=HIDDEN_REFUSED[0], json=HIDDEN_REFUSED[1])
            return
        if query.get('limit') not in (['100'], ['1']):
            self.unexpected.append(f'clinician viewer-items limit {query}')
            route.abort()
            return
        if query.get('limit') == ['100'] and 'cursor' not in query and (target in self.hold_items):
            self.held_items.append((target, route))
            return
        if query.get('limit') == ['100'] and 'cursor' in query and (target in self.hold_next):
            self.held_next.append((target, query['cursor'][0], route))
            return
        if query.get('limit') == ['1'] and target in self.hold_probes:
            self.hold_probes.discard(target)
            self.held_probes.append((target, route))
            return
        route.fulfill(**self.clinician_page(target, query.get('cursor', [None])[0], issue=query.get('limit') == ['100']))

    def clinician_page(self, target, cursor, issue=True):
        spec = self.items.get(target, NOT_FOUND)
        if isinstance(spec, tuple):
            return {'status': spec[0], 'json': spec[1]}
        if spec == 'withheld':
            return {'json': {'uid': target, 'final': False, 'items': None, 'nextCursor': None}}
        index = 0
        if cursor is not None:
            if self.cursors.get(cursor, (None,))[0] != target:
                self.unexpected.append(f'unknown cursor {cursor!r} for {target}')
                return {'status': CHANGED[0], 'json': CHANGED[1]}
            index = self.cursors[cursor][1]
        pages = spec['pages']
        following = None
        if issue and index + 1 < len(pages):
            following = f'eyJ2IjoxLCJTWU4iOnsicGFnZSI6{index + 1}.SYN-sig_{target[-2:]}-{len(self.cursors)}_Q'
            self.cursors[following] = (target, index + 1)
        return {'json': {'uid': spec.get('answer_uid', target), 'final': True, 'reportVersion': spec.get('versions', {}).get(index, spec['version']), 'items': copy.deepcopy(pages[index]), 'nextCursor': following}}

    def wait_until(self, predicate, what, timeout=10.0):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail(f'{what}: not observed within {timeout:.0f}s')
            self.page.wait_for_timeout(10)

    def settle(self, page=None):
        (page or self.page).wait_for_timeout(300)

    def release(self, route, payload, status=200):
        request = route.request
        route.fulfill(status=status, json=payload)
        self.wait_until(lambda: any((item is request for item in self.finished)), 'the released answer reaching the page')
        self.settle()

    def open_home(self, script=None):
        if script is not None:
            self.files['clinician.js'] = script
        self.page.goto(ORIGIN + BASE + 'clinician.html')
        expect(self.page.locator('#list-state')).to_have_attribute('data-state', 'ready')
        expect(self.page.locator('#studies tr[data-uid]')).to_have_count(len(self.rows))

    def pick(self, u):
        self.page.locator(f'#studies tr[data-uid="{u}"]').click()
        expect(self.page.locator('#detail')).to_have_attribute('data-uid', u)
        expect(self.page.locator('#report-state')).not_to_have_attribute('data-state', 'loading')
        return self.page.evaluate(COMPARE_VIEW)

    def opened(self, count):
        self.wait_until(lambda: len(self.viewer_opens) >= count, f'viewer window request {count}')
        self.settle()
        self.assertEqual(count, len(self.viewer_opens), 'viewer window requests')
        return self.viewer_opens[-1]

    def open_viewer(self, config=None, study=VA, uncancellable=False, enter=None, before_boot=None):
        self.viewer_page = True
        self.config = CONFIG if config is None else config
        self.page.goto(VIEWER_URL)
        if uncancellable:
            self.page.evaluate('() => { const real = window.fetch.bind(window);\n              window.fetch = (url, options = {}) => { const { signal, ...rest } = options; return real(url, rest); }; }')
        self.bootstrap=True
        self.page.evaluate('kinCreateSessionBoundary().preRegistration()')
        self.bootstrap=False
        self.page.evaluate(END_REASONS)
        if uncancellable:
            self.page.evaluate('() => { const real = window.fetch.bind(window);\n              window.fetch = (url, options = {}) => { const { signal, ...rest } = options; return real(url, rest); }; }')
        if before_boot:
            self.page.evaluate(before_boot)
        self.page.evaluate('([study, enter]) => enter ? synBoot(study, enter) : synBoot(study)', [study, enter])
        self.observe_document()

    def panel(self):
        return self.page.evaluate(PANEL)

    def wait_panel(self, state, study):
        self.wait_until(lambda: (lambda p: (p['state'], p['uid']) == (state, study))(self.panel()), f'panel {state} for {study}')
        return self.panel()

    def reads(self):
        return [(target, query) for target, query in self.item_requests if query.get('limit') != ['1']]

    def note_state(self):
        return self.page.evaluate('() => window.kinViewerNoteConnectionState()')

    def modules_settled(self):
        self.wait_until(lambda: self.note_state() not in ('stopped', 'unconfirmed'), 'the module gate answer')
        self.settle()

    def layout(self):
        return self.page.evaluate("() => { const p = document.querySelector('#kin-viewer-layout');\n          return {summary: p.querySelector('summary').textContent,\n            buttons: [...p.querySelectorAll('button')].map(b => [b.textContent, b.disabled])}; }")

    def probes(self):
        return len([1 for _, query in self.item_requests if query.get('limit') == ['1']])

    def focus(self):
        self.page.evaluate('synFocus()')

    def session(self):
        return self.page.evaluate('() => kinViewerSession.state()')


    def release_me(self, answer):
        self.me, self.hold_me = (answer, False)
        held, self.held_me = (self.held_me, [])
        for route in held:
            route.fulfill(json=answer)

    def frameless(self, on):
        self.page.evaluate('on => { window.synFrameless = on; }', on)

    def open_state(self, state):
        self.fresh_page()
        if state == 'refused+late-writer':
            self.refusal_then_late_writers('panel', 403)
            self.settle()
            self.assertEqual('refused', self.session())
            return
        if state == 'refused+layout-account':
            held, _ = self.layout_sees_account_change('save', OTHER_WRITER)
            self.release(held, RADIOLOGIST)
            self.item_requests, self.cursors = ([], {})
            self.page.evaluate('() => { synMounted.length = 0; synStopped.length = 0; }')
            self.assertEqual('refused', self.session())
            return
        if state in ('ended+reenter', 'read-only+ended'):
            if state == 'ended+reenter':
                self.writer_document()
                self.me = OTHER_WRITER
                self.page.evaluate('synReenter()')
            else:
                self.read_only_document()
                self.page.evaluate(LOGOUT)
                self.wait_until(lambda: self.session() == 'refused', 'the logout broadcast')
                self.page.evaluate('synReenter()')
            self.wait_until(lambda: self.session() == 'refused', "the document's end")
            self.settle()
            self.item_requests, self.cursors = ([], {})
            self.page.evaluate('() => { synMounted.length = 0; synStopped.length = 0; }')
            self.me_status, self.writer_paged = (None, False)
            return
        if state == 'read-only+held':
            self.hold_writer_work()
            start = len(self.item_requests)
            self.to_clinician_only(LATER)
            self.wait_panel('ready', VA)
            self.modules_settled()
            self.item_requests = self.item_requests[start:]
            self.settle()
            self.assertEqual('read-only', self.session())
            return
        self.me = RADIOLOGIST if state == 'writer' else CLINICIAN
        self.me_status = {'unconfirmed': 503, 'refused': 403}.get(state)
        self.writer_paged = state == 'writer'
        self.item_requests, self.cursors, self.me_requests = ([], {}, 0)
        self.open_viewer()
        if state == 'writer':
            self.wait_until(lambda: len(self.panel()['rows']) == 2, "the writer list's two pages")
            self.wait_until(lambda: set(self.page.evaluate('synMounted')) == MODULES, 'every module mounted')
            self.wait_until(lambda: any((not disabled for _, disabled in self.layout()['buttons'])), 'the layout buttons')
        elif state == 'read-only':
            self.wait_panel('ready', VA)
            self.modules_settled()
        else:
            self.wait_until(lambda: self.me_requests >= 3, "the panel's, the module gate's and the layout panel's /me")
        self.settle()
        self.assertEqual(state, self.session())

    def observe(self, action):
        start = len(self.item_requests)
        self.page.evaluate(action)
        self.ticks()
        return self.item_requests[start:]

    def ticks(self, rounds=2, count=2):
        for _ in range(rounds):
            self.page.evaluate('n => synTick(n)', count)
            self.quiet()

    def quiet(self):
        begin = time.monotonic()
        while time.monotonic() - max(self.last_request, begin) < QUIET:
            self.page.wait_for_timeout(20)

    @staticmethod
    def kind(requests):
        kinds = {'check' if query.get('limit') == ['1'] else 'read-all' if query.get('includeHidden') == ['true'] else 'read' for _, query in requests}
        return '+'.join(sorted(kinds)) or 'none'

    def observe_writes(self, state):
        seen = self.page.evaluate(PROBE_WRITES, AUTHORING)
        sr = tuple(seen.pop('sr'))
        refusal = {'read-only': RO_SR, 'read-only+held': RO_SR, 'refused': ENDED, 'refused+late-writer': ENDED, 'refused+layout-account': ENDED, 'ended+reenter': ENDED, 'read-only+ended': ENDED}.get(state, UNCONFIRMED_SR)
        seen['sr_commands'] = {(f'refused: {WRITER_SR}',) * 2: True, (f'refused: {refusal}',) * 2: False}.get(sr, f'unexpected {sr}')
        buttons, mounted = (set(self.panel()['buttons']), set(self.page.evaluate('synMounted')))
        seen['panel_controls'] = bool(buttons & {'Download SR', 'Store SR', 'Length', 'Angle', 'Ellipse ROI', 'Add Key Image'})
        seen['row_controls'] = bool(buttons & {'Edit', 'Save', 'Hide', 'Restore', 'History', 'Recheck Source'})
        seen.update(findings='findings' in mounted, jobs='jobs' in mounted, tech_note=self.note_state() == 'ready', layout_account='hanging-protocol' in mounted or any((not disabled for _, disabled in self.layout()['buttons'])))
        seen['marks_present'] = bool(self.page.evaluate('synMarks()'))
        stray = self.page.evaluate("synRawMark('Bidirectional')")
        self.settle()
        seen['stray_mark_kept'] = self.page.evaluate('uid => synHas(uid)', stray)
        return seen

    def observe_list(self):
        self.page.evaluate(NAVIGABLE, [SERIES, SOP])
        outcome = self.page.evaluate(NAVIGATE, [VA, SERIES, SOP, None])
        return {'list_mark': ['Length', 'SYN-A length', True] in self.page.evaluate('synDrawn()'), 'go_to_image': outcome.get('ok') is True}

    def observe_rechecks(self, state):
        initial = list(self.item_requests)
        handed = [WRITER_CURSOR] if state == 'writer' else list(self.cursors)
        continued = [query['cursor'][0] for _, query in initial if 'cursor' in query]
        asked = self.me_requests
        seen = {'initial_read': self.kind([r for r in initial if r[1].get('limit') != ['1']]), 'page_continuation': 'none' if not continued else 'cursor' if continued == handed else f'unexpected {continued}', 'focus': self.kind(self.observe('synFocus()')), 'me_on_focus': self.me_requests > asked, 'periodic': self.kind(self.observe('synAdvance(16000)')), 'frame_lost': self.kind(self.observe('window.synFrameless = true')), 'frame_return': self.kind(self.observe('window.synFrameless = false'))}
        self.observe('window.synFrameless = true')
        seen['frameless_focus'] = self.kind(self.observe('synFocus()'))
        seen['study_change'] = self.kind([r for r in self.observe(f"window.synFrameless = false, synSwitch('{VP}')") if r[0] == VP])
        return seen

    def test_01_open_viewer_and_compare_use_one_named_window_with_the_opener_cut(self):
        self.open_home()
        expect(self.page.locator('#open-viewer')).to_be_disabled()
        seen = self.pick(A)
        self.assertTrue(seen['enabled'])
        with self.page.expect_popup() as info:
            self.page.locator('#open-viewer').click()
        popup = info.value
        self.assertEqual({'StudyInstanceUIDs': [A]}, self.opened(1))
        popup.wait_for_url(f'{ORIGIN}/ohif/viewer?StudyInstanceUIDs={A}')
        popup.wait_for_function('window.verified===true')
        self.assertEqual([None],self.entry_reads)
        self.assertEqual('SYN-SESSION-'+CLINICIAN['sub'],popup.evaluate('KinWorkContext.session()'))
        self.assertEqual([VIEWER_WINDOW, True], popup.evaluate('() => [window.name, window.opener === null]'))
        self.assertEqual(VIEWER_ASKED, self.page.locator('#viewer-note').text_content())
        self.page.locator(f'#compare-list li[data-uid="{P1}"] button').click()
        self.assertEqual({'StudyInstanceUIDs': [f'{A},{P1}'], 'hangingProtocolId': ['@ohif/hpCompare']}, self.opened(2))
        popup.wait_for_url(f'{ORIGIN}/ohif/viewer?StudyInstanceUIDs={A},{P1}&hangingProtocolId=@ohif/hpCompare')
        self.assertEqual(2, len(self.context.pages), 'one viewer window, reused')
        self.assertEqual(COMPARE_ASKED, self.page.locator('#viewer-note').text_content())
        self.pick(BAD)
        self.page.locator('#open-viewer').click()
        self.settle()
        self.assertEqual(BAD_UID, self.page.locator('#viewer-note').text_content())
        self.page.evaluate('() => { window.open = () => null; }')
        self.pick(A)
        self.page.locator('#open-viewer').click()
        self.assertEqual(BLOCKED, self.page.locator('#viewer-note').text_content())
        self.page.locator(f'#compare-list li[data-uid="{P2}"] button').click()
        self.assertEqual(BLOCKED, self.page.locator('#viewer-note').text_content())
        self.settle()
        self.assertEqual(2, len(self.viewer_opens))

    def test_02_candidates_are_the_same_server_patient_key_only(self):
        self.open_home()
        seen = self.pick(A)
        self.assertEqual({'note': VIEWER, 'section': A, 'candidates': [P1, P2], 'enabled': True}, seen)
        parts = self.page.evaluate("() => [...document.querySelectorAll('#compare-list li')].map(li =>\n          [li.querySelector('span:not(.status)').textContent, li.querySelector('.status').textContent,\n           li.querySelector('button').textContent, li.querySelector('p').textContent])")
        self.assertEqual([[f'2025-01-01 · CT · {HOSTILE}', 'Awaiting Report', 'Compare', 'SYN KIM · SYN-P-100 · SYN Hospital A'], ['2024-01-01 · MR · SYN DESC 13', 'Awaiting Report', 'Compare', 'SYN KIM (EDITED) · SYN-P-100-EDIT · SYN Hospital A']], parts)
        self.assertIsNone(self.page.evaluate('() => document.body.dataset.pwned ?? null'))
        self.assertEqual([A, P2], self.pick(P1)['candidates'])
        for lone in (N, O, T, B, BAD):
            with self.subTest(study=lone):
                self.assertEqual({'note': f'{VIEWER} {NONE}', 'section': None, 'candidates': [], 'enabled': True}, self.pick(lone))
        self.assertEqual({'note': f'{VIEWER} {NO_KEY}', 'section': None, 'candidates': [], 'enabled': True}, self.pick(K))

    def test_03_a_b_a_and_refresh_keep_candidates_to_the_selected_study(self):
        for name in ('shipped',):
            with self.subTest(file=name):
                self.rows = copy.deepcopy(ROWS)
                self.viewer_opens = []
                self.open_home(SHIPPED['clinician.js'])
                self.assertEqual([P1, P2], self.pick(A)['candidates'])
                self.page.evaluate(f'''() => {{ window.synStale = document.querySelector('#compare-list li[data-uid="{P2}"] button'); }}''')
                self.assertEqual({'note': f'{VIEWER} {NONE}', 'section': None, 'candidates': [], 'enabled': True}, self.pick(B))
                self.assertEqual({'note': VIEWER, 'section': A, 'candidates': [P1, P2], 'enabled': True}, self.pick(A))
                next((row for row in self.rows if row['uid'] == P2))['sourcePatientKey'] = patient(INST_A, 'SYN-P-999')
                self.page.locator('#refresh').click()
                self.wait_until(lambda: self.page.evaluate(COMPARE_VIEW)['candidates'] == [P1], 'A read again from the new list')
                expect(self.page.locator('#report-state')).to_have_attribute('data-state', 'final')
                self.assertEqual({'note': VIEWER, 'section': A, 'candidates': [P1], 'enabled': True}, self.page.evaluate(COMPARE_VIEW))
                self.assertFalse(self.page.evaluate('() => window.synStale.isConnected'))
                self.page.evaluate('() => window.synStale.click()')
                self.settle()
                self.assertEqual([], self.viewer_opens, 'a stale Compare opens nothing')
                self.assertEqual(GONE, self.page.locator('#viewer-note').text_content())
                for page in self.context.pages[1:]:
                    page.close()

    def test_04_wording_font_targets_and_keyboard(self):
        self.open_home()
        self.pick(A)
        labels = self.page.evaluate("() => ({buttons: [...document.querySelectorAll('#viewer-slot button, #compare button')]\n          .map(b => b.textContent), headings: [...document.querySelectorAll('#compare h3')].map(h => h.textContent)})")
        self.assertEqual({'buttons': ['Open Viewer', 'Compare', 'Compare'], 'headings': ['Comparison']}, labels)
        for text in labels['buttons'] + labels['headings']:
            self.assertFalse(has_hangul(text), text)
        explanations = [self.page.locator('#viewer-note').text_content(), self.page.locator('#compare > p.muted').text_content()]
        for text in explanations:
            self.assertTrue(has_hangul(text), text)
        states = [self.page.evaluate("() => [...document.querySelectorAll('#viewer-slot, #viewer-slot *, #compare, #compare *')]\n          .filter(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()))\n          .map(e => ({text: e.textContent, size: parseFloat(getComputedStyle(e).fontSize)}))")]
        for message in (NONE, NO_KEY, BLOCKED, BAD_UID, GONE, VIEWER_ASKED, COMPARE_ASKED):
            states.append([{'text': message, 'size': None}])
        for texts in states:
            for item in texts:
                with self.subTest(text=item['text'][:60]):
                    self.assertIsNone(AVOIDED.search(item['text']))
                    if item['size'] is not None:
                        self.assertGreaterEqual(item['size'], 12)
        targets = self.page.evaluate("() => [...document.querySelectorAll('#viewer-slot button, #compare button')]\n          .map(b => { const r = b.getBoundingClientRect(); return [b.textContent, r.width, r.height]; })")
        for text, width, height in targets:
            self.assertGreaterEqual(min(width, height), 24, text)
        self.page.locator(f'#compare-list li[data-uid="{P2}"] button').focus()
        with self.page.expect_popup():
            self.page.keyboard.press('Enter')
        self.assertEqual({'StudyInstanceUIDs': [f'{A},{P2}'], 'hangingProtocolId': ['@ohif/hpCompare']}, self.opened(1))
        self.assertEqual('polite', self.page.locator('#viewer-note').get_attribute('aria-live'))

    def test_05_clinician_viewer_offers_no_create_link_or_save_control(self):
        self.open_viewer()
        seen = self.wait_panel('ready', VA)
        self.assertEqual('확정 판독문 r4의 저장 항목 4개 · 읽기 전용', seen['status'])
        self.assertEqual(['Refresh', 'Go to Image', 'Go to Image', 'Go to Image', 'Go to Image'], seen['buttons'])
        self.assertEqual(([], 0, [RO_NOTE]), (seen['links'], seen['inputs'], seen['notes']))
        self.assertEqual([['Key Image · Saved r1', 'Read-only', 'SYN-A key', 'SYN-A key note', '프레임 1', 'Go to Image'], ['Length · Saved r2', 'Read-only', 'SYN-A length', '프레임 1', 'Go to Image'], ['Angle · Saved r1', 'Read-only', 'SYN-A angle', '프레임 1', UNVERIFIED, 'Go to Image'], ['Arrow · Saved r1', 'Read-only', 'SYN-A arrow', '프레임 2', 'Go to Image']], seen['rows'])
        self.assertEqual([['Length', 'SYN-A length', True]], self.page.evaluate('synDrawn()'))
        cursor = next(iter(self.cursors))
        self.assertEqual([(VA, {'limit': ['100']}), (VA, {'limit': ['100'], 'cursor': [cursor]})], self.reads())
        for _, query in self.item_requests:
            self.assertNotIn('includeHidden', query)
            self.assertNotIn('recheck', query)
        self.assertEqual('undefined', self.page.evaluate('synAddLength()'))
        self.assertEqual(RO_TOOL, self.panel()['status'])
        self.assertEqual([f'refused: {RO_SR}'] * 2, [self.page.evaluate('name => synSR(name)', name) for name in ('storeMeasurements', 'downloadReport')])
        self.assertEqual([], self.page.evaluate('synNative'))
        self.assertEqual([RO_SR, RO_SR], self.page.evaluate('synNotices'))
        self.modules_settled()
        self.wait_until(lambda: self.page.evaluate(LAYOUT)['summary'] == 'Viewer Status', "the layout panel's account")
        self.assertEqual('read-only', self.page.evaluate('kinViewerNoteConnectionState()'))
        self.assertEqual([], self.page.evaluate('synMounted'))
        self.assertEqual({'summary': 'Viewer Status', 'buttons': [], 'note': '읽기 전용 화면입니다. 배치 저장·복원과 Hanging Protocol은 제공하지 않습니다. 화면 배치는 뷰어의 기본 레이아웃 도구로 바꿀 수 있습니다.'}, self.page.evaluate(LAYOUT))
        self.assertEqual(0, self.page.locator('[data-syn-module]').count())
        for text in [seen['status'], RO_NOTE, RO_TOOL, RO_SR, RO_WITHHELD, RO_DENIED, *sum(seen['rows'], [])]:
            self.assertIsNone(AVOIDED.search(text), text)

    def test_05b_writer_sessions_unanswered_me_and_controls(self):
        for session in (RADIOLOGIST, MIXED):
            with self.subTest(session=session['roles']):
                self.me = session
                self.item_requests, self.cursors = ([], {})
                self.open_viewer()
                self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'writer panel')
                self.wait_until(lambda: set(self.page.evaluate('synMounted')) == MODULES, 'every module mounted')
                seen = self.panel()
                self.assertTrue({'Download SR', 'Store SR', 'Length', 'Angle', 'Ellipse ROI', 'Add Key Image', 'Edit', 'Hide', 'History'} <= set(seen['buttons']), seen['buttons'])
                self.assertEqual(4, len(self.page.evaluate('synMounted')))
                self.assertEqual([(VA, {'includeHidden': ['true'], 'limit': ['100']})], self.reads())
                self.page.evaluate('synAddLength()')
                self.assertNotEqual(RO_TOOL, self.panel()['status'])
        self.me, self.me_status, self.item_requests, self.me_requests = (CLINICIAN, 500, [], 0)
        self.open_viewer()
        self.wait_until(lambda: self.me_requests >= 3, "the panel's, the module gate's and the layout panel's /me")
        self.settle()
        self.assertEqual([], self.page.evaluate('synMounted'))
        self.assertEqual('unconfirmed', self.note_state())
        self.assertEqual([], self.panel()['buttons'])
        self.assertEqual([], self.reads())
        self.assertTrue(all((disabled for _, disabled in self.layout()['buttons'])), self.layout())
        self.me, self.me_status = (CLINICIAN, None)

    def test_06_states_loading_empty_withheld_failed_and_denied(self):
        self.hold_items = {VA}
        self.open_viewer()
        self.wait_until(lambda: self.held_items, 'the held first read')
        seen = self.panel()
        self.assertEqual(('loading', LOADING, ['Refresh'], []), (seen['state'], seen['status'], seen['buttons'], seen['rows']))
        self.hold_items = set()
        self.release(self.held_items.pop()[1], {'uid': VA, 'final': True, 'reportVersion': 4, 'items': [], 'nextCursor': None})
        self.assertEqual('empty', self.panel()['state'])
        cases = [(VE, 'empty', '확정 판독문 r3에 저장된 측정·키 이미지가 없습니다 · 읽기 전용', ['Refresh']), (VW, 'withheld', RO_WITHHELD, ['Refresh']), (VX, 'failed', '저장 항목을 불러오지 못했습니다. 검사를 찾을 수 없습니다 (HTTP 404) Refresh로 다시 읽으세요.', ['Refresh']), (VY, 'failed', '저장 항목을 불러오지 못했습니다. 판독 상태가 바뀌었습니다. 새로고침하세요. (HTTP 409 · VIEWER_REPORT_CHANGED) Refresh로 다시 읽으세요.', ['Refresh']), (VO, 'failed', '저장 항목을 불러오지 못했습니다. 응답 형식을 확인할 수 없습니다. Refresh로 다시 읽으세요.', ['Refresh']), (VQ, 'failed', '저장 항목을 불러오지 못했습니다. 응답 형식을 확인할 수 없습니다. Refresh로 다시 읽으세요.', ['Refresh']), (VZ, 'denied', RO_DENIED, ['Recheck Access'])]
        for target, state, status, buttons in cases:
            with self.subTest(study=target, state=state):
                self.page.evaluate('study => synSwitch(study)', target)
                self.wait_panel(state, target)
                self.settle()
                seen = self.panel()
                self.assertEqual((state, status, buttons, []), (seen['state'], seen['status'], seen['buttons'], seen['rows']))
        self.assertEqual(2, len([1 for target, _ in self.reads() if target == VQ]))
        self.items[VE] = HIDDEN_REFUSED
        self.page.evaluate('study => synSwitch(study)', VE)
        self.wait_panel('failed', VE)
        self.assertEqual('저장 항목을 불러오지 못했습니다. 숨긴 표시 항목이나 형식이 잘못된 이어받기 값으로는 조회할 수 없습니다 (HTTP 400) Refresh로 다시 읽으세요.', self.panel()['status'])
        self.items[VE] = {'version': 3, 'pages': [[key_item(51, 'SYN-E key')]]}
        self.page.get_by_role('button', name='Refresh', exact=True).click()
        seen = self.wait_panel('ready', VE)
        self.assertEqual([['Key Image · Saved r1', 'Read-only', 'SYN-E key', '프레임 1', 'Go to Image']], seen['rows'])
        self.item_requests, self.cursors = ([], {})

    def test_07_a_b_a_across_the_comparison_study(self):
        old = {'uid': VA, 'final': True, 'reportVersion': 4, 'items': [key_item(61, 'SYN-A-OLD')], 'nextCursor': None}
        for name in ('shipped',):
            with self.subTest(file=name):
                self.item_requests, self.cursors, self.held_items = ([], {}, [])
                self.hold_items = {VA}
                self.open_viewer(CONFIG, uncancellable=True)
                self.wait_until(lambda: len(self.held_items) == 1, "A's first read held")
                first = self.held_items[0][1]
                self.page.evaluate('study => synSwitch(study)', VP)
                seen = self.wait_panel('ready', VP)
                self.assertEqual([['Key Image · Saved r1', 'Read-only', 'SYN-P key', '프레임 1', 'Go to Image']], seen['rows'])
                self.page.evaluate('study => synSwitch(study)', VA)
                self.wait_until(lambda: len(self.held_items) == 2, "A's second read held")
                second = self.held_items[1][1]
                self.release(first, old)
                seen = self.panel()
                self.assertEqual(('loading', LOADING, []), (seen['state'], seen['status'], seen['rows']), "A's late first answer does not paint while its newer read is pending")
                self.hold_items = set()
                self.release(second, self.clinician_page(VA, None)['json'])
                seen = self.wait_panel('ready', VA)
                self.assertEqual(['SYN-A key', 'SYN-A length', 'SYN-A angle', 'SYN-A arrow'], [row[2] for row in seen['rows']])
                self.assertNotIn('SYN-A-OLD', str(seen))
                self.assertNotIn('SYN-P', str(seen))

    def attempt_every_authoring_tool(self):
        outcomes = {}
        for name in AUTHORING:
            outcomes[name] = self.page.evaluate("name => {\n              const drag = () => [synDraw('default'), synDraw('mpr')];\n              const seen = { click: synClick(name) }; seen.afterClick = drag();\n              synRun('setToolActiveToolbar', { itemId: name, toolGroupIds: ['default', 'mpr', 'SRToolGroup', 'volume3d'] }); seen.toolbar = drag();\n              synRun('setToolActive', { toolName: name }); seen.hotkey = drag();\n              synGroup('default').setToolActive(name, { bindings: [{ mouseButton: 1 }] }); seen.group = drag();\n              synGroup('default').setToolPassive(name); seen.passive = synModes('default')[name];\n              return seen; }", name)
        return outcomes

    def test_08_native_authoring_paths_are_closed_for_a_clinician(self):
        self.open_viewer()
        self.wait_panel('ready', VA)
        self.wait_until(lambda: self.page.evaluate('synToolbar()')['primary'] == VIEW_SECTION, 'the trimmed toolbar')
        bar = self.page.evaluate('synToolbar()')
        self.assertEqual((VIEW_SECTION, VIEW_MORE, 'Reset'), (bar['primary'], bar['more'], bar['morePrimary']))
        self.assertNotIn('MeasurementTools', bar['buttons'])
        self.assertNotIn('Capture', bar['buttons'])
        self.assertEqual(['missing', []], self.page.evaluate("[synClick('Capture'), synNative.filter(x => x === 'view showDownloadViewportModal')]"))
        for group in ALL_GROUPS:
            with self.subTest(group=group):
                modes = self.page.evaluate('id => synModes(id)', group)
                self.assertEqual({}, {n: m for n, m in modes.items() if m in ('Active', 'Passive') and n not in VIEWING})
        self.assertEqual(['view WindowLevel', 'view WindowLevel'], self.page.evaluate("[synDraw('default'), synDraw('mpr')]"))
        for name, seen in self.attempt_every_authoring_tool().items():
            with self.subTest(tool=name):
                view = ['view WindowLevel', 'view WindowLevel']
                self.assertEqual({'click': 'missing', 'afterClick': view, 'toolbar': view, 'hotkey': view, 'group': view}, {k: v for k, v in seen.items() if k != 'passive'})
                self.assertIn(seen['passive'], ('Enabled', 'Disabled'))
        self.assertEqual(RO_TOOL, self.panel()['status'])
        self.assertEqual(['ran', 'view Zoom', 'ran', 'view StackScroll', 'ran', 'view Crosshairs', 'ran'], self.page.evaluate("() => [synClick('Zoom'), synDraw('default'), synClick('StackScroll'), synDraw('default'), synClick('Crosshairs'),\n                     synDraw('mpr'), synClick('Reset')]"))
        self.page.evaluate("synRun('setToolActive', { toolName: 'WindowLevel' })")
        late = self.page.evaluate("() => { synServices.toolGroupService.createToolGroupAndAddTools('syn-late', {\n            active: [{ toolName: 'WindowLevel', bindings: [{ mouseButton: 1 }] }], passive: [{ toolName: 'Length' }, { toolName: 'ArrowAnnotate' }] });\n          synGroup('syn-late').setToolActive('ArrowAnnotate', { bindings: [{ mouseButton: 1 }] });\n          const created = [synModes('syn-late'), synDraw('syn-late')];\n          SynGroup.prototype.setToolActive.call(synGroup('default'), 'Bidirectional', { bindings: [{ mouseButton: 1 }] });\n          return [...created, synModes('default').Bidirectional, synDraw('default')]; }")
        self.assertEqual([{'WindowLevel': 'Active', 'Length': 'Enabled', 'ArrowAnnotate': 'Enabled'}, 'view WindowLevel', 'Enabled', 'view WindowLevel'], late)
        answers = self.page.evaluate("() => { const answers = [];\n          synRun('showCornerstoneContextMenu', { requireNearbyToolData: true, menuId: 'measurementsContextMenu' });\n          synRun('deleteMeasurement', { uid: 'syn-uid' }); synRun('setMeasurementLabel', { uid: 'syn-uid' });\n          synRun('updateMeasurement', { uid: 'syn-uid', textLabel: 'SYN' });\n          synRun('arrowTextCallback', { callback: text => answers.push(['new', text ?? null]) });\n          synRun('arrowTextCallback', { data: { uid: 'syn-uid' }, callback: text => answers.push(['edit', text ?? null]) });\n          const m = synServices.measurementService;\n          m.update('syn-uid', { label: 'SYN renamed' }, true); m.update('syn-uid', { label: 'synced' }, false); m.toggleLockMeasurement('syn-uid');\n          return answers; }")
        self.assertEqual([['new', None]], answers)
        self.assertEqual([['update', 'syn-uid', False]], self.page.evaluate('synEdits'))
        self.assertEqual(RO_EDIT, self.panel()['status'])
        self.assertEqual(['view resetViewport'], self.page.evaluate('synNative'))
        self.assertEqual([], self.page.evaluate('synMarks()'))
        self.assertEqual([['Length', 'SYN-A length', True]], self.page.evaluate('synDrawn()'))
        self.assertIsNone(AVOIDED.search(RO_EDIT))
        self.me, self.item_requests, self.cursors = (RADIOLOGIST, [], {})
        self.open_viewer()
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'writer panel')
        bar = self.page.evaluate('synToolbar()')
        self.assertEqual((PRIMARY_SECTION, MORE_TOOLS), (bar['primary'], bar['more']))
        self.assertEqual(['ran', 'mark ArrowAnnotate'], self.page.evaluate("[synClick('ArrowAnnotate'), synDraw('default')]"))
        self.page.evaluate("() => { synRun('showCornerstoneContextMenu', {}); synRun('setMeasurementLabel', { uid: 'syn-uid' });\n          synServices.measurementService.update('syn-uid', {}, true); }")
        self.assertEqual(['ArrowAnnotate'], self.page.evaluate('synMarks()'))
        self.assertEqual(['add ArrowAnnotate', 'menu', 'label syn-uid'], self.page.evaluate('synNative'))
        self.assertEqual('ran', self.page.evaluate("synClick('Capture')"), 'the writer keeps Capture')
        self.assertEqual('view showDownloadViewportModal', self.page.evaluate('synNative.at(-1)'))
        self.assertEqual([['update', 'syn-uid', True]], self.page.evaluate('synEdits'))
        self.page.evaluate('synClearMarks()')
        self.me, self.item_requests, self.cursors = (CLINICIAN, [], {})

    def test_09_module_gate_waits_for_a_confirmed_writer_and_keeps_clinician_only(self):
        for failure in (500, 503, 'abort', 'bad-json'):
            with self.subTest(every_me=failure):
                self.me, self.me_status, self.me_requests, self.item_requests = (CLINICIAN, failure, 0, [])
                self.open_viewer()
                self.wait_until(lambda: self.me_requests >= 3, 'every /me asked')
                self.settle()
                self.assertEqual(([], 'unconfirmed'), (self.page.evaluate('synMounted'), self.note_state()))
        for session, mounted, state in ((RADIOLOGIST, WRITE_MODULES, 'ready'), (CLINICIAN, set(), 'read-only')):
            with self.subTest(later=session['roles'][0]):
                self.me, self.me_status, self.me_requests, self.item_requests, self.cursors = (session, 503, 0, [], {})
                self.open_viewer()
                self.wait_until(lambda: self.me_requests >= 3, 'every /me asked')
                self.settle()
                self.assertEqual([], self.page.evaluate('synMounted'))
                self.me_status = None
                self.page.evaluate('study => synSwitch(study)', VP)
                self.wait_until(lambda: self.note_state() == state, f'the bridge {state}')
                self.settle()
                self.assertEqual(mounted, set(self.page.evaluate('synMounted')))
        for name, failures in (('shipped', (500, 503, 'abort', 'bad-json')),):
            for failure in failures:
                with self.subTest(file=name, gate=failure):
                    self.me, self.me_status, self.me_requests, self.item_requests, self.cursors = (CLINICIAN, None, 0, [], {})
                    self.open_viewer(CONFIG, enter=['kin.viewer-history'])
                    self.wait_panel('ready', VA)
                    self.me_status = failure
                    self.page.evaluate('ids => synEnter(ids)', LATER)
                    self.wait_until(lambda: self.note_state() == 'read-only', 'the bridge read-only')
                    self.wait_until(lambda: self.layout()['summary'] == 'Viewer Status', 'the layout panel status only')
                    self.settle()
                    self.assertEqual(([], []), (self.page.evaluate('synMounted'), self.layout()['buttons']))
        for name in ('shipped',):
            with self.subTest(reenter=name):
                self.me, self.me_status, self.me_requests, self.item_requests, self.cursors = (CLINICIAN, None, 0, [], {})
                self.open_viewer(CONFIG)
                self.wait_panel('ready', VA)
                self.modules_settled()
                self.me_status, self.me_requests = (503, 0)
                after = self.page.evaluate("() => { synReenter();\n                  return [synToolbar().primary, Object.entries(synModes('default')).filter(([n, m]) => ['Active', 'Passive'].includes(m)).map(([n]) => n).sort()]; }")
                self.assertEqual([VIEW_SECTION, ['Magnify', 'Pan', 'StackScroll', 'WindowLevel', 'Zoom']], after)
                self.wait_until(lambda: self.me_requests >= 2, "the re-entered panels' /me (the gate asks none)")
                self.settle()
                self.assertEqual(([], 'read-only'), (self.page.evaluate('synMounted'), self.note_state()))
                self.assertEqual(('Viewer Status', []), (self.layout()['summary'], self.layout()['buttons']))
                self.assertFalse(WRITER_CONTROLS & set(self.panel()['buttons']), self.panel()['buttons'])

    def test_10_periodic_and_focus_checks_follow_the_final_report(self):
        self.open_viewer()
        self.wait_panel('ready', VA)
        self.assertEqual([['Length', 'SYN-A length', True]], self.page.evaluate('synDrawn()'))
        self.items[VA] = 'withheld'
        self.focus()
        seen = self.wait_panel('withheld', VA)
        self.assertEqual((RO_WITHHELD, [], ['Refresh']), (seen['status'], seen['rows'], seen['buttons']))
        self.assertEqual([], self.page.evaluate('synDrawn()'))
        self.items[VA] = {'version': 5, 'pages': [[key_item(71, 'SYN-A r5 key')]]}
        self.focus()
        seen = self.wait_panel('ready', VA)
        self.assertEqual(('확정 판독문 r5의 저장 항목 1개 · 읽기 전용', [['Key Image · Saved r1', 'Read-only', 'SYN-A r5 key', '프레임 1', 'Go to Image']]), (seen['status'], seen['rows']))
        self.hold_items, self.items[VA] = ({VA}, {'version': 6, 'pages': [[key_item(72, 'SYN-A r6 key')]]})
        self.focus()
        self.wait_until(lambda: self.held_items, 'the r6 read held')
        seen = self.panel()
        self.assertEqual(('loading', []), (seen['state'], seen['rows']))
        self.hold_items = set()
        request = self.held_items[0][1].request
        self.held_items.pop()[1].fulfill(status=CHANGED[0], json=CHANGED[1])
        self.wait_until(lambda: any((item is request for item in self.finished)), 'the failed r6 read reaching the page')
        seen = self.wait_panel('failed', VA)
        self.assertEqual([], seen['rows'])
        self.assertEqual([], self.page.evaluate('synDrawn()'))
        self.items, self.item_requests, self.cursors = (copy.deepcopy(ITEMS), [], {})
        self.open_viewer(uncancellable=True)
        self.wait_panel('ready', VA)
        self.hold_probes = {VA}
        self.focus()
        self.wait_until(lambda: self.held_probes, "A's check held")
        self.page.evaluate('study => synSwitch(study)', VP)
        self.wait_panel('ready', VP)
        self.page.evaluate('study => synSwitch(study)', VA)
        self.wait_panel('ready', VA)
        self.release(self.held_probes.pop()[1], {'uid': VA, 'final': False, 'items': None, 'nextCursor': None})
        seen = self.panel()
        self.assertEqual(('ready', ['SYN-A key', 'SYN-A length', 'SYN-A angle', 'SYN-A arrow']), (seen['state'], [row[2] for row in seen['rows']]))
        self.items, self.item_requests, self.cursors = (copy.deepcopy(ITEMS), [], {})

    def authoring_closed(self, status, primary=VIEW_SECTION):
        bar = self.page.evaluate('synToolbar()')
        self.assertEqual((primary, VIEW_MORE), (bar['primary'], bar['more']))
        for group in ALL_GROUPS:
            modes = self.page.evaluate('id => synModes(id)', group)
            self.assertEqual({}, {n: m for n, m in modes.items() if m in ('Active', 'Passive') and n not in VIEWING}, group)
        view = ['view WindowLevel', 'view WindowLevel']
        for name, seen in self.attempt_every_authoring_tool().items():
            with self.subTest(tool=name):
                self.assertEqual({'click': 'missing', 'afterClick': view, 'toolbar': view, 'hotkey': view, 'group': view}, {k: v for k, v in seen.items() if k != 'passive'})
                self.assertIn(seen['passive'], ('Enabled', 'Disabled'))
        self.assertEqual(['false', 'false', 'false', 'undefined'], self.page.evaluate("[synAdd('Bidirectional'), synAdd('ArrowAnnotate'), synAdd('SplineROI'), synAddLength()]"))
        self.assertEqual(status, self.panel()['status'])
        self.assertEqual([], self.page.evaluate('synMarks()'))

    def test_11_authoring_waits_for_a_verified_writer(self):
            self.hold_me = True
            self.open_viewer()
            self.wait_until(lambda: len(self.held_me) >= 3, "the panel's, the module gate's and the layout panel's /me held")
            self.assertEqual('unconfirmed', self.session())
            self.authoring_closed(UNCONFIRMED_TOOL)
            self.assertEqual([f'refused: {UNCONFIRMED_SR}'] * 2, [self.page.evaluate('name => synSR(name)', name) for name in ('storeMeasurements', 'downloadReport')])
            self.assertEqual([['new', None]], self.page.evaluate(EDIT_ATTEMPTS))
            self.assertEqual(UNCONFIRMED_EDIT, self.panel()['status'])
            self.assertEqual(([], [['update', 'syn-uid', False]]), (self.page.evaluate('synNative'), self.page.evaluate('synEdits')))
            stray = self.page.evaluate("synRawMark('Bidirectional')")
            self.wait_until(lambda: not self.page.evaluate('uid => synHas(uid)', stray), 'the stray mark removed')
            self.release_me(CLINICIAN)
            self.wait_panel('ready', VA)
            self.assertEqual('read-only', self.session())
            self.assertEqual(([], [['Length', 'SYN-A length', True]]), (self.page.evaluate('synMarks()'), self.page.evaluate('synDrawn()')))
            self.assertEqual(['missing', 'view WindowLevel'], self.page.evaluate("[synClick('Bidirectional'), synDraw('default')]"))
            for text in (UNCONFIRMED_TOOL, UNCONFIRMED_EDIT, UNCONFIRMED_SR):
                self.assertIsNone(AVOIDED.search(text), text)
            for failure in (500, 503, 'abort', 'bad-json'):
                with self.subTest(every_me=failure):
                    self.me_status, self.me_requests, self.item_requests, self.cursors = (failure, 0, [], {})
                    self.open_viewer()
                    self.wait_until(lambda: self.me_requests >= 3, 'every /me asked')
                    self.settle()
                    self.assertEqual('unconfirmed', self.session())
                    self.assertEqual(VIEW_SECTION, self.page.evaluate('synToolbar()')['primary'])
                    self.assertEqual(['missing', 'view WindowLevel', 'view WindowLevel', 'view WindowLevel', 'view WindowLevel'], self.page.evaluate("() => { const seen = [synClick('Bidirectional'), synDraw('default')];\n                                   synRun('setToolActive', { toolName: 'ArrowAnnotate' }); seen.push(synDraw('default'));\n                                   synRun('setToolActiveToolbar', { itemId: 'EllipticalROI', toolGroupIds: ['default', 'mpr'] });\n                                   return [...seen, synDraw('default'), synDraw('mpr')]; }"))
                    self.assertEqual([], self.page.evaluate('synMarks()'))
            self.me, self.me_status, self.me_requests, self.item_requests, self.cursors = (RADIOLOGIST, 503, 0, [], {})
            self.open_viewer()
            self.wait_until(lambda: self.me_requests >= 3, 'every /me asked')
            self.settle()
            self.assertEqual(('unconfirmed', VIEW_SECTION), (self.session(), self.page.evaluate('synToolbar()')['primary']))
            self.me_status = None
            self.focus()
            self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'the writer panel after the focus retry')
            self.wait_until(lambda: set(self.page.evaluate('synMounted')) >= WRITE_MODULES, 'the write modules after the retry')
            self.assertEqual(('writer', PRIMARY_SECTION), (self.session(), self.page.evaluate('synToolbar()')['primary']))
            self.assertEqual(['ran', 'mark Bidirectional'], self.page.evaluate("[synClick('Bidirectional'), synDraw('default')]"))
            self.me = CLINICIAN
            self.me, self.item_requests, self.cursors = (RADIOLOGIST, [], {})
            self.open_viewer()
            self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'writer panel (no policy)')
            native_bar = self.page.evaluate('synToolbar()')
            native_modes = {group: self.page.evaluate('id => synModes(id)', group) for group in ALL_GROUPS}
            self.assertEqual((PRIMARY_SECTION, MORE_TOOLS), (native_bar['primary'], native_bar['more']))
            self.hold_me, self.me, self.item_requests, self.cursors = (True, CLINICIAN, [], {})
            self.open_viewer()
            self.wait_until(lambda: len(self.held_me) >= 3, 'every /me held')
            self.assertEqual(VIEW_SECTION, self.page.evaluate('synToolbar()')['primary'])
            self.release_me(RADIOLOGIST)
            self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'writer panel')
            self.assertEqual('writer', self.session())
            self.assertEqual(native_bar, self.page.evaluate('synToolbar()'))
            self.assertEqual(native_modes, {group: self.page.evaluate('id => synModes(id)', group) for group in ALL_GROUPS})
            self.assertEqual(['ran', 'mark Bidirectional', 'true'], self.page.evaluate("[synClick('Bidirectional'), synDraw('default'), synAdd('ArrowAnnotate')]"))
            stray = self.page.evaluate("synRawMark('CircleROI')")
            self.settle()
            self.assertTrue(self.page.evaluate('uid => synHas(uid)', stray), "a writer's local mark stays")
            self.wait_until(lambda: set(self.page.evaluate('synMounted')) >= WRITE_MODULES, 'the write modules mounted')
            self.me_status = 403
            self.focus();self.settle()
            self.assertFalse(self.page.evaluate('KinViewerSessionBoundary.ended()'))
            self.server_end();self.assert_closed()

    def test_12_final_list_is_rechecked_without_a_source_frame(self):
        self.open_viewer()
        ready = self.wait_panel('ready', VA)['status']
        before = self.probes()
        self.frameless(True)
        self.wait_until(lambda: self.panel()['frame'] == 'unmatched', 'the list marked unmatched')
        self.settle()
        seen = self.panel()
        self.assertEqual(('ready', 4, f'{ready} · {RO_UNMATCHED}'), (seen['state'], len(seen['rows']), seen['status']))
        self.assertEqual(before, self.probes())
        self.items[VA] = 'withheld'
        self.focus()
        seen = self.wait_panel('withheld', VA)
        self.assertEqual(([], f'{RO_WITHHELD} · {RO_UNMATCHED}', 'unmatched'), (seen['rows'], seen['status'], seen['frame']))
        self.assertEqual([], self.page.evaluate('synDrawn()'))
        self.items[VA] = {'version': 5, 'pages': [[key_item(71, 'SYN-A r5 key')], [mark_item(72, 'length', 'SYN-A r5 length')]]}
        reads = len(self.reads())
        self.page.evaluate('synAdvance(16000)')
        seen = self.wait_panel('ready', VA)
        cursor = list(self.cursors)[-1]
        self.assertEqual([(VA, {'limit': ['100']}), (VA, {'limit': ['100'], 'cursor': [cursor]})], self.reads()[reads:])
        self.assertEqual((['SYN-A r5 key', 'SYN-A r5 length'], 'unmatched', []), ([row[2] for row in seen['rows']], seen['frame'], self.page.evaluate('synDrawn()')))
        before = self.probes()
        self.frameless(False)
        self.wait_until(lambda: self.probes() > before and self.panel()['frame'] is None, "the check on the frame's return")
        self.settle()
        seen = self.panel()
        self.assertEqual(('ready', '확정 판독문 r5의 저장 항목 2개 · 읽기 전용'), (seen['state'], seen['status']))
        self.assertEqual([['Length', 'SYN-A r5 length', True]], self.page.evaluate('synDrawn()'))
        self.assertIsNone(AVOIDED.search(RO_UNMATCHED))
        self.items, self.item_requests, self.cursors = (copy.deepcopy(ITEMS), [], {})
        self.open_viewer(uncancellable=True)
        self.wait_panel('ready', VA)
        self.frameless(True)
        self.wait_until(lambda: self.panel()['frame'] == 'unmatched', 'A unmatched')
        self.hold_probes = {VA}
        self.focus()
        self.wait_until(lambda: self.held_probes, "A's frameless check held")
        self.page.evaluate(f"() => {{ window.synFrameless = false; synSwitch('{VP}'); }}")
        self.wait_panel('ready', VP)
        self.page.evaluate('study => synSwitch(study)', VA)
        self.wait_panel('ready', VA)
        self.release(self.held_probes.pop()[1], {'uid': VA, 'final': False, 'items': None, 'nextCursor': None})
        seen = self.panel()
        self.assertEqual(('ready', None, ['SYN-A key', 'SYN-A length', 'SYN-A angle', 'SYN-A arrow']), (seen['state'], seen['frame'], [row[2] for row in seen['rows']]))
        self.items, self.item_requests, self.cursors = (copy.deepcopy(ITEMS), [], {})

    def test_13_viewer_state_matrix(self):
        for state in ('unconfirmed','read-only','writer','read-only+held'):
            with self.subTest(state=state):
                self.open_state(state)
                seen=self.observe_list();seen.update(self.observe_writes(state));seen.update(self.observe_rechecks(state))
                self.assertEqual(set(VIEWER_STATE_MATRIX),set(seen))
                for row,expected in VIEWER_STATE_MATRIX.items():
                    with self.subTest(row=row):self.assertEqual(expected[STATES.index(state)],seen[row])
        # The five old refused/end rows now share the document boundary: neither viewing,
        # capture nor authoring can survive a real session end, including late writer answers.
        for role in (CLINICIAN,RADIOLOGIST):
            for status,code in ((401,'AUTH_SESSION_ENDED'),(403,'AUTH_SESSION_MISMATCH'),(409,'AUTH_SESSION_MISMATCH')):
                with self.subTest(role=role['user'],code=code,status=status):
                    self.fresh_page();self.me=role;self.me_status=None;self.hold_me=False;self.writer_paged=False
                    self.open_viewer();self.settle();self.server_end(status,code);self.assert_closed()

    def writer_open(self, config=None, hold=(), paged=False):
        self.me, self.me_status, self.list_me, self.writer_paged, self.hold_me, self.held_me = (MIXED, None, None, paged, False, [])
        self.hold_writer, self.held_writer, self.hold_items, self.held_items = (set(hold), [], set(), [])
        self.hold_next, self.held_next, self.accept_writes, self.held_writes, self.writes = (set(), [], False, [], [])
        self.items, self.item_requests, self.cursors, self.me_requests = (copy.deepcopy(ITEMS), [], {}, 0)
        self.open_viewer(config, uncancellable=True, enter=[HISTORY])

    def to_clinician_only(self, ids=None, hold_final=False):
        self.hold_writer, self.me = (set(), MIXED_NOW_CLINICIAN)
        if hold_final:
            self.hold_items = {VA}
        self.page.evaluate('ids => synEnter(ids)', ids or OTHER)
        self.wait_until(lambda: self.session() == 'read-only', 'the clinician-only answer')

    def snapshot(self):
        seen = self.panel()
        return (seen['state'], seen['rows'], self.page.evaluate('synDrawn()'))

    def labels(self):
        return [row[2] for row in self.panel()['rows']]

    def first_reads(self, start):
        return '+'.join((self.kind([request]) for request in self.item_requests[start:] if request[1].get('limit') != ['1'] and 'cursor' not in request[1])) or 'none'

    @staticmethod
    def change_effect(before, after):
        if after[1:] == before[1:]:
            return 'kept'
        return 'taken down' if after[1:] == ([], []) else f'changed {after}'

    def late(self, route, payload, marker):
        before = self.snapshot()
        self.release(route, payload)
        deadline = time.monotonic() + 2
        while marker not in str(self.snapshot()) and time.monotonic() < deadline:
            self.page.wait_for_timeout(50)
        after = self.snapshot()
        return 'shown' if marker in str(after) else 'dropped' if after == before else f'changed {after}'

    def test_14_clinician_only_change_voids_in_flight_writer_reads(self):
        a_labels, a_drawn = (['SYN-A key', 'SYN-A length', 'SYN-A angle', 'SYN-A arrow'], [['Length', 'SYN-A length', True]])
        late = ['SYN LATE WRITER LENGTH', 'SYN LATE WRITER KEY']
        for name in ('shipped',):
            with self.subTest(step='a', file=name):
                self.writer_open(None, hold={(VA, 'first')})
                self.wait_until(lambda: self.held_writer, 'the first author page held')
                self.assertEqual('writer', self.session())
                self.to_clinician_only(LATER, hold_final=True)
                self.wait_until(lambda: self.held_items, 'the final read held')
                self.release(self.held_writer.pop()[2], author_page(LATE_MARK, LATE_KEY))
                seen, drawn = (self.panel(), self.page.evaluate('synDrawn()'))
                self.assertEqual(([], []), (seen['rows'], drawn), 'nothing of the late author page')
                self.assertEqual('loading', seen['state'])
                self.hold_items = set()
                self.release(self.held_items.pop()[1], self.clinician_page(VA, None)['json'])
                seen = self.wait_panel('ready', VA)
                self.assertEqual((a_labels, a_drawn), ([row[2] for row in seen['rows']], self.page.evaluate('synDrawn()')))
                cursor = next(iter(self.cursors))
                self.assertEqual([(VA, {'includeHidden': ['true'], 'limit': ['100']}), (VA, {'limit': ['100']}), (VA, {'limit': ['100'], 'cursor': [cursor]})], self.reads())
                self.items[VA] = 'withheld'
                self.focus()
                seen = self.wait_panel('withheld', VA)
                self.assertEqual((RO_WITHHELD, [], []), (seen['status'], seen['rows'], self.page.evaluate('synDrawn()')))
        with self.subTest(step='c'):
            self.writer_open(hold={(VA, 'first')})
            self.wait_until(lambda: self.held_writer, 'the first author page held')
            self.items[VA] = 'withheld'
            self.to_clinician_only()
            seen = self.wait_panel('withheld', VA)
            self.assertEqual((RO_WITHHELD, [], []), (seen['status'], seen['rows'], self.page.evaluate('synDrawn()')))
            self.assertEqual('dropped', self.late(self.held_writer.pop()[2], author_page(LATE_MARK, LATE_KEY), 'SYN LATE'))
            self.items[VA], self.hold_next = (copy.deepcopy(ITEMS[VA]), {VA})
            self.focus()
            self.wait_until(lambda: self.held_next, 'the second final page held')
            self.assertEqual(('loading', [], []), self.snapshot())
            _, cursor, route = self.held_next.pop()
            self.release(route, {**self.clinician_page(VA, cursor)['json'], 'reportVersion': 5})
            seen = self.wait_panel('failed', VA)
            self.assertEqual(([], []), (seen['rows'], self.page.evaluate('synDrawn()')))
            self.hold_next = set()
            self.page.get_by_role('button', name='Refresh', exact=True).click()
            seen = self.wait_panel('ready', VA)
            self.assertEqual((a_labels, a_drawn), ([row[2] for row in seen['rows']], self.page.evaluate('synDrawn()')))
        with self.subTest(step='d: refresh, frameless'):
            self.writer_open(hold={(VA, 'first')})
            self.wait_until(lambda: self.held_writer, 'the first author page held')
            self.release(self.held_writer.pop()[2], author_page(SHOWN_MARK, SHOWN_KEY))
            self.wait_until(lambda: self.page.evaluate('synDrawn()') == [['Length', 'SYN WRITER SHOWN LENGTH', True]], 'the author mark drawn')
            self.frameless(True)
            self.settle()
            self.page.get_by_role('button', name='Refresh', exact=True).click()
            self.wait_until(lambda: self.held_writer, 'the Refresh page held')
            self.to_clinician_only(hold_final=True)
            self.assertEqual(([], []), self.snapshot()[1:], 'rows and marks taken down at once')
            self.wait_until(lambda: self.held_items, 'the final read held')
            self.assertEqual('dropped', self.late(self.held_writer.pop()[2], author_page(LATE_MARK, LATE_KEY), 'SYN LATE'))
            self.hold_items = set()
            self.release(self.held_items.pop()[1], self.clinician_page(VA, None)['json'])
            seen = self.wait_panel('ready', VA)
            self.assertEqual(('unmatched', a_labels, []), (seen['frame'], [row[2] for row in seen['rows']], self.page.evaluate('synDrawn()')))
            self.frameless(False)
            self.wait_until(lambda: self.page.evaluate('synDrawn()') == a_drawn, 'the final mark drawn with the frame back')
            self.assertIsNone(self.panel()['frame'])
        with self.subTest(step='d: a-b-a'):
            self.writer_open(hold={(VA, 'first')})
            self.wait_until(lambda: len(self.held_writer) == 1, "A's first author page held")
            self.page.evaluate('study => synSwitch(study)', VP)
            self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), "B's author list")
            self.page.evaluate('study => synSwitch(study)', VA)
            self.wait_until(lambda: len(self.held_writer) == 2, "A's second author page held")
            self.to_clinician_only()
            self.wait_panel('ready', VA)
            held, self.held_writer = (self.held_writer, [])
            for _, _, route in held:
                self.assertEqual('dropped', self.late(route, author_page(LATE_MARK, LATE_KEY), 'SYN LATE'))
            self.assertEqual((a_labels, a_drawn), (self.labels(), self.page.evaluate('synDrawn()')))

    def test_15_session_change_matrix(self):
        seen = {change: {} for change in SESSION_CHANGES}
        authors = lambda requests: [r for r in requests if r[1].get('includeHidden') == ['true']]
        finals = lambda requests: [r for r in requests if 'includeHidden' not in r[1] and r[1].get('limit') == ['100']]
        offered = lambda buttons: 'none' if not set(buttons) & WRITER_CONTROLS else f'offered {buttons}'
        u = seen['unconfirmed->writer']
        self.me, self.hold_me = (RADIOLOGIST, True)
        self.open_viewer(uncancellable=True, enter=[HISTORY])
        self.wait_until(lambda: len(self.held_me) == 1, "the panel's /me held")
        self.assertEqual('unconfirmed', self.session())
        before, asked, buttons = (self.snapshot(), list(self.item_requests), self.panel()['buttons'])
        start, me_before, self.hold_me = (len(self.item_requests), self.me_requests, False)
        self.page.evaluate('ids => synEnter(ids)', OTHER)
        self.wait_until(lambda: self.session() == 'writer', "the layout panel's writer answer")
        self.settle()
        u['shown_at_change'] = self.change_effect(before, self.snapshot())
        u['reads_by_other_me'] = ('me+' if self.me_requests - me_before > 1 else '') + self.first_reads(start)
        self.release(self.held_me.pop(), RADIOLOGIST)
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), "the author list after the panel's /me")
        u['read_awaiting_me'] = self.first_reads(start)
        u['state_after'] = self.session()
        for row in ('author_first_page', 'author_next_page', 'author_refresh'):
            u[row] = 'none' if not authors(asked) else 'asked'
        u['final_page'] = 'none' if not finals(asked) else 'asked'
        u['write_awaiting_me'] = u['write_sent'] = offered(buttons)
        self.item_requests, self.cursors, self.me_requests = ([], {}, 0)
        self.open_viewer(uncancellable=True, enter=[HISTORY])
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'the author list')
        self.settle()
        u['reads_by_own_me'] = ('me+' if self.me_requests > 1 else '') + self.first_reads(0)
        w = seen['writer->read-only']
        self.writer_open(hold={(VA, 'first')})
        self.wait_until(lambda: self.held_writer, 'the first author page held')
        start, me_before = (len(self.item_requests), self.me_requests)
        w['final_page'] = 'none' if not finals(self.item_requests) else 'asked'
        self.to_clinician_only()
        self.wait_panel('ready', VA)
        w['reads_by_other_me'] = ('me+' if self.me_requests - me_before > 1 else '') + self.first_reads(start)
        w['author_first_page'] = self.late(self.held_writer.pop()[2], author_page(LATE_MARK, LATE_KEY), 'SYN LATE')
        w['state_after'] = self.session()
        self.writer_open(hold={(VA, 'next')}, paged=True)
        self.wait_until(lambda: self.held_writer, 'the next author page held')
        self.to_clinician_only()
        self.wait_panel('ready', VA)
        w['author_next_page'] = self.late(self.held_writer.pop()[2], author_page(LATE_MARK), 'SYN LATE')
        self.writer_open(hold={(VA, 'first')})
        self.wait_until(lambda: self.held_writer, 'the first author page held')
        self.release(self.held_writer.pop()[2], author_page(SHOWN_MARK, SHOWN_KEY))
        self.wait_until(lambda: self.page.evaluate('synDrawn()') == [['Length', 'SYN WRITER SHOWN LENGTH', True]], 'the author mark drawn')
        self.page.get_by_role('button', name='Refresh', exact=True).click()
        self.wait_until(lambda: self.held_writer, 'the Refresh page held')
        before = self.snapshot()
        self.to_clinician_only(hold_final=True)
        w['shown_at_change'] = self.change_effect(before, self.snapshot())
        self.wait_until(lambda: self.held_items, 'the final read held')
        w['author_refresh'] = self.late(self.held_writer.pop()[2], author_page(LATE_MARK, LATE_KEY), 'SYN LATE')
        self.hold_items = set()
        self.release(self.held_items.pop()[1], self.clinician_page(VA, None)['json'])
        self.wait_panel('ready', VA)
        self.writer_open()
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'the author list')
        self.hold_me = True
        self.page.get_by_role('button', name='Refresh', exact=True).click()
        self.wait_until(lambda: self.held_me, 'the Refresh /me held')
        start, self.hold_me = (len(self.item_requests), False)
        self.to_clinician_only()
        self.wait_panel('ready', VA)
        self.release(self.held_me.pop(), MIXED)
        self.settle()
        self.assertEqual(('read-only', 'ready'), (self.session(), self.panel()['state']))
        w['read_awaiting_me'] = self.first_reads(start)
        self.writer_open()
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'the author list')
        self.hold_me = True
        self.page.get_by_role('button', name='Refresh', exact=True).click()
        self.wait_until(lambda: self.held_me, 'the Refresh /me held')
        start, me_before, self.hold_me, self.me = (len(self.item_requests), self.me_requests, False, MIXED_NOW_CLINICIAN)
        self.release(self.held_me.pop(), MIXED_NOW_CLINICIAN)
        self.wait_panel('ready', VA)
        w['reads_by_own_me'] = ('me+' if self.me_requests > me_before else '') + self.first_reads(start)
        history = self.page.locator('#kin-viewer-history')
        self.writer_open()
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'the author list')
        self.accept_writes = True
        history.get_by_role('button', name='Add Key Image', exact=True).click()
        self.wait_until(lambda: 'Save' in self.panel()['buttons'], "the new key image's Save")
        self.hold_me = True
        history.get_by_role('button', name='Save', exact=True).click()
        self.wait_until(lambda: self.held_me, "the Save's /me held")
        self.hold_me, self.me = (False, MIXED_NOW_CLINICIAN)
        self.release(self.held_me.pop(), MIXED_NOW_CLINICIAN)
        self.wait_panel('ready', VA)
        self.settle()
        w['write_awaiting_me'] = 'not sent' if not self.writes else f'sent {self.writes}'
        for route in self.held_writes:
            self.release(route, author_page(LATE_WRITE)['items'][0])
        self.writer_open()
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'the author list')
        self.accept_writes = True
        history.get_by_role('button', name='Add Key Image', exact=True).click()
        self.wait_until(lambda: 'Save' in self.panel()['buttons'], "the new key image's Save")
        history.get_by_role('button', name='Save', exact=True).click()
        self.wait_until(lambda: self.held_writes, 'the Save on the wire')
        self.to_clinician_only()
        self.wait_panel('ready', VA)
        w['write_sent'] = self.late(self.held_writes.pop(), author_page(LATE_WRITE)['items'][0], 'SYN LATE WRITTEN')
        r = seen['read-only->writer']
        self.me, self.list_me, self.hold_items, self.held_items = (CLINICIAN, CLINICIAN, {VA}, [])
        self.item_requests, self.cursors, self.me_requests, self.accept_writes = ([], {}, 0, False)
        self.open_viewer(uncancellable=True, enter=[HISTORY])
        self.wait_until(lambda: self.held_items, 'the final read held')
        self.assertEqual('read-only', self.session())
        me_before, self.me = (self.me_requests, CLINICIAN_NOW_MIXED)
        self.page.evaluate('ids => synEnter(ids)', OTHER)
        self.wait_until(lambda: self.me_requests > me_before, "the layout panel's /me")
        self.settle()
        self.hold_items = set()
        r['final_page'] = self.late(self.held_items.pop()[1], self.clinician_page(VA, None)['json'], 'SYN-A key')
        asked = list(self.item_requests)
        self.me, self.item_requests, self.cursors, self.me_requests = (CLINICIAN, [], {}, 0)
        self.open_viewer(uncancellable=True, enter=[HISTORY])
        self.wait_panel('ready', VA)
        buttons, self.hold_me = (self.panel()['buttons'], True)
        self.page.get_by_role('button', name='Refresh', exact=True).click()
        self.wait_until(lambda: self.held_me, 'the Refresh /me held')
        before, start, me_before = (self.snapshot(), len(self.item_requests), self.me_requests)
        self.me, self.hold_me = (CLINICIAN_NOW_MIXED, False)
        self.page.evaluate('ids => synEnter(ids)', OTHER)
        self.wait_until(lambda: self.me_requests > me_before, "the layout panel's /me")
        self.settle()
        r['shown_at_change'] = self.change_effect(before, self.snapshot())
        r['reads_by_other_me'] = ('me+' if self.me_requests - me_before > 1 else '') + self.first_reads(start)
        self.release(self.held_me.pop(), CLINICIAN_NOW_MIXED)
        self.wait_until(lambda: self.first_reads(start) != 'none', "the read after the panel's /me")
        self.wait_panel('ready', VA)
        r['read_awaiting_me'] = self.first_reads(start)
        start, me_before = (len(self.item_requests), self.me_requests)
        self.page.get_by_role('button', name='Refresh', exact=True).click()
        self.wait_until(lambda: self.first_reads(start) != 'none', 'the Refresh read')
        self.wait_panel('ready', VA)
        r['reads_by_own_me'] = ('me+' if self.me_requests - me_before > 1 else '') + self.first_reads(start)
        r['state_after'] = self.session()
        asked += self.item_requests
        for row in ('author_first_page', 'author_next_page', 'author_refresh'):
            r[row] = 'none' if not authors(asked) else 'asked'
        r['write_awaiting_me'] = r['write_sent'] = offered(buttons)
        for change in SESSION_CHANGES:
            self.assertEqual(set(SESSION_CHANGE_MATRIX), set(seen[change]), change)
            for row, expected in SESSION_CHANGE_MATRIX.items():
                with self.subTest(change=change, row=row):
                    self.assertEqual(expected[SESSION_CHANGES.index(change)], seen[change][row])

    def hold_writer_work(self, config=None):
        history = self.page.locator('#kin-viewer-history')
        self.writer_open(config)
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), "A's author list")
        history.get_by_role('button', name='Add Key Image', exact=True).click()
        history.get_by_label('Key Title', exact=True).fill(HELD_TITLE)
        self.page.evaluate('study => synSwitch(study)', VP)
        self.wait_until(lambda: (lambda p: p['uid'] == VP and 'SYN writer key' in str(p['rows']))(self.panel()), "B's author list")
        self.page.evaluate('study => synSwitch(study)', VA)
        self.wait_until(lambda: (lambda p: p['uid'] == VA and 'Resume Held Work' in p['buttons'])(self.panel()), "A's work held")
        self.page.evaluate(NAVIGABLE, [SERIES, SOP])

    def on_screen(self):
        return self.page.evaluate("() => document.body.innerText + ' ' + [...document.querySelectorAll('input, textarea')].map(e => e.value).join(' ')")

    def list_view(self, item):
        seen, drawn = (self.panel(), self.page.evaluate('synDrawn()'))
        suspended, before = (self.page.evaluate('kinViewerHistoryState().suspended'), self.page.evaluate('synIndexed.length'))
        self.page.locator(f'#kin-viewer-history section[data-item-id="{item}"]').get_by_role('button', name='Go to Image', exact=True).click()
        self.settle()
        clicked = self.page.evaluate('synIndexed.length') > before
        return {'panel': seen, 'drawn': drawn, 'suspended': suspended, 'go_to_image': clicked, 'navigate': self.page.evaluate(NAVIGATE, [VA, SERIES, SOP, item])}

    def refresh_final(self):
        reads = len(self.reads())
        self.page.get_by_role('button', name='Refresh', exact=True).click()
        self.wait_until(lambda: len(self.reads()) >= reads + 2 and self.panel()['state'] == 'ready', 'the Refresh read')
        self.settle()

    def test_16_held_writer_work_never_blocks_the_final_list(self):
        a_labels, length = (['SYN-A key', 'SYN-A length', 'SYN-A angle', 'SYN-A arrow'], item_id(2))
        arrived = {'ok': True, 'highlighted': True, 'annotation': 'shown', 'present': True, 'revision': 2, 'hidden': False, 'working': False}
        unsaved = '() => kinViewerHistoryHasUnsaved()'
        self.writer_open()
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), "A's author list")
        self.page.evaluate(NAVIGABLE, [SERIES, SOP])
        self.to_clinician_only(LATER)
        self.wait_panel('ready', VA)
        clear = self.list_view(length)
        self.assertEqual((a_labels, [['Length', 'SYN-A length', True]], False, True, arrived), ([row[2] for row in clear['panel']['rows']], clear['drawn'], clear['suspended'], clear['go_to_image'], clear['navigate']))
        self.assertEqual(({'Refresh', 'Go to Image'}, [RO_NOTE], 0), (set(clear['panel']['buttons']), clear['panel']['notes'], clear['panel']['inputs']))
        self.assertFalse(self.page.evaluate(unsaved))
        self.fresh_page()
        self.hold_writer_work()
        self.assertEqual(([], True, {'ok': False, 'reason': 'busy'}), (self.page.evaluate('synDrawn()'), self.page.evaluate('kinViewerHistoryState().suspended'), self.page.evaluate(NAVIGATE, [VA, SERIES, SOP, None])), "the writer's held-work pause")
        self.to_clinician_only(LATER)
        self.wait_panel('ready', VA)
        self.assertEqual(clear, self.list_view(length))
        self.assertTrue(self.page.evaluate(unsaved))
        for step in ('refresh', 'frame lost and back', 'final:false, then final'):
            with self.subTest(step=step):
                if step == 'refresh':
                    self.refresh_final()
                elif step == 'frame lost and back':
                    self.frameless(True)
                    self.wait_until(lambda: self.panel()['frame'] == 'unmatched', 'the list unmatched')
                    before = self.probes()
                    self.frameless(False)
                    self.wait_until(lambda: self.probes() > before and self.panel()['frame'] is None, "the check on the frame's return")
                    self.settle()
                else:
                    self.items[VA] = 'withheld'
                    self.focus()
                    seen = self.wait_panel('withheld', VA)
                    self.assertEqual((RO_WITHHELD, [], [], ['Refresh']), (seen['status'], seen['rows'], self.page.evaluate('synDrawn()'), seen['buttons']))
                    self.items[VA] = copy.deepcopy(ITEMS[VA])
                    self.focus()
                    self.wait_panel('ready', VA)
                    self.settle()
                self.assertEqual(clear, self.list_view(length))
                self.assertNotIn(HELD_TITLE, self.on_screen())
                self.assertNotIn('Unsaved', str(self.panel()['rows']))
                self.assertTrue(self.page.evaluate(unsaved))
        self.fresh_page()
        self.hold_writer_work()
        history = self.page.locator('#kin-viewer-history')
        history.get_by_role('button', name='Resume Held Work', exact=True).click()
        self.wait_until(lambda: 'Key Image · Unsaved' in str(self.panel()['rows']), 'the held key image resumed')
        resumed = self.panel()['rows']
        self.assertEqual(HELD_TITLE, history.get_by_label('Key Title', exact=True).input_value())
        self.assertFalse({'Resume Held Work', 'Discard Held Work'} & set(self.panel()['buttons']))
        self.fresh_page()

    def refusal_then_late_writers(self, refuser, status, config=None, late_bodies=False):
        self.me, self.me_status, self.hold_me, self.held_me = (RADIOLOGIST, None, True, [])
        self.item_requests, self.cursors, self.me_requests, self.writer_paged = ([], {}, 0, False)
        self.open_viewer(config, uncancellable=True, enter=[HISTORY], before_boot=SLOW_ME_BODIES if late_bodies else None)
        producers = {}
        for name, ids in (('panel', []), ('gate', GATES), ('layout', [LAYOUT_ID])):
            if ids:
                self.page.evaluate('ids => synEnter(ids)', ids)
            self.wait_until(lambda: len(self.held_me) > len(producers), f"the {name}'s /me held")
            producers[name] = self.held_me[-1]
        self.assertEqual((3, 'unconfirmed'), (len(self.held_me), self.session()))
        self.hold_me, self.held_me = (False, [])
        writers = [route for name, route in producers.items() if name != refuser]
        if late_bodies:
            for route in writers:
                self.release(route, RADIOLOGIST)
            self.assertEqual('unconfirmed', self.session(), 'the writer answers are in, their bodies are not')
        self.release(producers[refuser], {'statusCode': status, 'message': 'SYN refused'}, status=status)
        self.wait_until(lambda: self.session() == 'refused', 'the refusal')
        if late_bodies:
            self.page.evaluate('() => window.synBodies.forEach(release => release())')
            self.settle()
        else:
            for route in writers:
                self.release(route, RADIOLOGIST)

    def writer_document(self, config=None):
        self.me, self.me_status, self.hold_me, self.held_me = (RADIOLOGIST, None, False, [])
        self.item_requests, self.cursors, self.me_requests, self.writer_paged = ([], {}, 0, False)
        self.open_viewer(config, uncancellable=True)
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'the writer panel')
        self.wait_until(lambda: set(self.page.evaluate('synMounted')) == MODULES, 'every module mounted')
        self.wait_until(lambda: any((not disabled for _, disabled in self.layout()['buttons'])), 'the layout buttons')
        self.assertEqual(('writer', ['ran', 'mark Bidirectional']), (self.session(), self.page.evaluate("[synClick('Bidirectional'), synDraw('default')]")))

    def layout_status(self):
        return self.page.evaluate("() => document.querySelector('#kin-viewer-layout-status').textContent")


    def test_17_plain_failures_preserve_the_document_and_only_session_codes_end_it(self):
        self.writer_document()
        for status in (401,403,409,428,500):
            self.page.route(ORIGIN+'/api/syn-failure',lambda route:route.fulfill(status=status,json={'message':'SYN failure'}))
            self.page.evaluate("fetch('/api/syn-failure').then(r=>r.status)")
            self.assertFalse(self.page.evaluate('KinViewerSessionBoundary.ended()'))
            self.assertEqual('writer',self.session())
        self.hold_writer={(VP,'first')};self.page.evaluate('uid=>synSwitch(uid)',VP)
        self.wait_until(lambda:bool(self.held_writer),'late item read')
        self.server_end();self.assert_closed()
        for _,_,route in self.held_writer:
            try:route.fulfill(json=author_page(LATE_MARK,LATE_KEY))
            except Exception:pass
        self.assert_closed()

    def layout_sees_account_change(self, via, account, config=None):
        self.writer_document(config)
        self.hold_me = True
        self.focus()
        self.wait_until(lambda: len(self.held_me) == 1, "the Measurements panel's /me asked on focus, held")
        held, self.hold_me, self.held_me, self.me = (self.held_me[0], False, [], account)
        asked = self.me_requests
        if via == 'save':
            self.page.evaluate("() => [...document.querySelectorAll('#kin-viewer-layout button')]\n              .find(b => b.textContent === 'Save Recent Layout').click()")
            self.wait_until(lambda: self.me_requests > asked and self.layout_status() != LAYOUT_CHECKING, "Save Recent Layout's /me answered")
            outcome = self.layout_status()
        else:
            self.page.evaluate("() => { window.synHpOutcome = null;\n              synHpAccess({ signal: new AbortController().signal }).then(() => 'ok', error => error.message)\n                .then(outcome => { window.synHpOutcome = outcome; }); }")
            self.wait_until(lambda: self.page.evaluate('window.synHpOutcome') is not None, "the editor's access check answered")
            outcome = self.page.evaluate('window.synHpOutcome')
        self.settle()
        return (held, outcome)


    def test_18_layout_binding_mismatch_ends_the_document_before_held_panel_answers(self):
        for via in ('save', 'hanging-protocol', 'measurements'):
            with self.subTest(via=via):
                self.fresh_page();self.writer_document();self.hold_me=True
                self.focus();self.wait_until(lambda:bool(self.held_me),'held Measurements check')
                first=self.held_me.pop()
                if via=='save':self.page.get_by_role('button',name='Save Recent Layout',exact=True).click()
                elif via=='hanging-protocol':self.page.evaluate("void synHpAccess({signal:new AbortController().signal}).catch(()=>{})")
                else:self.focus()
                if via=='measurements':route=first;first=None
                else:self.wait_until(lambda:bool(self.held_me),'layout account check');route=self.held_me.pop()
                route.fulfill(status=409,headers={'X-KIN-Auth-Code':'AUTH_SESSION_MISMATCH'},json={'code':'AUTH_SESSION_MISMATCH'})
                self.assert_closed()
                if first:first.fulfill(json=RADIOLOGIST)
                self.assert_closed()
                self.assertEqual([],self.ended_value("Object.keys(localStorage).filter(key=>key.startsWith('kin-viewer-layout'))"))

    def read_only_document(self, config=None):
        self.me, self.me_status, self.hold_me, self.held_me = (CLINICIAN, None, False, [])
        self.items, self.item_requests, self.cursors = (copy.deepcopy(ITEMS), [], {})
        self.me_requests, self.writer_paged = (0, False)
        self.open_viewer(config)
        self.wait_panel('ready', VA)
        self.modules_settled()
        self.wait_until(lambda: self.layout()['summary'] == 'Viewer Status', "the layout panel's status line")
        self.assertEqual(('read-only', [['Length', 'SYN-A length', True]], []), (self.session(), self.page.evaluate('synDrawn()'), self.page.evaluate('synMounted')))


    def history_state(self):
        return self.page.evaluate('() => { const s = kinViewerHistoryState(); return {subject: s.subject, ended: s.ended}; }')


    def test_19_binding_mismatch_on_reentry_and_later_panels_never_adopts_the_other_account(self):
        for producer in ('reentry','layout','modules'):
            with self.subTest(producer=producer):
                self.fresh_page();self.me=RADIOLOGIST;self.me_status=None;self.hold_me=False
                self.open_viewer(enter=[HISTORY]);self.wait_until(lambda:bool(self.panel()['rows']),'writer history')
                self.hold_me=True
                if producer=='reentry':self.page.evaluate('synReenter()')
                else:self.page.evaluate('ids=>synEnter(ids)',[LAYOUT_ID] if producer=='layout' else GATES)
                self.wait_until(lambda:bool(self.held_me),'later producer account check')
                self.held_me.pop().fulfill(status=403,headers={'X-KIN-Auth-Code':'AUTH_SESSION_MISMATCH'},json=OTHER_WRITER)
                self.assert_closed()
                self.assertEqual('SYN-SESSION-'+RADIOLOGIST['sub'],self.ended_value('KinWorkContext.session()'))


    def test_20_read_only_end_remains_closed_after_reload(self):
        self.read_only_document();self.server_end();self.assert_closed()
        before=len(self.entry_reads)
        self.viewer_page=True
        # A reload has history binding, not a fresh clinician handoff.
        self.page.route(VIEWER_URL,lambda route:route.fulfill(body=VIEWER_HARNESS,content_type='text/html'))
        self.held_navigation.clear()
        self.page.goto(VIEWER_URL)
        self.page.evaluate("void kinCreateSessionBoundary().preRegistration()")
        self.assert_closed();self.assertEqual(before,len(self.entry_reads))

    def test_21_the_same_account_re_entering_is_not_an_end(self):
        self.writer_document()
        self.page.evaluate('synClearMarks()')
        asked, reads = (self.me_requests, len(self.reads()))
        self.page.evaluate('synReenter()')
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']) and Counter(self.page.evaluate('synMounted')) == Counter({m: 2 for m in MODULES}) and (self.layout()['buttons'] == [[n, False] for n in LAYOUT_BUTTONS + ['Save to Account']]), 'the writer document back after the re-entry')
        self.settle()
        self.assertEqual(('writer', 3, [(VA, {'includeHidden': ['true'], 'limit': ['100']})], 'ready', PRIMARY_SECTION, {'subject': RADIOLOGIST['sub'], 'ended': False}), (self.session(), self.me_requests - asked, self.reads()[reads:], self.note_state(), self.page.evaluate('synToolbar()')['primary'], self.history_state()))
        self.assertEqual(['ran', 'mark Bidirectional', 'true'], self.page.evaluate("[synClick('Bidirectional'), synDraw('default'), synAdd('ArrowAnnotate')]"))
        self.page.evaluate('synClearMarks()')
        self.fresh_page()
        self.read_only_document()
        asked, reads, cursors = (self.me_requests, len(self.reads()), len(self.cursors))
        self.page.evaluate('synReenter()')
        self.wait_panel('ready', VA)
        self.modules_settled()
        self.wait_until(lambda: self.layout()['summary'] == 'Viewer Status', "the layout panel's status line after the re-entry")
        self.settle()
        cursor = list(self.cursors)[cursors]
        self.assertEqual(('read-only', 2, [(VA, {'limit': ['100']}), (VA, {'limit': ['100'], 'cursor': [cursor]})], [['Length', 'SYN-A length', True]], [], 'read-only', {'subject': CLINICIAN['sub'], 'ended': False}), (self.session(), self.me_requests - asked, self.reads()[reads:], self.page.evaluate('synDrawn()'), self.page.evaluate('synMounted'), self.note_state(), self.history_state()))
        self.fresh_page()
        self.hold_writer_work()
        self.to_clinician_only(LATER)
        self.wait_panel('ready', VA)
        self.page.evaluate('synReenter()')
        self.wait_panel('ready', VA)
        self.settle()
        self.page.evaluate(NAVIGABLE, [SERIES, SOP])
        self.assertEqual(('read-only', [['Length', 'SYN-A length', True]], True, {'subject': MIXED_NOW_CLINICIAN['sub'], 'ended': False}), (self.session(), self.page.evaluate('synDrawn()'), self.page.evaluate(NAVIGATE, [VA, SERIES, SOP, None]).get('ok'), self.history_state()))

    def serve_real(self, module):
        self.files = dict(SHIPPED)
        for name in REAL_MODULES[module]:
            self.files[name] = lf_text(HPACS / name)
        self.real_api, self.module_requests, self.module_status = (True, [], {})
        return REAL_NOTE_DEPS if module == 'tech-note' else None

    def text_of(self, selector):
        return self.page.evaluate('s => document.querySelector(s)?.textContent ?? null', selector)

    def control_enabled(self, module):
        return self.page.evaluate("label => [...document.querySelectorAll('button')].some(b => b.textContent === label && !b.disabled)", MODULE_CONTROL[module])

    def module_ready(self, module):
        selector, ready = MODULE_READY[module]
        self.wait_until(lambda: ready in (self.text_of(selector) or '') and self.control_enabled(module), f'the real {module} working')




    def real_writer_document(self, module, config=None, files=None):
        before_boot = self.serve_real(module)
        self.files.update(files or {})
        self.me, self.me_status, self.hold_me, self.held_me = (RADIOLOGIST, None, False, [])
        self.item_requests, self.cursors, self.me_requests, self.writer_paged = ([], {}, 0, False)
        self.open_viewer(config, uncancellable=True, before_boot=before_boot)
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'the writer panel')
        self.wait_until(lambda: any((not disabled for _, disabled in self.layout()['buttons'])), 'the layout buttons')
        self.module_ready(module)
        if module == 'findings':
            self.wait_until(lambda: '연결할 수 있는 저장 표식' in (self.text_of('#kin-viewer-findings-comparison') or ''), "the Findings store's comparison read")

    def module_recheck(self, module):
        self.hold_me = True
        self.page.evaluate(MODULE_RECHECK[module])
        header = MODULE_ME_HEADER[module]
        self.wait_until(lambda: any((header in route.request.headers for route in self.held_me)), f"the real {module}'s recheck /me held")
        own = next((route for route in self.held_me if header in route.request.headers))
        self.held_me.remove(own)
        return own

    def release_held(self, answer):
        held, self.held_me, self.hold_me = (self.held_me, [], False)
        for route in held:
            self.release(route, answer)

    def test_22_each_real_write_module_observes_bound_checks_and_real_session_end(self):
        for module in ('jobs','findings','tech-note'):
            with self.subTest(module=module):
                self.fresh_page();self.real_writer_document(module)
                for status in (401,403,500):
                    own=self.module_recheck(module)
                    self.release(own,{'message':'SYN local failure'},status=status)
                    self.release_held(RADIOLOGIST);self.settle()
                    self.assertFalse(self.page.evaluate('KinViewerSessionBoundary.ended()'))
                    own=self.module_recheck(module)
                    self.release(own,RADIOLOGIST);self.release_held(RADIOLOGIST)
                    self.module_ready(module)
                own=self.module_recheck(module)
                own.fulfill(status=401,headers={'X-KIN-Auth-Code':'AUTH_SESSION_ENDED'},json={'code':'AUTH_SESSION_ENDED'})
                self.assert_closed()
                self.release_held(RADIOLOGIST);self.assert_closed()
            with self.subTest(first_me=module):
                self.fresh_page();before=self.serve_real(module);self.me=RADIOLOGIST;self.hold_me=False
                self.open_viewer(uncancellable=True,enter=[HISTORY,LAYOUT_ID],before_boot=before)
                self.wait_until(lambda:bool(self.panel()['rows']),'confirmed first account')
                self.hold_me=True;self.page.evaluate('ids=>synEnter(ids)',GATES)
                self.wait_until(lambda:bool(self.held_me),'module gate check')
                self.release(self.held_me.pop(),RADIOLOGIST)
                self.wait_until(lambda:len(self.held_me)==1,'real module first check')
                own=self.held_me.pop()
                own.fulfill(status=409,headers={'X-KIN-Auth-Code':'AUTH_SESSION_MISMATCH'},json=OTHER_WRITER)
                self.assert_closed();self.release_held(RADIOLOGIST);self.assert_closed()

    def test_23_scoped_logout_while_extensions_are_down_closes_the_document(self):
        for account in (CLINICIAN,RADIOLOGIST):
            for kind in ('broadcast','storage'):
                with self.subTest(account=account['user'],kind=kind):
                    self.fresh_page();self.me=account;self.me_status=None;self.hold_me=False
                    self.open_viewer();self.settle();self.page.evaluate('synLeave()')
                    self.notice('SYN-OTHER',kind);self.settle()
                    self.assertFalse(self.page.evaluate('KinViewerSessionBoundary.ended()'))
                    self.notice('SYN-SESSION-'+account['sub'],kind);self.assert_closed()

    def api_paths(self, start):
        paths = []
        for request in self.finished[start:]:
            url = urlparse(request.url)
            if url.path.startswith('/api/'):
                paths.append(url.path + (f'?{url.query}' if url.query else ''))
        return paths

    def ct_sync_document(self, uncancellable=False, checked=True):
        self.viewer_page = True
        self.page.goto(VIEWER_URL)
        if uncancellable:
            self.page.evaluate('() => { const real = window.fetch.bind(window);\n              window.fetch = (url, options = {}) => { const { signal, ...rest } = options; return real(url, rest); }; }')
        self.bootstrap=True
        self.page.evaluate('kinCreateSessionBoundary().preRegistration()')
        self.bootstrap=False
        self.page.evaluate(END_REASONS)
        if uncancellable:
            self.page.evaluate('() => { const real = window.fetch.bind(window);\n              window.fetch = (url, options = {}) => { const { signal, ...rest } = options; return real(url, rest); }; }')
        start = len(self.finished)
        self.page.evaluate(CT_SYNC_BOOT, [VA, VP])
        self.observe_document()
        if not checked:
            return None
        self.wait_until(lambda: len(self.api_paths(start)) >= 3, 'the CT sync access check')
        self.settle()
        return self.api_paths(start)

    def test_24_clinician_ct_sync_uses_narrow_scope_and_recovers_plain_failures(self):
        self.ct_pair()
        self.assertEqual(['/api/me','/api/clinician/studies?limit=100','/api/me'],self.ct_sync_document())
        self.page.evaluate("synCt.scroll('syn-ct-a',4)")
        self.wait_until(lambda:self.page.evaluate("synCt.z('syn-ct-b')")==8,'synced prior')
        for status in (401,403,500):
            self.page.evaluate('synCt.exit()');self.me_status=status;self.page.evaluate("synCt.enter();synCt.scroll('syn-ct-a',6)")
            self.wait_until(lambda:(self.page.evaluate('synCt.notice()') or {}).get('recheck'),'retryable access failure')
            self.assertFalse(self.page.evaluate('KinViewerSessionBoundary.ended()'))
            hit=self.page.evaluate(CT_SYNC_HIT);self.assertTrue(hit['button']);self.assertTrue(hit['words_pass'])
            self.assertGreaterEqual(hit['height'],24);self.assertGreaterEqual(hit['font'],12)
            self.me_status=None;self.page.locator('#kin-ct-sync-recheck').click()
            self.wait_until(lambda:self.page.evaluate('synCt.notice()')['text']==CT_SYNC_TEXT['confirmed'],'access recovered')
        self.server_end();self.assert_closed()
        self.fresh_page();self.me=RADIOLOGIST;self.me_status=None
        self.page.route(ORIGIN+'/api/studies',lambda route:route.fulfill(json={'studies':self.rows,'observedAt':'2026-10-05T00:00:00Z'}))
        self.assertEqual(['/api/me','/api/studies','/api/me'],self.ct_sync_document())
        self.page.evaluate("synCt.scroll('syn-ct-a',4)")
        self.wait_until(lambda:self.page.evaluate("synCt.z('syn-ct-b')")==8,'writer sync uses the full list')

    def test_25_ct_sync_end_during_image_decode_never_moves_the_prior(self):
        for status,code in ((401,'AUTH_SESSION_ENDED'),(403,'AUTH_SESSION_MISMATCH'),(409,'AUTH_SESSION_MISMATCH')):
            with self.subTest(status=status):
                self.fresh_page();self.ct_pair();self.ct_sync_document();self.page.evaluate(CT_SYNC_HOLD_IMAGES)
                self.page.evaluate("synCt.scroll('syn-ct-a',4)")
                self.wait_until(lambda:self.page.evaluate('synCtImages.length')==1,'pending image decode')
                self.server_end(status,code);self.assert_closed()
                self.ended_value('('+CT_SYNC_RELEASE_IMAGES+')()');self.settle()
                self.assertEqual(0,self.ended_value("synCt.z('syn-ct-b')"));self.assert_closed()



    def test_26_late_auth_code_after_mode_exit_still_ends_the_document(self):
        for producer in ('ct','measurements','layout'):
            for status,code in ((401,'AUTH_SESSION_ENDED'),(409,'AUTH_SESSION_MISMATCH')):
                with self.subTest(producer=producer,status=status):
                    self.fresh_page();self.me_status=None;self.hold_me=False
                    if producer=='ct':
                        self.ct_pair();self.ct_sync_document(uncancellable=True)
                        self.hold_me=True;self.page.evaluate("synCt.scroll('syn-ct-a',4)")
                    else:
                        self.writer_document();self.hold_me=True
                        if producer=='measurements':self.focus()
                        else:self.page.get_by_role('button',name='Save Recent Layout',exact=True).click()
                    self.wait_until(lambda:bool(self.held_me),'pending account check')
                    route=self.held_me.pop();self.page.evaluate('synCt.exit()' if producer=='ct' else 'synLeave()')
                    route.fulfill(status=status,headers={'X-KIN-Auth-Code':code},json={'code':code})
                    self.assert_closed()


    def test_27_findings_late_end_code_closes_ct_sync_and_all_other_panels(self):
        self.ct_pair();self.real_writer_document('findings')
        self.page.route(ORIGIN+'/api/studies',lambda route:route.fulfill(json={'studies':self.rows,'observedAt':'2026-10-05T00:00:00Z'}))
        self.page.evaluate(CT_SYNC_BESIDE_PANELS,[VA,VP]);self.settle()
        own=self.module_recheck('findings');self.release_held(RADIOLOGIST)
        self.page.evaluate('uid=>synSwitch(uid)',VE);self.settle()
        own.fulfill(status=401,headers={'X-KIN-Auth-Code':'AUTH_SESSION_ENDED'},json={'code':'AUTH_SESSION_ENDED'})
        self.assert_closed()

    def test_28_capture_is_offered_to_a_confirmed_writer_only(self):

            def capture():
                return self.page.evaluate("() => { const from = synNative.length, offered = synToolbar().primary.includes('Capture');\n              return [offered, synClick('Capture'), synNative.slice(from).filter(x => x === 'view showDownloadViewportModal').length]; }")
            self.hold_me = True
            self.open_viewer()
            self.wait_until(lambda: len(self.held_me) >= 3, 'every /me held')
            self.assertEqual(('unconfirmed', VIEW_SECTION, [False, 'missing', 0]), (self.session(), self.page.evaluate('synToolbar()')['primary'], capture()))
            self.release_me(RADIOLOGIST)
            self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'writer panel')
            self.assertEqual(('writer', PRIMARY_SECTION), (self.session(), self.page.evaluate('synToolbar()')['primary']))
            self.assertEqual([True, 'ran', 1], capture())
            self.page.evaluate(EXTRA_BUTTONS)
            self.assertEqual([['SYN-Download', 'SYN-Reset'], 'ran', 'ran', ['view showDownloadViewportModal', 'view resetViewport']], self.page.evaluate(EXTRA_PRESSED))
            self.me, self.item_requests, self.cursors = (CLINICIAN, [], {})
            self.open_viewer()
            self.wait_panel('ready', VA)
            self.wait_until(lambda: self.page.evaluate('synToolbar()')['primary'] == VIEW_SECTION, 'the trimmed toolbar')
            self.assertEqual([False, 'missing', 0], capture())
            self.assertEqual(VIEW_SECTION, self.page.evaluate('() => { synReenter(); return synToolbar().primary; }'))
            self.wait_panel('ready', VA)
            self.settle()
            self.assertEqual([False, 'missing', 0], capture())
            self.page.evaluate(EXTRA_BUTTONS)
            self.assertEqual([['SYN-Reset'], 'missing', 'ran', ['view resetViewport']], self.page.evaluate(EXTRA_PRESSED))
            self.server_end();self.assert_closed()
            self.fresh_page();self.writer_document();self.server_end();self.assert_closed()

    def observe_document(self):
        # The child observes the retained viewer while its landing navigation is held.
        # The viewer itself still has no opener, as in the clinician handoff.
        with self.page.expect_popup() as opened:
            self.page.evaluate("() => { window.open('/harness/observer'); }")
        self.observer = opened.value
        self.observer.wait_for_load_state()

    def ended_value(self, expression):
        return self.observer.evaluate("() => window.opener.eval(" + json.dumps(expression) + ")")

    def server_end(self,status=401,code='AUTH_SESSION_ENDED'):
        self.page.route(ORIGIN+'/api/syn-end',lambda route:route.fulfill(status=status,headers={'X-KIN-Auth-Code':code},json={'code':code}))
        self.page.evaluate("void fetch('/api/syn-end').catch(()=>{})")

    def assert_closed(self):
        self.wait_until(lambda:bool(self.held_navigation),'landing navigation')
        self.wait_until(lambda:self.ended_value('KinViewerSessionBoundary.ended()'),'document ended')
        self.settle()
        self.assertEqual(0,self.ended_value('document.body.children.length'))
        before=len(self.finished)
        self.ended_value("void fetch('/api/should-not-leave',{method:'POST',body:'{}'}).catch(()=>{})")
        self.settle();self.assertEqual(before,len(self.finished))

    def unsaved_work(self):
        """What the viewer document tells Log out (S7-U5 A006): the kinds its `kin-unsaved:` lock declares now, and its
        answer to the session's unsaved-work question."""
        return self.page.evaluate("""async () => {
          const session = KinWorkContext.session(), prefix = 'kin-unsaved:' + session + ':';
          const held = (await navigator.locks.query()).held.map(lock => lock.name).filter(name => name.startsWith(prefix))
            .map(name => name.split(':').pop()).sort();
          const answers = await new Promise(done => {
            const query = crypto.randomUUID(), seen = [], channel = new BroadcastChannel('kin-session');
            channel.onmessage = event => { if (event.data?.type === 'session-work' && event.data.query === query) seen.push(event.data.unsaved); };
            channel.postMessage({ type: 'session-work-query', session, query });
            setTimeout(() => { channel.close(); done(seen); }, 300);
          });
          return [held, answers]; }""")

    def test_29_log_out_asks_about_a_job_save_that_is_out_but_not_about_a_job_restore(self):
        """S7-U5 A006 / review DR-F04 (commander's decision): with the shipped Job panel, a restore in progress is not
        unsaved work - nothing is declared and Log out's question is answered with nothing; a Job save whose answer has
        not come is declared as `jobs` until the save is confirmed."""
        row = {'id': 'syn-job-1', 'revision': 1, 'title': 'SYN saved job', 'description': 'SYN description', 'hidden': False,
               'authorActor': 'syn-radiologist', 'authorSub': RADIOLOGIST['sub'], 'createdAt': '2026-10-05T00:00:00.000Z',
               'snapshotVersion': 2}
        held_saves = []
        def jobs(route):
            path = urlparse(route.request.url).path
            if route.request.method == 'POST':
                return held_saves.append(route)
            if path.endswith('/viewer-jobs'):
                return route.fulfill(json={'jobs': [row]})
            route.fulfill(status=404, json={'statusCode': 404, 'message': 'SYN job unavailable'})
        self.real_writer_document('jobs')
        self.page.route('**/api/studies/*/viewer-jobs**', jobs)
        self.page.get_by_role('button', name='Refresh Jobs', exact=True).click()
        self.wait_until(lambda: self.page.get_by_role('button', name='Restore Job', exact=True).count() == 1, 'the listed Job')
        self.settle()
        self.assertEqual([[], [[]]], self.unsaved_work())
        # Restore Job: the panel is busy with the restore (its account check held). Not unsaved work.
        self.hold_me = True
        self.page.get_by_role('button', name='Restore Job', exact=True).click()
        self.wait_until(lambda: any('x-kin-subject' in route.request.headers for route in self.held_me), "the restore's /me held")
        self.page.wait_for_timeout(700)
        self.assertEqual([[], [[]]], self.unsaved_work(), 'a Job restore in progress would be asked about at Log out')
        self.release_held(RADIOLOGIST)
        self.wait_until(lambda: 'SYN job unavailable' in (self.text_of('#kin-viewer-jobs-status') or '')
                        or '복원' in (self.text_of('#kin-viewer-jobs-status') or ''), 'the restore finished')
        self.settle()
        # Save Changes of the Job's details: declared while its answer is out, withdrawn when the save is confirmed.
        self.page.get_by_role('button', name='Edit Details', exact=True).click()
        self.page.get_by_role('button', name='Save Changes', exact=True).click()
        self.wait_until(lambda: held_saves, 'the Job save sent')
        self.wait_until(lambda: self.unsaved_work()[0] == ['jobs'], 'the Job save that is out declared')
        self.assertEqual([['jobs']], self.unsaved_work()[1])
        held_saves.pop().fulfill(json={'id': row['id'], 'revision': 2})
        self.wait_until(lambda: self.unsaved_work() == [[], [[]]], 'the confirmed Job save withdrawn')

    def notice(self,session,kind='broadcast'):
        self.observer.evaluate("""([session,kind])=>{const notice={type:'session-ended',session,operation:Date.now(),status:'ending'};
          if(kind==='storage')localStorage.setItem('kin-session-end',JSON.stringify(notice));
          else {const c=new BroadcastChannel('kin-session');c.postMessage(notice);c.close();}}""",[session,kind])

    def ct_pair(self):
        self.rows=[study(VA,'SYN KIM','SYN-P-100',patient(INST_A,'SYN-P-100'),'20260320',FINAL),
                   study(VP,'SYN KIM','SYN-P-100',patient(INST_A,'SYN-P-100'),'20250101',OPEN)]

if __name__ == "__main__":
    unittest.main(verbosity=2)
