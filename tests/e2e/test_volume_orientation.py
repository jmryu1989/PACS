# coding: utf-8
"""TEST-VOLUME-ORIENTATION: native oblique planes, known voxels, reset and saved job."""
import math,json,unittest
import numpy as np
from playwright.sync_api import expect
from test_volume_jobs import VolumeJobsE2E
from test_embedded_patient_copy import EmbeddedPatientCopyE2E

class VolumeOrientationE2E(VolumeJobsE2E):
 def starting(self):
  a,p,v=self.opened_projection();expect(v.locator('#kin-volume-orientation')).to_be_visible();expect(v.get_by_role('button',name='Reset Planes',exact=True)).to_be_enabled()
  v.get_by_role('button',name='Reset Planes',exact=True).click();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('시작 MPR 화면');return a,p,v
 def rotate_planes(self,v,axis,angle):
  v.get_by_label('MPR Rotation Axis',exact=True).select_option(str(axis));v.get_by_label('MPR Rotation Degrees',exact=True).fill(str(angle));v.get_by_role('button',name='Rotate Three Planes',exact=True).click();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text(str(angle)+'도 회전했습니다')
 def test_orientation_01_double_oblique_pixels_reset_and_saved_reopen(self):
  a,p,v=self.starting();before=self.volume_state(v);original=self.originals();p.locator('#findings').fill('KEEP OBLIQUE REPORT')
  normals=np.array([c['camera']['viewPlaneNormal'] for c in before]);focals=np.array([c['camera']['focalPoint'] for c in before]);pivot=np.linalg.solve(normals,np.sum(normals*focals,axis=1))
  self.rotate_planes(v,0,25);self.rotate_planes(v,1,-35)
  x,y=math.radians(25),math.radians(-35);rx=np.array([[1,0,0],[0,math.cos(x),-math.sin(x)],[0,math.sin(x),math.cos(x)]]);ry=np.array([[math.cos(y),0,math.sin(y)],[0,1,0],[-math.sin(y),0,math.cos(y)]]);rotation=ry@rx
  after=self.volume_state(v);samples=[]
  for old,new in zip(before,after):
   for key in ['viewUp','viewPlaneNormal']:np.testing.assert_allclose(new['camera'][key],rotation@old['camera'][key],atol=1e-6)
   for key in ['focalPoint','position']:np.testing.assert_allclose(new['camera'][key],pivot+rotation@(np.array(old['camera'][key])-pivot),atol=1e-6)
   n=rotation@old['camera']['viewPlaneNormal'];direction=np.array([0.,0.,1.])-n*n[2];direction/=np.linalg.norm(direction);samples.append([(pivot+direction*d).tolist() for d in [-12,0,12]])
  values=v.evaluate('''points=>Array.from(services.viewportGridService.getState().viewports.keys()).map((id,i)=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id),c=v.getCanvas();return points[i].map(point=>{const xy=v.worldToCanvas(point);return c.getContext('2d').getImageData(Math.floor(xy[0]*c.width/c.clientWidth),Math.floor(xy[1]*c.height/c.clientHeight),1,1).data[0]})})''',samples)
  for row in values:
   for got,want in zip(row,[25,127,229]):self.assertAlmostEqual(got,want,delta=3)
  self.save_volume(v);saved=self.get_volume_job(a)
  v.get_by_role('button',name='Reset Planes',exact=True).click();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('시작 MPR 화면');self.preserved_volume(before,self.volume_state(v))
  fresh=self.login();self.launch(fresh,[a]);self.ready(fresh);fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000)
  restored=self.volume_state(fresh)
  for expected,actual in zip(saved['snapshot']['cells'],restored):
   for key in ['focalPoint','position','viewUp','viewPlaneNormal']:np.testing.assert_allclose(actual['camera'][key],expected['camera'][key],atol=1e-6)
  expect(p.locator('#findings')).to_have_value('KEEP OBLIQUE REPORT');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1);print('OBLIQUE_PIXELS',json.dumps({'pivot':pivot.tolist(),'values':values}),flush=True)
 def test_orientation_03_partial_camera_failure_rolls_back(self):
  a,p,v=self.starting();before=self.volume_state(v);original=self.originals();p.locator('#findings').fill('KEEP FAILED ROTATION')
  v.evaluate('''()=>{const ids=[...services.viewportGridService.getState().viewports.keys()];const view=services.cornerstoneViewportService.getCornerstoneViewport(ids[1]);const original=view.setCamera;let failed=false;view.setCamera=function(camera){if(camera.position&&!failed){failed=true;throw Error('INJECTED CAMERA FAILURE')}return original.call(this,camera)}}''')
  v.get_by_role('button',name='Rotate Three Planes',exact=True).click();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('INJECTED CAMERA FAILURE');self.preserved_volume(before,self.volume_state(v))
  self.rotate_planes(v,2,15);expect(p.locator('#findings')).to_have_value('KEEP FAILED ROTATION');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1)
 def test_orientation_04_embedded_owner_and_hidden_report(self):
  a,b=self.pair();p,f=EmbeddedPatientCopyE2E.opened(self,a);self.mpr(f);self.choose_volume(p,f,1);p.locator('#findings').fill('KEEP EMBEDDED OBLIQUE');p.wait_for_timeout(600) # Allow the 500ms target caption to observe the explicit plane selection.
  button=f.get_by_role('button',name='Rotate Three Planes',exact=True,include_hidden=True);expect(button).to_be_enabled();self.rotate_planes(f,2,15);before=self.volume_state(f)
  p.evaluate("()=>{window.savedOrientationOwner=KinWorkspaceLayout.key;KinWorkspaceLayout.key=()=>{throw Error('OWNER UNAVAILABLE')}}");expect(button).to_be_disabled();button.dispatch_event('click');self.preserved_volume(before,self.volume_state(f));p.evaluate('()=>KinWorkspaceLayout.key=window.savedOrientationOwner');expect(button).to_be_enabled()
  p.get_by_role('button',name='Back to Worklist',exact=True).click();expect(button).to_be_disabled();button.dispatch_event('click');self.preserved_volume(before,self.volume_state(f));expect(p.locator('#findings')).to_have_value('KEEP EMBEDDED OBLIQUE')
 def test_orientation_02_invalid_geometry_modal_and_session(self):
  a,p,v=self.starting();before=self.volume_state(v)
  for value in ['','181','-181']:
   v.get_by_label('MPR Rotation Degrees',exact=True).fill(value);v.get_by_role('button',name='Rotate Three Planes',exact=True).click();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('범위의 각도');self.preserved_volume(before,self.volume_state(v))
  v.get_by_label('MPR Rotation Degrees',exact=True).fill('15');v.evaluate('()=>{const vol=cornerstone.cache.getVolume(projectionVP.getVolumeId());window.obliqueMeta=cornerstone.metaData.get("instance",vol.imageIds.at(-1));window.obliqueSpacing=obliqueMeta.PixelSpacing;obliqueMeta.PixelSpacing=[2,2]}')
  v.get_by_role('button',name='Rotate Three Planes',exact=True).click();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('원본 좌표');self.preserved_volume(before,self.volume_state(v));v.evaluate('()=>obliqueMeta.PixelSpacing=obliqueSpacing')
  self.open_note(v);expect(v.get_by_role('button',name='Rotate Three Planes',exact=True)).to_be_disabled();v.locator('#tech-note-close').click();expect(v.get_by_role('button',name='Rotate Three Planes',exact=True)).to_be_enabled()
  v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(v.locator('#kin-volume-orientation')).to_have_count(0)
 def test_orientation_05_missing_asset_keeps_existing_tools(self):
  a,b=self.pair();p=self.login();p.route('**/volume-orientation.js',lambda route:route.abort());v=self.launch(p,[a]);self.ready(v);self.save_volume(v);self.assertEqual(self.get_volume_job(a)['snapshot']['version'],2)
  self.mpr(v);expect(v.locator('#kin-volume-orientation')).to_have_count(0);self.open_note(v);expect(v.locator('#tech-note-target')).to_contain_text(a.uid);v.locator('#tech-note-close').click();self.assertEqual(len(self.versions(a)),1)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeOrientationE2E(n) for n in loader.getTestCaseNames(VolumeOrientationE2E) if n.startswith('test_orientation_'))
if __name__=='__main__':unittest.main(verbosity=2)
