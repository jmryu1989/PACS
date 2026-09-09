"""Original UID inventory + page details, cold/unknown registration and existing API equality."""
import json,re,unittest
from study_query_scope_live import StudyQueryScopeLive
from invariants_live import psql
class StudySourceLive(StudyQueryScopeLive):
    def test_source_01_original_registration_remains_unverified_and_tenant_scoped(self):
        with self.stack.fixture() as a:
            assert a.uid in self.stack.active and re.fullmatch(r'[0-9.]+',a.uid)
            native=self.stack._orthanc_request('POST','/tools/find',json.dumps({'Level':'Study','Query':{'StudyInstanceUID':a.uid},'ResponseContent':['RequestedTags'],'RequestedTags':['StudyInstanceUID','InstitutionName']}).encode())
            self.assertEqual(native.status,200);self.assertEqual(len(native.body),1)
            self.assertEqual(native.body[0]['RequestedTags'],{'StudyInstanceUID':a.uid,'InstitutionName':a.institution})
            before=next(s for s in self.collect() if s['uid']==a.uid)
            psql('DELETE FROM "StudyState" WHERE uid=\''+a.uid+'\';')
            after=next(s for s in self.collect() if s['uid']==a.uid)
            self.assertEqual(after['state']['institutionId'],'hallym');self.assertEqual(after['state']['ss'],'Unverified')
            for key in ['uid','name','id','sourcePatientKey','birth','date','sex','modality','desc','count','series']:self.assertEqual(after[key],before[key])
            psql('UPDATE "StudyState" SET "institutionId"=NULL WHERE uid=\''+a.uid+'\';')
            again=next(s for s in self.collect() if s['uid']==a.uid);self.assertEqual(again['state']['institutionId'],'hallym')
            self.assertNotIn(a.uid,[s['uid'] for s in self.collect('kdoctor')])
def load_tests(loader,tests,pattern):
    return unittest.TestSuite(StudySourceLive(name) for name in loader.getTestCaseNames(StudySourceLive) if name.startswith(('test_source_','test_query_','test_pages_')))
if __name__=='__main__':unittest.main(verbosity=2)
