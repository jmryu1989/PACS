"""REQ-WS1/WS2/WS7 -> RISK-WS1/WS2/WS7 -> WS1-LAYOUT-ROAM / WS7-RW-RELOCATION.

Serve the real page and dependency assets. Only HTTP answers are synthetic.
Node identity is itself the relocation contract; all other assertions observe
public controls, focus, geometry and stored preferences. No product instrumentation.
"""
import base64
import copy
import io
import json
import os
from pathlib import Path
import re
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
# Landed W2 page (main after PR #164); CI fetches this exact commit.
W2_LANDED = 'a86ecf1655c8c587012cef5fd16e233e121ae7dc'


# W3R-08: a picture or a measurement is taken only after web fonts have loaded and
# every element's box has stayed the same for three consecutive frames (late list,
# observer-driven layout and toast transitions included).
SETTLE = '''async () => {
  await document.fonts.ready;
  const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
  const boxes = () => JSON.stringify([...document.querySelectorAll('body *')].map(node => {
    const box = node.getBoundingClientRect(); return [box.x, box.y, box.width, box.height]; }));
  let last = null, same = 0;
  for (let i = 0; i < 180 && same < 3; i++) { await frame(); const now = boxes(); same = now === last ? same + 1 : 0; last = now; }
  return same >= 3;
}'''
# The worklist list area: what a stacked list needs to show its header and one whole row.
LIST = '''() => { const grid = document.querySelector('.left > .grid'), table = grid.querySelector('table');
  const box = grid.getBoundingClientRect(), row = table.tBodies[0].rows[0];
  return {grid: [box.top, box.bottom], head: table.tHead.getBoundingClientRect().height,
          row: row ? row.getBoundingClientRect().height : null, scrollbar: grid.offsetHeight - grid.clientHeight}; }'''


def settle(page):
    assert page.evaluate(SETTLE), 'layout did not settle'


def cover(page, rects):
    # A test-only box on top of the page at the same viewport rect in both pages;
    # it is then masked like the logo, so both pictures carry the identical mask.
    page.evaluate('''rects => rects.forEach(([x, y, w, h]) => { const box = document.createElement('div');
      box.className = 'kin-test-cover';
      box.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;pointer-events:none`;
      document.documentElement.append(box); })''', rects)


def first_paint_pixels(page, path, clip=None):
    # W3S-03: W2 itself has two native-checkbox raster states after fonts/blur/
    # double-rAF. Playwright masks the element's measured bounding box, never a
    # fixed pixel range. Geometry/checked state remain independently compared.
    checkbox = page.get_by_role('group', name='Status', exact=True).get_by_role('checkbox')
    expect(checkbox).to_have_count(1)
    expect(checkbox).to_be_checked()
    assert checkbox.bounding_box() is not None
    settle(page)
    return page.screenshot(animations='disabled', caret='hide', clip=clip,
        mask=[page.locator('.brand img'), checkbox, page.locator('.kin-test-cover')], path=str(path))


# W3R-08: two pages with identical element geometry still differ by raster
# anti-aliasing on rounded edges (measured: at most 7/255 per channel, on edges in
# one 256 px tile column; each tree alone reproduces its own picture exactly).
# Pixels count as different above 16/255 in any channel; a 1 px move of a border
# or a glyph differs by far more and fails.
ANTIALIAS = 16
COMPARE = '''async ([a, b, tolerance]) => {
  const load = src => new Promise((resolve, reject) => { const img = new Image();
    img.onload = () => resolve(img); img.onerror = reject; img.src = 'data:image/png;base64,' + src; });
  const [x, y] = await Promise.all([load(a), load(b)]);
  if (x.width !== y.width || x.height !== y.height) return {size: [x.width, x.height, y.width, y.height]};
  const data = img => { const canvas = new OffscreenCanvas(img.width, img.height), g = canvas.getContext('2d');
    g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height).data; };
  const p = data(x), q = data(y); let over = 0, max = 0;
  for (let i = 0; i < p.length; i += 4) {
    const d = Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2]));
    if (d > max) max = d;
    if (d > tolerance) over++;
  }
  return {over, max};
}'''


def picture_difference(browser, a, b):
    """Pixels whose largest channel difference exceeds ANTIALIAS, and the largest difference."""
    context = browser.new_context()
    try:
        return context.new_page().evaluate(COMPARE, [base64.b64encode(a).decode(), base64.b64encode(b).decode(), ANTIALIAS])
    finally:
        context.close()


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

    def assert_drawer_place(self, page, width, height):
        """D1041: LEFT 12/360 px beside the report in wide landscape windows; the approved
        bottom panel (4-①) in stacked portrait layouts at any width and up to 1100 px."""
        drawer = page.get_by_role('complementary', name='Study Panel', exact=True)
        box = drawer.bounding_box()
        self.assertGreaterEqual(box['x'], 0)
        self.assertLessEqual(box['x'] + box['width'], width + 0.5)
        self.assertLessEqual(box['y'] + box['height'], height + 0.5)
        expect(drawer.get_by_role('button', name='Close', exact=True)).to_be_in_viewport()
        self.assertAlmostEqual(12, box['x'], delta=1)
        if width <= 1100 or height > width:
            self.assertAlmostEqual(width - 24, box['width'], delta=1)
            self.assertAlmostEqual(height - 12, box['y'] + box['height'], delta=1)
            self.assertAlmostEqual(height * .55, box['height'], delta=1)
        else:
            self.assertAlmostEqual(360, box['width'], delta=1)
            report = page.locator('.report-p').bounding_box()
            self.assertLessEqual(box['x'] + box['width'], report['x'])
        return box

    def test_drawer_geometries_and_pilot_pictures(self):
        self.boot()
        self.page.locator('#rows tr[data-uid]').first.click()
        pictures = Path(os.environ.get('KIN_W3_PILOT_DIR', ROOT / 'tmp/w3-land/pilot'))
        pictures.mkdir(parents=True, exist_ok=True)
        # W3R-01: portrait screens wider than 1100 px (medical portrait monitors)
        # get the same bottom panel as 900x1200, never the landscape left column.
        for width, height in ((1920,1080), (900,1200), (1366,768), (2560,1440), (768,1024), (640,480), (900,768), (1024,768),
                              (1200,1920), (1440,2560), (1536,2048), (1080,1920)):
            self.page.set_viewport_size(dict(width=width, height=height))
            settle(self.page)
            prefix = f'{width}x{height}'
            if width in (1920,900,1200):
                self.page.screenshot(path=str(pictures/(prefix+'-closed.png')))
            self.open_drawer()
            for name in ('Images','Info','Templates'):
                self.drawer().get_by_role('tab', name=name, exact=True).click()
                with self.subTest(width=width, height=height, tab=name):
                    self.assert_drawer_place(self.page, width, height)
                if width in (1920,900,1200):
                    self.page.screenshot(path=str(pictures/(prefix+'-'+name.lower()+'.png')))
            self.page.keyboard.press('Escape')
            if height == 768 and 900 <= width <= 1100:
                expect(self.page.get_by_role('navigation', name='Study Panel', exact=True)).to_be_hidden()
        self.page.set_viewport_size(dict(width=840,height=768))
        strip = self.page.get_by_role('navigation', name='Study Panel', exact=True)
        expect(strip).to_be_in_viewport()
        strip.get_by_role('button', name='Info', exact=True).click()
        expect(self.drawer().get_by_role('tab', name='Info', exact=True)).to_have_attribute('aria-selected', 'true')
        self.page.keyboard.press('Escape')
        # A tall portrait has room for a resizable context panel. Only short
        # narrow landscapes compact it; the portrait pilot retains manual sizes.
        # (At 768x1024 the W3R-09 list floor and D383's prior-report line leave
        # the band at its 140 px minimum, so the pilot's 900x1200 is used here.)
        self.page.set_viewport_size(dict(width=900,height=1200))
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

    def test_browser_zoom_keeps_drawer_in_view(self):
        """W3R-02: browser zoom (Ctrl +) gives a CSS-pixel viewport with a device
        scale factor; 200 % and 150 % of 1920x1080 and 125 % of 1366x768."""
        for width, height, scale in ((960, 540, 2), (1280, 720, 1.5), (1093, 614, 1.25)):
            with self.subTest(width=width, height=height, scale=scale):
                site = WorkspaceSite()
                context = self.browser.new_context(viewport=dict(width=width, height=height), device_scale_factor=scale)
                context.route('**/*', lambda route, request: site.handle(route, request))
                try:
                    page = context.new_page()
                    errors = []
                    page.on('pageerror', lambda e: errors.append(str(e)))
                    page.goto(auth.MAIN_URL)
                    expect(page.locator('#rows')).to_contain_text(auth.PATIENT)
                    self.assertEqual(scale, page.evaluate('devicePixelRatio'))
                    # Keyboard selection: a short window's list header can cover the row.
                    page.locator('#rows tr[data-uid]').first.focus()
                    page.keyboard.press('Enter')
                    expect(page.locator('#rows tr[data-uid]').first).to_have_class(re.compile(r'\bsel\b'))
                    page.keyboard.press('Control+Alt+5')
                    expect(page.get_by_role('complementary', name='Study Panel', exact=True)).to_be_visible()
                    settle(page)
                    self.assert_drawer_place(page, width, height)
                    page.keyboard.press('Escape')
                    expect(page.get_by_role('complementary', name='Study Panel', exact=True)).to_have_count(0)
                    self.assertEqual([], errors)
                    self.assertEqual([], site.violations)
                finally:
                    context.close()

    def test_selection_settles_layout_before_drawer_open(self):
        """W3R-03: the Study Panel strip (stacked, <= 1100 px), the narrow stacking
        (landscape < 900 px) and the row floors follow the selected study when it is
        selected; opening and closing the drawer then moves no panel."""
        geometry = """() => ({classes: ['portrait', 'workspace-strip', 'workspace-narrow'].filter(c => document.body.classList.contains(c)),
          panels: ['.menubar', '.left', '.right', '.rw', '.related-p', '.related-list-pane', '.report-p', '.study-panel-strip'].map(s => {
            const node = document.querySelector(s), box = node.getBoundingClientRect();
            return [s, getComputedStyle(node).display, box.x, box.y, box.width, box.height]; }),
          scroll: [document.querySelector('.right').scrollTop, document.querySelector('.split').scrollTop]})"""
        for width, height in ((900, 1200), (768, 1024), (1080, 1920), (840, 768)):
            with self.subTest(width=width, height=height):
                site = WorkspaceSite()
                context = self.browser.new_context(viewport=dict(width=width, height=height))
                context.route('**/*', lambda route, request: site.handle(route, request))
                try:
                    page = context.new_page()
                    page.goto(auth.MAIN_URL)
                    expect(page.locator('#rows')).to_contain_text(auth.PATIENT)
                    settle(page)
                    unselected = page.evaluate(geometry)
                    row = page.locator('#rows tr[data-uid]').first
                    if height > width:
                        row.click()  # W3R-09 keeps the row reachable by mouse in stacked layouts
                    else:
                        row.focus(); page.keyboard.press('Enter')
                    expect(row).to_have_class(re.compile(r'\bsel\b'))
                    settle(page)
                    selected = page.evaluate(geometry)
                    if height > width and width <= 1100:
                        self.assertNotIn('workspace-strip', unselected['classes'])
                        self.assertIn('workspace-strip', selected['classes'])
                        expect(page.get_by_role('navigation', name='Study Panel', exact=True)).to_be_in_viewport()
                    if width < 900 and height <= width:
                        self.assertNotIn('portrait', unselected['classes'])
                        self.assertIn('portrait', selected['classes'])
                        self.assertIn('workspace-narrow', selected['classes'])
                    page.keyboard.press('Control+Alt+5')
                    expect(page.get_by_role('complementary', name='Study Panel', exact=True)).to_be_visible()
                    settle(page)
                    self.assertEqual(selected, page.evaluate(geometry), 'opening the drawer moved a panel')
                    page.keyboard.press('Escape')
                    expect(page.get_by_role('complementary', name='Study Panel', exact=True)).to_have_count(0)
                    settle(page)
                    self.assertEqual(selected, page.evaluate(geometry), 'closing the drawer moved a panel')
                    self.assertEqual([], site.violations)
                finally:
                    context.close()

    def test_stacked_list_shows_header_and_one_whole_row(self):
        """W3R-09: at portrait widths whose wrapped list controls left 17 px (or less)
        of the first row, the stacked list keeps its header and one whole row, and a
        click on that row's centre selects it."""
        for width, height in ((768, 1024), (800, 1024), (834, 1112), (900, 1200), (768, 1366)):
            with self.subTest(width=width, height=height):
                site = WorkspaceSite()
                context = self.browser.new_context(viewport=dict(width=width, height=height))
                context.route('**/*', lambda route, request: site.handle(route, request))
                try:
                    page = context.new_page()
                    page.goto(auth.MAIN_URL)
                    expect(page.locator('#rows')).to_contain_text(auth.PATIENT)
                    settle(page)
                    self.assertIn('portrait', page.evaluate('document.body.className'))
                    area = page.evaluate(LIST)
                    self.assertGreaterEqual(area['grid'][1] - area['grid'][0] + 0.5, area['head'] + area['row'] + area['scrollbar'])
                    row = page.locator('#rows tr[data-uid]').first
                    box = row.bounding_box()
                    self.assertLessEqual(box['y'] + box['height'], area['grid'][1] + 0.5)
                    hit = page.evaluate('([x, y]) => !!document.elementFromPoint(x, y)?.closest("#rows tr[data-uid]")',
                                        [box['x'] + min(box['width'], width - box['x']) / 2, box['y'] + box['height'] / 2])
                    self.assertTrue(hit)
                    row.click()
                    expect(row).to_have_class(re.compile(r'\bsel\b'))
                    self.assertEqual([], site.violations)
                finally:
                    context.close()

    def test_sizes_stay_with_their_orientation(self):
        """W3R-07: a size is applied only in the orientation it was set in. A landscape
        worklist width never becomes a portrait height (and back); v3 records written
        by earlier W3 builds carry an orientation-free copy, which is not applied."""
        self.page.set_viewport_size(dict(width=900, height=1200))
        self.boot()
        settle(self.page)
        portrait_default = self.page.locator('.left').bounding_box()['height']
        self.page.set_viewport_size(dict(width=1600, height=1000))
        settle(self.page)
        landscape_default = self.page.locator('.left').bounding_box()['width']
        main = self.page.locator('#resize-main')
        main.focus()
        for _ in range(4):
            self.page.keyboard.press('Shift+ArrowRight')
        width = self.page.locator('.left').bounding_box()['width']
        self.assertGreater(width, landscape_default + 100)
        related = self.page.locator('.related-p').bounding_box()['width']
        stored = self.local()
        self.assertEqual(round(width), stored['landscape']['main'])
        self.assertEqual({}, stored['portrait'])
        self.assertEqual([None, None, None], [stored['workspace'][k] for k in ('worklist', 'related', 'prior')])
        self.page.set_viewport_size(dict(width=900, height=1200))
        settle(self.page)
        self.assertAlmostEqual(portrait_default, self.page.locator('.left').bounding_box()['height'], delta=1)
        main.focus()
        self.page.keyboard.press('Shift+ArrowDown')
        tall = self.page.locator('.left').bounding_box()['height']
        self.assertGreater(tall, portrait_default + 20)
        stored = self.local()
        self.assertEqual(round(tall), stored['portrait']['main'])
        self.assertEqual(round(width), stored['landscape']['main'])
        self.page.set_viewport_size(dict(width=1600, height=1000))
        settle(self.page)
        self.assertAlmostEqual(width, self.page.locator('.left').bounding_box()['width'], delta=1)
        self.page.reload()
        expect(self.page.locator('#rows')).to_contain_text(auth.PATIENT)
        settle(self.page)
        self.assertAlmostEqual(width, self.page.locator('.left').bounding_box()['width'], delta=1)
        self.assertAlmostEqual(related, self.page.locator('.related-p').bounding_box()['width'], delta=1)
        # An earlier W3 build wrote the landscape width into the shared field too.
        earlier = dict(version=3, mode='auto', portrait={}, landscape={'main': 767}, reading=READING,
                       workspace=dict(version=1, rail=None, worklist=767, related=None, prior=None,
                                      railCollapsed=False, studyPanelTab='info'))
        self.page.evaluate('([k, v]) => localStorage.setItem(k, JSON.stringify(v))', [KEY, earlier])
        self.page.set_viewport_size(dict(width=900, height=1200))
        self.page.reload()
        expect(self.page.locator('#rows')).to_contain_text(auth.PATIENT)
        settle(self.page)
        self.assertAlmostEqual(portrait_default, self.page.locator('.left').bounding_box()['height'], delta=1)
        self.open_drawer()
        self.drawer().get_by_role('tab', name='Images', exact=True).click()
        self.page.keyboard.press('Escape')
        stored = self.local()
        self.assertEqual({'main': 767}, stored['landscape'])
        self.assertIsNone(stored['workspace']['worklist'])

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
        # D1041 6-②: the landed W2 opens Folders on every login; the drawer
        # opens beside an already open Folders panel (no click closes it).
        expect(self.page.get_by_role('button', name='Folders', exact=True)).to_have_attribute('aria-expanded', 'true')
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
        # D1041 6-②: Folders is open on login (landed W2), so its rail is
        # reachable without a click; a click here would close the panel.
        folders = self.page.get_by_role('button', name='Folders', exact=True)
        expect(folders).to_have_attribute('aria-expanded', 'true')
        rail = self.page.get_by_role('separator', name='폴더 너비 조절', exact=True)
        rail.focus()
        self.page.keyboard.press('ArrowRight')
        self.assertIsInstance(self.local()['workspace']['rail'], int)
        self.page.get_by_role('button', name='Rail', exact=True).click()
        self.assertTrue(self.local()['workspace']['railCollapsed'])
        self.page.reload()
        expect(self.page.locator('#rows')).to_contain_text(auth.PATIENT)
        # Same login: W2 keeps the never-closed panel open; W3 restores the
        # collapsed rail from the v3 record.
        expect(folders).to_have_attribute('aria-expanded', 'true')
        expect(self.page.get_by_role('button', name='Rail', exact=True)).to_have_attribute('aria-expanded', 'false')

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

    def first_paint(self, asset_root, version, width, height, rail=None, picture=None, clip=None):
        """Serve one tree at one size; return its first-paint facts, list area, Rail box and picture."""
        auth.ROOT = asset_root
        site = WorkspaceSite()
        context = self.browser.new_context(viewport=dict(width=width, height=height))
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
            settle(page)
            facts = page.evaluate("""() => ({focus:document.activeElement.id || document.activeElement.tagName,
              panels:['.left','.right','.rw','.related-p','.report-p'].map(s=>{
                const r=document.querySelector(s).getBoundingClientRect();return [r.x,r.y,r.width,r.height]}),
              toolbar:[...document.querySelectorAll('.menubar input, .userfilter > *')].filter(n=>n.getClientRects().length).map(n=>{
                const r=n.getBoundingClientRect();return [n.textContent,n.value,n.checked,r.x,r.y,r.width,r.height]}),
              folders:document.querySelector('#worklist-folders-panel').open,
              headings:[...document.querySelectorAll('.rw h3')].map(n=>n.textContent)})""")
            area = page.evaluate(LIST)
            control = page.get_by_role('button', name='Rail', exact=True)
            box = control.bounding_box() if control.count() else None
            pixels = None
            if picture:
                cover(page, [rail])
                pixels = first_paint_pixels(page, picture, clip(area) if callable(clip) else clip)
            self.assertEqual([], site.violations)
            return facts, area, box and [box['x'], box['y'], box['width'], box['height']], pixels
        finally:
            context.close()

    def test_first_paint_matches_w2_for_empty_v1_and_v2_records(self):
        # D1004 requires identical first paint. This fixed landed-input comparison
        # is a deliberate byte-provenance use; compare visible geometry and pixels.
        # The baseline is the landed W2 (main a86ecf1, PR #164): D1041 6-② made
        # W2 open Folders on every login, so W2's own first paint changed by
        # decision after the earlier W2 input 9d4ba0f. Two decided differences:
        # - W3's Rail control shows in that open panel's title row; its measured
        #   box is masked in both pictures (the folder tree keeps W2's place).
        # - W3R-09: where W2's stacked list cannot show its header and one whole
        #   row, W3's list grows by exactly the missing height. Toolbar, focus,
        #   Folders and the list's place stay W2's, the work area below moves down
        #   by that height, and the pictures are identical above W2's list bottom.
        current = auth.ROOT
        pictures = Path(os.environ.get('KIN_W3_PILOT_DIR', ROOT / 'tmp/w3-land/pilot')) / 'first-paint'
        pictures.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='kin-w3-w2-') as temporary:
            raw = subprocess.check_output(['git', 'archive', '--format=zip', W2_LANDED,
                'worklist-v0/hpacs-lite', 'scripts/main-split-order.json', 'proxy/branding'], cwd=ROOT)
            zipfile.ZipFile(io.BytesIO(raw)).extractall(temporary)
            try:
                for version in (None, 1, 2):
                    for width, height in ((1366,768),(1920,1080),(2560,1440),(900,1200),(768,1024),(1080,1920)):
                        mine, area, rail, _ = self.first_paint(current, version, width, height)
                        self.assertIsNotNone(rail)
                        name = f'v{version or 0}-{width}x{height}.png'
                        picture = (width, height) in ((1920,1080), (900,1200), (1080,1920))
                        lacking = lambda a: a['head'] + a['row'] + a['scrollbar'] - (a['grid'][1] - a['grid'][0])
                        clip = lambda a: dict(x=0, y=0, width=width, height=a['grid'][1]) if lacking(a) > 0.5 else None
                        w2, w2_area, w2_rail, w2_pixels = self.first_paint(Path(temporary), version, width, height, rail,
                            pictures / ('w2-' + name) if picture else None, clip)
                        self.assertIsNone(w2_rail)
                        missing = lacking(w2_area)
                        if picture:
                            again, _, _, pixels = self.first_paint(current, version, width, height, rail,
                                pictures / ('current-' + name), clip(w2_area))
                            self.assertEqual(mine, again)
                        difference = picture_difference(self.browser, w2_pixels, pixels) if picture else None
                        with self.subTest(version=version, width=width, height=height, pixels=difference):
                            if missing <= 0.5:
                                self.assertEqual(w2, mine)
                                if picture:
                                    self.assertEqual(0, difference.get('over'), 'first-paint pixels differ outside the logo/native checkbox/Rail')
                                continue
                            self.assertGreater(height, width, 'only a stacked list grows')
                            need = area['head'] + area['row'] + area['scrollbar']
                            self.assertAlmostEqual(need, area['grid'][1] - area['grid'][0], delta=1)
                            grown = mine['panels'][0][3] - w2['panels'][0][3]
                            self.assertAlmostEqual(missing, grown, delta=1)
                            for key in ('focus', 'toolbar', 'folders', 'headings'):
                                self.assertEqual(w2[key], mine[key], key)
                            self.assertEqual(w2['panels'][0][:3], mine['panels'][0][:3])
                            self.assertAlmostEqual(w2['panels'][1][1] + grown, mine['panels'][1][1], delta=0.01)
                            if picture:
                                self.assertEqual(0, difference.get('over'), 'first-paint pixels differ above the list bottom')
            finally:
                auth.ROOT = current


if __name__ == '__main__':
    unittest.main()
