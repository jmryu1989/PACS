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
MODAL_CSS = slice_between(MAIN, ".modal { display: none;", "/* ══ 클릭 피드백")
BASE_BLOCK = slice_between(MAIN, "    const reportOrigin = new Map();", "    function reportSource()")
# One contiguous region: report source, loadReport, the draft bar, the rebase pane,
# stashReport and commitReport, exactly as they sit in the file.
REPORT_BLOCK = slice_between(MAIN, "    function reportSource() {", "    function heldByOther(s)")
API_FN = extract_function(MAIN, "api")
WRITE_BLOCK_FN = extract_function(MAIN, "reportWriteBlock")

HARNESS = """<!doctype html><html><head><style>MODALCSS</style></head><body>
<div class="draftbar" id="draftbar" style="display:none"><span id="draftmsg"></span>
<button id="b-report-reload"></button><button id="b-draft-discard"></button></div>
<textarea id="findings"></textarea><textarea id="conclusion"></textarea><textarea id="recommendation"></textarea>
<button id="b-approve"></button><button id="b-save"></button><button id="b-transcribe"></button>
<button id="b-addendum"></button><button id="b-unread"></button><button id="b-prelim"></button><button id="b-defer"></button>
PANEHTML
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
function heldByOther(s) { return s?.holder && s.holder !== user ? s.holder : null; }
function today() { return "2026-09-20"; }
function saveApp() {}
function syncStudy() {}
function render() {}
function renderRelated() {}
function updateReportButtons() {}
function updateReportTemplateButton() {}
window.confirm = message => { confirms.push(message); return confirmAnswer; };
window.navigator.clipboard = { writeText: value => { clipboard.push(value); } };
window.fetch = async (url, options = {}) => {
  const path = String(url).slice(API.length);
  calls.push({ method: options.method ?? "GET", path, body: options.body ? JSON.parse(options.body) : null });
  const reply = replies.shift() ?? { status: 200, body: {} };
  return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
};
function toast(message, kind) { toasts.push({ message, kind }); }
function apiFail(e) { toast("서버 저장 실패: " + e.message, "err"); }
APIFN
WRITEBLOCKFN
BASEBLOCK
REPORTBLOCK
window.load = options => loadReport(options);
window.stash = () => stashReport();
window.commit = (action, reason) => commitReport(action, reason);
window.openPane = (uid, error) => openStaleRebase(uid, error);
window.reply = value => { replies.push(value); };
window.text = () => RFIELDS.map(k => $("#" + k).value);
window.type = values => { RFIELDS.forEach((k, i) => { $("#" + k).value = values[i]; }); };
window.select = uid => { selectedUid = uid; };
window.snapshot = () => ({
  calls: structuredClone(calls), toasts: structuredClone(toasts), confirms: structuredClone(confirms),
  clipboard: structuredClone(clipboard), text: window.text(), state: structuredClone(appState[selectedUid] ?? null),
  stored: structuredClone(appState), base: reportBaseVersion(selectedUid, -1),
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
            .replace("APIFN", API_FN)
            .replace("WRITEBLOCKFN", WRITE_BLOCK_FN)
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
        self.page.set_content(harness(base))
        self.page.evaluate("load()")
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
