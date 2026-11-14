# coding: utf-8
"""Monitors in Hanging Protocol on the shipped viewer chrome: the window opened from Viewer Settings (one row of choices
and one drawing per monitor, Save into a Hanging Protocol rule), and what an applied rule does to this window: the rows
stand on their monitor's part of the window (the real toolbar, with Viewer Settings, on the first monitor that shows
one), the other display gets fixed copies, Second Display keeps the patient tabs only, the worklist window's place is
read and reported, and everything goes back to the account's Toolbar & Thumbnail Position afterwards.

Runs the shipped viewer-ux-shell.js, viewer-series-strip.js, viewer-ux-toolbar.js, viewer-features.js,
viewer-features-chrome.js, viewer-features-monitors.js, viewer-display-layout.js, viewer-display-span.js,
hanging-protocol-model.js and viewer-ux-theme.css in the synthetic stock column of viewer_chrome_position_dom_test.py,
with a synthetic Hanging Protocols panel handle and, where two displays are needed, a synthetic screen-details answer
(window-management already granted) for two displays meeting in the middle of this window. Real monitors are not
emulated: the actual move of a window between two physical displays is checked on a real desktop."""
import unittest

from playwright.sync_api import sync_playwright, expect

from viewer_chrome_position_dom_test import BOXES, FRAME, HARNESS, HPACS, ORIGIN, OWNER, SETUP, TOOLS

RULE_ID = '11111111-1111-4111-8111-111111111111'
OTHER_ID = '22222222-2222-4222-8222-222222222222'


def monitor(images, **extra):
    return dict({'images': images, 'worklist': 'none', 'thumbs': 'top', 'toolbar': 'top'}, **extra)


def hp_rule(rule_id, name, monitors=None):
    value = {'id': rule_id, 'name': name, 'enabled': True, 'match': {'modality': None, 'retrieveAE': None, 'bodyPart': None, 'description': None},
             'selectors': [{'alias': 'Current', 'role': 'current', 'historical': False, 'modality': None, 'retrieveAE': None, 'bodyPart': None,
                            'description': None, 'laterality': None, 'order': 'ascending', 'occurrence': 1}],
             'layout': {'rows': 2, 'cols': 2, 'cells': ['Current', 'Current', 'Current', 'Current']}}
    if monitors:
        value['monitors'] = {'count': len(monitors), 'list': monitors}
    return value


HP = """([library, applied]) => {
  window.synLibrary = library; window.synApplied = applied; window.synSavedMonitors = [];
  window.KinViewerHangingProtocol = { current: () => ({ scope: () => 'personal', read: () => structuredClone(synLibrary),
    applied: () => synApplied && structuredClone(synApplied), selected: () => synLibrary.rules[0]?.id || null,
    saveMonitors: async (id, monitors) => { synSavedMonitors.push([id, structuredClone(monitors)]);
      const rule = synLibrary.rules.find(r => r.id === id); if (monitors) rule.monitors = monitors; else delete rule.monitors;
      return { ok: true, account: 'saved' }; } }) };
}"""

# Two displays side by side, each half of this window, the window-management permission already granted.
TWO_DISPLAYS = """() => {
  const half = innerWidth / 2, at = screenX + (outerWidth - innerWidth) / 2;
  const screens = [0, 1].map(i => ({ availLeft: at + i * half, availTop: screenY, availWidth: half, availHeight: 2000,
    left: at + i * half, top: screenY, width: half, height: 2000, isPrimary: i === 0, devicePixelRatio: devicePixelRatio }));
  window.synScreens = screens.map(s => ({ left: s.left, top: s.top, width: s.width, height: s.height }));
  const query = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = async value => value?.name === 'window-management' ? { state: 'granted', onchange: null } : query(value);
  window.getScreenDetails = async () => ({ screens, currentScreen: screens[0], addEventListener() {}, removeEventListener() {} });
}"""

# One display, and the browser says so.
ONE_DISPLAY = "() => { Object.defineProperty(screen, 'isExtended', { configurable: true, get: () => false }); }"


class MonitorHangingDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start(); cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self, library=None, applied=None, displays=ONE_DISPLAY, settings=None, second=True, size=(1366, 900)):
        context = self.browser.new_context(viewport={'width': size[0], 'height': size[1]})
        page = context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(ORIGIN + "/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        page.goto(ORIGIN + "/")
        page.add_style_tag(path=str(HPACS / "viewer-ux-theme.css"))
        for name in ["hanging-protocol-model.js", "viewer-display-layout.js", "viewer-ux-shortcuts.js", "viewer-features.js", "viewer-features-chrome.js",
                     "viewer-features-monitors.js", "viewer-ux-toolbar.js", "viewer-series-strip.js", "viewer-display-span.js", "viewer-ux-shell.js"]:
            page.add_script_tag(path=str(HPACS / name))
        page.evaluate(SETUP, [OWNER, TOOLS, 4])
        page.evaluate("settings => { synServer.viewerSettings = settings; }", settings)
        page.evaluate(HP, [library or {'version': 1, 'activeRuleId': None, 'rules': [hp_rule(RULE_ID, 'Brain CT'), hp_rule(OTHER_ID, 'Chest CT')]}, applied])
        if displays:
            page.evaluate(displays)
        page.evaluate("() => synMount()")
        expect(page.locator('.kin-ux-toolbar-slot > .kin-ux-toolbar')).to_have_count(1)
        expect(page.locator('.kin-series-card')).to_have_count(4)
        page.wait_for_function("KinViewerFeatures.settings().some(s => s.id === 'monitorHanging')")
        page.evaluate("second => { window.synSecond = second; window.synSpan = KinViewerDisplaySpan.mount({ services: synServices, enabled: () => synSecond }); }", second)
        page.evaluate(FRAME)
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    def window(self, page):
        dialog = page.locator('dialog.kin-ux-settings')
        if not dialog.evaluate('n => n.open'):
            page.get_by_role('button', name='Viewer Settings').click()
        dialog.locator('.kin-ux-feature-setting-buttons').get_by_role('button', name='Monitors in Hanging Protocol…').click()
        panel = page.locator('dialog.kin-ux-feature-panel[aria-label="Monitors in Hanging Protocol"]')
        expect(panel).to_be_visible()
        return panel

    def prepare(self, page, monitors, list_rect='absent'):
        if list_rect != 'absent':
            page.evaluate("rect => { window.kinViewerListPlace = async () => rect; }", list_rect)
        result = page.evaluate("""async rule => { const answer = await KinViewerMonitors.prepare(rule);
          window.synAnswer = answer; return { split: answer.split, note: answer.note }; }""", hp_rule(RULE_ID, 'Brain CT', monitors))
        page.evaluate(FRAME); page.evaluate(FRAME)
        return result

    # ── The window (the stories' steps: choose 2 monitors, change the second monitor's thumbnails, Close) ──
    def test_01_one_row_and_one_drawing_per_monitor_and_close_returns_to_viewer_settings(self):
        page = self.open()
        panel = self.window(page)
        expect(panel.get_by_label('Hanging Protocol')).to_have_value(RULE_ID)
        expect(panel.get_by_label('Monitors')).to_have_value('1')
        expect(panel.locator('table tr').first.locator('th')).to_have_text(['Monitor', 'Images', 'Worklist', 'Thumbnails', 'Toolbar'])
        options = lambda label: panel.get_by_label(label).locator('option').evaluate_all('n => n.map(o => o.textContent)')
        self.assertEqual(['None', '1 × 1', '1 × 2', '2 × 1', '2 × 2', 'Automatic'], options('Monitor 1 Images'))
        self.assertEqual(['Show', 'None'], options('Monitor 1 Worklist'))
        self.assertEqual(['Top', 'Bottom', 'Left', 'Right', 'None'], options('Monitor 1 Thumbnails'))
        self.assertEqual(['Top', 'Bottom', 'Left', 'Right', 'None'], options('Monitor 1 Toolbar'))
        panel.get_by_label('Monitors').select_option('2')
        drawings = panel.locator('.kin-chrome-monitor')
        expect(drawings).to_have_count(2)
        expect(panel.get_by_label('Monitor 2 Thumbnails')).to_be_visible()
        first = drawings.nth(0).get_attribute('aria-label')
        panel.get_by_label('Monitor 2 Images').select_option('2x2')
        panel.get_by_label('Monitor 2 Thumbnails').select_option('left')
        self.assertEqual(first, drawings.nth(0).get_attribute('aria-label'), 'only the second drawing changes')
        expect(drawings.nth(1)).to_have_attribute('aria-label', 'Monitor 2: Images 2 × 2, Worklist None, Thumbnails Left, Toolbar Top')
        expect(drawings.nth(1).locator('.kin-chrome-thumbs')).to_have_count(1)
        expect(drawings.nth(1).locator('.kin-chrome-images > div')).to_have_count(4)
        # Nothing moved: no rule was saved or applied.
        self.assertEqual([], page.evaluate('synSavedMonitors'))
        self.assertIsNone(page.evaluate("document.body.getAttribute('data-kin-monitor-rows')"))
        panel.get_by_role('button', name='Close').click()
        expect(panel).to_have_count(0)
        settings = page.locator('dialog.kin-ux-settings')
        expect(settings).to_be_visible()
        expect(settings.get_by_role('button', name='Monitors in Hanging Protocol…')).to_be_visible()
        expect(settings.get_by_role('button', name='Save')).to_be_visible()

    def test_02_save_keeps_the_monitors_in_the_chosen_rule(self):
        page = self.open()
        panel = self.window(page)
        panel.get_by_label('Hanging Protocol').select_option(OTHER_ID)
        panel.get_by_label('Monitors').select_option('2')
        panel.get_by_label('Monitor 1 Images').select_option('none')
        panel.get_by_label('Monitor 1 Worklist').select_option('show')
        panel.get_by_label('Monitor 1 Thumbnails').select_option('none')
        panel.get_by_label('Monitor 1 Toolbar').select_option('none')
        panel.get_by_label('Monitor 2 Images').select_option('1x2')
        panel.get_by_label('Monitor 2 Thumbnails').select_option('left')
        panel.get_by_role('button', name='Save').click()
        expect(panel.get_by_role('status')).to_contain_text('Hanging Protocol "Chest CT"에 이 브라우저와 계정 모두 저장했습니다')
        self.assertEqual([[OTHER_ID, {'count': 2, 'list': [monitor('none', worklist='show', thumbs='none', toolbar='none'), monitor('1x2', thumbs='left')]}]],
                         page.evaluate('synSavedMonitors'))
        # The worklist window is one: Show on monitor 2 takes it from monitor 1.
        panel.get_by_label('Monitor 2 Worklist').select_option('show')
        expect(panel.get_by_label('Monitor 1 Worklist')).to_have_value('none')
        # Reopened, the window shows what the rule holds.
        panel.get_by_role('button', name='Close').click()
        panel = self.window(page)
        panel.get_by_label('Hanging Protocol').select_option(OTHER_ID)
        expect(panel.get_by_label('Monitors')).to_have_value('2')
        expect(panel.get_by_label('Monitor 2 Images')).to_have_value('1x2')

    def test_03_save_refuses_monitors_without_a_toolbar(self):
        page = self.open()
        panel = self.window(page)
        panel.get_by_label('Monitor 1 Toolbar').select_option('none')
        panel.get_by_role('button', name='Save').click()
        expect(panel.get_by_role('status')).to_have_text('Viewer Settings에 돌아갈 수 있도록, 영상을 보이는 모니터 하나에는 도구 줄(Toolbar)이 있어야 합니다.')
        self.assertEqual([], page.evaluate('synSavedMonitors'))

    # ── An applied rule on this window ──
    def test_04_one_display_rows_on_their_edges_and_the_images_split_around_them(self):
        page = self.open()
        result = self.prepare(page, [monitor('2x1', thumbs='left', toolbar='bottom')])
        self.assertIn('적용 Monitor 1.', result['note'])
        split = result['split']
        self.assertEqual(2, len(split['rects'])); self.assertEqual([0, 1], split['cells'])
        boxes = page.evaluate(BOXES)
        column, toolbar, thumbs = boxes['column'], boxes['toolbar'], boxes['thumbs']
        self.assertAlmostEqual(column['bottom'], toolbar['bottom'], delta=1); self.assertAlmostEqual(36, toolbar['height'], delta=1)
        self.assertAlmostEqual(column['width'], toolbar['width'], delta=1)
        self.assertAlmostEqual(column['left'], thumbs['left'], delta=1); self.assertAlmostEqual(156, thumbs['width'], delta=1)
        self.assertAlmostEqual(toolbar['top'], thumbs['bottom'], delta=1, msg='the strip stands inside the toolbar')
        # The images' rectangles leave both bands free.
        grid = boxes['grid']
        for rect in split['rects']:
            self.assertGreaterEqual(grid['left'] + rect['x'] * grid['width'] + 0.5, thumbs['right'])
            self.assertLessEqual(grid['top'] + (rect['y'] + rect['height']) * grid['height'] - 0.5, toolbar['top'])
        self.assertEqual('', page.evaluate("document.body.getAttribute('data-kin-monitor-rows')"))
        # Undo puts back the account's rows exactly.
        page.evaluate('synAnswer.undo()'); page.evaluate(FRAME)
        self.assertIsNone(page.evaluate("document.body.getAttribute('data-kin-monitor-rows')"))
        self.assertEqual([], page.evaluate("() => [...document.body.attributes].map(a => a.name).filter(n => n.startsWith('data-kin'))"))

    def test_05_the_account_value_waits_while_a_rule_places_the_rows_and_returns_after(self):
        page = self.open(settings={'version': 2, 'bar': ['WindowLevel', 'Pan', 'Zoom'], 'shortcuts': {},
                                   'features': {'chrome': {'toolbar': 'right', 'toolbarAutoHide': False, 'thumbs': 'left', 'thumbsAutoHide': False}}})
        expect(page.locator('body')).to_have_attribute('data-kin-toolbar-side', 'right')
        self.prepare(page, [monitor('1x1', thumbs='bottom', toolbar='top')])
        page.evaluate('synAnswer.commit()')
        expect(page.locator('body')).to_have_attribute('data-kin-toolbar-side', 'top')
        # A rule without monitors applied afterwards (Hanging Protocols calls clear()): the account's rows come back.
        page.evaluate('KinViewerMonitors.clear()'); page.evaluate(FRAME)
        expect(page.locator('body')).to_have_attribute('data-kin-toolbar-side', 'right')
        expect(page.locator('body')).not_to_have_attribute('data-kin-monitor-rows', '')

    def test_06_two_displays_the_real_toolbar_stands_on_the_monitor_that_shows_one(self):
        page = self.open(displays=TWO_DISPLAYS)
        result = self.prepare(page, [monitor('1x1', toolbar='none', thumbs='none'), monitor('2x2', toolbar='top', thumbs='right')])
        self.assertIn('적용 Monitor 1·Monitor 2.', result['note'])
        split = result['split']
        self.assertEqual(5, len(split['rects']))
        boxes = page.evaluate(BOXES)
        half = (boxes['column']['left'] + boxes['column']['right']) / 2
        self.assertAlmostEqual(half, boxes['toolbar']['left'], delta=1, msg='the toolbar is on monitor 2 only')
        self.assertAlmostEqual(boxes['column']['right'], boxes['toolbar']['right'], delta=1)
        self.assertAlmostEqual(boxes['column']['right'], boxes['thumbs']['right'], delta=1)
        settings = page.get_by_role('button', name='Viewer Settings')
        self.assertGreaterEqual(settings.bounding_box()['x'], half - 1, 'Viewer Settings is reached on monitor 2')
        # Monitor 1's cell fills its half; no copy of a row that only one monitor shows.
        self.assertIn({'x': 0, 'y': 0, 'width': 0.5, 'height': 1}, split['rects'])
        expect(page.locator('.kin-span-fixed')).to_have_count(0)
        # The grid is not shifted to the seam by the span module while the rule holds it.
        self.assertEqual([], page.evaluate("() => [...document.querySelectorAll('style')].map(s => s.textContent).filter(t => t.includes('[data-cy=\"viewport-grid\"] { margin-left'))"))

    def test_07_two_displays_the_other_monitor_gets_fixed_copies_and_second_display_keeps_only_the_tabs(self):
        page = self.open(displays=TWO_DISPLAYS, second=False)
        self.prepare(page, [monitor('1x2', toolbar='top', thumbs='left'), monitor('1x2', toolbar='bottom', thumbs='right')])
        tools = page.locator('.kin-span-fixed[aria-label="Image Tools (Second Display)"]')
        series = page.locator('.kin-span-fixed[aria-label="Series (Second Display)"]')
        expect(tools).to_have_count(1); expect(series).to_have_count(1)
        expect(tools).to_be_visible(); expect(series).to_be_visible()
        boxes = page.evaluate(BOXES)
        half = (boxes['column']['left'] + boxes['column']['right']) / 2
        tbox, sbox = tools.bounding_box(), series.bounding_box()
        self.assertAlmostEqual(half, tbox['x'], delta=1); self.assertAlmostEqual(boxes['column']['bottom'], tbox['y'] + tbox['height'], delta=1)
        self.assertAlmostEqual(boxes['column']['right'], sbox['x'] + sbox['width'], delta=1); self.assertAlmostEqual(156, sbox['width'], delta=1)
        self.assertLessEqual(boxes['toolbar']['right'], half + 1, 'the original toolbar stays on monitor 1')
        # A copy forwards to the original control.
        page.evaluate("() => { window.synPan = 0; document.querySelector('.kin-ux-toolbar-slot [data-tool=Pan]').addEventListener('click', () => synPan++); }")
        tools.get_by_role('button', name='Pan').click()
        self.assertEqual(1, page.evaluate('synPan'))
        # Second Display is off: the patient tabs have no copy, the rows the rule places do.
        expect(page.locator('.kin-span-mirror[aria-label="Patients (Second Display)"]')).to_have_count(0)
        # Back to the account's rows: the fixed copies go, and Second Display off again takes every copy.
        page.evaluate('synAnswer.undo()'); page.evaluate(FRAME); page.evaluate(FRAME)
        expect(page.locator('.kin-span-fixed')).to_have_count(0)

    def test_08_the_worklist_window_is_read_not_moved(self):
        page = self.open(displays=TWO_DISPLAYS)
        rules = [monitor('none', worklist='show', toolbar='none', thumbs='none'), monitor('2x2')]
        here = page.evaluate("() => ({ left: synScreens[0].left + 10, top: 10, width: 400, height: 300 })")
        there = page.evaluate("() => ({ left: synScreens[1].left + 10, top: 10, width: 400, height: 300 })")
        self.assertIn('Worklist: 목록 창이 Monitor 1에 있습니다.', self.prepare(page, rules, here)['note'])
        page.evaluate('synAnswer.undo()')
        self.assertIn('Worklist: 목록 창이 Monitor 1에 있지 않습니다(Monitor 2). 브라우저는 목록 창을 옮기지 않습니다.', self.prepare(page, rules, there)['note'])
        page.evaluate('synAnswer.undo()')
        self.assertIn('Worklist: 목록 창 위치를 확인할 수 없습니다.', self.prepare(page, rules, None)['note'])

    def test_09_without_display_information_nothing_is_claimed(self):
        page = self.open(displays="() => { Object.defineProperty(screen, 'isExtended', { configurable: true, get: () => true }); }")
        result = self.prepare(page, [monitor('1x1'), monitor('1x1')])
        self.assertIsNone(result['split'])
        self.assertIn('화면 정보를 확인할 수 없어 모니터별 배치를 적용하지 않았습니다', result['note'])
        self.assertIsNone(page.evaluate("document.body.getAttribute('data-kin-monitor-rows')"))

    def test_10_a_monitor_beyond_the_displays_is_reported(self):
        page = self.open()
        result = self.prepare(page, [monitor('1x1'), monitor('1x1'), monitor('1x1')])
        self.assertIn('Monitor 2: 이 화면 구성에 없어 적용하지 않았습니다.', result['note'])
        self.assertIn('Monitor 3: 이 화면 구성에 없어 적용하지 않았습니다.', result['note'])
        self.assertIn('규칙의 칸 2, 3, 4은(는) 모니터 칸 수가 모자라 보이지 않습니다.', result['note'])

    def test_11_an_abort_puts_the_rows_back(self):
        page = self.open()
        state = page.evaluate("""async rule => { const control = new AbortController();
          const pending = KinViewerMonitors.prepare(rule, { signal: control.signal }); control.abort();
          try { await pending; return 'answered'; } catch (error) { return error.name; } }""", hp_rule(RULE_ID, 'Brain CT', [monitor('1x1', toolbar='left')]))
        self.assertEqual('AbortError', state)
        page.evaluate(FRAME)
        self.assertIsNone(page.evaluate("document.body.getAttribute('data-kin-monitor-rows')"))

    def test_12_an_aborted_prepare_that_answers_late_leaves_the_next_rule_alone(self):
        page = self.open()
        # Rule A waits on the worklist's answer; it is aborted, rule B is applied, then A's answer comes.
        page.evaluate("() => { window.kinViewerListPlace = () => new Promise(resolve => { window.synRelease = resolve; }); }")
        page.evaluate("""rule => { window.synControl = new AbortController();
          window.synA = KinViewerMonitors.prepare(rule, { signal: synControl.signal }).then(() => 'answered', error => error.name); }""",
                      hp_rule(RULE_ID, 'Rule A', [monitor('1x1', worklist='show', toolbar='left')]))
        page.wait_for_function("() => typeof window.synRelease === 'function'")
        expect(page.locator('body')).to_have_attribute('data-kin-toolbar-side', 'left')
        page.evaluate('synControl.abort()'); page.evaluate(FRAME)
        self.assertIsNone(page.evaluate("document.body.getAttribute('data-kin-monitor-rows')"), 'the abort puts the rows back at once')
        page.evaluate("""async rule => { const b = await KinViewerMonitors.prepare(rule); b.commit(); }""",
                      hp_rule(OTHER_ID, 'Rule B', [monitor('1x1', toolbar='right')]))
        expect(page.locator('body')).to_have_attribute('data-kin-toolbar-side', 'right')
        page.evaluate('synRelease(null)')
        self.assertEqual('AbortError', page.evaluate('synA'))
        page.evaluate(FRAME)
        expect(page.locator('body')).to_have_attribute('data-kin-toolbar-side', 'right')
        self.assertEqual('', page.evaluate("document.body.getAttribute('data-kin-monitor-rows')"), "rule B's rows stay")

    def test_13_a_resized_window_gives_the_rows_back_and_says_so(self):
        page = self.open()
        self.prepare(page, [monitor('2x1', thumbs='left', toolbar='bottom')])
        page.evaluate('synAnswer.commit()')
        self.assertEqual('', page.evaluate("document.body.getAttribute('data-kin-monitor-rows')"))
        page.set_viewport_size({'width': 1000, 'height': 800})
        page.wait_for_function("() => document.body.getAttribute('data-kin-monitor-rows') === null")
        page.wait_for_function("() => synNotes.some(n => String(n.message).includes('모니터별 도구 줄·썸네일 배치를 해제했습니다'))")
        # Back in the column's flow: the rows cover no image.
        boxes = page.evaluate(BOXES)
        self.assertAlmostEqual(boxes['toolbar']['bottom'], boxes['thumbs']['top'], delta=1)
        self.assertLessEqual(boxes['thumbs']['bottom'], boxes['grid']['top'] + 1)

    def test_14_both_monitors_with_a_toolbar_each_reach_viewer_settings(self):
        page = self.open(displays=TWO_DISPLAYS)
        self.prepare(page, [monitor('1x1', toolbar='top', thumbs='none'), monitor('1x1', toolbar='left', thumbs='none')])
        copy = page.locator('.kin-span-fixed[aria-label="Image Tools (Second Display)"]')
        expect(copy).to_be_visible()
        settings = copy.get_by_role('button', name='Viewer Settings')
        expect(settings).to_have_count(1)
        half = (page.evaluate(BOXES)['column']['left'] + page.evaluate(BOXES)['column']['right']) / 2
        self.assertGreaterEqual(settings.bounding_box()['x'], half - 1)
        settings.click()
        expect(page.locator('dialog.kin-ux-settings')).to_be_visible()


if __name__ == '__main__':
    unittest.main()
