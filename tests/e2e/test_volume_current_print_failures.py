# coding: utf-8
"""TEST-MPR-CURRENT-PRINT: final PDF, pending input and stale async output."""
import os,unittest
from pathlib import Path
from pypdf import PdfReader
from playwright.sync_api import expect
from test_volume_current_print import VolumeCurrentPrintE2E

class VolumeCurrentPrintFailuresE2E(VolumeCurrentPrintE2E):
 def test_current_extra_06_pdf_saved_report_preserves_draft(self):
  a,p,v=self.starting();self.add_mark(v,'Unsaved PDF point')
  with p.expect_response(lambda r:r.url.endswith('/hold') and r.request.method=='POST') as held:p.locator('#findings').fill('DO NOT PRINT UNSAVED REPORT')
  self.assertEqual(held.value.status,201);before=self.rows();state=self.volume_state(v);paper=self.current_output(v);v.get_by_label('함께 출력할 판독문',exact=True).select_option('saved');expect(v.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=120000);expect(paper.locator('.report')).to_contain_text(a.secret);expect(paper.locator('main')).not_to_contain_text('DO NOT PRINT UNSAVED REPORT')
  v.evaluate('''()=>{const open=window.open;window.open=(...args)=>{const w=open(...args);if(w)w.print=()=>w.__printCalled=true;return w}}''')
  with v.expect_popup() as opened:v.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF').click()
  printed=opened.value;printed.wait_for_function('()=>window.__printCalled===true',timeout=120000);output=Path(os.environ['KIN_EVIDENCE_DIR'])/'current-mpr.pdf';printed.pdf(path=str(output),prefer_css_page_size=True);pdf=PdfReader(output);self.assertGreaterEqual(len(pdf.pages),3);text='\n'.join(page.extract_text() for page in pdf.pages)
  self.assertIn(a.secret,text);self.assertNotIn('DO NOT PRINT UNSAVED REPORT',text);self.assertNotIn('Job undefined',text);self.assertEqual(text.count('Unsaved PDF point'),3)
  for page in pdf.pages:self.assertIn(a.patient_id,page.extract_text())
  self.unchanged_rows(before);self.preserved_volume(state,self.volume_state(v));v.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click();expect(p.locator('#findings')).to_have_value('DO NOT PRINT UNSAVED REPORT');self.assertTrue(v.evaluate('()=>kinMprMarks.dirty()'));self.assertEqual(self.jobs(a),[]);v.screenshot(path=str(output.with_suffix('.png')))
 def test_current_extra_07_readonly_pending_input_and_retry(self):
  a,p,v=self.starting();fresh=self.launch(self.login('tech'),[a]);self.ready(fresh);self.mpr(fresh);self.choose_volume(fresh,fresh,0);before=self.rows();expected=self.native_pixels(fresh);paper=self.current_output(fresh);self.assertEqual(self.print_pixels(paper),expected);self.unchanged_rows(before)
  panel=self.marks(v);panel.get_by_label('MPR annotation label',exact=True).fill('KEEP PENDING POINT');v.get_by_role('button',name='Print Current View',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('표식 입력을 마친 뒤');expect(panel.get_by_label('MPR annotation label',exact=True)).to_have_value('KEEP PENDING POINT');expect(v.locator('#kin-job-print')).to_have_count(0)
  panel.get_by_role('button',name='Cancel Edit',exact=True).click();v.route('**/viewer-volume-job-print.js',lambda route:route.abort());v.get_by_role('button',name='Print Current View',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('출력 화면을 불러오지 못했습니다');v.unroute('**/viewer-volume-job-print.js');self.current_output(v);self.unchanged_rows(before)
 def test_current_extra_08_delayed_source_drift_close_and_denial(self):
  a,p,v=self.starting();marks=self.add_mark(v);before=self.rows();self.current_output(v)
  v.evaluate('''()=>{const fetch=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).endsWith('/viewer-jobs/preview')){window.__waiting=true;await new Promise(r=>window.__release=r)}return fetch(...args)};window.__restore=()=>window.fetch=fetch}''');v.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click();v.wait_for_function('()=>window.__waiting');v.evaluate('()=>{projectionVP.setCamera({parallelScale:projectionVP.getCamera().parallelScale*1.1});projectionVP.render();window.__restore();window.__release()}');expect(v.locator('#kin-job-print [role=status]')).to_contain_text('현재 영상 표시가 바뀌었습니다',timeout=120000);expect(v.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF')).to_be_disabled()
  v.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click();self.same_marks(v.evaluate('()=>kinMprMarks.capture()'),marks);self.current_output(v)
  endpoint='**/viewer-jobs/preview';v.route(endpoint,lambda route:route.fulfill(status=500,content_type='application/json',body='{"message":"CURRENT SOURCE FAILED"}'));v.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click();expect(v.locator('#kin-job-print [role=status]')).to_contain_text('CURRENT SOURCE FAILED');expect(v.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF')).to_be_disabled();v.unroute(endpoint);v.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click();self.current_output(v);self.unchanged_rows(before)
  # The shared jobs client ends the workspace on 403; it cannot retry a denied
  # session in place. A recoverable 500 above must retain the retry path.
  v.route(endpoint,lambda route:route.fulfill(status=403,content_type='application/json',body='{"message":"CURRENT SOURCE DENIED"}'));v.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click();expect(v.locator('#kin-job-print')).not_to_be_visible();self.unchanged_rows(before)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeCurrentPrintFailuresE2E(n) for n in loader.getTestCaseNames(VolumeCurrentPrintFailuresE2E) if n.startswith('test_current_extra_'))
if __name__=='__main__':unittest.main(verbosity=2)
