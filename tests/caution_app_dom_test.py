"""C19/C20: unchanged served worklist assets with synthetic HTTP answers only.

Check navigation, drafts and copy through their real page consumers. No production
stack, accounts, database or image data are used.
"""
import copy
import os
from pathlib import Path
import unittest

from playwright.sync_api import expect, sync_playwright
import auth_logout_dom_test as auth
from worklist_folders_dom_test import FolderSite


class CautionSite(FolderSite):
    def __init__(self):
        super().__init__()
        self.names = [{'id': 'one', 'name': 'One', 'uids': []}, {'id': 'two', 'name': 'Two', 'uids': []}]
        self.favorite_names = copy.deepcopy(self.names)
        self.tag_names = {scope: copy.deepcopy(self.names) for scope in ('personal', 'institution')}
        self.writes = []
        self.fail_save = False

    def api(self, route, request, method, path, query):
        if path in ('/api/favorite-folders', '/api/study-tags', '/api/shared-filters/copy'):
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            owner = [auth.INSTITUTION, account['sub']]
            if method == 'POST':
                body = request.post_data_json
                self.writes.append((path, copy.deepcopy(body)))
                if self.fail_save:
                    return route.fulfill(status=409, json={'message': 'SYN changed'})
                if path.endswith('/copy'):
                    self.filters = [dict(self.shared[0], id=10, name='Copied CT')]
                    self.collection_revision += 1
                    return route.fulfill(json=self.collection())
                rows = self.favorite_names if path.endswith('favorite-folders') else self.tag_names[body['scope']]
                key = body.get('folderId', body.get('tagId'))
                if body['action'] == 'rename':
                    next(row for row in rows if row['id'] == key)['name'] = body['name']
                elif body['action'] == 'create':
                    rows.append({'id': key, 'name': body['name'], 'uids': []})
            if path.endswith('favorite-folders'):
                return route.fulfill(json={'owner': owner, 'revision': len(self.writes), 'folders': self.favorite_names})
            return route.fulfill(json={'owner': owner, 'canManageInstitution': True, 'catalogs': [
                {'scope': scope, 'revision': len(self.writes), 'tags': rows} for scope, rows in self.tag_names.items()]})
        return super().api(route, request, method, path, query)


class CautionAppDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = CautionSite()
        self.context = self.browser.new_context(viewport={'width': 1500, 'height': 1000})
        self.context.route('**/*', lambda route, request: self.site.handle(route, request))
        self.page = self.context.new_page()
        self.errors, self.dialogs = [], []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.on('dialog', lambda d: (self.dialogs.append(d.message), d.dismiss()))
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(len(self.site.modalities))

    def test_c22_sr_keeps_already_read_values_when_the_traversal_stops(self):
        self.page.add_script_tag(path=str(Path(__file__).resolve().parents[1] / 'config/ohif/sr-provenance.js'))
        self.page.evaluate("""() => {
          const content = [{ConceptNameCodeSequence:[{CodeValue:'125007'}],ContentSequence:[
            {ConceptNameCodeSequence:[{CodeValue:'112040'}],UID:'1.2.3'},
            {ValueType:'NUM',MeasuredValueSequence:[{NumericValue:'123.456',MeasurementUnitsCodeSequence:[{CodeValue:'mm'}]}]}
          ]}, ...Array.from({length:2001},()=>({ValueType:'TEXT',TextValue:'tail'}))];
          const ds={Modality:'SR',displaySetInstanceUID:'sr1',isLoaded:true,measurements:[],instance:{SOPInstanceUID:'1.2.4',ContentSequence:content}};
          const hooks=new Map();
          const plugin=kinCreateSRProvenance();
          plugin.preRegistration({servicesManager:{services:{
            displaySetService:{getActiveDisplaySets:()=>[ds],getDisplaySetByUID:()=>ds},
            customizationService:{get:k=>hooks.get(k),setModeCustomization:(k,v)=>hooks.set(k,v)},
            viewportGridService:{getState:()=>({activeViewportId:'one',viewports:new Map([['one',{displaySetInstanceUIDs:['sr1']} ]])})},
            cornerstoneViewportService:{getCornerstoneViewport:()=>null},
            viewportActionCornersService:{addComponents:()=>{}}
          }},extensionManager:{getModuleEntry:()=>null}});
          plugin.onModeEnter();window.cautionSR=plugin;
        }""")
        expect(self.page.locator('#kin-sr-provenance')).to_contain_text('123.456 mm')
        expect(self.page.locator('#kin-sr-provenance')).to_contain_text('상한')

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def test_favorite_names_survive_navigation_close_create_and_failed_save(self):
        p = self.page
        self.open_filter_action('favorite-open')
        expect(p.locator('#favorite-name')).to_have_value('One')
        p.locator('#favorite-name').fill('Unsent rename')
        p.locator('#favorite-new-name').fill('New folder')
        p.locator('[data-folder-id="two"]').click()
        p.locator('[data-folder-id="one"]').click()
        expect(p.locator('#favorite-name')).to_have_value('Unsent rename')
        p.locator('#favorite-close').click()
        self.open_filter_action('favorite-open')
        expect(p.locator('#favorite-name')).to_have_value('Unsent rename')
        expect(p.locator('#favorite-new-name')).to_have_value('New folder')
        self.assertEqual(self.site.writes, [])
        p.locator('#favorite-create').click()
        expect(p.locator('#favorite-name')).to_have_value('New folder')
        p.locator('[data-folder-id="one"]').click()
        expect(p.locator('#favorite-name')).to_have_value('Unsent rename')
        self.site.fail_save = True
        p.locator('#favorite-rename').click()
        expect(p.locator('#favorite-status')).to_contain_text('SYN changed')
        expect(p.locator('#favorite-name')).to_have_value('Unsent rename')
        self.site.fail_save = False
        p.locator('#favorite-rename').click()
        expect(p.locator('#favorite-status')).to_contain_text('저장되었습니다')
        self.assertEqual(self.site.favorite_names[0]['name'], 'Unsent rename')
        self.assertEqual(self.dialogs, [])
        self.screenshot('favorites')

    def test_tag_names_survive_selection_scope_and_close_without_writes(self):
        p = self.page
        self.open_filter_action('study-tag-open')
        expect(p.locator('#study-tag-name')).to_have_value('One')
        p.locator('#study-tag-name').fill('Personal draft')
        p.locator('#study-tag-new').fill('New personal')
        p.locator('[data-tag-id="two"]').click()
        p.locator('[data-tag-id="one"]').click()
        expect(p.locator('#study-tag-name')).to_have_value('Personal draft')
        p.locator('#study-tag-scope').select_option('institution')
        expect(p.locator('#study-tag-name')).to_have_value('One')
        expect(p.locator('#study-tag-new')).to_have_value('')
        p.locator('#study-tag-name').fill('Institution draft')
        p.locator('#study-tag-scope').select_option('personal')
        expect(p.locator('#study-tag-name')).to_have_value('Personal draft')
        expect(p.locator('#study-tag-new')).to_have_value('New personal')
        p.locator('#study-tag-close').click()
        self.open_filter_action('study-tag-open')
        expect(p.locator('#study-tag-name')).to_have_value('Personal draft')
        p.locator('#study-tag-scope').select_option('institution')
        expect(p.locator('#study-tag-name')).to_have_value('Institution draft')
        self.assertEqual(self.site.writes, [])
        self.assertEqual(self.dialogs, [])
        self.screenshot('tags')

    def test_shared_copy_needs_no_confirmation_and_does_not_apply_search(self):
        p = self.page
        self.open_filter_action('managefilters')
        p.locator('#sfm-shared > summary').click()
        p.locator('#sfs-load').click()
        expect(p.locator('#sfs-copy')).to_be_enabled()
        p.locator('#sfs-destination').fill('Copied')
        p.locator('#sfs-copy').click()
        expect(p.locator('#sfm-status')).to_contain_text('개인 검색으로 복사했습니다')
        self.assertEqual(len(self.site.writes), 1)
        self.assertEqual(self.site.writes[0][1]['to'], 'Copied')
        self.assertEqual(self.dialogs, [])
        expect(p.locator('#rows tr[data-uid]')).to_have_count(len(self.site.modalities))
        self.screenshot('copy')

    def open_filter_action(self, action):
        if not self.page.locator('#' + action).is_visible():
            self.page.locator('#toolbar-filters > summary').click()
        self.page.locator('#' + action).click()

    def test_password_path_and_unavailable_commands(self):
        # An account action: the menu the user's name opens beside Log out (Session details) carries it.
        self.page.locator('#session-who').click()
        details = self.page.get_by_role('group', name='Session details')
        expect(details.get_by_role('link', name='Change Password')).to_have_attribute(
            'href', '/api/auth/login?action=UPDATE_PASSWORD')
        for selector in ['#b-except', '#t-desc']:
            expect(self.page.locator(selector)).to_be_hidden()
        expect(self.page.get_by_role('button', name='Split Exam')).to_have_count(0)
        self.screenshot('available-commands')

    def screenshot(self, name):
        if os.environ.get('KIN_EVIDENCE_DIR'):
            path = Path(os.environ['KIN_EVIDENCE_DIR'])
            path.mkdir(parents=True, exist_ok=True)
            self.page.screenshot(path=str(path / (name + '.png')))


if __name__ == '__main__':
    unittest.main()
