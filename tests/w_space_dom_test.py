"""W-SPACE: Minhoon 2026-10-27 feedback items 9, 10 and 11 on the served work page.

REQ (feedback.md items 9/10/11) -> RISK: a hidden panel leaves its space empty or comes back after a reload / under
another account; a dragged column order is lost or changes what the list filters and sorts; the palette overwrites a
reader's saved text colour; hiding one panel narrows another that is still shown; a band holding only placeholder tabs
keeps its height -> TEST-WSPACE-DOM-01..06.

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
        self.set_panel(page, 'Reading Template', False)
        self.set_panel(page, 'Thumbnail', False)
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
        # A different account in this browser has its own record: nothing hidden.
        second = WorkspaceSite()
        second.login_as = auth.RAD_OTHER
        page = self.open(second)
        band = page.evaluate(BAND)
        self.assertIsNotNone(band['template'])
        self.assertIsNotNone(band['thumbwrap'])

    def test_wspace_dom_05_hiding_one_panel_never_narrows_another_shown_panel(self):
        """From the first paint, each of the five panels alone: the panels still shown keep at least their width, the
        band keeps its height while a content panel remains, and showing the panel again returns the first paint."""
        content = {'Thumbnail': 'thumbwrap', 'Clinical Information': 'clinical', 'Reading Template': 'template'}
        for width, height in SIZES:
            site = WorkspaceSite()
            page = self.open(site, width, height)
            start = page.evaluate(BAND)
            for label in ('Thumbnail', 'AI Report', 'Image Report', 'Clinical Information', 'Reading Template'):
                with self.subTest(size=f'{width}x{height}', hidden=label):
                    # Shown again before any assertion, so every case starts from the first paint.
                    band = self.set_panel(page, label, False)
                    back = self.set_panel(page, label, True)
                    self.assertEqual(shown(start), shown(back))
                    for key in ('thumb', 'clinical', 'template'):
                        self.assertEqual([start[key][0], start[key][2]], [back[key][0], back[key][2]], key)
                    self.assertEqual(start['rw'][3], band['rw'][3])
                    self.assertEqual(start['workrow'], band['workrow'])
                    for key in ('thumb', 'clinical', 'template'):
                        if content.get(label) == key:
                            self.assertIsNone(band[key])
                        elif key == 'thumb' and label == 'Thumbnail':
                            self.assertLess(band[key][2], start[key][2])   # the tab strip only
                        else:
                            self.assertGreaterEqual(band[key][2], start[key][2] - 0.5, key)
                    if label in content:   # its width went to the panels still shown (at 1024 the tab strip frees ~18 px)
                        shown_now = [k for k in ('thumb', 'clinical', 'template') if band[k] and not (k == 'thumb' and label == 'Thumbnail')]
                        for key in shown_now:
                            self.assertGreater(band[key][2], start[key][2] + 2, key)
                    else:   # a placeholder tab gives up no panel width
                        for key in ('thumb', 'clinical', 'template'):
                            self.assertAlmostEqual(start[key][2], band[key][2], delta=0.5, msg=key)
                    total = sum(band[k][2] for k in ('thumb', 'clinical', 'template') if band[k])
                    self.assertAlmostEqual(band['rw'][2], total, delta=2)
            page.screenshot(path=str(OUT / f'panels-each-restored-{width}x{height}.png'))

    def test_wspace_dom_06_placeholder_tabs_alone_give_the_band_height_to_the_row_and_keep_the_stored_height(self):
        for width, height in SIZES:
            with self.subTest(size=f'{width}x{height}'):
                site = WorkspaceSite()
                page = self.open(site, width, height)
                portrait = height > width
                # A reader-chosen band height first: dragging the separator stores it.
                grip = page.locator('#resize-top').bounding_box()
                x, y = grip['x'] + grip['width'] / 2, grip['y'] + grip['height'] / 2
                page.mouse.move(x, y)
                page.mouse.down()
                page.mouse.move(x, y + 15, steps=4)
                page.mouse.move(x, y + 30, steps=4)
                page.mouse.up()
                settle(page)
                start = page.evaluate(BAND)
                axis = 'portrait' if portrait else 'landscape'
                stored = page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', KEY)[axis]['top']
                self.assertIsNotNone(stored)
                for label in ('Thumbnail', 'Clinical Information', 'Reading Template'):
                    band = self.set_panel(page, label, False)
                self.assertEqual(['AI Report', 'Image Report'], band['tabs'])
                self.assertIsNone(band['thumbwrap'])
                # The band is its tab strip, without the separator, and the strip spans the band.
                self.assertAlmostEqual(band['rw'][3], band['rtabs'][3], delta=1)
                self.assertAlmostEqual(band['rw'][2], band['rtabs'][2], delta=1)
                self.assertIsNone(band['separator'])
                freed = start['rw'][3] + start['separator'][3] - band['rw'][3]
                self.assertGreater(freed, 100)
                if not portrait:
                    self.assertAlmostEqual(band['workrow'][3], start['workrow'][3] + freed, delta=1)
                    self.assertAlmostEqual(band['report'][3], start['report'][3] + freed, delta=1)
                else:   # stacked: the row moves up by that height
                    self.assertAlmostEqual(band['workrow'][1], start['workrow'][1] - freed, delta=1)
                self.assertEqual(start['split'], band['split'])
                page.screenshot(path=str(OUT / f'panels-tabs-only-{width}x{height}.png'))
                record = page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', KEY)
                self.assertEqual(stored, record[axis]['top'])
                self.assertEqual(['thumbnail', 'clinical', 'template'], record['workspace']['hiddenPanels'])
                # A reload keeps the strip; a content panel shown again takes the stored band height back.
                self.reload(page, site)
                again = page.evaluate(BAND)
                self.assertAlmostEqual(again['rw'][3], again['rtabs'][3], delta=1)
                back = self.set_panel(page, 'Clinical Information', True)
                self.assertEqual(start['rw'][3], back['rw'][3])
                self.assertIsNotNone(back['separator'])
                self.assertEqual(stored, page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', KEY)[axis]['top'])

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
