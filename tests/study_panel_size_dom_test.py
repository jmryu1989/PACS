"""REQ-WS1/WS7 (pilot D1160) -> RISK-WS1/WS7 -> WS7-PANEL-SIZE / WS7-PANEL-TEXT / WS1-PANEL-ROAM.

The pilot radiologist's answer D1160: the Study Panel's size can be changed by the reader (width and height,
because monitors differ) and its text size too; today's layout stays the default. This module serves the real page
and assets with synthetic HTTP answers only (the harness of study_panel_page_dom_test.py), drives the public
controls (the panel edge with the mouse and the keys, the Text Size select, Default) and observes geometry, the
rendered size of text, the report's buttons and fields, the stored layout and the account copy. No product
instrumentation; a dialog or a page error fails every case (no prompt, confirm or modal: doctor friction 0).

The default must be round 6's panel. test_default_is_round_6 serves the round-6 tree (R6 below, a fixed landed
input: the same deliberate byte-provenance use as the W2 first-paint comparison; CI fetches this exact commit) and
compares, with nothing chosen, the panel's and the page's geometry exactly and the open panel's pixels within the
r6 tolerance (ANTIALIAS), the two new header controls masked in both pictures.
"""
import io
import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
import study_panel_page_dom_test as dom
from study_panel_page_dom_test import KEY, ROOT, VISIBLE, WorkspaceSite, auth, cover, picture_difference, settle, wait_startup

# Round 6 as finished (a94f2e2 product tree + the r6c test/README commit): the default this round must keep.
R6 = 'ea2a0379cc3dc0482ee3887940f875fe34ce773c'
# The panel through its public roles: the drawer, its tabs, the shown tab's content, its Close button and edge.
PANEL = '''() => { const d = document.querySelector('[role=complementary][aria-label="Study Panel"]');
  const r = n => { const b = n.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; };
  const shown = d.querySelector('[role=tabpanel]:not([hidden])'), edge = d.querySelector('[role=separator]');
  return {drawer: r(d), close: r([...d.querySelectorAll('button')].find(b => b.textContent === 'Close')),
    tablist: r(d.querySelector('[role=tablist]')), tabs: [...d.querySelectorAll('[role=tab]')].filter(t => !t.hidden).map(r),
    shown: r(shown), overflow: [shown.scrollWidth - shown.clientWidth,
      ...[...d.querySelectorAll('[role=tab]')].filter(t => !t.hidden).map(t => t.scrollWidth - t.clientWidth)],
    edge: edge && !edge.hidden ? {box: r(edge), orientation: edge.getAttribute('aria-orientation'),
      now: +edge.getAttribute('aria-valuenow'), min: +edge.getAttribute('aria-valuemin'), max: +edge.getAttribute('aria-valuemax')} : null}; }'''
# The page under the panel (an overlay: none of it moves while the panel opens, is resized or changes its text).
PAGE = '''() => ['.menubar', '.left', '.left > .grid', '#rows tr[data-uid]', '.right', '.rw', '.related-p', '.related-list-pane',
  '.report-p', '#b-approve', '#b-save', '#findings', '#conclusion'].map(s => { const n = document.querySelector(s);
  const b = n.getBoundingClientRect(); return [s, b.x, b.y, b.width, b.height, getComputedStyle(n).fontSize]; })'''
# Rendered text: the height of the first line box of a text (zoom does not change computed font sizes).
TEXT = '''(selector) => { const root = document.querySelector(selector), walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = walker.nextNode(); while (text && !text.nodeValue.trim()) text = walker.nextNode();
  const range = document.createRange(); range.selectNodeContents(text); return range.getClientRects()[0].height; }'''
# Everywhere the round-6 rules place the panel: wide landscape columns, stacked portrait bands at every width, the
# pilot's 900x1200, short side-by-side windows (the column left of the report) and the narrow sheet.
DEFAULT_SIZES = ((1920, 1080), (1366, 768), (2560, 1440), (1200, 1920), (1440, 2560), (900, 1200), (768, 1024), (1024, 768), (840, 768))
# The order's sizes: portrait monitors, the pilot's 900x1200, landscape monitors and the W3R5-01/02 narrow windows.
BOUND_SIZES = ((1200, 1920), (1440, 2560), (900, 1200), (1920, 1080), (1366, 768),
               (840, 768), (860, 700), (900, 768), (1024, 768), (900, 600), (1280, 720), (800, 768))
SCALES = (1, 1.2, 1.4)


class StudyPanelSizeDOM(unittest.TestCase):
    # The round-6 module's page helpers, used as they are (not its cases).
    page_at = dom.StudyPanelPageDOM.page_at
    click_row = dom.StudyPanelPageDOM.click_row
    assert_row_in_view = dom.StudyPanelPageDOM.assert_row_in_view
    assert_report_usable = dom.StudyPanelPageDOM.assert_report_usable

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def page(self, width, height):
        """A fresh login (two studies) with the first study selected; a dialog fails the case."""
        page, site, context = self.page_at(width, height)
        dialogs = []
        page.on('dialog', lambda d: (dialogs.append(d.message), d.dismiss()))
        self.addCleanup(lambda: self.assertEqual([], dialogs, 'no prompt, confirm or alert'))
        self.click_row(page, 0, f'{width}x{height}')
        return page, site, context

    def open_panel(self, page):
        page.keyboard.press('Control+Alt+5')
        drawer = page.get_by_role('complementary', name='Study Panel', exact=True)
        expect(drawer).to_be_visible()
        settle(page)
        return drawer

    def edge(self, page):
        return page.get_by_role('complementary', name='Study Panel', exact=True).get_by_role('separator', name='Study Panel 크기 조절')

    def text_size(self, page, step):
        page.get_by_role('complementary', name='Study Panel', exact=True).get_by_role('combobox', name='Text Size').select_option(str(step))
        settle(page)

    def keys(self, page, *keys):
        self.edge(page).focus()
        for key in keys:
            page.keyboard.press(key)
        settle(page)

    def drag(self, page, delta):
        """Press on the panel edge and move the pointer by `delta` along its axis in steps (kept in the window)."""
        box, vertical = self.edge(page).bounding_box(), self.panel(page)['edge']['orientation'] == 'vertical'
        window = page.viewport_size
        x = box['x'] + box['width'] / 2 if vertical else box['x'] + min(box['width'] / 3, 200)
        y = box['y'] + min(box['height'] / 3, 200) if vertical else box['y'] + box['height'] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        if vertical:
            page.mouse.move(max(2, min(window['width'] - 2, x + delta)), y, steps=6)
        else:
            page.mouse.move(x, max(2, min(window['height'] - 2, y + delta)), steps=6)
        page.mouse.up()
        settle(page)

    def account_menu(self, page):
        page.locator('#toolbar-view > summary').click()
        menu = page.locator('#workspace-server-menu')
        if menu.get_attribute('open') is None:
            menu.locator('summary').click()

    def panel(self, page):
        return page.evaluate(PANEL)

    def stored(self, page):
        value = page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', KEY)
        return (value or {}).get('workspace', {}).get('studyPanel')

    def size_of(self, facts):
        return facts['drawer'][2] if facts['edge']['orientation'] == 'vertical' else facts['drawer'][3]

    # ── the default is round 6 ──────────────────────────────────────────────────────────────────────────

    def default_panel(self, asset_root, width, height, mask=None, picture=False):
        """Serve one tree at one size, select the first study and open the panel with nothing chosen."""
        auth.ROOT = asset_root
        site = WorkspaceSite()
        site.second_study = True
        context = self.browser.new_context(viewport=dict(width=width, height=height))
        context.route('**/*', lambda route, request: site.handle(route, request))
        try:
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(auth.MAIN_URL)
            expect(page.locator('#rows tr[data-uid]')).to_have_count(2)
            wait_startup(page, site)
            settle(page)
            facts = {'first_paint_nodes': page.evaluate("() => document.querySelectorAll('*').length")}
            self.click_row(page, 0, f'{width}x{height}')
            self.open_panel(page)
            page.mouse.move(width - 1, height - 1)
            settle(page)
            facts['nodes'] = page.evaluate("() => document.querySelectorAll('*').length")
            facts['panel'], facts['page'] = self.panel(page), page.evaluate(PAGE)
            del facts['panel']['edge']
            drawer = page.get_by_role('complementary', name='Study Panel', exact=True)
            controls = [c.bounding_box() for c in (drawer.get_by_role('combobox', name='Text Size'),
                                                   drawer.get_by_role('button', name='Default', exact=True)) if c.count()]
            if controls:
                left, top = min(c['x'] for c in controls), min(c['y'] for c in controls)
                mask = [left, top, max(c['x'] + c['width'] for c in controls) - left, max(c['y'] + c['height'] for c in controls) - top]
            if picture:
                cover(page, [mask])
                settle(page)
                facts['pixels'] = page.screenshot(animations='disabled', caret='hide',
                    mask=[page.locator('.brand img'), page.locator('input[type=checkbox]'), page.locator('.kin-test-cover')])
            for tab in ('Images', 'Templates', 'Info'):
                drawer.get_by_role('tab', name=tab, exact=True).click()
                settle(page)
                facts['tab ' + tab] = {k: v for k, v in self.panel(page).items() if k != 'edge'}
            self.assertEqual([], errors)
            self.assertEqual([], site.violations)
            return facts, mask
        finally:
            context.close()

    def test_default_is_round_6(self):
        """D1160 '지금이 기본 세팅': nothing chosen = round 6's panel at every placement, to the pixel; the first
        paint is round 6's too (the options exist only in the opened panel)."""
        current = auth.ROOT
        with tempfile.TemporaryDirectory(prefix='kin-w3-r6-') as temporary:
            raw = subprocess.check_output(['git', 'archive', '--format=zip', R6,
                'worklist-v0/hpacs-lite', 'scripts/main-split-order.json', 'proxy/branding'], cwd=ROOT)
            zipfile.ZipFile(io.BytesIO(raw)).extractall(temporary)
            try:
                for width, height in DEFAULT_SIZES:
                    picture = (width, height) in ((1920, 1080), (1200, 1920), (900, 1200), (1024, 768), (840, 768))
                    mine, mask = self.default_panel(current, width, height, picture=picture)
                    theirs, _ = self.default_panel(Path(temporary), width, height, mask=mask, picture=picture)
                    with self.subTest(width=width, height=height):
                        self.assertEqual(theirs['first_paint_nodes'], mine['first_paint_nodes'], 'first paint')
                        for key in ('panel', 'page', 'tab Images', 'tab Templates', 'tab Info'):
                            self.assertEqual(theirs[key], mine[key], key)
                        # The opened panel's new nodes: the Text Size select and its 3 options, Default, the
                        # controls' row and the edge (stated in the round-7 report).
                        self.assertEqual(7, mine['nodes'] - theirs['nodes'])
                        if picture:
                            difference = picture_difference(self.browser, theirs['pixels'], mine['pixels'])[0]
                            self.assertEqual(0, difference.get('over'), f'open panel pixels differ outside the new controls: {difference}')
            finally:
                auth.ROOT = current

    # ── resizing ───────────────────────────────────────────────────────────────────────────────────────

    def test_edge_drag_and_keys_resize_within_bounds(self):
        """D1160 width in landscape (the LEFT drawer's right edge), height in portrait (the panel's edge facing the
        report): mouse and keys, within a minimum and the room that leaves the report's buttons and fields as
        visible as with the panel closed; what was chosen is stored at the end of a drag or with each key."""
        for width, height, orientation, name in ((1920, 1080, 'landscape', 'width'), (1200, 1920, 'portrait', 'height')):
            with self.subTest(width=width, height=height):
                page, _, _ = self.page(width, height)
                closed, under = self.assert_report_usable(page, 'closed'), page.evaluate(PAGE)
                self.open_panel(page)
                start = self.panel(page)
                vertical = start['edge']['orientation'] == 'vertical'
                self.assertEqual(orientation == 'landscape', vertical)
                low, high, at = start['edge']['min'], start['edge']['max'], self.size_of(start)
                self.assertEqual(round(at), start['edge']['now'])
                self.assertLess(low, at)
                # The edge is in the panel's keyboard order: Tab reaches it, no pointer needed.
                page.get_by_role('complementary', name='Study Panel', exact=True).get_by_role('button', name='Close', exact=True).focus()
                for _ in range(80):
                    if self.edge(page).evaluate('edge => edge === document.activeElement'):
                        break
                    page.keyboard.press('Tab')
                expect(self.edge(page)).to_be_focused()
                self.drag(page, 120)
                facts = self.panel(page)
                self.assertAlmostEqual(at + 120, self.size_of(facts), delta=1)
                self.assertEqual({orientation: {name: round(self.size_of(facts))}}, self.stored(page))
                self.drag(page, 5000)
                facts = self.panel(page)
                self.assertAlmostEqual(high, self.size_of(facts), delta=1, msg='the room is the maximum')
                report = page.locator('.report-p').bounding_box()
                if vertical:
                    self.assertLessEqual(facts['drawer'][0] + facts['drawer'][2], report['x'] - 12 + .5)
                else:
                    self.assertLessEqual(facts['drawer'][1] + facts['drawer'][3], report['y'] - 12 + .5)
                opened = self.assert_report_usable(page, 'largest')
                for item, fact in closed.items():
                    if fact:
                        self.assertEqual(fact['visible'], opened[item]['visible'], f'{item} visible part changed')
                if not vertical:
                    for item in ('#b-approve', '#b-save', '#findings', '#conclusion'):
                        self.assertTrue(opened[item]['whole'], f'{item} whole at the largest panel')
                self.drag(page, -5000)
                self.assertAlmostEqual(low, self.size_of(self.panel(page)), delta=1, msg='the minimum')
                self.keys(page, 'ArrowRight' if vertical else 'ArrowDown')
                self.assertAlmostEqual(low + 10, self.size_of(self.panel(page)), delta=1)
                self.keys(page, 'Shift+ArrowRight' if vertical else 'Shift+ArrowDown')
                self.assertAlmostEqual(low + 50, self.size_of(self.panel(page)), delta=1)
                self.keys(page, 'ArrowLeft' if vertical else 'ArrowUp')
                self.assertAlmostEqual(low + 40, self.size_of(self.panel(page)), delta=1)
                self.assertEqual({orientation: {name: round(low + 40)}}, self.stored(page))
                self.keys(page, 'End')
                self.assertAlmostEqual(high, self.size_of(self.panel(page)), delta=1)
                self.keys(page, 'Home')
                self.assertAlmostEqual(low, self.size_of(self.panel(page)), delta=1)
                expect(self.edge(page)).to_be_focused()
                self.assertEqual(under, page.evaluate(PAGE), 'the page under the panel moved')
                page.keyboard.press('Escape')
                expect(page.get_by_role('complementary', name='Study Panel', exact=True)).to_have_count(0)
                self.assertEqual(under, page.evaluate(PAGE))
                self.doCleanups()

    def test_a_smaller_window_keeps_the_report_and_the_choice(self):
        """A size chosen on a large monitor is shown within the room of a smaller window of the same orientation
        (never over the report) and is not overwritten by it: back in the large window it is the chosen size."""
        for big, small, orientation in (((1920, 1080), (1366, 768), 'landscape'), ((1440, 2560), (1200, 1920), 'portrait')):
            with self.subTest(big=big, small=small):
                page, _, _ = self.page(*big)
                self.open_panel(page)
                self.keys(page, 'End')
                large, chosen = self.panel(page), self.stored(page)
                self.assertEqual(round(self.size_of(large)), chosen[orientation]['width' if orientation == 'landscape' else 'height'])
                page.set_viewport_size(dict(width=small[0], height=small[1]))
                settle(page)
                facts = self.panel(page)
                self.assertLess(self.size_of(facts), self.size_of(large) - 1)
                self.assertAlmostEqual(facts['edge']['max'], self.size_of(facts), delta=1)
                report = page.locator('.report-p').bounding_box()
                if orientation == 'landscape':
                    self.assertLessEqual(facts['drawer'][0] + facts['drawer'][2], report['x'] - 12 + .5)
                else:
                    self.assertLessEqual(facts['drawer'][1] + facts['drawer'][3], report['y'] - 12 + .5)
                self.assert_report_usable(page, 'smaller window')
                self.assertEqual(chosen, self.stored(page), 'a smaller window overwrote the choice')
                page.set_viewport_size(dict(width=big[0], height=big[1]))
                settle(page)
                self.assertEqual(large, self.panel(page))
                self.doCleanups()

    def test_reading_workspace_panel_resizes_within_the_report_bounds(self):
        """W3R5-03 ② in the Reading Workspace as well: opened from 'Study Info & Templates', the panel at its largest
        (Normal and Larger text) leaves the report's buttons and fields as visible as with it closed, and Escape from
        the edge returns to the opener."""
        for width, height in ((1920, 1080), (1024, 768), (900, 1200)):
            with self.subTest(width=width, height=height):
                page, _, _ = self.page(width, height)
                page.route('**/ohif/**', lambda route: route.fulfill(content_type='text/html', body='<!doctype html><title>SYN viewer</title>'))
                page.get_by_role('button', name='Reading Workspace', exact=True).click()
                opener = page.get_by_role('button', name='Study Info & Templates', exact=True)
                expect(opener).to_be_visible()
                settle(page)
                closed = self.assert_report_usable(page, 'reading, closed')
                opener.click()
                expect(page.get_by_role('complementary', name='Study Panel', exact=True)).to_be_visible()
                settle(page)
                for step in (0, 2):
                    self.text_size(page, step)
                    self.keys(page, 'End')
                    facts = self.panel(page)
                    self.assertAlmostEqual(facts['edge']['max'], self.size_of(facts), delta=1)
                    opened = self.assert_report_usable(page, f'reading, largest, text {step}')
                    for item, fact in closed.items():
                        if fact:
                            self.assertEqual(fact['visible'], opened[item]['visible'], f'text {step}: {item} visible part changed')
                    self.keys(page, 'Home')
                    facts = self.panel(page)
                    self.assertAlmostEqual(facts['edge']['min'], self.size_of(facts), delta=1)
                page.keyboard.press('Escape')
                expect(opener).to_be_focused()
                self.doCleanups()

    def test_default_at_the_default_lets_an_account_load_apply(self):
        """Default when nothing was chosen, or End at the largest size, changes nothing and writes nothing, so an
        account Load already on its way still applies (a real change would rightly make it give way)."""
        page, site, _ = self.page(1920, 1080)
        drawer = self.open_panel(page)
        default = self.panel(page)
        self.drag(page, 160)
        self.text_size(page, 2)
        chosen = self.panel(page)
        self.account_menu(page)
        save = page.get_by_role('button', name='Save to Account', exact=True)
        expect(save).to_be_enabled()
        save.click()
        expect(page.locator('#workspace-server-status')).to_contain_text('현재 배치를 계정에 저장')
        # (The open View menu makes the toolbar taller and the panel follows the work area down: sizes are compared
        # while it is open, the whole geometry after it is closed.)
        text = drawer.get_by_role('combobox', name='Text Size')
        drawer.get_by_role('button', name='Default', exact=True).click()
        settle(page)
        self.assertEqual(default['drawer'][2], self.panel(page)['drawer'][2])
        expect(text).to_have_value('0')
        writes = len(site.layout_writes)
        before = page.evaluate('(key) => localStorage.getItem(key)', KEY)
        site.held_read = []
        page.get_by_role('button', name='Load from Account', exact=True).click()
        for _ in range(100):
            if site.held_read:
                break
            page.wait_for_timeout(50)
        self.assertEqual(1, len(site.held_read), 'the account read is on its way')
        drawer.get_by_role('button', name='Default', exact=True).click()
        settle(page)
        self.assertEqual(default['drawer'][2], self.panel(page)['drawer'][2])
        self.assertEqual(before, page.evaluate('(key) => localStorage.getItem(key)', KEY), 'a change that did not happen was written')
        route, site.held_read = site.held_read[0], None
        route.fulfill(json=dict(owner=[auth.INSTITUTION, auth.RAD['sub']], revision=site.layout_revision, layout=site.layout, updatedAt=None))
        expect(page.locator('#workspace-server-status')).to_contain_text('서버 배치를 불러왔습니다')
        expect(text).to_have_value('2')
        page.locator('#toolbar-view > summary').click()
        settle(page)
        self.assertEqual(chosen, self.panel(page))
        self.assertEqual(writes, len(site.layout_writes))

    def test_bounds_keep_report_list_and_controls_at_every_size(self):
        """At each of the order's sizes and at both text extremes: the largest panel leaves the report's buttons
        and fields as visible as with it closed (W3R-01/W3R5-03); the smallest keeps the header controls and the
        three tabs whole and in view with room for content; the page under it (list floor, rows, report) does
        not move, and after closing the first study is still clicked where it is seen (W3R-09, W3R5-01/02)."""
        for width, height in BOUND_SIZES:
            with self.subTest(width=width, height=height):
                page, _, _ = self.page(width, height)
                closed, under = self.assert_report_usable(page, 'closed'), page.evaluate(PAGE)
                drawer = self.open_panel(page)
                for step in (0, 2):
                    self.text_size(page, step)
                    self.keys(page, 'End')
                    facts = self.panel(page)
                    self.assertAlmostEqual(facts['edge']['max'], self.size_of(facts), delta=1)
                    opened = self.assert_report_usable(page, f'largest, text {step}')
                    for item, fact in closed.items():
                        if fact:
                            self.assertEqual(fact['visible'], opened[item]['visible'], f'text {step}: {item} visible part changed')
                    self.keys(page, 'Home')
                    facts = self.panel(page)
                    self.assertAlmostEqual(facts['edge']['min'], self.size_of(facts), delta=1)
                    for control in (drawer.get_by_role('combobox', name='Text Size'), drawer.get_by_role('button', name='Default', exact=True),
                                    drawer.get_by_role('button', name='Close', exact=True), *[drawer.get_by_role('tab', name=t, exact=True)
                                    for t in ('Images', 'Info', 'Templates')]):
                        expect(control).to_be_in_viewport(ratio=1)
                    self.assertEqual(1, len({round(t[1]) for t in facts['tabs']}), f'text {step}: the tabs keep one row {facts["tabs"]}')
                    self.assertLessEqual(max(facts['overflow']), 1, f'text {step}: clipped panel text {facts["overflow"]}')
                    if facts['edge']['min'] >= (320 if facts['edge']['orientation'] == 'vertical' else 240) * SCALES[step] - 1:
                        self.assertGreaterEqual(facts['shown'][3], 100, f'text {step}: room for the tab content')
                self.assertEqual(under, page.evaluate(PAGE), 'the page under the panel moved')
                page.keyboard.press('Escape')
                expect(page.get_by_role('complementary', name='Study Panel', exact=True)).to_have_count(0)
                self.assertEqual(under, page.evaluate(PAGE))
                self.assertTrue(self.assert_row_in_view(page, 0, 'after the panel')['selected'])
                self.doCleanups()

    def test_sizes_and_text_stay_with_their_orientation(self):
        """W3R-07 for the panel: a landscape width and text step never apply in portrait, nor a portrait height in
        landscape; both survive a reload of the same browser."""
        page, site, _ = self.page(1920, 1080)
        self.open_panel(page)
        landscape_default = self.panel(page)
        page.set_viewport_size(dict(width=1200, height=1920))
        settle(page)
        portrait_default, portrait_text = self.panel(page), page.evaluate(TEXT, '#clinical td')
        page.set_viewport_size(dict(width=1920, height=1080))
        settle(page)
        self.assertEqual(landscape_default, self.panel(page))
        self.drag(page, 140)
        self.text_size(page, 1)
        wide = self.panel(page)
        self.assertAlmostEqual(500, wide['drawer'][2], delta=1)
        page.set_viewport_size(dict(width=1200, height=1920))
        settle(page)
        self.assertEqual(portrait_default, self.panel(page), 'a landscape choice leaked into portrait')
        self.assertEqual(portrait_text, page.evaluate(TEXT, '#clinical td'))
        expect(page.get_by_role('combobox', name='Text Size')).to_have_value('0')
        self.keys(page, 'Shift+ArrowUp', 'Shift+ArrowUp')
        tall = self.panel(page)
        self.assertAlmostEqual(portrait_default['drawer'][3] - 80, tall['drawer'][3], delta=1)
        page.set_viewport_size(dict(width=1920, height=1080))
        settle(page)
        self.assertEqual(wide, self.panel(page), 'a portrait choice leaked into landscape')
        expect(page.get_by_role('combobox', name='Text Size')).to_have_value('1')
        self.assertEqual({'landscape': {'width': 500, 'text': 1}, 'portrait': {'height': round(tall['drawer'][3])}}, self.stored(page))
        page.reload()
        expect(page.locator('#rows tr[data-uid]')).to_have_count(2)
        wait_startup(page, site)
        settle(page)
        self.click_row(page, 0, 'after reload')
        self.open_panel(page)
        self.assertEqual(wide, self.panel(page))
        page.set_viewport_size(dict(width=1200, height=1920))
        settle(page)
        self.assertEqual(tall, self.panel(page))

    # ── text size ──────────────────────────────────────────────────────────────────────────────────────

    def test_text_size_scales_the_panel_text_only(self):
        """Normal / Large / Larger scale the tabs and the panel's content (labels, values, Info, Templates) by
        1.2 and 1.4; the panel header, the report editor and the worklist rows never change; the panel widens to
        a minimum that fits the larger text, and nothing in it is clipped."""
        page, _, _ = self.page(1920, 1080)
        drawer = self.open_panel(page)
        under = page.evaluate(PAGE)
        def measure():
            facts = self.panel(page)
            return dict(facts=facts, label=page.evaluate(TEXT, '#clinical td'), value=page.evaluate(TEXT, '#clinical tr td + td'),
                        heading=page.evaluate(TEXT, '.s-clinical h3'), tab=page.evaluate(TEXT, '[role=tab][aria-selected=true]'),
                        title=page.evaluate(TEXT, '[role=complementary][aria-label="Study Panel"] h2'))
        normal = measure()
        for step in (1, 2):
            self.text_size(page, step)
            larger = measure()
            with self.subTest(step=step):
                for name in ('label', 'value', 'heading', 'tab'):
                    self.assertAlmostEqual(SCALES[step], larger[name] / normal[name], delta=0.06, msg=name)
                self.assertEqual(normal['title'], larger['title'], 'the header is not scaled')
                # Close stays the same size in the same row; it moves right with the wider panel's edge.
                self.assertEqual(normal['facts']['close'][1:], larger['facts']['close'][1:])
                self.assertAlmostEqual(larger['facts']['drawer'][0] + larger['facts']['drawer'][2] - 9,
                                       larger['facts']['close'][0] + larger['facts']['close'][2], delta=0.5)
                self.assertEqual(normal['facts']['drawer'][0:2], larger['facts']['drawer'][0:2])
                self.assertAlmostEqual(max(360, 320 * SCALES[step]), larger['facts']['drawer'][2], delta=1)
                self.assertLessEqual(max(larger['facts']['overflow']), 1, 'clipped text')
                self.assertEqual(under, page.evaluate(PAGE), 'text outside the panel changed')
                drawer.get_by_role('tab', name='Templates', exact=True).click()
                settle(page)
                self.assertLessEqual(max(self.panel(page)['overflow']), 1, 'clipped Templates text')
                drawer.get_by_role('tab', name='Info', exact=True).click()
                settle(page)
        self.text_size(page, 0)
        self.assertEqual(normal, measure())
        self.assertEqual({}, self.stored(page) or {}, 'Normal is the default and is not stored')

    # ── default ────────────────────────────────────────────────────────────────────────────────────────

    def test_default_and_double_click_restore_this_orientation(self):
        """One Default (the header button, or a double-click on the edge) brings back the default size and text
        of the current orientation, without a question; the other orientation keeps its choice."""
        page, _, _ = self.page(1200, 1920)
        drawer = self.open_panel(page)
        portrait_default = self.panel(page)
        self.keys(page, 'Shift+ArrowUp')
        self.text_size(page, 2)
        portrait = self.panel(page)
        page.set_viewport_size(dict(width=1920, height=1080))
        settle(page)
        landscape_default = self.panel(page)
        for restore in ('button', 'double-click'):
            with self.subTest(restore=restore):
                self.drag(page, 200)
                self.text_size(page, 1)
                self.assertNotEqual(landscape_default, self.panel(page))
                if restore == 'button':
                    default = drawer.get_by_role('button', name='Default', exact=True)
                    default.click()
                    settle(page)
                    expect(default).to_be_focused()
                else:
                    box = self.edge(page).bounding_box()
                    page.mouse.dblclick(box['x'] + box['width'] / 2, box['y'] + 200)
                    settle(page)
                self.assertEqual(landscape_default, self.panel(page))
                expect(drawer.get_by_role('combobox', name='Text Size')).to_have_value('0')
                self.assertEqual({'portrait': {'height': round(portrait['drawer'][3]), 'text': 2}}, self.stored(page))
        page.set_viewport_size(dict(width=1200, height=1920))
        settle(page)
        self.assertEqual(portrait, self.panel(page))
        drawer.get_by_role('button', name='Default', exact=True).click()
        settle(page)
        self.assertEqual(portrait_default, self.panel(page))
        self.assertIsNone(self.stored(page))

    # ── persistence and roaming ────────────────────────────────────────────────────────────────────────

    def test_choices_roam_through_the_account(self):
        """The choices travel in the v3 layout record: Save to Account carries them, another browser's Load from
        Account applies them, and an account record without them (written before the options) is the default."""
        page, site, _ = self.page(1920, 1080)
        drawer = self.open_panel(page)
        default = self.panel(page)
        self.drag(page, 160)
        self.text_size(page, 2)
        chosen = self.panel(page)
        page.keyboard.press('Escape')
        self.account_menu(page)
        save = page.get_by_role('button', name='Save to Account', exact=True)
        expect(save).to_be_enabled()
        save.click()
        expect(page.locator('#workspace-server-status')).to_contain_text('현재 배치를 계정에 저장')
        self.assertEqual({'landscape': {'width': 520, 'text': 2}}, site.layout['workspace']['studyPanel'])
        saved = json.loads(json.dumps(site.layout))
        for record, expected in ((saved, chosen), ({**saved, 'workspace': {k: v for k, v in saved['workspace'].items() if k != 'studyPanel'}}, default)):
            with self.subTest(record='with choices' if record is saved else 'without choices'):
                other = WorkspaceSite()
                other.second_study, other.layout, other.layout_revision = True, record, 1
                context = self.browser.new_context(viewport=dict(width=1920, height=1080))
                context.route('**/*', lambda route, request, other=other: other.handle(route, request))
                self.addCleanup(context.close)
                fresh = context.new_page()
                fresh.goto(auth.MAIN_URL)
                expect(fresh.locator('#rows tr[data-uid]')).to_have_count(2)
                wait_startup(fresh, other)
                settle(fresh)
                self.click_row(fresh, 0, 'other browser')
                self.account_menu(fresh)
                fresh.get_by_role('button', name='Load from Account', exact=True).click()
                expect(fresh.locator('#workspace-server-status')).to_contain_text('서버 배치를 불러왔습니다')
                fresh.locator('#toolbar-view > summary').click()
                self.open_panel(fresh)
                self.assertEqual(expected, self.panel(fresh))
                self.assertEqual([], other.violations)


if __name__ == '__main__':
    unittest.main()
