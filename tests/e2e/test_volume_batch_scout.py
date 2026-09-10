# coding: utf-8
"""TEST-VOLUME-BATCH-SCOUT: independent plane equations, pixels and lifecycle."""
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
from playwright.sync_api import expect
from test_volume_batch_save import VolumeBatchSaveE2E,CAPTURE

class VolumeBatchScoutE2E(VolumeBatchSaveE2E):
 def observe_scout(self,v):
  v.evaluate('''()=>{window.scoutPlanes=[];window.scoutNative=null;const original=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(...args){
   const main=this.closest('[data-kin-batch-render]'),scout=this.closest('[data-kin-batch-scout-render]');
   if(main)scoutPlanes.push(cornerstone.getEnabledElement(main).viewport.getCamera());
   if(scout){const view=cornerstone.getEnabledElement(scout).viewport;scoutNative={camera:view.getCamera(),corners:[[0,0],[256/devicePixelRatio,0],[0,256/devicePixelRatio]].map(p=>view.canvasToWorld(p)),pixels:scoutPlanes.slice(-3).map(c=>{const xy=view.worldToCanvas(c.focalPoint).map(n=>Math.floor(n*devicePixelRatio));return Array.from(this.getContext('2d').getImageData(xy[0],xy[1],1,1).data)})};}
   return original.apply(this,args);
  }}''')
 def guides(self,v):
  return v.evaluate("()=>Array.from(document.querySelectorAll('#kin-volume-batch .scout line')).map(l=>[[Number(l.getAttribute('x1')),Number(l.getAttribute('y1'))],[Number(l.getAttribute('x2')),Number(l.getAttribute('y2'))]])")
 def check_planes(self,v):
  native=v.evaluate('()=>scoutNative');planes=v.evaluate('()=>scoutPlanes.slice(-3)');lines=self.guides(v);self.assertEqual(len(lines),3)
  origin,x,y=np.array(native['corners']);normal=np.array(native['camera']['viewPlaneNormal'])
  for plane,line in zip(planes,lines):
   n=np.array(plane['viewPlaneNormal']);f=np.array(plane['focalPoint']);self.assertAlmostEqual(float(np.dot(normal,n)),0,delta=1e-6)
   for px,py in line:
    world=origin+(x-origin)*px/256+(y-origin)*py/256;self.assertAlmostEqual(float(np.dot(n,world-f)),0,delta=1e-6)
    self.assertTrue(0<=px<=256 and 0<=py<=256)
  return native
 def scout_hash(self,v):
  v.wait_for_function("()=>{const i=document.querySelector('#kin-volume-batch .scout img');return i.complete&&i.naturalWidth===256}")
  return v.evaluate("()=>{const i=document.querySelector('#kin-volume-batch .scout img'),c=document.createElement('canvas');c.width=c.height=256;const ctx=c.getContext('2d');ctx.drawImage(i,0,0);let hash=2166136261;for(const b of ctx.getImageData(0,0,256,256).data)hash=Math.imul(hash^b,16777619);return hash>>>0}")
 def test_scout_01_positions_pixels_navigation_and_preservation(self):
  a,p,v=self.batch_start();self.observe_scout(v);before=self.volume_state(v);original=self.originals();p.locator('#findings').fill('KEEP SCOUT REPORT');self.make_batch(v)
  native=self.check_planes(v)
  for rgba,want in zip(native['pixels'],[230,128,25]):self.assertAlmostEqual(rgba[0],want,delta=3)
  expect(v.locator('#kin-volume-batch .scout [data-selected=true]')).to_have_attribute('data-plane','0');v.get_by_role('button',name='Next Plane',exact=True).click();expect(v.locator('#kin-volume-batch .scout [data-selected=true]')).to_have_attribute('data-plane','1')
  v.get_by_role('button',name='Play Batch',exact=True).click();v.wait_for_function("()=>document.querySelector('#kin-volume-batch .scout [data-selected=true]')?.getAttribute('data-plane')!=='1'");v.get_by_role('button',name='Stop Batch',exact=True).click()
  selected=int(v.locator('#kin-volume-batch .scout [data-selected=true]').get_attribute('data-plane'))+1;expect(v.locator('#kin-volume-batch .frame')).to_contain_text(str(selected)+' / 3');expect(v.locator('#kin-volume-batch .scout figcaption')).to_contain_text('Plane '+str(selected)+' / 3')
  self.preserved_volume(before,self.volume_state(v));expect(p.locator('#findings')).to_have_value('KEEP SCOUT REPORT');self.assertEqual(self.originals(),original)
  v.locator('#kin-volume-batch .scout').scroll_into_view_if_needed();v.screenshot(path=str(Path(__file__).parent/'artifacts/MPR-batch-scout.png'))
  v.get_by_role('button',name='Clear Batch',exact=True).click();expect(v.locator('#kin-volume-batch .scout')).not_to_be_visible();self.assertTrue(v.evaluate('()=>batchURLs.every(url=>batchRevoked.includes(url))'));expect(v.locator('[data-kin-batch-scout-render],[data-kin-batch-render]')).to_have_count(0)
 def test_scout_02_oblique_reverse_saved_replay_dpr(self):
  a,p,v=self.batch_start();self.observe_scout(v);self.rotate_planes(v,0,25);self.rotate_planes(v,1,-35);v.get_by_label('Batch Reverse',exact=True).check();self.make_batch(v,offset=12,interval=12,count=3);self.check_planes(v);lines=self.guides(v);image=self.scout_hash(v);recipe=v.evaluate(CAPTURE)['batch'];self.rotate_planes(v,0,10);self.save_volume(v)
  create=self.browser.new_context
  with patch.object(self.browser,'new_context',side_effect=lambda **options:create(**dict(options,device_scale_factor=1.5))):fresh=self.login()
  self.launch(fresh,[a]);self.ready(fresh);self.observe_scout(fresh);fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=60000)
  self.check_planes(fresh);np.testing.assert_allclose(self.guides(fresh),lines,atol=1e-6,rtol=0);self.assertEqual(self.scout_hash(fresh),image);self.same_recipe(fresh.evaluate(CAPTURE)['batch'],recipe)
  expect(fresh.get_by_text('Sorry, something went wrong there. Try again.',exact=True)).to_have_count(0)
 def test_scout_03_failed_reference_keeps_old_batch(self):
  a,p,v=self.batch_start();self.observe_scout(v);self.make_batch(v);before=v.evaluate(CAPTURE);lines=self.guides(v);image=self.scout_hash(v)
  v.evaluate('''()=>{const original=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(callback,...args){if(this.closest('[data-kin-batch-scout-render]')){HTMLCanvasElement.prototype.toBlob=original;callback(null);return;}return original.call(this,callback,...args)}}''')
  v.get_by_role('button',name='Make Batch',exact=True).click();expect(v.locator('#kin-volume-batch [role=status]')).to_contain_text('위치 참고 영상을 만들지 못했습니다');self.assertEqual(v.evaluate(CAPTURE)['batch'],before['batch']);self.assertEqual(self.guides(v),lines);self.assertEqual(self.scout_hash(v),image);expect(v.locator('[data-kin-batch-scout-render],[data-kin-batch-render]')).to_have_count(0)
 def test_scout_04_cancel_late_reference_attachment(self):
  a,p,v=self.batch_start();self.observe_scout(v);self.make_batch(v);image=self.scout_hash(v);before=v.evaluate(CAPTURE)
  v.evaluate('''()=>{const engine=projectionVP.getRenderingEngine(),enable=engine.enableElement;engine.enableElement=function(input){const result=enable.call(this,input);if(input.viewportId.startsWith('kin-scout-')){engine.enableElement=enable;const view=this.getViewport(input.viewportId),set=view.setVolumes;view.setVolumes=function(...args){return new Promise(resolve=>window.releaseScout=resolve).then(()=>set.apply(this,args))}}return result}}''')
  v.get_by_role('button',name='Make Batch',exact=True).click();v.wait_for_function('()=>!!window.releaseScout');v.get_by_role('button',name='Cancel Batch',exact=True).click();expect(v.locator('[data-kin-batch-scout-render],[data-kin-batch-render]')).to_have_count(0);v.evaluate('()=>releaseScout()');v.wait_for_timeout(100);self.assertEqual(self.scout_hash(v),image);self.assertEqual(v.evaluate(CAPTURE)['batch'],before['batch'])
 def test_scout_05_missing_optional_asset_keeps_batch(self):
  a,b=self.pair();p=self.login();p.context.route('**/viewer-volume-scout.js',lambda r:r.abort());v=self.launch(p,[a]);self.ready(v);self.mpr(v);self.choose_volume(v,v,1);self.make_batch(v,offset=0,interval=.1,count=2)
  expect(v.locator('#kin-volume-batch .scout')).not_to_be_visible();expect(v.locator('#kin-volume-batch [role=status]')).to_contain_text('위치 안내선 도구를 불러오지 못했습니다');expect(v.locator('#kin-volume-batch .frame')).to_contain_text('1 / 2')

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeBatchScoutE2E(n) for n in loader.getTestCaseNames(VolumeBatchScoutE2E) if n.startswith('test_scout_'))
if __name__=='__main__':unittest.main(verbosity=2)
