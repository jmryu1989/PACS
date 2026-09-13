# coding: utf-8
"""TEST-MPR-CURVED-DOM (native): manual curved/freehand MPR from original HU and Job v10 reopen.

Synthetic CT only. Pixel spacing 0.5 (rows) x 0.7 (columns), slice step 2.5 mm; stored values are
the projection phantom bands (100 / 500 / 900, a 4x4 corner of 1000). The expected HU of every
reconstructed sample is computed here with numpy from the DICOM definition, independently of the
viewer model, so a double rescale, nearest sampling, a flipped row or a wrong axis each fail.
"""
import copy,json,math,os,unittest,uuid
from pathlib import Path
from unittest.mock import patch
import numpy as np
from playwright.sync_api import expect, TimeoutError as PlaywrightTimeout
from pynetdicom.association import Association
from test_volume_projection import phantom
from test_volume_marks import VolumeMarksE2E
import test_prior_selection as ct

SPACING=(0.5,0.7,2.5)
SLOPE=dict(slope=2,intercept=-1024,signed=False)
SIGNED=dict(slope=1,intercept=1024,signed=True)
VIEWS='''()=>[...services.viewportGridService.getState().viewports.values()].filter(c=>c.displaySetInstanceUIDs?.length).sort((a,b)=>a.y-b.y||a.x-b.x).map(c=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(c.viewportId),m=v.getCamera();return {id:c.viewportId,normal:m.viewPlaneNormal}})'''
PLACE='''([id,focal])=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id),c=v.getCamera(),d=focal.map((n,i)=>n-c.focalPoint[i]);v.setCamera({focalPoint:focal,position:c.position.map((n,i)=>n+d[i])});v.setProperties({voiRange:{lower:-1000,upper:1000},VOILUTFunction:'LINEAR',invert:false});v.render()}'''
SCREEN='''([id,p])=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id),xy=v.worldToCanvas(p),r=v.element.getBoundingClientRect();return [xy[0]+r.left,xy[1]+r.top]}'''
PROBE='''([id,p])=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id),xy=v.worldToCanvas(p),r=v.element.getBoundingClientRect(),x=xy[0]+r.left,y=xy[1]+r.top,hit=document.elementFromPoint(x,y),s=kinMprCurved.inspect();
 return {view:id,active:services.viewportGridService.getState().activeViewportId,screen:[x,y],rect:[r.left,r.top,r.width,r.height],hit:hit?[hit.tagName,hit.id,String(hit.className?.baseVal??hit.className??'')].join('|'):null,hitInView:!!hit&&v.element.contains(hit),
  armed:s?.armed??null,state:s?.state??null,points:s?.value?.points??[],status:document.querySelector('#kin-mpr-curved [role=status]')?.textContent??null}}'''
ACCESSOR='''()=>{const id=[...services.viewportGridService.getState().viewports.values()].find(c=>c.displaySetInstanceUIDs?.length).viewportId,vol=cornerstone.cache.getVolume(services.cornerstoneViewportService.getCornerstoneViewport(id).getVolumeId()),m=vol.voxelManager,a=m.getCompleteScalarDataArray(),at=(i,j,k)=>a[i+j*vol.dimensions[0]+k*vol.dimensions[0]*vol.dimensions[1]];
 return {complete:typeof m.getCompleteScalarDataArray,atIJK:typeof m.getAtIJK,type:a.constructor.name,length:a.length,dimensions:Array.from(vol.dimensions),spacing:Array.from(vol.spacing),origin:Array.from(vol.origin),direction:Array.from(vol.direction),corner:at(1,2,5),low:at(40,40,5),mid:at(40,40,16),high:at(40,40,30)}}'''

def hu_volume(fixture):
 raw=np.empty((33,64,64),dtype=np.float64)
 for k in range(33):raw[k]=100 if k<=10 else 900 if k>=22 else 500;raw[k,:4,:4]=1000
 return raw*2-1024 if fixture is SLOPE else raw

def polyline(points,kind):
 if kind=='freehand':return [list(p) for p in points]
 n,out=len(points),[];at=lambda i:points[max(0,min(n-1,i))]
 for i in range(n-1):
  p0,p1,p2,p3=at(i-1),at(i),at(i+1),at(i+2)
  for j in range(16):
   t=j/16;out.append([.5*(2*p1[k]+(-p0[k]+p2[k])*t+(2*p0[k]-5*p1[k]+4*p2[k]-p3[k])*t*t+(-p0[k]+3*p1[k]-3*p2[k]+p3[k])*t**3) for k in range(3)])
 out.append(list(points[-1]));return out

def oracle(curve,hu):
 """kin-cpr-1 from its written contract: arc-length columns, +normal row 0, half-voxel clamp, trilinear."""
 line=polyline(curve['points'],curve['kind']);cumulative=[0.0]
 for i in range(1,len(line)):cumulative.append(cumulative[-1]+math.dist(line[i],line[i-1]))
 s,h,n=curve['output']['spacing'],curve['output']['halfHeight'],curve['plane']['normal']
 columns=math.floor(cumulative[-1]/s+1e-9)+1;half=math.floor(h/s+1e-9);rows=2*half+1;values=[];outside=0;segment=0;centre=[]
 for c in range(columns):
  d=c*s
  while segment<len(line)-2 and cumulative[segment+1]<d:segment+=1
  span=cumulative[segment+1]-cumulative[segment];f=min(1,max(0,(d-cumulative[segment])/span)) if span>0 else 0
  centre.append([line[segment][k]+(line[segment+1][k]-line[segment][k])*f for k in range(3)])
 dims=(64,64,33)
 for r in range(rows):
  offset=(half-r)*s
  for c in range(columns):
   p=[centre[c][k]+n[k]*offset for k in range(3)];index=[p[0]/SPACING[1],p[1]/SPACING[0],p[2]/SPACING[2]]
   if any(x< -.5-1e-6 or x>dims[a]-.5+1e-6 for a,x in enumerate(index)):values.append(None);outside+=1;continue
   x=[min(max(v,0),dims[a]-1) for a,v in enumerate(index)];base=[min(int(math.floor(v)),dims[a]-2) for a,v in enumerate(x)];frac=[x[a]-base[a] for a in range(3)]
   value=0.0
   for di in (0,1):
    for dj in (0,1):
     for dk in (0,1):
      w=(frac[0] if di else 1-frac[0])*(frac[1] if dj else 1-frac[1])*(frac[2] if dk else 1-frac[2])
      if w:value+=w*hu[base[2]+dk,base[1]+dj,base[0]+di]
   values.append(value)
 return columns,rows,values,outside

class VolumeCurvedE2E(VolumeMarksE2E):
 def opened_curved(self,fixture):
  send=Association.send_c_store
  def shaped(association,dataset,*args,**kwargs):
   self.assertIn(str(dataset.StudyInstanceUID),self.stack.active);z=int(dataset.InstanceNumber)-1
   dataset.PixelSpacing=[SPACING[0],SPACING[1]];dataset.ImagePositionPatient=[0,0,z*SPACING[2]];dataset.SliceLocation=z*SPACING[2];dataset.SliceThickness=dataset.SpacingBetweenSlices=SPACING[2]
   dataset.RescaleSlope=fixture['slope'];dataset.RescaleIntercept=fixture['intercept'];return send(association,dataset,*args,**kwargs)
  with patch.object(Association,'send_c_store',shaped):a=phantom(self.stack,0,signed=fixture['signed'])
  self.seed_report(a);p=self.login();self.choose(p,a)
  with p.context.expect_page() as opened:p.locator('#m-filmbox').click()
  v=opened.value;ct.canvas_ready(v,1);self.ready(v);self.mpr(v);self.choose_volume(v,v,0)
  expect(v.locator('#kin-mpr-curved')).to_be_visible(timeout=30000);return a,p,v
 def view(self,v,axis):
  return next(row['id'] for row in v.evaluate(VIEWS) if abs(abs(row['normal'][axis])-1)<1e-6)
 def panel(self,v):return v.locator('#kin-mpr-curved')
 def inspect(self,v,values=False):return v.evaluate('x=>kinMprCurved.inspect({values:x})',values)
 def final(self,v,timeout=30000):
  expect(self.panel(v).locator('p[data-kin-curved-state]')).to_have_text('Final',timeout=timeout);report=self.inspect(v,True);self.assertEqual(report['final']['signature'],report['current']);return report
 def click(self,v,view,point):v.mouse.click(*v.evaluate(SCREEN,[view,list(point)]))
 def add_point(self,v,view,point):
  # Every drawing click must add exactly this point at the end; the native facts around the click
  # (hit element, active pane, panel state/status, stored order) are printed either way.
  before=v.evaluate(PROBE,[view,list(point)]);n=len(before['points']);v.mouse.click(*before['screen']);failure=None
  try:v.wait_for_function('n=>(kinMprCurved.inspect()?.value?.points?.length??0)>n',arg=n,timeout=5000)
  except PlaywrightTimeout as error:failure=error
  after=v.evaluate(PROBE,[view,list(point)]);print('CURVED_CLICK',json.dumps({'index':n,'requested':list(point),'before':before,'after':after}),flush=True)
  if failure:self.fail(f'curved point {n} {list(point)} was not accepted; status {after["status"]!r}; hit {before["hit"]!r}')
  self.assertEqual(len(after['points']),n+1,after['points']);self.assertTrue(all(abs(x-y)<=.5 for x,y in zip(after['points'][n],point)),after['points'])
 def draw(self,v,view,points):
  self.panel(v).get_by_role('button',name='Draw Curve',exact=True).click()
  for point in points:self.add_point(v,view,point)
  self.panel(v).get_by_role('button',name='Finish Drawing',exact=True).click()
 def assert_oracle(self,report,hu):
  columns,rows,values,outside=oracle(report['value'],hu);final=report['final']
  self.assertEqual((final['columns'],final['rows'],final['outside']),(columns,rows,outside))
  for n,(got,want) in enumerate(zip(final['values'],values)):
   if want is None:self.assertIsNone(got,n)
   else:self.assertAlmostEqual(got,want,delta=1e-6,msg=n)
  return values
 def assert_accessor(self,v,fixture):
  facts=v.evaluate(ACCESSOR);print('CURVED_SCALAR_ACCESSOR',json.dumps(facts),flush=True);hu=hu_volume(fixture)
  self.assertEqual(facts['complete'],'function');self.assertEqual(facts['length'],64*64*33);self.assertEqual(facts['dimensions'],[64,64,33])
  for got,want in zip(facts['spacing'],[0.7,0.5,2.5]):self.assertAlmostEqual(got,want,delta=1e-9)
  self.assertEqual(facts['origin'],[0,0,0]);self.assertEqual(facts['direction'],[1,0,0,0,1,0,0,0,1])
  # Cached native scalars are HU: slope/intercept applied once by the loader, never by the viewer.
  self.assertEqual([facts['corner'],facts['low'],facts['mid'],facts['high']],[hu[5,2,1],hu[5,40,40],hu[16,40,40],hu[30,40,40]])

 def test_curved_01_anisotropic_rescaled_curve_edit_save_and_new_browser_restore(self):
  a,p,v=self.opened_curved(SLOPE);original=self.originals();p.locator('#findings').fill('KEEP CURVED REPORT');hu=hu_volume(SLOPE);self.assert_accessor(v,SLOPE)
  coronal=self.view(v,1);v.evaluate(PLACE,[coronal,[18,1,40]]);before=self.volume_state(v)
  self.panel(v).get_by_label('Curved MPR Half Height',exact=True).fill('3')
  self.draw(v,coronal,[[1,1,15],[20,1,40],[36,1,70]]);report=self.final(v)
  value=report['value'];self.assertEqual((value['kind'],value['output']['spacing'],value['plane']['origin'][1]),('curved',0.5,1))
  self.assertEqual(len(value['points']),3,value['points'])
  for got,want in zip(value['points'],[[1,1,15],[20,1,40],[36,1,70]]):self.assertTrue(all(abs(x-y)<=.5 for x,y in zip(got,want)),got)
  values=self.assert_oracle(report,hu);self.assertGreater(report['final']['outside'],0)
  self.assertTrue(any(abs(x-hu[5,2,1])<1e-9 for x in values if x is not None),'the 1000 raw corner voxel is reconstructed exactly')
  self.preserved_volume(before,self.volume_state(v))
  # Drag the middle control point: labelled preview while held, final after release.
  start=v.evaluate(SCREEN,[coronal,value['points'][1]]);end=v.evaluate(SCREEN,[coronal,[22,1,46]])
  v.mouse.move(*start);v.mouse.down();v.mouse.move(*end,steps=8)
  expect(self.panel(v).locator('p[data-kin-curved-state]')).to_contain_text('Preview',timeout=10000)
  self.assertIn('Finish Drawing',v.evaluate('()=>{try{kinMprCurved.capture();return ""}catch(e){return e.message}}'))
  v.mouse.up();report=self.final(v);self.assertTrue(abs(report['value']['points'][1][2]-46)<=.5);self.assert_oracle(report,hu)
  # Select and delete the last point, then draw it again.
  self.click(v,coronal,report['value']['points'][2]);self.panel(v).get_by_role('button',name='Delete Point',exact=True).click()
  self.assertEqual(len(self.final(v)['value']['points']),2);self.draw(v,coronal,[[36,1,70]]);report=self.final(v);self.assertEqual(len(report['value']['points']),3);values=self.assert_oracle(report,hu)
  self.save_volume(v);job=self.get_volume_job(a);s=job['snapshot'];self.assertEqual(s['version'],10);self.assertEqual(s['curved'],report['value']);self.assertEqual(len(s['volume']['sourceDigest']),64);self.assertEqual(len(s['cells']),3);self.assertFalse(v.evaluate('()=>kinMprCurved.dirty()'))
  v.get_by_role('button',name='Print Current View',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('Curved MPR 작업은 아직 출력할 수 없습니다')
  if os.environ.get('KIN_EVIDENCE_DIR'):v.screenshot(path=str(Path(os.environ['KIN_EVIDENCE_DIR'])/'mpr-curved-final.png'))
  fresh=self.login();self.launch(fresh,[a]);self.ready(fresh)
  fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('Curved MPR 작업을 복원했습니다',timeout=60000)
  expect(fresh.get_by_role('button',name='Restore Job',exact=True)).to_have_count(1);expect(fresh.get_by_role('button',name='Print Saved Images',exact=True)).to_have_count(0)
  restored=self.final(fresh);self.assertEqual(restored['value'],s['curved']);self.assertEqual(restored['final']['values'],report['final']['values']);self.assertFalse(fresh.evaluate('()=>kinMprCurved.dirty()'))
  cameras=fresh.evaluate('()=>[...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).map(c=>services.cornerstoneViewportService.getCornerstoneViewport(c.viewportId).getCamera())')
  for camera,cell in zip(cameras,s['cells']):
   for key in ['focalPoint','viewPlaneNormal','viewUp']:
    for got,want in zip(camera[key],cell['camera'][key]):self.assertAlmostEqual(got,want,delta=1e-6)
  expect(fresh.locator('#kin-mpr-curved .badge')).to_have_text('CURVED MPR · Derived display · Not a source image')
  expect(p.locator('#findings')).to_have_value('KEEP CURVED REPORT');self.assertEqual(self.originals(),original)

 def test_curved_02_signed_freehand_axial_edge_outside_rows_and_high_contrast_corner(self):
  a,p,v=self.opened_curved(SIGNED);original=self.originals();hu=hu_volume(SIGNED);self.assert_accessor(v,SIGNED)
  axial=self.view(v,2);v.evaluate(PLACE,[axial,[10,5,80]])
  panel=self.panel(v);panel.get_by_label('Curved MPR Half Height',exact=True).fill('3');panel.get_by_label('Curve Type',exact=True).select_option('freehand');panel.get_by_role('button',name='Draw Curve',exact=True).click()
  v.mouse.move(*v.evaluate(SCREEN,[axial,[0.2,1,80]]));v.mouse.down();v.mouse.move(*v.evaluate(SCREEN,[axial,[20,1,80]]),steps=25);v.mouse.up()
  report=self.final(v);value=report['value'];self.assertEqual((value['kind'],value['interpolation']),('freehand','linear'));self.assertTrue(2<=len(value['points'])<=128)
  values=self.assert_oracle(report,hu)
  # The last slice centre is z=80; samples beyond z=81.25 are outside: 4 rows on the +z side.
  self.assertEqual(report['final']['outside'],4*report['final']['columns'])
  self.assertTrue(any(abs(x-1000)<1e-9 for x in values if x is not None));self.assertTrue(any(abs(x-900)<1e-9 for x in values if x is not None))
  self.save_volume(v);self.assertEqual(self.get_volume_job(a)['snapshot']['curved'],value);self.assertEqual(self.originals(),original)

 def test_curved_03_off_plane_refusals_marks_conflict_forged_jobs_and_dirty_restore(self):
  a,p,v=self.opened_curved(SLOPE);coronal=self.view(v,1);v.evaluate(PLACE,[coronal,[18,10,40]]);panel=self.panel(v)
  self.draw(v,coronal,[[5,10,20],[30,10,60]]);report=self.final(v);value=report['value']
  v.evaluate('id=>{const view=services.cornerstoneViewportService.getCornerstoneViewport(id),c=view.getCamera(),d=c.viewPlaneNormal.map(n=>n*2);view.setCamera({focalPoint:c.focalPoint.map((n,i)=>n+d[i]),position:c.position.map((n,i)=>n+d[i])});view.render()}',coronal)
  expect(v.locator('[data-kin-curved-plane]')).to_contain_text('off curve plane · editing disabled')
  self.panel(v).get_by_role('button',name='Draw Curve',exact=True).click();self.click(v,coronal,[20,12,40]);expect(panel.locator('[role=status]')).to_contain_text('그리기 평면에서 벗어나')
  v.get_by_label('Job Title',exact=True).fill('Armed curved save');v.get_by_role('button',name='Save New Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('Finish Drawing');self.assertEqual(self.jobs(a),[])
  panel.get_by_role('button',name='Finish Drawing',exact=True).click();panel.get_by_role('button',name='Go to Curve Plane',exact=True).click()
  expect(v.locator('[data-kin-curved-plane]')).to_have_text('Curve plane · Curved MPR path');self.assertEqual(self.inspect(v)['value'],value)
  axial=self.view(v,2);v.evaluate('id=>{window.projectionVP=services.cornerstoneViewportService.getCornerstoneViewport(id);services.viewportGridService.setActiveViewportId(id)}',axial)
  # Pick Point listens on the cornerstone element; a press on an inactive pane only activates it.
  v.wait_for_function('([id,p])=>{const view=services.cornerstoneViewportService.getCornerstoneViewport(id),xy=view.worldToCanvas(p),r=view.element.getBoundingClientRect();return services.viewportGridService.getState().activeViewportId===id&&view.element.contains(document.elementFromPoint(xy[0]+r.left,xy[1]+r.top))}',arg=[axial,[10,10,40]],timeout=5000)
  self.assertEqual(v.evaluate('()=>services.viewportGridService.getState().activeViewportId'),axial)
  self.add_mark(v,'Curved conflict',(10,10,40));v.get_by_label('Job Title',exact=True).fill('Marks with curve');v.get_by_role('button',name='Save New Job',exact=True).click()
  expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('단면 묶음·3D 표식과 함께');self.assertEqual(self.jobs(a),[])
  v.locator('#kin-mpr-marks').get_by_role('button',name='Remove Annotation',exact=True).click()
  snapshot=v.evaluate('()=>kinCreateVolumeJob({grid:services.viewportGridService,cs:services.cornerstoneViewportService,ds:services.displaySetService,studies:new URLSearchParams(location.search).get("StudyInstanceUIDs").split(",")}).capture()')
  self.assertEqual(snapshot['version'],10)
  normal=value['plane']['normal']
  for label,edit in [('foreign frame of reference',lambda s:s['curved'].update(frameOfReference='2.25.999')),('off-plane point',lambda s:s['curved']['points'][1].__setitem__(1,s['curved']['points'][1][1]+.05)),
                     ('coarser spacing',lambda s:s['curved']['output'].update(spacing=0.7)),('unknown algorithm',lambda s:s['curved'].update(algorithm='kin-cpr-2')),('outside point',lambda s:s['curved']['points'][1].__setitem__(0,60))]:
   forged=copy.deepcopy(snapshot);edit(forged);r=self.stack.request('POST',f'/studies/{a.uid}/viewer-jobs','doctor',dict(id=str(uuid.uuid4()),title='Forged curved',description='',snapshot=forged));self.assertEqual(r.status,400,label+' '+r.text)
  r=self.stack.request('POST',f'/studies/{a.uid}/viewer-jobs','tech',dict(id=str(uuid.uuid4()),title='Denied curved',description='',snapshot=snapshot));self.assertEqual(r.status,403,r.text);self.assertEqual(self.jobs(a),[])
  self.save_volume(v);self.assertEqual(self.get_volume_job(a)['snapshot']['curved'],value)
  panel.get_by_role('button',name='Clear Curve',exact=True).click();self.assertTrue(v.evaluate('()=>kinMprCurved.dirty()'))
  v.get_by_role('button',name='Restore Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('미저장 곡면 MPR 곡선');self.assertIsNone(self.inspect(v)['value']);self.assertEqual(len(self.jobs(a)),1)

 def test_curved_04_failed_restore_rolls_back_to_the_previous_curve_and_pixels(self):
  a,p,v=self.opened_curved(SLOPE);hu=hu_volume(SLOPE);coronal=self.view(v,1);v.evaluate(PLACE,[coronal,[18,20,40]]);panel=self.panel(v)
  panel.get_by_label('Curved MPR Half Height',exact=True).fill('4');self.draw(v,coronal,[[5,20,20],[30,20,60]]);first=self.final(v);self.save_volume(v)
  panel.get_by_role('button',name='Clear Curve',exact=True).click();self.draw(v,coronal,[[8,20,70],[25,20,30],[40,20,50]]);second=self.final(v);self.assert_oracle(second,hu)
  v.get_by_label('Job Title',exact=True).fill('Second curve');v.get_by_role('button',name='Save New Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('저장했습니다',timeout=45000)
  self.assertFalse(v.evaluate('()=>kinMprCurved.dirty()'));before=self.volume_state(v);jobs=self.jobs(a);self.assertEqual(len(jobs),2)
  v.evaluate('()=>{const restore=kinMprCurved.restore;let once=true;kinMprCurved.restore=async(value,current,deadline)=>{await restore(value,current,deadline);if(once){once=false;throw Error("CURVED RESTORE FAILURE")}}}')
  index=next(i for i,j in enumerate(jobs) if j['title']=='Saved MPR synthetic');v.get_by_role('button',name='Restore Job',exact=True).nth(index).click()
  expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('이전 화면',timeout=90000)
  report=self.final(v,60000);self.assertEqual(report['value'],second['value']);self.assertEqual(report['final']['values'],second['final']['values']);self.assertFalse(v.evaluate('()=>kinMprCurved.dirty()'))
  self.assertEqual([(x['hash'],x['min'],x['max']) for x in before],[(x['hash'],x['min'],x['max']) for x in self.volume_state(v)])
  self.assertNotEqual(first['value'],second['value'])

def load_tests(loader,tests,pattern):return unittest.TestSuite(loader.loadTestsFromName(name,VolumeCurvedE2E) for name in loader.getTestCaseNames(VolumeCurvedE2E) if name.startswith('test_curved_'))
if __name__=='__main__':unittest.main(verbosity=2)
