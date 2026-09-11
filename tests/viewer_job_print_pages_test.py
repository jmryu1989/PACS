# coding: utf-8
"""TEST-D09-OUTPUT-IDENTITY: printed page identity of the job print dialog.

Pure Playwright: the real viewer-job-print.js module runs on a blank page with a
cornerstone stub and a synthetic read-only api, so no LiveStack, no Orthanc, no
database and no original DICOM is involved. Empty cells keep the renderer out.
"""
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright
from pypdf import PdfReader

try:
    import pypdfium2
except ImportError:
    pypdfium2 = None

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "worklist-v0" / "hpacs-lite" / "viewer-job-print.js"
SELECT = '[aria-label="함께 출력할 판독문"]'
UID_A = ("1.2.826.0.1.3680043.8.498." + "1" * 64)[:64]
UID_B = ("1.2.826.0.1.3680043.8.498." + "2" * 64)[:64]
PATIENT_ID = "OUTPUT-IDENTITY-P1"
CURRENT_MARK = "CURRENT-BODY-LINE"
COMPARISON_MARK = "COMPARISON-BODY-LINE"
# The @page bottom margin is 24mm; footer content must stay inside it.
BOTTOM_MARGIN_PT = 24 * 72 / 25.4

CORNERSTONE = """() => {
  window.cornerstone = { imageLoader: { registerImageLoader() {} },
    metaData: { addProvider() {}, removeProvider() {} }, utilities: { roundNumber: n => n } };
}"""

SETUP = """data => {
  window.__writes = [];
  window.__data = data;
  const copy = value => JSON.parse(JSON.stringify(value));
  const api = async (path, options) => {
    const method = (options && options.method) || 'GET';
    if (method !== 'GET') { window.__writes.push(method + ' ' + path); throw new Error('write refused'); }
    if (/^\\/studies\\/[^/]+\\/viewer-jobs\\/[^/]+$/.test(path)) return copy(window.__data.job);
    const preview = /^\\/studies\\/([^/]+)\\/report-preview$/.exec(path);
    if (preview && window.__data.previews[preview[1]]) return copy(window.__data.previews[preview[1]]);
    throw new Error('unexpected request ' + path);
  };
  window.__printer = globalThis.kinViewerJobPrint({ api, authenticate: async () => {}, live: () => true });
}"""

# TEST-D09-EDITOR-COMPARE-OUTPUT: the unsaved body arrives only through the
# injected adapter, so the stub answers are the only source of this text.
LINK_MODULE = ROOT / "worklist-v0" / "hpacs-lite" / "viewer-editor-link.js"
DRAFT_MARK = "DRAFT-BODY-LINE"

EDITOR_SETUP = """args => {
  window.__writes = [];
  window.__data = args.data;
  window.__reads = 0;
  window.__replies = args.replies || [];
  const copy = value => JSON.parse(JSON.stringify(value));
  const api = async (path, options) => {
    const method = (options && options.method) || 'GET';
    if (method !== 'GET') { window.__writes.push(method + ' ' + path); throw new Error('write refused'); }
    if (/^\\/studies\\/[^/]+\\/viewer-jobs\\/[^/]+$/.test(path)) return copy(window.__data.job);
    const preview = /^\\/studies\\/([^/]+)\\/report-preview$/.exec(path);
    if (preview && window.__data.previews[preview[1]]) return copy(window.__data.previews[preview[1]]);
    throw new Error('unexpected request ' + path);
  };
  const editor = args.adapter === false ? undefined : {
    available: () => args.available !== false,
    read: async () => {
      window.__reads++;
      const step = window.__replies.length > 1 ? window.__replies.shift() : window.__replies[0];
      return copy(step);
    },
    dispose() {},
  };
  window.__printer = globalThis.kinViewerJobPrint({ api, authenticate: async () => {}, live: () => true, editor });
}"""

# about:blank children share this origin, so the factory's origin and source
# checks run for real: one frame answers, the other relays the same answer.
RESPONDER = """
window.addEventListener('message', function (event) {
  var data = event.data;
  if (!data || data.type !== 'kin-editor-request') return;
  if (window.__mode === 'silent') return;
  if (window.__mode === 'forward') {
    parent.frames[1].postMessage({ type: 'kin-editor-relay', request: data }, event.origin);
    return;
  }
  parent.postMessage({ type: 'kin-editor-reply', request: data.request, result: window.__result || 'ok',
    owner: data.owner, studies: data.studies, activeUid: data.activeUid,
    session: window.__session || 's1', editor: parent.__body }, event.origin);
});
"""

OTHER = """
window.addEventListener('message', function (event) {
  var relay = event.data;
  if (!relay || relay.type !== 'kin-editor-relay') return;
  var data = relay.request;
  parent.postMessage({ type: 'kin-editor-reply', request: data.request, result: 'ok',
    owner: data.owner, studies: data.studies, activeUid: data.activeUid,
    session: 's1', editor: parent.__body }, event.origin);
});
"""

FACTORY_SETUP = """args => {
  window.__writes = [];
  window.__data = args.data;
  window.__body = args.body;
  const copy = value => JSON.parse(JSON.stringify(value));
  const api = async (path, options) => {
    const method = (options && options.method) || 'GET';
    if (method !== 'GET') { window.__writes.push(method + ' ' + path); throw new Error('write refused'); }
    if (/^\\/studies\\/[^/]+\\/viewer-jobs\\/[^/]+$/.test(path)) return copy(window.__data.job);
    const preview = /^\\/studies\\/([^/]+)\\/report-preview$/.exec(path);
    if (preview && window.__data.previews[preview[1]]) return copy(window.__data.previews[preview[1]]);
    throw new Error('unexpected request ' + path);
  };
  const frame = () => new Promise(resolve => {
    const node = document.createElement('iframe');
    node.src = 'about:blank';
    node.onload = () => resolve(node);
    document.body.append(node);
  });
  return (async () => {
    const responder = await frame(), other = await frame();
    const inject = (node, code) => {
      const doc = node.contentDocument, script = doc.createElement('script');
      script.textContent = code; doc.body.append(script);
    };
    inject(responder, args.responderCode); inject(other, args.otherCode);
    window.__responder = responder; window.__other = other;
    responder.contentWindow.__mode = 'reply';
    const editor = window.kinViewerEditorLink({ studies: args.studies, owner: () => args.owner,
      live: () => true, target: responder.contentWindow, origin: location.origin, timeoutMs: args.timeoutMs });
    window.__editor = editor;
    window.__printer = globalThis.kinViewerJobPrint({ api, authenticate: async () => {}, live: () => true, editor });
  })();
}"""

STATUS_IS = ("t => { const s = document.querySelector('#kin-job-print [role=status]');"
             " return !!s && s.textContent === t; }")
CHOOSE = """value => { const s = document.querySelector('[aria-label="함께 출력할 판독문"]');
  s.value = value; s.dispatchEvent(new Event('change')); }"""

READY = ("() => { const s = document.querySelector('#kin-job-print [role=status]');"
         " return !!s && s.textContent.includes('미리보기 내용을 확인'); }")
SRCDOC = ("m => { const f = document.querySelector('#kin-job-print iframe');"
          " const s = f ? f.getAttribute('srcdoc') : ''; return !!s && s.includes(m); }")


def flat(text):
    return re.sub(r"\s+", "", text)


def study(uid, date, name="홍 길동", desc="CHEST CT", acc="ACC-0001"):
    return dict(uid=uid, id=PATIENT_ID, name=name, date=date, acc=acc, desc=desc, modality="CT")


def report(version, rs, findings):
    return dict(version=version, rs=rs, author="doctor",
                repDoc="doctor" if rs == "A" else None,
                confirm="2026-08-02T00:00:00Z" if rs == "A" else None,
                findings=findings, conclusion="OUTPUT CONCLUSION", recommendation="OUTPUT RECOMMENDATION")


def job(studies):
    return dict(id="job-1", title="OUTPUT IDENTITY JOB", description="synthetic saved comparison",
                authorActor="doctor", createdAt="2026-09-01T00:00:00Z", revision=1,
                snapshot=dict(version=2, rows=1, cols=len(studies), studies=list(studies),
                              cells=[None] * len(studies)))


def runs(pdf_page):
    """Text runs as (y, x, text) in page space; Chromium flips y through cm."""
    collected = []

    def visitor(text, cm, tm, font_dict, font_size):
        if text and text.strip():
            x = tm[4] * cm[0] + tm[5] * cm[2] + cm[4]
            y = tm[4] * cm[1] + tm[5] * cm[3] + cm[5]
            collected.append((float(y), float(x), text))

    pdf_page.extract_text(visitor_text=visitor)
    return collected


def lines(rows):
    """Text lines from runs: grouped by baseline, kept in content-stream order.

    Chromium emits one run per font. Where a fallback font splits a Korean/Latin
    line (Linux CI: Liberation Sans + WenQuanYi Zen Hei), pypdf reports the x of
    the line start again for the Latin runs after a switch, so ordering by x
    would scramble the line (validate run 34614012107, test_pages_03). The
    baselines of those runs are identical and the stream order of a
    left-to-right line is its visual order, so x never decides the order.
    """
    grouped = {}
    for y, x, text in rows:
        grouped.setdefault(round(y, 1), []).append(text)
    return ["".join(group) for _, group in sorted(grouped.items(), reverse=True)]


class ViewerJobPrintPages(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.evidence = Path(os.environ.get("KIN_EVIDENCE_DIR") or tempfile.mkdtemp(prefix="kin-output-identity-"))
        cls.evidence.mkdir(parents=True, exist_ok=True)
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context()
        self.addCleanup(self.context.close)

    def data(self, current_date, comparison_date, current=None, comparison=None,
             current_report=None, comparison_report=None):
        current = current or study(UID_A, current_date)
        comparison = comparison or study(UID_B, comparison_date)
        current["date"] = current_date
        comparison["date"] = comparison_date
        return dict(job=job([UID_A, UID_B]), previews={
            UID_A: dict(study=current, report=current_report or report(1, "A", (CURRENT_MARK + "\n") * 80)),
            UID_B: dict(study=comparison, report=comparison_report or report(2, "W", (COMPARISON_MARK + "\n") * 80)),
        })

    def prepared(self, data, choice=None, marker=None):
        page = self.context.new_page()
        page.set_content("<!doctype html><html><body></body></html>")
        page.evaluate(CORNERSTONE)
        page.add_script_tag(path=str(MODULE))
        self.assertEqual(page.evaluate("() => typeof globalThis.kinViewerJobPrint"), "function")
        self.assertEqual(page.evaluate("() => typeof globalThis.kinViewerJobPrintIdentity"), "object")
        page.evaluate(SETUP, data)
        page.evaluate("uid => window.__printer.open(uid, 'job-1', 2)", data["job"]["snapshot"]["studies"][0])
        page.wait_for_function(READY, timeout=60000)
        if choice:
            page.select_option(SELECT, choice)
            page.wait_for_function(SRCDOC, arg=marker, timeout=60000)
            page.wait_for_function(READY, timeout=60000)
        return page

    def options(self, page):
        return page.eval_on_selector_all(SELECT + " option", "os => os.map(o => [o.value, o.textContent])")

    def srcdoc(self, page):
        return page.get_attribute("#kin-job-print iframe", "srcdoc")

    def printed(self, srcdoc, name):
        sheet = self.context.new_page()
        sheet.set_content(srcdoc)
        path = self.evidence / name
        sheet.pdf(path=str(path), prefer_css_page_size=True)
        sheet.close()
        return PdfReader(str(path)), path

    def no_writes(self, page):
        self.assertEqual(page.evaluate("() => window.__writes"), [])

    def test_pages_01_later_comparison_keeps_page_identity(self):
        data = self.data("20260801", "20260901")
        page = self.prepared(data, "both", 'data-report-uid="' + UID_B + '"')
        srcdoc = self.srcdoc(page)
        self.assertNotIn("과거", srcdoc)
        self.assertIn("현재 검사보다 이후", srcdoc)
        reader, path = self.printed(srcdoc, "later-both.pdf")
        texts = [sheet.extract_text() for sheet in reader.pages]
        flats = [flat(text) for text in texts]
        total = len(texts)
        self.assertGreaterEqual(total, 4)
        self.assertNotIn("과거", "\n".join(texts))
        current = [i for i, text in enumerate(flats) if CURRENT_MARK in text]
        comparison = [i for i, text in enumerate(flats) if COMPARISON_MARK in text]
        self.assertGreaterEqual(len(current), 2, texts)
        self.assertGreaterEqual(len(comparison), 2, texts)
        self.assertEqual(set(current) & set(comparison), set())
        self.assertIn(0, current)
        for index in current:
            self.assertIn(flat("Current Study Report"), flats[index])
            self.assertIn(flat("Study " + UID_A), flats[index])
            self.assertIn(flat("승인된 저장본 · v1 · RS A"), flats[index])
            self.assertIn(PATIENT_ID, flats[index])
            self.assertNotIn(UID_B, flats[index])
        for index in comparison:
            self.assertIn(flat("Comparison Study Report"), flats[index])
            self.assertIn(flat("Study " + UID_B), flats[index])
            self.assertIn(flat("미승인 저장본 · v2"), flats[index])
            self.assertIn(flat("현재 검사보다 이후"), flats[index])
            self.assertIn(PATIENT_ID, flats[index])
            self.assertNotIn(UID_A, flats[index])
        images = [i for i, text in enumerate(flats) if flat("빈 셀") in text]
        self.assertTrue(images, texts)
        self.assertEqual(set(images) & (set(current) | set(comparison)), set())
        for index in images:
            self.assertIn(flat("환자 홍 길동 (" + PATIENT_ID + ")"), flats[index])
            self.assertIn(flat("Current Study Report:"), flats[index])
            self.assertIn(flat("Comparison Study Report:"), flats[index])
        for index in range(total):
            self.assertIn("%d/%d" % (index + 1, total), flats[index])
            owners = [uid for uid in (UID_A, UID_B) if uid in flats[index]]
            self.assertEqual(len(owners), 0 if index in images else 1,
                             "page %d names %d studies" % (index + 1, len(owners)))
        print("OUTPUT IDENTITY LATER PDF pages=%d path=%s" % (total, path), flush=True)
        self.no_writes(page)

    def test_pages_02_date_variants_named_by_relation(self):
        variants = [
            ("same", "20260801", "20260801", "20260801", "현재 검사와 같은 날짜 · 선후 미확인"),
            ("earlier", "20260801", "20260701", "20260701", "현재 검사보다 이전"),
            ("nodate", "20260801", "", "날짜 없음", "검사일 확인 불가 · 선후 미확인"),
            ("bad", "20260801", "BADDATE1", "BADDATE1", "검사일 확인 불가 · 선후 미확인"),
            ("badcurrent", "BADCURRENT", "20260901", "20260901", "검사일 확인 불가 · 선후 미확인"),
        ]
        for name, current_date, comparison_date, shown, relation in variants:
            with self.subTest(variant=name):
                data = self.data(current_date, comparison_date)
                page = self.prepared(data, "both", 'data-report-uid="' + UID_B + '"')
                srcdoc = self.srcdoc(page)
                options = dict(self.options(page))
                self.assertNotIn("과거", srcdoc)
                self.assertNotIn("과거", "".join(options.values()))
                self.assertIn(shown, options["prior"])
                self.assertEqual(options["prior"],
                                 "Comparison study report (%s · CHEST CT · Acc ACC-0001)" % shown)
                self.assertEqual(options["both"], "Current + comparison study reports")
                self.assertIn("검사일 %s · %s" % (shown, relation), srcdoc)
                self.assertIn("Comparison Study Report: %s · %s · 미승인 저장본 · v2 · RS W" % (shown, relation), srcdoc)
                self.assertIn("Comparison Study Report", srcdoc)
                self.no_writes(page)
                if name == "nodate":
                    reader, _ = self.printed(srcdoc, "nodate-both.pdf")
                    texts = [sheet.extract_text() for sheet in reader.pages]
                    self.assertNotIn("과거", "\n".join(texts))
                    comparison_pages = [flat(text) for text in texts if COMPARISON_MARK in flat(text)]
                    self.assertTrue(comparison_pages, texts)
                    for text in comparison_pages:
                        self.assertIn(flat("Comparison Study Report · 날짜 없음 · " + relation), text)
                        self.assertIn(flat("Study " + UID_B), text)
                page.close()

    def test_pages_03_long_identity_stays_in_the_bottom_margin(self):
        name = " ".join("NAME%02d" % index for index in range(13))
        desc = ("DESCRIPTION-" * 6)[:64]
        acc = "ACC-0123456789AB"
        self.assertEqual((len(name), len(desc), len(acc), len(UID_A), len(UID_B)), (90, 64, 16, 64, 64))
        data = self.data("20260801", "20260901",
                         current=study(UID_A, "20260801", name=name, desc=desc, acc=acc),
                         comparison=study(UID_B, "20260901", name=name, desc=desc, acc=acc))
        page = self.prepared(data, "both", 'data-report-uid="' + UID_B + '"')
        srcdoc = self.srcdoc(page)
        self.assertNotIn("과거", srcdoc)
        reader, path = self.printed(srcdoc, "long-identity-both.pdf")
        self.assertGreaterEqual(len(reader.pages), 4)
        seen = {CURRENT_MARK: 0, COMPARISON_MARK: 0, "summary": 0}
        for index, sheet in enumerate(reader.pages):
            rows = runs(sheet)
            self.assertTrue(rows, "page %d has no text" % (index + 1))
            footer = [row for row in rows if row[0] < BOTTOM_MARGIN_PT]
            self.assertTrue(footer, "page %d has no footer text" % (index + 1))
            # Drop the @bottom-right page counter so the left box reads in order.
            footer_lines = [flat(line) for line in lines(footer) if not re.fullmatch(r"[\d/]+", flat(line))]
            footer_text = "".join(footer_lines)
            whole = flat(sheet.extract_text())
            lowest_footer = max(y for y, _, _ in footer)
            self.assertLess(lowest_footer, BOTTOM_MARGIN_PT)
            if flat("빈 셀") in whole:
                seen["summary"] += 1
                self.assertIn(flat("환자 " + name + " (" + PATIENT_ID + ")"), footer_text)
                self.assertIn(flat("Current Study Report:"), footer_text)
                self.assertIn(flat("Comparison Study Report:"), footer_text)
                continue
            owners = [uid for uid in (UID_A, UID_B) if uid in footer_text]
            self.assertEqual(len(owners), 1, "page %d footer names %r" % (index + 1, footer_lines))
            uid = owners[0]
            mark = CURRENT_MARK if uid == UID_A else COMPARISON_MARK
            title = "Current Study Report" if uid == UID_A else "Comparison Study Report"
            if mark in whole:
                seen[mark] += 1
            self.assertTrue(any(flat("Study " + uid) in line for line in footer_lines),
                            "page %d footer lost the study uid: %r" % (index + 1, footer_lines))
            # The identity line may wrap inside the margin box; the uid may not.
            self.assertIn(flat(name + " (" + PATIENT_ID + ") · " + desc + " · Acc " + acc), footer_text,
                          "page %d footer lost the identity line: %r" % (index + 1, footer_lines))
            self.assertIn(flat(title), footer_text)
            marks = [y for y, _, text in rows if mark in text]
            if marks:
                self.assertGreater(min(marks), BOTTOM_MARGIN_PT,
                                   "page %d body text entered the bottom margin" % (index + 1))
                self.assertGreater(min(marks), lowest_footer)
        self.assertGreaterEqual(seen[CURRENT_MARK], 2)
        self.assertGreaterEqual(seen[COMPARISON_MARK], 2)
        self.assertGreaterEqual(seen["summary"], 1)
        if pypdfium2 is not None:
            document = pypdfium2.PdfDocument(str(path))
            try:
                for index in range(len(document)):
                    target = self.evidence / ("long-identity-page-%02d.png" % (index + 1))
                    document[index].render(scale=2).to_pil().save(str(target))
                    print("OUTPUT IDENTITY PNG " + str(target), flush=True)
            finally:
                document.close()
        self.no_writes(page)

    def test_pages_04_single_study_offers_only_the_current_report(self):
        data = dict(job=job([UID_A]), previews={
            UID_A: dict(study=study(UID_A, "20260801"), report=report(1, "A", (CURRENT_MARK + "\n") * 80))})
        page = self.prepared(data, "saved", 'data-report-uid="' + UID_A + '"')
        # The unsaved-draft choice is listed for a single study too; no
        # comparison choice may appear (TEST-D09-EDITOR-COMPARE-OUTPUT).
        self.assertEqual(self.options(page), [["none", "Images only"], ["saved", "Current study report"],
                                              ["editor", "Current study draft (unsaved)"]])
        srcdoc = self.srcdoc(page)
        self.assertEqual(srcdoc.count("data-report-uid="), 1)
        self.assertIn("Current Study Report", srcdoc)
        self.assertNotIn("Comparison Study Report", srcdoc)
        self.assertNotIn("과거", srcdoc)
        self.assertIn("검사일 20260801 · 현재 검사", srcdoc)
        reader, _ = self.printed(srcdoc, "single-saved.pdf")
        flats = [flat(sheet.extract_text()) for sheet in reader.pages]
        self.assertGreaterEqual(len(flats), 2)
        current = [text for text in flats if CURRENT_MARK in text]
        self.assertGreaterEqual(len(current), 2)
        for text in current:
            self.assertIn(flat("Current Study Report · 20260801"), text)
            self.assertIn(flat("Study " + UID_A), text)
            self.assertIn(flat("승인된 저장본 · v1 · RS A"), text)
            self.assertNotIn(flat("Comparison Study Report"), text)
        self.no_writes(page)

    # Two ways a browser can lack named @page support: an old parser throws,
    # a lenient one silently drops the unknown rule and keeps the rest. The
    # gate must close the print path in both, so both are simulated.
    UNSUPPORTED_NAMED_PAGES = {
        "throws": """() => {
          const original = CSSStyleSheet.prototype.replaceSync;
          CSSStyleSheet.prototype.replaceSync = function (text) {
            if (/@page\\s+report-\\d+/.test(String(text))) throw new SyntaxError('named pages unsupported');
            return original.call(this, text);
          };
        }""",
        "drops": """() => {
          const original = CSSStyleSheet.prototype.replaceSync;
          CSSStyleSheet.prototype.replaceSync = function (text) {
            return original.call(this, String(text).replace(/@page\\s+report-\\d+\\s*\\{[^]*?\\}\\s*\\}/g, ''));
          };
        }""",
    }
    GATE_STATUS = ("() => document.querySelector('#kin-job-print [role=status]')"
                   ".textContent.includes('페이지 식별정보를 지원하는 Chrome 또는 Edge에서 여세요.')")

    def test_pages_06_named_page_support_gate_blocks_print(self):
        # A browser that parses margin boxes but lacks named @page rules would
        # print continuation pages with only the shared footer, which is
        # exactly what the per-report footer exists to prevent.
        for variant, stub in self.UNSUPPORTED_NAMED_PAGES.items():
            with self.subTest(variant=variant):
                data = self.data("20260801", "20260901")
                page = self.context.new_page()
                page.set_content("<!doctype html><html><body></body></html>")
                page.evaluate(CORNERSTONE)
                page.add_script_tag(path=str(MODULE))
                page.evaluate(stub)
                # The stub must leave the generic @page rule intact so that only
                # the named-page check, not the margin-box check, decides.
                self.assertTrue(page.evaluate("() => { const s = new CSSStyleSheet();"
                                              " s.replaceSync('@page{@bottom-left{content:\"x\"}}');"
                                              " return s.cssRules[0]?.cssRules[0]?.name === 'bottom-left'; }"))
                page.evaluate(SETUP, data)
                page.evaluate("uid => window.__printer.open(uid, 'job-1', 2)", data["job"]["snapshot"]["studies"][0])
                page.wait_for_function(self.GATE_STATUS, timeout=60000)
                self.assertTrue(page.eval_on_selector("#kin-job-print button:text-is('인쇄 / PDF')", "b => b.disabled"))
                # The preview itself is still built; only the print path is closed.
                self.assertIn("<main>", self.srcdoc(page) or "")
                page.select_option(SELECT, "both")
                page.wait_for_function(SRCDOC, arg='data-report-uid="' + UID_B + '"', timeout=60000)
                page.wait_for_function(self.GATE_STATUS, timeout=60000)
                self.assertTrue(page.eval_on_selector("#kin-job-print button:text-is('인쇄 / PDF')", "b => b.disabled"))
                self.no_writes(page)
                page.close()

    # TEST-D09-EDITOR-COMPARE-OUTPUT: the unsaved reading-workspace body reaches
    # the output only through an injected read-only adapter, is named as
    # unfinished on every page it owns, and is never saved or approved.
    def editor_data(self, single=False, can_preview=True, actor="doctor"):
        if single:
            data = dict(job=job([UID_A]), previews={
                UID_A: dict(study=study(UID_A, "20260801"), report=report(1, "A", "SAVED CURRENT\n"))})
        else:
            data = self.data("20260801", "20260901")
        for preview in data["previews"].values():
            preview["actor"] = actor
            preview["canPreviewEditor"] = False
        data["previews"][UID_A]["canPreviewEditor"] = bool(can_preview)
        return data

    def draft_reply(self, findings=None, session="s1", uid=UID_A):
        return dict(owner='["INST-1","subject-1"]', uid=uid, session=session,
                    editor=dict(findings=findings if findings is not None else (DRAFT_MARK + "\n") * 80,
                                conclusion="DRAFT CONCLUSION", recommendation="DRAFT RECOMMENDATION"))

    def editor_page(self, data, replies=None, adapter=True, available=True):
        page = self.context.new_page()
        page.set_content("<!doctype html><html><body></body></html>")
        page.evaluate(CORNERSTONE)
        page.add_script_tag(path=str(LINK_MODULE))
        page.add_script_tag(path=str(MODULE))
        self.assertEqual(page.evaluate("() => typeof globalThis.kinViewerEditorLink"), "function")
        self.assertEqual(page.evaluate("() => typeof globalThis.kinViewerEditorLinkApi"), "object")
        page.evaluate(EDITOR_SETUP, dict(data=data, replies=replies or [], adapter=adapter, available=available))
        page.evaluate("uid => window.__printer.open(uid, 'job-1', 2)", data["job"]["snapshot"]["studies"][0])
        page.wait_for_function(READY, timeout=60000)
        return page

    def editor_prepared(self, data, replies=None, choice="editor", marker=None, **kwargs):
        page = self.editor_page(data, replies, **kwargs)
        page.select_option(SELECT, choice)
        page.wait_for_function(SRCDOC, arg=marker, timeout=60000)
        page.wait_for_function(READY, timeout=60000)
        return page

    def status_text(self, page):
        return page.eval_on_selector("#kin-job-print [role=status]", "s => s.textContent")

    def wait_status(self, page, text):
        page.wait_for_function(STATUS_IS, arg=text, timeout=60000)

    def choose(self, page, value):
        page.evaluate(CHOOSE, value)

    def option_state(self, page):
        return dict(page.eval_on_selector_all(SELECT + " option", "os => os.map(o => [o.value, o.disabled])"))

    def print_disabled(self, page):
        return page.eval_on_selector("#kin-job-print button:text-is('인쇄 / PDF')", "b => b.disabled")

    def test_pages_07_editor_draft_owns_its_pages_as_unsaved(self):
        data = self.editor_data()
        page = self.editor_prepared(data, [self.draft_reply()], "editor", 'data-report-draft="true"')
        srcdoc = self.srcdoc(page)
        self.assertNotIn("과거", srcdoc)
        self.assertEqual(srcdoc.count("data-report-uid="), 1)
        self.assertEqual(srcdoc.count('data-report-draft="true"'), 1)
        self.assertIn("Current Study Report", srcdoc)
        self.assertNotIn("Comparison Study Report", srcdoc)
        self.assertIn("미확정 편집문 · 저장·승인되지 않음", srcdoc)
        self.assertIn("출력 시점의 판독 화면 편집문입니다. 서버에 저장·승인되지 않았습니다.", srcdoc)
        self.assertIn("작성자(편집 중): doctor", srcdoc)
        self.assertNotIn("승인 판독의", srcdoc)
        self.assertNotIn("저장본", srcdoc)
        self.assertNotIn("RS A", srcdoc)
        self.assertIn("검사일 20260801 · 현재 검사", srcdoc)
        # The saved server body of the same study must not be substituted.
        self.assertNotIn(CURRENT_MARK, srcdoc)
        self.assertIn(DRAFT_MARK, srcdoc)
        self.assertEqual(dict(self.options(page))["editor"], "Current study draft (unsaved)")
        reader, path = self.printed(srcdoc, "editor-draft.pdf")
        flats = [flat(sheet.extract_text()) for sheet in reader.pages]
        total = len(flats)
        self.assertGreaterEqual(total, 3)
        draft_pages = [i for i, text in enumerate(flats) if flat(DRAFT_MARK) in text]
        self.assertGreaterEqual(len(draft_pages), 2, flats)
        self.assertIn(0, draft_pages)
        for index in draft_pages:
            self.assertIn(flat("Current Study Report"), flats[index])
            self.assertIn(flat("Study " + UID_A), flats[index])
            self.assertIn(flat("미확정 편집문 · 저장·승인되지 않음"), flats[index])
            self.assertIn(PATIENT_ID, flats[index])
            self.assertNotIn(UID_B, flats[index])
            self.assertNotIn(flat("저장본"), flats[index])
            for stamp in ("RSA", "RSW", "·v1·", "·v2·"):
                self.assertNotIn(stamp, flats[index], stamp)
        for index in range(total):
            self.assertIn("%d/%d" % (index + 1, total), flats[index])
        print("EDITOR DRAFT PDF pages=%d path=%s" % (total, path), flush=True)
        self.no_writes(page)

    def test_pages_08_editor_prior_keeps_each_body_on_its_own_pages(self):
        data = self.editor_data()
        page = self.editor_prepared(data, [self.draft_reply()], "editor-prior",
                                    'data-report-uid="' + UID_B + '"')
        srcdoc = self.srcdoc(page)
        self.assertNotIn("과거", srcdoc)
        self.assertEqual(srcdoc.count('data-report-draft="true"'), 1)
        self.assertEqual(srcdoc.count("data-report-uid="), 2)
        self.assertIn("미승인 저장본 · v2 · RS W", srcdoc)
        self.assertIn("현재 검사보다 이후", srcdoc)
        self.assertNotIn(CURRENT_MARK, srcdoc)
        options = dict(self.options(page))
        self.assertEqual(options["editor-prior"],
                         "Current study draft (unsaved) + comparison study report"
                         " (20260901 · CHEST CT · Acc ACC-0001)")
        self.assertEqual(options["prior"], "Comparison study report (20260901 · CHEST CT · Acc ACC-0001)")
        reader, path = self.printed(srcdoc, "editor-prior.pdf")
        flats = [flat(sheet.extract_text()) for sheet in reader.pages]
        total = len(flats)
        self.assertGreaterEqual(total, 4)
        draft_pages = [i for i, text in enumerate(flats) if flat(DRAFT_MARK) in text]
        comparison = [i for i, text in enumerate(flats) if COMPARISON_MARK in text]
        images = [i for i, text in enumerate(flats) if flat("빈 셀") in text]
        self.assertGreaterEqual(len(draft_pages), 2, flats)
        self.assertGreaterEqual(len(comparison), 2, flats)
        self.assertEqual(set(draft_pages) & set(comparison), set())
        self.assertEqual(set(images) & (set(draft_pages) | set(comparison)), set())
        self.assertIn(0, draft_pages)
        for index in draft_pages:
            self.assertIn(flat("Current Study Report"), flats[index])
            self.assertIn(flat("Study " + UID_A), flats[index])
            self.assertIn(flat("미확정 편집문 · 저장·승인되지 않음"), flats[index])
            self.assertNotIn(UID_B, flats[index])
            # The draft body itself never carries a stored version or approval.
            self.assertNotIn(flat("Current Study Report · 20260801 · 승인"), flats[index])
        for index in comparison:
            self.assertIn(flat("Comparison Study Report"), flats[index])
            self.assertIn(flat("Study " + UID_B), flats[index])
            self.assertIn(flat("미승인 저장본 · v2 · RS W"), flats[index])
            self.assertIn(flat("현재 검사보다 이후"), flats[index])
            self.assertNotIn(UID_A, flats[index])
            self.assertNotIn(flat("미확정"), flats[index])
        for index in range(total):
            self.assertIn("%d/%d" % (index + 1, total), flats[index])
            owners = [uid for uid in (UID_A, UID_B) if uid in flats[index]]
            self.assertEqual(len(owners), 0 if index in images else 1,
                             "page %d names %d studies" % (index + 1, len(owners)))
        print("EDITOR PRIOR PDF pages=%d path=%s" % (total, path), flush=True)
        self.no_writes(page)

    def test_pages_09_editor_refusals_close_the_choice(self):
        denied = self.editor_data(can_preview=False)
        page = self.editor_page(denied, [self.draft_reply()])
        self.choose(page, "editor")
        self.wait_status(page, "편집문 출력 권한이 없습니다.")
        self.assertTrue(self.print_disabled(page))
        self.assertEqual(self.srcdoc(page), "")
        # The saved choices stay usable after the draft choice was refused.
        page.select_option(SELECT, "saved")
        page.wait_for_function(SRCDOC, arg='data-report-uid="' + UID_A + '"', timeout=60000)
        self.no_writes(page)
        page.close()
        reasons = {"session": "판독 화면의 세션이 바뀌었습니다. 다시 연결하세요.",
                   "context": "판독 화면의 편집 대상이 이 검사가 아닙니다.",
                   "modal": "판독 화면의 대화상자를 닫은 뒤 다시 확인하세요.",
                   "unavailable": "판독문 입력란을 확인할 수 없습니다.",
                   "denied": "편집문 출력 권한이 없습니다.",
                   "invalid": "편집문 응답을 확인할 수 없습니다.",
                   "timeout": "판독 화면의 응답이 없습니다. 목록 창에서 영상 창을 다시 연결하세요."}
        for reason, message in reasons.items():
            with self.subTest(reason=reason):
                page = self.editor_page(self.editor_data(), [dict(ok=False, reason=reason)])
                self.choose(page, "editor")
                self.wait_status(page, message)
                self.assertTrue(self.print_disabled(page))
                self.no_writes(page)
                page.close()
        # A reply about another study is refused before any page is built.
        page = self.editor_page(self.editor_data(), [self.draft_reply(uid=UID_B)])
        self.choose(page, "editor")
        self.wait_status(page, "편집문 응답을 확인할 수 없습니다.")
        self.assertEqual(self.srcdoc(page), "")
        self.no_writes(page)

    def test_pages_10_without_a_reading_window_the_draft_choice_is_blocked(self):
        for name, kwargs in [("no adapter", dict(adapter=False)), ("not available", dict(available=False))]:
            with self.subTest(variant=name):
                page = self.editor_page(self.editor_data(), [self.draft_reply()], **kwargs)
                disabled = self.option_state(page)
                self.assertEqual(disabled["editor"], True)
                self.assertEqual(disabled["editor-prior"], True)
                self.assertEqual(disabled["saved"], False)
                self.assertEqual(disabled["both"], False)
                self.choose(page, "editor")
                self.wait_status(page, "연결된 판독 화면이 없습니다."
                                       " 판독 화면에서 연 영상 창에서만 편집문을 출력할 수 있습니다.")
                self.assertTrue(self.print_disabled(page))
                self.no_writes(page)
                page.close()
        # A single-study viewer still offers the draft, but no paired choice.
        page = self.editor_page(self.editor_data(single=True), [self.draft_reply()])
        self.assertEqual([value for value, _ in self.options(page)], ["none", "saved", "editor"])
        self.assertEqual(self.option_state(page)["editor"], False)
        page.select_option(SELECT, "editor")
        page.wait_for_function(SRCDOC, arg='data-report-draft="true"', timeout=60000)
        self.assertIn(DRAFT_MARK, self.srcdoc(page))
        self.no_writes(page)

    def test_pages_11_a_changed_draft_body_refuses_the_output(self):
        data = self.editor_data()
        page = self.editor_page(data, [self.draft_reply(), self.draft_reply(findings="CHANGED WHILE BUILDING")])
        self.choose(page, "editor")
        page.wait_for_function("() => document.querySelector('#kin-job-print [role=status]')"
                               ".textContent.includes('변경되었습니다')", timeout=60000)
        self.assertIn("변경되었습니다", self.status_text(page))
        self.assertTrue(self.print_disabled(page))
        self.assertEqual(self.srcdoc(page), "")
        self.no_writes(page)
        # A session change between the two reads is refused the same way.
        page.close()
        page = self.editor_page(data, [self.draft_reply(), self.draft_reply(session="s2")])
        self.choose(page, "editor")
        page.wait_for_function("() => document.querySelector('#kin-job-print [role=status]')"
                               ".textContent.includes('변경되었습니다')", timeout=60000)
        self.assertEqual(self.srcdoc(page), "")
        self.no_writes(page)

    # crypto.randomUUID needs a secure context, so the real factory runs on a
    # routed https origin whose about:blank children inherit that same origin.
    SECURE = "https://kin-editor-link.test/"

    def factory_page(self, data, timeout_ms=1200):
        page = self.context.new_page()
        page.route(self.SECURE + "**", lambda route: route.fulfill(
            status=200, content_type="text/html", body="<!doctype html><html><body></body></html>"))
        page.goto(self.SECURE)
        page.evaluate(CORNERSTONE)
        page.add_script_tag(path=str(LINK_MODULE))
        page.add_script_tag(path=str(MODULE))
        page.evaluate(FACTORY_SETUP, dict(data=data, studies=[UID_A, UID_B], owner=["INST-1", "subject-1"],
                                          timeoutMs=timeout_ms, responderCode=RESPONDER, otherCode=OTHER,
                                          body=dict(findings=(DRAFT_MARK + "\n") * 80,
                                                    conclusion="DRAFT CONCLUSION",
                                                    recommendation="DRAFT RECOMMENDATION")))
        page.evaluate("uid => window.__printer.open(uid, 'job-1', 2)", UID_A)
        page.wait_for_function(READY, timeout=60000)
        return page

    def test_pages_12_real_link_checks_origin_source_and_silence(self):
        page = self.factory_page(self.editor_data())
        self.assertEqual(self.option_state(page)["editor"], False)
        page.select_option(SELECT, "editor")
        page.wait_for_function(SRCDOC, arg='data-report-draft="true"', timeout=60000)
        page.wait_for_function(READY, timeout=60000)
        srcdoc = self.srcdoc(page)
        self.assertIn(DRAFT_MARK, srcdoc)
        self.assertIn("미확정 편집문 · 저장·승인되지 않음", srcdoc)
        self.assertNotIn(CURRENT_MARK, srcdoc)
        refresh = "#kin-job-print button:text-is('다시 확인')"
        timeout_text = "판독 화면의 응답이 없습니다. 목록 창에서 영상 창을 다시 연결하세요."
        # A well-formed reply relayed from another frame is not this target.
        page.evaluate("() => { window.__responder.contentWindow.__mode = 'forward'; }")
        page.click(refresh)
        self.wait_status(page, timeout_text)
        self.assertEqual(self.srcdoc(page), "")
        # No answer at all ends the same way, without a stuck dialog.
        page.evaluate("() => { window.__responder.contentWindow.__mode = 'silent'; }")
        page.click(refresh)
        self.wait_status(page, timeout_text)
        # A real refusal reaches the dialog through the same checked path.
        page.evaluate("() => { const w = window.__responder.contentWindow;"
                      " w.__mode = 'reply'; w.__result = 'context'; }")
        page.click(refresh)
        self.wait_status(page, "판독 화면의 편집 대상이 이 검사가 아닙니다.")
        page.evaluate("() => { const w = window.__responder.contentWindow;"
                      " w.__mode = 'reply'; w.__result = 'ok'; }")
        page.click(refresh)
        page.wait_for_function(READY, timeout=60000)
        self.assertIn(DRAFT_MARK, self.srcdoc(page))
        self.no_writes(page)

    def test_pages_13_real_link_gates_target_owner_origin_and_cancel(self):
        page = self.factory_page(self.editor_data())
        checks = page.evaluate("""async () => {
          const target = window.__responder.contentWindow, owner = ['INST-1', 'subject-1'];
          const make = extra => window.kinViewerEditorLink(Object.assign({ studies: [%s, %s],
            owner: () => owner, live: () => true, target, origin: location.origin, timeoutMs: 800 }, extra));
          const result = {};
          result.available = make({}).available();
          result.noTarget = make({ target: null }).available();
          result.noOwner = make({ owner: () => null }).available();
          result.notLive = make({ live: () => false }).available();
          result.badOrigin = (await make({ origin: 'https://example.invalid' }).read()).reason;
          const disposed = make({}); disposed.dispose();
          result.disposed = disposed.available();
          const controller = new AbortController(); controller.abort();
          try { await make({}).read(controller.signal); result.cancelled = 'resolved'; }
          catch (error) { result.cancelled = error.message; }
          const pendingLink = make({});
          const pending = pendingLink.read();
          pendingLink.dispose();
          result.pending = (await pending).reason;
          return result;
        }""" % (repr(UID_A), repr(UID_B)))
        self.assertEqual(checks, dict(available=True, noTarget=False, noOwner=False, notLive=False,
                                      badOrigin="timeout", disposed=False,
                                      cancelled="출력 확인이 취소되었습니다.", pending="missing"))
        self.no_writes(page)

    def test_pages_05_preview_never_writes(self):
        data = self.data("20260801", "20260901")
        for choice, marker in [("saved", 'data-report-uid="' + UID_A + '"'),
                               ("prior", 'data-report-uid="' + UID_B + '"'),
                               ("both", 'data-report-uid="' + UID_B + '"')]:
            with self.subTest(choice=choice):
                page = self.prepared(data, choice, marker)
                self.assertNotIn("과거", self.srcdoc(page))
                self.no_writes(page)
                page.close()

    def test_parser_01_keeps_font_runs_in_stream_order(self):
        # The exact runs pypdf reported for the summary-page footer of the CI
        # long-identity PDF (validate run 34614012107, Linux fallback fonts):
        # Korean runs carry their real x, the Latin runs after each font switch
        # repeat the line-start x, and the whole line shares one baseline.
        name = " ".join("NAME%02d" % index for index in range(13))
        latin = "  " + name + " (" + PATIENT_ID + ") · "
        ci_runs = [
            (35.67, 554.23, "7"), (35.67, 557.99, " /"), (28.17, 557.99, "7"),
            (51.42, 33.75, "환자"), (51.42, 33.75, latin), (51.42, 452.54, "검사"), (51.42, 33.75, "  20260801 · Acc ACC-"),
            (43.92, 33.75, "0123456789AB"),
            (36.42, 33.75, "환자"), (36.42, 33.75, latin), (36.42, 452.54, "검사"), (36.42, 33.75, "  20260901 · Acc ACC-"),
            (28.92, 33.75, "0123456789AB"),
            (21.42, 33.75, "Current Study Report: 20260801 · "), (21.42, 125.8, "승인된"), (21.42, 145.47, "저장본"),
            (21.42, 33.75, "  · v1 · RS A"),
        ]
        parsed = [flat(line) for line in lines(ci_runs) if not re.fullmatch(r"[\d/]+", flat(line))]
        self.assertEqual(parsed, [
            flat("환자 " + name + " (" + PATIENT_ID + ") · 검사 20260801 · Acc ACC-"),
            "0123456789AB",
            flat("환자 " + name + " (" + PATIENT_ID + ") · 검사 20260901 · Acc ACC-"),
            "0123456789AB",
            flat("Current Study Report: 20260801 · 승인된 저장본 · v1 · RS A"),
        ])
        self.assertIn(flat("환자 " + name + " (" + PATIENT_ID + ")"), "".join(parsed))
        # A single-font line (Windows: Malgun Gothic) is one run and unaffected.
        self.assertEqual(lines([(18.4, 33.75, "승인된 저장본 · v1 · RS A"), (25.9, 33.75, "Study X")]),
                         ["Study X", "승인된 저장본 · v1 · RS A"])
        # Distinct baselines still separate lines (a lower y is a later line);
        # within a line the stream order decides, never the reported x.
        self.assertEqual(lines([(10.0, 33.75, "second"), (20.0, 90.0, "first-b"), (20.0, 33.75, "first-a")]),
                         ["first-bfirst-a", "second"])


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
