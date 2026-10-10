# coding: utf-8
"""REQ-WS3/WS7 -> RISK-WS3/WS7 -> WS3-SHORTCUTS / WS3-COUNTS / WS3-RELATIVE-DATE.
Serve the committed page/bundle and dependency assets; only HTTP answers are synthetic.
"""
import copy
import os
import re
import sys
import unittest
from playwright.sync_api import expect, sync_playwright
import auth_logout_dom_test as auth
from pathlib import Path

if os.environ.get('KIN_W2_ASSET_ROOT'):
    auth.ROOT = Path(os.environ['KIN_W2_ASSET_ROOT']).resolve()


class FolderSite(auth.Site):
    def __init__(self):
        super().__init__()
        self.filters = []
        self.shortcuts = []
        self.shared = [dict(id=9, name='Shared CT', mode='Radiology', days=-1, quick='', cols={'modality': 'CT'})]
        self.collection_revision = 0
        self.fail_read = False
        self.fail_shared = False
        self.fail_write = False
        self.shortcut_writes = []
        self.modalities = ['CT', 'MR', 'MG', 'XA', 'CT,SR', 'CTA']
        self.row_dates = None

    def collection(self):
        return dict(owner=[auth.INSTITUTION, self.account['sub']], revision=self.collection_revision,
                    folders=[], filters=copy.deepcopy(self.filters), shortcuts=copy.deepcopy(self.shortcuts))

    def list_body(self, account, rename=None):
        body = super().list_body(account, rename)
        template = body['studies'][0]
        body['studies'] = [dict(copy.deepcopy(template), uid=auth.UID+'.'+str(i), name='SYN '+mod,
                               id='SYN-'+str(i), modality=mod) for i, mod in enumerate(self.modalities)]
        body['pagination']['total'] = len(body['studies'])
        if self.row_dates:
            for row, date in zip(body['studies'], self.row_dates):
                row['date'] = date.replace('-', '')
        return body

    def api(self, route, request, method, path, query):
        if path in ('/api/filter-folders', '/api/shared-filters', '/api/filters', '/api/prefs', '/api/bootstrap'):
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            if path in self.held_gets and method == 'GET':
                return self.held_gets[path].append(route)
            if path == '/api/filter-folders':
                if method == 'GET':
                    return route.fulfill(status=503 if self.fail_read else 200,
                                         json={'message': 'SYN read failed'} if self.fail_read else self.collection())
                body = request.post_data_json
                self.shortcut_writes.append(copy.deepcopy(body))
                if self.fail_write or body['revision'] != self.collection_revision:
                    return route.fulfill(status=409, json={'message': 'SYN conflict'})
                self.shortcuts = copy.deepcopy(body['command']['shortcuts'])
                self.collection_revision += 1
                if getattr(self, 'held_shortcuts', None) is not None:
                    self.held_shortcuts.append((route, self.collection()))
                    return
                return route.fulfill(status=201, json=self.collection())
            if path == '/api/shared-filters':
                if getattr(self, 'held_shared', None) is not None:
                    self.held_shared.append((route, copy.deepcopy(dict(owner=[auth.INSTITUTION, account['sub']],
                        revision=1, folders=[], filters=self.shared, canManage=False))))
                    return
                return route.fulfill(status=403 if self.fail_shared else 200, json=dict(
                    owner=[auth.INSTITUTION, account['sub']], revision=1, folders=[], filters=self.shared, canManage=False))
            if path == '/api/filters' and method == 'POST':
                value = request.post_data_json
                old = next((f for f in self.filters if f['name'] == value['name']), None)
                saved = dict(value, id=old['id'] if old else len(self.filters)+1)
                if old:
                    self.filters.remove(old)
                if saved.get('isDefault'):
                    for f in self.filters:
                        f['isDefault'] = False
                self.filters.append(saved)
                self.collection_revision += 1
                return route.fulfill(status=201, json=saved)
            if path in ('/api/bootstrap', '/api/prefs'):
                return route.fulfill(json=dict(statesOmitted=True, me=dict(actor=account['actor'], roles=account['roles'],
                    institution=auth.INSTITUTION, institutionName='SYN Hospital A'), filters=self.filters, templates=[],
                    institutions=[], states={}, orders=[], serverTime='2026-10-03T00:00:00.000Z'))
        return super().api(route, request, method, path, query)


class WorklistFoldersDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = FolderSite()
        self.context = self.browser.new_context(viewport={'width': 1500, 'height': 1000}, timezone_id='America/Los_Angeles')
        self.context.route('**/*', lambda route, request: self.site.handle(route, request))
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.on('dialog', lambda d: d.accept())

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors)
        self.assertEqual([], self.site.violations)

    def open(self):
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(len(self.site.modalities))
        expect(self.page.get_by_role('button', name='All Studies (6)', exact=True)).to_be_visible()

    def folder(self, text):
        return self.page.get_by_role('navigation', name='Folders').get_by_role('button', name=re.compile('^'+re.escape(text)+r' \('))

    def test_first_paint_tokens_or_and_empty_and_vanished(self):
        self.open()
        expect(self.folder('All Studies')).to_have_attribute('aria-current', 'true')
        expect(self.page.locator('#quick')).to_have_value('')
        expect(self.folder('MG')).to_be_visible()
        expect(self.folder('XA')).to_be_visible()
        self.folder('CT').click()
        self.folder('MR').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(3)
        self.page.locator('#quick').fill('MR')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        self.page.locator('#quick').fill('')
        self.folder('CT').click()
        self.folder('MR').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(0)
        expect(self.page.get_by_role('status').filter(has_text='선택된 Modality')).to_be_visible()
        self.page.evaluate('''() => {
          const status = [...document.querySelectorAll('[role=status]')].find(n => n.textContent.includes('선택된 Modality'));
          window.selectionAnnouncements = 0;
          new MutationObserver(records => {
            for (const r of records) if (r.target === status || [...r.removedNodes].includes(status)) ++window.selectionAnnouncements;
          }).observe(status.parentElement, {subtree:true, childList:true, characterData:true});
        }''')
        self.page.locator('#quick').fill('CT')
        self.page.locator('#quick').fill('')
        self.assertEqual(0, self.page.evaluate('window.selectionAnnouncements'))
        self.folder('MG').click()
        self.site.modalities = ['CT']
        self.page.locator('#refresh').click()
        expect(self.folder('MG')).to_have_text('MG (0)')
        expect(self.folder('MG')).to_have_attribute('aria-pressed', 'true')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(0)

    def test_search_draft_ime_apply_save_shortcut_and_relogin(self):
        self.open()
        self.folder('CT').click()
        self.folder('MR').click()
        self.page.locator('[data-search-mode]').select_option('manual')
        self.page.locator('#quick').fill('MR')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(3)
        self.page.locator('#quick').dispatch_event('keydown', {'key': 'Enter', 'isComposing': True})
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(3)
        self.page.locator('#quick').dispatch_event('keydown', {'key': 'Enter', 'keyCode': 229})
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(3)
        self.page.locator('#quick').press('Enter')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        self.page.locator('#toolbar-filters > summary').click()
        self.page.locator('#savefilter').click()
        self.page.locator('#sfm-name').fill('My MR')
        self.page.locator('#sfm-save-apply').click()
        expect(self.page.locator('#sfm-status')).to_contain_text('저장')
        self.page.locator('#sfm-close').click()
        nav = self.page.get_by_role('navigation', name='Folders')
        nav.get_by_label('Shortcut Name', exact=True).fill('Morning')
        nav.get_by_role('combobox', name=re.compile(r'^Saved Search')).select_option('own:1')
        nav.get_by_role('button', name='Add Shortcut', exact=True).click()
        expect(self.page.locator('#shortcuts-status')).to_contain_text('저장했습니다')
        self.folder('All Studies').click()
        self.folder('Morning').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        self.site.sign_in(auth.RAD)
        self.page.goto(auth.MAIN_URL)
        expect(self.folder('Morning')).to_be_visible()
        self.folder('Morning').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        self.assertEqual('own:1', self.site.shortcuts[0]['searchId'])

    def test_counts_unknown_partial_complete_and_failure(self):
        self.site.held_lists = []
        self.page.goto(auth.MAIN_URL)
        expect(self.folder('CT')).to_have_text('CT (—)')
        self.page.wait_for_function('document.querySelector("#study-fetch-status").textContent.length > 0')
        held = self.site.held_lists
        self.site.held_lists = None
        for route, account in held:
            route.fulfill(json=self.site.list_body(account))
        expect(self.folder('CT')).to_have_text('CT (2)')
        self.site.held_lists = []
        self.page.locator('#refresh').click()
        expect(self.folder('CT')).to_have_text('CT (2 · Partial)')
        held = self.site.held_lists
        self.site.held_lists = None
        for route, _ in held:
            route.fulfill(status=503, json={'message': 'SYN failed'})
        expect(self.folder('CT')).to_have_text('CT (—)')

    def test_unavailable_shared_rename_revoke_and_deleted_search_never_widen(self):
        self.site.shortcuts = [dict(id='s', name='Shared shortcut', searchId='shared:9')]
        self.open()
        self.folder('Shared shortcut').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        self.site.shared[0]['name'] = 'Renamed shared'
        self.page.locator('#shortcuts-reload').click()
        expect(self.folder('Shared shortcut')).to_contain_text('Unavailable')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(0)
        expect(self.folder('All Studies')).not_to_have_attribute('aria-current', 'true')
        self.site.fail_shared = True
        self.page.locator('#shortcuts-reload').click()
        expect(self.folder('Shared shortcut')).to_be_disabled()
        self.assertEqual('shared:9', self.site.shortcuts[0]['searchId'])

    def test_old_shared_answer_cannot_restore_a_revoked_target(self):
        self.site.shortcuts = [dict(id='s', name='Shared shortcut', searchId='shared:9')]
        self.open()
        self.folder('Shared shortcut').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        self.site.held_shared = []
        self.page.locator('#shortcuts-reload').click()
        for _ in range(100):
            if self.site.held_shared:
                break
            self.page.wait_for_timeout(20)
        self.assertEqual(1, len(self.site.held_shared))
        held = self.site.held_shared
        self.site.held_shared = None
        self.site.shared = []
        self.page.locator('#shortcuts-reload').click()
        expect(self.folder('Shared shortcut')).to_be_disabled()
        for route, snapshot in held:
            with self.page.expect_response(lambda r: r.url.endswith('/api/shared-filters')) as response:
                route.fulfill(json=snapshot)
            response.value.finished()
        self.page.evaluate('() => new Promise(resolve => requestAnimationFrame(resolve))')
        expect(self.folder('Shared shortcut')).to_be_disabled()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(0)

    def test_deleted_personal_target_keeps_shortcut_unavailable(self):
        self.site.filters = [dict(self.site.shared[0], id=1, name='Personal CT')]
        self.site.shortcuts = [dict(id='s', name='Personal shortcut', searchId='own:1')]
        self.open()
        self.folder('Personal shortcut').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        self.site.filters[0]['name'] = 'Renamed CT'
        self.page.locator('#shortcuts-reload').click()
        expect(self.page.locator('#active-filter-name')).to_contain_text('Renamed CT')
        self.site.filters = []
        self.page.locator('#shortcuts-reload').click()
        expect(self.folder('Personal shortcut')).to_be_disabled()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(0)
        self.assertEqual('own:1', self.site.shortcuts[0]['searchId'])

    def test_preparation_cancel_keeps_unknown_write_blocked_until_reload(self):
        self.open()
        self.site.held_shortcuts = []
        nav = self.page.get_by_role('navigation', name='Folders')
        nav.get_by_label('Shortcut Name', exact=True).fill('Interrupted')
        nav.get_by_role('button', name='Add Shortcut', exact=True).click()
        for _ in range(100):
            if self.site.held_shortcuts:
                break
            self.page.wait_for_timeout(20)
        self.assertEqual(1, len(self.site.held_shortcuts))
        self.page.evaluate('''() => {
          const preparation = KinWorkContext.prepare({});
          KinWorkContext.cancelPreparation(preparation);
        }''')
        expect(self.page.locator('#shortcuts-save')).to_be_disabled()
        expect(self.page.locator('#shortcuts-status')).to_contain_text('Reload Shortcuts')
        held = self.site.held_shortcuts
        self.site.held_shortcuts = None
        for route, snapshot in held:
            with self.page.expect_response(lambda r: r.request.method == 'POST' and r.url.endswith('/api/filter-folders')) as response:
                route.fulfill(status=201, json=snapshot)
            response.value.finished()
        self.page.evaluate('() => new Promise(resolve => requestAnimationFrame(resolve))')
        expect(self.page.locator('#shortcuts-save')).to_be_disabled()
        self.assertEqual(1, len(self.site.shortcut_writes))
        self.page.locator('#shortcuts-reload').click()
        expect(self.page.locator('#shortcuts-save')).to_be_enabled()
        self.page.locator('#shortcuts-save').click()
        expect(self.page.locator('#shortcuts-status')).to_contain_text('저장했습니다')
        self.assertEqual(2, len(self.site.shortcut_writes))
        self.assertEqual(1, len(self.site.shortcuts))

    def test_shortcut_conflict_retains_draft_and_read_failure_blocks_writes(self):
        self.open()
        self.site.collection_revision += 1
        nav = self.page.get_by_role('navigation', name='Folders')
        nav.get_by_label('Shortcut Name', exact=True).fill('Draft shortcut')
        nav.get_by_role('button', name='Add Shortcut', exact=True).click()
        expect(self.page.locator('#shortcuts-status')).to_contain_text('저장 결과를 확인하지 못했습니다')
        expect(self.folder('Draft shortcut')).to_be_visible()
        expect(self.page.locator('#shortcuts-save')).to_be_disabled()
        self.assertEqual([], self.site.shortcuts)
        self.site.fail_read = True
        self.page.locator('#shortcuts-reload').click()
        expect(self.page.locator('#shortcuts-status')).to_contain_text('읽지 못해')
        expect(self.page.locator('#shortcuts-save')).to_be_disabled()
        self.site.fail_read = False
        self.page.locator('#shortcuts-reload').click()
        expect(self.page.locator('#shortcuts-save')).to_be_enabled()
        self.page.locator('#shortcuts-save').click()
        expect(self.page.locator('#shortcuts-status')).to_contain_text('저장했습니다')
        self.assertEqual('Draft shortcut', self.site.shortcuts[0]['name'])
        self.assertEqual(2, len(self.site.shortcut_writes))

    def test_late_collection_answer_after_logout_does_not_recreate_tree(self):
        self.open()
        self.site.held_gets['/api/filter-folders'] = []
        self.page.locator('#shortcuts-reload').click()
        self.page.wait_for_function('document.querySelector("#shortcuts-status").textContent.includes("불러오는")')
        self.page.locator('#logout').click()
        expect(self.page).to_have_url(re.compile('index.html'))
        for route in self.site.held_gets['/api/filter-folders']:
            try:
                route.fulfill(json=self.site.collection())
            except Exception:
                pass  # Browser cancellation is observable through the closed document below.
        expect(self.page.locator('#worklist-folders')).to_have_count(0)

    def test_unseen_default_mg_xa_survive_first_paint_and_new_login(self):
        self.site.filters = [dict(id=1, name='MG and XA', mode='Radiology', days=-1, quick='',
                                 cols={'modality': ['MG', 'XA']}, isDefault=True)]
        self.site.held_lists = []
        self.page.goto(auth.MAIN_URL)
        for token in ['MG', 'XA']:
            expect(self.folder(token)).to_have_text(token+' (—)')
            expect(self.folder(token)).to_have_attribute('aria-pressed', 'true')
        held = self.site.held_lists
        self.site.held_lists = None
        for route, account in held:
            route.fulfill(json=self.site.list_body(account))
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        self.site.sign_in(auth.RAD)
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        for token in ['MG', 'XA']:
            expect(self.folder(token)).to_have_attribute('aria-pressed', 'true')

    def test_relative_dates_cross_local_midnight_dst_month_and_year(self):
        from datetime import datetime, timedelta
        for instant in ['2026-03-08T23:59:00-07:00', '2026-11-01T23:59:00-08:00',
                        '2026-12-31T23:59:00-08:00', '2026-02-28T23:59:00-08:00']:
            with self.subTest(instant=instant):
                now = datetime.fromisoformat(instant)
                self.page.clock.set_fixed_time(now)
                self.site.modalities = ['CT', 'MR', 'MG', 'XA']
                self.site.row_dates = [(now.date()+timedelta(days=d)).isoformat() for d in [-2, -1, 0, 2]]
                self.site.filters = [dict(id=1, name='Since yesterday', mode='Radiology', days=-1, quick='', isDefault=True,
                    cols={'$compound': {'version':1, 'join':'and', 'rules':[{'field':'date','op':'withinLastDays','value':'1'}]}})]
                self.page.goto(auth.MAIN_URL)
                expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
                expect(self.page.locator('#rows')).to_contain_text('SYN MR')
                expect(self.page.locator('#rows')).to_contain_text('SYN MG')
                self.page.clock.set_fixed_time(now+timedelta(minutes=2))
                self.page.locator('#refresh').click()
                expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
                expect(self.page.locator('#rows')).to_contain_text('SYN MG')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(verbosity=2)
