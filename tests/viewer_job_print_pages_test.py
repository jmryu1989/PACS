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
    grouped = {}
    for y, x, text in rows:
        grouped.setdefault(round(y, 1), []).append((x, text))
    return ["".join(text for _, text in sorted(group)) for _, group in sorted(grouped.items(), reverse=True)]


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
        self.assertEqual(self.options(page), [["none", "Images only"], ["saved", "Current study report"]])
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

    def test_pages_06_named_page_support_gate_blocks_print(self):
        # A browser that parses margin boxes but rejects named @page rules
        # would print continuation pages with only the shared footer, which is
        # exactly what the per-report footer exists to prevent.
        data = self.data("20260801", "20260901")
        page = self.context.new_page()
        page.set_content("<!doctype html><html><body></body></html>")
        page.evaluate(CORNERSTONE)
        page.add_script_tag(path=str(MODULE))
        page.evaluate("""() => {
          const original = CSSStyleSheet.prototype.replaceSync;
          CSSStyleSheet.prototype.replaceSync = function (text) {
            if (/@page\\s+report-\\d+/.test(String(text))) throw new SyntaxError('named pages unsupported');
            return original.call(this, text);
          };
        }""")
        page.evaluate(SETUP, data)
        page.evaluate("uid => window.__printer.open(uid, 'job-1', 2)", data["job"]["snapshot"]["studies"][0])
        page.wait_for_function("() => document.querySelector('#kin-job-print [role=status]')"
                               ".textContent.includes('페이지 식별정보를 지원하는 Chrome 또는 Edge에서 여세요.')", timeout=60000)
        self.assertTrue(page.eval_on_selector("#kin-job-print button:text-is('인쇄 / PDF')", "b => b.disabled"))
        # The preview itself is still built; only the print path is closed.
        self.assertIn("<main>", self.srcdoc(page) or "")
        page.select_option(SELECT, "both")
        page.wait_for_function(SRCDOC, arg='data-report-uid="' + UID_B + '"', timeout=60000)
        page.wait_for_function("() => document.querySelector('#kin-job-print [role=status]')"
                               ".textContent.includes('페이지 식별정보를 지원하는 Chrome 또는 Edge에서 여세요.')", timeout=60000)
        self.assertTrue(page.eval_on_selector("#kin-job-print button:text-is('인쇄 / PDF')", "b => b.disabled"))
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


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
