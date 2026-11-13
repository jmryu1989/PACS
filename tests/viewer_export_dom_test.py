# coding: utf-8
"""Viewer export (copy, JPEG, series, video, captures) on the shipped toolbar and export module.

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
  const TEXT_COLOURS = ['rgb(0, 255, 255)', 'rgb(255, 255, 0)', 'rgb(255, 128, 0)', 'rgb(128, 255, 128)'];
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
      // The viewport reports the draw; the image text follows one frame later, as React overlays do.
      requestAnimationFrame(() => { element.dispatchEvent(new CustomEvent('CORNERSTONE_IMAGE_RENDERED'));
        requestAnimationFrame(() => { text.style.color = TEXT_COLOURS[index]; }); });
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

    def open(self, setup=SETUP, before=None, scale=1):
        context = self.browser.new_context(viewport={'width': 900, 'height': 700}, accept_downloads=True, device_scale_factor=scale)
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
        self.assertEqual(['WindowLevel', 'Zoom', 'Pointer'], bar, 'the frequent bar holds no export action')
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

    def test_04_on_off_items_of_the_stock_menu_show_whether_they_are_on(self):
        # The stock viewer marks an on/off item only with its "on" text class (a selected tool reports isActive).
        # Reference Lines starts on there, so the menu must say so before the first press turns it off.
        page = self.open()
        page.evaluate("""() => {
          const ON = '!text-primary-active', OFF = '!text-common-bright hover:!bg-primary-dark hover:text-primary-light';
          window.synClass = { ReferenceLines: ON, ImageOverlayViewer: OFF };
          synButtons.MoreTools = { id: 'MoreTools', uiType: 'ohif.splitButton', props: { groupId: 'MoreTools', items: [
            { id: 'ReferenceLines', label: 'Reference Lines', commands: 'toggleEnabledDisabledToolbar' },
            { id: 'ImageOverlayViewer', label: 'Image Overlay', commands: 'toggleEnabledDisabledToolbar' },
            { id: 'Reset', label: 'Reset View', commands: 'resetViewport' }] } };
          synSection.push('MoreTools');
          const stock = synServices.toolbarService.getButtonProps;
          synServices.toolbarService.getButtonProps = id => {
            const item = synButtons.MoreTools.props.items.find(x => x.id === id);
            return item ? { ...item, disabled: false, className: synClass[id] || '', isActive: undefined } : stock(id);
          };
          synServices.toolbarService.recordInteraction = item => {
            synInteractions.push(item.itemId);
            if (synClass[item.itemId]) synClass[item.itemId] = synClass[item.itemId] === ON ? OFF : ON;
            synServices.toolbarService.changed();
          };
          synServices.toolbarService.changed();
        }""")
        pressed = "id => document.querySelector('.kin-ux-toolbar [data-tool=\"' + id + '\"]')?.getAttribute('aria-pressed') ?? null"
        page.wait_for_function("() => !!document.querySelector('.kin-ux-more [data-tool=\"ReferenceLines\"]')")
        self.assertEqual(['true', 'false', None], [page.evaluate(pressed, tool) for tool in ['ReferenceLines', 'ImageOverlayViewer', 'Reset']])
        self.click(page, 'ReferenceLines')
        page.wait_for_function("() => document.querySelector('.kin-ux-toolbar [data-tool=\"ReferenceLines\"]').getAttribute('aria-pressed') === 'false'")
        self.click(page, 'ImageOverlayViewer')
        page.wait_for_function("() => document.querySelector('.kin-ux-toolbar [data-tool=\"ImageOverlayViewer\"]').getAttribute('aria-pressed') === 'true'")
        self.assertEqual(['ReferenceLines', 'ImageOverlayViewer'], page.evaluate("() => synInteractions"))
        # A selected tool keeps the state the viewer reports for it.
        self.assertEqual(None, page.evaluate(pressed, 'WindowLevel'))

    # ── Copy: the selected cell or the whole screen as seen ──
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

    def test_15_a_viewer_ending_while_the_png_is_encoded_writes_nothing(self):
        page = self.open(before="""() => { const toBlob = HTMLCanvasElement.prototype.toBlob;
          HTMLCanvasElement.prototype.toBlob = function (...args) { setTimeout(() => toBlob.apply(this, args), 300); }; }""")
        page.evaluate("async () => { await navigator.clipboard.writeText('SYN before'); }")
        self.click(page, 'CopyImage')
        page.wait_for_timeout(100)
        page.evaluate("() => synToolbar.dispose()")
        page.wait_for_function("() => synNotes.length")
        self.assertEqual(['error'], page.evaluate("() => synNotes.map(n => n.type)"))
        self.assertEqual('SYN before', page.evaluate("() => navigator.clipboard.readText()"))

    def test_16_a_cell_that_shows_another_series_and_comes_back_is_not_the_same_cell(self):
        page = self.open(before="""() => { const decode = Image.prototype.decode;
          Image.prototype.decode = function () { return new Promise(r => setTimeout(r, 300)).then(() => decode.call(this)); }; }""")
        page.evaluate("async () => { await navigator.clipboard.writeText('SYN before'); }")
        self.click(page, 'CopyImage')
        # A -> B -> A in the same viewport while the copy is drawn: the native viewport announces each new stack.
        page.evaluate("""() => { const v = synViewports.get('left'), ids = v.getImageIds;
          v.getImageIds = () => ['syn:other:0']; v.element.dispatchEvent(new CustomEvent('CORNERSTONE_STACK_NEW_STACK'));
          v.getImageIds = ids; v.element.dispatchEvent(new CustomEvent('CORNERSTONE_STACK_NEW_STACK')); }""")
        page.wait_for_function("() => synNotes.length")
        self.assertEqual(['error'], page.evaluate("() => synNotes.map(n => n.type)"))
        self.assertEqual('SYN before', page.evaluate("() => navigator.clipboard.readText()"))

    def test_17_wrapped_clipped_and_boxed_image_text_keeps_its_place(self):
        page = self.open()
        # Three lines of image text on a dark blue box, and a narrow clipping box whose overflow is hidden on screen.
        page.evaluate("""() => { const pane = document.querySelector('[data-cy=viewport-pane]');
          pane.querySelector('.overlay').remove();
          const lines = document.createElement('div'); lines.textContent = 'AAAA\\nBBBB\\nCCCC';
          lines.style.cssText = 'position:absolute;left:4px;top:4px;white-space:pre-line;line-height:30px;font:bold 26px sans-serif;color:rgb(255,255,0);background:rgb(0,0,128)';
          const clip = document.createElement('div'); clip.textContent = 'WWWWWWWWWWWW';
          clip.style.cssText = 'position:absolute;left:120px;top:4px;width:40px;overflow:hidden;white-space:nowrap;font:bold 26px sans-serif;color:rgb(255,255,0)';
          pane.append(lines, clip); }""")
        self.click(page, 'CopyImage')
        page.wait_for_function("() => synNotes.length")
        got = page.evaluate(CLIPBOARD, {'width': 200, 'samples': [[2 + 1, 50]],
                                        'regions': [[4, 4, 70, 30], [4, 34, 70, 30], [4, 64, 70, 30], [120, 4, 40, 30], [162, 4, 36, 30]]})
        yellow = lambda region: any(near(tuple(map(int, rgb.split(','))), (255, 255, 0), 60) for rgb in region)
        navy = lambda region: any(near(tuple(map(int, rgb.split(','))), (0, 0, 128), 30) for rgb in region)
        first, second, third, clipped, beyond = got['regions']
        self.assertTrue(yellow(first) and yellow(second) and yellow(third), 'each of the three lines is on its own line')
        self.assertTrue(navy(second), 'the box behind the text keeps its background')
        self.assertTrue(yellow(clipped)); self.assertFalse(yellow(beyond), 'text clipped on screen is clipped in the copy')

    # The clipboard image as PNG bytes.
    CLIPBOARD_BYTES = """async () => { const items = await navigator.clipboard.read(); const blob = await items[0].getType('image/png');
      return await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result.split(',')[1]); f.readAsDataURL(blob); }); }"""

    def text_overlap(self, page, names):
        """Image text of each name on screen against the copy: overlap (IoU) of their yellow text pixels."""
        import base64
        from io import BytesIO
        from PIL import Image
        page.evaluate("""names => { const pane = document.querySelector('[data-cy=viewport-pane]'); pane.querySelector('.overlay').remove();
          names.forEach((name, i) => { const n = document.createElement('div'); n.textContent = name; n.dir = i ? 'rtl' : 'ltr';
            n.style.cssText = 'position:absolute;left:4px;width:190px;top:' + (6 + 40 * i) + 'px;font:26px sans-serif;color:rgb(255,255,0);text-align:' + (i ? 'right' : 'left');
            pane.append(n); }); }""", names)
        # Screen and copy at the same density (device scale 2, canvas density 2): no resampling between them.
        shot = Image.open(BytesIO(page.screenshot(clip={'x': 0, 'y': 60, 'width': 200, 'height': 150}, scale='device'))).convert('RGB')
        self.click(page, 'CopyImage')
        page.wait_for_function("() => synNotes.some(n => n.type === 'success')")
        copied = Image.open(BytesIO(base64.b64decode(page.evaluate(self.CLIPBOARD_BYTES)))).convert('RGB')
        self.assertEqual(shot.size, copied.size)
        text = lambda rgb: rgb[0] > 170 and rgb[1] > 170 and rgb[2] < 120
        overlaps = []
        for i in range(len(names)):
            box = [(x, y) for x in range(400) for y in range(12 + 80 * i, 80 + 80 * i)]
            a = {p for p in box if text(shot.getpixel(p))}; b = {p for p in box if text(copied.getpixel(p))}
            overlaps.append(len(a & b) / max(1, len(a | b)))
        return overlaps

    def test_18_decomposed_korean_and_joined_arabic_names_are_drawn_as_on_screen(self):
        import unicodedata
        page = self.open(scale=2)
        overlaps = self.text_overlap(page, [unicodedata.normalize('NFD', '홍길동 환자'), 'محمد أحمد'])
        # Same density, same place: the copy's text pixels are the screen's (per-character drawing scored 0.47 and 0.34).
        for overlap in overlaps: self.assertGreater(overlap, 0.9, overlaps)

    def test_13_no_clipboard_or_no_cell_says_so(self):
        page = self.open(before="() => { Object.defineProperty(window, 'ClipboardItem', { value: undefined }); }")
        self.click(page, 'CopyImage')
        self.assertEqual(['error'], page.evaluate("() => synNotes.map(n => n.type)"))
        page = self.open()
        page.evaluate("() => synServices.viewportGridService.setActive('missing')")
        self.click(page, 'CopyImage')
        self.assertEqual(['warning'], page.evaluate("() => synNotes.map(n => n.type)"))

    # ── Save JPEG: one image; Save Series JPEG: every image of the series as JPEG in one ZIP ──
    STATUS = "() => document.querySelector('.kin-ux-toolbar-settings [role=status]').textContent"
    TEXT_COLOURS = [(0, 255, 255), (255, 255, 0), (255, 128, 0), (128, 255, 128)]

    def downloads(self, page):
        seen = []; page.on('download', lambda download: seen.append(download)); return seen

    def image(self, data):
        from io import BytesIO
        from PIL import Image
        bitmap = Image.open(BytesIO(data)); bitmap.load(); return bitmap

    def assert_frame(self, bitmap, index, colour=(200, 0, 0)):
        rgb = bitmap.convert('RGB')
        self.assertTrue(near(rgb.getpixel((300, 260)), colour), 'the image: %s' % (rgb.getpixel((300, 260)),))
        self.assertTrue(near(rgb.getpixel(((10 + 15 * index + 5) * 2, 55 * 2)), (255, 255, 255)), 'image %d is drawn' % index)
        for other in range(4):
            if other != index:
                self.assertFalse(near(rgb.getpixel(((10 + 15 * other + 5) * 2, 55 * 2)), (255, 255, 255)), 'only image %d' % index)
        text = {rgb.getpixel((x, y)) for x in range(8, 240, 2) for y in range(8, 68, 2)}
        self.assertTrue(any(near(c, self.TEXT_COLOURS[index], 60) for c in text), 'the image text of image %d is drawn' % index)

    def test_20_save_jpeg_downloads_the_cell_as_a_real_jpeg(self):
        page = self.open()
        with page.expect_download() as saved:
            self.click(page, 'SaveJPEG')
        path = saved.value.path(); data = Path(path).read_bytes()
        self.assertRegex(saved.value.suggested_filename, r'^image-\d{8}-\d{6}\.jpg$')
        self.assertEqual(b'\xff\xd8\xff', data[:3])
        bitmap = self.image(data)
        self.assertEqual(('JPEG', (400, 300)), (bitmap.format, bitmap.size))
        self.assert_frame(bitmap, 1)
        self.assertTrue(near(bitmap.convert('RGB').getpixel((200, 200)), (0, 255, 0)), 'the measurement layer')

    def test_21_save_series_jpeg_writes_every_image_in_order_and_returns_to_the_shown_one(self):
        import zipfile
        from io import BytesIO
        page = self.open()
        page.evaluate("() => { window.synSaid = []; new MutationObserver(() => synSaid.push(document.querySelector('.kin-ux-toolbar-settings [role=status]').textContent)).observe(document.querySelector('.kin-ux-toolbar-settings'), { subtree: true, childList: true, characterData: true }); }")
        before = page.evaluate(self.STATUS)
        with page.expect_download() as saved:
            self.click(page, 'SaveSeriesJPEG')
        self.assertRegex(saved.value.suggested_filename, r'^series-7-\d{8}-\d{6}\.zip$')
        archive = zipfile.ZipFile(BytesIO(Path(saved.value.path()).read_bytes()))
        self.assertIsNone(archive.testzip())
        self.assertEqual(['image-0001.jpg', 'image-0002.jpg', 'image-0003.jpg', 'image-0004.jpg'], archive.namelist())
        for index, name in enumerate(archive.namelist()):
            bitmap = self.image(archive.read(name))
            self.assertEqual(('JPEG', (400, 300)), (bitmap.format, bitmap.size))
            self.assert_frame(bitmap, index)
        page.wait_for_function("() => synViewports.get('left').getCurrentImageIdIndex() === 1")
        page.wait_for_function("before => document.querySelector('.kin-ux-toolbar-settings [role=status]').textContent === before", arg=before)
        self.assertIn('JPEG 만드는 중 4/4 · Esc로 멈춤', page.evaluate("() => synSaid"))
        self.assertEqual('success', page.evaluate("() => synNotes.at(-1).type"))

    def slow(self, page, ms=150):
        page.evaluate("""ms => { const v = synViewports.get('left'), set = v.setImageIdIndex; v.reader = set;
          v.setImageIdIndex = value => new Promise(r => setTimeout(r, ms)).then(() => set(value)); }""", ms)

    def test_22_escape_stops_without_a_file_and_returns_to_the_shown_image(self):
        page = self.open(); seen = self.downloads(page); self.slow(page)
        self.click(page, 'SaveSeriesJPEG')
        page.wait_for_function("() => document.querySelector('.kin-ux-toolbar-settings [role=status]').textContent.includes('2/4')")
        page.keyboard.press('Escape')
        page.wait_for_function("() => synNotes.length")
        self.assertEqual(['warning'], page.evaluate("() => synNotes.map(n => n.type)"))
        self.assertIn('멈췄습니다', page.evaluate("() => synNotes[0].message"))
        page.wait_for_function("() => synViewports.get('left').getCurrentImageIdIndex() === 1")
        page.wait_for_timeout(300); self.assertEqual([], seen)

    def test_23_the_reader_moving_the_image_stops_it_and_is_not_undone(self):
        page = self.open(); seen = self.downloads(page); self.slow(page)
        self.click(page, 'SaveSeriesJPEG')
        # The reader scrolls back to the first image while the export shows the third (the reader's own scroll is not slowed).
        page.wait_for_function("() => synViewports.get('left').getCurrentImageIdIndex() === 2")
        page.evaluate("() => synViewports.get('left').reader(0)")
        page.wait_for_function("() => synNotes.length")
        self.assertIn('바뀌어', page.evaluate("() => synNotes[0].message"))
        page.wait_for_timeout(500)
        self.assertEqual(0, page.evaluate("() => synViewports.get('left').getCurrentImageIdIndex()"))
        self.assertEqual([], seen)

    def test_24_another_series_in_the_cell_stops_it_and_nothing_is_restored_onto_it(self):
        page = self.open(); seen = self.downloads(page); self.slow(page)
        self.click(page, 'SaveSeriesJPEG')
        page.wait_for_function("() => document.querySelector('.kin-ux-toolbar-settings [role=status]').textContent.includes('2/4')")
        page.evaluate("""() => { const v = synViewports.get('left'); window.synMoved = [];
          synViewports.set('left', { ...v, getImageIds: () => ['syn:other:0', 'syn:other:1'], getCurrentImageIdIndex: () => 0,
            setImageIdIndex: async value => { synMoved.push(value); } }); }""")
        page.wait_for_function("() => synNotes.length")
        page.wait_for_timeout(500)
        self.assertEqual([], page.evaluate("() => synMoved"), 'the other series is not moved')
        self.assertEqual([], seen)

    def test_25_playing_cine_or_a_running_export_refuses_to_start(self):
        page = self.open(); seen = self.downloads(page)
        page.evaluate("() => { synServices.cineService.getState = () => ({ cines: { left: { isPlaying: true } } }); }")
        self.click(page, 'SaveSeriesJPEG')
        self.assertIn('Cine', page.evaluate("() => synNotes.at(-1).message"))
        page.evaluate("() => { synServices.cineService.getState = () => ({ cines: {} }); synNotes.length = 0; }")
        self.slow(page)
        self.click(page, 'SaveSeriesJPEG'); self.click(page, 'SaveSeriesJPEG')
        self.assertIn('진행 중', page.evaluate("() => synNotes.at(-1).message"))
        page.wait_for_function("() => synNotes.some(n => n.type === 'success')")
        page.wait_for_timeout(200); self.assertEqual(1, len(seen))

    def record_moves(self, page):
        page.evaluate("""() => { const v = synViewports.get('left'), set = v.setImageIdIndex; window.synMoves = [];
          v.setImageIdIndex = value => { synMoves.push(value); return set(value); }; }""")

    def test_27_an_unrelated_draw_does_not_end_the_wait_and_a_stop_lets_the_call_land_first(self):
        page = self.open(); seen = self.downloads(page); self.slow(page, 300)
        self.click(page, 'SaveSeriesJPEG')
        page.wait_for_function("() => document.querySelector('.kin-ux-toolbar-settings [role=status]').textContent.includes('1/4')")
        # Another draw of the cell (still on image 2 of 4) arrives while image 1 loads, then the reader presses Esc.
        page.evaluate("() => synViewports.get('left').element.dispatchEvent(new CustomEvent('CORNERSTONE_IMAGE_RENDERED'))")
        page.keyboard.press('Escape')
        page.wait_for_function("() => synNotes.length")
        self.assertIn('멈췄습니다', page.evaluate("() => synNotes[0].message"))
        page.wait_for_function("() => synViewports.get('left').getCurrentImageIdIndex() === 1")
        page.wait_for_timeout(900)
        self.assertEqual(1, page.evaluate("() => synViewports.get('left').getCurrentImageIdIndex()"), 'no late call moves the image after the stop')
        self.assertEqual([], seen)

    def test_27b_an_unrelated_draw_while_an_image_loads_neither_stops_nor_shifts_the_series(self):
        import zipfile
        from io import BytesIO
        page = self.open(); self.slow(page, 300)
        with page.expect_download() as saved:
            self.click(page, 'SaveSeriesJPEG')
            page.wait_for_function("() => document.querySelector('.kin-ux-toolbar-settings [role=status]').textContent.includes('1/4')")
            page.evaluate("() => synViewports.get('left').element.dispatchEvent(new CustomEvent('CORNERSTONE_IMAGE_RENDERED'))")
        archive = zipfile.ZipFile(BytesIO(Path(saved.value.path()).read_bytes()))
        for index, name in enumerate(archive.namelist()):
            self.assert_frame(self.image(archive.read(name)), index)

    def test_27c_a_load_that_lands_after_the_timeout_is_still_this_exports_and_is_undone(self):
        # The image load times out (0.2 s here) but lands at 1.5 s: the export holds on until then and goes back.
        page = self.open(); seen = self.downloads(page); self.slow(page, 1500)
        page.evaluate("() => { KinViewerExport.options.loadTimeout = 200; }")
        self.click(page, 'SaveSeriesJPEG')
        page.wait_for_function("() => synNotes.length", timeout=15000)
        self.assertIn('불러오지 못해', page.evaluate("() => synNotes[0].message"))
        self.assertEqual(1, page.evaluate("() => synViewports.get('left').getCurrentImageIdIndex()"), 'back on the shown image when it says so')
        page.wait_for_timeout(2500)
        self.assertEqual(1, page.evaluate("() => synViewports.get('left').getCurrentImageIdIndex()"), 'nothing moves it afterwards')
        self.assertEqual([], seen)
        self.click(page, 'SaveSeriesJPEG')
        self.assertNotIn('진행 중', page.evaluate("() => synNotes.at(-1).message"), 'the export was released')

    def returning(self, page):
        # The export has shown the last image and is going back to the image the reader was on.
        page.wait_for_function("() => synMoves.length >= 2 && synMoves.at(-1) === 1 && synMoves.at(-2) === 3")

    def test_28_escape_or_a_viewer_ending_while_it_returns_writes_nothing(self):
        for stop in ["() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))", "() => synToolbar.dispose()"]:
            page = self.open(); seen = self.downloads(page); self.slow(page, 300); self.record_moves(page)
            self.click(page, 'SaveSeriesJPEG')
            self.returning(page)
            page.evaluate(stop)
            page.wait_for_function("() => synNotes.length")
            page.wait_for_timeout(700)
            self.assertEqual([], seen, stop)
            self.assertNotEqual('success', page.evaluate("() => synNotes.at(-1).type"), stop)

    def test_29_a_failed_return_writes_nothing_and_says_so(self):
        # Four images are shown (moves 0, 1, 2, 3); the fifth move, back to image 2 of 4, fails to load.
        page = self.open(); seen = self.downloads(page); self.record_moves(page)
        page.evaluate("""() => { const v = synViewports.get('left'), set = v.setImageIdIndex;
          v.setImageIdIndex = value => synMoves.length >= 4 ? Promise.reject(new Error('load failed')) : set(value); }""")
        self.click(page, 'SaveSeriesJPEG')
        page.wait_for_function("() => synNotes.length")
        self.assertEqual('error', page.evaluate("() => synNotes.at(-1).type"))
        self.assertIn('돌아가지 못해', page.evaluate("() => synNotes.at(-1).message"))
        page.wait_for_timeout(300); self.assertEqual([], seen)

    def test_26_volume_cells_are_refused_for_series(self):
        page = self.open()
        page.evaluate("() => { synViewports.get('left').type = 'orthographic'; }")
        self.click(page, 'SaveSeriesJPEG')
        self.assertIn('2D', page.evaluate("() => synNotes.at(-1).message"))

    # ── Save Video: the series as a video, played back frame by frame ──
    # Plays the downloaded file in the page and reads which image (bright square) each presented frame shows.
    PLAYED = """async b64 => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const video = document.createElement('video'); video.muted = true; video.src = URL.createObjectURL(new Blob([bytes]));
      document.body.append(video);
      await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('not playable')); });
      const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight;
      const x = c.getContext('2d', { willReadFrequently: true });
      const shown = () => { x.drawImage(video, 0, 0);
        for (let k = 0; k < 4; k++) { const d = x.getImageData(Math.round((10 + 15 * k + 5) * 2 * c.width / 400), Math.round(110 * c.height / 300), 1, 1).data;
          if (d[0] > 190 && d[1] > 190 && d[2] > 190) return k; } return -1; };
      // Seek, paused, to each sample time; the recorder's WebM has no index, so the end is found by seeking far.
      // After the seek, wait until the frame at that time is presented (a fallback timer for a frame already shown).
      const seek = time => new Promise(resolve => { video.onseeked = () => { video.requestVideoFrameCallback(() => resolve()); setTimeout(resolve, 250); }; video.currentTime = time; });
      await seek(1e6); const end = video.currentTime; const seen = [];
      for (let time = 0.05; time < end; time += 0.1) { await seek(time); seen.push([Math.round(time * 100) / 100, shown()]); }
      return { width: c.width, height: c.height, seen, end };
    }"""

    def test_30_save_video_plays_every_image_in_order_at_the_cine_speed(self):
        import base64
        page = self.open()
        page.evaluate("() => { synServices.cineService.getState = () => ({ cines: { left: { isPlaying: false, frameRate: 5 } } }); }")
        with page.expect_download(timeout=30000) as saved:
            self.click(page, 'SaveVideo')
        name, data = saved.value.suggested_filename, Path(saved.value.path()).read_bytes()
        self.assertRegex(name, r'^series-7-\d{8}-\d{6}\.(mp4|webm)$')
        if name.endswith('.webm'): self.assertEqual(b'\x1a\x45\xdf\xa3', data[:4])
        else: self.assertEqual(b'ftyp', data[4:8])
        played = page.evaluate(self.PLAYED, base64.b64encode(data).decode())
        self.assertEqual((400, 300), (played['width'], played['height']))
        order, first = [], {}
        for time, image in played['seen']:
            if image < 0: continue
            if not order or order[-1] != image: order.append(image)
            first.setdefault(image, time)
        self.assertEqual([0, 1, 2, 3], order, played['seen'])
        for image in range(4):
            self.assertAlmostEqual(image / 5, first[image], delta=0.12, msg='5 fps: %s' % played['seen'])
        self.assertAlmostEqual(4 / 5, played['end'], delta=0.12, msg='the last image keeps its 1/5 s: %s' % played)
        page.wait_for_function("() => synViewports.get('left').getCurrentImageIdIndex() === 1")
        self.assertEqual('success', page.evaluate("() => synNotes.at(-1).type"))
        self.assertIn('5 fps', page.evaluate("() => synNotes.at(-1).message"))

    def test_31_escape_while_recording_writes_no_file(self):
        page = self.open(); seen = self.downloads(page)
        page.evaluate("() => { synServices.cineService.getState = () => ({ cines: { left: { isPlaying: false, frameRate: 1 } } }); }")
        self.click(page, 'SaveVideo')
        page.wait_for_function("() => document.querySelector('.kin-ux-toolbar-settings [role=status]').textContent.includes('동영상 녹화 중 2/4')")
        page.keyboard.press('Escape')
        page.wait_for_function("() => synNotes.length")
        self.assertIn('멈췄습니다', page.evaluate("() => synNotes[0].message"))
        page.wait_for_timeout(1500); self.assertEqual([], seen)
        self.assertEqual(1, page.evaluate("() => synViewports.get('left').getCurrentImageIdIndex()"))

    def test_33_an_image_not_ready_by_its_time_writes_no_video(self):
        # At 5 fps the second image is due 0.2 s after the first; its decode takes 0.7 s.
        page = self.open(before="""() => { const decode = window.createImageBitmap; let calls = 0;
          window.createImageBitmap = (...args) => ++calls === 2 ? new Promise(r => setTimeout(r, 700)).then(() => decode(...args)) : decode(...args); }""")
        seen = self.downloads(page)
        page.evaluate("() => { synServices.cineService.getState = () => ({ cines: { left: { isPlaying: false, frameRate: 5 } } }); }")
        self.click(page, 'SaveVideo')
        page.wait_for_function("() => synNotes.length", timeout=15000)
        self.assertEqual('error', page.evaluate("() => synNotes.at(-1).type"))
        self.assertIn('제때', page.evaluate("() => synNotes.at(-1).message"))
        page.wait_for_timeout(500); self.assertEqual([], seen)

    def test_34_a_short_decode_delay_is_absorbed_and_the_timing_holds(self):
        import base64
        # The fourth image's decode takes 0.3 s; it starts with the first, so it is ready long before 0.6 s.
        page = self.open(before="""() => { const decode = window.createImageBitmap; let calls = 0;
          window.createImageBitmap = (...args) => ++calls === 4 ? new Promise(r => setTimeout(r, 300)).then(() => decode(...args)) : decode(...args); }""")
        page.evaluate("() => { synServices.cineService.getState = () => ({ cines: { left: { isPlaying: false, frameRate: 5 } } }); }")
        with page.expect_download(timeout=30000) as saved:
            self.click(page, 'SaveVideo')
        played = page.evaluate(self.PLAYED, base64.b64encode(Path(saved.value.path()).read_bytes()).decode())
        first = {}
        for time, image in played['seen']: first.setdefault(image, time)
        for image in range(4):
            self.assertAlmostEqual(image / 5, first[image], delta=0.12, msg='5 fps: %s' % played['seen'])

    def test_32_a_browser_without_a_recorder_says_so(self):
        page = self.open(before="() => { Object.defineProperty(window, 'MediaRecorder', { value: undefined }); }")
        self.click(page, 'SaveVideo')
        self.assertEqual(['error'], page.evaluate("() => synNotes.map(n => n.type)"))

    # ── Captures: captures collect in this window's Captures panel ──
    def panel(self, page):
        return page.get_by_role('complementary', name='Captures')

    def test_40_captures_collect_copy_save_remove_and_save_all(self):
        import zipfile
        from io import BytesIO
        page = self.open()
        self.click(page, 'AddToCaptures')
        panel = self.panel(page)
        panel.get_by_role('heading', name='Captures (1)').wait_for()
        page.evaluate("() => synServices.viewportGridService.setActive('right')")
        panel.get_by_role('button', name='Add Image', exact=True).click()
        panel.get_by_role('button', name='Add Screen', exact=True).click()
        panel.get_by_role('heading', name='Captures (3)').wait_for()
        labels = panel.locator('li img').evaluate_all("nodes => nodes.map(n => n.alt)")
        self.assertEqual(3, len(labels)); self.assertIn(' · Screen · ', labels[2])
        # Each capture is the cell as it was: left red, right blue, the screen both.
        colours = []
        for label in labels:
            with page.expect_download() as saved:
                panel.get_by_role('button', name='Save ' + label, exact=True).click()
            self.assertRegex(saved.value.suggested_filename, r'^capture-0\d-\d{8}-\d{6}\.png$')
            bitmap = self.image(Path(saved.value.path()).read_bytes()).convert('RGB')
            colours.append((bitmap.size, bitmap.getpixel((300, 260)), bitmap.getpixel((bitmap.width - 100, 260))))
        self.assertEqual([(400, 300), (400, 300), (800, 300)], [c[0] for c in colours])
        self.assertTrue(near(colours[0][1], (200, 0, 0)) and near(colours[1][1], (0, 0, 200)), colours)
        self.assertTrue(near(colours[2][1], (200, 0, 0)) and near(colours[2][2], (0, 0, 200)), colours)
        panel.get_by_role('button', name='Copy ' + labels[1], exact=True).click()
        page.wait_for_function("() => synNotes.some(n => n.type === 'success' && n.message.startsWith('Capture 2'))")
        got = page.evaluate(CLIPBOARD, {'width': 200, 'samples': [[150, 130]]})
        self.assertTrue(near(got['samples'][0], (0, 0, 200)), got)
        panel.get_by_role('button', name='Remove ' + labels[0], exact=True).click()
        panel.get_by_role('heading', name='Captures (2)').wait_for()
        with page.expect_download() as saved:
            panel.get_by_role('button', name='Save All', exact=True).click()
        archive = zipfile.ZipFile(BytesIO(Path(saved.value.path()).read_bytes()))
        self.assertIsNone(archive.testzip()); self.assertEqual(2, len(archive.namelist()))
        self.assertTrue(all(archive.read(n)[:8] == b'\x89PNG\r\n\x1a\n' for n in archive.namelist()))
        panel.get_by_role('button', name='Clear', exact=True).click()
        panel.get_by_role('heading', name='Captures (0)').wait_for()
        panel.get_by_role('button', name='Close', exact=True).click()
        self.assertFalse(panel.is_visible())
        self.click(page, 'Captures')
        self.assertTrue(panel.is_visible())
        self.click(page, 'Captures')
        self.assertFalse(panel.is_visible())

    def test_41_leaving_the_study_empties_the_panel_and_drops_a_capture_in_flight(self):
        page = self.open()
        self.click(page, 'AddToCaptures')
        self.panel(page).get_by_role('heading', name='Captures (1)').wait_for()
        page.evaluate("""() => { const decode = Image.prototype.decode;
          Image.prototype.decode = function () { return new Promise(r => setTimeout(r, 300)).then(() => decode.call(this)); }; }""")
        self.click(page, 'AddToCaptures')
        page.evaluate("() => synToolbar.dispose()")
        self.assertEqual(0, page.locator('aside.kin-captures').count())
        page.wait_for_timeout(700)
        self.assertEqual(0, page.locator('aside.kin-captures').count(), 'the late capture does not bring the panel back')
        self.assertEqual([], page.evaluate("() => synNotes.filter(n => n.type === 'error')"))

    def test_43_save_all_after_leaving_the_study_writes_nothing(self):
        page = self.open(); seen = self.downloads(page)
        self.click(page, 'AddToCaptures')
        self.panel(page).get_by_role('heading', name='Captures (1)').wait_for()
        page.evaluate("""() => { const read = Blob.prototype.arrayBuffer;
          Blob.prototype.arrayBuffer = function () { return new Promise(r => setTimeout(r, 300)).then(() => read.call(this)); }; }""")
        self.panel(page).get_by_role('button', name='Save All', exact=True).click()
        page.evaluate("() => synToolbar.dispose()")
        page.wait_for_timeout(800)
        self.assertEqual([], seen)

    def test_42_panel_buttons_meet_the_toolbar_guards(self):
        page = self.open()
        self.click(page, 'Captures')
        page.evaluate("() => { synBusy = true; }")
        self.panel(page).get_by_role('button', name='Add Image', exact=True).click()
        page.wait_for_timeout(200)
        self.panel(page).get_by_role('heading', name='Captures (0)').wait_for()


if __name__ == '__main__':
    unittest.main(verbosity=2)
