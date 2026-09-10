"""Restriction status, unsaved report retention and malformed administrative input."""
import json
import sys
import unittest
import uuid
from playwright.sync_api import expect
from test_study_access import StudyAccessE2E,policy,lit
from test_worklist import psql

class StudyAccessRecoveryE2E(StudyAccessE2E):
    def test_recovery_03_institution_move_requires_explicit_new_scope(self):
        self.fixture();foreign=self.fixture(institution='KIN 판독센터');self.owner('doctor');self.owner('kdoctor')
        doctor=self.stack.user_ids['doctor'];other=self.stack.user_ids['kdoctor']
        def membership(subject,institution,roles):
            r=self.stack.request('PATCH','/admin/users/'+subject,'jmryu',dict(approvalState='APPROVED',institution=institution,roles=roles))
            self.assertEqual(r.status,200,r.text);self.stack.tokens.clear()
        def restore():
            membership(doctor,'hallym',['radiologist']);membership(other,'kin-center',['radiologist'])
        self.addCleanup(restore)
        self.write(policy(restricted=False))
        membership(doctor,'kin-center',['radiologist']);membership(other,'kin-center',['radiologist','admin'])
        r=self.stack.request('GET','/study-access','doctor');self.assertEqual(r.status,200,r.text);self.assertTrue(r.body['denied']);self.assertTrue(r.body['needsInstitutionReview'])
        r=self.stack.request('GET','/studies','doctor');self.assertEqual(r.status,200,r.text);self.assertEqual(r.body['studies'],[])
        self.write(policy(restricted=False),actor='kdoctor')
        r=self.stack.request('GET','/studies','doctor');self.assertEqual(r.status,200,r.text);self.assertIn(foreign.uid,[x['uid'] for x in r.body['studies']])
        self.assertEqual(self.stack.request('GET','/admin/users/'+doctor+'/study-access','jmryu').status,404)

    def test_recovery_01_status_change_retains_unsaved_report(self):
        a,b=self.fixture(),self.fixture();self.seed_report(a);p=self.login();self.select(p,a)
        p.locator('#findings').fill('SYNTHETIC UNSAVED ACCESS TEXT');p.evaluate('clearInterval(poll)')
        expect(p.locator('#study-access-open')).to_be_enabled();p.locator('#study-access-open').click()
        d=p.locator('#study-access-status');expect(d).to_be_visible();expect(d.locator('[data-status]')).to_contain_text('Revision 0')
        self.write(policy([b.uid]));d.locator('[data-refresh]').click();expect(d.locator('[data-status]')).to_contain_text('Restricted')
        expect(p.locator('#rows tr[data-uid="'+a.uid+'"]').first).to_have_count(0)
        expect(p.locator('#findings')).to_have_value('SYNTHETIC UNSAVED ACCESS TEXT')
        self.write(policy(endsAt='2020-01-01T00:00:00.000Z'),revision=1);d.locator('[data-refresh]').click();expect(d.locator('[data-status]')).to_contain_text('Denied')
        expect(p.locator('#findings')).to_have_value('SYNTHETIC UNSAVED ACCESS TEXT')
        p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close();}")
        expect(d).to_have_count(0);expect(p.locator('#study-access-open')).to_be_disabled()

    def test_recovery_04_poll_recovers_changed_policy_after_outage(self):
        a,b=self.fixture(),self.fixture();self.seed_report(a);p=self.login();self.select(p,a)
        p.locator('#findings').fill('SYNTHETIC OUTAGE UNSAVED');p.evaluate('clearInterval(poll)')
        p.locator('#study-access-open').click();d=p.locator('#study-access-status')
        expect(d.locator('[data-status]')).to_contain_text('Revision 0')
        p.route('**/api/study-access',lambda route:route.abort('failed'))
        d.locator('[data-refresh]').click();expect(p.locator('#study-access-open')).to_contain_text('Unverified')
        self.write(policy([b.uid]));p.unroute('**/api/study-access')
        # Recovery is driven by the real status timer, without manual refresh.
        expect(d.locator('[data-status]')).to_contain_text('Revision 1',timeout=40000)
        expect(p.locator('#rows tr[data-uid="'+a.uid+'"]').first).to_have_count(0)
        expect(p.locator('#findings')).to_have_value('SYNTHETIC OUTAGE UNSAVED')

    def test_recovery_02_strict_admin_input_does_not_mutate_policy(self):
        self.fixture();path=self.path();self.write(policy())
        before=psql('SELECT to_jsonb(t)::text FROM "StudyAccessPolicy" t WHERE subject='+lit(self.owner('doctor')[1]))
        for bad in [dict(policy(),extra=True),policy(rules=[{}]),policy(startsAt='2026-02-30T00:00:00.000Z'),policy(restricted=False,rules=[{'all':True}]),policy(rules=[dict(patientId=None,modalities=[],dateFrom=None,dateTo=None,studyUids=['2.25.1']*1001)])]:
            body=self.body(bad,revision=1);r=self.stack.request('POST',path,'jmryu',body);self.assertEqual(r.status,400,r.text)
        body=self.body(policy(),revision=1);body['expectedOwner']=self.owner('doctor')
        self.assertEqual(self.stack.request('POST',path,'jmryu',body).status,409)
        upper='/admin/users/'+self.owner('doctor')[1].upper()+'/study-access'
        self.assertEqual(self.stack.request('GET',upper,'jmryu').status,404)
        self.assertEqual(psql('SELECT to_jsonb(t)::text FROM "StudyAccessPolicy" t WHERE subject='+lit(self.owner('doctor')[1])),before)

def load_tests(loader,tests,pattern):
    return unittest.TestSuite(StudyAccessRecoveryE2E(name) for name in StudyAccessRecoveryE2E.__dict__ if name.startswith('test_recovery_'))

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
