# coding: utf-8
"""TEST-D09-LIVE-PRINT: transient source validation and actual native output."""
import copy, json, sys, unittest, uuid
from pathlib import Path
from urllib.request import Request
import numpy as np
from pypdf import PdfReader
from playwright.sync_api import expect
from test_viewer_job_print import ViewerJobPrintE2E, canvas_ready, psql, literal


class LivePrintE2E(ViewerJobPrintE2E):
 def preview(self,f,body,user='doctor',status=200):
  r=self.stack.request('POST',f'/studies/{f.uid}/viewer-jobs/preview',user,body)
  self.assertEqual(r.status,status,r.text);return r

 def rows(self):
  return {t:psql('SELECT to_jsonb(t)::text FROM "'+t+'" t ORDER BY to_jsonb(t)::text COLLATE "C"') for t in
   ['ViewerJob','ViewerJobRevision','ViewerItem','ViewerRevision','ViewerRequest','Report','ReportVersion','ReportDraft','AuditLog']}

 def live_output(self,p):
  p.get_by_role('button',name='Print Current View',exact=True).click()
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=45000)
  return p.frame_locator('#kin-job-print iframe')

 def test_live_01_read_api_validation_permissions_preservation(self):
  patient='LIVEPRINT-'+uuid.uuid4().hex[:10];a=self.ct(patient,'current','20260801');b=self.ct(patient,'past','20260701')
  body={'snapshot':self.v2([a,b])['snapshot']};before=self.rows();originals=self.originals()
  for user in ['doctor','tech']:
   r=self.preview(a,body,user);self.assertEqual(set(r.body),{'snapshot'})
   for cell in r.body['snapshot']['cells']:self.assertRegex(cell['sourceDigest'],r'^[a-f0-9]{32}$')
  request=Request(self.stack.api+f'/studies/{a.uid}/viewer-jobs/preview',data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+self.stack.token('doctor'),'Content-Type':'application/json'},method='POST')
  with self.stack._open(request) as response:self.assertEqual(response.headers.get('Cache-Control'),'no-store')
  raw=json.dumps(body).encode();raw=raw[:-1]+b',"snapshot":'+json.dumps(body['snapshot']).encode()+b'}'
  self.assertEqual(self.stack.bearer_request('POST',f'/studies/{a.uid}/viewer-jobs/preview',self.stack.token('doctor'),raw,headers={'Content-Type':'application/json'}).status,400)
  self.assertEqual(self.stack.bearer_request('POST',f'/studies/{a.uid}/viewer-jobs/preview',self.stack.token('doctor'),body,headers={'X-KIN-Subject':'different'}).status,403)
  self.preview(a,body,'kdoctor',403)
  self.assertEqual(self.stack.bearer_request('POST',f'/studies/{a.uid}/viewer-jobs/preview',self.stack.service_token('gateway'),body).status,403)
  for field,value in [('version',1),('version',3),('active',-1),('rows',3)]:
   bad=copy.deepcopy(body);bad['snapshot'][field]=value;self.preview(a,bad,status=400)
  bad=copy.deepcopy(body);bad['id']=str(uuid.uuid4());self.preview(a,bad,status=400)
  bad=copy.deepcopy(body);bad['snapshot']['cells'][0]['viewport']['width']=0;self.preview(a,bad,status=400)
  bad=copy.deepcopy(body);bad['snapshot']['cells'][0]['camera']['focalPoint'][2]+=1;self.preview(a,bad,status=400)
  self.preview(b,body,status=400)
  self.assertEqual(self.rows(),before);self.assertEqual(self.originals(),originals)
  other=self.ct('DIFFERENT-'+uuid.uuid4().hex[:8],'future','20260907')
  self.preview(a,{'snapshot':self.v2([a,other])['snapshot']},status=400)
  psql(f'UPDATE "StudyState" SET rs=\'P\', "preDoc"=\'someone\', "preReviewer"=\'else\' WHERE uid={literal(b.uid)}')
  self.preview(a,body,status=403)
  psql(f'UPDATE "StudyState" SET rs=\'W\', "preDoc"=NULL, "preReviewer"=NULL WHERE uid={literal(b.uid)}')

 def test_live_02_native_pixels_report_pdf_no_job(self):
  patient='LIVEPRINT-'+uuid.uuid4().hex[:10];a=self.ct(patient,'current','20260801');b=self.ct(patient,'past','20260701');self.seed_report(a)
  p=self.launch_job([a,b]);self.grid(p,2);self.drag(p,'D03A current',0);self.drag(p,'D03A past',1);canvas_ready(p,2)
  self.choose(p,0);p.keyboard.press('ArrowDown');self.gesture(p,'Zoom',0,30);self.gesture(p,'Pan',30,20)
  for key in ['2','r','h','v','i']:p.keyboard.press(key)
  self.choose(p,1);p.keyboard.press('1');p.wait_for_timeout(200)
  p.get_by_label('Job Title',exact=True).fill('미저장 제목');p.get_by_label('Description',exact=True).fill('미저장 설명')
  expected=self.arrays(self.pngs(p));before=self.rows();originals=self.originals();paper=self.live_output(p)
  actual=self.output_arrays(p,paper);self.assertEqual(len(actual),2)
  errors=[]
  for x,y in zip(expected,actual):
   self.assertEqual(x.shape,y.shape);error=int(np.abs(x.astype(int)-y.astype(int)).max());errors.append(error);self.assertLessEqual(error,2)
  expect(paper.locator('main')).to_contain_text('화면 캡처 아님');expect(paper.locator('main')).to_contain_text('주석 미포함')
  p.get_by_label('함께 출력할 판독문',exact=True).select_option('saved')
  expect(paper.locator('.report')).to_be_visible();expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인')
  p.evaluate('''()=>{const open=window.open;window.open=(...args)=>{const w=open(...args);if(w)w.print=()=>w.__printCalled=true;return w}}''')
  with p.expect_popup() as opened:p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF').click()
  printed=opened.value;printed.wait_for_function('()=>window.__printCalled===true')
  output=Path(__file__).parent/'artifacts/live-print.pdf';printed.pdf(path=str(output),prefer_css_page_size=True)
  pdf=PdfReader(output);self.assertGreaterEqual(len(pdf.pages),2)
  embedded=[]
  for page in pdf.pages:self.assertIn(patient,page.extract_text());embedded += [np.array(img.image.convert('RGB')) for img in page.images]
  self.assertEqual(len(embedded),2)
  for x in actual:self.assertTrue(any(x.shape==y.shape and np.array_equal(x,y) for y in embedded))
  self.assertEqual(self.rows(),before);self.assertEqual(self.originals(),originals)
  self.assertEqual(self.jobs(a),[])
  p.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click()
  expect(p.get_by_label('Job Title',exact=True)).to_have_value('미저장 제목');expect(p.get_by_label('Description',exact=True)).to_have_value('미저장 설명')
  for x,y in zip(expected,self.arrays(self.pngs(p))):self.assertTrue(np.array_equal(x,y))
  print('LIVEPRINT native max RGB errors '+json.dumps(errors)+'; PDF pages '+str(len(pdf.pages)),flush=True)

 def test_live_03_drift_digest_failure_close_retry(self):
  f=self.ct('LIVEPRINT-'+uuid.uuid4().hex[:10],'current','20260801');p=self.launch_job([f]);canvas_ready(p,1)
  before=self.rows();paper=self.live_output(p)
  endpoint='**/viewer-jobs/preview'
  def changed(route):
   response=route.fetch();body=response.json();body['snapshot']['cells'][0]['sourceDigest']='0'*32
   route.fulfill(response=response,json=body)
  p.route(endpoint,changed)
  p.evaluate('''()=>{const open=window.open;window.open=(...args)=>{const w=open(...args);if(w)w.print=()=>w.__printCalled=true;return w}}''')
  with p.expect_popup() as opened:p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF').click()
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('변경')
  self.assertTrue(opened.value.is_closed());p.unroute(endpoint)
  p.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click()
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인')
  p.evaluate('''()=>{const s=services.viewportGridService.getState();const v=services.cornerstoneViewportService.getCornerstoneViewport(s.activeViewportId);v.setCamera({parallelScale:v.getCamera().parallelScale*1.2});v.render()}''')
  p.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click()
  expect(p.locator('#kin-job-print [role=status]')).to_contain_text('현재 영상 표시가 바뀌었습니다')
  expect(p.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF')).to_be_disabled()
  p.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click();self.live_output(p)
  p.evaluate('''()=>{const f=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).endsWith('/viewer-jobs/preview')){window.__waiting=true;await new Promise(r=>window.__release=r)}return f(...args)};window.__restore=()=>window.fetch=f}''')
  p.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click();p.wait_for_function('()=>window.__waiting')
  p.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click();p.evaluate('()=>{window.__restore();window.__release()}')
  self.live_output(p);self.assertEqual(self.rows(),before)

 def test_live_04_empty_cell_unsaved_annotation_controls_session(self):
  f=self.ct('LIVEPRINT-'+uuid.uuid4().hex[:10],'current','20260801');p=self.launch_job([f]);self.grid(p,4)
  for index in [0,1,3]:self.drag(p,'D03A current',index)
  canvas_ready(p,3);self.choose(p,0)
  p.locator('[data-cy="MeasurementTools-split-button-secondary"]').click();p.get_by_text('Annotation',exact=True).click()
  box=p.locator('.cornerstone-canvas').first.bounding_box();x,y=box['x']+box['width']*.47,box['y']+box['height']*.47
  p.mouse.move(x,y);p.mouse.down();p.mouse.move(x+45,y+28,steps=8);p.mouse.up()
  p.get_by_placeholder('Enter label').fill('보존할 미저장 표식');p.get_by_role('button',name='Save',exact=True).click()
  row=p.locator('#kin-viewer-history section[data-kind=arrow]').last;before=self.rows();pixels=self.pngs(p)
  paper=self.live_output(p);expect(paper.locator('.cell')).to_have_count(4);expect(paper.locator('.cell').nth(2)).to_contain_text('빈 셀')
  initial=self.output_arrays(p,paper);self.assertEqual(len(initial),3)
  p.get_by_label('출력 조절 대상',exact=True).select_option('1');p.get_by_label('확대 (%)',exact=True).fill('200')
  p.get_by_role('button',name='출력 조절 적용',exact=True).click();expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인')
  changed=self.output_arrays(p,paper);self.assertTrue(np.array_equal(initial[0],changed[0]));self.assertFalse(np.array_equal(initial[1],changed[1]));self.assertTrue(np.array_equal(initial[2],changed[2]))
  p.get_by_role('button',name='선택 범위 처음 화면으로',exact=True).click();expect(p.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인')
  for a,b in zip(initial,self.output_arrays(p,paper)):self.assertTrue(np.array_equal(a,b))
  self.assertEqual(self.pngs(p),pixels);self.assertEqual(self.rows(),before)
  p.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click();expect(row.get_by_label('주석 문구')).to_have_value('보존할 미저장 표식')
  self.live_output(p);p.evaluate("()=>window.dispatchEvent(new StorageEvent('storage',{key:'kin-session-ended',newValue:String(Date.now())}))")
  expect(p.locator('#kin-job-print')).not_to_be_visible();self.assertEqual(self.rows(),before)


def load_tests(loader,tests,pattern):return unittest.TestSuite(LivePrintE2E(n) for n in loader.getTestCaseNames(LivePrintE2E) if n.startswith('test_live_'))
if __name__=='__main__':
 sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
