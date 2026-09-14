# coding: utf-8
"""TEST-VOLUME-ORIENTATION: native oblique planes, known voxels, reset and saved job."""
import math,json,unittest
from pathlib import Path
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
  self.band_reads=getattr(self,'band_reads',0)+1
  # One read returns the samples plus each plane's canvas size and whole-canvas red-channel statistics.
  read=page.evaluate('''points=>[...services.viewportGridService.getState().viewports.keys()].map((id,i)=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id),c=v.getCanvas();return {values:points[i].map(([p])=>{const xy=v.worldToCanvas(p);if(!(xy[0]>=2&&xy[1]>=2&&xy[0]<=c.clientWidth-2&&xy[1]<=c.clientHeight-2))return null;return c.getContext('2d').getImageData(Math.floor(xy[0]*c.width/c.clientWidth),Math.floor(xy[1]*c.height/c.clientHeight),1,1).data[0]}),canvas:('''+self.CANVAS_STATS+''')(id,c)}})''',points)
  values=[plane['values'] for plane in read];canvases=[plane['canvas'] for plane in read]
  counts=[]
  for index,(row,got) in enumerate(zip(points,values)):
   if index in skip:counts.append(None);continue
   lower,upper=(voi or {}).get(index,(0,1000));bands=set();count=0
   for (point,value),pixel in zip(row,got):
    if pixel is None:continue
    expected=(value-lower)/(upper-lower)*255
    try:self.assertAlmostEqual(pixel,expected,delta=3,msg=f'plane {index} at {point} expects source value {value}; canvas {canvases[index]}')
    except AssertionError:
     # The first mismatch ends this read; diagnosis never replaces or softens this same assertion.
     self.band_failure(page,index,point,value,pixel,expected,canvases,cameras);raise
    bands.add(value);count+=1
   self.assertGreaterEqual(len(bands),2,f'plane {index} should cross source bands');self.assertGreaterEqual(count,6);counts.append(count)
  return counts
 # The pinned Viewport.setCamera re-derives slab clipping planes only when the focal point leaves the plane or viewUp
 # changes. Every plane must still clip +/- its live normal about its focal point at its own half thickness.
 CLIP_PLANES="()=>[...services.viewportGridService.getState().viewports.keys()].map(id=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id),m=v.getActors()[0].actor.getMapper(),c=v.getCamera();return {id,half:v.getSlabThickness(),blend:m.getBlendMode(),normal:Array.from(c.viewPlaneNormal),focalPoint:Array.from(c.focalPoint),planes:m.getClippingPlanes().map(p=>({normal:Array.from(p.getNormal()),origin:Array.from(p.getOrigin())}))}})"
 def assert_clip_planes(self,page,label):
  import numpy as np
  state=page.evaluate(self.CLIP_PLANES);message=f'{label} clipping planes: '+json.dumps(state)
  for s in state:
   n,f=np.array(s['normal']),np.array(s['focalPoint']);self.assertEqual(len(s['planes']),2,message)
   np.testing.assert_allclose(s['planes'][0]['normal'],n,atol=1e-6,rtol=0,err_msg=message);np.testing.assert_allclose(s['planes'][1]['normal'],-n,atol=1e-6,rtol=0,err_msg=message)
   np.testing.assert_allclose(s['planes'][0]['origin'],f-s['half']*n,atol=1e-5,rtol=0,err_msg=message);np.testing.assert_allclose(s['planes'][1]['origin'],f+s['half']*n,atol=1e-5,rtol=0,err_msg=message)
  return state
 CANVAS_STATS="(id,c)=>{const s={id,width:c.width,height:c.height,clientWidth:c.clientWidth,clientHeight:c.clientHeight,dpr:devicePixelRatio,min:null,max:null,nonzero:0};if(!c.width||!c.height)return s;const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;for(let k=0;k<d.length;k+=4){const x=d[k];if(s.min===null||x<s.min)s.min=x;if(s.max===null||x>s.max)s.max=x;if(x)s.nonzero++}return s}"
 def band_failure(self,page,index,point,value,pixel,expected,canvases,cameras):
  # Diagnosis only, saved in the uploaded volume-mpr artifact folder. Every step records its own failure and
  # the caller re-raises its original assertion, even when the single re-rendered read below matches.
  record={'test':self._testMethodName,'read':self.band_reads,'plane':index,'original':{'point':point,'source':value,'pixel':pixel,'expected':expected,'delta':3,'canvases':canvases},'cameras':cameras,'errors':{}}
  def attempt(name,action):
   try:return action()
   except Exception as error:record['errors'][name]=f'{type(error).__name__}: {error}'
  def save(path,data):
   with path.open('x',encoding='utf-8') as stream:json.dump(data,stream,indent=1,default=str)
   return str(path)
  folder=Path(__file__).resolve().parent/'artifacts'/'volume-mpr-ci';stem=f'band-pixels-{self._testMethodName}-read{self.band_reads}-plane{index}'
  record['clip_planes']=attempt('clip_planes',lambda:page.evaluate(self.CLIP_PLANES))
  record['render_proof']=attempt('render_proof',lambda:page.evaluate('()=>window.kinRenderProof?JSON.parse(JSON.stringify({...kinRenderProof,readAt:performance.now()})):null'))
  attempt('folder',lambda:folder.mkdir(parents=True,exist_ok=True))
  attempt('original_record',lambda:save(folder/(stem+'-original.json'),record))
  def screenshot():
   path=folder/(stem+'.png')
   if path.exists():raise FileExistsError(str(path))
   page.screenshot(path=str(path));return str(path)
  record['screenshot']=attempt('screenshot',screenshot)
  record['diagnostic']=attempt('diagnostic_render',lambda:page.evaluate('''async ([index,p])=>{const id=[...services.viewportGridService.getState().viewports.keys()][index],v=services.cornerstoneViewportService.getCornerstoneViewport(id),E=cornerstone.Enums.Events,requested=performance.now();
   const rendered=await new Promise((resolve,reject)=>{const done=e=>{clearTimeout(timer);resolve({at:performance.now(),viewportId:e.detail?.viewportId??null})};const timer=setTimeout(()=>{v.element.removeEventListener(E.IMAGE_RENDERED,done);reject(Error('IMAGE_RENDERED not received within 5000ms of render()'))},5000);
    v.element.addEventListener(E.IMAGE_RENDERED,done,{once:true});try{v.render()}catch(error){clearTimeout(timer);v.element.removeEventListener(E.IMAGE_RENDERED,done);reject(error)}});
   const c=v.getCanvas(),xy=v.worldToCanvas(p),pixel=(xy[0]>=2&&xy[1]>=2&&xy[0]<=c.clientWidth-2&&xy[1]<=c.clientHeight-2)?c.getContext('2d').getImageData(Math.floor(xy[0]*c.width/c.clientWidth),Math.floor(xy[1]*c.height/c.clientHeight),1,1).data[0]:null;
   return {id,requested,rendered,xy:Array.from(xy),pixel,canvas:('''+self.CANVAS_STATS+''')(id,c),render_proof:window.kinRenderProof?JSON.parse(JSON.stringify(kinRenderProof)):null}}''',[index,point]))
  if isinstance((record['diagnostic'] or {}).get('pixel'),(int,float)):record['diagnostic_within_original_tolerance']=abs(record['diagnostic']['pixel']-expected)<=3
  record['outcome']='diagnosis only; the original assertion is re-raised unchanged'
  attempt('diagnosis_record',lambda:save(folder/(stem+'-diagnosis.json'),record))
  print('BAND_PIXELS_DIAGNOSIS',json.dumps(record,default=str),flush=True)
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
 def test_orientation_06_single_axis_saved_job_restores_live_slab_planes(self):
  # H/F rotation keeps the coronal focal point exactly at the pivot and its viewUp unchanged while its normal turns.
  # Native setCamera alone would then leave a freshly restored coronal plane clipping its initial slab.
  a,p,v=self.starting();before=self.cameras(v);original=self.originals();p.locator('#findings').fill('KEEP SINGLE AXIS REPORT')
  self.rotate_planes(v,2,40);moved=self.cameras(v);pivot=self.pivot(before)
  co=next(i for i,c in enumerate(before) if abs(abs(c['viewPlaneNormal'][1])-1)<1e-6);ax=next(i for i,c in enumerate(before) if abs(abs(c['viewPlaneNormal'][2])-1)<1e-6)
  # The discriminating preconditions: exact focal point, viewUp within the native 1e-5 guard, a 40 degree turn of the normal.
  np.testing.assert_allclose(moved[co]['focalPoint'],before[co]['focalPoint'],atol=1e-9,rtol=0);np.testing.assert_allclose(moved[co]['viewUp'],before[co]['viewUp'],atol=1e-5,rtol=0)
  self.assertAlmostEqual(abs(float(np.dot(moved[co]['viewPlaneNormal'],before[co]['viewPlaneNormal']))),math.cos(math.radians(40)),delta=1e-6);np.testing.assert_allclose(moved[ax]['viewPlaneNormal'],before[ax]['viewPlaneNormal'],atol=1e-9,rtol=0)
  clip_author=self.assert_clip_planes(v,'rotated author');identity=[1,0,0,0,1,0];authored=self.band_pixels(v,identity,skip={ax})
  self.save_volume(v);saved=self.get_volume_job(a);cells=saved['snapshot']['cells'];self.cameras_close([c['camera'] for c in cells],moved,1e-6)
  fresh=self.login();errors=[];fresh.on('pageerror',lambda e:errors.append(str(e)));self.launch(fresh,[a]);self.ready(fresh);fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000)
  self.cameras_close(self.cameras(fresh),[c['camera'] for c in cells],1e-6)
  # Every restored plane clips about its live camera at the saved thickness and blend, read after the restore finished.
  clip_restored=self.assert_clip_planes(fresh,'restored job');self.assertEqual([(s['half'],s['blend']) for s in clip_restored],[(s['half'],s['blend']) for s in clip_author])
  for s,cell in zip(clip_restored,cells):self.assertEqual(s['blend'],cell['projection']['blend']);self.assertAlmostEqual(s['half']*2,cell['projection']['thickness'],delta=1e-6)
  reopened=self.band_pixels(fresh,identity,skip={ax});self.assertIsNotNone(reopened[co])
  expect(p.locator('#findings')).to_have_value('KEEP SINGLE AXIS REPORT');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1);self.assertEqual(errors,[])
  print('SINGLE_AXIS_RESTORED_PLANES',json.dumps({'pivot':pivot.tolist(),'coronal':co,'axial':ax,'samples':authored,'reopened_samples':reopened,'clip_planes':{'author':clip_author,'restored':clip_restored}}),flush=True)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeOrientationE2E(n) for n in loader.getTestCaseNames(VolumeOrientationE2E) if n.startswith('test_orientation_'))
if __name__=='__main__':unittest.main(verbosity=2)
