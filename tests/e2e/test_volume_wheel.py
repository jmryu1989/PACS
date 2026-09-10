# coding: utf-8
import math,unittest
import numpy as np
from playwright.sync_api import expect
from test_volume_gesture import VolumeGestureE2E

class VolumeWheelE2E(VolumeGestureE2E):
 def wheel_at(self,v,point,delta=-120):
  box=v.locator('#svg-layer-'+v.evaluate('()=>gestureVP.id')).bounding_box();v.mouse.move(box['x']+point[0],box['y']+point[1]);v.wait_for_timeout(100) # Let the native hover layer finish hit testing before dispatching a wheel.
  v.mouse.wheel(0,delta);v.wait_for_timeout(200)
 def slabs(self,v):
  return v.evaluate("()=>[...services.viewportGridService.getState().viewports.keys()].map(id=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id);return {total:2*v.getSlabThickness(),blend:v.getActors()[0].actor.getMapper().getBlendMode()}})")
 def test_wheel_01_target_mode_and_restore(self):
  a,p,v=self.starting();original=self.originals();p.locator('#findings').fill('KEEP WHEEL REPORT');self.activate(v);v.get_by_label('Wheel Changes Thickness',exact=True).check();center=self.handles(v)['center'];point=[center[0],center[1]+45];before=self.volume_state(v);slabs=self.slabs(v)
  self.wheel_at(v,point);got=self.slabs(v);self.assertEqual(got[0],slabs[0]);self.assertEqual(got[2],slabs[2]);self.assertAlmostEqual(got[1]['total'],slabs[1]['total']+1,delta=1e-6);self.assertEqual(got[1]['blend'],3)
  for old,new in zip(before,self.volume_state(v)):
   for key in ['position','focalPoint','viewUp','viewPlaneNormal']:np.testing.assert_allclose(new['camera'][key],old['camera'][key],atol=1e-6,rtol=0)
  for _ in range(12):self.wheel_at(v,point)
  self.save_volume(v);saved=self.get_volume_job(a);fresh=self.login();self.launch(fresh,[a]);self.ready(fresh);fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000)
  np.testing.assert_allclose([s['total'] for s in self.slabs(fresh)],[s['total'] for s in self.slabs(v)],atol=1e-6,rtol=0);self.assertEqual(self.slabs(fresh)[1]['blend'],3);self.assertAlmostEqual(saved['snapshot']['cells'][1]['projection']['thickness'],self.slabs(v)[1]['total'],delta=1e-6);expect(p.locator('#findings')).to_have_value('KEEP WHEEL REPORT');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1)
 def test_wheel_02_hidden_modal_and_native_slice(self):
  a,p,v=self.starting();self.activate(v);v.get_by_label('Wheel Changes Thickness',exact=True).check();center=self.handles(v)['center'];point=[center[0],center[1]+45];before=self.volume_state(v)
  v.get_by_label('Crosshair Plane 1',exact=True).uncheck();slabs=self.slabs(v);self.wheel_at(v,point);self.assertEqual(self.slabs(v),slabs);self.assertGreater(np.linalg.norm(np.array(self.volume_state(v)[0]['camera']['focalPoint'])-before[0]['camera']['focalPoint']),.1);before=self.volume_state(v);v.get_by_label('Crosshair Plane 1',exact=True).check();self.open_note(v);self.wheel_at(v,point);self.preserved_volume(before,self.volume_state(v));v.locator('#tech-note-close').click()
  slabs=self.slabs(v);self.wheel_at(v,[center[0]+40,center[1]+40]);self.assertEqual(self.slabs(v),slabs);after=self.volume_state(v);self.assertGreater(np.linalg.norm(np.array(after[0]['camera']['focalPoint'])-before[0]['camera']['focalPoint']),.1);self.assertEqual(len(self.versions(a)),1)
 def test_wheel_03_mip_pixels_minimum_and_partial_failure(self):
  a,p,v=self.starting();self.project(v,1,.2);self.choose_volume(v,v,1);v.wait_for_timeout(600);self.activate(v,'mpr-sagittal');v.get_by_label('Wheel Changes Thickness',exact=True).check();center=self.handles(v)['center'];point=[center[0]+45,center[1]];before=self.volume_state(v)
  for _ in range(15):self.wheel_at(v,point)
  self.assertAlmostEqual(self.slabs(v)[0]['total'],15.2,delta=1e-6);self.assertEqual(self.slabs(v)[0]['blend'],1)
  pixel="()=>{const v=services.cornerstoneViewportService.getCornerstoneViewport('mpr-axial'),c=v.getCanvas(),q=v.worldToCanvas([32,31,16]);return c.getContext('2d').getImageData(Math.floor(q[0]*c.width/c.clientWidth),Math.floor(q[1]*c.height/c.clientHeight),1,1).data[0]}"
  self.assertAlmostEqual(v.evaluate(pixel),229,delta=3)
  for _ in range(17):self.wheel_at(v,point,120)
  self.assertEqual(self.slabs(v)[0],{'total':.2,'blend':1});self.assertAlmostEqual(v.evaluate(pixel),127,delta=3);self.wheel_at(v,point);self.assertEqual(self.slabs(v)[0],{'total':1.2,'blend':1})
  for old,new in zip(before,self.volume_state(v)):
   for key in ['position','focalPoint','viewUp','viewPlaneNormal']:np.testing.assert_allclose(new['camera'][key],old['camera'][key],atol=1e-6,rtol=0)
  # The mode changes first; failure to set thickness must restore it too.
  v.evaluate("()=>{window.wheelFail=services.cornerstoneViewportService.getCornerstoneViewport('mpr-axial');wheelFail.setBlendMode(0);wheelFail.setSlabThickness(.1);wheelFail.render();window.oldSlab=wheelFail.setSlabThickness;window.wheelFailures=0;wheelFail.setSlabThickness=function(...args){if(wheelFailures++===0)throw Error('Synthetic wheel slab failure');return oldSlab.apply(this,args)}}");before=self.slabs(v);self.wheel_at(v,point);self.assertGreater(v.evaluate('()=>wheelFailures'),0);self.assertEqual(self.slabs(v),before);v.wait_for_timeout(1200);expect(v.locator('#kin-volume-crosshair [role=status]')).to_contain_text('Synthetic wheel slab failure');v.evaluate('()=>wheelFail.setSlabThickness=oldSlab');self.assertEqual(len(self.versions(a)),1)
 def test_wheel_04_small_deltas_both_lines_limit_and_disposal(self):
  a,p,v=self.starting();self.activate(v);v.get_by_label('Wheel Changes Thickness',exact=True).check();v.get_by_label('Crosshair Style',exact=True).select_option('normal');v.wait_for_function('()=>document.querySelectorAll("[data-kin-crosshair]").length===6');center=self.handles(v)['center'];before=self.slabs(v)
  for _ in range(11):self.wheel_at(v,center,-10)
  self.assertEqual(self.slabs(v),before);self.wheel_at(v,center,-10);after=self.slabs(v);self.assertEqual(after[0],before[0])
  for i in [1,2]:self.assertAlmostEqual(after[i]['total'],before[i]['total']+1,delta=1e-6)
  self.wheel_at(v,center,-100)
  for i in [1,2]:self.assertAlmostEqual(self.slabs(v)[i]['total'],before[i]['total']+2,delta=1e-6)
  self.wheel_at(v,center,-53)
  for i in [1,2]:self.assertAlmostEqual(self.slabs(v)[i]['total'],before[i]['total']+3,delta=1e-6)
  maximum=math.hypot(63,63,32);v.evaluate("maximum=>{for(const id of ['mpr-sagittal','mpr-coronal']){const v=services.cornerstoneViewportService.getCornerstoneViewport(id);v.setSlabThickness((maximum-.5)/2);v.render()}gestureVP.render()}",maximum);v.wait_for_timeout(150);self.wheel_at(v,center)
  for i in [1,2]:self.assertAlmostEqual(self.slabs(v)[i]['total'],maximum,delta=1e-6)
  before=self.slabs(v);v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(v.locator('#kin-volume-crosshair')).to_have_count(0);self.wheel_at(v,center);self.assertEqual(self.slabs(v),before);self.assertEqual(len(self.versions(a)),1)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeWheelE2E(n) for n in loader.getTestCaseNames(VolumeWheelE2E) if n.startswith('test_wheel_'))
if __name__=='__main__':unittest.main(verbosity=2)
