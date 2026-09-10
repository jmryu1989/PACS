"""REQ-D01-CONSULTATION / RISK-ACCESS/TARGET/DUPLICATE/LOSS / TEST-CONSULTATION."""
import json
import sys
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from playwright.sync_api import expect
from test_worklist import WorklistE2E, psql


def lit(value): return "'"+str(value).replace("'","''")+"'"


class ConsultationE2E(WorklistE2E):
    def setUp(self):
        super().setUp();self.ids=set();self.addCleanup(self.cleanup_consultations)

    def cleanup_consultations(self):
        self.close_contexts();self.contexts=[]
        for uid in self.stack.active:
            for raw in psql('SELECT to_jsonb(t)::text FROM "StudyConsultation" t WHERE "studyUid"='+lit(uid)):
                row=json.loads(raw);self.assertIn(row['id'],self.ids)
                self.assertIn(row['requesterSub'],self.stack.user_ids.values());self.assertIn(row['recipientSub'],self.stack.user_ids.values())
                self.assertEqual(psql('DELETE FROM "StudyConsultation" t WHERE to_jsonb(t)='+lit(raw)+'::jsonb RETURNING 1'),['1'])

    def owner(self,actor='doctor'):
        r=self.stack.request('GET','/me',actor);self.assertEqual(r.status,200)
        return [r.body['institution'],r.body['sub']]

    def request_body(self,recipient='doctor2',actor='doctor',reason='SYNTHETIC consultation request'):
        id=str(uuid.uuid4());self.ids.add(id)
        return dict(expectedOwner=self.owner(actor),requestId=id,recipientSub=self.stack.user_ids[recipient],reason=reason)

    def create_request(self,f,actor='doctor',recipient='doctor2',body=None,status=201):
        body=body or self.request_body(recipient,actor)
        result=self.stack.request('POST',f'/studies/{f.uid}/consultations',actor,body)
        self.assertEqual(result.status,status,result.text);return result.body

    def change_body(self,row,action,actor='doctor2',note='SYNTHETIC consultation response'):
        return dict(expectedOwner=self.owner(actor),revision=row['revision'],requestId=str(uuid.uuid4()),action=action,note='' if action=='accept' else note)

    def change_request(self,row,action,actor='doctor2',body=None,status=201):
        result=self.stack.request('POST','/consultations/'+row['id'],actor,body or self.change_body(row,action,actor))
        self.assertEqual(result.status,status,result.text);return result.body

    def read_request(self,id,actor='doctor',status=200):
        r=self.stack.request('GET','/consultations/'+id,actor);self.assertEqual(r.status,status,r.text);return r.body

    def audits(self,f):
        return psql('SELECT detail FROM "AuditLog" WHERE target='+lit(f.uid)+" AND action='study.consultation' ORDER BY id")

    def login(self,actor='doctor'):
        p=super().login(actor)
        def capture(r):
            if r.method=='POST' and '/api/studies/' in r.url and r.url.endswith('/consultations'):self.ids.add(r.post_data_json['requestId'])
        p.on('request',capture);return p

    def open_dialog(self,p):
        p.locator('#consultations-open').click();expect(p.locator('#co-status')).to_contain_text('현재 불러온 의뢰')

    def test_consult_01_roles_institution_eligibility_and_original(self):
        a=self.fixture();self.seed_report(a)
        original=psql('SELECT to_jsonb(t)::text FROM "StudyState" t WHERE uid='+lit(a.uid));versions=self.versions(a)
        body=self.request_body();row=self.create_request(a,body=body)['item']
        self.assertEqual(self.create_request(a,body=body)['item'],row);self.assertEqual(len(self.audits(a)),1)
        self.create_request(a,status=409)
        self.change_request(row,'accept','doctor',status=403)
        self.read_request(row['id'],'kdoctor',404);self.read_request(row['id'],'tech',403)
        self.assertNotIn('creationFingerprint',row);self.assertNotIn('lastFingerprint',row)
        b=self.fixture();other=self.create_request(b,'jmryu','doctor')['item']
        self.read_request(other['id'],'doctor2',404)
        received=self.stack.request('GET','/consultations?direction=received','doctor2')
        self.assertEqual(received.status,200);self.assertEqual([r['id'] for r in received.body['items']],[row['id']])
        for who in ['doctor','tech','kdoctor']:self.create_request(b,recipient=who,status=400)
        self.assertEqual(self.stack.request('GET','/consultation-candidates','tech').status,403)
        target=self.stack.user_ids['doctor2'];self.assertEqual(self.stack.kc_admin('PUT',f'/users/{target}',{'enabled':False}).status,204)
        try:self.create_request(b,status=400)
        finally:self.assertEqual(self.stack.kc_admin('PUT',f'/users/{target}',{'enabled':True}).status,204)
        foreign=self.fixture(institution='KIN 판독센터');self.create_request(foreign,status=404)
        self.assertEqual(psql('SELECT to_jsonb(t)::text FROM "StudyState" t WHERE uid='+lit(a.uid)),original)
        self.assertEqual(self.versions(a),versions)

    def test_consult_02_concurrency_replay_completion_cancel(self):
        a=self.fixture();body=self.request_body();row=self.create_request(a,body=body)['item']
        commands=[self.change_body(row,'accept') for _ in range(2)]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda b:self.stack.request('POST','/consultations/'+row['id'],'doctor2',b),commands))
        self.assertEqual(sorted(r.status for r in results),[201,409]);winner=next(i for i,r in enumerate(results) if r.status==201)
        accepted=self.change_request(row,'accept',body=commands[winner])['item'];self.assertEqual(accepted['revision'],2)
        complete=self.change_body(accepted,'complete');done=self.change_request(accepted,'complete',body=complete)['item']
        self.assertEqual(done['state'],'Completed');self.assertEqual(done['reply'],complete['note'])
        self.assertEqual(self.change_request(accepted,'complete',body=complete)['item'],done)
        self.assertEqual(self.create_request(a,body=body)['item'],done);self.assertEqual(len(self.audits(a)),3)
        self.change_request(done,'cancel','doctor',status=409)
        next_row=self.create_request(a)['item'];cancelled=self.change_request(next_row,'cancel','doctor')['item']
        self.assertEqual(cancelled['state'],'Cancelled');self.assertTrue(cancelled['cancelReason'])
        self.assertEqual(self.versions(a),[])

    def test_consult_03_browser_received_reply_filter_and_report(self):
        a=self.fixture();b=self.fixture();self.seed_report(b)
        sender=self.login();self.select(sender,a);self.open_dialog(sender)
        sender.locator('#co-new').click();expect(sender.locator('#co-status')).to_contain_text('수신자와 의뢰 사유')
        sender.locator('#co-reader').select_option(self.stack.user_ids['doctor2'])
        reason='SYNTHETIC <img src=x onerror="window.consultBad=1"> consultation'
        sender.locator('#co-reason').fill(reason);sender.locator('#co-send').click()
        expect(sender.locator('#co-status')).to_contain_text('자문 요청을 저장했습니다')
        id=next(iter(self.ids));self.assertEqual(sender.evaluate('selectedUid'),a.uid)
        sender.locator('#co-close').click()
        receiver=self.login('doctor2');self.select(receiver,b);receiver.locator('#findings').fill('CONSULTATION PRIVATE DRAFT')
        self.open_dialog(receiver);receiver.locator(f'[data-consultation="{id}"]').click()
        expect(receiver.locator('#co-original')).to_have_text(reason);expect(receiver.locator('#co-original img')).to_have_count(0)
        self.assertIsNone(receiver.evaluate('window.consultBad'));self.assertEqual(receiver.evaluate('selectedUid'),b.uid)
        receiver.locator('#co-accept').click();expect(receiver.locator('#co-current-state')).to_contain_text('Accepted')
        receiver.locator('#co-note').fill('SYNTHETIC requested review completed')
        receiver.locator('#co-complete').click();expect(receiver.locator('#co-current-state')).to_contain_text('Completed')
        receiver.locator('#co-filter').click();expect(receiver.locator('#consultations-dialog')).not_to_be_visible()
        expect(receiver.locator('#rows tr[data-uid]')).to_have_count(1)
        expect(receiver.locator('#findings')).to_have_value('CONSULTATION PRIVATE DRAFT');self.assertEqual(receiver.evaluate('selectedUid'),b.uid)
        self.open_dialog(receiver);receiver.locator(f'[data-consultation="{id}"]').click()
        receiver.locator('#co-open-study').click();self.assertEqual(receiver.evaluate('selectedUid'),a.uid)
        self.assertEqual(len(self.versions(b)),1)
        self.open_dialog(sender);sender.locator('#co-direction').select_option('sent')
        sender.locator(f'[data-consultation="{id}"]').click()
        expect(sender.locator('#co-answer')).to_have_text('SYNTHETIC requested review completed')
        sender.screenshot(path='../tmp/consultation/consultation-completed.png')

    def test_consult_04_lost_response_retry_and_late_session(self):
        a=self.fixture();p=self.login();self.select(p,a);self.open_dialog(p);p.locator('#co-new').click()
        expect(p.locator('#co-status')).to_contain_text('수신자와 의뢰 사유');p.locator('#co-reader').select_option(self.stack.user_ids['doctor2'])
        p.locator('#co-reason').fill('SYNTHETIC preserve uncertain request')
        def lost(route):route.fetch();route.abort()
        p.route('**/api/studies/*/consultations',lost);p.locator('#co-send').click()
        expect(p.locator('#co-retry')).to_be_enabled();expect(p.locator('#co-reason')).to_have_value('SYNTHETIC preserve uncertain request')
        p.once('dialog',lambda d:d.dismiss());p.locator('#co-close').click();expect(p.locator('#consultations-dialog')).to_be_visible()
        p.unroute('**/api/studies/*/consultations',lost);p.locator('#co-retry').click()
        expect(p.locator('#co-status')).to_contain_text('자문 요청을 저장했습니다');self.assertEqual(len(self.audits(a)),1)
        p.locator('#co-close').click();waiting=[];p.route('**/api/consultations?*',lambda route:waiting.append(route))
        p.locator('#consultations-open').click();expect(p.locator('#co-status')).to_contain_text('읽는 중')
        p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close();}")
        expect(p.locator('#consultations-dialog')).not_to_be_visible()
        for route in waiting:route.fulfill(status=200,content_type='application/json',body=json.dumps(dict(owner=self.owner(),direction='received',items=[],nextCursor=None)))
        expect(p.locator('#co-list')).to_be_empty();expect(p.locator('#co-original')).to_be_empty()


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(ConsultationE2E(name) for name in ConsultationE2E.__dict__ if name.startswith('test_consult_'))


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
