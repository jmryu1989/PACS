"""Restricted collection references and multi-study saved jobs."""
import json
import sys
import unittest
import uuid
from unittest.mock import patch
import test_worklist as base
from test_study_access import StudyAccessE2E,policy,lit
from test_viewer_jobs import ViewerJobsE2E
from viewer_api_test import ViewerStack
from test_worklist import psql

class StudyAccessReferencesE2E(StudyAccessE2E):
    @classmethod
    def setUpClass(cls):
        with patch.object(base,'LiveStack',ViewerStack):super().setUpClass()

    def cleanup_fixtures(self):
        for uid in list(self.stack.active):
            for raw in psql('SELECT to_jsonb(t)::text FROM "ViewerJob" t WHERE "studyUid"='+lit(uid)):
                row=json.loads(raw);self.assertIn(row['authorSub'],self.stack.user_ids.values());self.assertTrue(set(row['studies'])<=set(self.stack.active))
                for rev in psql('SELECT to_jsonb(t)::text FROM "ViewerJobRevision" t WHERE "jobId"='+lit(row['id'])+'::uuid'):
                    self.assertEqual(psql('DELETE FROM "ViewerJobRevision" t WHERE to_jsonb(t)='+lit(rev)+'::jsonb RETURNING 1'),['1'])
                self.assertEqual(psql('DELETE FROM "ViewerJob" t WHERE to_jsonb(t)='+lit(raw)+'::jsonb RETURNING 1'),['1'])
        super().cleanup_fixtures()

    def test_ref_01_multi_study_job_list_restore_and_preview(self):
        patient='SYNTHETIC-'+uuid.uuid4().hex;a=self.fixture(patient_id=patient);b=self.fixture(patient_id=patient)
        command=ViewerJobsE2E.command(self,[a,b]);r=self.stack.request('POST','/studies/'+a.uid+'/viewer-jobs','doctor',command);self.assertEqual(r.status,200,r.text)
        self.write(policy(rules=[dict(patientId=a.patient_id,modalities=[],dateFrom=None,dateTo=None,studyUids=[a.uid])]))
        r=self.stack.request('GET','/studies/'+a.uid+'/viewer-jobs','doctor');self.assertEqual(r.status,200,r.text);self.assertEqual(r.body['jobs'],[])
        r=self.stack.request('GET','/studies/'+a.uid+'/viewer-jobs/'+command['id'],'doctor');self.assertIn(r.status,[403,404],r.text)
        # An allowed anchor must not authorize the comparison's restricted prior.
        r=self.stack.request('POST','/studies/'+a.uid+'/viewer-jobs','doctor',ViewerJobsE2E.command(self,[a,b]));self.assertIn(r.status,[403,404],r.text)
        r=self.stack.request('GET','/studies/'+b.uid+'/report-preview','doctor');self.assertIn(r.status,[403,404],r.text)

    def test_ref_02_favorites_and_consultations_hide_uid_and_count(self):
        a,b=self.fixture(),self.fixture();owner=self.owner('doctor');subject=owner[1];actor=self.stack.request('GET','/me','doctor').body['actor']
        self.owner('doctor2');ids=set()
        def cleanup():
            for table,column,value in [('FavoriteWorkspace','subject',subject),('StudyConsultation','requesterSub',subject)]:
                for raw in psql('SELECT to_jsonb(t)::text FROM "'+table+'" t WHERE "'+column+'"='+lit(value)):
                    row=json.loads(raw)
                    if table=='StudyConsultation':self.assertIn(row['id'],ids)
                    self.assertEqual(psql('DELETE FROM "'+table+'" t WHERE to_jsonb(t)='+lit(raw)+'::jsonb RETURNING 1'),['1'])
            for raw in psql('SELECT to_jsonb(t)::text FROM "AuditLog" t WHERE actor='+lit(actor)+" AND action LIKE 'favorite.%'"):
                self.assertEqual(psql('DELETE FROM "AuditLog" t WHERE to_jsonb(t)='+lit(raw)+'::jsonb RETURNING 1'),['1'])
        self.addCleanup(cleanup)
        folder=str(uuid.uuid4());revision=0
        for action,extra in [('create',dict(name='SYNTHETIC folder')),('add',dict(uid=a.uid)),('add',dict(uid=b.uid))]:
            body=dict(expectedOwner=owner,revision=revision,requestId=str(uuid.uuid4()),folderId=folder,action=action,**extra)
            r=self.stack.request('POST','/favorite-folders','doctor',body);self.assertEqual(r.status,201,r.text);revision=r.body['revision']
        request=str(uuid.uuid4());ids.add(request)
        r=self.stack.request('POST','/studies/'+b.uid+'/consultations','doctor',dict(expectedOwner=owner,requestId=request,recipientSub=self.stack.user_ids['doctor2'],reason='SYNTHETIC consultation'));self.assertEqual(r.status,201,r.text)
        self.write(policy(rules=[dict(patientId=a.patient_id,modalities=[],dateFrom=None,dateTo=None,studyUids=[a.uid])]))
        r=self.stack.request('GET','/favorite-folders','doctor');self.assertEqual(r.status,200,r.text);self.assertEqual(r.body['folders'][0]['uids'],[a.uid]);self.assertEqual(r.body['folders'][0]['unavailable'],0);self.assertNotIn(b.uid,r.text)
        r=self.stack.request('GET','/consultations?direction=sent','doctor');self.assertEqual(r.status,200,r.text);self.assertEqual(r.body['items'],[]);self.assertIsNone(r.body['nextCursor'])
        r=self.stack.request('GET','/consultations/'+request,'doctor');self.assertIn(r.status,[403,404],r.text)

    def test_ref_03_tags_opaque_dicom_selectors_and_global_counts(self):
        a,b=self.fixture(),self.fixture();owner=self.owner('doctor');tag=str(uuid.uuid4());revision=0
        instance=self.stack.first_instance_id(b.uid);sop=ViewerJobsE2E.command(self,[b])['snapshot']['cells'][0]['sop']
        def cleanup():
            for raw in psql('SELECT to_jsonb(t)::text FROM "StudyTagCatalog" t WHERE "ownerSub"='+lit(owner[1])):
                row=json.loads(raw);self.assertEqual({t['id'] for t in json.loads(row['value'])},{tag})
                self.assertEqual(psql('DELETE FROM "StudyTagCatalog" t WHERE to_jsonb(t)='+lit(raw)+'::jsonb RETURNING 1'),['1'])
        self.addCleanup(cleanup)
        for action,extra in [('create',dict(name='SYNTHETIC access tag')),('add',dict(uid=a.uid)),('add',dict(uid=b.uid))]:
            body=dict(expectedOwner=owner,scope='personal',revision=revision,requestId=str(uuid.uuid4()),tagId=tag,action=action,**extra)
            r=self.stack.request('POST','/study-tags','doctor',body);self.assertEqual(r.status,201,r.text);revision=next(c for c in r.body['catalogs'] if c['scope']=='personal')['revision']
        self.write(policy(rules=[dict(patientId=a.patient_id,modalities=[],dateFrom=None,dateTo=None,studyUids=[a.uid])]))
        r=self.stack.request('GET','/study-tags','doctor');self.assertEqual(r.status,200,r.text);tags=next(c for c in r.body['catalogs'] if c['scope']=='personal')['tags'];self.assertEqual(tags[0]['uids'],[a.uid]);self.assertEqual(tags[0]['unavailable'],0);self.assertNotIn(b.uid,r.text)
        for path in ['/statistics','/instances/'+instance+'/file','/dicom-web/studies?StudyInstanceUID='+a.uid+'&StudyInstanceUID='+b.uid,'/dicom-web/studies?StudyInstanceUID='+a.uid+'&0020000D='+b.uid]:
            r=self.stack.bearer_request('GET',path,self.stack.token('doctor'),base=self.stack.proxy);self.assertEqual(r.status,403,r.text)
        r=self.stack.request('POST','/dicom/lookup','doctor',dict(studyUid=b.uid,sopUid=sop));self.assertIn(r.status,[403,404],r.text)

def load_tests(loader,tests,pattern):
    return unittest.TestSuite(StudyAccessReferencesE2E(name) for name in StudyAccessReferencesE2E.__dict__ if name.startswith('test_ref_'))

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
