# coding: utf-8
"""TEST-VOLUME-GESTURE: real native toolbar/pointer input and patient-space oracle."""
import math,unittest
import numpy as np
from playwright.sync_api import expect
from test_volume_crosshair import VolumeCrosshairE2E

class VolumeGestureE2E(VolumeCrosshairE2E):
 def activate(self,v,id='mpr-axial'):
  v.locator('button[data-cy="Crosshairs"]').click()
  v.wait_for_function("()=>cornerstoneTools.ToolGroupManager.getToolGroup('mpr').getToolOptions('Crosshairs').mode==='Active'")
  v.evaluate("""id=>{window.gestureTool=cornerstoneTools.ToolGroupManager.getToolGroup('mpr').getToolInstance('Crosshairs');window.gestureVP=services.cornerstoneViewportService.getCornerstoneViewport(id);window.gestureEvents=[];gestureVP.element.addEventListener(cornerstoneTools.Enums.Events.MOUSE_DRAG,e=>gestureEvents.push({op:gestureTool.editData?.annotation.data.handles.activeOperation,previous:e.detail.lastPoints.world,current:e.detail.currentPoints.world,delta:e.detail.deltaPoints.world}),true)}""",id)
 def handles(self,v):
  return v.evaluate("""()=>{const a=cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='Crosshairs'&&a.data.viewportId===gestureVP.id);return {center:gestureVP.worldToCanvas(gestureTool.toolCenter),rotation:a.data.handles.rotationPoints.map(p=>gestureVP.worldToCanvas(p[0])),slab:a.data.handles.slabThicknessPoints.map(p=>({point:gestureVP.worldToCanvas(p[0]),other:p[1].id}))}}""")
 def drag(self,v,start,end,steps=8,release=True):
  box=v.locator('#svg-layer-'+v.evaluate('()=>gestureVP.id')).bounding_box()
  v.mouse.move(box['x']+start[0],box['y']+start[1]);v.wait_for_timeout(100);v.mouse.down();v.mouse.move(box['x']+end[0],box['y']+end[1],steps=steps)
  if release:v.mouse.up();v.wait_for_timeout(450)
 def rotate_mouse(self,v,degrees,steps=8):
  data=self.handles(v);center=np.array(data['center']);start=np.array(data['rotation'][0]);angle=math.radians(degrees);matrix=np.array([[math.cos(angle),-math.sin(angle)],[math.sin(angle),math.cos(angle)]]);end=center+matrix@(start-center)
  before=self.volume_state(v);cameras=[x['camera'] for x in before];normals=np.array([c['viewPlaneNormal'] for c in cameras]);pivot=np.linalg.solve(normals,np.einsum('ij,ij->i',normals,[c['focalPoint'] for c in cameras]));active=v.evaluate('()=>gestureVP.id');index=next(i for i,x in enumerate(before) if x['id']==active);normal=normals[index]
  v.evaluate('()=>gestureEvents=[]');self.drag(v,start.tolist(),end.tolist(),steps);events=v.evaluate('()=>gestureEvents');self.assertGreater(len(events),0);self.assertTrue(all(e['op']==2 for e in events))
  # The browser quantizes pointer coordinates. Derive the exact requested angle
  # independently from native input positions, not our product's angle helper.
  angle=0
  for e in events:
   a=np.array(e['previous'])-pivot;b=np.array(e['current'])-pivot;a-=normal*np.dot(a,normal);b-=normal*np.dot(b,normal);angle+=math.atan2(np.dot(np.cross(a,b),normal),np.dot(a,b))
  k=np.array([[0,-normal[2],normal[1]],[normal[2],0,-normal[0]],[-normal[1],normal[0],0]]);matrix=np.eye(3)*math.cos(angle)+(1-math.cos(angle))*np.outer(normal,normal)+math.sin(angle)*k
  after=self.volume_state(v)
  for i,(old,new) in enumerate(zip(cameras,[x['camera'] for x in after])):
   for key in ['viewUp','viewPlaneNormal','focalPoint','position']:
    expected=np.array(old[key]) if i==index else matrix@old[key] if key in ['viewUp','viewPlaneNormal'] else pivot+matrix@(np.array(old[key])-pivot)
    np.testing.assert_allclose(new[key],expected,atol=2e-5,rtol=0)
  np.testing.assert_allclose(v.evaluate('()=>gestureTool.toolCenter'),pivot,atol=.001,rtol=0)
  print('POINTER_ROTATION_DEGREES',math.degrees(angle),'EVENTS',len(events),flush=True)
 def test_gesture_01_rotation_slow_flip_and_reopen(self):
  a,p,v=self.starting();original=self.originals();p.locator('#findings').fill('KEEP GESTURE REPORT');self.activate(v);self.rotate_mouse(v,15,8)
  v.evaluate("()=>{gestureVP.setCamera({flipHorizontal:true});gestureVP.render()}");v.wait_for_timeout(100);self.rotate_mouse(v,-15,100)
  v.evaluate("()=>{gestureVP.setCamera({flipHorizontal:false});gestureVP.render()}");self.rotate_planes(v,0,25);self.rotate_planes(v,1,-35);self.save_volume(v);saved=self.get_volume_job(a)
  fresh=self.login();self.launch(fresh,[a]);self.ready(fresh);fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000)
  for expected,actual in zip(saved['snapshot']['cells'],self.volume_state(fresh)):
   for key in ['viewUp','viewPlaneNormal','focalPoint','position']:np.testing.assert_allclose(actual['camera'][key],expected['camera'][key],atol=1e-6,rtol=0)
  cameras=[cell['camera'] for cell in saved['snapshot']['cells']];normals=np.array([c['viewPlaneNormal'] for c in cameras]);pivot=np.linalg.solve(normals,np.einsum('ij,ij->i',normals,[c['focalPoint'] for c in cameras]));points=[]
  for normal in normals:
   direction=np.array([0.,0.,1.])-normal*normal[2];direction/=direction[2];points.append([(pivot+direction*d).tolist() for d in [-10,0,10]])
  for page in [v,fresh]:
   pixels=page.evaluate("""points=>[...services.viewportGridService.getState().viewports.keys()].map((id,i)=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id),c=v.getCanvas();return points[i].map(p=>{const q=v.worldToCanvas(p);return c.getContext('2d').getImageData(Math.floor(q[0]*c.width/c.clientWidth),Math.floor(q[1]*c.height/c.clientHeight),1,1).data[0]})})""",points)
   for row in pixels:
    for got,want in zip(row,[25,127,229]):self.assertAlmostEqual(got,want,delta=3)
   print('GESTURE_REOPEN_PHANTOM',pixels,flush=True)
  expect(p.locator('#findings')).to_have_value('KEEP GESTURE REPORT');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1)
 def test_gesture_02_cancel_during_drag(self):
  a,p,v=self.starting();self.activate(v);data=self.handles(v);start=data['rotation'][0];v.evaluate('()=>window.dragWrapper=gestureTool._dragCallback');self.drag(v,start,[start[0]-10,start[1]],release=False)
  v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(v.locator('#kin-volume-crosshair')).to_have_count(0);self.assertTrue(v.evaluate('()=>gestureTool._dragCallback!==dragWrapper&&gestureTool.editData===null'))
  v.wait_for_timeout(500) # Disposal schedules a native render; sample its completed pixels.
  before=self.volume_state(v);errors=[];v.on('pageerror',lambda e:errors.append(str(e)));v.mouse.move(500,500,steps=8);v.mouse.up();v.wait_for_timeout(450);self.preserved_volume(before,self.volume_state(v));self.assertEqual(errors,[]);self.assertEqual(len(self.versions(a)),1)
 def test_gesture_03_line_and_slab_patient_geometry(self):
  a,p,v=self.starting();original=self.originals();self.activate(v);data=self.handles(v);cx,cy=data['center'];before=self.volume_state(v)
  self.drag(v,[cx+45,cy],[cx+45,cy+18]);events=v.evaluate('()=>gestureEvents');self.assertTrue(events);self.assertTrue(all(e['op']==1 for e in events));delta=np.sum([e['delta'] for e in events],axis=0);after=self.volume_state(v)
  for i,(old,new) in enumerate(zip(before,after)):
   normal=np.array(old['camera']['viewPlaneNormal']);shift=normal*np.dot(delta,normal) if i==2 else np.zeros(3)
   for key in ['position','focalPoint']:np.testing.assert_allclose(new['camera'][key],np.array(old['camera'][key])+shift,atol=.001,rtol=0)
   np.testing.assert_allclose(new['camera']['viewPlaneNormal'],normal,atol=1e-8,rtol=0)
  # Start with a clearly separated slab boundary; its native property is half
  # thickness in patient millimetres. Initial configuration is not an input test.
  v.evaluate("()=>{const other=services.cornerstoneViewportService.getCornerstoneViewport('mpr-sagittal');gestureTool.setSlabThickness(other,4);other.render();gestureVP.render();gestureEvents=[]}");v.wait_for_timeout(150);data=self.handles(v);handle=next(h for h in data['slab'] if h['other']=='mpr-sagittal');start=handle['point'];before=self.volume_state(v)
  self.drag(v,start,[start[0]+20,start[1]],steps=1);events=v.evaluate('()=>gestureEvents');self.assertTrue(events);self.assertTrue(all(e['op']==3 for e in events));delta=np.sum([e['delta'] for e in events],axis=0);half=v.evaluate("()=>services.cornerstoneViewportService.getCornerstoneViewport('mpr-sagittal').getSlabThickness()");self.assertAlmostEqual(half,4+float(np.dot(delta,before[1]['camera']['viewPlaneNormal'])),delta=.001)
  for old,new in zip(before,self.volume_state(v)):
   for key in ['position','focalPoint','viewUp','viewPlaneNormal']:np.testing.assert_allclose(new['camera'][key],old['camera'][key],atol=1e-6,rtol=0)
  self.save_volume(v);saved=self.get_volume_job(a);self.assertAlmostEqual(saved['snapshot']['cells'][1]['projection']['thickness'],half*2,delta=.001);self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1);print('SLAB_TOTAL_MM',half*2,flush=True)
 def test_gesture_04_partial_camera_failure_rolls_back(self):
  a,p,v=self.starting();self.activate(v);before=self.volume_state(v);data=self.handles(v);start=data['rotation'][0]
  v.evaluate("()=>{window.failVP=services.cornerstoneViewportService.getCornerstoneViewport('mpr-coronal');window.setBefore=failVP.setCamera;window.failCount=0;failVP.setCamera=function(camera,...args){if(camera.viewPlaneNormal&&failCount++===0)throw Error('Synthetic gesture camera failure');return setBefore.call(this,camera,...args)}}")
  self.drag(v,start,[start[0]-20,start[1]],steps=1);self.assertGreater(v.evaluate('()=>failCount'),0);v.evaluate('()=>failVP.setCamera=setBefore');self.preserved_volume(before,self.volume_state(v));self.assertEqual(len(self.versions(a)),1)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeGestureE2E(n) for n in loader.getTestCaseNames(VolumeGestureE2E) if n.startswith('test_gesture_'))
if __name__=='__main__':unittest.main(verbosity=2)
