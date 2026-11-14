# coding: utf-8
"""Monitors in Hanging Protocol in the shipped Hanging Protocols panel (hanging-protocol-model.js,
viewer-hanging-protocol.js): a rule with monitors is applied as the split the monitors module answers (one native
position per rectangle, each showing the rule cell dealt to it); the display set presets of each cell follow it there
and back; the split is rolled back to like any layout this panel built; a rule without monitors gives the rows back;
the monitors are saved into one of the reader's own rules. The monitors module itself (moving the window, placing the
rows) is replaced here by one that answers the pure split of viewer-features-monitors.js for two displays side by side;
it is checked in viewer_monitor_hanging_dom_test.py. Runs on the synthetic services of viewer_hanging_protocol_dom_test.py,
whose native grid honours layoutOptions as the pinned reducer does."""
import copy
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

from viewer_hanging_protocol_dom_test import HARNESS, MODEL, VIEWER, library, rule

PLAN = Path(__file__).resolve().parents[1] / "worklist-v0" / "hpacs-lite" / "viewer-features-monitors.js"
SOFT = {'magnification': 'fit', 'windowing': {'name': 'Soft tissue', 'w': 400, 'l': 40}, 'filter': 'sharpen', 'sort': 'stock', 'rotate': 0,
        'flip': 'none', 'firstImage': 'first', 'gspsAuto': False, 'overlay': 'full'}
LUNG = dict(SOFT, magnification='1:1', windowing={'name': 'Lung', 'w': 1500, 'l': -600}, filter='none', overlay='none')
BONE = dict(SOFT, windowing={'name': 'Bone', 'w': 2000, 'l': 500}, filter='none')
DEFAULT = dict(SOFT, windowing=None, filter='none')
OTHER_ID = '22222222-2222-4222-8222-222222222222'


def monitor(images, **extra):
    return dict({'images': images, 'worklist': 'none', 'thumbs': 'top', 'toolbar': 'top'}, **extra)


def split_library(monitors, display=None):
    value = library()
    value['rules'][0]['monitors'] = {'count': len(monitors), 'list': monitors}
    if display is not None:
        value['rules'][0]['display'] = display
    return value


STUB = """() => {
  window.monitorCalls = [];
  window.monitorRegions = [{ monitor: 0, left: 0, right: 1000 }, { monitor: 1, left: 1000, right: 2000 }];
  window.KinViewerMonitors = {
    prepare: async (rule, { signal } = {}) => {
      monitorCalls.push(['prepare', rule.name]);
      const split = KinViewerMonitorPlan.split(KinHangingProtocolModel, rule, monitorRegions, { left: 0, right: 2000, top: 0, bottom: 1000 }, { left: 0, top: 0, width: 2000, height: 1000 });
      return { split, moved: false, note: ' · Monitors: synthetic', undo() { monitorCalls.push(['undo', rule.name]); }, commit() { monitorCalls.push(['commit', rule.name]); } };
    },
    clear() { monitorCalls.push(['clear']); },
  };
}"""


class HangingProtocolMonitorsDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start(); cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.page.route('https://hp.test/**', lambda route: route.fulfill(body=HARNESS, content_type='text/html') if route.request.url == 'https://hp.test/' else route.abort())
        self.page.goto('https://hp.test/')
        for path in (MODEL, VIEWER, PLAN):
            self.page.add_script_tag(path=str(path))
        self.page.evaluate("window.announced=[];addEventListener('kin-hanging-protocol-applied',e=>announced.push(structuredClone(e.detail)))")
        self.page.evaluate(STUB)

    def tearDown(self):
        self.page.close()

    def seed(self, value):
        self.page.evaluate("value=>localStorage.setItem(KinHangingProtocolModel.ownerKey(owner),JSON.stringify(value))", value)
        self.page.evaluate('__mount()')

    def stored(self):
        return self.page.evaluate("JSON.parse(localStorage.getItem(KinHangingProtocolModel.ownerKey(owner)))")

    def apply(self, text='Applied'):
        self.page.locator('#kin-hp-apply').click(); expect(self.page.locator('#kin-hp-status')).to_contain_text(text)

    def screen(self):
        return self.page.evaluate("[...viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).map(v=>({x:v.x,y:v.y,width:v.width,height:v.height,sets:v.displaySetInstanceUIDs}))")

    def test_01_two_monitors_split_the_screen_and_each_shows_its_own_cells(self):
        # Rule cells: Current, Related, vacancy, Current. Monitor 1 (2 x 1) shows cells 1-2, monitor 2 (2 x 1) cells 3-4.
        self.seed(split_library([monitor('2x1', thumbs='left'), monitor('2x1', thumbs='right')], [SOFT, LUNG, None, BONE]))
        self.apply()
        call = self.page.evaluate('setCalls.at(-1)')
        self.assertEqual(4, len(call['layoutOptions']))
        self.assertGreaterEqual(call['numRows'] * call['numCols'], 4)
        screen = self.screen()
        # Top to bottom, then left to right: monitor 1 top (Current), monitor 2 top (vacancy), monitor 1 bottom (Related), monitor 2 bottom (Current).
        self.assertEqual([['ds-current'], [], ['ds-related'], ['ds-current']], [cell['sets'] for cell in screen])
        self.assertTrue(all(cell['x'] < 0.5 for cell in (screen[0], screen[2])) and all(cell['x'] >= 0.5 for cell in (screen[1], screen[3])))
        applied = self.page.evaluate('KinViewerHangingProtocol.current().applied()')
        self.assertEqual([0, 2, 1, 3], applied['ruleCells'])
        self.assertEqual([{k: c[k] for k in ('x', 'y', 'width', 'height')} for c in screen], applied['rects'])
        # Each viewport is announced with the display rule of the rule cell it shows.
        self.assertEqual([SOFT, None, LUNG, BONE], self.page.evaluate('announced.at(-1).display'))
        self.assertEqual(applied['viewportIds'], self.page.evaluate('announced.at(-1).viewportIds'))
        expect(self.page.locator('#kin-hp-status')).to_contain_text('Monitors: synthetic')
        self.assertEqual([['prepare', 'Brain CT'], ['commit', 'Brain CT']], self.page.evaluate('monitorCalls'))

    def test_02_save_with_hanging_protocol_writes_each_viewport_back_to_its_rule_cell(self):
        self.seed(split_library([monitor('2x1'), monitor('2x1')]))
        self.apply()
        result = self.page.evaluate("d=>KinViewerHangingProtocol.current().saveDisplay(d)", [SOFT, LUNG, BONE, DEFAULT])
        self.assertEqual({'ok': True, 'account': 'not-loaded'}, result)
        # Viewport 2 shows the vacancy (rule cell 3): nothing is kept there; the default is no rule.
        self.assertEqual([SOFT, BONE, None, None], self.stored()['rules'][0]['display'])

    def test_03_a_rule_cell_no_monitor_shows_keeps_its_display_rule(self):
        # One monitor of 1 x 1: only rule cell 1 is shown; cells 2 and 4 keep what they had.
        self.seed(split_library([monitor('1x1')], [SOFT, LUNG, None, BONE]))
        self.apply()
        self.assertEqual([['ds-current']], [cell['sets'] for cell in self.screen()])
        self.assertEqual([0], self.page.evaluate('KinViewerHangingProtocol.current().applied().ruleCells'))
        self.page.evaluate("d=>KinViewerHangingProtocol.current().saveDisplay(d)", [DEFAULT])
        self.assertEqual([None, LUNG, None, BONE], self.stored()['rules'][0]['display'])
        self.assertEqual(['Current', 'Related', None, 'Current'], self.stored()['rules'][0]['layout']['cells'], 'the rule keeps all its cells')

    def test_04_a_failed_apply_rolls_back_to_the_split_and_puts_the_rows_back(self):
        value = split_library([monitor('2x1'), monitor('2x1')])
        other = rule('Other CT'); other['id'] = OTHER_ID; other['monitors'] = {'count': 1, 'list': [monitor('1x2')]}
        value['rules'].append(other)
        self.seed(value)
        self.apply()
        before = self.screen()
        self.page.get_by_label('Hanging Protocol Rule').select_option(OTHER_ID)
        self.page.evaluate('failAfterMutation=true')
        self.page.locator('#kin-hp-apply').click()
        expect(self.page.locator('#kin-hp-status')).to_contain_text('synthetic native failure')
        self.assertEqual(before, self.screen(), 'the split this panel built is put back')
        self.assertEqual(['prepare', 'Other CT'], self.page.evaluate('monitorCalls.at(-2)'))
        self.assertEqual(['undo', 'Other CT'], self.page.evaluate('monitorCalls.at(-1)'))
        # The split is still one this panel can leave: the same rule applies again.
        self.page.evaluate('failAfterMutation=false')
        self.apply()
        self.assertEqual(['commit', 'Other CT'], self.page.evaluate('monitorCalls.at(-1)'))
        self.assertEqual(2, len(self.screen()))

    def test_05_a_rule_without_monitors_gives_the_rows_back_and_a_uniform_grid(self):
        value = split_library([monitor('2x1'), monitor('2x1')])
        other = rule('Other CT'); other['id'] = OTHER_ID
        value['rules'].append(other)
        self.seed(value)
        self.apply()
        self.page.get_by_label('Hanging Protocol Rule').select_option(OTHER_ID)
        self.apply()
        self.assertIsNone(self.page.evaluate("setCalls.at(-1).layoutOptions ?? null"))
        self.assertEqual(['clear'], self.page.evaluate('monitorCalls.at(-1)'))
        self.assertEqual([0, 1, 2, 3], self.page.evaluate('KinViewerHangingProtocol.current().applied().ruleCells'))
        self.assertIsNone(self.page.evaluate('KinViewerHangingProtocol.current().applied().rects'))

    def test_06_without_the_monitors_module_the_rule_layout_applies_and_says_so(self):
        self.page.evaluate('delete window.KinViewerMonitors')
        self.seed(split_library([monitor('2x1'), monitor('2x1')]))
        self.apply('모니터 배치를 불러오지 못해 적용하지 않았습니다')
        self.assertEqual(4, len(self.screen()))
        self.assertIsNone(self.page.evaluate("setCalls.at(-1).layoutOptions ?? null"))

    def test_07_no_covered_image_monitor_applies_the_rule_grid(self):
        self.page.evaluate("monitorRegions=[{monitor:0,left:0,right:2000}]")
        self.seed(split_library([monitor('none', worklist='show'), monitor('2x2')]))
        self.apply()
        self.assertIsNone(self.page.evaluate("setCalls.at(-1).layoutOptions ?? null"))
        self.assertEqual(4, len(self.screen()))

    def test_08_save_monitors_writes_one_rule_and_refuses_what_cannot_be_saved(self):
        value = library(); other = rule('Other CT'); other['id'] = OTHER_ID; value['rules'].append(other)
        self.seed(value)
        monitors = {'count': 2, 'list': [monitor('none', worklist='show', toolbar='none', thumbs='none'), monitor('2x2', thumbs='left')]}
        result = self.page.evaluate("([id,m])=>KinViewerHangingProtocol.current().saveMonitors(id,m)", [OTHER_ID, monitors])
        self.assertEqual({'ok': True, 'account': 'not-loaded'}, result)
        saved = self.stored()
        self.assertEqual(monitors, next(r for r in saved['rules'] if r['id'] == OTHER_ID)['monitors'])
        self.assertNotIn('monitors', saved['rules'][0])
        bad = copy.deepcopy(monitors); bad['list'][1]['worklist'] = 'show'
        self.assertEqual({'ok': False, 'reason': 'invalid'}, self.page.evaluate("([id,m])=>KinViewerHangingProtocol.current().saveMonitors(id,m)", [OTHER_ID, bad]))
        self.assertEqual({'ok': False, 'reason': 'missing'}, self.page.evaluate("m=>KinViewerHangingProtocol.current().saveMonitors('33333333-3333-4333-8333-333333333333',m)", monitors))
        # Removing them leaves the rule as it was before.
        self.page.evaluate("id=>KinViewerHangingProtocol.current().saveMonitors(id,null)", OTHER_ID)
        self.assertNotIn('monitors', next(r for r in self.stored()['rules'] if r['id'] == OTHER_ID))
        # The Site library is not written here.
        self.page.evaluate("KinViewerHangingProtocol.current().setScope('site')")
        self.assertEqual({'ok': False, 'reason': 'scope'}, self.page.evaluate("([id,m])=>KinViewerHangingProtocol.current().saveMonitors(id,m)", [OTHER_ID, monitors]))

    def test_10_input_or_a_new_series_while_monitors_are_prepared_stops_the_apply(self):
        self.seed(split_library([monitor('2x1'), monitor('2x1')]))
        # The module takes its time (it moves the window); the reader clicks meanwhile.
        self.page.evaluate("""() => { const prepare = KinViewerMonitors.prepare;
          KinViewerMonitors.prepare = async (rule, options) => { const answer = await prepare(rule, options);
            await new Promise(resolve => { window.synPrepared = resolve; }); return answer; }; }""")
        calls = len(self.page.evaluate('setCalls'))
        self.page.locator('#kin-hp-apply').click()
        self.page.wait_for_function("() => typeof window.synPrepared === 'function'")
        self.page.mouse.click(5, 5)
        self.page.evaluate('synPrepared()')
        expect(self.page.locator('#kin-hp-status')).to_contain_text('모니터 배치를 확인하는 사이 영상이나 조작이 바뀌어 적용하지 않았습니다')
        self.assertEqual(calls, len(self.page.evaluate('setCalls')), 'no layout was requested')
        self.assertEqual(['undo', 'Brain CT'], self.page.evaluate('monitorCalls.at(-1)'))
        # A series change while the module prepares stops it the same way.
        self.page.evaluate("delete window.synPrepared")
        self.page.locator('#kin-hp-apply').click()
        self.page.wait_for_function("() => typeof window.synPrepared === 'function'")
        self.page.evaluate("() => { const view = [...viewports.values()][0]; view.displaySetInstanceUIDs = ['ds-related']; synPrepared(); }")
        expect(self.page.locator('#kin-hp-status')).to_contain_text('모니터 배치를 확인하는 사이 영상이나 조작이 바뀌어 적용하지 않았습니다')
        self.assertEqual(calls, len(self.page.evaluate('setCalls')))

    def test_11_a_split_a_job_put_back_is_rolled_back_to_like_one_this_panel_built(self):
        # A version 16 Job restored this split on a fresh viewer (viewer-volume-job.js registers its geometry).
        rects = [{'x': 0, 'y': 0, 'width': .5, 'height': 1}, {'x': .5, 'y': 0, 'width': .5, 'height': 1}]
        self.page.evaluate("""rects => { window.kinViewerSplitRects = rects;
          return grid.setLayout({ numRows: 1, numCols: 2, layoutOptions: rects, findOrCreateViewport: i => ({ displaySetInstanceUIDs: ['ds-current'],
            viewportOptions: { viewportId: 'job-' + i, viewportType: 'stack' } }) }); }""", rects)
        # Uneven on purpose: the right cell is not a uniform grid cell any more.
        self.page.evaluate("() => { const v = viewports.get('job-1'); v.x = .6; v.width = .4; window.kinViewerSplitRects[1] = { x: .6, y: 0, width: .4, height: 1 }; }")
        before = self.screen()
        self.seed(library())
        self.page.evaluate('failAfterMutation=true')
        self.page.locator('#kin-hp-apply').click()
        expect(self.page.locator('#kin-hp-status')).to_contain_text('synthetic native failure')
        self.assertEqual(before, self.screen(), 'the restored split is put back')
        self.assertEqual({'x': .6, 'y': 0, 'width': .4, 'height': 1}, self.page.evaluate('setCalls.at(-1).layoutOptions[1]'))
        # And the rule applies over it.
        self.page.evaluate('failAfterMutation=false')
        self.apply()
        self.assertEqual(4, len(self.screen()))

    def test_09_export_and_duplicate_keep_the_monitors(self):
        monitors = [monitor('1x1'), monitor('2x2', thumbs='right')]
        self.seed(split_library(monitors))
        self.page.locator('#kin-hp-duplicate').click()
        self.page.locator('#kin-hp-save-local').click()
        rules = self.stored()['rules']
        self.assertEqual(2, len(rules))
        self.assertEqual([{'count': 2, 'list': monitors}] * 2, [r['monitors'] for r in rules])


if __name__ == '__main__':
    unittest.main()
