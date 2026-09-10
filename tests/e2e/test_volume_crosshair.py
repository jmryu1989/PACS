# coding: utf-8
import json,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_volume_orientation import VolumeOrientationE2E

class VolumeCrosshairE2E(VolumeOrientationE2E):
 def lines(self,v):
  return v.evaluate('''()=>[...services.viewportGridService.getState().viewports.keys()].map(id=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id);return [...v.element.querySelectorAll('[data-kin-crosshair]')].map(n=>({tag:n.tagName,index:n.getAttribute('data-kin-crosshair'),attributes:Object.fromEntries([...n.attributes].map(a=>[a.name,a.value])),world:n.tagName==='line'?[[+n.getAttribute('x1'),+n.getAttribute('y1')],[+n.getAttribute('x2'),+n.getAttribute('y2')]].map(p=>v.canvasToWorld(p)):[]}))})''')
 def test_crosshair_01_styles_hide_and_preserve_oblique(self):
  a,p,v=self.starting();self.rotate_planes(v,0,25);self.rotate_planes(v,1,-35);p.locator('#findings').fill('KEEP CROSSHAIR REPORT');original=self.originals()
  v.get_by_role('button',name='Show Crosshairs',exact=True).click();v.wait_for_function("()=>document.querySelectorAll('[data-kin-crosshair]').length===12");before=self.volume_state(v)
  import numpy as np
  for style,count in [('normal',2),('gap',4),('small',2),('tapered',4)]:
   v.get_by_label('Crosshair Style',exact=True).select_option(style);v.wait_for_function('(count)=>document.querySelectorAll("[data-kin-crosshair]").length===count',arg=count*3);data=self.lines(v)
   for index,items in enumerate(data):
    self.assertEqual(len(items),count)
    if style=='tapered':self.assertTrue(all(item['tag']=='polygon' for item in items));continue
    for item in items:
     for point in item['world']:
      current=before[index]['camera'];self.assertAlmostEqual(float(np.dot(np.array(point)-current['focalPoint'],current['viewPlaneNormal'])),0,delta=.001)
      residuals=[abs(float(np.dot(np.array(point)-camera['camera']['focalPoint'],camera['camera']['viewPlaneNormal']))) for j,camera in enumerate(before) if j!=index];self.assertLess(min(residuals),.001)
   self.preserved_volume(before,self.volume_state(v))
  v.get_by_label('Crosshair Plane 2',exact=True).uncheck();v.wait_for_function('()=>document.querySelectorAll("#svg-layer-mpr-sagittal [data-kin-crosshair]").length===0');data=self.lines(v);self.assertEqual([len(x) for x in data],[4,0,4]);self.preserved_volume(before,self.volume_state(v))
  v.get_by_label('Crosshair Plane 2',exact=True).check();v.wait_for_function('()=>document.querySelectorAll("[data-kin-crosshair]").length===12');self.preserved_volume(before,self.volume_state(v));expect(p.locator('#findings')).to_have_value('KEEP CROSSHAIR REPORT');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1)
  folder=Path('../tmp/volume-crosshair/screens');folder.mkdir(parents=True,exist_ok=True);v.screenshot(path=str(folder/'crosshair-styles.png'));print('STYLES_AND_OBLIQUE_PLANES_PASS',flush=True)
 def test_crosshair_02_hidden_active_tool_and_lifecycle(self):
  a,p,v=self.starting();v.get_by_role('button',name='Show Crosshairs',exact=True).click();v.wait_for_function("()=>document.querySelectorAll('[data-kin-crosshair]').length===12")
  v.evaluate("()=>{const g=cornerstoneTools.ToolGroupManager.getToolGroup('mpr');for(const [name,option] of Object.entries(g.toolOptions))if(option.mode==='Active'&&option.bindings.some(b=>b.mouseButton===1))g.setToolPassive(name);g.setToolActive('Crosshairs',{bindings:[{mouseButton:1}]});window.crosshairTool=g.getToolInstance('Crosshairs');window.crosshairWrapped=crosshairTool.renderAnnotation;}")
  errors=[];v.on('pageerror',lambda error:errors.append(str(error)))
  v.get_by_label('Crosshair Plane 1',exact=True).uncheck();v.wait_for_function('()=>document.querySelectorAll("#svg-layer-mpr-axial [data-kin-crosshair]").length===0');before=self.volume_state(v)
  canvas=v.locator('#svg-layer-mpr-axial');box=canvas.bounding_box();v.mouse.click(box['x']+box['width']*.6,box['y']+box['height']*.6);v.wait_for_timeout(450) # Native dispatch waits 400ms to distinguish a double click.
  self.preserved_volume(before,self.volume_state(v));self.assertEqual(errors,[])
  v.get_by_label('Crosshair Plane 1',exact=True).check();v.wait_for_function('()=>document.querySelectorAll("#svg-layer-mpr-axial [data-kin-crosshair]").length===4');v.mouse.click(box['x']+box['width']*.6,box['y']+box['height']*.6)
  v.wait_for_function('(before)=>[...services.viewportGridService.getState().viewports.keys()].some((id,i)=>services.cornerstoneViewportService.getCornerstoneViewport(id).getCamera().focalPoint.some((x,j)=>Math.abs(x-before[i].camera.focalPoint[j])>.01))',arg=before)
  self.assertEqual(errors,[])
  self.open_note(v);expect(v.get_by_role('button',name='Show Crosshairs',exact=True)).to_be_disabled();v.locator('#tech-note-close').click();expect(v.get_by_role('button',name='Show Crosshairs',exact=True)).to_be_enabled()
  v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(v.locator('#kin-volume-crosshair')).to_have_count(0);self.assertTrue(v.evaluate('()=>crosshairTool.renderAnnotation!==crosshairWrapped'))
 def test_crosshair_03_source_fallback_resize_and_recovery(self):
  a,p,v=self.starting();before=self.volume_state(v);v.get_by_role('button',name='Show Crosshairs',exact=True).click();v.wait_for_function("()=>document.querySelectorAll('[data-kin-crosshair]').length===12");self.preserved_volume(before,self.volume_state(v))
  v.get_by_label('Crosshair Plane 2',exact=True).uncheck();v.evaluate("()=>{window.cv=services.cornerstoneViewportService.getCornerstoneViewport('mpr-axial');window.crosshairVolume=cornerstone.cache.getVolume(cv.getVolumeId());window.crosshairTool=cornerstoneTools.ToolGroupManager.getToolGroup('mpr').getToolInstance('Crosshairs');crosshairVolume.framesLoaded--}")
  v.wait_for_function("()=>!Object.hasOwn(crosshairTool,'_pointNearTool')");v.evaluate('()=>crosshairVolume.framesLoaded++');expect(v.get_by_label('Crosshair Plane 2',exact=True)).not_to_be_checked();v.wait_for_function("()=>Object.hasOwn(crosshairTool,'_pointNearTool')")
  v.set_viewport_size({'width':1450,'height':1000});expect(v.get_by_label('Crosshair Plane 2',exact=True)).not_to_be_checked();v.wait_for_function('()=>document.querySelectorAll("#svg-layer-mpr-sagittal [data-kin-crosshair]").length===0');v.get_by_label('Crosshair Plane 2',exact=True).check()
  errors=[];v.on('pageerror',lambda error:errors.append(str(error)));v.get_by_label('Crosshair Style',exact=True).evaluate("e=>{e.value='';e.dispatchEvent(new Event('change',{bubbles:true}))}")
  v.wait_for_function('()=>document.querySelectorAll("[data-kin-crosshair]").length===0&&document.querySelectorAll("#svg-layer-mpr-axial line").length>=4');self.assertEqual(errors,[])
  v.get_by_label('Crosshair Style',exact=True).select_option('small');v.wait_for_function('()=>document.querySelectorAll("[data-kin-crosshair]").length===6');self.assertEqual(errors,[])
 def test_crosshair_04_pan_zoom_and_saved_reopen(self):
  import numpy as np
  a,p,v=self.starting();self.rotate_planes(v,0,25);self.rotate_planes(v,1,-35);v.get_by_role('button',name='Show Crosshairs',exact=True).click()
  v.evaluate("()=>{const v=services.cornerstoneViewportService.getCornerstoneViewport('mpr-axial'),c=v.getCamera(),delta=c.viewUp.map(x=>x*2);v.setCamera({focalPoint:c.focalPoint.map((x,i)=>x+delta[i]),position:c.position.map((x,i)=>x+delta[i]),parallelScale:c.parallelScale*.8});v.render()}")
  v.get_by_label('Crosshair Style',exact=True).select_option('small');v.wait_for_function('()=>document.querySelectorAll("[data-kin-crosshair]").length===6');self.save_volume(v);saved=self.get_volume_job(a)
  fresh=self.login();self.launch(fresh,[a]);self.ready(fresh);fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000)
  fresh.get_by_role('button',name='Show Crosshairs',exact=True).click();fresh.get_by_label('Crosshair Style',exact=True).select_option('small');fresh.wait_for_function('()=>document.querySelectorAll("[data-kin-crosshair]").length===6')
  cameras=[cell['camera'] for cell in saved['snapshot']['cells']]
  normals=np.array([c['viewPlaneNormal'] for c in cameras]);focals=np.array([c['focalPoint'] for c in cameras]);pivot=np.linalg.solve(normals,np.sum(normals*focals,axis=1));samples=[]
  for n in normals:
   direction=np.array([0.,0.,1.])-n*n[2];direction/=np.linalg.norm(direction);samples.append([(pivot+direction*d).tolist() for d in [-12,0,12]])
  for page in [v,fresh]:
   values=page.evaluate('''points=>[...services.viewportGridService.getState().viewports.keys()].map((id,i)=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id),c=v.getCanvas();return points[i].map(p=>{const xy=v.worldToCanvas(p);return c.getContext('2d').getImageData(Math.floor(xy[0]*c.width/c.clientWidth),Math.floor(xy[1]*c.height/c.clientHeight),1,1).data[0]})})''',samples)
   for row in values:
    for got,want in zip(row,[25,127,229]):self.assertAlmostEqual(got,want,delta=3)
   print('RESTORED_PHANTOM_PIXELS',values,flush=True)
   for index,items in enumerate(self.lines(page)):
    self.assertEqual(len(items),2)
    for item in items:
     for point in item['world']:
      self.assertAlmostEqual(float(np.dot(np.array(point)-cameras[index]['focalPoint'],cameras[index]['viewPlaneNormal'])),0,delta=.001)
      self.assertLess(min(abs(float(np.dot(np.array(point)-c['focalPoint'],c['viewPlaneNormal']))) for j,c in enumerate(cameras) if j!=index),.001)
  self.assertEqual(len(self.versions(a)),1)
 def test_crosshair_05_visible_crosshair_same_window_restore(self):
  import numpy as np
  a,p,v=self.starting();self.rotate_planes(v,0,25);self.rotate_planes(v,1,-35);v.get_by_role('button',name='Show Crosshairs',exact=True).click();v.get_by_label('Crosshair Style',exact=True).select_option('small');v.wait_for_function('()=>document.querySelectorAll("[data-kin-crosshair]").length===6');self.save_volume(v);saved=self.get_volume_job(a)
  v.evaluate("()=>{window.originalCrosshairReset=cornerstoneTools.ToolGroupManager.getToolGroup('mpr').getToolInstance('Crosshairs').onResetCamera;const v=services.cornerstoneViewportService.getCornerstoneViewport('mpr-axial'),c=v.getCamera(),d=c.viewPlaneNormal.map(x=>x*2);v.setCamera({focalPoint:c.focalPoint.map((x,i)=>x+d[i]),position:c.position.map((x,i)=>x+d[i])});v.render()}");v.get_by_role('button',name='Restore Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000);v.wait_for_timeout(700)
  self.assertTrue(v.evaluate("()=>cornerstoneTools.ToolGroupManager.getToolGroup('mpr').getToolInstance('Crosshairs').onResetCamera===originalCrosshairReset"))
  v.wait_for_function('()=>document.querySelectorAll("[data-kin-crosshair]").length===6');cameras=[cell['camera'] for cell in saved['snapshot']['cells']];normals=np.array([c['viewPlaneNormal'] for c in cameras]);focals=np.array([c['focalPoint'] for c in cameras]);pivot=np.linalg.solve(normals,np.sum(normals*focals,axis=1));center=v.evaluate("()=>cornerstoneTools.ToolGroupManager.getToolGroup('mpr').getToolInstance('Crosshairs').toolCenter");np.testing.assert_allclose(center,pivot,atol=.001)
  for index,items in enumerate(self.lines(v)):
   self.assertEqual(len(items),2)
   for item in items:
    for point in item['world']:self.assertLess(min(abs(float(np.dot(np.array(point)-c['focalPoint'],c['viewPlaneNormal']))) for j,c in enumerate(cameras) if j!=index),.001)
 def test_crosshair_06_restore_failure_keeps_prior_screen_and_reset_callback(self):
  opened=self.opened_projection;holder=[]
  def with_crosshairs():
   a,p,v=opened();v.get_by_role('button',name='Show Crosshairs',exact=True).click();v.evaluate("()=>window.originalCrosshairReset=cornerstoneTools.ToolGroupManager.getToolGroup('mpr').getToolInstance('Crosshairs').onResetCamera");holder.append(v);return a,p,v
  self.opened_projection=with_crosshairs
  self.test_volume_job_03_restore_failure_recovers_existing_mpr()
  self.assertTrue(holder[0].evaluate("()=>cornerstoneTools.ToolGroupManager.getToolGroup('mpr').getToolInstance('Crosshairs').onResetCamera===originalCrosshairReset"))
 def test_crosshair_07_session_cancellation_releases_native_callback(self):
  a,p,v=self.starting();v.get_by_role('button',name='Show Crosshairs',exact=True).click();self.save_volume(v)
  v.evaluate("()=>{window.cancelTool=cornerstoneTools.ToolGroupManager.getToolGroup('mpr').getToolInstance('Crosshairs');window.cancelReset=cancelTool.onResetCamera}");v.get_by_role('button',name='Restore Job',exact=True).click();v.wait_for_function('()=>cancelTool.onResetCamera!==cancelReset')
  v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(v.locator('#kin-volume-crosshair')).to_have_count(0);v.wait_for_function('()=>cancelTool.onResetCamera===cancelReset');self.assertEqual(len(self.versions(a)),1)
 def test_crosshair_08_missing_asset_preserves_rotation_and_stack_jobs(self):
  a,b=self.pair();p=self.login();p.route('**/volume-crosshair.js',lambda route:route.abort());v=self.launch(p,[a]);self.ready(v);self.save_volume(v);self.assertEqual(self.get_volume_job(a)['snapshot']['version'],2)
  self.mpr(v);expect(v.get_by_role('button',name='Rotate Three Planes',exact=True)).to_be_enabled();self.rotate_planes(v,2,15);expect(v.locator('#kin-volume-crosshair')).to_have_count(0)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeCrosshairE2E(n) for n in loader.getTestCaseNames(VolumeCrosshairE2E) if n.startswith('test_crosshair_'))
if __name__=='__main__':unittest.main(verbosity=2)
