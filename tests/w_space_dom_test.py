"""W-SPACE: Minhoon 2026-10-27 feedback items 9, 10 and 11 on the served work page.

REQ (feedback.md items 9/10/11) -> RISK: a hidden panel leaves its space empty or comes back after a reload / under
another account; a dragged column order is lost or changes what the list filters and sorts; the palette overwrites a
reader's saved text colour -> TEST-WSPACE-DOM-01..04.

REQ Minhoon-20261027/item-9 under the W-SPACE layout contract (2026-10-29) -> RISK-WSPACE-WIDTH / -PREFERENCE / -EMPTY
-> TEST-WSPACE-G1..G5, each for Radiology and Technician at 1920x1080, 1024x768 and 768x1024, plus the 600/601 px
stacked boundary, the 840x768 selected-study sheet and the Study Panel drawer. Expected widths come from the contract
(each mode's shipped shares: Radiology 34 : 30 : 36, Technician 34 : 66) and the band's measured width, never from the
product's resolver. Tolerances are the existing ones: 0.5 CSS px for widths, 1 CSS px for strip and returned heights.

The real main.html and its assets are served; only HTTP answers are synthetic (study_panel_page_dom_test.WorkspaceSite).
Every assertion reads public controls, geometry, computed colours and the stored preferences. No product instrumentation.
"""
import json
import os
import sys
import unittest
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
import multi_study_view_dom_test as multi  # noqa: E402
import study_panel_page_dom_test as dom  # noqa: E402
from study_panel_page_dom_test import KEY, RASTER, WorkspaceSite, auth, settle, wait_startup  # noqa: E402

OWNER = json.dumps([auth.INSTITUTION, auth.RAD['sub']], separators=(',', ':'))
COLUMNS_KEY = 'kin-worklist-columns:v1:' + OWNER
OUT = Path(os.environ.get('KIN_WSPACE_OUT', dom.ROOT / 'tmp/w-space/dom'))
# Sizes: a normal landscape monitor, a small landscape window and a stacked portrait window.
SIZES = ((1920, 1080), (1024, 768), (768, 1024))
BAND = '''() => { const r = s => { const n = document.querySelector(s); if (!n || !n.getClientRects().length) return null;
  const b = n.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; };
  return { rw: r('.right > .rw'), thumb: r('.rw > .s-thumb'), clinical: r('.rw > .s-clinical'), template: r('.rw > .s-template'),
    thumbwrap: r('.rw .thumbwrap'), rtabs: r('.rw .rtabs'), separator: r('#resize-top'), workrow: r('.workrow'), report: r('.report-p'), split: r('.split'), list: r('.left'), listEdge: r('#resize-main'),
    tabs: [...document.querySelectorAll('.rw .rtabs > div')].filter(n => n.getClientRects().length).map(n => n.textContent) }; }'''


def shown(band):
    """Which parts of the band are on screen, and its tabs."""
    return {k: band[k] is not None for k in ('rw', 'thumb', 'clinical', 'template', 'thumbwrap', 'separator')} | {'tabs': band['tabs']}


MODES = ('Radiology', 'Technician')
# The contract's per-mode content shares (main.html first paint: Thumbnail 34%, Clinical 30%, Template the rest;
# Technician hides Template and gives Clinical 66%). AI Report / Image Report are placeholder tabs and own no column.
SHARES = {'Radiology': {'thumbnail': 34, 'clinical': 30, 'template': 36}, 'Technician': {'thumbnail': 34, 'clinical': 66}}
LABELS = {'thumbnail': 'Thumbnail', 'aiReport': 'AI Report', 'imageReport': 'Image Report',
          'clinical': 'Clinical Information', 'template': 'Reading Template'}
PLACEHOLDERS = ('aiReport', 'imageReport')
# The band's usable inline extent (its border box less borders and a scrollbar) next to every measured rectangle.
GEOM = '''() => { const q = s => document.querySelector(s), r = n => { if (!n || !n.getClientRects().length) return null;
  const b = n.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }, rw = q('.right > .rw');
  return { usable: rw && rw.getClientRects().length ? rw.getBoundingClientRect().width - (rw.offsetWidth - rw.clientWidth) : null,
    rw: r(rw), thumb: r(q('.rw > .s-thumb')), thumbwrap: r(q('.rw .thumbwrap')), clinical: r(q('.rw > .s-clinical')),
    template: r(q('.rw > .s-template')), rtabs: r(q('.rw .rtabs')), separator: r(q('#resize-top')), workrow: r(q('.workrow')),
    report: r(q('.report-p')), order: r(q('.order-p')), split: r(q('.split')), listEdge: r(q('#resize-main')),
    mode: q('.tabs > div.on')?.dataset.tab, viewport: [innerWidth, innerHeight],
    tabs: [...document.querySelectorAll('.rw .rtabs > div')].filter(n => n.getClientRects().length).map(n => n.textContent) }; }'''


def content(g):
    """The content panels on screen and their widths; an `.s-thumb` holding only tabs is not Thumbnail content."""
    out = {}
    if g['thumbwrap']:
        out['thumbnail'] = g['thumb'][2]
    for key in ('clinical', 'template'):
        if g[key]:
            out[key] = g[key][2]
    return out


def stacked(g):
    """main.html's very narrow portrait branch (max-width: 600px): every panel takes the band's full width."""
    width, height = g['viewport']
    return width <= 600 and height > width


class FilterSite(WorkspaceSite):
    """A WorkspaceSite whose account has one saved search that opens the Technician list."""
    SAVED = {'id': 'syn-technician', 'name': 'SYN Technician', 'mode': 'Technician', 'cols': {}, 'quick': '', 'days': 0}

    def api(self, route, request, method, path, query):
        # The bootstrap list and the personal search collection that replaces it after start-up.
        if method == 'GET' and path in ('/api/bootstrap', '/api/filter-folders'):
            saved = self.SAVED

            class Answer:   # the base fixture's bootstrap answer, with the saved search added
                def fulfill(self, **kwargs):
                    kwargs['json'] = {**kwargs['json'], 'filters': [saved]}
                    return route.fulfill(**kwargs)

                def __getattr__(self, name):
                    return getattr(route, name)
            return super().api(Answer(), request, method, path, query)
        return super().api(route, request, method, path, query)


class WSpaceDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        OUT.mkdir(parents=True, exist_ok=True)
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(args=RASTER)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def open(self, site, width=1920, height=1080, init=None):
        context = self.browser.new_context(viewport={'width': width, 'height': height})
        context.route('**/*', lambda route, request: site.handle(route, request))
        if init:
            context.add_init_script(init)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('dialog', lambda d: d.accept())
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        self.addCleanup(lambda: self.assertEqual([], site.violations))
        page.goto(auth.MAIN_URL)
        expect(page.locator('#rows')).to_contain_text(auth.PATIENT)
        wait_startup(page, site)
        settle(page)
        return page

    def reload(self, page, site):
        page.reload()
        expect(page.locator('#rows')).to_contain_text(auth.PATIENT)
        wait_startup(page, site)
        settle(page)

    @staticmethod
    def view(page):
        if page.locator('#toolbar-view').get_attribute('open') is None:
            page.locator('#toolbar-view > summary').click()

    def panels(self, page):
        self.view(page)
        page.get_by_role('button', name='Panels', exact=True).click()
        dialog = page.get_by_role('dialog', name='Panel Settings', exact=True)
        expect(dialog).to_be_visible()
        return dialog

    def set_panel(self, page, label, shown):
        dialog = self.panels(page)
        box = dialog.get_by_label(label, exact=True)
        box.set_checked(shown)
        expect(dialog.locator('#panel-settings-status')).to_have_text('패널 표시를 기억했습니다 · 이 브라우저')
        dialog.get_by_role('button', name='Close', exact=True).click()
        expect(dialog).to_be_hidden()
        page.locator('#toolbar-view > summary').click()   # close View: its open panel takes toolbar height
        settle(page)
        return page.evaluate(BAND)

    def assert_row_on_top(self, band, portrait):
        """With the band gone the Related/report row starts at the top of the work column (stacked: under the list)."""
        top = band['listEdge'][1] + band['listEdge'][3] if portrait else band['split'][1]
        self.assertAlmostEqual(top, band['workrow'][1], delta=1)

    # ── W-SPACE layout contract helpers ──
    def set_panels(self, page, changes):
        """Panel Settings: set each named checkbox (key -> shown), close the dialog and View, then measure."""
        dialog = self.panels(page)
        for key, on in changes.items():
            dialog.get_by_label(LABELS[key], exact=True).set_checked(on)
            expect(dialog.locator('#panel-settings-status')).to_have_text('패널 표시를 기억했습니다 · 이 브라우저')
        dialog.get_by_role('button', name='Close', exact=True).click()
        expect(dialog).to_be_hidden()
        page.locator('#toolbar-view > summary').click()
        settle(page)
        return page.evaluate(GEOM)

    def show_all(self, page):
        dialog = self.panels(page)
        dialog.get_by_role('button', name='Show All Panels', exact=True).click()
        dialog.get_by_role('button', name='Close', exact=True).click()
        expect(dialog).to_be_hidden()
        page.locator('#toolbar-view > summary').click()
        settle(page)
        return page.evaluate(GEOM)

    @staticmethod
    def switch(page, mode):
        """The public workflow tab."""
        page.locator(f'.tabs > div[data-tab="{mode}"]').click()
        expect(page.locator(f'.tabs > div[data-tab="{mode}"]')).to_have_class('on')
        settle(page)
        return page.evaluate(GEOM)

    @staticmethod
    def stored(page):
        return page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', KEY)

    def assert_allocation(self, g, mode, visible, msg=''):
        """Invariants 1/2: the shown content is exactly the mode's available panels the reader did not hide; side by
        side each takes the band's usable width times its share of the shown shares, stacked each takes it whole; the
        placeholder tabs alone are a full-width strip above the content."""
        info = f'{msg} {mode} {g}'
        self.assertEqual(mode, g['mode'], info)
        widths = content(g)
        self.assertEqual(set(visible), set(widths), info)
        if not widths:
            return
        usable, left, right = g['usable'], g['rw'][0], g['rw'][0] + g['rw'][2]
        total = sum(SHARES[mode][k] for k in widths)
        for key, width in widths.items():
            expected = usable if stacked(g) else usable * SHARES[mode][key] / total
            self.assertAlmostEqual(expected, width, delta=0.5, msg=f'{key}: {info}')
            box = g['thumb' if key == 'thumbnail' else key]
            self.assertGreaterEqual(box[0], left - 0.5, info)
            self.assertLessEqual(box[0] + box[2], right + 0.5, info)
            self.assertGreater(box[3], 0, info)
        if 'thumbnail' not in widths and g['tabs']:
            self.assertAlmostEqual(usable, g['thumb'][2], delta=1, msg=f'strip width: {info}')
            self.assertAlmostEqual(g['rtabs'][3], g['thumb'][3], delta=1, msg=f'strip height: {info}')
            for key in widths:
                self.assertGreaterEqual(g[key][1], g['thumb'][1] + g['thumb'][3] - 0.5, f'{key} under the strip: {info}')

    def assert_same_content(self, a, b, msg=''):
        """The same visible content at the same position and width (0.5 px)."""
        self.assertEqual(set(content(a)), set(content(b)), msg)
        self.assertAlmostEqual(a['usable'], b['usable'], delta=0.5, msg=msg)
        for key in content(a):
            box = 'thumb' if key == 'thumbnail' else key
            self.assertAlmostEqual(a[box][0], b[box][0], delta=0.5, msg=f'{key} x: {msg}')
            self.assertAlmostEqual(a[box][2], b[box][2], delta=0.5, msg=f'{key} width: {msg}')

    def receiver(self, g):
        """The work column below the band: the report in Radiology, the order list in Technician."""
        return g['order'] if g['mode'] == 'Technician' else g['report']

    def test_wspace_dom_01_each_panel_hides_its_space_returns_and_reload_keeps_it(self):
        for width, height in SIZES:
            with self.subTest(size=f'{width}x{height}'):
                site = WorkspaceSite()
                page = self.open(site, width, height)
                start = page.evaluate(BAND)
                self.assertEqual(['Thumbnail', 'AI Report', 'Image Report'], start['tabs'])
                self.assertTrue(start['rw'] and start['thumb'] and start['clinical'] and start['template'])
                portrait = height > width
                total = lambda b: sum(b[k][2] for k in ('thumb', 'clinical', 'template') if b[k])
                # Reading Template: its width goes to the panels beside it (the band keeps its height).
                band = self.set_panel(page, 'Reading Template', False)
                self.assertIsNone(band['template'])
                self.assertAlmostEqual(band['rw'][2], total(band), delta=2)
                self.assertGreater(band['clinical'][2], start['clinical'][2] + 10)
                # Clinical Information next: Thumbnail takes the band.
                band = self.set_panel(page, 'Clinical Information', False)
                self.assertIsNone(band['clinical'])
                self.assertAlmostEqual(band['rw'][2], band['thumb'][2], delta=2)
                # Thumbnail: the content goes, the two placeholder tabs stay as tabs only.
                band = self.set_panel(page, 'Thumbnail', False)
                self.assertIsNone(band['thumbwrap'])
                self.assertEqual(['AI Report', 'Image Report'], band['tabs'])
                band = self.set_panel(page, 'AI Report', False)
                self.assertEqual(['Image Report'], band['tabs'])
                # The last one: the band and its separator go and the Related/report row takes the height.
                band = self.set_panel(page, 'Image Report', False)
                self.assertIsNone(band['rw'])
                self.assertIsNone(band['separator'])
                if not portrait:
                    self.assertGreater(band['workrow'][3], start['workrow'][3] + start['rw'][3])
                    self.assertGreater(band['report'][3], start['report'][3] + start['rw'][3])
                else:   # stacked: the row moves up by the band and its separator
                    self.assertAlmostEqual(band['workrow'][1] - band['split'][1],
                                           start['workrow'][1] - start['split'][1] - start['rw'][3] - start['separator'][3], delta=1)
                # The toolbar and the list above the band do not move (the dialog, not the toolbar, says the outcome),
                # and the Related/report row now starts where the band started.
                self.assertEqual(start['split'], band['split'])
                self.assert_row_on_top(band, portrait)
                page.screenshot(path=str(OUT / f'panels-all-hidden-{width}x{height}.png'))
                stored = page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', KEY)
                self.assertEqual(['thumbnail', 'aiReport', 'imageReport', 'clinical', 'template'], stored['workspace']['hiddenPanels'])
                # A reload keeps every choice; the dialog shows them unchecked. (After a reload the toolbar's status line
                # says the layout was restored and can wrap in a narrow window, so heights above the band are not compared.)
                self.reload(page, site)
                again = page.evaluate(BAND)
                self.assertEqual(shown(band), shown(again))
                self.assert_row_on_top(again, portrait)
                dialog = self.panels(page)
                for label in ('Thumbnail', 'AI Report', 'Image Report', 'Clinical Information', 'Reading Template'):
                    expect(dialog.get_by_label(label, exact=True)).not_to_be_checked()
                # Show All Panels returns the first paint's panels with their widths (and heights side by side).
                dialog.get_by_role('button', name='Show All Panels', exact=True).click()
                dialog.get_by_role('button', name='Close', exact=True).click()
                page.locator('#toolbar-view > summary').click()
                settle(page)
                back = page.evaluate(BAND)
                self.assertEqual(shown(start), shown(back))
                for key in ('thumb', 'clinical', 'template'):
                    # (a stacked band also yields height to the prior report line by the toolbar's height, D383)
                    self.assertEqual([start[key][0], start[key][2]], [back[key][0], back[key][2]], key)
                    if not portrait:
                        self.assertEqual(start[key][3], back[key][3], key)
                self.assertNotIn('hiddenPanels', page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', KEY)['workspace'])

    def test_wspace_dom_02_account_layout_carries_hidden_panels_and_another_account_sees_all(self):
        site = WorkspaceSite()
        page = self.open(site)
        self.drag_top(page, 30)   # TEST-WSPACE-G4: a saved band height travels with the hidden panels
        self.set_panel(page, 'Reading Template', False)
        self.set_panel(page, 'Thumbnail', False)
        saved = page.evaluate(GEOM)
        self.view(page)
        menu = page.locator('#workspace-server-menu')
        if menu.get_attribute('open') is None:
            menu.locator('summary').click()
        save = page.get_by_role('button', name='Save to Account', exact=True)
        expect(save).to_be_enabled()
        save.click()
        expect(page.locator('#workspace-server-status')).to_contain_text('현재 배치를 계정에 저장')
        self.assertEqual(['thumbnail', 'template'], site.layout['workspace']['hiddenPanels'])
        # Another browser of the same account (empty storage, same server) shows every panel until it loads the account.
        other = self.open(site)
        self.assertIsNotNone(other.evaluate(BAND)['template'])
        self.view(other)
        menu = other.locator('#workspace-server-menu')
        if menu.get_attribute('open') is None:
            menu.locator('summary').click()
        other.get_by_role('button', name='Load from Account', exact=True).click()
        expect(other.locator('#workspace-server-status')).to_contain_text('서버 배치를 불러왔습니다')
        other.locator('#toolbar-view > summary').click()
        settle(other)
        band = other.evaluate(BAND)
        self.assertIsNone(band['template'])
        self.assertIsNone(band['thumbwrap'])
        loaded = other.evaluate(GEOM)
        self.assertEqual(self.stored(page)['landscape'], self.stored(other)['landscape'])
        self.assertEqual(saved['rw'][3], loaded['rw'][3])
        self.assert_same_content(saved, loaded, 'account Load')
        # The loaded mask in Technician: Template is unavailable there anyway, Thumbnail stays hidden.
        self.assert_allocation(self.switch(other, 'Technician'), 'Technician', ['clinical'], 'loaded, Technician')
        self.assertEqual(['thumbnail', 'template'], self.stored(other)['workspace']['hiddenPanels'])
        # A different account in this browser has its own record: nothing hidden.
        second = WorkspaceSite()
        second.login_as = auth.RAD_OTHER
        page = self.open(second)
        band = page.evaluate(BAND)
        self.assertIsNotNone(band['template'])
        self.assertIsNotNone(band['thumbwrap'])

    def test_wspace_g1_placeholder_toggles_never_move_content(self):
        """TEST-WSPACE-G1 (RISK-WSPACE-WIDTH, invariant 1): AI Report / Image Report, one, the other or both, with
        Thumbnail shown and hidden, and Technician's unavailable Reading Template, leave every content panel where it was;
        a state restored from storage paints the same."""
        for mode in MODES:
            for width, height in SIZES:
                with self.subTest(mode=mode, size=f'{width}x{height}'):
                    site = WorkspaceSite()
                    page = self.open(site, width, height)
                    self.switch(page, mode)
                    for hidden in ([], ['thumbnail']):
                        base = self.set_panels(page, {'thumbnail': False}) if hidden else page.evaluate(GEOM)
                        visible = [k for k in SHARES[mode] if k not in hidden]
                        self.assert_allocation(base, mode, visible, 'base')
                        for tabs in (['aiReport'], ['imageReport'], ['aiReport', 'imageReport']):
                            g = self.set_panels(page, {k: False for k in tabs})
                            self.assert_allocation(g, mode, visible, f'{hidden} {tabs} hidden')
                            self.assert_same_content(base, g, f'{mode} {hidden} {tabs} hidden')
                            again = self.set_panels(page, {k: True for k in tabs})
                            self.assert_same_content(base, again, f'{mode} {hidden} {tabs} shown again')
                    page.screenshot(path=str(OUT / f'g1-{mode}-thumbnail-hidden-{width}x{height}.png'))
                    base = self.set_panels(page, {'thumbnail': True})
                    if mode == 'Technician':
                        # Technician has no Reading Template: the reader's choice for it moves nothing here.
                        g = self.set_panels(page, {'template': False})
                        self.assertEqual(base['rw'], g['rw'])
                        self.assert_same_content(base, g, 'template preference in Technician')
                        self.assertEqual(['template'], self.stored(page)['workspace']['hiddenPanels'])
                        self.set_panels(page, {'template': True})
                    # A stored state: Thumbnail and AI Report hidden, then a reload in this mode.
                    live = self.set_panels(page, {'thumbnail': False, 'aiReport': False})
                    self.reload(page, site)
                    again = self.switch(page, mode)
                    self.assert_allocation(again, mode, [k for k in SHARES[mode] if k != 'thumbnail'], 'stored')
                    self.assert_same_content(live, again, f'{mode} stored state')
                    self.assertEqual(['Image Report'], again['tabs'])

    def test_wspace_g2_a_hidden_content_panel_gives_its_width_only_to_the_others(self):
        """TEST-WSPACE-G2 (RISK-WSPACE-WIDTH, invariant 2): each available content panel alone, then one after another
        until one is left: the survivors share the band in the mode's proportions, fill it and never narrow."""
        for mode in MODES:
            for width, height in SIZES:
                with self.subTest(mode=mode, size=f'{width}x{height}'):
                    page = self.open(WorkspaceSite(), width, height)
                    start = self.switch(page, mode)
                    available = list(SHARES[mode])
                    self.assert_allocation(start, mode, available, 'start')
                    for gone in available:
                        g = self.set_panels(page, {gone: False})
                        survivors = [k for k in available if k != gone]
                        self.assert_allocation(g, mode, survivors, f'{gone} hidden')
                        for key in survivors:
                            self.assertGreater(content(g)[key], content(start)[key] + (-0.5 if stacked(g) else 0.5), f'{mode} {gone} {key}')
                        self.assertAlmostEqual(g['usable'], sum(content(g).values()), delta=1)
                        # The band keeps its height while content remains (stacked: the hidden panel's height goes).
                        if not stacked(g):
                            self.assertEqual(start['rw'][3], g['rw'][3])
                        self.assert_same_content(start, self.set_panels(page, {gone: True}), f'{mode} {gone} shown again')
                    previous, hidden = start, []
                    for gone in available[:-1]:
                        hidden.append(gone)
                        g = self.set_panels(page, {gone: False})
                        survivors = [k for k in available if k not in hidden]
                        self.assert_allocation(g, mode, survivors, f'{hidden} hidden')
                        for key in survivors:
                            self.assertGreaterEqual(content(g)[key], content(previous)[key] - 0.5, f'{mode} {hidden} {key}')
                        previous = g
                    # The one survivor has the band and its own scroll box, not a clipped control row.
                    last = available[-1]
                    self.assertAlmostEqual(previous['usable'], content(previous)[last], delta=0.5)
                    overflow = page.evaluate('''() => { const n = document.querySelector('.rw > .s-clinical');
                      return n ? [getComputedStyle(n).overflowY, n.scrollWidth - n.clientWidth] : null; }''')
                    if overflow:
                        self.assertEqual('auto', overflow[0])
                        self.assertLessEqual(overflow[1], 1)
                    page.screenshot(path=str(OUT / f'g2-{mode}-one-left-{width}x{height}.png'))

    def test_wspace_g3_showing_and_mode_round_trips_restore_the_same_layout(self):
        """TEST-WSPACE-G3 (RISK-WSPACE-WIDTH, invariant 3): A->B->A both ways with a real hidden preference, hide order,
        showing each panel, Show All Panels, and the saved-search route to Technician."""
        for width, height in SIZES:
            with self.subTest(size=f'{width}x{height}'):
                site = FilterSite()
                page = self.open(site, width, height)
                r0 = page.evaluate(GEOM)
                t0 = self.switch(page, 'Technician')
                self.assert_allocation(t0, 'Technician', ['thumbnail', 'clinical'], 't0')
                self.assert_same_content(r0, self.switch(page, 'Radiology'), 'Radiology after Technician')
                # The saved search's mode change paints what the tab does.
                page.locator('#toolbar-filters > summary').click()
                page.locator('#chips button[data-i]', has_text=FilterSite.SAVED['name']).click()
                expect(page.locator('.tabs > div[data-tab="Technician"]')).to_have_class('on')
                page.locator('#toolbar-filters > summary').click()   # its open menu takes toolbar height
                settle(page)
                self.assert_same_content(t0, page.evaluate(GEOM), 'saved search to Technician')
                self.switch(page, 'Radiology')
                # A real hidden preference survives both directions and returns the same geometry.
                r1 = self.set_panels(page, {'template': False, 'aiReport': False})
                self.assert_allocation(r1, 'Radiology', ['thumbnail', 'clinical'], 'r1')
                t1 = self.switch(page, 'Technician')
                self.assert_allocation(t1, 'Technician', ['thumbnail', 'clinical'], 't1')
                self.assert_same_content(t0, t1, 'Technician with Template hidden')
                self.assertEqual(['aiReport', 'template'], self.stored(page)['workspace']['hiddenPanels'])
                dialog = self.panels(page)
                expect(dialog.get_by_label('Reading Template', exact=True)).not_to_be_checked()
                dialog.get_by_role('button', name='Close', exact=True).click()
                page.locator('#toolbar-view > summary').click()
                settle(page)
                self.assert_same_content(r1, self.switch(page, 'Radiology'), 'R -> T -> R')
                t2 = self.switch(page, 'Technician')
                self.switch(page, 'Radiology')
                self.assert_same_content(t2, self.switch(page, 'Technician'), 'T -> R -> T')
                self.assertEqual(['aiReport', 'template'], self.stored(page)['workspace']['hiddenPanels'])
                self.switch(page, 'Radiology')
                self.show_all(page)
                # Hide order has no lasting effect; showing a panel returns the set's own layout.
                only_clinical = self.set_panels(page, {'clinical': False})
                a = self.set_panels(page, {'thumbnail': False})
                self.show_all(page)
                self.set_panels(page, {'thumbnail': False})
                b = self.set_panels(page, {'clinical': False})
                self.assert_same_content(a, b, 'hide order')
                self.assert_allocation(b, 'Radiology', ['template'], 'thumbnail and clinical hidden')
                self.assert_same_content(only_clinical, self.set_panels(page, {'thumbnail': True}), 'Thumbnail shown again')
                back = self.show_all(page)
                self.assert_same_content(r0, back, 'Show All Panels')
                self.assertEqual(shown(r0), shown(back))
                # A portrait band without a stored height yields to the prior report line by the toolbar's height (D383),
                # and the applied search adds its name line to the toolbar.
                if width > height:
                    self.assertEqual(r0['rw'][3], back['rw'][3])

    def drag_top(self, page, dy):
        grip = page.locator('#resize-top').bounding_box()
        x, y = grip['x'] + grip['width'] / 2, grip['y'] + grip['height'] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x, y + dy / 2, steps=4)
        page.mouse.move(x, y + dy, steps=4)
        page.mouse.up()
        settle(page)

    def test_wspace_g4_saved_geometry_stays_the_readers_intent(self):
        """TEST-WSPACE-G4 (RISK-WSPACE-PREFERENCE, invariant 4): a dragged and a keyed band height survive hiding,
        showing, a mode switch, a reload and a smaller window; nothing rendered is written back to the record."""
        for mode in MODES:
            for width, height in SIZES:
                with self.subTest(mode=mode, size=f'{width}x{height}'):
                    site = WorkspaceSite()
                    page = self.open(site, width, height)
                    self.switch(page, mode)
                    axis = 'portrait' if height > width else 'landscape'
                    self.drag_top(page, 30)
                    self.assertIsNotNone(self.stored(page)[axis]['top'])
                    dragged = page.evaluate(GEOM)['rw'][3]
                    # The key moves from the drawn separator, respecting the existing 140 px drag minimum.
                    # Preload's list floor can leave a tight portrait band already at that minimum.
                    page.locator('#resize-top').focus()
                    page.keyboard.press('ArrowUp')
                    settle(page)
                    record = self.stored(page)
                    self.assertAlmostEqual(max(140, dragged - 10), record[axis]['top'], delta=1)
                    sizes = {a: record[a] for a in ('portrait', 'landscape')}
                    start = page.evaluate(GEOM)
                    self.assertAlmostEqual(record[axis]['top'], start['rw'][3], delta=1)
                    available = list(SHARES[mode])
                    self.set_panels(page, {available[1]: False})
                    self.set_panels(page, {k: False for k in available})   # tabs only
                    other = 'Technician' if mode == 'Radiology' else 'Radiology'
                    self.switch(page, other)
                    self.switch(page, mode)
                    self.assertEqual(sizes, {a: self.stored(page)[a] for a in sizes})
                    self.reload(page, site)
                    self.switch(page, mode)
                    back = self.show_all(page)
                    self.assertEqual(start['rw'][3], back['rw'][3])
                    self.assert_same_content(start, back, 'reload and Show All')
                    self.assertEqual(sizes, {a: self.stored(page)[a] for a in sizes})
                    # A smaller window clamps for now; the original window returns the saved geometry.
                    page.set_viewport_size({'width': int(width * 0.8), 'height': int(height * 0.8)})
                    settle(page)
                    page.set_viewport_size({'width': width, 'height': height})
                    settle(page)
                    again = page.evaluate(GEOM)
                    self.assertEqual(start['rw'][3], again['rw'][3])
                    self.assert_same_content(start, again, 'smaller window and back')
                    self.assertEqual(sizes, {a: self.stored(page)[a] for a in sizes})

    def test_wspace_g5_tabs_only_and_empty_band_return_their_height(self):
        """TEST-WSPACE-G5 (RISK-WSPACE-EMPTY, invariant 5): with every content panel the mode can show hidden the band is
        the tab strip without a separator; without tabs it is gone; the report (Radiology) or order list (Technician)
        gets the height, or the stacked row moves up; showing content returns the saved height."""
        for mode in MODES:
            for width, height in SIZES:
                with self.subTest(mode=mode, size=f'{width}x{height}'):
                    site = WorkspaceSite()
                    page = self.open(site, width, height)
                    self.switch(page, mode)
                    portrait = height > width
                    axis = 'portrait' if portrait else 'landscape'
                    self.drag_top(page, 30)
                    start = page.evaluate(GEOM)
                    stored = self.stored(page)[axis]['top']
                    self.assertIsNotNone(stored)
                    band = self.set_panels(page, {k: False for k in SHARES[mode]})
                    self.assertEqual(['AI Report', 'Image Report'], band['tabs'])
                    self.assertIsNone(band['thumbwrap'])
                    self.assertAlmostEqual(band['rw'][3], band['rtabs'][3], delta=1)
                    self.assertAlmostEqual(band['rw'][2], band['rtabs'][2], delta=1)
                    self.assertIsNone(band['separator'])
                    freed = start['rw'][3] + start['separator'][3] - band['rw'][3]
                    if not portrait:
                        self.assertAlmostEqual(self.receiver(band)[3], self.receiver(start)[3] + freed, delta=1)
                    else:
                        self.assertAlmostEqual(band['workrow'][1], start['workrow'][1] - freed, delta=1)
                    self.assertEqual(start['split'], band['split'])
                    page.screenshot(path=str(OUT / f'g5-{mode}-tabs-only-{width}x{height}.png'))
                    gone = self.set_panels(page, {k: False for k in PLACEHOLDERS})
                    self.assertIsNone(gone['rw'])
                    self.assertIsNone(gone['separator'])
                    freed = start['rw'][3] + start['separator'][3]
                    if not portrait:
                        self.assertAlmostEqual(self.receiver(gone)[3], self.receiver(start)[3] + freed, delta=1)
                    else:
                        self.assertAlmostEqual(gone['workrow'][1], start['workrow'][1] - freed, delta=1)
                    self.assert_row_on_top(gone, portrait)
                    self.assertEqual(stored, self.stored(page)[axis]['top'])
                    self.reload(page, site)
                    self.switch(page, mode)
                    self.assertIsNone(page.evaluate(GEOM)['rw'])
                    back = self.set_panels(page, {'clinical': True})
                    self.assertEqual(start['rw'][3], back['rw'][3])
                    self.assertIsNotNone(back['separator'])
                    self.assertEqual(stored, self.stored(page)[axis]['top'])

    def test_wspace_g5_multi_study_keeps_the_tab_strip(self):
        """TEST-WSPACE-G5 for the contract's named Multi-Study consumer (WS-06): two studies opened with Open Selected
        Studies, then every content panel hidden. Its composition and work-row floor press on the band in a short window;
        the placeholder tabs stay a readable full-width strip, the band is gone without them, Show All returns it."""
        for width, height in SIZES:
            with self.subTest(size=f'{width}x{height}'):
                site = multi.W9Site()
                context = self.browser.new_context(viewport={'width': width, 'height': height})
                context.route('**/*', lambda route, request, s=site: s.handle(route, request))
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.on('dialog', lambda d: d.accept())
                self.addCleanup(context.close)
                self.addCleanup(lambda e=errors: self.assertEqual([], e))
                self.addCleanup(lambda s=site: self.assertEqual([], s.violations))
                page.goto(auth.MAIN_URL)
                expect(page.locator('#rows')).to_contain_text(multi.ALPHA)
                settle(page)
                site.viewer_owner = page.evaluate(
                    '() => KinViewerOpening.key(KinAuth.session()).slice(KinViewerOpening.PREFIX.length)')
                for uid in page.locator('#rows tr[data-uid]').evaluate_all('rows => rows.slice(0, 2).map(r => r.dataset.uid)'):
                    page.locator(f'#rows tr[data-uid="{uid}"]').click(modifiers=['Control'])
                page.locator('#multi-selection-open-set').click()
                expect(page.locator('#multi-study')).to_be_visible()
                settle(page)
                start = page.evaluate(GEOM)
                self.assert_allocation(start, 'Radiology', list(SHARES['Radiology']), 'Multi-Study')
                for left in (['AI Report', 'Image Report'], ['Image Report']):
                    hide = {k: False for k in SHARES['Radiology']} if len(left) == 2 else {'aiReport': False}
                    band = self.set_panels(page, hide)
                    info = f'Multi-Study {left} {band}'
                    self.assertEqual(left, band['tabs'], info)
                    self.assertIsNone(band['thumbwrap'], info)
                    self.assertIsNone(band['separator'], info)
                    self.assertGreater(band['rtabs'][3], 0, info)
                    self.assertAlmostEqual(band['rw'][3], band['rtabs'][3], delta=1, msg=info)
                    self.assertAlmostEqual(band['rw'][2], band['rtabs'][2], delta=1, msg=info)
                    # The labels are what is drawn at their own centres, not the Multi-Study heading under them.
                    hits = page.evaluate('''() => [...document.querySelectorAll('.rw .rtabs > div')]
                      .filter(n => n.getClientRects().length).map(n => { const b = n.getBoundingClientRect();
                        return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('.rtabs > div')?.textContent ?? null; })''')
                    self.assertEqual(left, hits, info)
                page.screenshot(path=str(OUT / f'g5-multi-study-tabs-only-{width}x{height}.png'))
                gone = self.set_panels(page, {'imageReport': False})
                self.assertIsNone(gone['rw'])
                self.assertIsNone(gone['separator'])
                back = self.show_all(page)
                self.assert_same_content(start, back, 'Multi-Study Show All')
                page.locator('#multi-study-close').click()
                expect(page.locator('#multi-study')).to_be_hidden()
                settle(page)
                self.assert_allocation(page.evaluate(GEOM), 'Radiology', list(SHARES['Radiology']), 'Multi-Study closed')

    def test_wspace_g_responsive_600_601_and_the_selected_study_sheet(self):
        """The contract's responsive consumers of G1/G2/G5: at 600 px the stacked panels are full width and the band is
        exactly the shown panels (Technician has no Template height); at 601 px the shares apply; the 840x768
        selected-study sheet keeps its compact band for content and only the strip when tabs alone are left."""
        for mode in MODES:
            for width in (600, 601):
                with self.subTest(mode=mode, size=f'{width}x1024'):
                    page = self.open(WorkspaceSite(), width, 1024)
                    g = self.switch(page, mode)
                    self.assertEqual(width == 600, stacked(g))
                    self.assert_allocation(g, mode, list(SHARES[mode]), 'start')
                    if stacked(g):
                        parts = sum(g[k][3] for k in ('thumb', 'clinical', 'template') if g[k])
                        self.assertAlmostEqual(parts, g['rw'][3], delta=1)
                    tabs = self.set_panels(page, {'aiReport': False})
                    self.assert_same_content(g, tabs, 'AI Report hidden')
                    self.assertEqual(g['rw'][3], tabs['rw'][3])
                    hidden = self.set_panels(page, {'thumbnail': False})
                    self.assert_allocation(hidden, mode, [k for k in SHARES[mode] if k != 'thumbnail'], 'thumbnail hidden')
                    if stacked(hidden):
                        parts = sum(hidden[k][3] for k in ('thumb', 'clinical', 'template') if hidden[k])
                        self.assertAlmostEqual(parts, hidden['rw'][3], delta=1)
                    page.screenshot(path=str(OUT / f'g-responsive-{mode}-{width}x1024.png'))
            with self.subTest(mode=mode, size='840x768 selected'):
                site = WorkspaceSite()
                page = self.open(site, 840, 768)
                self.switch(page, mode)
                page.locator('#rows tr[data-uid]').first.click()
                settle(page)
                g = page.evaluate(GEOM)
                self.assert_allocation(g, mode, list(SHARES[mode]), 'compact sheet')
                band = self.set_panels(page, {k: False for k in SHARES[mode]})
                self.assertAlmostEqual(band['rw'][3], band['rtabs'][3], delta=1)
                self.assertIsNone(band['separator'])
                gone = self.set_panels(page, {k: False for k in PLACEHOLDERS})
                self.assertIsNone(gone['rw'])
                back = self.show_all(page)
                self.assertAlmostEqual(g['rw'][3], back['rw'][3], delta=1)
                self.assert_same_content(g, back, 'compact sheet Show All')

    def test_wspace_g_study_panel_drawer_keeps_its_own_presentation(self):
        """The drawer shows the shared nodes whole whatever the band hides, and closing it returns them to the band's
        current mode and hidden panels."""
        for mode in MODES:
            with self.subTest(mode=mode):
                page = self.open(WorkspaceSite(), 1920, 1080)
                self.switch(page, mode)
                before = self.set_panels(page, {'thumbnail': False, 'aiReport': False})
                page.keyboard.press('Control+Alt+5')
                drawer = page.get_by_role('complementary', name='Study Panel', exact=True)
                expect(drawer).to_be_visible()
                drawer.get_by_role('tab', name='Images', exact=True).click()
                expect(drawer.get_by_role('tab', name='Images', exact=True)).to_have_attribute('aria-selected', 'true')
                inside = page.evaluate('''() => { const t = document.querySelector('#study-panel-host .s-thumb');
                  const w = t?.querySelector('.thumbwrap'), h = document.querySelector('#study-panel-host');
                  return t && [w.getClientRects().length > 0, t.getBoundingClientRect().width, h.querySelector('.study-panel').clientWidth]; }''')
                self.assertTrue(inside[0], 'Thumbnail content in the drawer')
                self.assertLessEqual(inside[1], inside[2] + 0.5)
                drawer.get_by_role('button', name='Close', exact=True).click()
                expect(drawer).to_have_count(0)
                settle(page)
                after = page.evaluate(GEOM)
                self.assert_allocation(after, mode, [k for k in SHARES[mode] if k != 'thumbnail'], 'after the drawer')
                self.assert_same_content(before, after, 'drawer closed')
                self.assertEqual(['Image Report'], after['tabs'])

    def column_order(self, page):
        return page.locator('#heads th').all_inner_texts()

    def names(self, page):
        return page.locator('#rows tr[data-uid]').evaluate_all(
            "rows => rows.map(r => [...r.cells].map(c => c.textContent).join('|')).map(t => t.includes('BRAVO') ? 'B' : 'A')")

    def test_wspace_dom_03_columns_drag_reorder_hide_and_reload_keep_filters_and_sorting(self):
        for width, height in SIZES[:2]:
            with self.subTest(size=f'{width}x{height}'):
                site = WorkspaceSite()
                site.second_study = True
                page = self.open(site, width, height)
                before = [t.strip() for t in self.column_order(page)]
                self.assertEqual(['PF', 'Assigned Reader', 'Tech Note', 'No'], [t.split('\n')[0].strip() for t in before[:4]])
                # Sorting and filtering before any column change.
                page.locator('#heads th', has_text='Name').first.click()
                sorted_once = self.names(page)
                page.locator('#heads th', has_text='Name').first.click()
                sorted_twice = self.names(page)
                self.assertEqual(sorted(sorted_once), sorted(sorted_twice))
                self.assertNotEqual(sorted_once, sorted_twice)
                self.view(page)
                page.get_by_role('button', name='Columns', exact=True).click()
                editor = page.locator('#column-manager')
                expect(editor).to_be_visible()
                rows = editor.locator('.wc-row')
                self.assertEqual(['pf', 'assignedReader', 'techNote', 'no'], rows.evaluate_all('r => r.slice(0, 4).map(n => n.dataset.column)'))
                # Drag No above PF by its grip.
                no, pf = editor.locator('.wc-row[data-column="no"]'), editor.locator('.wc-row[data-column="pf"]')
                no.locator('.wc-grip').drag_to(pf, target_position={'x': 40, 'y': 3})
                self.assertEqual(['no', 'pf', 'assignedReader', 'techNote'], rows.evaluate_all('r => r.slice(0, 4).map(n => n.dataset.column)'))
                # Drag Viewing below Count, then hide Viewing, Series and Assigned Reader.
                editor.locator('.wc-row[data-column="viewing"] .wc-grip').drag_to(
                    editor.locator('.wc-row[data-column="count"]'), target_position={'x': 40, 'y': 30})
                order = rows.evaluate_all('r => r.map(n => n.dataset.column)')
                self.assertEqual(order.index('count') + 1, order.index('viewing'))
                for name in ('Viewing', 'Series', 'Assigned Reader'):
                    editor.get_by_label('Show ' + name, exact=True).uncheck()
                editor.get_by_role('button', name='Apply & Save in Browser', exact=True).click()
                expect(editor).to_be_hidden()
                page.locator('#toolbar-view > summary').click()
                after = [t.split('\n')[0].strip() for t in self.column_order(page)]
                self.assertEqual(['No', 'PF', 'Tech Note', 'Count'], after[:4])
                for name in ('Viewing', 'Series', 'Assigned Reader'):
                    self.assertNotIn(name, after)
                stored = page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', COLUMNS_KEY)
                self.assertEqual(['no', 'pf'], stored['modes']['Radiology']['order'][:2])
                self.assertEqual(sorted(['viewing', 'series', 'assignedReader']), sorted(stored['modes']['Radiology']['hidden']))
                # Reload: order and hidden columns kept; sorting and the Name filter behave as before.
                self.reload(page, site)
                self.assertEqual(after, [t.split('\n')[0].strip() for t in self.column_order(page)])
                page.locator('#heads th', has_text='Name').first.click()
                self.assertEqual(sorted_once, self.names(page))
                page.locator('#heads th', has_text='Name').first.click()
                self.assertEqual(sorted_twice, self.names(page))
                name_filter = page.locator('#filterrow th').nth(after.index('Name')).locator('input')
                name_filter.fill('BRAVO')
                expect(page.locator('#rows tr[data-uid]')).to_have_count(1)
                expect(page.locator('#rows tr[data-uid]')).to_contain_text(auth.PATIENT_B)
                name_filter.fill('')
                expect(page.locator('#rows tr[data-uid]')).to_have_count(2)
                page.screenshot(path=str(OUT / f'columns-{width}x{height}.png'))

    def test_wspace_dom_04_palette_is_the_default_and_a_saved_text_colour_is_kept(self):
        rgb = lambda value: 'rgb(%d, %d, %d)' % tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))
        site = WorkspaceSite()
        site.second_study = True
        page = self.open(site)
        page.locator('#rows tr[data-uid]').first.click()
        settle(page)
        colours = page.evaluate('''() => { const s = (q, p) => getComputedStyle(document.querySelector(q))[p];
          return { body: s('body', 'backgroundColor'), text: s('body', 'color'), menubar: s('.menubar', 'backgroundColor'),
            band: s('.rw h3', 'backgroundColor'), muted: s('.rw h3', 'color'), cell: s('#rows tr[data-uid] td', 'color'),
            selected: s('#rows tr.sel td', 'backgroundColor'), tab: s('.rtabs', 'borderBottomColor'),
            editor: s('#findings', 'color'), editorBg: s('#findings', 'backgroundColor') }; }''')
        self.assertEqual(rgb('#212121'), colours['body'])
        self.assertEqual(rgb('#e3e3e3'), colours['text'])
        self.assertEqual(rgb('#2d2d2d'), colours['menubar'])
        self.assertEqual(rgb('#2d2d2d'), colours['band'])
        self.assertEqual(rgb('#b4b4b4'), colours['muted'])
        self.assertEqual(rgb('#e3e3e3'), colours['cell'])
        self.assertEqual(rgb('#e3e3e3'), colours['editor'])
        self.assertEqual(rgb('#212121'), colours['editorBg'])
        self.assertEqual('rgba(138, 180, 200, 0.2)', colours['selected'])
        self.assertEqual(rgb('#8ab4c8'), colours['tab'])
        page.screenshot(path=str(OUT / 'palette-1920x1080.png'))
        # A reader's saved personal text colours (Appearance & Tools) stay theirs.
        saved = json.dumps({'version': 1, 'list': 'warm', 'current': 'cool', 'prior': 'default'})
        init = 'localStorage.setItem(%s, %s)' % (json.dumps('kin-reading-color:v1:' + OWNER), json.dumps(saved))
        mine = self.open(WorkspaceSite(), init=init)
        kept = mine.evaluate('''() => [getComputedStyle(document.querySelector('#rows tr[data-uid] td')).color,
          getComputedStyle(document.querySelector('#findings')).color]''')
        self.assertEqual([rgb('#fff1d6'), rgb('#d7f3ff')], kept)
        self.assertEqual(saved, mine.evaluate('(key) => localStorage.getItem(key)', 'kin-reading-color:v1:' + OWNER))


if __name__ == '__main__':
    unittest.main()
