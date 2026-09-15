# coding: utf-8
"""TEST-MIP-JOB-DOM (A11-VOI-2): MIP Viewer Job save/restore of the confirmed MIP display and VOI Slab with its three-plane MPR."""
import copy,io,json,time,unittest,uuid
import numpy as np
from playwright.sync_api import expect
import test_prior_selection as ct
from test_volume_mip import HELPERS,SETTLE,VOI_HELPERS,VOI_STUDIES,VOI_CASES,SOURCE_PLANES,VolumeMipE2E,mm_text,voi_plan,voi_planes,voi_record
from test_volume_path import field_differences,job_post

# scripts/run-tests.py accepts only cases whose class is declared in the selected module; load_tests selects exactly these,
# so the inherited MIP Viewer, VOI Slab, projection, job and orientation cases stay out of this bounded profile.
MIP_JOB_CASES=('test_mip_job_01_save_restore_roundtrip_new_browser_pixels','test_mip_job_02_save_gates_failure_unconfirmed_retry_roles_account',
               'test_mip_job_03_restore_failure_missing_tool_cancel_stale_rollback')
JOBS='**/api/studies/*/viewer-jobs*'
JOB='window.kinCreateVolumeJob({grid:services.viewportGridService,cs:services.cornerstoneViewportService,ds:services.displaySetService,studies:new URLSearchParams(location.search).get("StudyInstanceUIDs").split(",")})'
CAPTURE='()=>'+JOB+'.capture()'
# While the MIP Viewer dialog is open the MPR tools refuse a permitted capture (viewer-volume-orientation.js:47 through the marks
# capture), which is why Save MIP Job reads its MPR read-only (f429401). A read of the Job shown behind that dialog does the same.
READ_ONLY_CAPTURE='()=>'+JOB+'.capture(true)'
REFUSED_CAPTURE='()=>{try{'+JOB+'.capture();return null}catch(error){return error.message}}'
LAYOUT='()=>{const s=services.viewportGridService.getState();return {rows:s.layout.numRows,cols:s.layout.numCols,sets:[...s.viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).map(g=>g.displaySetInstanceUIDs||[])}}'
FRAME="()=>cornerstone.metaData.get('instance',cornerstone.cache.getVolume(mipView().getVolumeId()).imageIds[0]).FrameOfReferenceUID"
# CA5: the MIP display against the active cell's recorded properties (what the Job cell stores) and both actors.
DISPLAY="""()=>{const active=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId),p=active.getProperties(),m=mipView();
 return {cell:{voiRange:{lower:p.voiRange.lower,upper:p.voiRange.upper},interpolationType:p.interpolationType??1},actor:active.getActors()[0].actor.getProperty().getInterpolationType(),
  mip:m.getActors()[0].actor.getProperty().getInterpolationType(),mipRange:{lower:m.getProperties().voiRange.lower,upper:m.getProperties().voiRange.upper}}}"""
EDITORS="""()=>{const d=document.querySelector('#kin-volume-mip'),f=n=>d.querySelector('[aria-label="VOI Slab '+n+'"]');
 return {center:['L','P','S'].map(a=>Number(f('Center '+a).value)),pivot:['L','P','S'].map(a=>Number(f('Pivot '+a).value)),thickness:Number(f('Thickness').value),enable:f('Enable').checked,original:f('Original').checked,preset:f('Preset').value}}"""
# The page's own VOI tool and request model replay the dialog's steps for a case (Preset, Rotate, Move, each from the editor
# values), so the stored numbers are compared with the confirmed record itself, bit for bit, not with a copy of the saver.
VOI_REPLAY="""([preset,center,pivot,thickness,rotations,move])=>{const V=KinVolumeVoi,M=KinVolumeMip,vol=cornerstone.cache.getVolume(mipView().getVolumeId());
 const draft=s=>V.validate({center:s.center.map(n=>Number(String(n))),normal:[...s.normal],pivot:s.pivot.map(n=>Number(String(n))),thickness:Number(String(s.thickness))});
 let slab={center,normal:[...V.defaults(vol.imageData,preset).normal],pivot,thickness};
 if(!rotations.length&&!move)slab=draft(slab);
 for(const [axis,degrees] of rotations)slab=V.rotate(draft(slab),axis,degrees);
 if(move)slab=V.move(draft(slab),move);
 const record=M.normalizeVoi({volumeId:vol.volumeId,affine:M.affine(i=>vol.imageData.indexToWorld(i)),center:slab.center,normal:slab.normal,pivot:slab.pivot,thickness:slab.thickness});
 const again=M.normalizeVoi(record);
 return {record:{center:[...record.center],normal:[...record.normal],pivot:[...record.pivot],thickness:record.thickness},fixed:again.normal.every((n,i)=>n===record.normal[i])}}"""
# Jobs panel status text together with the MIP dialog state at the moment the text changed.
STATUS_WATCH="""()=>{if(window.jobStatusStates)return;const s=document.querySelector('#kin-viewer-jobs-status');window.jobStatusStates=[];
 new MutationObserver(()=>{const d=document.querySelector('#kin-volume-mip');jobStatusStates.push([s.textContent,d?.open?d.dataset.kinMipState:'closed',d?.querySelector('.kin-mip-voi-state')?.textContent||''])}).observe(s,{childList:true,characterData:true,subtree:true})}"""
SESSION_END="()=>window.dispatchEvent(new StorageEvent('storage',{key:'kin-session-ended',newValue:String(Date.now())}))"
# Faults go where the viewer reads through a changeable object (d6271d2): the VOI plane factory and the rendering engine's
# window slot. Each proves it is installed and fires once inside the product step it targets.
PLANE_FAULT="""()=>{"use strict";const model=window.KinVolumeMip,real=model.voiPlane;window.mipFault=[];
 model.voiPlane=function(definition){const stack=mipTrace();if(!stack.includes('writeVoi'))return real(definition);model.voiPlane=real;mipFault.push({stack});throw Error('INJECTED MIP JOB PLANE WRITE')};return model.voiPlane!==real}"""
GPU_FAULT="""()=>{"use strict";window.mipFault=[];const key='offscreenMultiRenderWindow';let installed=0;
 const engines=cornerstone.getRenderingEngines?.()||[services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId).getRenderingEngine()];
 for(const engine of engines){const own=Object.getOwnPropertyDescriptor(engine,key);let real=engine[key];if(!real)continue;
  const restore=()=>{for(const e of engines)if(e.__kinMipFault)e.__kinMipFault();};
  const unlinked={getOpenGLRenderWindow:(...a)=>{const gl=real.getOpenGLRenderWindow(...a);return {getViewNodeFor:(...b)=>{const node=gl.getViewNodeFor(...b);return {get:(...c)=>{const program=node.get(...c).tris.getProgram();return {tris:{getProgram:()=>({getCompiled:()=>program.getCompiled(),getLinked:()=>false,getFragmentShader:()=>program.getFragmentShader()})}}}}}}}};
  engine.__kinMipFault=()=>{delete engine.__kinMipFault;if(!own)delete engine[key];else Object.defineProperty(engine,key,'value' in own?{...own,value:real}:own)};
  Object.defineProperty(engine,key,{configurable:true,enumerable:own?own.enumerable:false,get(){const stack=mipTrace();if(!stack.includes('gpuProblem'))return real;restore();mipFault.push({stack});return unlinked},set(value){real=value}});installed++;}
 return installed>0}"""
MIP_LIGHT="""()=>{const d=document.querySelector('#kin-volume-mip'),vp=d&&cornerstone.getEnabledElement(d.querySelector('[data-kin-mip-render]'))?.viewport;
 return {open:!!d?.open,state:d?.dataset.kinMipState||'',planes:vp?vp.getActors()[0].actor.getMapper().getClippingPlanes().length:0,voi:d?.querySelector('.kin-mip-voi-state')?.textContent||'',note:d?.querySelector('.kin-mip-voi-note')?.textContent||''}}"""

def json_keys(value):
 if isinstance(value,dict):return [k for key,item in value.items() for k in [key,*json_keys(item)]]
 if isinstance(value,list):return [k for item in value for k in json_keys(item)]
 return []

class VolumeMipJobE2E(VolumeMipE2E):
 def job_final(self,v,mark,mode,orientation,probes=()):
  v.wait_for_function("([m,o,n])=>{const d=document.querySelector('#kin-volume-mip');return mipTransitions.length>n&&mipTransitions.at(-1)==='final'&&d.dataset.kinMipState==='final'&&d.querySelector('.kin-mip-label').textContent.startsWith(m+' · '+o+' · ')}",arg=[mode,orientation,mark],timeout=40000)
  v.evaluate(SETTLE);return v.evaluate('p=>mipVoiState(p)',[list(w) for w in probes])
 def save_titled(self,dialog,title,summary):
  dialog.get_by_label('MIP Job Title',exact=True).fill(title);dialog.get_by_role('button',name='Save MIP Job',exact=True).click()
  expect(dialog.locator('.kin-mip-voi-state')).to_have_text(summary,timeout=45000)
 def mip_job(self,a,title):
  rows=[row for row in self.jobs(a) if row['title']==title];self.assertEqual(len(rows),1,title)
  r=self.stack.request('GET',f'/studies/{a.uid}/viewer-jobs/{rows[0]["id"]}','doctor');self.assertEqual(r.status,200,r.text);return rows[0],r.body
 def restore_titled(self,page,a,title):
  index=next(i for i,row in enumerate(self.jobs(a)) if row['title']==title)
  page.get_by_role('button',name='Restore Job',exact=True).nth(index).click()
 def assert_cells(self,actual,expected):
  self.assertEqual(len(actual),len(expected));self.assertEqual([c['projection'] for c in actual],[c['projection'] for c in expected])
  for left,right in zip(actual,expected):
   for key in ('focalPoint','position','viewUp','viewPlaneNormal'):np.testing.assert_allclose(left['camera'][key],right['camera'][key],atol=1e-6,rtol=0)
   self.assertAlmostEqual(left['camera']['parallelScale'],right['camera']['parallelScale'],delta=1e-6)
 def rolled_back(self,page,message,previous):
  status=page.locator('#kin-viewer-jobs-status');expect(status).to_contain_text(message,timeout=90000);expect(status).to_contain_text('이전 화면')
  expect(page.locator('#kin-volume-mip[open]')).to_have_count(0)
  after=page.evaluate(CAPTURE);self.assertEqual(after['version'],previous['version']);self.assert_cells(after['cells'],previous['cells'])

 def test_mip_job_01_save_restore_roundtrip_new_browser_pixels(self):
  study,intercept,voi=VOI_STUDIES[0];plan=voi_plan();along,_,oblique=VOI_CASES;record=voi_record(oblique)
  cell=plan[(study,'oblique','Coronal','Raysum')];worlds=[probe['world'] for probe in cell];self.assertTrue(cell)
  off_cell=plan[(study,'along-ray','Sagittal','MinIP')];off_worlds=[probe['world'] for probe in off_cell];self.assertTrue(off_cell)
  a,p,v=self.opened_voi_study(intercept,voi);original=self.originals();p.locator('#findings').fill('KEEP MIP JOB REPORT');source=v.evaluate(SOURCE_PLANES)
  posts=[];v.on('request',lambda r:posts.append(r) if job_post(a.uid)(r) else None)
  dialog=self.open_voi(v);summary,status=dialog.locator('.kin-mip-voi-state'),dialog.locator('[role=status]')
  for text in ('Save MIP Job으로 저장할 때만','저장하지 않고 창을 닫으면 사라집니다','작업 저장은 영상 반출이 아닙니다'):expect(dialog.locator('.kin-mip-voi-scope')).to_contain_text(text)
  self.voi_native(self.settled(v,self.apply_voi_case(v,dialog,oblique)),'MIP','Axial',record,voi)
  mark=self.mark(v);self.choose_mip(dialog,'Raysum','Coronal');state=self.job_final(v,mark,'Raysum','Coronal',worlds)
  self.voi_native(state,'Raysum','Coronal',record,voi);self.voi_pixels(state,cell,'before save')
  label='VOI Slab · On · '+mm_text(record['thickness'])+' mm · ';expect(summary).to_have_text(label+'Not Saved');self.assertEqual(posts,[])
  replay=v.evaluate(VOI_REPLAY,[oblique['preset'],list(oblique['center']),list(oblique['pivot']),oblique['thickness'],[list(r) for r in oblique['rotations']],oblique['move']])
  self.assertTrue(replay['fixed'],'precondition: the confirmed oblique normal is a fixed point of renormalization')
  display=v.evaluate(DISPLAY);self.assertEqual(display['cell'],{'voiRange':{'lower':voi[0],'upper':voi[1]},'interpolationType':0});self.assertEqual([display['actor'],display['mip']],[0,0])
  # Save MIP Job: exactly one POST, Saved only after it committed, the stored block is the confirmed display exactly.
  self.save_titled(dialog,'MIP oblique Raysum',label+'Saved');expect(status).to_contain_text('MIP 작업을 저장했습니다');self.assertEqual(len(posts),1)
  row,job=self.mip_job(a,'MIP oblique Raysum');body=json.loads(posts[0].post_data);saved=job['snapshot']
  self.assertEqual([row['snapshotVersion'],saved['version'],body['snapshot']['version']],[12,12,12])
  self.assertEqual(sorted(saved),['active','cells','cols','mip','rows','studies','version','volume']);self.assertEqual([saved['rows']*saved['cols'],len(saved['cells'])],[3,3])
  self.assertEqual(sorted(saved['mip']),['algorithm','coordinates','display','frameOfReference','mode','orientation','schema','voiSlab'])
  self.assertEqual([saved['mip'][k] for k in ('schema','algorithm','coordinates','mode','orientation')],[1,'kin-mip-1','LPS_mm','Raysum','Coronal'])
  self.assertEqual(field_differences(saved['mip'],body['snapshot']['mip']),[]);self.assertEqual(field_differences(saved['mip']['voiSlab'],replay['record']),[])
  self.assertEqual(field_differences(saved['cells'],body['snapshot']['cells']),[]);self.assertEqual(saved['volume']['sops'],body['snapshot']['volume']['sops'])
  active=saved['cells'][saved['active']]['properties'];self.assertEqual(saved['mip']['display'],{'voiRange':active['voiRange'],'interpolationType':active['interpolationType']})
  self.assertEqual(saved['mip']['display'],display['cell']);self.assertEqual(saved['mip']['frameOfReference'],v.evaluate(FRAME))
  self.assertFalse({'volumeId','affine','history','original','applied','pending','state','pixels'}&set(json_keys(saved)),json_keys(saved))
  # A changed display is Not Saved, Undo back to the saved record is Saved again, and closing an unsaved change sends nothing.
  mark=self.mark(v);self.voi_field(dialog,'Move').fill('2');self.voi_button(dialog,'Move Slab').click();self.job_final(v,mark,'Raysum','Coronal');expect(summary).to_have_text(label+'Not Saved')
  mark=self.mark(v);self.voi_button(dialog,'Undo VOI').click();self.voi_native(self.job_final(v,mark,'Raysum','Coronal',worlds),'Raysum','Coronal',record,voi);expect(summary).to_have_text(label+'Saved')
  mark=self.mark(v);self.voi_button(dialog,'Move Slab').click();self.job_final(v,mark,'Raysum','Coronal');expect(summary).to_have_text(label+'Not Saved')
  self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible();self.assertEqual(v.evaluate('()=>mipCount()'),0);self.assertEqual(len(posts),1)
  self.assertEqual(v.evaluate(SOURCE_PLANES),source,'saving and closing the MIP Viewer leave the MPR slab planes as they were')
  # With the dialog closed the Jobs panel is interactive again: the version 12 row is labelled as a reconstructed output and offers
  # Print Saved Images (A11-OUTPUT-1; the print itself is tested in test_volume_mip_output.py).
  jobs_panel=v.locator('#kin-viewer-jobs');expect(jobs_panel).to_contain_text('MIP Viewer · 저장 조건 재구성 출력 · 표시 전용 투영 작업')
  expect(jobs_panel.get_by_role('button',name='Restore Job',exact=True)).to_have_count(1);expect(jobs_panel.get_by_role('button',name='Print Saved Images',exact=True)).to_have_count(1)
  # Restore after changing the MPR: the success status appears only with the dialog's Final and its Saved state.
  self.project(v,1,2);self.assertEqual(v.evaluate(CAPTURE)['version'],4);v.evaluate(STATUS_WATCH);mark=self.mark(v)
  v.get_by_role('button',name='Restore Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('MIP 작업을 복원했습니다',timeout=90000)
  announced=[x for x in v.evaluate('()=>jobStatusStates') if 'MIP 작업을 복원했습니다' in x[0]];self.assertEqual(len(announced),1,announced)
  self.assertEqual(announced[0][1:],['final',label+'Saved'],'the success status follows the confirmed Final and its Saved state')
  transitions=v.evaluate('m=>mipTransitions.slice(m)',mark);self.assertIn('pending',transitions);self.assertEqual(transitions[-1],'final')
  v.evaluate(SETTLE);state=v.evaluate('p=>mipVoiState(p)',worlds);self.voi_native(state,'Raysum','Coronal',record,voi);self.voi_pixels(state,cell,'restored')
  for (origin,normal),(want_origin,want_normal) in zip(state['planes'][2:],voi_planes(saved['mip']['voiSlab'])):
   np.testing.assert_allclose(origin,want_origin,atol=1e-6,rtol=0);np.testing.assert_allclose(normal,want_normal,atol=1e-6,rtol=0)
  self.assertEqual(v.evaluate(DISPLAY),display);expect(summary).to_have_text(label+'Saved')
  slab=saved['mip']['voiSlab'];self.assertEqual(v.evaluate(EDITORS),{'center':slab['center'],'pivot':slab['pivot'],'thickness':slab['thickness'],'enable':True,'original':False,'preset':'Sagittal'})
  self.assertEqual(v.evaluate(REFUSED_CAPTURE),'다른 작업을 마친 뒤 MPR 방향을 조절하세요.');restored=v.evaluate(READ_ONLY_CAPTURE);self.assertEqual(restored['version'],12);self.assertEqual(field_differences(restored['mip'],saved['mip']),[]);self.assert_cells(restored['cells'],saved['cells'])
  mark=self.mark(v);self.voi_button(dialog,'Undo VOI').click();expect(status).to_contain_text('되돌릴 VOI Slab 변경이 없습니다');self.unchanged(v,mark);expect(self.voi_field(dialog,'Original')).not_to_be_checked()
  self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible();self.assertEqual(len(posts),1)
  # A new browser restores the same display, pixels, editors and MPR cameras.
  fresh=self.login();self.launch(fresh,[a]);self.ready(fresh);fresh.evaluate(HELPERS)
  fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('MIP 작업을 복원했습니다',timeout=90000)
  fresh_dialog=fresh.locator('#kin-volume-mip');expect(fresh_dialog).to_have_attribute('data-kin-mip-state','final');fresh.evaluate(VOI_HELPERS);fresh.evaluate(SETTLE)
  state=fresh.evaluate('p=>mipVoiState(p)',worlds);self.voi_native(state,'Raysum','Coronal',record,voi);self.voi_pixels(state,cell,'new browser')
  expect(fresh_dialog.locator('.kin-mip-voi-state')).to_have_text(label+'Saved');self.assertEqual(fresh.evaluate(EDITORS)['center'],slab['center'])
  again=fresh.evaluate(READ_ONLY_CAPTURE);self.assertEqual(field_differences(again['mip'],saved['mip']),[]);self.assert_cells(again['cells'],saved['cells'])
  fresh_dialog.get_by_role('button',name='Close MIP Viewer',exact=True).click();expect(fresh_dialog).not_to_be_visible()
  # A VOI-off MinIP x Sagittal Job restores two slab planes and the unclipped known-voxel values.
  dialog=self.open_voi(v);mark=self.mark(v);self.choose_mip(dialog,'MinIP','Sagittal');state=self.job_final(v,mark,'MinIP','Sagittal',off_worlds)
  self.voi_native(state,'MinIP','Sagittal',None,voi);self.voi_pixels(state,off_cell,'VOI off','unclipped')
  expect(summary).to_have_text('VOI Slab · Off · Not Saved');self.save_titled(dialog,'MIP off MinIP','VOI Slab · Off · Saved');self.assertEqual(len(posts),2)
  _,off_job=self.mip_job(a,'MIP off MinIP');self.assertIsNone(off_job['snapshot']['mip']['voiSlab']);self.assertEqual([off_job['snapshot']['mip']['mode'],off_job['snapshot']['mip']['orientation']],['MinIP','Sagittal'])
  self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible()
  self.restore_titled(v,a,'MIP off MinIP');expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('MIP 작업을 복원했습니다',timeout=90000)
  expect(dialog).to_have_attribute('data-kin-mip-state','final');v.evaluate(SETTLE);state=v.evaluate('p=>mipVoiState(p)',off_worlds)
  self.voi_native(state,'MinIP','Sagittal',None,voi);self.voi_pixels(state,off_cell,'VOI off restored','unclipped');expect(summary).to_have_text('VOI Slab · Off · Saved')
  self.assertEqual(v.evaluate(EDITORS)['enable'],False);self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible()
  expect(p.locator('#findings')).to_have_value('KEEP MIP JOB REPORT');self.assertEqual(len(self.versions(a)),1);self.assertEqual(self.originals(),original);self.assertEqual(len(posts),2)
  print('MIP_JOB_SAVED',json.dumps({'mip':saved['mip'],'replay':replay['record'],'source_planes':len(source)}),flush=True)

 def test_mip_job_02_save_gates_failure_unconfirmed_retry_roles_account(self):
  study,intercept,voi=VOI_STUDIES[1];_,perpendicular,_=VOI_CASES;rB=voi_record(perpendicular)
  a,p,v=self.opened_voi_study(intercept,voi);original=self.originals()
  posts=[];v.on('request',lambda r:posts.append(r) if job_post(a.uid)(r) else None)
  dialog=self.open_voi(v);summary,status,note=dialog.locator('.kin-mip-voi-state'),dialog.locator('[role=status]'),dialog.locator('.kin-mip-job-note')
  save,retry,title=dialog.get_by_role('button',name='Save MIP Job',exact=True),dialog.get_by_role('button',name='Retry MIP Save',exact=True),dialog.get_by_label('MIP Job Title',exact=True)
  label='VOI Slab · On · '+mm_text(rB['thickness'])+' mm · ';expect(retry).to_be_disabled()
  self.voi_native(self.settled(v,self.apply_voi_case(v,dialog,perpendicular)),'MIP','Axial',rB,voi)
  save.click();expect(status).to_contain_text('MIP Job Title을 입력하세요');self.assertEqual(posts,[])
  # A held render is not a Final display, and Original view is not the display a restore would show.
  title.fill('MIP gates');v.evaluate('()=>{mipHold=true;mipHeldFrames=0}');mark=self.mark(v);self.voi_button(dialog,'Reset VOI').click();v.wait_for_function('()=>mipHeldFrames>0')
  expect(dialog).to_have_attribute('data-kin-mip-state','pending');save.click();expect(status).to_contain_text('최종 표시를 확인한 뒤 MIP 작업을 저장하세요');self.assertEqual(posts,[])
  v.evaluate('()=>{mipHold=false;mipView().render()}');self.voi_native(self.settled(v,mark),'MIP','Axial',None,voi)
  mark=self.mark(v);self.voi_button(dialog,'Undo VOI').click();self.voi_native(self.settled(v,mark),'MIP','Axial',rB,voi)
  mark=self.mark(v);self.voi_field(dialog,'Original').check();self.settled(v,mark);save.click();expect(status).to_contain_text('Original 보기를 끈 뒤 저장하세요')
  mark=self.mark(v);self.voi_field(dialog,'Original').uncheck();self.settled(v,mark);self.assertEqual(posts,[])
  # 3D marks beside a MIP display are refused by name; a non-radiologist account cannot save (button and server).
  v.evaluate("()=>{window.heldMarks=window.kinMprMarks;window.kinMprMarks={...(heldMarks||{}),dirty:heldMarks?.dirty||(()=>false),capture:readOnly=>({...(heldMarks?.capture?.(readOnly)||{version:1,visible:true,sync:true}),marks:[{id:'synthetic-mark'}]})}}")
  save.click();expect(status).to_contain_text('MIP 작업은 단면 묶음·3D 표식과 함께 저장할 수 없습니다')
  v.evaluate('()=>{if(heldMarks)window.kinMprMarks=heldMarks;else delete window.kinMprMarks}');self.assertEqual(posts,[])
  v.evaluate('()=>{window.heldCommand=window.kinViewerJobCommand;window.kinViewerJobCommand={...heldCommand,writable:()=>false}}')
  expect(save).to_be_disabled(timeout=5000);expect(note).to_contain_text('판독의 계정에서 MIP 작업을 저장할 수 있습니다');v.evaluate('()=>{window.kinViewerJobCommand=heldCommand}');expect(save).to_be_enabled(timeout=5000)
  # A 4xx is Not Saved and clears the kept body.
  def rejected(route):
   if route.request.method=='POST':route.fulfill(status=400,content_type='application/json',body=json.dumps({'message':'INJECTED MIP 400'}))
   else:route.continue_()
  v.route(JOBS,rejected);save.click();expect(status).to_contain_text('INJECTED MIP 400');expect(summary).to_have_text(label+'Not Saved');v.unroute(JOBS,rejected)
  self.assertEqual(self.jobs(a),[]);expect(retry).to_be_disabled();expect(title).to_have_value('MIP gates')
  # A receipt lost after the server committed is Save Unconfirmed; Retry MIP Save replays the same body once, and only while
  # the same block is shown.
  def lost(route):
   if route.request.method=='POST':route.fetch();route.abort()
   else:route.continue_()
  v.route(JOBS,lost);save.click();expect(summary).to_have_text(label+'Save Unconfirmed · Retry MIP Save',timeout=45000);expect(status).to_contain_text('Retry MIP Save로 같은 요청을 다시 보내세요')
  v.unroute(JOBS,lost);self.assertEqual(len(self.jobs(a)),1);expect(retry).to_be_enabled(timeout=5000)
  self.voi_field(dialog,'Move').fill('1');mark=self.mark(v);self.voi_button(dialog,'Move Slab').click();self.settled(v,mark);expect(summary).to_contain_text('· Not Saved');expect(retry).to_be_disabled(timeout=5000)
  save.click();expect(status).to_contain_text('Retry Request로 먼저 확인하세요')
  mark=self.mark(v);self.voi_button(dialog,'Undo VOI').click();self.settled(v,mark);expect(summary).to_have_text(label+'Save Unconfirmed · Retry MIP Save');expect(retry).to_be_enabled(timeout=5000)
  save.click();expect(status).to_contain_text('Retry MIP Save로 확인하세요')
  retry.click();expect(summary).to_have_text(label+'Saved',timeout=45000);expect(status).to_contain_text('MIP 작업을 저장했습니다');self.assertEqual(len(self.jobs(a)),1)
  # A 5xx is Save Unconfirmed too; the retry then creates the one Job.
  self.voi_field(dialog,'Move').fill('1');mark=self.mark(v);self.voi_button(dialog,'Move Slab').click();self.settled(v,mark);expect(summary).to_contain_text('· Not Saved')
  def unavailable(route):
   if route.request.method=='POST':route.fulfill(status=503,content_type='application/json',body=json.dumps({'message':'INJECTED MIP 503'}))
   else:route.continue_()
  v.route(JOBS,unavailable);title.fill('MIP moved');save.click();expect(summary).to_contain_text('· Save Unconfirmed · Retry MIP Save',timeout=45000);v.unroute(JOBS,unavailable)
  self.assertEqual(len(self.jobs(a)),1);retry.click();expect(summary).to_contain_text('· Saved',timeout=45000);self.assertEqual(len(self.jobs(a)),2)
  # A list refresh failure after the commit keeps Saved with a refresh notice.
  self.voi_field(dialog,'Move').fill('1');mark=self.mark(v);self.voi_button(dialog,'Move Slab').click();self.settled(v,mark);expect(summary).to_contain_text('· Not Saved')
  failed=[]
  def list_once(route):
   if route.request.method=='GET' and 'mine=' in route.request.url and not failed:failed.append(route.request.url);route.fulfill(status=500,content_type='application/json',body=json.dumps({'message':'INJECTED LIST 500'}))
   else:route.continue_()
  v.route(JOBS,list_once);title.fill('MIP list failure');save.click();expect(summary).to_contain_text('· Saved',timeout=45000);expect(status).to_contain_text('작업 목록을 새로 고치지 못했습니다')
  v.unroute(JOBS,list_once);self.assertEqual(len(failed),1);self.assertEqual(len(self.jobs(a)),3)
  # After a save a changed display is Not Saved; close and reopen shows no VOI Slab and sends nothing.
  count=len(posts);self.voi_field(dialog,'Move').fill('1');mark=self.mark(v);self.voi_button(dialog,'Move Slab').click();self.settled(v,mark);expect(summary).to_contain_text('· Not Saved')
  self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible();dialog=self.open_voi(v);expect(summary).to_have_text('VOI Slab · Off · Not Saved');expect(title).to_have_value('');self.assertEqual(len(posts),count)
  # A replaced source closes the viewer before any request.
  self.settled(v,self.apply_voi_case(v,dialog,perpendicular));title.fill('MIP replaced source')
  v.evaluate("()=>{window.mipSource=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);window.mipVolumeId=mipSource.getVolumeId;mipSource.getVolumeId=()=>'replaced-volume';[...document.querySelectorAll('#kin-volume-mip button')].find(b=>b.textContent==='Save MIP Job').click()}")
  expect(dialog).not_to_be_visible();v.evaluate('()=>{mipSource.getVolumeId=mipVolumeId}');self.assertEqual(len(posts),count)
  # Forged snapshots and a non-radiologist are refused by the server; nothing is stored.
  jobs_before=len(self.jobs(a));base=copy.deepcopy(self.mip_job(a,'MIP gates')[1]['snapshot']);del base['volume']['sourceDigest']
  def forged(change,user='doctor'):
   s=copy.deepcopy(base);change(s);return self.stack.request('POST',f'/studies/{a.uid}/viewer-jobs',user,{'id':str(uuid.uuid4()),'title':'Forged MIP','description':'','snapshot':s}).status
  for name,change in (('history key',lambda s:s['mip'].__setitem__('history',[])),('non-unit normal',lambda s:s['mip']['voiSlab'].__setitem__('normal',[n*1.001 for n in s['mip']['voiSlab']['normal']])),
                      ('frame of reference mismatch',lambda s:s['mip'].__setitem__('frameOfReference','2.25.1234')),('slab outside',lambda s:s['mip']['voiSlab'].__setitem__('center',[-500.0,-500.0,-500.0])),
                      ('display mismatch',lambda s:s['mip']['display']['voiRange'].__setitem__('lower',s['mip']['display']['voiRange']['lower']+1))):
   self.assertEqual(forged(change),400,name)
  self.assertEqual(forged(lambda s:None,'tech'),403);self.assertEqual(len(self.jobs(a)),jobs_before)
  # A session ended while the POST is held closes the viewer and never shows Saved.
  dialog=self.open_voi(v);self.settled(v,self.apply_voi_case(v,dialog,perpendicular));title.fill('MIP held session')
  held=[]
  def hold(route):
   if route.request.method=='POST':held.append(route)
   else:route.continue_()
  v.route(JOBS,hold);save.click()
  for _ in range(100):
   if held:break
   v.wait_for_timeout(100)
  self.assertEqual(len(held),1);expect(summary).to_contain_text('· Saving')
  # While the save is in flight the existing busy gate refuses a display change; nothing reaches the native viewer.
  mark=self.mark(v);self.choose_mip(dialog,'MinIP');expect(status).to_contain_text('영상 작업 처리가 끝난 뒤');self.unchanged(v,mark)
  expect(dialog.get_by_label('MIP Projection',exact=True)).to_have_value('MIP')
  # Session end disposes the MPR tools and the MIP Viewer with them, which closes its dialog and removes it from the page
  # (viewer-volume-mip.js dispose), so the VOI Slab summary the reader saw is held by reference and read after the POST ends.
  self.assertTrue(v.evaluate("()=>!!(window.mipHeldSummary=document.querySelector('#kin-volume-mip .kin-mip-voi-state'))"));v.evaluate(SESSION_END)
  expect(v.locator('#kin-volume-mip[open]')).to_have_count(0,timeout=10000);expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('세션이 변경되었습니다')
  try:held[0].abort()
  except Exception:pass
  v.wait_for_timeout(500);expect(v.locator('#kin-volume-mip[open]')).to_have_count(0);self.assertNotIn('Saved',v.evaluate('()=>mipHeldSummary.textContent'))
  self.assertNotIn('저장했습니다',v.locator('#kin-viewer-jobs-status').text_content())
  self.assertEqual(len(self.jobs(a)),jobs_before);self.assertEqual(self.originals(),original)

 def test_mip_job_03_restore_failure_missing_tool_cancel_stale_rollback(self):
  study,intercept,voi=VOI_STUDIES[0];_,perpendicular,_=VOI_CASES;rB=voi_record(perpendicular)
  a,p,v=self.opened_voi_study(intercept,voi);original=self.originals()
  dialog=self.open_voi(v);self.voi_native(self.settled(v,self.apply_voi_case(v,dialog,perpendicular)),'MIP','Axial',rB,voi)
  self.save_titled(dialog,'MIP VOI job','VOI Slab · On · '+mm_text(rB['thickness'])+' mm · Saved')
  mark=self.mark(v);self.voi_button(dialog,'Reset VOI').click();self.settled(v,mark);mark=self.mark(v);self.choose_mip(dialog,'MinIP');self.job_final(v,mark,'MinIP','Axial')
  self.save_titled(dialog,'MIP off job','VOI Slab · Off · Saved');self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible()
  self.project(v,1,2);previous=v.evaluate(CAPTURE);self.assertEqual(previous['version'],4);status=v.locator('#kin-viewer-jobs-status')
  # A clipping-plane write failure and a GPU clip program mismatch inside the restore roll back to the previous screen.
  for fault,message,step in ((PLANE_FAULT,'INJECTED MIP JOB PLANE WRITE','writeVoi'),(GPU_FAULT,'투영 셰이더를 GPU에서 확인하지 못했습니다','gpuProblem')):
   mark=self.mark(v);self.assertTrue(v.evaluate(fault),'fault not installed: '+message);self.restore_titled(v,a,'MIP VOI job');self.rolled_back(v,message,previous)
   self.assertEqual(v.evaluate('s=>mipFault.map(t=>t.stack.includes(s))',step),[True],message);self.assertNotIn('final',v.evaluate('m=>mipTransitions.slice(m)',mark));self.assertEqual(v.evaluate('()=>mipCount()'),0)
  # A plane W/L changed between the MPR restore and the MIP step is not the saved display: refused with rollback.
  mark=self.mark(v)
  self.assertTrue(v.evaluate("""()=>{const job=window.kinVolumeMipJob,real=job.restore;window.mipDisplayFault=0;
   job.restore=async function(...args){job.restore=real;const vp=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId),r=vp.getProperties().voiRange;
    vp.setProperties({voiRange:{lower:r.lower+50,upper:r.upper}});mipDisplayFault++;return real.apply(this,args)};return job.restore!==real}"""),'fault not installed: display mismatch')
  self.restore_titled(v,a,'MIP VOI job');self.rolled_back(v,'밝기 범위·보간이 복원한 MPR 평면과 달라',previous)
  self.assertEqual(v.evaluate('()=>mipDisplayFault'),1);self.assertNotIn('final',v.evaluate('m=>mipTransitions.slice(m)',mark));self.assertEqual(v.evaluate('()=>mipCount()'),0)
  # A render that never confirms times out inside the Job deadline and rolls back.
  v.evaluate('()=>{mipHold=true;mipHeldFrames=0}');mark=self.mark(v);self.restore_titled(v,a,'MIP VOI job');v.wait_for_function('()=>mipHeldFrames>0',timeout=60000)
  self.rolled_back(v,'최종 렌더를 확인하지 못했습니다',previous);v.evaluate('()=>{mipHold=false}');v.wait_for_timeout(500);self.assertNotIn('final',v.evaluate('m=>mipTransitions.slice(m)',mark))
  # Close MIP Viewer and Escape cancel the restore well before that timeout. The rollback proves the cancel left the restore
  # ticket current (it runs only while serial === ticket), and a released render announces no Final.
  for how in ('close','escape'):
   v.evaluate('()=>{mipHold=true;mipHeldFrames=0}');mark=self.mark(v);self.restore_titled(v,a,'MIP VOI job');v.wait_for_function('()=>mipHeldFrames>0',timeout=60000)
   expect(dialog).to_have_attribute('data-kin-mip-state','pending');started=time.monotonic()
   if how=='close':self.voi_button(dialog,'Close MIP Viewer').click()
   else:self.voi_button(dialog,'Close MIP Viewer').focus();v.keyboard.press('Escape')
   expect(status).to_contain_text('MIP 작업 복원을 취소했습니다',timeout=10000);self.assertLess(time.monotonic()-started,10,how)
   self.rolled_back(v,'MIP 작업 복원을 취소했습니다',previous);self.assertEqual(v.evaluate('()=>mipCount()'),0)
   v.evaluate('()=>{mipHold=false}');v.wait_for_timeout(500);self.assertNotIn('final',v.evaluate('m=>mipTransitions.slice(m)',mark),how)
  # A session ended during the MIP restore step closes the viewer without a success status.
  v.evaluate('()=>{mipHold=true;mipHeldFrames=0}');mark=self.mark(v);self.restore_titled(v,a,'MIP VOI job');v.wait_for_function('()=>mipHeldFrames>0',timeout=60000);v.evaluate(SESSION_END)
  expect(v.locator('#kin-volume-mip[open]')).to_have_count(0,timeout=10000);v.evaluate('()=>{mipHold=false}');v.wait_for_timeout(500)
  self.assertNotIn('복원했습니다',status.text_content());self.assertNotIn('final',v.evaluate('m=>mipTransitions.slice(m)',mark))
  # A missing MIP Viewer module on a fresh page refuses and rolls back; nothing is created.
  fresh=self.login();fresh.route('**/viewer-volume-mip.js',lambda route:route.abort());self.launch(fresh,[a]);self.ready(fresh);before=fresh.evaluate(LAYOUT)
  self.restore_titled(fresh,a,'MIP VOI job');expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('MIP Viewer 도구를 불러오지 못해',timeout=90000)
  expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('이전 화면');expect(fresh.locator('#kin-volume-mip')).to_have_count(0);self.assertEqual(fresh.evaluate(LAYOUT),before)
  # Without the VOI Slab tool a VOI Job is refused with rollback, while a VOI-off Job restores.
  other=self.login();other.route('**/volume-voi.js',lambda route:route.abort());self.launch(other,[a]);self.ready(other);before=other.evaluate(LAYOUT)
  self.restore_titled(other,a,'MIP VOI job');expect(other.locator('#kin-viewer-jobs-status')).to_contain_text('VOI Slab 도구를 확인할 수 없어 MIP 작업을 복원하지 않았습니다',timeout=90000)
  expect(other.locator('#kin-viewer-jobs-status')).to_contain_text('이전 화면');expect(other.locator('#kin-volume-mip[open]')).to_have_count(0);self.assertEqual(other.evaluate(LAYOUT),before)
  self.restore_titled(other,a,'MIP off job');expect(other.locator('#kin-viewer-jobs-status')).to_contain_text('MIP 작업을 복원했습니다',timeout=90000)
  shown=other.evaluate(MIP_LIGHT);self.assertEqual([shown['open'],shown['state'],shown['planes'],shown['voi']],[True,'final',2,'VOI Slab · Off · Saved']);self.assertIn('VOI Slab 도구를 확인할 수 없어',shown['note'])
  # A series changed after the save is refused by the server (409) before any layout change; the MIP never opens.
  from pydicom import dcmread
  stale=self.login();self.launch(stale,[a]);self.ready(stale);before=stale.evaluate(LAYOUT)
  # One more slice at the next 2.5 mm position: the saved sops no longer describe the whole original series.
  d=dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/'+self.stack.first_instance_id(a.uid)+'/file')));self.assertEqual(str(d.StudyInstanceUID),a.uid)
  d.SOPInstanceUID=d.file_meta.MediaStorageSOPInstanceUID=ct.generate_uid();d.InstanceNumber=34;d.ImagePositionPatient=[0,0,33*2.5];d.SliceLocation=33*2.5
  ae=ct.AE(ae_title='HALLYM_CT');ae.add_requested_context(ct.CTImageStorage,ct.ExplicitVRLittleEndian);assoc=ae.associate('127.0.0.1',4242,ae_title='KINLAB')
  try:self.assertTrue(assoc.is_established);self.assertEqual(assoc.send_c_store(d).Status,0)
  finally:assoc.release()
  row=next(r for r in self.jobs(a) if r['title']=='MIP VOI job');self.assertEqual(self.stack.request('GET',f'/studies/{a.uid}/viewer-jobs/{row["id"]}','doctor').status,409)
  self.restore_titled(stale,a,'MIP VOI job');expect(stale.locator('#kin-viewer-jobs-status')).to_contain_text('저장 당시 볼륨 원본과 달라 복원하지 않았습니다',timeout=90000)
  expect(stale.locator('#kin-volume-mip')).to_have_count(0);self.assertEqual(stale.evaluate(LAYOUT),before);self.assertEqual(len(self.versions(a)),1)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeMipJobE2E(n) for n in MIP_JOB_CASES)
if __name__=='__main__':unittest.main(verbosity=2)
