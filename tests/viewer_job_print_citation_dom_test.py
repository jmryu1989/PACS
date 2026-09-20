# coding: utf-8
"""TEST-S3-U5-JOB-PRINT-CITATION: the citation evidence on the job print report pages.

REQ-S3-U5-JOB-PRINT-CITATION -> RISK-S3-U5-EVIDENCE-LESS-PAGE / CROSS-STUDY-EVIDENCE /
FALSE-EMPTY / STALE-EVIDENCE-PRINTED / PANEL-TEARDOWN -> TEST-S3-U5-JOB-PRINT-CITATION.

Pure Playwright: the real viewer-job-print.js runs on a blank page beside the two shipped
libraries the viewer lazily loads, with a cornerstone stub, empty cells (so no renderer)
and a synthetic read-only api. No LiveStack, no Orthanc, no database, no original DICOM.

The api stub is a RE-TYPED copy of viewer-jobs.js:110-136, because that function is a
closure inside kinViewerJobs and cannot be loaded standalone. The one rule this file
depends on - 401 or non-foreign 403 ends the panel, every other status is attached to the
error - is pinned against the shipped text by tests/viewer_job_print_citation_test.cjs so
this copy cannot outlive it.

KIN_JOB_PRINT_JS is the override tests/viewer_job_print_citation_mutants.py needs. The
default is always the shipped file and the runner only ever points it at a temporary COPY.
"""
import os
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MODULE = Path(os.environ.get("KIN_JOB_PRINT_JS", ROOT / "worklist-v0" / "hpacs-lite" / "viewer-job-print.js"))
CITATION_MODULE = ROOT / "worklist-v0" / "hpacs-lite" / "report-citation.js"
PAPER_MODULE = ROOT / "worklist-v0" / "hpacs-lite" / "report-preview.js"

UID_A = ("1.2.826.0.1.3680043.8.498." + "1" * 64)[:64]
UID_B = ("1.2.826.0.1.3680043.8.498." + "2" * 64)[:64]
PATIENT_ID = "S3U5-P1"
SELECT = '[aria-label="함께 출력할 판독문"]'

BODY_A = "CURRENT-BODY-LINE"
BODY_B = "COMPARISON-BODY-LINE"

HEADING = "인용된 소견"
LIMITATION = "이 목록은 판독문 문장과 1:1로 대응하지 않습니다."
UNKNOWN = "인용 증적을 확인하지 못했습니다"
REFUSED = "인용 증적을 확인하지 못했습니다 — 접근 권한 밖"
NONE = "인용된 소견 없음"
EDITOR_NOTICE = "현재 편집문 · 미확정 — 인용 증적은 이 출력에 싣지 않습니다. 서버 저장본 출력에서 확인하세요."
# The job print dialog's own wording, not the preview's ('다시 확인을 누르세요').
CHANGED = "출력 내용이 변경되었습니다. 다시 확인하세요."
MISSING = "인용 출력 구성 요소를 불러오지 못했습니다. 다시 확인을 누르세요."
PRESENT = "넣은 문자열이 이 칸에 그대로 있습니다"
ABSENT = "넣은 문자열이 이 칸에 더는 없습니다"
UNAVAILABLE = "이 인용의 소견을 지금 확인할 수 없습니다 — 판독문과 증언은 그대로 있습니다"

# Values that must never reach a printed medical record.
CID = "SENTINELCIDAAAA"
FINDING = "SENTINELFINDINGBBBB"
JOB_REF = "SENTINELJOBCCCC"
MARK_REF = "SENTINELMARKDDDD"
ITEM_REF = "SENTINELITEMEEEE"
SECRET_TEXT = "SENTINELINSERTEDTEXTFFFF"
# The server's refusal sentence must stay on the server, not on a medical record.
PRELIM_SENTINEL = "SENTINELPRELIMDOCGGGG"
IDENTIFIER_SENTINELS = (CID, FINDING, JOB_REF, MARK_REF, ITEM_REF, "918273", "827364")

CORNERSTONE = """() => {
  window.cornerstone = { imageLoader: { registerImageLoader() {} },
    metaData: { addProvider() {}, removeProvider() {} }, utilities: { roundNumber: n => n } };
}"""

SETUP = """args => {
  window.__data = args.data;
  window.__requests = [];
  window.__writes = [];
  window.__ended = false;
  window.__printCalls = 0;
  window.__written = [];
  window.__editorReads = 0;
  const copy = value => JSON.parse(JSON.stringify(value));
  // Per-study queue. When it runs dry the LAST answer repeats, so the print-time
  // re-read agrees with the render unless a case deliberately queues a change.
  const cite = {};
  for (const [uid, queue] of Object.entries(args.citations || {})) cite[uid] = { queue: queue.slice(), last: null };
  const nextCitation = uid => {
    const slot = cite[uid];
    if (!slot) return null;
    if (slot.queue.length) slot.last = slot.queue.shift();
    return slot.last;
  };
  // A re-typed copy of viewer-jobs.js:110-136. Only the parts this unit depends
  // on: the foreign option, the panel-ending statuses and the attached .status.
  const api = async (url, options = {}) => {
    const { foreign = false } = options;
    const method = options.method || 'GET';
    window.__requests.push(method + ' ' + url);
    if (method !== 'GET') { window.__writes.push(method + ' ' + url); throw new Error('write refused'); }
    let reply;
    if (/^\\/studies\\/[^/]+\\/viewer-jobs\\/[^/]+$/.test(url)) reply = { status: 200, body: window.__data.job };
    else {
      const preview = /^\\/studies\\/([^/]+)\\/report-preview$/.exec(url);
      const citations = /^\\/studies\\/([^/]+)\\/report\\/citations$/.exec(url);
      if (preview) reply = window.__data.previews[preview[1]]
        ? { status: 200, body: window.__data.previews[preview[1]] } : { status: 404 };
      else if (citations) reply = nextCitation(citations[1]) || { status: 404 };
      else reply = { status: 404 };
    }
    if (reply.status === 401 || reply.status === 403 && !foreign) {
      window.__ended = true;
      throw new Error('검사 접근 권한을 확인할 수 없습니다.');
    }
    if (reply.status >= 400 || !reply.body) {
      const error = new Error(reply.message || '서버 연결을 확인한 뒤 다시 시도하세요.');
      error.status = reply.status;
      throw error;
    }
    return copy(reply.body);
  };
  const editor = args.editor === false ? undefined : {
    available: () => true,
    read: async () => { window.__editorReads += 1; return copy(args.editorReply); },
    dispose() {},
  };
  // The popup the product prints into; the repo already stubs a popup's print
  // this way. A headless print() would block, and what matters here is whether
  // the product reached it and with which document string.
  window.open = () => ({
    closed: false,
    document: { open() {}, write(html) { window.__written.push(html); }, close() {}, images: [] },
    focus() {}, print() { window.__printCalls += 1; }, close() { this.closed = true; },
  });
  window.__printer = globalThis.kinViewerJobPrint({ api, authenticate: async () => {},
    live: () => !window.__ended, editor });
}"""

READY = ("() => { const s = document.querySelector('#kin-job-print [role=status]');"
         " return !!s && s.textContent.includes('미리보기 내용을 확인'); }")
# Every case that a mutant must break waits for the dialog to STOP working rather
# than for the outcome it expects, and then asserts. Waiting for the expected
# outcome would turn a real defect into a timeout, and a timeout carries none of
# the assertion text the mutant runner adjudicates on.
SETTLED = ("() => { const s = document.querySelector('#kin-job-print [role=status]');"
           " return !!s && !s.textContent.includes('확인하는 중'); }")
PRINT_SETTLED = ("t => window.__printCalls > 0 ||"
                 " document.querySelector('#kin-job-print [role=status]').textContent === t")
SRCDOC = ("m => { const f = document.querySelector('#kin-job-print iframe');"
          " const s = f ? f.getAttribute('srcdoc') : ''; return !!s && s.includes(m); }")
STATUS = "() => document.querySelector('#kin-job-print [role=status]').textContent"


def study(uid, date="20260801", desc="CHEST CT"):
    return dict(uid=uid, id=PATIENT_ID, name="홍 길동", date=date, acc="ACC-1", desc=desc, modality="CT")


def report(version, rs, findings, conclusion="OUTPUT CONCLUSION"):
    return dict(version=version, rs=rs, author="doctor",
                repDoc="doctor" if rs == "A" else None,
                confirm="2026-08-02T00:00:00Z" if rs == "A" else None,
                findings=findings, conclusion=conclusion, recommendation="OUTPUT RECOMMENDATION")


def job(studies):
    return dict(id="job-1", title="S3-U5 JOB", description="synthetic saved comparison",
                authorActor="doctor", createdAt="2026-09-01T00:00:00Z", revision=1,
                snapshot=dict(version=2, rows=1, cols=len(studies), studies=list(studies),
                              cells=[None] * len(studies)))


def entry(field, revision, index, link="current", by="doctor", at="2026-09-01T03:04:05Z", text=BODY_A):
    """The server's real projection for a readable entry, with every value that
    must never reach paper carried as a distinctive sentinel."""
    return dict(cid=CID, field=field, findingId=FINDING, findingRevision=revision, sourceIndex=index,
                sourceRef=dict(jobId=JOB_REF, itemId=ITEM_REF, markId=MARK_REF, sourceRevision=827364),
                headRevisionAtInsert=918273, linkStateAtInsert=link, insertedBy=by, insertedAt=at,
                insertedText=text, sameTextCount=1)


def reduced(by="doctor", at="2026-09-04T01:02:03Z"):
    """A source this reader cannot see: the server drops insertedText and says so."""
    return dict(cid=CID, field="recommendation", state="source-unavailable", insertedBy=by, insertedAt=at)


def answer(version, head):
    return dict(status=200, body=dict(version=version, head=head, draft=[]))


def failure(status, message=None):
    """A refusal. `message` is what the server would have said; the stub puts it on the
    Error exactly as viewer-jobs.js does, so a case can prove the paper never repeats it."""
    reply = dict(status=status)
    if message is not None:
        reply["message"] = message
    return reply


class ViewerJobPrintCitationDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context()
        self.addCleanup(self.context.close)

    # ── fixtures ──

    def pair(self, current_version=1, comparison_version=2, actor_a="doctor", actor_b="doctor2"):
        data = dict(job=job([UID_A, UID_B]), previews={
            UID_A: dict(study=study(UID_A), report=report(current_version, "A", (BODY_A + "\n") * 3),
                        actor=actor_a, canPreviewEditor=True),
            UID_B: dict(study=study(UID_B, "20260901"), report=report(comparison_version, "W", (BODY_B + "\n") * 3),
                        actor=actor_b, canPreviewEditor=False),
        })
        return data

    def single(self, version=1):
        return dict(job=job([UID_A]), previews={
            UID_A: dict(study=study(UID_A), report=report(version, "A", (BODY_A + "\n") * 3),
                        actor="doctor", canPreviewEditor=True)})

    def draft_reply(self, uid=UID_A):
        return dict(owner='["INST-1","subject-1"]', uid=uid, session="s1",
                    editor=dict(findings="DRAFT BODY\n", conclusion="DRAFT CONCLUSION",
                                recommendation="DRAFT RECOMMENDATION"))

    # ── page ──

    def open_page(self, data, citations=None, editor=True, editor_reply=None, modules=True):
        page = self.context.new_page()
        page.set_content("<!doctype html><html><body></body></html>")
        page.evaluate(CORNERSTONE)
        page.add_script_tag(path=str(MODULE))
        if modules:
            page.add_script_tag(path=str(CITATION_MODULE))
            page.add_script_tag(path=str(PAPER_MODULE))
        self.assertEqual(page.evaluate("() => typeof globalThis.kinViewerJobPrint"), "function")
        page.evaluate(SETUP, dict(data=data, citations=citations or {}, editor=editor,
                                  editorReply=editor_reply or self.draft_reply()))
        page.evaluate("uid => window.__printer.open(uid, 'job-1', 2)", data["job"]["snapshot"]["studies"][0])
        return page

    def prepared(self, data, citations=None, choice=None, marker=None, **kwargs):
        page = self.open_page(data, citations, **kwargs)
        page.wait_for_function(READY, timeout=60000)
        if choice:
            self.choose(page, choice, marker)
        return page

    def choose(self, page, choice, marker=None):
        page.select_option(SELECT, choice)
        if marker:
            page.wait_for_function(SRCDOC, arg=marker, timeout=60000)
        page.wait_for_function(READY, timeout=60000)

    def choose_settled(self, page, choice):
        """Select and wait for the dialog to stop working, whatever the outcome."""
        page.select_option(SELECT, choice)
        page.wait_for_function(SETTLED, timeout=60000)

    def print_settled(self, page):
        self.press_print(page)
        page.wait_for_function(PRINT_SETTLED, arg=CHANGED, timeout=60000)

    def status(self, page):
        return page.evaluate(STATUS)

    def srcdoc(self, page):
        return page.get_attribute("#kin-job-print iframe", "srcdoc") or ""

    def sections(self, page):
        """Each report section's uid with its citation block's serialized markup."""
        return page.evaluate("""() => {
          const doc = new DOMParser().parseFromString(
            document.querySelector('#kin-job-print iframe').getAttribute('srcdoc') || '', 'text/html');
          return [...doc.querySelectorAll('section.report')].map(section => ({
            uid: section.dataset.reportUid,
            draft: section.dataset.reportDraft === 'true',
            html: (section.querySelector('section.citations') || {}).outerHTML || '',
            lines: [...section.querySelectorAll('section.citations p.citation')].map(p => p.textContent),
            heading: (section.querySelector('section.citations h3') || {}).textContent || '',
          }));
        }""")

    def citation_requests(self, page):
        return [r for r in page.evaluate("() => window.__requests") if r.endswith("/report/citations")]

    def requests_for(self, page, uid):
        return [r for r in self.citation_requests(page) if uid in r]

    def press_print(self, page):
        page.eval_on_selector("#kin-job-print button:text-is('인쇄 / PDF')", "b => b.click()")

    def assert_no_writes(self, page):
        self.assertEqual(page.evaluate("() => window.__writes"), [])

    # ── cases ──

    def test_01_a_saved_head_prints_its_witness_lines_under_this_readers_permission(self):
        data = self.pair()
        page = self.prepared(data, {UID_A: [answer(1, [entry("findings", 11, 0)])]},
                             "saved", 'data-report-uid="' + UID_A + '"')
        sections = self.sections(page)
        self.assertEqual([s["uid"] for s in sections], [UID_A])
        self.assertEqual(sections[0]["heading"], HEADING)
        lines = sections[0]["lines"]
        # B2: the attribution names THIS study's own reader, not the session and
        # not another study's answer. Without it a reduced line has no referent.
        self.assertEqual(lines[0], "인용 증적 확인: doctor의 열람 권한 기준")
        self.assertEqual(lines[1], LIMITATION)
        self.assertIn("Findings · 소견 r11 · 출처 1번 · 인용 당시 연결 현재 판과 일치 · doctor"
                      " · 2026-09-01 03:04(UTC) — " + PRESENT, lines[2])
        self.assertNotIn(NONE, "\n".join(lines))
        self.assertEqual(len(self.requests_for(page, UID_A)), 2)
        self.assertEqual(self.requests_for(page, UID_B), [])
        self.assert_no_writes(page)

    def test_02_prior_reads_only_the_comparison_study(self):
        data = self.pair()
        page = self.prepared(data, {UID_B: [answer(2, [entry("conclusion", 22, 6, link="revised",
                                                             by="doctor2", text="NOT IN THE BODY")])]},
                             "prior", 'data-report-uid="' + UID_B + '"')
        sections = self.sections(page)
        self.assertEqual([s["uid"] for s in sections], [UID_B])
        lines = sections[0]["lines"]
        self.assertEqual(lines[0], "인용 증적 확인: doctor2의 열람 권한 기준")
        self.assertIn("Conclusion · 소견 r22 · 출처 7번 · 인용 당시 연결 이후 개정됨 · doctor2"
                      " · 2026-09-01 03:04(UTC) — " + ABSENT, lines[2])
        # J1: the current study is previewed but never asked for citations.
        self.assertEqual(self.requests_for(page, UID_A), [])
        self.assertEqual(len(self.requests_for(page, UID_B)), 2)
        self.assert_no_writes(page)

    def test_03_both_keeps_each_studys_evidence_on_its_own_page(self):
        data = self.pair()
        page = self.prepared(data, {
            UID_A: [answer(1, [entry("findings", 11, 0)])],
            UID_B: [answer(2, [entry("conclusion", 22, 6, link="hidden", by="doctor2", text="NOT HERE")])],
        }, "both", 'data-report-uid="' + UID_B + '"')
        sections = self.sections(page)
        self.assertEqual([s["uid"] for s in sections], [UID_A, UID_B])
        first, second = sections[0]["lines"], sections[1]["lines"]
        self.assertEqual(first[0], "인용 증적 확인: doctor의 열람 권한 기준")
        self.assertEqual(second[0], "인용 증적 확인: doctor2의 열람 권한 기준")
        self.assertIn("소견 r11 · 출처 1번", "\n".join(first),
                      "each report page must carry its own study's evidence")
        self.assertIn("소견 r22 · 출처 7번", "\n".join(second),
                      "each report page must carry its own study's evidence")
        # Neither study's line may appear under the other's report.
        self.assertNotIn("소견 r22", "\n".join(first))
        self.assertNotIn("소견 r11", "\n".join(second))
        self.assertEqual(len(self.requests_for(page, UID_A)), 2)
        self.assertEqual(len(self.requests_for(page, UID_B)), 2)
        self.assert_no_writes(page)

    def test_04_a_refused_study_says_so_and_never_ends_the_panel(self):
        data = self.pair()
        page = self.open_page(data, {
            UID_A: [answer(1, [entry("findings", 11, 0)])],
            # The server's 403 names the reviewer who may read it. That sentence is a
            # sentinel here so 'the paper says no more than 접근 권한 밖' is a real assertion
            # rather than a vacuous one against a message the stub never offered.
            UID_B: [failure(403, "예비 판독(RS: P) 중입니다. " + PRELIM_SENTINEL + "만 볼 수 있습니다.")],
        })
        page.wait_for_function(READY, timeout=60000)
        self.choose_settled(page, "both")
        # J4 / foreign:true - a read that only looks for evidence must never be
        # the thing that ends a viewer session, and it must say no more than '밖'.
        self.assertFalse(page.evaluate("() => window.__ended"),
                         "a refused citation read must not end the viewer session")
        self.assertNotEqual(self.srcdoc(page), "",
                            "a refused citation read must not end the viewer session")
        sections = self.sections(page)
        self.assertEqual(len(sections), 2, "a refused citation read must not end the viewer session")
        self.assertIn("소견 r11 · 출처 1번", "\n".join(sections[0]["lines"]))
        self.assertEqual(sections[1]["lines"],
                         ["인용 증적 확인: doctor2의 열람 권한 기준", REFUSED])
        self.assertTrue(page.evaluate("() => document.querySelector('#kin-job-print').open"))
        self.assertFalse(page.eval_on_selector("#kin-job-print button:text-is('다시 확인')", "b => b.disabled"))
        # The reason stays on the server: the paper says '접근 권한 밖' and nothing else.
        self.assertNotIn(PRELIM_SENTINEL, self.srcdoc(page))
        self.assertNotIn("예비 판독", self.srcdoc(page))
        self.assert_no_writes(page)

    def test_05_a_failed_read_loses_only_its_own_section(self):
        data = self.pair()
        page = self.open_page(data, {
            UID_A: [failure(500)],
            UID_B: [answer(2, [entry("conclusion", 22, 6, by="doctor2", text="NOT HERE")])],
        })
        page.wait_for_function(READY, timeout=60000)
        self.choose_settled(page, "both")
        self.assertNotEqual(self.srcdoc(page), "",
                            "one failed citation read must not blank the whole output")
        sections = self.sections(page)
        self.assertEqual(len(sections), 2, "one failed citation read must not blank the whole output")
        self.assertEqual(sections[0]["lines"], ["인용 증적 확인: doctor의 열람 권한 기준", UNKNOWN])
        self.assertIn("소견 r22 · 출처 7번", "\n".join(sections[1]["lines"]))
        # J3: the rest of the paper survives - body, summary and identity.
        srcdoc = self.srcdoc(page)
        self.assertIn(BODY_A, srcdoc)
        self.assertIn(BODY_B, srcdoc)
        self.assertIn("빈 셀", srcdoc)
        self.assertIn("Study " + UID_A, srcdoc)
        self.assertNotIn(NONE, srcdoc)
        self.assert_no_writes(page)

    def test_06_editor_mode_prints_a_notice_and_never_reads_citations(self):
        data = self.pair()
        page = self.prepared(data, {UID_A: [answer(1, [entry("findings", 11, 0)])]},
                             "editor", "DRAFT BODY")
        sections = self.sections(page)
        self.assertEqual(len(sections), 1)
        self.assertTrue(sections[0]["draft"])
        # D3: one fixed notice, zero citation lines and no attribution - no read
        # was made under anyone's permission.
        self.assertEqual(sections[0]["lines"], [EDITOR_NOTICE],
                         "an unconfirmed draft must print the notice and nothing else")
        self.assertNotIn("열람 권한 기준", sections[0]["html"])
        self.assertEqual(self.citation_requests(page), [],
                         "an unconfirmed draft must print the notice and nothing else")
        self.print_settled(page)
        self.assertEqual(page.evaluate("() => window.__printCalls"), 1)
        self.assertEqual(self.citation_requests(page), [])
        self.assertIn(EDITOR_NOTICE, page.evaluate("() => window.__written[0]"))
        self.assert_no_writes(page)

    def test_07_editor_prior_gives_the_draft_a_notice_and_the_comparison_its_evidence(self):
        data = self.pair()
        page = self.prepared(data, {
            UID_A: [answer(1, [entry("findings", 11, 0)])],
            UID_B: [answer(2, [entry("conclusion", 22, 6, by="doctor2", text="NOT HERE")])],
        }, "editor-prior", "DRAFT BODY")
        sections = self.sections(page)
        self.assertEqual([s["draft"] for s in sections], [True, False])
        self.assertEqual(sections[0]["lines"], [EDITOR_NOTICE])
        self.assertEqual(sections[1]["lines"][0], "인용 증적 확인: doctor2의 열람 권한 기준")
        self.assertIn("소견 r22 · 출처 7번", "\n".join(sections[1]["lines"]))
        # Only the comparison study is asked; the draft belongs to no saved version.
        self.assertEqual(self.requests_for(page, UID_A), [])
        self.assertEqual(len(self.requests_for(page, UID_B)), 2)
        self.assert_no_writes(page)

    def test_08_images_only_asks_for_nothing(self):
        data = self.pair()
        page = self.prepared(data, {UID_A: [answer(1, [entry("findings", 11, 0)])]})
        self.assertEqual(self.sections(page), [])
        self.assertEqual(self.citation_requests(page), [])
        self.assertNotIn(HEADING, self.srcdoc(page))
        self.assert_no_writes(page)

    def test_09_no_saved_version_draws_no_section_and_a_missing_library_refuses_the_output(self):
        # A study with nothing saved has no version to speak for, so there is no
        # section and no read - and therefore nothing for the library to do.
        page = self.prepared(self.single(version=0), {}, "saved", "저장된 판독문 없음")
        self.assertEqual(self.sections(page)[0]["html"], "")
        self.assertEqual(self.citation_requests(page), [])
        page.close()
        # D-U5-4: with a page that DOES need evidence and no library to write it,
        # the only honest answer is to refuse. Printing 'unconfirmed' would need a
        # second copy of that wording here; printing nothing would make a signed
        # report look exactly like one with nothing to cite. Both arms are checked:
        # either library alone missing must refuse.
        for missing in ("KinReportPaper", "KinReportCitation"):
            with self.subTest(missing=missing):
                page = self.prepared(self.pair(), {UID_A: [answer(1, [entry("findings", 11, 0)])]})
                page.evaluate("name => { delete globalThis[name]; }", missing)
                self.assertEqual(page.evaluate("name => typeof globalThis[name]", missing), "undefined")
                page.select_option(SELECT, "saved")
                page.wait_for_function("t => document.querySelector('#kin-job-print [role=status]').textContent === t",
                                       arg=MISSING, timeout=60000)
                self.assertEqual(self.srcdoc(page), "")
                self.assertTrue(page.eval_on_selector("#kin-job-print button:text-is('인쇄 / PDF')",
                                                      "b => b.disabled"))
                # 'none' is unaffected: it needs no evidence, so it still prepares.
                self.choose(page, "none")
                self.assertIn("빈 셀", self.srcdoc(page))
                self.assert_no_writes(page)
                page.close()

    def test_10_an_answer_for_another_version_is_unknown(self):
        data = self.pair()
        page = self.prepared(data, {
            UID_A: [answer(1, [entry("findings", 11, 0)])],
            UID_B: [answer(1, [entry("conclusion", 22, 6, by="doctor2")])],
        }, "both", 'data-report-uid="' + UID_B + '"')
        sections = self.sections(page)
        # Only the study whose answer does not belong to its head goes unknown.
        self.assertIn("소견 r11 · 출처 1번", "\n".join(sections[0]["lines"]))
        self.assertEqual(sections[1]["lines"], ["인용 증적 확인: doctor2의 열람 권한 기준", UNKNOWN],
                         "an answer for another version must not be printed")
        self.assertNotIn("소견 r22", self.srcdoc(page),
                         "an answer for another version must not be printed")
        self.assert_no_writes(page)

    def test_11_a_malformed_two_hundred_is_unknown_and_never_an_empty_list(self):
        broken = [
            ("head is not an array", dict(version=1, head={}, draft=[])),
            ("draft is missing", dict(version=1, head=[])),
            ("version is not an integer", dict(version="1", head=[], draft=[])),
            ("a null entry", dict(version=1, head=[None], draft=[])),
            ("an unknown field", dict(version=1, head=[dict(entry("findings", 11, 0), field="history")], draft=[])),
        ]
        for name, body in broken:
            with self.subTest(case=name):
                page = self.prepared(self.pair(), {UID_A: [dict(status=200, body=body)]},
                                     "saved", 'data-report-uid="' + UID_A + '"')
                self.assertEqual(self.sections(page)[0]["lines"],
                                 ["인용 증적 확인: doctor의 열람 권한 기준", UNKNOWN])
                self.assertNotIn(NONE, self.srcdoc(page))
                self.assert_no_writes(page)
                page.close()
        # A valid answer with nothing in it is the ONLY route to '없음'.
        page = self.prepared(self.pair(), {UID_A: [answer(1, [])]}, "saved",
                             'data-report-uid="' + UID_A + '"')
        self.assertEqual(self.sections(page)[0]["lines"],
                         ["인용 증적 확인: doctor의 열람 권한 기준", NONE])

    def test_12_print_refuses_when_the_evidence_changed_since_the_render(self):
        data = self.pair()
        # Two identical answers for the render (prepare reads twice), then a
        # different head for the print-time re-read.
        page = self.prepared(data, {UID_A: [
            answer(1, [entry("findings", 11, 0)]),
            answer(1, [entry("findings", 11, 0)]),
            answer(1, [entry("findings", 11, 0), entry("conclusion", 33, 1, by="doctor2")]),
        ]}, "saved", 'data-report-uid="' + UID_A + '"')
        self.print_settled(page)
        # No new comparison and no new wording: the existing equal() on the print
        # path carries the evidence because it lives inside state()'s data.
        self.assertEqual(page.evaluate("() => window.__printCalls"), 0,
                         "a changed head must refuse the print")
        self.assertEqual(page.evaluate("() => window.__written"), [],
                         "a changed head must refuse the print")
        self.assertEqual(self.status(page), CHANGED)
        self.assert_no_writes(page)

    def test_13_a_draft_only_change_does_not_refuse_the_print(self):
        data = self.pair()
        head = [entry("findings", 11, 0)]
        # C6/J5: the answer's draft array cannot reach this paper, so comparing it
        # would refuse a print for a change the page could never show.
        changed_draft = dict(status=200, body=dict(version=1, head=head,
                                                   draft=[entry("findings", 99, 4, by="doctor2")]))
        page = self.prepared(data, {UID_A: [answer(1, head), answer(1, head), changed_draft]},
                             "saved", 'data-report-uid="' + UID_A + '"')
        srcdoc = self.srcdoc(page)
        self.print_settled(page)
        self.assertEqual(page.evaluate("() => window.__printCalls"), 1,
                         "draft-only change must not refuse the print")
        written = page.evaluate("() => window.__written")
        self.assertEqual(len(written), 1, "draft-only change must not refuse the print")
        self.assertEqual(written[0], srcdoc, "draft-only change must not refuse the print")
        self.assertIn("소견 r11 · 출처 1번", written[0])
        self.assertNotIn("소견 r99", written[0])
        self.assertNotEqual(self.status(page), CHANGED)
        self.assert_no_writes(page)

    def test_14_the_section_stays_inside_its_report_and_carries_no_identifier(self):
        data = self.pair()
        page = self.prepared(data, {
            UID_A: [answer(1, [entry("findings", 11, 0, text=SECRET_TEXT), reduced()])],
            UID_B: [answer(2, [entry("conclusion", 22, 6, by="doctor2", text="NOT HERE")])],
        }, "both", 'data-report-uid="' + UID_B + '"')
        sections = self.sections(page)
        # Reduced entries survive as reduced: the count is preserved and the line
        # claims nothing about the body.
        self.assertIn(UNAVAILABLE, sections[0]["lines"][-1])
        self.assertEqual(len([line for line in sections[0]["lines"] if "Findings" in line or
                              "Recommendation" in line]), 2)
        # Structure: the block is a child of its own report section, each entry
        # avoids splitting, and the heading is an h3 beside the field labels.
        structure = page.evaluate("""() => {
          const doc = new DOMParser().parseFromString(
            document.querySelector('#kin-job-print iframe').getAttribute('srcdoc') || '', 'text/html');
          const blocks = [...doc.querySelectorAll('section.citations')];
          return { count: blocks.length,
                   inside: blocks.every(b => b.parentElement && b.parentElement.classList.contains('report')),
                   heading: blocks.every(b => b.firstElementChild && b.firstElementChild.tagName === 'H3'),
                   afterFields: blocks.every(b => !!b.previousElementSibling &&
                     b.previousElementSibling.dataset.reportField === 'recommendation'),
                   css: (doc.querySelector('style') || {}).textContent || '' };
        }""")
        self.assertEqual(structure["count"], 2)
        self.assertTrue(structure["inside"])
        self.assertTrue(structure["heading"])
        self.assertTrue(structure["afterFields"])
        self.assertIn(".citation{break-inside:avoid;margin:3px 0}", structure["css"])
        # J8: identifier sentinels must be absent from the WHOLE document - an
        # attribute or a comment is invisible to textContent - while insertedText
        # is only forbidden inside the citation subtree, because a body may
        # legitimately contain the same words.
        whole = self.srcdoc(page)
        for secret in IDENTIFIER_SENTINELS:
            self.assertNotIn(secret, whole, secret)
        for section in sections:
            self.assertNotIn(SECRET_TEXT, section["html"])
        # The reference blocks still carry the original DICOM identity they exist for.
        self.assertIn("Study " + UID_A, whole)
        self.assert_no_writes(page)
        # Real pagination is not observable in a headless DOM; the PDF gate in
        # tests/viewer_job_print_pages_test.py owns that. UNVERIFIED here.


if __name__ == "__main__":
    import sys
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
