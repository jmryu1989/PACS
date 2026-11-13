# coding: utf-8
"""Display menu on the shipped image toolbar: Overlay Items, Corner Information, Auto Rotate 180°, Zoom, Smart Zoom,
My W/L Presets and VOI LUT, with their account values.

The shipped viewer-features.js, viewer-features-display.js, viewer-display-model.js, viewer-ux-shortcuts.js,
viewer-ux-toolbar.js (with viewer-ux-theme.css) and config/ohif/planar-geometry.js run in Chromium beside synthetic
OHIF services, two synthetic stack cells with OHIF's corner text, a synthetic image metadata provider, a synthetic stored
VOI source and an in-page account settings endpoint that keeps the revision contract of /api/workspace-shortcuts.
Real pixels, the stored VOI LUT table and the viewer's own corner text are checked on the real viewer in
tests/e2e/test_viewer_display_menu.py.
"""
from pathlib import Path
import json
import unittest

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
ORIGIN = "https://viewer-display.test"
OWNER = ['syn-site', 'syn-reader']
MENU = ['Overlay Items…', 'Corner Information…', 'Auto Rotate 180°', 'Zoom…', 'Smart Zoom', 'My W/L Presets…', 'VOI LUT']

HARNESS = """<!doctype html><html><head><style>
body { margin: 0; background: #111; color: #eee; --kin-panel: #222; --kin-ux-text: #eee; --kin-ux-secondary: #999; --kin-accent: #6cf; }
#grid { position: absolute; left: 0; top: 80px; display: flex; gap: 4px; }
[data-cy=viewport-pane] { position: relative; width: 300px; height: 200px; overflow: hidden; }
.viewport-element { position: absolute; inset: 0; }
[data-cy^=viewport-overlay-] { position: absolute; font: 12px sans-serif; }
</style></head><body><div id="root"><div class="kin-ux-toolbar-slot"></div><div id="grid"></div></div></body></html>"""

# Synthetic services, two stack cells (left: CT in the standard orientation; right: CR stored upside-down with a stored
# VOI LUT table), the image metadata, a stored VOI source, an account endpoint and a session. Nothing is mounted yet.
SETUP = """owner => {
  window.synNotes = []; window.synEnded = false; window.synWriter = true; window.synActive = 'left';
  window.synShown = { left: ['syn-set-1'], right: ['syn-set-2'] };
  window.synMeta = {
    'syn:left:1': { Modality: 'CT', SOPInstanceUID: '1.2.826.0.1.1', StudyDate: '20260801', SeriesDescription: 'SYN CT', SeriesNumber: 1,
      InstanceNumber: 1, SliceThickness: 2.5, PixelSpacing: [1, 1], Rows: 256, Columns: 256, ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
      ImagePositionPatient: [0, 0, 0], PatientName: { Alphabetic: 'SYN^ONE' }, PatientID: 'SYN-1', Manufacturer: 'SYNTHETIC',
      StudyInstanceUID: '1.2.826.0.1.100', SeriesInstanceUID: '1.2.826.0.1.101' },
    'syn:right:1': { Modality: 'CR', SOPInstanceUID: '1.2.826.0.1.2', StudyDate: '20260801', SeriesDescription: 'SYN CR', SeriesNumber: 2,
      InstanceNumber: 1, ImagerPixelSpacing: [0.5, 0.5], Rows: 512, Columns: 512, ImageOrientationPatient: [-1, 0, 0, 0, -1, 0],
      ImagePositionPatient: [0, 0, 0], PatientName: { Alphabetic: 'SYN^ONE' }, PatientID: 'SYN-1' },
  };
  const EVENTS = { PRE_STACK_NEW_IMAGE: 'syn-pre', STACK_NEW_IMAGE: 'syn-new', VIEWPORT_NEW_IMAGE_SET: 'syn-set', CAMERA_MODIFIED: 'syn-camera',
    VOI_MODIFIED: 'syn-voi', IMAGE_RENDERED: 'syn-rendered', CAMERA_RESET: 'syn-reset' };
  window.cornerstone = { Enums: { Events: EVENTS }, metaData: { get: (type, id) => type === 'instance' ? synMeta[id] : undefined } };
  // Events as Cornerstone sends them: on the cell element, not bubbling.
  const fire = (v, name, detail = {}) => v.element.dispatchEvent(new CustomEvent(EVENTS[name], { detail: { viewportId: v.id, element: v.element, ...detail } }));
  window.synFire = (id, name, detail) => fire(synViewports.get(id), name, detail);
  window.synViewports = new Map();
  for (const [id, spacing, range] of [['left', 1, { lower: -1000, upper: -1 }], ['right', 0.5, { lower: 0, upper: 4095 }]]) {
    const pane = document.createElement('div'); pane.dataset.cy = 'viewport-pane'; pane.id = 'pane-' + id;
    pane.innerHTML = '<div class="viewport-element"></div>'
      + '<div data-cy="viewport-overlay-top-left" style="left:4px;top:4px"><div>20260801</div><div>SYN</div></div>'
      + '<div data-cy="viewport-overlay-top-right" style="right:4px;top:4px"></div>'
      + '<div data-cy="viewport-overlay-bottom-left" style="left:4px;bottom:4px"><div class="syn-wl">W: 1000 L: -500</div><div class="syn-zoom">Zoom: 1.00x</div></div>'
      + '<div data-cy="viewport-overlay-bottom-right" style="right:4px;bottom:4px"><div>I: 1 (1/1)</div></div>';
    document.getElementById('grid').append(pane);
    const element = pane.querySelector('.viewport-element');
    const v = { id, type: 'stack', element, image: 'syn:' + id + ':1', renders: 0, presentation: { rotation: 0 }, properties: { voiRange: { ...range }, VOILUTFunction: 'LINEAR' },
      camera: { focalPoint: [0, 0, 0], position: [0, 0, 100], parallelScale: 100, viewUp: [0, -1, 0] }, spacing };
    // World units per CSS pixel: the parallel scale is half the cell height in world units.
    const per = () => v.camera.parallelScale / (element.clientHeight / 2);
    Object.assign(v, {
      getCurrentImageId: () => v.image, getCurrentImageIdIndex: () => 0, getImageIds: () => [v.image],
      getZoom: () => 100 / v.camera.parallelScale,
      setZoom(zoom) { v.camera = { ...v.camera, parallelScale: 100 / zoom }; fire(v, 'CAMERA_MODIFIED'); },
      setPan(pan) { v.camera = { ...v.camera, focalPoint: [0, 0, 0], position: [0, 0, 100] }; fire(v, 'CAMERA_MODIFIED'); },
      getCamera: () => structuredClone(v.camera),
      setCamera(next) { v.camera = { ...v.camera, ...structuredClone(next) }; fire(v, 'CAMERA_MODIFIED'); },
      getViewPresentation: () => ({ ...v.presentation, zoom: v.getZoom() }),
      setViewPresentation(next) { v.presentation = { rotation: next.rotation }; fire(v, 'CAMERA_MODIFIED'); },
      getProperties: () => structuredClone(v.properties),
      setProperties(next) { v.properties = { ...v.properties, ...structuredClone(next) }; if (next.voiRange) fire(v, 'VOI_MODIFIED', { range: next.voiRange }); },
      setVOI(range) { v.properties = { ...v.properties, voiRange: { ...range } }; fire(v, 'VOI_MODIFIED', { range }); },
      render() { v.renders++; },
      canvasToWorld: ([x, y]) => [v.camera.focalPoint[0] + (x - element.clientWidth / 2) * per(), v.camera.focalPoint[1] + (y - element.clientHeight / 2) * per(), 0],
      worldToCanvas: ([x, y]) => [(x - v.camera.focalPoint[0]) / per() + element.clientWidth / 2, (y - v.camera.focalPoint[1]) / per() + element.clientHeight / 2],
      getImageData: () => ({ spacing: [spacing, spacing, 1], imageData: { getPointData: () => ({ getScalars: () => ({ getRange: () => [0, 4095] }) }) } }),
    });
    synViewports.set(id, v);
  }
  // The stored VOI of the right image: a table, and its header window when the table is not preferred.
  window.synVoiCalls = [];
  window.kinStoredVoi = {
    spec(sop, frame, options = {}) {
      if (sop !== '1.2.826.0.1.2' || frame !== 1) return null;
      return options.preferTable ? { voi: { status: 'verified', fn: 'TABLE', source: 'VOI LUT Sequence', lut: { first: 0, bits: 8, data: [0, 255] }, center: 2048, width: 4096 }, invert: false }
        : { voi: { status: 'verified', fn: 'LINEAR', source: 'Window Center/Width', lut: null, center: 1500, width: 1000 }, invert: false };
    },
    apply(v, spec) {
      synVoiCalls.push([v.id, spec.voi.fn, spec.voi.fn === 'TABLE' ? null : [spec.voi.center, spec.voi.width]]);
      // As the viewer's stored VOI does: a window is drawn with its own VOI LUT Function.
      if (spec.voi.fn !== 'TABLE') v.setProperties({ VOILUTFunction: spec.voi.fn });
      if (spec.voi.fn !== 'TABLE') v.setVOI({ lower: spec.voi.center - 0.5 - (spec.voi.width - 1) / 2, upper: spec.voi.center - 0.5 + (spec.voi.width - 1) / 2 });
      return true;
    },
  };
  const listeners = new Map();
  const events = name => ({ subscribe(event, fn) { const key = name + event; listeners.set(key, [...(listeners.get(key) || []), fn]);
    return { unsubscribe() { listeners.set(key, (listeners.get(key) || []).filter(f => f !== fn)); } }; } });
  window.synEmit = (name, event, payload) => { for (const fn of listeners.get(name + event) || []) fn(payload); };
  const grid = { ...events('grid'), EVENTS: { ACTIVE_VIEWPORT_ID_CHANGED: 'active', GRID_STATE_CHANGED: 'gridState' },
    getActiveViewportId: () => synActive, setActiveViewportId: id => { synActive = id; },
    getState: () => ({ activeViewportId: synActive, viewports: new Map(Object.entries(synShown).map(([id, sets]) => [id, { viewportId: id, displaySetInstanceUIDs: sets }])) }) };
  const buttons = Object.fromEntries(['WindowLevel', 'Pan', 'Zoom', 'StackScroll', 'Length'].map(id => [id, { id, uiType: 'ohif.radioGroup', props: { label: id, commands: 'setToolActiveToolbar' } }]));
  window.synServices = {
    viewportGridService: grid,
    cornerstoneViewportService: { ...events('cells'), EVENTS: { VIEWPORT_DATA_CHANGED: 'data' }, getCornerstoneViewport: id => synViewports.get(id) },
    uiNotificationService: { show: note => synNotes.push(note) },
    toolbarService: { EVENTS: { TOOL_BAR_MODIFIED: 'modified' }, getButtonSection: () => Object.keys(buttons).map(id => ({ id })), getButtons: () => buttons,
      getButtonProps: id => buttons[id] && { id, ...buttons[id].props }, recordInteraction() {}, subscribe: () => ({ unsubscribe() {} }) },
  };
  window.synCommands = { runCommand() {} };
  window.kinViewerHistoryWorkspaceState = () => ({ busy: false });
  window.kinViewerJobWorkspaceState = () => ({ busy: false });
  window.KinViewerHangingSettings = { modalities: [], defaults: {}, get: () => ({}), mount: () => ({ apply() {}, dispose() {} }), mountSizing: () => ({ dispose() {} }) };
  window.KinSessionTransport = { refusal: () => false, responseError: () => new Error('ended') };
  window.synServer = { revision: 3, viewerSettings: null, puts: [], hold: null };
  // The image's DICOM JSON, as DICOMweb answers /studies/…/instances/…/metadata.
  window.synRaw = { '1.2.826.0.1.1': { '00101030': { vr: 'DS', Value: [70] }, '00080060': { vr: 'CS', Value: ['CT'] } } };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, init = {}) => {
    const s = synServer;
    const sop = String(url).includes('/dicom-web/studies/') && String(url).endsWith('/metadata') ? String(url).split('/').at(-2) : null;
    if (sop) return synRaw[sop] ? reply(200, [synRaw[sop]]) : reply(404, {});
    if (!String(url).endsWith('/api/workspace-shortcuts')) return reply(404, {});
    if ((init.method || 'GET') === 'GET') return reply(200, { owner, revision: s.revision, viewerSettings: structuredClone(s.viewerSettings) });
    const body = JSON.parse(init.body); s.puts.push(body);
    if (s.hold) await s.hold;
    if (body.revision !== s.revision) return reply(409, { message: '계정 설정이 변경되었습니다. 불러온 뒤 다시 저장하세요' });
    s.revision++; s.viewerSettings = body.viewerSettings;
    return reply(200, { owner, revision: s.revision, viewerSettings: structuredClone(s.viewerSettings) });
  };
  window.synSession = { owner: () => owner, ended: () => synEnded, writer: () => synWriter, state: () => 'confirmed', decide: async () => {} };
  window.synMount = () => {
    window.synToolbar = KinViewerUXToolbar.mount({ services: synServices, commands: synCommands, session: synSession });
    window.synKeys = KinViewerUXShortcuts.mount({ getBindings: () => synToolbar.bindings(), invoke: id => synToolbar.invoke(id), allowed: () => !synEnded });
  };
}"""


class ViewerDisplayDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self, features=None, writer=True):
        context = self.browser.new_context(viewport={'width': 1366, 'height': 900})
        page = context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(ORIGIN + "/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.route(ORIGIN + "/worklist/hpacs-lite/viewer-display-model.js",
                   lambda route: route.fulfill(path=str(HPACS / "viewer-display-model.js"), content_type="text/javascript; charset=utf-8"))
        page.goto(ORIGIN + "/")
        page.add_style_tag(path=str(HPACS / "viewer-ux-theme.css"))
        page.add_script_tag(path=str(ROOT / "config" / "ohif" / "planar-geometry.js"))
        for name in ["viewer-ux-shortcuts.js", "viewer-features.js", "viewer-features-display.js", "viewer-ux-toolbar.js"]:
            page.add_script_tag(path=str(HPACS / name))
        page.evaluate(SETUP, OWNER)
        settings = {'version': 2, 'bar': ['WindowLevel', 'Pan', 'Zoom'], 'shortcuts': {}, 'features': features} if features is not None else None
        page.evaluate("([settings, writer]) => { synServer.viewerSettings = settings; synWriter = writer; synMount(); }", [settings, writer])
        if writer:
            expect(page.locator('.kin-ux-toolbar-settings [role=status]')).to_have_text('계정 설정 · 다른 PC에서도 적용됩니다.')
        expect(page.get_by_role('button', name='Display ▾')).to_be_visible()
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    def menu(self, page, item, cell='left'):
        page.evaluate("id => { synActive = id; }", cell)
        page.get_by_role('button', name='Display ▾').click()
        page.get_by_role('menu', name='Display').get_by_role('menuitem', name=item, exact=True).click()

    def window(self, page, title):
        panel = page.locator('section.kin-ux-feature-panel[role=dialog][aria-label="%s"]' % title)
        expect(panel).to_be_visible()
        return panel

    def features(self, page):
        return page.evaluate("synServer.viewerSettings?.features || {}")

    def visibility(self, page, cell, selector, settle=150):
        # The module draws on the next animation frame.
        page.wait_for_timeout(settle)
        return page.evaluate("([cell, s]) => [...document.querySelectorAll('#pane-' + cell + ' ' + s)].map(n => getComputedStyle(n).display === 'none' ? 'none' : getComputedStyle(n).visibility)",
                             [cell, selector])

    def layer_text(self, page, cell, selector):
        return page.evaluate("([cell, s]) => [...document.querySelectorAll('#pane-' + cell + ' .kin-ux-cell-layer ' + s)].map(n => n.textContent)", [cell, selector])

    # ── Menu, Viewer Settings entries ──
    def test_01_display_menu_and_viewer_settings_entries(self):
        page = self.open()
        page.get_by_role('button', name='Display ▾').click()
        expect(page.get_by_role('menu', name='Display').get_by_role('menuitem')).to_have_text(MENU)
        page.keyboard.press('Escape')
        page.get_by_role('button', name='Viewer Settings').click()
        dialog = page.locator('dialog.kin-ux-settings')
        self.assertEqual(['Auto Rotate 180° from Image Orientation Patient', 'Use VOI LUT for standard 2D images'],
                         dialog.locator('.kin-ux-feature-settings input[type=checkbox]').evaluate_all('n => n.map(i => i.getAttribute("aria-label"))'))
        expect(dialog.get_by_role('checkbox', name='Auto Rotate 180° from Image Orientation Patient')).not_to_be_checked()
        expect(dialog.get_by_role('checkbox', name='Use VOI LUT for standard 2D images')).to_be_checked()
        expect(dialog.locator('.kin-ux-feature-setting-buttons button')).to_have_text(['Overlay Items…', 'Corner Information…', 'My W/L Presets…'])
        # A window opened from Viewer Settings opens above it.
        dialog.get_by_role('button', name='My W/L Presets…').click()
        expect(page.locator('dialog.kin-ux-feature-panel[aria-label="My W/L Presets"]')).to_be_visible()
        # No Smart Zoom check: the Zoom tool already zooms around the pointer.
        expect(dialog.get_by_role('checkbox', name='Smart Zoom (zoom around the mouse)')).to_have_count(0)

    # ── 03-1 Overlay Items ──
    def test_02_overlay_items_each_on_its_own_and_saved(self):
        page = self.open()
        # Defaults: OHIF's W/L line stays, its Zoom line gives way to this module's line, which shows the fitted size as 100%.
        self.assertEqual(['visible'], self.visibility(page, 'left', '.syn-wl'))
        self.assertEqual(['none'], self.visibility(page, 'left', '.syn-zoom'))
        expect(page.locator('#pane-left .kin-display-zoom')).to_have_text('Zoom 100%')
        self.menu(page, 'Overlay Items…')
        panel = self.window(page, 'Overlay Items')
        self.assertEqual(['W/L Value', 'Zoom', 'Ruler', 'DICOM Information', 'Cell Border'],
                         panel.locator('input[type=checkbox]').evaluate_all('n => n.map(i => i.getAttribute("aria-label"))'))
        expect(panel.get_by_label('Border Colour')).to_be_visible(); expect(panel.get_by_label('Border Width')).to_be_visible()
        panel.get_by_role('checkbox', name='W/L Value').uncheck()
        self.assertEqual(['none'], self.visibility(page, 'left', '.syn-wl'))
        self.assertEqual(['none'], self.visibility(page, 'right', '.syn-wl'))
        page.wait_for_function("synServer.viewerSettings?.features?.overlayItems?.wl === false")
        # Ruler: 5 cm in the image's own scale (1 mm pixels, 1 screen pixel per mm at 100%), longer when zoomed.
        panel.get_by_role('checkbox', name='Ruler').check()
        expect(page.locator('#pane-left .kin-display-ruler')).to_have_text('5 cm')
        self.assertEqual('50px', page.locator('#pane-left .kin-display-ruler').evaluate('n => n.style.height'))
        # The CR has only Imager Pixel Spacing: its ruler says so.
        expect(page.locator('#pane-right .kin-display-ruler')).to_have_text('5 cm at detector')
        page.evaluate("synViewports.get('left').setZoom(2)")
        expect(page.locator('#pane-left .kin-display-ruler')).to_have_attribute('style', 'height: 100px;')
        expect(page.locator('#pane-left .kin-display-zoom')).to_have_text('Zoom 200%')
        panel.get_by_role('checkbox', name='Zoom').uncheck()
        expect(page.locator('#pane-left .kin-display-zoom')).to_have_count(0)
        self.assertEqual(['none'], self.visibility(page, 'left', '.syn-zoom'), 'the stock zoom line does not come back')
        panel.get_by_role('checkbox', name='Cell Border').check()
        panel.get_by_label('Border Width').select_option('3')
        expect(page.locator('#pane-left .kin-display-border')).to_have_css('border-top-width', '3px')
        panel.get_by_role('checkbox', name='DICOM Information').uncheck()
        self.assertEqual(['hidden'], self.visibility(page, 'left', '[data-cy="viewport-overlay-top-left"]'))
        self.assertEqual(['hidden'], self.visibility(page, 'left', '[data-cy="viewport-overlay-bottom-right"]'))
        panel.get_by_role('checkbox', name='DICOM Information').check()
        panel.get_by_role('checkbox', name='Ruler').focus(); page.keyboard.press('Escape')
        expect(panel).to_have_count(0)
        expect(page.locator('#pane-left .kin-display-ruler')).to_be_visible()
        page.wait_for_function("synServer.viewerSettings?.features?.overlayItems?.width === 3 && synServer.viewerSettings.features.overlayItems.dicom === true")
        self.assertEqual({'wl': False, 'zoom': False, 'ruler': True, 'dicom': True, 'border': True, 'colour': '#E8C547', 'width': 3},
                         self.features(page)['overlayItems'])
        # Image Text hides this module's text with OHIF's; showing it again brings back each chosen item.
        page.evaluate("document.getElementById('pane-left').setAttribute('data-kin-image-text-hidden', 'kit-1')")
        self.assertEqual(['hidden'], self.visibility(page, 'left', '.kin-display-text'))
        page.evaluate("document.getElementById('pane-left').removeAttribute('data-kin-image-text-hidden')")
        self.assertEqual(['visible'], self.visibility(page, 'left', '.kin-display-text'))
        self.assertEqual(['none'], self.visibility(page, 'left', '.syn-wl'))
        expect(page.locator('#pane-left .kin-display-ruler')).to_be_visible()
        # Imager Pixel Spacing corrected by a stored magnification factor is an estimate at the patient, not the detector.
        page.evaluate("synMeta['syn:right:1'].EstimatedRadiographicMagnificationFactor = 2; synViewports.get('right').setZoom(1)")
        expect(page.locator('#pane-right .kin-display-ruler')).to_have_text('5 cm (ERMF estimate)')
        self.assertEqual('100px', page.locator('#pane-right .kin-display-ruler').evaluate('n => n.style.height'))

    def test_03_saved_overlay_items_apply_on_open(self):
        page = self.open({'overlayItems': {'wl': False, 'zoom': True, 'ruler': False, 'dicom': True, 'border': True, 'colour': '#00FF00', 'width': 4}})
        expect(page.locator('#pane-left .kin-display-border')).to_have_css('border-top-color', 'rgb(0, 255, 0)')
        self.assertEqual(['none'], self.visibility(page, 'left', '.syn-wl'))

    # ── 03-2 Corner Information ──
    def test_04_corner_information_per_modality_other_tag_and_restore(self):
        page = self.open()
        self.menu(page, 'Corner Information…')
        panel = self.window(page, 'Corner Information')
        expect(panel.get_by_label('Modality')).to_have_value('CT')
        for corner in ['Top Left', 'Top Right', 'Bottom Left', 'Bottom Right']:
            for line in (1, 2, 3):
                expect(panel.get_by_label('%s line %d' % (corner, line))).to_be_visible()
        expect(panel.get_by_role('button', name='Apply to Image')).to_be_visible()
        expect(panel.get_by_role('button', name='Restore Stock Overlay')).to_be_visible()
        panel.get_by_label('Top Right line 1').select_option(label='Slice Thickness')
        expect(panel.get_by_label('Top Right line 1')).to_have_value('SliceThickness')
        # Other Tag: a tag number or a keyword goes into the line last chosen.
        panel.get_by_label('Bottom Right line 2').focus()
        panel.get_by_label('Other Tag').fill('Slice Thickness!')
        panel.get_by_role('button', name='Use in Selected Line').click()
        expect(panel.get_by_role('status')).to_contain_text('Enter a DICOM keyword')
        panel.get_by_label('Other Tag').fill('0010,1030')
        panel.get_by_label('Bottom Right line 2').focus()
        panel.get_by_role('button', name='Use in Selected Line').click()
        expect(panel.get_by_label('Bottom Right line 2')).to_have_value('(0010,1030)')
        # Nothing changes on the image before Apply.
        expect(page.locator('#pane-left .kin-display-corner')).to_have_count(0)
        panel.get_by_role('button', name='Apply to Image').click()
        expect(panel.get_by_role('status')).to_have_text('Saved to your account.')
        saved = self.features(page)['cornerInfo']['CT']
        self.assertEqual(['SliceThickness', '', ''], saved['TR'])
        self.assertEqual(['InstanceNumber', '(0010,1030)', ''], saved['BR'])
        self.assertEqual(['StudyDate', 'SeriesDescription', ''], saved['TL'])
        expect(page.locator('#pane-left .kin-display-corner[data-corner=TR]')).to_have_text('SliceThickness: 2.5 mm')
        expect(page.locator('#pane-left .kin-display-corner[data-corner=BR]')).to_have_text('InstanceNumber: 1\n(0010,1030): 70')
        expect(page.locator('#pane-left .kin-display-corner[data-corner=TL]')).to_have_text('StudyDate: 20260801\nSeriesDescription: SYN CT')
        self.assertEqual(['hidden'], self.visibility(page, 'left', '[data-cy="viewport-overlay-top-left"]'))
        # The CR cell is another modality: its usual text stays.
        expect(page.locator('#pane-right .kin-display-corner')).to_have_count(0)
        self.assertEqual(['visible'], self.visibility(page, 'right', '[data-cy="viewport-overlay-top-left"]'))
        # W/L and Zoom stay under their own checks.
        self.assertEqual(['visible'], self.visibility(page, 'left', '.syn-wl'))
        expect(page.locator('#pane-left .kin-display-zoom')).to_have_text('Zoom 100%')
        page.keyboard.press('Escape'); expect(panel).to_have_count(0)
        # DICOM Information hides the chosen items as well, not W/L.
        self.menu(page, 'Overlay Items…')
        overlay = self.window(page, 'Overlay Items')
        overlay.get_by_role('checkbox', name='DICOM Information').uncheck()
        self.assertEqual(['hidden'] * 3, self.visibility(page, 'left', '.kin-display-corner'))
        self.assertEqual(['visible'], self.visibility(page, 'left', '.syn-wl'))
        overlay.get_by_role('checkbox', name='DICOM Information').check()
        overlay.get_by_role('button', name='Close').click()
        self.menu(page, 'Corner Information…')
        panel = self.window(page, 'Corner Information')
        expect(panel.get_by_label('Top Right line 1')).to_have_value('SliceThickness')
        panel.get_by_role('button', name='Restore Stock Overlay').click()
        expect(panel.get_by_role('status')).to_have_text('Saved to your account.')
        expect(page.locator('#pane-left .kin-display-corner')).to_have_count(0)
        self.assertEqual(['visible'], self.visibility(page, 'left', '[data-cy="viewport-overlay-top-left"]'))
        self.assertNotIn('CT', self.features(page).get('cornerInfo') or {})
        expect(panel.get_by_label('Top Right line 1')).to_have_value('')

    def test_05_saved_corner_information_applies_on_open(self):
        page = self.open({'cornerInfo': {'CR': {'TL': ['PatientName', 'PatientID', ''], 'TR': ['', '', ''], 'BL': ['Modality', '', ''], 'BR': ['', '', '']}}})
        expect(page.locator('#pane-right .kin-display-corner[data-corner=TL]')).to_have_text('PatientName: SYN^ONE\nPatientID: SYN-1')
        expect(page.locator('#pane-right .kin-display-corner[data-corner=BL]')).to_have_text('Modality: CR')
        expect(page.locator('#pane-left .kin-display-corner')).to_have_count(0)

    # ── 03-5 Zoom, 03-6 Smart Zoom ──
    def test_06_zoom_buttons_typed_zoom_fit_and_smart_zoom(self):
        page = self.open()
        self.menu(page, 'Zoom…')
        panel = self.window(page, 'Zoom')
        expect(panel.locator('.kin-display-row').first.get_by_role('button')).to_have_text(['50%', '75%', '100%', '150%', '200%', '300%', '400%', 'Fit'])
        expect(panel.get_by_text('Current 100%')).to_be_visible()
        panel.get_by_role('button', name='200%').click()
        self.assertEqual(2, page.evaluate("synViewports.get('left').getZoom()"))
        expect(page.locator('#pane-left .kin-display-zoom')).to_have_text('Zoom 200%')
        expect(panel.get_by_text('Current 200%')).to_be_visible()
        self.assertEqual(1, page.evaluate("synViewports.get('right').getZoom()"))
        panel.get_by_label('Zoom percent').fill('150'); panel.get_by_role('button', name='Apply').click()
        self.assertEqual(1.5, page.evaluate("synViewports.get('left').getZoom()"))
        panel.get_by_label('Zoom percent').fill('5'); panel.get_by_role('button', name='Apply').click()
        expect(panel.get_by_role('status')).to_have_text('Enter a zoom from 10% to 1600%.')
        self.assertEqual(1.5, page.evaluate("synViewports.get('left').getZoom()"))
        page.evaluate("synViewports.get('left').setCamera({ focalPoint: [20, 10, 0], position: [20, 10, 100] })")
        panel.get_by_role('button', name='Fit').click()
        self.assertEqual({'zoom': 1, 'focal': [0, 0, 0]}, page.evaluate("({ zoom: synViewports.get('left').getZoom(), focal: synViewports.get('left').getCamera().focalPoint })"))
        page.keyboard.press('Escape'); expect(panel).to_have_count(0)
        # Smart Zoom: the clicked point stays under the pointer and the image is twice as large; Escape ends the clicks.
        self.menu(page, 'Smart Zoom')
        panel = self.window(page, 'Smart Zoom')
        expect(panel).to_contain_text('Click a point in the cell')
        box = page.locator('#pane-left').bounding_box()
        x, y = box['x'] + 220, box['y'] + 60
        before = page.evaluate("p => synViewports.get('left').canvasToWorld(p)", [220, 60])
        page.mouse.click(x, y)
        self.assertEqual(2, page.evaluate("synViewports.get('left').getZoom()"))
        after = page.evaluate("p => synViewports.get('left').canvasToWorld(p)", [220, 60])
        for a, b in zip(before, after):
            self.assertAlmostEqual(a, b, places=6)
        page.mouse.click(x, y)
        self.assertEqual(4, page.evaluate("synViewports.get('left').getZoom()"))
        page.keyboard.press('Escape')
        expect(panel).to_have_count(0)
        expect(page.locator('#pane-left .kin-display-capture')).to_have_count(0)
        page.mouse.click(x, y)
        self.assertEqual(4, page.evaluate("synViewports.get('left').getZoom()"), 'a click no longer zooms')

    # ── 03-3 Auto Rotate 180° ──
    def test_07_show_after_and_undo_follow_the_orientation_rule(self):
        page = self.open()
        self.menu(page, 'Auto Rotate 180°', cell='right')
        panel = self.window(page, 'Auto Rotate 180°')
        expect(panel).to_contain_text('Image Orientation Patient: -1\\0\\0\\0\\-1\\0')
        expect(panel).to_contain_text('This image is stored upside-down (180°).')
        self.assertEqual(0, page.evaluate("synViewports.get('right').presentation.rotation"), 'off by default: not turned on open')
        panel.get_by_role('button', name='Show After').click()
        self.assertEqual(180, page.evaluate("synViewports.get('right').presentation.rotation"))
        expect(page.locator('#pane-right .kin-display-badges')).to_have_text('Auto-rotated 180°VOI LUT')
        panel.get_by_role('button', name='Show After').click()
        expect(panel.get_by_role('status')).to_have_text('This image is already turned 180°.')
        self.assertEqual(180, page.evaluate("synViewports.get('right').presentation.rotation"))
        # A hand rotation after the turn; Undo takes back only the 180°.
        page.evaluate("synViewports.get('right').setViewPresentation({ rotation: 270 })")
        panel.get_by_role('button', name='Undo').click()
        self.assertEqual(90, page.evaluate("synViewports.get('right').presentation.rotation"))
        expect(page.locator('#pane-right .kin-display-badges')).to_have_text('VOI LUT')
        panel.get_by_role('button', name='Close').click()
        # The standard image is not turned.
        self.menu(page, 'Auto Rotate 180°', cell='left')
        panel = self.window(page, 'Auto Rotate 180°')
        panel.get_by_role('button', name='Show After').click()
        expect(panel.get_by_role('status')).to_have_text('This image is in the standard orientation.')
        self.assertEqual(0, page.evaluate("synViewports.get('left').presentation.rotation"))

    def test_08_automatic_turn_once_per_display_set_and_not_after_undo(self):
        page = self.open({'autoRotate': True})
        page.wait_for_function("synViewports.get('right').presentation.rotation === 180")
        self.assertEqual(0, page.evaluate("synViewports.get('left').presentation.rotation"))
        # Drawing the same image again does not turn it again.
        page.evaluate("synFire('right', 'STACK_NEW_IMAGE'); synFire('right', 'STACK_NEW_IMAGE')")
        self.assertEqual(180, page.evaluate("synViewports.get('right').presentation.rotation"))
        self.menu(page, 'Auto Rotate 180°', cell='right')
        panel = self.window(page, 'Auto Rotate 180°')
        panel.get_by_role('button', name='Undo').click()
        self.assertEqual(0, page.evaluate("synViewports.get('right').presentation.rotation"))
        page.evaluate("synFire('right', 'STACK_NEW_IMAGE')")
        self.assertEqual(0, page.evaluate("synViewports.get('right').presentation.rotation"), 'not applied again after Undo')
        # Another display set in the cell is judged anew; a turn the cell kept is taken back when it leaves.
        page.evaluate("synShown.right = ['syn-set-3']; synFire('right', 'VIEWPORT_NEW_IMAGE_SET')")
        self.assertEqual(180, page.evaluate("synViewports.get('right').presentation.rotation"))
        # A hand rotation after the automatic turn stays; only this module's 180° is taken back.
        page.evaluate("synViewports.get('right').setViewPresentation({ rotation: 270 })")
        page.evaluate("synMeta['syn:right:2'] = { ...synMeta['syn:left:1'], SOPInstanceUID: '1.2.826.0.1.9' }; synViewports.get('right').image = 'syn:right:2'; synShown.right = ['syn-set-4']; synFire('right', 'VIEWPORT_NEW_IMAGE_SET')")
        self.assertEqual(90, page.evaluate("synViewports.get('right').presentation.rotation"))
        # Reset View takes the rotation to 0°: nothing of this module's is left to take back.
        page.evaluate("synViewports.get('right').setViewPresentation({ rotation: 0 }); synViewports.get('right').image = 'syn:right:1'; synShown.right = ['syn-set-5']; synFire('right', 'VIEWPORT_NEW_IMAGE_SET')")
        self.assertEqual(180, page.evaluate("synViewports.get('right').presentation.rotation"))
        page.evaluate("synViewports.get('right').setViewPresentation({ rotation: 0 }); synFire('right', 'CAMERA_RESET')")
        page.evaluate("synViewports.get('right').image = 'syn:right:2'; synShown.right = ['syn-set-6']; synFire('right', 'VIEWPORT_NEW_IMAGE_SET')")
        self.assertEqual(0, page.evaluate("synViewports.get('right').presentation.rotation"))

    # ── 03-7 My W/L Presets ──
    def test_09_wl_presets_numbers_save_reopen_apply_delete(self):
        page = self.open()
        self.menu(page, 'My W/L Presets…')
        panel = self.window(page, 'My W/L Presets')
        expect(panel).to_contain_text('Modality: CT')
        expect(panel).to_contain_text('Current W 1000 / L -500')
        expect(panel).to_contain_text('No saved presets.')
        panel.get_by_label('Preset name').fill('NODULE LUNG')
        panel.get_by_role('button', name='Save Current W/L').click()
        expect(panel.locator('tr[data-preset="NODULE LUNG"] td')).to_have_text(['NODULE LUNG', '1000', '-500', 'ApplyDelete'])
        self.assertEqual({'CT': [{'name': 'NODULE LUNG', 'w': 1000, 'l': -500}]}, self.features(page)['wlPresets'])
        expect(panel.get_by_label('Preset name')).to_have_value('')
        # Typed W/L.
        panel.get_by_label('Window Width').fill('350'); panel.get_by_label('Window Level').fill('40')
        panel.get_by_role('button', name='Apply', exact=True).click()
        self.assertEqual({'lower': -135, 'upper': 214}, page.evaluate("synViewports.get('left').properties.voiRange"))
        expect(panel).to_contain_text('Current W 350 / L 40')
        page.keyboard.press('Escape'); expect(panel).to_have_count(0)
        self.menu(page, 'My W/L Presets…')
        panel = self.window(page, 'My W/L Presets')
        panel.get_by_role('button', name='Apply NODULE LUNG').click()
        self.assertEqual({'lower': -1000, 'upper': -1}, page.evaluate("synViewports.get('left').properties.voiRange"))
        # The same name replaces its row; an empty name is refused.
        page.evaluate("synViewports.get('left').setProperties({ voiRange: { lower: -1350, upper: 149 } })")
        panel.get_by_label('Preset name').fill('  NODULE   LUNG ')
        panel.get_by_role('button', name='Save Current W/L').click()
        expect(panel.locator('tr[data-preset="NODULE LUNG"] td')).to_have_text(['NODULE LUNG', '1500', '-600', 'ApplyDelete'])
        panel.get_by_role('button', name='Save Current W/L').click()
        expect(panel.get_by_role('status')).to_have_text('Enter a preset name.')
        panel.get_by_role('button', name='Delete NODULE LUNG').click()
        expect(panel).to_contain_text('No saved presets.')
        page.wait_for_function("!synServer.viewerSettings?.features?.wlPresets")

    def test_10_saved_presets_of_the_cells_modality_on_open(self):
        page = self.open({'wlPresets': {'CR': [{'name': 'My Chest', 'w': 4000, 'l': 2000}], 'CT': [{'name': 'My Lung', 'w': 1500, 'l': -600}]}})
        self.menu(page, 'My W/L Presets…', cell='right')
        panel = self.window(page, 'My W/L Presets')
        expect(panel).to_contain_text('Modality: CR')
        expect(panel.locator('tr[data-preset]')).to_have_count(1)
        panel.get_by_role('button', name='Apply My Chest').click()
        self.assertEqual({'lower': 0, 'upper': 3999}, page.evaluate("synViewports.get('right').properties.voiRange"))

    # ── 03-8 VOI LUT ──
    def test_11_voi_lut_on_off_and_a_hand_window_turns_it_off(self):
        page = self.open()
        # The account default is on: the stored table is drawn on open, with a badge.
        page.wait_for_function("synVoiCalls.some(c => c[0] === 'right' && c[1] === 'TABLE')")
        expect(page.locator('#pane-right .kin-display-badges')).to_have_text('VOI LUT')
        self.menu(page, 'VOI LUT', cell='right')
        panel = self.window(page, 'VOI LUT')
        expect(panel).to_contain_text('This image carries a VOI LUT (VOI LUT Sequence).')
        check = panel.get_by_role('checkbox', name='Use VOI LUT')
        expect(check).to_be_checked()
        page.evaluate("synVoiCalls.length = 0")
        check.uncheck()
        self.assertEqual([['right', 'LINEAR', [1500, 1000]]], page.evaluate("synVoiCalls"))
        self.assertEqual({'lower': 1000, 'upper': 1999}, page.evaluate("synViewports.get('right').properties.voiRange"))
        expect(page.locator('#pane-right .kin-display-badges')).to_have_count(0)
        check.check()
        self.assertEqual('TABLE', page.evaluate("synVoiCalls.at(-1)[1]"))
        expect(page.locator('#pane-right .kin-display-badges')).to_have_text('VOI LUT')
        # The table is drawn again for the next image of the cell.
        # The viewer's own window events while the image loads, also those after STACK_NEW_IMAGE in the same load, are not
        # the reader's: the table stays on.
        page.evaluate("""synVoiCalls.length = 0; synFire('right', 'PRE_STACK_NEW_IMAGE'); synFire('right', 'VOI_MODIFIED'); synFire('right', 'STACK_NEW_IMAGE');
          queueMicrotask(() => synViewports.get('right').setProperties({ voiRange: { lower: 0, upper: 4095 } }))""")
        page.wait_for_timeout(100)
        self.assertTrue(page.evaluate("synVoiCalls.length > 0 && synVoiCalls.every(c => c[0] === 'right' && c[1] === 'TABLE')"))
        expect(check).to_be_checked()
        # A window set by hand: the cell takes that window, drawn linear, and the check goes off.
        page.evaluate("synViewports.get('right').properties.VOILUTFunction = 'SIGMOID'; synViewports.get('right').setProperties({ voiRange: { lower: 100, upper: 900 } })")
        expect(check).not_to_be_checked()
        expect(page.locator('#pane-right .kin-display-badges')).to_have_count(0)
        self.assertEqual({'VOILUTFunction': 'LINEAR', 'voiRange': {'lower': 100, 'upper': 900}},
                         page.evaluate("(({ VOILUTFunction, voiRange }) => ({ VOILUTFunction, voiRange }))(synViewports.get('right').properties)"))
        page.evaluate("synVoiCalls.length = 0; synFire('right', 'PRE_STACK_NEW_IMAGE'); synFire('right', 'STACK_NEW_IMAGE')")
        page.wait_for_timeout(100)
        self.assertEqual([], page.evaluate("synVoiCalls"), "the reader's window is not overwritten")
        self.assertEqual({'lower': 100, 'upper': 900}, page.evaluate("synViewports.get('right').properties.voiRange"))
        panel.get_by_role('button', name='Close').click()
        # A cell without a stored VOI LUT.
        self.menu(page, 'VOI LUT', cell='left')
        panel = self.window(page, 'VOI LUT')
        expect(panel).to_contain_text('This image has no VOI LUT.')
        expect(panel.get_by_role('checkbox', name='Use VOI LUT')).to_be_disabled()
        expect(panel.get_by_role('checkbox', name='Use VOI LUT')).not_to_be_checked()

    def test_12_account_default_off_leaves_the_header_window(self):
        page = self.open({'voiLut': False})
        # Off: the header window, drawn linear (a SIGMOID or a table the viewer kept does not stay).
        page.wait_for_function("synVoiCalls.some(c => c[1] === 'LINEAR')")
        page.wait_for_timeout(200)
        self.assertFalse(page.evaluate("synVoiCalls.some(c => c[1] === 'TABLE')"))
        self.assertEqual(['right', 'LINEAR', [1500, 1000]], page.evaluate("synVoiCalls.at(-1)"))
        expect(page.locator('#pane-right .kin-display-badges')).to_have_count(0)
        # The next image of the cell gets the header window too.
        page.evaluate("synVoiCalls.length = 0; synViewports.get('right').properties.VOILUTFunction = 'SIGMOID'; synFire('right', 'PRE_STACK_NEW_IMAGE'); synFire('right', 'STACK_NEW_IMAGE')")
        page.wait_for_timeout(100)
        self.assertEqual('LINEAR', page.evaluate("synVoiCalls.at(-1)[1]"))
        self.menu(page, 'VOI LUT', cell='right')
        panel = self.window(page, 'VOI LUT')
        expect(panel.get_by_role('checkbox', name='Use VOI LUT')).not_to_be_checked()
        panel.get_by_role('checkbox', name='Use VOI LUT').check()
        self.assertEqual('TABLE', page.evaluate("synVoiCalls.at(-1)[1]"))

    # The next image of the right cell as the viewer loads it: PRE_STACK_NEW_IMAGE, STACK_NEW_IMAGE, and then, later in
    # the same load, the viewer's per-image (or default) properties through setProperties.
    # The next image of the same display set; with plain=True it has only a plain linear window, which the stored VOI
    # does not keep (its spec is null), so it has no table.
    def next_image(self, page, n, properties, plain=False):
        page.evaluate('''([n, props, plain]) => {
          const v = synViewports.get('right');
          if (!kinStoredVoi.synMapped) {
            const original = kinStoredVoi.spec;
            kinStoredVoi.spec = (sop, frame, options) => original(String(sop).startsWith('1.2.826.0.1.2.') ? '1.2.826.0.1.2' : sop, frame, options);
            kinStoredVoi.synMapped = true;
          }
          synMeta['syn:right:' + n] = { ...synMeta['syn:right:1'], SOPInstanceUID: (plain ? '1.2.826.0.1.99.' : '1.2.826.0.1.2.') + n, InstanceNumber: n };
          synFire('right', 'PRE_STACK_NEW_IMAGE'); v.image = 'syn:right:' + n;
          synFire('right', 'STACK_NEW_IMAGE');
          queueMicrotask(() => v.setProperties(props));
        }''', [n, properties, plain])
        page.wait_for_timeout(150)

    def shown(self, page, cell='right'):
        return page.evaluate("id => (({ VOILUTFunction, voiRange }) => ({ VOILUTFunction, voiRange }))(synViewports.get(id).getProperties())", cell)

    def test_18_reader_window_kept_after_the_viewers_image_properties(self):
        page = self.open()
        page.wait_for_function("synVoiCalls.some(c => c[0] === 'right' && c[1] === 'TABLE')")
        page.wait_for_timeout(100)
        page.evaluate("synViewports.get('right').setProperties({ voiRange: { lower: 100, upper: 900 } })")
        self.assertEqual({'VOILUTFunction': 'LINEAR', 'voiRange': {'lower': 100, 'upper': 900}}, self.shown(page))
        # The viewer's linear defaults for the next image do not replace the reader's window.
        self.next_image(page, 2, {'VOILUTFunction': 'LINEAR', 'voiRange': {'lower': 20, 'upper': 200}})
        self.assertEqual({'VOILUTFunction': 'LINEAR', 'voiRange': {'lower': 100, 'upper': 900}}, self.shown(page))
        # Nor do non-linear ones: the reader's window, drawn linear.
        self.next_image(page, 3, {'VOILUTFunction': 'SIGMOID', 'voiRange': {'lower': 30, 'upper': 300}})
        self.assertEqual({'VOILUTFunction': 'LINEAR', 'voiRange': {'lower': 100, 'upper': 900}}, self.shown(page))
        # Nor on an image of the same set without a table (a plain linear window only).
        self.assertIsNone(page.evaluate("kinStoredVoi.spec('1.2.826.0.1.99.6', 1, { preferTable: true })"))
        self.next_image(page, 6, {'VOILUTFunction': 'LINEAR', 'voiRange': {'lower': 20, 'upper': 200}}, plain=True)
        self.assertEqual({'VOILUTFunction': 'LINEAR', 'voiRange': {'lower': 100, 'upper': 900}}, self.shown(page))
        # A new window by hand on that image is the one kept when an image with a table comes back.
        page.evaluate("synViewports.get('right').setProperties({ voiRange: { lower: 300, upper: 700 } })")
        self.assertEqual({'VOILUTFunction': 'LINEAR', 'voiRange': {'lower': 300, 'upper': 700}}, self.shown(page))
        self.next_image(page, 7, {'VOILUTFunction': 'LINEAR', 'voiRange': {'lower': 20, 'upper': 200}})
        self.assertEqual({'VOILUTFunction': 'LINEAR', 'voiRange': {'lower': 300, 'upper': 700}}, self.shown(page))
        # A new window by hand is the one kept from then on.
        page.evaluate("synViewports.get('right').setProperties({ voiRange: { lower: 200, upper: 800 } })")
        self.next_image(page, 4, {'VOILUTFunction': 'LINEAR', 'voiRange': {'lower': 20, 'upper': 200}})
        self.assertEqual({'VOILUTFunction': 'LINEAR', 'voiRange': {'lower': 200, 'upper': 800}}, self.shown(page))
        # Use VOI LUT again: the reader's window is no longer kept; the table is drawn for the next image.
        self.menu(page, 'VOI LUT', cell='right')
        panel = self.window(page, 'VOI LUT')
        panel.get_by_role('checkbox', name='Use VOI LUT').check()
        page.evaluate("synVoiCalls.length = 0")
        self.next_image(page, 5, {'VOILUTFunction': 'LINEAR', 'voiRange': {'lower': 20, 'upper': 200}})
        self.assertEqual('TABLE', page.evaluate("synVoiCalls.at(-1)[1]"))
        expect(panel.get_by_role('checkbox', name='Use VOI LUT')).to_be_checked()

    def test_19_off_header_window_after_the_viewers_image_properties(self):
        page = self.open({'voiLut': False})
        page.wait_for_function("synVoiCalls.some(c => c[1] === 'LINEAR')")
        page.wait_for_timeout(100)
        self.next_image(page, 2, {'VOILUTFunction': 'LINEAR', 'voiRange': {'lower': 20, 'upper': 200}})
        self.assertEqual({'VOILUTFunction': 'LINEAR', 'voiRange': {'lower': 1000, 'upper': 1999}}, self.shown(page))
        self.next_image(page, 3, {'VOILUTFunction': 'SIGMOID', 'voiRange': {'lower': 30, 'upper': 300}})
        self.assertEqual({'VOILUTFunction': 'LINEAR', 'voiRange': {'lower': 1000, 'upper': 1999}}, self.shown(page))
        self.assertFalse(page.evaluate("synVoiCalls.some(c => c[1] === 'TABLE')"))

    def test_20_window_from_viewer_settings_closes_for_good_when_its_cell_changes(self):
        page = self.open({'wlPresets': {'CT': [{'name': 'Lung', 'w': 1500, 'l': -600}]}})
        page.get_by_role('button', name='Viewer Settings').click()
        page.locator('dialog.kin-ux-settings').get_by_role('button', name='My W/L Presets…').click()
        modal = page.locator('dialog.kin-ux-feature-panel[aria-label="My W/L Presets"]')
        expect(modal).to_be_visible()
        # The cell is given other images and then the same ones again: the window does not come back to life.
        page.evaluate("synShown.left = ['syn-set-new']; synEmit('cells', 'data', { viewportId: 'left' })")
        page.wait_for_timeout(100)
        page.evaluate("synShown.left = ['syn-set-1']; synEmit('cells', 'data', { viewportId: 'left' })")
        expect(modal).to_have_count(0)
        self.assertEqual({'lower': -1000, 'upper': -1}, page.evaluate("synViewports.get('left').properties.voiRange"))
        # Opened again, it acts on the cell as it is now.
        page.locator('dialog.kin-ux-settings').get_by_role('button', name='My W/L Presets…').click()
        expect(modal).to_be_visible()
        modal.get_by_role('button', name='Apply Lung').click()
        self.assertEqual({'lower': -1350, 'upper': 149}, page.evaluate("synViewports.get('left').properties.voiRange"))
        # Another layout (the grid names no cell) closes it as well.
        page.evaluate("synEmit('grid', 'gridState', {})")
        expect(modal).to_have_count(0)

    # ── A window acts only on the cell it was opened for ──
    def test_15_window_closes_when_its_cell_gets_other_images(self):
        page = self.open({'wlPresets': {'CT': [{'name': 'My Lung', 'w': 1500, 'l': -600}]}})
        self.menu(page, 'My W/L Presets…')
        panel = self.window(page, 'My W/L Presets')
        self.menu(page, 'Zoom…')
        zoom = self.window(page, 'Zoom')
        # The left cell is given a CR series: both windows of the left cell close, nothing is applied to the CR.
        page.evaluate("synMeta['syn:left:2'] = { ...synMeta['syn:right:1'], SOPInstanceUID: '1.2.826.0.1.7' }; synViewports.get('left').image = 'syn:left:2'; synShown.left = ['syn-set-8']; synEmit('cells', 'data', { viewportId: 'left' })")
        expect(panel).to_have_count(0); expect(zoom).to_have_count(0)
        self.assertEqual({'lower': -1000, 'upper': -1}, page.evaluate("synViewports.get('left').properties.voiRange"))
        # Opened from Viewer Settings (no menu run): the window refuses once its cell shows other images.
        page.evaluate("synMeta['syn:left:2'].Modality = 'CT'; synShown.left = ['syn-set-1']; synViewports.get('left').image = 'syn:left:1'")
        page.get_by_role('button', name='Viewer Settings').click()
        page.locator('dialog.kin-ux-settings').get_by_role('button', name='My W/L Presets…').click()
        modal = page.locator('dialog.kin-ux-feature-panel[aria-label="My W/L Presets"]')
        expect(modal).to_be_visible()
        page.evaluate("synShown.left = ['syn-set-9']")
        modal.get_by_role('button', name='Apply My Lung').click()
        expect(modal.get_by_role('status')).to_have_text('The images in this cell changed. Open this window again.')
        self.assertEqual({'lower': -1000, 'upper': -1}, page.evaluate("synViewports.get('left').properties.voiRange"))

    # ── Saves run in order, each on the value the one before it saved ──
    def test_16_two_presets_saved_while_a_save_is_in_progress_are_both_kept(self):
        page = self.open()
        self.menu(page, 'My W/L Presets…')
        panel = self.window(page, 'My W/L Presets')
        page.evaluate("() => { synServer.hold = new Promise(resolve => { window.synRelease = resolve; }); }")
        panel.get_by_label('Preset name').fill('First'); panel.get_by_role('button', name='Save Current W/L').click()
        panel.get_by_label('Preset name').fill('Second'); panel.get_by_role('button', name='Save Current W/L').click()
        page.wait_for_function("synServer.puts.length === 1")
        page.evaluate("synServer.hold = null; synRelease()")
        page.wait_for_function("(synServer.viewerSettings?.features?.wlPresets?.CT || []).length === 2")
        self.assertEqual(['First', 'Second'], page.evaluate("synServer.viewerSettings.features.wlPresets.CT.map(p => p.name)"))
        self.assertEqual([3, 4], page.evaluate("synServer.puts.map(p => p.revision)"))
        expect(panel.locator('tr[data-preset]')).to_have_count(2)

    def test_17_two_overlay_changes_while_a_save_is_in_progress_are_both_kept(self):
        page = self.open()
        self.menu(page, 'Overlay Items…')
        panel = self.window(page, 'Overlay Items')
        page.evaluate("() => { synServer.hold = new Promise(resolve => { window.synRelease = resolve; }); }")
        panel.get_by_role('checkbox', name='W/L Value').uncheck()
        page.wait_for_function("synServer.puts.length === 1")
        panel.get_by_role('checkbox', name='Zoom').uncheck()
        page.evaluate("synServer.hold = null; synRelease()")
        page.wait_for_function("synServer.puts.length === 2 && synServer.revision === 5")
        self.assertEqual({'wl': False, 'zoom': False}, page.evaluate("(({ wl, zoom }) => ({ wl, zoom }))(synServer.viewerSettings.features.overlayItems)"))
        expect(panel.get_by_role('checkbox', name='Zoom')).not_to_be_checked()
        expect(page.locator('#pane-left .kin-display-zoom')).to_have_count(0)

    # ── Calculations (viewer-display-model.js) ──
    def test_13_model(self):
        page = self.open()
        result = page.evaluate("""() => {
          const m = KinViewerDisplayModel, o = v => m.orientation(v).state;
          const full = Array.from({ length: 20 }, (_, i) => ({ name: 'P' + i, w: 100, l: 10 }));
          const camera = { focalPoint: [10, 20, 0], position: [10, 20, 100], parallelScale: 80 };
          const zoomed = m.anchoredZoom(camera, [30, -40, 0], 2);
          return {
            orientation: [o([1,0,0,0,1,0]), o([-1,0,0,0,-1,0]), o([-1,0,0,0,1,0]), o([1,0,0,0,-1,0]), o([0,1,0,1,0,0]),
              o([1,0,0,0,0,-1]), o([-1,0,0,0,0,1]), o([0,1,0,0,0,-1]), o([0,-1,0,0,0,1]), o('-1\\\\0\\\\0\\\\0\\\\-1\\\\0'),
              o([-0.95,0.31,0,0.31,-0.95,0]), o([0.8,0.6,0,-0.6,0.8,0]), o(null), o([1,0,0]), o(['a',0,0,0,1,0])],
            zoom: [m.zoomFromPercent('150'), m.zoomFromPercent(' 75% '), m.zoomFromPercent('9'), m.zoomFromPercent('1601'), m.zoomFromPercent('abc'), m.zoomPercent(2.004)],
            anchored: zoomed, kept: [30 + (camera.focalPoint[0] - 30) / 2, -40 + (camera.focalPoint[1] + 40) / 2],
            presets: [m.savePreset({}, 'CT', { name: 'x'.repeat(61), w: 1, l: 1 }).reason, m.savePreset({}, 'CT', { name: 'A', w: 0, l: 1 }).reason,
              m.savePreset({ CT: full }, 'CT', { name: 'New', w: 1, l: 1 }).reason, m.savePreset({ CT: full }, 'CT', { name: 'P3', w: 7, l: 8 }).value.CT[3],
              m.savePreset({}, 'ct', { name: 'A', w: 1, l: 1 }).reason, m.presets({ CT: [{ name: 'A', w: 1, l: 1 }, { name: 'A', w: 2, l: 2 }, { name: '', w: 1, l: 1 }], bad: [] })],
            fields: [m.field('(0018,0050)'), m.field('00180050'), m.field('SliceThickness'), m.field('Slice Thickness'), m.field('(0018,005)')],
            labels: [m.fieldLabel('SliceThickness'), m.fieldLabel('PatientID'), m.fieldLabel('KVP'), m.fieldLabel('(0019,1001)')],
            lines: [m.line('KVP', { KVP: 120 }), m.line('(0018,0050)', { SliceThickness: 5 }), m.line('(0019,1001)', {}, { '00191001': { vr: 'LO', Value: ['X'] } }), m.line('(0019,1001)', {}, undefined), m.line('(0019,1001)', {}, null), m.line('(0010,0010)', {}, { '00100010': { vr: 'PN', Value: [{ Alphabetic: 'SYN^TWO' }] } }), m.line('PatientName', {})],
            ruler: [m.rulerPixels(50, 0.5, 2), m.rulerPixels(50, 0, 2), m.rulerPixels(50, 0.2, NaN)],
            overlay: m.overlay({ wl: false, colour: 'red', width: 9, extra: 1 }),
            corners: m.corners({ CT: { TL: ['PatientName', 'bad key!', '0018,0050', 'Fourth'] }, x: {} }),
            space: (() => {
              // Long names in many modalities: the presets stop at their share of the account's feature values.
              let value = {}, last = null;
              for (const modality of ['CT', 'MR', 'CR', 'DX', 'MG', 'US', 'XA', 'RF', 'NM', 'PT'])
                for (let i = 0; i < 20; i++) {
                  const result = m.savePreset(value, modality, { name: modality + '-' + i + '-' + 'n'.repeat(50), w: 12345.67, l: -1234.56 });
                  if (!result.ok) return { reason: result.reason, bytes: JSON.stringify(value).length, last };
                  value = result.value; last = modality + i;
                }
              return { reason: null };
            })(),
            // Korean names take three bytes a letter: the share is counted in UTF-8 bytes, as the server counts.
            spaceKo: (() => {
              let value = {};
              for (const modality of ['CT', 'MR', 'CR', 'DX', 'MG', 'US', 'XA', 'RF'])
                for (let i = 0; i < 20; i++) {
                  const result = m.savePreset(value, modality, { name: modality + i + '폐창'.repeat(25), w: 1500, l: -600 });
                  if (!result.ok) return { reason: result.reason, bytes: new TextEncoder().encode(JSON.stringify(value)).length };
                  value = result.value;
                }
              return { reason: null };
            })(),
            range: [m.toRange(400, 40), m.fromRange({ lower: -160, upper: 239 }), m.toRange(1, 0), m.fromRange({ lower: -0.5, upper: -0.5 })],
          };
        }""")
        self.assertEqual(['standard', 'rotated-180', 'mirrored', 'mirrored', 'other', 'standard', 'rotated-180', 'standard', 'rotated-180',
                          'rotated-180', 'rotated-180', 'oblique', 'missing', 'missing', 'missing'], result['orientation'])
        self.assertEqual([1.5, 0.75, None, None, None, 200], result['zoom'])
        self.assertEqual(40, result['anchored']['parallelScale'])
        self.assertEqual(result['kept'], result['anchored']['focalPoint'][:2])
        self.assertEqual(['name-length', 'numbers', 'full', {'name': 'P3', 'w': 7, 'l': 8}, 'modality', {'CT': [{'name': 'A', 'w': 1, 'l': 1}]}], result['presets'])
        self.assertEqual(['(0018,0050)', '(0018,0050)', 'SliceThickness', None, None], result['fields'])
        self.assertEqual(['Slice Thickness', 'Patient ID', 'kVp', '(0019,1001)'], result['labels'])
        self.assertEqual(['KVP: 120 kV', '(0018,0050): 5 mm', '(0019,1001): X', '(0019,1001): …', '(0019,1001): —', '(0010,0010): SYN^TWO', 'PatientName: —'], result['lines'])
        self.assertEqual([200, None, None], result['ruler'])
        self.assertEqual({'wl': False, 'zoom': True, 'ruler': False, 'dicom': True, 'border': False, 'colour': '#E8C547', 'width': 2}, result['overlay'])
        self.assertEqual({'CT': {'TL': ['PatientName', '', '(0018,0050)'], 'TR': ['', '', ''], 'BL': ['', '', ''], 'BR': ['', '', '']}}, result['corners'])
        self.assertEqual('space', result['space']['reason'])
        self.assertLessEqual(result['space']['bytes'], 12000)
        self.assertGreater(result['space']['bytes'], 11000)
        self.assertEqual('space', result['spaceKo']['reason'])
        self.assertLessEqual(result['spaceKo']['bytes'], 12000)
        # The viewer's DICOM linear window (W 400 / L 40 is -160 … 239) both ways, and W 1.
        self.assertEqual([{'lower': -160, 'upper': 239}, {'w': 400, 'l': 40}, {'lower': -0.5, 'upper': -0.5}, {'w': 1, 'l': 0}], result['range'])

    # ── Read-only session: applied in this window only ──
    def test_14_read_only_session_applies_without_saving(self):
        page = self.open(writer=False)
        self.menu(page, 'My W/L Presets…')
        panel = self.window(page, 'My W/L Presets')
        panel.get_by_label('Preset name').fill('Local')
        panel.get_by_role('button', name='Save Current W/L').click()
        expect(panel.get_by_role('status')).to_have_text('Applied in this window (not saved to your account).')
        expect(panel.locator('tr[data-preset="Local"]')).to_have_count(1)
        self.assertEqual([], page.evaluate("synServer.puts"))


if __name__ == '__main__':
    unittest.main(verbosity=2)
