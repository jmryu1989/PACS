"""Consultation review follow-up: authority, stale detail recovery and pagination."""
import sys
import unittest
from playwright.sync_api import expect
from test_consultations import ConsultationE2E


class ConsultationRecoveryE2E(ConsultationE2E):
    def test_consult_recovery_01_admin_and_conflict_preserve_note(self):
        a=self.fixture();row=self.create_request(a)['item']
        self.assertEqual(self.read_request(row['id'],'jmryu')['item']['id'],row['id'])
        self.change_request(row,'accept','jmryu',status=403)
        self.change_request(row,'complete','jmryu',status=403)
        p=self.login('doctor2');self.select(p,a);self.open_dialog(p)
        p.locator(f'[data-consultation="{row["id"]}"]').click()
        expect(p.locator('#co-current-state')).to_contain_text('Requested')
        p.locator('#co-note').fill('SYNTHETIC working reply retained')
        self.change_request(row,'cancel','jmryu')
        p.locator('#co-accept').click()
        expect(p.locator('#co-current-state')).to_contain_text('Cancelled')
        expect(p.locator(f'[data-consultation="{row["id"]}"]')).to_contain_text('Cancelled')
        expect(p.locator('#co-note')).to_have_value('SYNTHETIC working reply retained')
        expect(p.locator('#co-status')).to_contain_text('최신 상태를 표시했습니다')
        self.assertEqual(len(self.audits(a)),2)
        p.evaluate("()=>{goOffline(Error('synthetic disconnected'));stopReconnect();}")
        expect(p.locator('#consultations-open')).to_be_disabled()
        expect(p.locator('#co-new')).to_be_disabled()
        expect(p.locator('#co-status')).to_contain_text('입력은 유지')
        p.evaluate('async()=>{goOnline(await fetchBootstrap());}')
        expect(p.locator('#consultations-open')).to_be_enabled()
        expect(p.locator('#co-new')).to_be_enabled()
        expect(p.locator('#co-note')).to_have_value('SYNTHETIC working reply retained')
        p.once('dialog',lambda d:d.accept());p.locator('#co-close').click()

    def test_consult_recovery_02_close_busy_read_aborts_and_clears_search(self):
        a=self.fixture();self.create_request(a);p=self.login('doctor2');self.select(p,a)
        waiting=[];p.route('**/api/consultations?*',lambda route:waiting.append(route))
        p.locator('#consultations-open').click();expect(p.locator('#co-status')).to_contain_text('읽는 중')
        expect(p.locator('#co-close')).to_be_enabled();p.locator('#co-close').click()
        expect(p.locator('#consultations-dialog')).not_to_be_visible()
        for route in waiting:route.continue_()
        p.unroute('**/api/consultations?*');self.open_dialog(p)
        p.locator('#co-search').fill('SYNTHETIC private patient search');p.locator('#co-close').click()
        expect(p.locator('#co-search')).to_have_value('');expect(p.locator('#co-list')).to_be_empty()
        expect(p.locator('#co-original')).to_be_empty()

    def test_consult_recovery_03_request_filter_starts_at_first_page(self):
        fixtures=[self.fixture() for _ in range(26)]
        for fixture in fixtures:self.create_request(fixture)
        p=self.login('doctor2')
        expect(p.locator('#rows tr[data-uid]')).not_to_have_count(0)
        p.locator('#clearfilter').click();p.locator('#page-size').select_option('25')
        p.locator('#page-next').click();expect(p.locator('#page-prev')).to_be_enabled()
        self.open_dialog(p);expect(p.locator('#co-count')).to_have_text('26 shown / 26 loaded')
        p.locator('#co-filter').click();expect(p.locator('#consultations-dialog')).not_to_be_visible()
        expect(p.locator('#page-prev')).to_be_disabled();expect(p.locator('#rows tr[data-uid]')).to_have_count(25)
        expect(p.locator('#filterlist')).to_contain_text('Received Consultations')


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(ConsultationRecoveryE2E(name) for name in ConsultationRecoveryE2E.__dict__ if name.startswith('test_consult_recovery_'))


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
