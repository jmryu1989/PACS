# coding: utf-8
"""TEST-D09-EDITOR-COMPARE-OUTPUT: the reading workspace's unsaved report body
printed beside the saved comparison images, annotations and reports.

The reading window is owned by another change, so this test stands in for it with
a same-origin about:blank frame that answers the product's own kin-editor-request
protocol. Nothing in the product is stubbed: the real viewer-editor-link factory,
its origin/source checks, the real report-preview boundary and the real print
path all run, and the frame is reached exactly the way a real opener would be.
"""
import json, re, sys, unittest, uuid
from pathlib import Path
import numpy as np
from pypdf import PdfReader
from playwright.sync_api import expect
from test_viewer_job_report import ViewerJobReportE2E, canvas_ready
from test_viewer_job_print import psql, literal

DRAFT_MARK = 'DRAFT-BODY-LINE'
COMPARISON_MARK = 'COMPARISON-BODY-LINE'
SELECT = '[aria-label="함께 출력할 판독문"]'
UNSAVED = '미확정 편집문 · 저장·승인되지 않음'
MISSING_REPLY = '판독 화면의 응답이 없습니다. 목록 창에서 영상 창을 다시 연결하세요.'
NOT_ALLOWED = '편집문 출력 권한이 없습니다.'

# Runs inside the stand-in reading window. It answers only kin-editor-request,
# echoes the scope it was asked about and reads the body from its opener page so
# the test can change it between two checks.
RESPONDER = """
window.addEventListener('message', function (event) {
  var data = event.data;
  if (!data || data.type !== 'kin-editor-request') return;
  if (parent.__editorMode === 'silent') return;
  parent.postMessage({ type: 'kin-editor-reply', request: data.request,
    result: parent.__editorResult || 'ok', owner: data.owner, studies: data.studies,
    activeUid: data.activeUid, session: parent.__editorSession || 'session-1',
    editor: parent.__editorBody }, event.origin);
});
"""

INSTALL = """args => {
  window.__editorBody = args.body;
  window.__editorMode = 'reply';
  window.__editorResult = 'ok';
  window.__editorSession = 'session-1';
  const frame = document.createElement('iframe');
  frame.src = 'about:blank';
  frame.style.cssText = 'position:fixed;left:-10000px;width:10px;height:10px';
  const ready = new Promise(resolve => { frame.onload = () => resolve(); });
  document.body.append(frame);
  return ready.then(() => {
    const doc = frame.contentDocument, script = doc.createElement('script');
    script.textContent = args.code; doc.body.append(script);
    window.__readingFrame = frame;
    // Chromium keeps window.opener configurable, so the viewer reaches this
    // frame through the very expression the product uses in a real popup.
    Object.defineProperty(window, 'opener', { configurable: true, value: frame.contentWindow });
    return window.opener === frame.contentWindow;
  });
}"""


def flat(text):
    return re.sub(r'\s+', '', text)


class EditorCompareOutputE2E(ViewerJobReportE2E):
 def install_reading_window(self, p, findings=None):
  body = dict(findings=findings if findings is not None else 'UNSAVED CURRENT\n' + (DRAFT_MARK + '\n') * 70,
              conclusion='UNSAVED CONCLUSION', recommendation='UNSAVED RECOMMENDATION')
  self.assertTrue(p.evaluate(INSTALL, dict(body=body, code=RESPONDER)))
  return body

 def set_body(self, p, **changes):
  p.evaluate('changes=>{window.__editorBody=Object.assign({},window.__editorBody,changes)}', changes)

 def select_reports(self, p, choice):
  p.get_by_label('함께 출력할 판독문', exact=True).select_option(choice)
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인', timeout=45000)
  return p.frame_locator('#kin-job-print iframe')

 def option_state(self, p):
  return dict(p.eval_on_selector_all(SELECT + ' option', 'os=>os.map(o=>[o.value,o.disabled])'))

 def pair(self):
  patient = 'EDITOROUT-' + uuid.uuid4().hex[:10]
  a = self.ct(patient, 'current', '20260801')
  b = self.ct(patient, 'past', '20260701')
  self.seed_report(a, action='approve', findings='SAVED CURRENT MUST NOT BE SUBSTITUTED')
  self.seed_report(b, findings='PRIOR SAVED\n' + (COMPARISON_MARK + ' 비교 소견을 보존합니다.\n') * 65)
  return a, b, patient

 def test_editor_output_01_draft_and_saved_comparison_own_their_pages(self):
  a, b, patient = self.pair()
  head = self.annotation(b, '비교 검사의 저장 표식')
  command = self.v2([a, b]); command['snapshot']['version'] = 3; job = self.post(a, command)
  before = {f.uid: self.report_rows(f) for f in [a, b]}
  original = self.originals(); frozen = self.get_job(a, job)
  p = self.launch_job([a, b]); canvas_ready(p, 1); self.observe(p, 'canvas-ready')
  # Baseline after the dock-panel resize settled; observations name what moved.
  pixels = self.settled_pngs(p); settled = self.observe(p, 'settled'); writes = []
  p.on('request', lambda r: writes.append(r.url)
       if r.method in ['POST', 'PUT', 'PATCH', 'DELETE'] and '/api/studies/' in r.url else None)
  body = self.install_reading_window(p)
  paper = self.output(p); images = self.output_arrays(p, paper)
  state = self.option_state(p)
  self.assertEqual(state['editor'], False); self.assertEqual(state['editor-prior'], False)
  self.assertEqual(p.eval_on_selector(SELECT + " option[value=editor]", 'o=>o.textContent'),
                   'Current study draft (unsaved)')
  paper = self.select_reports(p, 'editor')
  expect(paper.locator('.report')).to_have_count(1)
  expect(paper.locator('.report')).to_have_attribute('data-report-draft', 'true')
  expect(paper.locator('.report')).to_have_attribute('data-report-uid', a.uid)
  expect(paper.locator('.report h2')).to_have_text('Current Study Report')
  expect(paper.locator('.report-source')).to_have_text(UNSAVED)
  expect(paper.locator('.report-date')).to_have_text('검사일 20260801 · 현재 검사')
  expect(paper.locator('[data-report-field=findings]')).to_have_text(body['findings'])
  expect(paper.locator('[data-report-field=conclusion]')).to_have_text(body['conclusion'])
  expect(paper.locator('.report')).to_contain_text('출력 시점의 판독 화면 편집문입니다. 서버에 저장·승인되지 않았습니다.')
  expect(paper.locator('.report')).not_to_contain_text('SAVED CURRENT MUST NOT BE SUBSTITUTED')
  expect(paper.locator('.report')).not_to_contain_text('승인 판독의')
  expect(paper.locator('main')).not_to_contain_text('과거')
  self.assertEqual(paper.locator('script').count(), 0)
  paper = self.select_reports(p, 'editor-prior')
  expect(paper.locator('.report')).to_have_count(2)
  expect(paper.locator('.report').nth(0)).to_have_attribute('data-report-draft', 'true')
  expect(paper.locator('.report').nth(0)).to_have_attribute('data-print-page', 'report-0')
  expect(paper.locator('.report').nth(1)).to_have_attribute('data-report-uid', b.uid)
  expect(paper.locator('.report').nth(1)).to_have_attribute('data-print-page', 'report-1')
  expect(paper.locator('.report').nth(1)).to_contain_text('미승인 저장본 · v1')
  expect(paper.locator('.report-date').nth(1)).to_have_text('검사일 20260701 · 현재 검사보다 이전')
  expect(paper.locator('[data-annotation-id="' + head['id'] + '"]')).to_contain_text('비교 검사의 저장 표식')
  # The pinned v3 annotation path is untouched by the draft selection.
  for x, y in zip(images, self.output_arrays(p, paper)):
   self.assertTrue(np.array_equal(x, y))
  printed = self.print_popup(p); printed.wait_for_function('()=>window.__printed===true')
  path = Path(__file__).parent / 'artifacts/editor-compare-output.pdf'
  printed.pdf(path=str(path), prefer_css_page_size=True)
  pdf = PdfReader(path); total = len(pdf.pages)
  self.assertGreaterEqual(total, 4)
  owned = {a.uid: 0, b.uid: 0}
  for index, sheet in enumerate(pdf.pages):
   text = sheet.extract_text(); page = flat(text)
   self.assertIn(patient, text)
   draft = flat(DRAFT_MARK) in page
   comparison = COMPARISON_MARK in page
   self.assertFalse(draft and comparison, 'page %d mixes the draft and the saved report' % (index + 1))
   if draft:
    owned[a.uid] += 1
    self.assertIn(flat('Current Study Report'), page)
    self.assertIn(flat('Study ' + a.uid), page)
    self.assertIn(flat(UNSAVED), page)
    self.assertIn('20260801', page)
    self.assertNotIn(b.uid, page)
    for stamp in ('RSA', 'RSW', '·v1·', '승인된저장본'):
     self.assertNotIn(stamp, page, 'page %d gave the draft a saved stamp %r' % (index + 1, stamp))
   if comparison:
    owned[b.uid] += 1
    self.assertIn(flat('Comparison Study Report'), page)
    self.assertIn(flat('Study ' + b.uid), page)
    self.assertIn(flat('미승인 저장본 · v1'), page)
    self.assertIn(flat('현재 검사보다 이전'), page)
    self.assertNotIn(a.uid, page)
    self.assertNotIn(flat('미확정'), page)
   self.assertIn('%d/%d' % (index + 1, total), page)
  self.assertGreaterEqual(owned[a.uid], 2); self.assertGreaterEqual(owned[b.uid], 2)
  alltext = '\n'.join(sheet.extract_text() for sheet in pdf.pages)
  self.assertIn('UNSAVED CURRENT', alltext); self.assertIn('PRIOR SAVED', alltext)
  self.assertNotIn('SAVED CURRENT MUST NOT BE SUBSTITUTED', alltext)
  self.assertNotIn('과거', alltext)
  embedded = [np.array(img.image.convert('RGB')) for sheet in pdf.pages for img in sheet.images]
  self.assertEqual(len(embedded), 2)
  for x in images:
   self.assertTrue(any(x.shape == y.shape and np.array_equal(x, y) for y in embedded))
  # Printing the unfinished body saves and approves nothing.
  self.assert_pixels_kept(p, pixels, settled, 'after-print')
  self.assertEqual(self.get_job(a, job), frozen)
  self.assertEqual(self.originals(), original)
  self.assertEqual({f.uid: self.report_rows(f) for f in [a, b]}, before)
  self.assertEqual(writes, [])
  print('EDITOR COMPARE OUTPUT PDF ' + json.dumps(dict(pages=total, images=len(embedded))), flush=True)

 def test_editor_output_02_permission_and_boundary_refuse_the_draft(self):
  a, b, _ = self.pair(); self.post(a, self.v2([a, b]))
  before = {f.uid: self.report_rows(f) for f in [a, b]}
  p = self.launch_job([a, b]); self.install_reading_window(p); self.output(p)
  url = '**/api/studies/' + a.uid + '/report-preview'

  def without_editor(route):
   response = route.fetch(); data = response.json(); data['canPreviewEditor'] = False
   route.fulfill(response=response, json=data)

  p.route(url, without_editor)
  p.get_by_label('함께 출력할 판독문', exact=True).select_option('editor')
  expect(p.locator('#kin-job-print [role=status]')).to_have_text(NOT_ALLOWED, timeout=45000)
  expect(p.locator('#kin-job-print').get_by_role('button', name='인쇄 / PDF')).to_be_disabled()
  expect(p.locator('#kin-job-print iframe')).to_have_attribute('srcdoc', '')
  p.unroute(url, without_editor)
  # The saved choices stay usable once the draft choice was refused.
  paper = self.select_reports(p, 'saved')
  expect(paper.locator('.report')).to_have_attribute('data-report-uid', a.uid)
  # The real institution/P boundary of the current study still closes the dialog.
  psql(f'UPDATE "StudyState" SET rs=\'P\', "preDoc"=\'someone\', "preReviewer"=\'else\' WHERE uid={literal(a.uid)}')
  try:
   self.assertEqual(self.stack.request('GET', f'/studies/{a.uid}/report-preview', 'doctor').status, 403)
   p.get_by_label('함께 출력할 판독문', exact=True).select_option('editor')
   expect(p.locator('#kin-job-print')).not_to_be_visible(timeout=45000)
  finally:
   psql(f'UPDATE "StudyState" SET rs=\'W\', "preDoc"=NULL, "preReviewer"=NULL WHERE uid={literal(a.uid)}')
  self.assertEqual({f.uid: self.report_rows(f) for f in [a, b]}, before)

 def test_editor_output_03_changed_body_and_lost_window_refuse_the_print(self):
  a, b, _ = self.pair(); self.post(a, self.v2([a, b]))
  before = {f.uid: self.report_rows(f) for f in [a, b]}; original = self.originals()
  p = self.launch_job([a, b]); self.install_reading_window(p); self.output(p)
  paper = self.select_reports(p, 'editor-prior')
  expect(paper.locator('.report')).to_have_count(2)
  # The body is re-read immediately before printing, so a keystroke in the
  # reading window after the preview was built must stop the output.
  self.set_body(p, findings='CHANGED WHILE THE PREVIEW WAS OPEN')
  printed = self.print_popup(p)
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('변경되었습니다', timeout=45000)
  self.assertTrue(printed.is_closed())
  expect(paper.locator('.report')).to_have_count(0)
  p.locator('#kin-job-print').get_by_role('button', name='다시 확인', exact=True).click()
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인', timeout=45000)
  expect(paper.locator('.report').nth(0)).to_contain_text('CHANGED WHILE THE PREVIEW WAS OPEN')
  expect(paper.locator('.report').nth(0)).to_contain_text(UNSAVED)
  # A session change in the reading window is refused the same way.
  p.evaluate("()=>{window.__editorSession='session-2'}")
  printed = self.print_popup(p)
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('변경되었습니다', timeout=45000)
  self.assertTrue(printed.is_closed())
  p.evaluate("()=>{window.__editorMode='silent'}")
  p.locator('#kin-job-print').get_by_role('button', name='다시 확인', exact=True).click()
  expect(p.locator('#kin-job-print [role=status]')).to_have_text(MISSING_REPLY, timeout=45000)
  expect(p.locator('#kin-job-print iframe')).to_have_attribute('srcdoc', '')
  # A closed reading window ends the same way, and the images still print.
  p.evaluate("()=>{window.__readingFrame.remove()}")
  p.locator('#kin-job-print').get_by_role('button', name='다시 확인', exact=True).click()
  expect(p.locator('#kin-job-print [role=status]')).to_have_text(MISSING_REPLY, timeout=45000)
  paper = self.select_reports(p, 'prior')
  expect(paper.locator('.report')).to_have_attribute('data-report-uid', b.uid)
  expect(paper.locator('.report')).to_contain_text('미승인 저장본 · v1')
  self.assertEqual({f.uid: self.report_rows(f) for f in [a, b]}, before)
  self.assertEqual(self.originals(), original)

 def test_editor_output_04_no_reading_window_leaves_the_choice_blocked(self):
  a, b, _ = self.pair(); self.post(a, self.v2([a, b]))
  before = {f.uid: self.report_rows(f) for f in [a, b]}
  # No stand-in window is installed, so the viewer has no opener at all.
  p = self.launch_job([a, b]); self.assertFalse(p.evaluate('()=>!!window.opener'))
  self.output(p)
  state = self.option_state(p)
  self.assertEqual(state['editor'], True)
  self.assertEqual(state['editor-prior'], True)
  self.assertEqual(state['saved'], False)
  self.assertEqual(state['prior'], False)
  p.evaluate("""()=>{const s=document.querySelector('[aria-label="함께 출력할 판독문"]');
    s.value='editor';s.dispatchEvent(new Event('change'))}""")
  expect(p.locator('#kin-job-print [role=status]')).to_have_text(
   '연결된 판독 화면이 없습니다. 판독 화면에서 연 영상 창에서만 편집문을 출력할 수 있습니다.', timeout=45000)
  expect(p.locator('#kin-job-print').get_by_role('button', name='인쇄 / PDF')).to_be_disabled()
  paper = self.select_reports(p, 'both')
  expect(paper.locator('.report')).to_have_count(2)
  expect(paper.locator('main')).not_to_contain_text(UNSAVED)
  self.assertEqual({f.uid: self.report_rows(f) for f in [a, b]}, before)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(EditorCompareOutputE2E(n) for n in loader.getTestCaseNames(EditorCompareOutputE2E)
                              if n.startswith('test_editor_output_'))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(verbosity=2)
