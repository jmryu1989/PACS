# coding: utf-8
"""Read-only source SR trees, actual C-STORE documents and explicit response-boundary cases."""
import io,json,unittest,uuid
from pathlib import Path
import pydicom
from pydicom.dataset import Dataset,FileDataset,FileMetaDataset
from pydicom.uid import BasicTextSRStorage,ComprehensiveSRStorage,ExplicitVRLittleEndian,generate_uid
from pynetdicom import AE
from playwright.sync_api import expect
from test_related_context import RelatedContextE2E

def code(value,meaning,scheme='99KIN'):
 d=Dataset();d.CodeValue=value[:16];d.CodingSchemeDesignator=scheme;d.CodeMeaning=meaning;return d

def content(kind,name):
 d=Dataset();d.RelationshipType='CONTAINS';d.ValueType=kind;d.ConceptNameCodeSequence=[code(name,name)];return d

class SRReaderE2E(RelatedContextE2E):
 def source(self,f,basic=False):
  original=pydicom.dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/'+self.stack.first_instance_id(f.uid)+'/file')))
  sop,series=generate_uid(),generate_uid();cls=BasicTextSRStorage if basic else ComprehensiveSRStorage
  meta=FileMetaDataset();meta.TransferSyntaxUID=ExplicitVRLittleEndian;meta.MediaStorageSOPClassUID=cls;meta.MediaStorageSOPInstanceUID=sop;meta.ImplementationClassUID=generate_uid()
  d=FileDataset(None,{},file_meta=meta,preamble=b'\0'*128)
  for key in ['PatientName','PatientID','PatientBirthDate','PatientSex','InstitutionName','StudyInstanceUID','StudyDate','StudyTime','AccessionNumber','StudyID','StudyDescription']:setattr(d,key,getattr(original,key))
  d.SOPClassUID=cls;d.SOPInstanceUID=sop;d.SeriesInstanceUID=series;d.SpecificCharacterSet='ISO_IR 192';d.Modality='SR';d.SeriesNumber=8 if basic else 7;d.InstanceNumber=1
  d.SeriesDescription='SR basic' if basic else 'SR comprehensive';d.ContentDate='20260908';d.ContentTime='061500';d.CompletionFlag='COMPLETE';d.VerificationFlag='UNVERIFIED'
  d.ValueType='CONTAINER';d.ContinuityOfContent='SEPARATE';d.ConceptNameCodeSequence=[code('ROOT','Source report')]
  note=content('TEXT','Source text');note.TextValue='원문 <img src=x onerror="window.srBad=1">\n두 번째 줄'
  when=content('DATE','Source date');when.Date='20260908';at=content('TIME','Source time');at.Time='061500.125'
  group=content('CONTAINER','Source group');group.ContinuityOfContent='SEPARATE';group.ContentSequence=[note,when,at]
  d.ContentSequence=[group]
  if not basic:
   num=content('NUM','Source size');value=Dataset();value.NumericValue='12.340';value.MeasurementUnitsCodeSequence=[code('mm','millimeter','UCUM')];num.MeasuredValueSequence=[value]
   coded=content('CODE','Source code');coded.ConceptCodeSequence=[code('L','Left','SCT')]
   point=content('SCOORD','Source coordinates');point.GraphicType='POINT';point.GraphicData=[10.5,20.25]
   ref=content('IMAGE','Source image');item=Dataset();item.ReferencedSOPClassUID=original.SOPClassUID;item.ReferencedSOPInstanceUID=original.SOPInstanceUID;item.ReferencedFrameNumber=[1];ref.ReferencedSOPSequence=[item]
   point.ContentSequence=[ref];ref.RelationshipType='SELECTED FROM';group.ContentSequence.extend([num,coded,point])
  ae=AE(ae_title='HALLYM_CT');ae.add_requested_context(cls,ExplicitVRLittleEndian);assoc=ae.associate('127.0.0.1',4242,ae_title='KINLAB')
  self.assertTrue(assoc.is_established)
  try:self.assertEqual(assoc.send_c_store(d).Status,0)
  finally:assoc.release()
  return dict(study=f.uid,series=series,sop=sop,sopClass=str(cls),reference=str(original.SOPInstanceUID))

 def path(self,source):return '/dicom-web/studies/'+source['study']+'/series/'+source['series']+'/instances/'+source['sop']+'/metadata'
 def open_source(self,p,source):
  p.locator('#sr-open').click();expect(p.locator('#sr-series option[value="'+source['series']+'"]').first).to_be_attached()
  p.locator('#sr-series').select_option(source['series']);expect(p.locator('#sr-document option[value="'+source['sop']+'"]').first).to_be_attached();p.locator('#sr-document').select_option(source['sop'])
 def read_source(self,p):
  p.locator('#sr-read').click();expect(p.locator('#sr-tree')).to_contain_text('Content Sequence')
  p.locator('#sr-tree details:not([data-sr-metadata])').evaluate_all('nodes=>nodes.forEach(n=>n.open=true)')

 def test_sr_01_real_documents_and_original_values(self):
  f=self.ct('SR-'+uuid.uuid4().hex[:12],'current','20260801');full=self.source(f);basic=self.source(f,True);originals=self.originals()
  p=self.login();self.select(p,f);self.open_source(p,full);self.read_source(p)
  body=p.locator('#sr-tree').inner_text()
  for value in ['원문 <img src=x','두 번째 줄','12.34','UCUM','millimeter','SCT','20260908','061500.125','10.5','20.25',full['reference'],'Referenced Frame']:self.assertIn(value,body)
  self.assertIsNone(p.evaluate('window.srBad'));self.assertEqual(p.locator('#sr-tree img, #sr-tree a, #sr-tree script').count(),0)
  response=p.context.request.get(self.stack.proxy+self.path(full));self.assertEqual(response.status,200);raw=response.json()[0]
  print('SR source metadata '+json.dumps(raw,ensure_ascii=False),flush=True)
  tree=p.evaluate('arg=>srTree(arg.raw,arg.source)',dict(raw=raw,source=full));self.assertIn(str(raw['0040A730']['Value'][0]['0040A730']['Value'][3]['0040A300']['Value'][0]['0040A30A']['Value'][0]),json.dumps(tree))
  print('SR source identities and values '+json.dumps(dict(full=full,basic=basic,rendered=body),ensure_ascii=False),flush=True)
  p.screenshot(path=str(Path(__file__).parent/'artifacts/SR-source.png'))
  p.locator('#sr-tree').get_by_text('Numeric Value',exact=False).scroll_into_view_if_needed();p.screenshot(path=str(Path(__file__).parent/'artifacts/SR-values.png'))
  p.locator('#sr-close').click();self.open_source(p,basic);self.read_source(p);expect(p.locator('#sr-tree')).not_to_contain_text('Measured Value')
  self.assertEqual(self.originals(),originals)

 def test_sr_02_scope_delayed_response_and_actual_tenant(self):
  patient='SR-SCOPE-'+uuid.uuid4().hex[:12];a=self.ct(patient,'current','20260801');b=self.ct(patient,'past','20260701');sa=self.source(a);sa2=self.source(a,True);sb=self.source(b)
  p=self.login();self.select(p,a);self.open_source(p,sa)
  # Hold one real authenticated response body after it has arrived. This deliberately
  # ignores subsequent abort so the generation guard must reject late consumption.
  p.evaluate('''path=>{const native=window.fetch;window.srHeld=false;window.srDelivered=false;
   window.fetch=async(input,options)=>{const response=await native(input,options);if(!String(input).endsWith(path))return response;
    window.fetch=native;const bytes=new Uint8Array(await response.arrayBuffer());let first=true;
    const gate=new Promise(resolve=>window.srRelease=resolve);window.srHeld=true;
    return {ok:response.ok,status:response.status,body:{getReader:()=>({read:async()=>{if(!first)return {done:true};first=false;await gate;window.srDelivered=true;return {done:false,value:bytes};},cancel:async()=>{}})}};
   };}''',self.path(sa))
  p.locator('#sr-read').click();p.wait_for_function('()=>window.srHeld')
  # A background viewing change uses the same product handler while the modal is open.
  p.evaluate('uid=>previewRelated(uid)',b.uid);expect(p.locator('#sr-dialog')).not_to_be_visible();expect(p.locator('#sr-tree')).to_be_empty()
  p.evaluate('()=>returnToReportStudy()');self.open_source(p,sa2);self.read_source(p);expect(p.locator('#sr-tree')).not_to_contain_text('Measured Value')
  before=p.locator('#sr-tree').inner_text();p.evaluate('()=>window.srRelease()');p.wait_for_function('()=>window.srDelivered');p.wait_for_timeout(100)
  self.assertEqual(p.locator('#sr-tree').inner_text(),before);print('SR real response body held locally, abort ignored: old body delivered after A-B-A, current document unchanged',flush=True)
  expect(p.locator('#sr-tree')).to_contain_text('Content Sequence');p.locator('#sr-close').click()
  self.related(p,b).click();self.open_source(p,sb);self.read_source(p);expect(p.locator('#sr-context')).to_contain_text('2026-07-01');expect(p.locator('#sr-tree')).to_contain_text(sb['sop'])
  other=self.login('kdoctor');self.assertEqual(other.context.request.get(self.stack.proxy+self.path(sa)).status,403)
  expect(other.locator('#rows tr[data-uid="'+a.uid+'"]').first).to_have_count(0)
  p.locator('#sr-close').click();self.open_source(p,sb)
  p.route('**'+self.path(sb),lambda route:route.fulfill(status=403,body='denied'));p.locator('#sr-read').click();expect(p.locator('#sr-status')).to_contain_text('HTTP 403');expect(p.locator('#sr-tree')).to_be_empty();expect(p.locator('#sr-series option, #sr-document option')).to_have_count(0);expect(p.locator('#sr-read')).to_be_disabled()
  p.locator('#sr-close').click();p.once('dialog',lambda dialog:dialog.accept());p.locator('#logout').click();p.wait_for_url('**/auth/**',timeout=30000)

 def test_sr_03_explicit_failures_bounds_and_retry(self):
  f=self.ct('SR-FAIL-'+uuid.uuid4().hex[:12],'current','20260801');source=self.source(f);p=self.login();self.select(p,f);self.open_source(p,source)
  path='**'+self.path(source);original=p.context.request.get(self.stack.proxy+self.path(source)).json()
  cases=[(500,'oops','HTTP 500'),(200,'not json','SR 열람 실패'),(200,' '* (2*1024*1024+1),'2 MiB')]
  wrong=json.loads(json.dumps(original));wrong[0]['0020000D']['Value']=['9.8.7'];cases.append((200,json.dumps(wrong),'식별'))
  unsupported=json.loads(json.dumps(original));unsupported[0]['77770010']={'vr':'OB','BulkDataURI':'https://invalid.example/secret'};cases.append((200,json.dumps(unsupported),'바이너리'))
  for status,body,message in cases:
   p.route(path,lambda route,request,status=status,body=body:route.fulfill(status=status,content_type='application/dicom+json',body=body));p.locator('#sr-read').click();expect(p.locator('#sr-status')).to_contain_text(message);expect(p.locator('#sr-tree')).to_be_empty();p.unroute(path)
  self.read_source(p);p.locator('#sr-close').click()
  pattern='**/dicom-web/studies/'+f.uid+'/series?Modality=SR&limit=101'
  for rows,message in [([],'없습니다'),([{}]*101,'100개')]:
   p.route(pattern,lambda route,request,rows=rows:route.fulfill(status=200,content_type='application/dicom+json',body=json.dumps(rows)));p.locator('#sr-open').click();expect(p.locator('#sr-status')).to_contain_text(message);expect(p.locator('#sr-tree')).to_be_empty();p.locator('#sr-close').click();p.unroute(pattern)
  self.open_source(p,source);instance='**/dicom-web/studies/'+f.uid+'/series/'+source['series']+'/instances?*';p.route(instance,lambda route:route.fulfill(status=200,content_type='application/dicom+json',body=json.dumps([{}]*201)))
  p.locator('#sr-series').select_option('');p.locator('#sr-series').select_option(source['series']);expect(p.locator('#sr-status')).to_contain_text('200개');expect(p.locator('#sr-document option')).to_have_count(0)

 def test_sr_04_report_draft_keyboard_small_window_and_reload(self):
  f=self.ct('SR-PRESERVE-'+uuid.uuid4().hex[:12],'current','20260801');source=self.source(f);self.seed_report(f)
  p=self.login();self.select(p,f);draft='SR private draft 12345';p.locator('#findings').fill(draft);p.locator('#quick').click();self.wait_state(p,f,lambda s:(s.get('draft') or {}).get('findings')==draft,timeout=25000)
  rows=self.report_rows(f);originals=self.originals();state=self.state(f);writes=self.source_writes(p)
  p.set_viewport_size(dict(width=900,height=700));p.locator('#sr-open').focus();p.keyboard.press('Enter');expect(p.locator('#sr-dialog')).to_be_visible();p.keyboard.press('Escape');expect(p.locator('#sr-dialog')).not_to_be_visible()
  self.open_source(p,source);self.read_source(p);p.screenshot(path=str(Path(__file__).parent/'artifacts/SR-small.png'));p.locator('#sr-close').click();expect(p.locator('#findings')).to_have_value(draft)
  self.assertEqual(state.get('holder'),self.stack.actor('doctor'));self.assertEqual(writes,[]);self.assertEqual(self.report_rows(f),rows);self.assertEqual(self.state(f).get('holder'),state.get('holder'));self.assertEqual(self.originals(),originals)
  p.close();p=self.login();self.select(p,f);self.open_source(p,source);self.read_source(p);expect(p.locator('#findings')).to_have_value(draft)

def load_tests(loader,tests,pattern):return unittest.TestSuite(SRReaderE2E(n) for n in loader.getTestCaseNames(SRReaderE2E) if n.startswith('test_sr_'))
if __name__=='__main__':unittest.main(verbosity=2)
