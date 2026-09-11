# coding: utf-8
"""TEST-MPR-MARKS: patient-coordinate points, retained drafts and source-bound Jobs."""
import copy,json,os,unittest,uuid
from pathlib import Path
from playwright.sync_api import expect
from test_volume_sync import VolumeSyncE2E

class VolumeMarksE2E(VolumeSyncE2E):
 def same_marks(self,actual,expected):
  actual=copy.deepcopy(actual);expected=copy.deepcopy(expected);self.assertEqual(len(actual['marks']),len(expected['marks']))
  for left,right in zip(actual['marks'],expected['marks']):
   self.assertEqual(len(left['point']),3)
   for a,b in zip(left['point'],right['point']):self.assertAlmostEqual(a,b,delta=1e-10)
   left['point']=right['point']
  self.assertEqual(actual,expected)
 def marks(self,v):
  panel=v.locator('#kin-mpr-marks');expect(panel).to_be_visible();return panel
 def add_mark(self,v,label='Manual test point',point=(32,32,16)):
  panel=self.marks(v);panel.get_by_label('MPR annotation label',exact=True).fill(label);panel.get_by_role('button',name='Pick Point',exact=True).click()
  xy=v.evaluate('point=>{const xy=projectionVP.worldToCanvas(point),r=projectionVP.element.getBoundingClientRect();return [xy[0]+r.left,xy[1]+r.top]}',list(point));v.mouse.click(*xy);expect(panel.locator('[role=status]')).to_contain_text('추가했습니다');return v.evaluate('()=>kinMprMarks.capture()')
 def test_marks_01_point_display_offset_sync_and_edit(self):
  a,p,v=self.starting();before=self.volume_state(v);marks=self.add_mark(v);self.preserved_volume(before,self.volume_state(v));self.assertEqual(len(marks['marks']),1)
  for a1,b1 in zip(marks['marks'][0]['point'],[32,32,16]):self.assertAlmostEqual(a1,b1,delta=.2)
  panel=self.marks(v);expect(v.locator('.kin-mpr-marks-overlay [data-mark-id]')).to_have_count(3)
  v.evaluate('()=>{const c=projectionVP.getCamera(),d=c.viewPlaneNormal.map(n=>n*5);projectionVP.setCamera({focalPoint:c.focalPoint.map((n,i)=>n+d[i]),position:c.position.map((n,i)=>n+d[i])});projectionVP.render()}');expect(v.locator('.kin-mpr-marks-overlay [data-mark-id]').first).to_contain_text('off plane')
  panel.get_by_label('Sync 3D Annotation',exact=True).uncheck();shifted=self.volume_state(v);panel.get_by_role('button',name='Go to Point',exact=True).click();after=self.volume_state(v);self.assertEqual(shifted[1:],after[1:]);expect(v.locator('.kin-mpr-marks-overlay [data-mark-id]').first).to_contain_text('On plane')
  panel.get_by_role('button',name='Edit Annotation',exact=True).click();panel.get_by_label('MPR annotation label',exact=True).fill('<Manual edited>');panel.get_by_role('button',name='Update Label',exact=True).click();expect(v.locator('.kin-mpr-marks-overlay [data-mark-id]').first).to_contain_text('<Manual edited>');panel.get_by_label('Show Annotations',exact=True).uncheck();expect(v.locator('.kin-mpr-marks-overlay').first).to_be_hidden()
 def test_marks_02_job_and_new_browser_restore_full_volume(self):
  a,p,v=self.starting();original=self.originals();p.locator('#findings').fill('KEEP 3D REPORT');marks=self.add_mark(v);self.marks(v).get_by_label('Sync 3D Annotation',exact=True).uncheck();self.marks(v).get_by_label('Show Annotations',exact=True).uncheck();marks=v.evaluate('()=>kinMprMarks.capture()');self.save_volume(v);self.assertFalse(v.evaluate('()=>kinMprMarks.dirty()'));job=self.get_volume_job(a);self.assertEqual(job['snapshot']['version'],6);self.same_marks(job['snapshot']['marks'],marks);self.assertEqual(len(job['snapshot']['volume']['sops']),33);self.assertEqual(len(job['snapshot']['volume']['sourceDigest']),64)
  fresh=self.login();self.launch(fresh,[a]);self.ready(fresh);fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000);expect(self.marks(fresh).get_by_label('Sync 3D Annotation',exact=True)).not_to_be_checked();expect(self.marks(fresh).get_by_label('Show Annotations',exact=True)).not_to_be_checked();self.same_marks(fresh.evaluate('()=>kinMprMarks.capture()'),marks);self.assertFalse(fresh.evaluate('()=>kinMprMarks.dirty()'));expect(fresh.locator('.kin-mpr-marks-overlay [data-mark-id]')).to_have_count(3);expect(fresh.get_by_role('button',name='Print Saved Images',exact=True)).to_have_count(1)
  expect(p.locator('#findings')).to_have_value('KEEP 3D REPORT');self.assertEqual(self.originals(),original)
  v.get_by_role('button',name='Print Current View',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('현재 3D 표식은 Save New Job으로 저장한 뒤')
  if os.environ.get('KIN_EVIDENCE_DIR'):fresh.screenshot(path=str(Path(os.environ['KIN_EVIDENCE_DIR'])/'mpr-marks.png'))
 def test_marks_03_dirty_unload_restore_and_revert(self):
  a,p,v=self.starting();self.save_volume(v);self.add_mark(v);panel=self.marks(v)
  self.assertTrue(v.evaluate('()=>{const e=new Event("beforeunload",{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented}'));self.assertTrue(v.evaluate('()=>kinViewerJobWorkspaceState().dirty'))
  v.get_by_role('button',name='Restore Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('미저장 표식');self.assertEqual(len(v.evaluate('()=>kinMprMarks.capture().marks')),1)
  panel.get_by_role('button',name='Revert All Unsaved Annotations',exact=True).click();self.assertFalse(v.evaluate('()=>kinMprMarks.dirty()'));expect(v.locator('.kin-mpr-marks-overlay [data-mark-id]')).to_have_count(0)
 def test_marks_04_server_rejects_forged_bounds_and_roles(self):
  a,p,v=self.starting();self.add_mark(v);snapshot=v.evaluate('()=>kinCreateVolumeJob({grid:services.viewportGridService,cs:services.cornerstoneViewportService,ds:services.displaySetService,studies:new URLSearchParams(location.search).get("StudyInstanceUIDs").split(",")}).capture()')
  for edit in [lambda s:s['marks']['marks'][0].update(point=[1e6,1e6,1e6]),lambda s:s['marks']['marks'][0].update(sop='2.25.9'),lambda s:s['marks']['marks'].append(copy.deepcopy(s['marks']['marks'][0])),lambda s:s['volume']['sops'].pop()]:
   forged=copy.deepcopy(snapshot);edit(forged);r=self.stack.request('POST',f'/studies/{a.uid}/viewer-jobs','doctor',dict(id=str(uuid.uuid4()),title='Invalid manual',description='',snapshot=forged));self.assertEqual(r.status,400,r.text)
  r=self.stack.request('POST',f'/studies/{a.uid}/viewer-jobs','tech',dict(id=str(uuid.uuid4()),title='Denied manual',description='',snapshot=snapshot));self.assertEqual(r.status,403,r.text);self.assertEqual(self.jobs(a),[]);self.assertTrue(v.evaluate('()=>kinMprMarks.dirty()'))

 def test_marks_05_lost_receipt_retains_dirty_then_retry_acknowledges(self):
  a,p,v=self.starting();marks=self.add_mark(v);v.get_by_label('Job Title',exact=True).fill('Manual receipt retry');pattern='**/api/studies/*/viewer-jobs'
  def lost(route):
   if route.request.method=='POST':route.fetch();route.abort()
   else:route.continue_()
  v.route(pattern,lost);v.get_by_role('button',name='Save New Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('입력은 유지',timeout=45000);self.assertEqual(len(self.jobs(a)),1);self.assertTrue(v.evaluate('()=>kinMprMarks.dirty()'));self.same_marks(v.evaluate('()=>kinMprMarks.capture()'),marks);v.unroute(pattern,lost)
  v.get_by_role('button',name='Retry Request',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('저장했습니다',timeout=45000);self.assertEqual(len(self.jobs(a)),1);self.assertFalse(v.evaluate('()=>kinMprMarks.dirty()'))
 def test_marks_06_remove_last_point_saves_empty_job_and_clears_dirty(self):
  a,p,v=self.starting();marks=self.add_mark(v);self.save_volume(v);original=self.get_volume_job(a);self.marks(v).get_by_role('button',name='Remove Annotation',exact=True).click();self.assertTrue(v.evaluate('()=>kinMprMarks.dirty()'));self.save_volume(v);self.assertFalse(v.evaluate('()=>kinMprMarks.dirty()'));self.assertEqual(len(self.jobs(a)),2)
  old=self.stack.request('GET',f'/studies/{a.uid}/viewer-jobs/{original["id"]}','doctor');self.assertEqual(old.status,200);self.same_marks(old.body['snapshot']['marks'],marks);expect(v.locator('.kin-mpr-marks-overlay [data-mark-id]')).to_have_count(0)
 def test_marks_07_partial_restore_rolls_back_annotations_and_pixels(self):
  a,p,v=self.starting();self.add_mark(v);self.save_volume(v);v.evaluate('()=>{kinMprMarks.restore({version:1,visible:true,sync:true,marks:[]});const restore=kinMprMarks.restore;let once=true;kinMprMarks.restore=function(value){restore(value);if(once){once=false;throw Error("MARK RESTORE FAILURE")}}}');before=self.volume_state(v)
  v.get_by_role('button',name='Restore Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('이전 화면',timeout=45000);expect(v.locator('.kin-mpr-marks-overlay [data-mark-id]')).to_have_count(0);self.assertFalse(v.evaluate('()=>kinMprMarks.dirty()'));self.assertEqual([(x['hash'],x['min'],x['max']) for x in before],[(x['hash'],x['min'],x['max']) for x in self.volume_state(v)])
 def test_marks_08_session_end_removes_mark_surfaces_and_rejects_old_capability(self):
  a,p,v=self.starting();self.add_mark(v);v.evaluate('()=>{window.oldMarks=kinMprMarks;window.dispatchEvent(new StorageEvent("storage",{key:"kin-session-ended",newValue:"test"}))}');expect(v.locator('.kin-mpr-marks-overlay')).to_have_count(0);self.assertTrue(v.evaluate('()=>{try{oldMarks.capture();return false}catch(_){return true}}'))
 def test_marks_09_layout_change_retains_unsaved_points(self):
  a,p,v=self.starting();marks=self.add_mark(v);v.evaluate('()=>{window.beforeMarksCapability=kinMprMarks}')
  v.locator('[data-cy=Layout]').click();v.locator('[data-cy=Layout-0-0]').click()
  expect(v.locator('.kin-mpr-marks-overlay')).to_have_count(0);self.assertTrue(v.evaluate('()=>kinMprMarks.dirty()'));self.mpr(v);self.choose_volume(v,v,0)
  expect(v.locator('.kin-mpr-marks-overlay [data-mark-id]')).to_have_count(3);self.same_marks(v.evaluate('()=>kinMprMarks.capture()'),marks);self.assertTrue(v.evaluate('()=>kinMprMarks.dirty()'))
 def test_marks_10_full_source_change_and_parent_roles_remain_enforced(self):
  from test_volume_jobs import VolumeJobsE2E
  save=self.save_volume
  self.save_volume=lambda v:(self.add_mark(v),save(v))
  VolumeJobsE2E.test_volume_job_04_parent_permission_and_changed_series(self)

 def test_marks_11_marker_geometry_long_label_and_sync_center(self):
  a,p,v=self.starting();marks=self.add_mark(v,'Manual point '+('Long label '*13));self.rotate_planes(v,0,25);self.rotate_planes(v,1,-35)
  v.evaluate('()=>{for(const id of services.viewportGridService.getState().viewports.keys()){const view=services.cornerstoneViewportService.getCornerstoneViewport(id),c=view.getCamera(),d=c.viewPlaneNormal.map(n=>n*3);view.setCamera({focalPoint:c.focalPoint.map((n,i)=>n+d[i]),position:c.position.map((n,i)=>n+d[i])});view.render()}}');self.marks(v).get_by_role('button',name='Go to Point',exact=True).click()
  actual=v.evaluate('()=>{const p=kinMprMarks.capture().marks[0].point;return [...services.viewportGridService.getState().viewports.keys()].map(id=>{const view=services.cornerstoneViewportService.getCornerstoneViewport(id),xy=view.worldToCanvas(p),root=view.element.getBoundingClientRect(),point=view.element.querySelector("[data-kin-mpr-mark-point]").getBoundingClientRect(),label=view.element.querySelector("[data-mark-id]").getBoundingClientRect();return {focal:view.getCamera().focalPoint,want:p,xy,actual:[point.x+point.width/2-root.x,point.y+point.height/2-root.y],inside:label.left>=root.left&&label.right<=root.right&&label.top>=root.top&&label.bottom<=root.bottom}}) }')
  for row in actual:
   self.assertTrue(row['inside'])
   for got,want in zip(row['actual'],row['xy']):self.assertAlmostEqual(got,want,delta=.1)
   for got,want in zip(row['focal'],row['want']):self.assertAlmostEqual(got,want,delta=1e-6)
  if os.environ.get('KIN_EVIDENCE_DIR'):v.screenshot(path=str(Path(os.environ['KIN_EVIDENCE_DIR'])/'mpr-marks-long-label.png'))
 def test_marks_12_legacy_jobs_clear_marks_without_target_dependency(self):
  from test_volume_batch import VolumeBatchE2E
  a,p,v=self.starting();self.save_volume(v);plain=self.get_volume_job(a);VolumeBatchE2E.make_batch(self,v);self.save_volume(v)
  jobs=self.jobs(a);batch=next(j for j in jobs if j['id']!=plain['id']);fresh=self.login();self.launch(fresh,[a]);self.ready(fresh)
  fresh.evaluate('()=>{kinMprMarks.restore=()=>{throw Error("OLD JOB MUST NOT RESTORE MARKS")}}')
  for uid in [batch['id'],plain['id']]:
   index=next(i for i,j in enumerate(jobs) if j['id']==uid);fresh.get_by_role('button',name='Restore Job',exact=True).nth(index).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=60000);self.assertEqual(fresh.evaluate('()=>kinMprMarks.capture().marks'),[]);self.choose_volume(fresh,fresh,1)
 def test_marks_13_ui_server_rejection_keeps_points_and_allows_new_save(self):
  a,p,v=self.starting();marks=self.add_mark(v);v.get_by_label('Job Title',exact=True).fill('Rejected manual save');pattern='**/api/studies/*/viewer-jobs'
  def reject(route):
   if route.request.method=='POST':route.fulfill(status=400,content_type='application/json',body=json.dumps({'message':'Synthetic rejection'}))
   else:route.continue_()
  v.route(pattern,reject);v.get_by_role('button',name='Save New Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('Synthetic rejection');self.assertTrue(v.evaluate('()=>kinMprMarks.dirty()'));self.same_marks(v.evaluate('()=>kinMprMarks.capture()'),marks);self.assertEqual(self.jobs(a),[]);v.unroute(pattern,reject);self.save_volume(v);self.assertFalse(v.evaluate('()=>kinMprMarks.dirty()'))
 def test_marks_14_owner_change_cancels_armed_pick(self):
  a,p,v=self.starting();panel=self.marks(v);panel.get_by_label('MPR annotation label',exact=True).fill('Armed before session end');panel.get_by_role('button',name='Pick Point',exact=True).click();self.assertTrue(v.evaluate('()=>kinMprMarks.dirty()'));v.evaluate('()=>{window.retiredMarks=kinMprMarks;window.dispatchEvent(new StorageEvent("storage",{key:"kin-session-ended",newValue:"armed"}))}');expect(v.locator('#kin-mpr-marks')).to_have_count(0);self.assertFalse(v.evaluate('()=>retiredMarks.dirty()'));self.assertTrue(v.evaluate('()=>{try{retiredMarks.capture();return false}catch(_){return true}}'));expect(v.locator('[data-kin-mpr-mark-point]')).to_have_count(0)
 def test_marks_15_descending_originals_pick_save_restore(self):
  from unittest.mock import patch
  from pynetdicom.association import Association
  send=Association.send_c_store
  def descending(association,dataset,*args,**kwargs):
   self.assertIn(str(dataset.StudyInstanceUID),self.stack.active);dataset.ImageOrientationPatient=[-1,0,0,0,1,0];dataset.ImagePositionPatient=[63,0,float(dataset.ImagePositionPatient[2])];return send(association,dataset,*args,**kwargs)
  with patch.object(Association,'send_c_store',descending):a,p,v=self.opened_projection()
  point=v.evaluate('()=>{const volume=cornerstone.cache.getVolume(projectionVP.getVolumeId()),point=Array.from(volume.imageData.indexToWorld([32,32,31])),c=projectionVP.getCamera();projectionVP.setCamera({focalPoint:point,position:point.map((n,i)=>n+c.viewPlaneNormal[i]*100)});projectionVP.render();return point}')
  positions=v.evaluate('()=>{const ids=cornerstone.cache.getVolume(projectionVP.getVolumeId()).imageIds;return [ids[0],ids.at(-1)].map(id=>Number(cornerstone.metaData.get("instance",id).ImagePositionPatient[2]))}');self.assertGreater(positions[0],positions[1]);marks=self.add_mark(v,'Descending last slice',point);self.save_volume(v);job=self.get_volume_job(a);self.same_marks(job['snapshot']['marks'],marks);fresh=self.login();self.launch(fresh,[a]);self.ready(fresh);fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('\ubcf5\uc6d0\ud588\uc2b5\ub2c8\ub2e4',timeout=45000);self.same_marks(fresh.evaluate('()=>kinMprMarks.capture()'),marks)
 def test_marks_16_readiness_requires_actual_renderer_identity(self):
  a,p,v=self.starting();self.add_mark(v);before=self.volume_state(v)
  v.evaluate('()=>{const cs=services.cornerstoneViewportService,original=cs.getCornerstoneViewport;window.restoreReadinessPort=()=>cs.getCornerstoneViewport=original;window.readyViewId=projectionVP.id;const fake=Object.create(projectionVP);cs.getCornerstoneViewport=function(id){return id===readyViewId?fake:original.call(this,id)};services.viewportGridService.setViewportIsReady(readyViewId,false)}')
  v.wait_for_timeout(1100);self.assertFalse(v.evaluate('()=>services.viewportGridService.getState().viewports.get(readyViewId).isReady'));v.evaluate('()=>restoreReadinessPort()');v.wait_for_function('()=>services.viewportGridService.getState().viewports.get(readyViewId).isReady');self.preserved_volume(before,self.volume_state(v));expect(v.locator('.kin-mpr-marks-overlay [data-mark-id]')).to_have_count(3)
 def test_marks_17_other_source_retains_visible_discard_summary_and_blocks_restore(self):
  a,b=self.pair();v=self.login();self.launch(v,[a,b]);self.ready(v);self.mpr(v);self.choose_volume(v,v,0)
  point=v.evaluate('()=>{window.projectionVP=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);const volume=cornerstone.cache.getVolume(projectionVP.getVolumeId()),point=Array.from(volume.imageData.indexToWorld(volume.dimensions.map(n=>Math.floor(n/2)))),c=projectionVP.getCamera();projectionVP.setCamera({focalPoint:point,position:point.map((n,i)=>n+c.viewPlaneNormal[i]*100)});projectionVP.render();return point}')
  source_uid=v.evaluate('()=>cornerstone.metaData.get("instance",cornerstone.cache.getVolume(projectionVP.getVolumeId()).imageIds[0]).StudyInstanceUID');self.assertIn(source_uid,[a.uid,b.uid]);other_uid=b.uid if source_uid==a.uid else a.uid
  self.save_volume(v);self.add_mark(v,'Retained source A',point)
  v.evaluate('uid=>{const set=services.displaySetService.getActiveDisplaySets().find(s=>s.StudyInstanceUID===uid&&s.Modality==="CT");if(!set)throw Error("Missing second CT");services.viewportGridService.setDisplaySetsForViewports([...services.viewportGridService.getState().viewports.keys()].map(viewportId=>({viewportId,displaySetInstanceUIDs:[set.displaySetInstanceUID]})))}',other_uid)
  v.wait_for_function('uid=>{try{return [...services.viewportGridService.getState().viewports.keys()].every(id=>{const view=services.cornerstoneViewportService.getCornerstoneViewport(id),volume=cornerstone.cache.getVolume(view.getVolumeId());return volume?.loadStatus.loaded&&cornerstone.metaData.get("instance",volume.imageIds[0]).StudyInstanceUID===uid})}catch(_){return false}}',arg=other_uid);self.choose_volume(v,v,0);panel=self.marks(v);expect(panel.locator('.drafts')).to_contain_text(source_uid);expect(panel.locator('.drafts')).to_contain_text('Retained source A');self.assertTrue(v.evaluate('()=>kinMprMarks.dirty()'))
  v.get_by_role('button',name='Restore Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('\ubbf8\uc800\uc7a5 \ud45c\uc2dd');self.assertEqual(v.evaluate('()=>{const view=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);return cornerstone.metaData.get("instance",cornerstone.cache.getVolume(view.getVolumeId()).imageIds[0]).StudyInstanceUID}'),other_uid);panel.get_by_role('button',name='Revert All Unsaved Annotations',exact=True).click();self.assertFalse(v.evaluate('()=>kinMprMarks.dirty()'));expect(panel.locator('.drafts')).to_have_text('')
 def test_marks_18_partial_point_navigation_restores_all_planes(self):
  a,p,v=self.starting();self.add_mark(v);v.evaluate('()=>{for(const id of services.viewportGridService.getState().viewports.keys()){const view=services.cornerstoneViewportService.getCornerstoneViewport(id),c=view.getCamera(),d=c.viewPlaneNormal.map(n=>n*3);view.setCamera({focalPoint:c.focalPoint.map((n,i)=>n+d[i]),position:c.position.map((n,i)=>n+d[i])});view.render()}const view=services.cornerstoneViewportService.getCornerstoneViewport([...services.viewportGridService.getState().viewports.keys()][1]),set=view.setCamera;let once=true;view.setCamera=function(...args){set.apply(this,args);if(once){once=false;throw Error("PARTIAL GO FAILURE")}}}');before=self.volume_state(v)
  self.marks(v).get_by_role('button',name='Go to Point',exact=True).click();expect(self.marks(v).locator('[role=status]')).to_contain_text('이전 화면으로 복구했습니다');self.preserved_volume(before,self.volume_state(v));self.assertTrue(v.evaluate('()=>kinMprMarks.dirty()'))
 def test_marks_19_receipt_after_layout_change_acknowledges_saved_source(self):
  a,p,v=self.starting();marks=self.add_mark(v);waiting=[];pattern='**/api/studies/*/viewer-jobs';v.get_by_label('Job Title',exact=True).fill('Receipt during layout change')
  def hold(route):
   if route.request.method=='POST':waiting.append((route,route.fetch()))
   else:route.continue_()
  v.route(pattern,hold);v.get_by_role('button',name='Save New Job',exact=True).click()
  for _ in range(100):
   if waiting:break
   v.wait_for_timeout(50)
  self.assertEqual(len(waiting),1);self.assertEqual(len(self.jobs(a)),1);v.locator('[data-cy=Layout]').click();v.locator('[data-cy=Layout-0-0]').click();expect(v.locator('.kin-mpr-marks-overlay')).to_have_count(0)
  route,response=waiting.pop();route.fulfill(response=response);v.unroute(pattern,hold);expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('저장했습니다',timeout=45000);self.assertFalse(v.evaluate('()=>kinMprMarks.dirty()'));self.assertEqual(len(self.jobs(a)),1)
  self.mpr(v);self.choose_volume(v,v,0);self.same_marks(v.evaluate('()=>kinMprMarks.capture()'),marks);self.assertFalse(v.evaluate('()=>kinMprMarks.dirty()'))

def load_tests(loader,tests,pattern):return unittest.TestSuite(loader.loadTestsFromName(name,VolumeMarksE2E) for name in loader.getTestCaseNames(VolumeMarksE2E) if name.startswith('test_marks_'))
if __name__=='__main__':unittest.main(verbosity=2)
