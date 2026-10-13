"""REQ-WS1/WS2/WS7 -> RISK-WS1/WS2/WS7 -> WS1-LAYOUT-ROAM / WS7-RW-RELOCATION.

Serve the real page and dependency assets. Only HTTP answers are synthetic.
Node identity is itself the relocation contract; all other assertions observe
public controls, focus, geometry and stored preferences. No product instrumentation.
"""
import base64
import copy
import io
import json
import math
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
# Landed W2 page: main after PR #164 (W2-LAND) and PR #168 (W2-FU, whose footer
# counts wrap between items with Folders open); CI fetches this exact commit.
W2_LANDED = '9d6984b1ba3af76f7522b1c6d6179c398c513b57'


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
# First-paint landmarks and how each may move where W3's stacked list grows (W3R5-04):
# grow = the list column (and the Folders rail spanning it); below-list = the separator
# under it; work-area = the area below, which gives up that height; band = the report
# window band (it may also yield); below-band = everything under the band, moved only.
PANELS = [('.left', 'grow'), ('#worklist-folders-panel', 'grow'), ('#resize-main', 'below-list'), ('.right', 'work-area'),
          ('.rw', 'band'), ('#resize-top', 'below-band'), ('.workrow', 'below-band'), ('.related-p', 'below-band'),
          ('.related-list-pane', 'below-band'), ('.prior-report-pane', 'below-band'), ('.report-p', 'below-band'),
          ('.rbtns', 'below-band'), ('#findings', 'below-band'), ('#conclusion', 'below-band')]
# The worklist list area: what a stacked list needs to show its header and one whole row.
LIST = '''() => { const grid = document.querySelector('.left > .grid'), table = grid.querySelector('table');
  const box = grid.getBoundingClientRect(), row = table.tBodies[0].rows[0];
  return {grid: [box.top, box.bottom], head: table.tHead.getBoundingClientRect().height,
          row: row ? row.getBoundingClientRect().height : null, scrollbar: grid.offsetHeight - grid.clientHeight}; }'''


# W3R5-01/02: what a reader sees of the worklist. A box is cut by every ancestor
# that clips (the list, a scrolling list column, the work area) and by the window;
# a row is "whole" when nothing of it is cut and it lies below the sticky header.
# "hit": the centre of its visible part reaches the row. "point": the centre of its
# widest visible plain cell (a click on a control in the row runs that control).
VISIBLE = '''(() => {
  const clip = (node, r) => { r = {top: r.top, bottom: r.bottom, left: r.left, right: r.right};
    for (let e = node.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const c = e.getBoundingClientRect(), top = c.top + e.clientTop, left = c.left + e.clientLeft;
      r = {top: Math.max(r.top, top), bottom: Math.min(r.bottom, top + e.clientHeight),
           left: Math.max(r.left, left), right: Math.min(r.right, left + e.clientWidth)}; }
    return {top: Math.max(r.top, 0), bottom: Math.min(r.bottom, innerHeight), left: Math.max(r.left, 0), right: Math.min(r.right, innerWidth)}; };
  const seen = (node, r = node.getBoundingClientRect()) => { const v = clip(node, r);
    return {box: [r.left, r.top, r.width, r.height], visible: [v.left, v.top, Math.max(0, v.right - v.left), Math.max(0, v.bottom - v.top)],
            whole: v.top <= r.top + 0.5 && v.bottom >= r.bottom - 0.5 && v.right > v.left && v.bottom > v.top}; };
  return {clip, seen};
})()'''
ROWS = '''(count) => { const {clip, seen} = ''' + VISIBLE + ''';
  // The header cells are sticky inside the list; the thead box itself scrolls away.
  const grid = document.querySelector('.left > .grid'), cells = [...grid.querySelectorAll('thead th')].map(th => th.getBoundingClientRect()).filter(r => r.width && r.height);
  const head = {top: Math.min(...cells.map(r => r.top)), bottom: Math.max(...cells.map(r => r.bottom)), left: Math.min(...cells.map(r => r.left)), right: Math.max(...cells.map(r => r.right))};
  return {head: seen(grid.querySelector('thead th'), {...head, width: head.right - head.left, height: head.bottom - head.top}), rows: [...document.querySelectorAll('#rows tr[data-uid]')].slice(0, count).map(row => {
    const r = row.getBoundingClientRect(), v = clip(row, r), fact = seen(row);
    fact.whole = fact.whole && r.top >= head.bottom - 0.5;
    const at = (x, y) => document.elementFromPoint(x, y)?.closest('tr') === row;
    const y = Math.max(v.top, head.bottom) / 2 + Math.min(v.bottom, r.bottom) / 2;
    fact.hit = v.right > v.left && v.bottom > Math.max(v.top, head.bottom) && at((v.left + v.right) / 2, y);
    fact.shown = Math.max(0, Math.min(v.bottom, r.bottom) - Math.max(v.top, head.bottom));
    const cells = [...row.cells].filter(c => !c.querySelector('button, a, input, select, label, textarea')).map(c => {
      const b = c.getBoundingClientRect(); return [Math.max(b.left, v.left), Math.min(b.right, v.right)]; })
      .filter(([a, z]) => z - a >= 8).sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]));
    fact.point = cells.length ? [(cells[0][0] + cells[0][1]) / 2, y] : null;
    fact.point_hit = !!fact.point && at(...fact.point);
    fact.selected = row.classList.contains('sel');
    return fact; })}; }'''
# D383 in the same page: the Related list's header and the first text line of the
# prior report pane (at least 8 px of it, T8) are in view together with the list.
RELATED = '''() => { const {clip, seen} = ''' + VISIBLE + ''';
  const body = document.querySelector('.prior-report-body'), walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let text = walker.nextNode(); while (text && !text.nodeValue.trim()) text = walker.nextNode();
  const range = document.createRange(); range.selectNodeContents(text); const line = range.getClientRects()[0], v = clip(text, line);
  return {head: seen(document.querySelector('.related-list-pane thead')), line: text.nodeValue.trim().slice(0, 40), line_visible: v.bottom - v.top}; }'''


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
# Regions [x, width, y in a, y in b, height]: the same columns of the two pictures,
# each region of b compared with the region of a it was moved from (W3R5-04).
COMPARE = '''async ([a, b, tolerance, regions]) => {
  const load = src => new Promise((resolve, reject) => { const img = new Image();
    img.onload = () => resolve(img); img.onerror = reject; img.src = 'data:image/png;base64,' + src; });
  const [x, y] = await Promise.all([load(a), load(b)]);
  if (x.width !== y.width || x.height !== y.height) return [{size: [x.width, x.height, y.width, y.height]}];
  const data = img => { const canvas = new OffscreenCanvas(img.width, img.height), g = canvas.getContext('2d');
    g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height).data; };
  const p = data(x), q = data(y), w = x.width;
  return (regions || [[0, w, 0, 0, x.height]]).map(([left, width, ya, yb, height]) => {
    if (left < 0 || width <= 0 || height < 0 || left + width > w || ya < 0 || yb < 0 || ya + height > x.height || yb + height > y.height)
      return {region: [left, width, ya, yb, height], outside: true};
    let over = 0, max = 0;
    for (let r = 0; r < height; r++) for (let c = left; c < left + width; c++) {
      const i = ((ya + r) * w + c) * 4, j = ((yb + r) * w + c) * 4;
      const d = Math.max(Math.abs(p[i] - q[j]), Math.abs(p[i + 1] - q[j + 1]), Math.abs(p[i + 2] - q[j + 2]));
      if (d > max) max = d;
      if (d > tolerance) over++;
    }
    return {region: [left, width, ya, yb, height], over, max}; });
}'''


def picture_difference(browser, a, b, regions=None):
    """Per region: pixels whose largest channel difference exceeds ANTIALIAS, and the largest difference."""
    context = browser.new_context()
    try:
        return context.new_page().evaluate(COMPARE, [base64.b64encode(a).decode(), base64.b64encode(b).decode(), ANTIALIAS, regions])
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

    def assert_report_usable(self, page, what):
        """W3R5-03 ②: with the panel open, the report's buttons and fields keep every
        visible pixel and stay on top: nothing of Approve/Save/Prelim, Findings or
        Conclusion that a reader saw before is under the panel."""
        facts = page.evaluate('''(names) => { const {seen} = ''' + VISIBLE + ''';
          const panel = document.querySelector('#study-panel-host .study-panel')?.getBoundingClientRect();
          return names.map(s => { const node = document.querySelector(s); if (!node || !node.getClientRects().length) return [s, null];
            const fact = seen(node), [x, y, w, h] = fact.visible;
            const covered = !!panel && w > 0 && h > 0 && x < panel.right && x + w > panel.left && y < panel.bottom && y + h > panel.top;
            const points = w > 0 && h > 0 ? [[x + 2, y + 2], [x + w - 2, y + 2], [x + w / 2, y + h / 2], [x + 2, y + h - 2], [x + w - 2, y + h - 2]] : [];
            return [s, {...fact, covered, on_top: points.every(([px, py]) => { const hit = document.elementFromPoint(px, py); return hit === node || node.contains(hit); })}]; }); }''',
            ['#b-approve', '#b-save', '#b-prelim', '#findings', '#conclusion'])
        for name, fact in facts:
            if fact is None or fact['visible'][3] <= 0:
                continue
            self.assertFalse(fact['covered'], f'{what}: {name} under the open panel {fact}')
            self.assertTrue(fact['on_top'], f'{what}: {name} not on top {fact}')
        return dict(facts)

    def assert_drawer_place(self, page, width, height):
        """D1041: LEFT 12/360 px beside the report in wide landscape windows. Stacked
        portrait layouts at any width, and windows up to 1100 px, expand it across the
        window (4-①) over the work area above the report section, 12 px above it
        (W3R5-03 ②: the report's buttons and fields stay visible and usable)."""
        drawer = page.get_by_role('complementary', name='Study Panel', exact=True)
        box = drawer.bounding_box()
        self.assertGreaterEqual(box['x'], 0)
        self.assertLessEqual(box['x'] + box['width'], width + 0.5)
        self.assertLessEqual(box['y'] + box['height'], height + 0.5)
        expect(drawer.get_by_role('button', name='Close', exact=True)).to_be_in_viewport()
        self.assertAlmostEqual(12, box['x'], delta=1)
        if width <= 1100 or height > width:
            area, report = page.locator('.split').bounding_box(), page.locator('.report-p').bounding_box()
            self.assertAlmostEqual(max(0, area['y']), box['y'], delta=1)
            bottom = min(report['y'], area['y'] + area['height'], height) - 12
            if bottom - box['y'] < 240 and report['x'] - 24 >= 240:
                # Too little room above a report column: the column left of the report.
                self.assertAlmostEqual(report['x'] - 24, box['width'], delta=1)
                self.assertAlmostEqual(min(area['y'] + area['height'], height) - 12, box['y'] + box['height'], delta=1)
            else:
                self.assertAlmostEqual(width - 24, box['width'], delta=1)
                if bottom - box['y'] >= 120:
                    self.assertAlmostEqual(min(bottom - box['y'], height * .55), box['height'], delta=1)
        else:
            self.assertAlmostEqual(360, box['width'], delta=1)
            report = page.locator('.report-p').bounding_box()
            self.assertLessEqual(box['x'] + box['width'], report['x'])
        self.assert_report_usable(page, f'{width}x{height}')
        return box

    def test_reading_workspace_panel_leaves_report_usable(self):
        """W3R5-03 ② in the Reading Workspace: the panel opened from 'Study Info & Templates'
        covers the image area, never the report (wide: 360 px left; a short side-by-side
        window: the column left of the report; stacked: above the report)."""
        for width, height in ((1920, 1080), (1024, 768), (900, 1200)):
            with self.subTest(width=width, height=height):
                page, _, _ = self.page_at(width, height)
                page.route('**/ohif/**', lambda route: route.fulfill(content_type='text/html', body='<!doctype html><title>SYN viewer</title>'))
                self.click_row(page, 0, 'select')
                page.get_by_role('button', name='Reading Workspace', exact=True).click()
                opener = page.get_by_role('button', name='Study Info & Templates', exact=True)
                expect(opener).to_be_visible()
                settle(page)
                closed = self.assert_report_usable(page, 'reading, closed')
                opener.click()
                expect(page.get_by_role('complementary', name='Study Panel', exact=True)).to_be_visible()
                settle(page)
                self.assert_drawer_place(page, width, height)
                opened = self.assert_report_usable(page, 'reading, open')
                for name, fact in closed.items():
                    if fact:
                        self.assertEqual(fact['visible'], opened[name]['visible'], f'{name} visible part changed')
                page.keyboard.press('Escape')
                expect(opener).to_be_focused()
                self.doCleanups()

    def test_open_panel_keeps_report_buttons_and_fields_usable(self):
        """W3R5-03 ② / W3R-01: at 1200x1920 (and the other portrait monitors, the
        pilot's 900x1200 and short windows up to 1100 px) the open panel leaves
        Approve/Save/Prelim and Findings/Conclusion as visible and clickable as with
        it closed; where the report is below the window, the panel follows it up as
        the work area scrolls, so the report never slides under it."""
        for width, height in ((1200, 1920), (1440, 2560), (1536, 2048), (1080, 1920), (900, 1200), (768, 1024), (1024, 768), (900, 768)):
            with self.subTest(width=width, height=height):
                page, _, _ = self.page_at(width, height)
                self.click_row(page, 0, 'select')
                closed = self.assert_report_usable(page, 'closed')
                page.keyboard.press('Control+Alt+5')
                expect(page.get_by_role('complementary', name='Study Panel', exact=True)).to_be_visible()
                settle(page)
                self.assert_drawer_place(page, width, height)
                opened = self.assert_report_usable(page, 'open')
                for name, fact in closed.items():
                    if fact:
                        self.assertEqual(fact['visible'], opened[name]['visible'], f'{name} visible part changed')
                if width >= 1080 and height >= 1920:
                    for name in ('#b-approve', '#b-save', '#findings', '#conclusion'):
                        self.assertTrue(opened[name]['whole'], f'{name} whole in view with the panel open')
                # Where the report starts low in the window, the reader turns the wheel over
                # the work area below the panel until the buttons and the start of Findings
                # are in view; the panel follows the report up and never covers it.
                # (In the 180 px portrait report section of 900x1200 and 768x1024 the report
                # editor itself is squeezed by the panels below it, on main as well; the
                # fields' own visibility there is not this panel's to change.)
                for _ in range(24):
                    now = self.assert_report_usable(page, 'scrolling to the report')
                    if now['#b-approve']['whole'] and now['#b-save']['whole']:
                        break
                    panel = page.get_by_role('complementary', name='Study Panel', exact=True).bounding_box()
                    report = page.locator('.report-p').bounding_box()
                    page.mouse.move(width - 30, (panel['y'] + panel['height'] + min(report['y'], height)) / 2)
                    page.mouse.wheel(0, 60)
                    settle(page)
                self.assert_drawer_place(page, width, height)
                scrolled = self.assert_report_usable(page, 'scrolled to the report')
                for name in ('#b-approve', '#b-save'):
                    self.assertTrue(scrolled[name]['whole'], f'{name} whole after scrolling to the report {scrolled[name]}')
                page.keyboard.press('Escape')
                expect(page.get_by_role('complementary', name='Study Panel', exact=True)).to_have_count(0)
                self.doCleanups()

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
                    # W3R5-01: the zoomed window's list keeps its header and one whole row.
                    settle(page)
                    self.click_row(page, 0, f'{scale:g}x zoom')
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
                    # W3R-09 / W3R5-01: a reader clicks the row where it is seen, at every size.
                    self.click_row(page, 0, f'{width}x{height}')
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

    def page_at(self, width, height, studies=2):
        """A fresh login at one window size serving one or two studies; returns (page, site, context)."""
        site = WorkspaceSite()
        site.second_study = studies > 1
        context = self.browser.new_context(viewport=dict(width=width, height=height))
        context.route('**/*', lambda route, request: site.handle(route, request))
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        self.addCleanup(lambda: self.assertEqual([], errors))
        self.addCleanup(lambda: self.assertEqual([], site.violations))
        page.goto(auth.MAIN_URL)
        expect(page.locator('#rows tr[data-uid]')).to_have_count(studies)
        settle(page)
        return page, site, context

    def assert_row_in_view(self, page, index, what):
        facts = page.evaluate(ROWS, index + 1)
        self.assertTrue(facts['head']['whole'], f'{what}: list header in view {facts["head"]}')
        row = facts['rows'][index]
        self.assertTrue(row['whole'], f'{what}: row {index} whole in view {row}')
        self.assertTrue(row['hit'] and row['point_hit'], f'{what}: row {index} on top {row}')
        return row

    def click_row(self, page, index, what):
        """A reader's click on the row where it is seen (no scrolling by the test)."""
        row = self.assert_row_in_view(page, index, what)
        page.mouse.click(*row['point'])
        expect(page.locator('#rows tr[data-uid]').nth(index)).to_have_class(re.compile(r'\bsel\b'))
        settle(page)
        # The document itself never scrolls: a reader could not scroll it back.
        self.assertEqual([0, 0], page.evaluate("() => [document.scrollingElement.scrollTop, document.querySelector('.split').scrollTop]"))

    def wheel_row_into_view(self, page, index, what):
        """The next study: the wheel over the list brings it under the pointer and a click
        on it selects it. A list that holds exactly its header and one row shows the
        next row at the end of its scroll at most 2 px under the sticky header."""
        last = None
        for _ in range(12):
            row = page.evaluate(ROWS, index + 1)['rows'][index]
            if row['whole'] or row['shown'] >= row['box'][3] - 2:
                break
            spot = page.evaluate("() => { const g = document.querySelector('.left > .grid'); return [g.scrollTop, document.querySelector('.left').scrollTop]; }")
            if spot == last:
                break
            last = spot
            grid = page.evaluate("() => { const r = document.querySelector('.left > .grid').getBoundingClientRect(); return [r.left + 30, r.top + r.height / 2]; }")
            page.mouse.move(*grid)
            page.mouse.wheel(0, 40)
            settle(page)
        self.assertTrue(row['point_hit'] and row['hit'] and row['shown'] >= row['box'][3] - 2,
                        f'{what}: the wheel did not bring row {index} into view {row}')
        page.mouse.click(*row['point'])
        expect(page.locator('#rows tr[data-uid]').nth(index)).to_have_class(re.compile(r'\bsel\b'))
        settle(page)

    def assert_column_controls_reachable(self, page, what):
        """Past the list floor the column scrolls; its last control (the status bar) can be reached
        by the wheel, and the open Folders rail stays where it was."""
        rail = page.locator('#worklist-folders-panel').bounding_box()
        status = page.locator('.left > .statusbar')
        for _ in range(30):
            box, seen = status.bounding_box(), page.evaluate("(node) => (" + VISIBLE + ").seen(node)", status.element_handle())
            if seen['whole']:
                break
            left = page.locator('.left').bounding_box()
            page.mouse.move(left['x'] + left['width'] - 40, left['y'] + left['height'] - 8)
            page.mouse.wheel(0, 80)
            settle(page)
        self.assertTrue(seen['whole'], f'{what}: status bar reachable {seen}')
        self.assertEqual(rail, page.locator('#worklist-folders-panel').bounding_box(), f'{what}: Folders rail moved')

    def test_short_landscape_login_list_keeps_header_row_and_next_study(self):
        """W3R5-01: Folders opens on every login (D1041 6-②). In short landscape windows
        its rail narrows the list column so far that the wrapped list controls left
        0-19 px of rows. The list keeps its header and one whole row at first paint, a
        click on that row selects it, the wheel brings the next study into the list and
        a click selects it; the controls below scroll with the column, nothing is clipped."""
        for width, height in ((840, 768), (860, 700), (900, 768), (1024, 768), (900, 600), (1280, 720)):
            with self.subTest(width=width, height=height):
                page, _, _ = self.page_at(width, height)
                expect(page.get_by_role('button', name='Folders', exact=True)).to_have_attribute('aria-expanded', 'true')
                self.assertNotIn('portrait', page.evaluate('document.body.className'))
                area = page.evaluate(LIST)
                self.assertGreaterEqual(area['grid'][1] - area['grid'][0] + 0.5, area['head'] + area['row'] + area['scrollbar'])
                self.click_row(page, 0, 'login')
                self.wheel_row_into_view(page, 1, 'next study')
                expect(page.locator('#rows tr[data-uid]').first).not_to_have_class(re.compile(r'\bsel\b'))
                self.assert_column_controls_reachable(page, 'column')
                self.doCleanups()

    def test_narrow_sheet_keeps_header_selected_and_next_row(self):
        """W3R5-02: a narrow landscape window stacks the work area when a study is
        selected; its fixed list band keeps the header, the selected row and the next
        row whole (no keyboard-only path), right after the selection and after a
        drawer round trip, together with the Related header and the prior report's
        first line (D383)."""
        for width, height in ((840, 768), (860, 700), (800, 768)):
            with self.subTest(width=width, height=height):
                page, _, _ = self.page_at(width, height)
                self.click_row(page, 0, 'login')
                self.assertIn('workspace-narrow', page.evaluate('document.body.className'))
                for phase in ('selected', 'drawer round trip'):
                    if phase == 'drawer round trip':
                        page.keyboard.press('Control+Alt+5')
                        expect(page.get_by_role('complementary', name='Study Panel', exact=True)).to_be_visible()
                        page.keyboard.press('Escape')
                        expect(page.get_by_role('complementary', name='Study Panel', exact=True)).to_have_count(0)
                        settle(page)
                    self.assertTrue(self.assert_row_in_view(page, 0, phase)['selected'])
                    related = page.evaluate(RELATED)
                    self.assertTrue(related['head']['whole'], f'{phase}: Related header {related}')
                    self.assertGreaterEqual(related['line_visible'], 8, f'{phase}: prior report first line {related}')
                # The next row: whole in a 768 px window's band; in a shorter window the band
                # yields to the prior report line and the wheel brings the next row up.
                if (width, height) != (860, 700):
                    self.assert_row_in_view(page, 1, 'next row without scrolling')
                self.wheel_row_into_view(page, 1, 'next row')
                self.assertIn('workspace-narrow', page.evaluate('document.body.className'))
                self.assert_column_controls_reachable(page, 'band')
                self.doCleanups()

    def test_list_floor_follows_a_row_height_change(self):
        """W3R5-05: only the rows' typography changes after first paint (no control or
        pager changes size); the list floor follows the taller row in a stacked list
        and in a short side-by-side column."""
        for width, height in ((768, 1024), (860, 700)):
            with self.subTest(width=width, height=height):
                page, _, _ = self.page_at(width, height, studies=1)
                controls = page.evaluate("() => [...document.querySelectorAll('.left > :not(.grid):not(#worklist-folders-panel)')].map(n => n.getBoundingClientRect().height)")
                page.add_style_tag(content='#rows tr:first-child td { height: 100px !important; padding-top: 20px !important; padding-bottom: 20px !important; }')
                settle(page)
                self.assertEqual(controls, page.evaluate("() => [...document.querySelectorAll('.left > :not(.grid):not(#worklist-folders-panel)')].map(n => n.getBoundingClientRect().height)"))
                area = page.evaluate(LIST)
                self.assertGreaterEqual(area['row'], 99.5)
                self.assertGreaterEqual(area['grid'][1] - area['grid'][0] + 0.5, area['head'] + area['row'] + area['scrollbar'])
                self.click_row(page, 0, 'taller row')
                self.doCleanups()

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

    def first_paint(self, asset_root, version, width, height, rail=None, picture=None):
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
            facts = page.evaluate("""(names) => ({focus:document.activeElement.id || document.activeElement.tagName,
              panels:names.map(s=>{
                const r=document.querySelector(s).getBoundingClientRect();return [r.x,r.y,r.width,r.height]}),
              toolbar:[...document.querySelectorAll('.menubar input, .userfilter > *')].filter(n=>n.getClientRects().length).map(n=>{
                const r=n.getBoundingClientRect();return [n.textContent,n.value,n.checked,r.x,r.y,r.width,r.height]}),
              folders:document.querySelector('#worklist-folders-panel').open,
              headings:[...document.querySelectorAll('.rw h3')].map(n=>n.textContent)})""", [name for name, _ in PANELS])
            facts['related_line'] = page.evaluate(RELATED)['line_visible']
            area = page.evaluate(LIST)
            control = page.get_by_role('button', name='Rail', exact=True)
            box = control.bounding_box() if control.count() else None
            pixels = None
            if picture:
                cover(page, [rail])
                pixels = first_paint_pixels(page, picture)
            self.assertEqual([], site.violations)
            return facts, area, box and [box['x'], box['y'], box['width'], box['height']], pixels
        finally:
            context.close()

    def assert_moved_work_area(self, w2, w2_area, mine, width, height, difference_of):
        """W3R-09 / W3R5-04: where W2's stacked list cannot show its header and one whole
        row, W3's list grows by that height in whole pixels (g) and the report window band
        may yield (y) so that D383's prior report line stays in view. Nothing else changes:
        every panel below is W2's panel moved down by g (the band and everything below it
        by g - y), and so are its pixels. Only the grown list (with the Folders rail that
        spans it) and the band's yielded strip are not compared."""
        index = {name: i for i, (name, _) in enumerate(PANELS)}
        grown = mine['panels'][index['.left']][3] - w2['panels'][index['.left']][3]
        missing = w2_area['head'] + w2_area['row'] + w2_area['scrollbar'] - (w2_area['grid'][1] - w2_area['grid'][0])
        self.assertTrue(missing <= grown < missing + 1, (missing, grown))
        self.assertAlmostEqual(round(grown), grown, delta=0.001)
        band = index['.rw']
        yielded = w2['panels'][band][3] - mine['panels'][band][3]
        self.assertAlmostEqual(round(yielded), yielded, delta=0.001)
        self.assertGreaterEqual(yielded, 0)
        self.assertGreaterEqual(mine['panels'][band][3], 140)
        if yielded:
            self.assertGreaterEqual(mine['related_line'], 8, 'the band yields only to keep the prior report line in view')
        g, y = round(grown), round(yielded)
        for (name, move), theirs, ours in zip(PANELS, w2['panels'], mine['panels']):
            dy, dh = {'grow': (0, g), 'below-list': (g, 0), 'work-area': (g, -g), 'band': (g, -y), 'below-band': (g - y, 0)}[move]
            expected = [theirs[0], theirs[1] + dy, theirs[2], theirs[3] + dh]
            for a, b in zip(expected, ours):
                self.assertAlmostEqual(a, b, delta=0.01, msg=f'{name}: expected {expected}, got {ours}')
        if difference_of is None:
            return
        rail = w2['panels'][index['#worklist-folders-panel']]
        list_bottom, column_bottom = w2_area['grid'][1], w2['panels'][index['.left']][1] + w2['panels'][index['.left']][3]
        band_bottom = w2['panels'][band][1] + w2['panels'][band][3]
        rail_right, top, top_up = math.ceil(rail[0] + rail[2]), math.floor(list_bottom), math.ceil(list_bottom)
        column, column_up = math.floor(column_bottom), math.ceil(column_bottom)
        band_end, below = math.floor(band_bottom - y) - (1 if y else 0), math.floor(band_bottom)
        regions = [[0, width, 0, 0, top],                                                        # above W2's list bottom
                   [0, rail_right, top, top, column - top],                                      # the Folders rail stays
                   [rail_right, width - rail_right, top_up, top_up + g, column - top_up],        # list controls move by g
                   [0, width, column_up, column_up + g, band_end - column_up],                   # band moves by g, less its yield
                   [0, width, below, below + g - y, height - below - (g - y)]]                   # all below the band by g - y
        for result in difference_of(regions):
            self.assertFalse(result.get('outside') or result.get('size'), result)
            self.assertEqual(0, result['over'], f'moved first-paint pixels differ: {result}')

    def test_first_paint_matches_w2_for_empty_v1_and_v2_records(self):
        # D1004 requires identical first paint. This fixed landed-input comparison
        # is a deliberate byte-provenance use; compare visible geometry and pixels.
        # The baseline is the landed W2 (main 9d6984b: PR #164 W2-LAND + PR #168
        # W2-FU): D1041 6-② made W2 open Folders on every login, so W2's own first
        # paint changed by decision after the earlier W2 input 9d4ba0f, and W2-FU
        # then changed how the footer wraps beside it. Two decided differences:
        # - W3's Rail control shows in that open panel's title row; its measured
        #   box is masked in both pictures (the folder tree keeps W2's place).
        # - W3R-09: where W2's stacked list cannot show its header and one whole
        #   row, W3's list grows by the missing height in whole pixels. Toolbar,
        #   focus, Folders and the list's place stay W2's; every panel below is W2's
        #   panel moved down (the report window band may yield for D383's prior
        #   report line), geometry and pixels alike (assert_moved_work_area).
        # Pixels count as equal within ANTIALIAS (16/255 per channel), not exact.
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
                        picture = (width, height) in ((1920,1080), (900,1200), (1080,1920), (768,1024))
                        w2, w2_area, w2_rail, w2_pixels = self.first_paint(Path(temporary), version, width, height, rail,
                            pictures / ('w2-' + name) if picture else None)
                        self.assertIsNone(w2_rail)
                        missing = w2_area['head'] + w2_area['row'] + w2_area['scrollbar'] - (w2_area['grid'][1] - w2_area['grid'][0])
                        pixels = None
                        if picture:
                            again, _, _, pixels = self.first_paint(current, version, width, height, rail, pictures / ('current-' + name))
                            self.assertEqual(mine, again)
                        difference_of = (lambda regions: picture_difference(self.browser, w2_pixels, pixels, regions)) if picture else None
                        with self.subTest(version=version, width=width, height=height):
                            if missing <= 0.5:
                                self.assertEqual(w2, mine)
                                if picture:
                                    self.assertEqual(0, difference_of(None)[0].get('over'), 'first-paint pixels differ outside the logo/native checkbox/Rail')
                                continue
                            self.assertGreater(height, width, 'only a stacked list grows')
                            need = area['head'] + area['row'] + area['scrollbar']
                            self.assertAlmostEqual(need, area['grid'][1] - area['grid'][0], delta=1)
                            for key in ('focus', 'toolbar', 'folders', 'headings'):
                                self.assertEqual(w2[key], mine[key], key)
                            self.assert_moved_work_area(w2, w2_area, mine, width, height, difference_of)
            finally:
                auth.ROOT = current


if __name__ == '__main__':
    unittest.main()
