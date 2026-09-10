# coding: utf-8
"""Guarded pinned-viewer CT position synchronization, using owned synthetic geometry."""
import copy,io,json,unittest,uuid
from pathlib import Path
from pydicom import dcmread
from pydicom.uid import generate_uid,CTImageStorage,ExplicitVRLittleEndian
from pynetdicom import AE
from playwright.sync_api import expect
from test_viewer_layout import ViewerLayoutE2E
from test_prior_selection import canvas_ready,synthetic_ct

class CTSyncE2E(ViewerLayoutE2E):
 def ct(self,patient,label,date):return synthetic_ct(self.stack,patient,label,date,slices=16)
 def pair(self,orthogonal=False):
  f=self.ct('SYNC-'+uuid.uuid4().hex[:12],'current','20260801')
  orth=next(x['ID'] for x in self.stack._orthanc_request('POST','/tools/lookup',f.uid.encode()).body if x['Type']=='Study')
  originals=[dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/'+x['ID']+'/file'))) for x in self.stack._orthanc_request('GET','/studies/'+orth+'/instances').body]
  originals.sort(key=lambda d:float(d.ImagePositionPatient[2]));series=generate_uid();ae=AE(ae_title='HALLYM_CT');ae.add_requested_context(CTImageStorage,ExplicitVRLittleEndian)
  assoc=ae.associate('127.0.0.1',4242,ae_title='KINLAB');self.assertTrue(assoc.is_established);refs={}
  try:
   for i,original in enumerate(originals[::2]):
    d=copy.deepcopy(original);d.SeriesInstanceUID=series;d.SeriesNumber=2;d.SeriesDescription='SYNC spaced';d.InstanceNumber=100-i
    d.SOPInstanceUID=generate_uid();d.file_meta.MediaStorageSOPInstanceUID=d.SOPInstanceUID;d.PixelData=original.pixel_array[::-1,:].copy().astype('<u2').tobytes()
    if orthogonal:d.ImageOrientationPatient=[0,1,0,0,0,1];d.ImagePositionPatient=[float(original.ImagePositionPatient[2]),0,0]
    self.assertEqual(assoc.send_c_store(d).Status,0);refs[float(d.ImagePositionPatient[2])]=str(d.SOPInstanceUID)
  finally:assoc.release()
  return f,series,refs

 def pair_page(self,f):
  p=self.launch(self.login(),[f]);self.grid(p,2);self.drag(p,'D03A current',0);self.drag(p,'SYNC spaced',1);canvas_ready(p,2);return p

 def snapshot(self,p):
  return p.evaluate('''()=>[...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).map(g=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId),id=v.getCurrentImageId();return {id:v.id,index:v.getCurrentImageIdIndex(),image:id,position:cornerstone.metaData.get('imagePlaneModule',id)?.imagePositionPatient}})''')

 def toggle(self,p):
  p.locator('[data-cy="MoreTools-split-button-secondary"]').click();p.locator('#root').get_by_text('Image Slice Sync',exact=True).click()

 def jump(self,p,cell,index):
  ident=self.snapshot(p)[cell]['id'];p.evaluate('''async ({id,index})=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id);await cornerstone.utilities.jumpToSlice(v.element,{imageIndex:index})}''',dict(id=ident,index=index))

 def wait_z(self,p,cell,z):
  p.wait_for_function('''({cell,z})=>{const g=[...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x)[cell];const v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId);return cornerstone.metaData.get('imagePlaneModule',v.getCurrentImageId())?.imagePositionPatient[2]===z}''',arg=dict(cell=cell,z=z),timeout=15000)
  canvas_ready(p,2)

 def test_sync_01_physical_positions_and_native_off(self):
  f,series,refs=self.pair();self.seed_report(f)
  values=dict(findings='Sync private findings',conclusion='Sync conclusion',recommendation='Sync recommendation')
  self.assertEqual(self.stack.request('PUT',f'/studies/{f.uid}/report','doctor',dict(values,baseVersion=1)).status,200)
  self.assertEqual(self.stack.request('POST',f'/studies/{f.uid}/hold','doctor').status,201)
  originals=self.originals();rows=self.report_rows(f);p=self.pair_page(f)
  self.toggle(p);self.jump(p,0,4);self.wait_z(p,1,8)
  state=self.snapshot(p);self.assertIn(refs[8],state[1]['image']);self.assertNotEqual(state[0]['index'],state[1]['index'])
  # The user-facing scroll/keyboard path must also emit native synchronization events.
  box=p.locator('[data-viewport-uid="'+state[0]['id']+'"] canvas').bounding_box();p.mouse.click(box['x']+box['width']*.5,box['y']+box['height']*.3);p.keyboard.press('ArrowDown')
  self.wait_z(p,0,10);p.keyboard.press('ArrowDown');self.wait_z(p,0,12);self.wait_z(p,1,12)
  self.jump(p,1,1);self.wait_z(p,0,24)
  print('SYNC actual physical positions '+json.dumps(self.snapshot(p)),flush=True);p.screenshot(path=str(Path(__file__).parent/'artifacts/SYNC-position.png'))
  self.toggle(p);before=self.snapshot(p)[1];self.jump(p,0,10);p.wait_for_timeout(400);self.assertEqual(self.snapshot(p)[1],before)
  p.reload();canvas_ready(p,1);self.assertEqual(p.evaluate("cornerstoneTools.SynchronizerManager.getAllSynchronizers().filter(s=>s.id==='IMAGE_SLICE_SYNC').length"),0)
  self.assertEqual(self.report_rows(f),rows);self.assertEqual(self.originals(),originals)

 def test_sync_02_range_series_replacement_and_wrong_patient(self):
  f,series,refs=self.pair();other=self.ct('SYNC-other-'+uuid.uuid4().hex[:12],'past','20260701');originals=self.originals()
  p=self.launch(self.login(),[f,other]);self.grid(p,2);self.drag(p,'D03A current',0);self.drag(p,'SYNC spaced',1);canvas_ready(p,2)
  self.toggle(p);self.jump(p,0,4);self.wait_z(p,1,8);before=self.snapshot(p)[1]
  self.jump(p,0,15);expect(p.locator('#kin-ct-sync-status')).to_contain_text('범위');self.assertEqual(self.snapshot(p)[1],before)
  self.drag(p,'D03A past',1);canvas_ready(p,2);before=self.snapshot(p)[1];self.jump(p,0,6)
  expect(p.locator('#kin-ct-sync-status')).to_contain_text('같은 환자');self.assertEqual(self.snapshot(p)[1],before)
  self.assertEqual(self.originals(),originals)

 def test_sync_03_different_for_and_missing_geometry(self):
  patient='SYNC-'+uuid.uuid4().hex[:12];a=self.ct(patient,'current','20260801');b=self.ct(patient,'past','20260701');originals=self.originals()
  p=self.launch(self.login(),[a,b]);self.grid(p,2);self.drag(p,'D03A current',0);self.drag(p,'D03A past',1);canvas_ready(p,2)
  before=self.snapshot(p)[1];self.toggle(p);self.jump(p,0,4);expect(p.locator('#kin-ct-sync-status')).to_contain_text('좌표계');self.assertEqual(self.snapshot(p)[1],before)
  self.jump(p,0,7);p.wait_for_timeout(300);self.assertEqual(self.snapshot(p)[1],before)
  self.assertEqual(self.originals(),originals)

 def test_sync_04_delayed_image_off_replacement_and_session(self):
  f,series,refs=self.pair();other=self.ct('SYNC-other-'+uuid.uuid4().hex[:12],'past','20260701');originals=self.originals();rows=self.report_rows(f)
  p=self.login();pending=[];pattern='**/instances/'+refs[12]+'/frames/*';p.route(pattern,lambda r:pending.append(r))
  self.launch(p,[f,other]);self.grid(p,2);self.drag(p,'D03A current',0);self.drag(p,'SYNC spaced',1);canvas_ready(p,2);self.toggle(p)
  self.jump(p,0,6);p.wait_for_timeout(300);self.assertTrue(pending);before=self.snapshot(p)[1];self.toggle(p)
  for r in pending:r.fulfill(response=r.fetch())
  p.unroute(pattern);p.wait_for_timeout(400);self.assertEqual(self.snapshot(p)[1],before)
  pending=[];pattern='**/api/me';p.route(pattern,lambda r:pending.append(r));self.toggle(p)
  self.jump(p,0,8);p.wait_for_timeout(150);self.assertTrue(pending);self.drag(p,'D03A past',1);canvas_ready(p,2);before=self.snapshot(p)[1]
  for r in pending:r.fulfill(response=r.fetch())
  p.unroute(pattern);p.wait_for_timeout(400);self.assertEqual(self.snapshot(p)[1],before)
  work=p.context.new_page();work.goto(self.stack.proxy+'/worklist/hpacs-lite/main.html');expect(work.locator('#dbstat')).to_contain_text('DB Connected');work.once('dialog',lambda d:d.accept());work.locator('#logout').click();work.wait_for_url('**/index.html')
  expect(p.locator('#kin-ct-sync-status')).to_contain_text('세션이 변경')
  self.jump(p,0,9);p.wait_for_timeout(250);self.assertEqual(self.snapshot(p)[1],before)
  self.assertEqual(self.report_rows(f),rows);self.assertEqual(self.originals(),originals)

 def test_sync_05_orthogonal_ct_geometry(self):
  f,series,refs=self.pair(orthogonal=True);originals=self.originals();p=self.pair_page(f);before=self.snapshot(p)[1]
  self.toggle(p);self.jump(p,0,6);expect(p.locator('#kin-ct-sync-status')).to_contain_text('방향');self.assertEqual(self.snapshot(p)[1],before)
  p.screenshot(path=str(Path(__file__).parent/'artifacts/SYNC-orientation-refused.png'))
  self.assertEqual(self.originals(),originals)

 def test_sync_06_failed_access_and_native_exit(self):
  f,series,refs=self.pair();originals=self.originals();p=self.pair_page(f);self.toggle(p);self.jump(p,0,4);self.wait_z(p,1,8)
  before=self.snapshot(p)[1];pattern='**/api/me';p.route(pattern,lambda r:r.fulfill(status=403,json={'message':'Synthetic denied'}))
  self.jump(p,0,6);expect(p.locator('#kin-ct-sync-status')).to_contain_text('적용하지 못했습니다');self.assertEqual(self.snapshot(p)[1],before);p.unroute(pattern)
  pending=[];p.route(pattern,lambda r:pending.append(r));self.jump(p,0,8);p.wait_for_timeout(150);self.assertTrue(pending)
  response=pending[0].fetch();p.evaluate('()=>{window.syncExitMarker=true}');p.mouse.click(20,24)
  expect(p.locator('#kin-ct-sync-status')).to_have_count(0);self.assertTrue(p.evaluate('window.syncExitMarker===true'));self.assertNotIn('/ohif/viewer?',p.url)
  pending[0].fulfill(response=response);p.wait_for_timeout(200);expect(p.locator('#kin-ct-sync-status')).to_have_count(0)
  self.assertEqual(self.originals(),originals)

def load_tests(loader,tests,pattern):return unittest.TestSuite(CTSyncE2E(n) for n in loader.getTestCaseNames(CTSyncE2E) if n.startswith('test_sync_'))
if __name__=='__main__':unittest.main(verbosity=2)
