"""REQ-D01-STUDY-ACCESS / access, expiry, owner, stale, loss boundaries."""
import json
import sys
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from playwright.sync_api import expect
from test_worklist import WorklistE2E, psql

def lit(v): return "'"+str(v).replace("'","''")+"'"
def policy(uids=None, **changes):
    value=dict(version=1,restricted=True,startsAt=None,endsAt=None,rules=[] if uids is None else [dict(patientId=None,modalities=[],dateFrom=None,dateTo=None,studyUids=uids)])
    value.update(changes);return value

class StudyAccessE2E(WorklistE2E):
    def setUp(self):
        super().setUp();self.subjects=set();self.addCleanup(self.cleanup_access)

    def cleanup_access(self):
        self.close_contexts();self.contexts=[]
        for subject in self.subjects:
            self.assertIn(subject,self.stack.user_ids.values())
            for table in ['StudyAccessRevision','StudyAccessPolicy']:
                for raw in psql('SELECT to_jsonb(t)::text FROM "'+table+'" t WHERE subject='+lit(subject)):
                    row=json.loads(raw);self.assertTrue(row['reason'].startswith('SYNTHETIC'))
                    self.assertEqual(psql('DELETE FROM "'+table+'" t WHERE to_jsonb(t)='+lit(raw)+'::jsonb RETURNING 1'),['1'])
            for raw in psql('SELECT to_jsonb(t)::text FROM "AuditLog" t WHERE target='+lit(subject)+" AND action='study.access'"):
                row=json.loads(raw);self.assertTrue(json.loads(row['detail'])['reason'].startswith('SYNTHETIC'))
                self.assertEqual(psql('DELETE FROM "AuditLog" t WHERE to_jsonb(t)='+lit(raw)+'::jsonb RETURNING 1'),['1'])

    def owner(self,who='jmryu'):
        r=self.stack.request('GET','/me',who);self.assertEqual(r.status,200,r.text);return [r.body['institution'],r.body['sub']]

    def path(self,who='doctor'):
        subject=self.owner(who)[1];self.subjects.add(subject);return '/admin/users/'+subject+'/study-access'

    def body(self,p,revision=0,actor='jmryu'):
        return dict(expectedOwner=self.owner(actor),policy=p,revision=revision,reason='SYNTHETIC access restriction',requestId=str(uuid.uuid4()))

    def write(self,p,who='doctor',revision=0,body=None,actor='jmryu',status=201):
        r=self.stack.request('POST',self.path(who),actor,body or self.body(p,revision,actor));self.assertEqual(r.status,status,r.text);return r.body

    def test_access_01_uid_scope_all_resource_entries_and_expiry(self):
        a,b=self.fixture(),self.fixture();self.seed_report(a);self.seed_report(b)
        before=psql('SELECT to_jsonb(t)::text FROM "Report" t WHERE uid='+lit(b.uid))
        self.write(policy([a.uid]))
        r=self.stack.request('GET','/studies?limit=100','doctor');self.assertEqual(r.status,200,r.text)
        self.assertEqual([s['uid'] for s in r.body['studies']],[a.uid]);self.assertEqual(r.body['pagination']['total'],1)
        r=self.stack.request('GET','/bootstrap','doctor');self.assertEqual(r.status,200,r.text);self.assertEqual(set(r.body['states']),{a.uid})
        for suffix in ['/report/versions','/tech-note','/reader-assignment','/viewer-items','/viewer-jobs','/report-preview']:
            with self.subTest(path=suffix):
                r=self.stack.request('GET','/studies/'+b.uid+suffix,'doctor');self.assertIn(r.status,[403,404],r.text)
        for suffix,body in [('/hold',{}),('/report/commit',dict(action='save',baseVersion=1,findings='SHOULD NOT SAVE')),('/release',{})]:
            r=self.stack.request('POST','/studies/'+b.uid+suffix,'doctor',body);self.assertIn(r.status,[403,404],r.text)
        r=self.stack.request('PUT','/studies/'+b.uid+'/report','doctor',dict(findings='SHOULD NOT SAVE'));self.assertIn(r.status,[403,404],r.text)
        for uid,expected in [(a.uid,200),(b.uid,403)]:
            r=self.stack.bearer_request('GET','/dicom-web/studies/'+uid+'/series',self.stack.token('doctor'),base=self.stack.proxy);self.assertEqual(r.status,expected,r.text)
        r=self.stack.request('GET','/audit','doctor');self.assertEqual(r.status,200,r.text);self.assertNotIn(b.uid,[x['target'] for x in r.body])
        self.assertEqual(psql('SELECT to_jsonb(t)::text FROM "Report" t WHERE uid='+lit(b.uid)),before)
        self.write(policy([a.uid],endsAt='2020-01-01T00:00:00.000Z'),revision=1)
        r=self.stack.request('GET','/studies','doctor');self.assertEqual(r.status,200,r.text);self.assertEqual(r.body['studies'],[])
        r=self.stack.request('GET','/study-access','doctor');self.assertEqual(r.status,200,r.text);self.assertFalse(r.body['windowOpen']);self.assertTrue(r.body['restricted'])

    def test_access_02_original_metadata_or_and_and_page_revision(self):
        a,b=self.fixture(),self.fixture();r=self.stack.request('GET','/studies','doctor');self.assertEqual(r.status,200)
        original=next(s for s in r.body['studies'] if s['uid']==a.uid)
        rule=dict(patientId=a.patient_id,modalities=[original['modality'].split(',')[0]],dateFrom=None,dateTo=None,studyUids=[])
        self.write(policy(rules=[rule]))
        r=self.stack.request('GET','/studies?limit=1','doctor');self.assertEqual(r.status,200,r.text);self.assertEqual([s['uid'] for s in r.body['studies']],[a.uid])
        # UI overlays cannot grant/revoke a rule that is defined on original tags.
        r=self.stack.request('PATCH','/studies/'+a.uid,'jmryu',dict(ov=dict(id='SYNTHETIC-overlay')));self.assertEqual(r.status,200,r.text)
        self.assertEqual(self.stack.request('GET','/studies/'+a.uid+'/viewer-items','doctor').status,200)
        # Exercise metadata preparation before clinical transaction locks.
        r=self.stack.request('POST','/studies/'+a.uid+'/hold','doctor',{});self.assertEqual(r.status,201,r.text)
        r=self.stack.request('PUT','/studies/'+a.uid+'/report','doctor',dict(findings='SYNTHETIC conditional draft'));self.assertEqual(r.status,200,r.text)
        r=self.stack.request('POST','/studies/'+a.uid+'/release','doctor',{});self.assertEqual(r.status,201,r.text)

        self.write(policy([a.uid,b.uid]),revision=1)
        r=self.stack.request('GET','/studies?limit=1','doctor');self.assertEqual(r.status,200,r.text);cursor=r.body['pagination']['next'];self.assertTrue(cursor)
        self.write(policy([a.uid,b.uid]),revision=2)
        r=self.stack.request('GET','/studies?limit=1&after='+cursor,'doctor');self.assertEqual(r.status,409,r.text)

    def test_access_03_cas_replay_owner_role_and_clear(self):
        a=self.fixture();path=self.path();body=self.body(policy([a.uid]))
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.stack.request('POST',path,'jmryu',body),range(2)))
        self.assertEqual([r.status for r in results],[201,201]);self.assertEqual({r.body['revision'] for r in results},{1})
        self.write(policy(),revision=1)
        replay=self.stack.request('POST',path,'jmryu',body);self.assertEqual(replay.status,201,replay.text);self.assertTrue(replay.body['replayed'])
        current=self.stack.request('GET',path,'jmryu');self.assertEqual(current.body['revision'],2);self.assertEqual(current.body['policy']['rules'],[])
        wrong=dict(body,reason='SYNTHETIC changed reuse');self.assertEqual(self.stack.request('POST',path,'jmryu',wrong).status,409)
        self.assertEqual(self.stack.request('POST',path,'doctor',self.body(policy(),actor='doctor')).status,403)
        self.assertEqual(self.stack.request('GET',path,'kdoctor').status,403)
        self.write(policy(restricted=False),revision=2)
        self.assertFalse(self.stack.request('GET',path,'jmryu').body['policy']['restricted'])
        self.assertEqual(psql('SELECT count(*) FROM "StudyAccessRevision" WHERE subject='+lit(self.owner('doctor')[1])),['3'])

    def test_access_04_admin_ui_save_reload_and_lost_response(self):
        a=self.fixture();self.owner('doctor');p=self.login('jmryu');errors=[];p.on('pageerror',lambda e:errors.append(str(e)))
        p.goto(self.stack.proxy+'/worklist/hpacs-lite/admin.html')
        p.locator('#search').fill(self.stack.username('doctor'));row=p.locator('#users tr').filter(has=p.get_by_text(self.stack.username('doctor'),exact=True))
        for _ in range(30):
            if row.count():break
            if p.locator('#next').is_disabled():break
            previous=p.locator('#page-label').inner_text();p.locator('#next').click();expect(p.locator('#page-label')).not_to_have_text(previous)
        expect(row).to_be_visible()
        row.get_by_role('button',name='Study Access',exact=True).click();self.assertEqual(errors,[]);d=p.locator('#study-access-dialog');expect(d.locator('[data-status]')).to_contain_text('Revision 0')
        d.locator('[name=mode]').select_option('rules');d.locator('[data-add]').click();d.locator('[data-field=studyUids]').fill(a.uid);d.locator('[name=reason]').fill('SYNTHETIC browser access')
        self.subjects.add(self.owner('doctor')[1]);lost=[]
        def drop(route):
            if route.request.method=='POST' and not lost:
                response=route.fetch();self.assertEqual(response.status,201);lost.append(route.request.post_data_json);route.abort('failed')
            else:route.continue_()
        p.route('**/api/admin/users/*/study-access',drop)
        d.locator('[data-save]').click();expect(d.locator('[data-retry]')).to_be_visible();expect(d.locator('[name=reason]')).to_be_disabled()
        d.locator('[data-retry]').click();expect(d.locator('[data-status]')).to_contain_text('Saved · Revision 1')
        d.locator('[data-reload]').click();expect(d.locator('[data-status]')).to_contain_text('Revision 1');expect(d.locator('[data-field=studyUids]')).to_have_value(a.uid)
        folder=Path('../tmp/study-access/screens');folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'admin-access.png'))

def load_tests(loader,tests,pattern):
    return unittest.TestSuite(StudyAccessE2E(name) for name in StudyAccessE2E.__dict__ if name.startswith('test_access_'))

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
