# coding: utf-8
"""TEST-MIP-VIEWER-DOM: independent whole-volume MIP/MinIP/Raysum viewer on known voxels, parity with the MPR slab."""
import json,math,time,unittest,uuid
from unittest.mock import patch
import numpy as np
from playwright.sync_api import expect
import test_prior_selection as ct
import test_volume_projection as projection
from test_volume_projection import VolumeProjectionE2E

# Separable known voxels: stored value = BASE + X[column band] + Y[row band] + Z[slice band]. A ray along one patient
# axis through the volume centre crosses only that axis' low, zero and high bands, and every axis has different
# bands, so each mode and orientation has its own value at the centre (at least 51 HU, 8.5 display levels, apart).
BASE,X,Y,Z,COLUMN=1000,(-200,0,250),(-300,0,150),(-100,0,400),1500
EDGES={64:(21,43),33:(11,22)}
# Voxel-centre ray lengths per band: 20.5/22/20.5 of 63 columns or rows, 10.5/11/10.5 of 32 slice gaps.
FRACTIONS={64:(20.5/63,22/63,20.5/63),33:(10.5/32,11/32,10.5/32)}
AXES={'Axial':(Z,33),'Coronal':(Y,64),'Sagittal':(X,64)}
MODES,ORIENTATIONS,BLENDS=('MIP','MinIP','Raysum'),('Axial','Coronal','Sagittal'),{'MIP':1,'MinIP':2,'Raysum':3}
CENTER,CORNER=[15.75,15.75,40],[.75,.75,40]
TOTAL=min(1000,math.hypot(63*.5,63*.5,32*2.5))
def band(index,count):low,high=EDGES[count];return 0 if index<low else 1 if index<high else 2
def expected_hu(mode,orientation,intercept=0):
 offsets,count=AXES[orientation]
 # Raysum is the mean of the samples on the ray, not their sum.
 return BASE+intercept+(max(offsets) if mode=='MIP' else min(offsets) if mode=='MinIP' else sum(f*o for f,o in zip(FRACTIONS[count],offsets)))
def level(hu,voi):return (hu-voi[0])/(voi[1]-voi[0])*255

def mip_phantom(stack,intercept=0):
 uid,series,frame=ct.generate_uid(),ct.generate_uid(),ct.generate_uid();patient='MIP-'+uuid.uuid4().hex[:10]
 f=ct.Fixture(uid,patient,'한림병원','jmryu','MIP-SYNTHETIC');stack.active[uid]=f
 ae=ct.AE(ae_title='HALLYM_CT');ae.add_requested_context(ct.CTImageStorage,ct.ExplicitVRLittleEndian);assoc=ae.associate('127.0.0.1',4242,ae_title='KINLAB')
 if not assoc.is_established:raise RuntimeError('Local CT association failed')
 columns=np.array([X[band(i,64)] for i in range(64)]);rows=np.array([Y[band(j,64)] for j in range(64)])
 try:
  for z in range(33):
   sop=ct.generate_uid();meta=ct.FileMetaDataset();meta.TransferSyntaxUID=ct.ExplicitVRLittleEndian;meta.MediaStorageSOPClassUID=ct.CTImageStorage;meta.MediaStorageSOPInstanceUID=sop;meta.ImplementationClassUID=ct.generate_uid()
   d=ct.FileDataset(None,{},file_meta=meta,preamble=b'\0'*128);d.SOPClassUID=ct.CTImageStorage;d.SOPInstanceUID=sop;d.SpecificCharacterSet='ISO_IR 192';d.PatientName='MIP^SYNTHETIC';d.PatientID=patient;d.PatientBirthDate='';d.PatientSex='O';d.InstitutionName='한림병원'
   d.StudyInstanceUID=uid;d.SeriesInstanceUID=series;d.FrameOfReferenceUID=frame;d.StudyDate=d.SeriesDate='20260915';d.StudyTime=d.SeriesTime='120000';d.AccessionNumber='MIP';d.StudyID='MIP';d.StudyDescription=d.SeriesDescription='Known voxel MIP viewer';d.Modality='CT';d.SeriesNumber=1;d.InstanceNumber=z+1;d.ImageType=['ORIGINAL','PRIMARY','AXIAL']
   # Anisotropic voxels: 0.5 mm in plane, 2.5 mm between slices.
   d.ImageOrientationPatient=[1,0,0,0,1,0];d.ImagePositionPatient=[0,0,z*2.5];d.SliceLocation=z*2.5;d.PixelSpacing=[.5,.5];d.SliceThickness=d.SpacingBetweenSlices=2.5
   d.Rows=d.Columns=64;d.SamplesPerPixel=1;d.PhotometricInterpretation='MONOCHROME2';d.BitsAllocated=d.BitsStored=16;d.HighBit=15;d.PixelRepresentation=0;d.WindowCenter=BASE+65+intercept;d.WindowWidth=1530;d.RescaleIntercept=intercept;d.RescaleSlope=1;d.RescaleType='HU'
   pixels=(BASE+rows[:,None]+columns[None,:]+Z[band(z,33)]).astype('<u2')
   # A constant 2x2 mm column through every slice: all three projections of it are the same value.
   pixels[:4,:4]=COLUMN;d.PixelData=pixels.tobytes();status=assoc.send_c_store(d)
   if status is None or status.Status!=0:raise RuntimeError('Synthetic CT C-STORE failed')
 finally:assoc.release()
 deadline=time.monotonic()+30
 while time.monotonic()<deadline:
  result=stack.request('GET','/studies','jmryu')
  if result.status==200 and any(s['uid']==uid for s in result.body['studies']):
   if stack.request('PATCH','/studies/'+uid,'jmryu',{'ss':'Verified'}).status!=200:raise RuntimeError('Synthetic CT verification failed')
   return f
  time.sleep(.25)
 raise RuntimeError('MIP CT did not reach local API')

HELPERS="""()=>{window.mipView=()=>cornerstone.getEnabledElement(document.querySelector('[data-kin-mip-render]'))?.viewport;
window.mipCount=()=>projectionVP.getRenderingEngine().getViewports().filter(v=>v.id.startsWith('kin-mip-')).length;
window.canvasPixel=(vp,w)=>{const c=vp.getCanvas(),q=vp.worldToCanvas(w);return c.getContext('2d').getImageData(Math.floor(q[0]*c.width/c.clientWidth),Math.floor(q[1]*c.height/c.clientHeight),1,1).data[0]};
window.mipState=()=>{const vp=mipView(),m=vp.getActors()[0].actor.getMapper(),cam=vp.getCamera(),o=m.getClippingPlanes().map(p=>Array.from(p.getOrigin())),d=document.querySelector('#kin-volume-mip'),s=d.querySelectorAll('select');
 return {id:vp.id,type:vp.type,actors:vp.getActors().length,blend:m.getBlendMode(),normal:Array.from(cam.viewPlaneNormal),up:Array.from(cam.viewUp),normals:m.getClippingPlanes().map(p=>Array.from(p.getNormal())),thickness:Math.hypot(...o[0].map((x,i)=>x-o[1][i])),sample:m.getSampleDistance(),spacing:Array.from(cornerstone.cache.getVolume(vp.getVolumeId()).spacing),volume:vp.getVolumeId(),source:services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId).getVolumeId(),camera:cornerstone.CONSTANTS.MPR_CAMERA_VALUES,state:d.dataset.kinMipState,label:d.querySelector('.kin-mip-label').textContent,mode:s[0].value,orientation:s[1].value}};}"""
SETTLE='()=>new Promise(r=>{let n=0;const f=()=>++n<4?requestAnimationFrame(f):setTimeout(r,250);requestAnimationFrame(f)})'

class VolumeMipE2E(VolumeProjectionE2E):
 def opened_mip_study(self,intercept=0):
  with patch.object(projection,'phantom',side_effect=lambda stack,value,constant,**sample:mip_phantom(stack,value)):
   a,p,v=self.opened_projection(intercept=intercept)
  voi=(BASE-700+intercept,BASE+830+intercept)
  v.evaluate("""([lower,upper])=>{for(const id of services.viewportGridService.getState().viewports.keys()){const vp=services.cornerstoneViewportService.getCornerstoneViewport(id);vp.setProperties({voiRange:{lower,upper},VOILUTFunction:'LINEAR',interpolationType:0,invert:false});vp.render()}}""",list(voi))
  v.evaluate(HELPERS);v.evaluate(SETTLE);return a,p,v,voi
 def open_mip(self,v):
  v.get_by_role('button',name='Open MIP Viewer',exact=True).click();dialog=v.locator('#kin-volume-mip')
  expect(dialog).to_have_attribute('data-kin-mip-state','final',timeout=45000);expect(dialog.locator('[role=status]')).to_contain_text('MIP · Axial');return dialog
 def choose_mip(self,dialog,mode=None,orientation=None):
  if orientation:dialog.get_by_label('MIP Orientation',exact=True).select_option(orientation)
  if mode:dialog.get_by_label('MIP Projection',exact=True).select_option(mode)
 def final(self,v,mode,orientation,probes=(CENTER,)):
  v.wait_for_function("([m,o])=>{const d=document.querySelector('#kin-volume-mip');return d?.dataset.kinMipState==='final'&&d.querySelector('.kin-mip-label').textContent.startsWith(m+' · '+o+' · ')}",arg=[mode,orientation],timeout=20000)
  v.evaluate(SETTLE);state=v.evaluate("probes=>({...mipState(),pixels:probes.map(w=>canvasPixel(mipView(),w))})",list(probes))
  self.assertEqual(state['state'],'final',state);self.native(state,mode,orientation);return state
 def native(self,state,mode,orientation):
  cam=state['camera'][orientation.lower()]
  self.assertTrue(state['id'].startswith('kin-mip-'));self.assertEqual(state['type'],'orthographic');self.assertEqual(state['actors'],1);self.assertEqual(state['blend'],BLENDS[mode])
  np.testing.assert_allclose(state['normal'],cam['viewPlaneNormal'],atol=1e-6,rtol=0);np.testing.assert_allclose(state['up'],cam['viewUp'],atol=1e-6,rtol=0)
  for normal in state['normals']:self.assertAlmostEqual(abs(float(np.dot(normal,cam['viewPlaneNormal']))),1,delta=1e-6)
  self.assertAlmostEqual(state['thickness'],TOTAL,delta=1e-6);self.assertAlmostEqual(state['sample'],sum(state['spacing'])/6,delta=1e-9)
  self.assertEqual(state['volume'],state['source']);self.assertEqual([state['mode'],state['orientation']],[mode,orientation]);self.assertTrue(state['label'].endswith(' · Final'))
 def near(self,actual,hu,voi,label):self.assertAlmostEqual(actual,level(hu,voi),delta=3,msg=label)

 def test_mip_01_known_voxels_modes_orientations_and_mpr_slab_parity(self):
  a,p,v,voi=self.opened_mip_study();original=self.originals();p.locator('#findings').fill('KEEP MIP REPORT');v.get_by_label('Job Title',exact=True).fill('KEEP MIP JOB');before=self.volume_state(v)
  centers=[expected_hu(m,o) for o in ORIENTATIONS for m in MODES];self.assertGreaterEqual(min(abs(x-y) for i,x in enumerate(centers) for y in centers[i+1:]),51)
  dialog=self.open_mip(v);expect(dialog.locator('details')).to_contain_text(a.uid);values={}
  for orientation in ORIENTATIONS:
   for mode in MODES:
    self.choose_mip(dialog,mode,orientation);probes=(CENTER,CORNER) if orientation=='Axial' else (CENTER,)
    state=self.final(v,mode,orientation,probes);self.near(state['pixels'][0],expected_hu(mode,orientation),voi,mode+' '+orientation)
    if orientation=='Axial':self.near(state['pixels'][1],COLUMN,voi,'constant column '+mode)
    values[mode+'/'+orientation]=state['pixels']
  print('MIP_VIEWER_PIXELS',json.dumps(values),flush=True)
  dialog.get_by_role('button',name='Close MIP Viewer',exact=True).click();expect(dialog).not_to_be_visible();self.assertEqual(v.evaluate('()=>mipCount()'),0)
  self.preserved_volume(before,self.volume_state(v));expect(p.locator('#findings')).to_have_value('KEEP MIP REPORT');expect(v.get_by_label('Job Title',exact=True)).to_have_value('KEEP MIP JOB')
  self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1);self.assertEqual(self.jobs(a),[])
  # The MPR slab at the same native plane, centre and whole-volume thickness gives the same final values.
  parity={}
  for orientation in ORIENTATIONS:
   index=v.evaluate("key=>{const n=cornerstone.CONSTANTS.MPR_CAMERA_VALUES[key].viewPlaneNormal;return [...services.viewportGridService.getState().viewports.keys()].findIndex(id=>{const c=services.cornerstoneViewportService.getCornerstoneViewport(id).getCamera().viewPlaneNormal;return Math.abs(c[0]*n[0]+c[1]*n[1]+c[2]*n[2])>1-1e-6})}",orientation.lower());self.assertGreaterEqual(index,0,orientation)
   self.choose_volume(v,v,index);v.wait_for_function("i=>services.viewportGridService.getState().activeViewportId===[...services.viewportGridService.getState().viewports.keys()][i]",arg=index);v.wait_for_timeout(700)
   v.evaluate("c=>{window.projectionVP=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);const n=projectionVP.getCamera().viewPlaneNormal;projectionVP.setCamera({focalPoint:c,position:c.map((x,i)=>x+500*n[i])});projectionVP.render()}",CENTER)
   limit=v.get_by_label('Total Thickness (mm)',exact=True).get_attribute('max');self.assertAlmostEqual(float(limit),TOTAL,delta=1e-9)
   for mode in MODES:
    self.project(v,BLENDS[mode],limit);probes=[CENTER,CORNER] if orientation=='Axial' else [CENTER]
    v.wait_for_function("([p,e])=>Math.abs(canvasPixel(projectionVP,p)-e)<=3",arg=[CENTER,level(expected_hu(mode,orientation),voi)]);v.evaluate(SETTLE)
    slab=v.evaluate("probes=>{const m=projectionVP.getActors()[0].actor.getMapper(),o=m.getClippingPlanes().map(p=>p.getOrigin());return {blend:m.getBlendMode(),thickness:Math.hypot(...o[0].map((x,i)=>x-o[1][i])),pixels:probes.map(w=>canvasPixel(projectionVP,w))}}",probes)
    self.assertEqual(slab['blend'],BLENDS[mode]);self.assertAlmostEqual(slab['thickness'],TOTAL,delta=1e-6)
    for actual,viewer in zip(slab['pixels'],values[mode+'/'+orientation]):self.assertLessEqual(abs(actual-viewer),3,(mode,orientation,slab,viewer))
    parity[mode+'/'+orientation]=slab['pixels']
  print('MPR_SLAB_PARITY_PIXELS',json.dumps(parity),flush=True)

 def test_mip_02_order_delay_failure_capability_and_busy_gates(self):
  intercept=-3000;a,p,v,voi=self.opened_mip_study(intercept);original=self.originals();before=self.volume_state(v)
  # A missing viewer module is reported at the entry and creates nothing.
  v.route('**/viewer-volume-mip.js',lambda route:route.abort());v.get_by_role('button',name='Open MIP Viewer',exact=True).click()
  expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('MIP Viewer 도구를 불러오지 못했습니다');expect(v.locator('#kin-volume-mip')).to_have_count(0);v.unroute('**/viewer-volume-mip.js')
  dialog=self.open_mip(v);status=dialog.locator('[role=status]')
  v.evaluate("""()=>{const s=document.querySelector('#kin-volume-mip [role=status]');window.mipStatuses=[];new MutationObserver(()=>mipStatuses.push(s.textContent)).observe(s,{childList:true,characterData:true,subtree:true});
   const pane=document.querySelector('#kin-volume-mip .kin-mip-canvas-pane');window.mipHold=true;window.mipHeldFrames=0;pane.addEventListener(cornerstone.Enums.Events.IMAGE_RENDERED,e=>{if(mipHold){e.stopImmediatePropagation();mipHeldFrames++}},true)}""")
  # Delayed final render: rendered frames are withheld, so nothing is final until the latest selection renders.
  self.choose_mip(dialog,'MinIP');v.wait_for_function('()=>mipHeldFrames>0');expect(dialog).to_have_attribute('data-kin-mip-state','pending');expect(dialog.locator('.kin-mip-label')).to_have_text('Rendering · 최종 표시 전')
  self.choose_mip(dialog,orientation='Coronal');self.choose_mip(dialog,'Raysum');v.wait_for_timeout(300);expect(dialog).to_have_attribute('data-kin-mip-state','pending')
  v.evaluate('()=>{mipHold=false;mipView().render()}');state=self.final(v,'Raysum','Coronal');self.near(state['pixels'][0],expected_hu('Raysum','Coronal',intercept),voi,'low HU Raysum Coronal')
  announced=[s for s in v.evaluate('()=>mipStatuses') if '최종 표시를 확인했습니다' in s];self.assertTrue(announced);self.assertTrue(all(s.startswith('Raysum · Coronal') for s in announced),announced)
  # Input order: plane-then-mode and mode-then-plane reach the same display and pixels.
  self.choose_mip(dialog,orientation='Sagittal');self.choose_mip(dialog,'MinIP');first=self.final(v,'MinIP','Sagittal')
  self.choose_mip(dialog,'MIP','Axial');self.final(v,'MIP','Axial');self.choose_mip(dialog,'MinIP');self.choose_mip(dialog,orientation='Sagittal');second=self.final(v,'MinIP','Sagittal')
  self.assertEqual({k:first[k] for k in ('blend','normal','up','thickness','pixels')},{k:second[k] for k in ('blend','normal','up','thickness','pixels')});self.near(second['pixels'][0],expected_hu('MinIP','Sagittal',intercept),voi,'low HU MinIP Sagittal')
  def kept(message):
   expect(status).to_contain_text(message);expect(status).to_contain_text('이전 표시(MinIP · Sagittal');state=self.final(v,'MinIP','Sagittal');self.assertEqual(state['pixels'],second['pixels'])
  # Setter and render failures keep the last confirmed display with a visible notice.
  v.evaluate("()=>{const vp=mipView(),set=vp.setBlendMode;vp.setBlendMode=function(mode,...rest){vp.setBlendMode=set;if(mode===1)throw Error('INJECTED MIP SETTER FAILURE');return set.call(this,mode,...rest)}}")
  self.choose_mip(dialog,'MIP');kept('INJECTED MIP SETTER FAILURE')
  v.evaluate("()=>{const vp=mipView(),render=vp.render;vp.render=function(){vp.render=render;throw Error('INJECTED MIP RENDER FAILURE')}}")
  self.choose_mip(dialog,orientation='Axial');kept('INJECTED MIP RENDER FAILURE')
  # A missing Raysum capability refuses Raysum instead of showing a non-average projection.
  v.evaluate('()=>{window.heldAverage=window.kinPrepareVolumeAverage;window.kinPrepareVolumeAverage=undefined}');self.choose_mip(dialog,'Raysum');kept('Raysum 평균 계산 모듈')
  v.evaluate('()=>{window.kinPrepareVolumeAverage=heldAverage}');self.choose_mip(dialog,'Raysum');state=self.final(v,'Raysum','Sagittal');self.near(state['pixels'][0],expected_hu('Raysum','Sagittal',intercept),voi,'low HU Raysum Sagittal')
  # Modal, job and preview gates refuse the change and keep the confirmed display.
  gates=[("()=>{const e=document.createElement('div');e.id='mip-modal-probe';e.setAttribute('role','dialog');e.setAttribute('aria-modal','true');document.body.append(e)}","()=>document.querySelector('#mip-modal-probe').remove()",'다른 창을 닫은 뒤'),
         ("()=>{window.heldJobs=window.kinViewerJobWorkspaceState;window.kinViewerJobWorkspaceState=()=>({...(heldJobs?.()||{}),busy:true})}","()=>{if(heldJobs)window.kinViewerJobWorkspaceState=heldJobs;else delete window.kinViewerJobWorkspaceState}",'영상 작업 처리가 끝난 뒤'),
         # The same capability object is restored so the progressive module still owns it at teardown.
         ("()=>{window.heldPreview=window.kinMprRenderingState;window.kinMprRenderingState={...(heldPreview||{}),busy:()=>true}}","()=>{if(heldPreview)window.kinMprRenderingState=heldPreview;else delete window.kinMprRenderingState}",'MPR preview 정리가 끝난 뒤')]
  for block,release,message in gates:
   v.evaluate(block);self.choose_mip(dialog,'MIP');expect(status).to_contain_text(message);expect(dialog.get_by_label('MIP Projection',exact=True)).to_have_value('Raysum')
   state=self.final(v,'Raysum','Sagittal');self.assertEqual(state['blend'],3);v.evaluate(release)
  self.choose_mip(dialog,'MIP');state=self.final(v,'MIP','Sagittal');self.near(state['pixels'][0],expected_hu('MIP','Sagittal',intercept),voi,'low HU MIP Sagittal')
  dialog.get_by_role('button',name='Close MIP Viewer',exact=True).click();expect(dialog).not_to_be_visible();self.assertEqual(v.evaluate('()=>mipCount()'),0)
  self.preserved_volume(before,self.volume_state(v));self.assertEqual(self.originals(),original);self.assertEqual(self.jobs(a),[])

 def test_mip_03_lifecycle_identity_teardown_reentry_and_high_values(self):
  intercept=3000;a,p,v,voi=self.opened_mip_study(intercept);original=self.originals();before=self.volume_state(v)
  entry="()=>[...document.querySelectorAll('#kin-volume-orientation button')].find(b=>b.textContent==='Open MIP Viewer').onclick()"
  # Delayed readiness: close while the access check is pending; its late response opens nothing.
  v.evaluate("()=>{const f=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).includes('/viewer-jobs')){window.mipWaiting=true;await new Promise(r=>window.releaseMipAccess=r)}return f(...args)};window.restoreMipFetch=()=>window.fetch=f}")
  v.get_by_role('button',name='Open MIP Viewer',exact=True).click();v.wait_for_function('()=>window.mipWaiting');dialog=v.locator('#kin-volume-mip')
  expect(dialog).to_have_attribute('data-kin-mip-state','pending');v.evaluate(entry);self.assertEqual(v.evaluate("()=>document.querySelectorAll('#kin-volume-mip').length"),1);self.assertEqual(v.evaluate('()=>mipCount()'),0)
  dialog.get_by_role('button',name='Close MIP Viewer',exact=True).click();v.evaluate('()=>{restoreMipFetch();releaseMipAccess()}');expect(dialog).not_to_be_visible();v.wait_for_timeout(500)
  self.assertEqual(v.evaluate('()=>mipCount()'),0);expect(dialog).not_to_have_attribute('data-kin-mip-state','final');expect(v.get_by_role('button',name='Open MIP Viewer',exact=True)).to_be_enabled()
  # Reentry while open keeps exactly one viewer; high HU values keep the known Raysum mean.
  dialog=self.open_mip(v);v.evaluate(entry);v.wait_for_timeout(300);self.assertEqual(v.evaluate('()=>mipCount()'),1)
  self.choose_mip(dialog,'Raysum');state=self.final(v,'Raysum','Axial',(CENTER,CORNER));self.near(state['pixels'][0],expected_hu('Raysum','Axial',intercept),voi,'high HU Raysum Axial');self.near(state['pixels'][1],COLUMN+intercept,voi,'high HU constant column')
  # Escape cancels; a reopened viewer starts from its first display.
  dialog.get_by_label('MIP Projection',exact=True).focus();v.keyboard.press('Escape');expect(dialog).not_to_be_visible();self.assertEqual(v.evaluate('()=>mipCount()'),0)
  dialog=self.open_mip(v);state=self.final(v,'MIP','Axial');self.near(state['pixels'][0],expected_hu('MIP','Axial',intercept),voi,'high HU MIP Axial')
  # Source volume replacement and plane selection replacement close the viewer and release its viewport.
  v.evaluate("()=>{window.mipSource=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);window.mipVolumeId=mipSource.getVolumeId;mipSource.getVolumeId=()=>'replaced-volume'}")
  expect(dialog).not_to_be_visible();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('MIP Viewer를 닫았습니다');self.assertEqual(v.evaluate('()=>mipCount()'),0);v.evaluate('()=>{mipSource.getVolumeId=mipVolumeId}')
  dialog=self.open_mip(v);v.evaluate("()=>{const s=services.viewportGridService.getState(),next=[...s.viewports.keys()].find(id=>id!==s.activeViewportId);services.viewportGridService.setActiveViewportId(next)}")
  expect(dialog).not_to_be_visible();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('원본');self.assertEqual(v.evaluate('()=>mipCount()'),0);expect(dialog.locator('details p')).to_have_text('')
  self.preserved_volume(before,self.volume_state(v));self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1);self.assertEqual(self.jobs(a),[])
  # Session end tears the viewer down.
  dialog=self.open_mip(v);v.evaluate("()=>window.dispatchEvent(new StorageEvent('storage',{key:'kin-session-ended',newValue:String(Date.now())}))")
  expect(v.locator('#kin-volume-mip[open]')).to_have_count(0);self.assertEqual(v.evaluate('()=>mipCount()'),0);self.assertEqual(self.originals(),original)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeMipE2E(n) for n in loader.getTestCaseNames(VolumeMipE2E) if n.startswith('test_mip_'))
if __name__=='__main__':unittest.main(verbosity=2)
