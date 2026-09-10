"""REQ-D01-REFRESH-PREFERENCE / RISK-STALE/UNSAVED/OWNER / TEST-WORKLIST-REFRESH."""
import sys
import time
import unittest
from playwright.sync_api import expect
from test_worklist import WorklistE2E
from test_workspace_persistence import WorkspacePersistenceE2E


class WorklistRefreshE2E(WorklistE2E):
    device=WorkspacePersistenceE2E.device
    sign_in=WorkspacePersistenceE2E.sign_in
    sign_out=WorkspacePersistenceE2E.sign_out

    def test_refresh_01_manual_real_timer_and_draft(self):
        a=self.fixture();self.seed_report(a);p=self.login();self.select(p,a)
        versions=self.versions(a);p.locator('#findings').fill('REFRESH UNSAVED INPUT')
        expect(p.locator('#worklist-refresh')).to_have_value('30')
        p.locator('#worklist-refresh').select_option('0')
        p.wait_for_function('() => !studyPageClient.busy')
        requests=[]
        p.on('request',lambda r:requests.append(r.url) if '/api/studies?' in r.url else None)
        b=self.fixture()
        p.wait_for_timeout(31000)
        self.assertEqual(requests,[],'Manual must not issue an automatic study list request')
        self.assertNotIn(b.uid,p.evaluate('studies.map(s=>s.uid)'))
        p.locator('#refresh').click()
        p.wait_for_function('(uid)=>studies.some(s=>s.uid===uid)',arg=b.uid)
        expect(p.locator('#findings')).to_have_value('REFRESH UNSAVED INPUT')
        c=self.fixture();p.locator('#worklist-refresh').select_option('30')
        self.assertNotIn(c.uid,p.evaluate('studies.map(s=>s.uid)'))
        p.wait_for_function('(uid)=>studies.some(s=>s.uid===uid)',arg=c.uid,timeout=45000)
        self.assertEqual(p.evaluate('selectedUid'),a.uid)
        expect(p.locator('#findings')).to_have_value('REFRESH UNSAVED INPUT')
        self.assertEqual(self.versions(a),versions)
        p.screenshot(path='../tmp/worklist-refresh/controls.png')

    def test_refresh_02_pause_discards_inflight_list_and_manual_recovers(self):
        a=self.fixture();p=self.login();self.select(p,a)
        p.wait_for_function('() => !studyPageClient.busy')
        p.locator('#worklist-refresh').select_option('0')
        b=self.fixture();held=[]
        def hold(route): held.append((route,route.fetch()))
        p.route('**/api/studies?*',hold)
        p.locator('#worklist-refresh').select_option('30')
        deadline=time.monotonic()+40
        while not held and time.monotonic()<deadline:p.wait_for_timeout(100)
        self.assertEqual(len(held),1)
        p.locator('#worklist-refresh').select_option('0')
        held[0][0].fulfill(response=held[0][1])
        p.wait_for_function('() => !studyPageClient.busy')
        self.assertNotIn(b.uid,p.evaluate('studies.map(s=>s.uid)'))
        expect(p.locator('#dbstat')).to_contain_text('DB Connected')
        self.assertEqual(p.evaluate('selectedUid'),a.uid)
        p.unroute('**/api/studies?*',hold)
        p.locator('#refresh').click()
        p.wait_for_function('(uid)=>studies.some(s=>s.uid===uid)',arg=b.uid)
        self.assertEqual(p.evaluate('selectedUid'),a.uid)

    def test_refresh_03_relogin_other_account_and_storage_failure(self):
        self.fixture();context=self.device();p=self.sign_in(context)
        p.locator('#worklist-refresh').select_option('120')
        self.sign_out(p);p=self.sign_in(context)
        expect(p.locator('#worklist-refresh')).to_have_value('120')
        self.assertEqual(p.evaluate('worklistRefresh.seconds()'),120)
        p.evaluate("() => {const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('kin-worklist-refresh:'))throw Error('blocked');return original.call(this,k,v);};}")
        p.locator('#worklist-refresh').select_option('60')
        expect(p.locator('#worklist-refresh-status')).to_contain_text('현재 창에만')
        self.assertEqual(p.evaluate('worklistRefresh.seconds()'),60)
        stored=p.evaluate("Object.entries(localStorage).filter(([k])=>k.startsWith('kin-worklist-refresh:')).map(([k,v])=>JSON.parse(v))")
        self.assertEqual(stored,[dict(version=1,seconds=120)])
        self.sign_out(p);other=self.sign_in(context,'doctor2')
        expect(other.locator('#worklist-refresh')).to_have_value('30')


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(WorklistRefreshE2E(name) for name in WorklistRefreshE2E.__dict__ if name.startswith('test_refresh_'))


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
