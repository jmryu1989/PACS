# coding: utf-8
"""REQ-D01-WORKLIST-ALERTS / RISK-REPEAT/STALE/OWNER/LOSS / TEST-WORKLIST-ALERTS."""
import sys
import unittest
from playwright.sync_api import expect
from test_worklist import WorklistE2E
from test_workspace_persistence import WorkspacePersistenceE2E


class WorklistAlertsE2E(WorklistE2E):
    device=WorkspacePersistenceE2E.device
    sign_in=WorkspacePersistenceE2E.sign_in
    sign_out=WorkspacePersistenceE2E.sign_out

    def controls(self,p):
        expect(p.locator('#worklist-alerts-open')).to_be_enabled()
        p.locator('#worklist-alerts-open').click()
        expect(p.locator('#worklist-alerts-dialog')).to_be_visible()

    def observe_audio(self,p):
        # Observe actual native oscillator start; keep the real context/nodes.
        p.evaluate("""() => {
            window.__alertTones=0;const create=AudioContext.prototype.createOscillator;
            AudioContext.prototype.createOscillator=function(...args){
                const node=create.apply(this,args),start=node.start;
                node.start=function(...args){const result=start.apply(this,args);window.__alertTones++;return result;};return node;
            };
        }""")

    def test_alerts_01_real_new_emergency_repeat_and_report_preservation(self):
        a=self.fixture();self.seed_report(a);p=self.login();self.select(p,a)
        # This case isolates manual Refresh. The next case exercises the real timer.
        p.evaluate('clearInterval(poll)');self.observe_audio(p);self.controls(p)
        expect(p.locator('#alerts-new')).not_to_be_checked();expect(p.locator('#alerts-emergency')).not_to_be_checked()
        expect(p.locator('#alerts-list-state')).to_have_text('List Baseline Ready')
        p.locator('#alerts-new').check();p.locator('#alerts-enable').click()
        expect(p.locator('#alerts-audio-state')).to_have_text('Sound Ready')
        self.assertEqual(p.evaluate('__alertTones'),0)
        p.locator('#alerts-done').click();p.locator('#findings').fill('ALERTS PRIVATE DRAFT')
        versions=self.versions(a);b=self.fixture()
        p.locator('#refresh').click();p.wait_for_function('() => __alertTones===1')
        expect(p.locator('#alerts-list-state')).to_have_text('New to List 1 · Emergency Changes 0')
        self.assertEqual(p.evaluate('selectedUid'),a.uid);expect(p.locator('#findings')).to_have_value('ALERTS PRIVATE DRAFT')
        p.locator('#refresh').click();expect(p.locator('#alerts-list-state')).to_have_text('New to List 0 · Emergency Changes 0')
        self.assertEqual(p.evaluate('__alertTones'),1)
        self.controls(p);p.locator('#alerts-new').uncheck();p.locator('#alerts-emergency').check();p.locator('#alerts-done').click()
        response=self.stack.request('PATCH','/studies/'+b.uid,'tech',{'em':'E'});self.assertEqual(response.status,200)
        p.locator('#refresh').click();p.wait_for_function('() => __alertTones===2')
        expect(p.locator('#alerts-list-state')).to_have_text('New to List 0 · Emergency Changes 1')
        p.locator('#refresh').click();expect(p.locator('#alerts-list-state')).to_have_text('New to List 0 · Emergency Changes 0');self.assertEqual(p.evaluate('__alertTones'),2)
        p.route('**/api/studies?*',lambda route:route.fulfill(status=503,body='unavailable'))
        p.locator('#refresh').click();expect(p.locator('#err')).to_contain_text('현재 목록과 입력은 유지')
        self.assertEqual(p.evaluate('__alertTones'),2);expect(p.locator('#findings')).to_have_value('ALERTS PRIVATE DRAFT')
        p.unroute('**/api/studies?*');p.locator('#refresh').click();expect(p.locator('#err')).to_have_text('')
        self.assertEqual(p.evaluate('__alertTones'),2);self.assertEqual(self.versions(a),versions)
        self.controls(p);p.screenshot(path='../tmp/worklist-alerts/controls-final.png')

    def test_alerts_02_audio_rejection_recovery_and_real_poll(self):
        a=self.fixture();p=self.login();self.observe_audio(p);self.controls(p);p.locator('#alerts-new').check()
        p.evaluate("() => {window.__nativeResume=AudioContext.prototype.resume;AudioContext.prototype.resume=()=>Promise.reject(Error('test denied'));}")
        p.locator('#alerts-enable').click();expect(p.locator('#alerts-feedback')).to_contain_text('소리를 시작하지 못했습니다')
        expect(p.locator('#alerts-audio-state')).to_have_text('Sound Off');self.assertEqual(p.evaluate('__alertTones'),0)
        p.evaluate('() => {AudioContext.prototype.resume=window.__nativeResume;}');p.locator('#alerts-enable').click();expect(p.locator('#alerts-audio-state')).to_have_text('Sound Ready')
        p.locator('#alerts-done').click();b=self.fixture()
        p.wait_for_function('() => __alertTones===1',timeout=45000)
        self.assertIn(b.uid,p.evaluate('studies.map(s=>s.uid)'))
        self.controls(p);p.locator('#alerts-enable').click();expect(p.locator('#alerts-audio-state')).to_have_text('Sound Off')

    def test_alerts_03_relogin_preferences_account_and_sound_activation(self):
        self.fixture();context=self.device();p=self.sign_in(context);self.controls(p)
        p.locator('#alerts-new').check();p.locator('#alerts-volume').select_option('0.1');p.locator('#alerts-done').click();self.sign_out(p)
        p=self.sign_in(context);self.controls(p);expect(p.locator('#alerts-new')).to_be_checked();expect(p.locator('#alerts-volume')).to_have_value('0.1')
        expect(p.locator('#alerts-audio-state')).to_have_text('Sound Off');self.observe_audio(p);p.locator('#alerts-test').click()
        expect(p.locator('#alerts-audio-state')).to_have_text('Sound Ready');self.assertEqual(p.evaluate('__alertTones'),1)
        stored=p.evaluate("Object.entries(localStorage).filter(([k])=>k.startsWith('kin-worklist-alerts:'))")
        self.assertEqual(len(stored),1);self.assertNotIn('uid',stored[0][1])
        p.locator('#alerts-done').click();self.sign_out(p)
        other=self.sign_in(context,'doctor2');self.controls(other);expect(other.locator('#alerts-new')).not_to_be_checked();expect(other.locator('#alerts-emergency')).not_to_be_checked();expect(other.locator('#alerts-volume')).to_have_value('0.3')

    def test_alerts_04_node_failure_is_not_ready_and_can_retry(self):
        self.fixture();p=self.login();self.controls(p);self.observe_audio(p)
        p.evaluate("() => {window.__nativeOscillator=AudioContext.prototype.createOscillator;AudioContext.prototype.createOscillator=()=>{throw Error('test device failure');};}")
        p.locator('#alerts-test').click();expect(p.locator('#alerts-feedback')).to_contain_text('소리 재생에 실패')
        expect(p.locator('#alerts-audio-state')).to_have_text('Sound Off');self.assertEqual(p.evaluate('__alertTones'),0)
        p.evaluate('() => {AudioContext.prototype.createOscillator=window.__nativeOscillator;}')
        p.locator('#alerts-test').click();expect(p.locator('#alerts-audio-state')).to_have_text('Sound Ready');self.assertEqual(p.evaluate('__alertTones'),1)


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(WorklistAlertsE2E(name) for name in WorklistAlertsE2E.__dict__ if name.startswith('test_alerts_'))


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
