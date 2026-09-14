# coding: utf-8
import json,unittest
from pathlib import Path
from playwright.sync_api import expect, TimeoutError as PlaywrightTimeout
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
 # A synthetic acquisition rotated 30 degrees about H/F and tilted 20 degrees: its volume axes
 # are not patient axes, so Basic Orthogonal must follow the native patient-axis planes.
 TILT=[0.8660254038,0.5,0,-0.4698463104,0.8137976813,0.3420201433]
 def starting_tilted(self):
  a,p,v=self.opened_projection(orientation=self.TILT);expect(v.get_by_role('button',name='Reset Planes',exact=True)).to_be_enabled()
  v.get_by_role('button',name='Reset Planes',exact=True).click();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('시작 MPR 화면');return a,p,v
 def basic(self,page):
  page.get_by_role('button',name='Basic Orthogonal',exact=True).click();expect(page.locator('#kin-volume-orientation [role=status]')).to_contain_text('기본 Axial·Sagittal·Coronal 방향으로 맞췄습니다')
 def settled(self,page):page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
 def native_planes(self,page):
  return page.evaluate("()=>({names:[...services.viewportGridService.getState().viewports.values()].map(c=>c.viewportOptions?.orientation),table:JSON.parse(JSON.stringify(cornerstone.CONSTANTS.MPR_CAMERA_VALUES))})")
 def assert_native_axes(self,cameras,native):
  import numpy as np
  self.assertEqual(sorted(native['names']),['axial','coronal','sagittal'])
  for camera,name in zip(cameras,native['names']):
   for key in ['viewPlaneNormal','viewUp']:np.testing.assert_allclose(camera[key],native['table'][name][key],atol=1e-6,rtol=0)
 def plane_offsets(self,cameras,pivot):
  import numpy as np
  rows=[]
  for c in cameras:
   n,u=np.array(c['viewPlaneNormal']),np.array(c['viewUp']);r=np.cross(u,n);f=np.array(c['focalPoint'])-pivot
   rows.append([float(f@r),float(f@u),float(f@n),float(np.linalg.norm(np.array(c['position'])-c['focalPoint'])),c['parallelScale']])
  return rows
 def screen_point(self,page,point):
  return page.evaluate("p=>[...services.viewportGridService.getState().viewports.keys()].map(id=>Array.from(services.cornerstoneViewportService.getCornerstoneViewport(id).worldToCanvas(p)))",list(map(float,point)))
 def display(self,page):
  return page.evaluate("()=>[...services.viewportGridService.getState().viewports.keys()].map(id=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id),p=v.getProperties();return {blend:v.getActors()[0].actor.getMapper().getBlendMode(),thickness:v.getSlabThickness(),voi:[p.voiRange.lower,p.voiRange.upper],invert:!!p.invert}})")
 # Linked MPR planes share one revision counter over native CAMERA_MODIFIED and IMAGE_RENDERED, so a plane
 # is ready only when a rendered frame came after its latest camera change, never after a fixed time.
 RENDER_PROOF='''ids=>{const E=window.cornerstone?.Enums?.Events;if(!E?.CAMERA_MODIFIED||!E?.IMAGE_RENDERED)throw Error('native CAMERA_MODIFIED/IMAGE_RENDERED events unavailable');
  const proof=window.kinRenderProof={revision:0,installedAt:performance.now(),events:[E.CAMERA_MODIFIED,E.IMAGE_RENDERED],views:{}};
  for(const id of ids){const element=services.cornerstoneViewportService.getCornerstoneViewport(id)?.element;if(!element)throw Error('linked viewport '+id+' has no element');
   const s=proof.views[id]={camera:0,cameraAt:null,cameras:0,render:0,renderAt:null,renders:0};
   element.addEventListener(E.CAMERA_MODIFIED,()=>{s.camera=++proof.revision;s.cameraAt=performance.now();s.cameras++});
   element.addEventListener(E.IMAGE_RENDERED,()=>{s.render=++proof.revision;s.renderAt=performance.now();s.renders++})}
  return proof}'''
 RENDER_READY="ids=>ids.every(id=>{const s=window.kinRenderProof?.views?.[id];return !!s&&s.cameras>0&&s.render>s.camera})"
 def await_final_render(self,page,ids,timeout=10000):
  try:page.wait_for_function(self.RENDER_READY,arg=ids,timeout=timeout)
  except PlaywrightTimeout:self.fail(f'linked planes {ids} drew no IMAGE_RENDERED after their last CAMERA_MODIFIED within {timeout}ms: '+json.dumps(page.evaluate('()=>window.kinRenderProof??null')))
  return page.evaluate('()=>JSON.parse(JSON.stringify({...kinRenderProof,readyAt:performance.now()}))')
 def test_crosshair_09_basic_orthogonal_tilted_source_keeps_pivot_pan_zoom_display_and_crosshair(self):
  import numpy as np
  a,p,v=self.starting_tilted();initial=self.cameras(v);native=self.native_planes(v);self.assert_native_axes(initial,native)
  original=self.originals();p.locator('#findings').fill('KEEP BASIC ORTHOGONAL REPORT')
  v.get_by_role('button',name='Show Crosshairs',exact=True).click();v.wait_for_function("()=>document.querySelectorAll('[data-kin-crosshair]').length===12")
  self.rotate_planes(v,0,25);self.rotate_planes(v,1,-35);self.rotate_planes(v,2,135)
  ax,sg,co=[native['names'].index(name) for name in ['axial','sagittal','coronal']]
  # MPR windowing sync is on by default and would copy the sagittal window to every plane.
  box=v.get_by_role('checkbox',name='Sync MPR Windowing',exact=True);expect(box).to_be_enabled();box.set_checked(False);expect(box).not_to_be_checked()
  v.evaluate("""([ax,sg,co])=>{const ids=[...services.viewportGridService.getState().viewports.keys()],get=i=>services.cornerstoneViewportService.getCornerstoneViewport(ids[i]);
   const axial=get(ax),c=axial.getCamera(),u=c.viewUp,n=c.viewPlaneNormal,right=[u[1]*n[2]-u[2]*n[1],u[2]*n[0]-u[0]*n[2],u[0]*n[1]-u[1]*n[0]],d=u.map((x,i)=>x*3-right[i]*4);
   axial.setCamera({focalPoint:c.focalPoint.map((x,i)=>x+d[i]),position:c.position.map((x,i)=>x+d[i]),parallelScale:c.parallelScale*.7});axial.render();
   const sagittal=get(sg);sagittal.setProperties({voiRange:{lower:0,upper:2000}});sagittal.render();
   const coronal=get(co);coronal.setBlendMode(1);coronal.setSlabThickness(5);coronal.render()}""",[ax,sg,co]);self.settled(v)
  v.wait_for_function("voi=>[...services.viewportGridService.getState().viewports.keys()].every((id,i)=>{const r=services.cornerstoneViewportService.getCornerstoneViewport(id).getProperties().voiRange;return Math.abs(r.lower-voi[i][0])<1e-6&&Math.abs(r.upper-voi[i][1])<1e-6})",arg=[[0,2000] if i==sg else [0,1000] for i in range(3)]);self.settled(v)
  before=self.cameras(v);pivot=self.pivot(before);offsets=self.plane_offsets(before,pivot);screen=self.screen_point(v,pivot);display=self.display(v)
  self.basic(v);self.settled(v);after=self.cameras(v)
  self.assert_native_axes(after,native);np.testing.assert_allclose(self.pivot(after),pivot,atol=1e-6,rtol=0)
  np.testing.assert_allclose(self.plane_offsets(after,pivot),offsets,atol=1e-6,rtol=0);np.testing.assert_allclose(self.screen_point(v,pivot),screen,atol=.01,rtol=0)
  for old,new in zip(display,self.display(v)):
   self.assertEqual((old['blend'],old['invert']),(new['blend'],new['invert']));self.assertAlmostEqual(old['thickness'],new['thickness'],delta=1e-6);np.testing.assert_allclose(new['voi'],old['voi'],atol=1e-6,rtol=0)
  np.testing.assert_allclose(v.evaluate("()=>Array.from(cornerstoneTools.ToolGroupManager.getToolGroup('mpr').getToolInstance('Crosshairs').toolCenter)"),pivot,atol=.001,rtol=0)
  for index,items in enumerate(self.lines(v)):
   self.assertEqual(len(items),4)
   for item in items:
    for point in item['world']:self.assertLess(min(abs(float(np.dot(np.array(point)-c['focalPoint'],c['viewPlaneNormal']))) for j,c in enumerate(after) if j!=index),.001)
  counts=self.band_pixels(v,self.TILT,skip={co},voi={sg:(0,2000)})
  self.basic(v);self.cameras_close(self.cameras(v),after,1e-7)
  v.get_by_role('button',name='Reset Planes',exact=True).click();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('시작 MPR 화면');self.cameras_close(self.cameras(v),initial,1e-6)
  expect(p.locator('#findings')).to_have_value('KEEP BASIC ORTHOGONAL REPORT');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1);self.assertEqual(self.jobs(a),[])
  folder=Path('../tmp/volume-crosshair/screens');folder.mkdir(parents=True,exist_ok=True);v.screenshot(path=str(folder/'basic-orthogonal-reset.png'))
  print('BASIC_ORTHOGONAL_TILTED',json.dumps({'names':native['names'],'pivot':pivot.tolist(),'normals':[c['viewPlaneNormal'] for c in after],'samples':counts}),flush=True)
 def test_crosshair_10_saved_oblique_job_reopens_to_basic_while_reset_keeps_restored_screen(self):
  import numpy as np
  a,p,v=self.starting_tilted();native=self.native_planes(v);original=self.originals();p.locator('#findings').fill('KEEP REOPENED BASIC REPORT')
  self.rotate_planes(v,0,-40);self.rotate_planes(v,2,160)
  v.evaluate("()=>{const v=services.cornerstoneViewportService.getCornerstoneViewport([...services.viewportGridService.getState().viewports.keys()][0]),c=v.getCamera(),d=c.viewUp.map(x=>x*-2);v.setCamera({focalPoint:c.focalPoint.map((x,i)=>x+d[i]),position:c.position.map((x,i)=>x+d[i]),parallelScale:c.parallelScale*1.2});v.render()}");self.settled(v)
  self.save_volume(v);saved=self.get_volume_job(a);cells=[cell['camera'] for cell in saved['snapshot']['cells']];pivot=self.pivot(cells)
  fresh=self.login();self.launch(fresh,[a]);self.ready(fresh);fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000)
  restored=self.cameras(fresh);self.cameras_close(restored,cells,1e-6);expect(fresh.get_by_role('button',name='Basic Orthogonal',exact=True)).to_be_enabled()
  self.basic(fresh);self.settled(fresh);basic=self.cameras(fresh)
  self.assert_native_axes(basic,native);np.testing.assert_allclose(self.pivot(basic),pivot,atol=1e-6,rtol=0);np.testing.assert_allclose(self.plane_offsets(basic,pivot),self.plane_offsets(restored,pivot),atol=1e-6,rtol=0)
  counts=self.band_pixels(fresh,self.TILT)
  fresh.get_by_role('button',name='Reset Planes',exact=True).click();expect(fresh.locator('#kin-volume-orientation [role=status]')).to_contain_text('시작 MPR 화면');self.cameras_close(self.cameras(fresh),cells,1e-6)
  self.basic(fresh);self.cameras_close(self.cameras(fresh),basic,1e-6)
  first=self.jobs(a)[0]['id'];self.save_volume(fresh);rows=self.jobs(a);self.assertEqual(len(rows),2);second=next(row for row in rows if row['id']!=first)
  stored=self.stack.request('GET',f'/studies/{a.uid}/viewer-jobs/{second["id"]}','doctor');self.assertEqual(stored.status,200,stored.text);self.cameras_close([cell['camera'] for cell in stored.body['snapshot']['cells']],basic,1e-6)
  expect(p.locator('#findings')).to_have_value('KEEP REOPENED BASIC REPORT');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1)
  print('BASIC_ORTHOGONAL_REOPENED',json.dumps({'pivot':pivot.tolist(),'samples':counts}),flush=True)
 def test_crosshair_11_basic_orthogonal_failure_flip_and_busy_keep_screen(self):
  import numpy as np
  a,p,v=self.starting();native=self.native_planes(v);original=self.originals();p.locator('#findings').fill('KEEP FAILED BASIC');self.rotate_planes(v,0,30)
  v.get_by_role('button',name='Show Crosshairs',exact=True).click();v.wait_for_function("()=>document.querySelectorAll('[data-kin-crosshair]').length===12")
  before=self.volume_state(v);pivot=self.pivot([s['camera'] for s in before])
  v.evaluate('''()=>{const ids=[...services.viewportGridService.getState().viewports.keys()];const view=services.cornerstoneViewportService.getCornerstoneViewport(ids[1]);const original=view.setCamera;let failed=false;view.setCamera=function(camera){if(camera.position&&!failed){failed=true;throw Error('INJECTED BASIC CAMERA FAILURE')}return original.call(this,camera)}}''')
  button=v.get_by_role('button',name='Basic Orthogonal',exact=True);button.click();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('INJECTED BASIC CAMERA FAILURE');self.settled(v)
  self.preserved_volume(before,self.volume_state(v));np.testing.assert_allclose(v.evaluate("()=>Array.from(cornerstoneTools.ToolGroupManager.getToolGroup('mpr').getToolInstance('Crosshairs').toolCenter)"),pivot,atol=.001,rtol=0)
  v.evaluate("()=>{const v=services.cornerstoneViewportService.getCornerstoneViewport([...services.viewportGridService.getState().viewports.keys()][2]);v.setCamera({flipHorizontal:true});v.render()}");self.settled(v)
  flipped=self.volume_state(v);self.assertTrue(flipped[2]['camera']['flipHorizontal'])
  button.click();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('뒤집기를 해제한 뒤');self.preserved_volume(flipped,self.volume_state(v))
  v.evaluate("()=>{const v=services.cornerstoneViewportService.getCornerstoneViewport([...services.viewportGridService.getState().viewports.keys()][2]);v.setCamera({flipHorizontal:false});v.render()}");self.settled(v)
  self.basic(v);self.assert_native_axes(self.cameras(v),native)
  self.open_note(v);expect(button).to_be_disabled();v.locator('#tech-note-close').click();expect(button).to_be_enabled()
  expect(p.locator('#findings')).to_have_value('KEEP FAILED BASIC');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1)
 def test_crosshair_12_native_rotate_handle_drag_follows_pointer_about_pivot(self):
  # Numeric Rotate Three Planes cannot prove line rotation: this drives the real pointer on the
  # native rotation handle and derives the expected planes from the sent pointer positions only.
  import math
  import numpy as np
  a,p,v=self.starting();original=self.originals();p.locator('#findings').fill('KEEP NATIVE ROTATE REPORT');errors=[];v.on('pageerror',lambda e:errors.append(str(e)))
  v.locator('button[data-cy="Crosshairs"]').click();v.wait_for_function("()=>cornerstoneTools.ToolGroupManager.getToolGroup('mpr').getToolOptions('Crosshairs')?.mode==='Active'")
  active=v.evaluate('()=>services.viewportGridService.getState().activeViewportId')
  # Readiness is the product wrapper bound to this tool plus native rotation handles on the active plane;
  # otherwise the unwrapped native drag could stand in for the product path.
  find="(id)=>cornerstoneTools.annotation.state.getAllAnnotations().find(x=>x.metadata.toolName==='Crosshairs'&&x.data.viewportId===id)"
  v.wait_for_function("id=>{const t=cornerstoneTools.ToolGroupManager.getToolGroup('mpr').getToolInstance('Crosshairs'),a=("+find+")(id);return Object.hasOwn(t,'_dragCallback')&&a?.data.handles.rotationPoints?.length>=2}",arg=active)
  # Listeners registered after the native dispatchers observe the operation the tool itself selected.
  v.evaluate("id=>{const e=services.cornerstoneViewportService.getCornerstoneViewport(id).element,t=cornerstoneTools.ToolGroupManager.getToolGroup('mpr').getToolInstance('Crosshairs'),E=cornerstoneTools.Enums.Events,op=()=>t.editData?.annotation?.data?.handles?.activeOperation??null;window.nativeRotate={down:undefined,drags:[],up:false};e.addEventListener(E.MOUSE_DOWN,()=>{if(nativeRotate.down===undefined)nativeRotate.down=op()});e.addEventListener(E.MOUSE_DRAG,()=>nativeRotate.drags.push(op()));e.addEventListener(E.MOUSE_UP,()=>{nativeRotate.up=true})}",active)
  self.settled(v);before=self.volume_state(v);ids=[s['id'] for s in before];index=ids.index(active);cameras=[s['camera'] for s in before];pivot=self.pivot(cameras);others=[i for i in range(3) if i!=index]
  info=v.evaluate("id=>{const vp=services.cornerstoneViewportService.getCornerstoneViewport(id),c=vp.getCanvas(),r=vp.element.getBoundingClientRect(),a=("+find+")(id);return {left:r.left+vp.element.clientLeft,top:r.top+vp.element.clientTop,width:c.width/devicePixelRatio,height:c.height/devicePixelRatio,handles:a.data.handles.rotationPoints.map(h=>Array.from(vp.worldToCanvas(h[0])))}}",active)
  camera=cameras[index];n=np.array(camera['viewPlaneNormal']);up=np.array(camera['viewUp']);right=np.cross(up,n);mm=2*camera['parallelScale']/info['height']
  # Own orthographic camera mapping must agree with the renderer before its canvas points are trusted.
  center=np.array([info['width']/2,info['height']/2])+np.array([(pivot-camera['focalPoint'])@right,-(pivot-camera['focalPoint'])@up])/mm
  np.testing.assert_allclose(center,self.screen_point(v,pivot)[index],atol=.5,rtol=0)
  origin=np.array([info['left'],info['top']]);turn=lambda d:np.array([[math.cos(math.radians(d)),-math.sin(math.radians(d))],[math.sin(math.radians(d)),math.cos(math.radians(d))]])
  inside=lambda q:12<=q[0]<=info['width']-12 and 12<=q[1]<=info['height']-12
  choice=None
  for handle in info['handles']:
   h=np.array(handle)
   for degrees in (32,-32):
    # Integer page coordinates are delivered unquantized, so the oracle sees exactly the sent input.
    start,middle,end=[np.round(origin+center+turn(d)@(h-center)) for d in (0,degrees/2,degrees)]
    if choice is None and np.linalg.norm(h-center)>=40 and np.linalg.norm(start-origin-h)<=2 and inside(end-origin) and inside(middle-origin):choice=(start,middle,end)
  self.assertIsNotNone(choice,f'no visible rotation handle with room to turn: {info}');start,middle,end=choice
  world=v.evaluate("([id,points])=>{const vp=services.cornerstoneViewportService.getCornerstoneViewport(id);return points.map(p=>Array.from(vp.canvasToWorld(p)))}",[active,[(start-origin).tolist(),(end-origin).tolist()]]);S,E=np.array(world[0]),np.array(world[1])
  for point,page in [(S,start),(E,end)]:
   d=point-camera['focalPoint'];self.assertAlmostEqual(float(d@n),0,delta=1e-6);np.testing.assert_allclose([info['width']/2+d@right/mm,info['height']/2-d@up/mm],page-origin,atol=.5,rtol=0)
  residual=lambda point,c:abs(float((point-np.array(c['focalPoint']))@np.array(c['viewPlaneNormal'])))
  owner=min(others,key=lambda i:residual(S,cameras[i]));self.assertLessEqual(residual(S,cameras[owner]),3*mm);self.assertGreater(min(residual(S,cameras[i]) for i in others if i!=owner),10*mm)
  x,y=S-pivot,E-pivot;x-=n*(x@n);y-=n*(y@n);angle=math.atan2(float(np.cross(x,y)@n),float(x@y));self.assertGreater(abs(math.degrees(angle)),25)
  k=np.array([[0,-n[2],n[1]],[n[2],0,-n[0]],[-n[1],n[0],0]]);rotation=np.eye(3)*math.cos(angle)+(1-math.cos(angle))*np.outer(n,n)+math.sin(angle)*k
  # Native render evidence starts before the real press, so every linked camera change of this drag is counted.
  linked=[ids[i] for i in others];v.evaluate(self.RENDER_PROOF,linked);clip_before=self.assert_clip_planes(v,'before press')
  v.mouse.move(*start.tolist());v.mouse.down();v.wait_for_function('()=>nativeRotate.down!==undefined');self.assertEqual(v.evaluate('()=>nativeRotate.down'),2)
  # A slow multi-event leg then one large event: the result must depend on pointer positions only.
  v.mouse.move(*middle.tolist(),steps=12);v.mouse.move(*end.tolist(),steps=1);v.mouse.up();v.wait_for_function('()=>nativeRotate.up')
  v.wait_for_function("id=>(("+find+")(id)?.data.handles.activeOperation??null)===null",arg=active);render_proof=self.await_final_render(v,linked);self.settled(v)
  drags=v.evaluate('()=>nativeRotate.drags');self.assertGreaterEqual(len(drags),2);self.assertTrue(all(op==2 for op in drags),drags)
  after=self.volume_state(v);moved=[s['camera'] for s in after];self.assertEqual([s['id'] for s in after],ids)
  for i,(old,new) in enumerate(zip(cameras,moved)):
   self.assertAlmostEqual(new['parallelScale'],old['parallelScale'],delta=1e-9)
   for key in ['viewUp','viewPlaneNormal','focalPoint','position']:
    if i==index:np.testing.assert_allclose(new[key],old[key],atol=1e-9,rtol=0);continue
    direction=key in ('viewUp','viewPlaneNormal');expected=rotation@old[key] if direction else pivot+rotation@(np.array(old[key])-pivot)
    np.testing.assert_allclose(new[key],expected,atol=2e-5 if direction else 2e-3,rtol=0)
  self.assertEqual(after[index]['hash'],before[index]['hash'])
  # Rounding the handle to integer page pixels puts the mouse-down point S slightly off the drawn line. Rotating
  # about the pivot by angle(S->E) carries that offset to E scaled by |E-P|/|S-P|, so E is expected there, not on the line.
  expected_residual=residual(S,cameras[owner])*float(np.linalg.norm(E-pivot))/float(np.linalg.norm(S-pivot))
  self.assertAlmostEqual(residual(E,moved[owner]),expected_residual,delta=.05);self.assertGreater(residual(E,cameras[owner]),10*mm)
  np.testing.assert_allclose(self.pivot(moved),pivot,atol=1e-3,rtol=0);np.testing.assert_allclose(v.evaluate("()=>Array.from(cornerstoneTools.ToolGroupManager.getToolGroup('mpr').getToolInstance('Crosshairs').toolCenter)"),pivot,atol=1e-3,rtol=0)
  for item in self.lines(v)[index]:
   for point in item['world']:self.assertLess(min(residual(np.array(point),moved[i]) for i in others),.001)
  expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('시작 MPR 화면')
  # The planes are read after the real drag; the pixel oracle below still guards the displayed image itself.
  clip_after=self.assert_clip_planes(v,'after drag');self.assertEqual([(s['half'],s['blend']) for s in clip_after],[(s['half'],s['blend']) for s in clip_before])
  identity=[1,0,0,0,1,0];counts=self.band_pixels(v,identity,skip={index})
  self.save_volume(v);saved=[cell['camera'] for cell in self.get_volume_job(a)['snapshot']['cells']];self.cameras_close(saved,moved,1e-6)
  fresh=self.login();self.launch(fresh,[a]);self.ready(fresh);fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000)
  self.cameras_close(self.cameras(fresh),saved,1e-6);self.assertAlmostEqual(residual(E,self.cameras(fresh)[owner]),expected_residual,delta=.05);clip_restored=self.assert_clip_planes(fresh,'restored job');reopened=self.band_pixels(fresh,identity,skip={index})
  expect(p.locator('#findings')).to_have_value('KEEP NATIVE ROTATE REPORT');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1);self.assertEqual(errors,[])
  print('NATIVE_ROTATE_HANDLE',json.dumps({'active':active,'owner':ids[owner],'degrees':math.degrees(angle),'drag_events':len(drags),'pointer_residual_mm':residual(E,moved[owner]),'expected_residual_mm':expected_residual,'pivot':pivot.tolist(),'samples':counts,'reopened_samples':reopened,'render_proof':render_proof,'clip_planes':{'before':clip_before,'after':clip_after,'restored':clip_restored}}),flush=True)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeCrosshairE2E(n) for n in loader.getTestCaseNames(VolumeCrosshairE2E) if n.startswith('test_crosshair_'))
if __name__=='__main__':unittest.main(verbosity=2)
