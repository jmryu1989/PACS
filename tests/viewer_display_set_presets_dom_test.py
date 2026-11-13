# coding: utf-8
"""Display Set Presets on the shipped image toolbar: the window opened from Viewer Settings › Tools & Display, one row per
cell; Apply to This Study puts each row on its own cell (sort, first image, magnification, windowing, rotate, flip,
filter, overlay); a presentation state (GSPS) found for the shown image wins and its annotations are drawn; Save with
Hanging Protocol hands the rows to the applied Hanging Protocol; an applied Hanging Protocol's rules are put on its cells.

The shipped viewer-features.js, viewer-features-view.js, hanging-protocol-model.js, viewer-image-filter.js,
viewer-gsps.js, viewer-ux-shortcuts.js and viewer-ux-toolbar.js (with viewer-ux-theme.css) run in Chromium beside
synthetic OHIF services, two synthetic CT stack cells of three images each, a synthetic DICOMweb answer with one GSPS
and a synthetic Hanging Protocols panel handle. The real panel is checked in viewer_hanging_protocol_display_dom_test.py
and the real viewer, pixels and measurements in tests/e2e/test_display_set_presets.py.
"""
from pathlib import Path
import unittest

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
ORIGIN = "https://display-set-presets.test"
OWNER = ['syn-site', 'syn-reader']
COLUMNS = ['Display Set', 'Magnification', 'Windowing', 'Filter', 'Sort', 'Rotate', 'Flip', 'First image', 'GSPS auto', 'Overlay']

HARNESS = """<!doctype html><html><head><style>
body { margin: 0; background: #111; color: #eee; --kin-panel: #222; --kin-ux-text: #eee; --kin-ux-secondary: #999; --kin-accent: #6cf; }
#grid { position: absolute; left: 0; top: 80px; display: flex; gap: 4px; }
[data-cy=viewport-pane] { position: relative; width: 300px; height: 200px; overflow: hidden; }
.viewport-element { position: absolute; inset: 0; } .viewport-element canvas { width: 300px; height: 200px; display: block; }
[data-cy^=viewport-overlay-] { position: absolute; font: 12px sans-serif; }
</style></head><body><div id="root"><div class="kin-ux-toolbar-slot"></div><div id="grid"></div></div></body></html>"""

SETUP = """owner => {
  window.synNotes = []; window.synEnded = false; window.synWriter = true; window.synActive = 'left';
  window.synShown = { left: ['syn-set-1'], right: ['syn-set-2'] };
  window.synMeta = {};
  // Three CT images per cell, stored in instance-number order 2, 3, 1 and slice positions z = 0, -10, 10.
  for (const [cell, base] of [['left', '1.2.826.0.1.1'], ['right', '1.2.826.0.1.2']])
    [[2, 0], [3, -10], [1, 10]].forEach(([n, z], i) => { synMeta['syn:' + cell + ':' + (i + 1)] = { Modality: 'CT', SOPInstanceUID: base + '.' + (i + 1),
      StudyInstanceUID: '1.2.826.0.1.100', SeriesInstanceUID: base, InstanceNumber: n, ImagePositionPatient: [0, 0, z],
      ImageOrientationPatient: [1, 0, 0, 0, 1, 0], PixelSpacing: [0.5, 0.5], Rows: 400, Columns: 600 }; });
  const EVENTS = { STACK_NEW_IMAGE: 'syn-new', CAMERA_MODIFIED: 'syn-camera', IMAGE_RENDERED: 'syn-rendered' };
  window.synJumps = [];
  // The stored window of every image: W 1000 / L -500.
  window.cornerstone = { Enums: { Events: EVENTS }, metaData: { get: (type, id) => type === 'instance' ? synMeta[id] : type === 'voiLutModule' && synMeta[id] ? { windowCenter: [-500], windowWidth: [1000] } : undefined },
    utilities: { jumpToSlice: async (element, { imageIndex }) => { const v = [...synViewports.values()].find(x => x.element === element); synJumps.push([v.id, imageIndex]); v.index = imageIndex; } } };
  const fire = (v, name) => v.element.dispatchEvent(new CustomEvent(EVENTS[name], { detail: { viewportId: v.id, element: v.element } }));
  window.synViewports = new Map(); window.synStacks = [];
  for (const id of ['left', 'right']) {
    const pane = document.createElement('div'); pane.dataset.cy = 'viewport-pane'; pane.id = 'pane-' + id;
    pane.innerHTML = '<div class="viewport-element"><canvas width="300" height="200"></canvas></div>'
      + '<div data-cy="viewport-overlay-top-left" style="left:4px;top:4px"><div>SYN^ONE</div></div>'
      + '<div data-cy="viewport-overlay-bottom-left" style="left:4px;bottom:4px"><div class="syn-wl">W: 1000 L: -500</div></div>'
      + '<div class="kin-display-text"><div>Zoom 100%</div></div>';
    document.getElementById('grid').append(pane);
    const element = pane.querySelector('.viewport-element');
    const v = { id, type: 'stack', element, ids: [1, 2, 3].map(n => 'syn:' + id + ':' + n), index: 0, renders: 0, zoom: 1,
      presentation: { rotation: 0 }, properties: { invert: false }, camera: { focalPoint: [0, 0, 0], position: [0, 0, 100], parallelScale: 100, flipHorizontal: false, flipVertical: false } };
    Object.assign(v, {
      getImageIds: () => [...v.ids], getCurrentImageId: () => v.ids[v.index], getCurrentImageIdIndex: () => v.index,
      async setStack(ids, index = 0) { synStacks.push([id, [...ids], index]); v.ids = [...ids]; v.index = index; v.properties = { invert: false }; },
      getZoom: () => v.zoom, setZoom(zoom) { v.zoom = zoom; v.camera.parallelScale = 100 / zoom; fire(v, 'CAMERA_MODIFIED'); },
      setPan() { v.camera.focalPoint = [0, 0, 0]; v.camera.position = [0, 0, 100]; },
      getCamera: () => structuredClone(v.camera), setCamera(next) { v.camera = { ...v.camera, ...structuredClone(next) }; fire(v, 'CAMERA_MODIFIED'); },
      getViewPresentation: () => ({ ...v.presentation }), setViewPresentation(next) { v.presentation = { rotation: next.rotation }; },
      getProperties: () => structuredClone(v.properties), setProperties(next) { v.properties = { ...v.properties, ...structuredClone(next) }; },
      render() { v.renders++; },
      // 0.5 mm pixels; the world origin is the centre of the first pixel. One world mm is one canvas pixel.
      getImageData: () => ({ spacing: [0.5, 0.5, 1], imageData: { indexToWorld: ([i, j]) => [i * 0.5, j * 0.5, 0] } }),
      worldToCanvas: ([x, y]) => [x - v.camera.focalPoint[0] + 150, y - v.camera.focalPoint[1] + 100],
    });
    synViewports.set(id, v);
  }
  window.synCommands = { calls: [], runCommand(name, props, context) { this.calls.push([name, structuredClone(props), context]); } };
  const listeners = new Map();
  const events = name => ({ subscribe(event, fn) { const key = name + event; listeners.set(key, [...(listeners.get(key) || []), fn]);
    return { unsubscribe() { listeners.set(key, (listeners.get(key) || []).filter(f => f !== fn)); } }; } });
  window.synEmit = (name, event, payload) => { for (const fn of listeners.get(name + event) || []) fn(payload); };
  const grid = { ...events('grid'), EVENTS: { ACTIVE_VIEWPORT_ID_CHANGED: 'active', GRID_STATE_CHANGED: 'gridState' },
    getActiveViewportId: () => synActive, setActiveViewportId: id => { synActive = id; },
    getState: () => ({ activeViewportId: synActive, viewports: new Map(Object.entries(synShown).map(([id, sets], x) => [id, { viewportId: id, x: x / 2, y: 0, displaySetInstanceUIDs: sets }])) }) };
  const buttons = Object.fromEntries(['WindowLevel', 'Pan', 'Zoom'].map(id => [id, { id, uiType: 'ohif.radioGroup', props: { label: id, commands: 'setToolActiveToolbar' } }]));
  window.synServices = {
    viewportGridService: grid,
    cornerstoneViewportService: { ...events('cells'), EVENTS: { VIEWPORT_DATA_CHANGED: 'data' }, getCornerstoneViewport: id => synViewports.get(id) },
    customizationService: { get: key => key === 'cornerstone.windowLevelPresets' ? { presets: { CT: [
      { description: 'Soft tissue', window: '400', level: '40' }, { description: 'Lung', window: '1500', level: '-600' }] } } : undefined },
    uiNotificationService: { show: note => synNotes.push(note) },
    toolbarService: { EVENTS: { TOOL_BAR_MODIFIED: 'modified' }, getButtonSection: () => Object.keys(buttons).map(id => ({ id })), getButtons: () => buttons,
      getButtonProps: id => buttons[id] && { id, ...buttons[id].props }, recordInteraction() {}, subscribe: () => ({ unsubscribe() {} }) },
  };
  window.kinViewerHistoryWorkspaceState = () => ({ busy: false });
  window.kinViewerJobWorkspaceState = () => ({ busy: false });
  window.KinViewerHangingSettings = { modalities: [], defaults: {}, get: () => ({}), mount: () => ({ apply() {}, dispose() {} }), mountSizing: () => ({ dispose() {} }) };
  window.KinSessionTransport = { refusal: () => false, responseError: () => new Error('ended') };
  window.synServer = { revision: 3, viewerSettings: null, puts: [] };
  // DICOMweb: one PR series with one GSPS for the left cell's second stored image (SOP …1.2): W 350 / L 50, a 90° turn,
  // a polyline and a text. The account endpoint keeps viewerSettings.
  const sq = items => ({ vr: 'SQ', Value: items }), cs = v => ({ vr: 'CS', Value: [v] });
  window.synGsps = { '00080016': { vr: 'UI', Value: ['1.2.840.10008.5.1.4.1.1.11.1'] }, '00080018': { vr: 'UI', Value: ['1.2.826.0.1.900.1'] },
    '00080060': cs('PR'), '00700080': cs('KEYIMAGE'), '00700082': { vr: 'DA', Value: ['20260801'] }, '00700083': { vr: 'TM', Value: ['101500'] },
    '00081115': sq([{ '00081140': sq([{ '00081155': { vr: 'UI', Value: ['1.2.826.0.1.1.2'] } }]) }]),
    '00283110': sq([{ '00281050': { vr: 'DS', Value: [50] }, '00281051': { vr: 'DS', Value: [350] } }]),
    '00700042': { vr: 'US', Value: [90] }, '00700041': cs('N'), '20500020': cs('IDENTITY'),
    '00700001': sq([{ '00700002': cs('L1'), '00700009': sq([{ '00700005': cs('PIXEL'), '00700023': cs('POLYLINE'), '00700022': { vr: 'FL', Value: [10.5, 20.5, 40.5, 20.5] } }]),
      '00700008': sq([{ '00700004': cs('PIXEL'), '00700014': { vr: 'FL', Value: [10.5, 30.5] }, '00700006': { vr: 'ST', Value: ['Nodule 8 mm'] } }]) }]) };
  window.synRequests = [];
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, init = {}) => {
    const s = synServer, path = String(url); synRequests.push(path);
    if (path === '/dicom-web/studies/1.2.826.0.1.100/series?Modality=PR&limit=101') return reply(200, [{ '0020000E': { vr: 'UI', Value: ['1.2.826.0.1.900'] } }]);
    if (path === '/dicom-web/studies/1.2.826.0.1.100/series/1.2.826.0.1.900/metadata') { if (window.synHoldGsps) await synHoldGsps; return reply(200, [synGsps]); }
    if (!path.endsWith('/api/workspace-shortcuts')) return reply(404, {});
    if ((init.method || 'GET') === 'GET') return reply(200, { owner, revision: s.revision, viewerSettings: structuredClone(s.viewerSettings) });
    const body = JSON.parse(init.body); s.puts.push(body); s.revision++; s.viewerSettings = body.viewerSettings;
    return reply(200, { owner, revision: s.revision, viewerSettings: structuredClone(s.viewerSettings) });
  };
  // A Hanging Protocols panel handle: what it reports as applied, and what Save hands it.
  window.synSaved = []; window.synApplied = null;
  window.KinViewerHangingProtocol = { current: () => ({ applied: () => synApplied && structuredClone(synApplied),
    saveDisplay: async display => { synSaved.push(structuredClone(display)); return { ok: true, account: 'saved' }; } }) };
  window.synSession = { owner: () => owner, ended: () => synEnded, writer: () => synWriter, state: () => 'confirmed', decide: async () => {} };
  window.synMount = () => {
    window.synToolbar = KinViewerUXToolbar.mount({ services: synServices, commands: synCommands, session: synSession });
    window.synKeys = KinViewerUXShortcuts.mount({ getBindings: () => synToolbar.bindings(), invoke: id => synToolbar.invoke(id), allowed: () => !synEnded });
  };
}"""

STATE = """id => { const v = synViewports.get(id), pane = document.getElementById('pane-' + id), canvas = pane.querySelector('canvas');
  const shown = n => getComputedStyle(n).visibility;
  return { ids: v.getImageIds(), index: v.index, image: v.getCurrentImageId(), zoom: v.zoom, rotation: v.presentation.rotation,
    flipH: v.camera.flipHorizontal, flipV: v.camera.flipVertical, scale: v.camera.parallelScale, invert: v.properties.invert, focal: v.camera.focalPoint,
    filter: canvas.style.filter || '', overlay: pane.dataset.kinCellOverlay || null,
    stockText: shown(pane.querySelector('[data-cy=viewport-overlay-top-left]')), displayText: shown(pane.querySelector('.kin-display-text')),
    marks: [...pane.querySelectorAll('.kin-view-marks>span')].map(n => n.textContent),
    lines: [...pane.querySelectorAll('.kin-view-gsps polyline')].map(n => n.getAttribute('points')),
    texts: [...pane.querySelectorAll('.kin-view-gsps text')].map(n => n.textContent) }; }"""


class ViewerDisplaySetPresetsDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self, features=None):
        context = self.browser.new_context(viewport={'width': 1366, 'height': 900})
        page = context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(ORIGIN + "/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        for name in ['hanging-protocol-model.js', 'viewer-image-filter.js', 'viewer-gsps.js']:
            page.route(ORIGIN + "/worklist/hpacs-lite/" + name, self.serve(HPACS / name))
        page.goto(ORIGIN + "/")
        page.add_style_tag(path=str(HPACS / "viewer-ux-theme.css"))
        for name in ["viewer-ux-shortcuts.js", "viewer-features.js", "viewer-features-view.js", "viewer-ux-toolbar.js"]:
            page.add_script_tag(path=str(HPACS / name))
        page.evaluate(SETUP, OWNER)
        settings = {'version': 2, 'bar': ['WindowLevel', 'Pan', 'Zoom'], 'shortcuts': {}, 'features': features} if features is not None else None
        page.evaluate("settings => { synServer.viewerSettings = settings; synMount(); }", settings)
        expect(page.locator('.kin-ux-toolbar-settings [role=status]')).to_have_text('계정 설정 · 다른 PC에서도 적용됩니다.')
        # The module has loaded its files and registered its window.
        page.wait_for_function("KinViewerFeatures.settings().some(s => s.id === 'displaySetPresets')")
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    @staticmethod
    def serve(path):
        return lambda route: route.fulfill(path=str(path), content_type="text/javascript; charset=utf-8")

    def presets(self, page):
        dialog = page.locator('dialog.kin-ux-settings')
        if not dialog.evaluate('n => n.open'):
            page.get_by_role('button', name='Viewer Settings').click()
        dialog.locator('.kin-ux-feature-setting-buttons').get_by_role('button', name='Display Set Presets…').click()
        panel = page.locator('dialog.kin-ux-feature-panel[aria-label="Display Set Presets"]')
        expect(panel).to_be_visible()
        expect(panel.get_by_label('Set 1 Windowing')).to_be_visible()
        return panel

    def state(self, page, cell, settle=150):
        page.wait_for_timeout(settle)
        return page.evaluate(STATE, cell)

    def commands(self, page):
        return page.evaluate("synCommands.calls")

    def test_01_window_has_one_row_per_cell_and_the_nine_choices(self):
        page = self.open({'wlPresets': {'CT': [{'name': 'Mediastinum', 'w': 350, 'l': 50}]}})
        panel = self.presets(page)
        expect(panel.locator('tr').first.locator('th')).to_have_text(COLUMNS)
        expect(panel.locator('tr td:first-child')).to_have_text(['Set 1', 'Set 2'])
        def options(label):
            return panel.get_by_label(label).locator('option').evaluate_all('n => n.map(o => o.textContent)')
        self.assertEqual(['Fit to window', '1:1', '150%', '200%'], options('Set 1 Magnification'))
        self.assertEqual(['Stock', 'Soft tissue', 'Lung', 'Mediastinum (My preset)'], options('Set 1 Windowing'))
        self.assertEqual(['None', 'Sharpen', 'Smooth'], options('Set 2 Filter'))
        self.assertEqual(['Stock', 'Instance number', 'Slice position ↑', 'Slice position ↓', 'Acquisition time'], options('Set 1 Sort'))
        self.assertEqual(['0°', '90°', '180°', '270°'], options('Set 1 Rotate'))
        self.assertEqual(['None', 'Horizontal', 'Vertical'], options('Set 1 Flip'))
        self.assertEqual(['First', 'Middle', 'Last'], options('Set 1 First image'))
        self.assertEqual(['Off', 'On'], options('Set 1 GSPS auto'))
        self.assertEqual(['Full', 'None'], options('Set 1 Overlay'))
        expect(panel.get_by_role('button', name='Apply to This Study')).to_be_enabled()
        # No Hanging Protocol applied: Save says why it cannot be used.
        save = panel.get_by_role('button', name='Save with Hanging Protocol')
        expect(save).to_be_disabled()
        expect(save).to_have_attribute('title', 'No Hanging Protocol is applied to this screen. Apply one in Hanging Protocols first.')
        # Nothing has changed on the cells by opening the window.
        self.assertEqual([], self.commands(page)); self.assertEqual([], page.evaluate('synStacks'))

    def test_02_apply_puts_each_row_on_its_own_cell(self):
        page = self.open()
        panel = self.presets(page)
        panel.get_by_label('Set 1 Magnification').select_option(label='200%')
        panel.get_by_label('Set 1 Windowing').select_option(label='Soft tissue')
        panel.get_by_label('Set 1 Filter').select_option(label='Sharpen')
        panel.get_by_label('Set 1 Sort').select_option(label='Slice position ↓')
        panel.get_by_label('Set 1 Rotate').select_option(label='90°')
        panel.get_by_label('Set 1 Flip').select_option(label='Horizontal')
        panel.get_by_label('Set 1 First image').select_option(label='Last')
        panel.get_by_label('Set 2 Windowing').select_option(label='Lung')
        panel.get_by_label('Set 2 Magnification').select_option(label='1:1')
        panel.get_by_label('Set 2 Sort').select_option(label='Instance number')
        panel.get_by_label('Set 2 First image').select_option(label='Middle')
        panel.get_by_label('Set 2 Overlay').select_option(label='None')
        panel.get_by_role('button', name='Apply to This Study').click()
        expect(panel.get_by_role('status')).to_have_text('Applied to 2 cells.')
        self.assertEqual([['setViewportWindowLevel', {'viewportId': 'left', 'window': 400, 'level': 40}, 'CORNERSTONE'],
                          ['setViewportWindowLevel', {'viewportId': 'right', 'window': 1500, 'level': -600}, 'CORNERSTONE']], self.commands(page))
        left, right = self.state(page, 'left'), self.state(page, 'right')
        # Left: slice position high to low (z 10, 0, -10), the last of them shown; 200%, turned 90° then mirrored, sharpened.
        self.assertEqual(['syn:left:3', 'syn:left:1', 'syn:left:2'], left['ids']); self.assertEqual(2, left['index'])
        self.assertEqual(2, left['zoom']); self.assertEqual(90, left['rotation'])
        self.assertEqual((True, False), (left['flipH'], left['flipV']))
        self.assertEqual('url("#kin-image-filter-sharpen")', left['filter'])
        self.assertEqual(['Filter: Sharpen'], left['marks'])
        self.assertEqual(1, page.locator('#kin-image-filters filter#kin-image-filter-sharpen feConvolveMatrix[kernelMatrix="0 -1 0 -1 5 -1 0 -1 0"]').count())
        # Right: instance number order (1, 2, 3 → stored 3rd, 1st, 2nd), the middle one; 1:1 is one 0.5 mm pixel per CSS pixel.
        self.assertEqual(['syn:right:3', 'syn:right:1', 'syn:right:2'], right['ids']); self.assertEqual(1, right['index'])
        self.assertEqual(50, right['scale']); self.assertEqual('', right['filter'])
        # Overlay None hides the right cell's text only (the viewer's and the display layer's); the left keeps all of it.
        self.assertEqual(('none', 'hidden', 'hidden'), (right['overlay'], right['stockText'], right['displayText']))
        self.assertEqual((None, 'visible', 'visible'), (left['overlay'], left['stockText'], left['displayText']))
        # Opened again, the window shows what each cell has.
        panel.get_by_role('button', name='Close').click()
        panel = self.presets(page)
        expect(panel.get_by_label('Set 1 Windowing')).to_have_value('["Soft tissue",400,40]')
        expect(panel.get_by_label('Set 2 Overlay')).to_have_value('none')
        # A row put back to the defaults: that cell loses the filter, overlay setting and order; the other keeps its own.
        for label, value in [('Set 2 Windowing', 'Stock'), ('Set 2 Magnification', 'Fit to window'), ('Set 2 Sort', 'Stock'),
                             ('Set 2 First image', 'First'), ('Set 2 Overlay', 'Full')]:
            panel.get_by_label(label).select_option(label=value)
        panel.get_by_label('Set 1 Rotate').select_option(label='0°')
        panel.get_by_role('button', name='Apply to This Study').click()
        expect(panel.get_by_role('status')).to_have_text('Applied to 1 cell.')
        left, right = self.state(page, 'left'), self.state(page, 'right')
        self.assertEqual(['syn:right:1', 'syn:right:2', 'syn:right:3'], right['ids']); self.assertEqual('syn:right:1', right['image'], 'the image shown stays')
        self.assertEqual((None, 'visible'), (right['overlay'], right['stockText']))
        self.assertEqual(0, left['rotation']); self.assertEqual('url("#kin-image-filter-sharpen")', left['filter'])

    def test_03_gsps_auto_applies_the_latest_presentation_state_of_the_shown_image(self):
        page = self.open()
        panel = self.presets(page)
        # Stock order, Middle → the left cell shows its second stored image, which the GSPS names.
        panel.get_by_label('Set 1 First image').select_option(label='Middle')
        panel.get_by_label('Set 1 Windowing').select_option(label='Lung')
        panel.get_by_label('Set 1 GSPS auto').select_option(label='On')
        panel.get_by_label('Set 2 GSPS auto').select_option(label='On')
        panel.get_by_role('button', name='Apply to This Study').click()
        # The right cell shows an image no GSPS names: its row applies, and the line says so.
        expect(panel.get_by_role('status')).to_have_text('Applied to 2 cells. Set 2: no GSPS.')
        self.assertEqual(['/dicom-web/studies/1.2.826.0.1.100/series?Modality=PR&limit=101', '/dicom-web/studies/1.2.826.0.1.100/series/1.2.826.0.1.900/metadata'],
                         [r for r in page.evaluate('synRequests') if r.startswith('/dicom-web')], 'read once for the study')
        # The GSPS window wins over the row's Lung (set first, then replaced); its 90° turn is put on the cell. The right row's
        # Stock window is the image's stored one.
        self.assertEqual([['setViewportWindowLevel', {'viewportId': 'left', 'window': 1500, 'level': -600}, 'CORNERSTONE'],
                          ['setViewportWindowLevel', {'viewportId': 'left', 'window': 350, 'level': 50}, 'CORNERSTONE']],
                         [c for c in self.commands(page) if c[1]['viewportId'] == 'left'])
        left = self.state(page, 'left')
        self.assertEqual(('syn:left:2', 90, False), (left['image'], left['rotation'], left['flipH']))
        self.assertEqual(['GSPS: KEYIMAGE'], left['marks'])
        # The polyline from (10.5, 20.5) to (40.5, 20.5) image coordinates: pixel index (10, 20) → world (5, 10) → canvas (155, 110).
        self.assertEqual(['155.0,110.0 170.0,110.0'], left['lines'])
        self.assertEqual(['Nodule 8 mm'], left['texts'])
        # Scrolling to an image the GSPS does not name: its annotations are not drawn there.
        page.evaluate("() => { const v = synViewports.get('left'); v.index = 0; v.element.dispatchEvent(new CustomEvent('syn-new', { detail: { viewportId: 'left', element: v.element } })); }")
        self.assertEqual([], self.state(page, 'left')['lines'])

    def test_04_save_with_hanging_protocol_hands_one_rule_per_applied_cell(self):
        page = self.open()
        page.evaluate("synApplied = { scope: 'personal', ruleId: '11111111-1111-4111-8111-111111111111', name: 'Chest CT', viewportIds: ['left', 'right'] }")
        panel = self.presets(page)
        save = panel.get_by_role('button', name='Save with Hanging Protocol')
        expect(save).to_be_enabled()
        panel.get_by_label('Set 2 Windowing').select_option(label='Lung')
        panel.get_by_label('Set 2 Filter').select_option(label='Smooth')
        save.click()
        expect(panel.get_by_role('status')).to_have_text('Saved with Hanging Protocol "Chest CT" in this browser and your account.')
        lung = {'magnification': 'fit', 'windowing': {'name': 'Lung', 'w': 1500, 'l': -600}, 'filter': 'smooth', 'sort': 'stock', 'rotate': 0,
                'flip': 'none', 'firstImage': 'first', 'gspsAuto': False, 'overlay': 'full'}
        default = dict(lung, windowing=None, filter='none')
        self.assertEqual([[default, lung]], page.evaluate('synSaved'))
        # Save does not change the cells.
        self.assertEqual([], self.commands(page)); self.assertEqual('', self.state(page, 'right')['filter'])
        panel.get_by_role('button', name='Close').click()
        # A Site rule, or a screen that no longer shows the applied layout: Save says why.
        page.evaluate("synApplied.scope = 'site'")
        panel = self.presets(page)
        expect(panel.get_by_role('button', name='Save with Hanging Protocol')).to_have_attribute('title', 'The applied Hanging Protocol is an institution (Site) rule. Only your own rules can be changed here.')
        panel.get_by_role('button', name='Close').click()
        page.evaluate("synApplied = { scope: 'personal', ruleId: '11111111-1111-4111-8111-111111111111', name: 'Chest CT', viewportIds: ['right', 'left'] }")
        panel = self.presets(page)
        expect(panel.get_by_role('button', name='Save with Hanging Protocol')).to_be_disabled()

    def test_05_an_applied_hanging_protocol_puts_its_rules_on_its_cells(self):
        page = self.open()
        soft = {'magnification': '150', 'windowing': {'name': 'Soft tissue', 'w': 400, 'l': 40}, 'filter': 'none', 'sort': 'stock', 'rotate': 180,
                'flip': 'vertical', 'firstImage': 'last', 'gspsAuto': False, 'overlay': 'full'}
        lung = dict(soft, windowing={'name': 'Lung', 'w': 1500, 'l': -600}, magnification='fit', rotate=0, flip='none', firstImage='first', overlay='none')
        page.evaluate("d => dispatchEvent(new CustomEvent('kin-hanging-protocol-applied', { detail: { scope: 'personal', ruleId: 'x', name: 'Chest CT', viewportIds: ['left', 'right'], display: d } }))",
                      [soft, lung])
        page.wait_for_function("synCommands.calls.length === 2")
        self.assertEqual([['setViewportWindowLevel', {'viewportId': 'left', 'window': 400, 'level': 40}, 'CORNERSTONE'],
                          ['setViewportWindowLevel', {'viewportId': 'right', 'window': 1500, 'level': -600}, 'CORNERSTONE']], self.commands(page))
        left, right = self.state(page, 'left'), self.state(page, 'right')
        self.assertEqual((1.5, 180, False, True, 2), (left['zoom'], left['rotation'], left['flipH'], left['flipV'], left['index']))
        self.assertEqual('none', right['overlay']); self.assertEqual('visible', left['stockText'])
        # A rule list of nulls (no rule) changes nothing; a malformed entry is ignored.
        page.evaluate("dispatchEvent(new CustomEvent('kin-hanging-protocol-applied', { detail: { viewportIds: ['left', 'right'], display: [null, { overlay: 'none' }] } }))")
        page.wait_for_timeout(300)
        self.assertEqual(2, len(self.commands(page)))
        # Another layout in the right cell: this module's marks there go.
        page.evaluate("() => { synShown.right = ['syn-set-9']; synEmit('grid', 'gridState', { viewports: [{ viewportId: 'right' }] }); }")
        self.assertIsNone(self.state(page, 'right', settle=300)['overlay'])

    def scroll(self, page, cell, index):
        page.evaluate("([id, i]) => { const v = synViewports.get(id); v.index = i; v.element.dispatchEvent(new CustomEvent('syn-new', { detail: { viewportId: id, element: v.element } })); }", [cell, index])

    def test_06_a_cell_given_other_images_while_the_pass_runs_keeps_them_as_they_are(self):
        page = self.open()
        page.evaluate("() => { window.synHoldGsps = new Promise(r => { window.synReleaseGsps = r; }); }")
        panel = self.presets(page)
        panel.get_by_label('Set 1 GSPS auto').select_option(label='On')
        panel.get_by_label('Set 2 Windowing').select_option(label='Lung')
        panel.get_by_label('Set 2 Sort').select_option(label='Instance number')
        panel.get_by_role('button', name='Apply to This Study').click()
        page.wait_for_function("synRequests.some(r => r.endsWith('/metadata'))")
        # While the left cell's GSPS is read, the right cell is given another series.
        page.evaluate("() => { synShown.right = ['syn-set-9']; synEmit('grid', 'gridState', { viewports: [{ viewportId: 'right' }] }); synReleaseGsps(); }")
        expect(panel.get_by_role('status')).to_contain_text('Set 2: its images changed, not applied')
        self.assertEqual([], [c for c in self.commands(page) if c[1]['viewportId'] == 'right'])
        self.assertEqual([], [s for s in page.evaluate('synStacks') if s[0] == 'right'])

    def test_07_gsps_follows_the_image_shown(self):
        page = self.open()
        page.evaluate("() => { window.synHoldGsps = new Promise(r => { window.synReleaseGsps = r; }); }")
        panel = self.presets(page)
        panel.get_by_label('Set 1 Windowing').select_option(label='Lung')
        panel.get_by_label('Set 1 GSPS auto').select_option(label='On')
        panel.get_by_role('button', name='Apply to This Study').click()
        page.wait_for_function("synRequests.some(r => r.endsWith('/metadata'))")
        # The reader scrolls to the second image (the one the GSPS names) while it is read: the GSPS of the image now
        # shown is put on, not the first image's (it has none).
        self.scroll(page, 'left', 1)
        page.evaluate("synReleaseGsps()")
        expect(panel.get_by_role('status')).to_have_text('Applied to 1 cell.')
        left = self.state(page, 'left')
        self.assertEqual(('syn:left:2', 90, ['GSPS: KEYIMAGE']), (left['image'], left['rotation'], left['marks']))
        self.assertEqual({'viewportId': 'left', 'window': 350, 'level': 50}, self.commands(page)[-1][1])
        # To an image it does not name: the row's own values come back (Lung, no turn), and no annotation.
        self.scroll(page, 'left', 2)
        left = self.state(page, 'left', settle=300)
        self.assertEqual((0, [], []), (left['rotation'], left['marks'], left['lines']))
        self.assertEqual({'viewportId': 'left', 'window': 1500, 'level': -600}, self.commands(page)[-1][1])
        # And back again.
        self.scroll(page, 'left', 1)
        left = self.state(page, 'left', settle=300)
        self.assertEqual((90, ['GSPS: KEYIMAGE'], 1), (left['rotation'], left['marks'], len(left['lines'])))
        self.assertEqual({'viewportId': 'left', 'window': 350, 'level': 50}, self.commands(page)[-1][1])

    def test_08_stock_windowing_in_a_changed_row_puts_the_stored_window_back(self):
        page = self.open()
        panel = self.presets(page)
        panel.get_by_label('Set 1 Windowing').select_option(label='Lung')
        panel.get_by_label('Set 1 Filter').select_option(label='Smooth')
        panel.get_by_role('button', name='Apply to This Study').click()
        expect(panel.get_by_role('status')).to_have_text('Applied to 1 cell.')
        panel.get_by_label('Set 1 Windowing').select_option(label='Stock')
        panel.get_by_role('button', name='Apply to This Study').click()
        page.wait_for_function("synCommands.calls.length === 2")
        self.assertEqual([{'viewportId': 'left', 'window': 1500, 'level': -600}, {'viewportId': 'left', 'window': 1000, 'level': -500}],
                         [c[1] for c in self.commands(page)])
        self.assertEqual('url("#kin-image-filter-smooth")', self.state(page, 'left')['filter'])

if __name__ == '__main__':
    unittest.main()
