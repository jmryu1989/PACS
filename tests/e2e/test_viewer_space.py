# coding: utf-8
"""V-SPACE (Minhoon feedback 2026-10-27 items 4 and 5): image area, per-cell scope and the reused window's place.

Item 4: one-line image tools and series rows; the reader's Studies/Measurement panel choice is kept per account in
this browser; image actions change only the cell they act on while no synchronizer is on.
Item 5: the single viewer window is reused, and a move made after the list reloaded is where it reopens.
Headless window coordinates are a browser reachability check, not physical monitor acceptance.
"""
import json
import os
from pathlib import Path
import re
import sys
import unittest
import uuid

from playwright.sync_api import expect

from test_prior_selection import canvas_ready
from test_viewer_layout import ViewerLayoutE2E
from test_viewer_windows import ViewerWindowsE2E


GEOMETRY = '''() => {
  const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return {x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height)}; };
  return { window: {width: innerWidth, height: innerHeight}, grid: r(document.querySelector('[data-cy=viewport-grid]')),
    canvases: [...document.querySelectorAll('[data-cy=viewport-pane] canvas.cornerstone-canvas')].map(r),
    toolbar: r(document.querySelector('[aria-label="Image Tools"]')), strip: r(document.querySelector('[aria-label="Series"]')),
    panels: Object.fromEntries(['left', 'right'].map(side => [side, r(document.querySelector('[data-cy=side-panel-header-' + side + ']')
      ?.closest('[style*="margin-' + side + '"]'))])) };
}'''
# The stock panel is open when its sliding margin is zero; its header toggles it.
PANEL_OPEN = '''side => { const box = document.querySelector('[data-cy=side-panel-header-' + side + ']')?.closest('[style*="margin-' + side + '"]');
  return box ? box.style[side === 'left' ? 'marginLeft' : 'marginRight'] === '0px' : null; }'''
CELL = '''id => { const v = services.cornerstoneViewportService.getCornerstoneViewport(id), p = v.getProperties();
  return {voi: p.voiRange && [p.voiRange.lower, p.voiRange.upper], invert: !!p.invert, scale: v.getCamera().parallelScale,
    flip: !!v.getCamera().flipHorizontal}; }'''


def evidence():
    folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/v-space/screens'))
    folder.mkdir(parents=True, exist_ok=True)
    return folder


class ViewerSpaceE2E(ViewerLayoutE2E):
    def viewer(self, page, fixture):
        page.set_viewport_size({'width': 1920, 'height': 1080})
        self.launch(page, [fixture])
        expect(page.get_by_role('toolbar', name='Frequent Tools').get_by_role('button', name='Zoom', exact=True)).to_be_visible()
        page.wait_for_function('() => window.kinViewerHistoryWorkspaceState?.()?.busy === false && window.kinViewerJobWorkspaceState?.()?.busy === false')
        return page

    def record(self, page, name):
        folder = evidence()
        (folder / (name + '.json')).write_text(json.dumps(page.evaluate(GEOMETRY), indent=1), encoding='utf-8')
        page.screenshot(path=str(folder / (name + '.png')))

    def test_space_01_one_line_tools_and_series(self):
        fixture = self.multiple('VSPACE-' + uuid.uuid4().hex[:12], 'current', '20260801')
        page = self.viewer(self.login(), fixture)
        self.grid(page, 2)
        page.wait_for_function('''() => [...services.viewportGridService.getState().viewports.values()]
          .every(c => services.cornerstoneViewportService.getCornerstoneViewport(c.viewportId)?.getCurrentImageId?.())''')
        self.record(page, 'space-01-1x2')
        bar = page.get_by_role('toolbar', name='Frequent Tools')
        tools = bar.get_by_role('button')
        self.assertGreater(tools.count(), 3)
        rows = bar.evaluate('''bar => [...bar.querySelectorAll('button')].map(b => {
          const r = b.getBoundingClientRect(), name = b.getAttribute('aria-label');
          return {name, top: Math.round(r.top), bottom: Math.round(r.bottom), title: b.title, shown: b.innerText.includes(name)}; })''')
        with self.subTest(contract='tools in one line, named by tooltip and accessible name'):
            self.assertEqual(len({row['top'] for row in rows}), 1, rows)
            self.assertTrue(all(row['name'] and row['title'].startswith(row['name']) for row in rows), rows)
            self.assertFalse([row for row in rows if row['shown']], 'tool names are not printed under the icons')
            box = bar.evaluate('b => b.closest("[aria-label=\\"Image Tools\\"]").getBoundingClientRect().height')
            self.assertLess(box, 2 * (rows[0]['bottom'] - rows[0]['top']), 'the tools row is one button high')
        # The reader still finds each name and key in More, which keeps the labelled list.
        page.get_by_label('Image Tools', exact=True).get_by_text('More', exact=True).click()
        more = page.get_by_role('group', name='More Tools').get_by_role('button')
        if more.count():
            expect(more.first).to_contain_text(more.first.get_attribute('aria-label'))
        page.keyboard.press('Escape')
        cards = page.get_by_role('region', name='Series', exact=True).locator('.kin-series-card')
        expect(cards).to_have_count(2)
        layout = cards.evaluate_all('''cards => cards.map(card => {
          const preview = card.firstElementChild.getBoundingClientRect(), text = [...card.children].slice(1).map(e => e.getBoundingClientRect());
          return {beside: text.every(t => t.left >= preview.right - 1 && t.top < preview.bottom), card: card.getBoundingClientRect().height,
            strip: card.closest('[aria-label="Series"]').getBoundingClientRect().height}; })''')
        with self.subTest(contract='series cards in one row: thumbnail beside number and title'):
            self.assertTrue(all(row['beside'] for row in layout), layout)
            self.assertTrue(all(row['card'] <= row['strip'] for row in layout), layout)
        expect(cards.first).to_have_attribute('aria-label', re.compile(r'^\d+/\d+ '))

    def test_space_02_side_panel_choice_follows_the_account(self):
        fixture = self.multiple('VSPACE-' + uuid.uuid4().hex[:12], 'current', '20260801')
        page = self.viewer(self.login(), fixture)
        self.assertEqual([page.evaluate(PANEL_OPEN, side) for side in ['left', 'right']], [True, False],
                         'the stock mode opens Studies and keeps Measurements closed until the reader chooses')
        self.record(page, 'space-02-first-entry')
        before = page.evaluate(GEOMETRY)
        page.locator('[data-cy=side-panel-header-left]').click()
        page.wait_for_function('side => (' + PANEL_OPEN + ')(side) === false', arg='left')
        page.wait_for_function('w => document.querySelector("[data-cy=viewport-grid]").getBoundingClientRect().width > w + 200',
                               arg=before['grid']['width'])
        self.record(page, 'space-02-studies-closed')
        # A new viewer document for the same account opens without the Studies panel.
        self.viewer(page, fixture)
        page.wait_for_function('side => (' + PANEL_OPEN + ')(side) === false', arg='left')
        self.assertFalse(page.evaluate(PANEL_OPEN, 'right'))
        after = page.evaluate(GEOMETRY)
        self.assertGreater(after['grid']['width'], before['grid']['width'] + 200)
        self.record(page, 'space-02-reopened-viewer')
        # Its own icon opens Measurements; that choice is kept the same way, and reopening Studies too.
        page.locator('[data-cy=trackedMeasurements-btn]').click()
        page.wait_for_function('side => (' + PANEL_OPEN + ')(side) === true', arg='right')
        page.locator('[data-cy=side-panel-header-left]').click()
        page.wait_for_function('side => (' + PANEL_OPEN + ')(side) === true', arg='left')
        page.wait_for_timeout(300)
        self.viewer(page, fixture)
        page.wait_for_function('() => ["left", "right"].every(side => (' + PANEL_OPEN + ')(side) === true)')
        page.locator('[data-cy=side-panel-header-right]').click()
        page.wait_for_function('side => (' + PANEL_OPEN + ')(side) === false', arg='right')
        page.wait_for_timeout(300)
        # Another account in its own browser keeps the stock entry.
        other = self.viewer(self.login('doctor2'), fixture)
        self.assertEqual([other.evaluate(PANEL_OPEN, side) for side in ['left', 'right']], [True, False])
        stored = page.evaluate("Object.entries(localStorage).filter(([k]) => k.startsWith('kin-viewer-side-panels:v1:'))")
        self.assertEqual(len(stored), 1, stored)
        self.assertEqual(json.loads(stored[0][1]), {'left': True, 'right': False})
        self.assertNotIn(fixture.uid, stored[0][0] + stored[0][1])

    def test_space_03_actions_stay_in_their_cell_without_sync(self):
        fixture = self.multiple('VSPACE-' + uuid.uuid4().hex[:12], 'current', '20260801')
        page = self.viewer(self.login(), fixture)
        self.grid(page, 2)
        self.drag(page, 'D02E second series', 1)
        page.wait_for_function('''() => [...services.viewportGridService.getState().viewports.values()]
          .every(c => services.cornerstoneViewportService.getCornerstoneViewport(c.viewportId)?.getCurrentImageId?.())''')
        ids = [cell['id'] for cell in self.cells(page)]
        self.assertEqual(len(ids), 2)
        synchronized = page.evaluate('''() => cornerstoneTools.SynchronizerManager.getAllSynchronizers()
          .filter(s => !s.isDisabled() && s._eventName !== cornerstoneTools.Enums.Events.SEGMENTATION_REPRESENTATION_ADDED)
          .map(s => s.id)''')
        self.assertEqual(synchronized, [], 'no image synchronizer is on by default')
        start = [page.evaluate(CELL, i) for i in ids]
        # Right-drag is window/level in a stack; drag inside the first cell only, once it is the active cell.
        canvas = page.locator('[data-viewport-uid="' + ids[0] + '"] canvas.cornerstone-canvas').bounding_box()
        page.mouse.click(canvas['x'] + 5, canvas['y'] + 5)
        page.wait_for_function('id => services.viewportGridService.getActiveViewportId() === id', arg=ids[0])
        x, y = canvas['x'] + canvas['width'] / 2, canvas['y'] + canvas['height'] / 2
        page.mouse.move(x, y); page.mouse.down(button='right'); page.mouse.move(x + 80, y + 60, steps=8); page.mouse.up(button='right')
        page.wait_for_function('([id, voi]) => JSON.stringify((' + CELL + ')(id).voi) !== JSON.stringify(voi)', arg=[ids[0], start[0]['voi']])
        windowed = [page.evaluate(CELL, i) for i in ids]
        self.assertEqual(windowed[1], start[1], 'window/level stays in the dragged cell')
        # Zoom and a toolbar action on the second cell leave the first as the reader left it.
        second = page.locator('[data-viewport-uid="' + ids[1] + '"] canvas.cornerstone-canvas').bounding_box()
        page.mouse.click(second['x'] + 5, second['y'] + 5)
        page.wait_for_function('id => services.viewportGridService.getActiveViewportId() === id', arg=ids[1])
        page.get_by_role('toolbar', name='Frequent Tools').get_by_role('button', name='Zoom', exact=True).click()
        box = page.locator('[data-viewport-uid="' + ids[1] + '"] canvas.cornerstone-canvas').bounding_box()
        x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x, y - 120, steps=8); page.mouse.up()
        try:
            page.wait_for_function('([id, scale]) => (' + CELL + ')(id).scale !== scale', arg=[ids[1], start[1]['scale']], timeout=10000)
        except Exception:
            print('ZOOM STATE', json.dumps(page.evaluate('''ids => ({active: services.viewportGridService.getActiveViewportId(), ids,
              tools: ids.map(id => { const v = services.cornerstoneViewportService.getCornerstoneViewport(id);
                const g = cornerstoneTools.ToolGroupManager.getToolGroupForViewport(v.id, v.renderingEngineId);
                return {group: g?.id, primary: g?.getActivePrimaryMouseButtonTool(), scale: v.getCamera().parallelScale}; })})''', ids)), flush=True)
            raise
        self.assertEqual(page.evaluate(CELL, ids[0]), windowed[0], 'zoom stays in the cell it was used on')
        self.record(page, 'space-03-independent-cells')


class ViewerWindowPlaceE2E(ViewerWindowsE2E):
    def test_space_05_reloaded_list_keeps_the_reused_window_place(self):
        a, _ = self.pair()
        b = self.ct('VSPACE-OTHER-' + uuid.uuid4().hex[:12], 'other patient', '20260715')
        p = self.sign_in(self.device())
        self.settings(p, 'window', False)
        self.close_settings(p)
        viewer = self.separate(p, a)
        # Reuse: another study replaces the same window's document instead of opening one.
        pages = len(p.context.pages)
        self.choose(p, b)
        p.locator('#m-filmbox').click()
        try:
            viewer.wait_for_url('**StudyInstanceUIDs=' + b.uid + '**', timeout=30000)
        except Exception:
            print('REUSE', viewer.url, len(p.context.pages), p.locator('#toast').inner_text(), flush=True)
            raise
        canvas_ready(viewer, 1)
        self.assertEqual(len(p.context.pages), pages)
        p.reload()
        expect(p.locator('#dbstat')).to_contain_text('DB Connected')
        saved = p.evaluate("() => localStorage.getItem('kin.ohif.current.rect')")
        viewer.evaluate('() => { moveTo(screenX + 37, screenY + 23); resizeTo(outerWidth - 41, outerHeight - 29); }')
        viewer.wait_for_timeout(300)
        moved = viewer.evaluate('() => ({left: screenX, top: screenY, width: outerWidth, height: outerHeight})')
        self.assertNotEqual(json.dumps(moved), saved, 'the move changed the window')
        for _ in range(30):
            moved = viewer.evaluate('() => ({left: screenX, top: screenY, width: outerWidth, height: outerHeight})')
            stored = p.evaluate("() => JSON.parse(localStorage.getItem('kin.ohif.current.rect'))")
            if stored == moved: break
            p.wait_for_timeout(500)
        print('PLACE', json.dumps(dict(saved=saved, moved=moved, stored=stored, viewer=viewer.url)), flush=True)
        self.assertEqual(stored, moved, 'the reloaded list saved the viewer the reader moved')
        viewer.close()
        self.choose(p, a)
        with p.context.expect_page() as opened:
            p.locator('#m-filmbox').click()
        reopened = opened.value
        reopened.wait_for_url('**/ohif/viewer?**')
        canvas_ready(reopened, 1)
        reopened.wait_for_function('''rect => Math.abs(screenX - rect.left) <= 16 && Math.abs(screenY - rect.top) <= 16 &&
          Math.abs(outerWidth - rect.width) <= 16 && Math.abs(outerHeight - rect.height) <= 16''', arg=moved, timeout=20000)


def load_tests(loader, tests, pattern):
    # Only the cases this module declares; the inherited layout/window cases run in their own profiles.
    return unittest.TestSuite(cls(name) for cls in (ViewerSpaceE2E, ViewerWindowPlaceE2E)
                              for name in sorted(cls.__dict__) if name.startswith('test_space_'))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main()

