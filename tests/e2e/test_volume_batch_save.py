# coding: utf-8
"""TEST-VOLUME-BATCH-SAVE: immutable recipe, native replay and rollback."""
import copy,json,unittest,uuid
from pathlib import Path
from unittest.mock import patch
import numpy as np
from playwright.sync_api import expect
from test_volume_batch import VolumeBatchE2E

CAPTURE='()=>window.kinCreateVolumeJob({grid:services.viewportGridService,cs:services.cornerstoneViewportService,ds:services.displaySetService,studies:new URLSearchParams(location.search).get("StudyInstanceUIDs").split(",")}).capture()'

class VolumeBatchSaveE2E(VolumeBatchE2E):
 maxDiff=None
 def same_recipe(self,left,right):
  # JSON/Prisma round trips alter the last binary floating-point digit. Keep
  # identifiers, dimensions and controls exact; physical camera values use a
  # 1e-12 tolerance, tighter than the native reconstruction's 1e-6 oracle.
  a,b=copy.deepcopy(left),copy.deepcopy(right)
  ac,bc=a['cell'].pop('camera'),b['cell'].pop('camera');self.assertEqual(a,b);self.assertEqual(ac.keys(),bc.keys())
  for key in ac:
   if isinstance(ac[key],bool):self.assertEqual(ac[key],bc[key])
   else:np.testing.assert_allclose(ac[key],bc[key],atol=1e-12,rtol=0)
 def pixels(self,v):
  result=[]
  for i in range(3):
   if i:v.get_by_role('button',name='Next Plane',exact=True).click()
   v.wait_for_function("()=>{const img=document.querySelector('#kin-volume-batch img');return img.complete&&img.naturalWidth>0}")
   result.append(v.evaluate("()=>{const img=document.querySelector('#kin-volume-batch img'),c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const bytes=ctx.getImageData(0,0,c.width,c.height).data;let hash=2166136261;for(const b of bytes)hash=Math.imul(hash^b,16777619);return {width:c.width,height:c.height,pixel:Array.from(ctx.getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data),hash:hash>>>0}}"))
  return result
 def test_batch_save_01_frozen_recipe_new_login_size_and_dpr(self):
  a,p,v=self.batch_start();original=self.originals();p.locator('#findings').fill('KEEP SAVED BATCH REPORT');self.rotate_planes(v,0,25);self.rotate_planes(v,1,-35);self.make_batch(v)
  recipe=v.evaluate(CAPTURE)['batch'];pixels=self.pixels(v)
  # Editing inputs or later moving the three source cameras cannot rewrite the
  # already generated planes whose pixels are shown in the batch preview.
  v.get_by_label('Batch Interval',exact=True).fill('0.5');self.rotate_planes(v,0,10);self.save_volume(v);job=self.get_volume_job(a)
  self.assertEqual(job['snapshot']['version'],5);self.same_recipe(job['snapshot']['batch'],recipe);self.assertNotEqual(job['snapshot']['cells'][0]['camera'],recipe['cell']['camera']);self.assertEqual(len(job['snapshot']['volume']['sourceDigest']),64)
  create=self.browser.new_context
  with patch.object(self.browser,'new_context',side_effect=lambda **options:create(**dict(options,device_scale_factor=1.5,viewport={'width':1400,'height':950}))):fresh=self.login()
  self.launch(fresh,[a]);self.ready(fresh);fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=60000)
  actual=fresh.evaluate(CAPTURE);self.same_recipe(actual['batch'],recipe);self.assertEqual(self.pixels(fresh),pixels);self.assertEqual(fresh.evaluate('devicePixelRatio'),1.5)
  for left,right in zip(actual['cells'],job['snapshot']['cells']):
   for key in ['position','focalPoint','viewUp','viewPlaneNormal']:np.testing.assert_allclose(left['camera'][key],right['camera'][key],atol=1e-6,rtol=0)
  expect(fresh.get_by_role('button',name='Print Saved Images',exact=True)).to_have_count(0);expect(p.locator('#findings')).to_have_value('KEEP SAVED BATCH REPORT');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1)
  print('BATCH_SAVED_REPLAY',json.dumps({'recipe':recipe,'pixels':pixels,'actual':actual}),flush=True)
 def test_batch_save_02_partial_failure_recovers_previous_batch(self):
  a,p,v=self.batch_start();self.make_batch(v);self.save_volume(v);self.make_batch(v,offset=-8,interval=8,count=3);before=v.evaluate(CAPTURE);pixels=self.pixels(v);p.locator('#findings').fill('KEEP BATCH ROLLBACK')
  v.evaluate('''()=>{const original=HTMLCanvasElement.prototype.toBlob;let count=0;HTMLCanvasElement.prototype.toBlob=function(callback,...args){if(this.closest('[data-kin-batch-render]')&&++count===2){HTMLCanvasElement.prototype.toBlob=original;callback(null);return;}return original.call(this,callback,...args)}}''')
  v.get_by_role('button',name='Restore Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('단면 영상을 만들지 못했습니다',timeout=60000)
  after=v.evaluate(CAPTURE);self.assertEqual(after['batch'],before['batch']);self.assertEqual(self.pixels(v),pixels);expect(v.locator('[data-kin-batch-render]')).to_have_count(0);expect(p.locator('#findings')).to_have_value('KEEP BATCH ROLLBACK');self.assertEqual(len(self.jobs(a)),1)
 def test_batch_save_03_rejects_forged_recipe_sources_and_roles(self):
  a,p,v=self.batch_start();self.make_batch(v);self.save_volume(v);job=self.get_volume_job(a);s=copy.deepcopy(job['snapshot']);del s['volume']['sourceDigest']
  def request(value,user='doctor'):return self.stack.request('POST',f'/studies/{a.uid}/viewer-jobs',user,{'id':str(uuid.uuid4()),'title':'Invalid batch','description':'','snapshot':value})
  for change in [lambda b:b['batch'].update(offset=10000),lambda b:b['batch'].update(count=1),lambda b:b['volume'].update(sops=b['volume']['sops'][::2]),lambda b:b['batch']['cell'].update(series='2.25.999')]:
   bad=copy.deepcopy(s);change(bad);self.assertEqual(request(bad).status,400)
  self.assertEqual(request(s,'tech').status,403);self.assertEqual(request(s,'kdoctor').status,403);self.assertEqual(len(self.jobs(a)),1)
 def test_batch_save_04_cancel_restore_recovers_previous_batch(self):
  a,p,v=self.batch_start();self.make_batch(v);self.save_volume(v);self.make_batch(v,offset=-8,interval=8,count=3);before=v.evaluate(CAPTURE);pixels=self.pixels(v)
  v.evaluate('''()=>{const original=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(callback,...args){if(this.closest('[data-kin-batch-render]')){HTMLCanvasElement.prototype.toBlob=original;window.batchRestoreWaiting=true;return original.call(this,b=>setTimeout(()=>callback(b),1500),...args)}return original.call(this,callback,...args)}}''')
  v.get_by_role('button',name='Restore Job',exact=True).click();v.wait_for_function('()=>window.batchRestoreWaiting');v.get_by_role('button',name='Cancel Batch',exact=True).click()
  expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('취소',timeout=60000);self.assertEqual(v.evaluate(CAPTURE)['batch'],before['batch']);self.assertEqual(self.pixels(v),pixels);expect(v.locator('[data-kin-batch-render]')).to_have_count(0)
 def test_batch_save_05_average_inversion_flips_and_reverse(self):
  a,p,v=self.batch_start();self.project(v,3,20);v.evaluate('()=>{projectionVP.setProperties({invert:true});projectionVP.setCamera({flipHorizontal:true,flipVertical:true});projectionVP.render()}');v.wait_for_function('()=>Math.abs(projectionPixel()-128)<=3')
  v.get_by_label('Batch Reverse',exact=True).check();self.make_batch(v,offset=1,interval=1,count=3);before=v.evaluate(CAPTURE);pixels=self.pixels(v);self.save_volume(v)
  v.get_by_role('button',name='Clear Batch',exact=True).click();v.get_by_role('button',name='Restore Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=60000)
  self.same_recipe(v.evaluate(CAPTURE)['batch'],before['batch']);self.assertEqual(self.pixels(v),pixels);self.assertEqual(len(self.jobs(a)),1)
 def test_batch_save_06_failed_regeneration_keeps_unsaved_recipe(self):
  a,p,v=self.batch_start();self.make_batch(v);before=v.evaluate(CAPTURE);pixels=self.pixels(v);self.rotate_planes(v,0,10)
  v.get_by_label('Batch Interval',exact=True).fill('1');v.evaluate('''()=>{const original=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(callback,...args){if(this.closest('[data-kin-batch-render]')){HTMLCanvasElement.prototype.toBlob=original;callback(null);return;}return original.call(this,callback,...args)}}''')
  v.get_by_role('button',name='Make Batch',exact=True).click();expect(v.locator('#kin-volume-batch [role=status]')).to_contain_text('단면 영상을 만들지 못했습니다')
  self.assertEqual(v.evaluate(CAPTURE)['batch'],before['batch']);v.get_by_role('button',name='Previous Plane',exact=True).click();v.get_by_role('button',name='Previous Plane',exact=True).click();self.assertEqual(self.pixels(v),pixels);self.save_volume(v);self.same_recipe(self.get_volume_job(a)['snapshot']['batch'],before['batch'])
 def test_batch_save_07_oblique_same_window_repeated_restore(self):
  a,p,v=self.batch_start();self.rotate_planes(v,0,25);self.rotate_planes(v,1,-35);self.make_batch(v);before=v.evaluate(CAPTURE);pixels=self.pixels(v);self.save_volume(v)
  for _ in range(2):
   v.get_by_role('button',name='Restore Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=60000);v.get_by_role('button',name='Make Batch',exact=True).scroll_into_view_if_needed();v.wait_for_timeout(300)
   self.same_recipe(v.evaluate(CAPTURE)['batch'],before['batch']);self.assertEqual(self.pixels(v),pixels);expect(v.get_by_text('Sorry, something went wrong there. Try again.',exact=True)).to_have_count(0)
 def test_batch_save_08_read_only_member_reopens(self):
  a,p,v=self.batch_start();self.make_batch(v);before=v.evaluate(CAPTURE);pixels=self.pixels(v);self.save_volume(v)
  fresh=self.login('tech');self.launch(fresh,[a]);self.ready(fresh);errors=[];fresh.on('pageerror',lambda e:errors.append(str(e)))
  expect(fresh.get_by_role('button',name='Save New Job',exact=True)).to_be_disabled();fresh.get_by_label('Job Author',exact=True).select_option('false');fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=60000)
  self.same_recipe(fresh.evaluate(CAPTURE)['batch'],before['batch']);self.assertEqual(self.pixels(fresh),pixels);expect(fresh.get_by_text('Sorry, something went wrong there. Try again.',exact=True)).to_have_count(0);self.assertEqual(errors,[])
  fresh.get_by_role('button',name='Make Batch',exact=True).scroll_into_view_if_needed();fresh.screenshot(path=str(Path(__file__).parent/'artifacts/MPR-batch-read-only.png'))

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeBatchSaveE2E(n) for n in loader.getTestCaseNames(VolumeBatchSaveE2E) if n.startswith('test_batch_save_'))
if __name__=='__main__':unittest.main(verbosity=2)
