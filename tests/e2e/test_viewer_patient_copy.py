# coding: utf-8
"""TEST-VIEWER-PATIENT-COPY: actual loaded DICOM identity and secure clipboard."""
import io,os,uuid,unittest,sys
from pathlib import Path
import pydicom
from playwright.sync_api import expect
from test_viewer_tech_note import ViewerTechNoteE2E,canvas_ready

class ViewerPatientCopyE2E(ViewerTechNoteE2E):
 def popup(self,a):
  p=self.login();p.context.grant_permissions(['clipboard-read','clipboard-write'],origin=self.stack.proxy);self.workspace(p,a)
  with p.context.expect_page() as opened:p.get_by_role('button',name='Open Viewer Window',exact=True).click()
  v=opened.value;canvas_ready(v,2);self.ready(v);self.active(v,a.uid);self.tools(v)
  try:expect(v.locator('#kin-viewer-copy-id')).to_be_enabled()
  except Exception:
   sys.stdout.reconfigure(encoding='utf-8',errors='replace')
   print('COPY IDENTITY DIAGNOSTIC',v.evaluate('''()=>{const grid=services.viewportGridService,g=grid.getState(),v=services.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId),id=v.getCurrentImageId(),m=cornerstone.metaData.get('instance',id),ds=services.displaySetService.getDisplaySetByUID(g.viewports.get(g.activeViewportId).displaySetInstanceUIDs[0]);return {image:id,instance:{study:m?.StudyInstanceUID,series:m?.SeriesInstanceUID,sop:m?.SOPInstanceUID,id:m?.PatientID},display:{study:ds.StudyInstanceUID,series:ds.SeriesInstanceUID,id:ds.PatientID},stackEvent:cornerstone.Enums?.Events?.STACK_NEW_IMAGE,gridEvents:grid.EVENTS}}'''),flush=True);raise
  return p,v
 def copied(self,v):expect(v.locator('#kin-viewer-copy-status')).to_have_text('환자 ID를 복사했습니다.')
 def clipboard(self,v):return v.evaluate('()=>navigator.clipboard.readText()')

 def test_copy_01_actual_dicom_literal_id_active_prior_and_preservation(self):
  patient='0007-한글<&-'+uuid.uuid4().hex[:8];a=self.ct(patient,'current','20260801');b=self.ct(patient,'past','20260701');self.seed_report(a);self.seed_report(b,action='approve')
  p,v=self.popup(a);p.locator('#findings').fill('KEEP COPY PARENT');v.get_by_label('Job Title',exact=True).fill('KEEP COPY VIEWER');before=self.snapshot(v);url=v.url
  original=pydicom.dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/'+self.stack.first_instance_id(a.uid)+'/file')))
  row=next(s for s in p.context.request.get(self.stack.api+'/studies').json()['studies'] if s['uid']==a.uid)
  v.locator('#kin-viewer-copy-id').click();self.copied(v);self.assertEqual(self.clipboard(v),str(original.PatientID));self.assertEqual(self.clipboard(v),row['id']);self.assertEqual(self.clipboard(v),patient)
  self.active(v,b.uid);expect(v.locator('#kin-viewer-copy-context')).to_contain_text(b.uid);v.locator('#kin-viewer-copy-id').focus();v.keyboard.press('Control+Alt+c');self.copied(v);self.assertEqual(self.clipboard(v),patient);expect(v.locator('#kin-viewer-copy-id')).to_be_focused()
  expect(v.locator('#kin-viewer-copy-context')).to_contain_text(patient);expect(v.get_by_label('Job Title',exact=True)).to_have_value('KEEP COPY VIEWER');expect(p.locator('#findings')).to_have_value('KEEP COPY PARENT')
  self.assertEqual(v.url,url);self.assertEqual(self.snapshot(v),before);self.assertEqual(self.jobs(a),[])
  folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);v.screenshot(path=str(folder/'selected-image-copy.png'))

 def test_copy_02_denial_retry_and_fast_return_discards_late_success(self):
  a,b=self.pair();p,v=self.popup(a)
  v.evaluate('()=>{window.nativeCopy=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=()=>Promise.reject(new DOMException("denied","NotAllowedError"))}')
  v.locator('#kin-viewer-copy-id').click();expect(v.locator('#kin-viewer-copy-status')).to_contain_text('실패했습니다');expect(v.locator('#kin-viewer-copy-id')).to_be_enabled()
  v.evaluate('()=>navigator.clipboard.writeText=undefined');v.locator('#kin-viewer-copy-id').click();expect(v.locator('#kin-viewer-copy-status')).to_contain_text('지원하지 않습니다')
  v.evaluate('()=>{window.copyCalls=[];window.copyHeld=false;navigator.clipboard.writeText=async text=>{copyCalls.push(text);await nativeCopy(text);copyHeld=true;await new Promise(resolve=>window.releaseCopy=resolve)}}')
  v.locator('#kin-viewer-copy-id').click();v.wait_for_function('()=>copyHeld');self.assertEqual(self.clipboard(v),a.patient_id);expect(v.locator('#kin-viewer-copy-id')).to_have_attribute('aria-busy','true');expect(v.locator('#kin-viewer-copy-id')).to_be_focused()
  v.locator('#kin-viewer-copy-id').dispatch_event('click');self.assertEqual(v.evaluate('()=>copyCalls'),[a.patient_id])
  v.evaluate('''()=>{const grid=services.viewportGridService,ids=[...grid.getState().viewports.keys()].filter(id=>services.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageId?.());grid.setActiveViewportId(ids[1]);grid.setActiveViewportId(ids[0]);}''')
  expect(v.locator('#kin-viewer-copy-status')).to_be_empty();v.evaluate('()=>releaseCopy()');expect(v.locator('#kin-viewer-copy-id')).to_be_enabled();expect(v.locator('#kin-viewer-copy-status')).to_be_empty();self.assertEqual(v.evaluate('()=>copyCalls'),[a.patient_id])
  v.evaluate('()=>navigator.clipboard.writeText=window.nativeCopy');v.locator('#kin-viewer-copy-id').click();self.copied(v)

 def test_copy_03_mismatched_metadata_input_modal_and_session_end(self):
  a,b=self.pair();p,v=self.popup(a);v.evaluate('()=>navigator.clipboard.writeText("UNCHANGED")')
  v.evaluate('''()=>{const g=services.viewportGridService.getState(),vp=services.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId);window.copyMeta=cornerstone.metaData.get('instance',vp.getCurrentImageId());window.copyOriginalId=copyMeta.PatientID;window.copyOriginalSop=copyMeta.SOPInstanceUID;copyMeta.SOPInstanceUID='1.2.3.4';}''')
  expect(v.locator('#kin-viewer-copy-id')).to_be_disabled();self.assertEqual(self.clipboard(v),'UNCHANGED')
  v.evaluate('()=>{copyMeta.SOPInstanceUID=copyOriginalSop;copyMeta.PatientID=""}');expect(v.locator('#kin-viewer-copy-id')).to_be_disabled()
  v.evaluate('()=>copyMeta.PatientID=copyOriginalId');expect(v.locator('#kin-viewer-copy-id')).to_be_enabled()
  v.evaluate('''()=>{const g=services.viewportGridService.getState();window.copyDisplay=services.displaySetService.getDisplaySetByUID(g.viewports.get(g.activeViewportId).displaySetInstanceUIDs[0]);window.originalDisplayId=copyDisplay.PatientID;copyDisplay.PatientID='WRONG';}''');expect(v.locator('#kin-viewer-copy-id')).to_be_disabled()
  v.evaluate('()=>{copyDisplay.PatientID=originalDisplayId;copyMeta.PatientID="X".repeat(65)}');expect(v.locator('#kin-viewer-copy-id')).to_be_disabled()
  v.evaluate('()=>copyMeta.PatientID=copyOriginalId');expect(v.locator('#kin-viewer-copy-id')).to_be_enabled()
  field=v.get_by_label('Job Title',exact=True);field.fill('KEEP COPY INPUT');field.focus();v.keyboard.press('Control+Alt+c');self.assertEqual(self.clipboard(v),'UNCHANGED');expect(field).to_have_value('KEEP COPY INPUT')
  self.open_note(v);v.keyboard.press('Control+Alt+c');self.assertEqual(self.clipboard(v),'UNCHANGED');v.locator('#tech-note-close').click()
  v.evaluate('()=>{window.copyNativeDialog=document.createElement("dialog");document.body.append(copyNativeDialog);copyNativeDialog.showModal()}');v.keyboard.press('Control+Alt+c');self.assertEqual(self.clipboard(v),'UNCHANGED');v.evaluate('()=>copyNativeDialog.remove()')
  v.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}");expect(v.locator('#kin-viewer-copy-id')).to_be_disabled();expect(v.locator('#kin-viewer-copy-context')).not_to_contain_text(a.patient_id);v.keyboard.press('Control+Alt+c');self.assertEqual(self.clipboard(v),'UNCHANGED')

def load_tests(loader,tests,pattern):return unittest.TestSuite(ViewerPatientCopyE2E(n) for n in loader.getTestCaseNames(ViewerPatientCopyE2E) if n.startswith('test_copy_'))
if __name__=='__main__':unittest.main(verbosity=2)
