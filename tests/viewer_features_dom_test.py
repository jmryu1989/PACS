# coding: utf-8
"""Viewer feature registry on the shipped image toolbar: Feature Menus, Tools & Display, feature settings and guards.

The shipped viewer-features.js, viewer-ux-shortcuts.js and viewer-ux-toolbar.js (with viewer-ux-theme.css) run in
Chromium beside synthetic OHIF services, a synthetic image cell and an in-page account settings endpoint that keeps
the revision and owner contract of /api/workspace-shortcuts. Synthetic test modules register the entries; the
shipped feature files register nothing yet, so the shipped group and section stay absent.
"""
from pathlib import Path
import json
import unittest

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
ORIGIN = "https://viewer-features.test"
OWNER = ['syn-site', 'syn-reader']

HARNESS = """<!doctype html><html><head><style>
body { margin: 0; background: #111; --kin-panel: #222; --kin-ux-text: #eee; --kin-ux-secondary: #999; --kin-accent: #6cf; }
#grid { position: absolute; left: 0; top: 80px; display: flex; }
[data-cy=viewport-pane] { position: relative; width: 200px; height: 150px; overflow: hidden; }
.viewport-element { position: absolute; inset: 0; }
</style></head><body><div id="root"><div class="kin-ux-toolbar-slot"></div><div id="grid"></div></div></body></html>"""

# Synthetic services, an account endpoint in the page and a session. Nothing is mounted yet.
SETUP = """owner => {
  window.synNotes = []; window.synInteractions = []; window.synBusy = false; window.synEnded = false; window.synWriter = true;
  window.synActive = 'left'; window.synActivated = []; window.synShown = { left: ['syn-set-1'], right: ['syn-set-2'] };
  const viewports = new Map();
  for (const id of ['left', 'right']) {
    const pane = document.createElement('div'); pane.dataset.cy = 'viewport-pane'; pane.id = 'pane-' + id;
    const element = document.createElement('div'); element.className = 'viewport-element';
    pane.append(element); document.getElementById('grid').append(pane);
    viewports.set(id, { id, type: 'stack', element });
  }
  // Services broadcast as OHIF 3.9 does: subscribe(event, fn) → { unsubscribe }, synEmit(service, event, payload).
  const listeners = new Map();
  const events = name => ({ subscribe(event, fn) { const key = name + event; listeners.set(key, [...(listeners.get(key) || []), fn]);
    return { unsubscribe() { listeners.set(key, (listeners.get(key) || []).filter(f => f !== fn)); } }; } });
  window.synEmit = (name, event, payload) => { for (const fn of listeners.get(name + event) || []) fn(payload); };
  // synLaterActive: as OHIF 3.9, the active cell is applied on a later render and announced on a timer after the call;
  // synActivationLost: the request is taken but the grid never makes that cell active.
  window.synLaterActive = false; window.synActivationLost = false;
  const grid = { ...events('grid'), EVENTS: { ACTIVE_VIEWPORT_ID_CHANGED: 'active', GRID_STATE_CHANGED: 'gridState' },
    getActiveViewportId: () => synActive,
    setActiveViewportId: id => {
      synActivated.push(id);
      if (synActivationLost) return;
      if (!synLaterActive) { synActive = id; return; }
      setTimeout(() => synEmit('grid', 'active', { viewportId: id }), 0);
      setTimeout(() => { synActive = id; }, 30);
    },
    getState: () => ({ viewports: new Map(Object.entries(synShown).map(([id, sets]) => [id, { displaySetInstanceUIDs: sets }])) }) };
  window.synButtons = {
    WindowLevel: { id: 'WindowLevel', uiType: 'ohif.radioGroup', props: { label: 'Window / Level', commands: 'setToolActiveToolbar' } },
    Pan: { id: 'Pan', uiType: 'ohif.radioGroup', props: { label: 'Pan', commands: 'setToolActiveToolbar' } },
    Zoom: { id: 'Zoom', uiType: 'ohif.radioGroup', props: { label: 'Zoom', commands: 'setToolActiveToolbar' } },
    StackScroll: { id: 'StackScroll', uiType: 'ohif.radioGroup', props: { label: 'Stack Scroll', commands: 'setToolActiveToolbar' } },
    Length: { id: 'Length', uiType: 'ohif.radioGroup', props: { label: 'Length', commands: 'setToolActiveToolbar' } },
    Angle: { id: 'Angle', uiType: 'ohif.radioGroup', props: { label: 'Angle', commands: 'setToolActiveToolbar' } },
    EllipticalROI: { id: 'EllipticalROI', uiType: 'ohif.radioGroup', props: { label: 'Ellipse', commands: 'setToolActiveToolbar' } },
    Capture: { id: 'Capture', uiType: 'ohif.radioGroup', props: { label: 'Capture', commands: 'showDownloadViewportModal' } },
  };
  window.synSection = Object.keys(synButtons);
  window.synServices = {
    viewportGridService: grid,
    cornerstoneViewportService: { ...events('cells'), EVENTS: { VIEWPORT_DATA_CHANGED: 'data' }, getCornerstoneViewport: id => viewports.get(id) },
    uiNotificationService: { show: note => synNotes.push(note) },
    toolbarService: {
      EVENTS: { TOOL_BAR_MODIFIED: 'modified' },
      getButtonSection: () => synSection.map(id => ({ id })),
      getButtons: () => synButtons,
      // A tool may be unavailable in some cells: synOffIn[id] lists them, judged for the active cell.
      getButtonProps: id => synButtons[id] && { id, ...synButtons[id].props, disabled: (window.synOffIn?.[id] || []).includes(synActive) },
      recordInteraction: (item, options) => synInteractions.push([item.itemId, options?.refreshProps?.viewportId]),
      subscribe: () => ({ unsubscribe() {} }),
    },
  };
  window.synCommands = { runCommand() {} };
  window.kinViewerHistoryWorkspaceState = () => ({ busy: synBusy });
  window.kinViewerJobWorkspaceState = () => ({ busy: false });
  window.KinViewerHangingSettings = { modalities: [], defaults: {}, get: () => ({}),
    mount: () => ({ apply() {}, dispose() {} }), mountSizing: () => ({ dispose() {} }) };
  window.KinSessionTransport = { refusal: () => false, responseError: () => new Error('ended') };
  // The account endpoint: GET reads, PUT saves at the expected revision or answers the conflict text.
  window.synServer = { revision: 3, viewerSettings: null, puts: [], gets: 0, hold: null };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, init = {}) => {
    const s = synServer;
    if (!String(url).endsWith('/api/workspace-shortcuts')) return reply(404, {});
    if ((init.method || 'GET') === 'GET') { s.gets++; return reply(200, { owner, revision: s.revision, viewerSettings: structuredClone(s.viewerSettings) }); }
    const body = JSON.parse(init.body); s.puts.push(body);
    if (s.hold) await s.hold;
    if (body.revision !== s.revision) return reply(409, { message: '계정 설정이 변경되었습니다. 불러온 뒤 다시 저장하세요' });
    s.revision++; s.viewerSettings = body.viewerSettings;
    return reply(200, { owner, revision: s.revision, viewerSettings: structuredClone(s.viewerSettings) });
  };
  window.synSession = { owner: () => owner, ended: () => synEnded, writer: () => synWriter, state: () => 'confirmed', decide: async () => {} };
  window.synMount = () => {
    window.synToolbar = KinViewerUXToolbar.mount({ services: synServices, commands: synCommands, session: synSession });
    // As config/ohif/viewer-ux.js mounts the single-key layer beside the toolbar.
    window.synKeys = KinViewerUXShortcuts.mount({ getBindings: () => synToolbar.bindings(), invoke: id => synToolbar.invoke(id), allowed: () => !synEnded });
  };
}"""

# A synthetic feature module with entries in two menus, three toolbar buttons, two checks, a settings window and a
# shortcut that reuses a menu item's action.
MODULE = """() => {
  window.synCalls = []; window.synHeard = []; window.synApplied = [];
  KinViewerFeatures.module('syn', ({ services, commands, session, store, ui }) => {
    window.synGiven = { services: services === synServices, commands: commands === synCommands, session: session === synSession };
    window.synSetupTools = ui.tools().map(tool => tool.id);
    ui.menuItem('Display', { id: 'synZoom', label: 'Zoom…', order: 2, run: ({ viewportId }) => synCalls.push(['synZoom', viewportId]) });
    ui.menuItem('Display', { id: 'synOverlay', label: 'Overlay Items…', order: 1, run: () => synCalls.push(['synOverlay']) });
    ui.menuItem('Display', { id: 'synOff', label: 'Unavailable Now', order: 3, run: () => synCalls.push(['synOff']), enabled: () => false });
    ui.menuItem('MG', { id: 'synMirror', label: 'Mirrored', run: () => synCalls.push(['synMirror']) });
    ui.toolbarButton({ id: 'synLeader', label: 'F.Leader', title: 'Quick tools', order: 3, run: () => synCalls.push(['synLeader']) });
    ui.toolbarButton({ id: 'synPrev', label: '‹ Prior', order: 1, run: () => synCalls.push(['synPrev']) });
    ui.toolbarButton({ id: 'synNext', label: 'Prior ›', order: 2, run: () => synCalls.push(['synNext']) });
    ui.setting({ id: 'synSmart', kind: 'check', label: 'Smart Zoom', order: 2, key: 'smartZoom' });
    ui.setting({ id: 'synRotate', kind: 'check', label: 'Auto Rotate 180°', order: 1, key: 'autoRotate', default: true });
    ui.setting({ id: 'synOverlaySettings', kind: 'button', label: 'Overlay Items…', order: 1, run: () => synOpenOverlay() });
    ui.shortcut({ id: 'synZoom', label: 'Zoom Presets' });
    store.subscribe('smartZoom', value => synHeard.push(['smartZoom', value]));
    store.subscribe('overlay', value => synHeard.push(['overlay', value]));
    window.synStore = store; window.synUI = ui;
    window.synOpenOverlay = () => {
      const panel = ui.panel({ id: 'overlay', title: 'Overlay Items' });
      const input = document.createElement('input'); input.setAttribute('aria-label', 'CT Items'); input.value = (store.get('overlay') || {}).CT || '';
      const apply = document.createElement('button'); apply.type = 'button'; apply.textContent = 'Apply';
      apply.onclick = async () => { const ok = await store.set('overlay', { CT: input.value }, { revision: panel.revision }); synApplied.push(ok); if (ok) panel.close(); };
      panel.body.append(input, apply); input.focus();
      return panel;
    };
  });
}"""

FULL = """() => {
  KinViewerFeatures.module('full', ({ ui }) => {
    for (const [menu, label] of [['MG', 'Mirrored'], ['Navigate', 'Navigation Bar'], ['Display', 'Overlay Items…'], ['Compare', 'Related Studies'], ['Measure', 'Circle by Diameter']])
      ui.menuItem(menu, { id: 'full' + menu, label, run: () => {} });
    for (const [id, label] of [['fullPrev', '‹ Prior'], ['fullNext', 'Prior ›'], ['fullLeader', 'F.Leader']]) ui.toolbarButton({ id, label, run: () => {} });
  });
}"""


class ViewerFeaturesDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self, modules=(MODULE,), size=(1366, 900), settings=None, writer=True, mount=True, routes=None):
        context = self.browser.new_context(viewport={'width': size[0], 'height': size[1]})
        page = context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(ORIGIN + "/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        for path, handler in (routes or {}).items():
            page.route(ORIGIN + path, handler)
        page.goto(ORIGIN + "/")
        page.add_style_tag(path=str(HPACS / "viewer-ux-theme.css"))
        for name in ["viewer-ux-shortcuts.js", "viewer-features.js", "viewer-ux-toolbar.js"]:
            page.add_script_tag(path=str(HPACS / name))
        page.evaluate(SETUP, OWNER)
        page.evaluate("([settings, writer]) => { synServer.viewerSettings = settings; synWriter = writer; }", [settings, writer])
        for module in modules:
            page.evaluate(module)
        if mount:
            page.evaluate("() => synMount()")
            if writer:
                expect(page.locator('.kin-ux-toolbar-settings [role=status]')).to_have_text('계정 설정 · 다른 PC에서도 적용됩니다.')
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    def texts(self, page, selector):
        return page.evaluate("s => [...document.querySelectorAll(s)].filter(n => !n.closest('[hidden]')).map(n => n.textContent)", selector)

    # ── Feature Menus: place, order, empty menus, closing ──
    def test_01_registered_menus_buttons_and_items_show_in_order_between_more_and_settings(self):
        page = self.open()
        self.assertEqual({'services': True, 'commands': True, 'session': True}, page.evaluate('synGiven'))
        order = page.evaluate("() => [...document.querySelector('.kin-ux-toolbar').children].filter(n => !n.hidden).map(n => n.className || n.tagName)")
        self.assertEqual(['kin-ux-tools-bar', 'kin-ux-more', 'kin-ux-features', 'kin-ux-toolbar-settings'], order)
        group = page.get_by_role('group', name='Feature Menus')
        expect(group).to_be_visible()
        # Menus without an item are not drawn; buttons follow the menus in their order.
        self.assertEqual(['MG ▾', 'Display ▾', '‹ Prior', 'Prior ›', 'F.Leader'], self.texts(page, '.kin-ux-features-row > button'))
        self.assertEqual('Quick tools', page.locator('[data-feature=synLeader]').get_attribute('title'))
        self.assertEqual([{'id': 'synOverlay', 'menu': 'Display', 'label': 'Overlay Items…', 'order': 1},
                          {'id': 'synZoom', 'menu': 'Display', 'label': 'Zoom…', 'order': 2},
                          {'id': 'synOff', 'menu': 'Display', 'label': 'Unavailable Now', 'order': 3}], page.evaluate("KinViewerFeatures.items('Display')"))
        self.assertEqual(['synMirror', 'synOverlay', 'synZoom', 'synOff', 'synPrev', 'synNext', 'synLeader'],
                         [item['id'] for item in page.evaluate("KinViewerFeatures.items()")])
        display = page.get_by_role('button', name='Display ▾')
        display.click()
        menu = page.get_by_role('menu', name='Display')
        expect(menu.get_by_role('menuitem')).to_have_text(['Overlay Items…', 'Zoom…', 'Unavailable Now'])
        expect(menu.get_by_role('menuitem', name='Unavailable Now')).to_be_disabled()
        self.assertEqual('true', display.get_attribute('aria-expanded'))
        expect(menu.get_by_role('menuitem', name='Overlay Items…')).to_be_focused()
        page.keyboard.press('ArrowDown'); expect(menu.get_by_role('menuitem', name='Zoom…')).to_be_focused()
        page.keyboard.press('Escape')
        expect(menu).to_have_count(0); expect(display).to_be_focused(); self.assertEqual('false', display.get_attribute('aria-expanded'))
        display.click(); expect(menu).to_be_visible()
        page.mouse.click(600, 600)
        expect(menu).to_have_count(0)
        display.click(); menu.get_by_role('menuitem', name='Zoom…').click()
        expect(menu).to_have_count(0)
        page.get_by_role('button', name='Prior ›').click()
        self.assertEqual([['synZoom', 'left'], ['synNext']], page.evaluate('synCalls'))

    def test_02_nothing_registered_draws_no_group_and_no_section(self):
        page = self.open(modules=())
        expect(page.locator('.kin-ux-features')).to_be_hidden()
        self.assertEqual([], page.evaluate("KinViewerFeatures.items()"))
        page.get_by_role('button', name='Viewer Settings').click()
        expect(page.locator('dialog.kin-ux-settings')).to_be_visible()
        expect(page.locator('dialog.kin-ux-settings fieldset.kin-ux-feature-settings')).to_be_hidden()
        self.assertEqual(['Mammography', 'Hanging & Layout', 'Second Display'], self.texts(page, 'dialog.kin-ux-settings > fieldset > legend'))
        # The shipped feature files that have no feature yet register nothing: loaded in order, the toolbar is as before.
        # (viewer-features-chrome.js has its own test: viewer_chrome_position_dom_test.py.)
        for name in ['navigate', 'display', 'view', 'autosave', 'input', 'monitors', 'compare', 'mg', 'measure', 'measure-lines', 'measure-ortho']:
            page.add_script_tag(path=str(HPACS / ('viewer-features-' + name + '.js')))
        self.assertEqual([], page.evaluate("KinViewerFeatures.items()"))
        expect(page.locator('.kin-ux-features')).to_be_hidden()

    def test_03_tools_and_display_section_and_feature_shortcut_in_viewer_settings(self):
        page = self.open(settings={'version': 2, 'bar': ['Zoom'], 'shortcuts': {'synZoom': 'j'}, 'features': {'smartZoom': True}})
        page.get_by_role('button', name='Viewer Settings').click()
        dialog = page.locator('dialog.kin-ux-settings')
        self.assertEqual(['Mammography', 'Hanging & Layout', 'Second Display', 'Tools & Display'], self.texts(page, 'dialog.kin-ux-settings > fieldset > legend'))
        self.assertTrue(page.evaluate("() => document.querySelector('.kin-ux-feature-settings').nextElementSibling.matches('p[role=status]')"))
        expect(dialog.locator('.kin-ux-feature-settings input[type=checkbox]')).to_have_count(2)
        self.assertEqual(['Auto Rotate 180°', 'Smart Zoom'], dialog.locator('.kin-ux-feature-settings input[type=checkbox]').evaluate_all('n => n.map(i => i.getAttribute("aria-label"))'))
        expect(dialog.get_by_role('checkbox', name='Smart Zoom')).to_be_checked()
        expect(dialog.get_by_role('checkbox', name='Auto Rotate 180°')).to_be_checked()
        expect(dialog.locator('.kin-ux-feature-setting-buttons button')).to_have_text(['Overlay Items…'])
        # The feature shortcut is a row of the shortcut table, with the stored key.
        expect(dialog.get_by_role('textbox', name='Zoom Presets Shortcut')).to_have_value('J')
        dialog.get_by_role('checkbox', name='Smart Zoom').uncheck()
        dialog.get_by_role('textbox', name='Zoom Presets Shortcut').fill('k')
        dialog.get_by_role('button', name='Save').click()
        expect(dialog).to_be_hidden()
        put = page.evaluate('synServer.puts.at(-1)')
        self.assertEqual(3, put['revision'])
        self.assertEqual({'smartZoom': False}, put['viewerSettings']['features'], 'an untouched default check is not written')
        self.assertEqual('k', put['viewerSettings']['shortcuts']['synZoom'])
        self.assertIn(['smartZoom', False], page.evaluate('synHeard'))
        # The saved key runs the feature through run(id).
        page.mouse.click(100, 140); page.keyboard.press('k')
        self.assertEqual([['synZoom', 'left']], page.evaluate('synCalls'))

    # ── store: PUT body, conflict, save in progress, read-only session, other window, reload ──
    def test_04_store_set_saves_in_the_account_and_hears_reloads_and_other_windows(self):
        page = self.open(settings={'version': 2, 'bar': ['Zoom'], 'shortcuts': {}, 'features': {'smartZoom': True}})
        self.assertEqual([['smartZoom', True], ['overlay', None]], page.evaluate('synHeard'), 'first read is heard')
        self.assertTrue(page.evaluate("synStore.set('overlay', { CT: 'WL' })"))
        put = page.evaluate('synServer.puts.at(-1)')
        self.assertEqual({'expectedOwner': OWNER, 'revision': 3,
                          'viewerSettings': {'version': 2, 'bar': ['Zoom'], 'shortcuts': {}, 'features': {'smartZoom': True, 'overlay': {'CT': 'WL'}}}}, put)
        self.assertEqual({'CT': 'WL'}, page.evaluate("synStore.get('overlay')"))
        self.assertEqual(4, page.evaluate("synStore.revision()"))
        self.assertIn(['overlay', {'CT': 'WL'}], page.evaluate('synHeard'))
        # Another window saved: the change arrives on the settings channel and is read and heard here.
        page.evaluate("() => { synHeard.length = 0; synServer.revision = 9; synServer.viewerSettings = { ...synServer.viewerSettings, features: { smartZoom: false } }; "
                      "new BroadcastChannel('kin-viewer-settings').postMessage({ owner: JSON.stringify(" + json.dumps(OWNER) + "), revision: 9 }); }")
        page.wait_for_function("() => synHeard.length === 2")
        self.assertEqual([['smartZoom', False], ['overlay', None]], page.evaluate('synHeard'))
        # A save at an older revision meets the conflict text, resolves false and the stored value is heard again.
        page.evaluate("() => { synHeard.length = 0; synServer.revision = 11; }")
        self.assertFalse(page.evaluate("synStore.set('smartZoom', true, { revision: 9 })"))
        expect(page.locator('.kin-ux-toolbar-settings [role=status]')).to_have_text('계정 설정이 변경되었습니다. 불러온 뒤 다시 저장하세요')
        self.assertEqual([['smartZoom', False]], page.evaluate('synHeard'))
        # Reload Settings reads the account again and every key is heard.
        page.evaluate("() => synHeard.length = 0")
        page.get_by_role('button', name='Reload Settings').click()
        page.wait_for_function("() => synHeard.length === 2")
        # One save at a time: a second set while the first is saving is refused with the status text.
        page.evaluate("() => { window.synRelease = null; synServer.hold = new Promise(r => { synRelease = r; }); window.synFirst = synStore.set('smartZoom', true); }")
        page.wait_for_function("() => synServer.puts.length === 3")
        self.assertFalse(page.evaluate("synStore.set('overlay', { CT: 'X' })"))
        expect(page.locator('.kin-ux-toolbar-settings [role=status]')).to_have_text('계정에 저장 중입니다. 저장이 끝난 뒤 다시 시도하세요.')
        page.evaluate("() => { synServer.hold = null; synRelease(); }")
        self.assertTrue(page.evaluate("synFirst"))
        self.assertEqual(3, len(page.evaluate('synServer.puts')))

    def test_05_session_that_does_not_save_applies_in_this_window_only(self):
        page = self.open(writer=False)
        page.wait_for_function("() => synHeard.length === 2")
        self.assertTrue(page.evaluate("synStore.set('smartZoom', true)"))
        self.assertEqual(0, page.evaluate('synServer.puts.length'))
        self.assertTrue(page.evaluate("synStore.get('smartZoom')"))
        expect(page.locator('.kin-ux-toolbar-settings [role=status]')).to_have_text('이 창에만 적용했습니다. 계정에는 저장하지 않습니다.')
        self.assertFalse(page.evaluate("synStore.writable()"))

    # ── A feature window above Viewer Settings ──
    def test_06_window_opened_from_settings_is_modal_above_it_and_parent_save_keeps_its_value(self):
        page = self.open(settings={'version': 2, 'bar': ['Zoom'], 'shortcuts': {}})
        page.get_by_role('button', name='Viewer Settings').click()
        settings = page.locator('dialog.kin-ux-settings')
        settings.get_by_role('checkbox', name='Smart Zoom').check()
        opener = settings.locator('.kin-ux-feature-setting-buttons').get_by_role('button', name='Overlay Items…')
        opener.click()
        child = page.locator('dialog.kin-ux-feature-panel[aria-label="Overlay Items"]')
        expect(child).to_be_visible()
        self.assertTrue(page.evaluate("() => document.querySelector('dialog.kin-ux-feature-panel').open && document.querySelector('dialog.kin-ux-settings').open"))
        expect(child.get_by_role('textbox', name='CT Items')).to_be_focused()
        # The child takes typing and presses; the parent dialog behind it is inert.
        page.keyboard.type('WL Zoom')
        child.get_by_role('button', name='Apply').click()
        expect(child).to_have_count(0)
        expect(opener).to_be_focused()
        self.assertEqual([True], page.evaluate('synApplied'))
        self.assertEqual(3, page.evaluate('synServer.puts[0].revision'))
        # The parent's draft check is still there and its Save does not conflict with the child's save.
        expect(settings.get_by_role('checkbox', name='Smart Zoom')).to_be_checked()
        settings.get_by_role('button', name='Save').click()
        expect(settings).to_be_hidden()
        last = page.evaluate('synServer.puts.at(-1)')
        self.assertEqual(4, last['revision'])
        self.assertEqual({'overlay': {'CT': 'WL Zoom'}, 'smartZoom': True}, last['viewerSettings']['features'])
        self.assertEqual(5, page.evaluate('synServer.revision'))
        # Esc closes the child and returns focus; Cancel on the parent then leaves values as saved.
        page.get_by_role('button', name='Viewer Settings').click()
        settings.locator('.kin-ux-feature-setting-buttons').get_by_role('button', name='Overlay Items…').click()
        expect(child.get_by_role('textbox', name='CT Items')).to_have_value('WL Zoom')
        page.keyboard.press('Escape')
        expect(child).to_have_count(0)
        expect(settings).to_be_visible()
        # Outside Viewer Settings the same window is a panel beside the images, closed by Esc.
        settings.get_by_role('button', name='Cancel').click()
        page.evaluate("() => synOpenOverlay()")
        panel = page.locator('section.kin-ux-feature-panel[role=dialog][aria-label="Overlay Items"]')
        expect(panel).to_be_visible()
        page.keyboard.press('Escape')
        expect(panel).to_have_count(0)
        # Left open beside the images, the window opens again above Viewer Settings when asked from there.
        page.evaluate("() => synOpenOverlay()")
        expect(panel).to_be_visible()
        page.get_by_role('button', name='Viewer Settings').click()
        settings.locator('.kin-ux-feature-setting-buttons').get_by_role('button', name='Overlay Items…').click()
        expect(panel).to_have_count(0)
        expect(child.get_by_role('textbox', name='CT Items')).to_be_focused()
        page.keyboard.type('!')
        expect(child.get_by_role('textbox', name='CT Items')).to_have_value('WL Zoom!')

    # ── run(id) keeps the toolbar's guards ──
    def test_07_run_is_refused_while_switching_patient_after_session_end_and_while_restoring(self):
        page = self.open(settings={'version': 2, 'bar': ['Zoom'], 'shortcuts': {'synZoom': 'j'}})
        self.assertTrue(page.evaluate("KinViewerFeatures.run('synMirror')"))
        page.evaluate("() => document.body.classList.add('kin-patient-switching')")
        self.assertFalse(page.evaluate("KinViewerFeatures.run('synMirror')"))
        page.mouse.click(100, 140); page.keyboard.press('j')
        page.evaluate("() => document.body.classList.remove('kin-patient-switching')")
        page.evaluate("() => synBusy = true")
        self.assertFalse(page.evaluate("KinViewerFeatures.run('synMirror')"))
        expect(page.locator('.kin-ux-toolbar-settings [role=status]')).to_have_text('영상 작업을 불러오는 중입니다. 완료 후 도구를 다시 선택하세요.')
        page.evaluate("() => synBusy = false")
        self.assertFalse(page.evaluate("KinViewerFeatures.run('synOff')"), 'a disabled item does not run')
        self.assertFalse(page.evaluate("KinViewerFeatures.run('missing')"))
        # A feature runs an existing tool in a given cell through the toolbar.
        self.assertTrue(page.evaluate("synUI.invoke('Length', { viewportId: 'right' })"))
        self.assertEqual([['Length', 'right']], page.evaluate('synInteractions'))
        self.assertEqual(['WindowLevel', 'Pan', 'Zoom', 'StackScroll', 'Length', 'Angle', 'EllipticalROI', 'Capture', 'Pointer'],
                         [tool['id'] for tool in page.evaluate("synUI.tools()")])
        self.assertIn('Length', page.evaluate('synSetupTools'), 'the tool catalog is known during setup')
        # Refused while a workspace is restored: the active cell stays where it was.
        page.evaluate("() => { synBusy = true; synActive = 'left'; synActivated.length = 0; }")
        self.assertFalse(page.evaluate("synUI.invoke('Length', { viewportId: 'right' })"))
        self.assertEqual(['left', []], page.evaluate("[synActive, synActivated]"))
        page.evaluate("() => synBusy = false")
        self.assertFalse(page.evaluate("synUI.invoke('Length', { viewportId: 'missing' })"), 'an unknown cell')
        self.assertEqual('left', page.evaluate('synActive'))
        page.evaluate("() => synEnded = true")
        self.assertFalse(page.evaluate("KinViewerFeatures.run('synMirror')"))
        self.assertFalse(page.evaluate("synUI.invoke('Length', { viewportId: 'left' })"))
        self.assertEqual([['synMirror']], page.evaluate('synCalls'))

    # ── Failure isolation, ui.load and dispose ──
    def test_08_one_module_failing_does_not_stop_the_others_and_dispose_cleans_up(self):
        held = []
        broken = """() => {
          KinViewerFeatures.module('broken', ({ ui }) => { ui.menuItem('Compare', { id: 'brokenItem', label: 'Broken', run: () => {} }); throw new Error('boom'); });
          KinViewerFeatures.module('rejects', async ({ ui }) => { ui.menuItem('Measure', { id: 'rejectsItem', label: 'Rejects', run: () => {} }); throw new Error('later'); });
          window.synDisposed = []; window.synLate = null;
          KinViewerFeatures.module('late', ({ ui }) => new Promise(resolve => { synLate = () => resolve(() => synDisposed.push('late')); }));
          KinViewerFeatures.module('loader', ({ ui }) => {
            window.synLoader = ui; window.synLoaded = []; window.synLayer = ui.cellLayer('left');
            return () => synDisposed.push('loader');
          });
        }"""
        page = self.open(modules=(broken, MODULE), routes={
            '/worklist/hpacs-lite/syn-missing.js': lambda route: route.fulfill(status=404, body=''),
            '/worklist/hpacs-lite/syn-slow.js': lambda route: held.append(route),
            '/worklist/hpacs-lite/syn-model.js': lambda route: route.fulfill(body='window.synModel = 7;', content_type='text/javascript'),
        })
        page.wait_for_function("() => synNotes.some(n => n.message.includes('rejects'))")
        self.assertEqual(['MG ▾', 'Display ▾', '‹ Prior', 'Prior ›', 'F.Leader'], self.texts(page, '.kin-ux-features-row > button'))
        self.assertEqual([], [i for i in page.evaluate("KinViewerFeatures.items()") if i['id'] in ('brokenItem', 'rejectsItem')])
        messages = [n['message'] for n in page.evaluate('synNotes')]
        self.assertIn('뷰어 기능 broken을(를) 설치하지 못했습니다.', messages)
        self.assertIn('뷰어 기능 rejects을(를) 설치하지 못했습니다.', messages)
        # ui.load: in order, a missing file rejects and is reported for that module only.
        self.assertEqual('ok', page.evaluate("synLoader.load(['syn-model.js']).then(() => synModel === 7 ? 'ok' : 'no')"))
        self.assertEqual('rejected', page.evaluate("synLoader.load('syn-missing.js').then(() => 'loaded', () => 'rejected')"))
        expect(page.locator('.kin-ux-toolbar-settings [role=status]')).to_have_text('loader: syn-missing.js을(를) 불러오지 못했습니다.')
        self.assertTrue(page.evaluate("() => KinViewerFeatures.run('synMirror')"))
        # Open what a module can open, then end the toolbar while a load and an install are still pending.
        page.evaluate("() => { synLoader.load('syn-slow.js').then(() => synLoaded.push('then'), () => synLoaded.push('catch')); }")
        page.wait_for_function("() => document.querySelector('script[src$=\"syn-slow.js\"]')")
        page.get_by_role('button', name='Display ▾').click()
        page.evaluate("() => synOpenOverlay()")
        self.assertTrue(page.evaluate("() => document.getElementById('pane-left').contains(synLayer)"))
        page.evaluate("() => synToolbar.dispose()")
        self.assertEqual(0, page.evaluate("() => document.querySelectorAll('.kin-ux-features, .kin-ux-feature-popup, .kin-ux-feature-panel, .kin-ux-cell-layer, .kin-ux-feature-settings').length"))
        self.assertEqual(['loader'], page.evaluate('synDisposed'))
        self.assertEqual([], page.evaluate("KinViewerFeatures.items()"))
        self.assertFalse(page.evaluate("KinViewerFeatures.run('synMirror')"))
        held[0].fulfill(body='window.synSlow = 1;', content_type='text/javascript')
        page.wait_for_function("() => window.synSlow === 1")
        page.evaluate("() => synLate()")
        page.wait_for_timeout(100)
        self.assertEqual([], page.evaluate('synLoaded'), 'a load that ends after dispose does nothing')
        self.assertEqual(['loader', 'late'], page.evaluate('synDisposed'), 'an install that ends after dispose is disposed at once')
        self.assertEqual([['synMirror']], page.evaluate('synCalls'), 'only the run before dispose')

    def test_10_account_read_before_mount_is_heard_at_once(self):
        # As the viewer opens: the account is read before the first mode mounts the toolbar.
        page = self.open(settings={'version': 2, 'bar': ['Zoom'], 'shortcuts': {}, 'features': {'smartZoom': True}}, mount=False)
        page.evaluate("async () => { await KinViewerUXToolbar.prepare(synSession); synMount(); }")
        self.assertEqual([['smartZoom', True], ['overlay', None]], page.evaluate('synHeard'))
        self.assertEqual(1, page.evaluate('synServer.gets'), 'no second read')
        self.assertIn('Length', page.evaluate('synSetupTools'))
        self.assertEqual([['smartZoom', True]], page.evaluate("() => { const heard = []; synStore.subscribe('smartZoom', v => heard.push(['smartZoom', v])); return heard; }"))

    def test_11_a_late_result_is_not_current_after_a_switch_another_series_or_dispose(self):
        late = """() => {
          window.synLate = [];
          KinViewerFeatures.module('late', ({ ui }) => {
            ui.menuItem('Compare', { id: 'lateRun', label: 'Slow', run: async ({ viewportId, current, signal }) => {
              await new Promise(resolve => { window.synFinish = resolve; });
              synLate.push([viewportId, current(), signal.aborted]);
            } });
          });
        }"""
        page = self.open(modules=(late,))
        finish = "() => { synFinish(); return new Promise(r => setTimeout(r, 20)); }"
        self.assertTrue(page.evaluate("KinViewerFeatures.run('lateRun')")); page.evaluate(finish)
        page.evaluate("() => { KinViewerFeatures.run('lateRun'); document.body.classList.add('kin-patient-switching'); }")
        page.evaluate("() => new Promise(r => setTimeout(r, 20))")
        page.evaluate("() => document.body.classList.remove('kin-patient-switching')"); page.evaluate(finish)
        page.evaluate("() => { KinViewerFeatures.run('lateRun', { viewportId: 'right' }); synShown.right = ['syn-set-9']; "
                      "synEmit('grid', 'gridState', { viewports: [{ viewportId: 'right', displaySetInstanceUIDs: ['syn-set-9'] }], removedViewportIds: [] }); }"); page.evaluate(finish)
        page.evaluate("() => { KinViewerFeatures.run('lateRun'); synToolbar.dispose(); }"); page.evaluate(finish)
        self.assertEqual([['left', True, False], ['left', False, True], ['right', False, True], ['left', False, True]], page.evaluate('synLate'))

    def test_13_cell_generations_catch_a_round_trip_and_a_switch_within_one_task(self):
        late = """() => {
          window.synLate = [];
          KinViewerFeatures.module('late', ({ ui }) => {
            ui.menuItem('Compare', { id: 'lateRun', label: 'Slow', run: async ({ viewportId, current, signal }) => {
              window.synCurrent = current; window.synSignal = signal;
              await new Promise(resolve => { window.synFinish = resolve; });
              synLate.push([viewportId, current(), signal.aborted]);
            } });
          });
        }"""
        page = self.open(modules=(late,))
        finish = "() => { synFinish(); return new Promise(r => setTimeout(r, 20)); }"
        shown = "(id, sets) => { synShown[id] = sets; synEmit('grid', 'gridState', { viewports: [{ viewportId: id, displaySetInstanceUIDs: sets }], removedViewportIds: [] }); }"
        page.evaluate("s => { window.synShow = eval(s); }", shown)
        # A → B → A in the cell: the same series is back, but the action started on the first A is no longer current,
        # and its signal was aborted as soon as the cell moved on.
        page.evaluate("() => KinViewerFeatures.run('lateRun', { viewportId: 'right' })")
        page.evaluate("() => synShow('right', ['syn-set-9'])")
        self.assertTrue(page.evaluate('synSignal.aborted'), 'aborted when the cell is given other images')
        page.evaluate("() => synShow('right', ['syn-set-2'])")
        page.evaluate(finish)
        # A patient switch that begins and ends within one task, judged before the observer has delivered it.
        self.assertEqual([False, True, False], page.evaluate("""() => {
          KinViewerFeatures.run('lateRun'); const current = synCurrent, signal = synSignal, before = signal.aborted;
          document.body.classList.add('kin-patient-switching'); document.body.classList.remove('kin-patient-switching');
          return [current(), signal.aborted, before];
        }"""))
        page.evaluate("() => new Promise(r => setTimeout(r, 20))")
        page.evaluate(finish)
        # The same for an emptied viewer, delivered by the observer before the action ends.
        page.evaluate("() => { KinViewerFeatures.run('lateRun'); document.body.classList.add('kin-viewer-empty'); document.body.classList.remove('kin-viewer-empty'); }")
        page.evaluate("() => new Promise(r => setTimeout(r, 20))")
        self.assertTrue(page.evaluate('synSignal.aborted'))
        page.evaluate(finish)
        # A switch that ended before the action started does not touch it.
        page.evaluate("() => { document.body.classList.add('kin-patient-switching'); document.body.classList.remove('kin-patient-switching'); KinViewerFeatures.run('lateRun'); }")
        page.evaluate("() => new Promise(r => setTimeout(r, 20))")
        page.evaluate(finish)
        # Another cell given other images, or new viewport data in another cell, leaves this cell's action current.
        page.evaluate("() => { KinViewerFeatures.run('lateRun', { viewportId: 'left' }); synShow('right', ['syn-set-7']); "
                      "synEmit('cells', 'data', { viewportId: 'right', viewportData: {} }); }")
        page.evaluate(finish)
        # New viewport data in this cell, and a grid change that names no cell (a new layout), each end it.
        page.evaluate("() => { KinViewerFeatures.run('lateRun', { viewportId: 'left' }); synEmit('cells', 'data', { viewportId: 'left', viewportData: {} }); }")
        page.evaluate(finish)
        page.evaluate("() => { KinViewerFeatures.run('lateRun', { viewportId: 'left' }); synEmit('grid', 'gridState', { state: {}, removedViewportIds: [] }); }")
        page.evaluate(finish)
        self.assertEqual([['right', False, True], ['left', False, True], ['left', False, True], ['left', True, False],
                          ['left', True, False], ['left', False, True], ['left', False, True]], page.evaluate('synLate'))

    # ── ui.invoke in a given cell: guards first, then the cell becomes active, then the tool is judged there ──
    def test_14_invoke_judges_the_tool_in_the_target_cell_once_the_viewer_has_made_it_active(self):
        page = self.open()
        page.evaluate("() => { synLaterActive = true; synOffIn = { Angle: ['left'], Zoom: ['left'] }; synActive = 'left'; }")
        # Unavailable in the active cell, available in the target: the target becomes active and the tool runs there.
        self.assertTrue(page.evaluate("synUI.invoke('Angle', { viewportId: 'right' })"))
        self.assertEqual([[['Angle', 'right']], 'right', ['right']], page.evaluate("[synInteractions, synActive, synActivated]"))
        # Available in the active cell, unavailable in the target: refused, and the target stays active.
        page.evaluate("() => { synInteractions.length = 0; synActivated.length = 0; }")
        self.assertFalse(page.evaluate("synUI.invoke('Zoom', { viewportId: 'left' })"))
        self.assertEqual([[], 'left', ['left']], page.evaluate("[synInteractions, synActive, synActivated]"))
        # The target is the active cell: judged and run there without a change of cell.
        page.evaluate("() => { synActivated.length = 0; }")
        self.assertFalse(page.evaluate("synUI.invoke('Zoom', { viewportId: 'left' })"))
        self.assertTrue(page.evaluate("synUI.invoke('Length', { viewportId: 'left' })"))
        self.assertEqual([[['Length', 'left']], []], page.evaluate("[synInteractions, synActivated]"))
        # The viewer never makes the target active: nothing runs in the cell that is active instead.
        page.evaluate("() => { synInteractions.length = 0; synActivationLost = true; }")
        self.assertFalse(page.evaluate("synUI.invoke('Length', { viewportId: 'right' })"))
        self.assertEqual([[], 'left'], page.evaluate("[synInteractions, synActive]"))
        # The guards come before the change of cell: a workspace being restored leaves the active cell where it was.
        page.evaluate("() => { synActivationLost = false; synBusy = true; synActivated.length = 0; }")
        self.assertFalse(page.evaluate("synUI.invoke('Length', { viewportId: 'right' })"))
        self.assertEqual(['left', []], page.evaluate("[synActive, synActivated]"))

    def test_12_a_module_failing_after_settings_opened_leaves_no_check_to_save(self):
        doomed = """() => {
          KinViewerFeatures.module('doomed', async ({ ui }) => {
            ui.setting({ id: 'doomedCheck', kind: 'check', label: 'Doomed Check', key: 'doomed' });
            await new Promise((_, reject) => { window.synDoom = () => reject(new Error('late failure')); });
          });
        }"""
        page = self.open(modules=(doomed, MODULE), settings={'version': 2, 'bar': ['Zoom'], 'shortcuts': {}})
        page.get_by_role('button', name='Viewer Settings').click()
        settings = page.locator('dialog.kin-ux-settings')
        settings.get_by_role('checkbox', name='Doomed Check').check()
        settings.get_by_role('checkbox', name='Smart Zoom').check()
        page.evaluate("() => synDoom()")
        expect(settings.get_by_role('checkbox', name='Doomed Check')).to_have_count(0)
        expect(settings.get_by_role('checkbox', name='Smart Zoom')).to_be_checked()
        settings.get_by_role('button', name='Save').click()
        expect(settings).to_be_hidden()
        self.assertEqual({'smartZoom': True}, page.evaluate('synServer.puts.at(-1).viewerSettings.features'))

    # ── Narrow screens: every button of the full group and of the toolbar can be reached ──
    def test_09_full_group_every_button_reachable_at_768x1024_and_1024x768(self):
        for size in [(768, 1024), (1024, 768)]:
            with self.subTest(size=size):
                page = self.open(modules=(FULL,), size=size)
                labels = page.evaluate("() => [...document.querySelectorAll('.kin-ux-toolbar button, .kin-ux-toolbar summary')]"
                                       ".filter(n => !n.closest('.kin-ux-more > div') && !n.matches('.kin-ux-tools-scroll, .kin-ux-features-scroll') && !n.hidden && !n.closest('[hidden]'))"
                                       ".map(n => n.getAttribute('aria-label') || n.textContent)")
                for name in ['MG ▾', 'Navigate ▾', 'Display ▾', 'Compare ▾', 'Measure ▾', '‹ Prior', 'Prior ›', 'F.Leader', 'Viewer Settings', 'More', 'Window / Level', 'Pointer']:
                    self.assertIn(name, labels)
                self.assertEqual(36, round(page.evaluate("() => document.querySelector('.kin-ux-toolbar').getBoundingClientRect().height")), 'one row')
                for name in labels:
                    self.assertTrue(self.reach(page, name), (size, name))

    def reach(self, page, name):
        """Pages the row holding the button with its own arrows until the button's centre is the button on screen."""
        visible = """name => {
          const node = [...document.querySelectorAll('.kin-ux-toolbar button, .kin-ux-toolbar summary')].find(n => (n.getAttribute('aria-label') || n.textContent) === name);
          const r = node.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
          const row = node.closest('.kin-ux-features-row, .kin-ux-tools-bar');
          const clip = row ? row.getBoundingClientRect() : { left: 0, right: innerWidth };
          if (x < Math.max(0, clip.left) || x > Math.min(innerWidth, clip.right)) return { seen: false, row: row && (row.matches('.kin-ux-tools-bar') ? 'Next Tools' : 'Next Feature Menus') };
          const hit = document.elementFromPoint(x, y)?.closest('button, summary');
          return { seen: hit === node, row: null };
        }"""
        for _ in range(12):
            state = page.evaluate(visible, name)
            if state['seen']:
                return True
            if not state['row']:
                return False
            pager = page.get_by_role('button', name=state['row'], exact=True)
            if not pager.is_visible():
                return False
            pager.click(); page.wait_for_timeout(400)
        return False


if __name__ == "__main__":
    unittest.main()
