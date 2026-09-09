"""Initial lean bootstrap loads saved report state only from complete study pages."""
import os,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_worklist import WorklistE2E
class StudyQueryScopeE2E(WorklistE2E):
    def test_query_01_reload_restores_draft_from_pages(self):
        a=self.fixture();self.seed_report(a)
        self.assertEqual(self.stack.request('PUT',f'/studies/{a.uid}/report','doctor',{'findings':'Saved query-scope draft','conclusion':'','recommendation':''}).status,200)
        page=self.login();responses=[]
        page.on('response',lambda r:responses.append(r) if '/api/bootstrap' in r.url else None)
        page.reload();self.select(page,a)
        expect(page.locator('#findings')).to_have_value('Saved query-scope draft')
        self.assertEqual(len(responses),1);self.assertTrue(responses[0].url.endswith('/bootstrap?states=omit'))
        self.assertEqual(responses[0].json()['states'],{});self.assertIn('no-store',responses[0].headers.get('cache-control',''))
        self.assertGreaterEqual(page.evaluate('appState[selectedUid].draft.baseVersion'),0)
        folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True);page.screenshot(path=str(folder/'lean-start-restored-draft.png'))
    def test_query_02_failed_first_page_keeps_start_empty_until_retry(self):
        a=self.fixture();self.seed_report(a);page=self.login()
        page.route('**/api/studies?*',lambda route:route.fulfill(status=503,json={'message':'Synthetic initial page failure'}))
        page.reload();expect(page.locator('#study-fetch-resume')).to_be_visible()
        self.assertEqual(page.evaluate('studies.length'),0);self.assertEqual(page.evaluate('Object.keys(appState).length'),0)
        page.unroute('**/api/studies?*');page.locator('#study-fetch-resume').click();self.select(page,a)
        expect(page.locator('#findings')).to_have_value(a.secret);self.assertGreater(page.evaluate('studies.length'),0)
def load_tests(loader,tests,pattern):
    return unittest.TestSuite(StudyQueryScopeE2E(name) for name in loader.getTestCaseNames(StudyQueryScopeE2E) if name.startswith('test_query_'))
if __name__=='__main__':unittest.main(verbosity=2)
