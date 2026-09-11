# coding: utf-8
"""TEST-D09-COMPARE-REPORTS, TEST-D09-OUTPUT-IDENTITY: explicitly selected comparison reports."""
import json, re, sys, unittest, uuid
from pathlib import Path
import numpy as np
from pypdf import PdfReader
from playwright.sync_api import expect
from test_viewer_job_report import ViewerJobReportE2E, canvas_ready
from test_viewer_job_print import psql, literal

CURRENT_MARK='CURRENT-BODY-LINE';COMPARISON_MARK='COMPARISON-BODY-LINE'
# The output @page reserves a 24mm bottom margin for the per-report footer.
BOTTOM_MARGIN_PT=24*72/25.4
SELECT='[aria-label="함께 출력할 판독문"]'


def flat(text):return re.sub(r'\s+','',text)


def text_runs(sheet):
 """(y, x, text) in page space; Chromium's print output flips y through cm."""
 rows=[]
 def visitor(text,cm,tm,font_dict,font_size):
  if text and text.strip():rows.append((float(tm[4]*cm[1]+tm[5]*cm[3]+cm[5]),float(tm[4]*cm[0]+tm[5]*cm[2]+cm[4]),text))
 sheet.extract_text(visitor_text=visitor);return rows


def line_order(group):
 """Same rule as viewer_job_print_pages_test.line_order: after a fallback-font switch
 (Linux Korean/Latin) pypdf reports a tie or the line-start x again for the next run;
 ties keep extraction order, a fall-back keeps the previous run's position, other x decide."""
 start=group[0][0] if group else None;ordered=[];cursor=None
 for index,(x,text) in enumerate(group):
  if cursor is not None and x<cursor and x==start:x=cursor
  ordered.append((x,index,text));cursor=x
 return [text for _,_,text in sorted(ordered,key=lambda item:(item[0],item[1]))]


def page_lines(rows):
 grouped={}
 for y,x,text in rows:grouped.setdefault(round(y,1),[]).append((x,text))
 return [''.join(line_order(group)) for _,group in sorted(grouped.items(),reverse=True)]


class CompareReportsE2E(ViewerJobReportE2E):
 def select_reports(self,p,choice):
  p.get_by_label('함께 출력할 판독문',exact=True).select_option(choice)
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=45000)
  return p.frame_locator('#kin-job-print iframe')

 def option_text(self,p,value):
  return p.eval_on_selector(SELECT+' option[value='+value+']','o=>o.textContent')

 def pair(self):
  patient='COMPAREREPORTS-'+uuid.uuid4().hex[:10]
  a=self.ct(patient,'current','20260801');b=self.ct(patient,'past','20260701')
  self.seed_report(a,action='approve',findings='CURRENT SAVED\n'+(CURRENT_MARK+'\n')*70)
  self.seed_report(b,findings='PRIOR SAVED <script>window.bad=1</script>\n'+(COMPARISON_MARK+' 비교 소견을 보존합니다.\n')*65)
  return a,b,patient

 def test_compare_reports_01_both_pdf_annotations_identity_and_preservation(self):
  a,b,patient=self.pair();head=self.annotation(b,'비교 검사의 저장 표식')
  command=self.v2([a,b]);command['snapshot']['version']=3;job=self.post(a,command)
  draft=self.stack.request('PUT',f'/studies/{b.uid}/report','doctor2',dict(baseVersion=1,findings='PRIVATE DRAFT NOT OUTPUT',conclusion='',recommendation=''))
  self.assertEqual(draft.status,200,draft.text)
  before={f.uid:self.report_rows(f) for f in [a,b]};original=self.originals();frozen=self.get_job(a,job)
  p=self.launch_job([a,b]);canvas_ready(p,1);self.observe(p,'canvas-ready')
  # The baseline is taken only once the canvases have settled after the dock
  # panel resize; the observations record what canvas_ready alone had seen.
  pixels=self.settled_pngs(p);settled=self.observe(p,'settled');writes=[]
  p.on('request',lambda r:writes.append(r.url) if r.method in ['POST','PUT','PATCH','DELETE'] and '/api/studies/' in r.url else None)
  paper=self.output(p);images=self.output_arrays(p,paper)
  paper=self.select_reports(p,'prior');expect(paper.locator('.report')).to_have_count(1)
  expect(paper.locator('.report')).to_have_attribute('data-report-uid',b.uid)
  expect(paper.locator('.report h2')).to_have_text('Comparison Study Report')
  expect(paper.locator('.report-date')).to_have_text('검사일 20260701 · 현재 검사보다 이전')
  expect(paper.locator('.report')).not_to_contain_text('CURRENT SAVED')
  paper=self.select_reports(p,'both');expect(paper.locator('.report')).to_have_count(2)
  expect(paper.locator('.report').nth(0)).to_have_attribute('data-report-uid',a.uid)
  expect(paper.locator('.report').nth(1)).to_have_attribute('data-report-uid',b.uid)
  expect(paper.locator('.report').nth(0)).to_contain_text('승인된 저장본 · v1')
  expect(paper.locator('.report').nth(1)).to_contain_text('미승인 저장본 · v1')
  expect(paper.locator('main')).not_to_contain_text('PRIVATE DRAFT NOT OUTPUT')
  expect(paper.locator('.report').nth(0)).to_have_attribute('data-print-page','report-0')
  expect(paper.locator('.report').nth(1)).to_have_attribute('data-print-page','report-1')
  expect(paper.locator('.report-date').nth(0)).to_have_text('검사일 20260801 · 현재 검사')
  expect(paper.locator('.report-date').nth(1)).to_have_text('검사일 20260701 · 현재 검사보다 이전')
  expect(paper.locator('[data-annotation-id="'+head['id']+'"]')).to_contain_text('비교 검사의 저장 표식')
  self.assertEqual(paper.locator('script').count(),0)
  for x,y in zip(images,self.output_arrays(p,paper)):self.assertTrue(np.array_equal(x,y))
  printed=self.print_popup(p);printed.wait_for_function('()=>window.__printed===true')
  path=Path(__file__).parent/'artifacts/compare-reports.pdf';printed.pdf(path=str(path),prefer_css_page_size=True)
  pdf=PdfReader(path);self.assertGreaterEqual(len(pdf.pages),4);owned={a.uid:0,b.uid:0}
  for index,sheet in enumerate(pdf.pages):
   text=sheet.extract_text();self.assertIn(patient,text);page=flat(text)
   current=CURRENT_MARK in page;comparison=COMPARISON_MARK in page
   self.assertFalse(current and comparison,'page %d mixes both reports'%(index+1))
   if current:
    owned[a.uid]+=1
    self.assertIn(flat('Current Study Report'),page);self.assertIn(flat('Study '+a.uid),page)
    self.assertIn(flat('승인된 저장본 · v1 · RS A'),page);self.assertIn('20260801',page);self.assertNotIn(b.uid,page)
   if comparison:
    owned[b.uid]+=1
    self.assertIn(flat('Comparison Study Report'),page);self.assertIn(flat('Study '+b.uid),page)
    self.assertIn(flat('미승인 저장본 · v1'),page);self.assertIn(flat('현재 검사보다 이전'),page)
    self.assertIn('20260701',page);self.assertNotIn(a.uid,page)
   self.assertIn('%d/%d'%(index+1,len(pdf.pages)),page)
  self.assertGreaterEqual(owned[a.uid],2);self.assertGreaterEqual(owned[b.uid],2)
  alltext='\n'.join(page.extract_text() for page in pdf.pages)
  self.assertIn('CURRENT SAVED',alltext);self.assertIn('PRIOR SAVED',alltext);self.assertNotIn('PRIVATE DRAFT NOT OUTPUT',alltext)
  self.assertNotIn('과거',alltext)
  embedded=[np.array(img.image.convert('RGB')) for page in pdf.pages for img in page.images]
  self.assertEqual(len(embedded),2)
  for x in images:self.assertTrue(any(x.shape==y.shape and np.array_equal(x,y) for y in embedded))
  self.assert_pixels_kept(p,pixels,settled,'after-print');self.assertEqual(self.get_job(a,job),frozen);self.assertEqual(self.originals(),original)
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
  p.get_by_role('button',name='Print Current View',exact=True).click()
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=45000)
  paper=self.select_reports(p,'both');expect(paper.locator('.report')).to_have_count(2)
  printed=self.print_popup(p);printed.wait_for_function('()=>window.__printed===true')
  expect(printed.locator('.report').nth(1)).to_have_attribute('data-report-uid',b.uid)
  self.assertEqual(self.jobs(a),[]);self.assertEqual({f.uid:self.report_rows(f) for f in [a,b]},before);self.assertEqual(self.originals(),original)
  p.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click()
  # Navigate the same browser tab, so a previous two-study choice cannot leak.
  self.launch(p,[a]);canvas_ready(p,1)
  p.get_by_role('button',name='Print Current View',exact=True).click()
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=45000)
  expect(p.get_by_label('함께 출력할 판독문',exact=True)).to_have_value('none')
  expect(p.get_by_label('함께 출력할 판독문',exact=True).locator('option[value=prior],option[value=both]')).to_have_count(0)
  paper=self.select_reports(p,'saved');expect(paper.locator('.report')).to_have_attribute('data-report-uid',a.uid)


 def overlay(self,f,**values):
  psql(f'UPDATE "StudyState" SET ov={literal(json.dumps(values,ensure_ascii=False))} WHERE uid={literal(f.uid)}')

 def test_compare_reports_05_comparison_named_by_date_relation(self):
  patient='COMPAREREPORTS-'+uuid.uuid4().hex[:10];a=self.ct(patient,'current','20260801')
  self.seed_report(a,action='approve',findings='CURRENT SAVED\n'+(CURRENT_MARK+'\n')*70)
  later=self.ct(patient,'later','20260901');same=self.ct(patient,'same','20260801');odd=self.ct(patient,'odd','20260701')
  for f in [later,same,odd]:self.seed_report(f,findings='COMPARISON SAVED\n'+(COMPARISON_MARK+'\n')*70)
  # synthetic_ct writes a real StudyDate, so only the invalid variants need the
  # StudyState overlay that report-preview applies over the DICOM tag.
  cases=[(later,None,'20260901','현재 검사보다 이후'),(same,None,'20260801','현재 검사와 같은 날짜 · 선후 미확인'),
   (odd,'','날짜 없음','검사일 확인 불가 · 선후 미확인'),(odd,'BADDATE1','BADDATE1','검사일 확인 불가 · 선후 미확인')]
  try:
   for index,(f,override,shown,relation) in enumerate(cases):
    with self.subTest(shown=shown):
     if override is None:psql(f'UPDATE "StudyState" SET ov=NULL WHERE uid={literal(f.uid)}')
     else:self.overlay(f,date=override)
     self.post(a,self.v2([a,f]));p=self.launch_job([a,f]);self.output(p)
     option=self.option_text(p,'prior')
     self.assertTrue(option.startswith('Comparison study report ('),option)
     self.assertIn(shown,option);self.assertNotIn('과거',option)
     self.assertNotIn('과거',self.option_text(p,'both'))
     paper=self.select_reports(p,'prior')
     expect(paper.locator('.report h2')).to_have_text('Comparison Study Report')
     expect(paper.locator('.report-date')).to_have_text(f'검사일 {shown} · {relation}')
     paper=self.select_reports(p,'both');expect(paper.locator('.report')).to_have_count(2)
     expect(paper.locator('.report-date').nth(0)).to_have_text('검사일 20260801 · 현재 검사')
     expect(paper.locator('.report-date').nth(1)).to_have_text(f'검사일 {shown} · {relation}')
     expect(paper.locator('main')).not_to_contain_text('과거')
     if index==0:
      printed=self.print_popup(p);printed.wait_for_function('()=>window.__printed===true')
      path=Path(__file__).parent/'artifacts/compare-reports-later.pdf';printed.pdf(path=str(path),prefer_css_page_size=True)
      pdf=PdfReader(path);alltext='\n'.join(sheet.extract_text() for sheet in pdf.pages)
      self.assertNotIn('과거',alltext);self.assertIn(flat('현재 검사보다 이후'),flat(alltext))
      self.assertIn(flat('Comparison Study Report'),flat(alltext))
      print('COMPARE REPORTS LATER PDF '+json.dumps(dict(pages=len(pdf.pages))),flush=True)
     p.close()
  finally:psql(f'UPDATE "StudyState" SET ov=NULL WHERE uid={literal(odd.uid)}')

 def test_compare_reports_06_long_identity_stays_in_the_bottom_margin(self):
  a,b,patient=self.pair();name=' '.join('NAME%02d'%i for i in range(13));desc=('DESCRIPTION-'*6)[:64];acc='ACC-0123456789AB'
  for f in [a,b]:self.overlay(f,name=name,desc=desc,acc=acc)
  try:
   self.post(a,self.v2([a,b]));p=self.launch_job([a,b]);self.output(p)
   paper=self.select_reports(p,'both');expect(paper.locator('.report')).to_have_count(2)
   printed=self.print_popup(p);printed.wait_for_function('()=>window.__printed===true')
   path=Path(__file__).parent/'artifacts/compare-reports-long-identity.pdf';printed.pdf(path=str(path),prefer_css_page_size=True)
   pdf=PdfReader(path);self.assertGreaterEqual(len(pdf.pages),4);owned={a.uid:0,b.uid:0}
   for index,sheet in enumerate(pdf.pages):
    rows=text_runs(sheet);footer=[row for row in rows if row[0]<BOTTOM_MARGIN_PT]
    self.assertTrue(footer,'page %d has no footer text'%(index+1))
    lines=[flat(line) for line in page_lines(footer) if not re.fullmatch(r'[\d/]+',flat(line))]
    joined=''.join(lines);owners=[uid for uid in [a.uid,b.uid] if uid in joined]
    self.assertLess(max(row[0] for row in footer),BOTTOM_MARGIN_PT)
    if not owners:continue
    self.assertEqual(len(owners),1,lines);uid=owners[0];owned[uid]+=1
    self.assertTrue(any(flat('Study '+uid) in line for line in lines),lines)
    self.assertIn(flat(f'{name} ({patient}) · {desc} · Acc {acc}'),joined)
    self.assertIn(flat('Current Study Report' if uid==a.uid else 'Comparison Study Report'),joined)
    mark=CURRENT_MARK if uid==a.uid else COMPARISON_MARK
    body=[row[0] for row in rows if mark in row[2]]
    if body:
     self.assertGreater(min(body),BOTTOM_MARGIN_PT,'page %d body entered the bottom margin'%(index+1))
     self.assertGreater(min(body),max(row[0] for row in footer))
   self.assertGreaterEqual(owned[a.uid],2);self.assertGreaterEqual(owned[b.uid],2)
   print('COMPARE REPORTS LONG IDENTITY PDF '+json.dumps(dict(pages=len(pdf.pages))),flush=True)
  finally:
   for f in [a,b]:psql(f'UPDATE "StudyState" SET ov=NULL WHERE uid={literal(f.uid)}')


def load_tests(loader,tests,pattern):return unittest.TestSuite(CompareReportsE2E(n) for n in loader.getTestCaseNames(CompareReportsE2E) if n.startswith('test_compare_reports_'))
if __name__=='__main__':
 sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
