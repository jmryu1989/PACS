# coding: utf-8
"""TEST-S3-U6-CURSOR-DOM: the shipped cursor placement, on the real main.html, against a fetch stub.

REQ-S3-U6-CURSOR-INSERTION (IF-A29 "cursor 위치 삽입")
  -> RISK-S3-U6-SPLIT-LINE/BROKEN-GUARD/LOST-TEXT/DIVERGENT-BODY/UNREAD-POSITION/LOST-CARET
  -> TEST-S3-U6-CURSOR-DOM.

The product regions are sliced out of main.html, never retyped: the caret model (base block), the
citation state, the preview pane, the insertion and stashReport/commitReport (report block), and -
for the template half - insertTemplate and its gate by name. The citation module is the shipped file.

What only a browser can answer is what this file is for: a textarea keeps its selection after blur,
an identical value assignment does not move the caret, a changed one does, and the position the
person read is the position that is sent. Nothing here talks to a server, a database or a stack.

Two files may be replaced through KIN_CURSOR_MAIN / KIN_CURSOR_CITATION_JS so the mutant runner can
break the product on purpose without ever touching the source tree.
"""
import json
import os
import re
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MAIN_PATH = Path(os.environ.get("KIN_CURSOR_MAIN", ROOT / "worklist-v0" / "hpacs-lite" / "main.html"))
CITATION_PATH = Path(os.environ.get("KIN_CURSOR_CITATION_JS", ROOT / "worklist-v0" / "hpacs-lite" / "report-citation.js"))
MAIN = MAIN_PATH.read_text(encoding="utf-8")
CITATION_JS = CITATION_PATH.read_text(encoding="utf-8")

UID = "1.2.3"
OTHER = "1.2.4"
BLOCK = "인용 제목\n인용 본문"
# A field with three lines: every anchor case below is a real position inside real text.
EXISTING = "첫 줄\n둘째 줄\n셋째 줄"


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
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise ValueError(name)


CITE_HTML = slice_between(MAIN, '<div class="modal" id="cite-preview"', "\n  </div>") + "\n  </div>"
# The sliced report block registers listeners on the stale-rebase pane at its TOP LEVEL
# (main.html:3404-3406). Without that markup `$` returns null, the script throws while loading and
# nothing after it is ever defined - the same reason both proven harnesses inject this modal.
PANE_HTML = slice_between(MAIN, '<div class="modal" id="stalemodal"', "\n  </div>") + "\n  </div>"
MODAL_CSS = slice_between(MAIN, ".modal { display: none;", "/* ══ 클릭 피드백")
BASE_BLOCK = slice_between(MAIN, "    let selectionSeq = 0;", "    function reportSource()")
REPORT_BLOCK = slice_between(MAIN, "    function reportSource() {", "    function heldByOther(s)")
API_FN = extract_function(MAIN, "api")
WRITE_BLOCK_FN = extract_function(MAIN, "reportWriteBlock")
EDITOR_BLOCK_FN = extract_function(MAIN, "reportEditorBlock")
# The template half lives outside every sliced region, so it is taken by name (P-7).
TEMPLATE_GATE_FN = extract_function(MAIN, "templateInsertionBlock")
TEMPLATE_FN = extract_function(MAIN, "insertTemplate")

HARNESS = """<!doctype html><html><head><style>MODALCSS</style></head><body>
<div class="draftbar" id="draftbar" style="display:none"><span id="draftmsg"></span>
<button id="b-report-reload"></button><button id="b-draft-discard"></button></div>
<div class="draftbar" id="citebar" style="display:none"><span id="citemsg"></span>
<button id="b-cite-list"></button><button id="b-cite-reload"></button></div>
<div id="citelist" hidden></div>
<textarea id="findings"></textarea><textarea id="conclusion"></textarea><textarea id="recommendation"></textarea>
<button id="b-approve"></button><button id="b-save"></button><button id="b-transcribe"></button>
<button id="b-addendum"></button><button id="b-unread"></button><button id="b-prelim"></button><button id="b-defer"></button>
<button id="raiser">Insert into Report</button>
PANEHTML
CITEHTML
<script>
CITATIONJS
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
let studies = [{uid: "UIDVALUE", name: "HONG GILDONG", id: "P-1", date: "2026-09-21", acc: "A1", desc: "Chest CT",
                rs: "T", ss: "Verified", em: "N"},
               {uid: "OTHERVALUE", name: "KIM CHULSOO", id: "P-2", date: "2026-09-21", acc: "A2", desc: "Brain CT",
                rs: "T", ss: "Verified", em: "N"}];
let calls = [], citeCalls = [], replies = [], citeReplies = [], toasts = [], confirms = [], confirmAnswer = false;
const studyPriority = { get: () => false };
let logouts = 0;
const KinAuth = { has: () => true, logout: async () => { logouts += 1; } };
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
TEMPLATEGATEFN
BASEBLOCK
REPORTBLOCK
TEMPLATEFN
window.load = options => loadReport(options);
window.stash = () => stashReport();
/* The real caller: reading-findings.js hands the pane an `inserted` callback so an ACCEPTED
   insertion can stand its own drawer down, and the product only redirects focus into the field on
   that path. A request without it would leave focus on the button that raised the pane. */
window.stoodDown = 0;
window.cite = () => openCitePreview({ ...REQUESTVALUE, inserted: () => { window.stoodDown += 1; } }, $("#raiser"));
window.reply = value => { replies.push(value); };
window.citeReply = value => { citeReplies.push(value); };
window.hold = (n = 1) => { holdCount += n; };
window.release = () => { const fn = heldAnswers.shift(); if (fn) fn(); return !!fn; };
window.outstanding = () => heldAnswers.length;
window.text = () => RFIELDS.map(k => $("#" + k).value);
window.assign = (field, value) => { $("#" + field).value = value; };
window.caretOf = field => [$("#" + field).selectionStart, $("#" + field).selectionEnd];
window.put = (field, start, end) => { const el = $("#" + field); el.setSelectionRange(start, end === undefined ? start : end); };
window.marked = field => caretFields.has(field);
window.moveSelection = uid => markSelectionChanged(uid);
window.insertTpl = t => insertTemplate(t);
window.snapshot = () => ({
  calls: structuredClone(calls), citeCalls: structuredClone(citeCalls), toasts: structuredClone(toasts),
  text: window.text(), state: structuredClone(appState[selectedUid] ?? null),
  shown: $("#cite-preview").classList.contains("show"),
  pane: { block: $("#cite-preview-block").textContent, status: $("#cite-preview-status").textContent,
          place: $("#cite-preview-place").textContent, field: $("#cite-preview-field").value },
  bar: { list: $("#citelist").hidden ? null : $("#citelist").textContent },
  caret: Object.fromEntries(RFIELDS.map(k => [k, window.caretOf(k)])),
  marked: Object.fromEntries(RFIELDS.map(k => [k, caretFields.has(k)])),
  focused: document.activeElement ? document.activeElement.id : null,
  stoodDown: window.stoodDown,
});
</script></body></html>"""


def harness(state, request):
    return (HARNESS
            .replace("MODALCSS", MODAL_CSS)
            .replace("PANEHTML", PANE_HTML)
            .replace("CITEHTML", CITE_HTML)
            .replace("CITATIONJS", CITATION_JS)
            .replace("APIFN", API_FN)
            .replace("WRITEBLOCKFN", WRITE_BLOCK_FN)
            .replace("EDITORBLOCKFN", EDITOR_BLOCK_FN)
            .replace("TEMPLATEGATEFN", TEMPLATE_GATE_FN)
            .replace("BASEBLOCK", BASE_BLOCK)
            .replace("REPORTBLOCK", REPORT_BLOCK)
            .replace("TEMPLATEFN", TEMPLATE_FN)
            .replace("INITIALSTATE", json.dumps(state))
            .replace("REQUESTVALUE", json.dumps(request))
            .replace("UIDVALUE", UID)
            .replace("OTHERVALUE", OTHER))


REQUEST = {"uid": UID, "findingId": "f1", "findingRevision": 2, "sourceIndex": 0,
           "sourceLabel": "Series 3 · Image 12", "linkState": "current", "headRevision": 2, "block": BLOCK}
ACCEPTED = {"status": 200, "body": {"inserted": {"cid": "c1", "field": "findings",
                                                 "insertedAt": "2026-09-21T02:00:00.000Z"}}}


class ReportCursorInsertDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._pw = sync_playwright().start()
        cls.browser = cls._pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls._pw.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.errors = []
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))

    def tearDown(self):
        # A harness that never started reports whatever it touched first; say so loudly instead.
        # The probe must be something assigned at the END of the script: function declarations hoist,
        # so a `typeof loadReport` probe stays true even when the script died half way through.
        started = self.page.evaluate("()=>typeof window.snapshot === 'function'")
        self.page.close()
        self.assertTrue(started, "HARNESS DID NOT START: %s" % self.errors[:2])
        self.assertEqual([], self.errors, "the product region raised in the browser")

    # ── helpers ────────────────────────────────────────────────────────────────────────────
    def open(self, fields=(EXISTING, "", ""), citations=None, draft=None, request=None):
        state = {UID: {"version": 1, "rs": "T", "draft": draft}, OTHER: {"version": 0, "rs": "T"}}
        self.page.set_content(harness(state, request or REQUEST))
        if citations is not None:
            self.page.evaluate("citeReply(%s)" % json.dumps(citations))
        self.page.evaluate("()=>{ RFIELDS.forEach((k,i)=>{ $('#'+k).value = %s[i]; }); load({force:true}); }"
                           % json.dumps(list(fields)))
        if citations is not None:
            self.page.wait_for_function("()=>citeCalls.length>=1")
        # load() re-assigned the fields from appState, so put the intended text back afterwards.
        self.page.evaluate("()=>{ RFIELDS.forEach((k,i)=>{ $('#'+k).value = %s[i]; }); }" % json.dumps(list(fields)))

    def caret(self, field, start, end=None):
        """A real caret: the field takes focus (which is what marks it), then the range is set."""
        self.page.focus("#" + field)
        self.page.evaluate("put(%s, %d, %d)" % (json.dumps(field), start, start if end is None else end))
        self.page.evaluate("()=>$('#raiser').focus()")

    def open_pane(self):
        self.page.evaluate("cite()")
        self.page.wait_for_function("()=>$('#cite-preview').classList.contains('show')")

    def press(self):
        self.page.evaluate("()=>$('#cite-preview-insert').click()")

    def snap(self):
        return self.page.evaluate("snapshot()")

    def last_put(self):
        calls = self.page.evaluate("snapshot().calls")
        puts = [c for c in calls if c["method"] == "PUT"]
        return puts[-1] if puts else None

    # ── D1 ─────────────────────────────────────────────────────────────────────────────────
    def test_d01_caret_in_the_middle_of_the_field_places_whole_lines_and_the_caret(self):
        self.open(citations={"version": 1, "head": [], "draft": []})
        self.caret("findings", EXISTING.index("둘째") + 1)   # inside the second line, not at the end
        self.open_pane()
        self.page.evaluate("reply(%s)" % json.dumps(ACCEPTED))
        self.press()
        self.page.wait_for_function("()=>calls.some(c=>c.method==='PUT')")
        expected = "첫 줄\n둘째 줄\n" + BLOCK + "\n셋째 줄"
        value = self.snap()
        self.assertEqual(expected, value["text"][0],
                         "S3-U6 M1: the block must occupy whole lines after the caret's own line")
        self.assertEqual(expected, self.last_put()["body"]["findings"],
                         "S3-U6 M1: the body must carry the same whole-line placement")
        self.assertEqual(1, self.page.evaluate("()=>KinReportCitation.lineBlockOccurrences(text()[0], %s)"
                                               % json.dumps(BLOCK)),
                         "S3-U6 M1: the sentence must be findable by the server's line-block rule")
        start = expected.index(BLOCK)
        self.assertEqual([start + len(BLOCK), start + len(BLOCK)], value["caret"]["findings"],
                         "S3-U6 M6: the caret must end on the inserted block, not at the end of the field")
        self.assertEqual(1, value["stoodDown"], "the accepted insertion stood the raising list down, once")
        self.assertEqual("findings", value["focused"], "focus follows the text into the field")

    # ── D2 ─────────────────────────────────────────────────────────────────────────────────
    def test_d02_an_untouched_field_appends_exactly_as_before(self):
        # The field ends in a newline on purpose: a script-assigned value leaves the browser caret at
        # the end, so a field WITHOUT a final newline would make "read the caret anyway" produce the
        # legacy bytes by accident and hide the defect this case exists for.
        ending = EXISTING + "\n"
        self.open(fields=(ending, "", ""), citations={"version": 1, "head": [], "draft": []})
        self.open_pane()
        place = self.snap()["pane"]["place"]
        self.page.evaluate("reply(%s)" % json.dumps(ACCEPTED))
        self.press()
        self.page.wait_for_function("()=>calls.some(c=>c.method==='PUT')")
        expected = ending + "\n" + BLOCK          # appendBlock: one LF separator, nothing else
        self.assertEqual(expected, self.snap()["text"][0],
                         "S3-U6 M2: a field nobody put a caret in still appends at the end")
        self.assertEqual(expected, self.last_put()["body"]["findings"])
        self.assertEqual("삽입 위치: Findings 칸 맨 끝 — 이 칸에서 확인된 커서 자리가 없어 끝에 붙입니다", place,
                         "and the pane says so in the sentence the contract pinned")

    # ── D3 ─────────────────────────────────────────────────────────────────────────────────
    def test_d03_the_caret_at_the_very_start_puts_the_block_first(self):
        self.open(citations={"version": 1, "head": [], "draft": []})
        self.caret("findings", 0)
        self.open_pane()
        self.assertIn("1번째 줄(줄바꿈 기준)부터", self.snap()["pane"]["place"])
        self.page.evaluate("reply(%s)" % json.dumps(ACCEPTED))
        self.press()
        self.page.wait_for_function("()=>calls.some(c=>c.method==='PUT')")
        self.assertEqual(BLOCK + "\n" + EXISTING, self.snap()["text"][0])

    # ── D4 ─────────────────────────────────────────────────────────────────────────────────
    def test_d04_a_field_ending_in_a_newline_gets_no_blank_line(self):
        ending = EXISTING + "\n"
        self.open(fields=(ending, "", ""), citations={"version": 1, "head": [], "draft": []})
        self.caret("findings", len(ending))
        self.open_pane()
        self.page.evaluate("reply(%s)" % json.dumps(ACCEPTED))
        self.press()
        self.page.wait_for_function("()=>calls.some(c=>c.method==='PUT')")
        self.assertEqual(EXISTING + "\n" + BLOCK + "\n", self.snap()["text"][0],
                         "an expressed caret at the end adds no blank line and keeps the trailing newline")
        self.assertNotIn("\n\n", self.snap()["text"][0])

    # ── D5 ─────────────────────────────────────────────────────────────────────────────────
    def test_d05_a_selection_is_never_replaced(self):
        self.open(citations={"version": 1, "head": [], "draft": []})
        start = EXISTING.index("둘째")
        self.caret("findings", start, start + 2)
        self.open_pane()
        self.assertIn("선택한 글은 지우지 않고", self.snap()["pane"]["place"])
        self.page.evaluate("reply(%s)" % json.dumps(ACCEPTED))
        self.press()
        self.page.wait_for_function("()=>calls.some(c=>c.method==='PUT')")
        value = self.snap()["text"][0]
        self.assertIn("둘째 줄", value, "not one selected character may be consumed")
        self.assertEqual("첫 줄\n둘째 줄\n" + BLOCK + "\n셋째 줄", value)

    # ── D6 ─────────────────────────────────────────────────────────────────────────────────
    def test_d06_changing_the_destination_moves_the_position_and_leaves_the_other_field_alone(self):
        self.open(fields=(EXISTING, "결론 첫 줄\n결론 둘째 줄", ""),
                  citations={"version": 1, "head": [], "draft": []})
        self.caret("findings", 0)
        self.caret("conclusion", len("결론 첫 줄"))
        self.open_pane()
        before_findings = self.snap()["text"][0]
        before_caret = self.snap()["caret"]["findings"]
        self.page.evaluate("()=>{ $('#cite-preview-field').value='conclusion';"
                           " $('#cite-preview-field').dispatchEvent(new Event('change')); }")
        self.assertIn("Conclusion 칸 2번째 줄(줄바꿈 기준)부터", self.snap()["pane"]["place"])
        self.page.evaluate("reply(%s)" % json.dumps(ACCEPTED))
        self.press()
        self.page.wait_for_function("()=>calls.some(c=>c.method==='PUT')")
        value = self.snap()
        self.assertEqual("결론 첫 줄\n" + BLOCK + "\n결론 둘째 줄", value["text"][1])
        self.assertEqual(before_findings, value["text"][0], "the field that was not chosen keeps every byte")
        self.assertEqual(before_caret, value["caret"]["findings"], "and its caret does not move either")

    # ── D7 ─────────────────────────────────────────────────────────────────────────────────
    def test_d07_a_change_before_the_first_press_sends_nothing_and_asks_again(self):
        self.open(citations={"version": 1, "head": [], "draft": []})
        self.caret("findings", 0)
        self.open_pane()
        shown = self.snap()["pane"]["place"]
        # The change happens BEFORE the first press: a plan refreshed on the press would absorb it.
        self.page.evaluate("assign('findings', %s)" % json.dumps("새로 들어온 초안\n둘째 줄"))
        self.page.evaluate("reply(%s)" % json.dumps(ACCEPTED))
        self.press()
        self.assertEqual([], [c for c in self.snap()["calls"] if c["method"] == "PUT"],
                         "S3-U6 M3: a position the person did not read may not be sent")
        self.assertIn("판독문이나 삽입 위치가 그 사이 바뀌었습니다", self.snap()["pane"]["status"])
        self.assertEqual("새로 들어온 초안\n둘째 줄", self.snap()["text"][0], "and nothing moved on screen")
        # Read the new position while the pane is still open: after the second press it is closed.
        offered = self.snap()["pane"]["place"]
        self.assertNotEqual(shown, offered, "the pane showed the new position before it was used")
        line = int(re.search(r"칸 (\d+)번째 줄", offered).group(1))
        # The second press carries exactly the position that was on display.
        self.press()
        self.page.wait_for_function("()=>calls.some(c=>c.method==='PUT')")
        body = self.last_put()["body"]["findings"]
        self.assertIn("새로 들어온 초안\n둘째 줄", body, "the draft that arrived is still whole")
        self.assertEqual(1, self.page.evaluate("()=>KinReportCitation.lineBlockOccurrences(text()[0], %s)"
                                               % json.dumps(BLOCK)))
        self.assertEqual(line, body[:body.index(BLOCK)].count("\n") + 1,
                         "the line the pane named is the line the block went to")

    # ── D8 ─────────────────────────────────────────────────────────────────────────────────
    def test_d08_a_refused_insertion_changes_no_byte_and_no_caret(self):
        self.open(citations={"version": 1, "head": [], "draft": []})
        self.caret("findings", EXISTING.index("둘째"))
        self.open_pane()
        before = self.snap()
        self.page.evaluate("reply(%s)" % json.dumps(
            {"status": 409, "body": {"code": "REPORT_CITATION_STALE", "message": "소견이 그 사이 바뀌었습니다"}}))
        self.press()
        self.page.wait_for_function("()=>calls.some(c=>c.method==='PUT')")
        after = self.snap()
        self.assertEqual(before["text"], after["text"], "a refusal changes no byte of the report")
        self.assertEqual(before["caret"]["findings"], after["caret"]["findings"], "nor the caret")
        self.assertTrue(after["marked"]["findings"], "nor the fact that the person put a caret there")

    # ── D9 ─────────────────────────────────────────────────────────────────────────────────
    def test_d09_a_late_answer_after_a_selection_change_writes_nothing(self):
        self.open(citations={"version": 1, "head": [], "draft": []})
        self.caret("findings", 0)
        self.open_pane()
        self.page.evaluate("hold()")
        self.page.evaluate("reply(%s)" % json.dumps(ACCEPTED))
        self.press()
        self.page.wait_for_function("()=>outstanding()===1")
        before = self.snap()
        # The product's own selection counter - the same one the late-answer guard reads.
        self.page.evaluate("moveSelection(%s)" % json.dumps(OTHER))
        self.page.evaluate("release()")
        self.page.wait_for_function("()=>!$('#cite-preview').classList.contains('show')")
        after = self.snap()
        self.assertEqual(before["text"], after["text"], "an answer that outlived its selection writes nothing")
        self.assertFalse(after["marked"]["findings"], "and the study move dropped the remembered caret")

    # ── D10 ────────────────────────────────────────────────────────────────────────────────
    def test_d10_an_anchor_inside_an_existing_citation_moves_past_it(self):
        # Deliberately NOT the block this case inserts: if the two were the same text, the count
        # below would be 2 after a correct insertion and the assertion would say nothing.
        cited = "먼저 넣은 제목\n먼저 넣은 본문"
        field = cited + "\n사람이 쓴 줄"
        entry = {"v": 2, "cid": "c0", "field": "findings", "findingId": "f0", "findingRevision": 1,
                 "sourceIndex": 0, "linkStateAtInsert": "current", "headRevisionAtInsert": 1,
                 "insertedText": cited, "insertedAt": "2026-09-21T01:00:00.000Z", "insertedBy": "doctor@kin",
                 "sameTextCount": 1}
        self.open(fields=(field, "", ""), citations={"version": 1, "head": [], "draft": [entry]})
        self.caret("findings", len("먼저 넣은 제목") + 1)   # between the two lines of the existing citation
        self.open_pane()
        # Read the disclosure now and judge it AFTER M5's own assertion: an unlabelled check here
        # would fail first under M5 and the runner would (correctly) refuse to count the kill.
        place = self.snap()["pane"]["place"]
        self.page.evaluate("reply(%s)" % json.dumps(ACCEPTED))
        self.press()
        self.page.wait_for_function("()=>calls.some(c=>c.method==='PUT')")
        value = self.snap()["text"][0]
        self.assertEqual(cited + "\n" + BLOCK + "\n사람이 쓴 줄", value,
                         "S3-U6 M5: the new sentence must land past the citation, never inside it")
        self.assertIn("이미 인용된 문장을 쪼개지 않도록", place, "and the pane said why it moved")
        self.assertEqual(1, self.page.evaluate("()=>KinReportCitation.lineBlockOccurrences(text()[0], %s)"
                                               % json.dumps(cited)),
                         "S3-U6 M5: the citation that was already there must still be present")

    # ── D11 ────────────────────────────────────────────────────────────────────────────────
    def test_d11_the_body_the_screen_and_the_attestation_are_one_string(self):
        self.open(citations={"version": 1, "head": [], "draft": []})
        self.caret("findings", EXISTING.index("둘째") + 1)
        self.open_pane()
        previewed = self.snap()["pane"]["block"]
        self.page.evaluate("reply(%s)" % json.dumps(ACCEPTED))
        self.press()
        self.page.wait_for_function("()=>calls.some(c=>c.method==='PUT')")
        put = self.last_put()
        self.assertEqual(put["body"]["findings"], self.snap()["text"][0],
                         "S3-U6 M4: the string that was sent is the string on the screen")
        self.assertEqual(previewed, put["body"]["insert"]["insertedText"],
                         "S3-U6 M4: and the attestation points at exactly the previewed bytes")
        self.assertEqual(BLOCK, previewed)
        self.assertEqual(put["body"]["findings"], self.page.evaluate("()=>appState[%s].draft.findings" % json.dumps(UID)),
                         "the draft the screen remembers is the row the server was told about")

    # ── D12 ────────────────────────────────────────────────────────────────────────────────
    def test_d12_selection_retention_across_blur_and_identical_reassignment(self):
        self.open(draft={"findings": EXISTING, "conclusion": "", "recommendation": "", "baseVersion": 1})
        self.caret("findings", 3)
        # (a) the browser keeps a textarea's selection after it loses focus
        self.assertEqual([3, 3], self.snap()["caret"]["findings"])
        self.assertNotEqual("findings", self.snap()["focused"])
        # (b) the real non-force loadReport with the SAME text moves neither caret nor marker
        self.page.evaluate("load()")
        self.assertEqual([3, 3], self.snap()["caret"]["findings"], "an identical assignment must not move the caret")
        self.assertTrue(self.snap()["marked"]["findings"], "and must not forget the position either")
        # (c) a real change does forget it, and the next insertion is the legacy append. The forced
        # load is the path that actually replaces a value: a non-force one finds the screen dirty
        # against the changed source and preserves what is on it, so it can never assign a different
        # string - which is why (b) above is the real non-force case and this one is not.
        self.page.evaluate("()=>{ appState[%s].draft.findings = '서버가 보낸 다른 초안'; load({force:true}); }"
                           % json.dumps(UID))
        self.assertFalse(self.snap()["marked"]["findings"], "a changed value drops the remembered position")
        self.page.evaluate("citeReply(%s)" % json.dumps({"version": 1, "head": [], "draft": []}))
        self.open_pane()
        self.assertIn("맨 끝", self.snap()["pane"]["place"])
        self.page.evaluate("reply(%s)" % json.dumps(ACCEPTED))
        self.press()
        self.page.wait_for_function("()=>calls.some(c=>c.method==='PUT')")
        self.assertEqual("서버가 보낸 다른 초안\n" + BLOCK, self.snap()["text"][0])

    # ── D13 ────────────────────────────────────────────────────────────────────────────────
    def test_d13_a_template_goes_into_each_field_at_its_own_caret(self):
        self.open(fields=(EXISTING, "결론 첫 줄\n결론 둘째 줄", "권고 한 줄"))
        self.caret("findings", 0)
        self.caret("conclusion", len("결론 첫 줄"))
        template = {"findings": "상용구 소견", "conclusion": "상용구 결론\r\n둘째", "recommendation": ""}
        self.page.evaluate("insertTpl(%s)" % json.dumps(template))
        value = self.snap()
        self.assertEqual("상용구 소견\n" + EXISTING, value["text"][0], "each field uses its own caret")
        self.assertEqual("결론 첫 줄\n상용구 결론\n둘째\n결론 둘째 줄", value["text"][1],
                         "a stored CRLF template is normalised before it is placed")
        self.assertEqual("권고 한 줄", value["text"][2], "a field the template does not fill is untouched")
        caret = value["caret"]["conclusion"]
        self.assertEqual(len("결론 첫 줄\n상용구 결론\n둘째"), caret[0], "the caret ends on the inserted block")

    # ── D14 ────────────────────────────────────────────────────────────────────────────────
    def test_d14_a_programmatic_change_during_the_insertion_loses_nothing(self):
        self.open(citations={"version": 1, "head": [], "draft": []})
        self.caret("findings", 0)
        self.open_pane()
        self.page.evaluate("hold()")
        self.page.evaluate("reply(%s)" % json.dumps(ACCEPTED))
        self.press()
        self.page.wait_for_function("()=>outstanding()===1")
        # Not reachable through the shipped flows (the modal is covering, insertInFlight defers the
        # writes and preservedLocal keeps the draft), which is exactly why it is tested here.
        self.page.evaluate("assign('findings', %s)" % json.dumps("그 사이 들어온 글"))
        self.page.evaluate("release()")
        self.page.wait_for_function("()=>!$('#cite-preview').classList.contains('show')")
        value = self.snap()["text"][0]
        self.assertIn("그 사이 들어온 글", value, "the text that arrived meanwhile is not overwritten")
        self.assertEqual(1, self.page.evaluate("()=>KinReportCitation.lineBlockOccurrences(text()[0], %s)"
                                               % json.dumps(BLOCK)),
                         "and the recorded sentence is still a whole-line block on the screen")


if __name__ == "__main__":
    unittest.main(verbosity=2)
