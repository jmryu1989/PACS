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
 # A synthetic acquisition rotated 30 degrees about H/F and tilted 20 degrees: its volume axes
 # are not patient axes, so Basic Orthogonal must follow the native patient-axis planes.
 TILT=[0.8660254038,0.5,0,-0.4698463104,0.8137976813,0.3420201433]
 def starting_tilted(self):
  a,p,v=self.opened_projection(orientation=self.TILT);expect(v.get_by_role('button',name='Reset Planes',exact=True)).to_be_enabled()
  v.get_by_role('button',name='Reset Planes',exact=True).click();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('시작 MPR 화면');return a,p,v
 def basic(self,page):
  page.get_by_role('button',name='Basic Orthogonal',exact=True).click();expect(page.locator('#kin-volume-orientation [role=status]')).to_contain_text('기본 Axial·Sagittal·Coronal 방향으로 맞췄습니다')
 def settled(self,page):page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
 def pivot(self,cameras):
  import numpy as np
  normals=np.array([c['viewPlaneNormal'] for c in cameras]);return np.linalg.solve(normals,np.sum(normals*np.array([c['focalPoint'] for c in cameras]),axis=1))
 def cameras(self,page):return [s['camera'] for s in self.volume_state(page)]
 def cameras_close(self,actual,expected,atol):
  import numpy as np
  self.assertEqual(len(actual),len(expected))
  for x,y in zip(actual,expected):
   for key in ['focalPoint','position','viewUp','viewPlaneNormal']:np.testing.assert_allclose(x[key],y[key],atol=atol,rtol=0)
   self.assertAlmostEqual(x['parallelScale'],y['parallelScale'],delta=atol)
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
 def band_pixels(self,page,orientation,skip=(),voi=None):
  # Expected values come from each point's own source index in the known phantom
  # (slices 0-10:100, 11-21:500, 22-32:900), away from band, corner and volume edges.
  import numpy as np
  r=np.array(orientation[:3],float);c=np.array(orientation[3:],float);n=np.cross(r,c);cameras=self.cameras(page);pivot=self.pivot(cameras);points=[]
  for index,camera in enumerate(cameras):
   up=np.array(camera['viewUp']);right=np.cross(up,camera['viewPlaneNormal']);chosen=[]
   for x in range(-40,41,4):
    for y in range(-40,41,4):
     q=pivot+right*x+up*y;i,j,k=float(q@r),float(q@c),float(q@n)
     if index in skip or not(6<=i<=58 and 6<=j<=58 and 1<=k<=31) or abs(k-10.5)<1.5 or abs(k-21.5)<1.5:continue
     chosen.append([q.tolist(),100 if k<10.5 else 900 if k>21.5 else 500])
   points.append(chosen)
  values=page.evaluate('''points=>[...services.viewportGridService.getState().viewports.keys()].map((id,i)=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id),c=v.getCanvas();return points[i].map(([p])=>{const xy=v.worldToCanvas(p);if(!(xy[0]>=2&&xy[1]>=2&&xy[0]<=c.clientWidth-2&&xy[1]<=c.clientHeight-2))return null;return c.getContext('2d').getImageData(Math.floor(xy[0]*c.width/c.clientWidth),Math.floor(xy[1]*c.height/c.clientHeight),1,1).data[0]})})''',points)
  counts=[]
  for index,(row,got) in enumerate(zip(points,values)):
   if index in skip:counts.append(None);continue
   lower,upper=(voi or {}).get(index,(0,1000));bands=set();count=0
   for (point,value),pixel in zip(row,got):
    if pixel is None:continue
    self.assertAlmostEqual(pixel,(value-lower)/(upper-lower)*255,delta=3,msg=f'plane {index} at {point} expects source value {value}');bands.add(value);count+=1
   self.assertGreaterEqual(len(bands),2,f'plane {index} should cross source bands');self.assertGreaterEqual(count,6);counts.append(count)
  return counts
 def test_crosshair_09_basic_orthogonal_tilted_source_keeps_pivot_pan_zoom_display_and_crosshair(self):
  import numpy as np
  a,p,v=self.starting_tilted();initial=self.cameras(v);native=self.native_planes(v);self.assert_native_axes(initial,native)
  original=self.originals();p.locator('#findings').fill('KEEP BASIC ORTHOGONAL REPORT')
  v.get_by_role('button',name='Show Crosshairs',exact=True).click();v.wait_for_function("()=>document.querySelectorAll('[data-kin-crosshair]').length===12")
  self.rotate_planes(v,0,25);self.rotate_planes(v,1,-35);self.rotate_planes(v,2,135)
  ax,sg,co=[native['names'].index(name) for name in ['axial','sagittal','coronal']]
  v.evaluate("""([ax,sg,co])=>{const ids=[...services.viewportGridService.getState().viewports.keys()],get=i=>services.cornerstoneViewportService.getCornerstoneViewport(ids[i]);
   const axial=get(ax),c=axial.getCamera(),u=c.viewUp,n=c.viewPlaneNormal,right=[u[1]*n[2]-u[2]*n[1],u[2]*n[0]-u[0]*n[2],u[0]*n[1]-u[1]*n[0]],d=u.map((x,i)=>x*3-right[i]*4);
   axial.setCamera({focalPoint:c.focalPoint.map((x,i)=>x+d[i]),position:c.position.map((x,i)=>x+d[i]),parallelScale:c.parallelScale*.7});axial.render();
   const sagittal=get(sg);sagittal.setProperties({voiRange:{lower:0,upper:2000}});sagittal.render();
   const coronal=get(co);coronal.setBlendMode(1);coronal.setSlabThickness(5);coronal.render()}""",[ax,sg,co]);self.settled(v)
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

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeCrosshairE2E(n) for n in loader.getTestCaseNames(VolumeCrosshairE2E) if n.startswith('test_crosshair_'))
if __name__=='__main__':unittest.main(verbosity=2)
