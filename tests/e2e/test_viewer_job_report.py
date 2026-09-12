# coding: utf-8
"""TEST-D09-JOB-REPORT: current report plus immutable comparison output."""
import json, re, sys, unittest, uuid
from pathlib import Path
from pypdf import PdfReader
from playwright.sync_api import expect
from test_viewer_job_annotations import ViewerJobAnnotationsE2E, canvas_ready


# Same helper as test_compare_reports/test_editor_compare_output (defined here because
# those modules import this one). pypdf reports the Linux-rendered Korean runs with
# doubled spaces between words, so PDF text is compared whitespace-stripped.
def flat(text):return re.sub(r'\s+','',text)


class ViewerJobReportE2E(ViewerJobAnnotationsE2E):
 def include_report(self,p):
  p.get_by_label('함께 출력할 판독문',exact=True).select_option('saved')
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=45000)
  return p.frame_locator('#kin-job-print iframe')

 def print_popup(self,p):
  p.evaluate('''()=>{const open=window.open;window.open=(...args)=>{const w=open(...args);if(w)w.print=()=>w.__printed=true;return w}}''')
  with p.expect_popup() as opened:p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF').click()
  return opened.value

 def revise_report(self,f,text):
  result=self.stack.request('POST',f'/studies/{f.uid}/report/commit','doctor',dict(action='save',baseVersion=1,findings=text,conclusion='updated conclusion',recommendation='updated recommendation'))
  self.assertEqual(result.status,201,result.text)

 def test_job_report_01_current_saved_report_prior_annotations_pdf_preservation(self):
  patient='JOBREPORT-'+uuid.uuid4().hex[:12];a=self.ct(patient,'current','20260801');b=self.ct(patient,'past','20260701')
  head=self.annotation(a,'동결 주석 <img src=x>');self.annotation(b,'과거 영상 길이','length')
  command=self.v2([a,b]);command['snapshot']['version']=3;job=self.post(a,command)
  self.change(a,head,label='이후 주석')
  text='현재 판독 <script>window.bad=1</script>\n'+('긴 한글 소견을 보존합니다.\n'*70)
  self.seed_report(a,action='approve',findings=text);self.seed_report(b,findings='PRIOR REPORT MUST NOT APPEAR')
  draft=self.stack.request('PUT',f'/studies/{a.uid}/report','doctor2',dict(baseVersion=1,findings='OTHER PRIVATE DRAFT',conclusion='',recommendation=''))
  self.assertEqual(draft.status,200,draft.text)
  before={f.uid:self.report_rows(f) for f in [a,b]};original=self.originals();frozen=self.get_job(a,job)
  p=self.launch_job([a]);canvas_ready(p,1);pixels=self.pngs(p);writes=[]
  p.on('request',lambda r:writes.append(r.url) if r.method in ['POST','PUT','PATCH','DELETE'] and '/api/studies/' in r.url else None)
  paper=self.output(p);expect(paper.locator('.report')).to_have_count(0)
  images=self.output_arrays(p,paper);paper=self.include_report(p)
  expect(paper.locator('.report')).to_contain_text('승인된 저장본 · v1 · RS A')
  expect(paper.locator('[data-report-field=findings]')).to_have_text(text)
  expect(paper.locator('.report')).not_to_contain_text('PRIOR REPORT MUST NOT APPEAR')
  expect(paper.locator('main')).not_to_contain_text('OTHER PRIVATE DRAFT')
  expect(paper.locator('[data-annotation-id="'+head['id']+'"]')).to_contain_text('동결 주석 <img src=x>')
  self.assertEqual(paper.locator('script').count(),0)
  actual=self.output_arrays(p,paper);self.assertEqual(len(actual),2)
  for x,y in zip(images,actual):self.assertTrue((x==y).all())
  printed=self.print_popup(p);printed.wait_for_function('()=>window.__printed===true')
  path=Path(__file__).parent/'artifacts/job-report.pdf';printed.pdf(path=str(path),prefer_css_page_size=True)
  pdf=PdfReader(path);self.assertGreaterEqual(len(pdf.pages),3)
  alltext='\n'.join(page.extract_text() for page in pdf.pages);flatall=flat(alltext)
  for page in pdf.pages:self.assertIn(patient,page.extract_text());self.assertIn(flat('승인된 저장본'),flat(page.extract_text()))
  self.assertIn(flat('현재 판독'),flatall);self.assertIn(flat('동결 주석'),flatall);self.assertNotIn(flat('OTHER PRIVATE DRAFT'),flatall)
  self.assertEqual(sum(len(page.images) for page in pdf.pages),2)
  print('JOBREPORT PDF '+json.dumps(dict(pages=len(pdf.pages),images=2)),flush=True)
  self.assertEqual(self.pngs(p),pixels);self.assertEqual(self.get_job(a,job),frozen);self.assertEqual(self.originals(),original)
  self.assertEqual({f.uid:self.report_rows(f) for f in [a,b]},before);self.assertEqual(writes,[])

 def test_job_report_02_report_change_blocks_print_refresh_and_image_only(self):
  f=self.ct('JOBREPORT-'+uuid.uuid4().hex[:12],'current','20260801');self.seed_report(f,findings='VERSION ONE')
  self.post(f,self.v2([f]));p=self.launch_job([f]);self.output(p);paper=self.include_report(p)
  expect(paper.locator('.report')).to_contain_text('미승인 저장본 · v1')
  self.revise_report(f,'VERSION TWO')
  popup=self.print_popup(p)
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('변경되었습니다')
  if not popup.is_closed():popup.wait_for_event('close')
  self.assertTrue(popup.is_closed())
  expect(p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF')).to_be_disabled()
  p.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click()
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=45000)
  expect(paper.locator('.report')).to_contain_text('미승인 저장본 · v2');expect(paper.locator('.report')).to_contain_text('VERSION TWO')
  p.get_by_label('함께 출력할 판독문',exact=True).select_option('none')
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=45000)
  expect(paper.locator('.report')).to_have_count(0)
  printed=self.print_popup(p);printed.wait_for_function('()=>window.__printed===true');expect(printed.locator('.report')).to_have_count(0)

 def test_job_report_03_missing_report_and_malformed_identity_refused(self):
  f=self.ct('JOBREPORT-'+uuid.uuid4().hex[:12],'current','20260801');self.post(f,self.v2([f]));p=self.launch_job([f]);self.output(p)
  paper=self.include_report(p);expect(paper.locator('.report')).to_contain_text('저장된 판독문 없음')
  url='**/api/studies/'+f.uid+'/report-preview'
  for defect in ['identity','report','failed']:
   def broken(route):
    if defect=='failed':route.fulfill(status=503,body='unavailable');return
    response=route.fetch();data=response.json()
    if defect=='identity':data['study']['uid']='1.2.3'
    else:data['report'].pop('findings')
    route.fulfill(response=response,json=data)
   p.route(url,broken);p.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click()
   expect(p.locator('#kin-job-print [role=status]')).not_to_contain_text('확인하는 중',timeout=45000)
   expect(p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF')).to_be_disabled()
   expect(paper.locator('.report')).to_have_count(0);p.unroute(url,broken)
  p.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click()
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=45000)
  expect(paper.locator('.report')).to_contain_text('저장된 판독문 없음')

 def test_job_report_04_preparation_drift_and_close_late_response(self):
  f=self.ct('JOBREPORT-'+uuid.uuid4().hex[:12],'current','20260801');self.seed_report(f,findings='ONE');self.post(f,self.v2([f]))
  p=self.launch_job([f]);self.output(p);url='**/api/studies/'+f.uid+'/report-preview';calls=[]
  def changed(route):
   calls.append(1)
   if len(calls)==2:self.revise_report(f,'TWO')
   route.fulfill(response=route.fetch())
  p.route(url,changed);p.get_by_label('함께 출력할 판독문',exact=True).select_option('saved')
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('판독문이 변경되었습니다',timeout=45000)
  expect(p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF')).to_be_disabled();p.unroute(url,changed)
  p.evaluate('''()=>{const original=window.fetch;window.fetch=async(...args)=>{
   if(String(args[0]).includes('/report-preview')){window.__reportWaiting=true;await new Promise(r=>window.__reportRelease=r)}
   return original(...args)};window.__restoreReportFetch=()=>window.fetch=original}''')
  p.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click();p.wait_for_function('()=>window.__reportWaiting')
  p.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click();p.evaluate('()=>{window.__restoreReportFetch();window.__reportRelease()}')
  expect(p.locator('#kin-job-print')).not_to_be_visible()
  paper=self.output(p);expect(paper.locator('.report')).to_have_count(0)
  expect(p.get_by_label('함께 출력할 판독문',exact=True)).to_have_value('none')
  paper=self.include_report(p);expect(paper.locator('.report')).to_contain_text('TWO')


def load_tests(loader,tests,pattern):return unittest.TestSuite(ViewerJobReportE2E(n) for n in loader.getTestCaseNames(ViewerJobReportE2E) if n.startswith('test_job_report_'))
if __name__=='__main__':
 sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
