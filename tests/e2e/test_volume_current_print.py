# coding: utf-8
"""TEST-MPR-CURRENT-PRINT: transient planes/points without creating a Job."""
import copy,os,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_volume_mpr_print import VolumeMprPrintE2E
from test_live_print import LivePrintE2E
from test_volume_batch_save import CAPTURE

class VolumeCurrentPrintE2E(VolumeMprPrintE2E):
 rows=LivePrintE2E.rows
 def unchanged_rows(self,before):
  after=self.rows()
  self.assertEqual({t:{'added':[r for r in after[t] if r not in before[t]],'removed':[r for r in before[t] if r not in after[t]]} for t in before if before[t]!=after[t]}, {})
 def current_output(self,v):
  v.get_by_role('button',name='Print Current View',exact=True).click()
  expect(v.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=120000)
  return v.frame_locator('#kin-job-print iframe')
 def test_mpr_current_01_native_pixels_and_no_writes(self):
  a,p,v=self.starting();expected=self.native_pixels(v);original=self.originals();state=self.volume_state(v)
  with p.expect_response(lambda r:r.url.endswith('/hold') and r.request.method=='POST') as held:p.locator('#findings').fill('KEEP CURRENT MPR DRAFT')
  self.assertEqual(held.value.status,201);before=self.rows();paper=self.current_output(v)
  self.assertEqual(self.print_pixels(paper),expected);expect(paper.locator('h1')).to_have_text('KIN PACS 현재 MPR 3평면');expect(paper.locator('main')).to_contain_text('저장하지 않는 출력');expect(paper.locator('main')).not_to_contain_text('Job undefined');self.unchanged_rows(before);self.assertEqual(self.jobs(a),[]);self.preserved_volume(state,self.volume_state(v));expect(p.locator('#findings')).to_have_value('KEEP CURRENT MPR DRAFT');self.assertEqual(self.originals(),original)
 def test_mpr_current_02_unsaved_marks_keep_dirty_and_values(self):
  a,p,v=self.starting();marks=self.add_mark(v,'Current unsaved point',point=(20,20,16));before=self.rows();state=self.volume_state(v);paper=self.current_output(v)
  expect(paper.locator('[data-annotation-id]')).to_have_count(3);expect(paper.locator('[data-annotation-id]').first).to_contain_text('Current unsaved point');expect(paper.locator('main')).to_contain_text('처음 선택한 수동 3D 표식');self.assertEqual(self.rows(),before);self.assertTrue(v.evaluate('()=>kinMprMarks.dirty()'));self.same_marks(v.evaluate('()=>kinMprMarks.capture(true)'),marks);self.preserved_volume(state,self.volume_state(v))
  v.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click();self.assertTrue(v.evaluate('()=>kinMprMarks.dirty()'));self.assertEqual(self.jobs(a),[])
  if os.environ.get('KIN_EVIDENCE_DIR'):v.screenshot(path=str(Path(os.environ['KIN_EVIDENCE_DIR'])/'current-mpr.png'))
 def test_mpr_current_03_api_roles_bounds_and_preservation(self):
  a,p,v=self.starting();self.add_mark(v);snapshot=v.evaluate(CAPTURE);before=self.rows();path=f'/studies/{a.uid}/viewer-jobs/preview'
  for user in ['doctor','tech']:
   r=self.stack.request('POST',path,user,{'snapshot':snapshot});self.assertEqual(r.status,200,r.text);self.assertRegex(r.body['snapshot']['volume']['sourceDigest'],r'^[a-f0-9]{64}$')
  self.assertEqual(self.stack.request('POST',path,'kdoctor',{'snapshot':snapshot}).status,403)
  for mutate in [lambda s:s['volume']['sops'].pop(),lambda s:s['marks']['marks'][0].update(point=[1e6,1e6,1e6]),lambda s:s['volume'].update(sourceDigest='0'*64)]:
   bad=copy.deepcopy(snapshot);mutate(bad);r=self.stack.request('POST',path,'doctor',{'snapshot':bad});self.assertEqual(r.status,400,r.text)
  self.assertEqual(self.rows(),before);self.assertTrue(v.evaluate('()=>kinMprMarks.dirty()'))
 def test_mpr_current_04_batch_excluded_and_mutation_locked(self):
  a,p,v=self.starting();self.make_batch(v);old=v.evaluate(CAPTURE);self.assertEqual(old['version'],5);self.rotate_planes(v,0,15);expected=self.native_pixels(v);before=self.rows();paper=self.current_output(v)
  self.assertEqual(self.print_pixels(paper),expected);expect(paper.locator('.cell')).to_have_count(3);expect(paper.locator('.batch-reference')).to_have_count(0)
  expect(v.get_by_role('button',name='Rotate Three Planes',exact=True)).to_be_disabled();expect(v.get_by_role('button',name='Pick Point',exact=True)).to_be_disabled()
  self.assertTrue(v.evaluate("()=>{try{kinMprMarks.capture();return false}catch(e){return e.message.includes('다른 작업')}}"));self.assertEqual(v.evaluate('()=>kinMprMarks.capture(true).marks'),[]);self.unchanged_rows(before)
  self.assertEqual(self.stack.request('POST',f'/studies/{a.uid}/viewer-jobs/preview','doctor',{'snapshot':old}).status,400)
  v.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click();self.assertEqual(v.evaluate(CAPTURE)['batch'],old['batch']);self.add_mark(v);marked=v.evaluate(CAPTURE);self.assertEqual(marked['version'],6);self.assertIsNotNone(marked['batch']);self.assertEqual(self.stack.request('POST',f'/studies/{a.uid}/viewer-jobs/preview','doctor',{'snapshot':marked}).status,400)
  paper=self.current_output(v);expect(paper.locator('[data-annotation-id]')).to_have_count(3);expect(paper.locator('.batch-reference')).to_have_count(0);self.assertTrue(v.evaluate('()=>kinMprMarks.dirty()'));self.unchanged_rows(before)
 def test_mpr_current_05_drift_digest_retry_and_session(self):
  a,p,v=self.starting();self.add_mark(v);before=self.rows();self.current_output(v);endpoint='**/viewer-jobs/preview'
  def changed(route):
   response=route.fetch();body=response.json();body['snapshot']['volume']['sourceDigest']='0'*64;route.fulfill(response=response,json=body)
  v.route(endpoint,changed);v.evaluate('''()=>{const open=window.open;window.open=(...args)=>{const w=open(...args);if(w)w.print=()=>w.__printCalled=true;return w}}''')
  with v.expect_popup() as opened:v.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF').click()
  expect(v.locator('#kin-job-print [role=status]')).to_contain_text('변경');self.assertTrue(opened.value.is_closed());v.unroute(endpoint)
  v.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click();expect(v.locator('#kin-job-print [role=status]')).to_contain_text('미리보기 내용을 확인',timeout=120000)
  v.evaluate('()=>{projectionVP.setCamera({parallelScale:projectionVP.getCamera().parallelScale*1.2});projectionVP.render()}');v.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click();expect(v.locator('#kin-job-print [role=status]')).to_contain_text('현재 영상 표시가 바뀌었습니다');expect(v.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF')).to_be_disabled()
  v.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click();self.assertTrue(v.evaluate('()=>kinMprMarks.dirty()'));self.current_output(v);v.evaluate("()=>window.dispatchEvent(new StorageEvent('storage',{key:'kin-session-ended',newValue:String(Date.now())}))");expect(v.locator('#kin-job-print')).not_to_be_visible();self.unchanged_rows(before)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeCurrentPrintE2E(n) for n in loader.getTestCaseNames(VolumeCurrentPrintE2E) if n.startswith('test_mpr_current_'))
if __name__=='__main__':unittest.main(verbosity=2)
