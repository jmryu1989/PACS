# coding: utf-8
"""TEST-S3-ASR-U4-HOST-DOM: the Dictate button, review pane and explicit Insert on the shipped page code.

REQ-S3-ASR-FIRST-PATH (asr-binding-contract.md §4-§7, §9 L2, §10)
  -> RISK-S3-ASR-SILENT-INSERT/STALE-INSERT/DUPLICATE-INSERT/LOST-TEXT/HELD-MICROPHONE/
     FALSE-AVAILABILITY/FOCUS-THEFT/LAYOUT-DISPLACEMENT
  -> TEST-S3-ASR-U4-HOST-DOM.

Everything that decides behaviour is shipped code: the report column markup and CSS, the editor gate,
the base-version/caret/selection blocks, the report block (placeBlock, citationGuards, stashReport),
the occupancy block, the real study move (select/refreshRight), the real updateReportButtons() and the
dictation wiring block are sliced out of main.html; report-citation.js, report-structure.js,
dictation-session.js, dictation-capture.js and dictation.js are served as files through the same
`<script src>` tags main.html carries. The page is served from http://127.0.0.1 through Playwright
routing, so it is a REAL secure context with real crypto.subtle; one case uses a non-loopback http
origin, which is a real insecure context.

Stand-ins, named: the media devices (AudioContext, AudioWorkletNode, getUserMedia, tracks) and the
network (fetch). These are CONTROL-FLOW proofs of the page integration only. No microphone, device,
worklet, engine or speech is exercised; real fake-device capture, track end and permission refusal in
pinned Chromium belong to S3-ASR-U4b, and the live refusal battery to U5.

`python tests/report_dictation_host_dom_test.py --static-only` runs the pure checks with no browser.
"""
import json
import os
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LITE = ROOT / "worklist-v0" / "hpacs-lite"
MAIN_PATH = Path(os.environ.get("KIN_DICTATION_HOST_MAIN", LITE / "main.html"))
HOST_PATH = Path(os.environ.get("KIN_DICTATION_HOST_JS", LITE / "dictation.js"))
MAIN = MAIN_PATH.read_text(encoding="utf-8")
ASSETS = {
    "report-citation.js": (LITE / "report-citation.js").read_text(encoding="utf-8"),
    "report-structure.js": (LITE / "report-structure.js").read_text(encoding="utf-8"),
    "dictation-session.js": (LITE / "dictation-session.js").read_text(encoding="utf-8"),
    "dictation-capture.js": (LITE / "dictation-capture.js").read_text(encoding="utf-8"),
    "dictation.js": HOST_PATH.read_text(encoding="utf-8"),
}
SECURE_ORIGIN = "http://127.0.0.1:8765"
INSECURE_ORIGIN = "http://dictation-insecure.test"
PAGE_PATH = "/worklist/hpacs-lite/harness.html"

UID = "1.2.3"
OTHER = "1.2.4"
EXISTING = "첫 줄\n둘째 줄\n셋째 줄"
OTHER_TEXT = "B 검사 소견"
# Leading space and an inner LF: the exact decoded string must reach the review and the report.
TRANSCRIPT = " 좌상엽에 8 mm 결절.\n추적 검사 권고"
DICTATE_TITLE = "음성 인식기가 연결되지 않았습니다."
CANCELLED = "취소됨(엔진 상태 미확인) — 판독문은 그대로입니다"
UNCHANGED = " — 판독문은 그대로입니다"
CAPABILITY = {"available": True, "maxBytes": 1048576, "timeoutMs": 120000, "languagePin": "auto",
              "enginePin": "whisper.cpp@927cfce34f31707e17f2bff35c349632fb9e2c3a",
              "modelPin": "ggml-small@sha256:1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"}
TEXT_CAP = 16384
MODULE_TAGS = ['<script src="report-structure.js"></script>', '<script src="dictation-session.js"></script>',
               '<script src="dictation-capture.js"></script>', '<script src="dictation.js"></script>']
FORBIDDEN = ("SpeechRecognition", "MediaRecorder", "getUserMedia", "mediaDevices")


def reply(text, **extra):
    body = {"text": text, "enginePin": CAPABILITY["enginePin"], "modelPin": CAPABILITY["modelPin"],
            "languagePin": "auto", "seconds": 0.25}
    body.update(extra)
    return json.dumps(body, ensure_ascii=False)


def slice_between(source, start_marker, end_marker):
    start = source.index(start_marker)
    end = source.index(end_marker, start + len(start_marker))
    return source[start:end]


def extract_function(source, name):
    """The shipped function, brace matched past a destructured parameter list."""
    start = source.index("function %s(" % name)
    if source[max(0, start - 6):start] == "async ":
        start -= 6
    depth, quote, escaped, open_brace = 0, None, False, -1
    index = source.index("(", start)
    while index < len(source):
        char = source[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
        elif char in "'\"`":
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                open_brace = source.index("{", index)
                break
        index += 1
    depth, quote, escaped, index = 0, None, False, open_brace
    while index < len(source):
        char = source[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
        elif char in "'\"`":
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
        index += 1
    raise AssertionError("unbalanced function %s" % name)


MARKERS = {
    "BASE_CSS": ("    * { box-sizing: border-box; }", "\n\n    /* ── 상단메뉴"),
    "PANEL_CSS": ("    .panel { display: flex;", "\n"),
    "REPORT_CSS": ("    /* Report */", "    .citefield {"),
    "MODAL_CSS": (".modal { display: none;", "/* ══ 클릭 피드백"),
    "RBTNS_HTML": ('<div class="rbtns">', "\n        </div>"),
    "BARS_HTML": ('<div class="draftbar" id="draftbar"', '<div id="citelist"'),
    # The citation list and the dictation pane, up to the report fields.
    "DICTATION_HTML": ('<div id="citelist"', '<div class="redit">'),
    "REDIT_HTML": ('<div class="redit">', "\n        </div>"),
    "RFOOT_HTML": ('<div class="rfoot2">', "\n        </div>"),
    "PANE_HTML": ('<div class="modal" id="stalemodal"', "\n  </div>"),
    "CITE_HTML": ('<div class="modal" id="cite-preview"', "\n  </div>"),
    "STRUCT_HTML": ('<div class="modal" id="structmodal"', "\n  </div>"),
    # Ends where the template filter listeners resume (main.html keeps the block beside the template
    # insertion path it mirrors).
    "DICTATION_BLOCK": ("    // ══════════ 받아쓰기 (S3-ASR-U4) ══════════",
                        '    $("#t-mod").addEventListener("change", renderTemplates);'),
    "BASE_BLOCK": ("    let selectionSeq = 0;", "    function reportSource()"),
    "REPORT_BLOCK": ("    function reportSource() {", "    function heldByOther(s)"),
    "HOLD_BLOCK": ("    // ══════════ 동시 판독 점유 (교훈 §2) ══════════",
                   "    // ══════════ 이탈 시 판독문 보존 (교훈 §1) ══════════"),
    "SELECT_BLOCK": ("    function select(uid, {", "    function renderClinical()"),
}
S = {name: slice_between(MAIN, *pair) for name, pair in MARKERS.items()}
for name in ("RBTNS_HTML", "REDIT_HTML", "RFOOT_HTML"):
    S[name] += "\n        </div>"
for name in ("PANE_HTML", "CITE_HTML", "STRUCT_HTML"):
    S[name] += "\n  </div>"
API_FN = extract_function(MAIN, "api")
WRITE_BLOCK_FN = extract_function(MAIN, "reportWriteBlock")
EDITOR_BLOCK_FN = extract_function(MAIN, "reportEditorBlock")
# The real one: it is where the page tells the dictation host that the report state changed.
BUTTONS_FN = extract_function(MAIN, "updateReportButtons")
GO_ONLINE_FN = extract_function(MAIN, "goOnline")
GO_OFFLINE_FN = extract_function(MAIN, "goOffline")

HARNESS = r"""<!doctype html><html><head><meta charset="utf-8"><style>
BASECSS
PANELCSS
REPORTCSS
MODALCSS
</style></head><body>
<div id="frame" style="display:flex;flex-direction:column;width:100%;height:100vh;min-height:0">
<div class="panel report-p">
RBTNSHTML
BARSHTML
DICTATIONHTML
REDITHTML
RFOOTHTML
</div>
</div>
PANEHTML
CITEHTML
STRUCTHTML
<script src="report-citation.js"></script>
<script>
/* Stand-ins: media devices and nothing else of the browser. Installed before the product loads. */
window.media = { mode: "grant", gumCalls: 0, contexts: [], tracks: [], commands: [], modules: [], grant: null };
class FakeAudioContext {
  constructor(options) { media.contexts.push(this); this.options = options; this.sampleRate = 16000;
    this.destination = {}; this.audioWorklet = { addModule: async path => { media.modules.push(path); } }; }
  async resume() {}
  async close() { this.closed = true; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}
class FakeWorkletNode {
  constructor(_context, name, options) { media.node = this; media.nodeName = name; media.nodeOptions = options;
    this.port = { postMessage: message => media.commands.push(message), close() {} }; }
  connect() {}
  disconnect() {}
}
function fakeStream() {
  const track = { readyState: "live", listeners: new Map(),
    addEventListener(name, fn) { this.listeners.set(name, fn); }, removeEventListener(name) { this.listeners.delete(name); },
    stop() { this.readyState = "ended"; } };
  media.tracks.push(track);
  return { getTracks: () => [track], getAudioTracks: () => [track] };
}
Object.defineProperty(window, "AudioContext", { configurable: true, writable: true, value: FakeAudioContext });
Object.defineProperty(window, "AudioWorkletNode", { configurable: true, writable: true, value: FakeWorkletNode });
Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async constraints => {
  media.gumCalls += 1; media.constraints = constraints;
  if (media.mode === "deny") throw new DOMException("denied", "NotAllowedError");
  if (media.mode === "hold") return new Promise(resolve => { media.grant = () => resolve(fakeStream()); });
  return fakeStream();
} } });
window.deliverPcm = bytes => media.node.port.onmessage({ data: { type: "pcm", buffer: Uint8Array.from(bytes).buffer } });
window.endTrack = () => media.tracks[media.tracks.length - 1].listeners.get("ended")();
window.released = () => media.tracks.length > 0 && media.tracks.every(t => t.readyState === "ended") &&
  media.contexts.every(c => c.closed);
</script>
<script src="report-structure.js"></script>
<script src="dictation-session.js"></script>
<script src="dictation-capture.js"></script>
<script src="dictation.js"></script>
<script>
const $ = s => document.querySelector(s);
const esc = v => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const RFIELDS = ["findings", "conclusion", "recommendation"];
const API = "/api";
let serverMode = true, offline = false, demoMode = false;
let selectedUid = "UIDVALUE", user = "doctor@kin";
let appState = INITIALSTATE;
let studies = [{uid: "UIDVALUE", name: "HONG GILDONG", id: "P-1", date: "2026-09-23", acc: "A1", desc: "Chest CT",
                rs: "T", ss: "Verified", em: "N"},
               {uid: "OTHERVALUE", name: "KIM CHULSOO", id: "P-2", date: "2026-09-23", acc: "A2", desc: "Brain CT",
                rs: "T", ss: "Verified", em: "N"}];
let calls = [], holdCalls = [], citeCalls = [], structCalls = [], dictCalls = [];
let replies = [], toasts = [], confirms = [], logouts = 0;
const studyPriority = { get: () => false };
const KinAuth = { has: () => true, logout: async () => { logouts += 1; } };
const reportPreview = { close() {} };
const displayActor = value => String(value ?? "").split("@")[0];
function cur() { return studies.find(s => s.uid === selectedUid); }
function heldByOther(s) { return s?.holder && s.holder !== user ? s.holder : null; }
function shownStudyDesc(s) { return s?.desc ?? ""; }
function today() { return "2026-09-23"; }
function saveApp() {}
function syncStudy() {}
function render() {}
function renderRelated() {}
function updateReportTemplateButton() {}
function updateTemplatePreview() {}
function toast(message, kind) { toasts.push({ message, kind }); }
function apiFail(e) { toast("서버 저장 실패: " + e.message, "err"); }
// What the real study move reaches for besides the report; inert here.
let templateEditor = null, reasonResolve = null, relatedUid = null, relatedReportSeq = 0;
let relatedModality = "", relatedBodyPart = "", relatedIncludeCurrent = false, mode = "Reading";
function closeTemplateEditor() {}
function closeTemplatePreview() {}
function clearRelatedReport() {}
function loadRelatedReport() {}
function renderClinical() {}
function renderThumbs() {}
function renderTemplates() {}
function renderOrders() {}
function openFilmbox() {}
const relatedParts = { reset() {} };
const readingWorkspace = { active: () => false, selectionChanged() {} };
const readingFindings = { sync() {} };
const imageOpening = { snapshot: () => ({ autoLoad: false }) };
window.confirm = message => { confirms.push(message); return false; };
window.fetch = async (url, options = {}) => {
  const path = String(url).slice(API.length);
  if (path.endsWith("/dictation")) {
    const body = options.body;
    /* Recorded at the moment fetch() is called, which is when a real fetch copies the body. */
    const call = { method: options.method, path, headers: { ...(options.headers ?? {}) }, redirect: options.redirect,
      credentials: options.credentials, cache: options.cache, bytes: Array.from(body), body, aborted: false };
    dictCalls.push(call);
    return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => { call.aborted = true; reject(new DOMException("aborted", "AbortError")); });
      call.respond = (status, raw) => resolve({ status, ok: status >= 200 && status < 300, text: async () => raw,
                                                json: async () => JSON.parse(raw) });
    });
  }
  const record = { method: options.method ?? "GET", path, keepalive: !!options.keepalive,
                   body: options.body ? JSON.parse(options.body) : null };
  if (path.endsWith("/hold") || path.endsWith("/release")) {
    holdCalls.push(record);
    return { ok: true, status: 200, json: async () => ({ holder: user, conflict: false }) };
  }
  if (path.endsWith("/report/citations")) {
    citeCalls.push(record);
    return { ok: true, status: 200, json: async () => ({ version: 1, head: [], draft: [] }) };
  }
  if (path.endsWith("/report/structure")) {
    structCalls.push(record);
    return { ok: true, status: 200, json: async () => ({ version: 0, unknown: false, head: [], draft: [] }) };
  }
  calls.push(record);
  const answer = replies.shift() ?? { status: 200, body: {} };
  return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
};
APIFN
WRITEBLOCKFN
EDITORBLOCKFN
DICTATIONBLOCK
BASEBLOCK
REPORTBLOCK
BUTTONSFN
HOLDBLOCK
SELECTBLOCK
window.load = options => loadReport(options);
window.stash = () => stashReport();
window.put = (field, start, end) => { const el = $("#" + field); el.setSelectionRange(start, end === undefined ? start : end); };
window.answer = (index, status, raw) => { dictCalls[index].respond(status, raw); return true; };
window.expected = (value, text, start, end) =>
  KinReportCitation.placeBlock(value, KinReportCitation.toLf(text), { start, end }, []).text;
const hdControl = id => { const el = $("#dictation-" + id); return { hidden: el.hidden, disabled: el.disabled }; };
const hdBox = el => { if (!el) return null; const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width }; };
window.boxes = () => ({ rbtns: hdBox($(".rbtns")), pane: hdBox($("#dictation-pane")), redit: hdBox($(".redit")),
  rfoot: hdBox($(".rfoot2")), frame: hdBox($("#frame")),
  fields: Object.fromEntries(RFIELDS.map(k => [k, { ...hdBox($("#" + k)), min: parseFloat(getComputedStyle($("#" + k)).minHeight) }])) });
window.hits = () => Object.fromEntries(["insert", "cancel"].map(id => {
  const el = $("#dictation-" + id), r = el.getBoundingClientRect();
  return [id, document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === el];
}));
window.snapshot = () => {
  const s = dictation.snapshot();
  return {
    text: RFIELDS.map(k => $("#" + k).value),
    caret: Object.fromEntries(RFIELDS.map(k => [k, [$("#" + k).selectionStart, $("#" + k).selectionEnd]])),
    calls: structuredClone(calls), holdCalls: structuredClone(holdCalls), toasts: structuredClone(toasts),
    dict: dictCalls.map(c => ({ method: c.method, path: c.path, headers: c.headers, redirect: c.redirect,
      credentials: c.credentials, cache: c.cache, length: c.bytes.length,
      riff: String.fromCharCode(...c.bytes.slice(0, 4)), wave: String.fromCharCode(...c.bytes.slice(8, 12)),
      pcm: c.bytes.slice(44), zeroed: c.body.every(b => b === 0), aborted: c.aborted })),
    session: { state: s.state, asrSeq: s.asrSeq, needsRepin: s.needsRepin, error: s.error,
               cleanupFailed: s.cleanupFailed, text: s.text,
               pin: s.pin ? { uid: s.pin.uid, selectionSeq: s.pin.selectionSeq, baseVersion: s.pin.baseVersion,
                              field: s.pin.field, caret: [s.pin.caret.start, s.pin.caret.end] } : null },
    pane: { hidden: $("#dictation-pane").hidden, status: $("#dictation-status").textContent,
            text: $("#dictation-text").textContent, textHidden: $("#dictation-text").hidden,
            place: $("#dictation-place").textContent, meta: $("#dictation-meta").textContent,
            metaTitle: $("#dictation-meta").getAttribute("title"),
            stop: hdControl("stop"), cancel: hdControl("cancel"), repin: hdControl("repin"),
            insert: hdControl("insert"), close: hdControl("close") },
    button: { disabled: $("#b-dictate").disabled, title: $("#b-dictate").getAttribute("title"),
              text: $("#b-dictate").textContent.trim(), outer: $("#b-dictate").outerHTML },
    focused: document.activeElement ? document.activeElement.id : null,
    media: { gum: media.gumCalls, released: released(), commands: media.commands.slice(), modules: media.modules.slice(),
             constraints: media.constraints ?? null, contexts: media.contexts.length },
    secure: window.isSecureContext, seq: selectionSeq, base: reportBaseVersion(selectedUid, -1), logouts,
  };
};
</script></body></html>"""


def default_state():
    return {UID: {"version": 1, "rs": "T", "ss": "Verified",
                  "draft": {"findings": EXISTING, "conclusion": "", "recommendation": "", "baseVersion": 1}},
            OTHER: {"version": 0, "rs": "T", "ss": "Verified", "findings": OTHER_TEXT, "conclusion": "",
                    "recommendation": "", "draft": None}}


def harness(state):
    page = HARNESS
    for key, name in (("BASECSS", "BASE_CSS"), ("PANELCSS", "PANEL_CSS"), ("REPORTCSS", "REPORT_CSS"),
                      ("MODALCSS", "MODAL_CSS"), ("RBTNSHTML", "RBTNS_HTML"), ("BARSHTML", "BARS_HTML"),
                      ("DICTATIONHTML", "DICTATION_HTML"), ("REDITHTML", "REDIT_HTML"),
                      ("RFOOTHTML", "RFOOT_HTML"), ("PANEHTML", "PANE_HTML"), ("CITEHTML", "CITE_HTML"),
                      ("STRUCTHTML", "STRUCT_HTML"), ("DICTATIONBLOCK", "DICTATION_BLOCK"),
                      ("BASEBLOCK", "BASE_BLOCK"), ("REPORTBLOCK", "REPORT_BLOCK"),
                      ("HOLDBLOCK", "HOLD_BLOCK"), ("SELECTBLOCK", "SELECT_BLOCK")):
        page = page.replace(key, S[name])
    return (page.replace("APIFN", API_FN).replace("WRITEBLOCKFN", WRITE_BLOCK_FN)
            .replace("EDITORBLOCKFN", EDITOR_BLOCK_FN).replace("BUTTONSFN", BUTTONS_FN)
            .replace("INITIALSTATE", json.dumps(state, ensure_ascii=False))
            .replace("UIDVALUE", UID).replace("OTHERVALUE", OTHER))


def script_selectors():
    found = set()
    for block in (S["DICTATION_BLOCK"], S["BASE_BLOCK"], S["REPORT_BLOCK"], S["HOLD_BLOCK"], S["SELECT_BLOCK"],
                  BUTTONS_FN):
        for match in re.finditer(r"""\$\(\s*["']#([A-Za-z0-9_-]+)["']\s*\)""", block):
            found.add(match.group(1))
    return found


def static_report():
    """Pure pins: the slices, the hooks the page depends on and the capture-name boundary."""
    problems = []
    for name, (start, _end) in MARKERS.items():
        if name == "PANEL_CSS":
            continue
        if MAIN.count(start) != 1:
            problems.append("slice marker %s occurs %d times" % (name, MAIN.count(start)))
    ids = set(re.findall(r"""\sid=["']([A-Za-z0-9_-]+)["']""", harness(default_state())))
    missing = sorted(s for s in script_selectors() if s not in ids and s != "b-structured")
    if missing:
        problems.append("harness markup is missing %s" % ", ".join(missing))
    positions = [MAIN.find(tag) for tag in MODULE_TAGS]
    if min(positions) < 0 or positions != sorted(positions):
        problems.append("main.html must load report-structure, session, capture and host in that order")
    for tag in MODULE_TAGS[1:]:
        if tag not in HARNESS:
            problems.append("the harness must load %s exactly as main.html does" % tag)
    if "dictation.refresh();" not in BUTTONS_FN:
        problems.append("updateReportButtons() must hand report-state changes to the dictation host")
    if "updateReportButtons();" not in S["SELECT_BLOCK"] or "loadReport({ force: forceReport });" not in S["SELECT_BLOCK"]:
        problems.append("the study move no longer reaches updateReportButtons() through refreshRight()")
    if "dictation.setServerCapability(b.dictation);" not in GO_ONLINE_FN:
        problems.append("goOnline() must pass the bootstrap capability to the dictation host")
    if "dictation.refresh();" not in GO_OFFLINE_FN:
        problems.append("goOffline() must let the dictation host release an active recording")
    if 'window.addEventListener("pagehide", () => dictation.pageExit());' not in S["DICTATION_BLOCK"]:
        problems.append("page exit must end an active dictation")
    autosave = slice_between(MAIN, "    const AUTOSAVE_MS = 20000;", "    }, AUTOSAVE_MS);")
    if "stashReport();" not in autosave:
        problems.append("the autosave interval no longer calls stashReport(), so stash() is not its stand-in")
    if "KinReportCitation.placeBlock(" not in S["DICTATION_BLOCK"] or "citationGuards(ins.field)" not in S["DICTATION_BLOCK"]:
        problems.append("the insertion must reuse placeBlock with the citation guards")
    if S["DICTATION_BLOCK"].count('dispatchEvent(new Event("input", { bubbles: true }))') != 1:
        problems.append("the insertion must raise exactly one input event")
    # Hook sites executed by other suites' harnesses must stay free of the host (see contract §3.4).
    for name, text in (("select/refreshRight", S["SELECT_BLOCK"]),
                       ("logout", slice_between(MAIN, "    // ② 로그아웃", "    // 다른 사람이 잡거나 놓은 걸")),
                       ("unload", slice_between(MAIN, "    const AUTOSAVE_MS = 20000;", "    // ② 로그아웃")),
                       ("report block", S["REPORT_BLOCK"]), ("base block", S["BASE_BLOCK"]),
                       ("hold block", S["HOLD_BLOCK"])):
        if "dictation" in text.lower():
            problems.append("%s is executed by other suites and must not reference the dictation host" % name)
    if 'title="%s"' % DICTATE_TITLE not in S["RBTNS_HTML"]:
        problems.append("the Dictate button's unavailable title moved")
    host = ASSETS["dictation.js"]
    for name, text in (("main.html", MAIN), ("report-citation.js", ASSETS["report-citation.js"]),
                       ("report-structure.js", ASSETS["report-structure.js"])):
        for word in FORBIDDEN:
            if word in text:
                problems.append("%s must not contain %s" % (name, word))
    if "getUserMedia" not in host or "isSecureContext" not in host:
        problems.append("the capture capability check belongs in dictation.js")
    for word in ("createObjectURL", "localStorage", "sessionStorage", "indexedDB", "console."):
        if word in host:
            problems.append("dictation.js must not use %s" % word)
    if "innerHTML" in host:
        problems.append("dictation.js writes text through textContent only")
    cases = sorted(n for n in dir(ReportDictationHostDOMTest) if n.startswith("test_hd"))
    if [c[:9] for c in cases] != ["test_hd%02d" % n for n in range(len(cases))]:
        problems.append("HD ids must stay dense and stable")
    return problems, cases


class ReportDictationHostDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls._pw = sync_playwright().start()
        cls.browser = cls._pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls._pw.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={"width": 1680, "height": 1100})
        self.opened = False
        self.errors = []
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))

    def tearDown(self):
        started = self.opened and self.page.evaluate("()=>typeof window.snapshot === 'function'")
        self.page.close()
        if self.opened:
            self.assertTrue(started, "HARNESS DID NOT START: %s" % self.errors[:2])
        self.assertEqual([], self.errors, "the product region raised in the browser")

    # ── helpers ────────────────────────────────────────────────────────────────────────────
    def _route(self, route):
        name = route.request.url.split("?")[0].rsplit("/", 1)[-1]
        if name == "harness.html":
            route.fulfill(status=200, headers={"Content-Type": "text/html; charset=utf-8"}, body=self.html)
        elif name in ASSETS:
            route.fulfill(status=200, headers={"Content-Type": "text/javascript; charset=utf-8"}, body=ASSETS[name])
        else:
            route.fulfill(status=404, body="")

    def open(self, capability=CAPABILITY, origin=SECURE_ORIGIN, state=None, media="grant"):
        self.html = harness(state or default_state())
        self.page.route(origin + "/**", self._route)
        self.page.goto(origin + PAGE_PATH)
        self.opened = True
        self.page.wait_for_function("()=>typeof window.snapshot === 'function'")
        self.page.evaluate("m => { media.mode = m; }", media)
        self.page.evaluate("load({force:true})")
        self.page.wait_for_function("()=>citeCalls.length>=1 && structCalls.length>=1")
        self.page.evaluate("()=>{ calls.length = 0; holdCalls.length = 0; toasts.length = 0; }")
        if capability is not None:
            # What goOnline() does with the bootstrap, followed by the page's own gate pass.
            self.page.evaluate("c => dictation.setServerCapability(c)", capability)
        self.page.evaluate("updateReportButtons()")
        return self.snap()

    def snap(self):
        return self.page.evaluate("snapshot()")

    def wait_state(self, state):
        self.page.wait_for_function("s => dictation.snapshot().state === s", arg=state)

    def caret(self, field, position):
        self.page.focus("#" + field)
        self.page.evaluate("([f, p]) => put(f, p)", [field, position])

    def record(self):
        """Dictate -> permission -> recording, through the real button."""
        self.page.click("#b-dictate")
        self.wait_state("recording")

    def upload(self, pcm=(1, 0, 255, 127)):
        """Returns the index of this run's request; counters are cumulative over one page."""
        commands, sent = self.page.evaluate("()=>[media.commands.length, dictCalls.length]")
        self.record()
        self.page.click("#dictation-stop")
        self.page.wait_for_function("n => media.commands.length === n", arg=commands + 1)
        self.page.evaluate("b => deliverPcm(b)", list(pcm))
        self.page.wait_for_function("n => dictCalls.length === n", arg=sent + 1)
        self.wait_state("uploading")
        return sent

    def review(self, text=TRANSCRIPT):
        index = self.upload()
        self.page.evaluate("([i, s, r]) => answer(i, s, r)", [index, 200, reply(text)])
        self.wait_state("review")

    def puts(self):
        return [c for c in self.snap()["calls"] if c["method"] == "PUT"]

    # ── HD-00 ──────────────────────────────────────────────────────────────────────────────
    def test_hd00_the_slices_hooks_and_boundaries_this_file_stands_on(self):
        problems, cases = static_report()
        self.assertEqual([], problems)
        self.assertEqual(16, len(cases))

    # ── HD-01 ──────────────────────────────────────────────────────────────────────────────
    def test_hd01_unavailable_by_default_and_when_malformed_says_what_is_true(self):
        before = self.open(capability=None)
        self.assertTrue(before["secure"], "the harness origin must be a real secure context")
        # The element as the browser built it from the shipped markup (a boolean attribute serialises
        # as disabled=""), before any capability was ever applied: every state below must equal it.
        markup = before["button"]["outer"]
        self.assertIn('title="%s"' % DICTATE_TITLE, markup)
        self.assertTrue(markup.endswith(">Dictate</button>"))
        for capability in (None, dict(CAPABILITY, available=False), dict(CAPABILITY, available="true"),
                           dict(CAPABILITY, maxBytes=2000000), {"available": True}):
            if capability is not None:
                self.page.evaluate("c => { dictation.setServerCapability(c); updateReportButtons(); }", capability)
            value = self.snap()
            self.assertEqual(markup, value["button"]["outer"], "character for character: %r" % (capability,))
            self.assertTrue(value["button"]["disabled"])
            self.assertEqual(DICTATE_TITLE, value["button"]["title"])
            self.assertTrue(value["pane"]["hidden"])
        self.page.evaluate("()=>$('#b-dictate').click()")
        value = self.snap()
        self.assertEqual(0, value["media"]["gum"], "no permission request")
        self.assertEqual([], value["dict"])
        self.assertEqual([], value["toasts"])
        self.assertEqual("unavailable", value["session"]["state"])

    # ── HD-02 ──────────────────────────────────────────────────────────────────────────────
    def test_hd02_an_insecure_origin_cannot_record_even_when_the_server_says_available(self):
        value = self.open(origin=INSECURE_ORIGIN)
        self.assertFalse(value["secure"], "a non-loopback http page is not a secure context")
        self.assertTrue(value["button"]["disabled"])
        self.assertEqual(self.page.evaluate("KinDictation.TITLES.browser"), value["button"]["title"])
        self.page.evaluate("()=>$('#b-dictate').click()")
        self.assertEqual(0, self.snap()["media"]["gum"])

    # ── HD-03 ──────────────────────────────────────────────────────────────────────────────
    def test_hd03_review_then_explicit_insert_at_the_caret_and_exactly_one_autosave(self):
        value = self.open()
        self.assertFalse(value["button"]["disabled"])
        self.assertEqual(self.page.evaluate("KinDictation.TITLES.ready"), value["button"]["title"])
        self.assertEqual("Dictate", value["button"]["text"])
        self.caret("findings", 3)                           # end of "첫 줄"
        self.record()
        value = self.snap()
        self.assertEqual(1, value["media"]["gum"])
        self.assertEqual(["./dictation-worklet.js"], value["media"]["modules"])
        self.assertFalse(value["pane"]["hidden"])
        self.assertEqual({"hidden": False, "disabled": False}, value["pane"]["stop"])
        self.assertEqual({"uid": UID, "selectionSeq": value["seq"], "baseVersion": 1, "field": "findings",
                          "caret": [3, 3]}, value["session"]["pin"])
        self.page.click("#dictation-stop")
        self.page.wait_for_function("()=>media.commands.length === 1")
        self.page.evaluate("b => deliverPcm(b)", [1, 0, 255, 127])
        self.page.wait_for_function("()=>dictCalls.length === 1")
        call = self.snap()["dict"][0]
        self.assertEqual({"method": "POST", "path": "/studies/%s/dictation" % UID,
                          "headers": {"Content-Type": "audio/wav", "X-KIN-CSRF": "1"}, "redirect": "error",
                          "credentials": "same-origin", "cache": "no-store"},
                         {k: call[k] for k in ("method", "path", "headers", "redirect", "credentials", "cache")})
        self.assertEqual(("RIFF", "WAVE", 48, [1, 0, 255, 127]), (call["riff"], call["wave"], call["length"], call["pcm"]))
        self.assertTrue(call["zeroed"], "the page keeps no audio once fetch() has the bytes")
        self.assertTrue(self.snap()["media"]["released"], "tracks and context are released once recorded")
        self.page.evaluate("([i, s, r]) => answer(i, s, r)", [0, 200, reply(TRANSCRIPT)])
        self.wait_state("review")
        value = self.snap()
        self.assertEqual(TRANSCRIPT, value["pane"]["text"], "exact decoded text in the review pane")
        self.assertEqual("삽입 위치: Findings 칸 2번째 줄(줄바꿈 기준)부터", value["pane"]["place"])
        self.assertIn("언어 설정 auto(감지된 언어 아님)", value["pane"]["meta"])
        self.assertNotIn("whisper", value["pane"]["meta"], "configured labels are not shown as attestation")
        self.assertIn("증명하지 않습니다", value["pane"]["metaTitle"])
        self.assertEqual([EXISTING, "", ""], value["text"], "a response alone never changes the report")
        self.assertEqual([], value["calls"])
        self.assertEqual([], value["holdCalls"])
        expected = self.page.evaluate("([v, t]) => expected(v, t, 3, 3)", [EXISTING, TRANSCRIPT])
        self.assertEqual("첫 줄\n" + TRANSCRIPT + "\n둘째 줄\n셋째 줄", expected)
        self.page.click("#dictation-insert")
        self.page.wait_for_function("()=>dictation.snapshot().state === 'inserted'")
        value = self.snap()
        self.assertEqual([expected, "", ""], value["text"])
        end = len("첫 줄\n" + TRANSCRIPT)
        self.assertEqual([end, end], value["caret"]["findings"], "the caret stands after the inserted text")
        self.assertEqual("findings", value["focused"])
        self.assertTrue(value["pane"]["hidden"])
        self.assertEqual([], value["calls"], "Insert itself writes nothing; autosave carries it")
        self.assertEqual(["ok"], [t["kind"] for t in value["toasts"]])
        self.page.wait_for_function("()=>holdCalls.length === 1")
        self.page.evaluate("stash()")
        self.page.wait_for_function("()=>calls.length === 1")
        self.assertEqual(expected, self.puts()[0]["body"]["findings"])
        self.page.evaluate("stash()")
        self.page.wait_for_timeout(50)
        self.assertEqual(1, len(self.puts()), "exactly one autosave write")
        self.assertEqual(1, len(self.snap()["holdCalls"]), "occupancy claimed once, as typing does")

    # ── HD-04 ──────────────────────────────────────────────────────────────────────────────
    def test_hd04_permission_refusal_fails_once_and_leaves_the_report(self):
        self.open(media="deny")
        self.page.click("#b-dictate")
        self.wait_state("failed")
        value = self.snap()
        message = self.page.evaluate("KinDictation.REASONS.DICTATION_CAPTURE_DENIED") + UNCHANGED
        self.assertEqual(message, value["pane"]["status"])
        self.assertEqual(2, value["session"]["asrSeq"], "begin and ONE end: the callback and rejection were one failure")
        self.assertEqual({"hidden": False, "disabled": False}, value["pane"]["close"])
        self.assertEqual([EXISTING, "", ""], value["text"])
        self.assertEqual([], value["dict"])
        self.assertFalse(value["button"]["disabled"], "a new attempt is possible")
        self.page.click("#dictation-close")
        self.assertTrue(self.snap()["pane"]["hidden"])

    # ── HD-05 ──────────────────────────────────────────────────────────────────────────────
    def test_hd05_an_edited_field_keeps_the_text_and_needs_a_click_repin_and_a_fresh_insert(self):
        self.open()
        self.caret("findings", 3)
        self.review()
        self.caret("findings", len(EXISTING))
        self.page.keyboard.type("추가")
        edited = EXISTING + "추가"
        self.assertIn("위치를 다시 고정하라고", self.snap()["pane"]["place"])
        self.page.click("#dictation-insert")
        self.page.wait_for_function("()=>dictation.snapshot().needsRepin === true")
        value = self.snap()
        self.assertEqual([edited, "", ""], value["text"], "the refused Insert changed nothing")
        self.assertEqual(TRANSCRIPT, value["pane"]["text"], "the review text is kept")
        self.assertEqual(self.page.evaluate("KinDictation.NOTICES['field-changed']"), value["pane"]["status"])
        self.assertTrue(value["pane"]["insert"]["disabled"])
        self.assertFalse(value["pane"]["repin"]["hidden"])
        # The explicit gesture: a click inside the chosen field. It re-pins and does NOT insert.
        self.page.click("#findings", position={"x": 12, "y": 8})
        self.page.wait_for_function("()=>dictation.snapshot().needsRepin === false")
        value = self.snap()
        start, end = value["caret"]["findings"]
        self.assertEqual([start, end], value["session"]["pin"]["caret"])
        self.assertEqual([edited, "", ""], value["text"], "re-pinning never inserts")
        self.assertEqual(self.page.evaluate("KinDictation.NOTICES.repinned"), value["pane"]["status"])
        self.assertFalse(value["pane"]["insert"]["disabled"])
        expected = self.page.evaluate("([v, t, s, e]) => expected(v, t, s, e)", [edited, TRANSCRIPT, start, end])
        self.page.click("#dictation-insert")
        self.wait_state("inserted")
        self.assertEqual([expected, "", ""], self.snap()["text"])

    # ── HD-06 ──────────────────────────────────────────────────────────────────────────────
    def test_hd06_a_changed_base_or_a_newly_read_only_field_refuses_and_invalidates(self):
        for change in ("recordReportOrigin(%s, 2)" % json.dumps(UID),
                       "(() => { appState[%s].holder = 'other@kin'; studies[0].holder = 'other@kin'; "
                       "updateReportButtons(); })()" % json.dumps(UID)):
            if self.opened:
                self.tearDown()
                self.setUp()
            self.open()
            self.caret("findings", 3)
            self.review()
            self.page.evaluate(change)
            self.page.click("#dictation-insert")
            self.wait_state("failed")
            value = self.snap()
            self.assertEqual(self.page.evaluate("KinDictation.REASONS['editor-changed']") + UNCHANGED,
                             value["pane"]["status"], change)
            self.assertEqual([EXISTING, "", ""], value["text"])
            self.assertEqual("", value["session"]["text"])
            self.assertEqual([], [c for c in value["calls"] if c["method"] == "PUT"])

    # ── HD-07 ──────────────────────────────────────────────────────────────────────────────
    def test_hd07_a_study_move_ends_the_session_and_the_late_answer_is_dropped(self):
        self.open()
        self.caret("findings", 3)
        self.upload()
        self.page.evaluate("select(%s)" % json.dumps(OTHER))       # the shipped study move
        self.wait_state("cancelled")
        value = self.snap()
        self.assertTrue(value["dict"][0]["aborted"])
        self.assertEqual(self.page.evaluate("KinDictation.REASONS['study-changed']") + UNCHANGED,
                         value["pane"]["status"])
        self.assertEqual([OTHER_TEXT, "", ""], value["text"])
        self.page.evaluate("([i, s, r]) => answer(i, s, r)", [0, 200, reply(TRANSCRIPT)])
        self.page.evaluate("select(%s)" % json.dumps(UID))          # A -> B -> A
        self.page.wait_for_timeout(50)
        value = self.snap()
        self.assertEqual("cancelled", value["session"]["state"])
        self.assertEqual([EXISTING, "", ""], value["text"], "nothing from the late answer reached the report")
        self.assertNotIn(TRANSCRIPT, json.dumps(value["calls"], ensure_ascii=False))

    # ── HD-08 ──────────────────────────────────────────────────────────────────────────────
    def test_hd08_review_is_dropped_by_an_a_b_a_move_and_cancel_is_honest(self):
        self.open()
        self.review()
        self.page.evaluate("select(%s)" % json.dumps(OTHER))
        self.page.evaluate("select(%s)" % json.dumps(UID))
        value = self.snap()
        self.assertEqual("cancelled", value["session"]["state"])
        self.assertTrue(value["pane"]["insert"]["hidden"], "an old session cannot be revived by coming back")
        self.assertEqual([EXISTING, "", ""], value["text"])
        self.page.click("#dictation-close")
        self.upload()
        self.page.click("#dictation-cancel")
        self.wait_state("cancelled")
        value = self.snap()
        self.assertEqual(CANCELLED, value["pane"]["status"])
        self.assertTrue(value["dict"][-1]["aborted"])
        self.page.evaluate("([i, s, r]) => answer(i, s, r)", [1, 200, reply(TRANSCRIPT)])
        self.page.wait_for_timeout(50)
        self.assertEqual("cancelled", self.snap()["session"]["state"])
        self.assertEqual([EXISTING, "", ""], self.snap()["text"])

    # ── HD-09 ──────────────────────────────────────────────────────────────────────────────
    def test_hd09_the_capture_cap_sends_without_stop_and_page_exit_releases(self):
        self.open()
        self.record()
        self.page.evaluate("b => deliverPcm(b)", [9, 0])
        self.page.wait_for_function("()=>dictCalls.length === 1")
        value = self.snap()
        self.assertEqual([], value["media"]["commands"], "no Stop was needed")
        self.assertEqual(self.page.evaluate("KinDictation.STATUS.capped"), value["pane"]["status"])
        self.page.evaluate("()=>window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))")
        self.wait_state("cancelled")
        value = self.snap()
        self.assertTrue(value["dict"][0]["aborted"])
        self.assertTrue(value["media"]["released"])

    # ── HD-10 ──────────────────────────────────────────────────────────────────────────────
    def test_hd10_a_device_that_ends_while_stopping_is_one_failure_with_one_message(self):
        self.open()
        self.record()
        self.page.click("#dictation-stop")
        self.page.wait_for_function("()=>media.commands.length === 1")
        self.page.evaluate("endTrack()")
        self.wait_state("failed")
        value = self.snap()
        self.assertEqual(self.page.evaluate("KinDictation.REASONS.DICTATION_CAPTURE_FAILED") + UNCHANGED,
                         value["pane"]["status"])
        self.assertEqual(2, value["session"]["asrSeq"])
        self.assertEqual([], value["dict"])
        self.assertTrue(value["media"]["released"])

    # ── HD-11 ──────────────────────────────────────────────────────────────────────────────
    def test_hd11_server_refusals_without_json_and_route_codes_leave_the_report(self):
        for status, raw, key in ((413, "<html><body>413 Request Entity Too Large</body></html>",
                                  "DICTATION_AUDIO_TOO_LARGE"),
                                 (503, '{"code":"DICTATION_BUSY","message":"DICTATION_BUSY"}', "DICTATION_BUSY"),
                                 (200, reply("x" * (TEXT_CAP + 1)), "transcript-too-long")):
            if self.opened:
                self.tearDown()
                self.setUp()
            self.open()
            self.upload()
            self.page.evaluate("([i, s, r]) => answer(i, s, r)", [0, status, raw])
            self.wait_state("failed")
            value = self.snap()
            self.assertEqual(self.page.evaluate("k => KinDictation.REASONS[k]", key) + UNCHANGED,
                             value["pane"]["status"])
            self.assertEqual([EXISTING, "", ""], value["text"])

    # ── HD-12 ──────────────────────────────────────────────────────────────────────────────
    def test_hd12_keyboard_reaches_every_step_and_an_arriving_answer_never_takes_focus(self):
        self.open()
        self.page.focus("#b-dictate")
        self.page.keyboard.press("Enter")
        self.wait_state("recording")
        self.assertEqual("dictation-stop", self.snap()["focused"], "the pane's own step: Stop, not Cancel")
        self.page.keyboard.press("Enter")
        self.page.wait_for_function("()=>media.commands.length === 1")
        self.assertEqual("dictation-cancel", self.snap()["focused"])
        self.page.evaluate("b => deliverPcm(b)", [1, 0])
        self.page.wait_for_function("()=>dictCalls.length === 1")
        self.page.evaluate("([i, s, r]) => answer(i, s, r)", [0, 200, reply(TRANSCRIPT)])
        self.wait_state("review")
        self.assertEqual("dictation-text", self.snap()["focused"], "the transcript is read before Insert")
        self.page.keyboard.press("Tab")
        self.assertEqual("dictation-cancel", self.snap()["focused"])
        self.page.keyboard.press("Tab")
        self.assertEqual("dictation-insert", self.snap()["focused"])
        self.page.keyboard.press("Enter")
        self.wait_state("inserted")
        self.assertEqual("findings", self.snap()["focused"])
        # A second run: the reader goes back to typing while the answer is out.
        self.page.focus("#b-dictate")
        self.page.keyboard.press("Enter")
        self.wait_state("recording")
        self.page.keyboard.press("Enter")
        self.page.wait_for_function("()=>media.commands.length === 2")
        self.page.evaluate("b => deliverPcm(b)", [1, 0])
        self.page.wait_for_function("()=>dictCalls.length === 2")
        self.page.click("#conclusion")
        self.page.evaluate("([i, s, r]) => answer(i, s, r)", [1, 200, reply("둘째 받아쓰기")])
        self.wait_state("review")
        self.assertEqual("conclusion", self.snap()["focused"], "an arriving answer must not steal the keyboard")
        self.page.focus("#dictation-text")
        self.page.keyboard.press("Escape")
        self.wait_state("cancelled")
        self.assertEqual(CANCELLED, self.snap()["pane"]["status"])
        self.page.keyboard.press("Escape")
        self.assertTrue(self.snap()["pane"]["hidden"])
        self.assertEqual("b-dictate", self.snap()["focused"])

    # ── HD-13 ──────────────────────────────────────────────────────────────────────────────
    def test_hd13_the_pane_is_bounded_and_the_report_layout_is_unchanged_at_both_viewports(self):
        for width, height, frame in ((1680, 1100, None), (1366, 768, None), (1366, 768, (460, 420))):
            if self.opened:
                self.tearDown()
                self.setUp()
            self.page.set_viewport_size({"width": width, "height": height})
            self.open()
            if frame:
                self.page.evaluate("([w, h]) => { const f = $('#frame'); f.style.width = w + 'px'; f.style.height = h + 'px'; }",
                                   list(frame))
            self.page.evaluate("()=>new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
            hidden = self.page.evaluate("boxes()")
            self.assertEqual(0, hidden["pane"]["height"], "a hidden pane takes no room")
            self.review("가" * TEXT_CAP)
            opened = self.page.evaluate("boxes()")
            where = "%dx%d frame=%s" % (width, height, frame)
            self.assertLessEqual(opened["pane"]["height"], 168.5, where)
            self.assertLessEqual(opened["rbtns"]["bottom"], opened["pane"]["top"] + 0.5, where)
            self.assertLessEqual(opened["pane"]["bottom"], opened["redit"]["top"] + 0.5, where)
            self.assertLessEqual(opened["rfoot"]["bottom"], opened["frame"]["bottom"] + 0.5, where)
            for name, field in opened["fields"].items():
                self.assertGreaterEqual(field["height"] + 0.5, field["min"], "%s %s" % (where, name))
            self.assertEqual({"insert": True, "cancel": True}, self.page.evaluate("hits()"), where)
            self.assertTrue(self.page.evaluate("()=>$('#dictation-text').scrollHeight > $('#dictation-text').clientHeight"),
                            "a long transcript scrolls inside the pane")
            self.page.click("#dictation-cancel")
            self.page.click("#dictation-close")
            self.page.evaluate("()=>new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
            self.assertEqual(hidden, self.page.evaluate("boxes()"), "closing restores the exact layout: " + where)
            self.page.evaluate("()=>$('#dictation-pane').remove()")
            self.page.evaluate("()=>new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
            without = self.page.evaluate("boxes()")
            without["pane"] = hidden["pane"]
            self.assertEqual(hidden, without, "the hidden pane has no layout effect at all: " + where)

    # ── HD-14 ──────────────────────────────────────────────────────────────────────────────
    def test_hd14_a_double_dictate_and_a_double_stop_start_and_send_once(self):
        self.open(media="hold")
        self.page.evaluate("()=>{ $('#b-dictate').click(); $('#b-dictate').click(); }")
        self.page.wait_for_function("()=>media.gumCalls >= 1")
        self.page.evaluate("()=>media.grant()")
        self.wait_state("recording")
        self.page.evaluate("()=>{ $('#dictation-stop').click(); $('#dictation-stop').click(); }")
        self.page.wait_for_function("()=>media.commands.length >= 1")
        self.page.evaluate("b => deliverPcm(b)", [1, 0])
        self.page.wait_for_function("()=>dictCalls.length >= 1")
        self.page.wait_for_timeout(50)
        value = self.snap()
        self.assertEqual((1, 1, 1, 1), (value["media"]["gum"], value["media"]["contexts"],
                                        len(value["media"]["commands"]), len(value["dict"])))

    # ── HD-15 ──────────────────────────────────────────────────────────────────────────────
    def test_hd15_review_stands_the_findings_drawer_down_once_per_run_and_never_reopens_it(self):
        """U4L attempt 1 (Astra B2): the page closes Image Findings once when a run enters review
        (standDownFindingsForDictationReview in the sliced dictation block). The same review emitting
        again - an edit, a refused Insert, a click re-pin - must not close it again: that is what keeps
        a drawer the reader reopened during review open. Cancel, the pane's Close and Insert never
        reopen it; only the next run's review closes it once more. The drawer stub gains its counters
        here, at runtime, so the harness glue it shares with the capture suite stays byte-identical."""
        self.open()
        self.page.evaluate("()=>{ window.drawer = { closes: 0, opens: 0 }; "
                           "readingFindings.close = () => { drawer.closes += 1; }; "
                           "readingFindings.open = () => { drawer.opens += 1; }; }")

        def drawer():
            return self.page.evaluate("()=>({ closes: drawer.closes, opens: drawer.opens })")
        self.caret("findings", 3)
        first = self.upload()
        self.assertEqual({"closes": 0, "opens": 0}, drawer(), "recording and uploading leave the drawer alone")
        self.page.evaluate("([i, s, r]) => answer(i, s, r)", [first, 200, reply(TRANSCRIPT)])
        self.wait_state("review")
        self.assertEqual({"closes": 1, "opens": 0}, drawer(), "entering review stands it down once")
        run = self.snap()["session"]["asrSeq"]
        # From here the reader may reopen the drawer with its own toggle (outside this harness). The same
        # review now emits several times; none of them may close it again.
        self.caret("findings", len(EXISTING))
        self.page.keyboard.type("추가")
        self.page.click("#dictation-insert")
        self.page.wait_for_function("()=>dictation.snapshot().needsRepin === true")
        self.page.click("#findings", position={"x": 12, "y": 8})
        self.page.wait_for_function("()=>dictation.snapshot().needsRepin === false")
        value = self.snap()
        self.assertEqual(("review", run), (value["session"]["state"], value["session"]["asrSeq"]),
                         "still the same run's review")
        self.assertEqual({"closes": 1, "opens": 0}, drawer(), "an edit, a refused Insert and a re-pin never close again")
        self.page.click("#dictation-cancel")
        self.wait_state("cancelled")
        self.page.click("#dictation-close")
        self.assertTrue(self.snap()["pane"]["hidden"])
        self.assertEqual({"closes": 1, "opens": 0}, drawer(), "cancel and the pane's Close reopen nothing")
        # A new run is a new review: exactly one more stand-down, and Insert reopens nothing.
        second = self.upload()
        self.page.evaluate("([i, s, r]) => answer(i, s, r)", [second, 200, reply(TRANSCRIPT)])
        self.wait_state("review")
        self.assertNotEqual(run, self.snap()["session"]["asrSeq"])
        self.assertEqual({"closes": 2, "opens": 0}, drawer(), "the next run's review stands it down once more")
        self.page.click("#dictation-insert")
        self.wait_state("inserted")
        self.assertEqual({"closes": 2, "opens": 0}, drawer(), "Insert reopens nothing")


if __name__ == "__main__":
    if "--static-only" in sys.argv:
        problems, cases = static_report()
        print(json.dumps({"static_only": True, "cases": len(cases), "problems": problems,
                          "main": str(MAIN_PATH), "host": str(HOST_PATH)}, ensure_ascii=False, indent=2))
        sys.exit(1 if problems else 0)
    program = unittest.main(verbosity=2, exit=False)
    sys.exit(0 if program.result.wasSuccessful() else 1)
