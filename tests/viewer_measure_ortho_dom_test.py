# coding: utf-8
"""Measure menu orthopaedic and spine tools on the shipped image toolbar: the step panels and the marks they make.

The shipped viewer-features.js, viewer-ux-toolbar.js, viewer-features-measure.js (the frame), viewer-features-measure-ortho.js,
measure-ortho-model.js and config/ohif/planar-geometry.js run in Chromium on the synthetic cornerstone of
viewer_measure_dom_test.py (a CT frame with 0.5 mm pixels, rows towards the patient's left, and a radiograph without spacing).
The History panel's save path is covered end to end in tests/e2e/test_measure_ortho.py.
"""
from pathlib import Path
import math
import sys
import unittest

from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, str(Path(__file__).resolve().parent))
from viewer_features_dom_test import HARNESS, SETUP, ORIGIN, OWNER  # noqa: E402
from viewer_measure_dom_test import CORNERSTONE  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
DEG = 180 / math.pi


class ViewerMeasureOrthoDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self):
        context = self.browser.new_context(viewport={'width': 1366, 'height': 900})
        page = context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(ORIGIN + "/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        def serve(name):
            return lambda route: route.fulfill(path=str(HPACS / name), content_type="text/javascript; charset=utf-8")
        for name in ["measure-tools-model.js", "measure-ortho-model.js"]:
            page.route(ORIGIN + "/worklist/hpacs-lite/" + name, serve(name))
        page.goto(ORIGIN + "/")
        page.add_style_tag(path=str(HPACS / "viewer-ux-theme.css"))
        page.add_style_tag(content="[data-cy=viewport-pane] { width: 400px !important; height: 300px !important; }")
        page.add_script_tag(path=str(ROOT / "config" / "ohif" / "planar-geometry.js"))
        for name in ["viewer-ux-shortcuts.js", "viewer-features.js", "viewer-features-measure.js", "viewer-features-measure-ortho.js", "viewer-ux-toolbar.js"]:
            page.add_script_tag(path=str(HPACS / name))
        page.evaluate(SETUP, OWNER)
        page.evaluate(CORNERSTONE)
        page.evaluate("() => synMount()")
        expect(page.locator('.kin-ux-toolbar-settings [role=status]')).to_have_text('계정 설정 · 다른 PC에서도 적용됩니다.')
        page.wait_for_function("() => !!window.KinMeasureOrthoModel && !!window.KinMeasureFrame && !!window.KinMeasureOrtho")
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    def tool(self, page, name):
        page.get_by_role('button', name='Measure ▾').click()
        page.get_by_role('menu', name='Measure').get_by_role('menuitem', name=name).click()
        panel = page.get_by_role('dialog', name=name)
        expect(panel).to_be_visible()
        return panel

    def press(self, page, cell, pixel):
        x, y = page.evaluate("([id, p]) => synPagePoint(id, p)", [cell, pixel])
        page.mouse.click(x, y)

    def presses(self, page, cell, pixels):
        for pixel in pixels:
            self.press(page, cell, pixel)

    def marks(self, page):
        return page.evaluate("synMarks()")

    def test_01_the_measure_menu_has_the_five_tools_between_the_base_tools(self):
        page = self.open()
        page.get_by_role('button', name='Measure ▾').click()
        expect(page.get_by_role('menu', name='Measure').get_by_role('menuitem')).to_have_text(
            ['Circle by Diameter', 'Spine Label', 'Limb Length Discrepancy', 'Acetabular Angle', 'Spine Balance',
             'Cobb Angle (Lordosis / Kyphosis)', 'Pelvic Incidence', 'Marking', 'Text', 'Memo'])

    def test_02_pelvic_incidence_steps_in_order_and_three_separate_values(self):
        page = self.open()
        panel = self.tool(page, 'Pelvic Incidence')
        expect(panel.locator('[data-measure-steps] li')).to_have_text(['①② 좌우 대퇴골두의 중심', '③ S1 위 종판의 앞 끝', '④ S1 위 종판의 뒤 끝'])
        expect(panel.locator('[data-step=now]')).to_have_text('①② 좌우 대퇴골두의 중심')
        self.presses(page, 'left', [[26, 60], [30, 60]])
        expect(panel.locator('[data-step=done]')).to_have_text(['①② 좌우 대퇴골두의 중심'])
        expect(panel.locator('[data-step=now]')).to_have_text('③ S1 위 종판의 앞 끝')
        self.presses(page, 'left', [[20, 40], [40, 30]])
        # CT, 0.5 mm: SS = atan(5 / 10), PT = atan(1 / 12.5) (the hip axis 1 mm in front of the endplate's middle), PI = PT + SS.
        ss, pt = math.atan2(5, 10) * DEG, math.atan2(1, 12.5) * DEG
        expect(panel.locator('[data-measure-result]')).to_have_text('Result: PI %.1f° · PT %.1f° · SS %.1f° · PixelSpacing' % (pt + ss, pt, ss))
        [mark] = self.marks(page)
        self.assertEqual('KinPelvicIncidence', mark['tool'])
        self.assertEqual('kin-pelvicincidence-v1:pixel', mark['baseline']['calculator'])
        for value, expected in zip(mark['baseline']['values'], [pt + ss, pt, ss]):
            self.assertAlmostEqual(expected, value, places=9)
        self.assertEqual(0, page.evaluate('synToolPresses'))
        expect(page.locator('[data-kin-mark=KinPelvicIncidence] text').first).to_be_visible()
        expect(page.locator('[data-kin-mark=KinPelvicIncidence]')).to_contain_text('PI %.1f° · PT %.1f° · SS %.1f°' % (pt + ss, pt, ss))

    def test_03_pelvic_incidence_points_out_of_order_make_no_mark(self):
        page = self.open()
        panel = self.tool(page, 'Pelvic Incidence')
        # The endplate first, then the femoral heads.
        self.presses(page, 'left', [[20, 40], [40, 30], [26, 60], [30, 60]])
        expect(panel.get_by_role('status')).to_contain_text('점 순서·원본 영상 방향을 확인하세요')
        self.assertEqual([], self.marks(page))
        # The endplate's ends the other way round.
        self.presses(page, 'left', [[26, 60], [30, 60], [40, 30], [20, 40]])
        expect(panel.get_by_role('status')).to_contain_text('③ S1 종판의 앞 끝, ④ 뒤 끝')
        self.assertEqual([], self.marks(page))

    def test_04_limb_length_right_left_and_difference_are_separate_values_with_units(self):
        page = self.open()
        panel = self.tool(page, 'Limb Length Discrepancy')
        expect(panel.locator('[data-measure-steps] li')).to_have_text(
            ['①② 기준선의 두 끝', '③④ 좌우의 같은 골반 표지(예: 좌골결절)', '⑤⑥ 좌우의 같은 대퇴 표지(예: 소전자 중점)'])
        self.presses(page, 'left', [[10, 20], [90, 20], [25, 24], [75, 22], [26, 40], [74, 40]])
        # 0.5 mm pixels; the CT's rows run towards the patient's left, so the image's left is the patient's right (Rt).
        expect(panel.locator('[data-measure-result]')).to_have_text('Result: Lt 9.0 mm · Rt 8.0 mm · Difference 1.0 mm (Lt longer) · PixelSpacing')
        [mark] = self.marks(page)
        self.assertEqual(('KinLimbLength', 'kin-limblength-v1:pixel'), (mark['tool'], mark['baseline']['calculator']))
        for value, expected in zip(mark['baseline']['values'], [8, 9, 1]):
            self.assertAlmostEqual(expected, value, places=9)

    def test_05_acetabular_angle_both_ends_of_line_a(self):
        page = self.open()
        panel = self.tool(page, 'Acetabular Angle')
        expect(panel.locator('[data-measure-steps] li')).to_have_text(['①② 기준선 A의 두 끝(좌우)', '③④ 한쪽 비구의 선', '⑤⑥ 다른 쪽 비구의 선'])
        self.presses(page, 'left', [[20, 50], [80, 50], [10, 40], [20, 50], [80, 50], [90, 45]])
        right = math.atan(0.5) * DEG
        expect(panel.locator('[data-measure-result]')).to_have_text(
            'Result: Lt @%.1f°(%.1f°) · @%.1f°(%.1f°) · Rt @45.0°(315.0°) · @135.0°(225.0°) · PixelSpacing' % (right, 360 - right, 180 - right, 180 + right))

    def test_06_spine_balance_on_a_radiograph_without_spacing_is_in_pixels(self):
        page = self.open()
        panel = self.tool(page, 'Spine Balance')
        expect(panel.locator('[data-measure-steps] li')).to_have_text(['①②③④ 위쪽 척추체의 네 모서리', '⑤⑥ 골반 높이의 좌우 두 점'])
        self.presses(page, 'right', [[40, 10], [50, 10], [50, 18], [40, 18], [20, 80], [80, 80]])
        expect(panel.locator('[data-measure-result]')).to_have_text(
            'Result: Balance 5.0 px (upper vertebral centre to the Image left) · 픽셀 기준(간격 미확인)')
        [mark] = self.marks(page)
        self.assertEqual(('KinSpineBalance', 'kin-spinebalance-v1:px', [-5]), (mark['tool'], mark['baseline']['calculator'], mark['baseline']['values']))

    def test_07_cobb_back_side_decides_lordosis_or_kyphosis_and_follows_the_view(self):
        page = self.open()
        panel = self.tool(page, 'Cobb Angle (Lordosis / Kyphosis)')
        select = panel.get_by_label('Back side')
        expect(select.locator('option')).to_have_text(['Right', 'Left'])
        expect(select).to_have_value('Right')
        lines = [[20, 20], [60, 28], [20, 70], [60, 62]]
        cobb = 2 * math.atan(0.2) * DEG
        self.presses(page, 'left', lines)
        expect(panel.locator('[data-measure-result]')).to_have_text('Result: Lordosis @−%.1f°(%.1f°) · Back: image right · PixelSpacing' % (cobb, 360 - cobb))
        # As the original: the back's side given after the four points applies to the mark just made.
        select.select_option('Left')
        expect(panel.locator('[data-measure-result]')).to_have_text('Result: Kyphosis @+%.1f°(%.1f°) · Back: image left · PixelSpacing' % (cobb, 360 - cobb))
        [mark] = self.marks(page)
        self.assertEqual('kin-spinecobb-v1:left:pixel', mark['baseline']['calculator'])
        self.assertAlmostEqual(cobb, mark['baseline']['values'][0], places=9)
        expect(page.locator('[data-kin-mark=KinSpineCobb]')).to_contain_text('Kyphosis @+%.1f°' % cobb)
        # The next mark takes the side chosen.
        self.presses(page, 'left', lines)
        self.assertEqual(['kin-spinecobb-v1:left:pixel', 'kin-spinecobb-v1:left:pixel'], [m['baseline']['calculator'] for m in self.marks(page)])
        # Through the edit gate: a refused change leaves the mark and the choice as they were.
        page.evaluate("() => { synGate = '계정이 확인되기 전에는 측정·표식을 편집하지 않습니다.'; }")
        select.select_option('Right')
        expect(panel.get_by_role('status')).to_have_text('계정이 확인되기 전에는 측정·표식을 편집하지 않습니다.')
        expect(select).to_have_value('Left')
        self.assertEqual('kin-spinecobb-v1:left:pixel', self.marks(page)[1]['baseline']['calculator'])
        page.evaluate("() => { synGate = ''; }")
        # A mirrored view: the screen's right is the image's left, so "Right" stores the image's left.
        panel.get_by_role('button', name='Restart').click()
        self.assertEqual([], self.marks(page))
        page.evaluate("() => synView('left', { flip: true })")
        select.select_option('Right')
        self.presses(page, 'left', lines)
        self.assertEqual('kin-spinecobb-v1:left:pixel', self.marks(page)[0]['baseline']['calculator'])
        # A view turned by 90°: the back is up or down on the screen.
        page.evaluate("() => synView('left', { flip: false, rotation: 90 })")
        select.focus()
        expect(select.locator('option')).to_have_text(['Top', 'Bottom'])

    def test_08_a_point_of_a_finished_mark_drags_alone_and_the_values_follow(self):
        page = self.open()
        panel = self.tool(page, 'Limb Length Discrepancy')
        self.presses(page, 'left', [[10, 20], [90, 20], [25, 24], [75, 22], [26, 40], [74, 40]])
        panel.get_by_role('button', name='Close').click()
        [before] = self.marks(page)
        handles = page.locator('[data-kin-measure-layer=left] [data-kin-mark=KinLimbLength] [data-kin-point]')
        expect(handles).to_have_count(6)
        # The image-right femoral landmark 4 px lower: that side is 2 mm longer.
        start = page.evaluate("() => synPagePoint('left', [74, 40])"); end = page.evaluate("() => synPagePoint('left', [74, 44])")
        page.mouse.move(*start); page.mouse.down(); page.mouse.move(*end, steps=4); page.mouse.up()
        [after] = self.marks(page)
        self.assertEqual(before['points'][:5], after['points'][:5])
        self.assertAlmostEqual(22, after['points'][5][1], places=6)
        for value, expected in zip(after['baseline']['values'], [8, 11, 3]):
            self.assertAlmostEqual(expected, value, places=9)
        self.assertEqual(0, page.evaluate('synToolPresses'))
        expect(page.locator('[data-kin-mark=KinLimbLength]')).to_contain_text('Difference 3.0 mm (Lt longer)')
        # Locked (saved): no handles; the gate refuses a drag.
        page.evaluate("() => { synLocked.add(synMarks()[0].uid); }")
        expect(handles).to_have_count(0)

    def test_09_the_save_check_and_a_mark_whose_values_are_not_those_of_its_points(self):
        page = self.open()
        self.tool(page, 'Pelvic Incidence')
        self.presses(page, 'left', [[26, 60], [30, 60], [20, 40], [40, 30]])
        verify = "() => KinMeasureFrame.verify(cornerstoneTools.annotation.state.getAllAnnotations()[0], true)"
        self.assertEqual('', page.evaluate(verify))
        page.evaluate("() => { cornerstoneTools.annotation.state.getAllAnnotations()[0].data.kinBaseline.values[0] += 1; }")
        self.assertIn('저장 당시 값과 다릅니다', page.evaluate(verify))
        expect(page.locator('[data-kin-mark=KinPelvicIncidence]')).to_contain_text('재확인 필요')
        # The Job print's recheck reads the saved item the same way.
        mark = self.marks(page)[0]
        now = page.evaluate("(m) => KinMeasureOrtho.values('syn:ct', { kind: 'pelvicIncidence', points: m.points, baseline: m.baseline })", mark)
        self.assertEqual('kin-pelvicincidence-v1:pixel', now['calculator'])
        # A value mark with no registered check is not passed.
        self.assertNotEqual('', page.evaluate("() => KinMeasureFrame.verify({ metadata: { toolName: 'KinUnknown' } }, true)"))

    def test_10_the_edit_gate_refuses_points_and_close_keeps_a_finished_mark(self):
        page = self.open()
        panel = self.tool(page, 'Acetabular Angle')
        page.evaluate("() => { synGate = '계정이 확인되기 전에는 측정·표식을 편집하지 않습니다.'; }")
        self.press(page, 'left', [20, 50])
        expect(panel.get_by_role('status')).to_have_text('계정이 확인되기 전에는 측정·표식을 편집하지 않습니다.')
        expect(panel.locator('[data-step=now]')).to_have_text('①② 기준선 A의 두 끝(좌우)')
        page.evaluate("() => { synGate = ''; }")
        self.presses(page, 'left', [[20, 50], [80, 50], [10, 40], [20, 50], [80, 50]])
        # Five of six points: Close drops them; the finished mark of a second run stays.
        panel.get_by_role('button', name='Close').click()
        self.assertEqual([], self.marks(page))
        panel = self.tool(page, 'Acetabular Angle')
        self.presses(page, 'left', [[20, 50], [80, 50], [10, 40], [20, 50], [80, 50], [90, 45]])
        panel.get_by_role('button', name='Close').click()
        self.assertEqual(['KinAcetabular'], [m['tool'] for m in self.marks(page)])
        expect(page.locator('[data-kin-mark=KinAcetabular]')).to_be_attached()

    def test_11_spacing_tags_that_cannot_be_used_are_refused_not_turned_into_pixels(self):
        page = self.open()
        # The CT keeps its PixelSpacing, but its orientation no longer holds: no mm, and no pixels either.
        page.evaluate("() => { cornerstone.metaData.get('instance', 'syn:ct').ImageOrientationPatient = [1, 0, 0]; }")
        panel = self.tool(page, 'Spine Balance')
        self.presses(page, 'left', [[40, 10], [50, 10], [50, 18], [40, 18], [20, 80], [80, 80]])
        expect(panel.get_by_role('status')).to_have_text('간격 태그를 쓸 수 없어 재지 않습니다(영상 방향·간격 확인 불가)')
        self.assertEqual([], self.marks(page))
        # The radiograph without any spacing tag is measured in pixels.
        self.presses(page, 'right', [[40, 10], [50, 10], [50, 18], [40, 18], [20, 80], [80, 80]])
        self.assertEqual(['kin-spinebalance-v1:px'], [m['baseline']['calculator'] for m in self.marks(page)])


if __name__ == "__main__":
    unittest.main()
