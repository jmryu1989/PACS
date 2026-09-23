# coding: utf-8
"""TEST-S3-ASR-U4b-CAPTURE: the shipped capture chain in pinned Chromium on a served loopback origin.

REQ-S3-ASR-FIRST-PATH (asr-binding-contract.md VC-6, VC-7, L4, §7)
  -> RISK-S3-ASR-FALSE-CAPTURE / RISK-S3-ASR-FORMAT / RISK-S3-ASR-HELD-MICROPHONE / RISK-S3-ASR-DENIAL-WRITE
  -> TEST-S3-ASR-U4b-CAPTURE (this file; its pure half is tests/dictation_capture_signal_test.py).

What is real here: Chromium's own file-backed fake microphone, the real getUserMedia, AudioContext,
AudioWorkletNode and the shipped dictation-worklet.js fetched over real HTTP from a test-owned
ThreadingHTTPServer on 127.0.0.1, the native fetch, and every product byte: report-citation.js,
report-structure.js, dictation-session.js, dictation-capture.js and dictation.js are served
byte-exact from the repository through the same `<script src>` tags main.html carries, and the
report column, editor gate, report, occupancy and dictation blocks are sliced out of main.html by
the U4 host suite's markers. Nothing is intercepted inside the browser: there is no Playwright
routing and no HAR (CAP-00 checks it).

What is instrumentation, named: one init script that only records and delegates (getUserMedia on
MediaDevices.prototype through Reflect.apply, and construct-only Proxies around AudioContext and
AudioWorkletNode that return the native instance); one raw CDP session per case on the page target
that only enables, listens to and disables the Log domain (Astra runtime amendment D2: the worklet's
CSP denial reaches the page as a worker-source Log entry that page.console drops); plus the test server, which answers the
report reads, occupancy and the dictation POST (a declared service stand-in) and keeps the page
alive with a recorded `200 {}` for any other /api request. A fallback answer never allows a
request: each case asserts author-written EXPECTED_API/REQUIRED_API literals tied by CAP-00 to
call sites in the served source.

Scope, stated plainly: this is a PARTIAL unit. The page runs at the production URL path under the
DECLARED CSP string from proxy/nginx.conf.template:59, served by this test; how production delivers
it is not observed. No claim is made about delivered headers, the real API or its compiled WAV
validator, or full-application pane geometry: those are S3-ASR-U4L G-LIVE-PATH and G-LIVE-GEO,
both mandatory. The U5 live refusal battery and Stage 3 remain open. The runtime assumptions listed
in the readiness (headless fake capture + AudioWorklet, the grant in Chromium 148,
--disable-audio-output rendering, the default autoplay policy after a real click, Permissions-Policy,
fetch copying the BufferSource, favicon requests) stay unverified until the first hosted run. So
does one more: Playwright may run its own evaluate/action calls with a simulated user gesture, so
activation at the press is recorded together with the activation seen at the first evaluate and at
AudioContext construction, and is not credited to the click alone.

Every wait polls one evaluate at a time from Python: under the served CSP (no 'unsafe-eval'), a
page-side polled predicate would run outside the evaluate call.

Browser (amendment D1): the full pinned Chromium 148.0.7778.96 through channel="chromium", headless. The
first hosted run launched chromium-headless-shell, whose WebContents delegate refuses every media
request; CAP-01 now asserts the actual launch from Playwright's own `<launching>` line.

Output: one `U4B-CAP <id> {json}` line per case, adjudicated before the exit code; `U4B-LAUNCH-FIRST`
right after the launch and `U4B-LAUNCH` at teardown.
`python tests/report_dictation_capture_dom_test.py --static-only` runs CAP-00 with no browser.
"""
import ast
import hashlib
import json
import os
import re
import sys
import threading
import time
import traceback
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
LITE = ROOT / "worklist-v0" / "hpacs-lite"
HD_PATH = ROOT / "tests" / "report_dictation_host_dom_test.py"
SELF_PATH = Path(__file__).resolve()
sys.path.insert(0, str(ROOT / "tests"))
from report_dictation_host_dom_test import (  # noqa: E402  (read-only reuse; never its HARNESS)
    S, API_FN, WRITE_BLOCK_FN, EDITOR_BLOCK_FN, BUTTONS_FN, default_state, UID, OTHER, EXISTING, CAPABILITY)
import dictation_capture_signal as signal  # noqa: E402

NGINX = (ROOT / "proxy" / "nginx.conf.template").read_text(encoding="utf-8")
MAIN = (LITE / "main.html").read_text(encoding="utf-8")
PAGE_PATH = "/worklist/hpacs-lite/u4b-capture.html"
AFTER_EXIT_PATH = "/u4b/after-exit.html"
ASSET_DIR = "/worklist/hpacs-lite/"
PAGE_SCRIPTS = ("report-citation.js", "report-structure.js", "dictation-session.js", "dictation-capture.js",
                "dictation.js")
WORKLET = "dictation-worklet.js"
ASSETS = PAGE_SCRIPTS + (WORKLET,)
BROWSER_VERSION = "148.0.7778.96"
TRANSCRIPT = "u4b-capture-transport-check"
UNCHANGED = " — 판독문은 그대로입니다"       # dictation.js:28
CANCELLED = "취소됨(엔진 상태 미확인)"       # dictation.js:29
CASE_SECONDS = 20
HOLD_SECONDS = 25
# Session states a started run never leaves by itself (dictation-session.js ACTIVE is the complement).
TERMINAL_STATES = ("failed", "cancelled", "unavailable", "inserted")
SMALL_CAP = 32044                           # 16000 frames: the CAP-03 worklet cap
FULL_FRAMES = 524266                        # floor((1048576 - 44) / 2), dictation-worklet.js:8
WRITE_METHODS = ("POST", "PUT", "PATCH", "DELETE")
LOGGED_HEADERS = ("Content-Type", "Content-Length", "Transfer-Encoding", "X-KIN-CSRF", "Authorization", "Cookie",
                  "Origin", "Sec-Fetch-Dest", "Sec-Fetch-Mode", "Sec-Fetch-Site")
ARTIFACTS = Path(os.environ.get("KIN_U4B_ARTIFACTS", ROOT / "tmp" / "dictation-capture-ci" / "capture-artifacts"))
CASE_IDS = ("CAP-01", "CAP-02", "CAP-03", "CAP-04", "CAP-05", "CAP-06", "CAP-07", "CAP-08", "CAP-09", "CAP-10",
            "NC-11", "NC-12")


def header_values(name):
    return re.findall(r'add_header %s "([^"]*)" always;' % re.escape(name), NGINX)


# Parsed, never retyped. N-6: the exactly-once rule breaks if G-CSP copies the CSP into
# `location /worklist/`; the G-CSP owner updates this parse in the same commit.
CSP_VALUES = header_values("Content-Security-Policy")
COOP_VALUES = header_values("Cross-Origin-Opener-Policy")
COEP_VALUES = header_values("Cross-Origin-Embedder-Policy")
CSP = CSP_VALUES[0] if CSP_VALUES else ""
COOP = COOP_VALUES[0] if COOP_VALUES else ""
COEP = COEP_VALUES[0] if COEP_VALUES else ""


def nc11_csp(origin):
    """B-1: only script-src changes. 'unsafe-inline' stays and the five page scripts are listed by
    exact URL; the worklet is not. worker-src 'self' blob: and every other directive stay
    byte-identical (DN-3), so the one expected violation is the worklet's own."""
    out = []
    for directive in CSP.split("; "):
        if directive.split(" ", 1)[0] == "script-src":
            directive = "script-src 'unsafe-inline' " + " ".join(origin + ASSET_DIR + name for name in PAGE_SCRIPTS)
        out.append(directive)
    return "; ".join(out)


# ── Path literals (B-2). Written from source reading, never from observed requests. ─────────────
# `{uid}` is the exact study (encodeURIComponent("1.2.3") is itself); the /api prefix is the glue's
# `const API = "/api"` that api() (main.html:1296) and the dictation host's apiBase both use.
CITATIONS_GET = ("GET", "/api/studies/{uid}/report/citations")     # ensureCitations, main.html:3695
STRUCTURE_GET = ("GET", "/api/studies/{uid}/report/structure")     # ensureStructure, main.html:3759
DICTATION_POST = ("POST", "/api/studies/{uid}/dictation")          # dictation.js:254,260
HOLD_POST = ("POST", "/api/studies/{uid}/hold")                    # claimHold, main.html:4991
REPORT_PUT = ("PUT", "/api/studies/{uid}/report")                  # stashReport, main.html:4579,4597
COMMIT_POST = ("POST", "/api/studies/{uid}/report/commit")         # main.html:4677
DRAFT_DELETE = ("DELETE", "/api/studies/{uid}/draft")              # main.html:3471
# Reachable from the slices, forbidden in every case except the literal that names them.
FORBIDDEN_WRITES = (COMMIT_POST, DRAFT_DELETE, REPORT_PUT)

# loadReport({ force: true }) reads citations and structure once each (main.html:3406-3408); no
# case path re-reads them (the hold answer's loadReport() finds both known).
EXPECTED_API = {
    "CAP-01": (CITATIONS_GET, STRUCTURE_GET),
    # Insert raises one input event: claimHold (main.html:5050-5054) posts hold once; stash() writes once.
    "CAP-02": (CITATIONS_GET, STRUCTURE_GET, DICTATION_POST, HOLD_POST, REPORT_PUT),
    "CAP-03": (CITATIONS_GET, STRUCTURE_GET, DICTATION_POST),
    "CAP-04": (CITATIONS_GET, STRUCTURE_GET),
    "CAP-05": (CITATIONS_GET, STRUCTURE_GET),
    "CAP-06": (CITATIONS_GET, STRUCTURE_GET, DICTATION_POST),
    "CAP-07": (CITATIONS_GET, STRUCTURE_GET),
    "CAP-08": (CITATIONS_GET, STRUCTURE_GET),
    "CAP-09": (CITATIONS_GET, STRUCTURE_GET),
    "CAP-10": (CITATIONS_GET, STRUCTURE_GET),
    "NC-11": (CITATIONS_GET, STRUCTURE_GET),
    "NC-12": (CITATIONS_GET, STRUCTURE_GET),
}
REQUIRED_API = {
    "CAP-01": {CITATIONS_GET: 1, STRUCTURE_GET: 1, DICTATION_POST: 0, REPORT_PUT: 0},
    "CAP-02": {CITATIONS_GET: 1, STRUCTURE_GET: 1, DICTATION_POST: 1, HOLD_POST: 1, REPORT_PUT: 1},
    "CAP-03": {CITATIONS_GET: 1, STRUCTURE_GET: 1, DICTATION_POST: 1, REPORT_PUT: 0},
    "CAP-04": {CITATIONS_GET: 1, STRUCTURE_GET: 1, DICTATION_POST: 0, REPORT_PUT: 0},
    "CAP-05": {CITATIONS_GET: 1, STRUCTURE_GET: 1, DICTATION_POST: 0, REPORT_PUT: 0},
    "CAP-06": {CITATIONS_GET: 1, STRUCTURE_GET: 1, DICTATION_POST: 1, REPORT_PUT: 0},
    "CAP-07": {CITATIONS_GET: 1, STRUCTURE_GET: 1, DICTATION_POST: 0, REPORT_PUT: 0},
    "CAP-08": {CITATIONS_GET: 1, STRUCTURE_GET: 1, DICTATION_POST: 0, REPORT_PUT: 0},
    "CAP-09": {CITATIONS_GET: 1, STRUCTURE_GET: 1, DICTATION_POST: 0, REPORT_PUT: 0},
    "CAP-10": {CITATIONS_GET: 1, STRUCTURE_GET: 1, DICTATION_POST: 0, REPORT_PUT: 0},
    "NC-11": {CITATIONS_GET: 1, STRUCTURE_GET: 1, DICTATION_POST: 0, REPORT_PUT: 0},
    "NC-12": {CITATIONS_GET: 1, STRUCTURE_GET: 1, DICTATION_POST: 0, REPORT_PUT: 0},
}


def resolve(pattern):
    return pattern[0], pattern[1].replace("{uid}", UID)


# ── The page (N-1): four parts copied from the U4 host harness, its two stand-in regions left out.
# Markup :164-182, module tags :219-222, glue :224-270 inside its own script tags (DN-1), and the
# slice placeholders/helpers :303-355 with window.answer dropped and the dict/media fields of
# snapshot() reading the server log (merged in Python) and the observer registry (DN-2).
TEMPLATE = r"""<!doctype html><html><head><meta charset="utf-8"><style>
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
/* U4b: window.answer is dropped; the test server holds and answers the real request (N-1). */
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
    dict: null, /* U4b: the dictation requests are read at the test server and merged in Python (DN-2). */
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
    media: __u4b.media(), /* U4b: the observer registry; released() is rebuilt there from real tracks and contexts (DN-2). */
    secure: window.isSecureContext, seq: selectionSeq, base: reportBaseVersion(selectedUid, -1), logouts,
  };
};
</script></body></html>"""

AFTER_EXIT_HTML = (b'<!doctype html><html><head><meta charset="utf-8"><title>U4b after exit</title></head>'
                   b'<body>after exit</body></html>')


def page_html(state):
    page = TEMPLATE
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


# ── The only page code touching media or network APIs: it records and delegates, nothing else.
# getUserMedia keeps the real MediaDevices receiver (Reflect.apply) and resolves the same stream;
# the constructors are construct-only Proxies whose trap lets newTarget default to the native
# target and returns the native instance (N-7). fetch is saved, never wrapped.
OBSERVER = r"""(() => {
  'use strict';
  if (Object.prototype.hasOwnProperty.call(window, '__u4b')) return;
  const natives = Object.freeze({
    getUserMedia: typeof MediaDevices === 'function' ? MediaDevices.prototype.getUserMedia : undefined,
    AudioContext: window.AudioContext,
    AudioWorkletNode: window.AudioWorkletNode,
    fetch: window.fetch,
  });
  const reg = { gum: [], tracks: [], contexts: [], nodes: [], violations: [], clicks: [] };
  const plain = value => { try { return JSON.parse(JSON.stringify(value === undefined ? null : value)); } catch (_) { return null; } };
  const nativeCode = fn => typeof fn === 'function' && /\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(fn));

  function getUserMedia(...args) {
    const call = { t: performance.now(), constraints: plain(args[0]), outcome: 'pending', error: null,
      tracks: [], settings: [], settled: null };
    reg.gum.push(call);
    return Reflect.apply(natives.getUserMedia, this, args).then(stream => {
      call.outcome = 'resolved'; call.settled = performance.now();
      for (const track of stream.getTracks()) {
        call.tracks.push(reg.tracks.length);
        reg.tracks.push(track);
        call.settings.push(plain(track.getSettings()));
      }
      return stream;
    }, error => {
      call.outcome = 'rejected'; call.settled = performance.now();
      call.error = { name: error && error.name, message: String(error && error.message) };
      throw error;
    });
  }
  function observed(Native, list, describe) {
    return new Proxy(Native, {
      construct(target, args) {
        const o = Reflect.construct(target, args);
        list.push(describe(o, args, performance.now()));
        return o;
      },
    });
  }
  function contextEntry(o, args, t) {
    const entry = { o, t, options: plain(args[0]), states: [[o.state, t]],
      activation: { hasBeenActive: navigator.userActivation.hasBeenActive, isActive: navigator.userActivation.isActive } };
    o.addEventListener('statechange', () => entry.states.push([o.state, performance.now()]));
    return entry;
  }
  function nodeEntry(o, args, t) {
    const entry = { o, t, name: args[1], options: plain(args[2]), processorErrors: 0 };
    o.addEventListener('processorerror', () => { entry.processorErrors += 1; });
    return entry;
  }
  const wrappers = Object.freeze({
    getUserMedia,
    AudioContext: typeof natives.AudioContext === 'function' ? observed(natives.AudioContext, reg.contexts, contextEntry) : undefined,
    AudioWorkletNode: typeof natives.AudioWorkletNode === 'function' ? observed(natives.AudioWorkletNode, reg.nodes, nodeEntry) : undefined,
  });
  function replace(owner, name, value) {
    const descriptor = owner && Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor && value) Object.defineProperty(owner, name, { ...descriptor, value });
  }
  replace(typeof MediaDevices === 'function' ? MediaDevices.prototype : null, 'getUserMedia', natives.getUserMedia && getUserMedia);
  replace(window, 'AudioContext', wrappers.AudioContext);
  replace(window, 'AudioWorkletNode', wrappers.AudioWorkletNode);

  // One entry per violation event, wherever it is seen first; seenOn says where it was observed.
  const seen = new WeakMap();
  const onViolation = where => event => {
    let entry = seen.get(event);
    if (!entry) {
      entry = { effectiveDirective: event.effectiveDirective, violatedDirective: event.violatedDirective,
        blockedURI: event.blockedURI, disposition: event.disposition, sourceFile: event.sourceFile,
        documentURI: event.documentURI, originalPolicy: event.originalPolicy,
        target: event.target === document ? 'document' : event.target === window ? 'window' : String(event.target && event.target.nodeName),
        t: performance.now(), seenOn: [] };
      seen.set(event, entry);
      reg.violations.push(entry);
    }
    entry.seenOn.push(where);
  };
  window.addEventListener('securitypolicyviolation', onViolation('window'), true);
  document.addEventListener('securitypolicyviolation', onViolation('document'), true);

  // A click's page-clock time before any handler, and the media state after the handlers ran.
  const states = () => ({ tracks: reg.tracks.map(t => t.readyState), contexts: reg.contexts.map(c => c.o.state) });
  window.addEventListener('click', event => {
    reg.clicks.push({ id: (event.target && event.target.id) || null, t: performance.now(), trusted: event.isTrusted,
      activation: { hasBeenActive: navigator.userActivation.hasBeenActive, isActive: navigator.userActivation.isActive },
      before: states(), after: null });
  }, true);
  window.addEventListener('click', () => {
    const last = reg.clicks[reg.clicks.length - 1];
    if (last && !last.after) last.after = states();
  }, false);

  const released = () => reg.tracks.length > 0 && reg.tracks.every(t => t.readyState === 'ended') &&
    reg.contexts.every(c => c.o.state === 'closed');
  const media = () => ({
    gum: reg.gum.length,
    gumCalls: reg.gum.map(c => ({ t: c.t, constraints: c.constraints, outcome: c.outcome, error: c.error,
      tracks: c.tracks.slice(), settings: c.settings.slice(), settled: c.settled })),
    tracks: reg.tracks.map(t => ({ kind: t.kind, label: t.label, readyState: t.readyState, muted: t.muted, enabled: t.enabled })),
    contexts: reg.contexts.map(c => ({ t: c.t, options: c.options, state: c.o.state, sampleRate: c.o.sampleRate,
      native: Object.getPrototypeOf(c.o) === natives.AudioContext.prototype, states: c.states.slice(),
      activation: c.activation })),
    nodes: reg.nodes.map(n => ({ t: n.t, name: n.name, options: n.options,
      native: Object.getPrototypeOf(n.o) === natives.AudioWorkletNode.prototype,
      channelCount: n.o.channelCount, channelCountMode: n.o.channelCountMode, processorErrors: n.processorErrors })),
    released: released(),
  });
  const api = Object.freeze({
    natives, wrappers, media, released,
    violations: () => plain(reg.violations),
    clicks: () => plain(reg.clicks),
    trackStates: () => reg.tracks.map(t => t.readyState),
    nodeTime: index => (reg.nodes[index] ? reg.nodes[index].t : null),
    activation: () => ({ hasBeenActive: navigator.userActivation.hasBeenActive, isActive: navigator.userActivation.isActive }),
    permission: () => navigator.permissions.query({ name: 'microphone' }).then(s => s.state, e => 'error:' + (e && e.name)),
    environment: () => ({
      secure: window.isSecureContext, crossOriginIsolated: window.crossOriginIsolated,
      fetchIsNative: natives.fetch === window.fetch && nativeCode(natives.fetch),
      gumIsWrapper: typeof MediaDevices === 'function' && MediaDevices.prototype.getUserMedia === getUserMedia &&
        navigator.mediaDevices.getUserMedia === getUserMedia,
      gumNative: nativeCode(natives.getUserMedia) && natives.getUserMedia !== getUserMedia,
      contextObserved: window.AudioContext === wrappers.AudioContext,
      nodeObserved: window.AudioWorkletNode === wrappers.AudioWorkletNode,
      contextTarget: nativeCode(natives.AudioContext) && !!wrappers.AudioContext &&
        wrappers.AudioContext.prototype === natives.AudioContext.prototype,
      nodeTarget: nativeCode(natives.AudioWorkletNode) && !!wrappers.AudioWorkletNode &&
        wrappers.AudioWorkletNode.prototype === natives.AudioWorkletNode.prototype,
      userAgent: navigator.userAgent,
    }),
  });
  Object.defineProperty(window, '__u4b', { value: api });
})();"""

# Page-side test steps. Every evaluate/wait goes through this table (CAP-00 checks it), and none
# of it names a media or network API: those are reached only through the product or the observer.
PROBES = {
    "started": "() => typeof window.snapshot === 'function' && typeof window.__u4b === 'object'",
    "load": "() => { load({ force: true }); return true; }",
    "capability": "c => { dictation.setServerCapability(c); updateReportButtons(); return true; }",
    "snapshot": "() => snapshot()",
    "state": "() => dictation.snapshot().state",
    "controller": "() => typeof dictation === 'object' && dictation !== null && typeof dictation.snapshot === 'function'",
    "strings": "() => ({ uploading: KinDictation.STATUS.uploading, capped: KinDictation.STATUS.capped,"
               " reasons: KinDictation.REASONS })",
    "fixed": "s => s.toFixed(1)",
    "put": "([f, p]) => { put(f, p); return true; }",
    "expected": "([v, t, s, e]) => expected(v, t, s, e)",
    "stash": "() => { stash(); return true; }",
    # HD-06's read-only trigger, mirrored (report_dictation_host_dom_test.py:689-690).
    "read_only": "uid => { appState[uid].holder = 'other@kin'; studies[0].holder = 'other@kin'; "
                 "updateReportButtons(); return true; }",
    "environment": "() => __u4b.environment()",
    "permission": "() => __u4b.permission()",
    "activation": "() => __u4b.activation()",
    "violations": "() => __u4b.violations()",
    "clicks": "() => __u4b.clicks()",
    "media": "() => __u4b.media()",
    "recorded_for": "ms => { const t = __u4b.nodeTime(0); return t !== null && performance.now() - t >= ms; }",
    "contexts_closed": "() => { const m = __u4b.media(); return m.contexts.length > 0 && "
                       "m.contexts.every(c => c.state === 'closed'); }",
    # Registered after load, so it runs after main.html:1590's pagehide listener.
    "exit_probe": "() => { window.addEventListener('pagehide', event => { sessionStorage.setItem('u4b-exit', "
                  "JSON.stringify({ persisted: event.persisted, tracks: __u4b.trackStates(), "
                  "state: dictation.snapshot().state, t: performance.now() })); }); return true; }",
    "exit_record": "() => sessionStorage.getItem('u4b-exit')",
}


def launch_args(fixture):
    # No --use-fake-ui-for-media-stream / --auto-accept-camera-and-microphone-capture: they would
    # make the grant unattributable and denial impossible. No --autoplay-policy: the default policy
    # after a real click is the observable (N-2).
    return ["--use-fake-device-for-media-stream", "--use-file-for-fake-audio-capture=%s" % fixture,
            "--disable-audio-output"]


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def emit(tag, value):
    print("%s %s" % (tag, json.dumps(value, ensure_ascii=False, sort_keys=True)), flush=True)


# ── CAP-00 ───────────────────────────────────────────────────────────────────────────────────────
STANDIN_TOKENS = ("FakeAudioContext", "FakeWorkletNode", "fakeStream", "deliverPcm", "endTrack", "window.fetch =",
                  "defineProperty(navigator", "media.gumCalls")
MEDIA_NETWORK_TOKENS = ("getUserMedia", "mediaDevices", "AudioContext", "AudioWorkletNode", "MediaStream", "fetch",
                        "XMLHttpRequest", "sendBeacon", "WebSocket", "EventSource")
# Built by concatenation so this file does not contain the tokens it forbids.
INTERCEPT_TOKENS = ("." + "route(", "route" + "_from_har", "record" + "_har", "route" + "FromHAR")
OWN_FILES = (SELF_PATH, ROOT / "tests" / "dictation_capture_signal.py", ROOT / "tests" / "dictation_capture_signal_test.py")
OBSERVER_FORBIDDEN = ("new Promise", ".stop(", ".close(", ".resume(", ".suspend(", ".connect(", ".disconnect(",
                      "postMessage", "dispatchEvent", "addModule", "fetch(", "XMLHttpRequest", "sendBeacon",
                      "WebSocket", "createMediaStream", "createOscillator", "createBuffer", "onmessage",
                      "Storage", "setTimeout", "setInterval", "preventDefault", "stopPropagation", "newTarget",
                      "window.fetch =", "defineProperty(navigator", "Response(")


def hd_harness_lines():
    """The U4 host harness as text. It is read for comparison only; its HARNESS is never imported."""
    text = HD_PATH.read_text(encoding="utf-8")
    start = text.index('HARNESS = r"""') + len('HARNESS = r"""')
    return text[start:text.index('"""', start)].split("\n")


def composition_problems():
    problems = []
    hd = hd_harness_lines()
    mine = TEMPLATE.split("\n")
    cite = hd.index('<script src="report-citation.js"></script>')
    skeleton = hd[:cite + 1]
    standin_end = hd.index("</script>", cite + 1)
    standin = hd[cite + 1:standin_end + 1]
    modules = hd[standin_end + 1:standin_end + 5]
    fetch_at = next(i for i, line in enumerate(hd) if line.startswith("window.fetch = async"))
    glue = hd[standin_end + 6:fetch_at]
    apifn = hd.index("APIFN")
    fetch_standin = hd[fetch_at:apifn]
    helpers = hd[apifn:hd.index("</script></body></html>")]
    if hd[standin_end + 5] != "<script>" or not glue[0].startswith("const $ = ") or \
            not glue[-1].startswith("window.confirm = "):
        problems.append("the U4 host harness no longer has the part boundaries U4b copies (:223-270)")
    if not standin[1].startswith("/* Stand-ins: media devices") or not fetch_standin[-1] == "};":
        problems.append("the U4 host harness stand-in regions moved (:183-218, :271-302)")
    n = len(skeleton)
    if mine[:n] != skeleton:
        problems.append("the markup skeleton is not HD :164-182")
    if mine[n:n + 4] != modules or [m for m in modules if not m.startswith("<script src=")]:
        problems.append("the module tags are not HD :219-222")
    if mine[n + 4] != "<script>":
        problems.append("the glue must open its own script tag (DN-1)")
    if mine[n + 5:n + 5 + len(glue)] != glue:
        problems.append("the environment glue is not HD :224-270 verbatim")
    rest = mine[n + 5 + len(glue):]
    if rest[-1] != "</script></body></html>":
        problems.append("the glue must close its own script tag (DN-1)")
    answer = next(i for i, line in enumerate(helpers) if line.startswith("window.answer = "))
    dict_at = next(i for i, line in enumerate(helpers) if line.startswith("    dict: dictCalls.map("))
    media_at = next(i for i, line in enumerate(helpers) if line.startswith("    media: { gum: media.gumCalls"))
    if not helpers[dict_at + 3].endswith("aborted: c.aborted })),") or \
            not helpers[media_at + 1].endswith("contexts: media.contexts.length },"):
        problems.append("the adapted snapshot fields (:334-337, :351-352) moved")
    adapted = {answer} | set(range(dict_at, dict_at + 4)) | set(range(media_at, media_at + 2))
    kept = [line for i, line in enumerate(helpers) if i not in adapted]
    mine_helpers = rest[:-1]
    if [line for line in mine_helpers if "U4b:" not in line] != kept:
        problems.append("the helpers are not HD :303-355 apart from the three declared adaptations")
    if sum("U4b:" in line for line in mine_helpers) != 3:
        problems.append("exactly three helper lines are U4b adaptations")
    trivial = {"<script>", "</script>", "}", "};", "});", "}));", ""}
    for name, block in (("stand-in media script :183-218", standin), ("fetch stand-in :271-302", fetch_standin)):
        leaked = [line for line in block if line.strip() not in trivial and line in mine]
        if leaked:
            problems.append("the %s leaked into the template: %r" % (name, leaked[:2]))
    return problems


def normalise(path):
    return re.sub(r"\$\{[^}]*\}", "{}", path)


def call_sites():
    """(method, path) of every api()/fetch call site the served slices and dictation.js:254 carry."""
    sites = set()
    literal = re.compile(r"""\bapi\(\s*(["'])(GET|POST|PUT|PATCH|DELETE)\1\s*,\s*([`"'])(.*?)\3""", re.S)
    variable = re.compile(r"""\bapi\(\s*(["'])(GET|POST|PUT|PATCH|DELETE)\1\s*,\s*([A-Za-z_]\w*)\s*[,)]""")
    for name in ("REPORT_BLOCK", "HOLD_BLOCK", "SELECT_BLOCK", "DICTATION_BLOCK"):
        block = S[name]
        for match in literal.finditer(block):
            sites.add((match.group(2), "/api" + normalise(match.group(4))))
        for match in variable.finditer(block):
            declared = re.findall(r"const %s = `([^`]*)`;" % match.group(3), block[:match.start()])
            if declared:
                sites.add((match.group(2), "/api" + normalise(declared[-1])))
    host = (LITE / "dictation.js").read_text(encoding="utf-8")
    url = re.search(r"const url = `\$\{o\.apiBase\}(/studies/\$\{[^}]*\}/dictation)`;", host)
    post = re.search(r"o\.fetch\(url, \{ method: 'POST',", host)
    if url and post and "apiBase: API," in S["DICTATION_BLOCK"]:
        sites.add(("POST", "/api" + normalise(url.group(1))))
    return sites


def harness_self_check():
    """Pure regression for the first hosted run's harness findings (35841141421/1). No browser or page:
    a stub page scripts the session states the run showed, and each wait must end the way it should."""
    problems = []

    class Page:
        def __init__(self):
            self.waited = 0

        def wait_for_timeout(self, ms):
            self.waited += 1

    class Server:
        def snapshot(self):
            return [{"method": "GET", "path": ASSET_DIR + WORKLET, "query": "", "status": 200, "answered_by": "asset",
                     "held": False, "body_len": 0, "headers": {"Content-Type": None}}]

    # The CAP-08/CAP-09 record of that run: the refusal as the page registry held it.
    refused = {"session": {"state": "failed", "error": "DICTATION_CAPTURE_FAILED"}, "pane": {"status": "refused"},
               "media": {"gumCalls": [{"outcome": "rejected",
                                       "error": {"name": "NotSupportedError", "message": "Not supported"}}],
                         "tracks": [], "contexts": [{"state": "closed", "sampleRate": 16000, "states": []}],
                         "nodes": []}}

    def scripted(states, seconds=5):
        case = Case.__new__(Case)
        case.id, case.checks, case.observed, case.console, case.log_entries = "SELF", [], {}, [], []
        case.server, case.page, case.deadline = Server(), Page(), time.monotonic() + seconds
        sequence = iter(states)

        def js(name, arg=None):
            if name == "state":
                return next(sequence)
            if name == "snapshot":
                return json.loads(json.dumps(refused))
            if name == "recorded_for":
                return False
            raise AssertionError(name)
        case.js = js
        return case

    def ends(action):
        try:
            action()
        except CaseStop:
            return "stopped"
        return "returned"

    case = scripted(["requesting-permission", "requesting-permission", "failed"])
    stopped = ends(lambda: case.wait_state("recording", "recording"))
    primary = case.observed.get("primary") or {}
    first_call = (primary.get("gum_calls") or [{}])[0]
    if stopped != "stopped" or case.page.waited != 2 or case.checks[-1]["detail"]["ended_by"] != "terminal-state":
        problems.append("wait_state must stop at another terminal state without waiting out the deadline")
    if (first_call.get("error") or {}).get("name") != "NotSupportedError" or \
            primary.get("worklet_gets") != [ASSET_DIR + WORKLET]:
        problems.append("a stopped wait must record the primary cause (the page's getUserMedia outcome)")
    case = scripted(["requesting-permission", "recording"])
    if ends(lambda: case.wait_state("recording", "recording")) != "returned" or case.checks:
        problems.append("wait_state must return once the target state is reached")
    case = scripted(["recording", "failed"])
    if ends(lambda: case.wait_state("failed", "failed")) != "returned" or case.checks:
        problems.append("a terminal target state is reached, not a failure")
    case = scripted(["requesting-permission"] * 4, seconds=-1)
    if ends(lambda: case.wait_state("recording", "recording")) != "stopped" or \
            case.checks[-1]["detail"]["ended_by"] != "deadline" or "primary" not in case.observed:
        problems.append("wait_state must still fail at the deadline, with the primary state recorded")
    case = scripted(["recording", "failed"])
    if ends(lambda: case.wait_js("recorded_for", 2000, "2.0 s", while_active=True)) != "stopped" or \
            case.checks[-1]["detail"]["ended_by"] != "terminal-state":
        problems.append("a timed wait during recording must stop when the capture fails")
    tree = ast.parse(SELF_PATH.read_text(encoding="utf-8"))
    functions = {node.name: ast.unparse(node) for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
    cap01 = next(text for name, text in functions.items() if name.startswith("test_cap01_"))
    if "dictation-cancel" in cap01:
        problems.append("CAP-01 must not click Cancel after a state read (the first run's stale-read race)")
    setup = functions["setUpClass"]
    start = setup.find("cls._pw = sync_playwright().start()")
    if not (0 <= setup.find("os.environ['DEBUG'] = 'pw:browser'") < start and
            0 <= setup.find("os.environ['DEBUG_FILE'] = ") < start):
        problems.append("the pw:browser log must be enabled before Playwright starts")
    sample = ("2026-09-23T09:08:48.001Z pw:browser <launching> /r/chrome-headless-shell-linux64/chrome-headless-shell "
              "--disable-field-trial-config --headless --mute-audio --use-fake-device-for-media-stream "
              "--use-file-for-fake-audio-capture=/f.wav --disable-audio-output\n"
              "2026-09-23T09:08:48.002Z pw:browser <launched> pid=7\n"
              "2026-09-23T09:08:49.000Z pw:browser [pid=7][err] [7:7:0923/090849.000:ERROR:synthetic.cc(1)] synthetic\n")
    parsed = parse_launch(sample)
    if not parsed["chrome_headless_shell"] or not parsed["flags"]["--headless"] or \
            not parsed["flags"]["--use-file-for-fake-audio-capture"] or parsed["flags"]["--use-fake-ui-for-media-stream"] or \
            len(parsed["notable"]) != 1:
        problems.append("parse_launch must name the launched binary, its flags and the browser's error lines")
    problems += launch_self_check()
    problems += csp_log_self_check()
    return problems


def launch_self_check():
    """D1: the launch oracle accepts only the full pinned Chromium without forbidden flags. The samples are
    literal `<launching>` lines in the form Playwright's launchProcess writes them."""
    problems = []
    tail = ("--disable-field-trial-config --headless --mute-audio --use-fake-device-for-media-stream "
            "--use-file-for-fake-audio-capture=/f.wav --disable-audio-output")

    def launched(executable, extra=""):
        return parse_launch("2026-09-23T09:08:48.001Z pw:browser <launching> %s %s%s\n"
                            "2026-09-23T09:08:48.002Z pw:browser <launched> pid=7\n" % (executable, tail, extra))

    full = "/home/runner/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome"
    shell = "/home/runner/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell"
    good = launched(full)
    if launch_problems(good) != {"binary": [], "forbidden": []} or not good["flags"]["--headless"]:
        problems.append("the full pinned Chromium launch must pass the launch oracle")
    for label, parsed in (("headless shell", launched(shell)), ("another revision", launched(full.replace("1223", "1222"))),
                          ("a sibling binary", launched(full + "_sandbox")), ("no launch line", parse_launch("")),
                          ("no log", {"unavailable": "missing"})):
        if not launch_problems(parsed)["binary"]:
            problems.append("the launch oracle must reject %s" % label)
    for flag in (" --use-fake-ui-for-media-stream", " --auto-accept-camera-and-microphone-capture",
                 " --autoplay-policy=no-user-gesture-required"):
        if launch_problems(launched(full, flag))["forbidden"] != [flag.strip().split("=")[0]]:
            problems.append("the launch oracle must reject%s" % flag)
    refused = parse_launch("x pw:browser <launching> %s %s\nx pw:browser [pid=7][err] [7:7:0923/090849.000:ERROR:"
                           "web_contents_delegate.cc(289)] WebContentsDelegate::RequestMediaAccessPermission: "
                           "Not supported.\n" % (full, tail))
    if not refused["delegate_not_supported_logged"] or good["delegate_not_supported_logged"]:
        problems.append("the delegate's refusal line must be recognised on stderr only")
    return problems


def csp_log_self_check():
    """D2: the Log verdict against literal entries in the form Blink writes them (csp_directive_list.cc:683-687
    message, :650-652 fallback note, :143-148 blocked suffix; worker source and error level)."""
    problems = []
    origin = "http://127.0.0.1:9"
    worklet = origin + ASSET_DIR + WORKLET
    directive = "script-src 'unsafe-inline' " + " ".join(origin + ASSET_DIR + name for name in PAGE_SCRIPTS)
    text = ("Loading the script '" + worklet + "' violates the following Content Security Policy directive: \"" +
            directive + "\". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback."
            " The action has been blocked.")
    denial = {"source": "worker", "level": "error", "text": text, "url": "", "timestamp": 1790154490000.0}
    network = {"source": "network", "level": "error", "text": "Failed to load resource: the server responded with a "
               "status of 404 (Not Found)", "url": origin + "/favicon.ico", "timestamp": 1790154490001.0}
    frame = {"source": "security", "level": "error", "text": "Refused to frame '" + origin + "/x' because it violates "
             "the following Content Security Policy directive: \"frame-ancestors 'self'\".", "timestamp": 2.0}
    verdict = csp_log_verdict([network, denial], worklet)
    if verdict["problems"] or verdict["directive"] != directive or verdict["matching"] != 1 or verdict["others"] or \
            not verdict["fallback_note"] or not verdict["directive_ok"]:
        problems.append("one worker/error denial naming the worklet must pass NC-11: %r" % verdict["problems"])

    def rejected(label, entries, **expect):
        result = csp_log_verdict(entries, worklet)
        if not result["problems"] or any(result[key] != value for key, value in expect.items()):
            problems.append("NC-11 must reject %s" % label)

    rejected("zero entries", [], matching=0)
    rejected("only non-CSP entries", [network], matching=0)
    rejected("a duplicate denial", [denial, dict(denial)], matching=2)
    rejected("the security source", [dict(denial, source="security")], matching=0, others=1)
    rejected("the warning level", [dict(denial, level="warning")], matching=0, others=1)
    rejected("another script URL", [dict(denial, text=text.replace(WORKLET, "dictation.js"))], matching=0, others=1)
    rejected("an unquoted worklet URL", [dict(denial, text=text.replace("'" + worklet + "'", worklet))], matching=0)
    rejected("another CSP entry beside the denial", [denial, frame], matching=1, others=1)
    rejected("a directive without 'unsafe-inline' first",
             [dict(denial, text=text.replace("script-src 'unsafe-inline'", "script-src 'self' 'unsafe-inline'"))],
             matching=1, directive_ok=False)
    rejected("a directive that allows the worklet", [dict(denial, text=text.replace(directive, directive + " " + worklet))],
             matching=1, directive_ok=False)
    if csp_log_verdict([network])["problems"] or not csp_log_verdict([network, frame])["problems"] or \
            not csp_log_verdict([denial])["problems"]:
        problems.append("every other case must allow non-CSP entries and reject any CSP entry")
    if log_entry({"entry": dict(denial, args=[{"objectId": "1"}], workerId="w1")}) != dict(denial, workerId="w1"):
        problems.append("log_entry must keep the raw source/level/text/url/timestamp and drop remote objects")
    return problems


def static_report():
    problems, report = [], {}
    problems += harness_self_check()
    for key in ("KIN_DICTATION_HOST_MAIN", "KIN_DICTATION_HOST_JS"):
        if os.environ.get(key):
            problems.append("%s is set: the slices would not come from the repository main.html" % key)
    # Assets and the tags that load them, in main.html's order.
    report["asset_sha256"] = {}
    for name in ASSETS:
        data = (LITE / name).read_bytes()
        report["asset_sha256"][name] = {"raw": sha256(data), "lf": sha256(data.replace(b"\r\n", b"\n"))}
    tags = ['<script src="%s"></script>' % name for name in PAGE_SCRIPTS]
    for label, text in (("main.html", MAIN), ("template", TEMPLATE)):
        positions = [text.find(tag) for tag in tags]
        if min(positions) < 0 or positions != sorted(positions):
            problems.append("%s must load the five page scripts in main.html's order" % label)
    if [TEMPLATE.count(tag) for tag in tags] != [1] * 5:
        problems.append("each page script is loaded exactly once")
    # CSP/COOP/COEP, parsed from the proxy template.
    for label, values in (("Content-Security-Policy", CSP_VALUES), ("Cross-Origin-Opener-Policy", COOP_VALUES),
                          ("Cross-Origin-Embedder-Policy", COEP_VALUES)):
        if len(values) != 1:
            problems.append("%s must be declared exactly once in nginx.conf.template (N-6), found %d"
                            % (label, len(values)))
    variant = nc11_csp("http://127.0.0.1:1")
    base, changed = CSP.split("; "), variant.split("; ")
    differing = [i for i, (a, b) in enumerate(zip(base, changed)) if a != b]
    if len(base) != len(changed) or len(differing) != 1 or not base[differing[0]].startswith("script-src "):
        problems.append("the NC-11 CSP must differ from :59 in script-src only (B-1)")
    elif changed[differing[0]] != "script-src 'unsafe-inline' " + " ".join(
            "http://127.0.0.1:1" + ASSET_DIR + name for name in PAGE_SCRIPTS):
        problems.append("the NC-11 script-src must be 'unsafe-inline' plus the five page scripts")
    if "worker-src 'self' blob:" not in base or "worker-src 'self' blob:" not in changed:
        problems.append("worker-src 'self' blob: must stay in both policies (DN-3)")
    report["csp"] = CSP
    report["coop_coep"] = [COOP, COEP]
    # Stand-ins and the template's own reach.
    page = page_html(default_state())
    for token in STANDIN_TOKENS:
        for label, text in (("served page", page), ("observer", OBSERVER), ("probes", "\n".join(PROBES.values()))):
            if token in text:
                problems.append("the U4 stand-in token %r is in the %s" % (token, label))
    for token in MEDIA_NETWORK_TOKENS:
        if token in TEMPLATE:
            problems.append("the template itself names %s; only product slices and the observer may" % token)
        for name, probe in PROBES.items():
            if token in probe:
                problems.append("probe %s names %s" % (name, token))
    problems += composition_problems()
    # No in-browser interception anywhere in U4b.
    for path in OWN_FILES:
        text = path.read_text(encoding="utf-8")
        for token in INTERCEPT_TOKENS:
            if token in text:
                problems.append("%s contains %s" % (path.name, token))
    source = SELF_PATH.read_text(encoding="utf-8")
    calls = re.findall(r"\.(evaluate|wait_for_function|evaluate_handle|add_init_script|add_script_tag|"
                       r"expose_function|expose_binding|set_extra_http_headers)\(([^,)]*)", source)
    for method, first in calls:
        # wait_for_function is not allowed at all: its predicate is re-run by the page after the call
        # returns, where the served CSP (no 'unsafe-eval') governs it [U]. Waits poll evaluate instead.
        allowed = (method == "evaluate" and first.startswith("PROBES[")) or \
                  (method == "add_init_script" and first == "script=OBSERVER")
        if not allowed:
            problems.append("page code outside PROBES/OBSERVER: .%s(%s" % (method, first))
    if sum(1 for method, _ in calls if method == "add_init_script") != 1:
        problems.append("exactly one init script, the observer")
    # D1/D2 pins (Astra runtime amendment 2026-09-23): the launch names the full pinned Chromium's channel;
    # the one CDP session only enables, listens to and disables the Log domain.
    parsed_source = ast.parse(source)
    method_calls = [node for node in ast.walk(parsed_source)
                    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)]
    launches = [call for call in method_calls if call.func.attr == "launch"]
    keywords = {kw.arg: getattr(kw.value, "value", None) for kw in launches[0].keywords} if len(launches) == 1 else {}
    if len(launches) != 1 or keywords.get("channel") != CHANNEL or keywords.get("headless") is not True:
        problems.append("the one browser launch must be channel=%r, headless=True" % CHANNEL)
    setup_text = next(ast.unparse(node) for node in ast.walk(parsed_source)
                      if isinstance(node, ast.FunctionDef) and node.name == "setUpClass")
    if setup_text.count("channel='%s'" % CHANNEL) != 1:
        problems.append("setUpClass must name channel=%r exactly once" % CHANNEL)
    if len([call for call in method_calls if call.func.attr == "new_cdp_session"]) != 1 or \
            [call for call in method_calls if call.func.attr == "new_browser_cdp_session"]:
        problems.append("exactly one page CDP session and no browser CDP session")
    sends = sorted(getattr(call.args[0], "value", None) if call.args else None
                   for call in method_calls if call.func.attr == "send")
    if sends != ["Log.disable", "Log.enable"]:
        problems.append("the CDP session may only send Log.enable and Log.disable, found %r" % sends)
    cdp_names = {node.value for node in ast.walk(parsed_source) if isinstance(node, ast.Constant)
                 and isinstance(node.value, str) and re.fullmatch(r"[A-Z][A-Za-z]+\.[a-z][A-Za-z]+", node.value)}
    if cdp_names - {"Log.enable", "Log.disable", "Log.entryAdded"}:
        problems.append("CDP names outside the Log domain: %r" % sorted(cdp_names))
    if not [call for call in method_calls if call.func.attr == "detach"]:
        problems.append("the CDP session must be detached on cleanup")
    # The observer only records and delegates.
    for token in OBSERVER_FORBIDDEN:
        if token in OBSERVER:
            problems.append("the observer contains %r" % token)
    for required, count in (("Reflect.apply(natives.getUserMedia, this, args)", 1),
                            ("const o = Reflect.construct(target, args);", 1),
                            ("Object.defineProperty(owner, name, { ...descriptor, value });", 1),
                            ("Object.defineProperty(window, '__u4b', { value: api });", 1),
                            ("replace(typeof MediaDevices === 'function' ? MediaDevices.prototype : null, "
                             "'getUserMedia', natives.getUserMedia && getUserMedia);", 1),
                            ("replace(window, 'AudioContext', wrappers.AudioContext);", 1),
                            ("replace(window, 'AudioWorkletNode', wrappers.AudioWorkletNode);", 1)):
        if OBSERVER.count(required) != count:
            problems.append("the observer must contain %r exactly %d time(s)" % (required, count))
    if OBSERVER.count("defineProperty(") != 2 or OBSERVER.count("replace(") != 4:
        problems.append("the observer replaces exactly getUserMedia, AudioContext and AudioWorkletNode")
    listened = re.findall(r"addEventListener\('([a-z]+)'", OBSERVER)
    if sorted(listened) != ["click", "click", "processorerror", "securitypolicyviolation",
                            "securitypolicyviolation", "statechange"]:
        problems.append("the observer listens to unexpected events: %r" % listened)
    # Pinned product literals the cases stand on.
    capture = (LITE / "dictation-capture.js").read_text(encoding="utf-8")
    worklet = (LITE / WORKLET).read_text(encoding="utf-8")
    host = (LITE / "dictation.js").read_text(encoding="utf-8")
    flat = re.sub(r"\s+", " ", capture)
    for label, text, literal, count in (
            ("capture:55", capture, "addModule('./dictation-worklet.js')", 1),
            ("capture:57-58", flat, "getUserMedia({ audio: { channelCount: 1, sampleRate: 16000, echoCancellation: "
                                    "false, noiseSuppression: false, autoGainControl: false }, video: false })", 1),
            ("capture:69-71", flat, "new env.AudioWorkletNode(context, 'kin-dictation-pcm', { channelCount: 1, "
                                    "channelCountMode: 'explicit', numberOfInputs: 1, numberOfOutputs: 1, "
                                    "outputChannelCount: [1], processorOptions: { maxFrames: Math.floor((maxBytes "
                                    "- 44) / 2) } })", 1),
            ("capture:84", capture, "state = 'recording'; source.connect(node); node.connect(context.destination);", 1),
            ("worklet:46", worklet, "registerProcessor('kin-dictation-pcm'", 1),
            ("worklet:8", worklet, "maxFrames > %d" % FULL_FRAMES, 1),
            ("host:261", host, "headers: { 'Content-Type': 'audio/wav', 'X-KIN-CSRF': '1' }", 1),
            ("host:373", host, "v.status = cur && cur.auto ? STATUS.capped : STATUS.uploading;", 1),
            ("host:28", host, "const UNCHANGED = '%s';" % UNCHANGED, 1),
            ("host:29", host, "const CANCELLED = '%s';" % CANCELLED, 1),
            ("main.html:1590", S["DICTATION_BLOCK"],
             'window.addEventListener("pagehide", () => dictation.pageExit());', 1),
            ("HD-06 trigger", HD_PATH.read_text(encoding="utf-8"),
             "appState[%s].holder = 'other@kin'; studies[0].holder = 'other@kin'; \"\n                       "
             "\"updateReportButtons(); })()", 1)):
        if text.count(literal) != count:
            problems.append("pinned literal %s moved: %r" % (label, literal[:80]))
    if FULL_FRAMES != (CAPABILITY["maxBytes"] - 44) // 2 or (SMALL_CAP - 44) // 2 != 16000:
        problems.append("the node maxFrames pins do not follow from maxBytes")
    # The fixture.
    wav = signal.fixture_wav()
    report["fixture"] = {"sha256": sha256(wav), "bytes": len(wav)}
    if sha256(wav) != signal.FIXTURE_SHA256:
        problems.append("the fixture no longer regenerates to its pin")
    # Path literals: tied to source, write methods bounded, never learned.
    if "fetch(API + path" not in API_FN or 'const API = "/api";' not in TEMPLATE:
        problems.append("api() no longer prefixes the glue's /api; the path literals would not be the wire paths")
    if PAGE_PATH.rsplit("/", 1)[0] + "/" != ASSET_DIR:
        problems.append("the page must sit beside the assets so ./dictation-worklet.js is the production path")
    sites = call_sites()
    report["call_sites"] = sorted("%s %s" % site for site in sites)
    if set(EXPECTED_API) != set(CASE_IDS) or set(REQUIRED_API) != set(CASE_IDS):
        problems.append("EXPECTED_API/REQUIRED_API must name exactly the browser cases")
    patterns = {p for case in CASE_IDS for p in EXPECTED_API.get(case, ())} | \
               {p for case in CASE_IDS for p in REQUIRED_API.get(case, {})} | set(FORBIDDEN_WRITES)
    for method, path in sorted(patterns):
        if (method, normalise(path.replace("{uid}", "${uid}"))) not in sites:
            problems.append("path literal %s %s has no call site in the served source" % (method, path))
    for case in CASE_IDS:
        expected, required = EXPECTED_API.get(case, ()), REQUIRED_API.get(case, {})
        for pattern in expected:
            if pattern[0] in WRITE_METHODS and pattern not in required:
                problems.append("%s allows %s %s without an exact count" % (case, *pattern))
        for pattern, count in required.items():
            if count and pattern not in expected:
                problems.append("%s requires %s %s but does not allow it" % (case, *pattern))
        for pattern in (DICTATION_POST, REPORT_PUT):
            if pattern not in required:
                problems.append("%s must count %s %s exactly" % (case, *pattern))
    # Launch arguments.
    args = launch_args(Path("/fixture.wav"))
    for flag in ("--use-fake-device-for-media-stream", "--use-file-for-fake-audio-capture=",
                 "--disable-audio-output"):
        if not any(arg.startswith(flag) for arg in args):
            problems.append("launch args lack %s" % flag)
    for flag in ("--use-fake-ui-for-media-stream", "--auto-accept-camera-and-microphone-capture",
                 "--autoplay-policy"):
        if any(arg.startswith(flag) for arg in args):
            problems.append("launch args must not carry %s" % flag)
    # Case ids stay dense and stable.
    tree = ast.parse(source)
    names = {node.name: [f.name for f in node.body if isinstance(f, ast.FunctionDef) and f.name.startswith("test_")]
             for node in tree.body if isinstance(node, ast.ClassDef)}
    ids = [re.match(r"test_(cap|nc)(\d\d)_", name) for name in names.get("ReportDictationCaptureDOMTest", [])]
    found = sorted(("CAP-%s" if m.group(1) == "cap" else "NC-%s") % m.group(2) for m in ids if m)
    if found != sorted(CASE_IDS) or len(ids) != len(CASE_IDS):
        problems.append("browser case ids must be exactly %s, found %s" % (", ".join(CASE_IDS), found))
    if [n[:10] for n in names.get("CaptureStaticTest", [])] != ["test_cap00"]:
        problems.append("CAP-00 is the one static case")
    report["cases"] = ["CAP-00"] + list(CASE_IDS)
    return problems, report


class CaptureStaticTest(unittest.TestCase):
    def test_cap00_static_pins_template_composition_and_path_literals(self):
        problems, report = static_report()
        emit("U4B-CAP CAP-00", dict(report, case="CAP-00", problems=problems, **{"pass": not problems}))
        self.assertEqual([], problems)


# ── The served origin ────────────────────────────────────────────────────────────────────────────
class CaptureServer:
    """A real loopback origin. It records every request in order and can hold one on an Event."""

    def __init__(self):
        self.lock = threading.Lock()
        self.entries, self.bodies, self.config = [], {}, {}
        self.t0 = time.monotonic()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_GET(self):
                owner.handle(self, "GET")

            def do_HEAD(self):
                owner.handle(self, "HEAD")

            def do_POST(self):
                owner.handle(self, "POST")

            def do_PUT(self):
                owner.handle(self, "PUT")

            def do_PATCH(self):
                owner.handle(self, "PATCH")

            def do_DELETE(self):
                owner.handle(self, "DELETE")

            def do_OPTIONS(self):
                owner.handle(self, "OPTIONS")

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.origin = "http://127.0.0.1:%d" % self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, name="u4b-origin", daemon=True)
        self.thread.start()

    def begin(self, case_id, **config):
        self.release_all()
        with self.lock:
            self.entries, self.bodies = [], {}
            self.t0 = time.monotonic()
            self.config = dict(config, case=case_id,
                               hold_worklet=threading.Event() if config.get("hold_worklet") else None,
                               hold_post=threading.Event() if config.get("hold_post") else None)

    def release_all(self):
        with self.lock:
            events = [self.config.get("hold_worklet"), self.config.get("hold_post")]
        for event in events:
            if event is not None:
                event.set()

    def release(self, name, answer=None):
        with self.lock:
            if answer is not None:
                self.config["post_answer"] = answer
            event = self.config.get(name)
        event.set()

    def snapshot(self):
        with self.lock:
            return [dict(entry, headers=dict(entry["headers"])) for entry in self.entries]

    def body(self, seq):
        with self.lock:
            return self.bodies.get(seq, b"")

    def stop(self):
        self.release_all()
        self.httpd.shutdown()
        self.httpd.server_close()

    @staticmethod
    def read_body(request):
        length = request.headers.get("Content-Length")
        if length is not None:
            return request.rfile.read(int(length))
        if "chunked" in (request.headers.get("Transfer-Encoding") or "").lower():
            chunks = []
            while True:
                size = int(request.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    request.rfile.readline()
                    return b"".join(chunks)
                chunks.append(request.rfile.read(size))
                request.rfile.readline()
        return b""

    def hold(self, event, entry):
        if event is None:
            return True
        with self.lock:
            entry["held"] = True
        released = event.wait(HOLD_SECONDS)
        with self.lock:
            entry["released_ms"] = round((time.monotonic() - self.t0) * 1000, 1)
        return released

    def handle(self, request, method):
        split = urlsplit(request.path)
        path = split.path
        try:
            body, unreadable = self.read_body(request), None
        except Exception as error:      # recorded and answered, never left hanging
            body, unreadable = b"", str(error)[:200]
        with self.lock:
            config = self.config
            entry = {"seq": len(self.entries), "t_ms": round((time.monotonic() - self.t0) * 1000, 1),
                     "method": method, "path": path, "query": split.query,
                     "headers": {name: request.headers.get(name) for name in LOGGED_HEADERS},
                     "body_len": len(body), "body_sha256": sha256(body), "status": None, "answered_by": None,
                     "held": False, "content_type": None, "unreadable_body": unreadable}
            self.entries.append(entry)
            if method in WRITE_METHODS:
                self.bodies[entry["seq"]] = body
        try:
            status, headers, payload, answered_by = self.answer_for(method, path, entry, config)
        except Exception as error:
            status, headers, payload, answered_by = 500, {"Content-Type": "text/plain"}, b"", "server-error"
            with self.lock:
                entry["server_error"] = str(error)[:300]
        try:
            request.send_response(status)
            for name, value in headers.items():
                request.send_header(name, value)
            request.send_header("Cache-Control", "no-store")
            request.send_header("Content-Length", str(len(payload)))
            request.end_headers()
            if method != "HEAD":
                request.wfile.write(payload)
            gone = False
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            gone = True
        with self.lock:
            entry.update(status=status, answered_by=answered_by, content_type=headers.get("Content-Type"),
                         done_ms=round((time.monotonic() - self.t0) * 1000, 1), client_gone=gone)

    def answer_for(self, method, path, entry, config):
        security = {"Content-Security-Policy": config.get("csp", CSP), "Cross-Origin-Opener-Policy": COOP,
                    "Cross-Origin-Embedder-Policy": COEP}
        as_json = {"Content-Type": "application/json"}
        if method == "GET" and path == PAGE_PATH:
            headers = dict(security, **config.get("page_headers", {}))
            headers["Content-Type"] = "text/html; charset=utf-8"
            return 200, headers, config["page"], "page"
        if method == "GET" and path == AFTER_EXIT_PATH:
            return 200, dict(security, **{"Content-Type": "text/html; charset=utf-8"}), AFTER_EXIT_HTML, "page"
        name = path[len(ASSET_DIR):] if path.startswith(ASSET_DIR) else None
        if method == "GET" and name in ASSETS:
            data = (LITE / name).read_bytes()
            with self.lock:
                entry["served_sha256"] = sha256(data)
            kind = "text/javascript; charset=utf-8"
            if name == WORKLET:
                kind = config.get("worklet_type", kind)
                if not self.hold(config.get("hold_worklet"), entry):
                    return 504, {"Content-Type": "text/plain"}, b"", "hold-timeout"
            return 200, dict(security, **{"Content-Type": kind}), data, "asset"
        if path.startswith("/api/"):
            match = re.fullmatch(r"/api/studies/[^/]+/(dictation|hold|release|report/citations|report/structure)", path)
            kind = match.group(1) if match else None
            if method == "POST" and kind == "dictation":
                if not self.hold(config.get("hold_post"), entry):
                    return 504, as_json, b'{"code":"U4B_HOLD_TIMEOUT"}', "hold-timeout"
                with self.lock:
                    status, answer = self.config.get("post_answer") or (500, {"code": "U4B_NO_ANSWER"})
                return status, as_json, json.dumps(answer, ensure_ascii=False).encode("utf-8"), "contract"
            if method == "POST" and kind in ("hold", "release"):
                return 200, as_json, json.dumps({"holder": "doctor@kin", "conflict": False}).encode(), "contract"
            if method == "GET" and kind == "report/citations":
                return 200, as_json, b'{"version":1,"head":[],"draft":[]}', "contract"
            if method == "GET" and kind == "report/structure":
                return 200, as_json, b'{"version":0,"unknown":false,"head":[],"draft":[]}', "contract"
            # HD's catch-all (report_dictation_host_dom_test.py:299-301): alive, recorded, never allowed.
            return 200, as_json, b"{}", "fallback"
        return 404, {"Content-Type": "text/plain; charset=utf-8"}, b"", "404"


# ── One case ─────────────────────────────────────────────────────────────────────────────────────
class CaseStop(Exception):
    pass


class Case:
    def __init__(self, test, case_id, title):
        self.test, self.id, self.title = test, case_id, title
        self.server = test.server
        self.page = self.strings = None
        self.started = time.monotonic()
        self.deadline = self.started + CASE_SECONDS
        self.checks, self.observed = [], {}
        self.page_errors, self.console, self.saved_violations = [], [], []
        self.user_activation = self.press_activation = None
        self.cdp, self.log_entries = None, []

    def left_ms(self):
        return max(1, int((self.deadline - time.monotonic()) * 1000))

    def check(self, name, ok, detail=None):
        self.checks.append({"name": name, "ok": bool(ok), "detail": detail})
        return bool(ok)

    def require(self, name, ok, detail=None):
        if not self.check(name, ok, detail):
            raise CaseStop(name)

    def js(self, name, arg=None):
        return self.page.evaluate(PROBES[name], arg)

    def read_state(self):
        try:
            return self.js("state")
        except Exception as error:
            return "unreadable: " + (str(error).splitlines()[0][:200] if str(error) else type(error).__name__)

    def primary(self):
        """Session, pane and media as the page has them now: the first cause, not the wait that followed."""
        try:
            value = self.snap()
        except Exception as error:
            return {"unreadable": str(error).splitlines()[0][:300] if str(error) else type(error).__name__}
        media = value.get("media") or {}
        return {"session": {"state": value["session"]["state"], "error": value["session"]["error"]},
                "pane_status": value["pane"]["status"], "gum_calls": media.get("gumCalls"),
                "tracks": media.get("tracks"),
                "contexts": [{"state": c.get("state"), "sampleRate": c.get("sampleRate"), "states": c.get("states")}
                             for c in media.get("contexts") or []],
                "nodes": len(media.get("nodes") or []), "worklet_gets": media.get("modules"),
                # page.console drops worker-source lines (review N-3); the raw Log session keeps them.
                "console": self.console[-10:], "log_tail": self.log_entries[-10:]}

    def stop_waiting(self, what, detail, terminal):
        self.observed["primary"] = self.primary()
        self.require(what, False, dict(detail, ended_by="terminal-state" if terminal else "deadline",
                                       primary=self.observed["primary"]))

    def wait_state(self, target, what):
        """Wait for the session state `target`. Another terminal state ends the wait at once and records
        what the page says caused it. In the first hosted run (35841141421/1) the capture had already
        failed while seven cases waited out their 20 s deadline without recording why."""
        while True:
            state = self.read_state()
            if state == target:
                return
            terminal = state in TERMINAL_STATES
            if terminal or time.monotonic() >= self.deadline:
                self.stop_waiting(what, {"state": state, "target": target}, terminal)
            self.page.wait_for_timeout(25)

    def wait_js(self, name, arg, what, while_active=False):
        """Polled from Python, one evaluate per step. A page-side polled predicate would run later,
        outside the evaluate call, under a CSP without 'unsafe-eval'; every wait here stays inside one.
        With while_active, a terminal session state ends the wait at once (see wait_state)."""
        last = None
        while True:
            try:
                if self.js(name, arg) is True:
                    return
            except Exception as error:
                last = str(error).splitlines()[0][:300] if str(error) else type(error).__name__
            state = self.read_state() if while_active else None
            terminal = while_active and state in TERMINAL_STATES
            if terminal or time.monotonic() >= self.deadline:
                self.stop_waiting(what, {"last_error": last, "state": state or self.read_state()}, terminal)
            self.page.wait_for_timeout(25)

    def wait_server(self, predicate, what, while_active=False):
        while True:
            entries = self.server.snapshot()
            if predicate(entries):
                return entries
            state = self.read_state() if while_active else None
            terminal = while_active and state in TERMINAL_STATES
            if terminal or time.monotonic() >= self.deadline:
                # The page may reach its terminal state from a response the server has not yet marked
                # answered; look once more before calling it a failure.
                entries = self.server.snapshot()
                if predicate(entries):
                    return entries
                self.stop_waiting(what, {"requests": [line(e) for e in entries], "state": state}, terminal)
            self.page.wait_for_timeout(25)

    def snap(self):
        value = self.js("snapshot")
        entries = self.server.snapshot()
        value["dict"] = [{"method": e["method"], "path": e["path"], "length": e["body_len"],
                          "content_type": e["headers"]["Content-Type"], "status": e["status"],
                          "answered_by": e["answered_by"], "held": e["held"]}
                         for e in entries if is_dictation_post(e)]
        value["media"]["modules"] = [e["path"] for e in entries if e["path"] == ASSET_DIR + WORKLET]
        return value

    def unchanged(self, name, value):
        self.check(name, value["text"] == [EXISTING, "", ""], value["text"])


def line(entry):
    return "%s %s %s %s" % (entry["method"], entry["path"] + ("?" + entry["query"] if entry["query"] else ""),
                            entry["answered_by"], entry["status"])


def is_dictation_post(entry):
    return (entry["method"], entry["path"]) == resolve(DICTATION_POST)


def served(entries, name):
    return [e for e in entries if e["method"] == "GET" and e["path"] == ASSET_DIR + name]


# D1 (Astra runtime amendment 2026-09-23): the full pinned Chromium, observed from the actual launch.
# Pinned Playwright 1.60 starts chromium-headless-shell for headless=True without a channel, and that
# shell's WebContents delegate answers every media request NOT_SUPPORTED (web_contents_delegate.cc:285-294
# at 148.0.7778.96; first hosted run 35841141421/1). BrowserType.executable_path never proves the launch.
CHANNEL = "chromium"
FULL_CHROMIUM_SUFFIX = "/chromium-1223/chrome-linux64/chrome"
FORBIDDEN_LAUNCH_FLAGS = ("--use-fake-ui-for-media-stream", "--auto-accept-camera-and-microphone-capture",
                          "--autoplay-policy")
LAUNCH_FLAGS = ("--headless", "--mute-audio", "--use-fake-device-for-media-stream", "--use-file-for-fake-audio-capture",
                "--disable-audio-output") + FORBIDDEN_LAUNCH_FLAGS
LAUNCH_NOTABLE = re.compile(r"ERROR|WARNING|[Pp]ermission|MediaStream|media_stream|Not supported|getUserMedia|[Aa]udio")
DELEGATE_NOT_SUPPORTED = "WebContentsDelegate::RequestMediaAccessPermission: Not supported."


def parse_launch(text):
    """Playwright's `<launching> <command> <args>` line and the browser's own notable stderr lines."""
    rows = text.splitlines()
    launching = [row.split("<launching> ", 1)[1] for row in rows if "<launching> " in row]
    command = launching[0].split(" ") if launching else []
    return {"lines": len(rows), "launching": launching[:2], "executable": command[0] if command else None,
            "chrome_headless_shell": bool(command) and command[0].endswith("chrome-headless-shell"),
            "flags": {flag: any(arg == flag or arg.startswith(flag + "=") for arg in command[1:]) for flag in LAUNCH_FLAGS},
            # Recorded only: stderr logging of this line is not guaranteed.
            "delegate_not_supported_logged": any("[err]" in row and DELEGATE_NOT_SUPPORTED in row for row in rows),
            "notable": [row[:400] for row in rows if "<launching> " not in row and LAUNCH_NOTABLE.search(row)][:60]}


def launch_problems(parsed):
    """The CAP-01 launch oracle: the first actual launch is the full pinned Chromium, without forbidden flags."""
    problems = {"binary": [], "forbidden": []}
    executable = (parsed or {}).get("executable") or ""
    if not executable:
        problems["binary"].append("no <launching> line was observed")
    elif not executable.endswith(FULL_CHROMIUM_SUFFIX) or executable.endswith("chrome-headless-shell"):
        problems["binary"].append("launched %s, not the full pinned Chromium (*%s)" % (executable, FULL_CHROMIUM_SUFFIX))
    flags = (parsed or {}).get("flags") or {}
    problems["forbidden"] = [flag for flag in FORBIDDEN_LAUNCH_FLAGS if flags.get(flag)]
    return problems


def launch_record(path):
    """Recorded, never asserted: which binary actually ran and what it logged."""
    try:
        return dict(parse_launch(path.read_text(encoding="utf-8", errors="replace")), log=path.name)
    except OSError as error:
        return {"unavailable": str(error)}


# D2 (Astra runtime amendment 2026-09-23): the worklet's CSP denial as the browser logs it. Blink sends
# no securitypolicyviolation event and no report for a worklet (execution_context_csp_delegate.cc:282-284,
# :172-178); the threaded worklet's console line reaches the page with source "worker"
# (threaded_messaging_proxy_base.cc:130-143, console_message.cc:32-42), which Playwright's page.console
# drops. A raw CDP Log session on the page target observes it; it only enables, listens and disables.
CSP_PHRASE = "Content Security Policy"
LOG_KEYS = ("source", "level", "text", "url", "timestamp", "lineNumber", "category", "workerId", "networkRequestId")


def log_entry(params):
    entry = (params or {}).get("entry") or {}
    return {key: entry.get(key) for key in LOG_KEYS if key in entry}


def csp_log_verdict(entries, worklet_url=None):
    """With worklet_url (NC-11): exactly one CSP entry, from the worker source at error level, naming the
    single-quoted worklet URL and 'Content Security Policy directive' (csp_directive_list.cc:683-687), whose
    quoted raw directive starts with script-src 'unsafe-inline' and does not allow the worklet, and zero
    other CSP entries. Without it (every other case): zero CSP entries."""
    csp = [entry for entry in entries if CSP_PHRASE in (entry.get("text") or "")]
    verdict = {"csp_entries": csp, "problems": [], "matching": 0, "others": len(csp), "directive": None,
               "directive_ok": False, "fallback_note": None}
    if worklet_url is None:
        if csp:
            verdict["problems"].append("%d CSP log entries where none may occur" % len(csp))
        return verdict
    quoted = "'%s'" % worklet_url
    matching = [entry for entry in csp if entry.get("source") == "worker" and entry.get("level") == "error"
                and quoted in (entry.get("text") or "") and CSP_PHRASE + " directive" in (entry.get("text") or "")]
    verdict["matching"] = len(matching)
    verdict["others"] = len([entry for entry in csp if not any(entry is match for match in matching)])
    if verdict["matching"] != 1:
        verdict["problems"].append("expected exactly one worker/error CSP entry naming %s, found %d"
                                   % (quoted, verdict["matching"]))
    if verdict["others"]:
        verdict["problems"].append("%d other CSP log entries" % verdict["others"])
    if verdict["matching"] == 1:
        text = matching[0]["text"]
        directive = re.search(r'Content Security Policy directive: "([^"]*)"', text)
        fallback = re.search(r"Note that '[^']+' was not explicitly set, so '[^']+' is used as a fallback\.", text)
        verdict["directive"] = directive.group(1) if directive else None
        verdict["fallback_note"] = fallback.group(0) if fallback else None     # recorded, not asserted
        verdict["directive_ok"] = verdict["directive"] is not None and \
            verdict["directive"].startswith("script-src 'unsafe-inline'") and worklet_url not in verdict["directive"]
        if not verdict["directive_ok"]:
            verdict["problems"].append("the quoted directive must start with script-src 'unsafe-inline' and must "
                                       "not allow the worklet: %r" % verdict["directive"])
    return verdict


class ReportDictationCaptureDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.results = []
        try:
            ARTIFACTS.mkdir(parents=True, exist_ok=False)     # a fresh directory, never reused
            fixture = signal.fixture_wav()
            if sha256(fixture) != signal.FIXTURE_SHA256:
                raise AssertionError("the fixture does not regenerate to its pin")
            cls.fixture_path = (ARTIFACTS / "fixture.wav").resolve()
            cls.fixture_path.write_bytes(fixture)
            cls.asset_sha = {name: sha256((LITE / name).read_bytes()) for name in ASSETS}
            cls.page_bytes = page_html(default_state()).encode("utf-8")
            cls.server = CaptureServer()
            cls.origin = cls.server.origin
            from importlib.metadata import version
            from playwright.sync_api import sync_playwright
            # Playwright's own pw:browser log names the binary it starts (`<launching> <command> <args>`)
            # and carries the browser's stderr; BrowserType.executable_path is only the default path. The
            # channel selects the full pinned Chromium (D1); CAP-01 asserts it from the actual launch line.
            cls.browser_log = (ARTIFACTS / "browser-debug.log").resolve()
            os.environ["DEBUG"] = "pw:browser"
            os.environ["DEBUG_FILE"] = str(cls.browser_log)
            cls._pw = sync_playwright().start()
            args = launch_args(cls.fixture_path)
            cls.browser = cls._pw.chromium.launch(channel="chromium", headless=True, args=args)
            # The first launch record, written now: a step cut later must not lose it (review N-2).
            cls.launch_first = cls.read_launch(seconds=5)
            (ARTIFACTS / "launch-first.json").write_text(json.dumps(cls.launch_first, ensure_ascii=False, indent=2) + "\n",
                                                         encoding="utf-8")
            emit("U4B-LAUNCH-FIRST", cls.launch_first)
            cls.browser_info = {"version": cls.browser.version, "channel": CHANNEL,
                                "browser_type_default_executable_path": cls._pw.chromium.executable_path,
                                "launched_executable": cls.launch_first.get("executable"),
                                "args": args, "headless": True, "playwright": version("playwright"),
                                "origin": cls.origin, "fixture": {"path": str(cls.fixture_path),
                                                                  "sha256": sha256(fixture), "bytes": len(fixture)}}
            emit("U4B-BROWSER", cls.browser_info)
        except Exception:
            emit("U4B-SETUP", {"pass": False, "error": traceback.format_exc()[-2000:]})
            cls.close_all()
            raise

    @classmethod
    def read_launch(cls, seconds=0):
        """The launch record from the pw:browser log. The driver writes the log asynchronously, so a
        first read may wait (bounded) for the `<launching>` line; absence is recorded, never invented."""
        until = time.monotonic() + seconds
        while True:
            record = launch_record(cls.browser_log)
            if record.get("executable") or time.monotonic() >= until:
                return record
            time.sleep(0.05)

    @classmethod
    def close_all(cls):
        for name, closer in (("browser", "close"), ("_pw", "stop"), ("server", "stop")):
            try:
                getattr(getattr(cls, name), closer)()
            except Exception:
                pass

    @classmethod
    def tearDownClass(cls):
        cls.close_all()
        launch = launch_record(cls.browser_log)
        (ARTIFACTS / "launch.json").write_text(json.dumps(launch, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        emit("U4B-LAUNCH", launch)
        summary = {"cases": {r["case"]: r["pass"] for r in cls.results},
                   "all_pass": bool(cls.results) and all(r["pass"] for r in cls.results)}
        (ARTIFACTS / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        manifest = {p.name: {"sha256": sha256(p.read_bytes()), "bytes": p.stat().st_size}
                    for p in sorted(ARTIFACTS.iterdir()) if p.is_file() and p.name != "manifest.json"}
        (ARTIFACTS / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        emit("U4B-SUMMARY", summary)

    # ── the case frame ────────────────────────────────────────────────────────────────────────
    def run_case(self, case_id, title, scenario, grant=True, capability=CAPABILITY, **config):
        case = Case(self, case_id, title)
        context = None
        try:
            self.server.begin(case_id, page=self.page_bytes, csp=config.pop("csp", CSP), **config)
            context = self.browser.new_context(viewport={"width": 1680, "height": 1100})
            if grant:
                context.grant_permissions(["microphone"], origin=self.origin)
            context.add_init_script(script=OBSERVER)
            case.page = context.new_page()
            case.page.on("pageerror", lambda error: case.page_errors.append(str(error)[:500]))
            case.page.on("console", lambda message: case.console.append(
                "%s: %s" % (message.type, message.text[:300])) if message.type in ("error", "warning") else None)
            # D2: observation only. Log.enable, the entryAdded listener and Log.disable are the whole session.
            case.cdp = context.new_cdp_session(case.page)
            case.cdp.on("Log.entryAdded", lambda params: case.log_entries.append(log_entry(params)))
            case.cdp.send("Log.enable")
            scenario(case, capability)
        except CaseStop:
            pass
        except Exception:
            case.check("harness", False, traceback.format_exc()[-1500:])
        finally:
            self.finish(case, context)
        failed = [c for c in case.checks if not c["ok"]]
        self.assertEqual([], failed, "%s failed; see the U4B-CAP line" % case_id)

    def finish(self, case, context):
        page_side = {}
        if case.page is not None:
            for name in ("violations", "clicks"):
                try:
                    page_side[name] = case.js(name)
                except Exception as error:
                    page_side[name] = None
                    case.observed.setdefault("unreadable", []).append("%s: %s" % (name, str(error)[:200]))
        if case.cdp is not None:
            # Let entries already posted by the browser arrive, then stop the Log domain and detach.
            for step in (lambda: case.page.wait_for_timeout(150), lambda: case.cdp.send("Log.disable"),
                         lambda: case.cdp.detach()):
                try:
                    step()
                except Exception as error:
                    case.observed.setdefault("log_session_cleanup", []).append(str(error).splitlines()[0][:200]
                                                                                 if str(error) else type(error).__name__)
        if context is not None:
            try:
                context.close()
            except Exception:
                pass
        self.server.release_all()
        time.sleep(0.05)
        entries = self.server.snapshot()
        api = [e for e in entries if e["path"].startswith("/api/")]
        other = [e for e in entries if not e["path"].startswith("/api/")]
        violations = case.saved_violations + (page_side.get("violations") or [])
        expected = {resolve(p) for p in EXPECTED_API[case.id]}
        case.check("api-within-expected", all((e["method"], e["path"]) in expected and not e["query"] for e in api),
                   [line(e) for e in api if (e["method"], e["path"]) not in expected or e["query"]])
        for pattern, count in REQUIRED_API[case.id].items():
            actual = sum(1 for e in api if (e["method"], e["path"]) == resolve(pattern))
            case.check("count %s %s" % pattern, actual == count, {"expected": count, "actual": actual})
        writes = [line(e) for e in api if e["method"] in WRITE_METHODS and (e["method"], e["path"]) not in expected]
        case.check("no-write-outside-literals", not writes, writes)
        forbidden = [line(e) for e in api if (e["method"], e["path"]) in {resolve(p) for p in FORBIDDEN_WRITES}
                     and (e["method"], e["path"]) not in expected]
        case.check("no-forbidden-write", not forbidden, forbidden)
        # Only /favicon.ico may go unanswered: browsers may ask for it on their own [A].
        missing = [line(e) for e in other if e["answered_by"] == "404" and e["path"] != "/favicon.ico"]
        case.check("no-404", not missing, missing)
        case.check("no-hold-timeout-or-server-error", not [line(e) for e in entries if e["answered_by"] in
                                                           ("hold-timeout", "server-error") or e["unreadable_body"]])
        drift = [e["path"] for e in other if "served_sha256" in e and
                 e["served_sha256"] != self.asset_sha[e["path"][len(ASSET_DIR):]]]
        case.check("assets-byte-exact", not drift, drift)
        if case.id != "NC-11":
            case.check("zero-csp-violations", not violations, violations)
            log_verdict = csp_log_verdict(case.log_entries)
            case.check("zero-csp-log-entries", not log_verdict["problems"], log_verdict["csp_entries"])
        else:
            # D2: the browser's worklet denial replaces the superseded document-event limb, which stays an
            # observation (Blink sends worklets no events; expected 0).
            log_verdict = csp_log_verdict(case.log_entries, self.origin + ASSET_DIR + WORKLET)
            case.observed["dom_violations"] = {"count": len(violations), "events": violations}
            case.observed["worklet_denial"] = {k: log_verdict[k] for k in ("directive", "fallback_note", "csp_entries")}
            if log_verdict["directive"] is not None:
                case.observed["worklet_denial"]["directive_equals_served_script_src"] = \
                    log_verdict["directive"] == next(d for d in nc11_csp(self.origin).split("; ")
                                                     if d.startswith("script-src "))
            case.check("worklet-csp-denial-logged-once", log_verdict["matching"] == 1, log_verdict["problems"])
            case.check("denial-directive-script-src-unsafe-inline-without-worklet", log_verdict["directive_ok"],
                       log_verdict["directive"])
            case.check("zero-other-csp-log-entries", log_verdict["others"] == 0, log_verdict["csp_entries"])
        case.check("no-page-error", not case.page_errors, case.page_errors)
        clicks = page_side.get("clicks") or case.observed.get("clicks_before_exit") or []
        record = {
            "case": case.id, "title": case.title,
            "pass": all(c["ok"] for c in case.checks),
            "failures": [c for c in case.checks if not c["ok"]],
            "checks": {c["name"]: c["ok"] for c in case.checks},
            "api_requests": [line(e) for e in api],
            "other_requests": [line(e) for e in other],
            "violations": violations,
            "user_activation": {"after_press": case.user_activation,
                                "at_press": [c.get("activation") for c in clicks if c.get("id") == "b-dictate"]},
            "clicks": [{k: c.get(k) for k in ("id", "t", "trusted", "after")} for c in clicks],
            "observed": case.observed,
            "console": case.console[:40],
            "log_entries": case.log_entries[:200], "log_entry_count": len(case.log_entries),
            "csp_log_entries": log_verdict["csp_entries"],
            "elapsed_s": round(time.monotonic() - case.started, 3),
        }
        if case.id == "CAP-01":
            record["blocked"] = not record["pass"]
        emit("U4B-CAP " + case.id, record)
        self.results.append(record)
        artifact = dict(record, requests=entries, browser=self.browser_info)
        (ARTIFACTS / ("%s.json" % case.id)).write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n",
                                                       encoding="utf-8")

    # ── shared steps ──────────────────────────────────────────────────────────────────────────
    def open(self, case, capability):
        case.page.goto(self.origin + PAGE_PATH, timeout=case.left_ms())
        # The first page-side read. Playwright may run evaluate with a simulated user gesture [U]; if
        # this already says hasBeenActive, activation at the press cannot be credited to the click alone.
        case.observed["activation_at_first_evaluate"] = case.js("activation")
        case.wait_js("started", None, "harness started")
        case.js("load")
        case.wait_server(lambda es: all(any((e["method"], e["path"]) == resolve(p) and e["status"] is not None
                                            for e in es) for p in (CITATIONS_GET, STRUCTURE_GET)),
                         "the report reads were answered")
        case.js("capability", capability)
        case.strings = case.js("strings")
        before = case.snap()
        case.observed["before"] = {"text": before["text"], "button": before["button"], "secure": before["secure"]}
        return before

    def ready(self, case, before):
        case.require("dictate-enabled", before["button"]["disabled"] is False, before["button"])
        case.require("report-initial", before["text"] == [EXISTING, "", ""], before["text"])

    def press(self, case):
        """The real Dictate click (N-2). Activation is read inside the click event by the observer and
        once more right after it."""
        case.page.click("#b-dictate", timeout=case.left_ms())
        case.user_activation = case.js("activation")
        presses = [c for c in case.js("clicks") if c["id"] == "b-dictate"]
        case.press_activation = presses[-1]["activation"] if presses else None

    def failed_with(self, case, value, reason):
        case.check("pane " + reason, value["pane"]["status"] == case.strings["reasons"][reason] + UNCHANGED,
                   value["pane"]["status"])

    def tracks_ended(self, case, name, value):
        tracks = value["media"]["tracks"]
        case.check(name, bool(tracks) and all(t["readyState"] == "ended" for t in tracks), tracks)

    def contexts_closed(self, case):
        case.wait_js("contexts_closed", None, "every AudioContext closed")

    def upload(self, case, entry, max_bytes):
        """U1-U4 on the wire bytes of one dictation POST; the WAV is kept as an artifact."""
        body = self.server.body(entry["seq"])
        headers = entry["headers"]
        u1 = {k: headers[k] for k in ("Content-Type", "X-KIN-CSRF", "Authorization", "Cookie", "Content-Length",
                                      "Transfer-Encoding", "Sec-Fetch-Mode")}
        u1_ok = (headers["Content-Type"] == "audio/wav" and headers["X-KIN-CSRF"] == "1" and
                 headers["Authorization"] is None and entry["path"] == resolve(DICTATION_POST)[1] and
                 headers["Content-Length"] == str(len(body)))
        verdict = signal.judge(body, max_bytes)
        name = "%s-dictation-%d.wav" % (case.id, entry["seq"])
        (ARTIFACTS / name).write_bytes(body)
        signal_reasons = [r for r in verdict["signal"]["reasons"] if r != "all-zero"]
        case.observed["upload"] = {"artifact": name, "sha256": verdict["sha256"], "length": len(body), "u1": u1,
                                   "u2": verdict["layout"], "u3": {"reasons": signal_reasons,
                                                                   "windows": verdict["signal"]["windows"]},
                                   "u4_all_zero": verdict["signal"]["all_zero"],
                                   "frames": verdict["layout"]["frames"]}
        return body, verdict, u1_ok, signal_reasons

    def post_entry(self, case, held):
        # Arrival is enough when unheld: the body is read before any answer, and the caller then waits
        # for the state the answer produces.
        entries = case.wait_server(lambda es: any(is_dictation_post(e) and (e["held"] if held else True)
                                                  for e in es), "the dictation POST arrived", while_active=True)
        return [e for e in entries if is_dictation_post(e)][0]

    # ── cases ─────────────────────────────────────────────────────────────────────────────────
    def test_cap01_environment_pins_the_secure_origin_the_grant_and_untouched_natives(self):
        def scenario(case, capability):
            # D1: the actual first launch, from Playwright's own <launching> line (BLOCKED class).
            launch = self.launch_first if self.launch_first.get("executable") else self.read_launch(seconds=2)
            case.observed["launch"] = {k: launch.get(k) for k in ("executable", "flags", "launching", "unavailable")}
            case.observed["launch_headless_flag"] = (launch.get("flags") or {}).get("--headless")    # recorded
            problems = launch_problems(launch)
            case.check("launched-full-chromium", not problems["binary"], problems["binary"])
            case.check("launch-forbidden-flags-absent", not problems["forbidden"], problems["forbidden"])
            before = self.open(case, capability)
            env = case.js("environment")
            permission = case.js("permission")
            case.observed.update(environment=env, permission=permission, browser=self.browser_info)
            case.check("browser-version", self.browser.version == BROWSER_VERSION, self.browser.version)
            case.check("secure-context", env["secure"] is True and before["secure"] is True, env["secure"])
            case.check("microphone-granted", permission == "granted", permission)
            case.check("fetch-is-the-saved-native", env["fetchIsNative"] is True)
            case.check("getUserMedia-is-the-wrapper-over-the-saved-native",
                       env["gumIsWrapper"] is True and env["gumNative"] is True)
            case.check("constructor-observers-over-the-saved-natives", env["contextObserved"] is True and
                       env["nodeObserved"] is True and env["contextTarget"] is True and env["nodeTarget"] is True)
            self.ready(case, before)
            self.press(case)
            entries = case.wait_server(lambda es: any(e["status"] for e in served(es, WORKLET)),
                                       "the worklet GET was answered")
            worklet = served(entries, WORKLET)[0]
            # Recorded, not asserted.
            case.observed["worklet_get"] = {"sec_fetch_dest": worklet["headers"]["Sec-Fetch-Dest"],
                                            "sec_fetch_mode": worklet["headers"]["Sec-Fetch-Mode"],
                                            "status": worklet["status"]}
            case.observed["crossOriginIsolated"] = env["crossOriginIsolated"]
            # Recorded, not asserted: where the chain went after the worklet, with its primary cause. No
            # cleanup click: in the first hosted run a state read here went stale before a Cancel click
            # (getUserMedia was refused in between), and the click on the now hidden button timed out
            # after 20 s. Closing the context ends any recording.
            settle = min(case.deadline, time.monotonic() + 3)
            state = case.read_state()
            while state == "requesting-permission" and time.monotonic() < settle:
                case.page.wait_for_timeout(50)
                state = case.read_state()
            case.observed["state_after_worklet"] = state
            case.observed["capture_outcome"] = case.primary()
            # Recorded only: whether the browser logged the base delegate's refusal (stderr level is not pinned).
            case.observed["delegate_not_supported_logged"] = self.read_launch().get("delegate_not_supported_logged")
        self.run_case("CAP-01", "environment", scenario)

    def test_cap02_real_capture_uploads_16k_mono_pcm16_and_inserts_only_on_insert(self):
        def scenario(case, capability):
            before = self.open(case, capability)
            self.ready(case, before)
            case.page.focus("#findings", timeout=case.left_ms())
            case.js("put", ["findings", 3])                         # end of "첫 줄"
            self.press(case)
            case.check("hasBeenActive-at-press", (case.press_activation or {}).get("hasBeenActive") is True,
                       {"in_click_event": case.press_activation, "after_click": case.user_activation})
            case.wait_state("recording", "recording")
            media = case.js("media")
            contexts, nodes, gum = media["contexts"], media["nodes"], media["gumCalls"]
            case.observed.update(contexts=contexts, nodes=nodes, gum=gum, tracks=media["tracks"])
            case.check("one-context-16k", len(contexts) == 1 and contexts[0]["sampleRate"] == 16000 and
                       contexts[0]["native"] is True, contexts)
            case.check("context-running", bool(contexts) and contexts[0]["state"] == "running", contexts)
            options = nodes[0]["options"] if nodes else None
            case.check("node-options", len(nodes) == 1 and nodes[0]["name"] == "kin-dictation-pcm" and
                       nodes[0]["native"] is True and options["channelCount"] == 1 and
                       options["channelCountMode"] == "explicit" and options["outputChannelCount"] == [1] and
                       options["processorOptions"] == {"maxFrames": FULL_FRAMES}, nodes)
            case.check("one-granted-capture", len(gum) == 1 and gum[0]["outcome"] == "resolved" and
                       len(media["tracks"]) >= 1 and all(t["readyState"] == "live" for t in media["tracks"]), gum)
            case.wait_js("recorded_for", 2000, "2.0 s after the worklet node", while_active=True)
            case.page.click("#dictation-stop", timeout=case.left_ms())
            entry = self.post_entry(case, held=True)
            held = case.snap()
            self.tracks_ended(case, "tracks-ended-while-held", held)
            case.check("pane-uploading-while-held", held["session"]["state"] == "uploading" and
                       held["pane"]["status"] == case.strings["uploading"], [held["session"], held["pane"]["status"]])
            case.unchanged("report-unchanged-while-held", held)
            body, verdict, u1_ok, reasons = self.upload(case, entry, CAPABILITY["maxBytes"])
            case.check("U1", u1_ok, case.observed["upload"]["u1"])
            case.check("U2", verdict["layout"]["ok"], verdict["layout"])
            case.check("U3", not reasons, reasons)
            case.check("U4", verdict["signal"]["all_zero"] is False)
            clicks = case.js("clicks")
            t0 = nodes[0]["t"] if nodes else None
            t1 = next((c["t"] for c in clicks if c["id"] == "dictation-stop"), None)
            frames = verdict["layout"]["frames"] or 0
            elapsed = (t1 - t0) / 1000 if t0 is not None and t1 is not None else None
            case.observed["u5"] = {"t0_ms": t0, "t1_ms": t1, "elapsed_s": elapsed, "frames": frames,
                                   "seconds": frames / 16000}
            case.check("U5", elapsed is not None and frames / 16000 >= 0.6 * elapsed and
                       frames / 16000 <= elapsed + 1.0, case.observed["u5"])
            seconds = frames / 16000
            self.server.release("hold_post", (200, {"text": TRANSCRIPT, "enginePin": CAPABILITY["enginePin"],
                                                    "modelPin": CAPABILITY["modelPin"], "languagePin": "auto",
                                                    "seconds": seconds}))
            case.wait_state("review", "review")
            review = case.snap()
            case.check("review-text", review["pane"]["text"] == TRANSCRIPT, review["pane"]["text"])
            case.check("review-seconds", review["pane"]["meta"].startswith(case.js("fixed", seconds) + "초 녹음"),
                       review["pane"]["meta"])
            case.check("review-pins", CAPABILITY["enginePin"] in (review["pane"]["metaTitle"] or "") and
                       CAPABILITY["modelPin"] in (review["pane"]["metaTitle"] or ""), review["pane"]["metaTitle"])
            case.unchanged("report-unchanged-in-review", review)
            expected = case.js("expected", [EXISTING, TRANSCRIPT, 3, 3])
            case.page.click("#dictation-insert", timeout=case.left_ms())
            case.wait_state("inserted", "inserted")
            inserted = case.snap()
            case.check("inserted-at-the-pinned-caret", inserted["text"] == [expected, "", ""], inserted["text"])
            case.wait_server(lambda es: any((e["method"], e["path"]) == resolve(HOLD_POST) and e["status"]
                                            for e in es), "occupancy claimed")
            case.js("stash")
            case.wait_server(lambda es: any((e["method"], e["path"]) == resolve(REPORT_PUT) and e["status"]
                                            for e in es), "the autosave write")
            case.page.wait_for_timeout(300)
            puts = [e for e in self.server.snapshot() if (e["method"], e["path"]) == resolve(REPORT_PUT)]
            findings = json.loads(self.server.body(puts[0]["seq"]) or b"{}").get("findings") if puts else None
            case.check("one-write-carries-the-insert", len(puts) == 1 and findings == expected,
                       {"puts": len(puts), "findings": findings})
        self.run_case("CAP-02", "real click, capture, held upload, review, Insert, one write", scenario,
                      hold_post=True)

    def test_cap03_the_worklet_cap_sends_exact_bytes_without_stop(self):
        def scenario(case, capability):
            before = self.open(case, capability)
            self.ready(case, before)
            self.press(case)
            entry = self.post_entry(case, held=True)
            held = case.snap()
            case.check("uploading-and-capped-before-any-answer", held["session"]["state"] == "uploading" and
                       held["pane"]["status"] == case.strings["capped"], [held["session"], held["pane"]["status"]])
            self.tracks_ended(case, "tracks-ended-while-held", held)
            clicks = case.js("clicks")
            case.check("no-stop-was-pressed", not [c for c in clicks if c["id"] == "dictation-stop"])
            nodes = held["media"]["nodes"]
            case.observed["nodes"] = nodes
            case.check("node-cap", len(nodes) == 1 and nodes[0]["options"]["processorOptions"] == {"maxFrames": 16000},
                       nodes)
            body, verdict, u1_ok, reasons = self.upload(case, entry, SMALL_CAP)
            case.check("exact-length", len(body) == SMALL_CAP, len(body))
            case.check("U2", verdict["layout"]["ok"], verdict["layout"])
            case.check("U3", not reasons, reasons)
            case.check("U4", verdict["signal"]["all_zero"] is False)
            case.observed["u1_recorded"] = u1_ok
            self.server.release("hold_post", (200, {"text": TRANSCRIPT, "enginePin": CAPABILITY["enginePin"],
                                                    "modelPin": CAPABILITY["modelPin"], "languagePin": "auto",
                                                    "seconds": (len(body) - 44) / 32000}))
            case.wait_state("review", "review")
            review = case.snap()
            case.check("review-text", review["pane"]["text"] == TRANSCRIPT, review["pane"]["text"])
            case.unchanged("report-unchanged", review)
        self.run_case("CAP-03", "automatic cap without Stop", scenario, hold_post=True,
                      capability=dict(CAPABILITY, maxBytes=SMALL_CAP))

    def test_cap04_cancel_while_recording_ends_tracks_synchronously(self):
        def scenario(case, capability):
            before = self.open(case, capability)
            self.ready(case, before)
            self.press(case)
            case.wait_state("recording", "recording")
            case.page.click("#dictation-cancel", timeout=case.left_ms())
            clicks = case.js("clicks")
            cancel = [c for c in clicks if c["id"] == "dictation-cancel"]
            after = cancel[0]["after"] if cancel else None
            case.check("tracks-ended-within-the-cancel-click", bool(after) and bool(after["tracks"]) and
                       all(s == "ended" for s in after["tracks"]), after)
            case.wait_state("cancelled", "cancelled")
            self.contexts_closed(case)
            value = case.snap()
            self.tracks_ended(case, "tracks-ended", value)
            case.check("pane-cancelled", value["pane"]["status"] == CANCELLED + UNCHANGED, value["pane"]["status"])
            case.unchanged("report-unchanged", value)
        self.run_case("CAP-04", "Cancel while recording", scenario)

    def test_cap05_a_read_only_editor_while_recording_fails_and_releases(self):
        def scenario(case, capability):
            before = self.open(case, capability)
            self.ready(case, before)
            self.press(case)
            case.wait_state("recording", "recording")
            case.js("read_only", UID)
            case.wait_state("failed", "failed")
            value = case.snap()
            case.check("failed-editor-changed", value["session"]["state"] == "failed" and
                       value["session"]["error"] == "editor-changed", value["session"])
            self.failed_with(case, value, "editor-changed")
            self.tracks_ended(case, "tracks-ended", value)
            case.unchanged("report-unchanged", value)
        self.run_case("CAP-05", "editor becomes read-only while recording", scenario)

    def test_cap06_an_engine_failure_after_capture_leaves_the_report(self):
        def scenario(case, capability):
            before = self.open(case, capability)
            self.ready(case, before)
            self.press(case)
            case.wait_state("recording", "recording")
            case.wait_js("recorded_for", 1000, "1.0 s after the worklet node", while_active=True)
            case.page.click("#dictation-stop", timeout=case.left_ms())
            entry = self.post_entry(case, held=False)
            case.wait_state("failed", "failed")
            value = case.snap()
            self.failed_with(case, value, "DICTATION_ENGINE_FAILED")
            self.tracks_ended(case, "tracks-ended", value)
            case.unchanged("report-unchanged", value)
            body, verdict, u1_ok, reasons = self.upload(case, entry, CAPABILITY["maxBytes"])
            case.observed["recorded_only"] = {"u1": u1_ok, "u2": verdict["layout"]["ok"], "u3": reasons}
        self.run_case("CAP-06", "engine failure after capture", scenario,
                      post_answer=(503, {"code": "DICTATION_ENGINE_FAILED"}))

    def test_cap07_page_exit_while_recording_ends_tracks(self):
        def scenario(case, capability):
            before = self.open(case, capability)
            self.ready(case, before)
            self.press(case)
            case.wait_state("recording", "recording")
            case.js("exit_probe")
            case.saved_violations = case.js("violations")
            case.observed["clicks_before_exit"] = case.js("clicks")
            case.page.goto(self.origin + AFTER_EXIT_PATH, timeout=case.left_ms())
            raw = case.js("exit_record")
            record = json.loads(raw) if raw else None
            case.observed["exit"] = record
            case.check("tracks-ended-at-exit", bool(record) and bool(record["tracks"]) and
                       all(s == "ended" for s in record["tracks"]), record)
            case.check("cancelled-at-exit", bool(record) and record["state"] == "cancelled", record)
        self.run_case("CAP-07", "page exit while recording", scenario)

    def denied(self, case, value):
        """The binding denial oracle (CAP-08), also outcome (i) of CAP-09."""
        gum = value["media"]["gumCalls"]
        case.check("one-gum-rejected-NotAllowedError", len(gum) == 1 and gum[0]["outcome"] == "rejected" and
                   (gum[0]["error"] or {}).get("name") == "NotAllowedError", gum)
        case.check("zero-tracks", value["media"]["tracks"] == [], value["media"]["tracks"])
        self.failed_with(case, value, "DICTATION_CAPTURE_DENIED")
        self.contexts_closed(case)
        case.unchanged("report-unchanged", value)

    def test_cap08_permissions_policy_denial_is_denied_and_writes_nothing(self):
        def scenario(case, capability):
            before = self.open(case, capability)
            case.observed["permission"] = case.js("permission")
            self.ready(case, before)
            self.press(case)
            case.wait_state("failed", "failed")
            self.denied(case, case.snap())
        self.run_case("CAP-08", "Permissions-Policy microphone=()", scenario,
                      page_headers={"Permissions-Policy": "microphone=()"})

    def test_cap09_no_grant_either_denies_or_waits_and_cancels(self):
        def scenario(case, capability):
            before = self.open(case, capability)
            case.observed["permission"] = case.js("permission")
            self.ready(case, before)
            self.press(case)
            pressed = time.monotonic()
            state = case.js("state")
            while state == "requesting-permission" and time.monotonic() - pressed < 10:
                case.page.wait_for_timeout(100)
                state = case.js("state")
            case.observed["state_after_wait"] = state
            if state == "failed":
                case.observed["outcome"] = "i-denied"
                self.denied(case, case.snap())
            elif state == "requesting-permission":
                case.observed["outcome"] = "ii-still-requesting"
                case.page.click("#dictation-cancel", timeout=case.left_ms())
                case.wait_state("cancelled", "cancelled")
                case.page.wait_for_timeout(2000)
                value = case.snap()
                tracks = value["media"]["tracks"]
                case.observed["late_tracks"] = tracks
                case.check("late-tracks-ended", all(t["readyState"] == "ended" for t in tracks), tracks)
                case.unchanged("report-unchanged", value)
            else:
                case.observed["outcome"] = "neither"
                case.check("no-grant-context-did-not-record", False, state)
        self.run_case("CAP-09", "no-grant context", scenario, grant=False)

    def test_cap10_cancel_while_the_worklet_loads_never_opens_the_microphone(self):
        def scenario(case, capability):
            before = self.open(case, capability)
            self.ready(case, before)
            self.press(case)
            case.wait_server(lambda es: any(e["held"] for e in served(es, WORKLET)), "the worklet GET is held")
            case.check("still-requesting", case.js("state") == "requesting-permission")
            case.page.click("#dictation-cancel", timeout=case.left_ms())
            case.wait_state("cancelled", "cancelled")
            self.server.release("hold_worklet")
            case.wait_server(lambda es: any(e["status"] for e in served(es, WORKLET)), "the worklet GET was answered")
            case.page.wait_for_timeout(1000)
            value = case.snap()
            case.check("gum-never-called", value["media"]["gum"] == 0, value["media"]["gumCalls"])
            self.contexts_closed(case)
            case.check("pane-cancelled", value["pane"]["status"] == CANCELLED + UNCHANGED, value["pane"]["status"])
            case.unchanged("report-unchanged", value)
        self.run_case("CAP-10", "Cancel while addModule is pending", scenario, hold_worklet=True)

    def test_nc11_a_csp_without_the_worklet_blocks_it_and_the_browser_logs_one_denial(self):
        def scenario(case, capability):
            before = self.open(case, capability)
            case.check("inline-glue-ran", case.js("controller") is True)
            self.ready(case, before)
            self.press(case)
            case.wait_state("failed", "failed")
            value = case.snap()
            # The worklet's console line crosses threads on its own task; give it a bounded moment to
            # arrive. Nothing is asserted here: finish() judges every entry the session collected.
            until = min(case.deadline, time.monotonic() + 3)
            while time.monotonic() < until and not csp_log_verdict(case.log_entries)["csp_entries"]:
                case.page.wait_for_timeout(50)
            case.page.wait_for_timeout(300)
            # Document/window events stay observations (the superseded limb); expected none for a worklet.
            case.observed["violations"] = case.js("violations")
            entries = self.server.snapshot()
            case.check("five-page-scripts-200", all(served(entries, n) and all(e["status"] == 200 for e in served(entries, n))
                                                    for n in PAGE_SCRIPTS), [line(e) for e in entries])
            case.check("no-worklet-GET", not served(entries, WORKLET))
            case.check("pane-rendered", value["pane"]["hidden"] is False)
            self.failed_with(case, value, "DICTATION_CAPTURE_FAILED")
            case.check("gum-0", value["media"]["gum"] == 0, value["media"]["gumCalls"])
        self.run_case("NC-11", "CSP without the worklet", scenario, csp=nc11_csp(self.origin))

    def test_nc12_a_worklet_served_as_text_plain_is_refused(self):
        def scenario(case, capability):
            before = self.open(case, capability)
            self.ready(case, before)
            self.press(case)
            case.wait_state("failed", "failed")
            value = case.snap()
            entries = self.server.snapshot()
            worklet = served(entries, WORKLET)
            case.check("worklet-GET-logged", len(worklet) == 1 and worklet[0]["status"] == 200 and
                       (worklet[0]["content_type"] or "").startswith("text/plain"), [line(e) for e in worklet])
            self.failed_with(case, value, "DICTATION_CAPTURE_FAILED")
            case.check("gum-0", value["media"]["gum"] == 0, value["media"]["gumCalls"])
        self.run_case("NC-12", "worklet served as text/plain", scenario, worklet_type="text/plain; charset=utf-8")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if "--static-only" in sys.argv:
        problems, report = static_report()
        emit("U4B-CAP CAP-00", dict(report, case="CAP-00", problems=problems, **{"pass": not problems}))
        sys.exit(1 if problems else 0)
    program = unittest.main(verbosity=2, exit=False)
    sys.exit(0 if program.result.wasSuccessful() else 1)
