# coding: utf-8
"""REQ-WS3/WS7 -> RISK-WS3/WS7 -> WS3-SHORTCUTS / WS3-COUNTS / WS3-RELATIVE-DATE.
Serve the committed page/bundle and dependency assets; only HTTP answers are synthetic.
"""
import copy
import io
import json
import subprocess
import tempfile
import zipfile
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
        removed = re.fullmatch(r'/api/filters/(\d+)', path)
        if removed and method == 'DELETE':
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            self.filters = [f for f in self.filters if f['id'] != int(removed.group(1))]
            self.collection_revision += 1
            return route.fulfill(json={'ok': True})
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
                return route.fulfill(status=(self.fail_shared if type(self.fail_shared) is int else 403) if self.fail_shared else 200, json=dict(
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
        expect(self.page.locator('#worklist-folders-toggle')).to_have_attribute('aria-expanded', 'false')
        self.page.locator('#worklist-folders-toggle').click()
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
        with self.page.expect_response(lambda r: '/api/studies' in r.url and r.request.method == 'GET') as response:
            self.page.locator('#refresh').click()
        response.value.finished()
        expect(self.folder('CT')).to_have_text('CT (2)')
        self.page.evaluate('() => new Promise(r => requestAnimationFrame(r))')
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
        expect(self.page.locator('#saved-filter-manager')).not_to_be_visible()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
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
        self.page.locator('#worklist-folders-toggle').click()
        expect(self.folder('Morning')).to_be_visible()
        self.folder('Morning').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        self.assertEqual('own:1', self.site.shortcuts[0]['searchId'])

    def test_counts_unknown_partial_complete_and_failure(self):
        self.site.held_lists = []
        self.page.goto(auth.MAIN_URL)
        self.page.locator('#worklist-folders-toggle').click()
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
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        self.site.shared[0]['name'] = 'Renamed shared'
        self.page.locator('#shortcuts-reload').click()
        expect(self.folder('Shared shortcut')).to_contain_text('Unavailable')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        expect(self.folder('All Studies')).not_to_have_attribute('aria-current', 'true')
        self.site.fail_shared = True
        self.page.locator('#shortcuts-reload').click()
        expect(self.folder('Shared shortcut')).to_be_disabled()
        self.assertEqual('shared:9', self.site.shortcuts[0]['searchId'])

    def test_old_shared_answer_cannot_restore_a_revoked_target(self):
        self.site.shortcuts = [dict(id='s', name='Shared shortcut', searchId='shared:9')]
        self.open()
        self.folder('Shared shortcut').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
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
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)

    def test_deleted_personal_target_keeps_shortcut_unavailable(self):
        self.site.filters = [dict(self.site.shared[0], id=1, name='Personal CT')]
        self.site.shortcuts = [dict(id='s', name='Personal shortcut', searchId='own:1')]
        self.open()
        self.folder('Personal shortcut').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        self.site.filters[0]['name'] = 'Renamed CT'
        self.page.locator('#shortcuts-reload').click()
        expect(self.page.locator('#active-filter-name')).to_contain_text('Renamed CT')
        self.site.filters = []
        self.page.locator('#shortcuts-reload').click()
        expect(self.folder('Personal shortcut')).to_be_disabled()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
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
        self.page.locator('#worklist-folders-toggle').click()
        expect(self.folder('MG and XA')).to_have_text('MG and XA (—)')
        expect(self.folder('MG and XA')).to_have_attribute('aria-current', 'true')
        expect(self.page.locator('#filterrow [data-f=modality]')).to_have_value('MG,XA')
        held = self.site.held_lists
        self.site.held_lists = None
        for route, account in held:
            route.fulfill(json=self.site.list_body(account))
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        self.site.sign_in(auth.RAD)
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        self.page.locator('#worklist-folders-toggle').click()
        expect(self.folder('MG and XA')).to_have_text('MG and XA (2)')
        expect(self.folder('MG and XA')).to_have_attribute('aria-current', 'true')
        expect(self.page.locator('#filterrow [data-f=modality]')).to_have_value('MG,XA')
        for token in ['MG', 'XA']:
            expect(self.folder(token)).to_have_text(token+' (1)')
            expect(self.folder(token)).to_have_attribute('aria-pressed', 'false')

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

    def test_first_paint_equal_served_main_and_default_exact_match(self):
        # D01/WS3: compare doctor-visible results/layout from real served assets, not source strings.
        source_root = auth.ROOT
        facts = """() => {
          const grid = document.querySelector('.left .grid').getBoundingClientRect();
          return {rows:[...document.querySelectorAll('#rows tr[data-uid]')].map(r=>r.dataset.uid),
            chips:[...document.querySelectorAll('#chips button')].map(b=>b.textContent.trim()),
            quick:document.querySelector('#quick').value,
            days:[...document.querySelectorAll('#qf button.on')].map(b=>b.dataset.days),
            state:document.querySelector('#active-filter-state').textContent,
            hidden:document.querySelector('#active-filter-info').hidden,
            focus:document.activeElement.id || document.activeElement.tagName,
            grid:[grid.x,grid.width],
            columns:[...document.querySelectorAll('#heads th')].filter(c=>c.getBoundingClientRect().right<=grid.right).map(c=>c.textContent)};
        }"""
        with tempfile.TemporaryDirectory(prefix='kin-w2-main-') as temporary:
            raw = subprocess.check_output(['git', 'archive', '--format=zip', 'c8e4f1b485ec05ccbb97589c74a573b3f48b70ce',
                'worklist-v0/hpacs-lite', 'scripts/main-split-order.json', 'proxy/branding'], cwd=Path(__file__).resolve().parents[1])
            zipfile.ZipFile(io.BytesIO(raw)).extractall(temporary)
            try:
                for default in (False, 'CT', 'CT,SR'):
                    for width in (1280, 1500, 1920):
                        observed = []
                        for root in (Path(temporary), source_root):
                            auth.ROOT = root
                            site = FolderSite()
                            if default:
                                site.filters = [dict(id=1, name='Default CT', mode='Radiology', days=-1,
                                    quick='', cols={'modality':default}, isDefault=True)]
                            ctx = self.browser.new_context(viewport={'width':width,'height':1000})
                            try:
                                ctx.route('**/*', lambda route, request: site.handle(route, request))
                                page = ctx.new_page()
                                page.goto(auth.MAIN_URL)
                                expect(page.locator('#rows tr[data-uid]')).to_have_count(1 if default else 6)
                                page.evaluate('() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
                                observed.append(page.evaluate(facts))
                                if root == source_root:
                                    expect(page.locator('#worklist-folders-toggle')).to_have_attribute('aria-expanded','false')
                            finally:
                                ctx.close()
                        self.assertEqual(observed[0], observed[1], (default, width))
            finally:
                auth.ROOT = source_root

    def test_chip_deleted_modified_and_transient_library_failure_keep_rows(self):
        self.site.filters = [dict(id=1, name='Personal CT', mode='Radiology', days=-1, quick='', cols={'modality':'CT'})]
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(6)
        self.page.locator('#toolbar-filters > summary').click()
        self.page.locator('#chips').get_by_role('button', name=re.compile('^Personal CT')).click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        self.page.locator('#quick').fill('SYN')
        expect(self.page.locator('#active-filter-state')).to_have_text('Modified')
        self.page.locator('#edit-active-filter').click()
        self.page.locator('#sfm-delete').click()
        expect(self.page.locator('#sfm-status')).to_contain_text('삭제')
        self.page.locator('#sfm-close').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        expect(self.page.locator('#active-filter-state')).to_have_text('Deleted')
        expect(self.page.locator('#active-filter-info')).to_have_attribute('title','저장 검색이 삭제됐습니다. 현재 목록 조건은 유지됩니다.')
        self.page.locator('#worklist-folders-toggle').click()
        self.folder('Shared CT').click()
        self.site.fail_shared = 503
        self.page.locator('#shortcuts-reload').click()
        expect(self.page.locator('#shortcuts-status')).to_contain_text('불러오지 못했습니다')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        expect(self.folder('Shared CT')).to_be_enabled()
        self.assertNotEqual('Unavailable', self.page.locator('#active-filter-state').text_content())

    def test_legacy_scalar_save_and_new_multi_value_edit_relogin_keep_their_meaning(self):
        self.site.filters = [dict(id=1,name='Legacy combined',mode='Radiology',days=-1,quick='',
            cols={'modality':'CT,SR'},isDefault=True)]
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        self.page.locator('#toolbar-filters > summary').click()
        self.page.locator('#edit-active-filter').click()
        self.page.locator('#sfm-save-apply').click()
        expect(self.page.locator('#saved-filter-manager')).not_to_be_visible()
        self.assertEqual('CT,SR', self.site.filters[0]['cols']['modality'])
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        self.page.locator('#edit-active-filter').click()
        self.page.locator('#sfm-col-modality').fill('CT, MR')
        self.page.locator('#sfm-save-apply').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(3)
        expect(self.page.locator('#saved-filter-manager')).not_to_be_visible()
        self.assertEqual(['CT','MR'], self.site.filters[0]['cols']['modality'])
        self.site.sign_in(auth.RAD)
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(3)
        expect(self.page.locator('#active-filter-state')).to_have_text('Saved')

    def test_folder_replaces_saved_dates_and_complete_counts_agree(self):
        from datetime import datetime
        self.page.clock.set_fixed_time(datetime.fromisoformat('2026-10-11T10:00:00-07:00'))
        self.site.modalities = ['CT','MR','CT','MR']
        self.site.row_dates = ['2026-10-11','2026-10-11','2026-10-01','2026-10-01']
        self.site.filters = [dict(id=1,name='Since yesterday',mode='Radiology',days=-1,quick='',isDefault=True,
            cols={'$compound':{'version':1,'join':'and','rules':[{'field':'date','op':'withinLastDays','value':'1'}]}})]
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        self.page.locator('#worklist-folders-toggle').click()
        for name, count in [('CT',2),('All Studies',4),('Since yesterday',2)]:
            self.folder(name).click()
            expect(self.page.locator('#rows tr[data-uid]')).to_have_count(count)
            self.assertEqual(str(self.page.locator('#rows tr[data-uid]').count()), re.search(r'\((\d+)\)$',self.folder(name).inner_text()).group(1))

    def test_column_alignment_keeps_other_conditions_and_tree_not_redrawn_per_key(self):
        self.open()
        self.page.locator('#quick').fill('MR')
        self.page.locator('#filterrow [data-f=modality]').fill('CT, MR')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        expect(self.page.locator('#quick')).to_have_value('MR')
        self.page.evaluate("""() => {
          window.treeChanges = 0;
          new MutationObserver(r=>window.treeChanges += r.length).observe(document.querySelector('#worklist-folders'),{subtree:true,childList:true});
        }""")
        self.page.locator('#quick').fill('SYN MR')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        self.assertEqual(0,self.page.evaluate('window.treeChanges'))
        self.site.modalities=['MR','MR','CT,SR']
        self.page.locator('#refresh').click()
        expect(self.folder('MR')).to_have_text('MR (2)')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)

    def test_conflict_blocks_another_edit_after_busy_ends_and_status_announces_only_changes(self):
        self.open()
        self.site.collection_revision += 1
        nav=self.page.get_by_role('navigation',name='Folders')
        nav.get_by_label('Shortcut Name',exact=True).fill('One')
        nav.get_by_role('button',name='Add Shortcut',exact=True).click()
        expect(self.page.locator('#shortcuts-status')).to_contain_text('저장 결과를 확인하지 못했습니다')
        # A second add actually enters the write path after the failed request ended.
        nav.locator('form').get_by_label('Shortcut Name',exact=True).fill('Two')
        nav.get_by_role('button',name='Add Shortcut',exact=True).click()
        expect(self.page.locator('#shortcuts-status')).to_contain_text('버전을 확인해야')
        self.assertEqual(1,len(self.site.shortcut_writes))
        self.page.evaluate("""() => {
          window.statusChanges = 0;
          new MutationObserver(r=>window.statusChanges += r.length).observe(document.querySelector('#shortcuts-status'),{subtree:true,childList:true,characterData:true});
          const preparation = KinWorkContext.prepare({}); KinWorkContext.cancelPreparation(preparation);
        }""")
        self.assertEqual(0,self.page.evaluate('window.statusChanges'))

    def test_held_session_end_discards_tree_and_account_search_data(self):
        # The retained document is required for Recover Draft; navigation cannot hide stale account data.
        self.site.shortcuts=[dict(id='s',name='Private shortcut',searchId='shared:9')]
        self.site.modalities=['CT']
        list_body = self.site.list_body
        def one_study(account, rename=None):
            body = list_body(account, rename)
            body['studies'][0]['uid'] = auth.UID
            return body
        self.site.list_body = one_study
        # Capture the public mounted module, not page-private globals. A retained
        # document must not be able to use the old account's destroyed module.
        self.context.route('**/worklist-folder-tree.js', lambda route: route.fulfill(
            content_type='application/javascript', body=(auth.ROOT / 'worklist-v0/hpacs-lite/worklist-folder-tree.js').read_text(encoding='utf-8') + """
          { const mount = KinWorklistFolderTree.mount;
            KinWorklistFolderTree.mount = options => {
              const api = mount(options); window.folderLifecycle = api; return api;
            };
          }
        """))
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        self.page.locator('#rows tr[data-uid]').click()
        expect(self.page.locator('#findings')).to_be_editable()
        self.page.locator('#findings').fill('SYN unsaved recovery text')
        self.page.locator('#worklist-folders-toggle').click()
        expect(self.folder('Private shortcut')).to_be_visible()
        old_button = self.folder('Private shortcut').element_handle()
        self.site.ended.add(self.site.cookie)
        self.page.locator('#refresh').click()
        expect(self.page.locator('dialog.kin-logout h2')).to_have_text('Session Ended')
        expect(self.page).to_have_url(auth.MAIN_URL)
        expect(self.page.locator('#worklist-folders nav')).to_have_count(0)
        # Public module lifecycle: the old owner cannot operate its detached tree.
        self.assertTrue(self.page.evaluate("() => {try {window.folderLifecycle.select('all');return false;} catch(e){return true;}}"))
        self.assertTrue(self.page.evaluate("() => {try {window.folderLifecycle.update({});return false;} catch(e){return true;}}"))
        self.assertTrue(self.page.evaluate("() => {try {window.folderLifecycle.snapshot();return false;} catch(e){return true;}}"))
        old_button.evaluate('button => button.click()')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(0)
        self.assertNotIn('Private shortcut',self.page.locator('body').text_content())
        self.assertNotIn('Shared CT',self.page.locator('body').text_content())
        self.site.shortcuts = []
        self.site.shared = []
        self.site.filters = []
        self.site.ended.clear()
        self.site.account = auth.RAD_OTHER
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        self.page.locator('#worklist-folders-toggle').click()
        self.assertNotIn('Private shortcut', self.page.locator('body').text_content())
        self.assertNotIn('Shared CT', self.page.locator('body').text_content())

    def test_manager_read_write_failure_clears_progress_status(self):
        self.open()
        self.page.locator('#toolbar-filters > summary').click()
        self.page.locator('#managefilters').click()
        self.page.locator('#sfm-organize > summary').click()
        self.site.fail_read=True
        self.page.locator('#sfm-load-folders').click()
        expect(self.page.locator('#shortcuts-status')).to_contain_text('읽지 못했습니다')
        self.site.fail_read=False
        self.page.locator('#sfm-load-folders').click()
        expect(self.page.locator('#sfm-status')).to_contain_text('불러왔습니다')
        self.site.fail_write=True
        self.page.locator('#sfm-folder-path').fill('SYN Folder')
        self.page.locator('#sfm-folder-save').click()
        expect(self.page.locator('#shortcuts-status')).to_contain_text('저장하지 못했습니다')
        expect(self.page.locator('#sfm-status')).to_contain_text('SYN conflict')

    def test_stored_scalar_tree_alignment_uses_exact_search_count(self):
        self.site.filters = [dict(id=1, name='Default CT', mode='Radiology', days=-1, quick='',
                                 cols={'modality': 'CT'}, isDefault=True)]
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        self.page.locator('#worklist-folders-toggle').click()
        expect(self.folder('CT')).to_have_attribute('aria-pressed', 'false')
        expect(self.folder('Default CT')).to_have_attribute('aria-current', 'true')
        expect(self.folder('Default CT')).to_have_text('Default CT (1)')
        self.assertEqual(self.page.locator('#rows tr[data-uid]').count(),
                         int(re.search(r'\((\d+)\)$', self.folder('Default CT').inner_text())[1]))
        self.folder('CT').click()
        expect(self.folder('CT')).to_have_text('CT (2)')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        self.page.locator('#quick').fill('SYN CT,SR')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        expect(self.folder('CT')).to_have_attribute('aria-pressed', 'false')

    def test_folder_replaces_favorite_tag_and_consultation_predicates(self):
        owner = [auth.INSTITUTION, self.site.account['sub']]
        link = dict(id='one', name='Synthetic', uids=[auth.UID + '.0'])
        self.site.gets['/api/favorite-folders'] = (200, dict(owner=owner, revision=1, folders=[link]))
        self.site.gets['/api/study-tags'] = (200, dict(owner=owner, catalogs=[
            dict(scope='personal', revision=1, tags=[link]), dict(scope='institution', revision=1, tags=[])]))
        self.site.gets['/api/consultations'] = (200, dict(owner=owner, direction='received', nextCursor=None,
            items=[dict(id='request', studyUid=auth.UID+'.0', state='Requested', revision=1,
                        institutionId=auth.INSTITUTION, requesterActor='SYN requester')]))
        self.open()
        self.page.locator('#toolbar-filters > summary').click()
        for folder in ['All Studies', 'CT', 'Shared CT']:
            for opener, apply, footer in [('#favorite-open', '#favorite-apply', '즐겨찾기'),
                                          ('#study-tag-open', '#study-tag-apply', '태그'),
                                          ('#consultations-open', '#co-filter', 'Consultations')]:
                with self.subTest(folder=folder, footer=footer):
                    section = '#toolbar-more' if opener == '#consultations-open' else '#toolbar-filters'
                    if not self.page.locator(section).evaluate('e=>e.open'):
                        self.page.locator(section + ' > summary').click()
                    self.page.locator(opener).click()
                    if opener == '#consultations-open':
                        expect(self.page.locator('#co-count')).to_contain_text('1 shown')
                    self.page.locator(apply).click()
                    expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
                    expect(self.page.locator('.statusbar').first).to_contain_text(footer)
                    self.folder(folder).click()
                    expected = {'All Studies': 6, 'CT': 2, 'Shared CT': 1}[folder]
                    expect(self.page.locator('#rows tr[data-uid]')).to_have_count(expected)
                    expect(self.folder(folder)).to_have_text(f'{folder} ({expected})')
                    expect(self.page.locator('.statusbar').first).not_to_contain_text(footer)
                    expect(self.page.locator('#favorite-clear')).to_be_hidden()
                    expect(self.page.locator('#study-tag-clear')).to_be_hidden()

    def test_duplicate_and_invalid_multi_value_column_input_is_atomic(self):
        self.open()
        field = self.page.locator('#filterrow [data-f=modality]')
        field.fill('ct, CT, mr, MR')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(3)
        expect(self.folder('CT')).to_have_attribute('aria-pressed', 'true')
        expect(self.folder('MR')).to_have_attribute('aria-pressed', 'true')
        before = self.page.locator('#rows tr[data-uid]').evaluate_all('rows=>rows.map(r=>r.dataset.uid)')
        for bad in ['CT,', 'CT,,MR', 'CT, UNKNOWN']:
            field.fill(bad)
            self.assertIn('사용할 수 없는 Modality', field.evaluate('e=>e.validationMessage'))
            self.assertEqual(before, self.page.locator('#rows tr[data-uid]').evaluate_all('rows=>rows.map(r=>r.dataset.uid)'))
        field.fill('CT\\ct')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        expect(self.folder('CT')).to_have_text('CT (2)')

    def test_duplicate_multi_value_editor_save_reapply_and_invalid_draft(self):
        self.open()
        self.page.locator('#toolbar-filters > summary').click()
        self.page.locator('#managefilters').click()
        self.page.locator('#sfm-name').fill('Stable modalities')
        field = self.page.locator('#sfm-col-modality')
        for bad in ['CT,', 'CT,,MR', 'CT, UNKNOWN']:
            field.fill(bad)
            expect(self.page.locator('#sfm-count')).to_contain_text('사용할 수 없는 Modality')
            self.page.locator('#sfm-preview').click()
            expect(self.page.locator('#saved-filter-manager')).to_be_visible()
            expect(self.page.locator('#rows tr[data-uid]')).to_have_count(6)
            self.page.locator('#sfm-save').click()
            self.assertEqual([], self.site.filters)
        field.fill('ct, CT, mr, MR')
        self.page.locator('#sfm-save-apply').click()
        expect(self.page.locator('#saved-filter-manager')).not_to_be_visible()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(3)
        self.assertEqual(['CT', 'MR'], self.site.filters[0]['cols']['modality'])
        self.folder('All Studies').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(6)
        self.folder('Stable modalities').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(3)
        expect(self.folder('Stable modalities')).to_have_text('Stable modalities (3)')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(verbosity=2)
