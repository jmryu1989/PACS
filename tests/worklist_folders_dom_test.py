# coding: utf-8
"""REQ-WS3/WS7 -> RISK-WS3/WS7 -> WS3-SHORTCUTS / WS3-COUNTS / WS3-RELATIVE-DATE.
D1041 replaces W2R-05/W2R-02: login-open Folders and saved Modality token OR.
REQ-WS3/WS7 -> RISK-WS3/WS7 -> WS3-LOGIN-OPEN / WS3-SAVED-MODALITY.
W2-FU (W2R4-01/02/04/05/06): Does Not Equal complements Equals with its Korean help shown,
footer counts stay whole with Folders open, and the per-login/per-tab close is driven only by
doctor actions (header or toolbar, reload, second tab, logout/login), never by storage keys.
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
        self.dialogs = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.on('dialog', lambda d: (self.dialogs.append(d.message), d.accept()))

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors)
        self.assertEqual([], self.site.violations)

    def open(self):
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(len(self.site.modalities))
        expect(self.page.locator('#worklist-folders-panel')).to_have_attribute('open', '')
        expect(self.page.get_by_role('button', name='All Studies (6)', exact=True)).to_be_visible()

    def folder(self, text):
        return self.page.get_by_role('navigation', name='Folders').get_by_role('button', name=re.compile('^'+re.escape(text)+r' \('))

    def close_menus(self):
        for menu in self.page.locator('.menubar > .toolbar-menu[open]').all():
            menu.locator(':scope > summary').click()

    def menu(self, name):
        menu = self.page.locator('#toolbar-' + name)
        if menu.get_attribute('open') is None:
            menu.locator(':scope > summary').click()

    def reload_shortcuts(self):
        popup = self.page.locator('#exam-filter-popup')
        if not popup.count() or not popup.is_visible():
            self.page.get_by_role('button', name='My Shortcuts', exact=True).click()
        else:
            popup.get_by_role('button', name='Close', exact=True).click()
            self.page.get_by_role('button', name='My Shortcuts', exact=True).click()
        popup.get_by_role('button', name='Close', exact=True).click()

    def save_shortcut(self, name):
        popup = self.page.locator('#exam-filter-popup')
        if not popup.count() or not popup.is_visible():
            self.page.get_by_role('button', name='My Shortcuts', exact=True).click()
        popup.get_by_label('Shortcut Name', exact=True).fill(name)
        popup.get_by_role('button', name='Save as Shortcut', exact=True).click()

    def test_first_paint_tokens_or_and_empty_and_vanished(self):
        self.open()
        # W2R4-05 (D73 §16): a close left by an earlier login is exercised below through
        # the doctor's own close/logout/login path, not by writing the product's storage key.
        expect(self.folder('All Studies')).to_have_attribute('aria-current', 'true')
        expect(self.page.locator('#quick')).to_have_value('')
        expect(self.folder('MG')).to_be_visible()
        expect(self.folder('XA')).to_be_visible()
        self.folder('CT').click()
        self.folder('MR').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(3)
        if not self.page.locator('#quick').is_visible():
            self.menu('filters')
        self.page.locator('#quick').fill('MR')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        if not self.page.locator('#quick').is_visible():
            self.menu('filters')
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
        if not self.page.locator('#quick').is_visible():
            self.menu('filters')
        self.page.locator('#quick').fill('CT')
        if not self.page.locator('#quick').is_visible():
            self.menu('filters')
        self.page.locator('#quick').fill('')
        self.assertEqual(0, self.page.evaluate('window.selectionAnnouncements'))
        with self.page.expect_response(lambda r: '/api/studies' in r.url and r.request.method == 'GET') as response:
            self.page.locator('#m-refresh').click()
        response.value.finished()
        expect(self.folder('CT')).to_have_text('CT (2)')
        self.page.evaluate('() => new Promise(r => requestAnimationFrame(r))')
        self.assertEqual(0, self.page.evaluate('window.selectionAnnouncements'))
        self.folder('MG').click()
        self.site.modalities = ['CT']
        self.page.locator('#m-refresh').click()
        expect(self.folder('MG')).to_have_text('MG (0)')
        expect(self.folder('MG')).to_have_attribute('aria-pressed', 'true')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(0)

        self.folder('All Studies').click()
        for account in (auth.RAD, auth.RAD_OTHER, auth.RAD):
            self.page.locator('#worklist-folders-panel > summary').click()
            expect(self.page.locator('#worklist-folders-panel')).not_to_have_attribute('open', '')
            with self.page.expect_response(lambda r: '/api/studies' in r.url and r.request.method == 'GET') as response:
                self.page.locator('#m-refresh').click()
            response.value.finished()
            expect(self.page.locator('#worklist-folders-panel')).not_to_have_attribute('open', '')
            self.page.reload()
            expect(self.page.locator('#rows tr[data-uid]')).to_have_count(len(self.site.modalities))
            expect(self.page.locator('#worklist-folders-panel')).not_to_have_attribute('open', '')
            self.page.locator('#logout').click()
            expect(self.page).to_have_url(re.compile('index.html'))
            self.site.login_as = account
            self.page.get_by_role('button', name=auth.SIGN_IN).click()
            expect(self.page).to_have_url(auth.MAIN_URL)
            expect(self.page.locator('#rows tr[data-uid]')).to_have_count(len(self.site.modalities))
            expect(self.page.locator('#worklist-folders-panel')).to_have_attribute('open', '')
            expect(self.page.get_by_role('navigation', name='Folders')).to_be_visible()
            self.assertEqual(account['sub'], self.site.account['sub'])
            expect(self.page.locator('dialog[open]')).to_have_count(0)
        self.assertEqual(3, self.site.logins)
        self.assertEqual([], self.dialogs, 'D1041 adds no prompt to the normal login/search path')

    def folders_state(self, page=None):
        page = page or self.page
        toggle = page.locator('#worklist-folders-panel > summary')
        expanded = 'true' if page.locator('#worklist-folders-panel').get_attribute('open') is not None else 'false'
        visible = page.get_by_role('navigation', name='Folders').is_visible()
        self.assertEqual(expanded == 'true', visible, 'toolbar state and panel visibility agree')
        return expanded

    def test_panel_header_close_is_kept_for_the_login_like_the_toolbar(self):
        # W2R4-06 (mutant O9): closing through the panel's own "Folders" header is the
        # same doctor action as the toolbar button and lasts for that login in the tab.
        self.open()
        toggle = self.page.locator('#worklist-folders-panel > summary')
        header = toggle
        expect(header).to_have_text('Folders')
        header.click()
        expect(self.page.locator('#worklist-folders-panel')).not_to_have_attribute('open', '')
        for _ in range(2):
            self.page.reload()
            expect(self.page.locator('#rows tr[data-uid]')).to_have_count(6)
            expect(self.page.locator('#worklist-folders-panel')).not_to_have_attribute('open', '')
            self.assertEqual('false', self.folders_state())
        toggle.click()
        expect(self.page.locator('#worklist-folders-panel')).to_have_attribute('open', '')
        header.click()
        expect(self.page.locator('#worklist-folders-panel')).not_to_have_attribute('open', '')
        self.page.locator('#logout').click()
        expect(self.page).to_have_url(re.compile('index.html'))
        self.site.login_as = auth.RAD
        self.page.get_by_role('button', name=auth.SIGN_IN).click()
        expect(self.page).to_have_url(auth.MAIN_URL)
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(6)
        expect(self.page.locator('#worklist-folders-panel')).to_have_attribute('open', '')
        self.assertEqual('true', self.folders_state())
        self.assertEqual([], self.dialogs)

    def test_closed_for_this_login_is_per_tab_not_whole_browser(self):
        # W2R4-06 (mutant O11): README promises "closing it lasts for that login in the tab".
        # A second tab of the same login starts open; each tab keeps its own choice.
        self.open()
        self.page.locator('#worklist-folders-panel > summary').click()
        expect(self.page.locator('#worklist-folders-panel')).not_to_have_attribute('open', '')
        second = self.context.new_page()
        second.on('pageerror', lambda e: self.errors.append(str(e)))
        second.goto(auth.MAIN_URL)
        expect(second.locator('#rows tr[data-uid]')).to_have_count(6)
        expect(second.locator('#worklist-folders-panel')).to_have_attribute('open', '')
        self.assertEqual('true', self.folders_state(second))
        self.page.reload()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(6)
        expect(self.page.locator('#worklist-folders-panel')).not_to_have_attribute('open', '')
        second.reload()
        expect(second.locator('#rows tr[data-uid]')).to_have_count(6)
        expect(second.locator('#worklist-folders-panel')).to_have_attribute('open', '')
        second.close()

    def test_storage_unavailable_still_opens_and_closes_for_the_page(self):
        # When the tab's session storage throws (blocked by browser policy), the doctor still
        # gets the panel open on load and a working close, without page errors; this binds to
        # no storage key name. (With every site storage blocked the page returns to sign-in
        # before W2 code runs: the existing sign-in layer, outside this unit.)
        self.context.add_init_script('''(() => {
          for (const name of ['getItem', 'setItem']) {
            const original = Storage.prototype[name];
            Storage.prototype[name] = function (...args) {
              if (this === window.sessionStorage) throw new DOMException('blocked', 'SecurityError');
              return original.apply(this, args);
            };
          }
        })()''')
        self.open()
        self.page.locator('#worklist-folders-panel > summary').click()
        expect(self.page.locator('#worklist-folders-panel')).not_to_have_attribute('open', '')
        self.assertEqual('false', self.folders_state())
        self.page.reload()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(6)
        expect(self.page.locator('#worklist-folders-panel')).to_have_attribute('open', '')

    def test_footer_counts_stay_whole_with_folders_open(self):
        # W2R4-04: D1041 makes the open panel every login's first screen. Each status count
        # ("W:6", "Unverified:0") wraps only between items, never mid-word, and nothing clips.
        facts = """() => {
          const bar = document.querySelector('#countlist').closest('.statusbar');
          const box = bar.getBoundingClientRect();
          const items = [...document.querySelectorAll('#countlist .count')].map(item => {
            const lines = new Set();
            const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if (!node.textContent.trim()) continue;
              const range = document.createRange(); range.selectNodeContents(node);
              for (const rect of range.getClientRects()) if (rect.width > 0) lines.add(Math.round(rect.top));
            }
            const r = item.getBoundingClientRect();
            return {text: item.textContent, lines: lines.size, inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5};
          });
          return {items, barOverflow: bar.scrollWidth - bar.clientWidth, panel: String(document.querySelector('#worklist-folders-panel').open)};
        }"""
        for width in (1280, 1500, 1920):
            with self.subTest(width=width):
                self.page.set_viewport_size({'width': width, 'height': 1000})
                self.open()
                self.page.evaluate('() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
                observed = self.page.evaluate(facts)
                print('W2R4-04 footer', width, json.dumps(observed, ensure_ascii=False))
                self.assertEqual('true', observed['panel'])
                texts = [i['text'] for i in observed['items']]
                self.assertGreaterEqual(len(texts), 6, texts)
                for text in texts:
                    self.assertRegex(text, r'^[A-Za-z ]+: ?\d+$')
                self.assertTrue(texts[0].startswith('Unread:') and texts[-1].startswith('Unverified:'), texts)
                for item in observed['items']:
                    self.assertEqual(1, item['lines'], (width, item))
                    self.assertTrue(item['inside'], (width, item))
                self.assertLessEqual(observed['barOverflow'], 0, width)

    def test_compound_modality_does_not_equal_complements_equals_in_editor(self):
        # W2R4-01: D1041 7-② ("CT,SR is a CT study") makes Does Not Equal the token
        # complement of Equals; switching operators keeps the same Modality list input.
        # W2R4-02: the Korean explanation is visible on that input for both operators.
        self.open()
        self.menu('filters')
        self.page.locator('#managefilters').click()
        self.page.locator('#sfm-name').fill('Not CT')
        self.page.locator('#sfm-add-rule').click()
        row = self.page.locator('#sfm-rules .sfm-rule')
        row.locator('[data-rule-field]').select_option('modality')
        row.locator('[data-rule-op]').select_option('eq')
        value = row.locator('[data-rule-value]')
        value.fill('ct, mr')
        expect(value).to_have_attribute('title', re.compile(r'[가-힣].*CT,SR'))
        equals_title = value.get_attribute('title')
        expect(self.page.locator('#sfm-count')).to_contain_text('목록 기준 3건')
        row.locator('[data-rule-op]').select_option('neq')
        expect(value).to_have_value('ct, mr')
        expect(value).to_have_attribute('title', re.compile(r'[가-힣].*CT,SR'))
        self.assertNotEqual(equals_title, value.get_attribute('title'))
        expect(self.page.locator('#sfm-count')).to_contain_text('목록 기준 3건')
        expect(self.page.locator('#sfm-count')).not_to_contain_text('오류')
        value.fill('CT')
        expect(self.page.locator('#sfm-count')).to_contain_text('목록 기준 4건')
        self.page.locator('#sfm-save-apply').click()
        expect(self.page.locator('#saved-filter-manager')).not_to_be_visible()
        self.close_menus()
        # Rows are MR, MG, XA and CTA; both CT and CT,SR are excluded.
        expected = [auth.UID + '.' + str(i) for i, mod in enumerate(self.site.modalities) if mod in ('MR', 'MG', 'XA', 'CTA')]
        self.assertEqual(sorted(expected), sorted(self.page.locator('#rows tr[data-uid]').evaluate_all(
            'rows => rows.map(r => r.dataset.uid)')))
        self.assertEqual({'version': 1, 'join': 'and', 'rules': [{'field': 'modality', 'op': 'neq', 'value': 'CT'}]},
                         self.site.filters[0]['cols']['$compound'])
        expect(self.folder('Not CT')).to_have_text('Not CT (4)')
        # A saved rule reopens with the same input and its explanation.
        self.menu('filters')
        self.page.locator('#edit-active-filter').click()
        value = self.page.locator('#sfm-rules [data-rule-value]')
        expect(value).to_have_value('CT')
        expect(value).to_have_attribute('title', re.compile(r'[가-힣].*CT,SR'))
        # Equals CT AND Does Not Equal CT can no longer share a study.
        self.page.locator('#sfm-add-rule').click()
        second = self.page.locator('#sfm-rules .sfm-rule').nth(1)
        second.locator('[data-rule-field]').select_option('modality')
        second.locator('[data-rule-op]').select_option('eq')
        second.locator('[data-rule-value]').fill('CT')
        expect(self.page.locator('#sfm-count')).to_contain_text('목록 기준 0건')
        self.page.locator('#sfm-join').select_option('or')
        expect(self.page.locator('#sfm-count')).to_contain_text('목록 기준 6건')
        self.assertEqual([], self.dialogs)

    def test_search_draft_ime_apply_save_shortcut_and_relogin(self):
        self.open()
        self.folder('CT').click()
        self.folder('MR').click()
        self.menu('filters')
        self.page.locator('[data-search-mode]').select_option('manual')
        if not self.page.locator('#quick').is_visible():
            self.menu('filters')
        self.page.locator('#quick').fill('MR')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(3)
        self.page.locator('#quick').dispatch_event('keydown', {'key': 'Enter', 'isComposing': True})
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(3)
        self.page.locator('#quick').dispatch_event('keydown', {'key': 'Enter', 'keyCode': 229})
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(3)
        self.page.locator('#quick').press('Enter')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        self.menu('filters')
        self.page.locator('#savefilter').click()
        self.page.locator('#sfm-name').fill('My MR')
        self.page.locator('#sfm-save-apply').click()
        expect(self.page.locator('#saved-filter-manager')).not_to_be_visible()
        self.close_menus()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        nav = self.page.get_by_role('navigation', name='Folders')
        self.save_shortcut('Morning')
        expect(self.page.locator('#shortcuts-status')).to_contain_text('저장했습니다')
        self.page.locator('#exam-filter-popup').get_by_role('button', name='Close', exact=True).click()
        self.folder('All Studies').click()
        self.page.get_by_role('list', name='My Shortcuts', exact=True).get_by_role('button', name=re.compile(r'^Morning \(')).click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        self.site.sign_in(auth.RAD)
        self.page.goto(auth.MAIN_URL)
        # The saved search also appears in Saved Searches; verify the user's shortcut in its own group.
        shortcut = self.page.get_by_role('list', name='My Shortcuts', exact=True).get_by_role('button', name=re.compile(r'^Morning \('))
        expect(shortcut).to_have_count(1)
        expect(shortcut).to_be_visible()
        shortcut.click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        saved = next(f for f in self.site.filters if f['name'] == 'Morning')
        self.assertEqual('own:' + str(saved['id']), self.site.shortcuts[0]['searchId'])

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
        self.page.locator('#m-refresh').click()
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
        self.reload_shortcuts()
        expect(self.folder('Shared shortcut')).to_contain_text('Unavailable')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        expect(self.folder('All Studies')).not_to_have_attribute('aria-current', 'true')
        self.site.fail_shared = True
        self.reload_shortcuts()
        expect(self.folder('Shared shortcut')).to_be_disabled()
        self.assertEqual('shared:9', self.site.shortcuts[0]['searchId'])

    def test_old_shared_answer_cannot_restore_a_revoked_target(self):
        self.site.shortcuts = [dict(id='s', name='Shared shortcut', searchId='shared:9')]
        self.open()
        self.folder('Shared shortcut').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        self.site.held_shared = []
        self.reload_shortcuts()
        for _ in range(100):
            if self.site.held_shared:
                break
            self.page.wait_for_timeout(20)
        self.assertEqual(1, len(self.site.held_shared))
        held = self.site.held_shared
        self.site.held_shared = None
        self.site.shared = []
        self.reload_shortcuts()
        expect(self.folder('Shared shortcut')).to_be_disabled()
        for route, snapshot in held:
            with self.page.expect_response(lambda r: r.url.endswith('/api/shared-filters')) as response:
                route.fulfill(json=snapshot)
            response.value.finished()
        self.page.evaluate('() => new Promise(resolve => requestAnimationFrame(resolve))')
        expect(self.folder('Shared shortcut')).to_be_disabled()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)

    def test_deleted_personal_target_keeps_shortcut_unavailable(self):
        self.site.filters = [dict(self.site.shared[0], id=1, name='Personal CT')]
        self.site.shortcuts = [dict(id='s', name='Personal shortcut', searchId='own:1')]
        self.open()
        self.folder('Personal shortcut').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        self.site.filters[0]['name'] = 'Renamed CT'
        self.reload_shortcuts()
        expect(self.page.locator('#active-filter-name')).to_contain_text('Renamed CT')
        self.site.filters = []
        self.reload_shortcuts()
        expect(self.folder('Personal shortcut')).to_be_disabled()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        self.assertEqual('own:1', self.site.shortcuts[0]['searchId'])

    def test_preparation_cancel_keeps_unknown_write_blocked_until_reload(self):
        self.open()
        self.site.held_shortcuts = []
        with self.page.expect_request(lambda request: request.url.endswith('/api/filter-folders') and request.method == 'POST'):
            self.save_shortcut('Interrupted')
        expect(self.page.locator('#shortcuts-status')).to_contain_text('저장 중')
        self.assertEqual(1, len(self.site.held_shortcuts))
        self.page.evaluate('''() => {
          const preparation = KinWorkContext.prepare({});
          KinWorkContext.cancelPreparation(preparation);
        }''')
        held = self.site.held_shortcuts
        self.site.held_shortcuts = None
        for route, snapshot in held:
            route.fulfill(status=201, json=snapshot)
        expect(self.page.locator('#exam-filter-popup [role=status]')).to_contain_text('저장 결과를 확인해야 합니다')
        expect(self.page.locator('#exam-filter-popup [role=status]')).not_to_contain_text('저장했습니다')
        self.assertEqual(1, len(self.site.shortcut_writes))
        self.save_shortcut('Interrupted')
        expect(self.page.locator('#exam-filter-popup [role=status]')).to_contain_text('저장했습니다')
        self.assertEqual(2, len(self.site.shortcut_writes))
        self.assertEqual(1, len(self.site.shortcuts))


    def test_shortcut_conflict_retains_draft_and_read_failure_blocks_writes(self):
        self.open()
        self.site.fail_write = True
        self.save_shortcut('Draft shortcut')
        popup = self.page.locator('#exam-filter-popup')
        expect(popup.locator('[role=status]')).to_contain_text('저장하지 못했습니다')
        expect(popup.get_by_label('Shortcut Name', exact=True)).to_have_value('Draft shortcut')
        self.assertEqual([], self.site.shortcuts)
        self.site.fail_read = True
        self.site.fail_write = False
        popup.get_by_role('button', name='Save as Shortcut', exact=True).click()
        expect(popup.locator('[role=status]')).to_contain_text('저장하지 못했습니다')
        self.assertEqual(1, len(self.site.shortcut_writes))
        self.site.fail_read = False
        popup.get_by_role('button', name='Save as Shortcut', exact=True).click()
        expect(popup.locator('[role=status]')).to_contain_text('저장했습니다')
        self.assertEqual('Draft shortcut', self.site.shortcuts[0]['name'])
        self.assertEqual(2, len(self.site.shortcut_writes))


    def test_late_collection_answer_after_logout_does_not_recreate_tree(self):
        self.open()
        self.site.held_gets['/api/filter-folders'] = []
        self.reload_shortcuts()
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
                self.page.locator('#m-refresh').click()
                expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
                expect(self.page.locator('#rows')).to_contain_text('SYN MG')

    def test_first_paint_served_main_and_d1041_decided_state(self):
        # The studio changes default geometry/columns; existing saved search criteria still win.
        for value in ('CT', 'CT,SR'):
            with self.subTest(saved=value):
                self.site.filters = [dict(id=1, name='Default CT', mode='Radiology', days=-1,
                    quick='', cols={'modality':value}, isDefault=True)]
                self.page.goto(auth.MAIN_URL)
                expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
                expect(self.page.locator('#worklist-folders-panel')).to_have_attribute('open', '')
                expect(self.page.locator('#filterrow [data-f=modality]')).to_have_value(value)
                self.assertEqual([auth.UID+'.0', auth.UID+'.4'],
                    self.page.locator('#rows tr[data-uid]').evaluate_all('rows => rows.map(row => row.dataset.uid)'))


    def test_chip_deleted_modified_and_transient_library_failure_keep_rows(self):
        self.site.filters = [dict(id=1, name='Personal CT', mode='Radiology', days=-1, quick='', cols={'modality':'CT'})]
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(6)
        self.menu('filters')
        self.page.locator('#chips').get_by_role('button', name=re.compile('^Personal CT')).click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        if not self.page.locator('#quick').is_visible():
            self.menu('filters')
        self.page.locator('#quick').fill('SYN')
        expect(self.page.locator('#active-filter-state')).to_have_text('Modified')
        self.menu('filters')
        self.page.locator('#edit-active-filter').click()
        self.page.locator('#sfm-delete').click()
        expect(self.page.locator('#sfm-status')).to_contain_text('삭제')
        self.page.locator('#sfm-close').click()
        # Closing returns focus in the dialog's close event, after the click. Edit Search is disabled for a deleted
        # search, so it lands on Clear; typing before it lands would send fill()'s keystroke to Clear instead.
        expect(self.page.locator('#filterrow .col-clear')).to_be_focused()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        expect(self.page.locator('#active-filter-state')).to_have_text('Deleted')
        if not self.page.locator('#quick').is_visible():
            self.menu('filters')
        self.page.locator('#quick').fill('')
        expect(self.folder('CT')).to_have_attribute('aria-pressed', 'true')
        expect(self.page.locator('#active-filter-info')).to_have_attribute('title','저장 검색이 삭제됐습니다. 현재 목록 조건은 유지됩니다.')
        self.folder('Shared CT').click()
        self.site.fail_shared = 503
        self.reload_shortcuts()
        expect(self.page.locator('#shortcuts-status')).to_contain_text('불러오지 못했습니다')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        expect(self.folder('Shared CT')).to_be_enabled()
        self.assertNotEqual('Unavailable', self.page.locator('#active-filter-state').text_content())

    def test_legacy_scalar_save_and_new_multi_value_edit_relogin_keep_their_meaning(self):
        self.site.filters = [dict(id=1,name='Legacy combined',mode='Radiology',days=-1,quick='',
            cols={'modality':'CT,SR'},isDefault=True)]
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        self.menu('filters')
        self.page.locator('#edit-active-filter').click()
        self.page.locator('#sfm-save-apply').click()
        expect(self.page.locator('#saved-filter-manager')).not_to_be_visible()
        self.close_menus()
        self.assertEqual('CT,SR', self.site.filters[0]['cols']['modality'])
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        self.menu('filters')
        self.page.locator('#edit-active-filter').click()
        self.page.locator('#sfm-col-modality').fill('CT, MR')
        self.page.locator('#sfm-save-apply').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(3)
        expect(self.page.locator('#saved-filter-manager')).not_to_be_visible()
        self.close_menus()
        self.assertEqual(['CT','MR'], self.site.filters[0]['cols']['modality'])
        self.site.sign_in(auth.RAD)
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(3)
        expect(self.page.locator('#active-filter-state')).to_have_text('Saved')

        for wanted, expected in [('CT', 2), ('ct', 2), ('CT, MR', 3)]:
            for compound in (False, True):
                cols = {'$compound': {'version':1,'join':'and','rules':[
                    {'field':'modality','op':'eq','value':wanted}]}} if compound else {'modality':wanted}
                self.site.filters = [dict(id=1,name='Stored tokens',mode='Radiology',days=-1,
                    quick='',cols=cols,isDefault=True)]
                self.page.goto(auth.MAIN_URL)
                expect(self.page.locator('#rows tr[data-uid]')).to_have_count(expected)
                expect(self.folder('Stored tokens')).to_have_text(f'Stored tokens ({expected})')
                self.menu('filters')
                self.page.locator('#edit-active-filter').click()
                self.page.locator('#sfm-save-apply').click()
                expect(self.page.locator('#saved-filter-manager')).not_to_be_visible()
                self.close_menus()
                self.assertEqual(cols, {key:value for key,value in self.site.filters[0]['cols'].items() if value != ''})
                expect(self.page.locator('#rows tr[data-uid]')).to_have_count(expected)
        self.menu('filters')
        self.page.locator('#edit-active-filter').click()
        self.page.locator('#sfm-rules [data-rule-value]').fill('ct, mr')
        self.page.locator('#sfm-save-apply').click()
        expect(self.page.locator('#saved-filter-manager')).not_to_be_visible()
        self.close_menus()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(3)

    def test_folder_replaces_saved_dates_and_complete_counts_agree(self):
        from datetime import datetime
        self.page.clock.set_fixed_time(datetime.fromisoformat('2026-10-11T10:00:00-07:00'))
        self.site.modalities = ['CT','MR','CT','MR']
        self.site.row_dates = ['2026-10-11','2026-10-11','2026-10-01','2026-10-01']
        self.site.filters = [dict(id=1,name='Since yesterday',mode='Radiology',days=-1,quick='',isDefault=True,
            cols={'$compound':{'version':1,'join':'and','rules':[{'field':'date','op':'withinLastDays','value':'1'}]}})]
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        for name, count in [('CT',2),('All Studies',4),('Since yesterday',2)]:
            if not self.page.locator('#quick').is_visible():
                self.menu('filters')
            self.page.locator('#quick').fill('SYN MR')
            self.folder(name).click()
            expect(self.page.locator('#quick')).to_have_value('')
            expect(self.page.locator('#rows tr[data-uid]')).to_have_count(count)
            self.assertEqual(str(self.page.locator('#rows tr[data-uid]').count()), re.search(r'\((\d+)\)$',self.folder(name).inner_text()).group(1))

    def test_column_alignment_keeps_other_conditions_and_tree_not_redrawn_per_key(self):
        self.open()
        if not self.page.locator('#quick').is_visible():
            self.menu('filters')
        self.page.locator('#quick').fill('MR')
        self.page.locator('#filterrow [data-f=modality]').fill('CT, MR')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        expect(self.page.locator('#quick')).to_have_value('MR')
        self.page.evaluate("""() => {
          window.treeChanges = 0;
          new MutationObserver(r=>window.treeChanges += r.length).observe(document.querySelector('#worklist-folders'),{subtree:true,childList:true});
        }""")
        if not self.page.locator('#quick').is_visible():
            self.menu('filters')
        self.page.locator('#quick').fill('SYN MR')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        self.assertEqual(0,self.page.evaluate('window.treeChanges'))
        self.site.modalities=['MR','MR','CT,SR']
        self.page.locator('#m-refresh').click()
        expect(self.folder('MR')).to_have_text('MR (2)')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)

    def test_conflict_blocks_another_edit_after_busy_ends_and_status_announces_only_changes(self):
        self.open()
        self.site.fail_write = True
        self.save_shortcut('One')
        expect(self.page.locator('#shortcuts-status')).to_contain_text('저장 결과를 확인하지 못했습니다')
        self.site.fail_read = True
        self.save_shortcut('Two')
        expect(self.page.locator('#shortcuts-status')).to_contain_text('버전을 확인해야')
        self.assertEqual(1, len(self.site.shortcut_writes))
        self.page.evaluate("""() => {
          window.statusChanges = 0;
          new MutationObserver(r=>window.statusChanges += r.length).observe(document.querySelector('#shortcuts-status'),{subtree:true,childList:true,characterData:true});
          const preparation = KinWorkContext.prepare({}); KinWorkContext.cancelPreparation(preparation);
        }""")
        self.assertEqual(0, self.page.evaluate('window.statusChanges'))

    def test_held_session_end_discards_tree_and_account_search_data(self):
        # The retained document is required for Recover Draft; navigation cannot hide stale account data.
        # The doctor's Refresh meets the ended session first; the background answers arrive after it.
        old_button = self.held_account_document()
        self.end_held_session(background_first=False)
        self.assert_held_session_end_discarded(old_button)

    def test_held_session_end_reached_by_a_background_answer_before_refresh(self):
        # W4X-05: a background read meets the ended session before the doctor presses anything. The page is
        # already Session Ended, the legitimate order: there is no Refresh to press and the same data must go.
        old_button = self.held_account_document()
        self.end_held_session(background_first=True)
        self.assert_held_session_end_discarded(old_button)

    def held_account_document(self):
        """One account's document with report text, Folders shortcut drafts and an open saved-search manager draft.
        The received/sent critical-result reads the page sends on its own stay unanswered (background reads)."""
        self.site.held_gets['/api/critical-results'] = []
        self.site.shortcuts=[dict(id='s',name='Private shortcut',searchId='shared:9')]
        self.site.filters=[dict(id=1,name='SYN private saved search',mode='Radiology',days=-1,quick='',cols={})]
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
        self.context.route('**/saved-filter-manager.js', lambda route: route.fulfill(
            content_type='application/javascript', body=(auth.ROOT / 'worklist-v0/hpacs-lite/saved-filter-manager.js').read_text(encoding='utf-8') + """
          { const mount = KinSavedFilterManager.mount;
            KinSavedFilterManager.mount = options => {
              const api = mount(options), reset = api.reset;
              window.savedSearchLifecycle = api; window.savedSearchResets = 0;
              if (reset) api.reset = () => { const result = reset(); ++window.savedSearchResets; return result; };
              return api;
            };
          }
        """))
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(1)
        expect(self.page.locator('#chips')).to_contain_text('SYN private saved search')
        self.page.locator('#rows tr[data-uid]').click()
        expect(self.page.locator('#findings')).to_be_editable()
        self.page.locator('#findings').fill('SYN unsaved recovery text')
        expect(self.folder('Private shortcut')).to_be_visible()
        old_button = self.folder('Private shortcut').element_handle()
        nav = self.page.get_by_role('navigation', name='Folders')
        nav.locator('details > summary').click()
        nav.get_by_label('Shortcut Name', exact=True).first.fill('SYN private rename draft')
        nav.get_by_label('Shortcut Name', exact=True).last.fill('SYN private shortcut draft')
        self.menu('filters')
        self.page.locator('#managefilters').click()
        self.page.locator('#sfm-name').fill('Unsaved search draft')
        self.page.locator('#sfm-folder').fill('SYN private folder')
        self.page.locator('#sfm-description').fill('SYN private description')
        self.page.locator('#sfm-quick').fill('SYN private patient query')
        self.page.locator('#sfm-default').check()
        self.page.locator('#sfm-add-rule').click()
        rule = self.page.locator('#sfm-rules [data-rule-field]')
        rule.select_option('date')
        self.page.locator('#sfm-rules [data-rule-op]').select_option('withinLastDays')
        self.page.locator('#sfm-rules [data-relative-preset]').select_option('7')
        self.page.locator('#sfm-organize > summary').click()
        for field in ['folder-path', 'folder-description', 'folder-destination']:
            self.page.locator('#sfm-' + field).fill('SYN private ' + field)
        self.page.locator('#sfm-shared > summary').click()
        for field in ['source', 'destination', 'prefix']:
            self.page.locator('#sfs-' + field).fill('SYN private ' + field)
        self.page.locator('#sfm-close').click()
        expect(self.page.locator('#sfm-name')).to_have_value('Unsaved search draft')
        return old_button

    def end_held_session(self, background_first):
        """The server ends the session while the background reads still wait. Every API request from here on also waits
        at the server, so which answer tells the page first is the case's choice, not the scheduler's: the background
        reads (background_first) or the list read of the doctor's Refresh. Every other request is then answered by the
        ended server in the order it came."""
        background = self.site.held_gets.pop('/api/critical-results')
        self.assertNotEqual([], background, 'background reads are waiting for their answers')
        waiting = []
        def hold(route, request):
            waiting.append((route, request))
        self.context.route('**/api/**', hold)
        self.site.ended.add(self.site.cookie)
        ended = lambda routes: [self.site.refuse(route, 401, 'AUTH_SESSION_ENDED') for route in routes]
        if background_first:
            ended(background)
        else:
            expect(self.page.locator('#m-refresh')).to_be_visible()   # no answer has told the page yet
            self.page.locator('#m-refresh').click()
            first = self.waiting_request(waiting, lambda request: request.method == 'GET'
                                         and request.url.startswith(auth.ORIGIN + '/api/studies?') and 'limit=100' in request.url)
            waiting.remove(first)
            self.site.handle(*first)
        self.context.unroute('**/api/**', hold)
        while waiting:
            self.site.handle(*waiting.pop(0))
        expect(self.page.locator('dialog.kin-logout h2')).to_have_text('Session Ended')
        if background_first:
            expect(self.page.locator('#m-refresh')).not_to_be_visible()
        else:
            ended(background)
            # Drain the late answers and their promise callbacks without reopening the document.
            self.page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
            expect(self.page.locator('dialog.kin-logout h2')).to_have_text('Session Ended')

    def waiting_request(self, waiting, matches):
        """The first held request that matches, once the page has sent it (bounded: 5 s)."""
        for _ in range(500):
            found = next((entry for entry in waiting if matches(entry[1])), None)
            if found:
                return found
            self.page.wait_for_timeout(10)
        self.fail('the request never reached the server: ' + repr([request.url for _, request in waiting]))

    def assert_held_session_end_discarded(self, old_button):
        expect(self.page).to_have_url(auth.MAIN_URL)
        # W2L4-01 / REQ-WS3 -> RISK-WS3: hiding the manager must not retain an
        # account's drafts while Recover Draft keeps this document alive.
        expect(self.page.locator('#sfm-name')).to_have_value('')
        self.assertGreater(self.page.evaluate('window.savedSearchResets'), 0)
        self.assertEqual([], self.page.locator('#saved-filter-manager input, #saved-filter-manager textarea, #saved-filter-manager select').evaluate_all(
            "fields => fields.filter(f => f.type === 'checkbox' ? f.checked : f.value !== '').map(f => ({id:f.id,value:f.value}))"))
        expect(self.page.locator('#sfm-rules input, #sfm-rules select')).to_have_count(0)
        self.assertNotIn('SYN private', self.page.locator('body').text_content())
        self.assertEqual([], self.page.locator('*').evaluate_all("""elements => elements.flatMap(
            e => [...e.attributes].filter(a => /SYN private|Private shortcut|Shared CT/.test(a.value))
              .map(a => ({tag:e.tagName, attribute:a.name, value:a.value})))"""))
        self.assertEqual([], self.page.locator('input, textarea').evaluate_all(
            "fields => fields.filter(f => f.value.includes('SYN private')).map(f => f.value)"))
        expect(self.page.get_by_role('button', name='Recover Draft', exact=True)).to_be_visible()
        self.page.evaluate('window.savedSearchLifecycle.open()')
        expect(self.page.locator('#saved-filter-manager')).not_to_be_visible()
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
        self.assertNotIn('Private shortcut', self.page.locator('body').text_content())
        self.assertNotIn('Shared CT', self.page.locator('body').text_content())

    def test_session_end_resets_open_manager_with_pending_save(self):
        # A save response arriving after account end must not restore its editor.
        self.site.modalities = ['CT']
        original = self.site.list_body
        def one_study(account, rename=None):
            body = original(account, rename)
            body['studies'][0]['uid'] = auth.UID
            return body
        self.site.list_body = one_study
        pending = []
        self.context.route('**/api/filters', lambda route, request:
            pending.append((route, request.post_data_json)) if request.method == 'POST' else route.fallback())
        self.page.goto(auth.MAIN_URL)
        self.page.locator('#rows tr[data-uid]').click()
        expect(self.page.locator('#findings')).to_be_editable()
        self.page.locator('#findings').fill('SYN report recovery must survive')
        self.menu('filters')
        self.page.locator('#managefilters').click()
        self.page.locator('#sfm-name').fill('SYN pending saved search')
        with self.page.expect_request(lambda request: request.method == 'POST' and request.url.endswith('/api/filters')):
            self.page.locator('#sfm-save').click()
        expect(self.page.locator('#sfm-save')).to_be_disabled()
        self.assertEqual(1, len(pending))
        self.page.evaluate('KinAuth.replaced({session: KinWorkContext.session()})')
        expect(self.page.locator('dialog.kin-logout h2')).to_have_text('Session Ended')
        expect(self.page.locator('#sfm-name')).to_have_value('')
        route, draft = pending.pop()
        self.site.answer(route, 201, dict(draft, id=41))
        # Drain browser responses and promise callbacks without reopening the document.
        self.page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        expect(self.page.locator('#saved-filter-manager')).not_to_be_visible()
        expect(self.page.locator('#saved-filter-manager')).to_have_attribute('aria-busy', 'false')
        expect(self.page.locator('#sfm-name')).to_have_value('')
        expect(self.page.locator('#sfm-status')).to_have_text('')
        self.assertNotIn('SYN pending saved search', self.page.locator('body').text_content())
        expect(self.page.get_by_role('button', name='Recover Draft', exact=True)).to_be_visible()

    def test_manager_read_write_failure_clears_progress_status(self):
        self.open()
        self.menu('filters')
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

    def test_stored_scalar_tree_alignment_uses_token_search_count(self):
        self.site.filters = [dict(id=1, name='Default CT', mode='Radiology', days=-1, quick='',
                                 cols={'modality': 'CT'}, isDefault=True),
                             dict(id=2, name='Stored MR', mode='Radiology', days=-1, quick='', cols={'modality':'MR'})]
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        expect(self.folder('CT')).to_have_attribute('aria-pressed', 'false')
        expect(self.folder('Default CT')).to_have_attribute('aria-current', 'true')
        expect(self.folder('Default CT')).to_have_text('Default CT (2)')
        expect(self.folder('Stored MR')).to_have_text('Stored MR (1)')
        self.assertEqual(self.page.locator('#rows tr[data-uid]').count(),
                         int(re.search(r'\((\d+)\)$', self.folder('Default CT').inner_text())[1]))
        self.folder('CT').click()
        expect(self.folder('CT')).to_have_text('CT (2)')
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        if not self.page.locator('#quick').is_visible():
            self.menu('filters')
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
        self.menu('filters')
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
                    expected = {'All Studies': 6, 'CT': 2, 'Shared CT': 2}[folder]
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
        self.menu('filters')
        self.page.locator('#savefilter').click()
        self.page.locator('#sfm-name').fill('Column tokens')
        self.page.locator('#sfm-save-apply').click()
        expect(self.page.locator('#saved-filter-manager')).not_to_be_visible()
        self.close_menus()
        self.assertEqual(['CT', 'MR'], self.site.filters[0]['cols']['modality'])
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
        self.menu('filters')
        self.page.locator('#managefilters').click()
        self.page.locator('#sfm-name').fill('Stable modalities')
        field = self.page.locator('#sfm-col-modality')
        for bad in ['CT,', 'CT,,MR', 'CT, UNKNOWN']:
            field.fill(bad)
            expect(self.page.locator('#sfm-count')).not_to_contain_text('오류')
            self.page.locator('#sfm-preview').click()
            expect(self.page.locator('#sfm-count')).to_contain_text('사용할 수 없는 Modality')
            expect(self.page.locator('#sfm-count')).not_to_contain_text('복합 조건 오류')
            expect(self.page.locator('#saved-filter-manager')).to_be_visible()
            expect(self.page.locator('#rows tr[data-uid]')).to_have_count(6)
            self.page.locator('#sfm-save').click()
            self.assertEqual([], self.site.filters)
        field.fill('ct, CT, mr, MR')
        self.page.locator('#sfm-save-apply').click()
        expect(self.page.locator('#saved-filter-manager')).not_to_be_visible()
        self.close_menus()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(3)
        self.assertEqual(['CT', 'MR'], self.site.filters[0]['cols']['modality'])
        self.folder('All Studies').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(6)
        self.folder('Stable modalities').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(3)
        expect(self.folder('Stable modalities')).to_have_text('Stable modalities (3)')

    def test_new_modality_typing_normalizes_without_error_toasts(self):
        self.open()
        self.page.evaluate("""() => {
          window.errorToasts = [];
          const node = document.querySelector('#toast');
          new MutationObserver(records => {
            for (const r of records) if (r.type === 'attributes' && r.attributeName === 'class'
                && node.classList.contains('err')) window.errorToasts.push(node.textContent);
          }).observe(node, {attributes:true});
        }""")
        field = self.page.locator('#filterrow [data-f=modality]')
        for text, count, normalized in [('ct',2,'CT'), (' CT ',2,'CT'), ('CT',2,'CT'),
                                        ('ct, mr',3,'CT,MR'), ('CT, MR',3,'CT,MR'),
                                        ('ct\\mr\\CT',3,'CT,MR')]:
            with self.subTest(text=text):
                field.fill('')
                field.press_sequentially(text)
                expect(self.page.locator('#rows tr[data-uid]')).to_have_count(count)
                expect(self.page.locator('.statusbar').first).to_contain_text('Modality('+normalized+')')
                self.assertEqual([], self.page.evaluate('window.errorToasts'))
                if count == 2:
                    expect(self.folder('CT')).to_have_attribute('aria-pressed', 'true')
        for text, commit in [('CT, UNKNOWN','Enter'), ('CT,','Tab')]:
            self.page.evaluate('window.errorToasts = []')
            field.fill(text)
            self.assertEqual([], self.page.evaluate('window.errorToasts'))
            expect(self.page.locator('#rows tr[data-uid]')).to_have_count(3)
            field.press(commit)
            self.assertEqual(1, len(self.page.evaluate('window.errorToasts')))
            expect(self.page.locator('#toast')).to_contain_text('사용할 수 없는 Modality')

    def test_editor_normalizes_new_single_and_multiple_modalities(self):
        self.open()
        self.menu('filters')
        for text, stored, count in [('ct','CT',2), (' CT ','CT',2), ('CT','CT',2),
                                    ('ct, mr',['CT','MR'],3), ('CT, MR',['CT','MR'],3),
                                    ('ct\\mr\\CT',['CT','MR'],3)]:
            with self.subTest(text=text):
                self.folder('All Studies').click()
                self.menu('filters')
                self.page.locator('#managefilters').click()
                self.page.locator('#sfm-new').click()
                self.page.locator('#sfm-name').fill('Typed '+text)
                field = self.page.locator('#sfm-col-modality')
                field.fill('')
                field.press_sequentially(text)
                expect(self.page.locator('#sfm-count')).not_to_contain_text('오류')
                self.page.locator('#sfm-save-apply').click()
                expect(self.page.locator('#saved-filter-manager')).not_to_be_visible()
                self.close_menus()
                saved = next(f for f in self.site.filters if f['name'] == ('Typed '+text).strip())
                self.assertEqual(stored, saved['cols']['modality'])
                expect(self.page.locator('#rows tr[data-uid]')).to_have_count(count)

    def test_manager_transient_shared_failure_keeps_applied_search(self):
        self.open()
        self.folder('Shared CT').click()
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        self.site.fail_shared = 503
        self.menu('filters')
        self.page.locator('#managefilters').click()
        self.page.locator('#sfm-shared > summary').click()
        with self.page.expect_response(lambda r: r.url.endswith('/api/shared-filters')) as response:
            self.page.locator('#sfs-load').click()
        response.value.finished()
        expect(self.page.locator('#sfm-status')).to_have_class(re.compile('sfm-error'))
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(2)
        self.page.locator('#sfm-close').click()
        expect(self.folder('Shared CT')).to_be_enabled()
        expect(self.folder('Shared CT')).not_to_contain_text('Unavailable')
        expect(self.folder('All Studies')).not_to_have_attribute('aria-current', 'true')



# 2026-11-01 compact worklist contract, through the same served synthetic site.
from datetime import datetime, timezone

class StudioSite(FolderSite):
    """Synthetic account layout endpoint: tests exercise the shipped Save/Load controls."""
    def __init__(self):
        super().__init__()
        self.layout = None
        self.layout_revision = 0
        self.layout_writes = []
        self.statuses = None
        self.notes = None

    def list_body(self, account, rename=None):
        body = super().list_body(account, rename)
        if self.notes is not None:
            for row, note in zip(body['studies'], self.notes):
                row['techNote'] = note
        if self.statuses:
            for row, rs in zip(body['studies'], self.statuses):
                row['state']['rs'] = rs
        return body

    def api(self, route, request, method, path, query):
        if path == '/api/workspace-layout':
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            owner = [auth.INSTITUTION, account['sub']]
            if method != 'GET':
                body = request.post_data_json
                self.layout_writes.append(copy.deepcopy(body))
                if body['expectedOwner'] != owner or body['revision'] != self.layout_revision:
                    return route.fulfill(status=409, json={'code': 'WORKSPACE_REVISION_CONFLICT'})
                self.layout = copy.deepcopy(body.get('layout'))
                self.layout_revision += 1
            return route.fulfill(json=dict(owner=owner, revision=self.layout_revision, layout=self.layout, updatedAt=None))
        return super().api(route, request, method, path, query)


class StudioWorklistDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = StudioSite()
        self.context = self.browser.new_context(viewport={"width": 1500, "height": 1000}, timezone_id="Asia/Seoul")
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
        self.page = self.context.new_page()
        self.page.set_default_timeout(5000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", lambda dialog: dialog.accept())
        self.page.clock.set_fixed_time(datetime(2026, 11, 1, 3, tzinfo=timezone.utc))

    def tearDown(self):
        if self.errors:
            print("Browser errors:", self.errors)
        self.context.close()
        self.assertEqual([], self.errors)
        self.assertEqual([], self.site.violations)

    def open(self):
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator("#rows tr[data-uid]")).to_have_count(6)

    def test_default_columns_and_compact_rows(self):
        self.open()
        names = self.page.locator("#heads th").evaluate_all("els => els.map(e => e.dataset.key)")
        self.assertEqual(["no", "assignedReader", "rs", "date", "id", "name", "age", "desc", "modality", "institutionName"], names)
        self.assertEqual("11px", self.page.locator("#rows td").first.evaluate("e => getComputedStyle(e).fontSize"))
        self.assertNotIn("Referred", self.page.locator("#heads").inner_text())
        if os.environ.get("KIN_EVIDENCE_DIR"):
            target = Path(os.environ["KIN_EVIDENCE_DIR"]); target.mkdir(parents=True, exist_ok=True)
            self.page.screenshot(path=str(target / "studio-worklist.png"), full_page=True)

    def test_selection_bar_follows_space_and_clear(self):
        self.open()
        expect(self.page.locator("#worklist-selection")).to_be_hidden()
        self.page.locator("#rows tr[data-uid]").first.press("Space")
        expect(self.page.locator("#worklist-selection")).to_be_visible()
        expect(self.page.get_by_role("button", name="Open Selected Studies", exact=True)).to_be_visible()
        self.page.get_by_role("button", name="Clear Selection", exact=True).click()
        expect(self.page.locator("#worklist-selection")).to_be_hidden()

    def test_top_menus_and_logout_fit_one_row(self):
        self.open()
        self.assertEqual(0, self.page.locator(".userfilter, #quick-match, #shortcuts-save, #shortcuts-reload").count())
        for width in (1920, 1366, 1024, 768):
            self.page.set_viewport_size({"width": width, "height": 1000})
            for selector in ("#toolbar-view > summary", "#toolbar-more > summary", "#toolbar-filters > summary", "#logout"):
                box = self.page.locator(selector).bounding_box()
                self.assertIsNotNone(box, selector)
                self.assertGreaterEqual(box["x"], 0, selector)
                self.assertLessEqual(box["x"] + box["width"], width + 1, selector)
                self.assertLessEqual(box["y"] + box["height"], 31, selector)
        self.page.locator("#toolbar-view > summary").click()
        expect(self.page.locator("#columnsettings")).to_be_visible()
        expect(self.page.locator("#panel-settings-open")).to_be_visible()

    def test_header_dates_and_age_saved_shortcut_round_trip(self):
        self.site.row_dates = ["2026-11-01", "2026-10-31", "2026-10-30", "2026-10-25", "2026-10-01", "2026-09-01"]
        self.open()
        date = self.page.get_by_label("StudyDate Filter", exact=True)
        for preset, count in (("today", 1), ("2d", 3), ("1w", 4), ("1m", 5), ("", 6)):
            date.select_option(preset)
            expect(self.page.locator("#rows tr[data-uid]")).to_have_count(count)
        date.select_option("1w")
        self.page.get_by_label("Age Filter", exact=True).fill(">0")
        self.page.get_by_label("Age Filter", exact=True).press("Enter")
        self.page.get_by_role("button", name="My Shortcuts", exact=True).click()
        self.page.get_by_label("Shortcut Name", exact=True).fill("SYN date age")
        self.page.get_by_role("button", name="Save as Shortcut", exact=True).click()
        expect(self.page.locator("#exam-filter-popup [role=status]")).to_contain_text("저장했습니다")
        self.page.locator("#exam-filter-popup").get_by_role("button", name="Close", exact=True).click()
        self.page.locator("#filterrow .col-clear").click()
        self.page.get_by_label("My Shortcuts", exact=True).get_by_role("button", name="SYN date age (4)", exact=True).click()
        expect(date).to_have_value("1w")
        expect(self.page.get_by_label("Age Filter", exact=True)).to_have_value(">0")
        self.assertEqual(-1, self.site.filters[0]["days"])
        self.assertEqual(">0", self.site.filters[0]["cols"]["age"])
        self.assertEqual("2026-10-25..2026-11-01", self.site.filters[0]["cols"]["date"])

    def test_rs_words_and_count_order(self):
        self.site.statuses = ['W', 'T', 'P', 'H', 'A', 'W']
        self.open()
        for word in ['Unread', 'In Progress', 'Preliminary', 'On Hold', 'Approved']:
            expect(self.page.locator('#rows')).to_contain_text(word)
        counts = self.page.locator('#countlist').inner_text()
        labels = ['Unread', 'In Progress', 'Preliminary', 'On Hold', 'Approved', 'Unverified']
        self.assertEqual(sorted(counts.index(word) for word in labels), [counts.index(word) for word in labels])
        for old in ['Waiting', 'Transcribed', 'Temporarily Saved']:
            self.assertNotIn(old, counts)

    def test_month_preset_clamps_to_last_day_of_previous_month(self):
        from datetime import datetime
        self.page.clock.set_fixed_time(datetime.fromisoformat('2026-03-31T12:00:00+09:00'))
        self.open()
        self.page.get_by_label('StudyDate Filter', exact=True).select_option('1m')
        self.page.get_by_role('button', name='My Shortcuts', exact=True).click()
        popup = self.page.locator('#exam-filter-popup')
        expect(popup.get_by_label('StudyDate from', exact=True)).to_have_value('2026-02-28')
        expect(popup.get_by_label('StudyDate to', exact=True)).to_have_value('2026-03-31')

    def test_custom_dates_float_without_growing_row(self):
        self.open()
        row = self.page.locator("#filterrow")
        before = row.bounding_box()["height"]
        self.page.get_by_label("StudyDate Filter", exact=True).select_option("custom")
        expect(self.page.get_by_label("StudyDate From", exact=True)).to_be_visible()
        self.assertAlmostEqual(before, row.bounding_box()["height"], delta=1)

    def test_column_width_drag_and_picker_share_dialog_state(self):
        self.open()
        head = self.page.locator('#heads th[data-key="name"]')
        before = head.bounding_box()["width"]
        grip = head.locator(".col-grip").bounding_box()
        self.page.mouse.move(grip["x"] + grip["width"] / 2, grip["y"] + grip["height"] / 2)
        self.page.mouse.down()
        self.page.mouse.move(grip["x"] + 45, grip["y"] + grip["height"] / 2)
        self.page.mouse.up()
        self.page.get_by_role("button", name="Choose columns", exact=True).click()
        self.page.locator('#column-picker [data-column="age"]').get_by_role('checkbox').uncheck()
        self.page.locator("#column-picker").get_by_role("button", name="Close", exact=True).click()
        self.page.locator("#toolbar-view > summary").click()
        self.page.locator("#columnsettings").click()
        expect(self.page.get_by_role("checkbox", name="Show Age", exact=True)).not_to_be_checked()
        width = int(self.page.get_by_label("Name content width (px)", exact=True).input_value())
        self.assertGreaterEqual(width, 64)
        self.assertLessEqual(width, 600)
        self.assertAlmostEqual(width, min(600, max(64, before + 45 - grip["width"] / 2)), delta=1)

    def test_tech_note_words_keep_korean_help(self):
        self.site.notes = [dict(version=1, present=True), dict(version=0, present=False),
                           dict(version=2, present=False), None]
        self.open()
        self.page.get_by_role('button', name='Choose columns', exact=True).click()
        self.page.locator('#column-picker [data-column=techNote]').get_by_role('checkbox').check()
        self.page.locator('#column-picker').get_by_role('button', name='Close', exact=True).click()
        buttons = self.page.locator('#rows [data-tech-note]')
        for i, word in enumerate(('Yes', 'None', 'Cleared', 'Unknown')):
            expect(buttons.nth(i)).to_have_text(word)
            expect(buttons.nth(i)).to_have_attribute('title', re.compile('[가-힣]'))
        self.page.get_by_label('Tech Note Filter', exact=True).select_option('Cleared')
        expect(self.page.locator('#rows [data-tech-note]')).to_have_text(['Cleared'])

    def test_width_change_preserves_default_text_size(self):
        self.open()
        self.page.get_by_role("button", name="Choose columns", exact=True).click()
        self.page.get_by_label("Name width (px)", exact=True).fill("240")
        self.page.get_by_label("Name width (px)", exact=True).press("Tab")
        self.page.locator("#column-picker").get_by_role("button", name="Close", exact=True).click()
        self.assertEqual("11px", self.page.locator("#rows td").first.evaluate("e => getComputedStyle(e).fontSize"))

    def test_panels_restore_after_default_and_reset(self):
        self.open()
        expect(self.page.locator(".rw > .s-thumb")).to_be_hidden()
        self.page.locator("#m-config").click()
        expect(self.page.get_by_role("dialog", name="Panel Settings")).to_be_visible()
        self.page.get_by_role("button", name="Show All Panels", exact=True).click()
        # The choice must actually reveal the shipped panel, including after reload.
        expect(self.page.locator(".rw > .s-thumb")).to_be_visible()
        self.page.reload()
        expect(self.page.locator(".rw > .s-thumb")).to_be_visible()
        self.page.locator("#toolbar-view > summary").click()
        self.page.locator("#layout-reset").click()
        expect(self.page.locator(".rw > .s-thumb")).to_be_hidden()

    def test_left_split_is_restored_from_workspace(self):
        self.open()
        split = self.page.locator("#resize-left-split")
        before = self.page.locator(".left > .related-list-pane").bounding_box()["height"]
        split.press("ArrowUp")
        after = self.page.locator(".left > .related-list-pane").bounding_box()["height"]
        self.assertGreater(after, before)
        self.page.locator("#toolbar-view > summary").click()
        self.page.locator("#workspace-server-summary").click()
        self.page.get_by_role("button", name="Save to Account", exact=True).click()
        expect(self.page.locator("#workspace-server-status")).to_contain_text("계정에 저장했습니다")
        self.assertTrue(self.site.layout_writes)
        # Delete browser state: only the account workspace can restore the divider now.
        self.page.evaluate("localStorage.clear()")
        self.page.reload()
        self.page.locator("#toolbar-view > summary").click()
        self.page.locator("#workspace-server-summary").click()
        self.page.get_by_role("button", name="Load from Account", exact=True).click()
        expect(self.page.locator("#workspace-server-status")).to_contain_text("서버 배치를 불러왔습니다")
        self.page.locator("#toolbar-view > summary").click()
        restored = self.page.locator(".left > .related-list-pane").bounding_box()["height"]
        self.assertAlmostEqual(after, restored, delta=1)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(verbosity=2)
