"""Minhoon item 12 (MH-4): a reader's measurement marker colour and thickness on the served viewer.

REQ-MARKER-STYLE -> RISK-MARKER-RECORD (a display choice changes a mark's points, values or saved item),
RISK-MARKER-PARTIAL (some marks or open windows keep the old look), RISK-MARKER-ACCOUNT (the choice is lost
or crosses accounts) -> TEST-MARKER-STYLE-SERVED. The choice is made in the work page's Appearance & Tools
dialog; an open viewer window redraws its marks without a reload, a new viewer starts with it, the saved
item and measured value do not change, and the account appearance keeps it.
"""
import json
import os
import unittest
from pathlib import Path

from playwright.sync_api import expect
from document_session import document_request
from test_viewer_history import ViewerHistoryE2E
from viewer_tools import select_image_tool
from workspace_roaming_support import cleanup_workspace

# The drawn mark: stroke colour/width of its lines and handles, and the colour of its value text.
DRAWN = '''() => {
  const shapes = [], texts = [];
  for (const svg of document.querySelectorAll('svg.svg-layer')) {
    for (const e of svg.querySelectorAll('[stroke]')) if (!e.closest('text') && e.getAttribute('stroke') !== 'none')
      shapes.push({tag: e.tagName, stroke: e.getAttribute('stroke'), width: Number(e.getAttribute('stroke-width')), dash: e.getAttribute('stroke-dasharray') || ''});
    for (const e of svg.querySelectorAll('text')) if (e.textContent.trim()) texts.push({fill: e.getAttribute('fill'), text: e.textContent});
  }
  return {shapes, texts};
}'''
LENGTH = '''() => { const a = cornerstoneTools.annotation.state.getAllAnnotations().find(a => a.metadata.toolName === 'Length');
  return a && {points: a.data.handles.points, stats: a.data.cachedStats}; }'''
SELECTION = ['rgb(0, 255, 0)', 'rgb(0, 220, 0)']


class MarkerStyleE2E(ViewerHistoryE2E):
    def setUp(self):
        super().setUp()
        self.addCleanup(cleanup_workspace, self.stack, 'ReadingAppearance')

    def settings(self, work):
        self.open_toolbar_group(work, '#reading-appearance-open')
        work.locator('#reading-appearance-open').click()
        expect(work.locator('#appearance-account-save')).to_be_enabled()

    def rest(self, page):
        # Point at an empty corner of the image and clear the selection, as a reader does, so no
        # mark is drawn in its hover or selection colour.
        corner = page.evaluate('''() => services.cornerstoneViewportService.getCornerstoneViewport(
            services.viewportGridService.getActiveViewportId()).element.querySelector('canvas').getBoundingClientRect().toJSON()''')
        page.mouse.move(corner['x'] + 30, corner['y'] + 30, steps=4); page.mouse.move(corner['x'] + 8, corner['y'] + 8, steps=4)
        page.evaluate('''() => { cornerstoneTools.annotation.selection.deselectAnnotation?.();
            for (const engine of cornerstone.getRenderingEngines()) engine.render(); }''')
        page.wait_for_function('''selection => { const shapes = [...document.querySelectorAll('svg.svg-layer [stroke]')]
            .filter(e => !e.closest('text') && e.getAttribute('stroke') !== 'none');
            return shapes.length > 0 && shapes.every(e => !selection.includes(e.getAttribute('stroke'))); }''', arg=SELECTION)
        return page.evaluate(DRAWN)

    def wait_drawn(self, page, color, width):
        page.wait_for_function('''([color, width]) => { const shapes = [...document.querySelectorAll('svg.svg-layer [stroke]')]
            .filter(e => !e.closest('text') && e.getAttribute('stroke') !== 'none' && !e.getAttribute('stroke-dasharray'));
            return shapes.length > 0 && shapes.every(e => e.getAttribute('stroke') === color) &&
              Math.max(...shapes.map(e => Number(e.getAttribute('stroke-width')))) === width; }''', arg=[color, width], timeout=15000)
        return page.evaluate(DRAWN)

    def test_marker_style_01_open_windows_redraw_and_records_stay(self):
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/marker-style'))
        folder.mkdir(parents=True, exist_ok=True)
        f = self.fixture(); self.seed_report(f)
        work, page = self.open_viewer(f)
        select_image_tool(page, 'Length')
        box = page.evaluate('''() => services.cornerstoneViewportService.getCornerstoneViewport(
            services.viewportGridService.getActiveViewportId()).element.querySelector('canvas').getBoundingClientRect().toJSON()''')
        x, y = box['x'] + box['width'] * .4, box['y'] + box['height'] * .4
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 80, y + 50, steps=10); page.mouse.up()
        row = page.locator('#kin-viewer-history section[data-kind=length]')
        expect(row).to_have_count(1)
        page.wait_for_function('''() => cornerstoneTools.annotation.state.getAllAnnotations().some(a => a.metadata.toolName === 'Length' &&
            Object.values(a.data.cachedStats || {}).some(s => s.length > 0))''')
        row.get_by_role('button', name='Save', exact=True).click()
        expect(row).to_contain_text('저장 완료')
        saved = self.saved(f)
        measured = page.evaluate(LENGTH)
        base = self.rest(page)
        base_color = base['shapes'][0]['stroke']
        base_width = max(s['width'] for s in base['shapes'] if not s['dash'])
        page.screenshot(path=str(folder / 'marker-default.png'))
        page.evaluate('window.kinMarkerProbe = 1')

        # The work page's dialog changes the account's choice; the open viewer window follows at once.
        self.settings(work)
        expect(work.locator('#reading-marker-color option')).to_have_count(5)
        expect(work.locator('#reading-marker-width option')).to_have_count(3)
        work.locator('#reading-marker-color').select_option('red')
        work.locator('#reading-marker-width').select_option('thick')
        expect(work.locator('#reading-marker-status')).to_contain_text('적용')
        red = self.wait_drawn(page, 'rgb(255, 64, 64)', base_width * 2)
        self.assertTrue(red['texts'] and all(t['fill'] == 'rgb(255, 64, 64)' for t in red['texts']), red['texts'])
        self.assertEqual(page.evaluate('window.kinMarkerProbe'), 1, 'the viewer window was not reloaded')
        self.assertEqual(page.evaluate(LENGTH), measured, 'points and measured values never follow the display choice')
        self.assertEqual([t['text'] for t in red['texts']], [t['text'] for t in base['texts']])
        self.assertEqual(self.saved(f), saved, 'the saved item holds no display choice')
        page.screenshot(path=str(folder / 'marker-red-thick.png'))

        # A viewer opened afterwards starts with the choice, on the saved mark it loads.
        other = work.context.new_page()
        other.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + f.uid)
        self.open_measurement_tools(other)
        other.wait_for_function("() => cornerstoneTools.annotation.state.getAllAnnotations().some(a => a.metadata.toolName === 'Length')", timeout=60000)
        self.rest(other)
        self.wait_drawn(other, 'rgb(255, 64, 64)', base_width * 2)

        # The account keeps the choice; an older-format save cannot replace it.
        work.locator('#appearance-account-save').click()
        expect(work.locator('#appearance-account-status')).to_have_text('표시 설정을 계정에 저장했습니다.')
        stored = document_request(work, 'GET', self.stack.api + '/reading-appearance').json()
        self.assertEqual(stored['sizes']['version'], 10)
        self.assertEqual(stored['sizes']['markers'], {'version': 1, 'color': 'red', 'width': 'thick'})

        # Reset returns both windows to the viewer's own style.
        work.locator('#reading-marker-reset').click()
        for target in [page, other]:
            back = self.wait_drawn(target, base_color, base_width)
            self.assertTrue(all(t['fill'] == base['texts'][0]['fill'] for t in back['texts']))
        self.assertEqual(page.evaluate(LENGTH), measured)
        (folder / 'marker-style.json').write_text(json.dumps({'study': f.uid, 'base': base, 'red': red, 'stored': stored['sizes']['markers']},
                                                             ensure_ascii=False, indent=2), encoding='utf-8')
        other.close(); page.close(); work.close()


if __name__ == '__main__':
    unittest.main()
