"""REQ-D01-INITIAL-EMERGENCY / RISK-REPEAT/STALE/OWNER/AUDIO."""
import sys
import unittest
from playwright.sync_api import expect
from test_worklist_alerts import WorklistAlertsE2E


class InitialEmergencyE2E(WorklistAlertsE2E):
    def configured(self):
        context=self.device();p=self.sign_in(context);self.controls(p)
        expect(p.locator('#alerts-initial')).not_to_be_checked();p.locator('#alerts-initial').check()
        self.observe_audio(p);p.locator('#alerts-enable').click();expect(p.locator('#alerts-audio-state')).to_have_text('Sound Ready')
        self.assertEqual(p.evaluate('__alertTones'),0)
        p.locator('#alerts-done').click();self.sign_out(p)
        p=self.sign_in(context);p.locator('#worklist-refresh').select_option('0');self.observe_audio(p);self.controls(p)
        expect(p.locator('#alerts-initial')).to_be_checked();expect(p.locator('#alerts-audio-state')).to_have_text('Sound Off')
        return context,p

    def test_initial_01_first_list_rechecks_and_plays_once_without_retargeting(self):
        a=self.fixture();b=self.fixture();self.patch(a,em='E');self.patch(b,em='E')
        context,p=self.configured();count=p.evaluate("studies.filter(s=>s.em==='E').length");self.assertGreaterEqual(count,2)
        expect(p.locator('#alerts-list-state')).to_contain_text(f'Initial Emergency {count} Pending')
        self.patch(a,em='N');p.locator('#alerts-done').click();self.select(p,b)
        p.locator('#findings').fill('initial emergency draft');versions=self.versions(b);self.controls(p)
        p.locator('#alerts-enable').click();p.wait_for_function('__alertTones===1')
        expect(p.locator('#alerts-feedback')).to_contain_text(f'응급 검사 {count-1}건')
        self.assertEqual(p.evaluate('selectedUid'),b.uid);expect(p.locator('#findings')).to_have_value('initial emergency draft')
        p.locator('#alerts-done').click();p.locator('#refresh').click()
        expect(p.locator('#alerts-list-state')).not_to_contain_text('Pending');self.assertEqual(p.evaluate('__alertTones'),1)
        self.controls(p);p.locator('#alerts-enable').click();p.locator('#alerts-enable').click()
        expect(p.locator('#alerts-audio-state')).to_have_text('Sound Ready');self.assertEqual(p.evaluate('__alertTones'),1)
        self.assertEqual(self.versions(b),versions);p.screenshot(path='../tmp/initial-emergency/played.png')

    def test_initial_02_failed_recheck_off_and_other_owner(self):
        a=self.fixture();self.patch(a,em='E');context,p=self.configured()
        pattern='**/api/studies?*';p.route(pattern,lambda route:route.fulfill(status=503,body='unavailable'))
        p.locator('#alerts-enable').click();expect(p.locator('#alerts-feedback')).to_contain_text('최신 목록을 확인하지 못해')
        self.assertEqual(p.evaluate('__alertTones'),0);expect(p.locator('#alerts-list-state')).to_contain_text('Pending')
        p.locator('#alerts-initial').uncheck();expect(p.locator('#alerts-list-state')).not_to_contain_text('Pending')
        p.unroute(pattern);p.locator('#alerts-done').click();p.locator('#refresh').click()
        expect(p.locator('#err')).to_have_text('');self.assertEqual(p.evaluate('__alertTones'),0)
        self.sign_out(p);other=self.sign_in(context,'doctor2');self.controls(other)
        expect(other.locator('#alerts-initial')).not_to_be_checked();expect(other.locator('#alerts-audio-state')).to_have_text('Sound Off')


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(InitialEmergencyE2E(name) for name in InitialEmergencyE2E.__dict__ if name.startswith('test_initial_'))


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
