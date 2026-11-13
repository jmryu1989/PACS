# coding: utf-8
"""Toolbar & Thumbnail Position on the shipped viewer chrome.

ChromePositionModelTest runs the pure part of viewer-features-chrome.js in Node: a stored value is checked field by
field and turned into the image column's grid (rows in place, outermost the toolbar) and the overlays of auto-hidden rows.

ChromePositionDOMTest runs the shipped viewer-ux-shell.js, viewer-series-strip.js, viewer-ux-toolbar.js,
viewer-features.js, viewer-features-chrome.js, viewer-display-span.js and viewer-ux-theme.css in Chromium inside a
synthetic copy of the stock viewer's column (grid in two wrappers in a flex column), with synthetic OHIF services, an
in-page account endpoint (revision and owner as /api/workspace-shortcuts) and synthetic DICOM JSON for the series strip.
"""
from pathlib import Path
import json
import os
import shutil
import subprocess
import unittest

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
ORIGIN = "https://viewer-chrome.test"
OWNER = ['syn-site', 'syn-reader']
SIDES = ['top', 'bottom', 'left', 'right']

# The stock viewer's nesting around the grid (OHIF 3.9.1 ViewerLayout): the tailwind classes as rules, not inline styles.
HARNESS = """<!doctype html><html><head><style>
html, body { margin: 0; height: 100%; background: #000; }
.flex { display: flex; } .flex-col { flex-direction: column; } .flex-row { flex-direction: row; } .flex-1 { flex: 1 1 0%; }
.h-full { height: 100%; } .w-full { width: 100%; } .relative { position: relative; } .overflow-hidden { overflow: hidden; }
[data-cy=viewport-grid] { display: grid; grid-template-columns: 1fr 1fr; }
[data-cy=viewport-pane] { position: relative; overflow: hidden; outline: 1px solid #333; }
.viewport-element { position: absolute; inset: 0; }
</style></head><body><div id="root"><div class="flex flex-col" style="height: 100vh">
  <div id="tabs" style="height: 38px; flex: none"><button type="button">Patient</button></div>
  <div class="relative flex flex-row overflow-hidden flex-1">
    <div id="column" class="flex h-full flex-1 flex-col">
      <div id="main" class="relative flex h-full flex-1 overflow-hidden">
        <div class="h-full w-full"><div data-cy="viewport-grid" class="h-full w-full">
          <div data-cy="viewport-pane" id="pane-left"><div class="viewport-element"></div></div>
          <div data-cy="viewport-pane" id="pane-right"><div class="viewport-element"></div></div>
        </div></div>
      </div>
    </div>
  </div>
</div></div></body></html>"""

SETUP = """([owner, tools, series]) => {
  window.synNotes = []; window.synWriter = true;
  const noEvents = () => ({ EVENTS: {}, subscribe: () => ({ unsubscribe() {} }) });
  window.cornerstone = { Enums: { Events: { IMAGE_LOAD_FAILED: 'failed', IMAGE_LOADED: 'loaded' } }, eventTarget: new EventTarget(),
    metaData: { get: () => null }, cache: { getImage: () => null, getImageLoadObject: () => null } };
  window.KinViewerPatientTabs = { snapshot: () => ({ key: 'p1', sequence: 1, studyUIDs: ['S1'] }), subscribe: () => () => {},
    mount() {}, refresh() {}, dispose() {}, end() {}, guard: () => true };
  window.KinViewerInfoBar = { mount: () => ({ refresh() {}, adopt() {}, invalidate() {}, dispose() {} }),
    identity: () => ({ set: { StudyInstanceUID: 'S1', SeriesInstanceUID: 'SER1' } }) };
  window.KinSessionTransport = { refusal: () => false, responseError: () => new Error('ended') };
  window.KinViewerHangingSettings = { modalities: [], defaults: {}, get: () => ({}),
    mount: () => ({ apply() {}, dispose() {} }), mountSizing: () => ({ dispose() {} }) };
  const cells = new Map([['left', { viewportId: 'left', x: 0, y: 0, width: .5, height: 1, displaySetInstanceUIDs: ['d1'] }],
    ['right', { viewportId: 'right', x: .5, y: 0, width: .5, height: 1, displaySetInstanceUIDs: ['d2'] }]]);
  window.synButtons = Object.fromEntries(tools.map(([id, label]) => [id, { id, uiType: 'ohif.radioGroup', props: { label, commands: 'setToolActiveToolbar' } }]));
  window.synServices = {
    viewportGridService: { ...noEvents(), getState: () => ({ viewports: cells }), getActiveViewportId: () => 'left', setActiveViewportId() {} },
    displaySetService: { ...noEvents(), getActiveDisplaySets: () => [] },
    cornerstoneViewportService: { ...noEvents(), getCornerstoneViewport: id => ({ id, type: 'stack', element: document.querySelector('#pane-' + id + ' .viewport-element') }) },
    uiNotificationService: { show: note => synNotes.push(note) },
    toolbarService: { EVENTS: { TOOL_BAR_MODIFIED: 'modified' }, getButtonSection: () => tools.map(([id]) => ({ id })),
      getButtons: () => synButtons, getButtonProps: id => synButtons[id] && { id, ...synButtons[id].props, disabled: false },
      recordInteraction() {}, subscribe: () => ({ unsubscribe() {} }) },
  };
  window.synCommands = { runCommand() {} };
  window.kinViewerHistoryWorkspaceState = () => ({ busy: false });
  window.kinViewerJobWorkspaceState = () => ({ busy: false });
  // The account endpoint (GET reads; PUT saves at the expected revision) and the archive's series metadata.
  window.synServer = { revision: 3, viewerSettings: null, puts: [] };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const tag = value => ({ Value: [value] });
  window.fetch = async (url, init = {}) => {
    const path = String(url), s = synServer;
    if (path.endsWith('/api/workspace-shortcuts')) {
      if ((init.method || 'GET') === 'GET') return reply(200, { owner, revision: s.revision, viewerSettings: structuredClone(s.viewerSettings) });
      const body = JSON.parse(init.body); s.puts.push(body);
      if (body.revision !== s.revision) return reply(409, { message: 'conflict' });
      s.revision++; s.viewerSettings = body.viewerSettings;
      return reply(200, { owner, revision: s.revision, viewerSettings: structuredClone(s.viewerSettings) });
    }
    if (path.includes('/dicom-web/studies/S1/metadata'))
      return reply(200, Array.from({ length: series }, (_, n) => ({ '0020000D': tag('S1'), '0020000E': tag('SER' + (n + 1)),
        '00200011': tag(n + 1), '0008103E': tag('Series ' + (n + 1)), '00080018': tag('SOP' + (n + 1)) })));
    return reply(404, {});
  };
  window.synSession = { owner: () => owner, ended: () => false, writer: () => synWriter, readOnly: () => false,
    state: () => 'confirmed', decide: async () => {} };
  // As config/ohif/viewer-ux.js on mode entry: the shell, then the toolbar.
  window.synMount = () => {
    window.synShell = KinViewerUXShell.mount({ services: synServices, session: synSession });
    window.synToolbar = KinViewerUXToolbar.mount({ services: synServices, commands: synCommands, session: synSession });
  };
}"""

# A feature module with a Display menu item, for the menus of a toolbar that hides or stands at the bottom.
MENU_MODULE = """() => KinViewerFeatures.module('synMenu', ({ ui }) => {
  ui.menuItem('Display', { id: 'synOverlay', label: 'Overlay Items', run: () => {} });
  ui.menuItem('Display', { id: 'synZoom', label: 'Zoom Presets', run: () => {} });
})"""

BOXES = """() => {
  const box = selector => { const node = document.querySelector(selector); if (!node) return null; const r = node.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  return { column: box('#column'), toolbar: box('.kin-ux-toolbar-slot'), thumbs: box('.kin-viewer-series-strip'),
    grid: box('[data-cy=viewport-grid]'), bar: box('.kin-ux-tools-bar') };
}"""
FRAME = "() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))"
TOOLS = [['WindowLevel', 'Window / Level'], ['Pan', 'Pan'], ['Zoom', 'Zoom'], ['StackScroll', 'Stack Scroll'], ['Length', 'Length'],
         ['Angle', 'Angle'], ['EllipticalROI', 'Ellipse'], ['Capture', 'Capture']]
MANY_TOOLS = TOOLS + [['RectangleROI', 'Rectangle'], ['ArrowAnnotate', 'Arrow'], ['invert', 'Invert'], ['Cine', 'Cine'],
                      ['flipHorizontal', 'Flip Horizontal'], ['Crosshairs', 'Crosshairs'], ['rotate-right', 'Rotate Right'],
                      ['Probe', 'Probe'], ['Magnify', 'Magnify'], ['CobbAngle', 'Cobb Angle']]


def overlap(a, b):
    return max(0, min(a['right'], b['right']) - max(a['left'], b['left'])) * max(0, min(a['bottom'], b['bottom']) - max(a['top'], b['top']))


class ChromePositionModelTest(unittest.TestCase):
    def node(self, script):
        node = os.environ.get('NODE') or shutil.which('node')
        if not node:
            self.fail('Node is required; set NODE to the installed executable')
        result = subprocess.run([node, '-e', "const m = require('./worklist-v0/hpacs-lite/viewer-features-chrome.js');" + script],
                                cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_m1_a_stored_value_is_checked_field_by_field(self):
        actual = self.node("""console.log(JSON.stringify([undefined, null, 7, 'left', [], {}, { toolbar: 'LEFT', thumbs: 'middle' },
          { toolbar: 'right', toolbarAutoHide: 'yes', thumbs: 'bottom', thumbsAutoHide: true, extra: 1 }].map(v => m.normalize(v))
          .concat([m.standard(undefined), m.standard({ toolbar: 'top', thumbs: 'top' }), m.standard({ thumbs: 'left' }), m.css(undefined)])));""")
        default = dict(toolbar='top', toolbarAutoHide=False, thumbs='top', thumbsAutoHide=False)
        self.assertEqual([default] * 7, actual[:7])
        self.assertEqual(dict(toolbar='right', toolbarAutoHide=False, thumbs='bottom', thumbsAutoHide=True), actual[7])
        self.assertEqual([True, True, False, ''], actual[8:])

    def test_m2_bands_put_the_toolbar_outside_and_overlays_inside_the_bands(self):
        actual = self.node("""const p = v => { const r = m.plan(v); return [r.areas, r.rows, r.columns, r.overlays]; };
          console.log(JSON.stringify({ sameLeft: p({ toolbar: 'left', thumbs: 'left' }), topLeft: p({ toolbar: 'top', thumbs: 'left' }),
            leftTop: p({ toolbar: 'left', thumbs: 'top' }), sameBottom: p({ toolbar: 'bottom', thumbs: 'bottom' }),
            portrait: p({ toolbar: 'left', thumbs: 'right' }), hiddenTool: p({ toolbar: 'top', toolbarAutoHide: true }),
            hiddenThumbs: p({ toolbar: 'top', thumbs: 'left', thumbsAutoHide: true }),
            bothRight: p({ toolbar: 'right', toolbarAutoHide: true, thumbs: 'right', thumbsAutoHide: true }) }));""")
        auto, fr = 'auto', 'minmax(0, 1fr)'
        self.assertEqual(['"tb th im"', fr, ' '.join([auto, auto, fr]), []], actual['sameLeft'])
        self.assertEqual(['"tb tb" "th im"', ' '.join([auto, fr]), ' '.join([auto, fr]), []], actual['topLeft'])
        self.assertEqual(['"tb th" "tb im"', ' '.join([auto, fr]), ' '.join([auto, fr]), []], actual['leftTop'])
        self.assertEqual(['"im" "th" "tb"', ' '.join([fr, auto, auto]), fr, []], actual['sameBottom'])
        self.assertEqual(['"tb im th"', fr, ' '.join([auto, fr, auto]), []], actual['portrait'])
        self.assertEqual(['"th" "im"', ' '.join([auto, fr]), fr,
                          [dict(row='toolbar', side='top', inset=dict(top=0, right=0, left=0), edge=dict(top=0, right=0, left=0), thickness=36,
                                together=False)]], actual['hiddenTool'])
        self.assertEqual([dict(row='thumbs', side='left', inset=dict(top=36, bottom=0, left=0), edge=dict(top=36, bottom=0, left=0), thickness=156,
                               together=False)], actual['hiddenThumbs'][3])
        self.assertEqual('"im"', actual['bothRight'][0])
        # Both hidden on one edge: the strip lies inside the toolbar but comes out from the same edge, with it.
        self.assertEqual([dict(row='toolbar', side='right', inset=dict(top=0, right=0, bottom=0), edge=dict(top=0, right=0, bottom=0), thickness=108, together=True),
                          dict(row='thumbs', side='right', inset=dict(top=0, right=108, bottom=0), edge=dict(top=0, right=0, bottom=0), thickness=156, together=True)],
                         actual['bothRight'][3])

    def test_m3_the_edge_band_is_8px_either_side_of_the_hidden_rows_edge(self):
        actual = self.node("""const box = { left: 100, top: 50, right: 900, bottom: 650 };
          const [left] = m.plan({ toolbar: 'left', toolbarAutoHide: true }).overlays;
          const [, thumbs] = m.plan({ toolbar: 'bottom', toolbarAutoHide: true, thumbs: 'bottom', thumbsAutoHide: true }).overlays;
          console.log(JSON.stringify([[100, 300], [108, 300], [92, 300], [109, 300], [100, 40], [500, 650 - 36], [500, 650 - 46], [500, 645]]
            .map(([x, y], i) => m.edgeHit(i < 5 ? left : thumbs, box, x, y))));""")
        # A strip hidden inside a hidden toolbar on the same edge comes out from the column's edge, not 36px inside it.
        self.assertEqual([True, True, True, False, False, False, False, True], actual)


class ChromePositionDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self, size=(1366, 900), settings=None, tools=TOOLS, series=4, modules=(), chrome_file=True, span=None):
        context = self.browser.new_context(viewport={'width': size[0], 'height': size[1]})
        page = context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(ORIGIN + "/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.goto(ORIGIN + "/")
        page.add_style_tag(path=str(HPACS / "viewer-ux-theme.css"))
        names = ["viewer-ux-shortcuts.js", "viewer-features.js"] + (["viewer-features-chrome.js"] if chrome_file else []) + [
            "viewer-ux-toolbar.js", "viewer-series-strip.js", "viewer-display-span.js", "viewer-ux-shell.js"]
        for name in names:
            page.add_script_tag(path=str(HPACS / name))
        page.evaluate(SETUP, [OWNER, tools, series])
        page.evaluate("settings => { synServer.viewerSettings = settings; }", settings)
        for module in modules:
            page.evaluate(module)
        page.evaluate("() => synMount()")
        expect(page.locator('.kin-ux-toolbar-slot > .kin-ux-toolbar')).to_have_count(1)
        expect(page.locator('.kin-ux-toolbar-settings [role=status]')).to_have_text('계정 설정 · 다른 PC에서도 적용됩니다.')
        expect(page.locator('.kin-series-card')).to_have_count(series)
        if span is not None:
            # Two displays meeting at x = span inside this window (the geometry part has its own tests).
            page.evaluate("""seam => {
              window.KinViewerDisplayLayout = { seams: () => [seam], split: (base, list) => ({ seam: list[0], left: 0, right: 0 }) };
              window.synSpan = KinViewerDisplaySpan.mount({ services: synServices, enabled: () => true });
            }""", span)
        page.evaluate(FRAME)
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    def chrome(self, page, **value):
        self.assertTrue(page.evaluate("value => KinViewerUXShell.chrome(value)", value))
        page.evaluate(FRAME)
        return page.evaluate(BOXES)

    def assertEdge(self, row, column, side, message):
        self.assertAlmostEqual(row[side], column[side], delta=0.5, msg=message)

    # ── The default: nothing changes ──
    def test_01_without_a_choice_the_rows_dom_and_sizes_are_as_before(self):
        before = self.open(chrome_file=False)
        expected = before.evaluate(BOXES)
        page = self.open()
        self.assertEqual(expected, page.evaluate(BOXES))
        self.assertEqual([], page.evaluate("() => [...document.body.attributes].map(a => a.name).filter(n => n.startsWith('data-kin'))"))
        self.assertEqual('flex', page.evaluate("() => getComputedStyle(document.getElementById('column')).display"))
        self.assertEqual(['kin-ux-toolbar-slot', 'kin-viewer-series-strip', 'main'],
                         page.evaluate("() => [...document.getElementById('column').children].map(n => n.id || n.className)"))
        # A choice and back to the default leaves no trace.
        self.chrome(page, toolbar='right', thumbs='left', thumbsAutoHide=True)
        self.assertEqual(expected, self.chrome(page))
        self.assertEqual([], page.evaluate("() => [...document.body.attributes].map(a => a.name).filter(n => n.startsWith('data-kin'))"))
        self.assertEqual('', page.evaluate("() => document.querySelector('style[data-kin-chrome]').textContent"))
        self.assertEqual(expected['toolbar']['height'], 36)
        self.assertEqual(expected['thumbs']['height'], 66)

    # ── Four edges for each row ──
    def test_02_sixteen_placements_put_each_row_on_its_edge_beside_the_images(self):
        page = self.open()
        for toolbar in SIDES:
            for thumbs in SIDES:
                case = toolbar + '/' + thumbs
                b = self.chrome(page, toolbar=toolbar, thumbs=thumbs)
                column, tool, strip, grid = b['column'], b['toolbar'], b['thumbs'], b['grid']
                self.assertEdge(tool, column, toolbar, case + ' toolbar on its edge')
                upright = toolbar in ('left', 'right')
                self.assertAlmostEqual(tool['width'] if upright else tool['height'], 108 if upright else 36, delta=0.5, msg=case)
                self.assertAlmostEqual(tool['height'] if upright else tool['width'], column['height'] if upright else column['width'], delta=0.5,
                                       msg=case + ' toolbar spans its edge')
                if thumbs == toolbar:
                    inner = {'top': ('top', 'bottom'), 'bottom': ('bottom', 'top'), 'left': ('left', 'right'), 'right': ('right', 'left')}[thumbs]
                    self.assertAlmostEqual(strip[inner[0]], tool[inner[1]], delta=0.5, msg=case + ' strip inside the toolbar')
                else:
                    self.assertEdge(strip, column, thumbs, case + ' strip on its edge')
                self.assertAlmostEqual(strip['width'] if thumbs in ('left', 'right') else strip['height'], 156 if thumbs in ('left', 'right') else 66,
                                       delta=0.5, msg=case)
                for name, row in (('toolbar', tool), ('thumbs', strip)):
                    self.assertLess(overlap(grid, row), 1, case + ' images under ' + name)
                self.assertLess(overlap(tool, strip), 1, case)
                for row in (tool, strip, grid):
                    self.assertGreaterEqual(row['left'], column['left'] - 0.5); self.assertLessEqual(row['right'], column['right'] + 0.5)
                    self.assertGreaterEqual(row['top'], column['top'] - 0.5); self.assertLessEqual(row['bottom'], column['bottom'] + 0.5)
                area = lambda r: r['width'] * r['height']
                self.assertAlmostEqual(area(grid) + area(tool) + area(strip), area(column), delta=area(column) * 0.002,
                                       msg=case + ' the images fill the rest')

    # ── The window in Viewer Settings ──
    def test_03_the_window_draws_the_choice_and_apply_saves_and_moves_the_rows(self):
        page = self.open()
        page.get_by_role('button', name='Viewer Settings', exact=True).click()
        settings = page.get_by_role('dialog', name='Viewer Settings')
        expect(settings.locator('fieldset.kin-ux-feature-settings > legend')).to_have_text('Tools & Display')
        settings.get_by_role('button', name='Toolbar & Thumbnail Position…').click()
        window = page.get_by_role('dialog', name='Toolbar & Thumbnail Position')
        expect(window).to_be_visible()
        expect(window.get_by_label('Toolbar', exact=True)).to_have_value('top')
        expect(window.get_by_label('Thumbnails', exact=True)).to_have_value('top')
        self.assertEqual(['Top', 'Bottom', 'Left', 'Right'], window.get_by_label('Toolbar', exact=True).locator('option').all_text_contents())
        landscape = window.get_by_role('img', name='Landscape', exact=False)
        expect(landscape).to_have_attribute('aria-label', 'Landscape: Toolbar Top, Thumbnails Top')
        expect(window.get_by_role('img', name='Portrait', exact=False)).to_have_attribute('aria-label', 'Portrait: Toolbar Top, Thumbnails Top')
        window.get_by_label('Toolbar', exact=True).select_option('left')
        window.get_by_label('Thumbnails', exact=True).select_option('right')
        window.get_by_label('Auto-hide Thumbnails').check()
        expect(landscape).to_have_attribute('aria-label', 'Landscape: Toolbar Left, Thumbnails Right (Auto-hide)')
        # The drawing follows the choice; the rows wait for Apply.
        self.assertIsNone(page.evaluate("() => document.body.getAttribute('data-kin-toolbar-side')"))
        window.get_by_role('button', name='Apply').click()
        expect(window.get_by_role('status')).to_have_text('계정에 저장하고 이 창에 적용했습니다.')
        self.assertEqual(dict(toolbar='left', toolbarAutoHide=False, thumbs='right', thumbsAutoHide=True),
                         page.evaluate("() => synServer.puts.at(-1).viewerSettings.features.chrome"))
        self.assertEqual('left', page.evaluate("() => document.body.getAttribute('data-kin-toolbar-side')"))
        b = page.evaluate(BOXES)
        self.assertEdge(b['toolbar'], b['column'], 'left', 'applied')
        self.assertAlmostEqual(b['grid']['right'], b['column']['right'], delta=0.5)  # the hidden strip takes no band
        window.get_by_role('button', name='Close').click()
        expect(window).to_have_count(0)
        expect(settings.get_by_role('button', name='Toolbar & Thumbnail Position…')).to_be_focused()
        settings.get_by_role('button', name='Toolbar & Thumbnail Position…').click()
        expect(window.get_by_label('Toolbar', exact=True)).to_have_value('left')
        expect(window.get_by_label('Auto-hide Thumbnails')).to_be_checked()
        # Back to the default: Top and Top, nothing hidden.
        window.get_by_label('Toolbar', exact=True).select_option('top')
        window.get_by_label('Thumbnails', exact=True).select_option('top')
        window.get_by_label('Auto-hide Thumbnails').uncheck()
        window.get_by_role('button', name='Apply').click()
        expect(window.get_by_role('status')).to_have_text('계정에 저장하고 이 창에 적용했습니다.')
        self.assertIsNone(page.evaluate("() => document.body.getAttribute('data-kin-chrome')"))

    def test_04_a_saved_choice_is_applied_when_the_viewer_reads_the_account(self):
        page = self.open(settings=dict(version=2, bar=[t[0] for t in TOOLS], shortcuts={},
                                       features=dict(chrome=dict(toolbar='bottom', thumbs='left', thumbsAutoHide='no'))))
        b = page.evaluate(BOXES)
        self.assertEdge(b['toolbar'], b['column'], 'bottom', 'saved toolbar')
        self.assertEdge(b['thumbs'], b['column'], 'left', 'saved strip')
        # A field that is not one of its choices reads as the default (the strip is not hidden).
        self.assertIsNone(page.evaluate("() => document.body.getAttribute('data-kin-thumbs-hide')"))

    # ── Rows on a side page up and down ──
    def test_05_side_rows_page_vertically(self):
        page = self.open(size=(1200, 520), tools=MANY_TOOLS, series=12,
                         settings=dict(version=2, bar=[t[0] for t in MANY_TOOLS], shortcuts={}))
        self.chrome(page, toolbar='left', thumbs='right')
        nxt = page.get_by_role('button', name='Next Tools')
        expect(nxt).to_be_visible()
        expect(nxt).to_have_text('⌄')
        expect(page.get_by_role('button', name='Previous Tools')).to_have_text('⌃')
        nxt.click()
        page.wait_for_function("() => document.querySelector('.kin-ux-tools-bar').scrollTop > 0")
        self.assertEqual(0, page.evaluate("() => document.querySelector('.kin-ux-tools-bar').scrollLeft"))
        # Every tool can be reached: paging down brings the last one into the bar.
        for _ in range(10):
            if page.evaluate("""() => { const bar = document.querySelector('.kin-ux-tools-bar').getBoundingClientRect();
                const last = [...document.querySelectorAll('.kin-ux-tools-bar [data-tool]')].at(-1).getBoundingClientRect();
                return last.top >= bar.top - 1 && last.bottom <= bar.bottom + 1; }"""):
                break
            nxt.click(); page.wait_for_timeout(400)
        else:
            self.fail('the last tool never came into the bar')
        # Each tool shows its name under the icon in a side bar.
        expect(page.locator('.kin-ux-tools-bar [data-tool=WindowLevel] .kin-ux-tool-label')).to_be_visible()
        series = page.get_by_role('button', name='Next Series')
        expect(series).to_have_text('⌄')
        self.assertGreater(page.evaluate("() => { const l = document.querySelector('.kin-series-list'); return l.scrollHeight - l.clientHeight; }"), 0)
        series.click()
        page.wait_for_function("() => document.querySelector('.kin-series-list').scrollTop > 0")
        # Back on the top edge the arrows page sideways again.
        self.chrome(page, toolbar='top', thumbs='bottom')
        expect(series).to_have_text('›')
        expect(page.get_by_role('button', name='Previous Series')).to_have_text('‹')

    # ── Auto-hide ──
    def test_06_auto_hide_comes_out_at_the_edge_and_folds_after_the_pointer_leaves(self):
        page = self.open()
        b = self.chrome(page, toolbar='left', toolbarAutoHide=True, thumbs='bottom', thumbsAutoHide=True)
        column = b['column']
        # Folded: the images take the whole column; a line marks each hidden edge.
        self.assertAlmostEqual(b['grid']['left'], column['left'], delta=0.5)
        self.assertAlmostEqual(b['grid']['bottom'], column['bottom'], delta=0.5)
        self.assertEqual(['0', '0'], page.evaluate("() => ['.kin-ux-toolbar-slot', '.kin-viewer-series-strip'].map(s => getComputedStyle(document.querySelector(s)).opacity)"))
        self.assertEqual(['""', '""'], page.evaluate("() => ['::before', '::after'].map(p => getComputedStyle(document.getElementById('column'), p).content)"))
        slot = page.locator('.kin-ux-toolbar-slot')
        page.mouse.move(column['left'] + 3, column['top'] + 200)
        expect(slot).to_have_attribute('data-kin-shown', '')
        self.assertEqual('1', page.evaluate("() => getComputedStyle(document.querySelector('.kin-ux-toolbar-slot')).opacity"))
        self.assertEqual('none', page.evaluate("() => getComputedStyle(document.getElementById('column'), '::before').display"))
        shown = page.evaluate(BOXES)
        self.assertAlmostEqual(shown['toolbar']['left'], column['left'], delta=0.5)
        self.assertGreater(overlap(shown['toolbar'], shown['grid']), 0)  # over the images, which keep their size
        self.assertEqual(b['grid'], shown['grid'])
        # Over the row it stays; away from it, it folds after 0.6 s.
        page.mouse.move(column['left'] + 60, column['top'] + 300)
        page.wait_for_timeout(800)
        expect(slot).to_have_attribute('data-kin-shown', '')
        page.mouse.move(column['left'] + 600, column['top'] + 300)
        page.wait_for_timeout(250)
        expect(slot).to_have_attribute('data-kin-shown', '')
        page.wait_for_timeout(600)
        expect(slot).not_to_have_attribute('data-kin-shown', '')
        # The strip at the bottom edge, offset by nothing (the toolbar is on another edge).
        strip = page.locator('.kin-viewer-series-strip')
        page.mouse.move(column['left'] + 600, column['bottom'] - 2)
        expect(strip).to_have_attribute('data-kin-shown', '')
        self.assertAlmostEqual(page.evaluate(BOXES)['thumbs']['bottom'], column['bottom'], delta=0.5)
        page.mouse.move(column['left'] + 600, column['top'] + 100)
        expect(strip).not_to_have_attribute('data-kin-shown', '', timeout=2000)

    def test_07_auto_hide_stays_out_while_a_menu_is_open_or_the_keyboard_is_in_it(self):
        page = self.open(modules=(MENU_MODULE,))
        b = self.chrome(page, toolbar='top', toolbarAutoHide=True)
        column, slot = b['column'], page.locator('.kin-ux-toolbar-slot')
        middle = (column['left'] + 500, column['top'] + 300)
        # More open.
        page.mouse.move(column['left'] + 400, column['top'] + 2)
        expect(slot).to_have_attribute('data-kin-shown', '')
        page.locator('.kin-ux-more > summary').click()
        page.mouse.move(*middle)
        page.wait_for_timeout(900)
        expect(slot).to_have_attribute('data-kin-shown', '')
        page.mouse.click(*middle)
        expect(page.locator('.kin-ux-more')).not_to_have_attribute('open', '')
        expect(slot).not_to_have_attribute('data-kin-shown', '', timeout=2000)
        # A feature menu open.
        page.mouse.move(column['left'] + 400, column['top'] + 2)
        expect(slot).to_have_attribute('data-kin-shown', '')
        page.get_by_role('button', name='Display ▾').click()
        expect(page.get_by_role('menu', name='Display')).to_be_visible()
        page.mouse.move(*middle)
        page.wait_for_timeout(900)
        expect(slot).to_have_attribute('data-kin-shown', '')
        page.mouse.click(*middle)
        expect(page.get_by_role('menu', name='Display')).to_have_count(0)
        expect(slot).not_to_have_attribute('data-kin-shown', '', timeout=2000)
        # Keyboard focus in the row: Tab reaches the folded toolbar and brings it out.
        page.mouse.move(*middle)
        page.locator('#tabs button').focus()
        page.keyboard.press('Tab')
        expect(slot).to_have_attribute('data-kin-shown', '')
        self.assertTrue(page.evaluate("() => document.querySelector('.kin-ux-toolbar-slot').contains(document.activeElement)"))
        page.wait_for_timeout(900)
        expect(slot).to_have_attribute('data-kin-shown', '')
        page.mouse.click(*middle)
        expect(slot).not_to_have_attribute('data-kin-shown', '', timeout=2000)

    # ── Narrow windows ──
    def test_08_narrow_windows_keep_images_and_every_control(self):
        for size in ((768, 1024), (1024, 768)):
            for toolbar, thumbs in (('left', 'right'), ('bottom', 'left'), ('right', 'top')):
                page = self.open(size=size, modules=(MENU_MODULE,))
                b = self.chrome(page, toolbar=toolbar, thumbs=thumbs)
                case = '%dx%d %s/%s' % (size[0], size[1], toolbar, thumbs)
                self.assertGreater(b['grid']['width'], 250, case); self.assertGreater(b['grid']['height'], 250, case)
                self.assertLess(overlap(b['grid'], b['toolbar']), 1, case); self.assertLess(overlap(b['grid'], b['thumbs']), 1, case)
                for name in ('Viewer Settings', 'More', 'Display ▾'):
                    control = page.locator('.kin-ux-toolbar').get_by_text(name, exact=True)
                    expect(control).to_be_visible()
                    box = control.bounding_box(); slot = b['toolbar']
                    self.assertTrue(box['x'] >= slot['left'] - 1 and box['x'] + box['width'] <= slot['right'] + 1 and
                                    box['y'] >= slot['top'] - 1 and box['y'] + box['height'] <= slot['bottom'] + 1, case + ' ' + name)
                # Each tool can be reached in the bar, directly or with the arrows.
                reach = page.evaluate("""() => { const bar = document.querySelector('.kin-ux-tools-bar');
                  const pagers = [...document.querySelectorAll('.kin-ux-tools-scroll')].filter(n => !n.hidden).length;
                  const fits = bar.scrollHeight <= bar.clientHeight + 1 && bar.scrollWidth <= bar.clientWidth + 1;
                  return fits || pagers === 2; }""")
                self.assertTrue(reach, case)
                page.context.close()

    # ── Menus of a bottom toolbar open upward ──
    def test_09_menus_of_a_bottom_toolbar_open_above_it(self):
        page = self.open(modules=(MENU_MODULE,))
        b = self.chrome(page, toolbar='bottom', thumbs='bottom')
        page.locator('.kin-ux-more > summary').click()
        more = page.locator('.kin-ux-more > div').bounding_box()
        self.assertLessEqual(more['y'] + more['height'], page.locator('.kin-ux-more > summary').bounding_box()['y'] + 1)
        self.assertGreaterEqual(more['y'], 0)
        page.keyboard.press('Escape')
        opener = page.get_by_role('button', name='Display ▾')
        opener.click()
        menu = page.get_by_role('menu', name='Display').bounding_box()
        top = opener.bounding_box()['y']
        self.assertLessEqual(menu['y'] + menu['height'], top + 1)
        self.assertGreaterEqual(menu['y'], 0)

    # ── Review findings: a side toolbar's More list, a refused drag, two hidden rows on one edge ──
    def test_11_more_on_a_side_toolbar_stays_in_the_window(self):
        page = self.open(tools=MANY_TOOLS, settings=dict(version=2, bar=[t[0] for t in TOOLS], shortcuts={}))
        for side in ('left', 'right'):
            self.chrome(page, toolbar=side, thumbs='top')
            page.locator('.kin-ux-more > summary').click()
            menu = page.locator('.kin-ux-more > div')
            self.assertGreaterEqual(menu.locator('[data-tool]').count(), len(MANY_TOOLS) - len(TOOLS))
            box = menu.bounding_box()
            self.assertGreaterEqual(box['y'], 0, side); self.assertLessEqual(box['y'] + box['height'], 900, side)
            self.assertTrue(menu.locator('[data-tool]').last.is_visible())
            page.keyboard.press('Escape')

    def test_12_a_drag_the_strip_refuses_does_not_hold_it_out(self):
        page = self.open()
        b = self.chrome(page, toolbar='top', thumbs='bottom', thumbsAutoHide=True)
        strip = page.locator('.kin-viewer-series-strip')
        page.mouse.move(b['column']['left'] + 400, b['column']['bottom'] - 2)
        expect(strip).to_have_attribute('data-kin-shown', '')
        # Unsaved work in the viewer: the strip's own guard refuses the drag (no dragend follows).
        page.evaluate("""() => { window.kinViewerHistoryWorkspaceState = () => ({ busy: true });
          const card = document.querySelector('.kin-series-card');
          card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })); }""")
        page.mouse.move(b['column']['left'] + 400, b['column']['top'] + 200)
        expect(strip).not_to_have_attribute('data-kin-shown', '', timeout=2000)

    def test_13_two_hidden_rows_on_one_edge_come_out_and_fold_together(self):
        page = self.open()
        b = self.chrome(page, toolbar='top', toolbarAutoHide=True, thumbs='top', thumbsAutoHide=True)
        column, slot, strip = b['column'], page.locator('.kin-ux-toolbar-slot'), page.locator('.kin-viewer-series-strip')
        page.mouse.move(column['left'] + 400, column['top'] + 2)
        expect(slot).to_have_attribute('data-kin-shown', '')
        expect(strip).to_have_attribute('data-kin-shown', '')
        shown = page.evaluate(BOXES)
        self.assertAlmostEqual(shown['thumbs']['top'], shown['toolbar']['bottom'], delta=0.5)
        # Down onto the strip: both stay while the pointer is over either.
        page.mouse.move(column['left'] + 400, shown['thumbs']['top'] + 30)
        page.wait_for_timeout(800)
        expect(slot).to_have_attribute('data-kin-shown', '')
        expect(strip).to_have_attribute('data-kin-shown', '')
        page.mouse.move(column['left'] + 400, column['top'] + 400)
        expect(slot).not_to_have_attribute('data-kin-shown', '', timeout=2000)
        expect(strip).not_to_have_attribute('data-kin-shown', '')
        # One line marks the shared edge.
        self.assertEqual(['""', 'none'], page.evaluate("() => ['::before', '::after'].map(p => { const s = getComputedStyle(document.getElementById('column'), p); return s.content === 'none' || s.height === 'auto' || s.height === '0px' ? 'none' : s.content; })"))
    # ── A window across two displays ──
    def test_10_a_window_across_two_displays_copies_rows_on_top_or_bottom_only(self):
        page = self.open(span=683)
        expect(page.locator('.kin-ux-toolbar .kin-span-mirror')).to_have_count(1)
        self.chrome(page, toolbar='bottom', thumbs='left')
        page.wait_for_function("() => document.querySelectorAll('.kin-viewer-series-strip .kin-span-mirror').length === 0")
        b = page.evaluate(BOXES)
        mirror = page.locator('.kin-ux-toolbar .kin-span-mirror')
        expect(mirror).to_have_count(1)
        self.assertAlmostEqual(mirror.bounding_box()['x'], 683, delta=1)
        self.assertAlmostEqual(mirror.bounding_box()['y'] + mirror.bounding_box()['height'], b['column']['bottom'], delta=1)
        self.assertLess(b['thumbs']['right'], 683)  # the strip on the left lies whole on the first display
        # The second display gets the strip on its own left edge (at the seam), over the images until the pointer is there.
        copy = page.get_by_role('group', name='Series (Second Display)')
        expect(copy).to_have_count(1)
        box = copy.bounding_box()
        self.assertAlmostEqual(box['x'], 683, delta=1)
        self.assertAlmostEqual(box['width'], 156, delta=1)
        self.assertAlmostEqual(box['y'], b['thumbs']['top'], delta=1)
        self.assertAlmostEqual(box['height'], b['thumbs']['height'], delta=1)
        self.assertEqual('0', copy.evaluate("n => getComputedStyle(n).opacity"))
        page.mouse.move(683 + 4, b['thumbs']['top'] + 100)
        expect(copy).to_have_attribute('data-kin-shown', '')
        self.assertEqual(4, copy.locator('.kin-series-card').count())
        page.mouse.move(683 + 60, b['thumbs']['top'] + 100)
        page.wait_for_timeout(800)
        expect(copy).to_have_attribute('data-kin-shown', '')  # over the copy it stays
        page.mouse.move(683 - 300, b['thumbs']['top'] + 100)
        expect(copy).not_to_have_attribute('data-kin-shown', '', timeout=2000)
        # Toolbar on the left, thumbnails on the right: each display has both, on the same edges.
        self.chrome(page, toolbar='left', thumbs='right')
        page.evaluate(FRAME)
        tools = page.get_by_role('group', name='Image Tools (Second Display)')
        series = page.get_by_role('group', name='Series (Second Display)')
        expect(tools).to_have_class('kin-span-mirror kin-span-side')
        self.assertAlmostEqual(tools.bounding_box()['x'], 683, delta=1)
        self.assertAlmostEqual(series.bounding_box()['x'] + series.bounding_box()['width'], 683, delta=1)
        page.mouse.move(683 + 3, 300)
        expect(tools).to_have_attribute('data-kin-shown', '')
        expect(series).not_to_have_attribute('data-kin-shown', '')
        expect(tools.locator('[data-tool=Zoom]')).to_be_visible()
        page.mouse.move(683 - 3, 300)
        expect(series).to_have_attribute('data-kin-shown', '')
        # An auto-hidden bottom strip keeps its copy, folded and shown with it.
        self.chrome(page, toolbar='top', thumbs='bottom', thumbsAutoHide=True)
        expect(page.locator('.kin-viewer-series-strip .kin-span-mirror')).to_have_count(1)
        self.assertEqual('0', page.evaluate("() => getComputedStyle(document.querySelector('.kin-viewer-series-strip')).opacity"))
        column = page.evaluate(BOXES)['column']
        page.mouse.move(900, column['bottom'] - 2)
        expect(page.locator('.kin-viewer-series-strip')).to_have_attribute('data-kin-shown', '')
        self.assertTrue(page.locator('.kin-viewer-series-strip .kin-span-mirror').is_visible())
        # Second Display off in a second window: the rows go, and with them their bands and edge lines.
        page.evaluate("() => { synSpan.dispose(); document.body.classList.add('kin-second-display-rows-off'); }")
        page.evaluate(FRAME)
        b = page.evaluate(BOXES)
        self.assertIsNone(b['toolbar']['width'] or None)
        self.assertAlmostEqual(b['grid']['top'], b['column']['top'], delta=0.5)
        self.assertEqual('none', page.evaluate("() => getComputedStyle(document.getElementById('column'), '::after').display"))


if __name__ == '__main__':
    unittest.main()
