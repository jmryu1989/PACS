# coding: utf-8
"""TEST-MPR-PATH-NATIVE: manual 3D path on native planes, unfolded HU, path planes and Job v11 reopen.

Synthetic CT only, the curved suite's anisotropic phantom: pixel spacing 0.5 (rows) x 0.7 (columns),
slice step 2.5 mm, stored bands 100 / 500 / 900 with a 4x4 corner of 1000, slope 2 / intercept -1024.
Every expected value is computed here with numpy from the DICOM definition and the written kin-path-1
contract (Catmull-Rom centre line, arc-length columns, double-reflection transport from the saved
initial normal, half-voxel clamped trilinear HU); nothing expected is read back from viewer output.
The analytic straight/planar/helix/linear-field proofs of that contract are tests/volume_path_test.cjs.
"""
import copy,json,math,re,unittest,uuid
import numpy as np
from playwright.sync_api import expect, TimeoutError as PlaywrightTimeout
from test_volume_curved import VolumeCurvedE2E,SLOPE,SPACING,PLACE,SCREEN,hu_volume,polyline
from test_worklist import psql

CELLS='''()=>[...services.viewportGridService.getState().viewports.values()].filter(c=>c.displaySetInstanceUIDs?.length).sort((a,b)=>a.y-b.y||a.x-b.x).map(c=>c.viewportId)'''
# Fresh native render evidence: listen on every plane, request a render, wait for all three events,
# then read cameras and the canvas pixel at the path point from that same rendered frame.
RENDERED='''async point=>{const ids=(%s)(),views=ids.map(id=>services.cornerstoneViewportService.getCornerstoneViewport(id)),name=cornerstone.Enums.Events.IMAGE_RENDERED;
 await new Promise((resolve,reject)=>{let left=views.length;const timer=setTimeout(()=>reject(Error('IMAGE_RENDERED was not reported by every plane')),10000);
  views.forEach(v=>v.element.addEventListener(name,()=>{if(--left===0){clearTimeout(timer);resolve();}},{once:true}));views.forEach(v=>v.render());});
 return views.map(v=>{const c=v.getCanvas(),m=v.getCamera(),xy=v.worldToCanvas(point);return {camera:{focalPoint:m.focalPoint,position:m.position,viewUp:m.viewUp,viewPlaneNormal:m.viewPlaneNormal},
  screen:[xy[0],xy[1]],pixel:c.getContext('2d').getImageData(Math.floor(xy[0]*c.width/c.clientWidth),Math.floor(xy[1]*c.height/c.clientHeight),1,1).data[0]}});}'''%CELLS
CAMERAS='''()=>(%s)().map(id=>services.cornerstoneViewportService.getCornerstoneViewport(id).getCamera())'''%CELLS
DIMS=(64,64,33)

def unit(v):
 v=np.asarray(v,dtype=np.float64);return v/np.linalg.norm(v)

def trilinear(p,hu):
 index=[p[0]/SPACING[1],p[1]/SPACING[0],p[2]/SPACING[2]]
 if any(x< -.5-1e-6 or x>DIMS[a]-.5+1e-6 for a,x in enumerate(index)):return None
 x=[min(max(v,0),DIMS[a]-1) for a,v in enumerate(index)];base=[min(int(math.floor(v)),DIMS[a]-2) for a,v in enumerate(x)];frac=[x[a]-base[a] for a in range(3)];value=0.0
 for di in (0,1):
  for dj in (0,1):
   for dk in (0,1):
    w=(frac[0] if di else 1-frac[0])*(frac[1] if dj else 1-frac[1])*(frac[2] if dk else 1-frac[2])
    if w:value+=w*hu[base[2]+dk,base[1]+dj,base[0]+di]
 return value

def centre_line(points,s):
 """Arc-length centres of the Catmull-Rom centre line and their central-difference tangents."""
 line=polyline(points,'curved');cumulative=[0.0]
 for i in range(1,len(line)):cumulative.append(cumulative[-1]+math.dist(line[i],line[i-1]))
 columns=math.floor(cumulative[-1]/s+1e-9)+1;centres=[];segment=0
 for c in range(columns):
  d=c*s
  while segment<len(line)-2 and cumulative[segment+1]<d:segment+=1
  span=cumulative[segment+1]-cumulative[segment];f=min(1,max(0,(d-cumulative[segment])/span)) if span>0 else 0
  centres.append([line[segment][k]+(line[segment+1][k]-line[segment][k])*f for k in range(3)])
 C=np.array(centres,dtype=np.float64);return cumulative[-1],columns,C,[unit(C[min(columns-1,c+1)]-C[max(0,c-1)]) for c in range(columns)]

def path_oracle(path):
 """kin-path-1 geometry from its written contract: arc-length centres, central-difference tangents, double reflection."""
 length,columns,C,T=centre_line(path['points'],path['output']['spacing'])
 n=np.array(path['frame']['initialNormal'],dtype=np.float64);r=unit(n-np.dot(n,T[0])*T[0]);N=[r]
 for c in range(columns-1):
  v1=C[c+1]-C[c];c1=np.dot(v1,v1);rL=r-2*np.dot(v1,r)/c1*v1;tL=T[c]-2*np.dot(v1,T[c])/c1*v1;v2=T[c+1]-tL;c2=np.dot(v2,v2)
  r=rL-2*np.dot(v2,rL)/c2*v2;r=unit(r-np.dot(r,T[c+1])*T[c+1]);N.append(r)
 return dict(length=length,columns=columns,centres=C,T=T,N=N,B=[np.cross(t,x) for t,x in zip(T,N)])

def unfolded(path,hu):
 g=path_oracle(path);s=path['output']['spacing'];half=math.floor(path['output']['halfHeight']/s+1e-9);rows=2*half+1;a=math.radians(path['unfold']['angle']);values=[];outside=0
 for r in range(rows):
  for c in range(g['columns']):
   value=trilinear(g['centres'][c]+(half-r)*s*(math.cos(a)*g['N'][c]+math.sin(a)*g['B'][c]),hu);values.append(value);outside+=value is None
 return g,rows,values,outside

def default_normal(t):
 axis=int(np.argmin(np.abs(t)));e=np.zeros(3);e[axis]=1;return unit(e-t[axis]*t)

def history_normal(history,s):
 """Initial normal over the accepted control-point lists of every edit, oldest first: the default rule at the first
 viable (two-point) path, then the kept vector projected perpendicular to each new start tangent; only a projection
 shorter than 1e-3 falls back to the default rule. Nothing is read from viewer output."""
 n=None
 for points in history:
  if len(points)<2:continue
  t=centre_line(points,s)[3][0]
  if n is not None:
   p=n-np.dot(n,t)*t
   if np.linalg.norm(p)>=1e-3:n=unit(p);continue
  n=default_normal(t)
 return n

def raw_vectors(text,key='initialNormal'):
 """The literal JSON tokens of every `key` array in a raw body; nothing is parsed, so no digit is rounded."""
 return re.findall(r'"%s"\s*:\s*\[[^\[\]]{0,200}\]'%key,text)

def job_post(uid):
 return lambda r:r.method=='POST' and r.url.split('?')[0].endswith(f'/studies/{uid}/viewer-jobs')

def field_differences(a,b,at=''):
 """Exact leaf differences between two JSON values as (path, a, b); key order is ignored, nothing is rounded."""
 if isinstance(a,dict) and isinstance(b,dict):
  return [d for k in sorted(set(a)|set(b)) for d in (field_differences(a[k],b[k],f'{at}.{k}') if k in a and k in b else [(f'{at}.{k}',a.get(k,'<missing>'),b.get(k,'<missing>'))])]
 if isinstance(a,list) and isinstance(b,list) and len(a)==len(b):
  return [d for i,(x,y) in enumerate(zip(a,b)) for d in field_differences(x,y,f'{at}[{i}]')]
 return [] if a==b and type(a)==type(b) or a==b and {type(a),type(b)}<={int,float} else [(at,a,b)]
CELL_DISPLAY='''()=>(%s)().map(id=>{const p=services.cornerstoneViewportService.getCornerstoneViewport(id).getProperties();return {voiRange:p.voiRange,VOILUTFunction:p.VOILUTFunction,invert:p.invert};})'''%CELLS

class VolumePathE2E(VolumeCurvedE2E):
 def opened_path(self):
  a,p,v=self.opened_curved(SLOPE);expect(v.locator('#kin-mpr-path')).to_be_visible(timeout=30000);return a,p,v
 def path(self,v):return v.locator('#kin-mpr-path')
 def path_inspect(self,v,values=False):return v.evaluate('x=>kinMprPath.inspect({values:x})',values)
 def path_final(self,v,timeout=30000):
  expect(self.path(v).locator('p[data-kin-path-state]')).to_have_text('Final',timeout=timeout);report=self.path_inspect(v,True);self.assertEqual(report['final']['signature'],report['current']);return report
 def path_input(self,v,label,value):
  field=self.path(v).get_by_label(label,exact=True);field.fill(str(value));field.dispatch_event('change')
 def path_status(self,v):return self.path(v).locator('[role=status]')
 def path_button(self,v,name):return self.path(v).get_by_role('button',name=name,exact=True)
 def path_count(self,v):return v.evaluate('()=>kinMprPath.inspect()?.value?.points?.length??0')
 def path_point(self,v,view,point):
  n=self.path_count(v);v.mouse.click(*v.evaluate(SCREEN,[view,list(point)]))
  try:v.wait_for_function('n=>(kinMprPath.inspect()?.value?.points?.length??0)>n',arg=n,timeout=5000)
  except PlaywrightTimeout:self.fail(f'path point {n} {list(point)} was not accepted; status {self.path_status(v).text_content()!r}')
  points=self.path_inspect(v)['value']['points'];got=points[n];self.assertTrue(all(abs(x-y)<=.5 for x,y in zip(got,point)),got);return points
 def add_path(self,v,picks):
  # Each pick is (plane axis, plane focal point, world point on that plane). Returns the accepted
  # control-point list after every pick, the edit history of the initial normal.
  self.path_button(v,'Add Points').click();history=[]
  for axis,focal,point in picks:
   view=self.view(v,axis);v.evaluate(PLACE,[view,list(focal)]);history.append(self.path_point(v,view,point))
  self.path_button(v,'Finish Points').click();return history
 def assert_unfolded(self,report,hu):
  g,rows,values,outside=unfolded(report['value'],hu);final=report['final']
  self.assertEqual((final['columns'],final['rows'],final['outside']),(g['columns'],rows,outside));self.assertAlmostEqual(final['length'],g['length'],delta=1e-9)
  for n,(got,want) in enumerate(zip(final['values'],values)):
   if want is None:self.assertIsNone(got,n)
   else:self.assertAlmostEqual(got,want,delta=1e-6,msg=n)
  return g
 def save_path_diagnosed(self,v,a,label):
  # Diagnostic record: exact before-save/saved/live field differences for the native log, plus the literal
  # initialNormal tokens of this synthetic Job at each persistence boundary (browser POST body, PostgreSQL
  # jsonb text, API GET response text), all read-only and unparsed. The callers keep their exact saved-path
  # equality assertions; this refuses only when the saved Job or a boundary token could not be identified.
  before=self.path_inspect(v)['value'];display=v.evaluate(CELL_DISPLAY)
  with v.expect_request(job_post(a.uid)) as sent:self.save_volume(v)
  rows=self.jobs(a);self.assertEqual(len(rows),1);job=rows[0]['id']
  r=self.stack.request('GET',f'/studies/{a.uid}/viewer-jobs/{job}','doctor');self.assertEqual(r.status,200,r.text);s=r.body['snapshot'];report=self.path_inspect(v)
  body=sent.value.post_data or ''
  try:owned=str(uuid.UUID(job))==job and json.loads(body)['id']==job
  except (ValueError,KeyError,TypeError):owned=False
  try:stored=psql("SELECT snapshot#>>'{path,frame,initialNormal}' FROM \"ViewerJob\" WHERE id='%s'::uuid"%job) if owned else None
  except RuntimeError:stored=None
  transport={'transport_request':raw_vectors(body),'transport_db':stored,'transport_response':raw_vectors(r.text)}
  print('PATH_SAVE',json.dumps({'test':label,'dirty':v.evaluate('()=>kinMprPath.dirty()'),'state':report['state'],'busy':report['busy'],'generation':report['generation'],
   'before_vs_saved':field_differences(before,s.get('path')),'saved_vs_live':field_differences(s.get('path'),report['value']),'before_vs_live':field_differences(before,report['value']),
   'display_before_save':display,'display_after_save':v.evaluate(CELL_DISPLAY),'job_owned':owned,**transport}),flush=True)
  self.assertTrue(owned,'the saved Job is not the one this browser posted')
  self.assertTrue(all(transport.values()) and len(stored)==1,'persistence boundary tokens were not captured')
  return s,report['value']
 def assert_cameras(self,cameras,g,column,perpendicular=0,delta=1e-6):
  planes=iter([(g['N'][column],g['T'][column]),(g['B'][column],g['T'][column])])
  for i,camera in enumerate(cameras):
   normal,up=(g['T'][column],g['B'][column]) if i==perpendicular else next(planes)
   np.testing.assert_allclose(camera['viewPlaneNormal'],normal,atol=delta);np.testing.assert_allclose(camera['viewUp'],up,atol=delta);np.testing.assert_allclose(camera['focalPoint'],g['centres'][column],atol=delta)

 def test_path_01_noncoplanar_points_unfolded_oracle_save_and_new_browser_restore(self):
  a,p,v=self.opened_path();original=self.originals();p.locator('#findings').fill('KEEP PATH REPORT');hu=hu_volume(SLOPE);self.assert_accessor(v,SLOPE)
  # Half height 20 mm carries the 30 degree unfold direction past the volume edge along part of the
  # path: the numpy oracle below gives 515 outside samples for these picks and 447..655 when
  # each clicked coordinate moves by up to 0.5 mm, so outside>0 is a property of this fixture.
  self.path_input(v,'3D Path Half Height',20);self.path_input(v,'3D Path Unfold Angle',30)
  picks=[(2,[20,15,30],[6,8,30]),(1,[20,20,40],[16,20,40]),(0,[26,15,50],[26,12,52]),(2,[20,15,62],[34,22,62])]
  # Placing each plane moves it; the planes are compared from the last placement on.
  history=self.add_path(v,picks);before=self.volume_state(v);report=self.path_final(v);value=report['value']
  self.assertEqual((value['cell'],value['output']['spacing'],value['unfold']['angle'],len(value['points'])),(0,0.5,30,4))
  points=np.array(value['points']);self.assertEqual((points[0][2],points[1][1],points[2][0],points[3][2]),(30,20,26,62))
  self.assertGreater(abs(np.dot(points[1]-points[0],np.cross(points[2]-points[0],points[3]-points[0]))),100,'non-coplanar')
  g=self.assert_unfolded(report,hu);self.assertGreater(report['final']['outside'],0)
  # The initial normal is chosen once, by the default rule at the first two-point path, and the kept vector is
  # re-projected on every later pick; the expectation comes from the accepted point lists alone. A fresh default at
  # the final start tangent differs from it by more than 1e-3 for these picks, so that regression is detected.
  self.assertEqual(history[-1],value['points']);want=history_normal(history,value['output']['spacing'])
  np.testing.assert_allclose(value['frame']['initialNormal'],want,atol=1e-9)
  self.assertGreater(np.max(np.abs(default_normal(g['T'][0])-want)),1e-3,'fixture must tell the edit history from a fresh default')
  self.preserved_volume(before,self.volume_state(v))
  expect(self.path(v).locator('.badge')).to_have_text('UNFOLDED 3D PATH · Derived display · Not a source image')
  self.maxDiff=None;s,_=self.save_path_diagnosed(v,a,'path_01')
  self.assertEqual(s['version'],11);self.assertEqual(s['path'],value);self.assertEqual(len(s['volume']['sourceDigest']),64);self.assertEqual(len(s['cells']),3);self.assertFalse(v.evaluate('()=>kinMprPath.dirty()'))
  v.get_by_role('button',name='Print Current View',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('3D Path 작업은 아직 출력할 수 없습니다')
  forged_base=copy.deepcopy(s);del forged_base['volume']['sourceDigest']
  stale=list(value['frame']['initialNormal']);stale[0]+=2e-3;norm=math.sqrt(sum(x*x for x in stale));stale=[x/norm for x in stale]
  for label,edit in [('point outside the volume',lambda x:x['path']['points'][2].__setitem__(2,82)),('foreign frame of reference',lambda x:x['path'].update(frameOfReference='2.25.999')),
                     ('coarser spacing',lambda x:(x['path']['output'].update(spacing=0.7),x['path']['position'].update(column=0))),('column past the path',lambda x:x['path']['position'].update(column=report['final']['columns'])),
                     ('stale initial normal',lambda x:x['path']['frame'].update(initialNormal=stale)),('curve beside the path',lambda x:x.update(curved={'schema':1}))]:
   forged=copy.deepcopy(forged_base);edit(forged);r=self.stack.request('POST',f'/studies/{a.uid}/viewer-jobs','doctor',dict(id=str(uuid.uuid4()),title='Forged path',description='',snapshot=forged));self.assertEqual(r.status,400,label+' '+r.text)
  self.assertEqual(len(self.jobs(a)),1)
  fresh=self.login();self.launch(fresh,[a]);self.ready(fresh)
  fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('3D Path 작업을 복원했습니다',timeout=60000)
  expect(fresh.get_by_role('button',name='Print Saved Images',exact=True)).to_have_count(0)
  restored=self.path_final(fresh);self.assertEqual(restored['value'],s['path']);self.assertEqual(restored['final']['values'],report['final']['values']);self.assertFalse(fresh.evaluate('()=>kinMprPath.dirty()'))
  for camera,cell in zip(fresh.evaluate(CAMERAS),s['cells']):
   for key in ['focalPoint','position','viewPlaneNormal','viewUp']:np.testing.assert_allclose(camera[key],cell['camera'][key],atol=1e-6)
  expect(p.locator('#findings')).to_have_value('KEEP PATH REPORT');self.assertEqual(self.originals(),original)

 def test_path_02_go_to_path_point_native_planes_pixels_and_rotation_semantics(self):
  a,p,v=self.opened_path();original=self.originals();hu=hu_volume(SLOPE)
  v.get_by_role('button',name='Reset Planes',exact=True).click();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('시작 MPR 화면')
  start=v.evaluate(CAMERAS);self.path_input(v,'3D Path Half Height',2)
  self.add_path(v,[(2,[20,15,30],[6,8,30]),(1,[20,20,40],[16,20,40]),(0,[26,15,50],[26,12,52])]);report=self.path_final(v);value=report['value'];g=self.assert_unfolded(report,hu)
  # A point in the middle HU band, at least 2.5 mm from any band blend and well inside the slab.
  column=next(c for c in range(5,g['columns']-5) if 32<=g['centres'][c][2]<=50 and 4<=g['centres'][c][0]<=40 and 3<=g['centres'][c][1]<=28)
  centre=g['centres'][column].tolist();want_hu=trilinear(centre,hu);self.assertAlmostEqual(want_hu,500*2-1024,delta=1e-9)
  gray=round(255*min(1,max(0,(want_hu+1000)/2000)))
  self.path_input(v,'3D Path Position Column',column);self.path(v).get_by_label('Perpendicular Plane Cell',exact=True).select_option('0')
  self.path_button(v,'Go to Path Point').click();expect(self.path_status(v)).to_contain_text('경로 수직 평면',timeout=20000)
  navigation=self.path_inspect(v)['navigation'];self.assertEqual((navigation['column'],navigation['perpendicular'],navigation['rendered']),(column,0,3))
  evidence=v.evaluate(RENDERED,centre);print('PATH_PLANES',json.dumps({'column':column,'centre':centre,'gray':gray,'evidence':evidence}),flush=True)
  # One read after a fresh render of every plane is the assertion; there is no re-read.
  self.assert_cameras([row['camera'] for row in evidence],g,column)
  for row,old in zip(evidence,start):self.assertAlmostEqual(math.dist(row['camera']['position'],row['camera']['focalPoint']),math.dist(old['position'],old['focalPoint']),delta=1e-6)
  for row in evidence:self.assertAlmostEqual(row['pixel'],gray,delta=3,msg=json.dumps(row))
  # The planes keep their ordinary meaning afterwards: rotation about the path point, and Reset.
  v.get_by_label('MPR Rotation Axis',exact=True).select_option('2');v.get_by_label('MPR Rotation Degrees',exact=True).fill('15');v.get_by_role('button',name='Rotate Three Planes',exact=True).click()
  expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('15도 회전했습니다')
  for camera in v.evaluate(CAMERAS):self.assertAlmostEqual(abs(np.dot(np.array(camera['focalPoint'])-g['centres'][column],camera['viewPlaneNormal'])),0,delta=1e-6)
  v.get_by_role('button',name='Reset Planes',exact=True).click();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('시작 MPR 화면')
  for camera,old in zip(v.evaluate(CAMERAS),start):
   for key in ['focalPoint','position','viewPlaneNormal','viewUp']:np.testing.assert_allclose(camera[key],old[key],atol=1e-6)
  self.path_button(v,'Go to Path Point').click();expect(self.path_status(v)).to_contain_text('경로 수직 평면',timeout=20000)
  self.maxDiff=None;s,live=self.save_path_diagnosed(v,a,'path_02');self.assertEqual(s['version'],11);self.assertEqual(s['path'],live)
  self.assert_cameras([cell['camera'] for cell in s['cells']],g,column)
  fresh=self.login();self.launch(fresh,[a]);self.ready(fresh)
  fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('3D Path 작업을 복원했습니다',timeout=60000)
  self.assertEqual(self.path_final(fresh)['value'],s['path'])
  self.assert_cameras(fresh.evaluate(CAMERAS),g,column);self.assertEqual(self.originals(),original)

 def test_path_03_edit_delete_reset_and_unfolded_distance(self):
  a,p,v=self.opened_path();original=self.originals();p.locator('#findings').fill('KEEP PATH EDIT REPORT');hu=hu_volume(SLOPE)
  self.path_input(v,'3D Path Half Height',2);history=self.add_path(v,[(2,[20,15,40],[5,5,40]),(2,[20,15,40],[35,25,40])]);report=self.path_final(v);value=report['value']
  length=math.dist(*value['points']);self.assertAlmostEqual(report['final']['length'],length,delta=1e-9);self.assertEqual(report['final']['columns'],math.floor(length/0.5+1e-9)+1)
  self.assert_unfolded(report,hu)
  # First viable path: the default rule for an in-plane axial start direction is the axial normal.
  np.testing.assert_allclose(history_normal(history,0.5),[0,0,1],atol=1e-12);np.testing.assert_allclose(value['frame']['initialNormal'],history_normal(history,0.5),atol=1e-9)
  expect(self.path(v).locator('.caption')).to_contain_text('Arc length %.2f mm'%length);expect(self.path(v).locator('.note')).to_contain_text('직선 거리·측정 의미가 없고')
  self.save_volume(v);saved=self.get_volume_job(a)['snapshot']['path'];self.assertEqual(saved,value);self.assertFalse(v.evaluate('()=>kinMprPath.dirty()'))
  axial=self.view(v,2);start=v.evaluate(SCREEN,[axial,value['points'][1]]);end=v.evaluate(SCREEN,[axial,[35,20,40]])
  v.mouse.move(*start);v.mouse.down();v.mouse.move(*end,steps=8)
  expect(self.path(v).locator('p[data-kin-path-state]')).to_contain_text('Preview',timeout=10000);v.mouse.up()
  moved=self.path_final(v);self.assertTrue(abs(moved['value']['points'][1][1]-20)<=.5);self.assertEqual(moved['value']['points'][1][2],40);self.assert_unfolded(moved,hu);self.assertTrue(v.evaluate('()=>kinMprPath.dirty()'))
  # Every drag position stays in the z=40 plane, so each intermediate projection keeps the axial normal exactly;
  # the appended off-plane point then tilts the start tangent and the kept normal is projected onto it.
  history.append(moved['value']['points']);np.testing.assert_allclose(moved['value']['frame']['initialNormal'],history_normal(history,0.5),atol=1e-9)
  history+=self.add_path(v,[(1,[20,12,40],[40,12,50])]);three=self.path_final(v);self.assertEqual(len(three['value']['points']),3);self.assert_unfolded(three,hu)
  self.assertEqual(history[-1],three['value']['points']);np.testing.assert_allclose(three['value']['frame']['initialNormal'],history_normal(history,0.5),atol=1e-9)
  coronal=self.view(v,1);v.mouse.click(*v.evaluate(SCREEN,[coronal,three['value']['points'][2]]));self.assertEqual(self.path_inspect(v)['selected'],2)
  self.path_button(v,'Delete Point').click();deleted=self.path_final(v)['value'];self.assertEqual(len(deleted['points']),2)
  history.append(deleted['points']);np.testing.assert_allclose(deleted['frame']['initialNormal'],history_normal(history,0.5),atol=1e-9)
  self.path_button(v,'Reset Path').click();self.assertEqual(self.path_final(v)['value'],saved);self.assertFalse(v.evaluate('()=>kinMprPath.dirty()'))
  self.path_button(v,'Clear Path').click();expect(self.path(v).locator('p[data-kin-path-state]')).to_have_text('No Path');self.assertTrue(v.evaluate('()=>kinMprPath.dirty()'))
  v.get_by_role('button',name='Restore Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('미저장 3D Path')
  self.path_button(v,'Reset Path').click();self.assertEqual(self.path_final(v)['value'],saved)
  expect(p.locator('#findings')).to_have_value('KEEP PATH EDIT REPORT');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1);self.assertEqual(len(self.jobs(a)),1)

 def test_path_04_failed_restore_rollback_and_conflicts(self):
  a,p,v=self.opened_path();original=self.originals();hu=hu_volume(SLOPE);self.path_input(v,'3D Path Half Height',2)
  self.add_path(v,[(2,[20,15,30],[6,8,30]),(1,[20,20,40],[16,20,40])]);first=self.path_final(v);self.save_volume(v)
  self.path_button(v,'Clear Path').click();self.add_path(v,[(2,[20,15,35],[30,6,35]),(1,[20,18,45],[12,18,48]),(0,[8,15,50],[8,26,52])]);second=self.path_final(v);self.assert_unfolded(second,hu)
  v.get_by_label('Job Title',exact=True).fill('Second path');v.get_by_role('button',name='Save New Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('저장했습니다',timeout=45000)
  self.assertFalse(v.evaluate('()=>kinMprPath.dirty()'));before=self.volume_state(v);jobs=self.jobs(a);self.assertEqual(len(jobs),2)
  v.evaluate('()=>{const restore=kinMprPath.restore;let once=true;kinMprPath.restore=async(value,current,deadline)=>{await restore(value,current,deadline);if(once){once=false;throw Error("PATH RESTORE FAILURE")}}}')
  index=next(i for i,j in enumerate(jobs) if j['title']=='Saved MPR synthetic');v.get_by_role('button',name='Restore Job',exact=True).nth(index).click()
  expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('이전 화면',timeout=90000)
  report=self.path_final(v,60000);self.assertEqual(report['value'],second['value']);self.assertEqual(report['final']['values'],second['final']['values']);self.assertFalse(v.evaluate('()=>kinMprPath.dirty()'))
  self.assertEqual([(x['hash'],x['min'],x['max']) for x in before],[(x['hash'],x['min'],x['max']) for x in self.volume_state(v)]);self.assertNotEqual(first['value'],second['value'])
  # A curve and a path are two reconstructions; one Job holds only one of them.
  coronal=self.view(v,1);v.evaluate(PLACE,[coronal,[18,10,74]]);self.draw(v,coronal,[[5,10,72],[20,10,76],[35,10,72]]);self.final(v)
  v.get_by_label('Job Title',exact=True).fill('Curve with path');v.get_by_role('button',name='Save New Job',exact=True).click()
  expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('곡면 MPR과 3D Path는 한 작업에 하나만');self.assertEqual(len(self.jobs(a)),2)
  self.panel(v).get_by_role('button',name='Clear Curve',exact=True).click()
  axial=self.view(v,2);v.evaluate(PLACE,[axial,[20,15,40]]);v.evaluate('id=>{window.projectionVP=services.cornerstoneViewportService.getCornerstoneViewport(id);services.viewportGridService.setActiveViewportId(id)}',axial)
  v.wait_for_function('([id,p])=>{const view=services.cornerstoneViewportService.getCornerstoneViewport(id),xy=view.worldToCanvas(p),r=view.element.getBoundingClientRect();return services.viewportGridService.getState().activeViewportId===id&&view.element.contains(document.elementFromPoint(xy[0]+r.left,xy[1]+r.top))}',arg=[axial,[40,28,40]],timeout=5000)
  self.add_mark(v,'Path conflict',(40,28,40));v.get_by_label('Job Title',exact=True).fill('Marks with path');v.get_by_role('button',name='Save New Job',exact=True).click()
  expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('3D Path는 단면 묶음·3D 표식과 함께');self.assertEqual(len(self.jobs(a)),2)
  v.locator('#kin-mpr-marks').get_by_role('button',name='Remove Annotation',exact=True).click()
  v.get_by_role('button',name='Print Current View',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('3D Path 작업은 아직 출력할 수 없습니다')
  expect(v.get_by_role('button',name='Print Saved Images',exact=True)).to_have_count(0)
  self.assertEqual(len(self.jobs(a)),2);self.assertEqual(self.originals(),original)

def load_tests(loader,tests,pattern):return unittest.TestSuite(loader.loadTestsFromName(name,VolumePathE2E) for name in loader.getTestCaseNames(VolumePathE2E) if name.startswith('test_path_'))
if __name__=='__main__':unittest.main(verbosity=2)
