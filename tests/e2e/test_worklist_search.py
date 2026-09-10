# coding: utf-8
"""REQ-D01-SEARCH-APPLY: applied criteria, clear barrier and report preservation."""
import sys,unittest,uuid
from pathlib import Path
from playwright.sync_api import expect
from test_thumbnail_series import ThumbnailSeriesE2E

class WorklistSearchE2E(ThumbnailSeriesE2E):
    def test_search_01_manual_apply_enter_refresh_and_editor(self):
        patient='SYNTHETIC-SEARCH-'+uuid.uuid4().hex[:12]
        a=self.ct(patient,'current','20260801');b=self.ct('SYNTHETIC-OTHER-'+uuid.uuid4().hex[:12],'other','20260802');self.seed_report(a)
        p=self.login();self.select(p,a);self.thumbs(p,1);p.evaluate('clearInterval(poll)')
        p.locator('#findings').fill('SYNTHETIC SEARCH UNSAVED')
        p.locator('[data-search-mode]').select_option('manual')
        p.locator('#quick').fill(b.patient_id)
        expect(p.locator(f'#rows tr[data-uid="{a.uid}"]')).to_have_count(1)
        expect(p.locator(f'#rows tr[data-uid="{b.uid}"]')).to_have_count(0)
        expect(p.locator('[data-search-status]')).to_contain_text('미적용')
        self.refresh(p);expect(p.locator(f'#rows tr[data-uid="{a.uid}"]')).to_have_count(1)
        p.locator('#quick').press('Enter')
        expect(p.locator(f'#rows tr[data-uid="{b.uid}"]')).to_have_count(1)
        expect(p.locator(f'#rows tr[data-uid="{a.uid}"]')).to_have_count(0)
        self.assertEqual(p.evaluate('selectedUid'),a.uid);expect(p.locator('#findings')).to_have_value('SYNTHETIC SEARCH UNSAVED')
        p.locator('#quick').fill(a.patient_id);p.locator('[data-search-apply]').click()
        expect(p.locator(f'#rows tr[data-uid="{a.uid}"]')).to_have_count(1)
        folder=Path('../tmp/worklist-search/screens');folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'manual.png'))

    def test_search_03_column_condition_and_option_change_keep_applied_result(self):
        a=self.ct('SYNTHETIC-SEARCH-'+uuid.uuid4().hex[:12],'current','20260801')
        p=self.login();self.select(p,a);self.thumbs(p,1);p.evaluate('clearInterval(poll)')
        p.locator('[data-search-mode]').select_option('manual')
        p.locator('#filterrow select[data-f="modality"]').select_option('MR')
        p.locator('[data-search-clear]').check()
        expect(p.locator(f'#rows tr[data-uid="{a.uid}"]')).to_have_count(1)
        expect(p.locator('[data-search-status]')).to_contain_text('미적용')
        p.locator('[data-search-apply]').click();expect(p.locator('#rows tr[data-uid]')).to_have_count(0)
        p.locator('#filterrow select[data-f="modality"]').select_option('CT')
        expect(p.locator('#rows tr[data-uid]')).to_have_count(0)
        p.locator('#filterrow select[data-f="modality"]').press('Enter')
        expect(p.locator(f'#rows tr[data-uid="{a.uid}"]')).to_have_count(1)

    def test_search_02_clear_barrier_saved_apply_and_preference_reload(self):
        a=self.ct('SYNTHETIC-SEARCH-'+uuid.uuid4().hex[:12],'current','20260801')
        p=self.login();self.select(p,a);self.thumbs(p,1);p.evaluate('clearInterval(poll)')
        p.locator('[data-search-clear]').check();p.locator('#clearfilter').click()
        expect(p.locator('#rows tr[data-uid]')).to_have_count(0)
        self.refresh(p);expect(p.locator('#rows tr[data-uid]')).to_have_count(0)
        expect(p.locator('[data-search-status]')).to_contain_text('결과를 비웠습니다')
        p.evaluate("patient=>applyFilter({name:'SYNTHETIC search',mode:'Radiology',quick:patient,days:-1,cols:{}})",a.patient_id)
        expect(p.locator(f'#rows tr[data-uid="{a.uid}"]')).to_have_count(1)
        p.locator('[data-search-mode]').select_option('manual');p.reload();p.wait_for_selector('[data-search-mode]')
        expect(p.locator('[data-search-mode]')).to_have_value('manual');expect(p.locator('[data-search-clear]')).to_be_checked()
        expect(p.locator('#quick')).to_have_value('')

def load_tests(loader,tests,pattern):
    return unittest.TestSuite(WorklistSearchE2E(name) for name in WorklistSearchE2E.__dict__ if name.startswith('test_search_'))

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
