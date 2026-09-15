# coding: utf-8
"""TEST-MIP-BATCH-DOM (A11-BATCH-1): MIP Viewer Batch, a rotation series of the confirmed MIP display with its nullable VOI Slab and
orientation, saved beside the three-plane MPR as version 13 and reopened all-or-nothing in a new login."""
import copy,io,json,math,time,unittest,uuid
import numpy as np
from playwright.sync_api import expect
import test_prior_selection as ct
from test_volume_mip import HELPERS,SETTLE,VOI_HELPERS,VOI_STUDIES,VOI_CASES,VOI_DELTA,VOI_DISCRIMINATION,SOURCE_PLANES,BLENDS,CENTER,SPACING,TOTAL,mm_text,rodrigues,voi_plan,voi_planes,voi_record
from test_volume_mip_job import CAPTURE,READ_ONLY_CAPTURE,LAYOUT,JOB,JOBS,SESSION_END,GPU_FAULT,VolumeMipJobE2E,json_keys
from test_volume_path import field_differences,job_post

# scripts/run-tests.py accepts only cases whose class is declared in the selected module; load_tests selects exactly these, so the
# inherited MIP Viewer, VOI Slab, MIP Job, projection and orientation cases stay out of this bounded profile.
MIP_BATCH_CASES=('test_mip_batch_01_rotation_voi_frames_save_restore_new_browser',
                 'test_mip_batch_02_gates_cancel_failure_order_v12_compat',
                 'test_mip_batch_03_restore_failure_missing_tool_cancel_stale_rollback')
SIZE=512
RECIPE_KEYS=['algorithm','axis','count','interval','reverse','schema']
READ_REFUSED='()=>{try{'+JOB+'.capture(true);return null}catch(error){return error.message}}'
FINAL_CAMERA="()=>{const c=mipView().getCamera();return {focalPoint:[...c.focalPoint],position:[...c.position],viewPlaneNormal:[...c.viewPlaneNormal],viewUp:[...c.viewUp],parallelScale:c.parallelScale}}"
# Installed once per page, before or after the MIP Viewer modules load (a fresh page loads them lazily inside the restore):
# - KinVolumeMip.verifyState is traced only from the batch frame stack, with the private viewport's camera read in that same event;
# - the Jobs status and the MIP status are recorded in one ordered list with the dialog state, VOI summary and batch caption;
# - a batch frame's rendered event is held while the MIP status names that frame, so the frame never confirms.
BATCH_HELPERS="""()=>{if(window.batchReady)return true;window.batchReady=true;
 window.batchTrace=()=>{const limit=Error.stackTraceLimit;Error.stackTraceLimit=40;const stack=new Error().stack;Error.stackTraceLimit=limit;return stack};
 window.batchFrames=[];window.batchStatuses=[];window.batchHoldFrame=null;window.batchHeld=0;
 window.batchView=()=>{const engines=cornerstone.getRenderingEngines?.()||[];for(const engine of engines)for(const vp of engine.getViewports())if(vp.id.startsWith('kin-mipbatch-'))return vp;return null};
 const copy=v=>Array.from(v||[]);
 const wrap=model=>{if(!model||model.__kinBatchTrace)return;const real=model.verifyState;model.__kinBatchTrace=real;
  model.verifyState=function(state,expected){const problem=real.call(this,state,expected);
   if(batchTrace().includes('verifyBatchFrame')){const vp=batchView(),cam=vp?.getCamera(),canvas=vp?.getCanvas();
    batchFrames.push({problem,id:vp?.id||'',canvas:canvas?[canvas.width,canvas.height]:null,
     state:{blend:state.blend,viewPlaneNormal:copy(state.viewPlaneNormal),viewUp:copy(state.viewUp),planes:(state.planes||[]).map(p=>[copy(p.origin),copy(p.normal)]),sampleDistance:state.sampleDistance,interpolationType:state.interpolationType,voiRange:{lower:state.voiRange?.lower,upper:state.voiRange?.upper}},
     expected:{viewPlaneNormal:copy(expected.viewPlaneNormal),viewUp:copy(expected.viewUp),voiSlab:!!expected.voiSlab},
     camera:cam&&{focalPoint:copy(cam.focalPoint),position:copy(cam.position),viewPlaneNormal:copy(cam.viewPlaneNormal),viewUp:copy(cam.viewUp),parallelScale:cam.parallelScale}})}
   return problem}};
 if(window.KinVolumeMip)wrap(window.KinVolumeMip);
 else{let held;Object.defineProperty(window,'KinVolumeMip',{configurable:true,enumerable:true,get:()=>held,set:value=>{wrap(value);held=value}})}
 const jobs=document.querySelector('#kin-viewer-jobs-status');
 const record=source=>{const d=document.querySelector('#kin-volume-mip'),s=d?.querySelector('[role=status]'),img=d?.querySelector('.kin-mip-batch img');
  batchStatuses.push({source,at:performance.now(),text:source==='jobs'?jobs?.textContent||'':s?.textContent||'',state:d?.open?d.dataset.kinMipState:'closed',voi:d?.querySelector('.kin-mip-voi-state')?.textContent||'',frame:d?.querySelector('.kin-mip-batch-frame')?.textContent||'',image:!!img?.getAttribute('src')})};
 if(jobs)new MutationObserver(()=>record('jobs')).observe(jobs,{childList:true,characterData:true,subtree:true});
 const watch=()=>{const d=document.querySelector('#kin-volume-mip');if(!d||d.__kinBatchWatch)return;d.__kinBatchWatch=true;new MutationObserver(()=>record('mip')).observe(d.querySelector('[role=status]'),{childList:true,characterData:true,subtree:true})};
 watch();new MutationObserver(watch).observe(document.body,{childList:true});
 document.addEventListener(cornerstone.Enums.Events.IMAGE_RENDERED,e=>{if(batchHoldFrame===null||!e.target?.dataset?.kinMipBatchRender)return;
  const s=document.querySelector('#kin-volume-mip [role=status]')?.textContent||'';
  if(s.startsWith('MIP Batch 생성 중 '+batchHoldFrame+' / ')||s.startsWith('MIP Batch 복원 중 '+batchHoldFrame+' / ')){e.stopImmediatePropagation();batchHeld++}},true);
 return true}"""
# The preview as the user sees it: every frame is stepped with Previous Frame / Next Frame, decoded from the preview image and read
# whole (FNV-1a over RGBA, the test_volume_batch_save helper); probe pixels are read where this test projected them itself.
FRAMES="""async probes=>{const d=document.querySelector('#kin-volume-mip'),img=d.querySelector('.kin-mip-batch img'),caption=d.querySelector('.kin-mip-batch-frame');
 const button=name=>[...d.querySelectorAll('.kin-mip-batch button')].find(b=>b.textContent===name),previous=button('Previous Frame'),next=button('Next Frame');
 for(let guard=0;!previous.disabled&&guard<100;guard++)previous.click();
 const count=Number(caption.textContent.split(' / ')[1].split(' · ')[0]),out=[];
 for(let i=0;i<count;i++){if(i)next.click();await img.decode();const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
  const data=ctx.getImageData(0,0,c.width,c.height).data;let hash=2166136261;for(const b of data)hash=Math.imul(hash^b,16777619);
  out.push({caption:caption.textContent,width:c.width,height:c.height,hash:hash>>>0,pixels:(probes[i]||[]).map(([x,y])=>data[(y*c.width+x)*4])})}
 return out}"""
# Faults only inside the batch frame path (stack filter), in the objects the viewer reads through: the VOI plane factory of
# writeBatchFrame, the rendering engine's window slot as gpuProblem reads it for verifyBatchFrame, and the canvas encoder of the
# private viewport. verifyBatchFrame checks ownership first, and a verifyBatchFrame-only filter fired inside that check, so the
# restore rolled back as a source change and never reached the GPU program; the slot fault therefore also requires gpuProblem.
BATCH_PLANE_FAULT="""()=>{"use strict";const model=window.KinVolumeMip,real=model.voiPlane;window.batchFault=[];
 model.voiPlane=function(definition){const stack=batchTrace();if(!stack.includes('writeBatchFrame'))return real(definition);model.voiPlane=real;batchFault.push({stack});throw Error('INJECTED MIP BATCH PLANE WRITE')};return model.voiPlane!==real}"""
BATCH_GPU_FAULT=GPU_FAULT.replace("window.mipFault=[]","window.batchFault=[]").replace("const stack=mipTrace();if(!stack.includes('gpuProblem'))return real;","const stack=batchTrace();if(!stack.includes('verifyBatchFrame')||!stack.includes('gpuProblem'))return real;").replace("mipFault.push({stack})","batchFault.push({stack})")
assert 'mipTrace' not in BATCH_GPU_FAULT and 'mipFault' not in BATCH_GPU_FAULT and BATCH_GPU_FAULT.count('verifyBatchFrame')==1 and BATCH_GPU_FAULT.count('gpuProblem')==1
BLOB_FAULT="""()=>{"use strict";const real=HTMLCanvasElement.prototype.toBlob;window.batchFault=[];
 HTMLCanvasElement.prototype.toBlob=function(callback,...rest){if(!this.closest?.('[data-kin-mip-batch-render]'))return real.call(this,callback,...rest);HTMLCanvasElement.prototype.toBlob=real;batchFault.push({stack:batchTrace()});callback(null)};return true}"""
MADE='MIP Batch 미리보기 {}장을 만들었습니다. 표시 전용 임시 미리보기이며 Save MIP Job으로 조건을 저장할 수 있습니다.'

def recipe_of(axis,interval,count,reverse=False):return {'schema':1,'algorithm':'kin-mip-batch-1','axis':axis,'interval':interval,'count':count,'reverse':reverse}
def cross(a,b):return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
def batch_cameras(final,recipe):
 # RC-4: computed here, never by the module under test. Rodrigues from the confirmed Final readback camera with its own distance,
 # about the voxel-centre box centre, parallel scale half the whole-volume slab.
 n0,u0=list(final['viewPlaneNormal']),list(final['viewUp']);distance=math.dist(final['position'],final['focalPoint'])
 right=cross(u0,n0);length=math.hypot(*right);right=[x/length for x in right]
 axis=u0 if recipe['axis']=='Horizontal' else right;sign=-1 if recipe['reverse'] else 1;cameras=[]
 for i in range(recipe['count']):
  angle=sign*i*recipe['interval'];radians=math.radians(angle)
  n=rodrigues(n0,axis,radians) if i else list(n0);u=list(u0) if recipe['axis']=='Horizontal' or not i else rodrigues(u0,axis,radians)
  cameras.append({'angle':angle,'focalPoint':list(CENTER),'position':[c+x*distance for c,x in zip(CENTER,n)],'viewPlaneNormal':n,'viewUp':u,'parallelScale':TOTAL/2})
 return cameras,distance
def ray_orientation(normal):
 # The preset whose ray axis an axis-aligned frame looks along; its known-voxel oracle holds for that frame (MIP, MinIP and the
 # mean do not depend on the ray's sign). An oblique frame has none.
 axis=max(range(3),key=lambda k:abs(normal[k]))
 return {0:'Sagittal',1:'Coronal',2:'Axial'}[axis] if abs(abs(normal[axis])-1)<=1e-9 else None
def canvas_point(world,camera):
 # Screen right is viewUp x viewPlaneNormal (vtk: direction of projection x viewUp); SIZE/2 pixels per parallel scale, y downwards.
 f,n,u,s=camera['focalPoint'],camera['viewPlaneNormal'],camera['viewUp'],camera['parallelScale'];r=cross(u,n);d=[w-c for w,c in zip(world,f)]
 x=SIZE/2+sum(a*b for a,b in zip(d,r))*(SIZE/2)/s;y=SIZE/2-sum(a*b for a,b in zip(d,u))*(SIZE/2)/s
 return [min(SIZE-1,max(0,math.floor(x))),min(SIZE-1,max(0,math.floor(y)))]
def any_case_probes(plan,study,orientation,mode):
 # VOI off: every VOI case's probe on this ray and mode, compared with its unclipped expectation.
 return [probe for case in VOI_CASES for probe in plan[(study,case['name'],orientation,mode)]]

class VolumeMipBatchE2E(VolumeMipJobE2E):
 def batch_button(self,dialog,name):return dialog.locator('.kin-mip-batch').get_by_role('button',name=name,exact=True)
 def batch_inputs(self,dialog,axis,interval,count,reverse=False):
  box=dialog.locator('.kin-mip-batch');box.get_by_label('MIP Batch Axis',exact=True).select_option(axis)
  box.get_by_label('MIP Batch Interval (deg)',exact=True).fill(str(interval));box.get_by_label('MIP Batch Number',exact=True).fill(str(count))
  if reverse:box.get_by_label('MIP Batch Reverse',exact=True).check()
  else:box.get_by_label('MIP Batch Reverse',exact=True).uncheck()
 def make(self,page,dialog,count):
  page.evaluate('()=>{batchFrames.length=0}');self.batch_button(dialog,'Make MIP Batch').click()
  expect(dialog.locator('[role=status]')).to_have_text(MADE.format(count),timeout=120000)
  page.evaluate(SETTLE);self.assertFalse(page.evaluate('()=>!!batchView()'),'the private batch viewport is disabled after Make')
  return page.evaluate('()=>batchFrames.splice(0)')
 def points(self,probe_sets,cameras):return [[canvas_point(probe['world'],camera) for probe in probes] if probes else [] for probes,camera in zip(probe_sets,cameras)]
 def batch_native(self,frames,cameras,record,voi,mode,label):
  self.assertEqual(len(frames),len(cameras),(label,[frame['problem'] for frame in frames]))
  for i,(frame,want) in enumerate(zip(frames,cameras)):
   tag=f'{label} frame {i}';camera,state=frame['camera'],frame['state']
   self.assertEqual(frame['problem'],'',tag);self.assertTrue(frame['id'].startswith('kin-mipbatch-'),tag);self.assertEqual(frame['canvas'],[SIZE,SIZE],tag)
   # BLK-1/RC-4: the read-back camera against the independently computed one, every field within 1e-6.
   for key in ('focalPoint','position','viewPlaneNormal','viewUp'):np.testing.assert_allclose(camera[key],want[key],atol=1e-6,rtol=0,err_msg=tag+' '+key)
   self.assertAlmostEqual(camera['parallelScale'],want['parallelScale'],delta=1e-6,msg=tag);self.assertGreaterEqual(math.dist(camera['position'],camera['focalPoint']),TOTAL/2+1e-6,tag)
   np.testing.assert_allclose(state['viewPlaneNormal'],want['viewPlaneNormal'],atol=1e-6,rtol=0,err_msg=tag);np.testing.assert_allclose(state['viewUp'],want['viewUp'],atol=1e-6,rtol=0,err_msg=tag)
   np.testing.assert_allclose(frame['expected']['viewPlaneNormal'],want['viewPlaneNormal'],atol=1e-6,rtol=0,err_msg=tag+' expected');self.assertEqual(frame['expected']['voiSlab'],bool(record),tag)
   self.assertEqual(state['blend'],BLENDS[mode],tag);self.assertAlmostEqual(state['sampleDistance'],sum(SPACING)/6,delta=1e-9,msg=tag);self.assertEqual(state['interpolationType'],0,tag)
   self.assertAlmostEqual(state['voiRange']['lower'],voi[0],delta=1e-6,msg=tag);self.assertAlmostEqual(state['voiRange']['upper'],voi[1],delta=1e-6,msg=tag)
   planes=state['planes'];self.assertEqual(len(planes),4 if record else 2,tag)
   # MB2: the whole-volume slab faces this frame and is centred on its focal point.
   for _,normal in planes[:2]:self.assertAlmostEqual(abs(float(np.dot(normal,want['viewPlaneNormal']))),1,delta=1e-6,msg=tag)
   self.assertAlmostEqual(math.dist(planes[0][0],planes[1][0]),TOTAL,delta=1e-6,msg=tag)
   middle=[(a+b)/2 for a,b in zip(planes[0][0],planes[1][0])];self.assertAlmostEqual(float(np.dot(np.subtract(middle,want['focalPoint']),want['viewPlaneNormal'])),0,delta=1e-6,msg=tag)
   # MB1: the VOI Slab planes are the saved source-LPS planes on every frame, never turned with the camera.
   for (origin,normal),(want_origin,want_normal) in zip(planes[2:],voi_planes(record) if record else []):
    np.testing.assert_allclose(origin,want_origin,atol=1e-6,rtol=0,err_msg=tag);np.testing.assert_allclose(normal,want_normal,atol=1e-6,rtol=0,err_msg=tag)
 def batch_pixels(self,shots,probe_sets,label,expected='expected'):
  for i,(shot,probes) in enumerate(zip(shots,probe_sets)):
   self.assertEqual([shot['width'],shot['height']],[SIZE,SIZE],(label,i))
   if probes is None:continue
   self.assertTrue(probes,(label,i,'the known-voxel oracle has no probe on this ray'));self.assertEqual(len(shot['pixels']),len(probes),(label,i))
   for probe,actual in zip(probes,shot['pixels']):
    self.assertGreaterEqual(probe['separation'],VOI_DISCRIMINATION,probe)
    wanted=[probe['expected']] if expected=='expected' else probe['unclipped']
    self.assertLessEqual(min(abs(actual-w) for w in wanted),VOI_DELTA,(label,i,expected,probe,actual))
 def batch_announced(self,page,count,saved_label):
  records=page.evaluate('()=>batchStatuses.slice()')
  success=[i for i,r in enumerate(records) if r['source']=='jobs' and 'MIP Batch 작업을 복원했습니다' in r['text']];self.assertEqual(len(success),1,records)
  progress=[i for i,r in enumerate(records) if r['source']=='mip' and r['text'].startswith('MIP Batch 복원 중 ')]
  self.assertTrue(progress,'the frame progress is shown');self.assertLess(progress[-1],success[0],records)
  self.assertIn(f'MIP Batch 복원 중 {count} / {count} · Close MIP Viewer나 Escape로 취소',[records[i]['text'] for i in progress])
  # BLK-2/MB8: nothing reads as restored or Saved while any frame is still pending ('· Not Saved' is not Saved).
  for r in records[:progress[-1]+1]:
   self.assertNotIn('복원했습니다',r['text'],r);self.assertFalse(r['voi'].endswith(' · Saved'),r)
  done=records[success[0]];self.assertEqual([done['state'],done['voi']],['final',saved_label],done)
  self.assertTrue(done['frame'].startswith(f'1 / {count} · '),done);self.assertTrue(done['image'],done)
 def assert_unannounced(self,page):
  records=page.evaluate('()=>batchStatuses.slice()')
  self.assertEqual([r for r in records if '복원했습니다' in r['text']],[]);self.assertEqual([r for r in records if r['voi'].endswith(' · Saved')],[])

 def test_mip_batch_01_rotation_voi_frames_save_restore_new_browser(self):
  study,intercept,voi=VOI_STUDIES[0];plan=voi_plan();_,_,oblique=VOI_CASES;record=voi_record(oblique)
  cell=plan[(study,'oblique','Coronal','Raysum')];self.assertTrue(cell);worlds=[probe['world'] for probe in cell]
  a,p,v=self.opened_voi_study(intercept,voi);original=self.originals();p.locator('#findings').fill('KEEP MIP BATCH REPORT');source=v.evaluate(SOURCE_PLANES)
  v.evaluate(BATCH_HELPERS);posts=[];v.on('request',lambda r:posts.append(r) if job_post(a.uid)(r) else None)
  dialog=self.open_voi(v);status,summary=dialog.locator('[role=status]'),dialog.locator('.kin-mip-voi-state')
  for text in ('회전 투영 미리보기','이 제품의 선택','Type·Thickness 입력','영상 반출·출력·필름·DICOM 저장이 아닙니다','프레임 영상은 저장하지 않으며'):expect(dialog.locator('.kin-mip-batch-scope')).to_contain_text(text)
  expect(dialog.locator('.kin-mip-batch-note')).to_have_text('');expect(self.batch_button(dialog,'Make MIP Batch')).to_be_enabled()
  self.voi_native(self.settled(v,self.apply_voi_case(v,dialog,oblique)),'MIP','Axial',record,voi)
  mark=self.mark(v);self.choose_mip(dialog,'Raysum','Coronal');state=self.job_final(v,mark,'Raysum','Coronal',worlds)
  self.voi_native(state,'Raysum','Coronal',record,voi);self.voi_pixels(state,cell,'Final before Make');final=v.evaluate(FINAL_CAMERA)
  thickness=mm_text(record['thickness']);label='VOI Slab · On · '+thickness+' mm · '
  # A 45 degree Vertical series: every frame's camera, slab and VOI Slab planes (no axis-aligned pixel oracle at 45 degrees).
  vertical=recipe_of('Vertical',45,3);self.batch_inputs(dialog,'Vertical',45,3);frames=self.make(v,dialog,3)
  cameras,distance=batch_cameras(final,vertical);self.assertGreaterEqual(distance,TOTAL/2+1e-6,'the confirmed Final camera stands outside the slab')
  self.batch_native(frames,cameras,record,voi,'Raysum','Vertical 45');expect(dialog.locator('.kin-mip-batch-frame')).to_have_text('1 / 3 · Raysum · Coronal · Vertical 0° · VOI Slab '+thickness+' mm · Preview')
  # Horizontal 90 x 4: frames 0 and 180 are coronal rays and 90 and 270 sagittal rays through the same known voxels and VOI Slab.
  recipe=recipe_of('Horizontal',90,4);self.batch_inputs(dialog,'Horizontal',90,4);frames=self.make(v,dialog,4);cameras,_=batch_cameras(final,recipe)
  self.batch_native(frames,cameras,record,voi,'Raysum','Horizontal 90')
  np.testing.assert_allclose(frames[0]['camera']['viewPlaneNormal'],final['viewPlaneNormal'],atol=1e-12,rtol=0);np.testing.assert_allclose(frames[0]['camera']['viewUp'],final['viewUp'],atol=1e-12,rtol=0)
  rays=[ray_orientation(camera['viewPlaneNormal']) for camera in cameras];self.assertEqual(rays,['Coronal','Sagittal','Coronal','Sagittal'])
  probe_sets=[plan[(study,'oblique',ray,'Raysum')] for ray in rays];points=self.points(probe_sets,cameras)
  shots=v.evaluate(FRAMES,points);self.batch_pixels(shots,probe_sets,'Horizontal 90 made');hashes=[shot['hash'] for shot in shots]
  self.assertEqual([shot['caption'] for shot in shots],[f'{i+1} / 4 · Raysum · Coronal · Horizontal {angle} · VOI Slab {thickness} mm · Preview' for i,angle in enumerate(('0°','+90°','+180°','+270°'))])
  self.assertNotEqual(hashes[0],hashes[1],'a quarter turn is another image')
  # The Final display and the MPR are untouched by Make.
  self.assertEqual(v.evaluate(SOURCE_PLANES),source,'Make leaves the MPR slab planes as they were')
  v.evaluate(SETTLE);after=v.evaluate('p=>mipVoiState(p)',worlds);self.voi_native(after,'Raysum','Coronal',record,voi);self.voi_pixels(after,cell,'Final after Make')
  np.testing.assert_allclose(v.evaluate(FINAL_CAMERA)['position'],final['position'],atol=1e-6,rtol=0)
  expect(summary).to_have_text(label+'Not Saved');expect(dialog.locator('.kin-mip-job-note')).to_contain_text('MIP Batch 조건');self.assertEqual(posts,[])
  # MB5: editing Number after Make does not change what Save stores.
  dialog.locator('.kin-mip-batch').get_by_label('MIP Batch Number',exact=True).fill('7')
  self.save_titled(dialog,'MIP batch oblique Raysum',label+'Saved');expect(status).to_contain_text('MIP 작업을 저장했습니다');self.assertEqual(len(posts),1)
  row,job=self.mip_job(a,'MIP batch oblique Raysum');body=json.loads(posts[0].post_data);saved=job['snapshot']
  self.assertEqual([row['snapshotVersion'],saved['version'],body['snapshot']['version']],[13,13,13])
  self.assertEqual(sorted(saved),['active','cells','cols','mip','mipBatch','rows','studies','version','volume']);self.assertEqual(sorted(saved['mipBatch']),RECIPE_KEYS)
  self.assertEqual(saved['mipBatch'],recipe);self.assertEqual(body['snapshot']['mipBatch'],recipe);self.assertEqual(field_differences(saved['mip'],body['snapshot']['mip']),[])
  self.assertEqual([saved['mip'][k] for k in ('schema','algorithm','mode','orientation')],[1,'kin-mip-1','Raysum','Coronal'])
  self.assertFalse({'volumeId','affine','history','original','applied','pending','state','pixels','frames','url','blob','angle','size'}&set(json_keys(saved)),json_keys(saved))
  self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible();self.assertEqual(v.evaluate('()=>mipCount()'),0);self.assertFalse(v.evaluate('()=>!!batchView()'))
  jobs_panel=v.locator('#kin-viewer-jobs');expect(jobs_panel).to_contain_text('MIP Batch · 출력 미지원 · 회전 투영 표시 작업')
  expect(jobs_panel.get_by_role('button',name='Restore Job',exact=True)).to_have_count(1);expect(jobs_panel.get_by_role('button',name='Print Saved Images',exact=True)).to_have_count(0)
  # Restore after changing the MPR: frame progress shows while frames regenerate, and success appears once, after the last frame, with Saved.
  self.project(v,1,2);self.assertEqual(v.evaluate(CAPTURE)['version'],4);v.evaluate('()=>{batchStatuses.length=0;batchFrames.length=0}')
  started=time.monotonic();v.get_by_role('button',name='Restore Job',exact=True).click()
  expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('MIP Batch 작업을 복원했습니다',timeout=150000);measured=time.monotonic()-started
  self.batch_announced(v,4,label+'Saved');self.batch_native(v.evaluate('()=>batchFrames.splice(0)'),cameras,record,voi,'Raysum','Horizontal 90 restored')
  shots=v.evaluate(FRAMES,points);self.assertEqual([shot['hash'] for shot in shots],hashes,'the restored frames are the saved preview pixel for pixel');self.batch_pixels(shots,probe_sets,'restored')
  expect(summary).to_have_text(label+'Saved');restored=v.evaluate(READ_ONLY_CAPTURE);self.assertEqual(restored['version'],13);self.assertEqual(restored['mipBatch'],recipe);self.assert_cells(restored['cells'],saved['cells'])
  box=dialog.locator('.kin-mip-batch');self.assertEqual([box.get_by_label('MIP Batch Axis',exact=True).input_value(),box.get_by_label('MIP Batch Interval (deg)',exact=True).input_value(),box.get_by_label('MIP Batch Number',exact=True).input_value()],['Horizontal','90','4'])
  self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible()
  # A new browser: the MIP Batch model is absent before the restore (RC-3), which loads it and regenerates the same pixels.
  fresh=self.login();self.launch(fresh,[a]);self.ready(fresh);fresh.evaluate(HELPERS);fresh.evaluate(BATCH_HELPERS)
  self.assertEqual(fresh.evaluate('()=>[typeof window.KinVolumeMipBatch,typeof window.kinCreateVolumeMip]'),['undefined','undefined'])
  started=time.monotonic();fresh.get_by_role('button',name='Restore Job',exact=True).click()
  expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('MIP Batch 작업을 복원했습니다',timeout=150000);fresh_measured=time.monotonic()-started
  self.batch_announced(fresh,4,label+'Saved');fresh_dialog=fresh.locator('#kin-volume-mip');expect(fresh_dialog).to_have_attribute('data-kin-mip-state','final')
  fresh_final=fresh.evaluate(FINAL_CAMERA);np.testing.assert_allclose(fresh_final['viewPlaneNormal'],final['viewPlaneNormal'],atol=1e-6,rtol=0)
  fresh_cameras,_=batch_cameras(fresh_final,recipe);self.batch_native(fresh.evaluate('()=>batchFrames.splice(0)'),fresh_cameras,record,voi,'Raysum','Horizontal 90 new browser')
  shots=fresh.evaluate(FRAMES,self.points(probe_sets,fresh_cameras));self.assertEqual([shot['hash'] for shot in shots],hashes,'a new browser regenerates the same pixels');self.batch_pixels(shots,probe_sets,'new browser')
  fresh.evaluate(VOI_HELPERS);fresh.evaluate(SETTLE);state=fresh.evaluate('p=>mipVoiState(p)',worlds);self.voi_native(state,'Raysum','Coronal',record,voi)
  expect(fresh_dialog.locator('.kin-mip-voi-state')).to_have_text(label+'Saved')
  again=fresh.evaluate(READ_ONLY_CAPTURE);self.assertEqual(again['mipBatch'],recipe);self.assertEqual(field_differences(again['mip'],saved['mip']),[]);self.assert_cells(again['cells'],saved['cells'])
  fresh_dialog.get_by_role('button',name='Close MIP Viewer',exact=True).click();expect(fresh_dialog).not_to_be_visible()
  # VOI off, MinIP x Sagittal, Vertical Reverse 45 x 3: frames 0 and -90 are sagittal and axial rays with the unclipped expectation.
  dialog=self.open_voi(v);mark=self.mark(v);self.choose_mip(dialog,'MinIP','Sagittal');self.job_final(v,mark,'MinIP','Sagittal')
  off=recipe_of('Vertical',45,3,True);off_final=v.evaluate(FINAL_CAMERA);self.batch_inputs(dialog,'Vertical',45,3,True);frames=self.make(v,dialog,3);off_cameras,_=batch_cameras(off_final,off)
  self.batch_native(frames,off_cameras,None,voi,'MinIP','VOI off Vertical reverse')
  off_rays=[ray_orientation(camera['viewPlaneNormal']) for camera in off_cameras];self.assertEqual(off_rays,['Sagittal',None,'Axial'])
  off_sets=[any_case_probes(plan,study,ray,'MinIP') if ray else None for ray in off_rays];off_points=self.points(off_sets,off_cameras)
  shots=v.evaluate(FRAMES,off_points);self.batch_pixels(shots,off_sets,'VOI off made','unclipped');off_hashes=[shot['hash'] for shot in shots]
  self.assertEqual([shot['caption'] for shot in shots],[f'{i+1} / 3 · MinIP · Sagittal · Vertical {angle} · VOI Slab Off · Preview' for i,angle in enumerate(('0°','-45°','-90°'))])
  expect(summary).to_have_text('VOI Slab · Off · Not Saved');self.save_titled(dialog,'MIP batch off MinIP','VOI Slab · Off · Saved');self.assertEqual(len(posts),2)
  _,off_job=self.mip_job(a,'MIP batch off MinIP');self.assertEqual(off_job['snapshot']['version'],13);self.assertIsNone(off_job['snapshot']['mip']['voiSlab']);self.assertEqual(off_job['snapshot']['mipBatch'],off)
  self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible()
  v.evaluate('()=>{batchStatuses.length=0;batchFrames.length=0}');self.restore_titled(v,a,'MIP batch off MinIP')
  expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('MIP Batch 작업을 복원했습니다',timeout=150000);self.batch_announced(v,3,'VOI Slab · Off · Saved')
  self.batch_native(v.evaluate('()=>batchFrames.splice(0)'),off_cameras,None,voi,'MinIP','VOI off restored')
  self.assertEqual([shot['hash'] for shot in v.evaluate(FRAMES,off_points)],off_hashes);self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible()
  expect(p.locator('#findings')).to_have_value('KEEP MIP BATCH REPORT');self.assertEqual(len(self.versions(a)),1);self.assertEqual(self.originals(),original);self.assertEqual(len(posts),2)
  print('MIP_BATCH_RESTORE',json.dumps({'same_browser_restore_s':round(measured,3),'new_browser_restore_s':round(fresh_measured,3),'frames':4,'final_distance_mm':distance,'hashes':hashes}),flush=True)

 def test_mip_batch_02_gates_cancel_failure_order_v12_compat(self):
  study,intercept,voi=VOI_STUDIES[1];_,perpendicular,_=VOI_CASES;rB=voi_record(perpendicular)
  a,p,v=self.opened_voi_study(intercept,voi);original=self.originals();source=v.evaluate(SOURCE_PLANES);v.evaluate(BATCH_HELPERS)
  posts=[];v.on('request',lambda r:posts.append(r) if job_post(a.uid)(r) else None)
  dialog=self.open_voi(v);status,summary=dialog.locator('[role=status]'),dialog.locator('.kin-mip-voi-state')
  save,retry,title=dialog.get_by_role('button',name='Save MIP Job',exact=True),dialog.get_by_role('button',name='Retry MIP Save',exact=True),dialog.get_by_label('MIP Job Title',exact=True)
  make,cancel,play,clear=(self.batch_button(dialog,name) for name in ('Make MIP Batch','Cancel MIP Batch','Play MIP Batch','Clear MIP Batch'))
  label='VOI Slab · On · '+mm_text(rB['thickness'])+' mm · ';result=dialog.locator('.kin-mip-batch-result')
  self.voi_native(self.settled(v,self.apply_voi_case(v,dialog,perpendicular)),'MIP','Axial',rB,voi)
  # Make is refused while Rendering and with Original on; nothing reaches a private viewport.
  v.evaluate('()=>{mipHold=true;mipHeldFrames=0}');mark=self.mark(v);self.voi_button(dialog,'Reset VOI').click();v.wait_for_function('()=>mipHeldFrames>0')
  expect(dialog).to_have_attribute('data-kin-mip-state','pending');make.click();expect(status).to_have_text('최종 표시를 확인한 뒤 MIP Batch를 만드세요.')
  v.evaluate('()=>{mipHold=false;mipView().render()}');self.settled(v,mark);mark=self.mark(v);self.voi_button(dialog,'Undo VOI').click();self.voi_native(self.settled(v,mark),'MIP','Axial',rB,voi)
  mark=self.mark(v);self.voi_field(dialog,'Original').check();self.settled(v,mark);make.click();expect(status).to_have_text('Original 보기를 끈 뒤 MIP Batch를 만드세요.')
  mark=self.mark(v);self.voi_field(dialog,'Original').uncheck();self.settled(v,mark)
  self.batch_inputs(dialog,'Horizontal',90,6);make.click();expect(status).to_contain_text('전체 회전 범위((Number-1)×Interval)는 360도 이내로 입력하세요')
  self.assertEqual(v.evaluate('()=>batchFrames.length'),0);self.assertFalse(v.evaluate('()=>!!batchView()'))
  # Preview A, then a second Make held on its second frame: display change, Save, capture, another Make and Play are refused, and
  # Cancel keeps A exactly (MB9).
  A=recipe_of('Horizontal',90,3);self.batch_inputs(dialog,'Horizontal',90,3);self.make(v,dialog,3);shots=v.evaluate(FRAMES,[]);first=[shot['hash'] for shot in shots]
  # FRAMES leaves its last frame shown (Next Frame); that frame, as recipe A names it, and its image are what the held Make keeps.
  kept=f"3 / 3 · MIP · Axial · Horizontal +180° · VOI Slab {mm_text(rB['thickness'])} mm · Preview";self.assertEqual(shots[-1]['caption'],kept)
  frame,image=dialog.locator('.kin-mip-batch-frame'),dialog.locator('.kin-mip-batch img');expect(frame).to_have_text(kept);kept_src=image.get_attribute('src');self.assertTrue(kept_src)
  self.assertEqual(v.evaluate(READ_ONLY_CAPTURE)['mipBatch'],A)
  self.batch_inputs(dialog,'Vertical',30,4);v.evaluate('()=>{batchHoldFrame=2;batchHeld=0}');make.click()
  v.wait_for_function('()=>batchHeld>0',timeout=60000);expect(status).to_have_text('MIP Batch 생성 중 2 / 4')
  mark=self.mark(v);self.choose_mip(dialog,'MinIP');expect(status).to_have_text('MIP Batch 생성이 끝난 뒤 Projection·Orientation·VOI Slab을 바꾸세요.');self.unchanged(v,mark)
  expect(dialog.get_by_label('MIP Projection',exact=True)).to_have_value('MIP')
  title.fill('MIP batch held');save.click();expect(status).to_have_text('MIP Batch 생성을 마친 뒤 MIP 작업을 저장하세요.');self.assertEqual(posts,[])
  self.assertEqual(v.evaluate(READ_REFUSED),'MIP Batch 생성을 마친 뒤 MIP 작업을 저장하세요.')
  make.click();expect(status).to_have_text('MIP Batch 생성이 끝난 뒤 다시 누르세요.')
  expect(play).to_be_disabled();expect(clear).to_be_disabled();expect(frame).to_have_text(kept);expect(image).to_have_attribute('src',kept_src)
  cancel.click();expect(status).to_have_text('MIP Batch 생성을 취소했습니다. 이전 MIP Batch 미리보기를 유지합니다.');v.evaluate('()=>{batchHoldFrame=null}')
  self.assertFalse(v.evaluate('()=>!!batchView()'));self.assertEqual([shot['hash'] for shot in v.evaluate(FRAMES,[])],first);self.assertEqual(v.evaluate(READ_ONLY_CAPTURE)['mipBatch'],A)
  expect(dialog).to_have_attribute('data-kin-mip-state','final');expect(play).to_be_enabled()
  # A clipping-plane write fault and a PNG encoding failure in the frame path keep A and never touch the Final display.
  for fault,message,step in ((BATCH_PLANE_FAULT,'INJECTED MIP BATCH PLANE WRITE','writeBatchFrame'),(BLOB_FAULT,'MIP Batch 영상을 만들지 못했습니다.','')):
   self.assertTrue(v.evaluate(fault),'fault not installed: '+message);mark=self.mark(v);make.click()
   expect(status).to_have_text(message.rstrip('.')+('.' if message.endswith('.') else '')+' 이전 MIP Batch 미리보기를 유지합니다.',timeout=60000)
   self.assertEqual(v.evaluate('s=>batchFault.map(f=>f.stack.includes(s))',step),[True],message);self.unchanged(v,mark)
   self.assertFalse(v.evaluate('()=>!!batchView()'));self.assertEqual([shot['hash'] for shot in v.evaluate(FRAMES,[])],first);expect(dialog).to_have_attribute('data-kin-mip-state','final')
  # Make -> Save version 13 -> Clear: the same block without its preview is Not Saved, and Save then stores version 12.
  self.batch_inputs(dialog,'Horizontal',90,3);self.make(v,dialog,3);expect(summary).to_have_text(label+'Not Saved')
  self.save_titled(dialog,'MIP batch v13',label+'Saved');self.assertEqual(json.loads(posts[-1].post_data)['snapshot']['version'],13)
  clear.click();expect(status).to_have_text('MIP Batch 미리보기를 비웠습니다.');expect(summary).to_have_text(label+'Not Saved');expect(result).to_be_hidden()
  self.assertEqual(v.evaluate(READ_ONLY_CAPTURE)['version'],12);self.assertEqual(v.evaluate(SOURCE_PLANES),source,'Make and Clear leave the MPR slab planes as they were')
  self.save_titled(dialog,'MIP batch cleared v12',label+'Saved');self.assertEqual(json.loads(posts[-1].post_data)['snapshot']['version'],12);self.assertEqual(len(posts),2)
  # MB6: a display change clears the preview before it renders, so Save stores version 12 of the new display.
  self.make(v,dialog,3);expect(summary).to_have_text(label+'Not Saved')
  self.voi_field(dialog,'Move').fill('1');mark=self.mark(v);self.voi_button(dialog,'Move Slab').click();self.settled(v,mark)
  expect(result).to_be_hidden();moved=v.evaluate(READ_ONLY_CAPTURE);self.assertEqual(moved['version'],12);self.assertNotIn('mipBatch',moved)
  self.save_titled(dialog,'MIP moved v12',label+'Saved');self.assertEqual(json.loads(posts[-1].post_data)['snapshot']['version'],12)
  mark=self.mark(v);self.voi_button(dialog,'Undo VOI').click();self.settled(v,mark)
  # MB10: an unknown receipt keeps the version 13 body; with the preview cleared the same block is another display, so Retry is off.
  self.make(v,dialog,3);title.fill('MIP batch lost')
  def lost(route):
   if route.request.method=='POST':route.fetch();route.abort()
   else:route.continue_()
  v.route(JOBS,lost);save.click();expect(summary).to_have_text(label+'Save Unconfirmed · Retry MIP Save',timeout=45000);v.unroute(JOBS,lost)
  jobs_now=len(self.jobs(a));expect(retry).to_be_enabled(timeout=5000)
  clear.click();expect(summary).to_have_text(label+'Not Saved');expect(retry).to_be_disabled(timeout=5000)
  save.click();expect(status).to_contain_text('Retry Request로 먼저 확인하세요')
  self.make(v,dialog,3);expect(summary).to_have_text(label+'Save Unconfirmed · Retry MIP Save');expect(retry).to_be_enabled(timeout=5000)
  retry.click();expect(summary).to_have_text(label+'Saved',timeout=45000);self.assertEqual(len(self.jobs(a)),jobs_now)
  # A non-radiologist can make a preview (display only) but not save it; the server refuses that account too.
  v.evaluate('()=>{window.heldCommand=window.kinViewerJobCommand;window.kinViewerJobCommand={...heldCommand,writable:()=>false}}')
  expect(save).to_be_disabled(timeout=5000);self.batch_inputs(dialog,'Vertical',90,2,True);self.make(v,dialog,2)
  self.assertEqual(v.evaluate(READ_ONLY_CAPTURE)['mipBatch'],recipe_of('Vertical',90,2,True));v.evaluate('()=>{window.kinViewerJobCommand=heldCommand}');expect(save).to_be_enabled(timeout=5000)
  base=copy.deepcopy(self.mip_job(a,'MIP batch v13')[1]['snapshot']);del base['volume']['sourceDigest'];jobs_before=len(self.jobs(a))
  def forged(change,user='doctor'):
   s=copy.deepcopy(base);change(s);return self.stack.request('POST',f'/studies/{a.uid}/viewer-jobs',user,{'id':str(uuid.uuid4()),'title':'Forged MIP batch','description':'','snapshot':s}).status
  for name,change in (('version 12 with mipBatch',lambda s:s.__setitem__('version',12)),('version 13 without mipBatch',lambda s:s.pop('mipBatch')),('version 14',lambda s:s.__setitem__('version',14)),
                      ('algorithm kin-mip-batch-2',lambda s:s['mipBatch'].__setitem__('algorithm','kin-mip-batch-2')),('axis Oblique',lambda s:s['mipBatch'].__setitem__('axis','Oblique')),
                      ('count 1',lambda s:s['mipBatch'].__setitem__('count',1)),('count 65',lambda s:s['mipBatch'].__setitem__('count',65)),
                      ('interval 0',lambda s:s['mipBatch'].__setitem__('interval',0)),('interval 180.0001',lambda s:s['mipBatch'].update(interval=180.0001,count=2)),
                      ('span 361',lambda s:s['mipBatch'].update(interval=19,count=20)),('extra recipe key',lambda s:s['mipBatch'].__setitem__('frames',[])),
                      ('beside a batch',lambda s:s.__setitem__('batch',None)),('display not the active cell',lambda s:s['mip']['display']['voiRange'].__setitem__('lower',s['mip']['display']['voiRange']['lower']+1))):
   self.assertEqual(forged(change),400,name)
  self.assertEqual(forged(lambda s:None,'tech'),403);self.assertEqual(len(self.jobs(a)),jobs_before)
  # The version 13 row is labelled and has no print; a version 12 row still restores, with no MIP Batch preview.
  self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible();self.assertFalse(v.evaluate('()=>!!batchView()'))
  jobs_panel=v.locator('#kin-viewer-jobs');expect(jobs_panel).to_contain_text('MIP Batch · 출력 미지원 · 회전 투영 표시 작업');expect(jobs_panel).to_contain_text('MIP Viewer · 출력 미지원 · 표시 전용 투영 작업')
  expect(jobs_panel.get_by_role('button',name='Print Saved Images',exact=True)).to_have_count(0)
  self.restore_titled(v,a,'MIP batch cleared v12');expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('MIP 작업을 복원했습니다',timeout=90000)
  expect(dialog).to_have_attribute('data-kin-mip-state','final');expect(result).to_be_hidden();expect(summary).to_have_text(label+'Saved')
  restored=v.evaluate(READ_ONLY_CAPTURE);self.assertEqual(restored['version'],12);self.assertNotIn('mipBatch',restored)
  # A session ended while a version 13 POST is held closes the viewer and never shows Saved.
  self.make(v,dialog,3);title.fill('MIP batch held session');held=[]
  def hold(route):
   if route.request.method=='POST':held.append(route)
   else:route.continue_()
  v.route(JOBS,hold);save.click()
  for _ in range(100):
   if held:break
   v.wait_for_timeout(100)
  self.assertEqual(len(held),1);self.assertEqual(json.loads(held[0].request.post_data)['snapshot']['version'],13);expect(summary).to_contain_text('· Saving')
  make.click();expect(status).to_have_text('MIP 작업 저장이 끝난 뒤 MIP Batch를 만드세요.')
  self.assertTrue(v.evaluate("()=>!!(window.batchHeldSummary=document.querySelector('#kin-volume-mip .kin-mip-voi-state'))"));v.evaluate(SESSION_END)
  expect(v.locator('#kin-volume-mip[open]')).to_have_count(0,timeout=10000);expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('세션이 변경되었습니다')
  try:held[0].abort()
  except Exception:pass
  v.wait_for_timeout(500);self.assertNotIn('Saved',v.evaluate('()=>batchHeldSummary.textContent'));self.assertNotIn('저장했습니다',v.locator('#kin-viewer-jobs-status').text_content())
  self.assertFalse(v.evaluate('()=>!!batchView()'));self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1)

 def test_mip_batch_03_restore_failure_missing_tool_cancel_stale_rollback(self):
  study,intercept,voi=VOI_STUDIES[0];_,perpendicular,_=VOI_CASES;rB=voi_record(perpendicular)
  a,p,v=self.opened_voi_study(intercept,voi);original=self.originals();v.evaluate(BATCH_HELPERS)
  dialog=self.open_voi(v);self.voi_native(self.settled(v,self.apply_voi_case(v,dialog,perpendicular)),'MIP','Axial',rB,voi)
  label='VOI Slab · On · '+mm_text(rB['thickness'])+' mm · '
  self.batch_inputs(dialog,'Horizontal',90,3);self.make(v,dialog,3);self.save_titled(dialog,'MIP batch VOI job',label+'Saved')
  mark=self.mark(v);self.voi_button(dialog,'Reset VOI').click();self.settled(v,mark);self.save_titled(dialog,'MIP plain job','VOI Slab · Off · Saved')
  self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible()
  rows={row['title']:row['snapshotVersion'] for row in self.jobs(a)};self.assertEqual([rows['MIP batch VOI job'],rows['MIP plain job']],[13,12])
  self.project(v,1,2);previous=v.evaluate(CAPTURE);self.assertEqual(previous['version'],4);status=v.locator('#kin-viewer-jobs-status')
  # A clipping-plane write fault and an unlinked clip program in a regenerated frame, after the Final display confirmed, roll back.
  for fault,message,steps in ((BATCH_PLANE_FAULT,'INJECTED MIP BATCH PLANE WRITE',['writeBatchFrame']),(BATCH_GPU_FAULT,'투영 셰이더를 GPU에서 확인하지 못했습니다',['verifyBatchFrame','gpuProblem'])):
   mark=self.mark(v);v.evaluate('()=>{batchStatuses.length=0}');self.assertTrue(v.evaluate(fault),'fault not installed: '+message)
   self.restore_titled(v,a,'MIP batch VOI job');self.rolled_back(v,message,previous)
   self.assertEqual(v.evaluate('s=>batchFault.map(t=>s.every(n=>t.stack.includes(n)))',steps),[True],message)
   self.assertIn('final',v.evaluate('m=>mipTransitions.slice(m)',mark),'the fault came after the Final display');self.assertEqual(v.evaluate('()=>mipCount()'),0)
   self.assertFalse(v.evaluate('()=>!!batchView()'));self.assert_unannounced(v)
  # A held frame render during regeneration times out on its own frame bound inside the batch budget and rolls back.
  v.evaluate('()=>{batchStatuses.length=0;batchHoldFrame=2;batchHeld=0}');mark=self.mark(v);started=time.monotonic()
  self.restore_titled(v,a,'MIP batch VOI job');v.wait_for_function('()=>batchHeld>0',timeout=90000)
  self.rolled_back(v,'MIP Batch 프레임의 최종 렌더를 확인하지 못했습니다',previous);v.evaluate('()=>{batchHoldFrame=null}')
  self.assertLess(time.monotonic()-started,120);self.assertIn('final',v.evaluate('m=>mipTransitions.slice(m)',mark));self.assert_unannounced(v)
  self.assertTrue([r for r in v.evaluate('()=>batchStatuses.slice()') if r['text'].startswith('MIP Batch 복원 중 2 / 3 · Close MIP Viewer나 Escape로 취소')])
  self.assertFalse(v.evaluate('()=>!!batchView()'))
  # MB13: Close MIP Viewer and Escape cancel during regeneration well before that bound; a later render announces nothing.
  for how in ('close','escape'):
   v.evaluate('()=>{batchStatuses.length=0;batchHoldFrame=2;batchHeld=0}');mark=self.mark(v);self.restore_titled(v,a,'MIP batch VOI job');v.wait_for_function('()=>batchHeld>0',timeout=90000)
   expect(dialog).to_have_attribute('data-kin-mip-state','final');started=time.monotonic()
   if how=='close':self.voi_button(dialog,'Close MIP Viewer').click()
   else:self.voi_button(dialog,'Close MIP Viewer').focus();v.keyboard.press('Escape')
   expect(status).to_contain_text('MIP 작업 복원을 취소했습니다',timeout=10000);self.assertLess(time.monotonic()-started,10,how)
   self.rolled_back(v,'MIP 작업 복원을 취소했습니다',previous);self.assertEqual(v.evaluate('()=>mipCount()'),0);self.assertFalse(v.evaluate('()=>!!batchView()'))
   v.evaluate('()=>{batchHoldFrame=null}');v.wait_for_timeout(500);self.assert_unannounced(v)
  # A session ended during regeneration closes the viewer without a success status.
  v.evaluate('()=>{batchStatuses.length=0;batchHoldFrame=2;batchHeld=0}');self.restore_titled(v,a,'MIP batch VOI job');v.wait_for_function('()=>batchHeld>0',timeout=90000);v.evaluate(SESSION_END)
  expect(v.locator('#kin-volume-mip[open]')).to_have_count(0,timeout=10000);v.evaluate('()=>{batchHoldFrame=null}');v.wait_for_timeout(500)
  self.assertNotIn('복원했습니다',status.text_content());self.assert_unannounced(v);self.assertFalse(v.evaluate('()=>!!batchView()'));self.assertEqual(self.originals(),original)
  # A MIP Batch model that cannot load on a fresh page refuses the version 13 Job with rollback, while the version 12 Job restores
  # there with the MIP Batch panel reporting the missing tool.
  fresh=self.login();fresh.route('**/volume-mip-batch.js',lambda route:route.abort());self.launch(fresh,[a]);self.ready(fresh);before=fresh.evaluate(LAYOUT)
  self.restore_titled(fresh,a,'MIP batch VOI job');expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('MIP Batch 도구를 불러오지 못해 MIP 작업을 복원하지 않았습니다',timeout=90000)
  expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('이전 화면');expect(fresh.locator('#kin-volume-mip')).to_have_count(0);self.assertEqual(fresh.evaluate(LAYOUT),before)
  self.restore_titled(fresh,a,'MIP plain job');expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('MIP 작업을 복원했습니다',timeout=90000)
  fresh_dialog=fresh.locator('#kin-volume-mip');expect(fresh_dialog).to_have_attribute('data-kin-mip-state','final');expect(fresh_dialog.locator('.kin-mip-voi-state')).to_have_text('VOI Slab · Off · Saved')
  expect(fresh_dialog.locator('.kin-mip-batch-note')).to_contain_text('MIP Batch 도구를 불러오지 못해');expect(self.batch_button(fresh_dialog,'Make MIP Batch')).to_be_disabled()
  fresh_dialog.get_by_role('button',name='Close MIP Viewer',exact=True).click();expect(fresh_dialog).not_to_be_visible()
  # A series changed after the save is refused by the server (409) before any layout change; the MIP Viewer never opens.
  from pydicom import dcmread
  stale=self.login();self.launch(stale,[a]);self.ready(stale);before=stale.evaluate(LAYOUT)
  d=dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/'+self.stack.first_instance_id(a.uid)+'/file')));self.assertEqual(str(d.StudyInstanceUID),a.uid)
  d.SOPInstanceUID=d.file_meta.MediaStorageSOPInstanceUID=ct.generate_uid();d.InstanceNumber=34;d.ImagePositionPatient=[0,0,33*2.5];d.SliceLocation=33*2.5
  ae=ct.AE(ae_title='HALLYM_CT');ae.add_requested_context(ct.CTImageStorage,ct.ExplicitVRLittleEndian);assoc=ae.associate('127.0.0.1',4242,ae_title='KINLAB')
  try:self.assertTrue(assoc.is_established);self.assertEqual(assoc.send_c_store(d).Status,0)
  finally:assoc.release()
  row=next(r for r in self.jobs(a) if r['title']=='MIP batch VOI job');self.assertEqual(self.stack.request('GET',f'/studies/{a.uid}/viewer-jobs/{row["id"]}','doctor').status,409)
  self.restore_titled(stale,a,'MIP batch VOI job');expect(stale.locator('#kin-viewer-jobs-status')).to_contain_text('저장 당시 볼륨 원본과 달라 복원하지 않았습니다',timeout=90000)
  expect(stale.locator('#kin-volume-mip')).to_have_count(0);self.assertEqual(stale.evaluate(LAYOUT),before);self.assertEqual(len(self.versions(a)),1)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeMipBatchE2E(n) for n in MIP_BATCH_CASES)
if __name__=='__main__':unittest.main(verbosity=2)
