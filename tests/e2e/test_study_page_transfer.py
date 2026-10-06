"""Actual screen atomic page loading, retry, cancel and related row pages."""
import copy,os,unittest,uuid
from pathlib import Path
from urllib.parse import urlsplit,parse_qs
from playwright.sync_api import expect
from test_worklist import WorklistE2E
from study_page_stub import fulfill_page
from document_session import document_request
from viewer_session import hold_landing
from test_viewer_layout import ViewerLayoutE2E

class StudyPageTransferE2E(WorklistE2E):
    def test_transfer_01_failure_resume_cancel_and_related_pages(self):
        prefix='TRANSFER-'+uuid.uuid4().hex[:8]
        a=self.fixture(patient_id=prefix);b=self.fixture(patient_id=prefix)
        self.seed_report(a);self.seed_report(b);page=self.login();self.select(page,a)
        page.locator('#findings').fill('Transfer keeps unsaved report')
        original=document_request(page, "GET", self.stack.api+'/studies');self.assertIn('no-store',original.headers.get('cache-control',''))
        raw={s['uid']:s for s in original.json()['studies']};items=[raw[a.uid],raw[b.uid]]
        for i in range(199):
            item=copy.deepcopy(raw[a.uid]);item['uid']='9.999.'+str(i).zfill(4);items.append(item)
        me=document_request(page, "GET", self.stack.api+'/me').json();owner=[me['institution'],me['sub']]
        phase={'name':'fail'};requests=[];held=[]
        def response(route):
            offset=int(parse_qs(urlsplit(route.request.url).query).get('after',['0'])[0]);requests.append(offset)
            if offset==100 and phase['name']=='fail':route.fulfill(status=503,json={'message':'Synthetic page failure'});return
            if offset==100 and phase['name']=='hold':held.append(route);return
            fulfill_page(route,items,owner)
        page.route('**/api/studies?*',response)
        before=page.locator('#rows tr[data-uid]').count();page.locator('#refresh').click()
        expect(page.locator('#study-fetch-resume')).to_be_visible();expect(page.locator('#study-fetch-status')).to_contain_text('100/201')
        expect(page.locator('#rows tr[data-uid]')).to_have_count(before)
        expect(page.locator('#findings')).to_have_value('Transfer keeps unsaved report');self.assertEqual(page.evaluate('selectedUid'),a.uid)
        phase['name']='ok';requests.clear();page.locator('#study-fetch-resume').click()
        expect(page.locator('#study-fetch')).not_to_be_visible();self.assertEqual(requests,[100,200])
        expect(page.locator('#page-status')).to_contain_text('/ 201건');expect(page.locator('#rows tr[data-uid]')).to_have_count(100)
        expect(page.locator('#relrows tr[data-uid]')).to_have_count(50)
        self.assertEqual(page.locator('#related-filter-count').inner_text(),'200 / 200')
        related_before=page.evaluate('relatedUid');page.locator('#related-page-next').click()
        expect(page.locator('#related-page-status')).to_have_text('2/4페이지')
        self.assertEqual(page.evaluate('relatedUid'),related_before);self.assertEqual(page.evaluate('selectedUid'),a.uid)
        expect(page.locator('#findings')).to_have_value('Transfer keeps unsaved report')
        phase['name']='hold';page.locator('#refresh').click()
        expect(page.locator('#study-fetch-status')).to_contain_text('100/201')
        page.locator('#study-fetch-cancel').click();expect(page.locator('#study-fetch-resume')).to_be_visible()
        self.assertTrue(held);fulfill_page(held.pop(),items,owner)
        expect(page.locator('#page-status')).to_contain_text('/ 201건')
        phase['name']='ok';page.locator('#study-fetch-resume').click();expect(page.locator('#study-fetch')).not_to_be_visible()
        expect(page.locator('#findings')).to_have_value('Transfer keeps unsaved report')
        folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);page.screenshot(path=str(folder/'resumed-related-pages.png'))
    def test_transfer_02_owner_response_requires_confirmed_session_replacement(self):
        page=self.login();expect(page.locator('#rows tr[data-uid]').first).to_be_visible()
        before=page.locator('#rows tr[data-uid]').count();logouts=[]
        page.on('request',lambda r:logouts.append(r.url) if r.method=='POST' and r.url.endswith('/auth/logout') else None)
        pattern='**/api/studies?*'
        page.route(pattern,lambda route:route.fulfill(status=200,json={'studies':[], 'pagination':{'owner':['other','other'],'limit':100,'offset':0,'total':0,'next':None}}))
        with page.expect_response(lambda r:r.url.endswith('/api/me')):
            page.locator('#refresh').click()
        page.wait_for_timeout(200)
        self.assertEqual(page.evaluate('KinWorkContext.state()'),'active')
        expect(page.locator('#rows tr[data-uid]')).to_have_count(before)
        self.assertEqual(logouts,[])
        page.unroute(pattern);landing=hold_landing(page)
        other=page.context.new_page();ViewerLayoutE2E.relog(self,other,'doctor2')
        # 첫 탭은 이 세션에 묶어 보내는 자기 요청 어느 것으로든 교체를 안다 — 이 Refresh일 수도, relog 사이에 나간 시작·주기 요청일
        # 수도 있다. 이미 닫혔으면 Refresh는 숨어 있고(:70) 눌러도 요청이 없다(:71-72): 보임과 상관없이 같은 클릭 사건을 보낸다.
        page.locator('#refresh').dispatch_event('click');page.wait_for_function("KinWorkContext.state() !== 'active'")
        self.assertEqual(page.evaluate('KinAuth.endState()'),{'state':'unconfirmed','reason':'replaced'})
        self.assertTrue(landing);self.assertEqual(logouts,[])
        self.assertIsNone(page.evaluate("localStorage.getItem('kin-session-end')"),'replacement must not write a logout record')
        protected=[]
        page.on('request',lambda request:protected.append(request.url) if '/api/' in request.url else None)
        expect(page.locator('#refresh')).not_to_be_visible()
        page.locator('#refresh').dispatch_event('click');page.wait_for_timeout(300)
        self.assertEqual(protected,[],'An ended document must not fetch another account\'s list')

    def test_transfer_03_poll_retry_offline_and_final_apply_barrier(self):
        a=self.fixture();self.seed_report(a);page=self.login();self.select(page,a)
        page.locator('#findings').fill('Keep input through failed polls')
        page.evaluate("""() => {
          const native = window.setInterval;
          window.setInterval = fn => { window.transferPoll = fn; return null; };
          startPolling(); window.setInterval = native;
        }""")
        before=page.evaluate('studies.length')
        page.evaluate("""async () => {
          const original = studyPageClient.read;
          studyPageClient.read = async options => { const result = await original(options); commitEpoch++; return {...result,studies:[]}; };
          try { await load(); } finally { studyPageClient.read = original; }
        }""")
        self.assertEqual(page.evaluate('studies.length'),before)
        failures={'on':True};calls=[]
        def response(route):
            calls.append(route.request.url)
            if failures['on']:route.fulfill(status=503,json={'message':'Synthetic poll failure'})
            else:route.continue_()
        page.route('**/api/studies?*',response)
        page.evaluate('transferPoll()');self.assertEqual(page.evaluate('pollFails'),1)
        self.assertTrue(page.evaluate('studyPageClient.resumable'))
        failures['on']=False;page.evaluate('transferPoll()')
        self.assertGreaterEqual(len(calls),2);self.assertEqual(page.evaluate('pollFails'),0)
        self.assertFalse(page.evaluate('studyPageClient.resumable'))
        expect(page.locator('#findings')).to_have_value('Keep input through failed polls')
        failures['on']=True;page.evaluate('transferPoll()');page.evaluate('transferPoll()')
        self.assertEqual(page.evaluate('serverMode'),False)
        expect(page.locator('#findings')).to_have_value('Keep input through failed polls')


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(StudyPageTransferE2E(name) for name in loader.getTestCaseNames(StudyPageTransferE2E) if name.startswith('test_transfer_'))
if __name__=='__main__':unittest.main(verbosity=2)
