"""REQ-WS1/WS2/WS7 -> RISK-WS1/WS2/WS7 -> WS1-LAYOUT-ROAM / WS7-RW-RELOCATION.

Serve the real page and dependency assets. Only HTTP answers are synthetic.
Node identity is itself the relocation contract; all other assertions observe
public controls, focus, geometry and stored preferences. No product instrumentation.
"""
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile
from playwright.sync_api import expect, sync_playwright
import auth_logout_dom_test as auth

ROOT = Path(__file__).resolve().parents[1]
if os.environ.get('KIN_W3_ASSET_ROOT'):
    auth.ROOT = Path(os.environ['KIN_W3_ASSET_ROOT']).resolve()
KEY = 'kin-workspace:v1:' + json.dumps([auth.INSTITUTION, auth.RAD['sub']], separators=(',', ':'))
READING = dict(version=1, reportWidth=540, imageHeight=390, relatedHeight=None,
               relatedListHeight=180, relatedHidden=False)


def first_paint_pixels(page, path):
    # W3S-03: W2 itself has two native-checkbox raster states after fonts/blur/
    # double-rAF. Playwright masks the element's measured bounding box, never a
    # fixed pixel range. Geometry/checked state remain independently compared.
    checkbox = page.get_by_role('group', name='Status', exact=True).get_by_role('checkbox')
    expect(checkbox).to_have_count(1)
    expect(checkbox).to_be_checked()
    assert checkbox.bounding_box() is not None
    return page.screenshot(animations='disabled', caret='hide',
        mask=[page.locator('.brand img'), checkbox], path=str(path))


class WorkspaceSite(auth.Site):
    def __init__(self):
        super().__init__()
        self.layout, self.layout_revision = None, 0
        self.fail_read, self.held_read = False, None
        self.layout_writes = []

    def api(self, route, request, method, path, query):
        if path == '/api/workspace-layout':
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            owner = [auth.INSTITUTION, account['sub']]
            if method == 'GET':
                if self.held_read is not None:
                    self.held_read.append(route)
                    return
                if self.fail_read:
                    return route.fulfill(status=503, json={'message': 'SYN read failed'})
            else:
                body = request.post_data_json
                self.layout_writes.append(copy.deepcopy(body))
                if body['expectedOwner'] != owner:
                    return route.fulfill(status=409, json={'code': 'WORKSPACE_OWNER_CHANGED'})
                if body['revision'] != self.layout_revision:
                    return route.fulfill(status=409, json={'code': 'WORKSPACE_REVISION_CONFLICT'})
                self.layout = copy.deepcopy(body.get('layout'))
                self.layout_revision += 1
            return route.fulfill(json=dict(owner=owner, revision=self.layout_revision, layout=self.layout, updatedAt=None))
        return super().api(route, request, method, path, query)


class StudyPanelPageDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = WorkspaceSite()
        self.context = self.browser.new_context(viewport={'width': 1920, 'height': 1080})
        self.context.route('**/*', lambda route, request: self.site.handle(route, request))
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors)
        self.assertEqual([], self.site.violations)

    def boot(self, value=None):
        if value is not None:
            self.context.add_init_script('localStorage.setItem(' + json.dumps(KEY) + ', ' + json.dumps(json.dumps(value)) + ')')
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows')).to_contain_text(auth.PATIENT)
        expect(self.page.locator('#study-panel-open')).to_have_attribute('aria-expanded', 'false')

    def drawer(self):
        return self.page.get_by_role('complementary', name='Study Panel', exact=True)

    def open_drawer(self, templates=False):
        self.page.keyboard.press('Control+Alt+' + ('t' if templates else '5'))
        expect(self.drawer()).to_be_visible()

    def account_menu(self):
        self.page.locator('#toolbar-view > summary').click()
        menu = self.page.locator('#workspace-server-menu')
        if menu.get_attribute('open') is None:
            menu.locator('summary').click()

    def local(self):
        return self.page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', KEY)

    def test_move_identity_listeners_and_focus_return_without_editor_rewrite(self):
        self.boot()
        self.page.locator('#rows tr[data-uid]').first.click()
        field = self.page.locator('#findings')
        field.fill('SYN preserved editor text')
        nodes = self.page.evaluate_handle("() => ['.s-thumb','.s-clinical','.s-template'].map(s => document.querySelector(s))")
        self.open_drawer()
        self.assertTrue(self.drawer().evaluate('(drawer,nodes) => nodes.every(n => drawer.contains(n))', nodes))
        self.drawer().get_by_role('tab', name='Templates', exact=True).click()
        self.drawer().get_by_role('searchbox', name='상용구 검색').fill('SYN search')
        self.drawer().get_by_role('button', name='Clear Search', exact=True).click()
        expect(self.page.locator('#tpl-search')).to_have_value('')
        self.page.keyboard.press('Escape')
        expect(self.drawer()).to_have_count(0)
        expect(field).to_be_focused()
        expect(field).to_have_value('SYN preserved editor text')
        self.assertTrue(self.page.evaluate('(nodes) => nodes.every(n => n.isConnected && n.closest(".rw"))', nodes))
        search = self.page.get_by_role('searchbox', name='상용구 검색', exact=True)
        search.focus()
        self.open_drawer(True)
        self.page.keyboard.press('Escape')
        expect(search).to_be_focused()

    def test_removed_and_hidden_opener_fall_back_to_report(self):
        self.boot()
        for kind in ('removed', 'hidden'):
            self.page.evaluate("() => {const b=document.createElement('button');b.id='synthetic-opener';b.textContent='SYN opener';document.body.prepend(b);b.focus()}")
            self.open_drawer()
            self.page.locator('#synthetic-opener').evaluate('(b,kind) => kind === "removed" ? b.remove() : b.hidden=true', kind)
            self.page.keyboard.press('Escape')
            expect(self.page.locator('#findings')).to_be_focused()
            self.page.locator('#synthetic-opener').evaluate_all('(nodes) => nodes.forEach(n => n.remove())')

    def test_ime_escape_tab_navigation_and_no_persisted_open(self):
        self.boot()
        self.open_drawer(True)
        tab = self.drawer().get_by_role('tab', name='Templates', exact=True)
        expect(tab).to_be_focused()
        tab.dispatch_event('compositionstart')
        self.page.keyboard.press('Escape')
        expect(self.drawer()).to_be_visible()
        tab.dispatch_event('compositionend')
        self.page.keyboard.press('Home')
        expect(self.drawer().get_by_role('tab', name='Images', exact=True)).to_be_focused()
        self.page.keyboard.press('End')
        expect(tab).to_be_focused()
        stored = self.local()
        self.assertEqual(3, stored['version'])
        self.assertEqual(dict(version=1, rail=None, worklist=None, related=None, prior=None,
                              railCollapsed=False, studyPanelTab='templates'), stored['workspace'])
        self.page.reload()
        expect(self.page.locator('#rows')).to_contain_text(auth.PATIENT)
        expect(self.drawer()).to_have_count(0)
        self.open_drawer()
        expect(self.drawer().get_by_role('tab', name='Templates', exact=True)).to_have_attribute('aria-selected', 'true')

    def test_role_fallback_preserves_preferred_tab(self):
        self.site.account = {**auth.RAD, 'roles': ['technician']}
        value = dict(version=3, mode='auto', portrait={}, landscape={}, reading=READING,
                     workspace=dict(version=1, rail=None, worklist=None, related=None, prior=None,
                                    railCollapsed=False, studyPanelTab='templates'))
        self.boot(value)
        self.open_drawer()
        # A prior login's saved preference cannot change the new-login default.
        expect(self.drawer().get_by_role('tab', name='Info', exact=True)).to_have_attribute('aria-selected', 'true')
        self.page.keyboard.press('Escape')
        # Explicit account Load remains a deliberate restore of a preferred tab,
        # including one hidden by the current role.
        self.site.layout = value
        self.account_menu()
        self.page.get_by_role('button', name='Load from Account', exact=True).click()
        expect(self.page.locator('#workspace-server-status')).to_contain_text('서버 배치를 불러왔습니다')
        self.page.locator('#toolbar-view > summary').click()
        self.open_drawer()
        expect(self.drawer().get_by_role('tab')).to_have_count(2)
        expect(self.drawer().get_by_role('tab', name='Images', exact=True)).to_have_attribute('aria-selected', 'true')
        self.assertEqual('templates', self.local()['workspace']['studyPanelTab'])
        self.page.keyboard.press('Escape')
        self.page.keyboard.press('Control+Alt+t')
        expect(self.drawer()).to_have_count(0)

    def test_integrated_workspace_opener_and_remapped_context_command(self):
        self.boot()
        self.page.route('**/ohif/**', lambda route: route.fulfill(content_type='text/html',
            body='<!doctype html><title>SYN viewer</title>'))
        self.page.locator('#rows tr[data-uid]').first.click()
        self.page.get_by_role('button', name='Reading Workspace', exact=True).click()
        opener = self.page.get_by_role('button', name='Study Info & Templates', exact=True)
        expect(opener).to_be_visible()
        opener.click()
        expect(self.drawer()).to_be_visible()
        self.page.keyboard.press('Escape')
        expect(self.drawer()).to_have_count(0)
        expect(opener).to_be_focused()
        bindings = dict(list='Digit1', image='Digit2', prior='Digit3', report='Digit4',
                        context='KeyQ', note='Digit6', tools='Digit7', nativeTools='Digit9',
                        previous='ArrowLeft', next='ArrowRight')
        self.page.evaluate('([owner,value]) => localStorage.setItem("kin-workspace-shortcuts:v1:"+owner,JSON.stringify(value))',
            [json.dumps([auth.INSTITUTION, auth.RAD['sub']], separators=(',', ':')), bindings])
        self.page.keyboard.press('Control+Alt+5')
        expect(self.drawer()).to_have_count(0)
        self.page.keyboard.press('Control+Alt+q')
        expect(self.drawer()).to_be_visible()
        self.page.keyboard.press('Escape')
        expect(self.drawer()).to_have_count(0)

    def test_v1_v2_migrate_preserving_reading_account_save_reload_and_recovery(self):
        for version in (1, 2):
            with self.subTest(version=version):
                value = dict(version=version, mode='auto', portrait={'main': 320}, landscape={'main': 700})
                if version == 2:
                    value['reading'] = READING
                self.page.goto(auth.MAIN_URL)
                self.page.evaluate('([k,v]) => localStorage.setItem(k,JSON.stringify(v))', [KEY, value])
                self.page.reload()
                expect(self.page.locator('#rows')).to_contain_text(auth.PATIENT)
                self.open_drawer(True)
                saved = self.local()
                self.assertEqual(3, saved['version'])
                self.assertEqual(value['portrait'], saved['portrait'])
                if version == 2:
                    self.assertEqual(READING, saved['reading'])
                self.page.keyboard.press('Escape')
                self.account_menu()
                save = self.page.get_by_role('button', name='Save to Account', exact=True)
                expect(save).to_be_enabled()
                save.click()
                expect(self.page.locator('#workspace-server-status')).to_contain_text('현재 배치를 계정에 저장')
                self.assertEqual(saved, self.site.layout)
                self.site.fail_read = True
                self.page.get_by_role('button', name='Load from Account', exact=True).click()
                retry = self.page.get_by_role('button', name='Retry', exact=True)
                expect(retry).to_be_enabled()
                expect(save).to_be_disabled()
                before = len(self.site.layout_writes)
                self.site.fail_read = False
                retry.click()
                expect(save).to_be_enabled()
                self.assertEqual(before, len(self.site.layout_writes))
                self.assertEqual(saved, self.local())

    def test_drawer_geometries_zoom_and_pilot_pictures(self):
        self.boot()
        self.page.locator('#rows tr[data-uid]').first.click()
        pictures = Path(os.environ.get('KIN_W3_PILOT_DIR', ROOT / 'tmp/w3-land/pilot'))
        pictures.mkdir(parents=True, exist_ok=True)
        for width, height in ((1920,1080), (900,1200), (1366,768), (2560,1440), (768,1024), (640,480), (900,768), (1024,768)):
            self.page.set_viewport_size(dict(width=width, height=height))
            prefix = f'{width}x{height}'
            if width in (1920,900):
                self.page.screenshot(path=str(pictures/(prefix+'-closed.png')))
            self.open_drawer()
            for name in ('Images','Info','Templates'):
                self.drawer().get_by_role('tab', name=name, exact=True).click()
                box = self.drawer().bounding_box()
                self.assertGreater(box['width'], 200)
                self.assertGreaterEqual(box['x'], 0)
                self.assertLessEqual(box['x']+box['width'], width)
                self.assertLessEqual(box['y']+box['height'], height+1)
                if width > 1100 and width > height:
                    self.assertAlmostEqual(12, box['x'], delta=1)
                    self.assertAlmostEqual(360, box['width'], delta=1)
                    report = self.page.locator('.report-p').bounding_box()
                    self.assertLessEqual(box['x'] + box['width'], report['x'])
                if width in (1920,900):
                    self.page.screenshot(path=str(pictures/(prefix+'-'+name.lower()+'.png')))
            self.page.keyboard.press('Escape')
            if height == 768 and 900 <= width <= 1100:
                expect(self.page.get_by_role('navigation', name='Study Panel', exact=True)).to_be_hidden()
        self.page.set_viewport_size(dict(width=960,height=540))
        self.page.evaluate("document.body.style.zoom='2'")
        self.open_drawer()
        expect(self.drawer().get_by_role('button', name='Close', exact=True)).to_be_in_viewport()
        self.page.keyboard.press('Escape')
        self.page.evaluate("document.body.style.zoom='1'")
        self.page.set_viewport_size(dict(width=840,height=768))
        strip = self.page.get_by_role('navigation', name='Study Panel', exact=True)
        expect(strip).to_be_in_viewport()
        strip.get_by_role('button', name='Info', exact=True).click()
        expect(self.drawer().get_by_role('tab', name='Info', exact=True)).to_have_attribute('aria-selected', 'true')
        self.page.keyboard.press('Escape')
        # A tall portrait has room for a resizable context panel. Only short
        # narrow landscapes compact it; the portrait pilot retains manual sizes.
        self.page.set_viewport_size(dict(width=768,height=1024))
        # Wait for the tall, stacked layout's visible geometry, including its
        # resize-driven reflow, before comparing a keyboard resize with it.
        self.page.wait_for_function("""() => {
            const panel = document.querySelector('.rw').getBoundingClientRect();
            const left = document.querySelector('.left').getBoundingClientRect();
            const right = document.querySelector('.right').getBoundingClientRect();
            return panel.height >= 140 && right.top >= left.bottom;
        }""")
        before = self.page.locator('.rw').bounding_box()['height']
        self.page.locator('#resize-top').focus()
        self.page.keyboard.press('ArrowUp')
        after = self.page.locator('.rw').bounding_box()['height']
        self.assertGreaterEqual(after,140)
        self.assertLess(after,before)

    def test_info_first_session_choice_and_new_login(self):
        """D1041-INFO/LOGIN: old v3 choice, same-login reload and same-owner login."""
        value = dict(version=3, mode='auto', portrait={}, landscape={}, reading=READING,
                     workspace=dict(version=1, rail=240, worklist=700, related=250, prior=180,
                                    railCollapsed=False, studyPanelTab='templates'))
        self.boot()
        self.page.evaluate('([k,v]) => localStorage.setItem(k,JSON.stringify(v))', [KEY, value])
        self.page.reload()
        expect(self.page.locator('#rows')).to_contain_text(auth.PATIENT)
        # The visible default must not depend on what the last login saved.
        self.open_drawer()
        info = self.drawer().get_by_role('tab', name='Info', exact=True)
        expect(info).to_have_attribute('aria-selected', 'true')
        expect(info).to_be_focused()
        for name in ('Images', 'Templates'):
            self.drawer().get_by_role('tab', name=name, exact=True).click()
            self.page.keyboard.press('Escape')
            self.open_drawer()
            expect(self.drawer().get_by_role('tab', name=name, exact=True)).to_have_attribute('aria-selected', 'true')
        # Reload retains only what the real page wrote, without a fixture reset.
        saved = self.local()
        self.assertEqual('templates', saved['workspace']['studyPanelTab'])
        self.page.reload()
        expect(self.page.locator('#rows')).to_contain_text(auth.PATIENT)
        expect(self.drawer()).to_have_count(0)
        self.open_drawer()
        expect(self.drawer().get_by_role('tab', name='Templates', exact=True)).to_have_attribute('aria-selected', 'true')
        self.page.keyboard.press('Escape')
        # A new server-issued session for the SAME owner, in the SAME browser.
        # No storage clearing can mask leakage across logins.
        old_session = self.site.cookie
        self.site.ended.add(old_session)
        self.site.sign_in(auth.RAD)
        self.assertNotEqual(old_session, self.site.cookie)
        self.page.reload()
        expect(self.page.locator('#rows')).to_contain_text(auth.PATIENT)
        self.open_drawer()
        expect(self.drawer().get_by_role('tab', name='Info', exact=True)).to_have_attribute('aria-selected', 'true')
        self.drawer().get_by_role('tab', name='Images', exact=True).click()
        self.assertEqual(saved['reading'], self.local()['reading'])
        for key in ('rail', 'worklist', 'related', 'prior', 'railCollapsed'):
            self.assertEqual(saved['workspace'][key], self.local()['workspace'][key])

    def test_left_overlay_preserves_folders_report_geometry_and_keyboard(self):
        """D1041-LEFT: left work area overlap is intentional; no extra grid column."""
        self.boot()
        self.page.locator('#rows tr[data-uid]').first.click()
        self.page.get_by_role('button', name='Folders', exact=True).click()
        panels = ['.left', '.right', '.related-p', '.report-p', '#worklist-folders-panel']
        before = [self.page.locator(s).bounding_box() for s in panels]
        self.page.locator('#findings').fill('SYN left drawer keeps this draft')
        self.open_drawer()
        box = self.drawer().bounding_box()
        self.assertAlmostEqual(12, box['x'], delta=1)
        self.assertAlmostEqual(360, box['width'], delta=1)
        self.assertLessEqual(box['x'] + box['width'], before[3]['x'])
        self.assertEqual(before, [self.page.locator(s).bounding_box() for s in panels])
        self.page.keyboard.press('ArrowRight')
        expect(self.drawer().get_by_role('tab', name='Templates', exact=True)).to_be_focused()
        self.page.keyboard.press('ArrowLeft')
        expect(self.drawer().get_by_role('tab', name='Info', exact=True)).to_be_focused()
        self.page.keyboard.press('Shift+Tab')
        expect(self.drawer().get_by_role('button', name='Close', exact=True)).to_be_focused()
        self.page.keyboard.press('Tab')
        expect(self.drawer().get_by_role('tab', name='Info', exact=True)).to_be_focused()
        self.page.keyboard.press('Escape')
        expect(self.page.locator('#findings')).to_be_focused()
        expect(self.page.locator('#findings')).to_have_value('SYN left drawer keeps this draft')
        expect(self.page.get_by_role('button', name='Folders', exact=True)).to_have_attribute('aria-expanded', 'true')
        self.assertEqual(before, [self.page.locator(s).bounding_box() for s in panels])
        # Integrated reading has an image viewport on the left. The same overlay
        # leaves its/report geometry and resize directions intact.
        self.page.route('**/ohif/**', lambda route: route.fulfill(content_type='text/html',
            body='<!doctype html><title>SYN viewer</title>'))
        self.page.get_by_role('button', name='Reading Workspace', exact=True).click()
        opener = self.page.get_by_role('button', name='Study Info & Templates', exact=True)
        expect(opener).to_be_visible()
        before = [self.page.locator(s).bounding_box() for s in ('#reading-viewer', '.report-p')]
        opener.click()
        box = self.drawer().bounding_box()
        self.assertLessEqual(box['x'] + box['width'], before[1]['x'])
        self.assertEqual(before, [self.page.locator(s).bounding_box() for s in ('#reading-viewer', '.report-p')])
        self.page.keyboard.press('Escape')
        expect(opener).to_be_focused()

    def test_rail_and_panel_keyboard_resize_persist_as_v3(self):
        self.boot()
        self.page.get_by_role('button', name='Folders', exact=True).click()
        rail = self.page.get_by_role('separator', name='폴더 너비 조절', exact=True)
        rail.focus()
        self.page.keyboard.press('ArrowRight')
        self.assertIsInstance(self.local()['workspace']['rail'], int)
        self.page.get_by_role('button', name='Rail', exact=True).click()
        self.assertTrue(self.local()['workspace']['railCollapsed'])
        self.page.reload()
        expect(self.page.locator('#rows')).to_contain_text(auth.PATIENT)
        expect(self.page.get_by_role('button', name='Folders', exact=True)).to_have_attribute('aria-expanded', 'false')

    def test_end_invalidates_resize_and_drawer_callbacks(self):
        self.boot()
        self.page.locator('#rows tr[data-uid]').first.click()
        # Unsaved work keeps the ended document present for recovery. Navigating
        # away would let pagehide mask a missing common-end cleanup.
        self.page.locator('#findings').fill('SYN recovery must retain this ended document')
        self.open_drawer(True)
        saved = self.local()
        # Server session-end response exercises the page's existing common end hooks.
        self.site.ended.add(self.site.cookie)
        self.page.route('**/worklist/hpacs-lite/index.html', lambda route: route.fulfill(status=204))
        self.page.locator('#refresh').dispatch_event('click')
        expect(self.page.get_by_role('complementary', name='Study Panel', exact=True, include_hidden=True)).to_have_count(0)
        self.page.set_viewport_size(dict(width=768,height=1024))
        self.page.keyboard.press('Control+Alt+t')
        expect(self.page.get_by_role('complementary', name='Study Panel', exact=True, include_hidden=True)).to_have_count(0)
        self.assertEqual(saved, self.local())

    def test_first_paint_matches_w2_for_empty_v1_and_v2_records(self):
        # D1004 requires identical first paint. This fixed landed-input comparison
        # is a deliberate byte-provenance use; compare visible geometry and pixels.
        current = auth.ROOT
        with tempfile.TemporaryDirectory(prefix='kin-w3-w2-') as temporary:
            raw = subprocess.check_output(['git', 'archive', '--format=zip', '9d4ba0f',
                'worklist-v0/hpacs-lite', 'scripts/main-split-order.json', 'proxy/branding'], cwd=ROOT)
            zipfile.ZipFile(io.BytesIO(raw)).extractall(temporary)
            try:
                for version in (None, 1, 2):
                    for width,height in ((1366,768),(1920,1080),(2560,1440),(900,1200),(768,1024)):
                        facts = []
                        pixels = []
                        for label, asset_root in (('w2', Path(temporary)), ('current', current)):
                            auth.ROOT = asset_root
                            site = WorkspaceSite()
                            context = self.browser.new_context(viewport=dict(width=width,height=height))
                            context.route('**/*', lambda route, request: site.handle(route, request))
                            try:
                                if version:
                                    value = dict(version=version, mode='auto', landscape={'main': 650}, portrait={'main': 310})
                                    if version == 2:
                                        value['reading'] = READING
                                    context.add_init_script('localStorage.setItem('+json.dumps(KEY)+','+json.dumps(json.dumps(value))+')')
                                page = context.new_page()
                                page.goto(auth.MAIN_URL)
                                expect(page.locator('#rows')).to_contain_text(auth.PATIENT)
                                page.evaluate('() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
                                facts.append(page.evaluate("""() => ({focus:document.activeElement.id || document.activeElement.tagName,
                                  panels:['.left','.right','.rw','.related-p','.report-p'].map(s=>{
                                    const r=document.querySelector(s).getBoundingClientRect();return [r.x,r.y,r.width,r.height]}),
                                  toolbar:[...document.querySelectorAll('.menubar input, .userfilter > *')].filter(n=>n.getClientRects().length).map(n=>{
                                    const r=n.getBoundingClientRect();return [n.textContent,n.value,n.checked,r.x,r.y,r.width,r.height]}),
                                  folders:document.querySelector('#worklist-folders-panel').open,
                                  headings:[...document.querySelectorAll('.rw h3')].map(n=>n.textContent)})"""))
                                if (width, height) in ((1920,1080), (900,1200)):
                                    picture_dir = Path(os.environ.get('KIN_W3_PILOT_DIR', ROOT / 'tmp/w3-land/pilot')) / 'first-paint'
                                    picture_dir.mkdir(parents=True, exist_ok=True)
                                    pixels.append(first_paint_pixels(page,
                                        picture_dir / f'{label}-v{version or 0}-{width}x{height}.png'))
                                self.assertEqual([],site.violations)
                            finally:
                                context.close()
                        with self.subTest(version=version, width=width, height=height):
                            self.assertEqual(facts[0],facts[1])
                            if pixels:
                                self.assertTrue(pixels[0] == pixels[1], 'first-paint pixels differ outside the logo/native checkbox')
            finally:
                auth.ROOT = current


if __name__ == '__main__':
    unittest.main()
