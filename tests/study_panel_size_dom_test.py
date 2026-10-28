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
r6 tolerance (ANTIALIAS), the two new header controls masked in both pictures. After a tab click round 6's panel
moved down where its toolbar status line wrapped (W3R7-04); there each tab's content is compared within the panel and
the panel must stay where it opened.

Round 8 (Astra review of rounds 6+7, W3R7-02..06) adds the cases at the end: a drag belongs to the edge it started
on (window turning under a held pointer), a late account Load gives way to a drag, Study Panel saves never move
the page (tab changes, first Templates open, failed/recovered saves said in the panel), the Reading Workspace with
the largest report column, and Default during a drag. They drive real mouse, keyboard and window-size changes.

W4-LAND decided difference (D1371, same rule as W6R1-05): the node counts of test_default_is_round_6 leave out the
closed Workspace Shortcuts dialog's subtree, found by its role and name in both trees (nodes_outside_shortcuts). W4-SC's
shortcut v2 gives that dialog its Worklist/Viewer tabs (+7 nodes once fable/w4-sc is merged); a closed dialog is no part
of a paint, its contents are W4-SC's cases, and the requirement these counts carry - the Study Panel's options exist only
in the opened panel, nothing else is added to the first paint but the declared W6/W4 report nodes - is unchanged. The
dialog must be present and closed in every count, so it cannot leave the count by being opened or moved.

Decided differences in the node counts (PR #231 fix round, 2026-10-27, by D73 §14): each decision that adds to or
removes from the first paint is declared once, as the region it owns, in DECIDED_REGIONS - W6-PAGE-22 (D1300), W4-LAND,
W5-UI Phases A and B, S9-U4b (D1486/D1617/D1668), EMR-D #219, W9-UI and the opened panel's round-7 controls (Text Size,
its row, Default, the edge). The counts of those regions are derived from that declaration in each served tree
(decided_nodes) and never pinned; every element outside them is compared exactly, at first paint and with the panel
open. What a feature builds inside its own declared region is that feature's own cases' (e.g. study_transfer_local,
related_report_mode, multi_study_view), so growth there is not a difference of this comparison. W9's launch button is
taken out of the layout before pictures and geometry are taken (HIDE_W9), so the round-6 comparison stays as it was.

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
from study_panel_page_dom_test import KEY, RASTER, ROOT, VISIBLE, WorkspaceSite, auth, cover, picture_difference, settle, wait_startup
from study_panel_page_dom_test import W6_REPORT_FIELDS, assert_w6_reachable, w6_facts, w6_moved, w6_regions
from study_panel_page_dom_test import HIDE_W4, HIDE_W9

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
# Rendered text (zoom does not change computed font sizes): the drawn advance of a text (the widths of its line boxes,
# which grow in proportion to the size the glyphs are drawn at) and the height of its first line box. The line box is
# the font's ascent + descent rounded to whole pixels on some platforms (the Linux runner's DejaVu Sans: 15, 17, 20 px
# at 13, 15.6, 18.2 px), so its ratio is not the text's scale; it is only required to grow.
TEXT = '''(selector) => { const root = document.querySelector(selector), walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = walker.nextNode(); while (text && !text.nodeValue.trim()) text = walker.nextNode();
  const range = document.createRange(); range.selectNodeContents(text); const lines = [...range.getClientRects()];
  return {advance: lines.reduce((sum, line) => sum + line.width, 0), line: lines[0].height}; }'''
# Everywhere the round-6 rules place the panel: wide landscape columns, stacked portrait bands at every width, the
# pilot's 900x1200, short side-by-side windows (the column left of the report) and the narrow sheet.
DEFAULT_SIZES = ((1920, 1080), (1366, 768), (2560, 1440), (1200, 1920), (1440, 2560), (900, 1200), (768, 1024), (1024, 768), (840, 768))
# The order's sizes: portrait monitors, the pilot's 900x1200, landscape monitors and the W3R5-01/02 narrow windows.
BOUND_SIZES = ((1200, 1920), (1440, 2560), (900, 1200), (1920, 1080), (1366, 768),
               (840, 768), (860, 700), (900, 768), (1024, 768), (900, 600), (1280, 720), (800, 768))
SCALES = (1, 1.2, 1.4)
STUDY_PANEL = '[role="complementary"][aria-label="Study Panel"]'
# The decided differences of the round-6 comparison, each declared as the region it owns (module header):
# (decision, CSS selector, 'tree' = the element and all it holds | 'node' = the element only, accessible name or None).
# A feature's own cases own what happens inside its region; this comparison owns everything outside all of them.
DECIDED_REGIONS = (
    ('W6-PAGE-22 D1300: report frame script and measurement iframe', 'script[src="report-editor-frame.js"]', 'node', None),
    ('W6-PAGE-22 D1300', 'body > iframe[aria-hidden="true"][sandbox="allow-same-origin"]', 'node', None),
    ('W6-PAGE-22 D1300: the removed Recommendation heading', 'h4:has(+ #recommendation)', 'node', None),
    ('W4-LAND: Approve & Next', '#b-approve-next', 'node', None),
    ('W4-LAND: Notice of a move that did not happen', '#report-notice', 'tree', None),
    ('W4-LAND: read-only Recommendation notice', '#recnote', 'tree', None),
    ('W5-UI Phase A: Related-mode reason lines', '#cvr-sent-mode-reason, #cvr-inbox-mode-reason', 'node', None),
    ('W5-UI Phase B: Related Report mode', '#related-mode', 'tree', None),
    ('W5-UI Phase B', 'link[href="related-report-mode.css"], script[src="related-report-mode.js"]', 'node', None),
    ('S9-U4b D1486/D1617/D1668: DICOM Transfer', '#study-transfer', 'tree', None),
    ('S9-U4b D1486', '#t-import, style:has(+ #study-transfer), script[src="study-transfer-local.js"]', 'node', None),
    ('EMR-D #219: clinical signing facts', 'script[src="clinical-signature.js"]', 'node', None),
    ('W9-UI: Multi-Study View', '#multi-study', 'tree', None),
    ('W9-UI', '#multi-selection-open-set, link[href="multi-study-view.css"], script[src="multi-study-view.js"]', 'node', None),
    ('W-SPACE item 9: Panel Settings', '#panel-settings-dialog', 'tree', None),
    ('W-SPACE items 9/11', '#panel-settings-open, link[href="workspace-theme.css"]', 'node', None),
    ('D1160 round 7: Text Size', STUDY_PANEL + ' select[aria-label="Text Size"]', 'tree', None),
    ('D1160 round 7: the controls row', STUDY_PANEL + ' :has(> select[aria-label="Text Size"])', 'node', None),
    ('D1160 round 7: Default', STUDY_PANEL + ' button', 'node', 'Default'),
    ('D1160 round 7: the panel edge', STUDY_PANEL + ' [role="separator"]', 'node', None),
)


def decided_nodes(page):
    """The elements of the declared regions (DECIDED_REGIONS) in this served tree, each counted once."""
    return page.evaluate("""(regions) => {
      const nodes = new Set();
      for (const [, selector, scope, name] of regions)
        for (const n of document.querySelectorAll(selector)) {
          if (name !== null && n.textContent !== name) continue;
          nodes.add(n);
          if (scope === 'tree') n.querySelectorAll('*').forEach(child => nodes.add(child));
        }
      return nodes.size;
    }""", [list(region) for region in DECIDED_REGIONS])


def nodes_outside_shortcuts(page):
    """Every element of the page except the closed Workspace Shortcuts dialog and what it holds (module header)."""
    dialog = page.get_by_role('dialog', name='Workspace Shortcuts', exact=True, include_hidden=True)
    expect(dialog).to_have_count(1)
    held = dialog.evaluate("d => { if (d.open) throw Error('Workspace Shortcuts is open'); return 1 + d.querySelectorAll('*').length; }")
    return page.evaluate("() => document.querySelectorAll('*').length") - held


def within_panel(facts):
    """A tab's facts with every box placed relative to the panel's own corner (the panel keeps its size)."""
    x, y = facts['drawer'][:2]
    place = lambda box: [box[0] - x, box[1] - y, box[2], box[3]]
    return {**facts, 'drawer': facts['drawer'][2:], 'close': place(facts['close']), 'tablist': place(facts['tablist']),
            'tabs': [place(tab) for tab in facts['tabs']], 'shown': place(facts['shown'])}


class StudyPanelSizeDOM(unittest.TestCase):
    # The round-6 module's page helpers, used as they are (not its cases).
    page_at = dom.StudyPanelPageDOM.page_at
    click_row = dom.StudyPanelPageDOM.click_row
    assert_row_in_view = dom.StudyPanelPageDOM.assert_row_in_view
    assert_report_usable = dom.StudyPanelPageDOM.assert_report_usable

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(args=RASTER)

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
        # AGENTS §4: the control's public name is English (W3R7-01); its Korean tooltip explains it.
        return page.get_by_role('complementary', name='Study Panel', exact=True).get_by_role('separator', name='Study Panel Size', exact=True)

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

    def press_and_move(self, page, delta):
        """Press on the panel edge and move the pointer by `delta` along its axis; the button stays down."""
        page.evaluate("() => addEventListener('pointerdown', e => { window.kinTestPointer = e.pointerId; }, {capture: true, once: true})")
        box, vertical = self.edge(page).bounding_box(), self.panel(page)['edge']['orientation'] == 'vertical'
        x = box['x'] + box['width'] / 2 if vertical else box['x'] + min(box['width'] / 3, 200)
        y = box['y'] + min(box['height'] / 3, 200) if vertical else box['y'] + box['height'] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        x, y = (x + delta, y) if vertical else (x, y + delta)
        page.mouse.move(x, y, steps=5)
        settle(page)
        return x, y

    def cancel_pointer(self, page):
        """The browser takes the pointer away (pointercancel on the edge that holds it), then the button is let go."""
        page.evaluate('''() => document.querySelector('[role=complementary][aria-label="Study Panel"] [role=separator]')
          .dispatchEvent(new PointerEvent('pointercancel', {pointerId: window.kinTestPointer, bubbles: true}))''')
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
            page.evaluate(HIDE_W9)   # W9-UI decided difference (study_panel_page_dom_test.py HIDE_W9)
            settle(page)
            facts = {'first_paint_nodes': nodes_outside_shortcuts(page), 'decided_first_paint_nodes': decided_nodes(page)}
            self.click_row(page, 0, f'{width}x{height}')
            self.open_panel(page)
            page.mouse.move(width - 1, height - 1)
            settle(page)
            facts['nodes'] = nodes_outside_shortcuts(page)
            facts['decided_nodes'] = decided_nodes(page)
            facts['panel'], facts['page'] = self.panel(page), page.evaluate(PAGE)
            facts['w6'] = w6_facts(page)
            del facts['panel']['edge']
            drawer = page.get_by_role('complementary', name='Study Panel', exact=True)
            controls = [c.bounding_box() for c in (drawer.get_by_role('combobox', name='Text Size'),
                                                   drawer.get_by_role('button', name='Default', exact=True)) if c.count()]
            if controls:
                left, top = min(c['x'] for c in controls), min(c['y'] for c in controls)
                mask = [left, top, max(c['x'] + c['width'] for c in controls) - left, max(c['y'] + c['height'] for c in controls) - top]
            if picture:
                page.evaluate(HIDE_W4)   # W4-LAND decided difference (study_panel_page_dom_test.py HIDE_W4)
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
            dom.with_palette(temporary, current)   # W-SPACE item 11 decided difference (study_panel_page_dom_test.py THEME)
            try:
                for width, height in DEFAULT_SIZES:
                    picture = (width, height) in ((1920, 1080), (1200, 1920), (900, 1200), (1024, 768), (840, 768))
                    mine, mask = self.default_panel(current, width, height, picture=picture)
                    theirs, _ = self.default_panel(Path(temporary), width, height, mask=mask, picture=picture)
                    with self.subTest(width=width, height=height):
                        # Compare everything outside the declared feature regions in both served trees.
                        self.assertEqual(theirs['first_paint_nodes'] - theirs['decided_first_paint_nodes'],
                                         mine['first_paint_nodes'] - mine['decided_first_paint_nodes'], 'first paint')
                        self.assertEqual(theirs['panel'], mine['panel'], 'panel')
                        page_facts = lambda facts: [row for row in facts['page'] if row[0] not in W6_REPORT_FIELDS]
                        self.assertEqual(page_facts(theirs), page_facts(mine), 'page')
                        where = f'{width}x{height}'
                        assert_w6_reachable(self, mine['w6'], where)
                        w6_moved(self, theirs['w6'], mine['w6'], 0, where)
                        # Round 6's tab click rewrote the toolbar status line, which wraps at 900x1200 and 768x1024 and
                        # pushed its panel down (W3R7-04, fixed this round). So each tab's content is round 6's within
                        # the panel, and the panel itself stays where it opened, which is round 6's place (above).
                        for key in ('tab Images', 'tab Templates', 'tab Info'):
                            expected = within_panel(theirs[key])
                            opened, after = theirs['panel']['drawer'], theirs[key]['drawer']
                            if after != opened:
                                # Where the status line wrapped depends on the platform's fonts (Windows: 900x1200 and
                                # 768x1024; the Linux runner also 1024x768). A panel in a column keeps its bottom, so
                                # round 6's panel there also lost the height it moved down by. Round 6's tab is then
                                # compared as if its panel had stayed where it opened: same left and width, the lost
                                # height given back to the panel and its shown tab; everything else unchanged.
                                down, lost = after[1] - opened[1], opened[3] - after[3]
                                self.assertEqual((opened[0], opened[2]), (after[0], after[2]), key)
                                self.assertGreater(down, 0, key)
                                self.assertIn(lost, (0, down), key)
                                expected['drawer'] = [expected['drawer'][0], expected['drawer'][1] + lost]
                                expected['shown'] = expected['shown'][:3] + [expected['shown'][3] + lost]
                            self.assertEqual(expected, within_panel(mine[key]), key)
                            self.assertEqual(mine['panel']['drawer'], mine[key]['drawer'], key + ': the panel does not move')
                        self.assertEqual(theirs['nodes'] - theirs['decided_nodes'],
                                         mine['nodes'] - mine['decided_nodes'], 'opened panel')
                        if picture:
                            regions = w6_regions(theirs['w6']['scroller'], mine['w6']['scroller'], width, height)
                            for difference in picture_difference(self.browser, theirs['pixels'], mine['pixels'], regions):
                                self.assertFalse(difference.get('outside') or difference.get('size'), difference)
                                self.assertEqual(0, difference['over'], f'open panel pixels differ outside the new controls/W6 scroller: {difference}')
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
                self.assertRegex(self.edge(page).get_attribute('title'), '[가-힣]', 'the Korean tooltip explains the English control')
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
                    self.assertAlmostEqual(SCALES[step], larger[name]['advance'] / normal[name]['advance'], delta=0.06, msg=name)
                    self.assertGreater(larger[name]['line'], normal[name]['line'], name + ': the glyphs are drawn taller')
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

    # ── round 8: the Astra review of rounds 6+7 (W3R7-02..06) ─────────────────────────────────────────────

    def test_a_drag_belongs_to_the_orientation_it_started_in(self):
        """W3R7-02: a drag changes only the edge it started on. The window turning under a held drag (landscape
        to portrait, the reverse, and the same resize axis with another orientation) ends it without a result:
        the new orientation shows its own size and its record, and the old one's, stay as they were. After
        that, a drag, a cancelled drag and Default work in the new orientation, and each orientation's choice
        survives a reload."""
        page, site, _ = self.page(1920, 1080)
        drawer = self.open_panel(page)
        landscape_default = self.panel(page)
        page.set_viewport_size(dict(width=1200, height=1920))
        settle(page)
        portrait_default = self.panel(page)
        for start, other, start_default, other_default, delta in (
                ((1920, 1080), (1200, 1920), landscape_default, portrait_default, 80),
                ((1200, 1920), (1920, 1080), portrait_default, landscape_default, -80)):
            with self.subTest(start=start):
                page.set_viewport_size(dict(width=start[0], height=start[1]))
                settle(page)
                self.assertEqual(start_default, self.panel(page))
                x, y = self.press_and_move(page, delta)
                self.assertAlmostEqual(self.size_of(start_default) + delta, self.size_of(self.panel(page)), delta=1, msg='the drag shows its size')
                page.set_viewport_size(dict(width=other[0], height=other[1]))
                settle(page)
                self.assertEqual(other_default, self.panel(page), 'the old drag resized the new orientation')
                page.mouse.move(min(x + 40, other[0] - 2), min(y + 40, other[1] - 2))
                page.mouse.up()
                settle(page)
                self.assertEqual(other_default, self.panel(page))
                self.assertIsNone(self.stored(page), 'a record changed')
                page.set_viewport_size(dict(width=start[0], height=start[1]))
                settle(page)
                self.assertEqual(start_default, self.panel(page), 'the dragged size stayed without being stored')
        # After the switch: a drag in the new orientation is its own choice; a cancelled drag keeps it; Default
        # restores only this orientation; a reload keeps each orientation's record.
        self.drag(page, -60)
        tall = self.panel(page)
        self.assertAlmostEqual(self.size_of(portrait_default) - 60, self.size_of(tall), delta=1)
        self.assertEqual({'portrait': {'height': round(self.size_of(tall))}}, self.stored(page))
        self.press_and_move(page, -40)
        self.cancel_pointer(page)
        self.assertEqual(tall, self.panel(page), 'a cancelled drag shows the stored size again')
        page.set_viewport_size(dict(width=1920, height=1080))
        settle(page)
        self.drag(page, 100)
        wide = self.panel(page)
        self.assertEqual({'portrait': {'height': round(self.size_of(tall))}, 'landscape': {'width': round(self.size_of(wide))}}, self.stored(page))
        drawer.get_by_role('button', name='Default', exact=True).click()
        settle(page)
        self.assertEqual(landscape_default, self.panel(page))
        self.assertEqual({'portrait': {'height': round(self.size_of(tall))}}, self.stored(page))
        page.reload()
        expect(page.locator('#rows tr[data-uid]')).to_have_count(2)
        wait_startup(page, site)
        settle(page)
        self.click_row(page, 0, 'after reload')
        self.open_panel(page)
        self.assertEqual(landscape_default, self.panel(page))
        page.set_viewport_size(dict(width=1200, height=1920))
        settle(page)
        self.assertEqual(tall, self.panel(page))

    def test_a_drag_on_the_same_axis_in_another_orientation_ends_too(self):
        """W3R7-02, the same resize axis: in the Reading Workspace the panel is a band (height) both in a short
        landscape window and in a portrait one. A drag held while the window turns from one to the other changes
        neither orientation's record."""
        page, _, _ = self.page(1024, 768)
        page.route('**/ohif/**', lambda route: route.fulfill(content_type='text/html', body='<!doctype html><title>SYN viewer</title>'))
        page.get_by_role('button', name='Reading Workspace', exact=True).click()
        page.get_by_role('button', name='Study Info & Templates', exact=True).click()
        expect(page.get_by_role('complementary', name='Study Panel', exact=True)).to_be_visible()
        settle(page)
        landscape = self.panel(page)
        page.set_viewport_size(dict(width=900, height=1200))
        settle(page)
        portrait = self.panel(page)
        self.assertEqual(['horizontal', 'horizontal'], [landscape['edge']['orientation'], portrait['edge']['orientation']],
                         'both are bands: the same resize axis')
        self.assertTrue(page.evaluate("document.body.classList.contains('portrait')"))
        page.set_viewport_size(dict(width=1024, height=768))
        settle(page)
        self.assertFalse(page.evaluate("document.body.classList.contains('portrait')"))
        x, y = self.press_and_move(page, -30)
        self.assertAlmostEqual(self.size_of(landscape) - 30, self.size_of(self.panel(page)), delta=1)
        page.set_viewport_size(dict(width=900, height=1200))
        settle(page)
        self.assertEqual(portrait, self.panel(page))
        page.mouse.move(x, y - 20)
        page.mouse.up()
        settle(page)
        self.assertEqual(portrait, self.panel(page))
        self.assertIsNone(self.stored(page))
        page.set_viewport_size(dict(width=1024, height=768))
        settle(page)
        self.assertEqual(landscape, self.panel(page))

    def test_a_late_account_load_yields_to_a_drag(self):
        """W3R7-03: an account Load answered while the reader drags never overwrites the new local choice: the
        drag's first move that changes the size makes the Load give way (said in the account status), and the
        drag then ends as the reader ends it (released: the dragged size, Normal text; cancelled: the local
        layout as it was). A press without movement is no change, and that Load still applies."""
        for outcome in ('release', 'cancel', 'no movement'):
            with self.subTest(outcome=outcome):
                page, site, _ = self.page(1920, 1080)
                drawer = self.open_panel(page)
                default = self.panel(page)
                self.drag(page, 160)
                self.text_size(page, 2)
                self.account_menu(page)
                page.get_by_role('button', name='Save to Account', exact=True).click()
                expect(page.locator('#workspace-server-status')).to_contain_text('현재 배치를 계정에 저장')
                self.assertEqual({'landscape': {'width': 520, 'text': 2}}, site.layout['workspace']['studyPanel'])
                drawer.get_by_role('button', name='Default', exact=True).click()
                settle(page)
                self.assertIsNone(self.stored(page))
                site.held_read = []
                page.get_by_role('button', name='Load from Account', exact=True).click()
                for _ in range(100):
                    if site.held_read:
                        break
                    page.wait_for_timeout(50)
                self.assertEqual(1, len(site.held_read), 'the account read is on its way')
                if outcome == 'no movement':
                    box = self.edge(page).bounding_box()
                    page.mouse.click(box['x'] + box['width'] / 2, box['y'] + 200)
                else:
                    x, y = self.press_and_move(page, 80)
                    self.assertAlmostEqual(default['drawer'][2] + 80, self.panel(page)['drawer'][2], delta=1)
                route, site.held_read = site.held_read[0], None
                route.fulfill(json=dict(owner=[auth.INSTITUTION, auth.RAD['sub']], revision=site.layout_revision, layout=site.layout, updatedAt=None))
                text = drawer.get_by_role('combobox', name='Text Size')
                if outcome == 'no movement':
                    expect(page.locator('#workspace-server-status')).to_contain_text('서버 배치를 불러왔습니다')
                    expect(text).to_have_value('2')
                    settle(page)
                    self.assertAlmostEqual(520, self.panel(page)['drawer'][2], delta=1)
                    self.assertEqual({'landscape': {'width': 520, 'text': 2}}, self.stored(page))
                    self.doCleanups()
                    continue
                expect(page.locator('#workspace-server-status')).to_contain_text('현재 배치가 변경되어 적용하지 않았습니다')
                settle(page)
                expect(text).to_have_value('0')
                self.assertAlmostEqual(default['drawer'][2] + 80, self.panel(page)['drawer'][2], delta=1, msg='the drag is still shown')
                if outcome == 'release':
                    page.mouse.up()
                    settle(page)
                    self.assertEqual({'landscape': {'width': round(default['drawer'][2] + 80)}}, self.stored(page))
                    expect(text).to_have_value('0')
                else:
                    self.cancel_pointer(page)
                    self.assertIsNone(self.stored(page))
                    self.assertEqual(default['drawer'][2], self.panel(page)['drawer'][2])
                    expect(text).to_have_value('0')
                self.doCleanups()

    # W3R7-04: the list, Related and report as a reader sees them, in the windows where the toolbar wraps.
    STATUS_SIZES = ((900, 1200), (768, 1024), (840, 768))

    def local_tab(self, page):
        value = page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', KEY)
        return ((value or {}).get('workspace') or {}).get('studyPanelTab')

    def test_panel_tabs_and_the_first_templates_open_keep_the_page_still(self):
        """W3R7-04: the reader's tab choice in the Study Panel is saved quietly: the first open on a tab other than
        Info (Templates by its shortcut, Images by its tab), closing, reopening and every tab change leave the
        list, Related and report where they were; the toolbar status line is not rewritten for them (in these
        windows a longer status line wraps and moves everything below it)."""
        for width, height in self.STATUS_SIZES:
            for first in ('Templates', 'Images'):
                with self.subTest(width=width, height=height, first=first):
                    page, _, _ = self.page(width, height)
                    under, status = page.evaluate(PAGE), page.locator('#layout-status').inner_text()
                    drawer = page.get_by_role('complementary', name='Study Panel', exact=True)
                    def still(what):
                        settle(page)
                        self.assertEqual(under, page.evaluate(PAGE), f'{what}: the page under the panel moved')
                        self.assertEqual(status, page.locator('#layout-status').inner_text(), f'{what}: status line rewritten')
                    if first == 'Templates':
                        page.keyboard.press('Control+Alt+t')
                        expect(drawer.get_by_role('tab', name='Templates', exact=True)).to_have_attribute('aria-selected', 'true')
                    else:
                        self.open_panel(page)
                        drawer.get_by_role('tab', name='Images', exact=True).click()
                    still('first open on ' + first)
                    self.assertEqual(first.lower(), self.local_tab(page), 'the tab choice is saved')
                    page.keyboard.press('Escape')
                    expect(drawer).to_have_count(0)
                    still('close')
                    page.keyboard.press('Control+Alt+t')
                    expect(drawer).to_be_visible()
                    still('reopen')
                    for tab in ('Images', 'Info', 'Templates', 'Info'):
                        drawer.get_by_role('tab', name=tab, exact=True).click()
                        still('tab ' + tab)
                    self.assertEqual('info', self.local_tab(page))
                    self.assertEqual(0, drawer.get_by_role('status').filter(has_text='배치').count(), 'a successful save says nothing')
                    self.doCleanups()

    def test_a_failed_panel_save_is_said_in_the_panel_without_moving_the_page(self):
        """W3R7-04, failure and recovery: when this browser refuses the layout (storage full), the panel's own
        line says the choice is kept only in this window, and the first save that works again says so; neither
        moves the list, Related or report, and the toolbar status line is not rewritten. Stored values stay
        honest: nothing while refused, everything once it works."""
        for width, height in self.STATUS_SIZES:
            with self.subTest(width=width, height=height):
                page, _, _ = self.page(width, height)
                under, status = page.evaluate(PAGE), page.locator('#layout-status').inner_text()
                before = self.local_tab(page)
                page.evaluate('''key => { const original = Storage.prototype.setItem;
                  window.kinTestStorageBack = () => { Storage.prototype.setItem = original; };
                  Storage.prototype.setItem = function (k, v) {
                    if (this === localStorage && k === key) throw new DOMException('SYN quota', 'QuotaExceededError');
                    return original.call(this, k, v); }; }''', KEY)
                drawer = page.get_by_role('complementary', name='Study Panel', exact=True)
                def still(what):
                    settle(page)
                    self.assertEqual(under, page.evaluate(PAGE), f'{what}: the page under the panel moved')
                    self.assertEqual(status, page.locator('#layout-status').inner_text(), f'{what}: status line rewritten')
                page.keyboard.press('Control+Alt+t')
                notice = drawer.get_by_role('status').filter(has_text='배치')
                expect(notice).to_have_text('배치 저장 안 됨 · 이 창에서만 유지')
                expect(notice).to_be_in_viewport(ratio=1)
                still('failed tab save')
                self.assertEqual(before, self.local_tab(page), 'nothing was stored')
                self.text_size(page, 1)
                expect(notice).to_have_text('배치 저장 안 됨 · 이 창에서만 유지')
                still('failed Text Size save')
                page.evaluate('() => window.kinTestStorageBack()')
                drawer.get_by_role('tab', name='Images', exact=True).click()
                expect(notice).to_have_text('배치 저장됨 · 이 브라우저')
                expect(notice).to_be_in_viewport(ratio=1)
                still('first save after the failure')
                self.assertEqual('images', self.local_tab(page))
                self.assertEqual({'portrait' if width < height or width < 900 else 'landscape': {'text': 1}}, self.stored(page))
                drawer.get_by_role('tab', name='Info', exact=True).click()
                still('later save')
                self.doCleanups()

    def test_reading_workspace_with_the_largest_report_keeps_the_panel_off_the_report(self):
        """W3R7-05: with Image and Report Size at End in the Reading Workspace, the panel and its edge stay 12 px
        and 6 px clear of the report column at the default, after Default and at every text step and bound
        (the size within min..max); the report controls take a click to their very left edge; ArrowRight at
        the default never makes the panel smaller."""
        EDGE_HITS = '''() => ['#b-approve', '#b-save', '#b-prelim'].map(s => { const n = document.querySelector(s);
          if (!n || !n.getClientRects().length) return [s, null]; const b = n.getBoundingClientRect();
          return [s, [0.5, 1, 2].map(dx => { const hit = document.elementFromPoint(b.left + dx, b.top + b.height / 2); return hit === n || n.contains(hit); })]; })'''
        for width, height in ((1920, 1080), (1366, 768)):
            with self.subTest(width=width, height=height):
                page, _, _ = self.page(width, height)
                page.route('**/ohif/**', lambda route: route.fulfill(content_type='text/html', body='<!doctype html><title>SYN viewer</title>'))
                page.get_by_role('button', name='Reading Workspace', exact=True).click()
                settle(page)
                page.get_by_role('separator', name='Image and Report Size', exact=True).focus()
                page.keyboard.press('End')
                settle(page)
                closed = self.assert_report_usable(page, 'closed')
                page.get_by_role('button', name='Study Info & Templates', exact=True).click()
                drawer = page.get_by_role('complementary', name='Study Panel', exact=True)
                expect(drawer).to_be_visible()
                settle(page)
                def clear(what):
                    facts, report = self.panel(page), page.locator('.report-p').bounding_box()
                    edge = facts['edge']
                    self.assertLessEqual(edge['min'], edge['now'], what)
                    self.assertLessEqual(edge['now'], edge['max'], what)
                    self.assertAlmostEqual(edge['now'], self.size_of(facts), delta=1, msg=what)
                    self.assertLessEqual(facts['drawer'][0] + facts['drawer'][2], report['x'] - 12 + .5, what)
                    self.assertLessEqual(edge['box'][0] + edge['box'][2], report['x'] - 6 + .5, f'{what}: the edge reaches the report')
                    opened = self.assert_report_usable(page, what)
                    for item, fact in closed.items():
                        if fact:
                            self.assertEqual(fact['visible'], opened[item]['visible'], f'{what}: {item} visible part changed')
                    for name, hits in page.evaluate(EDGE_HITS):
                        if hits is not None:
                            self.assertEqual([True, True, True], hits, f'{what}: {name} left edge not clickable')
                    return facts
                default = clear('default')
                self.keys(page, 'ArrowRight')
                self.assertGreaterEqual(self.size_of(clear('ArrowRight at the default')), self.size_of(default) - .5,
                                        'ArrowRight made the panel smaller')
                for step in (0, 1, 2):
                    self.text_size(page, step)
                    clear(f'text {step}')
                    self.keys(page, 'End')
                    clear(f'text {step}, End')
                    self.keys(page, 'Home')
                    clear(f'text {step}, Home')
                drawer.get_by_role('button', name='Default', exact=True).click()
                settle(page)
                self.assertEqual(default, clear('after Default'))
                self.doCleanups()

    def test_default_during_a_drag_ends_the_drag(self):
        """W3R7-06: Default (here focused and pressed with Space while the pointer still holds the edge) ends the
        drag and its preview, then restores the default size and text; letting the pointer go afterwards stores
        nothing. The same with a size chosen before the drag."""
        page, site, _ = self.page(1920, 1080)
        drawer = self.open_panel(page)
        default_facts = self.panel(page)
        default = drawer.get_by_role('button', name='Default', exact=True)
        for chosen in (None, 120):
            with self.subTest(chosen=chosen):
                if chosen:
                    self.drag(page, chosen)
                    self.text_size(page, 1)
                    self.assertIsNotNone(self.stored(page))
                default.focus()
                x, y = self.press_and_move(page, 80)
                self.assertNotEqual(default_facts, self.panel(page))
                expect(default).to_be_focused()
                page.keyboard.press('Space')
                settle(page)
                self.assertEqual(default_facts, self.panel(page), 'Default left the dragged size')
                expect(drawer.get_by_role('combobox', name='Text Size')).to_have_value('0')
                page.mouse.move(x + 30, y)
                page.mouse.up()
                settle(page)
                self.assertEqual(default_facts, self.panel(page), 'the release stored the dragged size')
                self.assertIsNone(self.stored(page))
        self.assertEqual([], site.layout_writes, 'nothing went to the account')


if __name__ == '__main__':
    unittest.main()
