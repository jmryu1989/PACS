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

# A11-VOI-1 VOI Slab oracle, pure geometry on the same known voxels. World = (column*.5, row*.5, slice*2.5) mm. The pinned
# mapper shortens each ray to the segment inside all clipping planes and takes nearest-voxel samples every STEP mm, so a
# probe's value follows from the band lengths on its kept segment; the zero-fill expectation is what a 0 HU substitution
# would show instead, and the unclipped one what ignoring the slab would show.
SPACING,COUNTS,RAY=(.5,.5,2.5),(64,64,33),{'Axial':2,'Coronal':1,'Sagittal':0}
STEP=sum(SPACING)/6
# Declared margins: probes are >=2 voxels from in-plane value edges and VOI edges, and kept-segment ends are >=3 sample
# steps from along-ray value edges (plus the travel of a 2-voxel in-plane shift on an oblique slab). A mean's sampling
# error bound must stay <=1.5 gray so the delta-3 assertion still separates it from both alternatives by >=9 gray.
VOI_DISCRIMINATION,VOI_DELTA,VOI_MEAN_BOUND=9,3,1.5
# Positive study: every stored value maps to >=+100 HU, so 0 HU fill lowers MinIP and means. Negative study: every value is
# <=-100 HU, so 0 HU fill raises MIP and means. A symmetric window keeps level(0 HU) at 127.5, far from background 0.
VOI_STUDIES=(('positive',-300,(-1100,1100)),('negative',-1900,(-1100,1100)))
# Along-ray (Axial slab S 35..76 keeps part of the zero and high S bands), perpendicular (Sagittal slab L -3..19.25 restricts
# columns; along its own rays it keeps the low and zero L bands) and oblique (30 degrees about S, clarified with 25 degrees
# about P so the normal also crosses the 2.5 mm axis, then a 6 mm Move, all about a pivot away from the centre).
VOI_CASES=({'name':'along-ray','preset':'Axial','center':(15.75,15.75,55.5),'pivot':(15.75,15.75,40),'thickness':41,'rotations':(),'move':0},
           {'name':'perpendicular','preset':'Sagittal','center':(8.125,15.75,40),'pivot':(15.75,15.75,40),'thickness':22.25,'rotations':(),'move':0},
           {'name':'oblique','preset':'Sagittal','center':(18,15.75,40),'pivot':(15.75,15.75,40),'thickness':14,'rotations':(('S',30),('P',25)),'move':6})
# A slab that keeps the band holding a ray's extreme cannot change that extreme: these cells have no discriminating probe
# by construction and are covered by the other along-ray view.
VOI_UNDISCRIMINATING={('along-ray','Axial','MIP'),('perpendicular','Sagittal','MinIP')}
PRESET_NORMALS,WORLD_AXES={'Axial':(0,0,1),'Coronal':(0,1,0),'Sagittal':(1,0,0)},{'L':(1,0,0),'P':(0,1,0),'S':(0,0,1)}

def rodrigues(v,k,radians):
 c,s,kv=math.cos(radians),math.sin(radians),sum(a*b for a,b in zip(k,v));cross=(k[1]*v[2]-k[2]*v[1],k[2]*v[0]-k[0]*v[2],k[0]*v[1]-k[1]*v[0])
 return [v[i]*c+cross[i]*s+k[i]*kv*(1-c) for i in range(3)]
def voi_record(case):
 normal,center,pivot=list(PRESET_NORMALS[case['preset']]),list(case['center']),list(case['pivot'])
 for axis,degrees in case['rotations']:
  r=math.radians(degrees);normal=rodrigues(normal,WORLD_AXES[axis],r);center=[p+x for p,x in zip(pivot,rodrigues([c-p for c,p in zip(center,pivot)],WORLD_AXES[axis],r))]
  length=math.hypot(*normal);normal=[n/length for n in normal]
 return {'center':[c+case['move']*n for c,n in zip(center,normal)],'normal':normal,'thickness':case['thickness']}
def voi_planes(record):
 c,n,h=record['center'],record['normal'],record['thickness']/2
 return [([c[i]-n[i]*h for i in range(3)],list(n)),([c[i]+n[i]*h for i in range(3)],[-x for x in n])]
def mm_text(value):
 # JavaScript Number(value.toFixed(1)) for these positive lengths: halves round up.
 tenths=math.floor(value*10+.5);return ('%.1f'%(tenths/10)).rstrip('0').rstrip('.')
def voi_label(record):return 'VOI Slab '+mm_text(record['thickness'])+' mm'
VOI_HELPERS="""()=>{if(window.mipVoiReady)return;window.mipVoiReady=true;const d=document.querySelector('#kin-volume-mip'),s=d.querySelector('[role=status]');
window.mipVoiState=probes=>{const vp=mipView(),m=vp.getActors()[0].actor.getMapper(),cam=vp.getCamera();
 return {blend:m.getBlendMode(),normal:Array.from(cam.viewPlaneNormal),up:Array.from(cam.viewUp),planes:m.getClippingPlanes().map(p=>[Array.from(p.getOrigin()),Array.from(p.getNormal())]),voiRange:{...vp.getProperties().voiRange},camera:cornerstone.CONSTANTS.MPR_CAMERA_VALUES,
  state:d.dataset.kinMipState,label:d.querySelector('.kin-mip-label').textContent,voi:d.querySelector('.kin-mip-voi-state').textContent,status:s.textContent,mode:d.querySelector('[aria-label="MIP Projection"]').value,orientation:d.querySelector('[aria-label="MIP Orientation"]').value,pixels:probes.map(w=>canvasPixel(vp,w))}};
window.mipTransitions=[];let shown=d.dataset.kinMipState||'';new MutationObserver(()=>{const now=d.dataset.kinMipState||'';if(now!==shown)mipTransitions.push(shown=now)}).observe(d,{attributes:true,attributeFilter:['data-kin-mip-state']});
window.mipStatuses=[];new MutationObserver(()=>mipStatuses.push(s.textContent)).observe(s,{childList:true,characterData:true,subtree:true});
window.mipTrace=()=>{const limit=Error.stackTraceLimit;Error.stackTraceLimit=20;const stack=new Error().stack;Error.stackTraceLimit=limit;return stack};
window.mipHold=false;window.mipHeldFrames=0;d.querySelector('.kin-mip-canvas-pane').addEventListener(cornerstone.Enums.Events.IMAGE_RENDERED,e=>{if(mipHold){e.stopImmediatePropagation();mipHeldFrames++}},true)}"""
SOURCE_PLANES="()=>[...services.viewportGridService.getState().viewports.keys()].map(id=>services.cornerstoneViewportService.getCornerstoneViewport(id).getActors().map(a=>(a.actor.getMapper().getClippingPlanes?.()||[]).map(p=>[...p.getOrigin(),...p.getNormal()])))"
VOI_GATES=(("()=>{const e=document.createElement('div');e.id='mip-voi-modal-probe';e.setAttribute('role','dialog');e.setAttribute('aria-modal','true');document.body.append(e)}","()=>document.querySelector('#mip-voi-modal-probe').remove()",'다른 창을 닫은 뒤'),
           ("()=>{window.heldJobs=window.kinViewerJobWorkspaceState;window.kinViewerJobWorkspaceState=()=>({...(heldJobs?.()||{}),busy:true})}","()=>{if(heldJobs)window.kinViewerJobWorkspaceState=heldJobs;else delete window.kinViewerJobWorkspaceState}",'영상 작업 처리가 끝난 뒤'),
           ("()=>{window.heldPreview=window.kinMprRenderingState;window.kinMprRenderingState={...(heldPreview||{}),busy:()=>true}}","()=>{if(heldPreview)window.kinMprRenderingState=heldPreview;else delete window.kinMprRenderingState}",'MPR preview 정리가 끝난 뒤'))
def nearest(value,axis):return min(COUNTS[axis]-1,max(0,math.floor(value/SPACING[axis]+.5)))
def value_edges(axis):
 # Along one axis the stored value changes only where the nearest voxel's band changes, and at the constant column's edge.
 return [(e-.5)*SPACING[axis] for e in EDGES[COUNTS[axis]]]+([(4-.5)*SPACING[axis]] if axis<2 else [])
def voxel_hu(index,intercept):
 i,j,k=index
 return COLUMN+intercept if i<4 and j<4 else BASE+intercept+X[band(i,64)]+Y[band(j,64)]+Z[band(k,33)]
def ray_segments(point,axis,intercept,extend=0):
 lo,hi=0,(COUNTS[axis]-1)*SPACING[axis];cuts=sorted({lo,hi,*[e for e in value_edges(axis) if lo<e<hi]});result=[]
 for s0,s1 in zip(cuts,cuts[1:]):
  index=[nearest(point[b],b) for b in range(3)];index[axis]=nearest((s0+s1)/2,axis);result.append([s0,s1,voxel_hu(index,intercept)])
 result[0][0]-=extend;result[-1][1]+=extend;return result
def kept_segment(point,axis,record):
 lo,hi=0,(COUNTS[axis]-1)*SPACING[axis];c,n,t=record['center'],record['normal'],record['thickness']
 d0=sum(((0 if b==axis else point[b])-c[b])*n[b] for b in range(3))
 if abs(n[axis])<1e-9:return ((lo,hi) if abs(d0)<=t/2 else None),None
 a,b=sorted(((-t/2-d0)/n[axis],(t/2-d0)/n[axis]));u,v=max(lo,a),min(hi,b)
 return ((u,v) if v>u else None),(a,b)
def clipped_parts(segments,interval):
 return [(max(s0,interval[0]),min(s1,interval[1]),hu) for s0,s1,hu in segments if min(s1,interval[1])>max(s0,interval[0])]
def project_hu(parts,mode):
 values=[hu for *_,hu in parts]
 return max(values) if mode=='MIP' else min(values) if mode=='MinIP' else sum((s1-s0)*hu for s0,s1,hu in parts)/sum(s1-s0 for s0,s1,_ in parts)
def zero_fill_hu(segments,interval,mode):
 full=segments[-1][1]-segments[0][0]
 if interval is None:return 0
 parts=clipped_parts(segments,interval);inside,excluded=project_hu(parts,mode),full-(interval[1]-interval[0])
 if mode=='Raysum':return inside*(interval[1]-interval[0])/full
 return (max(inside,0) if mode=='MIP' else min(inside,0)) if excluded>1e-9 else inside
def gray(hu,voi):return min(255.,max(0.,level(hu,voi)))
def voi_margins(point,axis,record,interval,bounds):
 plane=[b for b in range(3) if b!=axis]
 for b in plane:
  if min(abs(point[b]-e) for e in value_edges(b)+[0,(COUNTS[b]-1)*SPACING[b]])<2*SPACING[b]:return False
 # A VOI edge is a continuous plane, so its position on a probe's ray moves with the probe's own position (a canvas pixel,
 # well under 0.5 mm), not with voxelization: allow a shift of two 0.5 mm voxels on every in-plane axis.
 n=record['normal'];lateral=sum(2*min(SPACING)*abs(n[b]) for b in plane)
 if bounds is None:
  d0=sum(((0 if b==axis else point[b])-record['center'][b])*n[b] for b in range(3))
  return abs(abs(d0)-record['thickness']/2)>=lateral
 lo,hi,travel=0,(COUNTS[axis]-1)*SPACING[axis],lateral/abs(n[axis])
 if interval is None:return bounds[1]<=lo-3*STEP-travel or bounds[0]>=hi+3*STEP+travel
 if interval[1]-interval[0]<6*STEP+2*travel:return False
 for end in bounds:
  if lo-3*STEP-travel<end<hi+3*STEP+travel and min(abs(end-e) for e in value_edges(axis)+[lo,hi])<3*STEP+travel:return False
 return True
def voi_probe(point,orientation,mode,record,intercept,voi):
 axis=RAY[orientation];interval,bounds=kept_segment(point,axis,record)
 if not voi_margins(point,axis,record,interval,bounds):return None
 segments=ray_segments(point,axis,intercept)
 # The unclipped mean is taken over both voxel-centre and voxel-edge ray extents, since either may bound the full ray.
 unclipped=[gray(project_hu(ray_segments(point,axis,intercept,extend),mode),voi) for extend in (0,SPACING[axis]/2)]
 zero=gray(zero_fill_hu(segments,interval,mode),voi)
 if interval is None:expected,kind,bound=0.,'empty',0.
 else:
  parts=clipped_parts(segments,interval);hu=project_hu(parts,mode);expected,kind=gray(hu,voi),'kept'
  if not VOI_DELTA+1<=expected<=255-VOI_DELTA-1:return None
  bound=0.
  if mode=='Raysum':
   length=sum(s1-s0 for s0,s1,_ in parts);jumps=sum(abs(q[2]-p[2]) for p,q in zip(parts,parts[1:]))
   bound=STEP*(jumps+abs(parts[0][2]-hu)+abs(parts[-1][2]-hu))/length*255/(voi[1]-voi[0])
   if bound>VOI_MEAN_BOUND:return None
 separation=min([abs(expected-u) for u in unclipped]+[abs(expected-zero)])
 if separation<VOI_DISCRIMINATION:return None
 return {'world':[round(x,6) for x in point],'kind':kind,'expected':round(expected,3),'unclipped':[round(u,3) for u in unclipped],'zero_fill':round(zero,3),'separation':round(separation,3),'mean_bound':round(bound,3)}
def voi_probes(record,orientation,mode,intercept,voi):
 # Best-separated kept-segment probe and best empty-ray probe on a two-voxel grid; deterministic ties by position.
 axis=RAY[orientation];plane=[b for b in range(3) if b!=axis];middle=(COUNTS[axis]-1)*SPACING[axis]/2;chosen=[]
 grid=[[i*SPACING[b] for i in range(2,COUNTS[b]-2)] for b in plane];found={'kept':[],'empty':[]}
 for p in grid[0]:
  for q in grid[1]:
   point=[0,0,0];point[axis],point[plane[0]],point[plane[1]]=middle,p,q
   probe=voi_probe(point,orientation,mode,record,intercept,voi)
   if probe:found[probe['kind']].append(probe)
 for kind in ('kept','empty'):
  if found[kind]:chosen.append(min(found[kind],key=lambda probe:(-probe['separation'],probe['world'])))
 return chosen
def voi_plan():
 return {(study,case['name'],orientation,mode):voi_probes(voi_record(case),orientation,mode,intercept,voi)
         for study,intercept,voi in VOI_STUDIES for case in VOI_CASES for orientation in ORIENTATIONS for mode in MODES}
def voi_coverage_problems(plan):
 # The oracle itself must reach every clipping geometry, projection and plane before any pixel is trusted.
 has=lambda kind,**match:any(p['kind']==kind for key,probes in plan.items() for p in probes if all(key[('study','case','orientation','mode').index(k)]==v for k,v in match.items()))
 problems=[]
 for orientation in ORIENTATIONS:
  for mode in MODES:
   if not has('kept',orientation=orientation,mode=mode):problems.append('no kept-segment probe '+orientation+' '+mode)
   if not has('empty',orientation=orientation,mode=mode):problems.append('no empty-ray probe '+orientation+' '+mode)
 for mode in MODES:
  if not (has('kept',case='along-ray',orientation='Axial',mode=mode) or has('kept',case='perpendicular',orientation='Sagittal',mode=mode)):problems.append('no along-ray probe '+mode)
  for orientation in ORIENTATIONS:
   if not has('kept',case='oblique',orientation=orientation,mode=mode):problems.append('no oblique probe '+orientation+' '+mode)
  for case,orientation in (('along-ray','Coronal'),('along-ray','Sagittal'),('perpendicular','Axial'),('perpendicular','Coronal')):
   if not has('empty',case=case,orientation=orientation,mode=mode):problems.append('no perpendicular empty ray '+case+' '+orientation+' '+mode)
 for study,modes in (('positive',('MinIP','Raysum')),('negative',('MIP','Raysum'))):
  problems+=['no zero-fill probe '+study+' '+mode for mode in modes if not has('kept',study=study,mode=mode)]
 uncovered={key[1:] for key in plan if not any(plan[other] for other in plan if other[1:]==key[1:])}
 if uncovered!=VOI_UNDISCRIMINATING:problems.append('undiscriminating cells '+repr(sorted(uncovered)))
 return problems

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

 # A11-VOI-1 display-only VOI Slab. Helpers wait for the first Final after an action's pending render (the requested display
 # or, after a failure, the kept one) so a wrong display fails an assertion rather than a timeout. A refused request re-shows
 # the confirmed state by rewriting the same data-kin-mip-state value, which a MutationObserver still reports, so
 # mipTransitions records changes of that state only.
 def opened_voi_study(self,intercept,voi):
  with patch.object(projection,'phantom',side_effect=lambda stack,value,constant,**sample:mip_phantom(stack,value)):
   a,p,v=self.opened_projection(intercept=intercept)
  v.evaluate("""([lower,upper])=>{for(const id of services.viewportGridService.getState().viewports.keys()){const vp=services.cornerstoneViewportService.getCornerstoneViewport(id);vp.setProperties({voiRange:{lower,upper},VOILUTFunction:'LINEAR',interpolationType:0,invert:false});vp.render()}}""",list(voi))
  v.evaluate(HELPERS);v.evaluate(SETTLE);return a,p,v
 def open_voi(self,v):
  dialog=self.open_mip(v);v.evaluate(VOI_HELPERS);return dialog
 def mark(self,v):return v.evaluate('()=>mipTransitions.length')
 def settled(self,v,mark,probes=()):
  v.wait_for_function("m=>{const t=mipTransitions.slice(m);return t.includes('pending')&&t.at(-1)==='final'}",arg=mark,timeout=40000)
  v.evaluate(SETTLE);return v.evaluate('p=>mipVoiState(p)',[list(w) for w in probes])
 def unchanged(self,v,mark):v.wait_for_timeout(400);self.assertEqual(v.evaluate('m=>mipTransitions.slice(m)',mark),[])
 def voi_field(self,dialog,name):return dialog.get_by_label('VOI Slab '+name,exact=True)
 def voi_button(self,dialog,name):return dialog.get_by_role('button',name=name,exact=True)
 def enter_voi(self,dialog,case):
  self.voi_field(dialog,'Preset').select_option(case['preset'])
  for prefix,values in (('Center',case['center']),('Pivot',case['pivot'])):
   for axis,value in zip('LPS',values):self.voi_field(dialog,prefix+' '+axis).fill(repr(float(value)))
  self.voi_field(dialog,'Thickness').fill(repr(float(case['thickness'])));self.voi_field(dialog,'Enable').check()
 def apply_voi_case(self,v,dialog,case):
  self.enter_voi(dialog,case);mark=self.mark(v);steps=bool(case['rotations'] or case['move'])
  # Rotate and Move each request a display; renders are held until the last so only that record is confirmed.
  if steps:v.evaluate('()=>{mipHold=true}')
  if not steps:self.voi_button(dialog,'Apply VOI Slab').click()
  for axis,degrees in case['rotations']:
   self.voi_field(dialog,'Rotate Axis').select_option(axis);self.voi_field(dialog,'Rotate Degrees').fill(str(degrees));self.voi_button(dialog,'Rotate Slab').click()
  if case['move']:self.voi_field(dialog,'Move').fill(str(case['move']));self.voi_button(dialog,'Move Slab').click()
  if steps:v.evaluate('()=>{mipHold=false;mipView().render()}')
  return mark
 def voi_native(self,state,mode,orientation,record,voi,original=False):
  cam,shown=state['camera'][orientation.lower()],None if original else record
  self.assertEqual(state['state'],'final',state['status']);self.assertEqual([state['mode'],state['orientation'],state['blend']],[mode,orientation,BLENDS[mode]])
  np.testing.assert_allclose(state['normal'],cam['viewPlaneNormal'],atol=1e-6,rtol=0);np.testing.assert_allclose(state['up'],cam['viewUp'],atol=1e-6,rtol=0)
  self.assertEqual(len(state['planes']),4 if shown else 2,state['planes'])
  for _,normal in state['planes'][:2]:self.assertAlmostEqual(abs(float(np.dot(normal,cam['viewPlaneNormal']))),1,delta=1e-6)
  self.assertAlmostEqual(math.dist(state['planes'][0][0],state['planes'][1][0]),TOTAL,delta=1e-6)
  for (origin,normal),(want_origin,want_normal) in zip(state['planes'][2:],voi_planes(shown) if shown else []):
   np.testing.assert_allclose(origin,want_origin,atol=1e-6,rtol=0);np.testing.assert_allclose(normal,want_normal,atol=1e-6,rtol=0)
  self.assertAlmostEqual(state['voiRange']['lower'],voi[0],delta=1e-6);self.assertAlmostEqual(state['voiRange']['upper'],voi[1],delta=1e-6)
  suffix=' · Original' if original else ' · '+voi_label(record) if record else ''
  self.assertEqual(state['label'],mode+' · '+orientation+' · '+mm_text(TOTAL)+' mm'+suffix+' · Final')
 def voi_pixels(self,state,probes,label,expected='expected'):
  self.assertEqual(len(state['pixels']),len(probes))
  for probe,actual in zip(probes,state['pixels']):
   self.assertGreaterEqual(probe['separation'],VOI_DISCRIMINATION,probe)
   wanted=[probe['expected']] if expected=='expected' else probe['unclipped']
   self.assertLessEqual(min(abs(actual-w) for w in wanted),VOI_DELTA,(label,expected,probe,actual))

 def test_mip_04_voi_slab_known_voxels_modes_orientations(self):
  plan=voi_plan();self.assertEqual(voi_coverage_problems(plan),[])
  records={case['name']:voi_record(case) for case in VOI_CASES};evidence={}
  for study,intercept,voi in VOI_STUDIES:
   a,p,v=self.opened_voi_study(intercept,voi);original=self.originals();before=self.volume_state(v);source=v.evaluate(SOURCE_PLANES)
   dialog=self.open_voi(v);current=('MIP','Axial')
   for case in VOI_CASES:
    record=records[case['name']];self.voi_native(self.settled(v,self.apply_voi_case(v,dialog,case)),*current,record,voi)
    for orientation in ORIENTATIONS:
     for mode in MODES:
      probes=plan[(study,case['name'],orientation,mode)];worlds=[probe['world'] for probe in probes]
      if (mode,orientation)==current:state=v.evaluate('p=>mipVoiState(p)',worlds)
      else:mark=self.mark(v);self.choose_mip(dialog,mode,orientation);state=self.settled(v,mark,worlds);current=(mode,orientation)
      # Pixels first, so a wrong sample set fails the known-voxel oracle itself; then every switch is read back:
      # the same world VOI planes, the slab planes and the untouched W/L window.
      self.voi_pixels(state,probes,(study,case['name'],orientation,mode,state['label']));self.voi_native(state,mode,orientation,record,voi)
      evidence['/'.join((study,case['name'],orientation,mode))]=[dict(probe,actual=actual) for probe,actual in zip(probes,state['pixels'])]
    self.assertEqual(v.evaluate(SOURCE_PLANES),source)
   self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible();self.assertEqual(v.evaluate('()=>mipCount()'),0)
   self.preserved_volume(before,self.volume_state(v));self.assertEqual(v.evaluate(SOURCE_PLANES),source);self.assertEqual(self.originals(),original);self.assertEqual(self.jobs(a),[])
  print('MIP_VOI_PIXELS',json.dumps(evidence),flush=True)

 def test_mip_05_voi_order_delay_failure_missing_tool_cancel(self):
  study,intercept,voi=VOI_STUDIES[0];plan=voi_plan();along,perpendicular,_=VOI_CASES;rA,rB=voi_record(along),voi_record(perpendicular)
  a,p,v=self.opened_voi_study(intercept,voi);original=self.originals();before=self.volume_state(v);source=v.evaluate(SOURCE_PLANES)
  # A missing VOI tool disables only the VOI Slab with a notice; Projection and Orientation still reach Final.
  v.route('**/volume-voi.js',lambda route:route.abort());dialog=self.open_voi(v);status=dialog.locator('[role=status]')
  expect(self.voi_button(dialog,'Apply VOI Slab')).to_be_disabled();expect(dialog.locator('.kin-mip-voi-note')).to_contain_text('VOI Slab 도구를 확인할 수 없어')
  mark=self.mark(v);self.choose_mip(dialog,'MinIP','Coronal');self.voi_native(self.settled(v,mark),'MinIP','Coronal',None,voi)
  self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible();v.unroute('**/volume-voi.js')
  dialog=self.open_voi(v);expect(self.voi_button(dialog,'Apply VOI Slab')).to_be_enabled();expect(dialog.locator('.kin-mip-voi-note')).to_have_text('');expect(dialog.locator('.kin-mip-voi-state')).to_have_text('VOI Slab · Off · Not Saved')
  # Empty history, invalid input and an incomplete tool only explain; nothing reaches the native viewer.
  mark=self.mark(v);self.voi_button(dialog,'Undo VOI').click();expect(status).to_contain_text('되돌릴 VOI Slab 변경이 없습니다')
  self.enter_voi(dialog,along);self.voi_field(dialog,'Thickness').fill('-5');self.voi_button(dialog,'Apply VOI Slab').click();expect(status).to_contain_text('Thickness는 0보다 큰')
  self.voi_field(dialog,'Center S').fill('');self.voi_button(dialog,'Apply VOI Slab').click();expect(status).to_contain_text('Center S 값을 숫자로 입력하세요')
  self.enter_voi(dialog,along);self.voi_field(dialog,'Rotate Degrees').fill('200');self.voi_button(dialog,'Rotate Slab').click();expect(status).to_contain_text('-180~180')
  v.evaluate('()=>{window.heldVoi=window.KinVolumeVoi;window.KinVolumeVoi={...heldVoi,move:undefined}}');self.voi_field(dialog,'Move').fill('2');self.voi_button(dialog,'Move Slab').click()
  expect(status).to_contain_text('VOI Slab 도구를 확인할 수 없어');v.evaluate('()=>{window.KinVolumeVoi=heldVoi}')
  self.unchanged(v,mark);self.voi_native(v.evaluate('p=>mipVoiState(p)',[]),'MIP','Axial',None,voi)
  # A held VOI render stays Rendering; a newer mode and Undo supersede it and only the newest display is announced.
  self.enter_voi(dialog,along);v.evaluate('()=>{mipHold=true;mipHeldFrames=0}');mark=self.mark(v);statuses=v.evaluate('()=>mipStatuses.length')
  self.voi_button(dialog,'Apply VOI Slab').click();v.wait_for_function('()=>mipHeldFrames>0')
  expect(dialog).to_have_attribute('data-kin-mip-state','pending');expect(dialog.locator('.kin-mip-label')).to_have_text('Rendering · 최종 표시 전');expect(dialog.locator('.kin-mip-voi-state')).to_have_text('VOI Slab · Rendering · Not Saved')
  self.choose_mip(dialog,'MinIP');self.voi_button(dialog,'Undo VOI').click();v.wait_for_timeout(300);expect(dialog).to_have_attribute('data-kin-mip-state','pending')
  v.evaluate('()=>{mipHold=false;mipView().render()}');self.voi_native(self.settled(v,mark),'MinIP','Axial',None,voi)
  announced=[s for s in v.evaluate('n=>mipStatuses.slice(n)',statuses) if '최종 표시를 확인했습니다' in s];self.assertEqual(announced,['MinIP · Axial · '+mm_text(TOTAL)+' mm 최종 표시를 확인했습니다.'])
  # Input order: VOI then plane, and plane then VOI, reach the same planes, label and pixels.
  cell=plan[(study,'along-ray','Coronal','MinIP')];worlds=[probe['world'] for probe in cell];self.assertTrue(cell)
  self.enter_voi(dialog,along);mark=self.mark(v);self.voi_button(dialog,'Apply VOI Slab').click();self.choose_mip(dialog,orientation='Coronal');first=self.settled(v,mark,worlds)
  self.voi_native(first,'MinIP','Coronal',rA,voi);self.voi_pixels(first,cell,'VOI then Coronal')
  mark=self.mark(v);self.voi_button(dialog,'Reset VOI').click();self.choose_mip(dialog,orientation='Axial');self.voi_native(self.settled(v,mark),'MinIP','Axial',None,voi)
  mark=self.mark(v);self.choose_mip(dialog,orientation='Coronal');self.enter_voi(dialog,along);self.voi_button(dialog,'Apply VOI Slab').click();second=self.settled(v,mark,worlds)
  self.voi_native(second,'MinIP','Coronal',rA,voi);self.assertEqual({k:first[k] for k in ('planes','label','pixels')},{k:second[k] for k in ('planes','label','pixels')})
  kept_label='이전 표시(MinIP · Coronal · '+mm_text(TOTAL)+' mm · '+voi_label(rA)+')'
  def kept(mark,message):
   state=self.settled(v,mark,worlds);expect(status).to_contain_text(message);expect(status).to_contain_text(kept_label)
   self.voi_native(state,'MinIP','Coronal',rA,voi);self.assertEqual(state['pixels'],second['pixels'],message)
  # vtk.js freezes its objects, so a method assigned onto the mapper or a render window is silently ignored and the change
  # simply succeeds. Faults go where the viewer reads through a changeable object (the VOI plane factory, the viewport actor
  # lookup, the rendering engine's window slot); each proves it is installed and that it fired exactly once, inside the
  # product step it targets, with the VOI planes then on the mapper.
  def attempt(injection,message,frame=None,planes=None,action=None):
   self.assertTrue(v.evaluate(injection),'fault not installed: '+message);self.enter_voi(dialog,perpendicular);mark=self.mark(v);(action or self.voi_button(dialog,'Apply VOI Slab').click)();kept(mark,message)
   if frame:self.assertEqual(v.evaluate('f=>mipFault.map(t=>[t.stack.includes(f),t.planes])',frame),[[True,planes]],message)
  # Plane write, VOI readback, GPU program and Raysum capability failures keep the last Final including its VOI Slab.
  # The plane write fails on the second new plane: the old VOI planes are removed and one new plane is already on the mapper.
  attempt("""()=>{"use strict";const model=window.KinVolumeMip,real=model.voiPlane,count=()=>mipView().getActors()[0].actor.getMapper().getClippingPlanes().length;let made=0;window.mipFault=[];
 model.voiPlane=function(definition){const stack=mipTrace();if(!stack.includes('writeVoi')||++made<2)return real(definition);model.voiPlane=real;mipFault.push({stack,planes:count()});throw Error('INJECTED VOI PLANE WRITE')};return model.voiPlane!==real}""",'INJECTED VOI PLANE WRITE','writeVoi',3)
  attempt("""()=>{"use strict";const vp=mipView(),own=Object.getOwnPropertyDescriptor(vp,'getActors'),real=vp.getActors;window.mipFault=[];
 vp.getActors=function(...args){const actors=real.apply(this,args),stack=mipTrace();if(!stack.includes('readState'))return actors;if(own)Object.defineProperty(vp,'getActors',own);else delete vp.getActors;
  const mapper=actors[0].actor.getMapper(),planes=mapper.getClippingPlanes(),shifted=planes.map((p,i)=>i<2?p:{getOrigin:()=>{const o=Array.from(p.getOrigin());o[0]+=.01;return o},getNormal:()=>p.getNormal()});
  mipFault.push({stack,planes:planes.length});return [{...actors[0],actor:{...actors[0].actor,getMapper:()=>({...mapper,getClippingPlanes:()=>shifted})}},...actors.slice(1)]};return vp.getActors!==real}""",'VOI Slab 평면을 확인하지 못했습니다','readState',4)
  # Only the link status is false; the real program's compile status and fragment source are read through.
  attempt("""()=>{"use strict";const engine=mipView().getRenderingEngine(),key='offscreenMultiRenderWindow',own=Object.getOwnPropertyDescriptor(engine,key);let real=engine[key];window.mipFault=[];
 const restore=()=>{if(!own)delete engine[key];else Object.defineProperty(engine,key,'value' in own?{...own,value:real}:own)};
 const unlinked={getOpenGLRenderWindow:(...a)=>{const gl=real.getOpenGLRenderWindow(...a);return {getViewNodeFor:(...b)=>{const node=gl.getViewNodeFor(...b);return {get:(...c)=>{const program=node.get(...c).tris.getProgram();return {tris:{getProgram:()=>({getCompiled:()=>program.getCompiled(),getLinked:()=>false,getFragmentShader:()=>program.getFragmentShader()})}}}}}}}};
 Object.defineProperty(engine,key,{configurable:true,enumerable:own?own.enumerable:false,get(){const stack=mipTrace();if(!stack.includes('gpuProblem'))return real;restore();mipFault.push({stack,planes:mipView().getActors()[0].actor.getMapper().getClippingPlanes().length});return unlinked},set(value){real=value}});
 return !!real&&typeof Object.getOwnPropertyDescriptor(engine,key).get==='function'}""",'투영 셰이더를 GPU에서 확인하지 못했습니다','gpuProblem',4)
  attempt('()=>{window.heldAverage=window.kinPrepareVolumeAverage;window.kinPrepareVolumeAverage=undefined;return typeof heldAverage==="function"&&window.kinPrepareVolumeAverage===undefined}','Raysum 평균 계산 모듈',action=lambda:self.choose_mip(dialog,'Raysum'))
  v.evaluate('()=>{window.kinPrepareVolumeAverage=heldAverage}')
  # Modal, job and preview gates refuse a VOI change without touching the display.
  for block,release,message in VOI_GATES:
   v.evaluate(block);self.enter_voi(dialog,perpendicular);mark=self.mark(v);self.voi_button(dialog,'Apply VOI Slab').click();expect(status).to_contain_text(message);self.unchanged(v,mark)
   state=v.evaluate('p=>mipVoiState(p)',worlds);self.voi_native(state,'MinIP','Coronal',rA,voi);self.assertEqual(state['pixels'],second['pixels']);v.evaluate(release)
  # Original during a pending VOI change wins; turning it off shows that record, and Undo returns to the previous one.
  self.enter_voi(dialog,perpendicular);v.evaluate('()=>{mipHold=true;mipHeldFrames=0}');mark=self.mark(v);self.voi_button(dialog,'Apply VOI Slab').click();v.wait_for_function('()=>mipHeldFrames>0')
  self.voi_field(dialog,'Original').check();v.evaluate('()=>{mipHold=false;mipView().render()}');self.voi_native(self.settled(v,mark),'MinIP','Coronal',rB,voi,original=True)
  mark=self.mark(v);self.voi_field(dialog,'Original').uncheck();self.voi_native(self.settled(v,mark),'MinIP','Coronal',rB,voi)
  mark=self.mark(v);self.voi_button(dialog,'Undo VOI').click();state=self.settled(v,mark,worlds);self.voi_native(state,'MinIP','Coronal',rA,voi);self.assertEqual(state['pixels'],second['pixels'])
  # A final render that never confirms times out after 15 s and returns to the last Final.
  v.evaluate("""()=>{mipHold=true;mipHeldFrames=0;const s=document.querySelector('#kin-volume-mip [role=status]'),o=new MutationObserver(()=>{if(s.textContent.includes('최종 렌더를 확인하지 못했습니다')){mipHold=false;o.disconnect()}});o.observe(s,{childList:true,characterData:true,subtree:true})}""")
  self.enter_voi(dialog,perpendicular);mark=self.mark(v);self.voi_button(dialog,'Apply VOI Slab').click();v.wait_for_function('()=>mipHeldFrames>0');expect(dialog).to_have_attribute('data-kin-mip-state','pending');kept(mark,'최종 렌더를 확인하지 못했습니다')
  # Close and Escape while a VOI render is pending cancel it: no Final, the viewport is released, MPR is unchanged.
  for how in ('close','escape'):
   v.evaluate('()=>{mipHold=true;mipHeldFrames=0}');self.enter_voi(dialog,perpendicular);mark=self.mark(v);self.voi_button(dialog,'Apply VOI Slab').click();v.wait_for_function('()=>mipHeldFrames>0')
   if how=='close':self.voi_button(dialog,'Close MIP Viewer').click()
   else:self.voi_field(dialog,'Thickness').focus();v.keyboard.press('Escape')
   expect(dialog).not_to_be_visible();self.assertEqual(v.evaluate('()=>mipCount()'),0);v.evaluate('()=>{mipHold=false}');v.wait_for_timeout(300)
   self.assertNotIn('final',v.evaluate('m=>mipTransitions.slice(m)',mark))
   if how=='close':dialog=self.open_voi(v);expect(dialog.locator('.kin-mip-voi-state')).to_have_text('VOI Slab · Off · Not Saved')
  self.preserved_volume(before,self.volume_state(v));self.assertEqual(v.evaluate(SOURCE_PLANES),source);self.assertEqual(self.originals(),original);self.assertEqual(self.jobs(a),[])

 def test_mip_06_voi_original_undo_reset_scope_lifecycle(self):
  study,intercept,voi=VOI_STUDIES[1];plan=voi_plan();_,perpendicular,oblique=VOI_CASES;rB,rC=voi_record(perpendicular),voi_record(oblique)
  a,p,v=self.opened_voi_study(intercept,voi);original=self.originals();before=self.volume_state(v);source=v.evaluate(SOURCE_PLANES)
  writes=[];v.on('request',lambda r:writes.append(r.method+' '+r.url) if r.method in ('POST','PUT','PATCH','DELETE') and '/viewer-jobs' in r.url else None)
  dialog=self.open_voi(v);status,summary=dialog.locator('[role=status]'),dialog.locator('.kin-mip-voi-state')
  # A11-VOI-2 replaced the "not saved in a Job" sentence: a VOI Slab is saved only by Save MIP Job, and unsaved changes close with the window.
  for text in ('이 MIP Viewer 화면에만 적용','Save MIP Job으로 저장할 때만','저장하지 않고 창을 닫으면 사라집니다','원본 DICOM과 밝기 범위(W/L)는 바뀌지 않습니다','0 HU가 아니라 배경'):expect(dialog.locator('.kin-mip-voi-scope')).to_contain_text(text)
  expect(summary).to_have_text('VOI Slab · Off · Not Saved');expect(dialog).to_contain_text('조작성 평가 가능·진단 품질 미검증')
  cell=plan[(study,'perpendicular','Axial','MIP')];worlds=[probe['world'] for probe in cell];self.assertTrue(cell)
  clipped=self.settled(v,self.apply_voi_case(v,dialog,perpendicular),worlds);self.voi_native(clipped,'MIP','Axial',rB,voi);self.voi_pixels(clipped,cell,'VOI Slab')
  expect(summary).to_have_text('VOI Slab · On · '+mm_text(rB['thickness'])+' mm · Not Saved')
  # Original shows the unclipped Final without dropping the record; VOI edits wait until it is turned off.
  mark=self.mark(v);self.voi_field(dialog,'Original').check();shown=self.settled(v,mark,worlds)
  self.voi_native(shown,'MIP','Axial',rB,voi,original=True);self.voi_pixels(shown,cell,'Original','unclipped');expect(summary).to_have_text('VOI Slab · Original View · Not Saved')
  mark=self.mark(v);self.voi_button(dialog,'Reset VOI').click();expect(status).to_contain_text('Original 보기를 끈 뒤 VOI Slab');self.voi_button(dialog,'Undo VOI').click();expect(status).to_contain_text('Original 보기를 끈 뒤 Undo');self.unchanged(v,mark)
  mark=self.mark(v);self.voi_field(dialog,'Original').uncheck();back=self.settled(v,mark,worlds);self.voi_native(back,'MIP','Axial',rB,voi)
  self.assertEqual([back['planes'],back['pixels']],[clipped['planes'],clipped['pixels']])
  # Undo returns through confirmed records only; Reset is itself undoable.
  oblique_cell=plan[(study,'oblique','Axial','MIP')];self.assertTrue(oblique_cell)
  state=self.settled(v,self.apply_voi_case(v,dialog,oblique),[probe['world'] for probe in oblique_cell]);self.voi_native(state,'MIP','Axial',rC,voi);self.voi_pixels(state,oblique_cell,'oblique')
  for action,record in (('Undo VOI',rB),('Reset VOI',None),('Undo VOI',rB),('Undo VOI',None)):
   mark=self.mark(v);self.voi_button(dialog,action).click();state=self.settled(v,mark,worlds);self.voi_native(state,'MIP','Axial',record,voi)
   if record:self.assertEqual(state['pixels'],clipped['pixels'],action)
   else:self.voi_pixels(state,cell,action,'unclipped');expect(summary).to_have_text('VOI Slab · Off · Not Saved')
  mark=self.mark(v);self.voi_button(dialog,'Undo VOI').click();expect(status).to_contain_text('되돌릴 VOI Slab 변경이 없습니다');self.unchanged(v,mark)
  # Not saved: closing and reopening shows no VOI Slab, and no Job write was sent.
  self.settled(v,self.apply_voi_case(v,dialog,perpendicular),worlds)
  self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible();self.assertEqual(v.evaluate('()=>mipCount()'),0)
  dialog=self.open_voi(v);self.voi_native(v.evaluate('p=>mipVoiState(p)',[]),'MIP','Axial',None,voi);expect(summary).to_have_text('VOI Slab · Off · Not Saved')
  expect(self.voi_field(dialog,'Center S')).to_have_value('40');expect(self.voi_field(dialog,'Enable')).not_to_be_checked();expect(self.voi_field(dialog,'Original')).not_to_be_checked()
  self.assertEqual(writes,[]);self.assertEqual(self.jobs(a),[]);self.assertEqual(len(self.versions(a)),1)
  self.preserved_volume(before,self.volume_state(v));self.assertEqual(v.evaluate(SOURCE_PLANES),source);self.assertEqual(self.originals(),original)
  # A source replacement or session end with a VOI Slab applied closes the viewer and releases its viewport.
  self.settled(v,self.apply_voi_case(v,dialog,perpendicular),worlds)
  v.evaluate("()=>{window.mipSource=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);window.mipVolumeId=mipSource.getVolumeId;mipSource.getVolumeId=()=>'replaced-volume'}")
  expect(dialog).not_to_be_visible();expect(v.locator('#kin-volume-orientation [role=status]')).to_contain_text('MIP Viewer를 닫았습니다');self.assertEqual(v.evaluate('()=>mipCount()'),0);v.evaluate('()=>{mipSource.getVolumeId=mipVolumeId}')
  dialog=self.open_voi(v);expect(summary).to_have_text('VOI Slab · Off · Not Saved');self.settled(v,self.apply_voi_case(v,dialog,perpendicular),worlds)
  v.evaluate("()=>window.dispatchEvent(new StorageEvent('storage',{key:'kin-session-ended',newValue:String(Date.now())}))")
  expect(v.locator('#kin-volume-mip[open]')).to_have_count(0);self.assertEqual(v.evaluate('()=>mipCount()'),0);self.assertEqual(self.originals(),original);self.assertEqual(writes,[])

# The VOI Slab cases run once, in their own volume-mip-voi profile through test_volume_mip_voi.py, so the ci-slab-mip-viewer
# cap keeps bounding only the three MIP Viewer cases it was sized for.
VOI_SLAB_CASES=('test_mip_04_voi_slab_known_voxels_modes_orientations','test_mip_05_voi_order_delay_failure_missing_tool_cancel',
                'test_mip_06_voi_original_undo_reset_scope_lifecycle')
def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeMipE2E(n) for n in loader.getTestCaseNames(VolumeMipE2E) if n.startswith('test_mip_') and n not in VOI_SLAB_CASES)
if __name__=='__main__':unittest.main(verbosity=2)
