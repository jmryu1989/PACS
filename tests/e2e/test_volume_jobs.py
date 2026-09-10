# coding: utf-8
"""TEST-VOLUME-JOB: complete source references and native MPR save/reopen."""
import copy,json,unittest
from playwright.sync_api import expect
from test_volume_projection import VolumeProjectionE2E

class VolumeJobsE2E(VolumeProjectionE2E):
 def save_volume(self,v):
  v.get_by_label('Job Title',exact=True).fill('Saved MPR synthetic')
  v.get_by_role('button',name='Save New Job',exact=True).click()
  expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('저장했습니다',timeout=45000)
 def get_volume_job(self,a):
  rows=self.jobs(a);self.assertEqual(len(rows),1)
  r=self.stack.request('GET',f'/studies/{a.uid}/viewer-jobs/{rows[0]["id"]}','doctor');self.assertEqual(r.status,200,r.text);return r.body
 def test_volume_job_01_save_restore_and_new_browser(self):
  a,p,v=self.opened_projection();original=self.originals();p.locator('#findings').fill('KEEP MPR SAVED REPORT')
  self.project(v,3,20);v.wait_for_function('()=>Math.abs(projectionPixel()-127)<=3')
  v.evaluate('''()=>{const id=Array.from(services.viewportGridService.getState().viewports.keys())[1],v=services.cornerstoneViewportService.getCornerstoneViewport(id),c=v.getCamera();v.setCamera({parallelScale:c.parallelScale*1.2,focalPoint:c.focalPoint.map((n,i)=>n+(i===1?2:0)),position:c.position.map((n,i)=>n+(i===1?2:0))});v.render()}''')
  self.save_volume(v);job=self.get_volume_job(a)
  self.assertEqual(job['snapshot']['version'],4);self.assertEqual(len(job['snapshot']['volume']['sops']),33);self.assertNotIn('sop',job['snapshot']['cells'][0]);self.assertEqual(len(job['snapshot']['volume']['sourceDigest']),64)
  self.project(v,1,2);v.get_by_role('button',name='Restore Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000)
  v.wait_for_function('()=>services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId)?.getActors()[0]?.actor.getMapper().getBlendMode()===3')
  fresh=self.login();self.launch(fresh,[a]);self.ready(fresh);fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000)
  actual=fresh.evaluate('()=>window.kinCreateVolumeJob({grid:services.viewportGridService,cs:services.cornerstoneViewportService,ds:services.displaySetService,studies:new URLSearchParams(location.search).get("StudyInstanceUIDs").split(",")}).capture()')
  self.assertEqual(actual['volume']['sops'],job['snapshot']['volume']['sops']);self.assertEqual([c['projection'] for c in actual['cells']],[c['projection'] for c in job['snapshot']['cells']])
  for left,right in zip(actual['cells'],job['snapshot']['cells']):
   for key,want in right['camera'].items():
    got=left['camera'][key]
    if isinstance(want,list):
     for x,y in zip(got,want):self.assertAlmostEqual(x,y,delta=1e-6)
    elif isinstance(want,bool):self.assertEqual(got,want)
    else:self.assertAlmostEqual(got,want,delta=1e-6)
  fresh.wait_for_function('''()=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId),c=v.getCanvas(),xy=v.worldToCanvas([32,32,16]),value=c.getContext('2d').getImageData(Math.floor(xy[0]*c.width/c.clientWidth),Math.floor(xy[1]*c.height/c.clientHeight),1,1).data[0];return Math.abs(value-127)<=3}''')
  samples=fresh.evaluate('''()=>Array.from(services.viewportGridService.getState().viewports.keys()).slice(1).map(id=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id),c=v.getCanvas();return [5,16,27].map(z=>{const xy=v.worldToCanvas([32,32,z]);return c.getContext('2d').getImageData(Math.floor(xy[0]*c.width/c.clientWidth),Math.floor(xy[1]*c.height/c.clientHeight),1,1).data[0]})})''')
  for plane in samples:
   for value,want in zip(plane,[25,127,229]):self.assertAlmostEqual(value,want,delta=3)
  expect(p.locator('#findings')).to_have_value('KEEP MPR SAVED REPORT');self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1);print('MPR_REOPEN',json.dumps(actual),flush=True)
 def test_volume_job_02_forged_missing_source_and_roles(self):
  import uuid
  a,p,v=self.opened_projection();self.save_volume(v);job=self.get_volume_job(a);snapshot=copy.deepcopy(job['snapshot']);del snapshot['volume']['sourceDigest']
  def request(s,user='doctor'):
   return self.stack.request('POST',f'/studies/{a.uid}/viewer-jobs',user,{'id':str(uuid.uuid4()),'title':'Rejected source','description':'','snapshot':s})
  bad=copy.deepcopy(snapshot);bad['volume']['sops']=bad['volume']['sops'][::2];self.assertEqual(request(bad).status,400)
  bad=copy.deepcopy(snapshot);bad['cells'][0]['sop']=snapshot['volume']['sops'][0];self.assertEqual(request(bad).status,400)
  bad=copy.deepcopy(snapshot);bad['cells'][0]['projection']['thickness']=1001;self.assertEqual(request(bad).status,400)
  self.assertEqual(request(snapshot,'tech').status,403);self.assertEqual(request(snapshot,'kdoctor').status,403);self.assertEqual(len(self.jobs(a)),1)
 def test_volume_job_03_restore_failure_recovers_existing_mpr(self):
  a,p,v=self.opened_projection();self.project(v,3,20);self.save_volume(v);self.project(v,1,2)
  p.locator('#findings').fill('KEEP ROLLBACK REPORT');v.get_by_label('Job Title',exact=True).fill('KEEP ROLLBACK TITLE')
  capture='()=>window.kinCreateVolumeJob({grid:services.viewportGridService,cs:services.cornerstoneViewportService,ds:services.displaySetService,studies:new URLSearchParams(location.search).get("StudyInstanceUIDs").split(",")}).capture()'
  before=v.evaluate(capture)
  v.evaluate('()=>{const original=window.kinPrepareVolumeAverage;window.kinPrepareVolumeAverage=(...args)=>{window.kinPrepareVolumeAverage=original;throw Error("Injected renderer failure")}}')
  v.get_by_role('button',name='Restore Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('이전 화면',timeout=45000)
  after=v.evaluate(capture);self.assertEqual(before['volume'],after['volume']);self.assertEqual([c['projection'] for c in before['cells']],[c['projection'] for c in after['cells']])
  for x,y in zip(before['cells'],after['cells']):
   for field in ['position','focalPoint','viewUp','viewPlaneNormal']:
    for left,right in zip(x['camera'][field],y['camera'][field]):self.assertAlmostEqual(left,right,delta=1e-6)
  expect(p.locator('#findings')).to_have_value('KEEP ROLLBACK REPORT');expect(v.get_by_label('Job Title',exact=True)).to_have_value('KEEP ROLLBACK TITLE');self.assertEqual(len(self.jobs(a)),1)
 def test_volume_job_04_parent_permission_and_changed_series(self):
  import io
  from pydicom import dcmread
  import test_prior_selection as ct
  from viewer_api_test import literal
  from invariants_live import psql
  a,p,v=self.opened_projection();self.save_volume(v);job=self.get_volume_job(a);url=f'/studies/{a.uid}/viewer-jobs/{job["id"]}'
  self.assertEqual(self.stack.request('GET',url,'kdoctor').status,403)
  nullable=lambda value:'NULL' if value is None else literal(value)
  original=json.loads(psql(f'SELECT to_jsonb(s)::text FROM "StudyState" s WHERE uid={literal(a.uid)}')[0])
  try:
   psql(f'UPDATE "StudyState" SET rs=\'P\', "preDoc"=\'other\', "preReviewer"=\'other2\' WHERE uid={literal(a.uid)}')
   self.assertEqual(self.stack.request('GET',url,'doctor').status,403)
  finally:
   psql(f'UPDATE "StudyState" SET rs={literal(original["rs"])}, "preDoc"={nullable(original["preDoc"])}, "preReviewer"={nullable(original["preReviewer"])} WHERE uid={literal(a.uid)}')
  self.assertEqual(self.stack.request('GET',url,'doctor').status,200)
  d=dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/'+self.stack.first_instance_id(a.uid)+'/file')));self.assertEqual(str(d.StudyInstanceUID),a.uid);self.assertIn(a.uid,self.stack.active)
  d.SOPInstanceUID=d.file_meta.MediaStorageSOPInstanceUID=ct.generate_uid();d.InstanceNumber=34;d.ImagePositionPatient=[0,0,33];d.SliceLocation=33
  ae=ct.AE(ae_title='HALLYM_CT');ae.add_requested_context(ct.CTImageStorage,ct.ExplicitVRLittleEndian);assoc=ae.associate('127.0.0.1',4242,ae_title='KINLAB')
  try:self.assertTrue(assoc.is_established);self.assertEqual(assoc.send_c_store(d).Status,0)
  finally:assoc.release()
  self.assertEqual(self.stack.request('GET',url,'doctor').status,409)
 def test_volume_job_05_lost_save_receipt_retries_once(self):
  a,p,v=self.opened_projection();v.get_by_label('Job Title',exact=True).fill('MPR receipt retry');pattern='**/api/studies/*/viewer-jobs'
  def lost(route):
   if route.request.method=='POST':route.fetch();route.abort()
   else:route.continue_()
  v.route(pattern,lost);v.get_by_role('button',name='Save New Job',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('입력은 유지',timeout=45000)
  self.assertEqual(len(self.jobs(a)),1);expect(v.get_by_label('Job Title',exact=True)).to_have_value('MPR receipt retry');v.unroute(pattern,lost)
  v.get_by_role('button',name='Retry Request',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('저장했습니다',timeout=45000);self.assertEqual(len(self.jobs(a)),1)
 def test_volume_job_06_display_job_does_not_print_as_a_source_frame(self):
  from pathlib import Path
  a,p,v=self.opened_projection();self.project(v,1,20);self.save_volume(v)
  expect(v.get_by_role('button',name='Print Saved Images',exact=True)).to_have_count(0)
  v.get_by_role('button',name='Print Current View',exact=True).click();expect(v.locator('#kin-viewer-jobs-status')).to_contain_text('재구성 영상 출력은 아직 지원하지 않습니다')
  folder=Path('../tmp/volume-job/screens');folder.mkdir(parents=True,exist_ok=True);v.get_by_role('button',name='Restore Job',exact=True).scroll_into_view_if_needed();v.screenshot(path=str(folder/'mpr-saved-workspace.png'))
 def test_volume_job_07_missing_optional_asset_keeps_stack_jobs(self):
  a,b=self.pair();p=self.login();p.route('**/viewer-volume-job.js',lambda route:route.abort());v=self.launch(p,[a]);self.ready(v)
  self.save_volume(v);self.assertEqual(self.get_volume_job(a)['snapshot']['version'],2)
 def test_volume_job_08_inverted_projection_reopens_with_pixels(self):
  a,p,v=self.opened_projection();self.project(v,2,20)
  v.evaluate('()=>{projectionVP.setProperties({invert:true});projectionVP.render()}');v.wait_for_function('()=>Math.abs(projectionPixel()-230)<=3');self.save_volume(v)
  fresh=self.login();self.launch(fresh,[a]);self.ready(fresh);fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000)
  fresh.wait_for_function('''()=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId),c=v.getCanvas(),xy=v.worldToCanvas([32,32,16]);return v.getProperties().invert&&Math.abs(c.getContext('2d').getImageData(Math.floor(xy[0]*c.width/c.clientWidth),Math.floor(xy[1]*c.height/c.clientHeight),1,1).data[0]-230)<=3}''')
 def test_volume_job_09_rotation_scaled_display_and_revision_history(self):
  from unittest.mock import patch
  a,p,v=self.opened_projection();v.evaluate('()=>{projectionVP.setRotation(30);projectionVP.render()}');self.save_volume(v);saved=self.get_volume_job(a)
  create=self.browser.new_context
  with patch.object(self.browser,'new_context',side_effect=lambda **options:create(**dict(options,device_scale_factor=1.5))):fresh=self.login()
  self.launch(fresh,[a]);self.ready(fresh);fresh.get_by_role('button',name='Restore Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('복원했습니다',timeout=45000)
  actual=fresh.evaluate('()=>services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId).getCamera()');expected=saved['snapshot']['cells'][0]['camera']
  for key in ['focalPoint','position','viewUp','viewPlaneNormal']:
   for x,y in zip(actual[key],expected[key]):self.assertAlmostEqual(x,y,delta=1e-6)
  self.assertAlmostEqual(actual['rotation'],expected['rotation'],delta=1e-6);self.assertEqual(fresh.evaluate('devicePixelRatio'),1.5)
  fresh.get_by_role('button',name='Edit Details',exact=True).click();fresh.get_by_label('Description',exact=True).fill('MPR metadata revision');fresh.get_by_role('button',name='Save Changes',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('저장했습니다')
  fresh.once('dialog',lambda dialog:dialog.accept('Synthetic hide'));fresh.get_by_role('button',name='Hide Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('저장했습니다');self.assertEqual(self.jobs(a),[])
  fresh.get_by_label('Include Hidden Jobs',exact=True).check();expect(fresh.get_by_role('button',name='Unhide Job',exact=True)).to_be_enabled()
  fresh.once('dialog',lambda dialog:dialog.accept('Synthetic restore'));fresh.get_by_role('button',name='Unhide Job',exact=True).click();expect(fresh.locator('#kin-viewer-jobs-status')).to_contain_text('저장했습니다');latest=self.get_volume_job(a)
  self.assertEqual(latest['revision'],4);self.assertEqual(latest['snapshot'],saved['snapshot']);self.assertEqual(latest['description'],'MPR metadata revision')

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeJobsE2E(n) for n in loader.getTestCaseNames(VolumeJobsE2E) if n.startswith('test_volume_job_'))
if __name__=='__main__':unittest.main(verbosity=2)
