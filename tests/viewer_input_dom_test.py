# coding: utf-8
"""A1 04-3 Mouse & Wheel, 04-5 Context Toolbar and 04-6 F.Leader on the shipped viewer toolbar.

The shipped viewer-ux-shortcuts.js, viewer-features.js, viewer-features-input.js and viewer-ux-toolbar.js (with
viewer-ux-theme.css) and the stack mouse of config/ohif/viewer-ux.js run in Chromium beside synthetic OHIF services,
two synthetic stack cells with a synthetic tool group that keeps the pinned engine's binding rules, and an in-page
account settings endpoint with the revision and owner contract of /api/workspace-shortcuts. The real wheel, drag and
image changes are in tests/e2e/test_viewer_tools.py.
"""
from pathlib import Path
import unittest

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
ORIGIN = "https://viewer-input.test"
OWNER = ['syn-site', 'syn-reader']

HARNESS = """<!doctype html><html><head><style>
body { margin: 0; background: #111; --kin-panel: #222; --kin-ux-text: #eee; --kin-ux-secondary: #999; --kin-accent: #6cf; }
#grid { position: absolute; left: 0; top: 120px; display: flex; }
[data-cy=viewport-pane] { position: relative; width: 300px; height: 240px; overflow: hidden; }
.viewport-element { position: absolute; inset: 0; }
</style></head><body><div id="root"><div class="kin-ux-toolbar-slot"></div><div id="grid"></div></div>
<input id="note" aria-label="Note" style="position:absolute;left:700px;top:10px"></body></html>"""

SETUP = """owner => {
  window.synInteractions = []; window.synEnded = false; window.synActive = 'left'; window.synNotes = [];
  window.synMoves = []; window.synNativeKeys = []; window.synMenus = 0; window.synRuns = [];
  // One stack tool group for both cells, with the pinned engine's binding rules: setToolPassive removes the given
  // bindings (default: primary) and leaves a tool with bindings left Active; setToolActive adds bindings.
  const options = { WindowLevel: { mode: 'Active', bindings: [{ mouseButton: 1 }] }, Pan: { mode: 'Active', bindings: [{ mouseButton: 4 }] },
    Zoom: { mode: 'Active', bindings: [{ mouseButton: 2 }] }, StackScroll: { mode: 'Active', bindings: [{ mouseButton: 524288 }] },
    Length: { mode: 'Passive', bindings: [] }, Angle: { mode: 'Passive', bindings: [] }, EllipticalROI: { mode: 'Passive', bindings: [] } };
  const same = (a, b) => a.mouseButton === b.mouseButton && a.modifierKey === b.modifierKey;
  window.synGroup = { toolOptions: options,
    hasTool: name => !!options[name], getViewportsInfo: () => ['left', 'right'].map(viewportId => ({ viewportId, renderingEngineId: 'engine' })),
    getActivePrimaryMouseButtonTool: () => Object.keys(options).find(name => options[name].mode === 'Active' && options[name].bindings.some(b => b.mouseButton === 1 && !b.modifierKey)),
    setToolPassive(name, { removeAllBindings = [{ mouseButton: 1 }] } = {}) {
      const option = options[name]; option.bindings = option.bindings.filter(binding => !removeAllBindings.some(b => same(b, binding)));
      option.mode = option.bindings.length ? 'Active' : 'Passive';
    },
    setToolActive(name, { bindings = [] } = {}) {
      const option = options[name]; option.mode = 'Active';
      for (const binding of bindings) if (!option.bindings.some(b => same(b, binding))) option.bindings.push(binding);
    },
    setViewportsCursorByToolName() {} };
  window.synButtons = (name, button) => Object.keys(options).filter(tool => options[tool].bindings.some(b => b.mouseButton === button));
  const viewports = new Map();
  for (const id of ['left', 'right']) {
    const pane = document.createElement('div'); pane.dataset.cy = 'viewport-pane'; pane.id = 'pane-' + id;
    const element = document.createElement('div'); element.className = 'viewport-element';
    pane.append(element); document.getElementById('grid').append(pane);
    viewports.set(id, { id, type: 'stack', renderingEngineId: 'engine', element });
  }
  // What the image cells' native handlers see: a right-button motion (W/L) and the context menu.
  document.addEventListener('mousemove', event => { if (event.buttons & 2) synMoves.push([event.clientX, event.clientY]); });
  document.addEventListener('contextmenu', () => synMenus++);
  document.addEventListener('keydown', event => synNativeKeys.push(event.key));
  window.cornerstone = { eventTarget: new EventTarget(), Enums: { Events: { ELEMENT_ENABLED: 'enabled' } },
    getRenderingEngine: () => ({ getViewport: id => viewports.get(id) }) };
  window.cornerstoneTools = { Enums: { MouseBindings: { Primary: 1, Secondary: 2, Primary_And_Secondary: 3, Auxiliary: 4, Wheel: 524288 } },
    ToolGroupManager: { getToolGroupForViewport: () => synGroup }, utilities: { scroll() {} } };
  window.kinViewerSession = { ended: () => synEnded };
  const listeners = new Map();
  const events = name => ({ subscribe(event, fn) { const key = name + event; listeners.set(key, [...(listeners.get(key) || []), fn]);
    return { unsubscribe() { listeners.set(key, (listeners.get(key) || []).filter(f => f !== fn)); } }; } });
  window.synEmit = (name, event, payload) => { for (const fn of listeners.get(name + event) || []) fn(payload); };
  const grid = { ...events('grid'), EVENTS: { ACTIVE_VIEWPORT_ID_CHANGED: 'active', GRID_STATE_CHANGED: 'gridState' },
    getActiveViewportId: () => synActive, setActiveViewportId: id => { synActive = id; },
    getState: () => ({ viewports: new Map([['left', { displaySetInstanceUIDs: ['a'] }], ['right', { displaySetInstanceUIDs: ['b'] }]]) }) };
  const tool = (id, label, commands = 'setToolActiveToolbar') => [id, { id, uiType: 'ohif.radioGroup', props: { label, commands } }];
  window.synCatalog = Object.fromEntries([tool('WindowLevel', 'Window / Level'), tool('Pan', 'Pan'), tool('Zoom', 'Zoom'), tool('StackScroll', 'Stack Scroll'),
    tool('Length', 'Length'), tool('Angle', 'Angle'), tool('EllipticalROI', 'Ellipse'), tool('invert', 'Invert', 'invertViewport')]);
  window.synServices = {
    viewportGridService: grid,
    cornerstoneViewportService: { ...events('cells'), EVENTS: { VIEWPORT_DATA_CHANGED: 'data' }, getCornerstoneViewport: id => viewports.get(id) },
    uiNotificationService: { show: note => synNotes.push(note) },
    toolbarService: {
      EVENTS: { TOOL_BAR_MODIFIED: 'modified' },
      getButtonSection: () => Object.keys(synCatalog).map(id => ({ id })), getButtons: () => synCatalog,
      getButtonProps: id => synCatalog[id] && { id, ...synCatalog[id].props, isActive: synGroup.getActivePrimaryMouseButtonTool() === id },
      // As the stock toolbar selects a tool: the old primary tool goes passive and the new one takes the primary button.
      recordInteraction: (item, options) => {
        synInteractions.push([item.itemId, options?.refreshProps?.viewportId]);
        if (!synGroup.hasTool(item.itemId)) return;
        const previous = synGroup.getActivePrimaryMouseButtonTool(); if (previous) synGroup.setToolPassive(previous);
        synGroup.setToolActive(item.itemId, { bindings: [{ mouseButton: 1 }] });
      },
      refreshToolbarState() {}, subscribe: () => ({ unsubscribe() {} }),
    },
  };
  window.synCommands = { runCommand() {} };
  window.kinViewerHistoryWorkspaceState = () => ({ busy: false });
  window.kinViewerJobWorkspaceState = () => ({ busy: false });
  window.KinViewerHangingSettings = { modalities: [], defaults: {}, get: () => ({}),
    mount: () => ({ apply() {}, dispose() {} }), mountSizing: () => ({ dispose() {} }) };
  window.KinSessionTransport = { refusal: () => false, responseError: () => new Error('ended') };
  window.synServer = { revision: 3, viewerSettings: null, puts: [] };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, init = {}) => {
    const s = synServer;
    if (!String(url).endsWith('/api/workspace-shortcuts')) return reply(404, {});
    if ((init.method || 'GET') === 'GET') return reply(200, { owner, revision: s.revision, viewerSettings: structuredClone(s.viewerSettings) });
    const body = JSON.parse(init.body); s.puts.push(body);
    if (body.revision !== s.revision) return reply(409, { message: '계정 설정이 변경되었습니다. 불러온 뒤 다시 저장하세요' });
    s.revision++; s.viewerSettings = body.viewerSettings;
    return reply(200, { owner, revision: s.revision, viewerSettings: structuredClone(s.viewerSettings) });
  };
  window.synSession = { owner: () => owner, ended: () => synEnded, writer: () => true, state: () => 'confirmed', decide: async () => {} };
  window.synMount = () => {
    // As config/ohif/viewer-ux.js enters a mode: the stack mouse, then the toolbar, with the single-key layer beside it.
    window.synMouse = kinStackMouse(synServices);
    window.synToolbar = KinViewerUXToolbar.mount({ services: synServices, commands: synCommands, session: synSession });
    window.synKeys ||= KinViewerUXShortcuts.mount({ getBindings: () => synToolbar.bindings(), invoke: id => synToolbar.invoke(id), allowed: () => !synEnded });
  };
  window.synUnmount = () => { synToolbar.dispose(); synMouse.dispose(); };
}"""

# Another feature module with Measure items (as the measure feature files will register), first in the Measure area.
MEASURE = """count => {
  KinViewerFeatures.module('measure', ({ ui }) => {
    for (let n = 0; n < count; n++) ui.menuItem('Measure', { id: 'synMeasure' + n, label: n ? 'Measure ' + n : 'CTR', order: n,
      run: ({ viewportId }) => synRuns.push(['synMeasure' + n, viewportId]) });
  });
}"""


class ViewerInputDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self, settings=None, measure=0, size=(1366, 900)):
        context = self.browser.new_context(viewport={'width': size[0], 'height': size[1]})
        page = context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(ORIGIN + "/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.goto(ORIGIN + "/")
        page.add_style_tag(path=str(HPACS / "viewer-ux-theme.css"))
        page.add_script_tag(path=str(ROOT / "config/ohif/viewer-ux.js"))
        for name in ["viewer-ux-shortcuts.js", "viewer-features.js", "viewer-features-input.js", "viewer-ux-toolbar.js"]:
            page.add_script_tag(path=str(HPACS / name))
        page.evaluate(SETUP, OWNER)
        page.evaluate("settings => { synServer.viewerSettings = settings; }", settings)
        if measure:
            page.evaluate(MEASURE, measure)
        page.evaluate("() => synMount()")
        expect(page.locator('.kin-ux-toolbar-settings [role=status]')).to_have_text('계정 설정 · 다른 PC에서도 적용됩니다.')
        page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    def buttons(self, page, button):
        return page.evaluate("b => synButtons(null, b)", button)

    def settings(self, page):
        page.get_by_role('button', name='Viewer Settings').click()
        dialog = page.locator('dialog.kin-ux-settings')
        expect(dialog).to_be_visible()
        return dialog

    def center(self, page, cell):
        box = page.locator('#pane-' + cell).bounding_box()
        return box['x'] + box['width'] / 2, box['y'] + box['height'] / 2

    # ── 04-3 Mouse & Wheel ──
    def test_01_mouse_and_wheel_form_apply_saves_and_rebinds_the_open_group(self):
        page = self.open()
        # Entry: the stack bindings as before the choice existed.
        self.assertEqual([['StackScroll'], ['WindowLevel'], [], ['Pan']], [self.buttons(page, b) for b in (1, 2, 3, 4)])
        dialog = self.settings(page)
        section = dialog.locator('fieldset.kin-ux-feature-settings')
        expect(section.locator('legend')).to_have_text('Tools & Display')
        expect(section.get_by_role('checkbox', name='Space opens F.Leader')).not_to_be_checked()
        expect(section.locator('.kin-ux-feature-setting')).to_have_text(['Mouse & Wheel…', 'Context Toolbar…'])
        section.get_by_role('button', name='Mouse & Wheel…').click()
        panel = page.locator('dialog[data-feature-panel=mouse]')
        expect(panel).to_be_visible()
        labels = panel.locator('select, input').evaluate_all('n => n.map(i => i.getAttribute("aria-label"))')
        self.assertEqual(['Left button', 'Middle button', 'Right button', 'Left + Right', 'Default tool', 'Wheel step', 'Wrap at ends', 'Ctrl+wheel zoom'], labels)
        values = panel.locator('select').evaluate_all('n => n.map(s => s.selectedOptions[0].textContent)')
        self.assertEqual(['Stack Scroll', 'Pan', 'W/L', 'None', 'Stack Scroll', '1 image', 'Off'], values)
        expect(panel.get_by_role('checkbox', name='Wrap at ends')).not_to_be_checked()
        panel.get_by_label('Right button').select_option(label='W/L')
        panel.get_by_label('Wheel step').select_option(label='1 image')
        panel.get_by_label('Left + Right').select_option(label='Pan')
        panel.get_by_label('Middle button').select_option(label='Zoom')
        panel.get_by_label('Wheel step').select_option(label='3 images')
        panel.get_by_role('checkbox', name='Wrap at ends').check()
        panel.get_by_label('Ctrl+wheel zoom').select_option(label='10%')
        panel.get_by_role('button', name='Apply').click()
        expect(panel.get_by_role('status')).to_have_text('적용했습니다. 계정에 저장했습니다.')
        put = page.evaluate('synServer.puts.at(-1)')
        self.assertEqual({'middle': 'Zoom', 'right': 'WindowLevel', 'both': 'Pan', 'defaultTool': 'StackScroll', 'wheelStep': 3, 'wrap': True, 'ctrlZoom': 10},
                         put['viewerSettings']['features']['mouse'])
        # The group that was already open has the new buttons at once.
        self.assertEqual([['StackScroll'], ['WindowLevel'], ['Pan'], ['Zoom']], [self.buttons(page, b) for b in (1, 2, 3, 4)])
        self.assertEqual({'wheelStep': 3, 'wrap': True, 'ctrlZoom': 10}, page.evaluate("() => { const s = synMouse.settings(); return { wheelStep: s.wheelStep, wrap: s.wrap, ctrlZoom: s.ctrlZoom }; }"))
        # Left button now: W/L on the left at once; the saved default tool stays Stack Scroll.
        panel.get_by_label('Left button').select_option(label='W/L')
        panel.get_by_role('button', name='Apply').click()
        expect(panel.get_by_role('status')).to_have_text('적용했습니다. 계정에 저장했습니다.')
        self.assertEqual(['WindowLevel'], self.buttons(page, 1))
        panel.get_by_role('button', name='Close').click()
        expect(panel).to_have_count(0)
        expect(section.get_by_role('button', name='Mouse & Wheel…')).to_be_focused()
        # The parent's Save does not meet the child's save as a conflict, and keeps it.
        dialog.get_by_role('button', name='Save').click()
        expect(dialog).to_be_hidden()
        self.assertEqual(3, page.evaluate('synServer.viewerSettings.features.mouse.wheelStep'))

    def test_02_a_toolbar_tool_keeps_right_both_and_wheel_pointer_frees_left_and_off_returns_to_default(self):
        page = self.open(settings={'version': 2, 'bar': ['WindowLevel', 'Pan', 'Zoom', 'StackScroll', 'Length', 'Pointer'], 'shortcuts': {},
                                   'features': {'mouse': {'right': 'Zoom', 'both': 'WindowLevel', 'defaultTool': 'Pan', 'middle': 'None'}}})
        # Opened with the account's choices: Pan on the left (default tool), Zoom right, W/L on both.
        self.assertEqual([['Pan'], ['Zoom'], ['WindowLevel'], [], ['StackScroll']], [self.buttons(page, b) for b in (1, 2, 3, 4, 524288)])
        tools = page.get_by_role('toolbar', name='Frequent Tools')
        tools.get_by_role('button', name='Length').click()
        self.assertEqual([['Length'], ['Zoom'], ['WindowLevel'], ['StackScroll']], [self.buttons(page, b) for b in (1, 2, 3, 524288)])
        # A later read of the same account values keeps the reader's Length.
        page.evaluate("() => synMouse.configure(synServer.viewerSettings.features.mouse)")
        self.assertEqual(['Length'], self.buttons(page, 1))
        # Pointer: nothing on the left, the other buttons stay.
        tools.get_by_role('button', name='Pointer').click()
        self.assertEqual([[], ['Zoom'], ['WindowLevel'], ['StackScroll']], [self.buttons(page, b) for b in (1, 2, 3, 524288)])
        self.assertEqual(True, page.evaluate('synMouse.pointing()'))
        tools.get_by_role('button', name='Length').click()
        # Choosing the selected tool again turns it off: the left goes back to the default tool (Pan).
        tools.get_by_role('button', name='Length').click()
        self.assertEqual([['Pan'], ['Zoom'], ['WindowLevel']], [self.buttons(page, b) for b in (1, 2, 3)])

    # ── 04-5 Context Toolbar ──
    def turn_context_on(self, page):
        dialog = self.settings(page)
        dialog.get_by_role('button', name='Context Toolbar…').click()
        panel = page.locator('dialog[data-feature-panel=context]')
        expect(panel.get_by_role('checkbox', name='Right-click opens the Context Toolbar')).not_to_be_checked()
        shown = panel.locator('tr:has(input:checked) td:nth-child(2)')
        expect(shown).to_have_text(['Window / Level', 'Zoom', 'Pan', 'Length', 'Ellipse', 'Invert'])
        panel.get_by_role('checkbox', name='Right-click opens the Context Toolbar').check()
        expect(panel.get_by_role('status')).to_have_text('계정에 저장했습니다.')
        panel.get_by_role('button', name='Close').click()
        dialog.get_by_role('button', name='Cancel').click()
        expect(dialog).to_be_hidden()
        self.assertEqual(True, page.evaluate('synServer.viewerSettings.features.contextToolbar.on'))

    def test_03_right_click_without_moving_opens_the_bar_at_the_pointer_and_runs_on_that_cell(self):
        page = self.open()
        x, y = self.center(page, 'right')
        # Off (the default): a right click opens nothing and the context menu event goes on as before.
        page.mouse.click(x, y, button='right')
        expect(page.get_by_role('toolbar', name='Context Toolbar')).to_have_count(0)
        menus = page.evaluate('synMenus')
        self.assertGreaterEqual(menus, 1)
        self.turn_context_on(page)
        page.evaluate('() => { synMoves.length = 0; }')
        # A press that moves 2 px is still a click: the bar opens at the pointer and W/L saw no motion.
        page.mouse.move(x, y); page.mouse.down(button='right'); page.mouse.move(x + 2, y + 1, steps=2); page.mouse.up(button='right')
        bar = page.get_by_role('toolbar', name='Context Toolbar')
        expect(bar).to_be_visible()
        expect(bar.get_by_role('button')).to_have_text(['Window / Level', 'Zoom', 'Pan', 'Length', 'Ellipse', 'Invert'])
        box = bar.bounding_box()
        self.assertLessEqual(abs(box['x'] - (x + 2)), 1); self.assertLessEqual(abs(box['y'] - (y + 1)), 1)
        self.assertEqual([], page.evaluate('synMoves'))
        self.assertEqual(menus, page.evaluate('synMenus'), 'no other menu opens over the bar')
        # The bar runs on the cell that was right-clicked, not the active one; it then closes.
        self.assertEqual('left', page.evaluate('synActive'))
        bar.get_by_role('button', name='Zoom').click()
        expect(bar).to_have_count(0)
        page.wait_for_function("() => synInteractions.some(([id, cell]) => id === 'Zoom' && cell === 'right')")
        self.assertEqual('right', page.evaluate('synActive'))
        # Escape closes the bar and runs nothing.
        page.mouse.click(x, y, button='right')
        expect(bar).to_be_visible()
        before = page.evaluate('synInteractions.length')
        page.keyboard.press('Escape')
        expect(bar).to_have_count(0)
        self.assertEqual(before, page.evaluate('synInteractions.length'))

    def test_04_a_drag_both_buttons_a_cancel_or_a_long_press_open_no_bar(self):
        page = self.open(settings={'version': 2, 'bar': ['WindowLevel'], 'shortcuts': {}, 'features': {'contextToolbar': {'on': True, 'items': ['invert', 'Zoom']}}})
        x, y = self.center(page, 'left')
        bar = page.get_by_role('toolbar', name='Context Toolbar')
        # A drag: W/L sees the motion past the threshold, and no bar.
        page.mouse.move(x, y); page.mouse.down(button='right'); page.mouse.move(x + 30, y + 20, steps=6); page.mouse.up(button='right')
        self.assertTrue(page.evaluate('synMoves.length') > 0)
        expect(bar).to_have_count(0)
        # Out past the threshold and back: still a drag.
        page.mouse.move(x, y); page.mouse.down(button='right'); page.mouse.move(x + 12, y, steps=3); page.mouse.move(x, y, steps=3); page.mouse.up(button='right')
        expect(bar).to_have_count(0)
        # Both buttons: the right press joined by the left.
        page.mouse.move(x, y); page.mouse.down(button='right'); page.mouse.down(button='left'); page.mouse.up(button='left'); page.mouse.up(button='right')
        expect(bar).to_have_count(0)
        # Cancelled with Escape while pressed.
        page.mouse.down(button='right'); page.keyboard.press('Escape'); page.mouse.up(button='right')
        expect(bar).to_have_count(0)
        # Held longer than a click.
        page.mouse.down(button='right'); page.wait_for_timeout(550); page.mouse.up(button='right')
        expect(bar).to_have_count(0)
        # A click on the toolbar is not on an image.
        tb = page.locator('.kin-ux-toolbar').bounding_box()
        page.mouse.click(tb['x'] + 5, tb['y'] + 5, button='right')
        expect(bar).to_have_count(0)
        # The stored order is the bar's order.
        page.mouse.click(x, y, button='right')
        expect(bar.get_by_role('button')).to_have_text(['Invert', 'Zoom'])
        bar.get_by_role('button', name='Invert').click()
        page.wait_for_function("() => synInteractions.some(([id, cell]) => id === 'invert' && cell === 'left')")

    def test_05_context_toolbar_list_order_and_choice_are_saved_at_once(self):
        page = self.open()
        dialog = self.settings(page)
        dialog.get_by_role('button', name='Context Toolbar…').click()
        panel = page.locator('dialog[data-feature-panel=context]')
        # Arrow is stored but not on this toolbar: it is not offered and keeps its place; Invert swaps with Ellipse.
        panel.get_by_role('button', name='Move Invert Up').click()
        expect(panel.get_by_role('status')).to_have_text('계정에 저장했습니다.')
        expect(panel.get_by_role('button', name='Move Invert Up')).to_be_focused()
        panel.get_by_role('checkbox', name='Show Pan').uncheck()
        expect(panel.get_by_role('status')).to_have_text('계정에 저장했습니다.')
        panel.get_by_role('checkbox', name='Show Angle').check()
        expect(panel.get_by_role('status')).to_have_text('계정에 저장했습니다.')
        self.assertEqual({'on': False, 'items': ['WindowLevel', 'Zoom', 'Length', 'invert', 'ArrowAnnotate', 'EllipticalROI', 'Angle']},
                         page.evaluate('synServer.viewerSettings.features.contextToolbar'))
        expect(panel.locator('tr:has(input:checked) td:nth-child(2)')).to_have_text(['Window / Level', 'Zoom', 'Length', 'Invert', 'Ellipse', 'Angle'])
        # Each save moved the open Viewer Settings' revision: its Save keeps them.
        panel.get_by_role('button', name='Close').click()
        dialog.get_by_role('button', name='Save').click()
        expect(dialog).to_be_hidden()
        self.assertIn('Angle', page.evaluate('synServer.viewerSettings.features.contextToolbar.items'))

    # ── 04-6 F.Leader ──
    def test_06_fleader_button_areas_measure_letters_and_tool_keys_stay_quiet(self):
        page = self.open(measure=2)
        group = page.get_by_role('group', name='Feature Menus')
        leader_button = group.get_by_role('button', name='F.Leader')
        self.assertEqual('Press Space, then an area letter, then a function letter.', leader_button.get_attribute('title'))
        leader_button.click()
        panel = page.get_by_role('dialog', name='F.Leader')
        expect(panel.locator('li')).to_have_text(['VView', 'NNavigate', 'CCompare', 'MMeasure', 'SSettings'])
        page.keyboard.press('m')
        expect(panel.locator('h2')).to_have_text('F.Leader › Measure')
        # Registered Measure items first, then the toolbar's measuring tools, each with its letter.
        expect(panel.locator('li')).to_have_text(['ACTR', 'BMeasure 1', 'CLength', 'DAngle', 'EEllipse'])
        # While the panel is open a tool key (L = Length, W = W/L) runs no tool and reaches nothing underneath.
        before = page.evaluate('synInteractions.length')
        page.keyboard.press('w'); page.keyboard.press('z')
        self.assertEqual(before, page.evaluate('synInteractions.length'))
        self.assertNotIn('w', page.evaluate('synNativeKeys'))
        expect(panel).to_be_visible()
        page.keyboard.press('Backspace')
        expect(panel.locator('li')).to_have_count(5)
        page.keyboard.press('m'); page.keyboard.press('a')
        expect(panel).to_have_count(0)
        self.assertEqual([['synMeasure0', 'left']], page.evaluate('synRuns'))
        # A toolbar tool from its area runs as from the toolbar.
        leader_button.click(); page.keyboard.press('m'); page.keyboard.press('c')
        page.wait_for_function("() => synInteractions.some(([id]) => id === 'Length')")
        # Esc closes and runs nothing.
        leader_button.click(); page.keyboard.press('v')
        expect(panel.locator('h2')).to_have_text('F.Leader › View')
        runs = page.evaluate('[synRuns.length, synInteractions.length]')
        page.keyboard.press('Escape')
        expect(panel).to_have_count(0)
        self.assertEqual(runs, page.evaluate('[synRuns.length, synInteractions.length]'))
        # Settings: Viewer Settings and the Tools & Display windows.
        leader_button.click(); page.keyboard.press('s')
        expect(panel.locator('li')).to_have_text(['AViewer Settings', 'BMouse & Wheel…', 'CContext Toolbar…'])
        page.keyboard.press('b')
        expect(page.get_by_role('dialog', name='Mouse & Wheel')).to_be_visible()

    def test_07_space_opens_fleader_only_when_on_and_outside_text_and_dialogs(self):
        page = self.open(measure=1)
        panel = page.get_by_role('dialog', name='F.Leader')
        page.mouse.click(900, 600)
        page.keyboard.press(' ')
        expect(panel).to_have_count(0)
        self.assertIn(' ', page.evaluate('synNativeKeys'), 'off: Space reaches the viewer as before')
        dialog = self.settings(page)
        dialog.get_by_role('checkbox', name='Space opens F.Leader').check()
        dialog.get_by_role('button', name='Save').click()
        expect(dialog).to_be_hidden()
        self.assertEqual(True, page.evaluate('synServer.viewerSettings.features.fleaderSpace'))
        page.evaluate('() => { synNativeKeys.length = 0; }')
        page.mouse.click(900, 600)
        page.keyboard.press(' ')
        expect(panel).to_be_visible()
        self.assertEqual([], page.evaluate('synNativeKeys'), 'on: Space opens the panel and nothing else')
        page.keyboard.press('m')
        expect(panel.locator('li').first).to_have_text('ACTR')
        page.keyboard.press('a')
        expect(panel).to_have_count(0)
        self.assertEqual([['synMeasure0', 'left']], page.evaluate('synRuns'))
        # In a text field Space types a space.
        page.get_by_label('Note').click(); page.keyboard.press(' ')
        expect(panel).to_have_count(0)
        expect(page.get_by_label('Note')).to_have_value(' ')
        # With a dialog open it does not open the panel.
        dialog = self.settings(page)
        page.keyboard.press(' ')
        expect(panel).to_have_count(0)
        dialog.get_by_role('button', name='Cancel').click()
        # A click outside closes the panel.
        page.mouse.click(900, 600)
        page.keyboard.press(' ')
        expect(panel).to_be_visible()
        page.mouse.click(900, 700)
        expect(panel).to_have_count(0)

    def test_08_more_functions_than_keys_continue_on_tab_pages(self):
        page = self.open(measure=40)
        page.get_by_role('button', name='F.Leader').click()
        page.keyboard.press('m')
        panel = page.get_by_role('dialog', name='F.Leader')
        items = panel.locator('li')
        expect(items).to_have_count(35)
        expect(items.nth(26)).to_have_text('1Measure 26')
        expect(panel.locator('p')).to_contain_text('Tab: more keys (1/2)')
        page.keyboard.press('Tab')
        expect(panel.locator('p')).to_contain_text('(2/2)')
        # 40 Measure items + Length, Angle, Ellipse = 43: 8 on the second page.
        expect(items).to_have_text(['AMeasure 35', 'BMeasure 36', 'CMeasure 37', 'DMeasure 38', 'EMeasure 39', 'FLength', 'GAngle', 'HEllipse'])
        page.keyboard.press('e')
        expect(panel).to_have_count(0)
        self.assertEqual([['synMeasure39', 'left']], page.evaluate('synRuns'))

    def test_09_reopened_viewer_keeps_the_choices(self):
        page = self.open()
        dialog = self.settings(page)
        dialog.get_by_role('button', name='Mouse & Wheel…').click()
        panel = page.locator('dialog[data-feature-panel=mouse]')
        panel.get_by_label('Right button').select_option(label='Pan')
        panel.get_by_label('Default tool').select_option(label='Zoom')
        panel.get_by_role('button', name='Apply').click()
        expect(panel.get_by_role('status')).to_have_text('적용했습니다. 계정에 저장했습니다.')
        panel.get_by_role('button', name='Close').click()
        dialog.get_by_role('button', name='Cancel').click()
        # A new viewer (the mode entered again) reads the account: a new group starts with the saved choices.
        page.evaluate("() => { synUnmount(); for (const name of Object.keys(synGroup.toolOptions)) synGroup.toolOptions[name] = { mode: 'Passive', bindings: [] }; synGroup.toolOptions.StackScroll = { mode: 'Active', bindings: [{ mouseButton: 524288 }] }; synGroup.toolOptions.WindowLevel = { mode: 'Active', bindings: [{ mouseButton: 1 }] }; }")
        page.evaluate("() => KinViewerUXToolbar.clear()")
        page.evaluate("() => synMount()")
        expect(page.locator('.kin-ux-toolbar-settings [role=status]')).to_have_text('계정 설정 · 다른 PC에서도 적용됩니다.')
        page.wait_for_function("() => synButtons(null, 1).join() === 'Zoom' && synButtons(null, 2).join() === 'Pan'")
        dialog = self.settings(page)
        dialog.get_by_role('button', name='Mouse & Wheel…').click()
        panel = page.locator('dialog[data-feature-panel=mouse]')
        self.assertEqual(['Zoom', 'Pan', 'Pan', 'None', 'Zoom', '1 image', 'Off'],
                         panel.locator('select').evaluate_all('n => n.map(s => s.selectedOptions[0].textContent)'))

    def test_11_the_bar_and_the_press_belong_to_the_images_that_were_clicked(self):
        page = self.open(settings={'version': 2, 'bar': ['WindowLevel'], 'shortcuts': {}, 'features': {'contextToolbar': {'on': True, 'items': ['invert', 'Zoom']}}})
        x, y = self.center(page, 'right')
        bar = page.get_by_role('toolbar', name='Context Toolbar')
        # Another cell gets other images: this bar stays.
        page.mouse.click(x, y, button='right'); expect(bar).to_be_visible()
        page.evaluate("() => synEmit('cells', 'data', { viewportId: 'left' })")
        expect(bar).to_be_visible()
        # The clicked cell gets other images: the bar goes and nothing runs there.
        page.evaluate("() => synEmit('cells', 'data', { viewportId: 'right' })")
        expect(bar).to_have_count(0)
        # A new layout (no cell named), and a patient switch beginning, drop it too.
        page.mouse.click(x, y, button='right'); expect(bar).to_be_visible()
        page.evaluate("() => synEmit('grid', 'gridState', {})")
        expect(bar).to_have_count(0)
        page.mouse.click(x, y, button='right'); expect(bar).to_be_visible()
        page.evaluate("() => document.body.classList.add('kin-patient-switching')")
        expect(bar).to_have_count(0)
        page.evaluate("() => document.body.classList.remove('kin-patient-switching')")
        # Images replaced while the button is still pressed: no bar on release.
        page.mouse.move(x, y); page.mouse.down(button='right')
        page.evaluate("() => synEmit('cells', 'data', { viewportId: 'right' })")
        page.mouse.up(button='right')
        expect(bar).to_have_count(0)
        self.assertEqual([], page.evaluate("synInteractions.filter(([id]) => id === 'invert')"))
        # A History or Job workspace being restored refuses the tool before anything changes: the left cell stays active.
        self.assertEqual('left', page.evaluate('synActive'))
        page.mouse.click(x, y, button='right')
        page.evaluate("() => { window.kinViewerHistoryWorkspaceState = () => ({ busy: true }); }")
        bar.get_by_role('button', name='Invert').click()
        expect(bar).to_have_count(0)
        page.wait_for_timeout(100)
        self.assertEqual(['left', []], page.evaluate("[synActive, synInteractions.filter(([id]) => id === 'invert')]"))
        page.evaluate("() => { window.kinViewerHistoryWorkspaceState = () => ({ busy: false }); }")
        # The same images still: the bar runs on that cell.
        page.mouse.click(x, y, button='right')
        bar.get_by_role('button', name='Invert').click()
        page.wait_for_function("() => synInteractions.some(([id, cell]) => id === 'invert' && cell === 'right')")

    def test_12_held_keys_in_fleader_run_nothing(self):
        page = self.open(measure=40)
        panel = page.get_by_role('dialog', name='F.Leader')
        page.get_by_role('button', name='F.Leader').click()
        # m held: the first press opens Measure; its repeats would be the letter of the 13th function and must run nothing.
        page.keyboard.down('m'); page.keyboard.down('m'); page.keyboard.down('m'); page.keyboard.up('m')
        expect(panel.locator('h2')).to_have_text('F.Leader › Measure')
        self.assertEqual([], page.evaluate('synRuns'))
        # a held: the first press runs the first function and closes the panel; its repeats then run no tool key (A = Angle).
        page.keyboard.down('a'); page.keyboard.down('a'); page.keyboard.down('a')
        expect(panel).to_have_count(0)
        page.keyboard.up('a')
        self.assertEqual([['synMeasure0', 'left']], page.evaluate('synRuns'))
        self.assertEqual([], page.evaluate("synInteractions.filter(([id]) => id === 'Angle')"))
        # A new press of the same key is a tool key again.
        page.keyboard.press('a')
        page.wait_for_function("() => synInteractions.some(([id]) => id === 'Angle')")

    def test_10_narrow_windows_reach_fleader(self):
        for size in [(768, 1024), (1024, 768)]:
            page = self.open(size=size)
            button = page.get_by_role('button', name='F.Leader')
            expect(button).to_be_attached()
            page.evaluate("() => document.querySelector('[data-feature=fLeader]').scrollIntoView({ inline: 'nearest' })")
            expect(button).to_be_in_viewport()
            row = page.locator('.kin-ux-toolbar').bounding_box()
            self.assertLessEqual(row['height'], 60, 'the toolbar stays one row')


if __name__ == '__main__':
    unittest.main(verbosity=2)
