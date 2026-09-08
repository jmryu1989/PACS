# coding: utf-8
"""TEST-D09-COMPARE-REPORTS: explicitly selected comparison reports."""
import json, sys, unittest, uuid
from pathlib import Path
import numpy as np
from pypdf import PdfReader
from playwright.sync_api import expect
from test_viewer_job_report import ViewerJobReportE2E, canvas_ready
from test_viewer_job_print import psql, literal


class CompareReportsE2E(ViewerJobReportE2E):
 def select_reports(self,p,choice):
  p.get_by_label('함께 출력할 판독문',exact=True).select_option(choice)
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=45000)
  return p.frame_locator('#kin-job-print iframe')

 def pair(self):
  patient='COMPAREREPORTS-'+uuid.uuid4().hex[:10]
  a=self.ct(patient,'current','20260801');b=self.ct(patient,'past','20260701')
  self.seed_report(a,action='approve',findings='CURRENT SAVED')
  self.seed_report(b,findings='PRIOR SAVED <script>window.bad=1</script>\n'+'과거 소견을 보존합니다.\n'*65)
  return a,b,patient

 def test_compare_reports_01_both_pdf_annotations_identity_and_preservation(self):
  a,b,patient=self.pair();head=self.annotation(b,'과거의 저장 표식')
  command=self.v2([a,b]);command['snapshot']['version']=3;job=self.post(a,command)
  draft=self.stack.request('PUT',f'/studies/{b.uid}/report','doctor2',dict(baseVersion=1,findings='PRIVATE DRAFT NOT OUTPUT',conclusion='',recommendation=''))
  self.assertEqual(draft.status,200,draft.text)
  before={f.uid:self.report_rows(f) for f in [a,b]};original=self.originals();frozen=self.get_job(a,job)
  p=self.launch_job([a,b]);canvas_ready(p,1);pixels=self.pngs(p);writes=[]
  p.on('request',lambda r:writes.append(r.url) if r.method in ['POST','PUT','PATCH','DELETE'] and '/api/studies/' in r.url else None)
  paper=self.output(p);images=self.output_arrays(p,paper)
  paper=self.select_reports(p,'prior');expect(paper.locator('.report')).to_have_count(1)
  expect(paper.locator('.report')).to_have_attribute('data-report-uid',b.uid)
  expect(paper.locator('.report h2')).to_have_text('비교 과거 검사 판독문')
  expect(paper.locator('.report')).not_to_contain_text('CURRENT SAVED')
  paper=self.select_reports(p,'both');expect(paper.locator('.report')).to_have_count(2)
  expect(paper.locator('.report').nth(0)).to_have_attribute('data-report-uid',a.uid)
  expect(paper.locator('.report').nth(1)).to_have_attribute('data-report-uid',b.uid)
  expect(paper.locator('.report').nth(0)).to_contain_text('승인된 저장본 · v1')
  expect(paper.locator('.report').nth(1)).to_contain_text('미승인 저장본 · v1')
  expect(paper.locator('main')).not_to_contain_text('PRIVATE DRAFT NOT OUTPUT')
  expect(paper.locator('[data-annotation-id="'+head['id']+'"]')).to_contain_text('과거의 저장 표식')
  self.assertEqual(paper.locator('script').count(),0)
  for x,y in zip(images,self.output_arrays(p,paper)):self.assertTrue(np.array_equal(x,y))
  printed=self.print_popup(p);printed.wait_for_function('()=>window.__printed===true')
  path=Path(__file__).parent/'artifacts/compare-reports.pdf';printed.pdf(path=str(path),prefer_css_page_size=True)
  pdf=PdfReader(path);self.assertGreaterEqual(len(pdf.pages),4)
  for page in pdf.pages:
   text=page.extract_text();self.assertIn(patient,text);self.assertIn('현재 검사 판독문:',text);self.assertIn('비교 과거 검사 판독문:',text)
   self.assertIn('20260801',text);self.assertIn('20260701',text)
  alltext='\n'.join(page.extract_text() for page in pdf.pages)
  self.assertIn('CURRENT SAVED',alltext);self.assertIn('PRIOR SAVED',alltext);self.assertNotIn('PRIVATE DRAFT NOT OUTPUT',alltext)
  embedded=[np.array(img.image.convert('RGB')) for page in pdf.pages for img in page.images]
  self.assertEqual(len(embedded),2)
  for x in images:self.assertTrue(any(x.shape==y.shape and np.array_equal(x,y) for y in embedded))
  self.assertEqual(self.pngs(p),pixels);self.assertEqual(self.get_job(a,job),frozen);self.assertEqual(self.originals(),original)
  self.assertEqual({f.uid:self.report_rows(f) for f in [a,b]},before);self.assertEqual(writes,[])
  print('COMPARE REPORTS PDF '+json.dumps(dict(pages=len(pdf.pages),images=len(embedded))),flush=True)

 def test_compare_reports_02_prior_changes_and_real_denial_clear_output(self):
  a,b,_=self.pair();self.post(a,self.v2([a,b]));p=self.launch_job([a,b]);self.output(p);paper=self.select_reports(p,'both')
  self.revise_report(b,'UPDATED PRIOR')
  printed=self.print_popup(p);expect(p.locator('#kin-job-print [role=status]')).to_contain_text('변경되었습니다')
  self.assertTrue(printed.is_closed());expect(paper.locator('.report')).to_have_count(0)
  p.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click()
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=45000)
  expect(paper.locator('.report').nth(1)).to_contain_text('UPDATED PRIOR');expect(paper.locator('.report').nth(1)).to_contain_text('v2')
  psql(f'UPDATE "StudyState" SET rs=\'P\', "preDoc"=\'someone\', "preReviewer"=\'else\' WHERE uid={literal(b.uid)}')
  try:
   self.assertEqual(self.stack.request('GET',f'/studies/{b.uid}/report-preview','doctor').status,403)
   printed=self.print_popup(p)
   if not printed.is_closed():printed.wait_for_event('close')
   # The shared viewer permission handler closes the dialog on this real 403.
   expect(p.locator('#kin-job-print')).not_to_be_visible()
   expect(p.locator('#kin-job-print iframe')).to_have_attribute('srcdoc','');self.assertTrue(printed.is_closed())
  finally:psql(f'UPDATE "StudyState" SET rs=\'W\', "preDoc"=NULL, "preReviewer"=NULL WHERE uid={literal(b.uid)}')
  self.launch(p,[a,b]);expect(p.locator('#kin-viewer-jobs-status')).to_contain_text('목록입니다.')
  self.output(p);paper=self.select_reports(p,'prior');expect(paper.locator('.report')).to_contain_text('UPDATED PRIOR')

 def test_compare_reports_03_missing_malformed_and_late_selection(self):
  a=self.ct('COMPAREREPORTS-'+uuid.uuid4().hex[:10],'current','20260801');b=self.ct(a.patient_id,'past','20260701')
  self.post(a,self.v2([a,b]));p=self.launch_job([a,b]);self.output(p);paper=self.select_reports(p,'both')
  for section in [paper.locator('.report').nth(0),paper.locator('.report').nth(1)]:expect(section).to_contain_text('저장된 판독문 없음')
  url='**/api/studies/'+b.uid+'/report-preview'
  for defect in ['identity','report','failed']:
   def broken(route):
    if defect=='failed':route.fulfill(status=503,body='unavailable');return
    response=route.fetch();data=response.json()
    if defect=='identity':data['study']['uid']=a.uid
    else:data['report'].pop('findings')
    route.fulfill(response=response,json=data)
   p.route(url,broken);p.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click()
   expect(p.locator('#kin-job-print [role=status]')).not_to_contain_text('확인하는 중',timeout=45000)
   expect(paper.locator('.report')).to_have_count(0);expect(p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF')).to_be_disabled()
   p.unroute(url,broken)
  p.evaluate('''uid=>{const f=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).includes(uid+'/report-preview')&&!window.__held){window.__held=true;await new Promise(r=>window.__release=r)}return f(...args)};window.__restore=()=>window.fetch=f}''',b.uid)
  p.evaluate('''()=>{const select=document.querySelector('[aria-label="함께 출력할 판독문"]'), original=select.onchange;
   select.onchange=function(event){const pending=original.call(this,event);if(!window.__priorStarted){window.__priorStarted=true;Promise.resolve(pending).finally(()=>window.__priorSettled=true)}return pending}}''')
  p.get_by_label('함께 출력할 판독문',exact=True).select_option('prior');p.wait_for_function('()=>window.__held')
  paper=self.select_reports(p,'saved');expect(paper.locator('.report')).to_have_attribute('data-report-uid',a.uid)
  p.evaluate('()=>{window.__restore();window.__release()}');p.wait_for_function('()=>window.__priorSettled===true')
  expect(paper.locator('.report')).to_have_attribute('data-report-uid',a.uid)

 def test_compare_reports_04_current_output_and_single_study_reopen(self):
  a,b,_=self.pair();p=self.launch_job([a,b]);canvas_ready(p,1)
  before={f.uid:self.report_rows(f) for f in [a,b]};original=self.originals()
  p.get_by_role('button',name='현재 비교 화면 출력 · 저장 안 함',exact=True).click()
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=45000)
  paper=self.select_reports(p,'both');expect(paper.locator('.report')).to_have_count(2)
  printed=self.print_popup(p);printed.wait_for_function('()=>window.__printed===true')
  expect(printed.locator('.report').nth(1)).to_have_attribute('data-report-uid',b.uid)
  self.assertEqual(self.jobs(a),[]);self.assertEqual({f.uid:self.report_rows(f) for f in [a,b]},before);self.assertEqual(self.originals(),original)
  p.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click()
  # Navigate the same browser tab, so a previous two-study choice cannot leak.
  self.launch(p,[a]);canvas_ready(p,1)
  p.get_by_role('button',name='현재 비교 화면 출력 · 저장 안 함',exact=True).click()
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=45000)
  expect(p.get_by_label('함께 출력할 판독문',exact=True)).to_have_value('none')
  expect(p.get_by_label('함께 출력할 판독문',exact=True).locator('option[value=prior],option[value=both]')).to_have_count(0)
  paper=self.select_reports(p,'saved');expect(paper.locator('.report')).to_have_attribute('data-report-uid',a.uid)


def load_tests(loader,tests,pattern):return unittest.TestSuite(CompareReportsE2E(n) for n in loader.getTestCaseNames(CompareReportsE2E) if n.startswith('test_compare_reports_'))
if __name__=='__main__':
 sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
