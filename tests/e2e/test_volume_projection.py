# coding: utf-8
"""TEST-VOLUME-PROJECTION: known voxel slabs through the pinned native renderer."""
import json,math,time,unittest,uuid
from pathlib import Path
import numpy as np
from playwright.sync_api import expect
import test_prior_selection as ct
from test_volume_study_workflow import VolumeStudyWorkflowE2E

def phantom(stack,intercept=0,constant=False,signed=False,orientation=None,spacing=(1,1),structure=False):
 pitch,step=spacing
 uid,series,frame=ct.generate_uid(),ct.generate_uid(),ct.generate_uid();patient='PROJECTION-'+uuid.uuid4().hex[:10]
 f=ct.Fixture(uid,patient,'한림병원','jmryu','PROJECTION-SYNTHETIC');stack.active[uid]=f
 ae=ct.AE(ae_title='HALLYM_CT');ae.add_requested_context(ct.CTImageStorage,ct.ExplicitVRLittleEndian);assoc=ae.associate('127.0.0.1',4242,ae_title='KINLAB')
 if not assoc.is_established:raise RuntimeError('Local CT association failed')
 try:
  for z in range(33):
   sop=ct.generate_uid();meta=ct.FileMetaDataset();meta.TransferSyntaxUID=ct.ExplicitVRLittleEndian;meta.MediaStorageSOPClassUID=ct.CTImageStorage;meta.MediaStorageSOPInstanceUID=sop;meta.ImplementationClassUID=ct.generate_uid()
   d=ct.FileDataset(None,{},file_meta=meta,preamble=b'\0'*128);d.SOPClassUID=ct.CTImageStorage;d.SOPInstanceUID=sop;d.SpecificCharacterSet='ISO_IR 192';d.PatientName='PROJECTION^SYNTHETIC';d.PatientID=patient;d.PatientBirthDate='';d.PatientSex='O';d.InstitutionName='한림병원'
   d.StudyInstanceUID=uid;d.SeriesInstanceUID=series;d.FrameOfReferenceUID=frame;d.StudyDate=d.SeriesDate='20260901';d.StudyTime=d.SeriesTime='120000';d.AccessionNumber='PROJECTION';d.StudyID='PROJECTION';d.StudyDescription=d.SeriesDescription='Known voxel projection';d.Modality='CT';d.SeriesNumber=1;d.InstanceNumber=z+1;d.ImageType=['ORIGINAL','PRIMARY','AXIAL'];d.ImageOrientationPatient=[1,0,0,0,1,0] if orientation is None else [format(x,'.10g') for x in orientation];d.ImagePositionPatient=[0,0,z*step] if orientation is None else [format(x*z*step,'.10g') for x in np.cross(orientation[:3],orientation[3:])];d.SliceLocation=z*step;d.PixelSpacing=[pitch,pitch];d.SliceThickness=d.SpacingBetweenSlices=step
   d.Rows=d.Columns=64;d.SamplesPerPixel=1;d.PhotometricInterpretation='MONOCHROME2';d.BitsAllocated=d.BitsStored=16;d.HighBit=15;d.PixelRepresentation=0;d.WindowCenter=500+intercept;d.WindowWidth=1000;d.RescaleIntercept=intercept;d.RescaleSlope=1;d.RescaleType='HU'
   value=500 if constant or structure else 100 if z<=10 else 900 if z>=22 else 500;pixels=np.full((64,64),value,dtype='<u2');pixels[:4,:4]=500 if constant or structure else 1000
   # Decision 4 small high-contrast sample: one 2x2 mm block on a single 2.5 mm slice.
   if structure and z==13:pixels[30:34,30:34]=1000
   if signed:d.PixelRepresentation=1;d.WindowCenter-=1024;pixels=(pixels.astype('int32')-1024).astype('<i2')
   d.PixelData=pixels.tobytes();status=assoc.send_c_store(d)
   if status is None or status.Status!=0:raise RuntimeError('Synthetic CT C-STORE failed')
 finally:assoc.release()
 deadline=time.monotonic()+30
 while time.monotonic()<deadline:
  result=stack.request('GET','/studies','jmryu')
  if result.status==200 and any(s['uid']==uid for s in result.body['studies']):
   if stack.request('PATCH','/studies/'+uid,'jmryu',{'ss':'Verified'}).status!=200:raise RuntimeError('Synthetic CT verification failed')
   return f
  time.sleep(.25)
 raise RuntimeError('Projection CT did not reach local API')

class VolumeProjectionE2E(VolumeStudyWorkflowE2E):
 def opened_projection(self,intercept=0,constant=False,orientation=None,**sample):
  a=phantom(self.stack,intercept,constant,orientation=orientation,**sample);self.seed_report(a);p=self.login();self.choose(p,a)
  with p.context.expect_page() as opened:p.locator('#m-filmbox').click()
  v=opened.value;ct.canvas_ready(v,1);self.ready(v);self.mpr(v);self.choose_volume(v,v,0)
  v.evaluate("""()=>{window.projectionVP=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);projectionVP.setCamera({focalPoint:[32,32,16],position:[32,32,-500]});projectionVP.setProperties({voiRange:{lower:0,upper:1000},VOILUTFunction:'LINEAR',interpolationType:0,invert:false});projectionVP.render();window.projectionPixel=()=>{const v=projectionVP,c=v.getCanvas(),xy=v.worldToCanvas([32,32,16]);return c.getContext('2d').getImageData(Math.floor(xy[0]*c.width/c.clientWidth),Math.floor(xy[1]*c.height/c.clientHeight),1,1).data[0]}}""")
  v.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  expect(v.locator('#kin-volume-projection')).to_be_visible();expect(v.locator('#kin-volume-projection button')).to_be_enabled();return a,p,v
 def project(self,v,mode,total):
  v.get_by_label('Projection Mode',exact=True).select_option(str(mode))
  if mode:v.get_by_label('Total Thickness (mm)',exact=True).fill(str(total))
  v.get_by_role('button',name='Apply to Active Plane',exact=True).click();expect(v.locator('#kin-volume-projection [role=status]')).to_contain_text('적용했습니다')
 def test_projection_01_known_voxels_modes_thickness_and_other_planes(self):
  a,p,v=self.opened_projection();original=self.originals();p.locator('#findings').fill('KEEP PROJECTION REPORT');v.get_by_label('Job Title',exact=True).fill('KEEP PROJECTION JOB');before=self.volume_state(v);values=[]
  for mode,total,expected in [(1,20,229),(2,20,25),(3,20,127),(1,2,127),(0,.2,127)]:
   self.project(v,mode,total);v.wait_for_function('(expected)=>Math.abs(projectionPixel()-expected)<=3',arg=expected)
   state=v.evaluate("""()=>{const v=projectionVP,m=v.getActors()[0].actor.getMapper(),p=m.getClippingPlanes().map(p=>p.getOrigin());return {mode:m.getBlendMode(),thickness:Math.hypot(...p[0].map((x,i)=>x-p[1][i])),pixel:projectionPixel()}}""")
   self.assertEqual(state['mode'],mode);self.assertAlmostEqual(state['thickness'],total,delta=1e-6);values.append(state)
  self.preserved_volume(before[1:],self.volume_state(v)[1:]);expect(p.locator('#findings')).to_have_value('KEEP PROJECTION REPORT');expect(v.get_by_label('Job Title',exact=True)).to_have_value('KEEP PROJECTION JOB');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1);self.assertEqual(self.jobs(a),[])
  print('PROJECTION_PIXELS',json.dumps(values),flush=True);folder=Path('../tmp/volume-projection/screens');folder.mkdir(parents=True,exist_ok=True);v.screenshot(path=str(folder/'projection.png'))
 def test_projection_02_invalid_thickness_geometry_and_session(self):
  a,p,v=self.opened_projection();before=self.volume_state(v);v.get_by_label('Projection Mode',exact=True).select_option('1')
  for value in ['', '-1','1001']:
   v.get_by_label('Total Thickness (mm)',exact=True).fill(value);v.get_by_role('button',name='Apply to Active Plane',exact=True).click();expect(v.locator('#kin-volume-projection [role=status]')).to_contain_text('두께를');self.preserved_volume(before,self.volume_state(v))
  v.get_by_label('Total Thickness (mm)',exact=True).fill('20');v.evaluate("""()=>{const vol=cornerstone.cache.getVolume(projectionVP.getVolumeId());window.projectionMeta=cornerstone.metaData.get('instance',vol.imageIds.at(-1));window.projectionPosition=projectionMeta.ImagePositionPatient;projectionMeta.ImagePositionPatient=[0,0,99]}""");v.get_by_role('button',name='Apply to Active Plane',exact=True).click();expect(v.locator('#kin-volume-projection [role=status]')).to_contain_text('원본 좌표');self.preserved_volume(before,self.volume_state(v));v.evaluate('()=>projectionMeta.ImagePositionPatient=projectionPosition');self.project(v,1,20)
  v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(v.locator('#kin-volume-projection')).to_have_count(0);expect(v.locator('.kin-volume-projection-label')).to_have_count(0)

 def test_projection_03_negative_rescale_average_and_note_lock(self):
  a,p,v=self.opened_projection(intercept=-1000)
  v.evaluate("()=>{projectionVP.setProperties({voiRange:{lower:-1000,upper:0}});projectionVP.render()}")
  self.project(v,3,20);v.wait_for_function('()=>Math.abs(projectionPixel()-127)<=3')
  print('NEGATIVE_AVERAGE',v.evaluate('()=>({range:cornerstone.cache.getVolume(projectionVP.getVolumeId()).voxelManager.getRange(),pixel:projectionPixel()})'),flush=True)
  for selector in ['aria','bootstrap']:
   v.evaluate('kind=>{const e=document.createElement("div");e.id="projection-modal-probe";if(kind==="aria"){e.setAttribute("role","dialog");e.setAttribute("aria-modal","true");}else e.className="modal show";document.body.append(e)}',selector)
   expect(v.locator('#kin-volume-projection button')).to_be_disabled();v.evaluate('()=>document.querySelector("#projection-modal-probe").remove()');expect(v.locator('#kin-volume-projection button')).to_be_enabled()
  before=self.volume_state(v);self.open_note(v);expect(v.locator('#kin-volume-projection button')).to_be_disabled();self.preserved_volume(before,self.volume_state(v))
 def test_projection_04_constant_average(self):
  a,p,v=self.opened_projection(constant=True)
  self.project(v,3,20);v.wait_for_function('()=>Math.abs(projectionPixel()-127)<=3')
  print('CONSTANT_AVERAGE',v.evaluate('()=>({range:cornerstone.cache.getVolume(projectionVP.getVolumeId()).voxelManager.getRange(),pixel:projectionPixel()})'),flush=True)

 def test_projection_05_embedded_plane_change_and_source_guards(self):
  from test_embedded_patient_copy import EmbeddedPatientCopyE2E
  a,b=self.pair();p,f=EmbeddedPatientCopyE2E.opened(self,a);self.mpr(f);self.choose_volume(p,f,0)
  expect(f.locator('#kin-volume-projection button')).to_be_enabled();self.project(f,1,2)
  self.choose_volume(p,f,1);expect(f.get_by_label('Projection Mode',exact=True)).to_have_value('0');self.project(f,2,2)
  modes=f.evaluate('()=>Array.from(services.viewportGridService.getState().viewports.keys()).map(id=>services.cornerstoneViewportService.getCornerstoneViewport(id).getActors()[0].actor.getMapper().getBlendMode())');self.assertEqual(modes,[1,2,0])
  p.locator('#findings').fill('KEEP EMBEDDED PROJECTION');p.locator('#reading-tech-note').click();expect(p.locator('#tech-note-dialog')).to_be_visible();expect(f.locator('#kin-volume-projection button')).to_be_disabled();p.locator('#tech-note-close').click();expect(f.locator('#kin-volume-projection button')).to_be_enabled()
  f.evaluate("()=>{window.projectionSource=cornerstone.cache.getVolume(services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId).getVolumeId());projectionSource.loadStatus.loaded=false}");expect(f.locator('#kin-volume-projection button')).to_be_disabled();f.evaluate('()=>projectionSource.loadStatus.loaded=true');expect(f.locator('#kin-volume-projection button')).to_be_enabled();expect(p.locator('#findings')).to_have_value('KEEP EMBEDDED PROJECTION')

 def test_projection_06_high_hu_and_lost_texture_metadata(self):
  a,p,v=self.opened_projection(intercept=4096)
  v.evaluate("()=>{projectionVP.setProperties({voiRange:{lower:4096,upper:5096}});projectionVP.render()}")
  self.project(v,3,20);v.wait_for_function('()=>Math.abs(projectionPixel()-127)<=3')
  print('HIGH_HU_AVERAGE',v.evaluate('()=>({range:cornerstone.cache.getVolume(projectionVP.getVolumeId()).voxelManager.getRange(),pixel:projectionPixel()})'),flush=True)
  v.evaluate('()=>{const info=projectionVP.getActors()[0].actor.getMapper().getScalarTexture().getVolumeInfo();delete info.dataComputedScale;delete info.dataComputedOffset}')
  expect(v.locator('.kin-volume-projection-label').filter(has_text='Average')).to_contain_text('확인 필요');self.project(v,3,20);expect(v.locator('.kin-volume-projection-label').filter(has_text='Average')).not_to_contain_text('확인 필요');v.wait_for_function('()=>Math.abs(projectionPixel()-127)<=3')

 def slab_state(self,v,world):
  return v.evaluate("""world=>{const v=projectionVP,m=v.getActors()[0].actor.getMapper(),planes=m.getClippingPlanes(),o=planes.map(p=>p.getOrigin());return {mode:m.getBlendMode(),thickness:Math.hypot(...o[0].map((x,i)=>x-o[1][i])),normals:planes.map(p=>Array.from(p.getNormal())),viewNormal:Array.from(v.getCamera().viewPlaneNormal),pixel:slabPixel(world)}}""",world)
 def settled_slab(self,v,world,low,high):
  # Print the actual final pixel before failing so a CI timeout still records the value.
  try:v.wait_for_function('([w,l,h])=>{const p=slabPixel(w);return p>=l&&p<=h}',arg=[world,low,high])
  except Exception:print('SLAB_STATE',json.dumps(self.slab_state(v,world)),flush=True);raise
  return self.slab_state(v,world)
 def stable_pixel(self,v,expected):
  # A late render of the previous thickness would land after the first matching frame.
  v.wait_for_function('e=>Math.abs(projectionPixel()-e)<=3',arg=expected)
  v.evaluate('()=>new Promise(r=>{let n=0;const f=()=>++n<4?requestAnimationFrame(f):setTimeout(r,300);requestAnimationFrame(f)})')
  self.assertAlmostEqual(v.evaluate('()=>projectionPixel()'),expected,delta=3)

 def test_projection_07_anisotropic_oblique_small_structure_final_pixels(self):
  a,p,v=self.opened_projection(spacing=(.5,2.5),structure=True);original=self.originals();block=[15.75,15.75,32.5];values=[]
  v.evaluate("""()=>{window.slabPixel=w=>{const v=projectionVP,c=v.getCanvas(),q=v.worldToCanvas(w);return c.getContext('2d').getImageData(Math.floor(q[0]*c.width/c.clientWidth),Math.floor(q[1]*c.height/c.clientHeight),1,1).data[0]};projectionVP.setCamera({focalPoint:[15.75,15.75,40],position:[15.75,15.75,-460]});projectionVP.render()}""")
  # Axial slab centred 7.5 mm above the one-slice block: 20 mm reaches it, 2 mm does not.
  for mode,total,low,high in [(1,20,252,255),(2,20,124,130),(3,20,130,170),(1,2,124,130)]:
   self.project(v,mode,total);state=self.settled_slab(v,block,low,high)
   self.assertEqual(state['mode'],mode);self.assertAlmostEqual(state['thickness'],total,delta=1e-6);values.append(state)
  maximum=math.hypot(31.5,31.5,80);self.project(v,1,20);before=self.settled_slab(v,block,252,255);limit=v.get_by_label('Total Thickness (mm)',exact=True).get_attribute('max');self.assertAlmostEqual(float(limit),maximum,delta=1e-3)
  for bad in ['0.19',str(round(maximum+.1,3))]:
   v.get_by_label('Total Thickness (mm)',exact=True).fill(bad);v.get_by_role('button',name='Apply to Active Plane',exact=True).click();expect(v.locator('#kin-volume-projection [role=status]')).to_contain_text('0.2~91.6 mm');self.assertEqual(self.slab_state(v,block),before)
  self.project(v,1,limit);self.assertAlmostEqual(self.settled_slab(v,block,252,255)['thickness'],float(limit),delta=1e-6)
  # Oblique plane tilted 30 degrees about x through the block, then shifted 8 mm along its normal.
  n=[0,.5,math.sqrt(3)/2];up=[0,-math.sqrt(3)/2,.5]
  def aim(offset):
   f=[block[i]+offset*n[i] for i in range(3)]
   v.evaluate('([f,n,u])=>{projectionVP.setCamera({focalPoint:f,position:f.map((x,i)=>x+500*n[i]),viewPlaneNormal:n,viewUp:u});projectionVP.render()}',[f,n,up])
  aim(0);self.project(v,1,10);state=self.settled_slab(v,block,252,255);values.append(state)
  np.testing.assert_allclose(state['viewNormal'],n,atol=1e-6,rtol=0);self.assertAlmostEqual(state['thickness'],10,delta=1e-6)
  for normal in state['normals']:self.assertAlmostEqual(abs(float(np.dot(normal,n))),1,delta=1e-6)
  aim(8);self.project(v,1,2);values.append(self.settled_slab(v,block,124,130));self.project(v,1,20);values.append(self.settled_slab(v,block,252,255))
  self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1);self.assertEqual(self.jobs(a),[])
  print('ANISOTROPIC_OBLIQUE_SLAB',json.dumps(values),flush=True)

 def test_projection_08_progressive_slab_preview_final_and_capture_gate(self):
  a,p,v=self.opened_projection();original=self.originals();p.locator('#findings').fill('KEEP SLAB FINAL REPORT')
  expect(v.locator('#kin-mpr-preferences')).to_be_visible();v.get_by_label('MPR Progressive Rendering',exact=True).check()
  self.project(v,1,20);self.stable_pixel(v,229)
  base=v.evaluate('()=>{window.slabMapper=projectionVP.getActors()[0].actor.getMapper();return slabMapper.getSampleDistance()}')
  pick=v.locator('#kin-mpr-marks [data-action=pick]');expect(pick).to_be_enabled();expect(v.locator('.kin-mpr-refining')).to_have_count(0)
  def preview():
   v.wait_for_function("b=>{if(slabMapper.getSampleDistance()===b)projectionVP.element.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));return slabMapper.getSampleDistance()===b*3}",arg=base)
   expect(v.locator('.kin-mpr-refining').first).to_have_text('Preview · refining');self.assertTrue(v.evaluate('()=>kinMprRenderingState.busy()'))
  def final(total,expected):
   v.wait_for_function('b=>slabMapper.getSampleDistance()===b&&!kinMprRenderingState.busy()',arg=base);expect(v.locator('.kin-mpr-refining')).to_have_count(0)
   self.stable_pixel(v,expected);expect(v.locator('.kin-volume-projection-label').filter(has_text='MIP')).to_contain_text('MIP · '+str(total)+' mm');expect(pick).to_be_enabled()
  apply_now="""total=>{const panel=document.querySelector('#kin-volume-projection');panel.querySelector('input').value=String(total);panel.querySelector('button').click();return {status:panel.querySelector('[role=status]').textContent,thickness:2*projectionVP.getSlabThickness(),sample:slabMapper.getSampleDistance(),refining:document.querySelectorAll('.kin-mpr-refining').length}}"""
  # A held preview is visibly not final and blocks manual measurement completion.
  preview();expect(pick).to_be_disabled()
  # Input order: a thinner slab applied during preview stays labelled preview until release,
  # and the released final frame is the new 2 mm MIP (127), never the previous 20 mm (229).
  during=v.evaluate(apply_now,2);self.assertIn('적용했습니다',during['status']);self.assertAlmostEqual(during['thickness'],2,delta=1e-6);self.assertEqual(during['sample'],base*3);self.assertGreaterEqual(during['refining'],1)
  v.evaluate("()=>document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}))");final(2,127)
  # Delayed settle: a wheel preview's 150 ms timer fires after a thicker slab was applied.
  during=v.evaluate("t=>{projectionVP.element.dispatchEvent(new WheelEvent('wheel',{deltaY:0,bubbles:true,cancelable:true}));return ("+apply_now+")(t)}",20)
  self.assertAlmostEqual(during['thickness'],20,delta=1e-6);self.assertEqual(during['sample'],base*3);self.assertGreaterEqual(during['refining'],1);final(20,229)
  # Capture: Save New Job activated from the keyboard while the pointer still holds a preview
  # must start from the exact final sampling, and the Job keeps only the final projection.
  center=v.evaluate('()=>{const r=projectionVP.element.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]}');v.mouse.move(*center);v.mouse.down()
  v.wait_for_function('b=>slabMapper.getSampleDistance()===b*3',arg=base);expect(v.locator('.kin-mpr-refining').first).to_be_visible()
  v.evaluate("""()=>{window.saveProbe=null;document.addEventListener('click',e=>{if(e.target?.textContent==='Save New Job'&&!saveProbe)saveProbe={refining:document.querySelectorAll('.kin-mpr-refining').length,sample:slabMapper.getSampleDistance()}},true)}""")
  v.get_by_label('Job Title',exact=True).fill('SLAB FINAL JOB');self.assertEqual(v.evaluate('()=>slabMapper.getSampleDistance()'),base*3)
  v.get_by_role('button',name='Save New Job',exact=True).focus();v.keyboard.press('Enter');v.mouse.up()
  expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('저장했습니다',timeout=45000);self.assertEqual(v.evaluate('()=>saveProbe'),{'refining':0,'sample':base})
  rows=self.jobs(a);self.assertEqual(len(rows),1);job=self.stack.request('GET',f'/studies/{a.uid}/viewer-jobs/{rows[0]["id"]}','doctor');self.assertEqual(job.status,200,job.text)
  cells=[c for c in job.body['snapshot']['cells'] if c and c['projection']['blend']==1];self.assertEqual(len(cells),1);self.assertAlmostEqual(cells[0]['projection']['thickness'],20,delta=1e-6);self.assertNotIn('ampleDistance',json.dumps(job.body['snapshot']))
  expect(p.locator('#findings')).to_have_value('KEEP SLAB FINAL REPORT');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeProjectionE2E(n) for n in loader.getTestCaseNames(VolumeProjectionE2E) if n.startswith('test_projection_'))
if __name__=='__main__':unittest.main(verbosity=2)
