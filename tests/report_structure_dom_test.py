# coding: utf-8
"""TEST-S3-STRUCT-DOM: the shipped structured-entry block, on the real main.html, against a stub.

REQ-S3-STRUCT-BODY
  -> RISK-S3-STRUCT-SILENT-BODY-REWRITE/BROKEN-CITATION-BLOCK/FALSE-STRUCTURED-CLAIM/
     VALUE-TEXT-DRIFT/LOST-TYPED-WORK/CROSS-STUDY-WRITE/STALE-CONFIRMATION
  -> TEST-S3-STRUCT-DOM.

The product regions are sliced out of main.html, never retyped: the caret model (base block) and the
structured-entry block with the draft lifecycle around it (report block). Both shipped modules are
the real files.

What only a browser can answer is what this file is for: a textarea keeps its selection after the
modal took focus, the value is written only after the server answered, a plan that went stale
between opening and pressing is not sent, and the state is re-read after a commit instead of being
guessed.

The PRODUCT catalog is empty (P6), so D14 asserts the shipped default - no button, no request - and
every other case runs against a SYNTHETIC catalog injected by a shim that exists only in this file
(P7). No clinical item, label, unit, range or sentence is authored anywhere in this repository.

Two files may be replaced through KIN_STRUCT_MAIN / KIN_STRUCT_STRUCTURE_JS so the mutant runner can
break the product on purpose without ever touching the source tree.
"""
import json
import os
import re
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MAIN_PATH = Path(os.environ.get("KIN_STRUCT_MAIN", ROOT / "worklist-v0" / "hpacs-lite" / "main.html"))
STRUCTURE_PATH = Path(os.environ.get("KIN_STRUCT_STRUCTURE_JS",
                                     ROOT / "worklist-v0" / "hpacs-lite" / "report-structure.js"))
MAIN = MAIN_PATH.read_text(encoding="utf-8")
STRUCTURE_JS = STRUCTURE_PATH.read_text(encoding="utf-8")
CITATION_JS = (ROOT / "worklist-v0" / "hpacs-lite" / "report-citation.js").read_text(encoding="utf-8")
VECTORS = json.loads((ROOT / "tests" / "report_structure_vectors.json").read_text(encoding="utf-8"))

UID = "1.2.3"
OTHER = "1.2.4"
CATALOG = VECTORS["catalog"]
CHOICE_LINE = "SYNTHETIC-ITEM choice = alpha"
CHOICE_LINE2 = "SYNTHETIC-ITEM choice = beta"
BOOL_LINE = "SYNTHETIC-ITEM boolean = yes"
EXISTING = "first line\nsecond line\nthird line"
CITED = "cited head\ncited tail"
ACTOR = "other@synthetic"
SID = "00000000-0000-4000-8000-0000000000a1"


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
    if open_brace < 0:
        raise ValueError(name)
    depth, quote, escaped = 0, None, False
    for index in range(open_brace, len(source)):
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
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise ValueError(name)


STRUCT_HTML = slice_between(MAIN, '<div class="modal" id="structmodal"', "\n  </div>") + "\n  </div>"
CITE_HTML = slice_between(MAIN, '<div class="modal" id="cite-preview"', "\n  </div>") + "\n  </div>"
PANE_HTML = slice_between(MAIN, '<div class="modal" id="stalemodal"', "\n  </div>") + "\n  </div>"
MODAL_CSS = slice_between(MAIN, ".modal { display: none;", "/* ══ 클릭 피드백")
BASE_BLOCK = slice_between(MAIN, "    let selectionSeq = 0;", "    function reportSource()")
REPORT_BLOCK = slice_between(MAIN, "    function reportSource() {", "    function heldByOther(s)")
API_FN = extract_function(MAIN, "api")
WRITE_BLOCK_FN = extract_function(MAIN, "reportWriteBlock")
EDITOR_BLOCK_FN = extract_function(MAIN, "reportEditorBlock")

HARNESS = """<!doctype html><html><head><style>MODALCSS</style></head><body>
<div class="draftbar" id="draftbar" style="display:none"><span id="draftmsg"></span>
<button id="b-report-reload"></button><button id="b-draft-discard"></button></div>
<div class="draftbar" id="citebar" style="display:none"><span id="citemsg"></span>
<button id="b-cite-list"></button><button id="b-cite-reload"></button></div>
<div id="citelist" hidden></div>
<textarea id="findings"></textarea><textarea id="conclusion"></textarea><textarea id="recommendation"></textarea>
<button id="b-approve"></button><button id="b-save"></button><button id="b-transcribe"></button>
<button id="b-addendum"></button><button id="b-unread"></button><button id="b-prelim"></button><button id="b-defer"></button>
<button id="b-print"></button>
PANEHTML
CITEHTML
STRUCTHTML
<script>
CITATIONJS
</script>
<script>
STRUCTUREJS
</script>
<script>
/* P7: the ONLY place a synthetic catalog exists. The shipped module keeps its empty constant; this
   shim hands the sliced product block a catalog so the form has something to drive. Nothing here is
   reachable from the product or from HTTP. */
if (CATALOGJSON.length)
  window.KinReportStructure = Object.assign({}, window.KinReportStructure, { PRODUCT_CATALOG: CATALOGJSON });
</script>
<script>
const $ = s => document.querySelector(s);
const esc = v => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const RFIELDS = ["findings", "conclusion", "recommendation"];
const API = "/api";
let serverMode = true, offline = false, demoMode = false;
let selectedUid = "UIDVALUE", heldUid = null, heartbeat = null, user = "doctor@kin";
let appState = INITIALSTATE;
let studies = [{uid: "UIDVALUE", name: "SYNTHETIC ONE", id: "P-1", date: "2026-09-21", acc: "A1", desc: "SYN",
                rs: "T", ss: "Verified", em: "N"},
               {uid: "OTHERVALUE", name: "SYNTHETIC TWO", id: "P-2", date: "2026-09-21", acc: "A2", desc: "SYN",
                rs: "T", ss: "Verified", em: "N"}];
let calls = [], structCalls = [], citeCalls = [], replies = [], structReplies = [], citeReplies = [];
let toasts = [], confirms = [], confirmAnswer = false;
const studyPriority = { get: () => false };
const KinAuth = { has: () => true, logout: async () => {} };
const reportPreview = { close() {} };
const displayActor = value => String(value ?? "").split("@")[0];
function cur() { return studies.find(s => s.uid === selectedUid); }
function heldByOther(s) { return s?.holder && s.holder !== user ? s.holder : null; }
function shownStudyDesc(s) { return s?.desc ?? ""; }
function today() { return "2026-09-21"; }
function saveApp() {}
function syncStudy() {}
function render() {}
function renderRelated() {}
function updateReportButtons() {}
function updateReportTemplateButton() {}
function updateTemplatePreview() {}
function toast(message, kind) { toasts.push({ message, kind }); }
function apiFail(e) { toast("서버 저장 실패: " + e.message, "err"); }
window.confirm = message => { confirms.push(message); return confirmAnswer; };
let holdCount = 0; const heldAnswers = [];
window.fetch = async (url, options = {}) => {
  const path = String(url).slice(API.length);
  const record = { method: options.method ?? "GET", path, keepalive: !!options.keepalive,
                   body: options.body ? JSON.parse(options.body) : null,
                   keys: options.body ? Object.keys(JSON.parse(options.body)) : [] };
  if (path.endsWith("/report/structure")) {
    structCalls.push(record);
    const body = structReplies.shift();
    if (body === undefined)
      return { ok: false, status: 500, json: async () => ({ message: "구조화 항목을 확인할 수 없습니다" }) };
    return { ok: true, status: 200, json: async () => body };
  }
  if (path.endsWith("/report/citations")) {
    citeCalls.push(record);
    const body = citeReplies.shift();
    if (body === undefined)
      return { ok: false, status: 500, json: async () => ({ message: "인용을 확인할 수 없습니다" }) };
    return { ok: true, status: 200, json: async () => body };
  }
  calls.push(record);
  const reply = replies.shift() ?? { status: 200, body: {} };
  const answer = () => ({ ok: reply.status < 400, status: reply.status, json: async () => reply.body });
  if (holdCount > 0) { holdCount -= 1; return new Promise(resolve => { heldAnswers.push(() => resolve(answer())); }); }
  return answer();
};
APIFN
WRITEBLOCKFN
EDITORBLOCKFN
BASEBLOCK
REPORTBLOCK
window.load = options => loadReport(options);
window.stash = () => stashReport();
window.commit = action => commitReport(action);
window.openStruct = () => openStructure();
window.pickStruct = key => selectStructureItem(key);
window.applyStruct = () => applyStructure();
window.closeStruct = () => closeStructure();
window.pane = () => (structPane ? { uid: structPane.uid, selSeq: structPane.selSeq,
                                    field: structPane.field, line: structPane.line, status: structPane.status,
                                    busy: structPane.busy, previous: structPane.previous ? structPane.previous.sid : null,
                                    plan: structPane.plan ? { mode2: structPane.plan.mode2, text: structPane.plan.text,
                                                              line: structPane.plan.line,
                                                              removedLine: structPane.plan.removedLine } : null } : null);
window.ensureStruct = options => ensureStructure(selectedUid, options ?? {});
window.structKnown = uid => structureState.known(uid ?? selectedUid);
window.structKeep = uid => structureState.keepIds(uid ?? selectedUid);
window.confirmCitations = answer => citations.confirm(selectedUid, answer);
window.itemKey = code => "SYN-T1\\u0000" + code;
window.buttonExists = () => !!document.querySelector("#b-structured");
window.release = () => { const next = heldAnswers.shift(); if (next) next(); };
</script></body></html>"""


def harness(state, catalog=CATALOG):
    return (HARNESS
            .replace("MODALCSS", MODAL_CSS)
            .replace("PANEHTML", PANE_HTML)
            .replace("CITEHTML", CITE_HTML)
            .replace("STRUCTHTML", STRUCT_HTML)
            .replace("CITATIONJS", CITATION_JS)
            .replace("STRUCTUREJS", STRUCTURE_JS)
            .replace("CATALOGJSON", json.dumps(catalog, ensure_ascii=False))
            .replace("APIFN", API_FN)
            .replace("WRITEBLOCKFN", WRITE_BLOCK_FN)
            .replace("EDITORBLOCKFN", EDITOR_BLOCK_FN)
            .replace("BASEBLOCK", BASE_BLOCK)
            .replace("REPORTBLOCK", REPORT_BLOCK)
            .replace("INITIALSTATE", json.dumps(state, ensure_ascii=False))
            .replace("UIDVALUE", UID)
            .replace("OTHERVALUE", OTHER))


def state(findings=EXISTING, version=4, draft=None, **extra):
    row = {"version": version, "findings": findings, "conclusion": "", "recommendation": "",
           "rs": "T", "ss": "Verified", "em": "N", "prelimHidden": False, "draft": draft}
    row.update(extra)
    return {UID: row, OTHER: {"version": 1, "findings": "", "conclusion": "", "recommendation": "",
                              "rs": "T", "ss": "Verified", "em": "N", "prelimHidden": False, "draft": None}}


def entry(**over):
    row = {"v": 1, "sid": SID, "field": "findings", "templateId": "SYN-T1", "templateRevision": 2,
           "itemCode": "SYN-CHOICE", "valueType": "choice", "value": "c1", "unit": None,
           "renderedText": CHOICE_LINE, "enteredAt": "2026-09-06T00:00:00.123Z", "enteredBy": ACTOR,
           "sameTextCount": 1, "state": "present"}
    row.update(over)
    return row


class ReportStructureDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._play = sync_playwright().start()
        cls._browser = cls._play.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls._browser.close()
        cls._play.stop()

    def open(self, page_state, catalog=CATALOG, struct_replies=(), cite_replies=(), replies=(), boot=True):
        page = self._browser.new_page()
        page.set_content(harness(page_state, catalog))
        page.evaluate("data => { structReplies = data.s; citeReplies = data.c; replies = data.r; }",
                      {"s": list(struct_replies), "c": list(cite_replies), "r": list(replies)})
        self.addCleanup(page.close)
        if boot:
            # The product only issues the dedicated read from loadReport, so a harness that never
            # loads would be testing a screen nobody opened.
            page.evaluate("() => load({force: true})")
            if catalog and struct_replies:
                page.wait_for_function("() => structCalls.length >= 1")
        return page

    def pick(self, page, code="SYN-CHOICE"):
        page.evaluate("code => { openStruct(); pickStruct(itemKey(code)); }", code)

    # D1 ───────────────────────────────────────────────────────────────────────────────────────
    def test_d01_opening_and_cancelling_writes_nothing(self):
        page = self.open(state(), struct_replies=[{"version": 4, "unknown": False, "head": [], "draft": []}])
        page.evaluate("() => { $('#findings').value = %s; }" % json.dumps(EXISTING))
        self.pick(page)
        page.evaluate("() => closeStruct()")
        self.assertEqual(page.evaluate("() => calls.length"), 0,
                         "S3-STRUCT D1: opening the form must not write anything")
        self.assertEqual(page.evaluate("() => $('#findings').value"), EXISTING)
        self.assertIsNone(page.evaluate("() => pane()"))

    # D2 ───────────────────────────────────────────────────────────────────────────────────────
    def test_d02_apply_writes_the_field_only_after_the_server_answered(self):
        page = self.open(state(), struct_replies=[{"version": 4, "unknown": False, "head": [], "draft": []},
                                                  {"version": 4, "unknown": False, "head": [],
                                                   "draft": [entry(renderedText=BOOL_LINE, field="conclusion",
                                                                   itemCode="SYN-BOOL", valueType="boolean",
                                                                   value=True)]}],
                         replies=[{"status": 200, "body": {"structured": {"sid": SID, "field": "conclusion",
                                                                          "enteredAt": "now"}}}])
        page.evaluate("() => { $('#conclusion').value = 'typed by hand'; $('#conclusion').focus();"
                      "$('#conclusion').setSelectionRange(14, 14); }")
        self.pick(page, "SYN-BOOL")
        page.evaluate("() => { $('#struct-value-bool').checked = true;"
                      "$('#struct-value-bool').dispatchEvent(new Event('change', {bubbles: true})); }")
        before = page.evaluate("() => $('#conclusion').value")
        page.evaluate("() => { holdCount = 1; applyStruct(); }")
        page.wait_for_function("() => calls.length === 1")
        self.assertEqual(page.evaluate("() => $('#conclusion').value"), before,
                         "S3-STRUCT M3c: the field may not be written before the server answered")
        page.evaluate("() => release()")
        page.wait_for_function("() => $('#conclusion').value !== 'typed by hand'")
        value = page.evaluate("() => $('#conclusion').value")
        self.assertEqual(value, "typed by hand\n" + BOOL_LINE,
                         "S3-STRUCT M1: the sentence must occupy a whole line and delete nothing")
        sent = page.evaluate("() => calls[0].body")
        self.assertEqual(sent["conclusion"], value)
        self.assertEqual(sent["structure"]["renderedText"], BOOL_LINE)
        self.assertEqual(sent["structure"]["op"], "apply")

    # D3 ───────────────────────────────────────────────────────────────────────────────────────
    def test_d03_a_read_only_report_refuses_before_any_request(self):
        page = self.open(state(),
                         struct_replies=[{"version": 4, "unknown": False, "head": [], "draft": []}])
        self.pick(page)
        # The lock arrives while the form is open - the gate has to hold at the press, not only at
        # the opening, because that is when the write would happen.
        page.evaluate("() => { $('#findings').readOnly = true; }")
        page.evaluate("() => applyStruct()")
        self.assertEqual(page.evaluate("() => calls.length"), 0,
                         "S3-STRUCT D3: a locked report must not be written")
        self.assertTrue(page.evaluate("() => ($('#struct-status').textContent || '').length > 0"))

    # D4 ───────────────────────────────────────────────────────────────────────────────────────
    def test_d04_a_head_value_is_replaced_in_place_after_a_save(self):
        head = entry(sid="s-head")
        page = self.open(state(findings=CHOICE_LINE),
                         struct_replies=[{"version": 4, "unknown": False, "head": [head], "draft": []},
                                         {"version": 4, "unknown": False, "head": [head], "draft": []}],
                         replies=[{"status": 200, "body": {"structured": {"sid": "s-new", "field": "findings",
                                                                          "enteredAt": "now"}}}])
        page.evaluate("() => { $('#findings').value = %s; }" % json.dumps(CHOICE_LINE))
        page.wait_for_function("() => structKnown()")
        self.pick(page)
        page.evaluate("() => { $('#struct-value-choice').value = 'c2';"
                      "$('#struct-value-choice').dispatchEvent(new Event('change', {bubbles: true})); }")
        self.assertEqual(page.evaluate("() => pane().plan.mode2"), "replace")
        # P3/B7: replace is the only path in this unit that deletes body text, and this modal covers
        # the report column. The preview has to name the sentence that will go, not only its number.
        markup = page.evaluate("() => $('#structmodal').innerText")
        self.assertIn(CHOICE_LINE, markup, "the sentence that will be removed must be shown")
        self.assertIn(CHOICE_LINE2, markup, "the sentence that will be written must be shown")
        self.assertEqual(page.evaluate("() => $('#struct-removed').textContent"), CHOICE_LINE)
        self.assertEqual(page.evaluate("() => $('#struct-line').textContent"), CHOICE_LINE2)
        page.evaluate("() => applyStruct()")
        page.wait_for_function("() => calls.length === 1")
        self.assertEqual(page.evaluate("() => $('#findings').value"), CHOICE_LINE2)
        sent = page.evaluate("() => calls[0].body")
        self.assertEqual(sent["structure"]["op"], "replace")
        self.assertEqual(sent["structure"]["replacesSid"], "s-head")

    # D5 ───────────────────────────────────────────────────────────────────────────────────────
    def test_d05_an_ambiguous_old_sentence_refuses_and_sends_nothing(self):
        head = entry(sid="s-head")
        doubled = CHOICE_LINE + "\n" + CHOICE_LINE
        page = self.open(state(findings=doubled),
                         struct_replies=[{"version": 4, "unknown": False, "head": [head], "draft": []}])
        page.evaluate("() => { $('#findings').value = %s; }" % json.dumps(doubled))
        page.wait_for_function("() => structKnown()")
        self.pick(page)
        page.evaluate("() => { $('#struct-value-choice').value = 'c2';"
                      "$('#struct-value-choice').dispatchEvent(new Event('change', {bubbles: true})); }")
        page.evaluate("() => applyStruct()")
        self.assertEqual(page.evaluate("() => calls.length"), 0,
                         "S3-STRUCT M6: two identical sentences must refuse, not guess which one to replace")
        self.assertEqual(page.evaluate("() => $('#findings').value"), doubled)
        self.assertIn("여러 번", page.evaluate("() => $('#struct-status').textContent"))

    # D6 ───────────────────────────────────────────────────────────────────────────────────────
    def test_d06_a_new_sentence_never_lands_inside_a_cited_block(self):
        body = "before\n" + CITED + "\nafter"
        page = self.open(state(findings=body),
                         struct_replies=[{"version": 4, "unknown": False, "head": [], "draft": []}],
                         replies=[{"status": 200, "body": {"structured": {"sid": SID, "field": "findings",
                                                                          "enteredAt": "now"}}}])
        page.evaluate("() => { $('#findings').value = %s; $('#findings').focus();"
                      "$('#findings').setSelectionRange(18, 18); }" % json.dumps(body))
        page.evaluate("answer => confirmCitations(answer)",
                      {"version": 4, "head": [{"v": 2, "cid": "c-1", "field": "findings",
                                               "insertedText": CITED, "sameTextCount": 1,
                                               "insertedAt": "x", "insertedBy": ACTOR}], "draft": []})
        self.pick(page)
        page.evaluate("() => applyStruct()")
        page.wait_for_function("() => calls.length === 1")
        value = page.evaluate("() => $('#findings').value")
        lines = value.split("\n")
        self.assertEqual(lines.index("cited head") + 1, lines.index("cited tail"),
                         "S3-STRUCT M2: an existing citation block may not be cut in half")
        self.assertIn(CHOICE_LINE, lines)

    # D7 ───────────────────────────────────────────────────────────────────────────────────────
    def test_d07_a_refused_apply_leaves_the_body_untouched(self):
        page = self.open(state(),
                         struct_replies=[{"version": 4, "unknown": False, "head": [], "draft": []},
                                         {"version": 4, "unknown": False, "head": [], "draft": []}],
                         replies=[{"status": 409, "body": {"code": "REPORT_STRUCTURE_TEXT",
                                                           "message": "구조화 항목의 문장이 그 칸의 본문에 줄 단위로 그대로 있지 않습니다"}}])
        page.evaluate("() => { $('#findings').value = %s; }" % json.dumps(EXISTING))
        self.pick(page)
        page.evaluate("() => applyStruct()")
        page.wait_for_function("() => calls.length === 1")
        self.assertEqual(page.evaluate("() => $('#findings').value"), EXISTING,
                         "S3-STRUCT M3c: a refused apply must leave every byte of the report alone")
        self.assertIn("적용하지 못했습니다", page.evaluate("() => $('#struct-status').textContent"))

    # D8 ───────────────────────────────────────────────────────────────────────────────────────
    def test_d08_after_a_commit_the_state_is_re_read_and_carries_no_stale_keep_list(self):
        head = entry(sid="s-head")
        page = self.open(state(findings=CHOICE_LINE),
                         struct_replies=[{"version": 4, "unknown": False, "head": [],
                                          "draft": [entry(sid="s-draft")]},
                                         {"version": 5, "unknown": False, "head": [head], "draft": []}],
                         replies=[{"status": 200, "body": {"version": 5, "rs": "T", "findings": CHOICE_LINE,
                                                           "conclusion": "", "recommendation": "", "draft": None}}])
        page.wait_for_function("() => structKnown()")
        self.assertEqual(page.evaluate("() => structKeep()"), ["s-draft"])
        page.evaluate("() => commit('save')")
        # BOUNDED, and the same wait for the correct code and for M5c. `commit()` resolves once its
        # own POST is done; the dedicated re-read is fire-and-forget from loadReport, so give it a
        # bounded moment and then ASSERT. An unbounded wait_for_function here would raise a
        # Playwright TimeoutError under M5c - an ERROR carrying no AssertionError and matching a
        # crash marker - and the mutant would be scored a survivor for a harness reason (B5).
        page.wait_for_timeout(400)
        self.assertEqual(page.evaluate("() => structCalls.length"), 2,
                         "S3-STRUCT M5c: after a commit the state must be re-read, not kept")
        self.assertEqual(page.evaluate("() => calls[0].body.structureIds"), ["s-draft"])
        self.assertTrue(page.evaluate("() => structKnown()"))
        self.assertEqual(page.evaluate("() => structKeep()"), [],
                         "the re-read replaced the keep list with the server's own answer")

    # D9 ───────────────────────────────────────────────────────────────────────────────────────
    def test_d09_a_late_answer_is_not_applied_to_the_study_that_is_open_now(self):
        page = self.open(state(),
                         struct_replies=[{"version": 4, "unknown": False, "head": [], "draft": []},
                                         {"version": 1, "unknown": False, "head": [], "draft": []},
                                         {"version": 1, "unknown": False, "head": [], "draft": []}],
                         replies=[{"status": 200, "body": {"structured": {"sid": SID, "field": "findings",
                                                                          "enteredAt": "now"}}}])
        page.evaluate("() => { $('#findings').value = %s; }" % json.dumps(EXISTING))
        self.pick(page)
        page.evaluate("() => { holdCount = 1; applyStruct(); }")
        page.wait_for_function("() => calls.length === 1")
        page.evaluate("() => { selectedUid = %s; selectionSeq += 1; $('#findings').value = ''; }" % json.dumps(OTHER))
        page.evaluate("() => release()")
        page.wait_for_function("() => toasts.length > 0")
        self.assertEqual(page.evaluate("() => $('#findings').value"), "",
                         "S3-STRUCT D9: a late answer may not write into another patient's report")
        self.assertIsNone(page.evaluate("() => pane()"))

    # D10 ──────────────────────────────────────────────────────────────────────────────────────
    def test_d10_autosave_carries_the_keep_list_only_once_the_read_confirmed_it(self):
        page = self.open(state())
        page.evaluate("() => { $('#findings').value = 'typed'; }")
        page.evaluate("() => stash()")
        page.wait_for_function("() => calls.length === 1")
        self.assertNotIn("structureIds", page.evaluate("() => calls[0].keys"),
                         "S3-STRUCT D10: an unknown state must not invent a keep list")
        page.evaluate("answer => { structReplies.push(answer); }",
                      {"version": 4, "unknown": False, "head": [], "draft": [entry(sid="s-draft")]})
        page.evaluate("() => ensureStruct({force: true})")
        page.wait_for_function("() => structKnown()")
        page.evaluate("() => { $('#findings').value = 'typed more'; }")
        page.evaluate("() => stash()")
        page.wait_for_function("() => calls.length === 2")
        self.assertEqual(page.evaluate("() => calls[1].body.structureIds"), ["s-draft"])

    # D11 ──────────────────────────────────────────────────────────────────────────────────────
    def test_d11_an_entry_from_another_catalog_revision_is_read_only(self):
        old = entry(sid="s-old", templateRevision=1)
        page = self.open(state(findings=CHOICE_LINE),
                         struct_replies=[{"version": 4, "unknown": False, "head": [old], "draft": []}])
        page.evaluate("() => { $('#findings').value = %s; }" % json.dumps(CHOICE_LINE))
        page.wait_for_function("() => structKnown()")
        self.pick(page)
        status = page.evaluate("() => $('#struct-status').textContent")
        self.assertIn("서식은 현재 버전과 다릅니다", status,
                      "S3-STRUCT D11: a stored value from another revision must say so")
        page.evaluate("() => applyStruct()")
        self.assertEqual(page.evaluate("() => calls.length"), 0)

    # D12 ──────────────────────────────────────────────────────────────────────────────────────
    def test_d12_the_caret_survives_the_form_taking_focus(self):
        page = self.open(state(),
                         struct_replies=[{"version": 4, "unknown": False, "head": [], "draft": []}],
                         replies=[{"status": 200, "body": {"structured": {"sid": SID, "field": "findings",
                                                                          "enteredAt": "now"}}}])
        page.evaluate("() => { const el = $('#findings'); el.value = %s; el.focus();"
                      "el.setSelectionRange(10, 10); }" % json.dumps(EXISTING))
        self.pick(page)
        page.focus("#struct-item")
        page.evaluate("() => applyStruct()")
        page.wait_for_function("() => calls.length === 1")
        lines = page.evaluate("() => $('#findings').value").split("\n")
        self.assertEqual(lines[1], CHOICE_LINE,
                         "S3-STRUCT D12: the caret the person left must survive the form taking focus")
        self.assertEqual(lines[0], "first line")

    # D13 ──────────────────────────────────────────────────────────────────────────────────────
    def test_d13_the_form_shows_no_attestation_identifiers(self):
        head = entry(sid="s-secret-sid")
        page = self.open(state(findings=CHOICE_LINE),
                         struct_replies=[{"version": 4, "unknown": False, "head": [head], "draft": []}])
        page.evaluate("() => { $('#findings').value = %s; }" % json.dumps(CHOICE_LINE))
        page.wait_for_function("() => structKnown()")
        self.pick(page)
        markup = page.evaluate("() => $('#structmodal').outerHTML")
        self.assertNotIn("s-secret-sid", markup,
                         "S3-STRUCT D13: the sid is an attestation identifier, not something to show")
        self.assertNotIn(ACTOR, markup)
        self.assertIn(CHOICE_LINE, markup, "the sentence that will be written is exactly what is shown")

    # D14 ──────────────────────────────────────────────────────────────────────────────────────
    def test_d14_the_shipped_empty_catalog_renders_no_button_and_asks_for_nothing(self):
        # P6: this is the product default today. It must be a disabled-free absence, not a promise.
        page = self.open(state(), catalog=[])
        page.evaluate("() => load({force: true})")
        page.wait_for_timeout(120)
        self.assertFalse(page.evaluate("() => buttonExists()"),
                         "S3-STRUCT D14: with no catalog there must be no Structured control at all")
        self.assertEqual(page.evaluate("() => structCalls.length"), 0,
                         "S3-STRUCT D14: with no catalog the dedicated read must never be issued")

    # D15 ──────────────────────────────────────────────────────────────────────────────────────
    def test_d15_a_plan_that_went_stale_sends_nothing_and_asks_again(self):
        page = self.open(state(),
                         struct_replies=[{"version": 4, "unknown": False, "head": [], "draft": []}],
                         replies=[{"status": 200, "body": {"structured": {"sid": SID, "field": "findings",
                                                                          "enteredAt": "now"}}}])
        page.evaluate("() => { const el = $('#findings'); el.value = %s; el.focus();"
                      "el.setSelectionRange(10, 10); }" % json.dumps(EXISTING))
        self.pick(page)
        shown = page.evaluate("() => pane().plan.line")
        page.evaluate("() => { const el = $('#findings'); el.value = 'a new first line\\n' + el.value;"
                      "el.focus(); el.setSelectionRange(0, 0); }")
        page.evaluate("() => applyStruct()")
        self.assertEqual(page.evaluate("() => calls.length"), 0,
                         "S3-STRUCT M4c: a plan the person did not read may not be sent")
        self.assertIn("다시 확인", page.evaluate("() => $('#struct-status').textContent"))
        page.evaluate("() => applyStruct()")
        page.wait_for_function("() => calls.length === 1")
        self.assertEqual(page.evaluate("() => calls.length"), 1,
                         "the second press, with an unchanged plan, sends exactly one request")
        self.assertIsNone(page.evaluate("() => pane()"), "a successful apply closes the form")
        self.assertEqual(shown, 2, "the position first shown was the line after the caret's own line")
        self.assertEqual(page.evaluate("() => calls[0].body.structure.field"), "findings")

    # D16 ──────────────────────────────────────────────────────────────────────────────────────
    def test_d16_a_form_opened_on_one_study_never_writes_into_another(self):
        # B4: the decisive case. Without the uid/selSeq binding the first press only re-plans (the
        # other study's textarea differs) and the SECOND press finds its own fresh plan consistent
        # and writes patient A's entry into patient B's report.
        page = self.open(state(),
                         struct_replies=[{"version": 4, "unknown": False, "head": [], "draft": []},
                                         {"version": 1, "unknown": False, "head": [], "draft": []}],
                         replies=[{"status": 200, "body": {"structured": {"sid": SID, "field": "findings",
                                                                          "enteredAt": "now"}}}])
        page.evaluate("() => { const el = $('#findings'); el.value = %s; el.focus();"
                      "el.setSelectionRange(10, 10); }" % json.dumps(EXISTING))
        self.pick(page)
        self.assertEqual(page.evaluate("() => pane().uid"), UID, "the form pins the study it opened on")
        # the reader moves to another patient; the form is still on screen
        page.evaluate("() => { selectedUid = %s; selectionSeq += 1; $('#findings').value = 'B report'; }"
                      % json.dumps(OTHER))
        page.evaluate("() => applyStruct()")
        page.evaluate("() => applyStruct()")
        self.assertEqual(page.evaluate("() => calls.length"), 0,
                         "S3-STRUCT B4: an entry chosen on one study may never be written to another")
        self.assertEqual(page.evaluate("() => $('#findings').value"), "B report",
                         "the other patient's report must not have been touched")
        self.assertIsNone(page.evaluate("() => pane()"), "the form closes rather than waiting to be pressed again")
        self.assertFalse(page.evaluate("() => $('#structmodal').classList.contains('on')"))

    # D17 ──────────────────────────────────────────────────────────────────────────────────────
    def test_d17_a_second_change_before_the_commit_uses_the_draft_entry_not_the_superseded_head(self):
        # B3: after one Save the first value is a head entry; changing it writes a draft entry and
        # the head sentence leaves the body. A second change must pick the DRAFT entry - otherwise
        # the form shows the old value and plans to remove a line that is no longer there.
        head = entry(sid="s-head", value="c1", renderedText=CHOICE_LINE)
        draft = entry(sid="s-draft", value="c2", renderedText=CHOICE_LINE2)
        page = self.open(state(findings=CHOICE_LINE2),
                         struct_replies=[{"version": 4, "unknown": False, "head": [head], "draft": [draft]}],
                         replies=[{"status": 200, "body": {"structured": {"sid": "s-third", "field": "findings",
                                                                          "enteredAt": "now"}}}])
        page.evaluate("() => { $('#findings').value = %s; }" % json.dumps(CHOICE_LINE2))
        page.wait_for_function("() => structKnown()")
        self.pick(page)
        self.assertEqual(page.evaluate("() => pane().previous"), "s-draft",
                         "S3-STRUCT B3: the live value is my draft entry, not the superseded head")
        self.assertEqual(page.evaluate("() => $('#struct-value-choice').value"), "c2",
                         "the form opens on the value that is actually in the report")
        self.assertEqual(page.evaluate("() => $('#struct-removed').textContent"), CHOICE_LINE2)
        page.evaluate("() => { $('#struct-value-choice').value = 'c1';"
                      "$('#struct-value-choice').dispatchEvent(new Event('change', {bubbles: true})); }")
        self.assertEqual(page.evaluate("() => pane().plan.mode2"), "replace")
        page.evaluate("() => applyStruct()")
        page.wait_for_function("() => calls.length === 1")
        sent = page.evaluate("() => calls[0].body")
        self.assertEqual(sent["structure"]["replacesSid"], "s-draft")
        self.assertEqual(sent["structure"]["value"], "c1")
        self.assertEqual(sent["findings"], CHOICE_LINE)
        self.assertEqual(page.evaluate("() => $('#findings').value"), CHOICE_LINE)


if __name__ == "__main__":
    unittest.main(verbosity=2)
