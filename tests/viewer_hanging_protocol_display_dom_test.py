# coding: utf-8
"""Display set presets in the shipped Hanging Protocols panel (hanging-protocol-model.js, viewer-hanging-protocol.js):
an applied rule announces its cells and their display rules; Save with Hanging Protocol writes the cell rules into the
rule that is applied (not the one selected in the editor) beside its layout, keeping string, empty and plane cells, in
the browser draft and, when the account was loaded, in the account; the draft reopens with them. Runs on the same
synthetic services as tests/viewer_hanging_protocol_dom_test.py."""
import copy
import unittest

from playwright.sync_api import sync_playwright, expect

from viewer_hanging_protocol_dom_test import HARNESS, MODEL, VIEWER, library, rule

LUNG = {'magnification': '1:1', 'windowing': {'name': 'Lung', 'w': 1500, 'l': -600}, 'filter': 'none', 'sort': 'stock', 'rotate': 0,
        'flip': 'none', 'firstImage': 'middle', 'gspsAuto': False, 'overlay': 'none'}
SOFT = dict(LUNG, magnification='fit', windowing={'name': 'Soft tissue', 'w': 400, 'l': 40}, filter='sharpen', overlay='full', firstImage='first')
DEFAULT = {'magnification': 'fit', 'windowing': None, 'filter': 'none', 'sort': 'stock', 'rotate': 0, 'flip': 'none', 'firstImage': 'first',
           'gspsAuto': False, 'overlay': 'full'}
OTHER_ID = '22222222-2222-4222-8222-222222222222'


def two_rules():
    value = library()
    other = rule('Other CT'); other['id'] = OTHER_ID
    value['rules'].append(other)
    return value


class HangingProtocolDisplayDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start(); cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.page.route('https://hp.test/**', lambda route: route.fulfill(body=HARNESS, content_type='text/html') if route.request.url == 'https://hp.test/' else route.abort())
        self.page.goto('https://hp.test/'); self.page.add_script_tag(path=str(MODEL)); self.page.add_script_tag(path=str(VIEWER))
        self.page.evaluate("window.announced=[];addEventListener('kin-hanging-protocol-applied',e=>announced.push(structuredClone(e.detail)))")

    def tearDown(self):
        self.page.close()

    def seed(self, value):
        self.page.evaluate("value=>localStorage.setItem(KinHangingProtocolModel.ownerKey(owner),JSON.stringify(value))", value)
        self.page.evaluate('__mount()')

    def stored(self):
        return self.page.evaluate("JSON.parse(localStorage.getItem(KinHangingProtocolModel.ownerKey(owner)))")

    def apply(self):
        self.page.locator('#kin-hp-apply').click(); expect(self.page.locator('#kin-hp-status')).to_contain_text('Applied')

    def test_01_apply_announces_cells_and_their_display_rules(self):
        value = library(); value['rules'][0]['display'] = [SOFT, LUNG, None, None]
        self.seed(value)
        self.assertIsNone(self.page.evaluate('KinViewerHangingProtocol.current().applied()'))
        self.apply()
        announced = self.page.evaluate('announced')
        self.assertEqual(1, len(announced))
        ids = self.page.evaluate("[...viewports.keys()]")
        self.assertEqual(ids, announced[0]['viewportIds'])
        self.assertEqual([SOFT, LUNG, None, None], announced[0]['display'])
        self.assertEqual({'scope': 'personal', 'ruleId': library()['activeRuleId'], 'name': 'Brain CT', 'viewportIds': ids},
                         self.page.evaluate('KinViewerHangingProtocol.current().applied()'))
        # A rule without display rules announces nulls, one per cell.
        self.seed(library()); self.apply()
        self.assertEqual([None, None, None, None], self.page.evaluate('announced.at(-1).display'))

    def test_02_save_writes_the_applied_rule_not_the_selected_one_and_keeps_its_cells(self):
        self.seed(two_rules()); self.apply()
        # The editor now shows the other rule; Save still goes to the applied one.
        self.page.get_by_label('Hanging Protocol Rule').select_option(OTHER_ID)
        result = self.page.evaluate("d=>KinViewerHangingProtocol.current().saveDisplay(d)", [SOFT, LUNG, LUNG, DEFAULT])
        self.assertEqual({'ok': True, 'account': 'not-loaded'}, result)
        saved = self.stored()
        applied = next(r for r in saved['rules'] if r['id'] == library()['activeRuleId'])
        other = next(r for r in saved['rules'] if r['id'] == OTHER_ID)
        # The empty cell keeps null whatever was sent; a row left at the defaults is null.
        self.assertEqual([SOFT, LUNG, None, None], applied['display'])
        self.assertEqual(['Current', 'Related', None, 'Current'], applied['layout']['cells'])
        self.assertNotIn('display', other)
        expect(self.page.locator('#kin-hp-status')).to_contain_text('칸별 표시 규칙')
        # Still applied: Save does not change the screen or forget what is applied.
        self.assertIsNotNone(self.page.evaluate('KinViewerHangingProtocol.current().applied()'))
        # Reopened: the draft has them, and applying announces them.
        self.page.evaluate('hp.end();document.querySelector("#host").textContent="";__mount()')
        self.page.get_by_label('Hanging Protocol Rule').select_option(library()['activeRuleId'])
        self.apply()
        self.assertEqual([SOFT, LUNG, None, None], self.page.evaluate('announced.at(-1).display'))

    def test_03_save_reaches_the_account_when_it_was_loaded(self):
        self.page.evaluate('(value)=>responses.push(response({owner,revision:3,value}))', library())
        self.page.evaluate('__mount()')
        self.page.locator('#kin-hp-load-account').click(); expect(self.page.locator('#kin-hp-status')).to_contain_text('Apply')
        self.apply()
        stored = copy.deepcopy(library()); stored['rules'][0]['display'] = [SOFT, None, None, LUNG]
        self.page.evaluate('(value)=>responses.push(response({owner,revision:4,value}))', stored)
        result = self.page.evaluate("d=>KinViewerHangingProtocol.current().saveDisplay(d)", [SOFT, None, None, LUNG])
        self.assertEqual({'ok': True, 'account': 'saved'}, result)
        put = self.page.evaluate("requests.filter(r=>r.url==='/api/hanging-protocols'&&r.method==='PUT').at(-1).body")
        self.assertEqual(3, put['revision'])
        self.assertEqual([SOFT, None, None, LUNG], put['value']['rules'][0]['display'])
        # The account refuses (another window saved first): the draft is kept, the account result says so.
        self.page.evaluate("responses.push(response({message:'conflict'},409))")
        result = self.page.evaluate("d=>KinViewerHangingProtocol.current().saveDisplay(d)", [LUNG, None, None, None])
        self.assertEqual({'ok': True, 'account': 'failed'}, result)
        self.assertEqual([LUNG, None, None, None], self.stored()['rules'][0]['display'])

    def test_04_plane_cells_keep_null_and_their_objects(self):
        value = library(); cells = [{'alias': 'Current', 'view': 'mpr', 'orientation': 'axial'}, 'Current', None, 'Current']
        value['rules'][0]['selectors'] = [value['rules'][0]['selectors'][0]]; value['rules'][0]['layout'] = {'rows': 2, 'cols': 2, 'cells': cells}
        self.seed(value); self.page.evaluate('sets[0].images=ctSlices(4);useNativeViewportTypes()'); self.apply()
        result = self.page.evaluate("d=>KinViewerHangingProtocol.current().saveDisplay(d)", [LUNG, SOFT, LUNG, None])
        self.assertTrue(result['ok'], result)
        saved = self.stored()['rules'][0]
        self.assertEqual(cells, saved['layout']['cells'])
        self.assertEqual([None, SOFT, None, None], saved['display'])

    def test_05_save_is_refused_when_nothing_is_applied_or_the_rule_moved_on(self):
        self.seed(two_rules())
        self.assertEqual({'ok': False, 'reason': 'none'}, self.page.evaluate("d=>KinViewerHangingProtocol.current().saveDisplay(d)", [SOFT, None, None, None]))
        self.apply()
        # The editor changed the applied rule's cells after it was applied.
        self.page.get_by_label('Cell 2').select_option('Current')
        self.assertIsNone(self.page.evaluate('KinViewerHangingProtocol.current().applied()'), 'an edit forgets what was applied')
        self.assertEqual({'ok': False, 'reason': 'none'}, self.page.evaluate("d=>KinViewerHangingProtocol.current().saveDisplay(d)", [SOFT, None, None, None]))
        self.page.get_by_label('Cell 2').select_option('Related')
        self.apply()
        # The screen changed (another series dropped in a cell): not the applied layout any more.
        self.page.evaluate("()=>{const v=[...viewports.values()][1];v.displaySetInstanceUIDs=['ds-current'];emitHP();}")
        self.assertEqual({'ok': False, 'reason': 'none'}, self.page.evaluate("d=>KinViewerHangingProtocol.current().saveDisplay(d)", [SOFT, None, None, None]))
        self.assertNotIn('display', self.stored()['rules'][0])
        # A site rule is applied: refused.
        self.page.evaluate('hp.end();document.querySelector("#host").textContent="";localStorage.clear()')
        self.page.evaluate("value=>localStorage.setItem(KinHangingProtocolModel.siteKey({institution:owner.institution}),JSON.stringify(value))", library())
        self.page.evaluate('__mount()')
        self.page.locator('#kin-hp-apply-first').click(); expect(self.page.locator('#kin-hp-status')).to_contain_text('Applied')
        self.assertEqual('site', self.page.evaluate('KinViewerHangingProtocol.current().applied().scope'))
        self.assertEqual({'ok': False, 'reason': 'site'}, self.page.evaluate("d=>KinViewerHangingProtocol.current().saveDisplay(d)", [SOFT, None, None, None]))

    def test_06_the_editor_keeps_display_rules_in_step_with_its_layout(self):
        value = library(); value['rules'][0]['display'] = [SOFT, LUNG, None, LUNG]
        self.seed(value)
        # 2 × 2 → 1 × 2: the list follows the cells; then the second cell becomes empty.
        self.page.get_by_label('Grid').select_option('1x2')
        self.page.locator('#kin-hp-save-local').click()
        self.assertEqual([SOFT, LUNG], self.stored()['rules'][0]['display'])
        self.page.get_by_label('Cell 2').select_option('')
        self.page.locator('#kin-hp-save-local').click()
        self.assertEqual([SOFT, None], self.stored()['rules'][0]['display'])
        self.page.get_by_label('Cell 1').select_option('')
        self.page.get_by_label('Cell 2').select_option('Current')
        self.page.locator('#kin-hp-save-local').click()
        self.assertNotIn('display', self.stored()['rules'][0], 'a list with no rule left is dropped')
        # The panel's end forgets the mounted handle.
        self.page.evaluate('hp.end()')
        self.assertIsNone(self.page.evaluate('KinViewerHangingProtocol.current()'))


if __name__ == '__main__':
    unittest.main()
