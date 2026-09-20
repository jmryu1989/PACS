# coding: utf-8
"""TEST-S3-U4-PREVIEW-CITATION-DOM: the shipped report preview dialog printing citation evidence.

REQ-S3-U4-CITATION-OUTPUT -> RISK-S3-U4-FALSE-EMPTY / STALE-ANSWER-PRINTED / PAPER-IDENTIFIER-LEAK
-> TEST-S3-U4-PREVIEW-CITATION-DOM.

Pure Playwright over a stubbed fetch: the shipped KinReportPreview factory, the shipped
report-citation.js rules and the SHIPPED api() extracted from main.html run on a blank page. The
extracted api() matters - the 403 and 401 branches then travel the real {message, code, status,
body} shape the product throws, not one this test invented. No LiveStack, no Orthanc, no database,
no original DICOM, no server.

17 cases. The four browser mutants of this unit mutate report-preview.js, so the file takes a
KIN_PREVIEW_JS override and tests/report_preview_citation_mutants.py drives the kills through it.

What this file cannot see, and says so rather than pretending: real pagination (a headless DOM
cannot observe page breaks) and the ordering of the citation section against a rendered key-image
section (that needs the DICOM lookup/digest/tag stubs and a decodable frame, which is a separate
cost). Structure is asserted on the serialized paper instead. The AbortError/15 s budget rethrow is
reviewed statically only - a timer-driven case is not worth its cost.
"""
import json
import os
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MAIN = Path(os.environ.get("KIN_PREVIEW_MAIN", ROOT / "worklist-v0" / "hpacs-lite" / "main.html")).read_text(encoding="utf-8")
# KIN_PREVIEW_JS is the override the mutant runner needs: every browser mutant of this unit mutates
# report-preview.js, so a main.html-only hook could not serve any of them. The default is always the
# shipped file, and the runner only ever points this at a temporary COPY - never at the tree.
PREVIEW_JS = Path(os.environ.get("KIN_PREVIEW_JS", ROOT / "worklist-v0" / "hpacs-lite" / "report-preview.js")).read_text(encoding="utf-8")
CITATION_JS = (ROOT / "worklist-v0" / "hpacs-lite" / "report-citation.js").read_text(encoding="utf-8")

UID = "1.2.3"
OTHER = "1.2.4"
OTHER_PATIENT = "KIM CHULSOO"
EXPIRED = "세션이 만료되었습니다"
RECHECKING = "출력 직전 상태를 다시 확인하고 있습니다…"
BODY_LINE = "우상엽 결절"
HEADING = "인용된 소견"
ATTRIBUTION = "인용 증적 확인: doctor의 열람 권한 기준"
LIMITATION = "이 목록은 판독문 문장과 1:1로 대응하지 않습니다."
UNKNOWN = "인용 증적을 확인하지 못했습니다"
REFUSED = "인용 증적을 확인하지 못했습니다 — 접근 권한 밖"
NONE = "인용된 소견 없음"
EDITOR_NOTICE = "현재 편집문 · 미확정 — 인용 증적은 이 출력에 싣지 않습니다. 서버 저장본 출력에서 확인하세요."
CHANGED = "출력 내용이 변경되었습니다. 다시 확인을 누르세요."

# Values that must never reach a printed record.
CID = "SENTINELCIDAAAA"
FINDING = "SENTINELFINDINGBBBB"
JOB = "SENTINELJOBCCCC"
MARK = "SENTINELMARKDDDD"
SENTINELS = (CID, FINDING, JOB, MARK, "918273", "827364")


def extract_function(source, name):
    """The shipped function, brace matched past a destructured parameter list.

    Deliberately duplicated from report_citation_dom_test.py: importing that module would pull its
    own TestCase into this file's namespace and unittest would then rerun 26 unrelated cases.
    """
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


API_FN = extract_function(MAIN, "api")

HARNESS = """<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body>
<script>
CITATIONJS
</script>
<script>
PREVIEWJS
</script>
<script>
const API = "/api";
let selectedUid = "UIDVALUE", warnedFor = null, appState = {};
let previewCalls = [], citeCalls = [], toasts = [], logouts = 0;
const KinAuth = { logout: async () => { logouts += 1; } };
const displayActor = value => String(value ?? "").split("@")[0];
function syncStudy() {}
function updateReportButtons() {}
function loadReport() {}
function toast(message, kind) { toasts.push({ message, kind }); }

let previewAnswer = PREVIEWANSWER;
/* The citations answers a case queues. When the queue runs dry the LAST answer is repeated, so the
   print-time re-read agrees with the render unless a case deliberately queues a different one. */
let citeQueue = [], citeLast = null;
/* A held answer is what a stale response is made of. It deliberately IGNORES the abort signal:
   with an abort-honouring stub the late answer would never arrive and a missing guard after the
   last await would survive unobserved. */
let holdCite = 0; const heldCite = [];
window.fetch = async (url, options = {}) => {
  const path = String(url).slice(API.length);
  if (path.endsWith("/report/citations")) {
    citeCalls.push({ path, method: options.method ?? "GET" });
    if (citeQueue.length) citeLast = citeQueue.shift();
    const reply = citeLast ?? { status: 500, body: { message: "인용을 확인할 수 없습니다" } };
    const answer = () => ({ ok: reply.status < 400, status: reply.status, json: async () => reply.body });
    if (holdCite > 0) { holdCite -= 1; return new Promise(resolve => { heldCite.push(() => resolve(answer())); }); }
    return answer();
  }
  previewCalls.push({ path, method: options.method ?? "GET" });
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(previewAnswer)) };
};
APIFN

/* The popup the product prints into. The repo already stubs a popup's print this way (19 `.print =`
   stubs across the existing popup tests, e.g. tests/e2e/test_report_preview.py:102); a headless
   print dialog is not what these cases are about. The write capture is what turns "the printed
   document is the previewed document" into a whole-string equality instead of a substring, because
   the popup's re-serialization can never be compared with the srcdoc string itself.
   Document.prototype is taken from the POPUP's realm - the parent's would be a foreign prototype -
   and the capture is reinstalled after document.open(), which may drop own properties. */
let printCalls = 0; const written = [];
const realOpen = window.open;
window.open = (...args) => {
  const w = realOpen(...args);
  if (!w) return w;
  const capture = () => { w.document.write = text => { written.push(String(text)); w.Document.prototype.write.call(w.document, text); }; };
  w.print = () => { printCalls += 1; };
  capture();
  w.document.open = (...rest) => { const value = w.Document.prototype.open.apply(w.document, rest); capture(); return value; };
  return w;
};

let online = true;
let editorText = { findings: "편집 중인 글", conclusion: "", recommendation: "" };
const preview = KinReportPreview({ api, actorName: displayActor, toast,
  context: () => ({ uid: selectedUid, online, editor: { ...editorText } }) });

const dialog = () => document.querySelector("#report-preview");
const button = label => [...dialog().querySelectorAll("button")].find(b => b.textContent === label);
window.ui = {
  open: () => preview.open(),
  close: () => button("닫기").click(),
  srcdoc: () => dialog().querySelector("iframe").srcdoc,
  status: () => dialog().querySelector("[role=status]").textContent,
  printDisabled: () => button("인쇄 / PDF").disabled,
  print: () => button("인쇄 / PDF").click(),
  refresh: () => button("다시 확인").click(),
  setSource: value => { const s = dialog().querySelector("select[aria-label='출력 판독문']");
                        s.value = value; s.dispatchEvent(new Event("change")); },
  counts: () => ({ preview: previewCalls.length, cite: citeCalls.length }),
  queueCite: reply => { citeQueue.push(reply); },
  setPreview: answer => { previewAnswer = answer; },
  setUid: value => { selectedUid = value; },
  printCalls: () => printCalls,
  written: () => written.slice(),
  hold: (n = 1) => { holdCite += n; },
  release: () => { const fn = heldCite.shift(); if (fn) fn(); return !!fn; },
  outstanding: () => heldCite.length,
  logouts: () => logouts,
  /* The citation section as the paper serializes it. Identifier assertions run against the whole
     document, because an attribute or a comment is invisible to textContent. */
  section: () => { const html = window.ui.srcdoc(); const start = html.indexOf('<section class="citations"');
                   return start < 0 ? null : html.slice(start, html.indexOf("</section>", start) + 10); },
};
</script></body></html>"""


def preview_answer(version=3, action="approve", findings=BODY_LINE, uid=UID, name="HONG GILDONG"):
    return {"study": {"uid": uid, "id": "P-1", "name": name, "birth": "1970-01-01", "sex": "M",
                      "date": "2026-09-20", "acc": "A1", "desc": "Chest CT", "modality": "CT"},
            "actor": "doctor@kin", "canPreviewEditor": True,
            "report": {"version": version, "rs": "A", "action": action, "author": "doctor2@kin",
                       "repDoc": "doctor2@kin", "confirm": "2026-09-20T02:00:00Z",
                       "findings": findings, "conclusion": "", "recommendation": ""},
            "keys": []}


def entry(**overrides):
    """One readable entry in the server's real projected shape."""
    value = {"v": 2, "cid": CID, "field": "findings", "findingId": FINDING, "findingRevision": 2,
             "sourceIndex": 0, "sourceRef": {"kind": "job", "jobId": JOB, "markId": MARK, "sourceRevision": 827364},
             "linkStateAtInsert": "current", "headRevisionAtInsert": 918273, "insertedText": BODY_LINE,
             "insertedAt": "2026-09-19T05:00:00.000Z", "insertedBy": "doctor2@kin", "sameTextCount": 1}
    value.update(overrides)
    return value


def reduced(cid=CID + "5", field="conclusion"):
    """The server's reduced projection, exactly its five keys (report-citation.ts:261-265)."""
    return {"cid": cid, "field": field, "insertedAt": "2026-09-19T06:30:00.000Z",
            "insertedBy": "doctor3@kin", "state": "source-unavailable"}


def ok(head, version=3):
    return {"status": 200, "body": {"version": version, "head": head, "draft": []}}


class ReportPreviewCitationDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def tearDown(self):
        # A handler that throws leaves a half-drawn dialog whose assertions can still pass on what
        # did happen. Fail on it instead.
        self.assertEqual([], getattr(self, "errors", []), "the page reported an uncaught error")
        self.page.close()

    def open(self, cite=None, answer=None, render=True):
        self.page = self.browser.new_page()
        self.page.set_default_timeout(10000)
        errors = []
        self.page.on("pageerror", lambda error: errors.append(str(error)))
        harness = (HARNESS
                   .replace("CITATIONJS", CITATION_JS)
                   .replace("PREVIEWJS", PREVIEW_JS)
                   .replace("APIFN", API_FN)
                   .replace("PREVIEWANSWER", json.dumps(answer or preview_answer(), ensure_ascii=False))
                   .replace("UIDVALUE", UID))
        self.page.set_content(harness)
        self.assertEqual([], errors, "the generated harness did not start")
        self.assertEqual("function", self.page.evaluate("typeof KinReportPreview"),
                         "the shipped preview factory did not load")
        self.assertEqual("function", self.page.evaluate("typeof api"),
                         "the sliced product api() did not define")
        if cite is not None:
            self.page.evaluate("ui.queueCite(%s)" % json.dumps(cite, ensure_ascii=False))
        self.errors = errors
        self.page.evaluate("ui.open()")
        if render:
            self.wait_render()
        else:
            # A render that ends in a blank paper is still settled once the read has answered.
            self.page.wait_for_function("() => ui.counts().cite >= 1")

    def wait_render(self, previous=None):
        if previous is None:
            self.page.wait_for_function("() => ui.srcdoc().length > 0")
        else:
            self.page.wait_for_function("prev => ui.srcdoc().length > 0 && ui.srcdoc() !== prev", arg=previous)
        return self.page.evaluate("ui.srcdoc()")

    def section(self):
        value = self.page.evaluate("ui.section()")
        self.assertIsNotNone(value, "the paper carries no citation section:\n" + self.page.evaluate("ui.srcdoc()"))
        return value

    def require_print(self):
        self.assertFalse(self.page.evaluate("ui.printDisabled()"),
                         "print is disabled: this Chromium does not support @page margin boxes, "
                         "which is the product's own precondition for printing")

    def print_document(self):
        """Press print and return every string the product wrote into its popup.

        Waiting on the product's own print() call - not on the document landing - is what proves the
        path ran to its end: document.write happens before the last guards.
        """
        with self.page.expect_popup() as popup:
            self.page.evaluate("ui.print()")
        window = popup.value
        self.page.wait_for_function("() => ui.printCalls() === 1")
        written = self.page.evaluate("ui.written()")
        if not window.is_closed():
            window.close()
        return written

    # ── D1 · a saved head with citations prints them ──

    def test_a_saved_head_prints_one_witness_line_for_each_citation(self):
        self.open(cite=ok([entry(), entry(cid=CID + "2", field="conclusion", insertedText="다른 문장")]))
        section = self.section()
        self.assertIn(HEADING, section)
        self.assertIn(ATTRIBUTION, section)
        self.assertIn(LIMITATION, section)
        self.assertIn("Findings · 소견 r2 · 출처 1번 · 인용 당시 연결 현재 판과 일치", section)
        self.assertIn("2026-09-19 05:00(UTC)", section)
        # The first entry's text is in the printed body, the second one's is not.
        self.assertIn("넣은 문자열이 이 칸에 그대로 있습니다", section)
        self.assertIn("넣은 문자열이 이 칸에 더는 없습니다", section)
        self.assertEqual({"preview": 2, "cite": 1}, self.page.evaluate("ui.counts()"),
                         "one dedicated read per render, beside the existing re-snapshot")

    # ── D2 · an answered read with no citations is the only way to say 없음 ──

    def test_an_empty_head_prints_the_empty_wording(self):
        self.open(cite=ok([]))
        section = self.section()
        self.assertIn(NONE, section)
        self.assertNotIn(LIMITATION, section)
        self.assertNotIn(UNKNOWN, section)

    # ── D3 · refused ──

    def test_a_refused_read_says_so_and_still_prints_the_report(self):
        self.open(cite={"status": 403, "body": {"message": "예비 판독(RS: P) 중입니다."}})
        section = self.section()
        self.assertIn(REFUSED, section)
        self.assertNotIn(NONE, section)
        # The refusal reason is the server's; the paper says no more than the boundary.
        self.assertNotIn("예비 판독", section)
        srcdoc = self.page.evaluate("ui.srcdoc()")
        self.assertIn(BODY_LINE, srcdoc, "the report body still prints")
        self.assertIn("승인된 저장본 · v3", srcdoc, "the header is unchanged")
        self.require_print()

    # ── D4 · a server failure is unknown, never empty ──

    def test_a_failed_read_is_unknown_and_does_not_blank_the_paper(self):
        self.open(cite={"status": 500, "body": {"message": "인용을 확인할 수 없습니다"}})
        section = self.section()
        self.assertIn(UNKNOWN, section)
        self.assertNotIn(NONE, section)
        self.assertIn(BODY_LINE, self.page.evaluate("ui.srcdoc()"))
        self.require_print()

    # ── D5 · a 200 whose shape is wrong is unknown ──

    def test_a_malformed_two_hundred_is_unknown(self):
        self.open(cite={"status": 200, "body": {"version": 3, "head": "none", "draft": []}})
        self.assertIn(UNKNOWN, self.section())
        self.assertNotIn(NONE, self.section())

    # ── D6 · the answer must belong to the head being printed ──

    def test_a_citation_answer_for_another_version_is_unknown(self):
        self.open(cite=ok([entry()], version=2))
        section = self.section()
        self.assertIn(UNKNOWN, section)
        self.assertNotIn("소견 r2 ·", section)

    # ── D7 · the editor paper carries a notice and asks nobody's permission ──

    def test_editor_mode_prints_a_notice_and_never_reads_citations(self):
        self.open(cite=ok([entry()]))
        before = self.page.evaluate("ui.srcdoc()")
        self.page.evaluate("ui.setSource('editor')")
        self.wait_render(before)
        section = self.section()
        self.assertIn(EDITOR_NOTICE, section)
        self.assertNotIn(ATTRIBUTION, section)
        self.assertNotIn(LIMITATION, section)
        for text in (NONE, UNKNOWN, "소견 r"):
            self.assertNotIn(text, section)
        self.assertEqual(1, self.page.evaluate("ui.counts().cite"), "no dedicated read in editor mode")
        # C7: printing the unconfirmed paper must not ask for citations either, and what is printed
        # is the previewed document itself.
        self.require_print()
        printed = self.print_document()
        self.assertEqual([self.page.evaluate("ui.srcdoc()")], printed, "the printed string is the previewed string")
        self.assertIn(EDITOR_NOTICE, printed[0])
        self.assertEqual(1, self.page.evaluate("ui.counts().cite"), "no dedicated read at print time")

    # ── D8 · switching back and forth redraws under each mode's own rule ──

    def test_switching_modes_redraws_the_section_under_that_modes_rule(self):
        self.open(cite=ok([entry()]))
        first = self.page.evaluate("ui.srcdoc()")
        self.assertIn(ATTRIBUTION, first)
        self.page.evaluate("ui.setSource('editor')")
        editor = self.wait_render(first)
        self.assertIn(EDITOR_NOTICE, editor)
        self.page.evaluate("ui.setSource('saved')")
        saved = self.wait_render(editor)
        self.assertIn(ATTRIBUTION, saved)
        self.assertNotIn(EDITOR_NOTICE, saved)
        self.assertEqual(2, self.page.evaluate("ui.counts().cite"), "the saved render reads again")

    # ── D9 · a late answer never reaches a paper that moved on ──

    def test_a_late_citation_answer_cannot_overwrite_a_newer_paper(self):
        self.open(cite=ok([entry(findingRevision=7)]))
        first = self.page.evaluate("ui.srcdoc()")
        self.assertIn("소견 r7", first)
        # The next read is held open; the render waiting on it is now the old one.
        self.page.evaluate("ui.hold(1)")
        self.page.evaluate("ui.queueCite(%s)" % json.dumps(ok([entry(findingRevision=11)]), ensure_ascii=False))
        self.page.evaluate("ui.refresh()")
        self.page.wait_for_function("() => ui.outstanding() === 1")
        # A newer render answers immediately and owns the paper.
        self.page.evaluate("ui.queueCite(%s)" % json.dumps(ok([entry(findingRevision=22)]), ensure_ascii=False))
        self.page.evaluate("ui.refresh()")
        self.page.wait_for_function("() => ui.srcdoc().includes('소견 r22')")
        self.assertTrue(self.page.evaluate("ui.release()"), "the held answer was released")
        self.page.wait_for_function("() => ui.outstanding() === 0")
        srcdoc = self.page.evaluate("ui.srcdoc()")
        self.assertIn("소견 r22", srcdoc, "the newest render owns the paper")
        self.assertNotIn("소견 r11", srcdoc, "a late answer must not overwrite a newer paper")

    # ── D10 · where the section sits and what carries it ──

    def test_the_section_is_the_last_block_of_the_paper_and_avoids_splitting(self):
        self.open(cite=ok([entry()]))
        srcdoc = self.page.evaluate("ui.srcdoc()")
        self.assertLess(srcdoc.index("<h2>Recommendation</h2>"), srcdoc.index('<section class="citations"'),
                        "the evidence follows the report text")
        self.assertTrue(srcdoc.rstrip().endswith("</section></main></body></html>"), srcdoc[-120:])
        self.assertIn('<p class="citation">', srcdoc)
        # The style the entries rely on, and the key-image rule it must not disturb.
        self.assertIn(".citation{break-inside:avoid;margin:3px 0}", srcdoc)
        self.assertIn(".keys{break-before:page}", srcdoc)
        # Only text ever reaches the paper: a name is user input and this is a record.
        self.assertNotIn("<script", self.section())

    # ── D11 · the print-time re-read refuses a paper that no longer matches ──

    def test_print_refuses_when_the_evidence_changed_since_the_render(self):
        self.open(cite=ok([entry()]))
        self.require_print()
        self.page.evaluate("ui.queueCite(%s)" % json.dumps(ok([]), ensure_ascii=False))
        with self.page.expect_popup() as popup:
            self.page.evaluate("ui.print()")
        window = popup.value
        # Wait for the refusal itself, not for the window: under a mutant that skips the re-read the
        # recorded failure must be this assertion with both strings, not a 10 s timeout.
        self.page.wait_for_function("rechecking => ui.status() !== rechecking", arg=RECHECKING)
        self.assertEqual(CHANGED, self.page.evaluate("ui.status()"))
        self.assertEqual(0, self.page.evaluate("ui.printCalls()"), "a refused print never reaches print()")
        self.assertEqual([], self.page.evaluate("ui.written()"), "and writes nothing into the window it opened")
        if not window.is_closed():
            # The close reaches Playwright on a different path than the polling evaluate above.
            window.wait_for_event("close")
        self.assertEqual("", self.page.evaluate("ui.srcdoc()"), "the refused paper is withdrawn")

    # ── D12 · an unchanged re-read prints exactly what was previewed ──

    def test_print_writes_the_same_evidence_the_preview_showed(self):
        self.open(cite=ok([entry()]))
        self.require_print()
        previewed = self.page.evaluate("ui.srcdoc()")
        section = self.section()
        printed = self.print_document()
        # Whole-document equality: the product prints the very string it previewed, so a path that
        # rebuilt the paper from the print-time re-read could not pass by coincidence.
        self.assertEqual([previewed], printed)
        self.assertIn(section, printed[0])
        self.assertEqual(previewed, self.page.evaluate("ui.srcdoc()"), "printing does not redraw the preview")
        self.assertEqual({"preview": 3, "cite": 2}, self.page.evaluate("ui.counts()"),
                         "print re-reads the evidence beside the existing re-snapshot")

    # ── D13 · no identifier reaches the record ──

    def test_no_identifier_and_no_inserted_text_reach_the_printed_evidence(self):
        # Two reduced shapes on purpose: the server's exact five keys, and a deliberate superset
        # that still carries every identifier, so the suppression is asserted against the harder one.
        self.open(cite=ok([entry(), reduced(),
                           entry(cid=CID + "9", field="recommendation",
                                 state="source-unavailable", insertedText=None)]))
        srcdoc = self.page.evaluate("ui.srcdoc()")
        for sentinel in SENTINELS:
            self.assertNotIn(sentinel, srcdoc, "the record must not carry " + sentinel)
        section = self.section()
        # The sentence belongs to the body above; the evidence section never repeats it.
        self.assertIn(BODY_LINE, srcdoc)
        self.assertNotIn(BODY_LINE, section)
        self.assertIn("이 인용의 소견을 지금 확인할 수 없습니다", section, "a reduced entry keeps its place")

    # ── D15 · a late answer after 닫기 has no paper to paint ──

    def test_a_late_citation_answer_after_close_paints_nothing(self):
        """close() does not bump selectionEpoch, so check(s) is the only statement that stops the
        continuation of a read that was still out when the dialog closed."""
        self.open(cite=ok([entry(findingRevision=7)]))
        self.page.evaluate("ui.hold(1)")
        self.page.evaluate("ui.queueCite(%s)" % json.dumps(ok([entry(findingRevision=11)]), ensure_ascii=False))
        self.page.evaluate("ui.refresh()")
        self.page.wait_for_function("() => ui.outstanding() === 1")
        self.page.evaluate("ui.close()")
        self.assertTrue(self.page.evaluate("ui.release()"), "the held answer was released")
        self.page.wait_for_function("() => ui.outstanding() === 0")
        self.assertEqual("", self.page.evaluate("ui.srcdoc()"), "a closed dialog has no paper")
        self.assertTrue(self.page.evaluate("ui.printDisabled()"), "and nothing to print")
        self.assertEqual("", self.page.evaluate("ui.status()"))

    # ── D16 · and it can never paint another patient's paper ──

    def test_a_late_citation_answer_cannot_paint_another_patients_paper(self):
        """close → open on a different study is the dangerous shape: without check(s) the first
        study's paper would be drawn into the second study's dialog behind an enabled print button,
        and print()'s own comparison only compares the second study with itself."""
        self.open(cite=ok([entry(findingRevision=11)]))
        self.page.evaluate("ui.hold(1)")
        self.page.evaluate("ui.queueCite(%s)" % json.dumps(ok([entry(findingRevision=11)]), ensure_ascii=False))
        self.page.evaluate("ui.refresh()")
        self.page.wait_for_function("() => ui.outstanding() === 1")
        self.page.evaluate("ui.close()")
        self.page.evaluate("ui.setPreview(%s)" % json.dumps(
            preview_answer(uid=OTHER, name=OTHER_PATIENT, findings="다른 환자의 본문"), ensure_ascii=False))
        self.page.evaluate("ui.setUid(%s)" % json.dumps(OTHER))
        self.page.evaluate("ui.queueCite(%s)" % json.dumps(ok([entry(findingRevision=22)]), ensure_ascii=False))
        self.page.evaluate("ui.open()")
        self.page.wait_for_function("() => ui.srcdoc().includes('소견 r22')")
        self.assertTrue(self.page.evaluate("ui.release()"), "the first study's answer arrives now")
        self.page.wait_for_function("() => ui.outstanding() === 0")
        srcdoc = self.page.evaluate("ui.srcdoc()")
        self.assertIn(OTHER_PATIENT, srcdoc)
        self.assertIn("소견 r22", srcdoc)
        self.assertNotIn("소견 r11", srcdoc, "the first study's evidence must not reach this paper")
        self.assertNotIn("HONG GILDONG", srcdoc, "and neither must the first patient")

    # ── D17 · a session that ended takes the paper with it ──

    def test_an_expired_session_blanks_the_paper_instead_of_drawing_unknown(self):
        self.open(cite={"status": 401, "body": {}}, render=False)
        self.page.wait_for_function("expired => ui.status() === expired", arg=EXPIRED)
        self.assertEqual("", self.page.evaluate("ui.srcdoc()"), "nothing is drawn on a logged-out screen")
        self.assertEqual(EXPIRED, self.page.evaluate("ui.status()"))
        self.assertEqual(1, self.page.evaluate("ui.logouts()"), "the shipped api() ended the session")
        self.assertTrue(self.page.evaluate("ui.printDisabled()"))

    # ── D14 · a head that was never saved has nothing to attest ──

    def test_no_section_and_no_read_when_no_version_has_been_saved(self):
        self.open(cite=ok([entry()]), answer=preview_answer(version=0, action=None, findings=""))
        self.assertIsNone(self.page.evaluate("ui.section()"), "version 0 prints no evidence section")
        self.assertEqual(0, self.page.evaluate("ui.counts().cite"), "and asks for none")
        self.assertIn("저장된 판독문 없음", self.page.evaluate("ui.srcdoc()"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
