"""100 actual, isolated one-instance studies exercise the production QIDO UID-list adapter."""
import copy,hashlib,json,re,subprocess,sys,unittest,uuid
from pathlib import Path
from pydicom.uid import generate_uid
from pynetdicom import AE
from invariants_live import LiveStack,ROOT,psql
sys.path.insert(0,str(ROOT/'scripts'))
from send_cstore import public_ct_series,DEFAULT_SOURCE
class StudySourceBatch(unittest.TestCase):
 def test_source_batch_100_actual_studies(self):
  stack=LiveStack();token='SOURCEBATCH-'+uuid.uuid4().hex;uids=[generate_uid() for _ in range(100)]
  self.assertEqual(len(set(uids)),100);self.assertTrue(all(len(u)==64 and re.fullmatch(r'[0-9.]+',u) for u in uids))
  def find(query):
   r=stack._orthanc_request('POST','/tools/find',json.dumps({'Level':'Study','Query':query,'ResponseContent':['RequestedTags'],'RequestedTags':['StudyInstanceUID','PatientID']}).encode())
   self.assertEqual(r.status,200);self.assertIsInstance(r.body,list);return r.body
  initial=find({});self.assertFalse(set(uids)&{r['RequestedTags']['StudyInstanceUID'] for r in initial});self.assertFalse(find({'PatientID':token}))
  source_path,base=public_ct_series(DEFAULT_SOURCE,1)[0];before=hashlib.sha256(source_path.read_bytes()).hexdigest()
  def cleanup():
   rows=find({'PatientID':token});ids=[]
   for r in rows:
    if r.get('Type')!='Study' or r['RequestedTags']['StudyInstanceUID'] not in uids or r['RequestedTags']['PatientID']!=token or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{8}){4}',r['ID']):raise RuntimeError('Refusing cleanup of unowned source identity')
    ids.append(r['ID'])
   if ids:
    result=stack._orthanc_request('POST','/tools/bulk-delete',json.dumps({'Resources':ids}).encode());self.assertEqual(result.status,200)
   self.assertEqual(find({'PatientID':token}),[])
   quoted=','.join("'"+u+"'" for u in uids)
   psql('BEGIN; DELETE FROM "StudyState" WHERE uid IN ('+quoted+'); DELETE FROM "AuditLog" WHERE target IN ('+quoted+'); COMMIT;')
   self.assertEqual(psql('SELECT count(*) FROM "StudyState" WHERE uid IN ('+quoted+');'),['0'])
   self.assertEqual(hashlib.sha256(source_path.read_bytes()).hexdigest(),before)
  self.addCleanup(cleanup)
  ae=AE(ae_title='KIN_SOURCE_BATCH');ae.add_requested_context(str(base.SOPClassUID),str(base.file_meta.TransferSyntaxUID));association=ae.associate('127.0.0.1',4242,ae_title='KINLAB');self.assertTrue(association.is_established)
  try:
   for uid in uids:
    ds=copy.deepcopy(base);ds.StudyInstanceUID=uid;ds.SeriesInstanceUID=generate_uid();ds.FrameOfReferenceUID=generate_uid();ds.SOPInstanceUID=generate_uid();ds.file_meta.MediaStorageSOPInstanceUID=ds.SOPInstanceUID
    ds.SpecificCharacterSet='ISO_IR 192';ds.PatientID=token;ds.PatientName='SYNTHETIC^SOURCE^BATCH';ds.InstitutionName=token;ds.StudyDescription='SYNTHETIC source page batch';ds.AccessionNumber='SOURCEBATCH';ds.InstanceNumber=1
    self.assertEqual(getattr(association.send_c_store(ds),'Status',None),0)
  finally:association.release()
  self.assertEqual(len(find({'PatientID':token})),100)
  script="""const fs=require('fs'),a=require('assert');const {OrthancService}=require('/app/dist/orthanc.service');const input=JSON.parse(fs.readFileSync(0,'utf8'));(async()=>{const rows=await new OrthancService().studiesByUid(input.uids);a.deepStrictEqual(rows.map(r=>OrthancService.tag(r,'0020000D')),input.uids);a(rows.every(r=>OrthancService.tag(r,'00100020')===input.token));console.log(JSON.stringify({actualStudies:rows.length,uidLength:64,exactOrder:true,exactPatient:true,encodedUidListBytes:encodeURIComponent(input.uids.join(',')).length}));})().catch(e=>{console.error(e.name);process.exit(1)});"""
  run=subprocess.run(['docker','compose','exec','-T','api','node','-e',script],cwd=ROOT,input=json.dumps({'uids':uids,'token':token}).encode(),capture_output=True,timeout=60)
  self.assertEqual(run.returncode,0,run.stderr.decode(errors='replace'));result=json.loads(run.stdout);self.assertEqual(result['actualStudies'],100);print(json.dumps(result),flush=True)
if __name__=='__main__':unittest.main(verbosity=2)
