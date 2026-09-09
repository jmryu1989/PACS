# coding: utf-8
"""REQ-D01-FAVORITE-VIEW: immutable view link, access and report-safe restore."""
import json,os,unittest,uuid
from pathlib import Path
from playwright.sync_api import expect
from test_favorites import FavoritesE2E
from test_viewer_jobs import ViewerJobsE2E
from test_prior_selection import canvas_ready
from invariants_live import psql
from viewer_api_test import literal

class FavoriteViewE2E(ViewerJobsE2E):
 account=FavoritesE2E.account
 body=FavoritesE2E.body
 change=FavoritesE2E.change
 def setUp(self):
  super().setUp();self.favoriteOwners={}
 def favorite_audits(self):
  actor=self.stack.request('GET','/me','doctor').body['actor']
  return psql('SELECT count(*) FROM "AuditLog" WHERE actor='+literal(actor)+" AND action LIKE 'favorite.%'")[0]
 def prepare_favorite(self):
  patient='FAVVIEW-'+uuid.uuid4().hex[:10];a=self.ct(patient,'current','20260801');b=self.ct(patient,'prior','20260701')
  self.seed_report(a);self.seed_report(b);job=self.post(a,self.command([a,b]));s=self.account();fid=str(uuid.uuid4())
  s=self.change(self.body(s,'create',fid,name='SYNTHETIC saved view'));s=self.change(self.body(s,'add',fid,uid=a.uid))
  return a,b,job,s,fid
 def test_favorite_view_01_reference_retry_unlink_and_wrong_study(self):
  a,b,job,s,fid=self.prepare_favorite();originals=self.originals();snapshot=self.stack.request('GET',f'/studies/{a.uid}/viewer-jobs/{job["id"]}','doctor').body['snapshot']
  request=self.body(s,'view',fid,uid=a.uid,jobId=job['id']);s=self.change(request);self.assertEqual(s['folders'][0]['views'],{a.uid:job['id']});self.assertEqual(self.change(request),s);audit=self.favorite_audits()
  self.change(self.body(s,'view',fid,uid=b.uid,jobId=job['id']),status=404)
  self.change(self.body(s,'view',fid,uid=a.uid,jobId='not-uuid'),status=400)
  other=self.account('kdoctor');of=str(uuid.uuid4());other=self.change(self.body(other,'create',of,name='SYNTHETIC other'),'kdoctor')
  self.change(self.body(other,'view',of,uid=a.uid,jobId=job['id']),'kdoctor',403)
  self.assertEqual(self.favorite_audits(),audit)
  self.change({**request,'jobId':None},status=409);self.assertEqual(self.favorite_audits(),audit)
  hidden=self.post(a,{**self.revised(job),'hidden':True,'reason':'SYNTHETIC hide'},suffix='/'+job['id']+'/revisions')
  self.assertEqual(self.change(request),s);self.assertEqual(self.favorite_audits(),audit)  # Receipt retry remains safe after the view is hidden.
  self.assertEqual(self.stack.request('GET',f'/studies/{a.uid}/viewer-jobs/{job["id"]}','doctor').status,409)
  s=self.change(self.body(s,'view',fid,uid=a.uid,jobId=None));self.assertEqual(s['folders'][0]['views'],{})
  self.assertEqual(len(self.jobs(a,suffix='?includeHidden=true')),1);self.assertEqual(self.originals(),originals)
  restored=self.post(a,{**self.revised(hidden),'hidden':False,'reason':'SYNTHETIC restore'},suffix='/'+job['id']+'/revisions')
  self.assertEqual(self.stack.request('GET',f'/studies/{a.uid}/viewer-jobs/{job["id"]}','doctor').body['snapshot'],snapshot)
  s=self.change(self.body(s,'view',fid,uid=a.uid,jobId=job['id']));s=self.change(self.body(s,'remove',fid,uid=a.uid));self.assertEqual(s['folders'][0]['views'],{})
 def test_favorite_view_02_connect_cross_browser_and_restore(self):
  a,b,job,s,fid=self.prepare_favorite();p=self.login();self.select(p,b);p.locator('#findings').fill('KEEP FAVORITE VIEW REPORT');p.locator('#favorite-open').click()
  p.locator('.favorite-link').get_by_role('button',name='보기 상태 연결',exact=True).click();expect(p.locator('#favorite-view-choice option')).to_have_count(1)
  expect(p.locator('#favorite-view-choice')).to_have_value(job['id'])
  def lost(route):route.fetch();route.abort()
  p.route('**/api/favorite-folders',lambda route:lost(route) if route.request.method=='POST' else route.continue_())
  p.locator('#favorite-view-save').click();expect(p.locator('#favorite-retry')).to_be_visible();expect(p.locator('#favorite-retry')).to_be_enabled()
  p.unroute('**/api/favorite-folders');p.locator('#favorite-retry').click();expect(p.locator('.favorite-link').get_by_role('button',name='저장 보기 열기',exact=True)).to_be_visible()
  p.locator('#favorite-close').click();other=self.login();self.select(other,b);other.locator('#favorite-open').click()
  other.locator('.favorite-link').get_by_role('button',name='저장 보기 열기',exact=True).click();expect(other.locator('#reading-target')).to_contain_text(a.uid)
  frame=other.locator('#reading-frame').element_handle().content_frame();canvas_ready(frame,2);expect(frame.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=60000)
  self.assertIn('kinJob='+job['id'],other.locator('#reading-frame').get_attribute('src'))
  actual=frame.locator('body').evaluate("()=>cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports().map(v=>v.getProperties().voiRange))")
  self.assertEqual(len(actual),2)
  for value in actual:self.assertAlmostEqual(value['lower'],-1000,delta=0.01);self.assertAlmostEqual(value['upper'],-1,delta=0.01)
  self.assertEqual(len(self.versions(a)),1);self.assertEqual(len(self.versions(b)),1)
  p.locator('#favorite-open').click();p.locator('.favorite-link').get_by_role('button',name='저장 보기 열기',exact=True).click();expect(p.locator('#reading-target')).to_contain_text(a.uid)
  p.get_by_role('button',name='검사 목록',exact=True).click()
  p.locator(f'#rows tr[data-uid="{b.uid}"]').click();expect(p.locator('#findings')).to_have_value('KEEP FAVORITE VIEW REPORT')
  other.bring_to_front();frame.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');canvas_ready(frame,2)
  expected=self.stack.request('GET',f'/studies/{a.uid}/viewer-jobs/{job["id"]}','doctor').body['snapshot']
  observed=self.display(frame);self.assertEqual(len(observed),len(expected['cells']))
  for cell,actual in zip(expected['cells'],observed):
   self.assertIn(cell['sop'],actual['image']);self.assertIn('/frames/'+str(cell['frame']),actual['image'])
   for key in ['focalPoint','position','viewUp','viewPlaneNormal']:
    for x,y in zip(cell['camera'][key],actual['camera'][key]):self.assertAlmostEqual(x,y,places=5)
   for key in ['rotation','flipHorizontal','flipVertical','parallelScale']:self.assertAlmostEqual(cell['camera'][key],actual['camera'][key],places=5)
  print('FAVORITE SAVED DISPLAY',json.dumps(dict(expected=expected,observed=observed)),flush=True)
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);other.screenshot(path=str(folder/'favorite-view.png'))
 def test_favorite_view_03_revoked_prior_does_not_change_report_target(self):
  a,b,job,s,fid=self.prepare_favorite();c=self.ct(a.patient_id,'other','20260601');self.seed_report(c);self.change(self.body(s,'view',fid,uid=a.uid,jobId=job['id']));p=self.login();self.select(p,c);p.locator('#findings').fill('KEEP BLOCKED VIEW');p.locator('#favorite-open').click()
  audit=self.favorite_audits();self.assertEqual(psql('SELECT ("teleInstitutionId" IS NULL)::text FROM "StudyState" WHERE uid='+literal(b.uid)),['true'])
  psql(f"UPDATE \"StudyState\" SET \"institutionId\"='kin-center' WHERE uid='{b.uid}'")
  try:
   p.locator('.favorite-link').get_by_role('button',name='저장 보기 열기',exact=True).click();expect(p.locator('#favorite-status')).to_contain_text('열지 않았습니다')
   expect(p.locator('#rows tr.sel')).to_have_attribute('data-uid',c.uid);expect(p.locator('#findings')).to_have_value('KEEP BLOCKED VIEW');expect(p.locator('#reading-frame')).to_have_count(0);self.assertEqual(self.favorite_audits(),audit)
  finally:psql(f"UPDATE \"StudyState\" SET \"institutionId\"='hallym' WHERE uid='{b.uid}'")


 def test_favorite_view_04_dirty_previous_view_is_retained(self):
  a,b,job,s,fid=self.prepare_favorite();self.change(self.body(s,'view',fid,uid=a.uid,jobId=job['id']))
  p=self.login();self.select(p,b);p.locator('#findings').fill('KEEP DIRTY PREVIOUS REPORT');p.locator('#m-reading').click()
  expect(p.locator('#reading-frame')).to_be_visible();frame=p.locator('#reading-frame').element_handle().content_frame();canvas_ready(frame,1)
  frame.get_by_role('button',name='비교 작업·배치',exact=True).click();frame.get_by_label('작업 제목',exact=True).fill('KEEP UNSAVED PREVIOUS VIEW')
  src=p.locator('#reading-frame').get_attribute('src');p.get_by_role('button',name='검사 목록',exact=True).click();p.locator('#favorite-open').click()
  p.locator('.favorite-link').get_by_role('button',name='저장 보기 열기',exact=True).click();expect(p.locator('#reading-status')).to_contain_text('저장하지 않은 작업')
  self.assertEqual(p.locator('#reading-frame').get_attribute('src'),src);expect(frame.get_by_label('작업 제목',exact=True)).to_have_value('KEEP UNSAVED PREVIOUS VIEW')
  p.get_by_role('button',name='이전 영상 작업으로 돌아가기',exact=True).click();expect(p.locator('#findings')).to_have_value('KEEP DIRTY PREVIOUS REPORT')
  expect(frame.get_by_label('작업 제목',exact=True)).to_have_value('KEEP UNSAVED PREVIOUS VIEW');self.assertEqual(len(self.jobs(b)),0)


 def test_favorite_view_05_late_view_after_session_end_is_discarded(self):
  a,b,job,s,fid=self.prepare_favorite();self.change(self.body(s,'view',fid,uid=a.uid,jobId=job['id']))
  full=self.stack.request('GET',f'/studies/{a.uid}/viewer-jobs/{job["id"]}','doctor').body
  p=self.login();self.select(p,b);p.locator('#favorite-open').click();waiting=[];pattern='**/viewer-jobs/'+job['id'];p.route(pattern,lambda r:waiting.append(r))
  with p.expect_request(pattern):p.locator('.favorite-link').get_by_role('button',name='저장 보기 열기',exact=True).click()
  p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}")
  expect(p.locator('#favorite-dialog')).not_to_be_visible()
  for route in waiting:route.fulfill(status=200,content_type='application/json',body=json.dumps(full))
  expect(p.locator('#rows tr.sel')).to_have_attribute('data-uid',b.uid);expect(p.locator('#reading-frame')).to_have_count(0)

def load_tests(loader,tests,pattern):
 return unittest.TestSuite(FavoriteViewE2E(n) for n in loader.getTestCaseNames(FavoriteViewE2E) if n.startswith('test_favorite_view_'))
if __name__=='__main__':unittest.main(verbosity=2)
