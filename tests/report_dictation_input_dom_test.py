# coding: utf-8
"""TEST-S3-R14-INPUT-COMPAT-DOM: recogniser-shaped text against the shipped handlers.

REQ-S3-R14-INPUT-COMPAT (cached Notion Part 1 Radiologist Workspace `Dictation`)
  -> RISK-S3-R14-LOST-DICTATED-TEXT/DUPLICATED-DICTATED-TEXT/WRONG-INSERT-POSITION/
     UNCLAIMED-OCCUPANCY/SILENT-OVERLONG-VALUE/FALSE-DICTATION-PROMISE
  -> TEST-S3-R14-INPUT-COMPAT-DOM.

This unit adds **no product logic**. The one product byte it stands on is the disabled `Dictate`
button's `id`/`title`; every handler below is the shipped one, sliced out of `main.html` and never
retyped. The question is narrow and only a browser can answer it: does text that arrives the way an
IME or a voice-typing tool delivers it end up stored, positioned, claimed and refused exactly as
typed text does?

The oracle is CDP. `Input.imeSetComposition` makes Blink run its own `InputMethodController`, so
`compositionstart/update/end` and `input(isComposing=true)` are the browser's and `.value` carries
the composing text; `Input.insertText` commits it. **No script-constructed `CompositionEvent`
appears anywhere in this file** - a synthetic event would let a composition-named case pass while
proving nothing about a composition. If the transport is missing on the pinned Chromium the nine
composition cases skip and are listed by id in the printed summary as UNEXECUTED; they are never
quietly green.

DI-04 is an observation, not a gate. It runs the same-value poll against a live composition on the
unchanged shipped handlers and records what happened, and it runs before DI-05 asserts the parity
contract. If DI-05 fails, DI-04's record is the evidence of a real incompatibility - the answer is
to report it, not to add a guard.

Two files may be replaced through KIN_DICTATION_MAIN / KIN_DICTATION_CITATION_JS so an existing
mutant runner can break the product on purpose without touching the source tree.

`python tests/report_dictation_input_dom_test.py --static-only` runs the pure checks with no
browser.
"""
import json
import os
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAIN_PATH = Path(os.environ.get("KIN_DICTATION_MAIN", ROOT / "worklist-v0" / "hpacs-lite" / "main.html"))
CITATION_PATH = Path(os.environ.get("KIN_DICTATION_CITATION_JS",
                                    ROOT / "worklist-v0" / "hpacs-lite" / "report-citation.js"))
STRUCTURE_PATH = ROOT / "worklist-v0" / "hpacs-lite" / "report-structure.js"
MAIN = MAIN_PATH.read_text(encoding="utf-8")
CITATION_JS = CITATION_PATH.read_text(encoding="utf-8")
STRUCTURE_JS = STRUCTURE_PATH.read_text(encoding="utf-8")

UID = "1.2.3"
OTHER = "1.2.4"
# Three real lines, so every caret below sits at a real position inside real text.
EXISTING = "첫 줄\n둘째 줄\n셋째 줄"
# A composition the way an IME actually delivers one: intermediate states, then a commit that
# replaces them. Each step is the WHOLE composing string, which is what Input.imeSetComposition takes.
STEPS = ["ㄱ", "가", "간"]
COMPOSED = "간유리음영"
# Two characters is HOLD_MIN_CHARS (main.html:4828); the third step is where occupancy must start.
HOLD_STEPS = ["ㄱ", "가", "가ㄴ", "가나"]
HOLD_COMMIT = "가나"
STRUCT_VALUE = "경계가 뚜렷함"
DICTATE_TITLE = "음성 인식기가 연결되지 않았습니다."
# report-structure.js:111-112 - the shipped refusal wording, not a paraphrase.
MSG_ONE_LINE = "값은 한 줄이어야 합니다"
MSG_TOO_LONG = "값이 512바이트를 넘습니다"
# 170 Hangul = 510 UTF-8 bytes (accepted), 171 = 513 (refused). The limit is bytes, not UTF-16 units.
ACCEPT_VALUE = "가" * 170
REFUSE_VALUE = "가" * 171
# GEN-1 free-text item in the findings field (report-structure.js:77-83). The option value is the
# product's own item key: templateId, NUL, item code (report-structure.js:133-135).
FINDING_KEY = "GEN-1" + chr(0) + "FINDING"

SUMMARY = {"composition_source": "unknown", "executed": [], "skipped": [], "observations": {}}


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


# The markup is sliced too, not retyped. DI-13 has to assert the Dictate button's own bytes, and a
# hand-written copy of it would only assert this file against itself.
MARKERS = {
    "MODAL_CSS": (".modal { display: none;", "/* ══ 클릭 피드백"),
    "RBTNS_HTML": ('<div class="rbtns">', "\n        </div>"),
    "BARS_HTML": ('<div class="draftbar" id="draftbar"', '<div id="citelist"'),
    "REDIT_HTML": ('<div class="redit">', "\n        </div>"),
    # Not asserted here, but `commitReport` addresses #b-unread/#b-defer by id: a missing element
    # would throw at runtime instead of at load, which is the harder failure to read.
    "RFOOT_HTML": ('<div class="rfoot2">', "\n        </div>"),
    "PANE_HTML": ('<div class="modal" id="stalemodal"', "\n  </div>"),
    "CITE_HTML": ('<div class="modal" id="cite-preview"', "\n  </div>"),
    "STRUCT_HTML": ('<div class="modal" id="structmodal"', "\n  </div>"),
    "BASE_BLOCK": ("    let selectionSeq = 0;", "    function reportSource()"),
    "REPORT_BLOCK": ("    function reportSource() {", "    function heldByOther(s)"),
    "HOLD_BLOCK": ("    // ══════════ 동시 판독 점유 (교훈 §2) ══════════",
                   "    // ══════════ 이탈 시 판독문 보존 (교훈 §1) ══════════"),
}

MODAL_CSS = slice_between(MAIN, *MARKERS["MODAL_CSS"])
RBTNS_HTML = slice_between(MAIN, *MARKERS["RBTNS_HTML"]) + "\n        </div>"
BARS_HTML = (slice_between(MAIN, *MARKERS["BARS_HTML"])
             + '<div id="citelist" hidden aria-label="Report Citations"></div>')
REDIT_HTML = slice_between(MAIN, *MARKERS["REDIT_HTML"]) + "\n        </div>"
RFOOT_HTML = slice_between(MAIN, *MARKERS["RFOOT_HTML"]) + "\n        </div>"
PANE_HTML = slice_between(MAIN, *MARKERS["PANE_HTML"]) + "\n  </div>"
CITE_HTML = slice_between(MAIN, *MARKERS["CITE_HTML"]) + "\n  </div>"
STRUCT_HTML = slice_between(MAIN, *MARKERS["STRUCT_HTML"]) + "\n  </div>"
BASE_BLOCK = slice_between(MAIN, *MARKERS["BASE_BLOCK"])
REPORT_BLOCK = slice_between(MAIN, *MARKERS["REPORT_BLOCK"])
# Placed AFTER the report block: it declares heldUid/heartbeat/warnedFor/holdPending itself, so the
# stub below must not, and the only heldUid use inside the report block is inside commitReport.
HOLD_BLOCK = slice_between(MAIN, *MARKERS["HOLD_BLOCK"])
API_FN = extract_function(MAIN, "api")
WRITE_BLOCK_FN = extract_function(MAIN, "reportWriteBlock")
EDITOR_BLOCK_FN = extract_function(MAIN, "reportEditorBlock")

HARNESS = """<!doctype html><html><head><meta charset="utf-8"><style>MODALCSS</style></head><body>
<div class="panel report-p">
RBTNSHTML
BARSHTML
REDITHTML
RFOOTHTML
</div>
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
const $ = s => document.querySelector(s);
const esc = v => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const RFIELDS = ["findings", "conclusion", "recommendation"];
const API = "/api";
let serverMode = true, offline = false, demoMode = false;
let selectedUid = "UIDVALUE", user = "doctor@kin";
let appState = INITIALSTATE;
let studies = [{uid: "UIDVALUE", name: "HONG GILDONG", id: "P-1", date: "2026-09-22", acc: "A1", desc: "Chest CT",
                rs: "T", ss: "Verified", em: "N"},
               {uid: "OTHERVALUE", name: "KIM CHULSOO", id: "P-2", date: "2026-09-22", acc: "A2", desc: "Brain CT",
                rs: "T", ss: "Verified", em: "N"}];
let calls = [], holdCalls = [], citeCalls = [], structCalls = [];
let replies = [], citeReplies = [], structReplies = [], toasts = [], confirms = [], confirmAnswer = false;
const studyPriority = { get: () => false };
const KinAuth = { has: () => true, logout: async () => {} };
const reportPreview = { close() {} };
const displayActor = value => String(value ?? "").split("@")[0];
function cur() { return studies.find(s => s.uid === selectedUid); }
function heldByOther(s) { return s?.holder && s.holder !== user ? s.holder : null; }
function shownStudyDesc(s) { return s?.desc ?? ""; }
function today() { return "2026-09-22"; }
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
window.fetch = async (url, options = {}) => {
  const path = String(url).slice(API.length);
  const record = { method: options.method ?? "GET", path, keepalive: !!options.keepalive,
                   body: options.body ? JSON.parse(options.body) : null,
                   keys: options.body ? Object.keys(JSON.parse(options.body)) : [] };
  /* Occupancy is a different surface and gets its own counter. The shipped input listener POSTs
     /hold the moment two characters reach a field, so if it landed in `calls` every exact
     report-write count in this file would shift by one - the same class already handled below for
     the structured read. */
  if (path.endsWith("/hold") || path.endsWith("/release")) {
    holdCalls.push(record);
    return { ok: true, status: 200, json: async () => ({ holder: user, conflict: false }) };
  }
  if (path.endsWith("/report/citations")) {
    citeCalls.push(record);
    const body = citeReplies.shift();
    if (body === undefined)
      return { ok: false, status: 500, json: async () => ({ message: "인용을 확인할 수 없습니다" }) };
    return { ok: true, status: 200, json: async () => body };
  }
  if (path.endsWith("/report/structure")) {
    structCalls.push(record);
    const body = structReplies.shift() ?? { version: 0, unknown: false, head: [], draft: [] };
    return { ok: true, status: 200, json: async () => body };
  }
  calls.push(record);
  const reply = replies.shift() ?? { status: 200, body: {} };
  return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
};
APIFN
WRITEBLOCKFN
EDITORBLOCKFN
BASEBLOCK
REPORTBLOCK
HOLDBLOCK
window.load = options => loadReport(options);
window.stash = () => stashReport();
window.text = () => RFIELDS.map(k => $("#" + k).value);
window.caretOf = field => [$("#" + field).selectionStart, $("#" + field).selectionEnd];
window.put = (field, start, end) => { const el = $("#" + field); el.setSelectionRange(start, end === undefined ? start : end); };
window.marked = field => caretFields.has(field);
window.reply = value => { replies.push(value); };
window.citeReply = value => { citeReplies.push(value); };
window.structReply = value => { structReplies.push(value); };
window.openStruct = () => openStructure();
window.structValue = () => [$("#struct-value-text").value, $("#struct-value-text").selectionStart];
window.snapshot = () => ({
  calls: structuredClone(calls), holdCalls: structuredClone(holdCalls),
  citeCalls: structuredClone(citeCalls), structCalls: structuredClone(structCalls),
  toasts: structuredClone(toasts), text: window.text(),
  state: structuredClone(appState[selectedUid] ?? null),
  caret: Object.fromEntries(RFIELDS.map(k => [k, window.caretOf(k)])),
  marked: Object.fromEntries(RFIELDS.map(k => [k, caretFields.has(k)])),
  readOnly: Object.fromEntries(RFIELDS.map(k => [k, $("#" + k).readOnly])),
  placeholder: Object.fromEntries(RFIELDS.map(k => [k, $("#" + k).placeholder])),
  focused: document.activeElement ? document.activeElement.id : null,
  draftbar: { shown: $("#draftbar").style.display !== "none", message: $("#draftmsg").textContent },
  struct: { line: $("#struct-line").textContent, status: $("#struct-status").textContent,
            place: $("#struct-place").textContent, disabled: $("#struct-apply").disabled,
            shown: $("#structmodal").classList.contains("on") },
});
</script></body></html>"""


def harness(state):
    return (HARNESS
            .replace("MODALCSS", MODAL_CSS)
            .replace("RBTNSHTML", RBTNS_HTML)
            .replace("BARSHTML", BARS_HTML)
            .replace("REDITHTML", REDIT_HTML)
            .replace("RFOOTHTML", RFOOT_HTML)
            .replace("PANEHTML", PANE_HTML)
            .replace("CITEHTML", CITE_HTML)
            .replace("STRUCTHTML", STRUCT_HTML)
            .replace("CITATIONJS", CITATION_JS)
            .replace("STRUCTUREJS", STRUCTURE_JS)
            .replace("APIFN", API_FN)
            .replace("WRITEBLOCKFN", WRITE_BLOCK_FN)
            .replace("EDITORBLOCKFN", EDITOR_BLOCK_FN)
            .replace("BASEBLOCK", BASE_BLOCK)
            .replace("REPORTBLOCK", REPORT_BLOCK)
            .replace("HOLDBLOCK", HOLD_BLOCK)
            .replace("INITIALSTATE", json.dumps(state))
            .replace("UIDVALUE", UID)
            .replace("OTHERVALUE", OTHER))


def top_level_selectors():
    """Every `$("#id")` in the sliced script regions. A missing element makes the page throw while
    loading and kills every case before its first assertion (the U3 lesson)."""
    found = set()
    for block in (BASE_BLOCK, REPORT_BLOCK, HOLD_BLOCK):
        for match in re.finditer(r"""\$\(\s*["']#([A-Za-z0-9_-]+)["']\s*\)""", block):
            found.add(match.group(1))
    return found


def markup_ids():
    page = harness({})
    return set(re.findall(r"""\sid=["']([A-Za-z0-9_-]+)["']""", page))


def static_report():
    """The pure half of DI-00 plus the pins that need no browser."""
    problems = []
    for name, (start, end) in MARKERS.items():
        if MAIN.count(start) != 1:
            problems.append("slice marker %s start occurs %d times" % (name, MAIN.count(start)))
    ids = markup_ids()
    # The sliced region creates the Structured button at runtime, so it is legitimately absent here.
    missing = sorted(selector for selector in top_level_selectors()
                     if selector not in ids and selector != "b-structured")
    if missing:
        problems.append("harness markup is missing %s" % ", ".join(missing))
    autosave = slice_between(MAIN, "    const AUTOSAVE_MS = 20000;", "    }, AUTOSAVE_MS);")
    if "stashReport();" not in autosave:
        problems.append("the autosave interval no longer calls stashReport()")
    if "if (selectedUid) { loadReport(); updateReportButtons(); }" not in MAIN:
        problems.append("the non-force poll call site moved")
    if 'title="%s"' % DICTATE_TITLE not in MAIN:
        problems.append("the Dictate tooltip is not the disposed string")
    if 'id="b-dictate"' not in MAIN:
        problems.append("the Dictate button has no id")
    source = Path(__file__).read_text(encoding="utf-8")
    # Split so this check does not match itself.
    if ("Composition" + "Event(") in source or ("new " + "CompositionEvent") in source:
        problems.append("a script-constructed composition event would prove nothing about an IME")
    cases = sorted(name for name in dir(ReportDictationInputDOMTest) if name.startswith("test_di"))
    if len(cases) != 14:
        problems.append("expected 14 DI cases, found %d" % len(cases))
    return problems, cases


class ReportDictationInputDOMTest(unittest.TestCase):
    composition_source = "none"
    composition_error = ""

    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls._pw = sync_playwright().start()
        cls.browser = cls._pw.chromium.launch()
        cls._probe_composition()
        SUMMARY["composition_source"] = cls.composition_source

    @classmethod
    def _probe_composition(cls):
        """One probe, on a bare textarea, before any case: does this Chromium give us a REAL
        composition through CDP? If it does not, the composition cases are skipped and reported
        unexecuted - they are never allowed to pass on anything weaker."""
        page = cls.browser.new_page()
        try:
            page.set_content("<textarea id='t'></textarea>")
            page.evaluate("()=>{window.__c=[];const el=document.getElementById('t');"
                          "for(const n of ['compositionstart','compositionupdate','compositionend'])"
                          "el.addEventListener(n,()=>window.__c.push(n));}")
            page.focus("#t")
            session = page.context.new_cdp_session(page)
            session.send("Input.imeSetComposition", {"text": "ㄱ", "selectionStart": 1, "selectionEnd": 1})
            seen = page.evaluate("()=>window.__c.slice()")
            during = page.evaluate("()=>document.getElementById('t').value")
            session.send("Input.insertText", {"text": "가"})
            after = page.evaluate("()=>document.getElementById('t').value")
            if "compositionstart" in seen and after == "가":
                cls.composition_source = "cdp"
            else:
                cls.composition_error = "events=%s during=%r after=%r" % (seen, during, after)
        except Exception as error:               # the transport, not the product
            cls.composition_error = "%s: %s" % (type(error).__name__, error)
        finally:
            page.close()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls._pw.stop()
        print("R14-SUMMARY " + json.dumps(SUMMARY, ensure_ascii=False, sort_keys=True))
        if cls.composition_source != "cdp":
            print("R14-COMPOSITION-UNEXECUTED composition_source=none reason=%s cases=%s"
                  % (cls.composition_error, ",".join(SUMMARY["skipped"])))

    def setUp(self):
        self.page = self.browser.new_page()
        self._cdp = None
        self.errors = []
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))

    def tearDown(self):
        # A harness that never started reports whatever it touched first; say so loudly instead.
        # The probe must be something assigned at the END of the script: function declarations
        # hoist, so a `typeof loadReport` probe stays true even if the script died half way.
        started = self.page.evaluate("()=>typeof window.snapshot === 'function'")
        self.page.close()
        self.assertTrue(started, "HARNESS DID NOT START: %s" % self.errors[:2])
        self.assertEqual([], self.errors, "the product region raised in the browser")

    # ── helpers ────────────────────────────────────────────────────────────────────────────
    def need_composition(self, case):
        if self.composition_source != "cdp":
            SUMMARY["skipped"].append(case)
            self.skipTest("no real CDP composition on this Chromium (%s); %s is UNEXECUTED"
                          % (self.composition_error, case))
        SUMMARY["executed"].append(case)

    def cdp(self):
        if self._cdp is None:
            self._cdp = self.page.context.new_cdp_session(self.page)
        return self._cdp

    def compose(self, selector, steps, commit=None, record=None):
        """A real Blink composition. Each step is the whole composing string, as an IME sends it."""
        self.page.focus(selector)
        for step in steps:
            self.cdp().send("Input.imeSetComposition",
                            {"text": step, "selectionStart": len(step), "selectionEnd": len(step)})
            if record is not None:
                record.append(self.page.evaluate("()=>structValue()"))
        if commit is not None:
            self.cdp().send("Input.insertText", {"text": commit})

    def open(self, fields=(EXISTING, "", ""), draft=True, citations=None):
        body = {"findings": fields[0], "conclusion": fields[1], "recommendation": fields[2]}
        row = {"version": 1, "rs": "T", "ss": "Verified"}
        row["draft"] = dict(body, baseVersion=1) if draft else None
        if not draft:
            row.update(body)
        state = {UID: row, OTHER: {"version": 0, "rs": "T"}}
        self.page.set_content(harness(state))
        self.page.evaluate("citeReply(%s)" % json.dumps(citations or {"version": 1, "head": [], "draft": []}))
        self.page.evaluate("load({force:true})")
        self.page.wait_for_function("()=>citeCalls.length>=1")
        # The forced load has now put the state's text into the fields; start every case from a
        # screen that matches the saved source exactly.
        self.assertEqual(list(fields), self.snap()["text"], "the forced load did not seed the fields")
        self.page.evaluate("()=>{ calls.length = 0; holdCalls.length = 0; toasts.length = 0; }")

    def place(self, field, position):
        """A real caret: focus (which is what marks the field) and then the range. Focus stays -
        a composition needs it."""
        self.page.focus("#" + field)
        self.page.evaluate("put(%s, %d)" % (json.dumps(field), position))

    def snap(self):
        return self.page.evaluate("snapshot()")

    def puts(self):
        return [c for c in self.snap()["calls"] if c["method"] == "PUT"]

    def open_struct_finding(self):
        self.page.evaluate("openStruct()")
        self.page.wait_for_function("()=>$('#structmodal').classList.contains('on')")
        self.page.select_option("#struct-item", FINDING_KEY)

    # ── DI-00 ──────────────────────────────────────────────────────────────────────────────
    def test_di00_the_slices_the_call_sites_and_the_routing_this_file_stands_on(self):
        """Pure. The stand-ins below (`stash()`, `load()`) are only honest while the shipped timers
        still call exactly those functions, and every exact count is only honest while occupancy and
        the structured read stay out of `calls`."""
        problems, cases = static_report()
        self.assertEqual([], problems)
        self.assertEqual(["test_di%02d" % n for n in list(range(0, 14))],
                         [name[:9] for name in cases], "the DI ids must stay dense and stable")
        self.assertIn('path.endsWith("/hold") || path.endsWith("/release")', HARNESS,
                      "occupancy must not be counted as a report write")
        self.assertIn('path.endsWith("/report/structure")', HARNESS,
                      "the structured read must not be counted as a report write")
        self.assertIn("/hold", HOLD_BLOCK, "the occupancy slice must be the one that posts the hold")
        self.assertIn("HOLD_MIN_CHARS", HOLD_BLOCK)
        # N-B: refreshRight() is a non-force caller by default, so the poll is not the only one.
        self.assertIn("loadReport({ force: forceReport })", MAIN)

    # ── DI-01 ──────────────────────────────────────────────────────────────────────────────
    def test_di01_a_committed_composition_lands_at_the_caret(self):
        self.need_composition("DI-01")
        self.open()
        self.place("findings", 3)                      # end of "첫 줄", inside the first line
        self.compose("#findings", STEPS, COMPOSED)
        value = self.snap()
        self.assertEqual("첫 줄" + COMPOSED + "\n둘째 줄\n셋째 줄", value["text"][0],
                         "the composed text belongs at the caret, with nothing lost or doubled")
        self.assertEqual([3 + len(COMPOSED)] * 2, value["caret"]["findings"])
        self.assertTrue(value["marked"]["findings"], "the field was focused, so its position is known")

    # ── DI-02 ──────────────────────────────────────────────────────────────────────────────
    def test_di02_key_events_a_composition_and_a_direct_commit_are_the_same_text(self):
        """The three ways text reaches a field. `keyboard.insert_text` IS `Input.insertText`, so the
        third way is the commit half without the composition - which is the point: the composition
        path must end where the other two end."""
        self.need_composition("DI-02")
        self.open(fields=("", "", ""))
        self.place("findings", 0)
        self.page.keyboard.type(COMPOSED)
        self.place("conclusion", 0)
        self.compose("#conclusion", STEPS, COMPOSED)
        self.place("recommendation", 0)
        self.page.keyboard.insert_text(COMPOSED)
        value = self.snap()
        self.assertEqual([COMPOSED] * 3, value["text"], "all three paths must store the same bytes")
        self.assertEqual([[len(COMPOSED)] * 2] * 3, [value["caret"][k] for k in
                                                     ("findings", "conclusion", "recommendation")])
        self.assertEqual([True] * 3, [value["marked"][k] for k in
                                      ("findings", "conclusion", "recommendation")])
        self.page.evaluate("stash()")
        self.page.wait_for_function("()=>calls.length>=1")
        body = self.puts()[-1]["body"]
        self.assertEqual([COMPOSED] * 3, [body["findings"], body["conclusion"], body["recommendation"]],
                         "and the draft must carry the same bytes from every path")

    # ── DI-03 ──────────────────────────────────────────────────────────────────────────────
    def test_di03_autosave_carries_what_is_in_the_field_at_that_instant(self):
        """Autosave is value-polled (main.html:4932-4943), so it writes whatever the field holds -
        including a composition still in flight. That partial capture is recovery, not a defect: it
        loses nothing and the next tick supersedes it. Both writes are pinned here."""
        self.need_composition("DI-03")
        self.open()
        self.place("findings", 3)
        self.compose("#findings", STEPS)                       # still composing, not committed
        during = self.snap()["text"][0]
        self.page.evaluate("stash()")
        self.page.wait_for_function("()=>calls.length>=1")
        self.assertEqual(during, self.puts()[-1]["body"]["findings"],
                         "the first write must be exactly what the field held")
        self.compose("#findings", [], COMPOSED)
        self.page.evaluate("stash()")
        self.page.wait_for_function("()=>calls.length>=2")
        self.assertEqual("첫 줄" + COMPOSED + "\n둘째 줄\n셋째 줄", self.puts()[-1]["body"]["findings"],
                         "and the second write must carry the committed text")
        self.assertEqual(2, len(self.snap()["calls"]), "exactly two report writes, no third")
        SUMMARY["observations"]["value_during_composition"] = during

    # ── DI-04 ──────────────────────────────────────────────────────────────────────────────
    def test_di04_observation_a_same_value_poll_during_a_live_composition(self):
        """OBSERVATION, NOT A GATE. Runs the shipped handlers unchanged.

        After an autosave tick captures the composing text, `reportDirty()` is false, so a non-force
        `loadReport()` - what the 30 s poll calls - reaches its assignment. Whether that disturbs a
        live Blink composition is a browser fact nobody here has measured, so this case records it
        and asserts only what holds either way. DI-05 is where the parity contract is asserted."""
        self.need_composition("DI-04")
        self.open()
        self.place("findings", 3)
        self.compose("#findings", STEPS)
        self.page.evaluate("stash()")
        self.page.wait_for_function("()=>calls.length>=1")
        before = self.snap()
        writes = len(before["calls"])
        draft = before["state"]["draft"]
        self.page.evaluate("load()")
        after = self.snap()
        self.compose("#findings", [], COMPOSED)
        final = self.snap()
        SUMMARY["observations"]["same_value_poll_during_composition"] = {
            "before": {"text": before["text"][0], "caret": before["caret"]["findings"],
                       "marked": before["marked"]["findings"]},
            "after_load": {"text": after["text"][0], "caret": after["caret"]["findings"],
                           "marked": after["marked"]["findings"]},
            "after_commit": {"text": final["text"][0], "caret": final["caret"]["findings"]},
            "parity_expected": "첫 줄" + COMPOSED + "\n둘째 줄\n셋째 줄",
        }
        self.assertEqual(writes, len(after["calls"]), "a poll's load must not write")
        self.assertEqual(draft, after["state"]["draft"], "and must not alter the saved draft")
        self.assertTrue(final["text"][0].startswith("첫 줄"), "the text before the caret survives")
        self.assertTrue(final["text"][0].endswith("\n둘째 줄\n셋째 줄"), "and so does the text after it")

    # ── DI-05 ──────────────────────────────────────────────────────────────────────────────
    def test_di05_a_poll_during_a_live_composition_keeps_typing_parity(self):
        """The contract. Same shape as DI-04, now asserted: a composition that outlives an autosave
        tick and a poll must end exactly where typing would. If this fails, DI-04's record is the
        evidence of a real incompatibility - it is reported, not patched with a guard."""
        self.need_composition("DI-05")
        self.open()
        self.place("findings", 3)
        self.compose("#findings", STEPS)
        self.page.evaluate("stash()")
        self.page.wait_for_function("()=>calls.length>=1")
        self.page.evaluate("load()")
        self.compose("#findings", [], COMPOSED)
        value = self.snap()
        self.assertEqual("첫 줄" + COMPOSED + "\n둘째 줄\n셋째 줄", value["text"][0],
                         "a poll between the composition and its commit must change nothing")
        self.assertEqual([3 + len(COMPOSED)] * 2, value["caret"]["findings"])
        self.assertTrue(value["marked"]["findings"], "an identical assignment must not forget the position")

    # ── DI-06 ──────────────────────────────────────────────────────────────────────────────
    def test_di06_a_forced_load_replaces_the_field_even_mid_composition(self):
        """A study switch must still overwrite (the A->B->A lesson). What Blink does to a live
        composition when the value is replaced by a DIFFERENT string cannot be read off the source,
        so the product contract is asserted and the composition's fate is recorded."""
        self.need_composition("DI-06")
        self.open()
        self.place("findings", 3)
        self.compose("#findings", STEPS)
        self.page.evaluate("()=>{ appState[%s].draft.findings = '서버가 보낸 다른 초안'; load({force:true}); }"
                           % json.dumps(UID))
        after = self.snap()
        self.assertEqual("서버가 보낸 다른 초안", after["text"][0], "a forced load replaces the field")
        self.assertFalse(after["marked"]["findings"], "a changed value drops the remembered position")
        self.compose("#findings", [], COMPOSED)
        final = self.snap()
        SUMMARY["observations"]["forced_different_value_during_composition"] = {
            "after_load": after["text"][0], "after_commit": final["text"][0],
            "draftbar": after["draftbar"],
        }

    # ── DI-07 ──────────────────────────────────────────────────────────────────────────────
    def test_di07_a_prelim_lock_during_a_composition_locks_the_field(self):
        """Value preservation and permission are different states (main.html:3234). Someone else's
        Prelim must lock the field whatever the input path was doing."""
        self.open()
        self.place("findings", 3)
        self.page.evaluate("()=>{ const a = appState[%s]; a.prelimHidden = true; a.preReviewer = 'senior@kin';"
                           " load(); }" % json.dumps(UID))
        value = self.snap()
        self.assertTrue(value["readOnly"]["findings"], "a hidden preliminary report is not editable")
        self.assertEqual("senior 님이 최종 판독 중입니다 (RS: P) — 내용은 지정된 판독의만 볼 수 있습니다",
                         value["placeholder"]["findings"])
        self.assertEqual([], value["calls"], "and the lock transition writes nothing")

    # ── DI-08 ──────────────────────────────────────────────────────────────────────────────
    def test_di08_occupancy_starts_on_composing_text_exactly_as_on_typing(self):
        self.need_composition("DI-08")
        self.open(fields=("", "", ""))
        self.place("findings", 0)
        self.compose("#findings", HOLD_STEPS)                  # two characters, still composing
        self.page.wait_for_function("()=>holdCalls.length>=1")
        value = self.snap()
        self.assertEqual(1, len(value["holdCalls"]), "one claim, not one per event")
        self.assertEqual("POST", value["holdCalls"][0]["method"])
        self.assertEqual("/studies/%s/hold" % UID, value["holdCalls"][0]["path"])
        self.assertEqual([], value["calls"], "occupancy is not a report write")
        self.compose("#findings", [], HOLD_COMMIT)
        self.assertEqual(1, len(self.snap()["holdCalls"]), "committing must not claim a second time")

    # ── DI-09 ──────────────────────────────────────────────────────────────────────────────
    def test_di09_a_structured_line_goes_to_the_caret_the_composition_left(self):
        self.need_composition("DI-09")
        self.open()
        self.place("findings", 3)
        self.compose("#findings", STEPS, COMPOSED)             # caret now inside the first line
        self.open_struct_finding()
        self.compose("#struct-value-text", ["ㄱ", "겨"], STRUCT_VALUE)
        pane = self.snap()["struct"]
        self.assertEqual("Finding: " + STRUCT_VALUE, pane["line"])
        self.assertIn("2번째 줄부터 넣습니다", pane["place"],
                      "the caret sat inside line 1, so the line belongs on line 2")
        self.assertFalse(pane["disabled"])
        self.page.click("#struct-apply")
        self.page.wait_for_function("()=>calls.some(c=>c.method==='PUT')")
        value = self.snap()
        self.assertEqual(value["text"][0], self.puts()[-1]["body"]["findings"],
                         "the body sent is the body shown")
        self.assertEqual("첫 줄" + COMPOSED + "\nFinding: " + STRUCT_VALUE + "\n둘째 줄\n셋째 줄",
                         value["text"][0])

    # ── DI-10 ──────────────────────────────────────────────────────────────────────────────
    def test_di10_the_structured_value_field_is_not_rebuilt_while_it_is_composed_into(self):
        """Every keystroke re-renders that pane (main.html:3887-3889). A render that reassigned the
        value would eat the composition - the S2-B failure class."""
        self.need_composition("DI-10")
        self.open()
        self.open_struct_finding()
        seen = []
        self.compose("#struct-value-text", ["ㄱ", "겨", "경"], STRUCT_VALUE, record=seen)
        self.assertEqual([["ㄱ", 1], ["겨", 1], ["경", 1]], seen,
                         "the composing value and its caret must survive every re-render")
        pane = self.snap()["struct"]
        self.assertEqual("Finding: " + STRUCT_VALUE, pane["line"])
        self.assertEqual("", pane["status"])
        self.assertFalse(pane["disabled"])

    # ── DI-11 ──────────────────────────────────────────────────────────────────────────────
    def test_di11_a_value_that_is_not_one_line_is_refused(self):
        self.open()
        self.open_struct_finding()
        self.page.fill("#struct-value-text", "정상 소견")
        self.assertEqual("정상 소견", self.page.evaluate("()=>$('#struct-value-text').value"),
                         "the line separator has to reach the value for the rule to be tested")
        pane = self.snap()["struct"]
        self.assertEqual(MSG_ONE_LINE, pane["status"])
        self.assertEqual("", pane["line"])
        self.assertTrue(pane["disabled"])
        self.assertEqual([], self.snap()["calls"], "a refused value sends nothing")

    # ── DI-12 ──────────────────────────────────────────────────────────────────────────────
    def test_di12_the_limit_is_utf8_bytes_not_utf16_units(self):
        self.open()
        self.open_struct_finding()
        self.page.fill("#struct-value-text", ACCEPT_VALUE)     # 170 Hangul = 510 bytes
        pane = self.snap()["struct"]
        self.assertEqual("", pane["status"])
        self.assertEqual("Finding: " + ACCEPT_VALUE, pane["line"])
        self.assertFalse(pane["disabled"])
        self.page.fill("#struct-value-text", REFUSE_VALUE)     # 171 Hangul = 513 bytes
        pane = self.snap()["struct"]
        self.assertEqual(MSG_TOO_LONG, pane["status"])
        self.assertEqual("", pane["line"])
        self.assertTrue(pane["disabled"])
        self.assertEqual([], self.snap()["calls"], "a refused value sends nothing")

    # ── DI-13 ──────────────────────────────────────────────────────────────────────────────
    def test_di13_the_dictate_control_says_what_is_true(self):
        """The button comes from the sliced product markup, so this asserts main.html's own bytes."""
        self.open()
        button = self.page.evaluate(
            "()=>{const b=$('#b-dictate');return b?{disabled:b.disabled,text:b.textContent.trim(),"
            "title:b.getAttribute('title')}:null;}")
        self.assertIsNotNone(button, "the control has to be addressable to be honest")
        self.assertTrue(button["disabled"], "nothing is connected, so it stays disabled")
        self.assertEqual("Dictate", button["text"])
        self.assertEqual(DICTATE_TITLE, button["title"])
        self.page.evaluate("()=>$('#b-dictate').click()")
        value = self.snap()
        self.assertEqual([], value["calls"])
        self.assertEqual([], value["toasts"], "pressing it must do nothing at all")
        for name, text in (("main.html", MAIN), ("report-citation.js", CITATION_JS),
                           ("report-structure.js", STRUCTURE_JS)):
            for api in ("SpeechRecognition", "MediaRecorder", "getUserMedia", "mediaDevices"):
                self.assertNotIn(api, text, "%s must contain no recogniser or capture API" % name)


if __name__ == "__main__":
    if "--static-only" in sys.argv:
        problems, cases = static_report()
        print(json.dumps({"static_only": True, "cases": len(cases), "problems": problems,
                          "main": str(MAIN_PATH)}, ensure_ascii=False, indent=2))
        sys.exit(1 if problems else 0)
    unittest.main(verbosity=2)
