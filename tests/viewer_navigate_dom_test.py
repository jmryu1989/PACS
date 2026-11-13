# coding: utf-8
"""Navigate menu on the shipped image toolbar: Navigation Bar, Stack / Tile, Folded / Unfolded and Multi-frame Default.

The shipped viewer-features-navigate.js runs with the shipped toolbar and feature registry (viewer_features_dom_test's
harness: synthetic OHIF services and an in-page account endpoint) beside synthetic stack cells. The synthetic
cornerstone moves a cell to the image asked for and announces it as the viewer does (STACK_NEW_IMAGE on the cell).
"""
from pathlib import Path
import unittest

from playwright.sync_api import sync_playwright, expect

from viewer_features_dom_test import HARNESS, SETUP, OWNER

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
ORIGIN = "https://viewer-navigate.test"

# Stack cells and a synthetic cornerstone: synStack(id, count, {frames, modality, at}) puts an image set in a cell.
STACKS = """() => {
  window.synJumps = []; window.synDrawn = [];
  const meta = new Map(), cells = synServices.cornerstoneViewportService;
  const announce = (v) => v.element.dispatchEvent(new CustomEvent('CORNERSTONE_STACK_NEW_IMAGE', { detail: { viewportId: v.id, imageIdIndex: v.at } }));
  for (const id of ['left', 'right']) Object.assign(cells.getCornerstoneViewport(id), { imageIds: [], at: 0,
    getImageIds() { return this.imageIds; }, getCurrentImageIdIndex() { return this.at; }, getTargetImageIdIndex() { return this.at; },
    getCurrentImageId() { return this.imageIds[this.at]; }, render() {} });
  let sets = 0;
  window.synStack = (id, count, { frames = 0, modality = 'CT', at = 0 } = {}) => {
    const v = cells.getCornerstoneViewport(id), series = '1.2.9.' + (++sets);
    v.imageIds = Array.from({ length: count }, (_, n) => frames
      ? 'wadors:/studies/1.2.3/series/' + series + '/instances/1.2.4/frames/' + (n + 1)
      : 'wadors:/studies/1.2.3/series/' + series + '/instances/1.2.5.' + n + '/frames/1');
    for (const imageId of v.imageIds) meta.set(imageId, { Modality: modality, NumberOfFrames: frames || 1 });
    v.at = at; announce(v);
  };
  // Cine as OHIF's cine service: per-cell play state, CINE_STATE_CHANGED on every change.
  const heard = [];
  window.synCine = { state: { cines: {} }, calls: [], EVENTS: { CINE_STATE_CHANGED: 'cine' },
    getState() { return this.state; },
    subscribe(event, fn) { heard.push(fn); return { unsubscribe() { heard.splice(heard.indexOf(fn), 1); } }; },
    setCine({ id, isPlaying }) { this.calls.push(['setCine', id, isPlaying]); this.state.cines[id] = { id, isPlaying }; heard.forEach(fn => fn()); },
    stopClip(element, { viewportId }) { this.calls.push(['stopClip', viewportId]); } };
  synServices.cineService = synCine;
  window.cornerstone = {
    metaData: { get: (type, imageId) => type === 'instance' ? meta.get(imageId) : undefined },
    Enums: { Events: { STACK_NEW_IMAGE: 'CORNERSTONE_STACK_NEW_IMAGE' } },
    utilities: {
      jumpToSlice: async (element, { imageIndex }) => {
        const v = ['left', 'right'].map(id => cells.getCornerstoneViewport(id)).find(v => v.element === element);
        synJumps.push([v.id, imageIndex]); v.at = imageIndex; announce(v);
      },
      loadImageToCanvas: async ({ canvas, imageId }) => { synDrawn.push(imageId); },
    },
  };
}"""

PANES = "[data-cy=viewport-pane] { width: 480px; height: 400px; }"


class ViewerNavigateDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self, settings=None, stacks=(('left', 20, {'at': 3}),)):
        context = self.browser.new_context(viewport={'width': 1366, 'height': 900})
        page = context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(ORIGIN + "/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.goto(ORIGIN + "/")
        page.add_style_tag(path=str(HPACS / "viewer-ux-theme.css"))
        page.add_style_tag(content=PANES)
        for name in ["viewer-ux-shortcuts.js", "viewer-features.js", "viewer-ux-toolbar.js"]:
            page.add_script_tag(path=str(HPACS / name))
        page.evaluate(SETUP, OWNER)
        page.evaluate("settings => { synServer.viewerSettings = settings; }", settings or {'version': 2, 'bar': ['Zoom'], 'shortcuts': {}})
        page.evaluate(STACKS)
        page.add_script_tag(path=str(HPACS / "viewer-features-navigate.js"))
        page.evaluate("() => synMount()")
        expect(page.locator('.kin-ux-toolbar-settings [role=status]')).to_have_text('계정 설정 · 다른 PC에서도 적용됩니다.')
        for id, count, options in stacks:
            page.evaluate("([id, count, options]) => synStack(id, count, options)", [id, count, options])
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    def menu(self, page, item):
        page.get_by_role('button', name='Navigate ▾').click()
        page.get_by_role('menu', name='Navigate').get_by_role('menuitem', name=item).click()

    def labels(self, page, pane='left'):
        return page.locator('#pane-' + pane + ' .kin-nav-tiles button').evaluate_all('n => n.map(b => b.getAttribute("aria-label"))')

    def current(self, page, pane='left'):
        return page.locator('#pane-' + pane + ' .kin-nav-tiles button[aria-current=true]').evaluate_all('n => n.map(b => b.getAttribute("aria-label"))')

    def at(self, page, id='left'):
        return page.evaluate("id => synServices.cornerstoneViewportService.getCornerstoneViewport(id).at", id)

    # ── Pure: bar position ↔ image, typed number, grid size and pages, the stored table ──
    def test_01_pure_bar_number_grid_and_table(self):
        page = self.open(stacks=())
        result = page.evaluate("""() => { const m = KinViewerNavigateModel; return {
          indexAt: [m.indexAt(0, 100, 20), m.indexAt(100, 100, 20), m.indexAt(50, 100, 20), m.indexAt(-5, 100, 20), m.indexAt(120, 100, 20), m.indexAt(50, 100, 1)],
          fraction: [m.fraction(0, 20), m.fraction(19, 20), m.fraction(12, 20), m.fraction(0, 1)],
          typed: [m.typed('13', 20), m.typed('99', 20), m.typed('0', 20), m.typed(' 7 ', 20), m.typed('', 20), m.typed('1.5', 20), m.typed('-3', 20)],
          grid: [m.grid(480, 400, 20, 3), m.grid(200, 150, 20, 3), m.grid(480, 400, 4, 3), m.grid(480, 400, 24, 4), m.grid(50, 50, 20, 4)],
          first: [m.first(12, 20, 9), m.first(0, 24, 16), m.first(19, 24, 16), m.first(3, 5, 9)],
          scroll: [m.scroll(11, -3, 20, 9), m.scroll(8, 3, 20, 9), m.scroll(0, -4, 24, 16), m.scroll(8, 4, 24, 16)],
          follow: [m.follow(0, 12, 20, 9), m.follow(5, 2, 20, 9), m.follow(5, 9, 20, 9)],
          defaults: [m.defaults(undefined), m.defaults({ XA: 'unfolded', MR: 'sideways', CT: 'unfolded' })],
        }; }""")
        self.assertEqual([0, 19, 10, 0, 19, 0], result['indexAt'])
        self.assertEqual([0, 1, 12 / 19, 0], result['fraction'])
        self.assertEqual([12, 19, 0, 6, None, None, None], result['typed'])
        self.assertEqual([{'columns': 3, 'rows': 3, 'size': 9}, {'columns': 2, 'rows': 1, 'size': 2}, {'columns': 3, 'rows': 2, 'size': 6},
                          {'columns': 4, 'rows': 4, 'size': 16}, {'columns': 1, 'rows': 1, 'size': 1}], result['grid'])
        self.assertEqual([11, 0, 8, 0], result['first'])
        self.assertEqual([8, 11, 0, 8], result['scroll'])
        self.assertEqual([4, 2, 5], result['follow'])
        self.assertEqual({'XA': 'folded', 'US': 'folded', 'MR': 'unfolded', 'NM': 'unfolded', 'OT': 'unfolded'}, result['defaults'][0])
        self.assertEqual({'XA': 'unfolded', 'US': 'folded', 'MR': 'unfolded', 'NM': 'unfolded', 'OT': 'unfolded'}, result['defaults'][1])

    # ── Navigation Bar: number + Enter, out of range, drag, off keeps the image ──
    def test_02_navigation_bar_number_enter_drag_and_off(self):
        page = self.open()
        page.get_by_role('button', name='Navigate ▾').click()
        menu = page.get_by_role('menu', name='Navigate')
        expect(menu.get_by_role('menuitem')).to_have_text(['Navigation Bar', 'Stack / Tile', 'Folded / Unfolded'])
        expect(menu.get_by_role('menuitem', name='Folded / Unfolded')).to_be_disabled()
        menu.get_by_role('menuitem', name='Navigation Bar').click()
        bar = page.locator('#pane-left').get_by_role('group', name='Navigation Bar')
        expect(bar).to_be_visible()
        box = bar.get_by_role('spinbutton', name='Image Number')
        expect(box).to_have_value('4'); expect(bar.locator('small')).to_have_text('/ 20')
        expect(bar.get_by_role('slider', name='Image Position')).to_have_attribute('aria-valuenow', '4')
        # The bar sits at the right edge of the cell.
        edge = page.evaluate("() => { const p = document.getElementById('pane-left').getBoundingClientRect(), b = document.querySelector('#pane-left .kin-nav-bar').getBoundingClientRect(); return [p.right - b.right, b.left > p.left + p.width / 2]; }")
        self.assertLess(edge[0], 80); self.assertTrue(edge[1])
        box.fill('13')
        expect(box).to_have_value('13')
        self.assertEqual([], page.evaluate('synJumps'), 'typing does not move the image')
        box.press('Enter')
        page.wait_for_function("() => synJumps.length === 1")
        self.assertEqual([['left', 12]], page.evaluate('synJumps'))
        expect(bar.get_by_role('slider', name='Image Position')).to_have_attribute('aria-valuenow', '13')
        expect(box).to_have_value('13')
        # Past either end is the end; an empty box moves nothing and shows the image again.
        box.fill('99'); box.press('Enter'); page.wait_for_function("() => synJumps.length === 2")
        expect(box).to_have_value('20')
        box.fill('0'); box.press('Enter'); page.wait_for_function("() => synJumps.length === 3")
        expect(box).to_have_value('1')
        box.fill(''); box.press('Enter')
        expect(box).to_have_value('1')
        self.assertEqual([['left', 12], ['left', 19], ['left', 0]], page.evaluate('synJumps'))
        # Dragging the bar: the bottom is the last image, the top the first; the box follows.
        track = bar.get_by_role('slider', name='Image Position').bounding_box()
        page.mouse.move(track['x'] + track['width'] / 2, track['y'] + track['height'] - 1)
        page.mouse.down()
        page.wait_for_function("() => synJumps.at(-1)[1] === 19")
        page.mouse.move(track['x'] + track['width'] / 2, track['y'] + track['height'] / 2, steps=4)
        page.mouse.move(track['x'] + track['width'] / 2, track['y'] + 1, steps=4)
        page.mouse.up()
        page.wait_for_function("() => synJumps.at(-1)[1] === 0")
        expect(box).to_have_value('1')
        self.assertEqual(0, self.at(page))
        # The keyboard moves it too.
        bar.get_by_role('slider', name='Image Position').focus(); page.keyboard.press('ArrowDown')
        page.wait_for_function("() => synJumps.at(-1)[1] === 1")
        expect(box).to_have_value('2')
        # Pressed again, the bar goes and the image stays.
        jumps = len(page.evaluate('synJumps'))
        self.menu(page, 'Navigation Bar')
        expect(page.locator('.kin-nav-bar')).to_have_count(0)
        self.assertEqual(1, self.at(page))
        self.assertEqual(jumps, len(page.evaluate('synJumps')))
        # The other cell's bar is its own.
        page.evaluate("() => synStack('right', 6, { at: 2 })")
        page.evaluate("() => { synActive = 'right'; }")
        self.menu(page, 'Navigation Bar')
        expect(page.locator('#pane-right .kin-nav-bar input')).to_have_value('3')
        expect(page.locator('#pane-left .kin-nav-bar')).to_have_count(0)

    # ── Stack / Tile: the switch, a grid that fits the cell, a tile chosen is the image Stack shows ──
    def test_03_tile_choose_a_tile_and_stack_shows_it(self):
        page = self.open(stacks=(('left', 20, {'at': 12}),))
        self.menu(page, 'Navigation Bar')
        self.menu(page, 'Stack / Tile')
        switch = page.locator('#pane-left').get_by_role('group', name='Stack / Tile')
        expect(switch.get_by_role('button')).to_have_text(['Stack', 'Tile'])
        expect(switch.get_by_role('button', name='Stack')).to_have_attribute('aria-pressed', 'true')
        expect(page.locator('.kin-nav-tiles')).to_have_count(0)
        self.assertEqual(12, self.at(page), 'the menu changes nothing on the image')
        switch.get_by_role('button', name='Tile').click()
        self.assertEqual(['Image ' + str(n) for n in range(12, 21)], self.labels(page))
        self.assertEqual(['Image 13'], self.current(page))
        self.assertEqual(3, page.evaluate("() => getComputedStyle(document.querySelector('.kin-nav-tiles')).gridTemplateColumns.split(' ').length"))
        self.assertEqual(9, len(page.evaluate('synDrawn')))
        self.assertTrue(all('/instances/1.2.5.' in drawn for drawn in page.evaluate('synDrawn')))
        # The bar and the switch stay above the tiles.
        expect(page.locator('#pane-left .kin-nav-bar input')).to_be_visible()
        expect(switch.get_by_role('button', name='Stack')).to_be_visible()
        page.locator('#pane-left .kin-nav-tiles').get_by_role('button', name='Image 16').click()
        page.wait_for_function("() => synJumps.length === 1")
        self.assertEqual([['left', 15]], page.evaluate('synJumps'))
        self.assertEqual(['Image 16'], self.current(page))
        self.assertEqual(['Image ' + str(n) for n in range(12, 21)], self.labels(page), 'the grid stays where it was')
        expect(page.locator('#pane-left .kin-nav-bar input')).to_have_value('16')
        # The wheel moves the grid a row; every image can be reached.
        page.locator('#pane-left .kin-nav-tiles').hover()
        page.mouse.wheel(0, -100)
        expect(page.locator('#pane-left .kin-nav-tiles button').first).to_have_attribute('aria-label', 'Image 9')
        for _ in range(4): page.mouse.wheel(0, -100)
        expect(page.locator('#pane-left .kin-nav-tiles button').first).to_have_attribute('aria-label', 'Image 1')
        self.assertEqual(15, self.at(page), 'the wheel on the grid does not move the image')
        # The bar takes the image out of the grid: the grid follows it.
        box = page.locator('#pane-left .kin-nav-bar input'); box.fill('18'); box.press('Enter')
        page.wait_for_function("() => synJumps.length === 2")
        self.assertIn('Image 18', self.labels(page)); self.assertEqual(['Image 18'], self.current(page))
        page.locator('#pane-left .kin-nav-tiles').get_by_role('button', name='Image 16').click()
        page.wait_for_function("() => synJumps.length === 3")
        switch.get_by_role('button', name='Stack').click()
        expect(page.locator('.kin-nav-tiles')).to_have_count(0)
        self.assertEqual(15, self.at(page))
        expect(switch.get_by_role('button', name='Stack')).to_have_attribute('aria-pressed', 'true')
        self.menu(page, 'Stack / Tile')
        expect(page.locator('.kin-nav-switch')).to_have_count(0)
        self.assertEqual(15, self.at(page))

    # ── Folded / Unfolded on a multi-frame image ──
    def test_04_unfolded_lays_out_every_frame_and_folded_returns_to_the_frame(self):
        page = self.open(stacks=(('left', 24, {'frames': 24, 'modality': 'XA'}),))
        page.get_by_role('button', name='Navigate ▾').click()
        menu = page.get_by_role('menu', name='Navigate')
        expect(menu.get_by_role('menuitem', name='Stack / Tile')).to_be_disabled()
        expect(page.locator('.kin-nav-tiles')).to_have_count(0)  # XA opens Folded by default
        menu.get_by_role('menuitem', name='Folded / Unfolded').click()
        switch = page.locator('#pane-left').get_by_role('group', name='Folded / Unfolded')
        expect(switch.get_by_role('button')).to_have_text(['Folded (Cine)', 'Unfolded'])
        expect(switch.get_by_role('button', name='Folded (Cine)')).to_have_attribute('aria-pressed', 'true')
        switch.get_by_role('button', name='Unfolded').click()
        self.assertEqual(['Frame ' + str(n) for n in range(1, 17)], self.labels(page))
        self.assertEqual(['Frame 1'], self.current(page))
        self.assertTrue(all('/instances/1.2.4/frames/' in drawn for drawn in page.evaluate('synDrawn')))
        page.locator('#pane-left .kin-nav-tiles').hover()
        for _ in range(3): page.mouse.wheel(0, 100)
        expect(page.locator('#pane-left .kin-nav-tiles button').last).to_have_attribute('aria-label', 'Frame 24')
        self.assertEqual(['Frame ' + str(n) for n in range(9, 25)], self.labels(page))
        page.locator('#pane-left .kin-nav-tiles').get_by_role('button', name='Frame 20').click()
        page.wait_for_function("() => synJumps.length === 1")
        switch.get_by_role('button', name='Folded (Cine)').click()
        expect(page.locator('.kin-nav-tiles')).to_have_count(0)
        self.assertEqual(19, self.at(page))
        # A single-frame series offers Stack / Tile, not Folded / Unfolded.
        page.evaluate("() => synStack('left', 5)")
        expect(page.locator('.kin-nav-switch')).to_have_count(0)
        page.get_by_role('button', name='Navigate ▾').click()
        expect(menu.get_by_role('menuitem', name='Folded / Unfolded')).to_be_disabled()
        expect(menu.get_by_role('menuitem', name='Stack / Tile')).to_be_enabled()

    # ── The default by modality: built in, saved in the account, applied when a multi-frame image is put in a cell ──
    def test_05_multiframe_default_saved_and_applied_when_opened(self):
        page = self.open(stacks=(('right', 10, {'frames': 10, 'modality': 'MR'}),))
        right = page.locator('#pane-right')
        expect(right.get_by_role('group', name='Folded / Unfolded').get_by_role('button', name='Unfolded')).to_have_attribute('aria-pressed', 'true')
        self.assertEqual(['Frame ' + str(n) for n in range(1, 11)], self.labels(page, 'right'))
        # Folded / Unfolded on that cell closes the switch back to one frame at a time.
        page.evaluate("() => { synActive = 'right'; }")
        self.menu(page, 'Folded / Unfolded')
        expect(right.locator('.kin-nav-switch, .kin-nav-tiles')).to_have_count(0)
        # Viewer Settings › Multi-frame Default…: the table, saved on change, Close back to Viewer Settings.
        page.get_by_role('button', name='Viewer Settings').click()
        settings = page.locator('dialog.kin-ux-settings')
        settings.locator('.kin-ux-feature-setting-buttons').get_by_role('button', name='Multi-frame Default…').click()
        window = page.locator('dialog.kin-ux-feature-panel[aria-label="Multi-frame Default"]')
        expect(window).to_be_visible()
        expect(window.locator('tbody th')).to_have_text(['XA', 'US', 'MR', 'NM', 'OT'])
        self.assertEqual(['folded', 'folded', 'unfolded', 'unfolded', 'unfolded'], window.locator('select').evaluate_all('n => n.map(s => s.value)'))
        expect(window.get_by_role('combobox', name='XA Open as').locator('option')).to_have_text(['Folded (Cine)', 'Unfolded'])
        window.get_by_role('combobox', name='XA Open as').select_option('unfolded')
        expect(window.get_by_role('status')).to_have_text('계정에 저장했습니다.')
        put = page.evaluate('synServer.puts.at(-1)')
        self.assertEqual(3, put['revision'])
        self.assertEqual({'XA': 'unfolded', 'US': 'folded', 'MR': 'unfolded', 'NM': 'unfolded', 'OT': 'unfolded'}, put['viewerSettings']['features']['multiframeDefault'])
        # A second change in the same window saves at the revision of its own first save.
        window.get_by_role('combobox', name='MR Open as').select_option('folded')
        expect(window.get_by_role('status')).to_have_text('계정에 저장했습니다.')
        self.assertEqual(4, page.evaluate('synServer.puts.at(-1).revision'))
        # Another window saved meanwhile: the conflict reads the account again, shows what is stored there and the
        # next change saves at the revision read.
        page.evaluate("() => { synServer.revision = 20; synServer.viewerSettings = { ...synServer.viewerSettings, features: { multiframeDefault: { XA: 'unfolded', MR: 'folded', NM: 'folded' } } }; }")
        window.get_by_role('combobox', name='US Open as').select_option('unfolded')
        expect(window.get_by_role('status')).to_have_text('저장하지 못해 계정에 저장된 값을 다시 읽었습니다. 다시 고르세요.')
        self.assertEqual(['unfolded', 'folded', 'folded', 'folded', 'unfolded'], window.locator('select').evaluate_all('n => n.map(s => s.value)'))
        expect(window.locator('select:disabled')).to_have_count(0)
        window.get_by_role('combobox', name='NM Open as').select_option('unfolded')
        expect(window.get_by_role('status')).to_have_text('계정에 저장했습니다.')
        put = page.evaluate('synServer.puts.at(-1)')
        self.assertEqual(20, put['revision'])
        self.assertEqual({'XA': 'unfolded', 'US': 'folded', 'MR': 'folded', 'NM': 'unfolded', 'OT': 'unfolded'}, put['viewerSettings']['features']['multiframeDefault'])
        # While a save is on its way the five boxes wait.
        page.evaluate("() => { window.synRelease = null; synServer.hold = new Promise(r => { synRelease = r; }); }")
        window.get_by_role('combobox', name='OT Open as').select_option('folded')
        expect(window.locator('select:disabled')).to_have_count(5)
        page.evaluate("() => { synServer.hold = null; synRelease(); }")
        expect(window.locator('select:disabled')).to_have_count(0)
        expect(window.get_by_role('combobox', name='OT Open as')).to_have_value('folded')
        window.get_by_role('button', name='Close').click()
        expect(window).to_have_count(0); expect(settings).to_be_visible()
        settings.get_by_role('button', name='Cancel').click()
        # Applied when the next image is opened: XA now Unfolded, MR Folded.
        page.evaluate("() => synStack('left', 12, { frames: 12, modality: 'XA' })")
        expect(page.locator('#pane-left').get_by_role('group', name='Folded / Unfolded').get_by_role('button', name='Unfolded')).to_have_attribute('aria-pressed', 'true')
        self.assertEqual(12, len(self.labels(page)))
        page.evaluate("() => synStack('right', 8, { frames: 8, modality: 'MR' })")
        expect(right.locator('.kin-nav-switch, .kin-nav-tiles')).to_have_count(0)

    def test_06_account_table_read_at_open_and_a_new_image_set_ends_tile_but_keeps_the_bar(self):
        page = self.open(settings={'version': 2, 'bar': ['Zoom'], 'shortcuts': {}, 'features': {'multiframeDefault': {'MR': 'folded', 'XA': 'unfolded'}}},
                         stacks=(('left', 20, {'at': 4}), ('right', 10, {'frames': 10, 'modality': 'MR'})))
        expect(page.locator('#pane-right .kin-nav-tiles')).to_have_count(0)
        self.menu(page, 'Navigation Bar'); self.menu(page, 'Stack / Tile')
        page.locator('#pane-left').get_by_role('button', name='Tile').click()
        expect(page.locator('#pane-left .kin-nav-tiles')).to_be_visible()
        page.evaluate("() => synStack('left', 5, { at: 1 })")
        expect(page.locator('#pane-left .kin-nav-tiles, #pane-left .kin-nav-switch')).to_have_count(0)
        expect(page.locator('#pane-left .kin-nav-bar small')).to_have_text('/ 5')
        expect(page.locator('#pane-left .kin-nav-bar input')).to_have_value('2')
        page.evaluate("() => synStack('left', 6, { frames: 6, modality: 'XA' })")
        expect(page.locator('#pane-left').get_by_role('button', name='Unfolded')).to_have_attribute('aria-pressed', 'true')

    # ── Cine: a move by hand and laying the frames out stop it; Play on a laid-out cell goes back to Folded ──
    def test_08_cine_stops_for_moves_and_unfolding_and_play_folds(self):
        page = self.open(stacks=(('left', 24, {'frames': 24, 'modality': 'XA', 'at': 5}),))
        page.evaluate("() => synCine.setCine({ id: 'left', isPlaying: true })")
        self.menu(page, 'Navigation Bar')
        box = page.locator('#pane-left .kin-nav-bar input'); box.fill('12'); box.press('Enter')
        page.wait_for_function("() => synJumps.length === 1")
        self.assertEqual([['setCine', 'left', True], ['stopClip', 'left'], ['setCine', 'left', False]], page.evaluate('synCine.calls'))
        page.evaluate("() => { synCine.calls.length = 0; synCine.setCine({ id: 'left', isPlaying: true }); }")
        self.menu(page, 'Folded / Unfolded')
        self.assertEqual(['setCine'], [c[0] for c in page.evaluate('synCine.calls')], 'showing the switch does not stop it')
        page.locator('#pane-left').get_by_role('button', name='Unfolded').click()
        expect(page.locator('#pane-left .kin-nav-tiles')).to_be_visible()
        self.assertEqual([['setCine', 'left', True], ['stopClip', 'left'], ['setCine', 'left', False]], page.evaluate('synCine.calls'))
        self.assertEqual(['Frame 12'], self.current(page))
        page.evaluate("() => synCine.setCine({ id: 'left', isPlaying: true })")
        expect(page.locator('#pane-left .kin-nav-tiles')).to_have_count(0)
        expect(page.locator('#pane-left').get_by_role('button', name='Folded (Cine)')).to_have_attribute('aria-pressed', 'true')
        self.assertTrue(page.evaluate("synCine.state.cines.left.isPlaying"), 'it plays, folded')

    def test_07_dispose_leaves_nothing(self):
        page = self.open()
        self.menu(page, 'Navigation Bar'); self.menu(page, 'Stack / Tile')
        page.locator('#pane-left').get_by_role('button', name='Tile').click()
        page.evaluate("() => synToolbar.dispose()")
        self.assertEqual(0, page.evaluate("() => document.querySelectorAll('.kin-nav-bar, .kin-nav-switch, .kin-nav-tiles, .kin-ux-cell-layer').length"))
        self.assertFalse(page.evaluate("() => [...document.querySelectorAll('style')].some(s => s.textContent.includes('.kin-nav-bar'))"))
        page.evaluate("() => synStack('left', 4, { frames: 4, modality: 'MR' })")
        self.assertEqual(0, page.evaluate("() => document.querySelectorAll('.kin-nav-tiles').length"))


if __name__ == "__main__":
    unittest.main()
