# coding: utf-8
"""TEST-VOLUME-PROJECTION: known voxel slabs through the pinned native renderer."""
import json,time,unittest,uuid
from pathlib import Path
import numpy as np
from playwright.sync_api import expect
import test_prior_selection as ct
from test_volume_study_workflow import VolumeStudyWorkflowE2E

def phantom(stack,intercept=0,constant=False,signed=False):
 uid,series,frame=ct.generate_uid(),ct.generate_uid(),ct.generate_uid();patient='PROJECTION-'+uuid.uuid4().hex[:10]
 f=ct.Fixture(uid,patient,'한림병원','jmryu','PROJECTION-SYNTHETIC');stack.active[uid]=f
 ae=ct.AE(ae_title='HALLYM_CT');ae.add_requested_context(ct.CTImageStorage,ct.ExplicitVRLittleEndian);assoc=ae.associate('127.0.0.1',4242,ae_title='KINLAB')
 if not assoc.is_established:raise RuntimeError('Local CT association failed')
 try:
  for z in range(33):
   sop=ct.generate_uid();meta=ct.FileMetaDataset();meta.TransferSyntaxUID=ct.ExplicitVRLittleEndian;meta.MediaStorageSOPClassUID=ct.CTImageStorage;meta.MediaStorageSOPInstanceUID=sop;meta.ImplementationClassUID=ct.generate_uid()
   d=ct.FileDataset(None,{},file_meta=meta,preamble=b'\0'*128);d.SOPClassUID=ct.CTImageStorage;d.SOPInstanceUID=sop;d.SpecificCharacterSet='ISO_IR 192';d.PatientName='PROJECTION^SYNTHETIC';d.PatientID=patient;d.PatientBirthDate='';d.PatientSex='O';d.InstitutionName='한림병원'
   d.StudyInstanceUID=uid;d.SeriesInstanceUID=series;d.FrameOfReferenceUID=frame;d.StudyDate=d.SeriesDate='20260901';d.StudyTime=d.SeriesTime='120000';d.AccessionNumber='PROJECTION';d.StudyID='PROJECTION';d.StudyDescription=d.SeriesDescription='Known voxel projection';d.Modality='CT';d.SeriesNumber=1;d.InstanceNumber=z+1;d.ImageType=['ORIGINAL','PRIMARY','AXIAL'];d.ImageOrientationPatient=[1,0,0,0,1,0];d.ImagePositionPatient=[0,0,z];d.SliceLocation=z;d.PixelSpacing=[1,1];d.SliceThickness=d.SpacingBetweenSlices=1
   d.Rows=d.Columns=64;d.SamplesPerPixel=1;d.PhotometricInterpretation='MONOCHROME2';d.BitsAllocated=d.BitsStored=16;d.HighBit=15;d.PixelRepresentation=0;d.WindowCenter=500+intercept;d.WindowWidth=1000;d.RescaleIntercept=intercept;d.RescaleSlope=1;d.RescaleType='HU'
   value=500 if constant else 100 if z<=10 else 900 if z>=22 else 500;pixels=np.full((64,64),value,dtype='<u2');pixels[:4,:4]=1000 if not constant else 500
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
 def opened_projection(self,intercept=0,constant=False):
  a=phantom(self.stack,intercept,constant);self.seed_report(a);p=self.login();self.choose(p,a)
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

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeProjectionE2E(n) for n in loader.getTestCaseNames(VolumeProjectionE2E) if n.startswith('test_projection_'))
if __name__=='__main__':unittest.main(verbosity=2)
