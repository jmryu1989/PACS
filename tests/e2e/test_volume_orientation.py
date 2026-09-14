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
 # Band failure diagnostics belong in the artifact folder uploaded by the CI profile running this class
 # (measurement_ci.py volume-path out, validate.yml volume-path upload); a subclass run by another profile overrides it.
 ARTIFACT_PROFILE='volume-path-ci'
 def band_failure(self,page,index,point,value,pixel,expected,canvases,cameras):
  # Diagnosis only, saved in this class's uploaded profile artifact folder. Every step records its own failure and
  # the caller re-raises its original assertion, even when the single re-rendered read below matches.
  record={'test':self._testMethodName,'read':self.band_reads,'plane':index,'original':{'point':point,'source':value,'pixel':pixel,'expected':expected,'delta':3,'canvases':canvases},'cameras':cameras,'errors':{}}
  def attempt(name,action):
   try:return action()
   except Exception as error:record['errors'][name]=f'{type(error).__name__}: {error}'
  def save(path,data):
   with path.open('x',encoding='utf-8') as stream:json.dump(data,stream,indent=1,default=str)
   return str(path)
  folder=Path(__file__).resolve().parent/'artifacts'/self.ARTIFACT_PROFILE;stem=f'band-pixels-{self._testMethodName}-read{self.band_reads}-plane{index}'
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
 # Read-only trace of Restore Job camera writes on the Job's own volume viewports. The wrapper replaces the owner of
 # VolumeViewport's setCamera with the same property attributes, keeps receiver, arguments, return and exceptions, and
 # only reads the camera, slab and clipping planes around the call; it never sets, renders or calls another setter.
 RESTORE_CAMERA_TRACE='''()=>{if(window.kinRestoreCameraTrace)throw Error('restore camera trace already installed');let owner=cornerstone.VolumeViewport.prototype;while(owner&&!Object.prototype.hasOwnProperty.call(owner,'setCamera'))owner=Object.getPrototypeOf(owner);if(!owner)throw Error('no setCamera owner');
  const descriptor=Object.getOwnPropertyDescriptor(owner,'setCamera'),original=descriptor.value,records=[],copy=value=>JSON.parse(JSON.stringify(value));
  const planes=v=>{try{return v.getActors()[0].actor.getMapper().getClippingPlanes().map(p=>({normal:Array.from(p.getNormal()),origin:Array.from(p.getOrigin())}))}catch(error){return {error:String(error)}}};
  const wrapper=function(camera){if(!(typeof this.id==='string'&&this.id.startsWith('kin-volume-job-')&&this.type==='orthographic'))return original.apply(this,arguments);
   const record={index:records.length,id:this.id,volumeId:this.getVolumeId(),half:this.getSlabThickness(),suppliedKeys:Object.keys(camera||{}),supplied:copy(camera||{}),previous:copy(this.getCamera()),planesBefore:planes(this)};records.push(record);
   try{const result=original.apply(this,arguments);record.after=copy(this.getCamera());record.planesAfter=planes(this);return result}catch(error){record.error=String(error);throw error}};
  Object.defineProperty(owner,'setCamera',{...descriptor,value:wrapper});window.kinRestoreCameraTrace={owner,descriptor,wrapper,records};return {owner:owner.constructor.name,installed:owner.setCamera===wrapper}}'''
 RESTORE_CAMERA_TRACE_END='''()=>{const t=window.kinRestoreCameraTrace;if(!t)throw Error('restore camera trace missing');if(Object.getOwnPropertyDescriptor(t.owner,'setCamera').value!==t.wrapper)throw Error('setCamera was replaced during the restore camera trace');
  Object.defineProperty(t.owner,'setCamera',t.descriptor);delete window.kinRestoreCameraTrace;return {restored:Object.getOwnPropertyDescriptor(t.owner,'setCamera').value===t.descriptor.value,records:JSON.parse(JSON.stringify(t.records))}}'''
 def volume_center(self,page,index):
  # The loaded volume's own centre voxel indexToWorld(floor(dimensions/2)), recomputed here from its origin, spacing and direction.
  state=page.evaluate('''index=>{const id=[...services.viewportGridService.getState().viewports.keys()][index],v=services.cornerstoneViewportService.getCornerstoneViewport(id),volumeId=v.getVolumeId(),vol=cornerstone.cache.getVolume(volumeId),middle=Array.from(vol.dimensions).map(d=>Math.floor(d/2));
   return {id,volumeId,dimensions:Array.from(vol.dimensions),spacing:Array.from(vol.spacing),origin:Array.from(vol.origin),direction:Array.from(vol.direction),middle,indexToWorld:Array.from(vol.imageData.indexToWorld(middle,[0,0,0]))}}''',index)
  center=np.array(state['origin'],float)+sum(state['middle'][i]*state['spacing'][i]*np.array(state['direction'][3*i:3*i+3],float) for i in range(3))
  np.testing.assert_allclose(state['indexToWorld'],center,atol=1e-9,rtol=0,err_msg=json.dumps(state));return state,center.tolist()
 def restore_trigger(self,records,view,volume,saved,center,degrees):
  # The single traced application of the saved camera to the restored plane's viewport, not a flip-only call, native reset or retry.
  wanted={k:x for k,x in saved.items() if k not in ('flipHorizontal','flipVertical','rotation')};message='restore setCamera trace: '+json.dumps(records)
  matched=[r for r in records if r['supplied']==wanted];self.assertEqual(len(matched),1,message);r=matched[0]
  self.assertEqual((r['id'],r['volumeId']),(view,volume),message);self.assertNotIn('error',r,message);previous,after=r['previous'],r['after']
  np.testing.assert_allclose(previous['focalPoint'],center,atol=1e-9,rtol=0,err_msg=message);np.testing.assert_allclose(previous['viewUp'],saved['viewUp'],atol=1e-9,rtol=0,err_msg=message)
  self.assertAlmostEqual(abs(float(np.dot(previous['viewPlaneNormal'],saved['viewPlaneNormal']))),math.cos(math.radians(degrees)),delta=1e-6,msg=message)
  # Pinned Viewport.setCamera guard (chunk-8523.js:5603-5622, isEqual tolerance 1e-5) is false: this call derives no clipping planes.
  out_of_plane=abs(float(np.dot(np.subtract(saved['focalPoint'],previous['focalPoint']),after['viewPlaneNormal'])))>0;up_changed=not bool(np.all(np.abs(np.subtract(after['viewUp'],previous['viewUp']))<1e-5))
  self.assertFalse(out_of_plane or up_changed,message)
  # Directly after the call the slab still clips about the initial normal; only the Job's thickness re-apply can correct it.
  self.assertEqual(len(r['planesAfter']),2,message);self.assertEqual(r['planesAfter'],r['planesBefore'],message);np.testing.assert_allclose(r['planesAfter'][0]['normal'],previous['viewPlaneNormal'],atol=1e-6,rtol=0,err_msg=message)
  return r
 def test_orientation_06_single_axis_saved_job_restores_live_slab_planes(self):
  # An A/P turn keeps the axial focal point, which is the volume centre, and its viewUp while its normal turns. The fresh
  # Restore Job axial viewport is observed (traced) to start there, so native setCamera alone keeps its initial slab.
  # The earlier H/F 40 coronal case did not discriminate: the fresh coronal focal point differs from the author's.
  a,p,v=self.starting();before=self.cameras(v);original=self.originals();p.locator('#findings').fill('KEEP SINGLE AXIS REPORT')
  self.rotate_planes(v,1,30);moved=self.cameras(v);pivot=self.pivot(before)
  co=next(i for i,c in enumerate(before) if abs(abs(c['viewPlaneNormal'][1])-1)<1e-6);ax=next(i for i,c in enumerate(before) if abs(abs(c['viewPlaneNormal'][2])-1)<1e-6)
  # The discriminating preconditions: exact axial focal point at the volume centre, viewUp within the native 1e-5 guard, a 30 degree turn of the normal.
  author_volume,center=self.volume_center(v,ax)
  np.testing.assert_allclose(moved[ax]['focalPoint'],before[ax]['focalPoint'],atol=1e-9,rtol=0);np.testing.assert_allclose(moved[ax]['focalPoint'],center,atol=1e-9,rtol=0);np.testing.assert_allclose(moved[ax]['viewUp'],before[ax]['viewUp'],atol=1e-5,rtol=0)
  self.assertAlmostEqual(abs(float(np.dot(moved[ax]['viewPlaneNormal'],before[ax]['viewPlaneNormal']))),math.cos(math.radians(30)),delta=1e-6);np.testing.assert_allclose(moved[co]['viewPlaneNormal'],before[co]['viewPlaneNormal'],atol=1e-9,rtol=0)
  clip_author=self.assert_clip_planes(v,'rotated author');identity=[1,0,0,0,1,0];authored=self.band_pixels(v,identity)
  self.save_volume(v);saved=self.get_volume_job(a);cells=saved['snapshot']['cells'];self.cameras_close([c['camera'] for c in cells],moved,1e-6)
  fresh=self.login();errors=[];fresh.on('pageerror',lambda e:errors.append(str(e)));self.launch(fresh,[a]);self.ready(fresh);installed=fresh.evaluate(self.RESTORE_CAMERA_TRACE);self.assertTrue(installed['installed'],installed)
  try:fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000)
  except BaseException:
   # The original restore failure is re-raised; removing the trace is best effort here.
   try:fresh.evaluate(self.RESTORE_CAMERA_TRACE_END)
   except Exception as error:print('RESTORE_CAMERA_TRACE_END_FAILED',f'{type(error).__name__}: {error}',flush=True)
   raise
  trace=fresh.evaluate(self.RESTORE_CAMERA_TRACE_END);self.assertTrue(trace['restored'],'setCamera owner not restored after the trace')
  self.cameras_close(self.cameras(fresh),[c['camera'] for c in cells],1e-6)
  # Every restored plane clips about its live camera at the saved thickness and blend, read after the restore finished.
  clip_restored=self.assert_clip_planes(fresh,'restored job');self.assertEqual([(s['half'],s['blend']) for s in clip_restored],[(s['half'],s['blend']) for s in clip_author])
  for s,cell in zip(clip_restored,cells):self.assertEqual(s['blend'],cell['projection']['blend']);self.assertAlmostEqual(s['half']*2,cell['projection']['thickness'],delta=1e-6)
  restored_volume,restored_center=self.volume_center(fresh,ax);np.testing.assert_allclose(restored_center,center,atol=1e-9,rtol=0)
  trigger=self.restore_trigger(trace['records'],clip_restored[ax]['id'],restored_volume['volumeId'],cells[ax]['camera'],center,30)
  reopened=self.band_pixels(fresh,identity);self.assertTrue(all(count is not None for count in reopened),reopened)
  expect(p.locator('#findings')).to_have_value('KEEP SINGLE AXIS REPORT');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1);self.assertEqual(errors,[])
  print('SINGLE_AXIS_RESTORED_PLANES',json.dumps({'axis':1,'degrees':30,'pivot':pivot.tolist(),'coronal':co,'axial':ax,'center':center,'volume':{'author':author_volume,'restored':restored_volume},'samples':authored,'reopened_samples':reopened,'clip_planes':{'author':clip_author,'restored':clip_restored},'trace':{'owner':installed,'trigger':trigger,'records':trace['records']}}),flush=True)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeOrientationE2E(n) for n in loader.getTestCaseNames(VolumeOrientationE2E) if n.startswith('test_orientation_'))
if __name__=='__main__':unittest.main(verbosity=2)
