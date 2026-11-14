# coding: utf-8
"""Auto Save View on the shipped image toolbar: Display > Auto Save View... and Viewer Settings > Tools & Display (the
account check and the window); with the check on, one save a moment after the view last changed and none while the
viewer opens, while the saved view goes back or right after a Hanging Protocol is applied; nothing at all with it off;
the saved view put back over the viewer's first layout (layout, cell rule, image by SOP, window and camera) with a badge
naming only what went back; a Job chosen to open wins; Discard Saved View wins over a save on its way; a patient switch
saves at once.

The shipped viewer-features.js, viewer-features-autosave.js, viewer-auto-view-model.js, viewer-features-view.js (with
hanging-protocol-model.js, viewer-image-filter.js, viewer-gsps.js), viewer-ux-shortcuts.js and viewer-ux-toolbar.js (with
viewer-ux-theme.css) run in Chromium beside synthetic OHIF services, synthetic CT stacks and a synthetic API. The real
viewer, server and database are in tests/e2e/test_auto_save_view.py.
"""
from pathlib import Path
import json
import unittest

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
ORIGIN = "https://auto-save-view.test"
OWNER = ['syn-site', 'syn-reader']
STUDY = '1.2.826.0.1.3680043.8.498.140'
SA, SB = STUDY + '.2', STUDY + '.3'
CHECK = 'Save view changes automatically and apply on reopen'

HARNESS = """<!doctype html><html><head><style>
body { margin: 0; background: #111; color: #eee; --kin-panel: #222; --kin-ux-text: #eee; --kin-ux-secondary: #999; --kin-accent: #6cf; }
#grid { position: absolute; left: 0; top: 80px; width: 1240px; height: 440px; }
[data-cy=viewport-pane] { position: absolute; width: 300px; height: 200px; overflow: hidden; }
.viewport-element { position: absolute; inset: 0; } .viewport-element canvas { width: 300px; height: 200px; display: block; }
</style></head><body><div id="root"><div class="kin-ux-toolbar-slot"></div><div id="grid"></div></div></body></html>"""

SETUP = """config => {
  const STUDY = config.study, owner = config.owner;
  window.synNotes = []; window.synEnded = false; window.synWriter = true;
  window.synSets = [{ uid: 'set-A', series: config.sa, n: 8 }, { uid: 'set-B', series: config.sb, n: 4 }];
  window.synMeta = {};
  // Each series' images, numbered 1..n, slice positions rising with the number.
  for (const set of synSets) for (let i = 1; i <= set.n; i++) synMeta['syn:' + set.uid + ':' + i] = { Modality: 'CT', StudyInstanceUID: STUDY,
    SeriesInstanceUID: set.series, SOPInstanceUID: set.series + '.' + i, InstanceNumber: i, ImagePositionPatient: [0, 0, i * 5],
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0], PixelSpacing: [0.5, 0.5], Rows: 400, Columns: 600 };
  const EVENTS = { STACK_NEW_IMAGE: 'syn-new', CAMERA_MODIFIED: 'syn-camera', VOI_MODIFIED: 'syn-voi', IMAGE_RENDERED: 'syn-rendered' };
  window.cornerstone = { Enums: { Events: EVENTS },
    metaData: { get: (type, id) => type === 'instance' ? synMeta[id] : type === 'voiLutModule' && synMeta[id] ? { windowCenter: [40], windowWidth: [400] } : undefined },
    utilities: { windowLevel: { toWindowLevel: (low, high) => ({ windowWidth: Math.abs(high - low) + 1, windowCenter: (low + high + 1) / 2 }),
      toLowHighRange: (w, c) => ({ lower: c - 0.5 - (w - 1) / 2, upper: c - 0.5 + (w - 1) / 2 }) } } };
  // Cornerstone's events do not bubble: the features hear them on the document in the capture phase.
  const fire = (v, name, detail = {}) => v.element.dispatchEvent(new CustomEvent(EVENTS[name], { detail: { viewportId: v.id, element: v.element, ...detail } }));
  window.synFire = (id, name) => fire(synViewports.get(id), name);
  window.synViewports = new Map(); window.synShown = new Map(); window.synActive = null; window.synLayout = { rows: 1, cols: 1 }; window.synLayouts = [];
  function makeViewport(id, setUid, index, rows, cols) {
    const x = (index % cols) / cols, y = Math.floor(index / cols) / rows;
    const pane = document.createElement('div'); pane.dataset.cy = 'viewport-pane'; pane.id = 'pane-' + id;
    pane.style.left = (x * 1240) + 'px'; pane.style.top = (y * 440) + 'px';
    pane.innerHTML = '<div class="viewport-element"><canvas width="300" height="200"></canvas></div>';
    document.getElementById('grid').append(pane);
    const set = synSets.find(s => s.uid === setUid), element = pane.querySelector('.viewport-element');
    const v = { id, type: 'stack', element, ids: set ? Array.from({ length: set.n }, (_, i) => 'syn:' + set.uid + ':' + (i + 1)) : [], index: 0,
      presentation: { rotation: 0 }, properties: { invert: false, voiRange: { lower: -160, upper: 239 }, VOILUTFunction: 'LINEAR', interpolationType: 1 },
      camera: { focalPoint: [0, 0, 5], position: [0, 0, 105], viewUp: [0, -1, 0], viewPlaneNormal: [0, 0, 1], parallelScale: 100, rotation: 0, flipHorizontal: false, flipVertical: false } };
    Object.assign(v, {
      getImageIds: () => [...v.ids], getCurrentImageId: () => v.ids[v.index], getCurrentImageIdIndex: () => v.index,
      async setImageIdIndex(index) { v.index = index; fire(v, 'STACK_NEW_IMAGE'); },
      async setStack(ids, index = 0) { v.ids = [...ids]; v.index = index; fire(v, 'STACK_NEW_IMAGE'); },
      getZoom: () => 100 / v.camera.parallelScale, setZoom(zoom) { v.camera.parallelScale = 100 / zoom; fire(v, 'CAMERA_MODIFIED'); },
      setPan() {}, resetProperties() {}, render() {},
      getCamera: () => structuredClone(v.camera), setCamera(next) { const { rotation, ...rest } = structuredClone(next); v.camera = { ...v.camera, ...rest };
        if (rotation !== undefined) { v.camera.rotation = rotation; v.presentation.rotation = rotation; } fire(v, 'CAMERA_MODIFIED'); },
      getViewPresentation: () => ({ ...v.presentation }), setViewPresentation(next) { v.presentation = { rotation: next.rotation }; v.camera.rotation = next.rotation; fire(v, 'CAMERA_MODIFIED'); },
      getProperties: () => structuredClone(v.properties),
      setProperties(next) { v.properties = { ...v.properties, ...structuredClone(next) }; if (next.voiRange) fire(v, 'VOI_MODIFIED', { range: next.voiRange }); },
      setVOI(range) { v.properties.voiRange = { ...range }; fire(v, 'VOI_MODIFIED', { range }); },
      getImageData: () => ({ spacing: [0.5, 0.5, 1], imageData: { indexToWorld: ([i, j]) => [i * 0.5, j * 0.5, 0] } }), worldToCanvas: ([x, y]) => [x, y],
    });
    synViewports.set(id, v); synShown.set(id, { set: setUid, x, y, w: 1 / cols, h: 1 / rows });
  }
  window.synBuild = (rows, cols, cells, active) => {
    document.getElementById('grid').replaceChildren(); synViewports.clear(); synShown.clear();
    cells.forEach(([id, set], index) => makeViewport(id, set, index, rows, cols));
    synLayout = { rows, cols }; synActive = active ?? cells[0][0];
    synEmit('grid', 'gridState', { viewports: cells.map(([id]) => ({ viewportId: id })) });
  };
  window.synCommands = { calls: [], runCommand(name, props, context) { this.calls.push([name, structuredClone(props), context]);
    if (name === 'setViewportWindowLevel') { const v = synViewports.get(props.viewportId); v.setProperties({ voiRange: cornerstone.utilities.windowLevel.toLowHighRange(props.window, props.level) }); } } };
  const listeners = new Map();
  const events = name => ({ subscribe(event, fn) { const key = name + event; listeners.set(key, [...(listeners.get(key) || []), fn]);
    return { unsubscribe() { listeners.set(key, (listeners.get(key) || []).filter(f => f !== fn)); } }; } });
  window.synEmit = (name, event, payload) => { for (const fn of listeners.get(name + event) || []) fn(payload); };
  const grid = { ...events('grid'), EVENTS: { ACTIVE_VIEWPORT_ID_CHANGED: 'active', GRID_STATE_CHANGED: 'gridState', LAYOUT_CHANGED: 'layout' },
    getActiveViewportId: () => synActive, setActiveViewportId: id => { synActive = id; synEmit('grid', 'active', { viewportId: id }); },
    getState: () => ({ activeViewportId: synActive, layout: { numRows: synLayout.rows, numCols: synLayout.cols, layoutType: 'grid' },
      viewports: new Map([...synShown].map(([id, s]) => [id, { viewportId: id, x: s.x, y: s.y, width: s.w, height: s.h, displaySetInstanceUIDs: s.set ? [s.set] : [] }])) }),
    async setLayout({ numRows, numCols, activeViewportId, findOrCreateViewport }) {
      synLayouts.push([numRows, numCols]);
      const cells = Array.from({ length: numRows * numCols }, (_, i) => { const made = findOrCreateViewport(i); return [made.viewportOptions.viewportId, made.displaySetInstanceUIDs[0] || null]; });
      setTimeout(() => synBuild(numRows, numCols, cells, activeViewportId), 50);
    } };
  const buttons = Object.fromEntries(['WindowLevel', 'Pan', 'Zoom'].map(id => [id, { id, uiType: 'ohif.radioGroup', props: { label: id, commands: 'setToolActiveToolbar' } }]));
  window.synServices = {
    viewportGridService: grid,
    cornerstoneViewportService: { ...events('cells'), EVENTS: { VIEWPORT_DATA_CHANGED: 'data' }, getCornerstoneViewport: id => synViewports.get(id) },
    displaySetService: { getActiveDisplaySets: () => synSets.map(s => ({ displaySetInstanceUID: s.uid, StudyInstanceUID: STUDY, SeriesInstanceUID: s.series,
      images: Array.from({ length: s.n }, (_, i) => ({ SOPInstanceUID: s.series + '.' + (i + 1) })) })) },
    customizationService: { get: () => undefined },
    uiNotificationService: { show: note => synNotes.push(note) },
    toolbarService: { EVENTS: { TOOL_BAR_MODIFIED: 'modified' }, getButtonSection: () => Object.keys(buttons).map(id => ({ id })), getButtons: () => buttons,
      getButtonProps: id => buttons[id] && { id, ...buttons[id].props }, recordInteraction() {}, subscribe: () => ({ unsubscribe() {} }) },
  };
  window.kinViewerHistoryWorkspaceState = () => ({ busy: false });
  window.kinViewerJobWorkspaceState = () => ({ busy: false });
  window.KinViewerHangingSettings = { modalities: [], defaults: {}, get: () => ({}), mount: () => ({ apply() {}, dispose() {} }), mountSizing: () => ({ dispose() {} }) };
  window.KinSessionTransport = { refusal: () => false, responseError: () => new Error('ended') };
  // The API: the account's viewer settings and this study's saved view (one per reader). `hold` keeps a save's answer back.
  window.synServer = { revision: 3, viewerSettings: config.settings, saved: config.saved, posts: [], log: [], hold: null, release: null };
  window.synRequests = [];
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const VIEW = '/api/studies/' + STUDY + '/viewer-auto-view';
  window.fetch = async (url, init = {}) => {
    const s = synServer, path = String(url), method = init.method || 'GET';
    synRequests.push(method + ' ' + path);
    if (path === VIEW && method === 'GET') return reply(200, { view: s.saved ? { snapshot: structuredClone(s.saved), revision: 1, savedAt: '2026-11-14T01:02:03.000Z' } : null });
    if (path === VIEW && method === 'POST') {
      const body = JSON.parse(init.body); s.posts.push(body.snapshot); s.log.push('save');
      if (s.hold) await s.hold;
      s.saved = body.snapshot; s.log.push('saved');
      return reply(200, { saved: true, revision: s.posts.length, savedAt: '2026-11-14T02:03:04.000Z' });
    }
    if (path === VIEW + '/discard' && method === 'POST') { s.log.push('discard'); const had = !!s.saved; s.saved = null; return reply(200, { discarded: had }); }
    if (!path.endsWith('/api/workspace-shortcuts')) return reply(404, {});
    if (method === 'GET') return reply(200, { owner, revision: s.revision, viewerSettings: structuredClone(s.viewerSettings) });
    const body = JSON.parse(init.body); s.revision++; s.viewerSettings = body.viewerSettings;
    return reply(200, { owner, revision: s.revision, viewerSettings: structuredClone(s.viewerSettings) });
  };
  window.synSession = { owner: () => owner, ended: () => synEnded, writer: () => synWriter, state: () => 'confirmed', decide: async () => {} };
  window.synMount = () => {
    window.synToolbar = KinViewerUXToolbar.mount({ services: synServices, commands: synCommands, session: synSession });
    window.synKeys = KinViewerUXShortcuts.mount({ getBindings: () => synToolbar.bindings(), invoke: id => synToolbar.invoke(id), allowed: () => !synEnded });
  };
}"""

STATE = """id => { const v = synViewports.get(id); return v && { ids: v.getImageIds(), index: v.index, image: v.getCurrentImageId(), scale: v.camera.parallelScale,
  focal: v.camera.focalPoint, flipV: v.camera.flipVertical, voi: v.properties.voiRange, invert: v.properties.invert }; }"""


def cell(series, n, scale=40, lower=-1060, upper=439, flip=False, display=None, index=None):
    """A saved stack cell showing image n of the series (index n-1 in stock order)."""
    return {'study': STUDY, 'series': series, 'sop': series + '.' + str(n), 'frame': 1, 'index': n - 1 if index is None else index, 'zoom': 100 / scale,
            'camera': {'focalPoint': [12.5, -3.25, n * 5], 'position': [12.5, -3.25, n * 5 + 100], 'viewUp': [0, -1, 0], 'viewPlaneNormal': [0, 0, 1],
                       'parallelScale': scale, 'rotation': 0, 'flipHorizontal': False, 'flipVertical': flip},
            'properties': {'voiRange': {'lower': lower, 'upper': upper}, 'VOILUTFunction': 'LINEAR', 'invert': False, 'interpolationType': 1},
            'display': display}


def view(cells, rows=1, cols=None, active=0):
    return {'version': 1, 'studies': [STUDY], 'rows': rows, 'cols': cols or len(cells) // rows, 'active': active, 'cells': cells}


SORT_DOWN = {'magnification': 'fit', 'windowing': None, 'filter': 'none', 'sort': 'position-desc', 'rotate': 0, 'flip': 'none',
             'firstImage': 'first', 'gspsAuto': False, 'overlay': 'none'}


class ViewerAutoSaveViewDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self, on=True, saved=None, cells=(('left', 'set-A'), ('right', 'set-B')), rows=1, query=''):
        context = self.browser.new_context(viewport={'width': 1366, 'height': 900})
        page = context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        url = ORIGIN + '/ohif/viewer?StudyInstanceUIDs=' + STUDY + query
        page.route(url, lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        for name in ['viewer-auto-view-model.js', 'hanging-protocol-model.js', 'viewer-image-filter.js', 'viewer-gsps.js']:
            page.route(ORIGIN + "/worklist/hpacs-lite/" + name, self.serve(HPACS / name))
        page.goto(url)
        page.add_style_tag(path=str(HPACS / "viewer-ux-theme.css"))
        for name in ["viewer-ux-shortcuts.js", "viewer-features.js", "viewer-features-view.js", "viewer-features-autosave.js", "viewer-ux-toolbar.js"]:
            page.add_script_tag(path=str(HPACS / name))
        settings = {'version': 2, 'bar': ['WindowLevel', 'Pan', 'Zoom'], 'shortcuts': {}, 'features': {'autoSaveView': True}} if on else None
        page.evaluate(SETUP, {'study': STUDY, 'owner': OWNER, 'sa': SA, 'sb': SB, 'settings': settings, 'saved': saved})
        cells = [list(c) for c in cells]
        page.evaluate("([rows, cols, cells]) => { synBuild(rows, cols, cells); synMount(); }", [rows, len(cells) // rows, cells])
        page.wait_for_function("KinViewerFeatures.settings().some(s => s.id === 'autoSaveView') && !!window.KinViewerCellRules")
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    @staticmethod
    def serve(path):
        return lambda route: route.fulfill(path=str(path), content_type="text/javascript; charset=utf-8")

    def requests(self, page):
        return [r for r in page.evaluate('synRequests') if 'viewer-auto-view' in r]

    def posts(self, page):
        return page.evaluate('synServer.posts')

    def state(self, page, cell):
        return page.evaluate(STATE, cell)

    def change(self, page, cell='left', zoom=2.5, window=(1500, -600), image=5):
        """The reader changes one cell: zoom, window and image (as the viewer's tools do)."""
        page.evaluate("""([id, zoom, w, l, image]) => { const v = synViewports.get(id);
          v.setZoom(zoom); v.setProperties({ voiRange: cornerstone.utilities.windowLevel.toLowHighRange(w, l) }); v.setImageIdIndex(image); }""",
                      [cell, zoom, window[0], window[1], image])

    def started(self, page):
        # The viewer's first layout stands for the quiet time and the module is saving (or not) from there on.
        page.wait_for_timeout(1200)

    def window(self, page, via='menu'):
        if via == 'menu':
            page.get_by_role('button', name='Display ▾').click()
            page.get_by_role('menuitem', name='Auto Save View…').click()
            panel = page.locator('section.kin-ux-feature-panel[aria-label="Auto Save View"]')
        else:
            page.get_by_role('button', name='Viewer Settings').click()
            page.locator('dialog.kin-ux-settings .kin-ux-feature-setting-buttons').get_by_role('button', name='Auto Save View…').click()
            panel = page.locator('dialog.kin-ux-feature-panel[aria-label="Auto Save View"]')
        expect(panel).to_be_visible()
        return panel

    def test_01_the_check_the_menu_and_the_window(self):
        page = self.open(on=False)
        # Viewer Settings > Tools & Display: the account check (off by default) and the window's button.
        page.get_by_role('button', name='Viewer Settings').click()
        dialog = page.locator('dialog.kin-ux-settings')
        expect(dialog.get_by_label(CHECK)).not_to_be_checked()
        expect(dialog.locator('.kin-ux-feature-setting-buttons').get_by_role('button', name='Auto Save View…')).to_be_visible()
        page.keyboard.press('Escape')
        # Display > Auto Save View...: the same switch, the last saved view of this study and Discard Saved View.
        panel = self.window(page)
        expect(panel.get_by_label(CHECK)).not_to_be_checked()
        expect(panel.locator('[data-auto-view-saved]')).to_have_text('No view of this study is saved.')
        expect(panel.get_by_role('button', name='Discard Saved View')).to_be_disabled()
        self.assertEqual([], self.posts(page))
        # Switching it on in the window saves the account setting (viewerSettings.features.autoSaveView).
        panel.get_by_label(CHECK).check()
        expect(panel.get_by_role('status')).to_have_text('On: view changes are saved and applied when this study is opened again.')
        self.assertEqual(True, page.evaluate('synServer.viewerSettings.features.autoSaveView'))

    def test_02_on_one_save_a_moment_after_the_last_change_with_the_whole_view(self):
        page = self.open()
        self.started(page)
        self.assertEqual([], self.posts(page), 'opening the viewer saves nothing')
        self.change(page, zoom=2, window=(400, 40), image=2)
        page.wait_for_timeout(800)
        self.change(page, zoom=2.5, window=(1500, -600), image=5)
        page.wait_for_timeout(1000)
        self.assertEqual([], self.posts(page), 'nothing before the view has been still for two seconds')
        page.wait_for_function('synServer.posts.length === 1', timeout=5000)
        page.wait_for_timeout(2500)
        posts = self.posts(page)
        self.assertEqual(1, len(posts), 'one save for the changes together')
        saved = posts[0]
        self.assertEqual((1, 1, 2, 0, [STUDY]), (saved['version'], saved['rows'], saved['cols'], saved['active'], saved['studies']))
        left, right = saved['cells']
        self.assertEqual((SA, SA + '.6', 1, 5), (left['series'], left['sop'], left['frame'], left['index']))
        self.assertEqual(40, left['camera']['parallelScale']); self.assertEqual(2.5, left['zoom'])
        self.assertEqual({'lower': -1350, 'upper': 149}, left['properties']['voiRange'])
        self.assertEqual((SB, SB + '.1', None), (right['series'], right['sop'], right['display']))
        # A cell's Display Set Presets rule is part of it.
        page.evaluate("KinViewerCellRules.apply('right', %s)" % json.dumps(SORT_DOWN))
        page.wait_for_function('synServer.posts.length === 2', timeout=6000)
        right = self.posts(page)[1]['cells'][1]
        self.assertEqual(SORT_DOWN, right['display'])
        self.assertEqual((SB + '.4', 0), (right['sop'], right['index']), 'the image is named by its SOP; slice position down shows image 4 first')

    def test_03_off_no_request_at_all(self):
        page = self.open(on=False, saved=view([cell(SA, 3), cell(SB, 2)]))
        self.started(page)
        self.change(page)
        page.wait_for_timeout(3000)
        self.assertEqual([], self.requests(page), 'neither read nor saved while the check is off')
        self.assertEqual('syn:set-A:6', self.state(page, 'left')['image'], 'the reader\'s own change stays; no saved view was put back')

    def test_04_reopen_puts_the_saved_view_back_and_saves_nothing_meanwhile(self):
        saved = view([cell(SA, 7, scale=26.5, lower=31, upper=192, flip=True), cell(SB, 2, display=SORT_DOWN, index=2)], active=1)
        # The viewer opens on one cell of series A; the saved view is two cells, A and B.
        page = self.open(saved=saved, cells=(('first', 'set-A'),))
        page.wait_for_function("document.querySelector('[data-auto-view-badge]')", timeout=8000)
        self.assertEqual([[1, 2]], page.evaluate('synLayouts'), 'the saved layout')
        ids = page.evaluate('[...synViewports.keys()]')
        left, right = self.state(page, ids[0]), self.state(page, ids[1])
        self.assertEqual(('syn:set-A:7', 26.5, True, {'lower': 31, 'upper': 192}), (left['image'], left['scale'], left['flipV'], left['voi']))
        self.assertEqual([12.5, -3.25, 35], left['focal'])
        # The right cell's rule went first (slice position down: 4, 3, 2, 1); its image is found by SOP in that order.
        self.assertEqual(['syn:set-B:4', 'syn:set-B:3', 'syn:set-B:2', 'syn:set-B:1'], right['ids'])
        self.assertEqual(('syn:set-B:2', 2), (right['image'], right['index']))
        self.assertEqual(ids[1], page.evaluate('synActive'))
        badge = page.locator('[data-auto-view-badge]')
        expect(badge).to_have_text('Restored saved view: Zoom 250%, W 1500 / L -310, Image 3 (2 of 2 cells)')
        # Pressing the badge opens the window, which names the saved view.
        badge.click()
        panel = page.locator('section.kin-ux-feature-panel[aria-label="Auto Save View"]')
        expect(panel.locator('[data-auto-view-saved]')).to_contain_text('2 cells · Zoom 250%, W 1500 / L -310, Image 3')
        # Putting the view back changed every cell many times: nothing was saved for it.
        page.wait_for_timeout(3000)
        self.assertEqual([], self.posts(page))
        self.assertEqual(['GET /api/studies/%s/viewer-auto-view' % STUDY], self.requests(page))
        # The badge goes after a few seconds.
        page.wait_for_function("!document.querySelector('[data-auto-view-badge]')", timeout=8000)

    def test_05_a_cell_whose_series_is_gone_is_left_and_the_badge_says_so(self):
        gone = cell(SB, 2); gone['series'] = STUDY + '.9'; gone['sop'] = STUDY + '.9.2'
        page = self.open(saved=view([cell(SA, 4), gone]))
        page.wait_for_function("document.querySelector('[data-auto-view-badge]')", timeout=8000)
        self.assertEqual([], page.evaluate('synLayouts'), 'the layout stays: not every saved series is here')
        self.assertEqual('syn:set-A:4', self.state(page, 'left')['image'])
        self.assertEqual(('syn:set-B:1', 100), (self.state(page, 'right')['image'], self.state(page, 'right')['scale']))
        expect(page.locator('[data-auto-view-badge]')).to_have_text('Restored saved view: Zoom 250%, W 1500 / L -310, Image 4 (1 of 2 cells; 1 not restored)')

    def test_06_a_job_chosen_to_open_wins(self):
        page = self.open(saved=view([cell(SA, 4), cell(SB, 2)]), query='&kinJob=00000000-0000-4000-8000-000000000001')
        self.started(page); page.wait_for_timeout(1000)
        self.assertEqual([], self.requests(page))
        self.assertEqual('syn:set-A:1', self.state(page, 'left')['image'])
        self.assertEqual(0, page.locator('[data-auto-view-badge]').count())

    def test_07_no_save_right_after_a_hanging_protocol_is_applied(self):
        page = self.open()
        self.started(page)
        page.evaluate("dispatchEvent(new CustomEvent('kin-hanging-protocol-applied', { detail: { viewportIds: ['left', 'right'], display: [null, null] } }))")
        self.change(page)
        page.wait_for_timeout(3000)
        self.assertEqual([], self.posts(page), "the cells' rules are still being put on")
        page.wait_for_function('synServer.posts.length === 1', timeout=4000)

    def test_08_discard_wins_over_a_save_on_its_way(self):
        page = self.open(saved=view([cell(SA, 3), cell(SB, 2)]))
        page.wait_for_function("document.querySelector('[data-auto-view-badge]')", timeout=8000)
        page.wait_for_timeout(300)
        page.evaluate("() => { synServer.hold = new Promise(resolve => { synServer.release = resolve; }); }")
        self.change(page)
        page.wait_for_function("synServer.log.length === 1", timeout=5000)
        # A save is on its way (its answer held back) when Discard Saved View is pressed.
        panel = self.window(page)
        panel.get_by_role('button', name='Discard Saved View').click()
        page.wait_for_timeout(300)
        self.assertEqual(['save'], page.evaluate('synServer.log'), 'Discard waits for the save on its way')
        page.evaluate("synServer.release()")
        page.wait_for_function("synServer.log.length === 3", timeout=3000)
        self.assertEqual(['save', 'saved', 'discard'], page.evaluate('synServer.log'))
        self.assertIsNone(page.evaluate('synServer.saved'))
        expect(panel.get_by_role('status')).to_have_text('The saved view of this study was discarded.')
        expect(panel.locator('[data-auto-view-saved]')).to_have_text('No view of this study is saved.')
        # The view that was on its way is not written again; the next change is.
        page.wait_for_timeout(2500)
        self.assertEqual(1, len(self.posts(page)))
        self.change(page, zoom=4, image=1)
        page.wait_for_function('synServer.posts.length === 2', timeout=5000)

    def test_09_a_patient_switch_saves_at_once(self):
        page = self.open()
        self.started(page)
        self.change(page)
        page.evaluate("document.body.classList.add('kin-patient-switching')")
        page.wait_for_function('synServer.posts.length === 1', timeout=1000)
        self.assertEqual(SA + '.6', self.posts(page)[0]['cells'][0]['sop'])


if __name__ == "__main__":
    unittest.main()
