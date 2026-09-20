# coding: utf-8
"""TEST-S3-U3-REBASE-DOM: the real main.html report-commit path against a stubbed fetch.

Pure Playwright: the shipped api(), loadReport(), stashReport(), commitReport() and
the stale-rebase pane run on a blank page with a synthetic fetch, so there is no
LiveStack, no Orthanc, no database and no original DICOM. Only the refusal body
the test hands back can become the approved report shown to the user.
"""
import json
import os
import unittest
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MAIN = Path(os.environ.get("KIN_REBASE_MAIN", ROOT / "worklist-v0" / "hpacs-lite" / "main.html")).read_text(encoding="utf-8")
# S3-U2b put the citation state, the dedicated read and the insertion pane inside the same
# contiguous product region this harness slices, so the real module has to be here too. The
# citation behaviour itself is asserted in report_citation_dom_test.py.
CITATION_JS = (ROOT / "worklist-v0" / "hpacs-lite" / "report-citation.js").read_text(encoding="utf-8")

UID = "1.2.3"
OTHER = "1.2.4"
HEAD_FINDINGS = "SERVER HEAD\r\n  approved line  \nSECOND\n"
CACHED_FINDINGS = "CACHED HEAD — must never be shown as the approved report"


def slice_between(source, start_marker, end_marker):
    start = source.index(start_marker)
    end = source.index(end_marker, start + len(start_marker))
    return source[start:end]


def extract_function(source, name):
    """The shipped function, brace matched past a destructured parameter list."""
    start = source.index("function %s(" % name)
    # Keep the modifier. Slicing from "function api(" dropped the `async` in front
    # of it, so the generated script held `await` inside a plain function: the whole
    # harness failed to compile and every case died before its first assertion.
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


# The real modal markup and the real modal styling: the pane must be visible by
# the rules the product ships, not by a rule this test invents.
PANE_HTML = slice_between(MAIN, '<div class="modal" id="stalemodal"', "\n  </div>") + "\n  </div>"
CITE_HTML = slice_between(MAIN, '<div class="modal" id="cite-preview"', "\n  </div>") + "\n  </div>"
MODAL_CSS = slice_between(MAIN, ".modal { display: none;", "/* ══ 클릭 피드백")
BASE_BLOCK = slice_between(MAIN, "    let selectionSeq = 0;", "    function reportSource()")
# One contiguous region: report source, loadReport, the draft bar, the rebase pane,
# stashReport and commitReport, exactly as they sit in the file.
REPORT_BLOCK = slice_between(MAIN, "    function reportSource() {", "    function heldByOther(s)")
API_FN = extract_function(MAIN, "api")
WRITE_BLOCK_FN = extract_function(MAIN, "reportWriteBlock")
# S3-U2b moved the shared "may a script write into the editor" check into one function that the
# sliced region now calls; without it the harness defines nothing.
EDITOR_BLOCK_FN = extract_function(MAIN, "reportEditorBlock")

HARNESS = """<!doctype html><html><head><style>MODALCSS</style></head><body>
<div class="draftbar" id="draftbar" style="display:none"><span id="draftmsg"></span>
<button id="b-report-reload"></button><button id="b-draft-discard"></button></div>
<textarea id="findings"></textarea><textarea id="conclusion"></textarea><textarea id="recommendation"></textarea>
<button id="b-approve"></button><button id="b-save"></button><button id="b-transcribe"></button>
<button id="b-addendum"></button><button id="b-unread"></button><button id="b-prelim"></button><button id="b-defer"></button>
<div class="draftbar" id="citebar" style="display:none"><span id="citemsg"></span>
<button id="b-cite-list"></button><button id="b-cite-reload"></button></div>
<div id="citelist" hidden></div>
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
let serverMode = true, offline = false, demoMode = false, warnedFor = null;
let selectedUid = "UIDVALUE", heldUid = null, heartbeat = null, user = "doctor@kin";
let appState = INITIALSTATE, studies = [{uid: "UIDVALUE"}, {uid: "OTHERVALUE"}];
let calls = [], replies = [], toasts = [], confirms = [], confirmAnswer = false, clipboard = [];
const studyPriority = { get: () => false };
const KinAuth = { has: () => true, logout: async () => {} };
const reportPreview = { close() {} };
const displayActor = value => String(value ?? "").split("@")[0];
function cur() { return studies.find(s => s.uid === selectedUid); }
function shownStudyDesc(s) { return s?.desc ?? ""; }
function heldByOther(s) { return s?.holder && s.holder !== user ? s.holder : null; }
function today() { return "2026-09-20"; }
function saveApp() {}
function syncStudy() {}
function render() {}
function renderRelated() {}
function updateReportButtons() {}
function updateReportTemplateButton() {}
window.confirm = message => { confirms.push(message); return confirmAnswer; };
// A plain assignment is a silent no-op wherever Navigator.prototype owns the
// read-only clipboard getter, and the surviving-draft case asserts what was copied.
Object.defineProperty(navigator, "clipboard", {
  configurable: true, value: { writeText: value => { clipboard.push(value); } },
});
let holdNext = false, releaseHeld = null;
window.fetch = async (url, options = {}) => {
  const path = String(url).slice(API.length);
  // The citation read is a different surface with its own DOM test. Answer it inertly and keep it
  // out of `calls` so these rebase cases still count exactly the writes they are about.
  if (path.endsWith("/report/citations"))
    return { ok: true, status: 200, json: async () => ({ version: 0, head: [], draft: [] }) };
  calls.push({ method: options.method ?? "GET", path, body: options.body ? JSON.parse(options.body) : null });
  const reply = replies.shift() ?? { status: 200, body: {} };
  const answer = () => ({ ok: reply.status < 400, status: reply.status, json: async () => reply.body });
  // A held reply lets a test move the selection while the request is still in flight.
  if (holdNext) { holdNext = false; return new Promise(resolve => { releaseHeld = () => resolve(answer()); }); }
  return answer();
};
function toast(message, kind) { toasts.push({ message, kind }); }
function apiFail(e) { toast("서버 저장 실패: " + e.message, "err"); }
APIFN
WRITEBLOCKFN
EDITORBLOCKFN
BASEBLOCK
REPORTBLOCK
window.load = options => loadReport(options);
window.stash = () => stashReport();
window.commit = (action, reason) => { window.pending = commitReport(action, reason); return window.pending; };
window.openPane = (uid, seq, error) => openStaleRebase(uid, seq, error);
window.reply = value => { replies.push(value); };
window.hold = () => { holdNext = true; };
window.release = () => { const resolve = releaseHeld; releaseHeld = null; resolve(); };
window.text = () => RFIELDS.map(k => $("#" + k).value);
window.type = values => { RFIELDS.forEach((k, i) => { $("#" + k).value = values[i]; }); };
// The real counter: select() does exactly this before it redraws the right pane.
window.select = uid => { markSelectionChanged(uid); };
window.snapshot = () => ({
  calls: structuredClone(calls), toasts: structuredClone(toasts), confirms: structuredClone(confirms),
  clipboard: structuredClone(clipboard), text: window.text(), state: structuredClone(appState[selectedUid] ?? null),
  stored: structuredClone(appState), base: reportBaseVersion(selectedUid, -1), seq: selectionSeq,
  shown: $("#stalemodal").classList.contains("show"),
  pane: { head: RFIELDS.map(k => $("#stale-head-" + k).textContent), draft: RFIELDS.map(k => $("#stale-draft-" + k).textContent),
          title: $("#stale-head-title").textContent, message: $("#stale-msg").textContent,
          status: $("#stale-status").textContent, action: $("#stale-rebase").textContent,
          disabled: $("#stale-rebase").disabled },
});
</script></body></html>"""


def harness(state):
    return (HARNESS
            .replace("MODALCSS", MODAL_CSS)
            .replace("PANEHTML", PANE_HTML)
            .replace("CITEHTML", CITE_HTML)
            .replace("CITATIONJS", CITATION_JS)
            .replace("APIFN", API_FN)
            .replace("WRITEBLOCKFN", WRITE_BLOCK_FN)
            .replace("EDITORBLOCKFN", EDITOR_BLOCK_FN)
            .replace("BASEBLOCK", BASE_BLOCK)
            .replace("REPORTBLOCK", REPORT_BLOCK)
            .replace("INITIALSTATE", json.dumps(state, ensure_ascii=False))
            .replace("UIDVALUE", UID)
            .replace("OTHERVALUE", OTHER))


def stale_body(version=4, base=2, findings=HEAD_FINDINGS, **overrides):
    head = {"version": version, "updatedBy": "doctor2@kin", "findings": findings,
            "conclusion": "", "recommendation": "HEAD R"}
    head.update(overrides.pop("head", {}))
    body = {"code": "REPORT_DRAFT_STALE", "draftBaseVersion": base,
            "message": "이 초안은 v%d을 기준으로 씁니다. 지금 승인본은 v%d입니다 — 승인본을 확인한 뒤 기준을 다시 잡아 주세요." % (base, version),
            "head": head}
    body.update(overrides)
    return {"status": 409, "body": body}


class ReportRebaseDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def tearDown(self):
        self.page.close()

    def open(self, **state):
        base = {UID: {"rs": "A", "ss": "Verified", "em": "N", "version": 2, "findings": CACHED_FINDINGS,
                      "conclusion": "", "recommendation": "", "draft": None},
                OTHER: {"rs": "T", "ss": "Verified", "em": "N", "version": 1, "findings": "", "conclusion": "",
                        "recommendation": "", "draft": None}}
        base[UID].update(state)
        self.page = self.browser.new_page()
        # A script that fails to compile defines nothing, and every later call then
        # reports a ReferenceError for whatever it happened to touch first. Collect
        # the page's own error and say so here, at the line that caused it.
        errors = []
        self.page.on("pageerror", lambda error: errors.append(str(error)))
        self.page.set_content(harness(base))
        self.assertEqual([], errors, "the generated harness did not start")
        self.assertEqual("function", self.page.evaluate("typeof loadReport"),
                         "the sliced product code did not define loadReport")
        # select() -> refreshRight({forceReport: true}): choosing a study is the one
        # call that is allowed to replace the editor, and it is how a reader arrives
        # here. A non-forced load would find the empty harness fields "dirty" and
        # preserve them, so nothing would be drawn and no origin recorded.
        self.page.evaluate("load({force: true})")
        return base

    def test_a_version_that_arrived_without_a_redraw_never_becomes_the_commit_base(self):
        self.open()
        self.assertEqual(2, self.page.evaluate("snapshot().base"))
        self.page.evaluate("type(['MY ADDENDUM', '', ''])")
        # A PATCH response merges a newer version into appState while the editor keeps
        # the text the user is typing; polling then calls loadReport again.
        self.page.evaluate("()=>{appState['%s'].version = 5; loadReport();}" % UID)
        self.assertEqual(2, self.page.evaluate("snapshot().base"), "a preserved render must not move the base")
        self.page.evaluate("reply({status: 200, body: {}})")
        self.page.evaluate("stash()")
        self.page.wait_for_function("()=>calls.length===1")
        put = self.page.evaluate("snapshot().calls")[0]
        self.assertEqual(("PUT", 2), (put["method"], put["body"]["baseVersion"]))
        self.page.evaluate("reply({status: 200, body: {rs: 'A', version: 6, findings: 'MY ADDENDUM'}})")
        self.page.evaluate("commit('addendum')")
        self.page.wait_for_function("()=>calls.length===2")
        post = self.page.evaluate("snapshot().calls")[1]
        self.assertEqual(("POST", 2), (post["method"], post["body"]["baseVersion"]))

    def test_reloading_the_report_moves_the_base_to_the_version_it_drew(self):
        self.open()
        # Reload Report is the one call that is allowed to replace the editor, so
        # afterwards the screen really is standing on v5. The base follows the text.
        self.page.evaluate("()=>{appState['%s'] = {...appState['%s'], version: 5, findings: 'NEW HEAD'};}" % (UID, UID))
        self.page.evaluate("load({force: true})")
        self.assertEqual(5, self.page.evaluate("snapshot().base"))
        self.assertEqual(["NEW HEAD", "", ""], self.page.evaluate("snapshot().text"))
        self.page.evaluate("reply({status: 200, body: {rs: 'A', version: 6}})")
        self.page.evaluate("commit('addendum')")
        self.page.wait_for_function("()=>calls.length===1")
        self.assertEqual(5, self.page.evaluate("snapshot().calls")[0]["body"]["baseVersion"])

    def test_a_stale_addendum_shows_the_refused_head_and_leaves_every_byte_alone(self):
        self.open(draft={"findings": "MY ADDENDUM", "conclusion": "", "recommendation": "", "baseVersion": 2, "at": "2026-09-20T01:00"})
        self.page.evaluate("type(['MY ADDENDUM+', '', ''])")
        self.page.evaluate("reply(%s)" % json.dumps(stale_body()))
        self.page.evaluate("commit('addendum')")
        self.page.wait_for_function("()=>$('#stalemodal').classList.contains('show')")
        expect(self.page.locator("#stalemodal")).to_be_visible()
        value = self.page.evaluate("snapshot()")
        self.assertEqual([HEAD_FINDINGS, "", "HEAD R"], value["pane"]["head"], "the pane must show the server's bytes")
        self.assertNotIn(CACHED_FINDINGS, json.dumps(value["pane"], ensure_ascii=False), "the cached body must never stand in")
        self.assertEqual(["MY ADDENDUM+", "", ""], value["pane"]["draft"])
        self.assertIn("v4", value["pane"]["title"])
        self.assertIn("doctor2", value["pane"]["title"])
        self.assertIn("v2", value["pane"]["message"])
        self.assertIn("v4", value["pane"]["action"])
        # Nothing was rewritten, reloaded or discarded.
        self.assertEqual(["MY ADDENDUM+", "", ""], value["text"])
        self.assertEqual(2, value["state"]["draft"]["baseVersion"])
        self.assertEqual("MY ADDENDUM", value["state"]["draft"]["findings"])
        self.assertEqual(1, len(value["calls"]))
        self.assertEqual([], value["confirms"])
        self.assertEqual([], value["clipboard"])
        for entry in value["toasts"]:
            self.assertNotIn("저장했습니다", entry["message"])

    def test_the_rebase_writes_the_typed_text_onto_exactly_the_version_it_showed(self):
        self.open(draft={"findings": "MY ADDENDUM", "conclusion": "", "recommendation": "", "baseVersion": 2, "at": "2026-09-20T01:00"})
        self.page.evaluate("type(['MY ADDENDUM+', 'C', ''])")
        self.page.evaluate("reply(%s)" % json.dumps(stale_body()))
        self.page.evaluate("commit('addendum')")
        self.page.wait_for_function("()=>$('#stalemodal').classList.contains('show')")
        self.page.evaluate("reply({status: 200, body: {uid: '%s', baseVersion: 4}})" % UID)
        self.page.click("#stale-rebase")
        self.page.wait_for_function("()=>calls.length===2")
        put = self.page.evaluate("snapshot().calls")[1]
        self.assertEqual("PUT", put["method"])
        self.assertEqual({"findings": "MY ADDENDUM+", "conclusion": "C", "recommendation": "", "baseVersion": 4}, put["body"])
        value = self.page.evaluate("snapshot()")
        self.assertFalse(value["shown"], "the pane closes once the human has chosen")
        self.assertEqual(["MY ADDENDUM+", "C", ""], value["text"], "the rebase must not redraw the editor")
        self.assertEqual(4, value["state"]["draft"]["baseVersion"])
        self.assertEqual(4, value["base"])
        # The next addendum stands on the version the human actually read.
        self.page.evaluate("reply({status: 200, body: {rs: 'A', version: 5}})")
        self.page.evaluate("commit('addendum')")
        self.page.wait_for_function("()=>calls.length===3")
        self.assertEqual(4, self.page.evaluate("snapshot().calls")[2]["body"]["baseVersion"])

    def test_a_second_refusal_supersedes_the_first_and_a_moved_selection_refuses_to_write(self):
        self.open(draft={"findings": "MY ADDENDUM", "conclusion": "", "recommendation": "", "baseVersion": 2, "at": "2026-09-20T01:00"})
        self.page.evaluate("type(['MY ADDENDUM', '', ''])")
        self.page.evaluate("reply(%s)" % json.dumps(stale_body()))
        self.page.evaluate("commit('addendum')")
        self.page.wait_for_function("()=>$('#stalemodal').classList.contains('show')")
        # The head moved again while the pane was open: the newer refusal wins and
        # the older version number must not be the one that gets written.
        self.page.evaluate("reply(%s)" % json.dumps(stale_body(version=6, base=2, findings="EVEN NEWER")))
        self.page.evaluate("commit('addendum')")
        self.page.wait_for_function("()=>$('#stale-head-title').textContent.includes('v6')")
        self.page.evaluate("reply({status: 200, body: {}})")
        self.page.click("#stale-rebase")
        self.page.wait_for_function("()=>calls.length===3")
        self.assertEqual(6, self.page.evaluate("snapshot().calls")[2]["body"]["baseVersion"])

        # A pane that belongs to another study writes nothing at all.
        self.page.evaluate("reply(%s)" % json.dumps(stale_body()))
        self.page.evaluate("commit('addendum')")
        self.page.wait_for_function("()=>$('#stalemodal').classList.contains('show')")
        before = len(self.page.evaluate("snapshot().calls"))
        self.page.evaluate("select('%s')" % OTHER)
        self.page.click("#stale-rebase")
        value = self.page.evaluate("snapshot()")
        self.assertEqual(before, len(value["calls"]), "a moved selection must not write the other study's text")
        self.assertIn("검사가 바뀌었습니다", value["pane"]["status"])
        self.assertTrue(value["pane"]["disabled"])

    def test_a_refusal_that_lands_after_the_selection_moved_draws_nothing(self):
        self.open(draft={"findings": "MY ADDENDUM", "conclusion": "", "recommendation": "", "baseVersion": 2, "at": "2026-09-20T01:00"})
        self.page.evaluate("type(['MY ADDENDUM+', '', ''])")
        self.page.evaluate("hold()")
        self.page.evaluate("reply(%s)" % json.dumps(stale_body()))
        # Start the commit without awaiting it: the reply is held in flight.
        self.page.evaluate("()=>{commit('addendum');}")
        self.page.wait_for_function("()=>typeof releaseHeld==='function'")
        # The reader moves to another study; the editor now holds that study's report.
        self.page.evaluate("()=>{select('%s'); type(['OTHER PATIENT TEXT', '', '']);}" % OTHER)
        self.page.evaluate("release()")
        self.page.evaluate("()=>window.pending")
        value = self.page.evaluate("snapshot()")
        self.assertFalse(value["shown"], "two studies must never be shown as one comparison")
        self.assertEqual(["", "", ""], value["pane"]["head"], "nothing may be drawn into the pane at all")
        self.assertEqual(["", "", ""], value["pane"]["draft"])
        self.assertEqual(["OTHER PATIENT TEXT", "", ""], value["text"], "the other study's editor is untouched")
        self.assertEqual(1, len(value["calls"]))
        message = value["toasts"][-1]["message"]
        self.assertIn("다른 검사로 옮기기 전에", message)
        self.assertNotIn(HEAD_FINDINGS.strip(), message)
        self.assertNotIn("저장했습니다", message)
        # The refused study keeps its draft bytes and its base.
        self.assertEqual(2, value["stored"][UID]["draft"]["baseVersion"])
        self.assertEqual("MY ADDENDUM", value["stored"][UID]["draft"]["findings"])

    def test_a_refusal_that_returns_after_a_round_trip_is_still_not_the_same_selection(self):
        # A -> B -> A. The uid matches again, so a uid-only guard would draw the pane,
        # but the screen was redrawn twice and the editor no longer holds what the
        # request left with. Only the selection sequence can see that.
        self.open(draft={"findings": "MY ADDENDUM", "conclusion": "", "recommendation": "", "baseVersion": 2, "at": "2026-09-20T01:00"})
        self.page.evaluate("type(['MY ADDENDUM+', '', ''])")
        started = self.page.evaluate("snapshot().seq")
        self.page.evaluate("hold()")
        self.page.evaluate("reply(%s)" % json.dumps(stale_body()))
        self.page.evaluate("()=>{commit('addendum');}")
        self.page.wait_for_function("()=>typeof releaseHeld==='function'")
        self.page.evaluate("()=>{select('%s'); select('%s'); load({force: true});}" % (OTHER, UID))
        self.assertEqual(UID, self.page.evaluate("selectedUid"), "the reader is back on the same study")
        self.assertEqual(started + 2, self.page.evaluate("snapshot().seq"))
        self.page.evaluate("release()")
        self.page.evaluate("()=>window.pending")
        value = self.page.evaluate("snapshot()")
        self.assertFalse(value["shown"], "a returning selection is a new selection")
        self.assertEqual(["", "", ""], value["pane"]["head"], "nothing may be drawn into the pane at all")
        self.assertEqual(["", "", ""], value["pane"]["draft"])
        self.assertEqual(1, len(value["calls"]))
        self.assertIn("다른 검사로 옮기기 전에", value["toasts"][-1]["message"])
        # Coming back redrew the stored draft, and nothing the server holds changed.
        self.assertEqual(["MY ADDENDUM", "", ""], value["text"])
        self.assertEqual(2, value["stored"][UID]["draft"]["baseVersion"])
        self.assertEqual("MY ADDENDUM", value["stored"][UID]["draft"]["findings"])

    def test_a_surviving_draft_is_never_reported_as_the_loaded_server_report(self):
        for rs, exit_words in [("T", "Discard Draft를 누르면"), ("A", "Addendum을 눌러")]:
            with self.subTest(rs=rs):
                self.open(rs=rs, version=1, findings="SERVER V1",
                          draft={"findings": "MY DRAFT", "conclusion": "", "recommendation": "", "baseVersion": 1, "at": "2026-09-20T01:00"})
                self.assertEqual(["MY DRAFT", "", ""], self.page.evaluate("snapshot().text"))
                self.page.evaluate("()=>{confirmAnswer = true;}")
                self.page.evaluate("reply({status: 409, body: {message: '그 사이 doctor2가 v2를 저장했습니다. 내용을 다시 불러온 뒤 작성해 주세요.'}})")
                # The bootstrap answer carries the newer head and the reader's own draft row.
                self.page.evaluate("reply(%s)" % json.dumps({"status": 200, "body": {"states": {UID: {
                    "rs": rs, "version": 2, "findings": "SERVER V2", "conclusion": "", "recommendation": "",
                    "draft": {"findings": "MY DRAFT", "conclusion": "", "recommendation": "", "baseVersion": 1, "at": "2026-09-20T01:00"}}}}}))
                self.page.evaluate("commit('%s')" % ("save" if rs == "T" else "addendum"))
                value = self.page.evaluate("snapshot()")
                self.assertEqual(2, len(value["calls"]), "the bootstrap reload still happens")
                self.assertEqual(["MY DRAFT"], value["clipboard"], "the typed text is still copied out")
                # loadReport({force:true}) redraws reportSource(), which prefers the draft.
                self.assertEqual(["MY DRAFT", "", ""], value["text"], "the screen still shows the draft")
                self.assertEqual(2, value["state"]["version"], "the newer head was merged into the state")
                message = value["toasts"][-1]["message"]
                self.assertNotIn("서버 판독문을 불러왔습니다", message, "the screen does not show the server report")
                self.assertIn("화면에 보이는 것은 초안입니다", message)
                self.assertIn(exit_words, message)
                self.assertNotIn("저장했습니다", message)
                # Known limitation, asserted so it cannot change silently: the base returns
                # to the draft's version, so pressing the same button again repeats the 409.
                self.assertEqual(1, value["base"])
                self.page.close()

    def test_a_discarded_draft_still_reports_the_server_report_honestly(self):
        self.open(rs="T", version=1, findings="SERVER V1",
                  draft={"findings": "MY DRAFT", "conclusion": "", "recommendation": "", "baseVersion": 1, "at": "2026-09-20T01:00"})
        self.page.evaluate("()=>{confirmAnswer = true;}")
        self.page.evaluate("reply({status: 409, body: {message: '그 사이 doctor2가 v2를 저장했습니다. 내용을 다시 불러온 뒤 작성해 주세요.'}})")
        # This time the server no longer holds a draft for this reader.
        self.page.evaluate("reply(%s)" % json.dumps({"status": 200, "body": {"states": {UID: {
            "rs": "T", "version": 2, "findings": "SERVER V2", "conclusion": "", "recommendation": "", "draft": None}}}}))
        self.page.evaluate("commit('save')")
        value = self.page.evaluate("snapshot()")
        self.assertEqual(["SERVER V2", "", ""], value["text"])
        self.assertIn("서버 판독문을 불러왔습니다", value["toasts"][-1]["message"])
        self.assertEqual(2, value["base"], "the screen now stands on the version it drew")

    def test_the_old_optimistic_lock_branch_keeps_its_own_route(self):
        self.open(draft={"findings": "MY ADDENDUM", "conclusion": "", "recommendation": "", "baseVersion": 2, "at": "2026-09-20T01:00"})
        self.page.evaluate("type(['MY ADDENDUM', '', ''])")
        self.page.evaluate("reply({status: 409, body: {message: '그 사이 doctor2가 v4를 저장했습니다. 내용을 다시 불러온 뒤 작성해 주세요.'}})")
        self.page.evaluate("commit('addendum')")
        self.page.wait_for_function("()=>confirms.length===1")
        value = self.page.evaluate("snapshot()")
        self.assertFalse(value["shown"], "an uncoded conflict is not an approved-report pane")
        self.assertEqual(["MY ADDENDUM", "", ""], value["text"])
        self.assertEqual(1, len(value["calls"]), "the refused reload must not fetch the bootstrap")

    def test_a_refusal_without_a_usable_head_never_becomes_an_approved_report(self):
        for body in [stale_body(head={"version": 0}), stale_body(head={"version": "4"}),
                     {"status": 409, "body": {"code": "REPORT_DRAFT_STALE", "message": "낡은 초안입니다"}}]:
            with self.subTest(body=body):
                self.open(draft={"findings": "MY ADDENDUM", "conclusion": "", "recommendation": "", "baseVersion": 2, "at": "2026-09-20T01:00"})
                self.page.evaluate("type(['MY ADDENDUM', '', ''])")
                self.page.evaluate("reply(%s)" % json.dumps(body))
                self.page.evaluate("commit('addendum')")
                self.page.wait_for_function("()=>toasts.length>0")
                value = self.page.evaluate("snapshot()")
                self.assertFalse(value["shown"])
                self.assertEqual(["MY ADDENDUM", "", ""], value["text"])
                self.assertEqual(2, value["state"]["draft"]["baseVersion"])
                self.page.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
