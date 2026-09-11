# coding: utf-8
"""TEST-MPR-PRINT: annotated Job output failures and paginated identity."""
import os,unittest
from pathlib import Path
from playwright.sync_api import expect
from pypdf import PdfReader
from test_volume_mpr_print import VolumeMprPrintE2E
from test_volume_batch_print import VolumeBatchPrintE2E

class VolumeMprPrintFailuresE2E(VolumeMprPrintE2E):
 def batch_start(self):
  a,p,v=super().batch_start();self.add_mark(v);self.marks(v).get_by_label('Show Annotations',exact=True).uncheck();return a,p,v
 test_mpr_output_10_changed_job=VolumeBatchPrintE2E.test_batch_print_04_changed_job_blocks_print_then_retry
 test_mpr_output_11_memory_asset=VolumeBatchPrintE2E.test_batch_print_05_missing_asset_retry_and_low_memory
 test_mpr_output_12_cancel_render=VolumeBatchPrintE2E.test_batch_print_06_cancel_delayed_source_and_renderer_failure
 test_mpr_output_13_fresh_digest=VolumeBatchPrintE2E.test_batch_print_08_changed_fresh_source_manifest_refuses_output
 def test_mpr_output_14_pdf_identity_and_all_labels(self):
  a,p,v=self.starting()
  for i in range(8):self.add_mark(v,('Long manual point '+str(i)+' <text> & '+'x'*100),point=(20+i*2,32,16))
  self.save_volume(v);job=self.get_volume_job(a);paper=self.open_print(v);expect(paper.locator('[data-annotation-id]')).to_have_count(24);p.locator('#findings').fill('KEEP PDF DRAFT')
  v.get_by_label('함께 출력할 판독문',exact=True).select_option('saved');expect(v.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=120000)
  v.evaluate("""()=>{const open=window.open;window.open=(...args)=>{const w=open(...args);if(w)w.print=()=>w.__printCalled=true;return w}}""")
  with v.expect_popup() as opened:v.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF',exact=True).click()
  printed=opened.value;printed.wait_for_function('()=>window.__printCalled===true',timeout=60000);folder=Path(os.environ.get('KIN_EVIDENCE_DIR','../tmp/mpr-print'));folder.mkdir(parents=True,exist_ok=True);path=folder/'mpr-output.pdf';printed.pdf(path=str(path),prefer_css_page_size=True);pdf=PdfReader(path);self.assertGreaterEqual(len(pdf.pages),2)
  for page in pdf.pages:self.assertIn(a.patient_id,page.extract_text())
  text='\n'.join(page.extract_text() for page in pdf.pages);self.assertIn(job['id'],text);self.assertNotIn('KEEP PDF DRAFT',text)
  for i in range(8):self.assertEqual(text.count('Long manual point '+str(i)),3)
  print('MPR_PDF',{'pages':len(pdf.pages),'annotations':24},flush=True)

 def test_mpr_output_15_missing_marks_model_and_retry(self):
  a,p,v=self.starting();self.add_mark(v);self.save_volume(v);v.evaluate('()=>{window.savedMarksModel=KinVolumeMarks;window.KinVolumeMarks=undefined}');v.get_by_role('button',name='Print Saved Images',exact=True).click();expect(v.locator('#kin-job-print [role=status]')).to_contain_text('저장 표식의 원본 좌표',timeout=120000);v.evaluate('()=>window.KinVolumeMarks=savedMarksModel');v.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click();expect(v.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=120000)

 def test_mpr_output_16_forged_point_response_refused(self):
  a,p,v=self.starting();self.add_mark(v);self.save_volume(v);job=self.get_volume_job(a);pattern='**/api/studies/'+a.uid+'/viewer-jobs/'+job['id']
  def forged(route):
   response=route.fetch();value=response.json();value['snapshot']['marks']['marks'][0]['point']=[1e6,1e6,1e6];route.fulfill(response=response,json=value)
  v.route(pattern,forged);v.get_by_role('button',name='Print Saved Images',exact=True).click();expect(v.locator('#kin-job-print [role=status]')).to_contain_text('저장 표식의 원본 좌표',timeout=120000);expect(v.locator('[data-kin-batch-print-render]')).to_have_count(0);self.assertEqual(self.get_volume_job(a)['snapshot'],job['snapshot'])
 def test_mpr_output_17_canvas_size_failure_and_retry(self):
  a,p,v=self.starting();self.add_mark(v);self.save_volume(v)
  v.evaluate("""()=>{const fn=cornerstone.RenderingEngine.prototype.enableElement;cornerstone.RenderingEngine.prototype.enableElement=function(input){const result=fn.call(this,input);if(input.element?.dataset.kinBatchPrintRender){const view=this.getViewport(input.viewportId),get=view.getCanvas.bind(view);view.getCanvas=()=>({width:1,height:get().height});cornerstone.RenderingEngine.prototype.enableElement=fn;}return result}}""")
  v.get_by_role('button',name='Print Saved Images',exact=True).click();expect(v.locator('#kin-job-print [role=status]')).to_contain_text('출력 단면의 크기',timeout=120000);expect(v.locator('[data-kin-batch-print-render]')).to_have_count(0);v.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click();expect(v.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=120000)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeMprPrintFailuresE2E(n) for n in loader.getTestCaseNames(VolumeMprPrintFailuresE2E) if n.startswith('test_mpr_output_'))
if __name__=='__main__':unittest.main(verbosity=2)
