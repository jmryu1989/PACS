# coding: utf-8
"""TEST-VOLUME-BATCH: real reconstructed pixels, source cameras and cancellation."""
import unittest
from pathlib import Path
import numpy as np
from playwright.sync_api import expect
from test_volume_orientation import VolumeOrientationE2E

class VolumeBatchE2E(VolumeOrientationE2E):
 def batch_start(self):
  a,p,v=self.starting();expect(v.get_by_role('button',name='Make Batch',exact=True)).to_be_enabled();errors=[];v.on('pageerror',lambda e:errors.append(str(e)));self.addCleanup(lambda:self.assertEqual(errors,[]))
  # The native ErrorBoundary prevents default window errors, so Playwright's
  # pageerror alone misses errors which still leave a visible failure banner.
  v.on('console',lambda m:errors.append(m.text) if m.text.startswith('KIN_BATCH_WINDOW_ERROR ') else None)
  v.evaluate("()=>{for(const name of ['error','unhandledrejection'])window.addEventListener(name,e=>{const error=e.error||e.reason;console.warn('KIN_BATCH_WINDOW_ERROR '+(error?.stack||String(error)))})}")
  v.evaluate('''()=>{window.batchSamples=[];window.batchURLs=[];window.batchRevoked=[];const blob=HTMLCanvasElement.prototype.toBlob,create=URL.createObjectURL,revoke=URL.revokeObjectURL;URL.createObjectURL=function(b){const url=create.call(this,b);batchURLs.push(url);return url};URL.revokeObjectURL=function(url){batchRevoked.push(url);return revoke.call(this,url)};HTMLCanvasElement.prototype.toBlob=function(...args){const el=this.closest('[data-kin-batch-render]');if(el){const vp=cornerstone.getEnabledElement(el).viewport;batchSamples.push({camera:vp.getCamera(),pixel:Array.from(this.getContext('2d').getImageData(Math.floor(this.width/2),Math.floor(this.height/2),1,1).data),width:this.width,height:this.height})}return blob.apply(this,args)}}''');return a,p,v
 def make_batch(self,v,offset=-12,interval=12,count=3):
  for label,value in [('Batch Start Offset',offset),('Batch Interval',interval),('Batch Number',count)]:v.get_by_label(label,exact=True).fill(str(value))
  v.get_by_role('button',name='Make Batch',exact=True).click();expect(v.locator('#kin-volume-batch [role=status]')).to_contain_text('개 단면 미리보기를 생성했습니다',timeout=20000)
  expect(v.get_by_text('Sorry, something went wrong there. Try again.',exact=True)).to_have_count(0)
 def test_batch_01_pixels_navigation_cine_and_preservation(self):
  a,p,v=self.batch_start();before=self.volume_state(v);original=self.originals();p.locator('#findings').fill('KEEP BATCH REPORT');self.make_batch(v)
  samples=v.evaluate('()=>batchSamples');self.assertEqual(len(samples),3);np.testing.assert_allclose([r['camera']['focalPoint'][2] for r in samples],[28,16,4],atol=1e-6,rtol=0)
  for row,want in zip(samples,[230,128,25]):self.assertAlmostEqual(row['pixel'][0],want,delta=3)
  for index,want in enumerate([230,128,25]):
   if index:v.get_by_role('button',name='Next Plane',exact=True).click()
   v.wait_for_function("()=>{const img=document.querySelector('#kin-volume-batch img');return img.complete&&img.naturalWidth>0}")
   pixel=v.evaluate("()=>{const img=document.querySelector('#kin-volume-batch img'),c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return ctx.getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data[0]}");self.assertAlmostEqual(pixel,want,delta=3)
  expect(v.get_by_role('button',name='Next Plane',exact=True)).to_be_disabled();v.get_by_role('button',name='Play Batch',exact=True).click();expect(v.get_by_role('button',name='Stop Batch',exact=True)).to_be_visible();v.wait_for_timeout(350);v.get_by_role('button',name='Stop Batch',exact=True).click()
  self.preserved_volume(before,self.volume_state(v));expect(v.locator('[data-kin-batch-render]')).to_have_count(0);v.get_by_role('button',name='Clear Batch',exact=True).click();self.assertTrue(v.evaluate('()=>batchURLs.every(url=>batchRevoked.includes(url))'));expect(p.locator('#findings')).to_have_value('KEEP BATCH REPORT');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1)
 def test_batch_02_oblique_real_camera_spacing(self):
  a,p,v=self.batch_start();self.rotate_planes(v,0,25);self.rotate_planes(v,1,-35);before=self.volume_state(v);self.make_batch(v)
  samples=v.evaluate('()=>batchSamples');self.assertEqual(len(samples),3);normal=np.array(before[0]['camera']['viewPlaneNormal']);center=np.array(before[0]['camera']['focalPoint'])
  for row,offset in zip(samples,[-12,0,12]):
   expected=center+normal*offset;np.testing.assert_allclose(row['camera']['focalPoint'],expected,atol=1e-5,rtol=0);want=25 if expected[2]<10.5 else 230 if expected[2]>=21.5 else 128;self.assertAlmostEqual(row['pixel'][0],want,delta=3)
  self.preserved_volume(before,self.volume_state(v));self.assertEqual(len(self.versions(a)),1)
 def test_batch_05_projection_modal_and_session_cleanup(self):
  a,p,v=self.batch_start();self.project(v,1,20);v.wait_for_function('()=>Math.abs(projectionPixel()-229)<=3');before=self.volume_state(v);self.make_batch(v,offset=-4,interval=4,count=3)
  for row in v.evaluate('()=>batchSamples'):self.assertAlmostEqual(row['pixel'][0],229,delta=3)
  v.screenshot(path=str(Path(__file__).parent/'artifacts/MPR-batch-preview.png'))
  self.open_note(v);expect(v.get_by_role('button',name='Make Batch',exact=True)).to_be_disabled();v.locator('#tech-note-close').click();expect(v.locator('#kin-volume-batch .frame')).to_contain_text('1 / 3');self.preserved_volume(before,self.volume_state(v))
  v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(v.locator('#kin-volume-batch')).to_have_count(0);self.assertTrue(v.evaluate('()=>batchURLs.every(url=>batchRevoked.includes(url))'));expect(v.locator('[data-kin-batch-render]')).to_have_count(0);self.assertEqual(len(self.versions(a)),1)
 def test_batch_06_cancel_late_volume_attachment_and_denied_account(self):
  a,p,v=self.batch_start();before=self.volume_state(v)
  v.route('**/api/me',lambda r:r.fulfill(status=403,json={'message':'Synthetic denied'}));v.get_by_role('button',name='Make Batch',exact=True).click();expect(v.locator('#kin-volume-batch [role=status]')).to_contain_text('로그인');expect(v.locator('[data-kin-batch-render]')).to_have_count(0);self.assertEqual(v.evaluate('()=>batchSamples'),[]);v.unroute('**/api/me')
  v.evaluate('''()=>{window.batchEngine=projectionVP.getRenderingEngine();window.batchEnable=batchEngine.enableElement;batchEngine.enableElement=function(input){const result=batchEnable.call(this,input);if(input.viewportId.startsWith('kin-batch-')){const view=this.getViewport(input.viewportId),set=view.setVolumes;view.setVolumes=function(...args){return new Promise(resolve=>window.releaseBatchVolume=resolve).then(()=>set.apply(this,args))}}return result}}''')
  v.get_by_role('button',name='Make Batch',exact=True).click();v.wait_for_function('()=>!!window.releaseBatchVolume');v.get_by_role('button',name='Cancel Batch',exact=True).click();expect(v.locator('[data-kin-batch-render]')).to_have_count(0);v.evaluate('()=>{batchEngine.enableElement=batchEnable;releaseBatchVolume()}');v.wait_for_timeout(100);self.make_batch(v);self.assertEqual(len(v.evaluate('()=>batchSamples')),3);self.preserved_volume(before,self.volume_state(v));self.assertEqual(len(self.versions(a)),1)
 def test_batch_03_cancel_late_blob_and_retry(self):
  a,p,v=self.batch_start();before=self.volume_state(v)
  v.evaluate('''()=>{window.batchBlob=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(callback,...args){return batchBlob.call(this,b=>setTimeout(()=>callback(b),500),...args)}}''')
  v.get_by_role('button',name='Make Batch',exact=True).click();v.wait_for_function('()=>batchSamples.length>0');v.get_by_role('button',name='Cancel Batch',exact=True).click();expect(v.locator('[data-kin-batch-render]')).to_have_count(0);expect(v.locator('#kin-volume-batch .result')).not_to_be_visible();v.evaluate('()=>{HTMLCanvasElement.prototype.toBlob=batchBlob;batchSamples=[]}');self.make_batch(v);v.wait_for_timeout(600);expect(v.locator('#kin-volume-batch .frame')).to_contain_text('1 / 3');self.preserved_volume(before,self.volume_state(v));self.assertEqual(len(self.versions(a)),1)
 def test_batch_04_invalid_range_and_delayed_source_change(self):
  a,p,v=self.batch_start();before=self.volume_state(v);v.get_by_label('Batch Start Offset',exact=True).fill('10000');v.get_by_role('button',name='Make Batch',exact=True).click();expect(v.locator('#kin-volume-batch [role=status]')).to_contain_text('원본 볼륨 범위');self.assertEqual(v.evaluate('()=>batchSamples'),[])
  v.get_by_label('Batch Start Offset',exact=True).fill('0');pending=[];v.route('**/api/me',lambda r:pending.append(r));v.get_by_role('button',name='Make Batch',exact=True).click();v.wait_for_timeout(150);self.assertTrue(pending);self.choose_volume(v,v,1)
  for r in pending:
   try:r.fulfill(response=r.fetch())
   except Exception:pass # The generation request is deliberately aborted on selection change.
  v.unroute('**/api/me');expect(v.locator('[data-kin-batch-render]')).to_have_count(0);expect(v.get_by_role('button',name='Make Batch',exact=True)).to_be_enabled();self.assertEqual(v.evaluate('()=>batchSamples'),[]);self.preserved_volume(before,self.volume_state(v));self.assertEqual(len(self.versions(a)),1)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeBatchE2E(n) for n in loader.getTestCaseNames(VolumeBatchE2E) if n.startswith('test_batch_'))
if __name__=='__main__':unittest.main(verbosity=2)
