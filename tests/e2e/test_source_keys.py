"""A source-native opaque key must not prevent valid studies from loading."""
import copy,hashlib,json,re,sys,unittest,uuid,warnings
from pathlib import Path
from urllib.parse import quote
from pydicom.uid import generate_uid
from pynetdicom import AE
from playwright.sync_api import expect
from test_worklist import WorklistE2E
from invariants_live import ROOT,psql
sys.path.insert(0,str(ROOT/'scripts'))
from send_cstore import public_ct_series,DEFAULT_SOURCE
class SourceKeysE2E(WorklistE2E):
 def test_source_key_01_opaque_original_keeps_normal_worklist_available(self):
  valid=self.fixture();self.seed_report(valid)
  marker='SOURCEKEY-'+uuid.uuid4().hex;key='KIN_BAD-'+uuid.uuid4().hex+'.'+uuid.uuid4().hex[:23]
  self.assertEqual(len(key),64)
  def find():
   r=self.stack._orthanc_request('POST','/tools/find',json.dumps({'Level':'Study','Query':{'PatientID':marker},'ResponseContent':['RequestedTags'],'RequestedTags':['StudyInstanceUID','PatientID']}).encode());self.assertEqual(r.status,200);return r.body
  self.assertEqual(find(),[])
  source,base=public_ct_series(DEFAULT_SOURCE,1)[0];before=hashlib.sha256(source.read_bytes()).hexdigest()
  def cleanup():
   self.close_contexts();self.contexts=[]
   for row in find():
    if row.get('Type')!='Study' or row['RequestedTags']['StudyInstanceUID']!=key or row['RequestedTags']['PatientID']!=marker or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{8}){4}',row['ID']):raise RuntimeError('Refusing cleanup of unowned source key')
    self.assertEqual(self.stack._orthanc_request('DELETE','/studies/'+row['ID']).status,200)
   self.assertEqual(find(),[]);self.assertTrue(re.fullmatch(r'[A-Za-z0-9._-]+',key))
   psql('BEGIN; DELETE FROM "StudyState" WHERE uid=\''+key+'\'; DELETE FROM "AuditLog" WHERE target=\''+key+'\'; COMMIT;')
   self.assertEqual(psql('SELECT count(*) FROM "StudyState" WHERE uid=\''+key+'\';'),['0'])
   self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),before)
  self.addCleanup(cleanup)
  ds=copy.deepcopy(base)
  with warnings.catch_warnings():
   warnings.filterwarnings('ignore',message='Invalid value for VR UI:.*',category=UserWarning)
   ds.StudyInstanceUID=key
  ds.SeriesInstanceUID=generate_uid();ds.FrameOfReferenceUID=generate_uid();ds.SOPInstanceUID=generate_uid();ds.file_meta.MediaStorageSOPInstanceUID=ds.SOPInstanceUID
  ds.SpecificCharacterSet='ISO_IR 192';ds.PatientID=marker;ds.PatientName='SYNTHETIC^SOURCE^KEY';ds.InstitutionName=marker;ds.StudyDescription='SYNTHETIC original key compatibility'
  ae=AE(ae_title='KIN_SOURCE_KEY');ae.add_requested_context(str(ds.SOPClassUID),str(ds.file_meta.TransferSyntaxUID));association=ae.associate('127.0.0.1',4242,ae_title='KINLAB');self.assertTrue(association.is_established)
  try:self.assertEqual(getattr(association.send_c_store(ds),'Status',None),0)
  finally:association.release()
  native=self.stack._orthanc_request('GET','/dicom-web/studies?StudyInstanceUID='+quote(key,safe=''));self.assertEqual(native.status,200);self.assertEqual([r['0020000D']['Value'][0] for r in native.body],[key])
  legacy=self.stack.request('GET','/studies','doctor');self.assertEqual(legacy.status,200);self.assertIn(valid.uid,[r['uid'] for r in legacy.body['studies']]);self.assertNotIn(key,[r['uid'] for r in legacy.body['studies']])
  paged=self.stack.request('GET','/studies?limit=100','doctor');self.assertEqual(paged.status,200);self.assertIn(valid.uid,[r['uid'] for r in paged.body['studies']]);self.assertNotIn(key,[r['uid'] for r in paged.body['studies']])
  page=self.login();self.select(page,valid);expect(page.locator('#findings')).to_have_value(valid.secret)
  page.locator('#findings').fill('Keep normal report with opaque source key');page.locator('#refresh').click();expect(page.locator('#study-fetch')).not_to_be_visible();expect(page.locator('#findings')).to_have_value('Keep normal report with opaque source key')
  orphans=self.stack.request('GET','/unassigned','jmryu');self.assertEqual(orphans.status,200);self.assertEqual(next(r for r in orphans.body['studies'] if r['uid']==key)['id'],marker)
  self.assertEqual(find()[0]['RequestedTags']['StudyInstanceUID'],key)
def load_tests(loader,tests,pattern):
 return unittest.TestSuite(SourceKeysE2E(n) for n in loader.getTestCaseNames(SourceKeysE2E) if n.startswith('test_source_key_'))
if __name__=='__main__':unittest.main(verbosity=2)
