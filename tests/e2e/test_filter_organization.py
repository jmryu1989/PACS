"""TEST-D01-FILTER-ORGANIZE: account-persisted classification and metadata."""
import os
from pathlib import Path
import unittest
import uuid

from playwright.sync_api import expect
import test_saved_filter_manager as manager


class FilterOrganizationE2E(manager.SavedFilterManagerE2E):
    def test_organization_tree_order_search_move_and_relogin(self):
        prefix = 'ORG-' + uuid.uuid4().hex[:8]
        fixture = self.fixture(patient_id=prefix)
        self.seed_report(fixture)
        page = self.login(); self.select(page, fixture)
        page.locator('#quick').fill(prefix)
        self.open_manager(page)
        description = 'needle <img src=x onerror="window.badFolder=1">'
        saved = []
        for suffix, order in (('first', '20'), ('second', '10')):
            page.locator('#sfm-name').fill(prefix + suffix)
            page.locator('#sfm-folder').fill(prefix + ' / CT')
            page.locator('#sfm-description').fill(description if suffix == 'first' else 'other')
            page.locator('#sfm-ordinal').fill(order)
            saved.append(self.save(page))
            if suffix == 'first': page.locator('#sfm-new').click()
        branch = page.locator(f'details[data-folder="{prefix}/CT"]')
        self.assertEqual(branch.locator('button').evaluate_all('(els) => els.map(e => e.dataset.name)'),
                         [prefix + 'second', prefix + 'first'])
        self.assertEqual(saved[0]['folder'], prefix + '/CT')
        expect(page.locator('#sfm-list img')).to_have_count(0)
        self.assertIsNone(page.evaluate('window.badFolder'))
        branch.locator('summary').click()
        expect(branch.locator('button').first).not_to_be_visible()
        page.locator('#sfm-search').fill('needle')
        expect(page.locator('#sfm-list button')).to_have_count(1)
        page.locator('#sfm-list button').click()
        page.locator('#sfm-folder').fill(prefix + '/MR/추적')
        moved = self.save(page)
        self.assertEqual(moved['id'], saved[0]['id'])
        page.locator('#sfm-search').fill(prefix + '/MR')
        expect(page.locator('#sfm-list button')).to_have_count(1)
        page.locator('#sfm-close').click()
        expect(page.locator('#quick')).to_have_value(prefix)
        expect(page.locator('#findings')).to_have_value(fixture.secret)
        self.assertEqual(len(self.versions(fixture)), 1)
        fresh = self.login(); self.open_manager(fresh)
        fresh.locator('#sfm-search').fill(prefix)
        fresh.locator('#sfm-list button', has_text=prefix + 'first').click()
        expect(fresh.locator('#sfm-folder')).to_have_value(prefix + '/MR/추적')
        expect(fresh.locator('#sfm-description')).to_have_value(description)
        expect(fresh.locator('#sfm-ordinal')).to_have_value('20')
        # At the save controls, the folder navigation remains reachable alongside the editor.
        fresh.locator('#sfm-save').scroll_into_view_if_needed()
        expect(fresh.locator('#sfm-search')).to_be_in_viewport()
        fresh.locator('#sfm-folder').fill('')
        ungrouped = self.save(fresh)
        self.assertEqual(ungrouped['folder'], '')
        expect(fresh.locator(f'details[data-folder="{prefix}/MR"]')).to_have_count(0)
        other = self.login('doctor2'); self.open_manager(other)
        other.locator('#sfm-search').fill(prefix)
        expect(other.locator('#sfm-list button')).to_have_count(0)
        evidence = Path(os.environ['KIN_EVIDENCE_DIR'])
        fresh.locator('#saved-filter-manager').evaluate('(dialog) => dialog.scrollTop = 0')
        fresh.screenshot(path=str(evidence / 'organization-layout.png'))

    def test_organization_legacy_write_validation_and_failed_input(self):
        name = 'ORG-api-' + uuid.uuid4().hex[:8]
        original = dict(name=name, mode='Radiology', days=-1, cols={}, folder='개인/CT',
                        description='preserve metadata', ordinal=42)
        result = self.stack.request('POST', '/filters', 'doctor', original)
        self.assertEqual(result.status, 201); self.addCleanup(self.remove_filter, result.body['id'])
        legacy = {k:v for k,v in original.items() if k not in ('folder','description','ordinal')}
        legacy['quick'] = 'updated by older client'
        updated = self.stack.request('POST', '/filters', 'doctor', legacy)
        self.assertEqual(updated.status, 201)
        for key in ('folder','description','ordinal'):
            self.assertEqual(updated.body[key], original[key])
        for bad in ({'folder':'a//b'}, {'folder':'../a'}, {'folder':'a/b/c/d/e/f'},
                    {'folder':'a\\b'}, {'folder':{}}, {'description':None},
                    {'description':'x'*1001}, {'ordinal':-1}, {'ordinal':1.5}, {'ordinal':'2'}):
            rejected = self.stack.request('POST', '/filters', 'doctor', dict(original, **bad))
            self.assertEqual(rejected.status, 400, bad)
        prefs = self.stack.request('GET', '/prefs', 'doctor')
        row = next(f for f in prefs.body['filters'] if f['name'] == name)
        self.assertEqual(row['quick'], legacy['quick'])
        self.assertEqual(row['folder'], original['folder'])
        page = self.login(); self.open_manager(page)
        page.locator('#sfm-search').fill(name); page.locator('#sfm-list button').click()
        page.locator('#sfm-folder').fill('a//b')
        page.locator('#sfm-save').click()
        expect(page.locator('#sfm-status')).to_contain_text('폴더는')
        expect(page.locator('#sfm-folder')).to_have_value('a//b')
        expect(page.locator('#sfm-description')).to_have_value(original['description'])


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(FilterOrganizationE2E(name) for name in loader.getTestCaseNames(FilterOrganizationE2E)
                              if name.startswith('test_organization_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
