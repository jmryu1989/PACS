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

Synthetic data only (SYN-* names): no server, no network, no credentials. A request the harness does not answer is
aborted and fails the case. The server half is S5-U1b (tests/clinician_read_live.py, hosted synthetic stack only).
"""
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

# config/ohif.js wording, verbatim (kinCreateViewerHistory READ_ONLY and its statuses).
RO_NOTE = ("읽기 전용 · 확정 판독문에 저장된 측정·키 이미지만 표시합니다. 이 화면에서는 측정·키 이미지를 만들거나 저장하지 않으며 "
           "서버도 쓰기를 거절합니다.")
RO_WITHHELD = "확정 판독문이 아니어서 저장된 측정·키 이미지를 표시하지 않습니다 · 읽기 전용"
RO_TOOL = "읽기 전용 화면입니다. 측정을 만들지 않습니다."
RO_EDIT = "읽기 전용 화면입니다. 측정·표식을 편집하지 않습니다."
RO_SR = "읽기 전용 화면에서는 SR을 만들거나 저장하지 않습니다."
RO_DENIED = "이 검사의 저장 항목을 읽을 수 없습니다(HTTP 403). 서버가 거절했습니다."
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
window.synMounted = []; window.synNative = []; window.synNotices = []; window.synStudy = null;
const SERIES = '%SERIES%', SOP = '%SOP%';
window.synImage = () => `wadors:${location.origin}/dicom-web/studies/${window.synStudy}/series/${SERIES}/instances/${SOP}/frames/1`;
const element = document.createElement('div'); document.body.append(element);
const viewport = { id: 'syn-vp', renderingEngineId: 'syn-engine', type: 'stack', element,
  getCurrentImageId: () => window.synImage(), getImageIds: () => [window.synImage()], setImageIdIndex: async () => {},
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
window.synSR = name => { try { commands.get(name).commandFn({ measurementData: [] }); return 'ran'; } catch (error) { return 'refused: ' + error.message; } };
window.synAddLength = () => String(window.synTools.Length.addNewAnnotation({ detail: { element } }));
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
  ((host && document.querySelector(host)) || document.body).append(box); return true; }, stop() {} });
window.kinViewerTechNote = () => window.synModule('tech-note', ['Tech Note']);
window.KinViewerHangingProtocol = { mount: options => { window.synMounted.push('hanging-protocol');
  const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Save to Account'; options.host.append(b); return { end() {} }; } };
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
  return {state: p.dataset.readOnly ?? null, uid: p.dataset.studyUid ?? null,
    status: p.querySelector('[role=status]').textContent,
    buttons: [...p.querySelectorAll('button')].filter(b => !b.closest('[data-syn-module]')).map(b => b.textContent),
    links: [...p.querySelectorAll('a')].map(a => a.textContent), inputs: p.querySelectorAll('input, textarea').length,
    notes: [...p.querySelectorAll(':scope > div > p')].map(e => e.textContent),
    rows: [...p.querySelectorAll('section[data-item-id]')].map(s => [...s.children].map(c => c.textContent))}; }"""
LAYOUT = """() => { const p = document.querySelector('#kin-viewer-layout');
  return {summary: p.querySelector('summary').textContent, buttons: [...p.querySelectorAll('button')].map(b => b.textContent),
    note: p.querySelector(':scope > p').textContent}; }"""


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
RO_TOOLBAR = "      if (readOnly()) { text(actions, 'p', READ_ONLY.note); return; }\n"
MODULE_GATE = "kinViewerSession.decide().then(session => session === 'writer' ? ready : null)"
NOTE_GATE = "if(session==='writer'){state='stopped';connect();}else state=session;"
NOTE_CONNECT = "if(!active||state==='loading'||state==='ready'||kinViewerSession.readOnly())return;"
MODULE_WATCH = "  kinViewerSession.onReadOnly(() => { epoch++; current?.stop(); current = null; });\n"
NOTE_WATCH = "  kinViewerSession.onReadOnly(()=>{epoch++;if(active)state='read-only';current?.stop();current=null;});\n"
VERSION_PIN = "(version !== null && page.reportVersion !== version) ||"
VALID = "    const valid = ticket => !ended && ticket === generation && (!current() || current().study === scope);\n"
PAGE_SEQ = "          if (seq !== readSequence) return;\n          if (++pages > 6"
FINAL_SEQ = "        if (!valid(ticket) || seq !== readSequence) return;\n        readOnlyShow("
POLICY = "    const nativeAuthoringClosed = () => readOnly();\n"
DECIDE = "    decide() {\n      if (state === 'read-only') return Promise.resolve(state);\n"
# The gate as it was before F02: its own /me only, and an error or a non-clinician answer counts as a writer.
OLD_DECIDE = ("    decide() {\n      return fetch('/api/me', { credentials: 'same-origin', cache: 'no-store', headers: { 'X-KIN-CSRF': '1' } })\n"
              "        .then(response => response.ok ? response.json() : null)\n"
              "        .then(me => kinViewerClinicianOnly(me) ? 'read-only' : 'writer', () => 'writer');\n")
FINAL_CHECK = ("\n          .then(page => { if (readOnly()) confirmShown(ticket, seq, study, page, null); }, "
               "error => { if (readOnly()) confirmShown(ticket, seq, study, null, error); })")


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
                                         (PAGE_SEQ, "          if (++pages > 6", 1),
                                         (FINAL_SEQ, "        readOnlyShow(", 1)],
                                "config/ohif.js"),
            "policy-off": variant(CONFIG, [(POLICY, "    const nativeAuthoringClosed = () => false;\n", 1)], "config/ohif.js"),
            "gate-as-before": variant(CONFIG, [(DECIDE, OLD_DECIDE, 1),
                                               (NOTE_CONNECT, "if(!active||state==='loading'||state==='ready')return;", 1)],
                                      "config/ohif.js"),
            "no-final-check": variant(CONFIG, [(FINAL_CHECK, "", 1)], "config/ohif.js"),
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
        self.item_requests = []
        self.viewer_opens = []
        self.me_requests = 0
        self.unexpected, self.errors, self.dialogs, self.finished = [], [], [], []
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 900})
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
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
            # me_status: None answers self.me; an HTTP status, "abort" (a network failure the case asks for) or
            # "bad-json" (200 that is not JSON) fails this /me.
            if self.me_status == "abort":
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
        self.unexpected.append(f"{method} {request.url}")
        route.abort()

    def clinician_session(self):
        # api/src/clinician-policy.ts clinicianOnly: app roles only, all of them clinician.
        app = [role for role in self.me["roles"] if role in ("radiologist", "technician", "admin", "clinician")]
        return bool(app) and all(role == "clinician" for role in app)

    def viewer_items(self, route, target, query):
        self.item_requests.append((target, query))
        if set(query) - {"limit", "cursor", "includeHidden", "recheck"}:
            self.unexpected.append(f"viewer-items query {query}")
            route.abort()
            return
        if not self.clinician_session():
            # The writer route (viewer.service list): every head, hidden ones included; the panel's access probe reads one.
            if query == {"limit": ["1"]}:
                route.fulfill(json={"items": [], "nextCursor": None})
                return
            if query != {"includeHidden": ["true"], "limit": ["100"]}:
                self.unexpected.append(f"writer viewer-items query {query}")
                route.abort()
                return
            head = copy.deepcopy(WRITER_HEAD)
            head["authorSub"] = self.me["sub"]
            route.fulfill(json={"items": [head], "nextCursor": None})
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

    def release(self, route, payload):
        request = route.request
        route.fulfill(json=payload)
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
    def open_viewer(self, config=None, study=VA, uncancellable=False, enter=None):
        self.viewer_page = True
        self.config = CONFIG if config is None else config
        self.page.goto(VIEWER_URL)
        if uncancellable:
            # An answer already on the wire when the study changes: the panel aborts its reads on a study change, so the
            # harness drops the abort signal to let that answer arrive late, as it does once its response has started.
            self.page.evaluate("""() => { const real = window.fetch.bind(window);
              window.fetch = (url, options = {}) => { const { signal, ...rest } = options; return real(url, rest); }; }""")
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
