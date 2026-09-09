"""Actual BFF/browser column roaming; explicit apply and stale response protection."""
import os,unittest
from pathlib import Path
from playwright.sync_api import expect
from test_worklist_columns import WorklistColumnsE2E
from workspace_roaming_support import cleanup_workspace

class ColumnsRoamingE2E(WorklistColumnsE2E):
    @classmethod
    def setUpClass(cls):
        super().setUpClass();cls.addClassCleanup(cleanup_workspace,cls.stack,'WorklistColumns')
    def tearDown(self):
        super().tearDown();cleanup_workspace(self.stack,'WorklistColumns')
    def action(self,page,action,message):
        button=page.locator('#wc-server-'+action);expect(button).to_be_enabled();button.click()
        expect(page.locator('#wc-server-status')).to_contain_text(message)
        expect(button).to_be_enabled()
    def remote(self,page):
        r=page.request.get(self.stack.api+'/worklist-columns');self.assertEqual(r.status,200);return r.json()
    def test_roam_columns_01_two_browsers_explicit_apply_and_clear(self):
        f=self.fixture();self.seed_report(f);page=self.login();self.select(page,f)
        page.locator('#findings').fill('Column roaming unsaved report')
        self.open_columns(page);self.action(page,'inspect','저장된 열 설정이 없습니다')
        self.column(page,'age').locator('input').uncheck()
        self.column(page,'techNote').locator('[data-move="up"]').click()
        self.action(page,'save','편집값을 계정에 저장했습니다')
        saved=self.remote(page);self.assertEqual(saved['columns']['modes']['Radiology']['hidden'],['age'])
        expect(page.locator('#heads [data-key="age"]')).to_have_count(1)
        page.locator('#wc-save').click();expect(page.locator('#heads [data-key="age"]')).to_have_count(0)
        expect(page.locator('#findings')).to_have_value('Column roaming unsaved report')
        second=self.login();self.open_columns(second)
        expect(second.locator('#heads [data-key="age"]')).to_have_count(1)
        self.action(second,'load','편집창에 불러왔습니다')
        expect(self.column(second,'age').locator('input')).not_to_be_checked()
        expect(second.locator('#heads [data-key="age"]')).to_have_count(1)
        second.locator('#wc-save').click();expect(second.locator('#heads [data-key="age"]')).to_have_count(0)
        self.assertEqual(second.locator('#heads th').first.get_attribute('data-key'),'techNote')
        second.reload();expect(second.locator('#heads [data-key="age"]')).to_have_count(0)
        other=self.login('doctor2');self.open_columns(other);self.action(other,'load','저장된 열 설정이 없습니다')
        expect(self.column(other,'age').locator('input')).to_be_checked()
        self.open_columns(second);self.action(second,'inspect','저장된 열 설정이 있습니다')
        second.once('dialog',lambda d:d.accept());self.action(second,'clear','현재 목록·편집값·브라우저 저장값은 유지')
        self.assertIsNone(self.remote(second)['columns']);expect(self.column(second,'age').locator('input')).not_to_be_checked()
        second.locator('#wc-close').click();expect(second.locator('#heads [data-key="age"]')).to_have_count(0)
        expect(page.locator('#findings')).to_have_value('Column roaming unsaved report');self.assertEqual(len(self.versions(f)),1)
        self.open_columns(page)
        folder=Path(os.environ['KIN_EVIDENCE_DIR']);folder.mkdir(parents=True,exist_ok=True)
        page.screenshot(path=str(folder/'column-account-settings.png'))
    def test_roam_columns_02_conflict_and_network_failure(self):
        page=self.login();peer=self.login();self.open_columns(page);self.open_columns(peer)
        self.action(page,'inspect','저장된 열 설정이 없습니다');self.action(peer,'inspect','저장된 열 설정이 없습니다')
        self.column(peer,'age').locator('input').uncheck();self.action(peer,'save','편집값을 계정에 저장했습니다')
        self.column(page,'desc').locator('input').uncheck()
        page.locator('#wc-server-save').click();expect(page.locator('#wc-server-status')).to_contain_text('다른 창에서 계정 설정이 변경')
        expect(self.column(page,'desc').locator('input')).not_to_be_checked();expect(page.locator('#wc-server-save')).to_be_disabled()
        self.assertEqual(self.remote(page)['columns']['modes']['Radiology']['hidden'],['age'])
        page.once('dialog',lambda d:d.dismiss());page.locator('#wc-server-load').click()
        expect(self.column(page,'desc').locator('input')).not_to_be_checked()
        page.once('dialog',lambda d:d.accept());self.action(page,'load','편집창에 불러왔습니다')
        expect(self.column(page,'age').locator('input')).not_to_be_checked();expect(self.column(page,'desc').locator('input')).to_be_checked()
        page.route('**/api/worklist-columns',lambda r:r.abort())
        self.column(page,'sex').locator('input').uncheck();page.locator('#wc-server-save').click()
        expect(page.locator('#wc-server-status')).to_contain_text('응답을 확인할 수 없습니다')
        expect(self.column(page,'sex').locator('input')).not_to_be_checked()
        page.locator('#wc-memory').click();expect(page.locator('#heads [data-key="sex"]')).to_have_count(0)
        self.assertEqual(self.remote(peer)['columns']['modes']['Radiology']['hidden'],['age'])
    def test_roam_columns_04_transient_identity_check_keeps_draft_and_recovers(self):
        page=self.login();self.open_columns(page);self.action(page,'inspect','저장된 열 설정이 없습니다')
        self.column(page,'desc').locator('input').uncheck()
        page.route('**/api/me',lambda r:r.fulfill(status=503,body='temporary failure'))
        page.locator('#wc-server-save').click()
        expect(page.locator('#wc-server-status')).to_contain_text('계정 상태를 일시적으로 확인하지 못했습니다')
        expect(page.locator('#column-manager')).to_be_visible();expect(page.locator('#columnsettings')).to_be_enabled()
        expect(self.column(page,'desc').locator('input')).not_to_be_checked()
        page.unroute('**/api/me');self.action(page,'inspect','저장된 열 설정이 있습니다')
        self.assertEqual(self.remote(page)['columns']['modes']['Radiology']['hidden'],['desc'])
        page.route('**/api/worklist-columns',lambda r:r.fulfill(status=400,body='invalid',content_type='text/plain'))
        page.locator('#wc-server-save').click();expect(page.locator('#wc-server-status')).to_contain_text('형식을 거절했습니다')
        expect(self.column(page,'desc').locator('input')).not_to_be_checked()
        page.unroute('**/api/worklist-columns');self.action(page,'inspect','저장된 열 설정이 있습니다')
        page.route('**/api/worklist-columns',lambda r:r.fulfill(status=409,body='conflict',content_type='text/plain'))
        page.locator('#wc-server-save').click();expect(page.locator('#wc-server-status')).to_contain_text('다른 창에서 계정 설정이 변경')
        expect(self.column(page,'desc').locator('input')).not_to_be_checked()
        page.locator('#wc-memory').click();expect(page.locator('#heads [data-key="desc"]')).to_have_count(0)

    def test_roam_columns_03_delayed_read_edit_close_and_session(self):
        page=self.login();self.open_columns(page);self.action(page,'inspect','저장된 열 설정이 없습니다')
        self.column(page,'age').locator('input').uncheck();self.action(page,'save','편집값을 계정에 저장했습니다')
        page.locator('#wc-save').click();self.open_columns(page)
        held=[]
        def delay(route):held.append((route,route.fetch()))
        page.route('**/api/worklist-columns',delay)
        page.locator('#wc-server-load').click();page.wait_for_timeout(500);self.assertEqual(len(held),1)
        self.column(page,'desc').locator('input').uncheck();route,response=held.pop();route.fulfill(response=response)
        expect(page.locator('#wc-server-status')).to_contain_text('편집값이 바뀌어 불러오지 않았습니다')
        expect(self.column(page,'desc').locator('input')).not_to_be_checked()
        page.once('dialog',lambda d:d.accept());page.locator('#wc-server-load').click();page.wait_for_timeout(500);self.assertEqual(len(held),1)
        page.once('dialog',lambda d:d.accept());page.locator('#wc-close').click();route,response=held.pop();route.fulfill(response=response)
        self.open_columns(page);expect(self.column(page,'desc').locator('input')).to_be_checked()
        page.locator('#wc-server-load').click();page.wait_for_timeout(500);self.assertEqual(len(held),1)
        page.route('**/api/me',lambda r:r.fulfill(json=dict(kind='member',institution='different',sub='different')))
        route,response=held.pop();route.fulfill(response=response)
        expect(page.locator('#column-manager')).not_to_be_visible();expect(page.locator('#columnsettings')).to_be_disabled()
        expect(page.locator('#heads [data-key="desc"]')).to_have_count(1)

def load_tests(loader,tests,pattern):
    return unittest.TestSuite(ColumnsRoamingE2E(name) for name in loader.getTestCaseNames(ColumnsRoamingE2E) if name.startswith('test_roam_columns_'))
if __name__=='__main__':unittest.main(verbosity=2)
