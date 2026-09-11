# coding: utf-8
"""TEST-VIEWER-IDENTITY-FIELDS: native field placement, modality fallback, and roaming."""
import unittest
from pathlib import Path

from playwright.sync_api import expect
from test_viewer_identity_position import ViewerIdentityPositionE2E


class ViewerIdentityFieldsE2E(ViewerIdentityPositionE2E):
    def test_identity_fields_01_modality_profile_fields_and_unknown_fallback_preserve_work(self):
        current, prior = self.pair();page, viewer = self.popup(current)
        page.locator('#findings').fill('KEEP FIELD POSITION REPORT');before = self.snapshot(viewer);self.settings(page)
        label = self.label(viewer, current.uid);modality = label.get_attribute('data-modality')
        self.assertIn(modality, ('CT','MR','CR','DX','US','MG','XA','RF','PT','NM','OT'))
        page.locator('#viewer-identity-current-profile').select_option(modality)
        page.locator('#viewer-identity-current-name-position').select_option('top-left')
        page.locator('#viewer-identity-current-date-position').select_option('bottom-left')
        page.locator('#viewer-identity-current-description').check()
        page.locator('#viewer-identity-current-description-position').select_option('bottom-right')
        expect(label).to_have_attribute('data-profile', 'override')
        expect(label.locator('.kin-viewer-identity-group[data-position="top-left"]')).to_contain_text('SYNTHETIC')
        expect(label.locator('.kin-viewer-identity-group[data-position="bottom-left"]')).to_be_visible()
        expect(label.locator('.kin-viewer-identity-group[data-position="bottom-right"]')).to_be_visible()
        expect(page.locator('#findings')).to_have_value('KEEP FIELD POSITION REPORT');self.assertEqual(self.snapshot(viewer), before)
        self.assertEqual(self.jobs(current), []);self.assertEqual(len(self.versions(current)), 1)

    def test_identity_fields_02_deep_copy_modality_copy_reset_and_account_restore(self):
        current, prior = self.pair();page, viewer = self.popup(current);self.settings(page)
        modality = self.label(viewer, current.uid).get_attribute('data-modality')
        target = next(value for value in ('CT','MR','CR','DX','US','MG','XA','RF','PT','NM','OT') if value != modality)
        page.locator('#viewer-identity-current-profile').select_option(modality)
        page.locator('#viewer-identity-current-name-position').select_option('top-left')
        page.locator('#viewer-identity-copy-current').click()
        page.locator('#viewer-identity-current-name-position').select_option('bottom-right')
        page.locator('#viewer-identity-prior-profile').select_option(modality)
        expect(page.locator('#viewer-identity-prior-name-position')).to_have_value('top-left')
        page.locator('#viewer-identity-copy-modality-role').select_option('prior')
        page.locator('#viewer-identity-copy-modality-source').select_option(modality)
        page.locator('#viewer-identity-copy-modality-target').select_option(target)
        page.locator('#viewer-identity-copy-modality').click()
        page.locator('#appearance-account-save').click();expect(page.locator('#appearance-account-status')).to_have_text('표시 설정을 계정에 저장했습니다.')
        fresh = self.login();self.workspace(fresh, current);self.settings(fresh);fresh.locator('#appearance-account-load').click()
        fresh.locator('#viewer-identity-prior-profile').select_option(target)
        expect(fresh.locator('#viewer-identity-prior-name-position')).to_have_value('top-left')
        fresh.locator('#viewer-identity-prior-reset-profile').click()
        expect(fresh.locator('#viewer-identity-prior-name-position')).to_have_value('top-right')
        folder=Path(__file__).resolve().parents[2]/'tmp'/'workspace-ui-ci'/'identity-fields-native';folder.mkdir(parents=True,exist_ok=True);fresh.screenshot(path=str(folder/'identity-field-modality-settings.png'))
        self.assertEqual(self.jobs(current), []);self.assertEqual(len(self.versions(current)), 1)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ViewerIdentityFieldsE2E(name) for name in loader.getTestCaseNames(ViewerIdentityFieldsE2E)
                              if name.startswith('test_identity_fields_') and name in ViewerIdentityFieldsE2E.__dict__)


if __name__ == '__main__':
    names = [name for name in unittest.defaultTestLoader.getTestCaseNames(ViewerIdentityFieldsE2E)
             if name.startswith('test_identity_fields_') and name in ViewerIdentityFieldsE2E.__dict__]
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(ViewerIdentityFieldsE2E(name) for name in names))
    raise SystemExit(0 if result.wasSuccessful() else 1)
