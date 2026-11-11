# coding: utf-8
"""Viewer export (A1 FB-031, FC-078, FC-079, FC-081) on the shipped toolbar and export module.

The shipped viewer-ux-toolbar.js, viewer-ux-shortcuts.js and viewer-export.js run in Chromium beside synthetic
OHIF services and two synthetic image cells: a drawn image canvas at twice its CSS size, a measurement layer
(svg.svg-layer) and image text. The clipboard, canvas encoders, MediaRecorder and downloads are the browser's own.
Only synthetic pixels are used. Pixel rendering of the real Cornerstone canvas stays with the served viewer tests.
"""
from pathlib import Path
import unittest

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
ORIGIN = "https://viewer-export.test"

HARNESS = """<!doctype html><html><head><style>
body { margin: 0; background: #111; font-family: sans-serif; }
#grid { position: absolute; left: 0; top: 60px; display: flex; }
[data-cy=viewport-pane] { position: relative; width: 200px; height: 150px; overflow: hidden; }
.viewport-element { position: absolute; inset: 0; }
.viewport-element canvas, .viewport-element svg { position: absolute; left: 0; top: 0; width: 200px; height: 150px; }
.overlay { position: absolute; left: 4px; top: 4px; color: rgb(255, 255, 0); font: bold 28px sans-serif; }
.action { position: absolute; right: 2px; bottom: 2px; color: rgb(255, 0, 255); font: bold 28px sans-serif; }
</style></head><body><div id="root"><div class="kin-ux-toolbar-slot"></div><div id="grid"></div></div></body></html>"""

# Two cells. Each image is one colour with a frame number drawn as a bright square at x = 10 + 15 * frame, y = 50; the
# measurement layer draws a green line across the middle. The cell action button text is not image text.
SETUP = """() => {
  const colours = { left: [200, 0, 0], right: [0, 0, 200] };
  window.synNotes = []; window.synInteractions = []; window.synBusy = false;
  const viewports = new Map();
  for (const id of ['left', 'right']) {
    const pane = document.createElement('div'); pane.dataset.cy = 'viewport-pane';
    const element = document.createElement('div'); element.className = 'viewport-element';
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 300;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'svg-layer');
    svg.setAttribute('viewBox', '0 0 200 150');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    for (const [k, v] of Object.entries({ x1: 0, y1: 100, x2: 200, y2: 100, stroke: 'rgb(0, 255, 0)', 'stroke-width': 6 })) line.setAttribute(k, v);
    svg.append(line); element.append(canvas, svg);
    const text = document.createElement('div'); text.className = 'overlay'; text.textContent = 'SYN ' + id.toUpperCase();
    const action = document.createElement('button'); action.className = 'action'; action.textContent = 'XX';
    pane.append(element, text, action); document.getElementById('grid').append(pane);
    const imageIds = ['syn:' + id + ':0', 'syn:' + id + ':1', 'syn:' + id + ':2', 'syn:' + id + ':3'];
    let index = 1;
    const draw = () => {
      const c = canvas.getContext('2d'); c.fillStyle = 'rgb(' + colours[id].join(',') + ')'; c.fillRect(0, 0, 400, 300);
      c.fillStyle = 'rgb(255, 255, 255)'; c.fillRect((10 + 15 * index) * 2, 50 * 2, 10 * 2, 10 * 2);
      requestAnimationFrame(() => element.dispatchEvent(new CustomEvent('CORNERSTONE_IMAGE_RENDERED')));
    };
    draw();
    viewports.set(id, { id, type: 'stack', element, canvas, getImageIds: () => imageIds.slice(),
      getCurrentImageIdIndex: () => index,
      setImageIdIndex: async value => { await new Promise(r => setTimeout(r, 5)); index = value; draw(); return imageIds[value]; },
      render: () => {} });
  }
  window.synViewports = viewports;
  window.cornerstone = { Enums: { Events: { IMAGE_RENDERED: 'CORNERSTONE_IMAGE_RENDERED' } },
    metaData: { get: (type, imageId) => type === 'generalSeriesModule' ? { seriesNumber: 7 } : undefined } };
  let active = 'left';
  const grid = { getActiveViewportId: () => active, setActive: id => { active = id; },
    getState: () => ({ viewports: new Map([['left', {}], ['right', {}]]) }) };
  window.synButtons = {
    WindowLevel: { id: 'WindowLevel', uiType: 'ohif.radioGroup', props: { label: 'Window / Level', commands: 'setToolActiveToolbar' } },
    Capture: { id: 'Capture', uiType: 'ohif.radioGroup', props: { label: 'Capture', commands: 'showDownloadViewportModal' } },
    Zoom: { id: 'Zoom', uiType: 'ohif.radioGroup', props: { label: 'Zoom', commands: 'setToolActiveToolbar' } },
  };
  window.synDisabled = new Set();
  window.synSection = ['WindowLevel', 'Capture', 'Zoom'];
  const listeners = [];
  window.synServices = {
    viewportGridService: grid,
    cornerstoneViewportService: { getCornerstoneViewport: id => viewports.get(id) },
    cineService: { getState: () => ({ cines: {} }) },
    uiNotificationService: { show: note => window.synNotes.push(note) },
    toolbarService: {
      EVENTS: { TOOL_BAR_MODIFIED: 'modified' },
      getButtonSection: () => window.synSection.filter(id => window.synButtons[id]).map(id => ({ id })),
      getButtons: () => window.synButtons,
      getButtonProps: id => window.synButtons[id] && { id, ...window.synButtons[id].props, disabled: window.synDisabled.has(id) },
      recordInteraction: item => window.synInteractions.push(item.itemId),
      subscribe: (event, fn) => { listeners.push(fn); return { unsubscribe() {} }; },
      changed: () => listeners.forEach(fn => fn()),
    },
  };
  window.kinViewerHistoryWorkspaceState = () => ({ busy: window.synBusy });
  window.kinViewerJobWorkspaceState = () => ({ busy: false });
  window.KinViewerHangingSettings = { modalities: [], defaults: {}, get: () => ({}),
    mount: () => ({ apply() {}, dispose() {} }), mountSizing: () => ({ dispose() {} }) };
  const session = { owner: () => null, ended: () => false, writer: () => false, state: () => 'confirmed', decide: async () => {} };
  window.synToolbar = KinViewerUXToolbar.mount({ services: window.synServices, session });
}"""

MENU = "() => [...document.querySelectorAll('.kin-ux-more [data-tool]')].map(n => [n.dataset.tool, n.getAttribute('aria-label'), n.disabled])"

# The clipboard image as RGBA samples at CSS points scaled by the image's own density.
CLIPBOARD = """async points => {
  const items = await navigator.clipboard.read();
  const blob = await items[0].getType('image/png');
  const bitmap = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height;
  const x = c.getContext('2d'); x.drawImage(bitmap, 0, 0);
  const scale = bitmap.width / points.width;
  const at = ([px, py]) => [...x.getImageData(Math.round(px * scale), Math.round(py * scale), 1, 1).data].slice(0, 3);
  const region = ([l, t, w, h]) => { const d = x.getImageData(l * scale, t * scale, w * scale, h * scale).data; const seen = new Set();
    for (let i = 0; i < d.length; i += 4) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]); return [...seen]; };
  return { width: bitmap.width, height: bitmap.height, type: blob.type,
    samples: points.samples.map(at), regions: (points.regions || []).map(region) };
}"""


def near(rgb, expected, tolerance=40):
    return all(abs(a - b) <= tolerance for a, b in zip(rgb, expected))


class ViewerExportDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self, setup=SETUP, before=None):
        context = self.browser.new_context(viewport={'width': 900, 'height': 700}, accept_downloads=True)
        context.grant_permissions(['clipboard-read', 'clipboard-write'], origin=ORIGIN)
        page = context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(ORIGIN + "/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.goto(ORIGIN + "/")
        for name in ["viewer-ux-shortcuts.js", "viewer-export.js", "viewer-ux-toolbar.js"]:
            page.add_script_tag(path=str(HPACS / name))
        if before: page.evaluate(before)
        page.evaluate(setup)
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    def click(self, page, tool):
        page.evaluate("tool => document.querySelector('.kin-ux-toolbar [data-tool=\"' + tool + '\"]').click()", tool)

    # ── The toolbar: after Capture, only beside Capture, with Capture's availability and the busy guard ──
    def test_01_export_actions_stand_after_capture_in_more(self):
        page = self.open()
        menu = page.evaluate(MENU)
        ids = [tool for tool, _, _ in menu]
        self.assertEqual(['Capture', 'CopyImage', 'CopyScreen'], ids[:3], menu)
        self.assertEqual([['CopyImage', 'Copy Image', False], ['CopyScreen', 'Copy Screen', False]], [m for m in menu if m[0].startswith('Copy')])
        bar = page.evaluate("() => [...document.querySelectorAll('.kin-ux-tools-bar [data-tool]')].map(n => n.dataset.tool)")
        self.assertEqual(['WindowLevel', 'Zoom'], bar, 'the frequent bar is unchanged')
        title = page.locator('.kin-ux-more [data-tool="CopyImage"]').get_attribute('title')
        self.assertIn('클립보드', title); self.assertIn('식별정보가 포함될 수 있습니다', title)

    def test_02_no_capture_no_export_and_disabled_capture_disables_them(self):
        page = self.open(before="() => {}")
        page.evaluate("() => { window.synSection = ['WindowLevel', 'Zoom']; delete window.synButtons.Capture; synServices.toolbarService.changed(); }")
        page.wait_for_function("() => !document.querySelector('.kin-ux-toolbar [data-tool=\"Capture\"]')")
        self.assertEqual([], [m for m in page.evaluate(MENU) if m[0].startswith('Copy')], 'a document without Capture gets no export')
        page = self.open()
        page.evaluate("() => { synDisabled.add('Capture'); synServices.toolbarService.changed(); }")
        page.wait_for_function("() => document.querySelector('.kin-ux-toolbar [data-tool=\"Capture\"]').disabled")
        self.assertEqual([True, True], page.evaluate("() => ['CopyImage', 'CopyScreen'].map(id => document.querySelector('.kin-ux-toolbar [data-tool=\"' + id + '\"]').disabled)"))

    def test_03_busy_workspace_does_not_run_an_export_and_no_viewer_command_is_recorded(self):
        page = self.open()
        page.evaluate("async () => { synBusy = true; await navigator.clipboard.writeText('SYN before'); }")
        self.click(page, 'CopyImage')
        page.wait_for_timeout(300)
        self.assertEqual('SYN before', page.evaluate("() => navigator.clipboard.readText()"))
        page.evaluate("() => { synBusy = false; }")
        self.click(page, 'CopyImage')
        page.wait_for_function("() => synNotes.some(n => n.type === 'success')")
        self.assertEqual([], page.evaluate("() => synInteractions"), 'export runs in the page, not as a viewer command')

    # ── FB-031: copy the selected cell or the whole screen as seen ──
    def test_10_copy_image_puts_the_selected_cell_as_seen_on_the_clipboard(self):
        page = self.open()
        self.click(page, 'CopyImage')
        page.wait_for_function("() => synNotes.length")
        self.assertEqual('success', page.evaluate("() => synNotes.at(-1).type"), page.evaluate("() => synNotes"))
        got = page.evaluate(CLIPBOARD, {'width': 200, 'samples': [[150, 130], [100, 100], [10 + 15 * 1 + 5, 55]],
                                        'regions': [[4, 4, 120, 30], [160, 115, 38, 33]]})
        self.assertEqual('image/png', got['type'])
        self.assertEqual((400, 300), (got['width'], got['height']), 'the image keeps the canvas pixel density')
        image, line, frame = got['samples']
        self.assertTrue(near(image, (200, 0, 0)), image)
        self.assertTrue(near(line, (0, 255, 0)), 'the measurement layer is in the copy: %s' % line)
        self.assertTrue(near(frame, (255, 255, 255)), 'the shown frame: %s' % frame)
        text, action = got['regions']
        self.assertTrue(any(near(tuple(map(int, rgb.split(','))), (255, 255, 0), 60) for rgb in text), 'the image text is in the copy')
        self.assertFalse(any(near(tuple(map(int, rgb.split(','))), (255, 0, 255), 60) for rgb in action), 'control text is not image text')

    def test_11_hidden_image_text_is_not_copied(self):
        page = self.open()
        page.evaluate("() => document.querySelectorAll('.overlay').forEach(n => { n.style.display = 'none'; })")
        self.click(page, 'CopyImage')
        page.wait_for_function("() => synNotes.length")
        got = page.evaluate(CLIPBOARD, {'width': 200, 'samples': [], 'regions': [[4, 4, 120, 30]]})
        self.assertFalse(any(near(tuple(map(int, rgb.split(','))), (255, 255, 0), 60) for rgb in got['regions'][0]))

    def test_12_copy_screen_puts_every_cell_in_one_image(self):
        page = self.open()
        self.click(page, 'CopyScreen')
        page.wait_for_function("() => synNotes.length")
        got = page.evaluate(CLIPBOARD, {'width': 400, 'samples': [[150, 130], [350, 130]]})
        self.assertEqual((800, 300), (got['width'], got['height']))
        self.assertTrue(near(got['samples'][0], (200, 0, 0)), got)
        self.assertTrue(near(got['samples'][1], (0, 0, 200)), got)

    def test_14_a_cell_replaced_while_the_copy_is_drawn_writes_nothing(self):
        page = self.open(before="""() => { const decode = Image.prototype.decode;
          Image.prototype.decode = function () { return new Promise(r => setTimeout(r, 200)).then(() => decode.call(this)); }; }""")
        page.evaluate("async () => { await navigator.clipboard.writeText('SYN before'); }")
        # Another study arrives in the same cell (A -> B) while the measurement layer is being drawn.
        self.click(page, 'CopyImage')
        page.evaluate("() => { const v = synViewports.get('left'); synViewports.set('left', { ...v, getImageIds: () => ['syn:other:0'] }); }")
        page.wait_for_function("() => synNotes.length")
        self.assertEqual(['error'], page.evaluate("() => synNotes.map(n => n.type)"))
        self.assertIn('바뀌어', page.evaluate("() => synNotes[0].message"))
        self.assertEqual('SYN before', page.evaluate("() => navigator.clipboard.readText()"))

    def test_13_no_clipboard_or_no_cell_says_so(self):
        page = self.open(before="() => { Object.defineProperty(window, 'ClipboardItem', { value: undefined }); }")
        self.click(page, 'CopyImage')
        self.assertEqual(['error'], page.evaluate("() => synNotes.map(n => n.type)"))
        page = self.open()
        page.evaluate("() => synServices.viewportGridService.setActive('missing')")
        self.click(page, 'CopyImage')
        self.assertEqual(['warning'], page.evaluate("() => synNotes.map(n => n.type)"))


if __name__ == '__main__':
    unittest.main(verbosity=2)
