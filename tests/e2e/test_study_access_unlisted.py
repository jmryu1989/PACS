# coding: utf-8
"""Conditional access when an original study has no worklist state row yet."""
import sys,json,uuid,unittest
from test_study_access import StudyAccessE2E,policy,lit
from test_worklist import psql

class StudyAccessUnlistedE2E(StudyAccessE2E):
    def test_unlisted_matching_prepares_original_tags_before_transaction(self):
        a=self.fixture();oid='SYNTHETIC-access-'+uuid.uuid4().hex
        self.write(policy(rules=[dict(patientId=a.patient_id,modalities=[],dateFrom=None,dateTo=None,studyUids=[])]),who='tech')
        self.assertIn(a.uid,self.stack.active)
        raw=psql('SELECT to_jsonb(t)::text FROM "StudyState" t WHERE uid='+lit(a.uid));self.assertEqual(len(raw),1)
        self.assertEqual(psql('DELETE FROM "StudyState" t WHERE to_jsonb(t)='+lit(raw[0])+'::jsonb RETURNING uid'),[a.uid])
        def cleanup():
            for value in psql('SELECT to_jsonb(t)::text FROM "Order" t WHERE oid='+lit(oid)):
                row=json.loads(value);self.assertEqual(row['patientId'],a.patient_id);self.assertTrue(row['name'].startswith('SYNTHETIC'))
                self.assertEqual(psql('DELETE FROM "Order" t WHERE to_jsonb(t)='+lit(value)+'::jsonb RETURNING oid'),[oid])
        self.addCleanup(cleanup)
        psql('INSERT INTO "Order" (oid,"institutionId","patientId",name,sex,birth,sched,modality,descr,ward,"reqDoc") VALUES ('+','.join(lit(v) for v in [oid,'hallym',a.patient_id,'SYNTHETIC original matching','O','','20260910','CT','SYNTHETIC','',''])+')')
        r=self.stack.request('POST','/match','tech',dict(uid=a.uid,oid=oid,patient={}))
        self.assertEqual(r.status,201,r.text);self.assertEqual(r.body['matched'],'M')
        r=self.stack.request('POST','/unmatch','tech',dict(uid=a.uid));self.assertEqual(r.status,201,r.text)
        self.assertEqual(psql('SELECT matched FROM "Order" WHERE oid='+lit(oid)),['U'])

def load_tests(loader,tests,pattern):
    return unittest.TestSuite([StudyAccessUnlistedE2E('test_unlisted_matching_prepares_original_tags_before_transaction')])

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
