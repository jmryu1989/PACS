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

# The Length mark as drawn: its own SVG nodes, their stroke colour/width, the colour of its value text, and the
# pointer-feedback colours the viewer uses now. Only the mark's main line carries a data-id in the DOM; the
# tools' public SVG node cache (cornerstoneTools.state.svgNodeCache, per viewport, keyed by annotation UID and
# drawn part) names all of them, the value text and its link line included.
DRAWN = '''() => {
  const ct = cornerstoneTools, a = ct.annotation.state.getAllAnnotations().find(a => a.metadata.toolName === 'Length');
  const style = ct.annotation.config.style.getDefaultToolStyles().global || {};
  const out = {uid: a?.annotationUID || null, highlighted: !!a?.highlighted, selected: !!(a && ct.annotation.selection.isAnnotationSelected?.(a.annotationUID)),
    locked: !!(a && ct.annotation.locking.isAnnotationLocked?.(a.annotationUID)), feedback: [style.colorHighlighted, style.colorSelected].filter(Boolean),
    own: a && ct.annotation.locking.isAnnotationLocked?.(a.annotationUID) ? style.colorLocked : style.color,
    keyed: [], shapes: [], texts: []};
  if (!a) return out;
  const nodes = new Set();
  for (const canvas of Object.values(ct.state?.svgNodeCache || {})) for (const [key, entry] of Object.entries(canvas || {})) {
    const root = entry?.domRef;
    if (!key.includes(a.annotationUID) || !root?.isConnected) continue;
    out.keyed.push(key); nodes.add(root); root.querySelectorAll('*').forEach(n => nodes.add(n));
  }
  for (const e of nodes) {
    if (e.tagName === 'text') { if (e.textContent.trim()) out.texts.push({fill: e.getAttribute('fill'), text: e.textContent}); continue; }
    if (e.closest('text') || !e.hasAttribute('stroke') || e.getAttribute('stroke') === 'none') continue;
    out.shapes.push({tag: e.tagName, stroke: e.getAttribute('stroke'), width: Number(e.getAttribute('stroke-width')), dash: e.getAttribute('stroke-dasharray') || ''});
  }
  return out;
}'''
# Everything needed to read a failed wait: every drawn SVG node, the annotations' states and the live styles.
DIAGNOSIS = '''() => ({
  svg: [...document.querySelectorAll('svg.svg-layer *')].slice(0, 300).map(e => ({tag: e.tagName, id: e.getAttribute('data-id'),
    stroke: e.getAttribute('stroke'), width: e.getAttribute('stroke-width'), fill: e.getAttribute('fill'), text: e.tagName === 'text' ? e.textContent : undefined})),
  annotations: cornerstoneTools.annotation.state.getAllAnnotations().map(a => ({uid: a.annotationUID, tool: a.metadata.toolName,
    highlighted: a.highlighted, locked: cornerstoneTools.annotation.locking.isAnnotationLocked?.(a.annotationUID),
    selected: cornerstoneTools.annotation.selection.isAnnotationSelected?.(a.annotationUID), visible: a.isVisible})),
  styles: cornerstoneTools.annotation.config.style.getDefaultToolStyles(),
  active: document.activeElement?.outerHTML?.slice(0, 200)})'''
STYLES = '() => cornerstoneTools.annotation.config.style.getDefaultToolStyles()'
LENGTH = '''() => { const a = cornerstoneTools.annotation.state.getAllAnnotations().find(a => a.metadata.toolName === 'Length');
  return a && {points: a.data.handles.points, stats: a.data.cachedStats}; }'''
# The mark's own solid lines (the dashed one links the value text).
SOLID = 'd.shapes.filter(s => !s.dash)'


class MarkerStyleE2E(ViewerHistoryE2E):
    def setUp(self):
        super().setUp()
        self.addCleanup(cleanup_workspace, self.stack, 'ReadingAppearance')

    def settings(self, work):
        self.open_toolbar_group(work, '#reading-appearance-open')
        work.locator('#reading-appearance-open').click()
        expect(work.locator('#appearance-account-save')).to_be_enabled()

    def until(self, page, condition, label, arg=None, timeout=30000):
        try:
            page.wait_for_function('arg => { const d = (' + DRAWN + ')(); return ' + condition + '; }', arg=arg, timeout=timeout)
        except Exception:
            folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/marker-style')); folder.mkdir(parents=True, exist_ok=True)
            (folder / (label + '-diagnosis.json')).write_text(json.dumps({'drawn': page.evaluate(DRAWN), 'page': page.evaluate(DIAGNOSIS)},
                                                                          ensure_ascii=False, indent=1, default=str), encoding='utf-8')
            page.screenshot(path=str(folder / (label + '-failed.png')))
            raise
        return page.evaluate(DRAWN)

    def rest(self, page, label):
        # Leave the row's buttons, point at an empty corner of the image and clear the selection, as a reader does,
        # so the mark is drawn in neither its hover nor its selection colour.
        page.evaluate('() => document.activeElement?.blur?.()')
        corner = page.evaluate('''() => services.cornerstoneViewportService.getCornerstoneViewport(
            services.viewportGridService.getActiveViewportId()).element.querySelector('canvas').getBoundingClientRect().toJSON()''')
        page.mouse.move(corner['x'] + 30, corner['y'] + 30, steps=4); page.mouse.move(corner['x'] + 8, corner['y'] + 8, steps=4)
        page.evaluate('''() => { cornerstoneTools.annotation.selection.deselectAnnotation?.();
            for (const engine of cornerstone.getRenderingEngines()) for (const v of engine.getViewports())
              try { cornerstoneTools.utilities.triggerAnnotationRender(v.element); } catch (_) { v.render(); } }''')
        return self.until(page, SOLID + '.length > 0 && d.texts.length > 0 && d.shapes.every(s => !d.feedback.includes(s.stroke)) && '
                          'd.texts.every(t => !d.feedback.includes(t.fill))', label)

    def wait_drawn(self, page, color, width, label):
        # color None: the viewer's own colour for the mark's state (a saved mark reloaded in another window is locked).
        return self.until(page, SOLID + '.length > 0 && ' + SOLID + '.every(s => s.stroke === (arg[0] ?? d.own)) && Math.max(...' + SOLID +
                          '.map(s => s.width)) === arg[1] && d.texts.length > 0 && (arg[0] === null || d.texts.every(t => t.fill === arg[0]))',
                          label, arg=[color, width], timeout=15000)

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
        base = self.rest(page, 'rest-open')
        own_styles = page.evaluate(STYLES)
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
        red = self.wait_drawn(page, 'rgb(255, 64, 64)', base_width * 2, 'red-open')
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
        self.rest(other, 'rest-new')
        self.wait_drawn(other, 'rgb(255, 64, 64)', base_width * 2, 'red-new')

        # The account keeps the choice; an older-format save cannot replace it.
        work.locator('#appearance-account-save').click()
        expect(work.locator('#appearance-account-status')).to_have_text('표시 설정을 계정에 저장했습니다.')
        stored = document_request(work, 'GET', self.stack.api + '/reading-appearance').json()
        self.assertEqual(stored['sizes']['version'], 10)
        self.assertEqual(stored['sizes']['markers'], {'version': 1, 'color': 'red', 'width': 'thick'})

        # Reset returns both windows to the viewer's own style.
        work.locator('#reading-marker-reset').click()
        for target, label in [(page, 'reset-open'), (other, 'reset-new')]:
            self.wait_drawn(target, None, base_width, label)
            self.assertEqual(target.evaluate(STYLES), own_styles, 'Default/Standard is the viewer style exactly')
        self.assertEqual(page.evaluate(LENGTH), measured)
        (folder / 'marker-style.json').write_text(json.dumps({'study': f.uid, 'base': base, 'red': red, 'stored': stored['sizes']['markers']},
                                                             ensure_ascii=False, indent=2), encoding='utf-8')
        other.close(); page.close(); work.close()


if __name__ == '__main__':
    unittest.main()
