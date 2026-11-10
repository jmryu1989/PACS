"""A3 unit 11 (D-viewer-panels): Studies panel Recent/All tabs and the toolbar Pointer.

C-R01-027 #18/#19: the pinned OHIF 3.9.1 Studies panel builds Primary/Recent/All tabs but shows them only as a
dropdown behind its settings icon. The fixture models that panel as React 18 leaves it in the DOM. The element carries
the fiber it was created with, later commits land on that fiber's alternate, and the StudyBrowser props sit on the
host fiber's return. Selecting a tab calls the panel's own onClickTab, and the panel re-renders its list.
C-R01-029 #52: the Image Tools bar offers Pointer at the end of the default bar, after the existing tools, and in More
when an account already saved its own bar. The stack-mouse side (no primary tool) is covered by
tests/viewer_stack_mouse_test.cjs.
"""
import json
from pathlib import Path
import unittest

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'http://kin.test'
SHELL_PAGE = """<!doctype html><html><body>
<div id="root"><div class="side" style="display:flex;flex-direction:column;width:280px;height:400px">
  <div class="bg-muted" id="studies-header"><svg><title>icon-display-settings</title></svg>
    <button role="radio" aria-label="list"></button><button role="radio" aria-label="thumbnails"></button></div>
  <div data-cy="studyBrowser-panel" style="flex:1;overflow:auto"></div>
</div></div></body></html>"""
SHELL_STUBS = """
window.cornerstone = { Enums: { Events: {} } };
const chrome = () => ({ refresh() {}, place() {}, adopt() {}, invalidate() {}, dispose() {} });
window.KinViewerPatientTabs = { snapshot: () => null, subscribe: () => () => {}, mount() {}, refresh() {}, dispose() {}, guard: () => false };
window.KinViewerInfoBar = { mount: chrome, identity: () => ({}) };
window.KinViewerSeriesStrip = { mount: chrome };
"""
NATIVE_PANEL = """
const studies = [
  { studyInstanceUid: 'S1', date: '10-Nov-2026', description: 'MR BRAIN W CONTRAST' },
  { studyInstanceUid: 'S2', date: '13-Jun-2026', description: 'MR BRAIN' },
  { studyInstanceUid: 'S3', date: '10-Nov-2024', description: 'CT BRAIN' }];
window.native = { active: 'all', clicks: [], recent: [studies[0], studies[1]], commits: 0 };
const panel = document.querySelector('[data-cy="studyBrowser-panel"]'), key = Math.random().toString(36).slice(2);
const hosts = [{}, {}]; hosts[0].alternate = hosts[1]; hosts[1].alternate = hosts[0];
panel['__reactFiber$' + key] = hosts[0];
window.commit = () => {
  const tabs = [{ name: 'primary', label: 'Primary', studies: [studies[0]] }, { name: 'recent', label: 'Recent', studies: native.recent },
    { name: 'all', label: 'All', studies }];
  const props = { tabs, activeTabName: native.active, showSettings: false,
    onClickTab: name => { native.clicks.push(name); setTimeout(() => { native.active = name; commit(); }, 20); } };
  const host = hosts[native.commits++ % 2];
  host.memoizedProps = { 'data-cy': 'studyBrowser-panel', children: [] };
  host.return = { memoizedProps: props, return: { memoizedProps: { servicesManager: {} }, return: null } };
  panel['__reactProps$' + key] = host.memoizedProps;
  panel.replaceChildren(...tabs.find(tab => tab.name === native.active).studies.map(study => {
    const item = document.createElement('div'); item.className = 'study'; item.textContent = study.date + ' ' + study.description; return item; }));
};
commit();
const service = () => ({ EVENTS: {}, subscribe: () => ({ unsubscribe() {} }) });
window.shell = KinViewerUXShell.mount({ services: { viewportGridService: service(), displaySetService: service(),
  cornerstoneViewportService: service() }, session: { owner: () => null, readOnly: () => false } });
"""
TOOLBAR_PAGE = '<!doctype html><html><body><div id="root"><div class="kin-ux-toolbar-slot"></div></div></body></html>'
TOOLBAR_HARNESS = """
window.KinSessionTransport = { refusal: () => false, responseError: () => new Error('refused') };
window.KinViewerHangingSettings = { modalities: [], defaults: {}, get: () => ({}),
  mount: () => ({ apply() {}, dispose() {} }), mountSizing: () => ({ dispose() {} }) };
const state = window.mouse = { active: 'StackScroll', pointing: false, calls: [] };
window.kinViewerStackMouse = { pointing: () => state.pointing, deselect: () => false,
  point() { state.calls.push('point'); state.pointing = true; state.active = null; return true; } };
const listeners = new Set();
window.toolbarModified = () => listeners.forEach(fn => fn());
const radio = (id, label) => ({ id, uiType: 'ohif.radioGroup', props: { id, label, commands: [{ commandName: 'setToolActiveToolbar' }] } });
const measure = { Length: 'Length', Angle: 'Angle', EllipticalROI: 'Ellipse', RectangleROI: 'Rectangle' };
const buttons = { WindowLevel: radio('WindowLevel', 'Window Level'), Pan: radio('Pan', 'Pan'), Zoom: radio('Zoom', 'Zoom'),
  StackScroll: radio('StackScroll', 'Stack Scroll'), MeasurementTools: { id: 'MeasurementTools', uiType: 'ohif.splitButton', props: {
    primary: { id: 'Length', label: 'Length', commands: [{ commandName: 'setToolActiveToolbar' }] },
    items: Object.entries(measure).map(([id, label]) => ({ id, label, commands: [{ commandName: 'setToolActiveToolbar' }] })) } } };
const toolbarService = { EVENTS: { TOOL_BAR_MODIFIED: 'modified' }, getButtons: () => buttons,
  getButtonSection: () => Object.keys(buttons).map(id => ({ id })),
  getButtonProps: id => ({ id, disabled: false, isActive: state.active === id }),
  // As the pinned ToolbarService: run the command, then refreshToolbarState -> setButtons broadcasts TOOL_BAR_MODIFIED.
  recordInteraction(item) { state.calls.push(item.itemId); state.active = item.itemId; state.pointing = false; toolbarModified(); },
  subscribe(event, fn) { listeners.add(fn); return { unsubscribe() { listeners.delete(fn); } }; } };
window.toolbar = KinViewerUXToolbar.mount({ session: { state: () => 'writer', decide: async () => {}, writer: () => true,
  ended: () => false, owner: () => ['kin', 'reader'] }, services: { toolbarService,
  viewportGridService: { getActiveViewportId: () => 'left' }, cornerstoneViewportService: { getCornerstoneViewport: () => null } } });
"""
LABELS = 'nodes => nodes.map(node => node.getAttribute("aria-label"))'


class ViewerStudyTabsPointerDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def open(self, html, settings=None):
        page = self.browser.new_page(viewport={'width': 1366, 'height': 900})
        self.addCleanup(page.close)
        page.methods = []

        def serve(route):
            if route.request.url.endswith('/api/workspace-shortcuts'):
                page.methods.append(route.request.method)
                route.fulfill(content_type='application/json',
                              body=json.dumps({'owner': ['kin', 'reader'], 'revision': 3, 'viewerSettings': settings}))
            else:
                route.fulfill(content_type='text/html', body=html)
        page.route(ORIGIN + '/**', serve)
        page.goto(ORIGIN + '/ohif/viewer')
        page.add_style_tag(path=str(ROOT / 'worklist-v0/hpacs-lite/viewer-ux-theme.css'))
        return page

    def test_studies_panel_shows_recent_and_all_tabs_that_drive_the_stock_list(self):
        page = self.open(SHELL_PAGE)
        page.add_script_tag(content=SHELL_STUBS)
        page.add_script_tag(path=str(ROOT / 'worklist-v0/hpacs-lite/viewer-ux-shell.js'))
        page.add_script_tag(content=NATIVE_PANEL)
        tabs = page.get_by_role('tablist', name='Study List')
        expect(tabs).to_be_visible()
        expect(tabs.get_by_role('tab')).to_have_text(['Primary', 'Recent', 'All'])
        # The row sits between the stock header (settings icon, list/thumbnails) and the stock list; both stay.
        self.assertTrue(page.evaluate('''() => { const row = document.querySelector('.kin-study-tabs');
          return row.previousElementSibling.id === 'studies-header' && row.nextElementSibling.dataset.cy === 'studyBrowser-panel'
            && document.querySelectorAll('#studies-header [role=radio]').length === 2; }'''))
        selected = lambda: tabs.get_by_role('tab').evaluate_all('nodes => nodes.map(node => node.getAttribute("aria-selected"))')
        self.assertEqual(selected(), ['false', 'false', 'true'], 'the stock panel opens on All')
        studies = page.locator('[data-cy="studyBrowser-panel"] .study')
        expect(studies).to_have_count(3)
        # Recent: the stock panel filters its own list (the 2-year-old CT is left out).
        tabs.get_by_role('tab', name='Recent', exact=True).click()
        expect(studies).to_have_text(['10-Nov-2026 MR BRAIN W CONTRAST', '13-Jun-2026 MR BRAIN'])
        page.wait_for_timeout(400)  # past the row's own 300 ms hold: the state shown is the stock panel's committed one
        self.assertEqual(selected(), ['false', 'true', 'false'])
        tabs.get_by_role('tab', name='All', exact=True).click()
        expect(studies).to_have_count(3)
        page.wait_for_timeout(400)
        self.assertEqual(selected(), ['false', 'false', 'true'])
        self.assertEqual(page.evaluate('native.clicks'), ['recent', 'all'])
        # The stock panel changing its own tab (jump to a thumbnail) is followed.
        page.evaluate("() => { native.active = 'primary'; commit(); }")
        page.wait_for_function('() => document.querySelector(".kin-study-tabs [data-tab=primary]").getAttribute("aria-selected") === "true"')
        # A tab the stock panel has no study for cannot be chosen, as in its own dropdown.
        page.evaluate('() => { native.recent = []; commit(); }')
        expect(tabs.get_by_role('tab', name='Recent', exact=True)).to_be_disabled()
        # Without the stock panel's props the row is removed instead of offering tabs that do nothing.
        page.evaluate('''() => { const plain = document.createElement('div'); plain.dataset.cy = 'studyBrowser-panel';
          document.querySelector('[data-cy="studyBrowser-panel"]').replaceWith(plain); }''')
        expect(tabs).to_have_count(0)
        page.evaluate('shell.dispose()')
        expect(page.locator('.kin-study-tabs')).to_have_count(0)

    def toolbar(self, settings):
        page = self.open(TOOLBAR_PAGE, settings)
        page.add_script_tag(path=str(ROOT / 'worklist-v0/hpacs-lite/viewer-ux-shortcuts.js'))
        page.add_script_tag(path=str(ROOT / 'worklist-v0/hpacs-lite/viewer-ux-toolbar.js'))
        page.add_script_tag(content=TOOLBAR_HARNESS)
        tools = page.get_by_role('region', name='Image Tools', exact=True)
        expect(tools.get_by_role('status')).to_have_text('계정 설정 · 다른 PC에서도 적용됩니다.')
        return page, tools

    def test_default_bar_adds_pointer_after_the_existing_tools(self):
        page, tools = self.toolbar(None)
        bar = tools.get_by_role('toolbar', name='Frequent Tools')
        self.assertEqual(bar.get_by_role('button').evaluate_all(LABELS),
                         ['Window Level', 'Pan', 'Zoom', 'Stack Scroll', 'Length', 'Angle', 'Ellipse', 'Pointer'])
        pointer = bar.get_by_role('button', name='Pointer', exact=True)
        stack = bar.get_by_role('button', name='Stack Scroll', exact=True)
        expect(pointer).to_be_enabled()
        expect(pointer).to_have_attribute('aria-pressed', 'false')
        expect(pointer).to_have_attribute('title', 'Pointer · 단축키 미지정 — 끌어서 도구 위치를 바꿀 수 있습니다.')
        expect(stack).to_have_attribute('aria-pressed', 'true')
        pointer.click()
        expect(pointer).to_have_attribute('aria-pressed', 'true')
        expect(stack).to_have_attribute('aria-pressed', 'false')
        # Another tool still goes through the stock toolbar and takes the primary button back.
        bar.get_by_role('button', name='Length', exact=True).click()
        expect(pointer).to_have_attribute('aria-pressed', 'false')
        self.assertEqual(page.evaluate('mouse.calls'), ['point', 'Length'])
        # Not offered where the stack mouse has no group for the active cell (an MPR cell).
        page.evaluate('() => { mouse.pointing = null; toolbarModified(); }')
        expect(pointer).to_be_disabled()
        self.assertEqual(page.methods, ['GET'], 'opening the viewer writes no settings')

    def test_saved_bar_is_kept_and_pointer_is_offered_in_more(self):
        saved = {'version': 2, 'bar': ['Zoom', 'Length'], 'shortcuts': {'Zoom': 'z', 'Length': 'l'}}
        page, tools = self.toolbar(saved)
        bar = tools.get_by_role('toolbar', name='Frequent Tools')
        self.assertEqual(bar.get_by_role('button').evaluate_all(LABELS), ['Zoom', 'Length'])
        tools.locator('summary').click()
        pointer = tools.get_by_role('group', name='More Tools').get_by_role('button', name='Pointer', exact=True)
        expect(pointer).to_be_enabled()
        pointer.click()
        self.assertEqual(page.evaluate('mouse.calls'), ['point'])
        self.assertEqual(page.methods, ['GET'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
