# coding: utf-8
"""Batch ownership in the report iframe and recovery from stalled native rendering."""
import unittest
from unittest.mock import patch
from playwright.sync_api import expect
from test_volume_batch import VolumeBatchE2E
from test_embedded_patient_copy import EmbeddedPatientCopyE2E

class VolumeBatchContextE2E(VolumeBatchE2E):
 def check_scale(self,scale):
  original=self.browser.new_context
  with patch.object(self.browser,'new_context',lambda *a,**kw:original(*a,**dict(kw,device_scale_factor=scale))):self.test_batch_01_pixels_navigation_cine_and_preservation()
  v=self.contexts[-1].pages[-1];self.assertEqual(v.evaluate('devicePixelRatio'),scale);print('BATCH_DEVICE_SCALE',scale,v.evaluate('()=>batchSamples.map(r=>[r.width,r.height])'),flush=True)
 def test_batch_context_04_dpr125(self):self.check_scale(1.25)
 def test_batch_context_05_dpr150(self):self.check_scale(1.5)
 def test_batch_context_03_minimum_average_and_flips(self):
  a,p,v=self.batch_start();v.evaluate('()=>{projectionVP.setCamera({flipHorizontal:true,flipVertical:true});projectionVP.render()}')
  for blend,want in [(2,25),(3,127)]:
   self.project(v,blend,20);v.wait_for_function('(want)=>Math.abs(projectionPixel()-want)<=3',arg=want);before=self.volume_state(v);v.evaluate('()=>batchSamples=[]');self.make_batch(v,offset=0,interval=.1,count=2);rows=v.evaluate('()=>batchSamples');self.assertEqual(len(rows),2)
   for row in rows:self.assertAlmostEqual(row['pixel'][0],want,delta=3);self.assertTrue(row['camera']['flipHorizontal']);self.assertTrue(row['camera']['flipVertical'])
   self.preserved_volume(before,self.volume_state(v));v.get_by_role('button',name='Clear Batch',exact=True).click()
  self.assertEqual(len(self.versions(a)),1)
 def test_batch_context_01_embedded_owner_and_report(self):
  a,b=self.pair();p,f=EmbeddedPatientCopyE2E.opened(self,a);self.mpr(f);self.choose_volume(p,f,1);p.locator('#findings').fill('KEEP EMBEDDED BATCH');before=self.volume_state(f)
  expect(f.get_by_role('button',name='Make Batch',exact=True)).to_be_enabled();self.make_batch(f,offset=0,interval=.1,count=2);self.preserved_volume(before,self.volume_state(f))
  p.locator('#reading-tech-note').click();expect(p.locator('#tech-note-dialog')).to_be_visible();expect(f.get_by_role('button',name='Make Batch',exact=True,include_hidden=True)).to_be_disabled();p.locator('#tech-note-close').click();expect(f.locator('#kin-volume-batch .frame')).to_contain_text('1 / 2')
  p.evaluate("()=>{window.batchOwnerKey=KinWorkspaceLayout.key;KinWorkspaceLayout.key=()=>{throw Error('Synthetic owner unavailable')}}");button=f.get_by_role('button',name='Make Batch',exact=True,include_hidden=True);expect(button).to_be_disabled();button.dispatch_event('click');expect(f.locator('#kin-volume-batch .result')).not_to_be_visible();self.preserved_volume(before,self.volume_state(f));p.evaluate('()=>KinWorkspaceLayout.key=batchOwnerKey');expect(button).to_be_enabled();self.make_batch(f,offset=0,interval=.1,count=2)
  expect(p.locator('#findings')).to_have_value('KEEP EMBEDDED BATCH');self.assertEqual(len(self.versions(a)),1)
 def test_batch_context_02_render_deadline_and_retry(self):
  a,p,v=self.batch_start();before=self.volume_state(v)
  v.evaluate('''()=>{window.batchEngine=projectionVP.getRenderingEngine();window.batchEnable=batchEngine.enableElement;batchEngine.enableElement=function(input){const result=batchEnable.call(this,input);if(input.viewportId.startsWith('kin-batch-'))this.getViewport(input.viewportId).render=()=>{};return result}}''')
  v.get_by_role('button',name='Make Batch',exact=True).click();expect(v.locator('#kin-volume-batch [role=status]')).to_contain_text('시간이 초과',timeout=15000);expect(v.locator('[data-kin-batch-render]')).to_have_count(0);self.assertEqual(v.evaluate('()=>batchSamples'),[]);v.evaluate('()=>batchEngine.enableElement=batchEnable');self.make_batch(v);self.preserved_volume(before,self.volume_state(v));self.assertEqual(len(self.versions(a)),1)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeBatchContextE2E(n) for n in loader.getTestCaseNames(VolumeBatchContextE2E) if n.startswith('test_batch_context_'))
if __name__=='__main__':unittest.main(verbosity=2)
