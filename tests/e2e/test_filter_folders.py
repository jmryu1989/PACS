"""TEST-FILTER-FOLDERS: exact personal mutations, revision conflicts and UI preservation."""
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import unittest
import uuid

from playwright.sync_api import expect
import test_saved_filter_manager as manager


class FilterFoldersE2E(manager.SavedFilterManagerE2E):
    def snapshot(self, user='doctor'):
        result = self.stack.request('GET', '/filter-folders', user)
        self.assertEqual(result.status, 200, result.text)
        return result.body

    def command(self, snapshot, command, user='doctor', status=201):
        result = self.stack.request('POST', '/filter-folders', user, dict(
            expectedOwner=snapshot['owner'], revision=snapshot['revision'], command=command))
        self.assertEqual(result.status, status, result.text)
        return result.body

    def create_search(self, folder='', user='doctor'):
        result = self.stack.request('POST', '/filters', user, dict(name='FOLDER-'+uuid.uuid4().hex,
            folder=folder, quick='preserved criteria', cols={'mod':'CT'}, description='preserved', ordinal=7,
            isDefault=True, sortKey='date', sortDir=-1))
        self.assertEqual(result.status, 201, result.text)
        return result.body

    def test_folders_01_atomic_tree_and_remove_preserve_searches(self):
        prefix = 'TREE-'+uuid.uuid4().hex[:8]
        first = self.create_search(prefix+'/CT/Child')
        outside = self.create_search(prefix+'other/CT')
        before = self.snapshot()
        before = self.command(before, dict(action='save-folder', path=prefix+'/Empty', description='empty metadata', ordinal=2))
        moved = self.command(before, dict(action='move-folder', **{'from':prefix,'to':prefix+'Moved'}))
        actual = next(f for f in moved['filters'] if f['id']==first['id'])
        expected = next(f for f in before['filters'] if f['id']==first['id'])
        self.assertEqual(actual, dict(expected, folder=prefix+'Moved/CT/Child'))
        self.assertIn(dict(path=prefix+'Moved/Empty', description='empty metadata', ordinal=2), moved['folders'])
        self.assertEqual(next(f for f in moved['filters'] if f['id']==outside['id'])['folder'],outside['folder'])
        removed = self.command(moved, dict(action='remove-folder', path=prefix+'Moved'))
        self.assertEqual(next(f for f in removed['filters'] if f['id']==first['id']), dict(expected, folder=''))
        self.assertFalse(any(f['path'].startswith(prefix+'Moved') for f in removed['folders']))

    def test_folders_02_conflict_rollback_and_old_client_revision(self):
        search = self.create_search('Rollback/A')
        before = self.snapshot()
        self.command(before, dict(action='move-searches', ids=[search['id'],2147483647], to='NeverCreated'), status=404)
        self.assertEqual(self.snapshot(), before)
        self.command(before, dict(action='move-folder', **{'from':'Rollback','to':'Rollback/Child'}), status=400)
        self.assertEqual(self.snapshot(), before)
        changed = self.stack.request('POST','/filters','doctor',dict(name=search['name'],quick='legacy update'))
        self.assertEqual(changed.status,201)
        after = self.snapshot()
        self.assertEqual(after['revision'],before['revision']+1)
        self.assertEqual(next(f for f in after['filters'] if f['id']==search['id'])['folder'],'Rollback/A')
        self.command(before,dict(action='delete-searches',ids=[search['id']]),status=409)
        self.assertEqual(self.snapshot(),after)

    def test_folders_03_parallel_revision_and_owner(self):
        before = self.snapshot()
        def write(index):
            return self.stack.request('POST','/filter-folders','doctor',dict(expectedOwner=before['owner'],
                revision=before['revision'],command=dict(action='save-folder',path='Parallel'+str(index),description='',ordinal=0)))
        # Acquire auth before concurrent requests; do not race fixture provisioning.
        self.stack.token('doctor')
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(write,range(2)))
        self.assertEqual(sorted(r.status for r in results),[201,409])
        after = self.snapshot()
        self.assertEqual(after['revision'],before['revision']+1)
        foreign = self.create_search('Foreign', 'doctor2')
        self.command(after,dict(action='delete-searches',ids=[foreign['id']]),status=404)
        self.command(after,dict(action='save-folder',path='WrongOwner',description='',ordinal=0),'doctor2',409)
        self.assertEqual(self.snapshot(),after)
        self.assertTrue(any(f['id']==foreign['id'] for f in self.snapshot('doctor2')['filters']))

    def load_folders(self, page):
        if not page.locator('#sfm-organize').evaluate('el => el.open'):
            page.locator('#sfm-organize > summary').click()
        page.locator('#sfm-load-folders').click()
        expect(page.locator('#sfm-status')).to_contain_text('검색 모음을 불러왔습니다')

    def click_command(self,page,button,status=201):
        page.once('dialog',lambda dialog:dialog.accept())
        with page.expect_response(lambda r:r.request.method=='POST' and r.url.endswith('/api/filter-folders')) as response:
            page.locator(button).click()
        self.assertEqual(response.value.status,status)
        expect(page.locator('#saved-filter-manager')).to_have_attribute('aria-busy','false')

    def test_folders_04_ui_empty_bulk_move_relogin_remove(self):
        name='UI-'+uuid.uuid4().hex[:8]
        search=self.create_search()
        page=self.login();self.open_manager(page);self.load_folders(page)
        page.locator('#sfm-folder-path').fill(name+'/Empty')
        page.locator('#sfm-folder-description').fill('Empty description')
        self.click_command(page,'#sfm-folder-save')
        expect(page.locator(f'details[data-folder="{name}/Empty"]')).to_be_visible()
        page.get_by_role('checkbox',name='Select Search: '+search['name'],exact=True).check()
        page.locator('#sfm-folder-destination').fill(name+'/Empty')
        self.click_command(page,'#sfm-bulk-move')
        expect(page.locator(f'details[data-folder="{name}/Empty"] button[data-name]')).to_have_attribute('data-name',search['name'])
        page.once('dialog',lambda d:d.accept());page.locator('#sfm-close').click()
        fresh=self.login();self.open_manager(fresh);self.load_folders(fresh)
        expect(fresh.locator(f'details[data-folder="{name}/Empty"]')).to_be_visible()
        fresh.locator('#sfm-folder-path').fill(name)
        self.click_command(fresh,'#sfm-folder-remove')
        self.assertEqual(next(f for f in self.snapshot()['filters'] if f['id']==search['id'])['folder'],'')
        fresh.get_by_role('checkbox',name='Select Search: '+search['name'],exact=True).check()
        fresh.once('dialog',lambda d:d.dismiss());fresh.locator('#sfm-bulk-delete').click()
        self.assertTrue(any(f['id']==search['id'] for f in self.snapshot()['filters']))
        self.click_command(fresh,'#sfm-bulk-delete')
        self.assertFalse(any(f['id']==search['id'] for f in self.snapshot()['filters']))

    def test_folders_05_ui_conflict_preserves_edits_selection_and_report(self):
        fixture=self.fixture(patient_id='FOLDER-DRAFT-'+uuid.uuid4().hex[:8]);self.seed_report(fixture)
        search=self.create_search()
        page=self.login();self.select(page,fixture)
        page.locator('#findings').fill('unsaved clinical draft')
        self.open_manager(page);self.load_folders(page)
        page.locator('#sfm-quick').fill('unsaved search draft')
        page.get_by_role('checkbox',name='Select Search: '+search['name'],exact=True).check()
        page.locator('#sfm-folder-destination').fill('KeepDestination')
        self.create_search('concurrent')
        self.click_command(page,'#sfm-bulk-move',409)
        expect(page.locator('#sfm-quick')).to_have_value('unsaved search draft')
        expect(page.locator('#sfm-folder-destination')).to_have_value('KeepDestination')
        expect(page.get_by_role('checkbox',name='Select Search: '+search['name'],exact=True)).to_be_checked()
        self.load_folders(page)
        self.click_command(page,'#sfm-bulk-move')
        expect(page.locator('#sfm-quick')).to_have_value('unsaved search draft')
        page.once('dialog',lambda d:d.accept());page.locator('#sfm-close').click()
        expect(page.locator('#findings')).to_have_value('unsaved clinical draft')

    def test_folders_06_small_screen_metadata_order_and_busy_guard(self):
        page=self.login();page.set_viewport_size(dict(width=390,height=844))
        self.open_manager(page);self.load_folders(page)
        before=self.snapshot()
        before=self.command(before,dict(action='save-folder',path='Z first',description='visible metadata',ordinal=1))
        self.command(before,dict(action='save-folder',path='A later',description='',ordinal=10))
        self.load_folders(page)
        paths=page.locator('#sfm-list > details').evaluate_all('(nodes)=>nodes.map(node=>node.dataset.folder)')
        self.assertLess(paths.index('Z first'),paths.index('A later'))
        page.locator('#sfm-folder-path').fill('Z first');page.locator('#sfm-folder-description').focus()
        expect(page.locator('#sfm-folder-description')).to_have_value('visible metadata')
        page.locator('#sfm-folder-description').fill('draft retained on failure')
        page.locator('#sfm-folder-path').fill('New path');page.locator('#sfm-folder-order').focus()
        expect(page.locator('#sfm-folder-description')).to_have_value('draft retained on failure')
        page.route('**/api/filter-folders',lambda route:route.fulfill(status=503,content_type='application/json',body='{"message":"Synthetic unavailable"}')
                   if route.request.method=='POST' else route.continue_())
        self.click_command(page,'#sfm-folder-save',503)
        expect(page.locator('#sfm-folder-description')).to_have_value('draft retained on failure')
        page.once('dialog',lambda dialog:dialog.dismiss());page.locator('#sfm-preview').click()
        expect(page.locator('#saved-filter-manager')).to_be_visible()
        expect(page.locator('#sfm-folder-description')).to_have_value('draft retained on failure')
        button=page.locator('#sfm-folder-save');button.scroll_into_view_if_needed()
        self.assertTrue(button.evaluate('el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===el}'))
        self.assertTrue(page.locator('#saved-filter-manager').evaluate('el=>el.scrollWidth<=el.clientWidth'))
        evidence=Path(os.environ['KIN_EVIDENCE_DIR']);evidence.mkdir(parents=True,exist_ok=True)
        page.screenshot(path=str(evidence/'folders-portrait.png'))

    def test_folders_07_first_write_race_and_default_serialization(self):
        before=self.snapshot('tech');self.assertEqual(before['revision'],0)
        def folder_write(index):
            return self.stack.request('POST','/filter-folders','tech',dict(expectedOwner=before['owner'],revision=0,
                command=dict(action='save-folder',path='First'+str(index),description='',ordinal=0)))
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(folder_write,range(2)))
        self.assertEqual(sorted(result.status for result in results),[201,409])
        self.assertEqual(self.snapshot('tech')['revision'],1)
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda index:self.create_search('Defaults/'+str(index),'tech'),range(2)))
        saved=self.snapshot('tech')
        self.assertEqual(saved['revision'],3)
        self.assertEqual(sum(bool(filter['isDefault']) for filter in saved['filters']),1)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(FilterFoldersE2E(name) for name in loader.getTestCaseNames(FilterFoldersE2E)
                              if name.startswith('test_folders_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
