# coding: utf-8
"""TEST-S3-U2b-CITATION-DOM: the real main.html insertion path against a stubbed fetch.

Pure Playwright: the shipped api(), loadReport(), stashReport(), commitReport(), the citation
state, the dedicated read, the insertion pane and the real autosave/beforeunload block run on a
blank page with a synthetic fetch. No LiveStack, no Orthanc, no database, no original DICOM.

Contract 15 (a refused insertion changes nothing), 16 (a late answer never overwrites typed work),
pin B1 (the insertion leaves after a draft write already in flight, and every non-keepalive draft
write stands aside while it is out), pin B2 (a 200 extends only a confirmed state) and pin B3
(busy suppresses Escape and the backdrop; convergence is an explicit flag) are executed here
against the shipped handlers, not restated.

The autosave *timer* is the one wiring this file cannot drive in a bounded run - its 20 s interval
is real. Its source is pinned in tests/report_citation_client_test.cjs, and the function that
timer calls, reportNeedsWrite(), is executed here for real.
"""
import json
import os
import unittest
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MAIN = Path(os.environ.get("KIN_CITATION_MAIN", ROOT / "worklist-v0" / "hpacs-lite" / "main.html")).read_text(encoding="utf-8")
CITATION_JS = (ROOT / "worklist-v0" / "hpacs-lite" / "report-citation.js").read_text(encoding="utf-8")
VECTORS = json.loads((ROOT / "tests" / "report_citation_vectors.json").read_text(encoding="utf-8"))

UID = "1.2.3"
OTHER = "1.2.4"
# The R5 template's own vector, so the bytes this test asserts are the pinned ones.
ASSEMBLY = next(case for case in VECTORS["assembly"] if case["name"] == "all three fields")
BLOCK = ASSEMBLY["block"]
EXISTING = "기존 판독문 첫 줄\n둘째 줄"


def slice_between(source, start_marker, end_marker):
    start = source.index(start_marker)
    end = source.index(end_marker, start + len(start_marker))
    return source[start:end]


def extract_function(source, name):
    """The shipped function, brace matched past a destructured parameter list."""
    start = source.index("function %s(" % name)
    # Keep the modifier: slicing from "function api(" drops the `async` in front of it and the
    # whole generated harness then fails to compile, so every case dies before its first assertion.
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


# The real modal markup and the real modal styling: the pane must be modal by the rules the
# product ships, not by a rule this test invents.
CITE_HTML = slice_between(MAIN, '<div class="modal" id="cite-preview"', "\n  </div>") + "\n  </div>"
PANE_HTML = slice_between(MAIN, '<div class="modal" id="stalemodal"', "\n  </div>") + "\n  </div>"
MODAL_CSS = slice_between(MAIN, ".modal { display: none;", "/* ══ 클릭 피드백")
BASE_BLOCK = slice_between(MAIN, "    let selectionSeq = 0;", "    function reportSource()")
# One contiguous region: report source, loadReport, the draft bar, the rebase pane, the citation
# state, the dedicated read, the citation bar, the insertion pane, stashReport and commitReport.
REPORT_BLOCK = slice_between(MAIN, "    function reportSource() {", "    function heldByOther(s)")
# The shipped periodic-save and beforeunload block, so the closing-tab branch is the real one.
UNLOAD_BLOCK = slice_between(MAIN, "    const AUTOSAVE_MS = 20000;", "    // ② 로그아웃")
API_FN = extract_function(MAIN, "api")
WRITE_BLOCK_FN = extract_function(MAIN, "reportWriteBlock")
# The one gate the template path and the citation path share, taken from the product.
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
let appState = INITIALSTATE;
let studies = [{uid: "UIDVALUE", name: "HONG GILDONG", id: "P-1", date: "2026-09-20", acc: "A1", desc: "Chest CT",
                rs: "T", ss: "Verified", em: "N"},
               {uid: "OTHERVALUE", name: "KIM CHULSOO", id: "P-2", date: "2026-09-20", acc: "A2", desc: "Brain CT",
                rs: "T", ss: "Verified", em: "N"}];
let calls = [], citeCalls = [], replies = [], citeReplies = [], toasts = [], confirms = [], confirmAnswer = false, clipboard = [];
const studyPriority = { get: () => false };
const KinAuth = { has: () => true, logout: async () => {} };
const reportPreview = { close() {} };
const displayActor = value => String(value ?? "").split("@")[0];
function cur() { return studies.find(s => s.uid === selectedUid); }
function heldByOther(s) { return s?.holder && s.holder !== user ? s.holder : null; }
function shownStudyDesc(s) { return s?.desc ?? ""; }
function today() { return "2026-09-20"; }
function saveApp() {}
function syncStudy() {}
function render() {}
function renderRelated() {}
function updateReportButtons() {}
function updateReportTemplateButton() {}
window.confirm = message => { confirms.push(message); return confirmAnswer; };
Object.defineProperty(navigator, "clipboard", {
  configurable: true, value: { writeText: value => { clipboard.push(value); } },
});
// A held answer lets a test move the selection, type, close the tab or start another write while
// the request is still out. The call is recorded when it is SENT, which is what the ordering
// assertions are about.
let holdCount = 0; const heldAnswers = [];
window.fetch = async (url, options = {}) => {
  const path = String(url).slice(API.length);
  const record = { method: options.method ?? "GET", path, keepalive: !!options.keepalive,
                   body: options.body ? JSON.parse(options.body) : null,
                   keys: options.body ? Object.keys(JSON.parse(options.body)) : [] };
  if (path.endsWith("/report/citations")) {
    citeCalls.push(record);
    // No queued answer means the dedicated read fails: that is the "unconfirmed" state, and it
    // must be visibly different from "there are no citations".
    const reply = citeReplies.shift() ?? { status: 500, body: { message: "인용을 확인할 수 없습니다" } };
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  }
  calls.push(record);
  const reply = replies.shift() ?? { status: 200, body: {} };
  const answer = () => ({ ok: reply.status < 400, status: reply.status, json: async () => reply.body });
  if (holdCount > 0) { holdCount -= 1; return new Promise(resolve => { heldAnswers.push(() => resolve(answer())); }); }
  return answer();
};
function toast(message, kind) { toasts.push({ message, kind }); }
function apiFail(e) { toast("서버 저장 실패: " + e.message, "err"); }
APIFN
WRITEBLOCKFN
EDITORBLOCKFN
BASEBLOCK
REPORTBLOCK
UNLOADBLOCK
window.load = options => loadReport(options);
window.stash = () => stashReport();
window.commit = (action, reason) => { window.pending = commitReport(action, reason); return window.pending; };
window.cite = request => openCitePreview(request, null);
window.reply = value => { replies.push(value); };
window.citeReply = value => { citeReplies.push(value); };
window.hold = (n = 1) => { holdCount += n; };
window.release = () => { const fn = heldAnswers.shift(); if (fn) fn(); return !!fn; };
window.outstanding = () => heldAnswers.length;
window.text = () => RFIELDS.map(k => $("#" + k).value);
window.type = values => { RFIELDS.forEach((k, i) => { $("#" + k).value = values[i]; }); };
window.select = uid => { markSelectionChanged(uid); };
window.closeTab = () => window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
window.escapePane = () => $("#cite-preview").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
window.backdrop = () => $("#cite-preview").click();
window.citeInfo = uid => {
  const keep = citations.keepIds(uid), remove = citations.removeIds(uid), row = citations.get(uid);
  return { known: citations.known(uid), keep: keep === undefined ? "OMITTED" : keep,
           remove: remove === undefined ? "OMITTED" : remove,
           head: row ? structuredClone(row.head) : null, draft: row ? structuredClone(row.draft) : null };
};
window.snapshot = () => ({
  calls: structuredClone(calls), citeCalls: structuredClone(citeCalls), toasts: structuredClone(toasts),
  text: window.text(), state: structuredClone(appState[selectedUid] ?? null), stored: structuredClone(appState),
  base: reportBaseVersion(selectedUid, -1), seq: selectionSeq,
  shown: $("#cite-preview").classList.contains("show"),
  busy: { insert: $("#cite-preview-insert").disabled, close: $("#cite-preview-close").disabled,
          field: $("#cite-preview-field").disabled },
  pane: { block: $("#cite-preview-block").textContent, status: $("#cite-preview-status").textContent,
          source: $("#cite-preview-source").textContent, target: $("#cite-preview-target").textContent,
          field: $("#cite-preview-field").value },
  bar: { shown: $("#citebar").style.display !== "none", message: $("#citemsg").textContent,
         list: $("#citelist").hidden ? null : $("#citelist").textContent },
  converge: [...reportConverge], dirty: reportDirty(), needsWrite: reportNeedsWrite(),
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
            .replace("UNLOADBLOCK", UNLOAD_BLOCK)
            .replace("INITIALSTATE", json.dumps(state, ensure_ascii=False))
            .replace("UIDVALUE", UID)
            .replace("OTHERVALUE", OTHER))


def type_js(values):
    """The report text carries newlines; a %-formatted JS literal would end the string early."""
    return "type(%s)" % json.dumps(values, ensure_ascii=False)


def request(**overrides):
    value = {"uid": UID, "findingId": "f-1", "findingRevision": 2, "sourceIndex": 0,
             "sourceLabel": "Length · 좌상엽 · 프레임 3 · r2 · 12.3 mm", "linkState": "current",
             "headRevision": None, "block": BLOCK}
    value.update(overrides)
    return value


def draft(findings=EXISTING, base=1):
    return {"findings": findings, "conclusion": "", "recommendation": "", "baseVersion": base,
            "at": "2026-09-20T01:00"}


def entry(cid, text=BLOCK, field="findings", **overrides):
    value = {"v": 2, "cid": cid, "field": field, "findingId": "f-0", "findingRevision": 1, "sourceIndex": 0,
             "sourceRef": {"kind": "item", "itemId": "i-0", "sourceRevision": 1},
             "linkStateAtInsert": "current", "headRevisionAtInsert": None, "insertedText": text,
             "insertedAt": "2026-09-19T05:00:00.000Z", "insertedBy": "doctor2@kin", "sameTextCount": 1}
    value.update(overrides)
    return value


class ReportCitationDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def tearDown(self):
        # A handler that throws leaves the screen in a half-applied state and the assertions above
        # can still pass by looking at what did happen. Fail on it instead.
        self.assertEqual([], getattr(self, "errors", []), "the page reported an uncaught error")
        self.page.close()

    def open(self, citations=None, **state):
        base = {UID: {"rs": "T", "ss": "Verified", "em": "N", "version": 1, "findings": "SERVER HEAD",
                      "conclusion": "", "recommendation": "", "draft": draft()},
                OTHER: {"rs": "T", "ss": "Verified", "em": "N", "version": 1, "findings": "", "conclusion": "",
                        "recommendation": "", "draft": None}}
        base[UID].update(state)
        self.page = self.browser.new_page()
        # A script that fails to compile defines nothing, and every later call then reports a
        # ReferenceError for whatever it happened to touch first. Say so here instead.
        errors = []
        self.page.on("pageerror", lambda error: errors.append(str(error)))
        self.page.set_content(harness(base))
        self.assertEqual([], errors, "the generated harness did not start")
        self.assertEqual("function", self.page.evaluate("typeof insertCitation"),
                         "the sliced product code did not define insertCitation")
        if citations is not None:
            self.page.evaluate("citeReply(%s)" % json.dumps(citations, ensure_ascii=False))
        self.page.evaluate("load({force: true})")
        # loadReport fires the dedicated read; wait for it so the state is settled either way.
        self.page.wait_for_function("()=>citeCalls.length>=1")
        self.errors = errors
        return base

    def open_pane(self, **overrides):
        self.assertTrue(self.page.evaluate("cite(%s)" % json.dumps(request(**overrides), ensure_ascii=False)))
        expect(self.page.locator("#cite-preview")).to_be_visible()

    def press_insert(self):
        self.page.click("#cite-preview-insert")

    # ── R5: what the person reads is what is requested, inserted and attested ──

    def test_the_preview_shows_the_exact_bytes_and_only_a_200_moves_the_report(self):
        self.open(citations={"version": 1, "head": [], "draft": []})
        self.open_pane()
        value = self.page.evaluate("snapshot()")
        self.assertEqual(BLOCK, value["pane"]["block"], "the preview must show the assembled bytes verbatim")
        self.assertEqual("findings", value["pane"]["field"], "the destination is explicit and defaults to Findings")
        self.assertIn("HONG GILDONG", value["pane"]["target"])
        self.assertIn("r2", value["pane"]["source"])
        self.assertEqual([EXISTING, "", ""], value["text"], "opening the preview must not touch the report")
        self.assertEqual(0, len(value["calls"]))

        self.page.evaluate("reply({status: 200, body: {uid: '%s', author: 'doctor@kin', baseVersion: 1,"
                           " updatedAt: '2026-09-20T02:00:00.000Z',"
                           " inserted: {cid: 'cid-new', field: 'findings', insertedAt: '2026-09-20T02:00:00.000Z'}}})" % UID)
        self.press_insert()
        self.page.wait_for_function("()=>!$('#cite-preview').classList.contains('show')")
        value = self.page.evaluate("snapshot()")
        self.assertEqual(1, len(value["calls"]))
        put = value["calls"][0]
        self.assertEqual(("PUT", "/studies/%s/report" % UID), (put["method"], put["path"]))
        # preview == request == the appended report block == the attested insertedText.
        self.assertEqual(EXISTING + "\n" + BLOCK, put["body"]["findings"])
        self.assertEqual(BLOCK, put["body"]["insert"]["insertedText"])
        self.assertEqual(EXISTING + "\n" + BLOCK, value["text"][0])
        self.assertEqual(["", ""], value["text"][1:], "no other field may change")
        self.assertEqual({"field": "findings", "findingId": "f-1", "findingRevision": 2, "sourceIndex": 0,
                          "insertedText": BLOCK, "expectedLinkState": "current", "expectedHeadRevision": None},
                         put["body"]["insert"], "exactly the seven keys the server reads")
        self.assertEqual(1, put["body"]["baseVersion"], "the base is the version the screen drew")
        # The draft row the server now holds is what the screen says is saved.
        self.assertEqual(EXISTING + "\n" + BLOCK, value["state"]["draft"]["findings"])
        self.assertFalse(value["dirty"])
        self.assertFalse(value["needsWrite"])
        self.assertEqual([], value["converge"])
        self.assertIn("출처 증언이 함께 기록", value["toasts"][-1]["message"])

    def test_the_destination_is_explicit_and_a_changed_one_needs_its_own_press(self):
        self.open(citations={"version": 1, "head": [], "draft": []})
        self.open_pane()
        self.page.select_option("#cite-preview-field", "conclusion")
        self.page.evaluate("reply({status: 200, body: {inserted: {cid: 'c1', field: 'conclusion',"
                           " insertedAt: '2026-09-20T02:00:00.000Z'}}})")
        self.press_insert()
        self.page.wait_for_function("()=>calls.length===1")
        put = self.page.evaluate("snapshot().calls")[0]
        self.assertEqual("conclusion", put["body"]["insert"]["field"])
        self.assertEqual(BLOCK, put["body"]["conclusion"], "an empty field takes the block with no separator")
        self.assertEqual(EXISTING, put["body"]["findings"], "the other fields are sent unchanged")
        value = self.page.evaluate("snapshot()")
        self.assertEqual([EXISTING, BLOCK, ""], value["text"])

        # A second press into the same destination warns once. Changing the destination clears that
        # warning: the confirmation the person gave was about the field they were looking at.
        self.open_pane()
        self.assertEqual("findings", self.page.evaluate("snapshot().pane.field"), "each pane starts at Findings")
        self.page.select_option("#cite-preview-field", "conclusion")
        self.press_insert()
        self.page.wait_for_function("()=>$('#cite-preview-status').textContent.includes('이미 인용')")
        self.assertEqual(1, len(self.page.evaluate("snapshot().calls")), "the warning must not send anything")
        self.page.select_option("#cite-preview-field", "recommendation")
        self.assertNotIn("이미 인용", self.page.evaluate("snapshot().pane.status"),
                         "the warning belonged to the other destination")
        self.page.evaluate("reply({status: 200, body: {inserted: {cid: 'c2', field: 'recommendation',"
                           " insertedAt: '2026-09-20T02:01:00.000Z'}}})")
        self.press_insert()
        self.page.wait_for_function("()=>calls.length===2")
        put = self.page.evaluate("snapshot().calls")[1]
        self.assertEqual("recommendation", put["body"]["insert"]["field"])
        self.assertEqual(BLOCK, put["body"]["recommendation"])
        self.assertEqual(BLOCK, put["body"]["conclusion"], "the first destination keeps exactly what it had")

    def test_a_repeated_source_in_the_same_field_warns_once_and_is_then_allowed(self):
        self.open(citations={"version": 1, "head": [],
                             "draft": [entry("c-old", findingId="f-1", findingRevision=2, sourceIndex=0)]})
        self.open_pane()
        self.press_insert()
        self.page.wait_for_function("()=>$('#cite-preview-status').textContent.includes('이미 인용')")
        value = self.page.evaluate("snapshot()")
        self.assertEqual(0, len(value["calls"]), "a warning is not a request")
        self.assertEqual([EXISTING, "", ""], value["text"])
        self.page.evaluate("reply({status: 200, body: {inserted: {cid: 'c-new', field: 'findings',"
                           " insertedAt: '2026-09-20T02:00:00.000Z'}}})")
        self.press_insert()
        self.page.wait_for_function("()=>calls.length===1")
        info = self.page.evaluate("citeInfo('%s')" % UID)
        self.assertEqual(["c-old", "c-new"], info["keep"], "both citations stay; the count tells the truth")
        # Two citations now claim the one occurrence, so neither may read 'present'.
        self.assertEqual([2, 2], [item["sameTextCount"] for item in info["draft"]])

    # ── Contract 15: a refusal changes nothing ──

    def test_a_refused_insertion_leaves_the_report_and_the_draft_row_byte_identical(self):
        self.open(citations={"version": 1, "head": [], "draft": []})
        self.open_pane()
        self.page.evaluate("reply({status: 409, body: {code: 'REPORT_CITATION_STALE',"
                           " message: '소견이 그 사이 바뀌었습니다 — 소견 패널을 다시 불러온 뒤 인용하세요'}})")
        self.press_insert()
        self.page.wait_for_function("()=>$('#cite-preview-status').textContent.includes('인용하지 못했습니다')")
        value = self.page.evaluate("snapshot()")
        self.assertTrue(value["shown"], "the pane stays open so the person can read why")
        self.assertEqual([EXISTING, "", ""], value["text"], "a refused insertion must not touch the editor")
        self.assertEqual(EXISTING, value["state"]["draft"]["findings"], "the stored draft is byte identical")
        self.assertIn("판독문은 그대로입니다", value["pane"]["status"])
        self.assertEqual([UID], value["converge"], "the screen no longer knows what the row holds")
        self.assertIn("Reload Findings", value["toasts"][-1]["message"])
        for item in value["toasts"]:
            self.assertNotIn("저장했습니다", item["message"])
        # Once the answer is in, the pane is no longer busy and the person can close it.
        self.page.evaluate("escapePane()")
        self.page.wait_for_function("()=>!$('#cite-preview').classList.contains('show')")
        self.assertEqual(1, len(self.page.evaluate("snapshot().calls")))

    # ── Pin B1: ordering against draft writes ──

    def test_the_insertion_leaves_only_after_a_draft_write_already_in_flight_settles(self):
        self.open(citations={"version": 1, "head": [], "draft": []})
        self.page.evaluate(type_js([EXISTING + "\n사용자가 방금 친 줄", "", ""]))
        self.page.evaluate("hold()")
        self.page.evaluate("()=>{ window.stashing = stash(); }")
        self.page.wait_for_function("()=>outstanding()===1")
        self.assertEqual(1, len(self.page.evaluate("snapshot().calls")), "the draft write is out")
        self.open_pane()
        self.page.evaluate("reply({status: 200, body: {inserted: {cid: 'c1', field: 'findings',"
                           " insertedAt: '2026-09-20T02:00:00.000Z'}}})")
        self.press_insert()
        # The insertion must not overtake the write that is already carrying T0: if it did, the
        # older answer's body would land on the row after the sentence did.
        self.page.wait_for_function("()=>$('#cite-preview-insert').disabled===true")
        self.assertEqual(1, len(self.page.evaluate("snapshot().calls")), "the insertion must wait")
        self.assertTrue(self.page.evaluate("snapshot()")["busy"]["field"], "the destination is locked while busy")
        self.page.evaluate("release()")
        self.page.wait_for_function("()=>calls.length===2")
        put = self.page.evaluate("snapshot().calls")[1]
        self.assertEqual("PUT", put["method"])
        self.assertIn("insert", put["keys"])
        self.assertEqual(EXISTING + "\n사용자가 방금 친 줄\n" + BLOCK, put["body"]["findings"],
                         "the typed line is still there and the block follows it")

    def test_no_non_keepalive_draft_write_leaves_while_an_insertion_is_out(self):
        self.open(citations={"version": 1, "head": [], "draft": []})
        self.open_pane()
        self.page.evaluate("hold()")
        self.page.evaluate("reply({status: 200, body: {inserted: {cid: 'c1', field: 'findings',"
                           " insertedAt: '2026-09-20T02:00:00.000Z'}}})")
        self.press_insert()
        self.page.wait_for_function("()=>outstanding()===1")
        self.assertEqual(1, len(self.page.evaluate("snapshot().calls")))
        # Every non-keepalive path, not only the timer: the explicit stash, the one a study move
        # makes and the one logout makes all go through this function and must stand aside.
        self.page.evaluate(type_js([EXISTING + "\n더 친 글", "", ""]))
        self.page.evaluate("()=>stash()")
        self.page.evaluate("()=>stash()")
        self.assertEqual(1, len(self.page.evaluate("snapshot().calls")), "pin B1: every non-keepalive write skips")
        self.page.evaluate("release()")
        self.page.wait_for_function("()=>!$('#cite-preview').classList.contains('show')")
        # Once the answer is in, writing works again and carries what is on the screen.
        self.page.evaluate("()=>stash()")
        self.page.wait_for_function("()=>calls.length===3")
        self.assertEqual("PUT", self.page.evaluate("snapshot().calls")[2]["method"])

    def test_the_closing_tab_still_sends_what_it_has_while_an_insertion_is_out(self):
        # The documented residual: keepalive cannot wait for an answer, so it sends T0. Neither
        # outcome loses authored text, and the citation list says which one happened.
        self.open()          # unconfirmed on purpose: the keepalive body must carry no keep list
        self.page.evaluate(type_js([EXISTING + "\n아직 저장 안 된 줄", "", ""]))
        self.open_pane()
        self.page.evaluate("hold()")
        self.page.evaluate("reply({status: 200, body: {inserted: {cid: 'c1', field: 'findings',"
                           " insertedAt: '2026-09-20T02:00:00.000Z'}}})")
        self.press_insert()
        self.page.wait_for_function("()=>outstanding()===1")
        self.page.evaluate("closeTab()")
        self.page.wait_for_function("()=>calls.length===2")
        keepalive = self.page.evaluate("snapshot().calls")[1]
        self.assertTrue(keepalive["keepalive"], "the closing tab uses the keepalive path")
        self.assertEqual(EXISTING + "\n아직 저장 안 된 줄", keepalive["body"]["findings"],
                         "the typed text still goes out even though the sentence is in flight")
        self.assertNotIn("insert", keepalive["keys"], "a keepalive write never carries an insertion")
        # The unconfirmed state keeps the key out of that body too, so it can delete nothing.
        self.assertNotIn("citationIds", keepalive["keys"])

    # ── Contract 16: late answers ──

    def test_an_answer_that_arrives_after_the_study_moved_is_not_written_to_the_screen(self):
        self.open(citations={"version": 1, "head": [], "draft": []})
        self.open_pane()
        self.page.evaluate("hold()")
        self.page.evaluate("reply({status: 200, body: {inserted: {cid: 'c1', field: 'findings',"
                           " insertedAt: '2026-09-20T02:00:00.000Z'}}})")
        self.press_insert()
        self.page.wait_for_function("()=>outstanding()===1")
        self.page.evaluate("()=>{ select('%s'); type(['OTHER PATIENT TEXT', '', '']); }" % OTHER)
        self.page.evaluate("release()")
        self.page.wait_for_function("()=>toasts.some(t=>t.message.includes('늦게 도착'))")
        value = self.page.evaluate("snapshot()")
        self.assertFalse(value["shown"], "a pane that belongs to the study we left must not stay open")
        self.assertEqual(["OTHER PATIENT TEXT", "", ""], value["text"], "the other study's editor is untouched")
        self.assertEqual(EXISTING, value["stored"][UID]["draft"]["findings"], "the refused study keeps its bytes")
        self.assertEqual([UID], value["converge"], "the study whose row may have moved is marked")
        self.assertNotIn(BLOCK, json.dumps(value["stored"][OTHER], ensure_ascii=False))
        self.assertEqual(1, len(value["calls"]))

    def test_an_answer_that_returns_after_a_round_trip_is_still_not_the_same_selection(self):
        # A -> B -> A. The uid matches again, so a uid-only guard would write the sentence into an
        # editor that was redrawn twice since the request left.
        self.open(citations={"version": 1, "head": [], "draft": []})
        self.open_pane()
        started = self.page.evaluate("snapshot().seq")
        self.page.evaluate("hold()")
        self.page.evaluate("reply({status: 200, body: {inserted: {cid: 'c1', field: 'findings',"
                           " insertedAt: '2026-09-20T02:00:00.000Z'}}})")
        self.press_insert()
        self.page.wait_for_function("()=>outstanding()===1")
        self.page.evaluate("()=>{ select('%s'); select('%s'); load({force: true}); }" % (OTHER, UID))
        self.assertEqual(UID, self.page.evaluate("selectedUid"))
        self.assertEqual(started + 2, self.page.evaluate("snapshot().seq"))
        self.page.evaluate("release()")
        self.page.wait_for_function("()=>toasts.some(t=>t.message.includes('늦게 도착'))")
        value = self.page.evaluate("snapshot()")
        self.assertEqual([EXISTING, "", ""], value["text"], "the returning screen shows the stored draft only")
        self.assertEqual(EXISTING, value["state"]["draft"]["findings"])
        self.assertEqual([UID], value["converge"])

    def test_a_discarded_insertion_makes_the_next_draft_write_converge_the_row(self):
        # After a stash the dirty comparison reports clean, so only an explicit flag can make the
        # next write happen - and that write is what removes a sentence the screen never showed.
        self.open(citations={"version": 1, "head": [], "draft": []})
        self.open_pane()
        self.page.evaluate("hold()")
        self.page.evaluate("reply({status: 200, body: {inserted: {cid: 'c1', field: 'findings',"
                           " insertedAt: '2026-09-20T02:00:00.000Z'}}})")
        self.press_insert()
        self.page.wait_for_function("()=>outstanding()===1")
        self.page.evaluate("()=>{ select('%s'); }" % OTHER)
        self.page.evaluate("release()")
        self.page.wait_for_function("()=>toasts.some(t=>t.message.includes('늦게 도착'))")
        self.page.evaluate("()=>{ select('%s'); load({force: true}); }" % UID)
        value = self.page.evaluate("snapshot()")
        self.assertFalse(value["dirty"], "the editor matches the stored draft, so the comparison is clean")
        self.assertTrue(value["needsWrite"], "pin B3: the explicit flag outlives the comparison")
        self.page.evaluate("()=>stash()")
        self.page.wait_for_function("()=>calls.length===2 && reportConverge.size===0")
        put = self.page.evaluate("snapshot().calls")[1]
        self.assertEqual(EXISTING, put["body"]["findings"], "the row converges to what the screen shows")
        self.assertNotIn("insert", put["keys"])
        self.assertEqual([], self.page.evaluate("snapshot()")["converge"], "a completed write lowers the flag")

    # ── Pin B3: the pane is modal while busy ──

    def test_busy_suppresses_escape_and_the_backdrop_until_the_answer(self):
        self.open(citations={"version": 1, "head": [], "draft": []})
        self.open_pane()
        self.page.evaluate("hold()")
        self.page.evaluate("reply({status: 200, body: {inserted: {cid: 'c1', field: 'findings',"
                           " insertedAt: '2026-09-20T02:00:00.000Z'}}})")
        self.press_insert()
        self.page.wait_for_function("()=>outstanding()===1")
        value = self.page.evaluate("snapshot()")
        self.assertEqual({"insert": True, "close": True, "field": True}, value["busy"])
        self.page.evaluate("escapePane()")
        self.page.evaluate("backdrop()")
        value = self.page.evaluate("snapshot()")
        self.assertTrue(value["shown"], "pin B3: neither Escape nor the backdrop may close it while busy")
        self.assertIn("서버에 기록하는 중", value["pane"]["status"])
        self.page.evaluate("release()")
        self.page.wait_for_function("()=>!$('#cite-preview').classList.contains('show')")
        self.assertEqual([EXISTING + "\n" + BLOCK, "", ""], self.page.evaluate("snapshot().text"))

    # ── Pin B2: a 200 extends only a confirmed state ──

    def test_an_insertion_200_does_not_invent_a_keep_list_for_an_unconfirmed_study(self):
        self.open()          # the dedicated read fails: the study stays unconfirmed
        self.assertFalse(self.page.evaluate("citeInfo('%s')" % UID)["known"])
        self.assertEqual("OMITTED", self.page.evaluate("citeInfo('%s')" % UID)["keep"])
        self.open_pane()
        self.page.evaluate("reply({status: 200, body: {inserted: {cid: 'c1', field: 'findings',"
                           " insertedAt: '2026-09-20T02:00:00.000Z'}}})")
        self.press_insert()
        self.page.wait_for_function("()=>calls.length===1")
        put = self.page.evaluate("snapshot().calls")[0]
        self.assertNotIn("citationIds", put["keys"], "an unconfirmed study must omit the key, never send []")
        info = self.page.evaluate("citeInfo('%s')" % UID)
        self.assertFalse(info["known"], "pin B2: a 200 extends, it does not confirm")
        self.assertEqual("OMITTED", info["keep"])
        # The next draft write still omits it, so nothing this screen never read can be deleted.
        self.page.evaluate(type_js([EXISTING + "\n" + BLOCK + "\n더", "", ""]))
        self.page.evaluate("()=>stash()")
        self.page.wait_for_function("()=>calls.length===2")
        self.assertNotIn("citationIds", self.page.evaluate("snapshot().calls")[1]["keys"])
        # One successful read is what changes that.
        self.page.evaluate("citeReply(%s)" % json.dumps(
            {"version": 1, "head": [], "draft": [entry("c1")]}, ensure_ascii=False))
        self.page.click("#b-cite-reload")
        self.page.wait_for_function("()=>citeInfo('%s').known===true" % UID)
        self.page.evaluate(type_js([EXISTING + "\n" + BLOCK + "\n더\n또", "", ""]))
        self.page.evaluate("()=>stash()")
        self.page.wait_for_function("()=>calls.length===3")
        self.assertEqual(["c1"], self.page.evaluate("snapshot().calls")[2]["body"]["citationIds"])

    def test_a_confirmed_study_carries_its_keep_list_and_the_200_extends_it(self):
        self.open(citations={"version": 1, "head": [entry("h1", text="승인본 인용")],
                             "draft": [entry("d1", text=EXISTING.split("\n")[0])]})
        info = self.page.evaluate("citeInfo('%s')" % UID)
        self.assertTrue(info["known"])
        self.assertEqual(["d1"], info["keep"])
        self.open_pane()
        self.page.evaluate("reply({status: 200, body: {inserted: {cid: 'd2', field: 'findings',"
                           " insertedAt: '2026-09-20T02:00:00.000Z'}}})")
        self.press_insert()
        self.page.wait_for_function("()=>calls.length===1")
        put = self.page.evaluate("snapshot().calls")[0]
        self.assertEqual(["d1"], put["body"]["citationIds"], "the request keeps what the read confirmed")
        self.assertEqual(["d1", "d2"], self.page.evaluate("citeInfo('%s')" % UID)["keep"],
                         "pin B2: the 200 extends the confirmed list")
        self.page.evaluate(type_js([EXISTING + "\n" + BLOCK + "\n계속", "", ""]))
        self.page.evaluate("()=>stash()")
        self.page.wait_for_function("()=>calls.length===2")
        self.assertEqual(["d1", "d2"], self.page.evaluate("snapshot().calls")[1]["body"]["citationIds"],
                         "the next autosave must not drop the sentence it just attested")

    # ── The head list and the commit ──

    def test_a_head_citation_is_removed_only_by_an_explicit_choice_carried_on_the_commit(self):
        self.open(citations={"version": 1, "head": [entry("h1", text="승인본 인용"), entry("h2", text="남길 인용")],
                             "draft": [entry("d1", text=EXISTING.split("\n")[0])]},
                  findings="승인본 인용\n남길 인용")
        self.page.click("#b-cite-list")
        value = self.page.evaluate("snapshot()")
        self.assertTrue(value["bar"]["shown"])
        self.assertIn("인용 3건", value["bar"]["message"])
        self.assertIn("승인본 2건", value["bar"]["message"])
        self.assertIn("넣은 문자열이 이 칸에 그대로 있습니다", value["bar"]["list"])
        self.assertIn("주변 문장에 대해서는 아무것도 말하지 않습니다", value["bar"]["list"])
        self.assertNotIn("h1", value["bar"]["list"], "internal identifiers stay out of the reading surface")
        self.page.check("[data-cite-remove='h1']")
        self.assertEqual(["h1"], self.page.evaluate("citeInfo('%s')" % UID)["remove"])
        self.assertEqual(0, len(self.page.evaluate("snapshot().calls")), "choosing is not writing")
        self.page.evaluate("reply({status: 200, body: {rs: 'T', version: 2}})")
        self.page.evaluate("commit('save')")
        self.page.wait_for_function("()=>calls.length===1")
        post = self.page.evaluate("snapshot().calls")[0]
        self.assertEqual("POST", post["method"])
        self.assertEqual(["d1"], post["body"]["citationIds"])
        self.assertEqual(["h1"], post["body"]["removeCitationIds"],
                         "head removal travels on its own key, never through the draft keep list")
        self.assertFalse(self.page.evaluate("citeInfo('%s')" % UID)["known"],
                         "the commit moved both rows, so the screen no longer knows them")

    # ── The bar only speaks about what the dedicated read told it ──

    def test_the_bar_says_it_could_not_check_instead_of_reading_as_zero(self):
        self.open()          # the read fails
        value = self.page.evaluate("snapshot()")
        self.assertTrue(value["bar"]["shown"])
        self.assertIn("확인하지 못했습니다", value["bar"]["message"])
        self.assertNotIn("0건", value["bar"]["message"], "unknown must never be displayed as none")
        self.assertIsNone(value["bar"]["list"], "there is nothing to list")
        # A study with no citations at all says nothing, rather than adding a permanent empty bar.
        self.page.evaluate("citeReply(%s)" % json.dumps({"version": 1, "head": [], "draft": []}))
        self.page.click("#b-cite-reload")
        self.page.wait_for_function("()=>citeInfo('%s').known===true" % UID)
        self.assertFalse(self.page.evaluate("snapshot()")["bar"]["shown"])

    def test_presence_follows_the_editor_for_a_draft_citation_and_the_head_for_a_head_one(self):
        self.open(citations={"version": 1, "head": [entry("h1", text="SERVER HEAD")],
                             "draft": [entry("d1", text=EXISTING.split("\n")[0])]})
        self.page.click("#b-cite-list")
        shown = self.page.evaluate("snapshot().bar.list")
        self.assertEqual(2, shown.count("넣은 문자열이 이 칸에 그대로 있습니다"))
        # Deleting the quoted line from the editor moves the DRAFT entry to 'absent'; the approved
        # report has not changed, so the head entry must not move with it. The real input event
        # drives the real refresh, the same way typing does.
        self.page.fill("#findings", "다 지웠다")
        self.page.wait_for_function("()=>$('#citelist').textContent.includes('더는 없습니다')")
        shown = self.page.evaluate("snapshot().bar.list")
        self.assertIn("넣은 문자열이 이 칸에 더는 없습니다", shown)
        self.assertEqual(1, shown.count("넣은 문자열이 이 칸에 그대로 있습니다"), "the head entry is unchanged")
        # A reduced entry shows one neutral line and claims nothing about the text.
        self.page.evaluate("citeReply(%s)" % json.dumps({"version": 1, "head": [], "draft": [
            {"cid": "r1", "field": "findings", "insertedAt": "2026-09-19T05:00:00.000Z",
             "insertedBy": "doctor2@kin", "state": "source-unavailable"}]}, ensure_ascii=False))
        self.page.click("#b-cite-reload")
        self.page.wait_for_function("()=>$('#citelist').textContent.includes('지금 확인할 수 없습니다')")
        shown = self.page.evaluate("snapshot().bar.list")
        self.assertIn("이 인용의 소견을 지금 확인할 수 없습니다", shown)
        self.assertNotIn("넣은 문자열이", shown, "a reduced entry never claims the text is there or gone")

    def test_an_offline_or_read_only_screen_refuses_the_insertion_with_the_shared_reason(self):
        self.open(citations={"version": 1, "head": [], "draft": []})
        self.page.evaluate("()=>{ offline = true; }")
        self.assertFalse(self.page.evaluate("cite(%s)" % json.dumps(request(), ensure_ascii=False)))
        value = self.page.evaluate("snapshot()")
        self.assertFalse(value["shown"])
        self.assertIn("연결", value["toasts"][-1]["message"])
        self.assertEqual(0, len(value["calls"]), "an insertion needs the server's attestation to exist at all")
        # Another study's finding never reaches the pane.
        self.page.evaluate("()=>{ offline = false; }")
        self.assertFalse(self.page.evaluate("cite(%s)" % json.dumps(request(uid=OTHER), ensure_ascii=False)))
        self.assertIn("선택한 검사의 소견만", self.page.evaluate("snapshot().toasts")[-1]["message"])
        # A held study is read-only, and the same string the template path uses says so.
        self.page.evaluate("()=>{ studies[0].holder = 'doctor2@kin'; loadReport({force: true}); }")
        self.assertFalse(self.page.evaluate("cite(%s)" % json.dumps(request(), ensure_ascii=False)))
        self.assertEqual("현재 판독문은 편집할 수 없습니다", self.page.evaluate("snapshot().toasts")[-1]["message"])
        self.assertEqual(0, len(self.page.evaluate("snapshot().calls")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
