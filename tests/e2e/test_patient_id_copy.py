# coding: utf-8
"""Explicit viewed PatientID copying through the real secure-origin clipboard."""
import io,json,unittest,uuid
from pathlib import Path
import pydicom
from playwright.sync_api import expect
from test_related_context import RelatedContextE2E

class PatientIdCopyE2E(RelatedContextE2E):
 def clipboard(self,p):return p.evaluate('()=>navigator.clipboard.readText()')
 def permit(self,p):p.context.grant_permissions(['clipboard-read','clipboard-write'],origin=self.stack.proxy)
 def copied(self,p):expect(p.locator('#copy-patient-status')).to_have_text('환자 ID를 복사했습니다.')
 def test_copy_01_actual_id_related_context_and_literal(self):
  patient='0007-한글<&-'+uuid.uuid4().hex[:10];a=self.ct(patient,'current','20260801');b=self.ct(patient,'past','20260701');c=self.ct('0009-'+uuid.uuid4().hex[:12],'other','20260802')
  p=self.login();self.permit(p);expect(p.locator('#copy-patient-id')).to_be_disabled();self.select(p,a)
  original=pydicom.dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/'+self.stack.first_instance_id(a.uid)+'/file')))
  row=next(x for x in p.context.request.get(self.stack.proxy+'/api/studies').json()['studies'] if x['uid']==a.uid)
  self.assertEqual(row['id'],str(original.PatientID));self.assertEqual(row['id'],patient)
  expect(p.locator('#clinical')).to_contain_text(patient);p.locator('#copy-patient-id').click();self.copied(p);self.assertEqual(self.clipboard(p),patient)
  for value in [row['institutionName'],row['name'],patient,'2026-08-01']:expect(p.locator('#copy-patient-context')).to_contain_text(value)
  self.related(p,b).click();expect(p.locator('#copy-patient-status')).to_be_empty();expect(p.locator('#copy-patient-context')).to_contain_text('2026-07-01')
  p.locator('#copy-patient-id').focus();p.keyboard.press('Control+Alt+c');self.copied(p);self.assertEqual(self.clipboard(p),patient)
  self.select(p,c);expect(p.locator('#copy-patient-status')).to_be_empty();p.locator('#copy-patient-id').click();self.copied(p);self.assertEqual(self.clipboard(p),c.patient_id)
  print('COPY actual DICOM/API/clipboard '+json.dumps(dict(id=patient,apiId=row['id'],dicomId=str(original.PatientID),institution=row['institutionName'],relatedStudy=b.uid,otherClipboard=self.clipboard(p)),ensure_ascii=False),flush=True)
  self.select(p,a);p.set_viewport_size(dict(width=900,height=1050));p.locator('#copy-patient-id').click();self.copied(p)
  p.screenshot(path=str(Path(__file__).parent/'artifacts/COPY-context.png'))
  other=self.login('kdoctor');expect(other.locator('#rows tr[data-uid="'+a.uid+'"]').first).to_have_count(0)
  self.assertEqual(p.context.request.get(self.stack.proxy+'/api/studies/'+a.uid+'/report/versions').status,200)
  self.assertEqual(other.context.request.get(self.stack.proxy+'/api/studies/'+a.uid+'/report/versions').status,404)
  self.assertEqual(other.context.request.get(self.stack.proxy+'/dicom-web/studies/'+a.uid+'/metadata').status,403)

 def test_copy_02_rejection_unsupported_late_completion_and_retry(self):
  a=self.ct('000A-'+uuid.uuid4().hex[:12],'a','20260801');b=self.ct('000B-'+uuid.uuid4().hex[:12],'b','20260802');p=self.login();self.permit(p);self.select(p,a)
  p.evaluate('()=>{window.nativeCopy=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=()=>Promise.reject(new DOMException("denied","NotAllowedError"));}')
  p.locator('#copy-patient-id').click();expect(p.locator('#copy-patient-status')).to_contain_text('실패했습니다');expect(p.locator('#copy-patient-id')).to_be_enabled()
  p.evaluate('()=>navigator.clipboard.writeText=undefined');p.locator('#copy-patient-id').click();expect(p.locator('#copy-patient-status')).to_contain_text('지원하지 않습니다')
  p.evaluate('()=>navigator.clipboard.writeText=window.nativeCopy');p.locator('#copy-patient-id').click();self.copied(p);self.assertEqual(self.clipboard(p),a.patient_id)
  # The real OS write completes first; only the Promise resolution is held locally.
  p.evaluate('()=>{window.copyCalls=[];window.copyHeld=false;navigator.clipboard.writeText=async text=>{copyCalls.push(text);await nativeCopy(text);copyHeld=true;await new Promise(resolve=>window.releaseCopy=resolve);};}')
  p.locator('#copy-patient-id').click();p.wait_for_function('()=>copyHeld');self.assertEqual(self.clipboard(p),a.patient_id)
  p.evaluate('()=>copyViewedPatientId()');expect(p.locator('#copy-patient-id')).to_be_disabled()
  self.select(p,b);self.select(p,a);expect(p.locator('#copy-patient-status')).to_be_empty();p.evaluate('()=>releaseCopy()');expect(p.locator('#copy-patient-id')).to_be_enabled();expect(p.locator('#copy-patient-status')).to_be_empty()
  self.assertEqual(p.evaluate('()=>copyCalls'),[a.patient_id]);self.assertEqual(self.clipboard(p),a.patient_id)
  p.evaluate('()=>navigator.clipboard.writeText=window.nativeCopy');self.select(p,b);p.locator('#copy-patient-id').click();self.copied(p);self.assertEqual(self.clipboard(p),b.patient_id)
  print('COPY late real-write completion held locally: one invocation; A-B-A stale success discarded; explicit B retry copies B',flush=True)

 def test_copy_03_input_modal_preservation_and_session(self):
  f=self.ct('000C-'+uuid.uuid4().hex[:12],'preserve','20260801');self.seed_report(f);p=self.login();self.permit(p);self.select(p,f)
  draft='COPY private draft 123';p.locator('#findings').fill(draft);p.locator('#quick').click();self.wait_state(p,f,lambda s:(s.get('draft') or {}).get('findings')==draft,timeout=25000)
  rows=self.report_rows(f);originals=self.originals();holder=self.state(f).get('holder');self.assertEqual(holder,self.stack.actor('doctor'))
  writes=self.source_writes(p);p.evaluate('()=>navigator.clipboard.writeText("COPY-SENTINEL")')
  for selector in ['#findings','#quick','#t-body']:
   p.locator(selector).focus();p.keyboard.press('Control+Alt+c');self.assertEqual(self.clipboard(p),'COPY-SENTINEL')
  p.evaluate('()=>{const e=document.createElement("div");e.id="copy-editable-test";e.contentEditable="true";e.textContent="editable";document.body.append(e);e.focus();}')
  p.keyboard.press('Control+Alt+c');self.assertEqual(self.clipboard(p),'COPY-SENTINEL');p.locator('#copy-editable-test').evaluate('e=>e.remove()')
  p.locator('#copy-patient-id').focus()
  for flag in ['repeat','isComposing']:
   self.assertTrue(p.evaluate('flag=>document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{bubbles:true,cancelable:true,ctrlKey:true,altKey:true,code:"KeyC",[flag]:true}))',flag))
  p.locator('#sr-open').click();p.keyboard.press('Control+Alt+c');self.assertEqual(self.clipboard(p),'COPY-SENTINEL');p.keyboard.press('Escape')
  p.locator('#copy-patient-id').focus();p.keyboard.press('Enter');self.copied(p);self.assertEqual(self.clipboard(p),f.patient_id)
  expect(p.locator('#findings')).to_have_value(draft);self.assertEqual(writes,[]);self.assertEqual(self.report_rows(f),rows);self.assertEqual(self.state(f).get('holder'),holder);self.assertEqual(self.originals(),originals)
  # Response-state variants exercise unavailable targets without editing any source data.
  p.evaluate('()=>{window.savedCopyId=viewed().id;viewed().id="";renderClinical();}');expect(p.locator('#copy-patient-id')).to_be_disabled()
  p.evaluate('()=>{viewed().id=savedCopyId;demoMode=true;renderClinical();}');expect(p.locator('#copy-patient-id')).to_be_disabled()
  p.evaluate('()=>{demoMode=false;renderClinical();}');expect(p.locator('#copy-patient-id')).to_be_enabled()
  p.once('dialog',lambda d:d.accept());p.locator('#logout').click();p.wait_for_url('**/auth/**',timeout=30000);self.assertEqual(self.clipboard(p),f.patient_id)
  p=self.login();self.permit(p);expect(p.locator('#copy-patient-id')).to_be_disabled();self.select(p,f);p.locator('#copy-patient-id').click();self.copied(p);self.assertEqual(self.clipboard(p),f.patient_id);expect(p.locator('#findings')).to_have_value(draft)

def load_tests(loader,tests,pattern):return unittest.TestSuite(PatientIdCopyE2E(n) for n in loader.getTestCaseNames(PatientIdCopyE2E) if n.startswith('test_copy_'))
if __name__=='__main__':unittest.main(verbosity=2)
