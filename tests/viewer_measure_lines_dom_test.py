# coding: utf-8
"""Measure menu line tools on the shipped image toolbar: CTR, Parallel Lines, Length Ratio, Centre-line Angle, Volume Measure.

The shipped viewer-features.js, viewer-ux-toolbar.js, viewer-features-measure.js (the measuring frame),
viewer-features-measure-lines.js, measure-lines-model.js and config/ohif/planar-geometry.js run in Chromium on the synthetic
services and cornerstone of viewer_measure_dom_test.py, with two more frames of the same study: syn:ct2 (CT, 1 mm pixels)
and syn:us (ultrasound, Region Calibration 0.2 mm columns and 0.3 mm rows). The History panel's save path is covered end to
end in tests/e2e/test_measure_lines.py.
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

MORE_FRAMES = """() => {
  const ct2 = { Modality: 'CT', SOPClassUID: '1.2.840.10008.5.1.4.1.1.2', Rows: 100, Columns: 100, PixelSpacing: [1, 1],
    ImagePositionPatient: [0, 0, 0], ImageOrientationPatient: [1, 0, 0, 0, 1, 0], FrameOfReferenceUID: '2.25.4' };
  const us = { Modality: 'US', SOPClassUID: '1.2.840.10008.5.1.4.1.1.6.1', Rows: 100, Columns: 100,
    SequenceOfUltrasoundRegions: [{ RegionSpatialFormat: 1, PhysicalUnitsXDirection: 3, PhysicalUnitsYDirection: 3, PhysicalDeltaX: 0.02, PhysicalDeltaY: 0.03,
      RegionLocationMinX0: 0, RegionLocationMinY0: 0, RegionLocationMaxX1: 99, RegionLocationMaxY1: 99 }] };
  const get = cornerstone.metaData.get;
  cornerstone.metaData.get = (type, id) => {
    const tags = id === 'syn:ct2' ? ct2 : id === 'syn:us' ? us : null;
    if (!tags) return get.call(cornerstone.metaData, type, id);
    if (type === 'instance') return tags;
    if (type === 'imagePlaneModule') return id === 'syn:ct2' ? { imagePositionPatient: [0, 0, 0], rowCosines: [1, 0, 0], columnCosines: [0, 1, 0],
      rowPixelSpacing: 1, columnPixelSpacing: 1, frameOfReferenceUID: '2.25.4' } : { rowPixelSpacing: null, columnPixelSpacing: null };
    if (type === 'modalityLutModule') return { rescaleSlope: 1, rescaleIntercept: 0 };
  };
  // The page point of an image pixel in a cell, for every frame (world = pixel × spacing; 1 where none is known).
  const spacing = { 'syn:ct': 0.5, 'syn:ct2': 1 };
  window.synPagePoint = (id, [col, row]) => {
    const v = synViewports.find(x => x.id === id), s = spacing[v.image] || 1, rect = v.element.getBoundingClientRect();
    const [x, y] = v.worldToCanvas([col * s, row * s, 0]); return [rect.left + x, rect.top + y];
  };
  window.synImage = (id, image) => { synViewports.find(x => x.id === id).image = image; document.dispatchEvent(new Event('CORNERSTONE_STACK_NEW_IMAGE')); };
}"""


class ViewerMeasureLinesDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def open(self, size=(1366, 900)):
        context = self.browser.new_context(viewport={'width': size[0], 'height': size[1]})
        page = context.new_page(); errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route(ORIGIN + "/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        def serve(name):
            return lambda route: route.fulfill(path=str(HPACS / name), content_type="text/javascript; charset=utf-8")
        for name in ["measure-tools-model.js", "measure-lines-model.js"]:
            page.route(ORIGIN + "/worklist/hpacs-lite/" + name, serve(name))
        page.goto(ORIGIN + "/")
        page.add_style_tag(path=str(HPACS / "viewer-ux-theme.css"))
        page.add_style_tag(content="[data-cy=viewport-pane] { width: 400px !important; height: 300px !important; }")
        page.add_script_tag(path=str(ROOT / "config" / "ohif" / "planar-geometry.js"))
        for name in ["viewer-ux-shortcuts.js", "viewer-features.js", "viewer-features-measure.js", "viewer-features-measure-lines.js", "viewer-ux-toolbar.js"]:
            page.add_script_tag(path=str(HPACS / name))
        page.evaluate(SETUP, OWNER)
        page.evaluate(CORNERSTONE)
        page.evaluate(MORE_FRAMES)
        page.evaluate("() => synMount()")
        page.wait_for_function("() => !!window.KinMeasureLinesModel && !!window.KinMeasureFrame && !!window.KinMeasureLines")
        self.addCleanup(context.close)
        self.addCleanup(lambda: self.assertEqual([], errors))
        return page

    def tool(self, page, name, title=None):
        page.get_by_role('button', name='Measure ▾').click()
        page.get_by_role('menu', name='Measure').get_by_role('menuitem', name=name, exact=True).click()
        panel = page.get_by_role('dialog', name=title or name)
        expect(panel).to_be_visible()
        return panel

    def press(self, page, cell, pixel):
        x, y = page.evaluate("([id, p]) => synPagePoint(id, p)", [cell, pixel])
        page.mouse.click(x, y)

    def drag(self, page, cell, start, end):
        x0, y0 = page.evaluate("([id, p]) => synPagePoint(id, p)", [cell, start])
        x1, y1 = page.evaluate("([id, p]) => synPagePoint(id, p)", [cell, end])
        page.mouse.move(x0, y0); page.mouse.down(); page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2); page.mouse.move(x1, y1); page.mouse.up()

    def marks(self, page, tool=None):
        return [m for m in page.evaluate("synMarks()") if tool is None or m['tool'] == tool]

    def close(self, actual, expected, places=6):
        self.assertEqual(len(actual), len(expected))
        for a, e in zip(actual, expected):
            if e is None: self.assertIsNone(a)
            else: self.assertAlmostEqual(a, e, places=places)

    def test_01_measure_menu_has_the_line_tools_in_the_menu_order(self):
        page = self.open()
        page.get_by_role('button', name='Measure ▾').click()
        expect(page.get_by_role('menu', name='Measure').get_by_role('menuitem')).to_have_text(
            ['CTR', 'Circle by Diameter', 'Spine Label', 'Parallel Lines', 'Length Ratio', 'Centre-line Angle', 'Volume Measure', 'Marking', 'Text', 'Memo'])

    def test_02_ctr_four_lines_then_two_lines_from_presses_and_the_left_tool_does_not_run(self):
        page = self.open()
        panel = self.tool(page, 'CTR')
        method = panel.get_by_label('CTR Method')
        expect(method).to_have_value('4')
        steps = panel.locator('[data-measure-steps] li')
        expect(steps).to_have_count(4)
        # 0.5 mm pixels: midline x = 50; heart borders 20 and 35 pixels from it; the lung field 80 pixels wide.
        for pixel in [(50, 10), (50, 90), (30, 50)]: self.press(page, 'left', pixel)
        expect(steps.nth(2)).to_have_attribute('aria-current', 'step')
        for pixel in [(85, 50), (10, 60), (90, 60)]: self.press(page, 'left', pixel)
        expect(panel.locator('[data-measure-result]')).to_contain_text('CTR 0.69 (68.8%)')
        expect(panel.locator('[data-measure-result]')).to_contain_text('MRD 10.0 mm · MLD 17.5 mm · ID 40.0 mm')
        [mark] = self.marks(page, 'KinCTR')
        self.assertEqual(mark['baseline']['calculator'], 'kin-ctr4-v1:pixel')
        self.close(mark['baseline']['values'], [10, 17.5, 40, 27.5 / 40])
        self.assertEqual(len(mark['points']), 6)
        self.assertEqual(0, page.evaluate("synToolPresses"))
        # 2-line: the longer line is the chest (ID) whatever the order; the 4-line mark stays.
        method.select_option('2')
        expect(steps).to_have_count(2)
        for pixel in [(10, 70), (90, 70), (30, 40), (70, 40)]: self.press(page, 'left', pixel)
        expect(panel.locator('[data-measure-result]')).to_contain_text('CTR 0.50 (50.0%)')
        marks = self.marks(page, 'KinCTR')
        self.assertEqual(2, len(marks))
        self.assertEqual(marks[1]['baseline']['calculator'], 'kin-ctr2-v1:pixel')
        self.close(marks[1]['baseline']['values'], [20, 40, 0.5])
        # The lines are drawn with their values beside them; Close keeps finished marks.
        expect(page.locator('[data-kin-measure-layer=left] g[data-kin-mark=KinCTR]')).to_have_count(2)
        panel.get_by_role('button', name='Close').click()
        self.assertEqual(2, len(self.marks(page, 'KinCTR')))

    def test_03_parallel_lines_gap_and_centre_and_editing_keeps_them_parallel(self):
        page = self.open()
        panel = self.tool(page, 'Parallel Lines')
        for pixel in [(20, 20), (60, 20), (40, 40)]: self.press(page, 'left', pixel)
        expect(panel.locator('[data-measure-result]')).to_contain_text('Gap 10.0 mm · Centre 10.0 mm')
        [mark] = self.marks(page, 'KinParallelLines')
        self.close([n for p in mark['points'] for n in p[:2]], [10, 10, 30, 10, 10, 20, 30, 20])
        uid = mark['uid']
        # Turning the first line: the second keeps its middle and length and stays parallel; the values follow.
        self.drag(page, 'left', (60, 20), (60, 30))
        check = page.evaluate("""uid => { const a = cornerstoneTools.annotation.state.getAnnotation(uid), p = a.data.handles.points.map(w => [w[0] / 0.5, w[1] / 0.5]);
          const d1 = [p[1][0] - p[0][0], p[1][1] - p[0][1]], d2 = [p[3][0] - p[2][0], p[3][1] - p[2][1]];
          return { cross: d1[0] * d2[1] - d1[1] * d2[0], mid: [(p[2][0] + p[3][0]) / 2, (p[2][1] + p[3][1]) / 2], same: KinMeasureLinesModel.same(KinMeasureLinesModel.parallel(p, [0.5, 0.5]), a.data.kinBaseline.values) }; }""", uid)
        self.assertAlmostEqual(check['cross'], 0, places=6)
        self.close(check['mid'], [40, 40])
        self.assertTrue(check['same'])
        # The second line's end slides along the line only.
        before = self.marks(page, 'KinParallelLines')[0]['points']
        self.drag(page, 'left', (round(before[3][0] / 0.5), round(before[3][1] / 0.5)), (80, 10))
        after = self.marks(page, 'KinParallelLines')[0]['points']
        self.close(after[2], before[2])
        cross = (after[1][0] - after[0][0]) * (after[3][1] - after[2][1]) - (after[1][1] - after[0][1]) * (after[3][0] - after[2][0])
        self.assertAlmostEqual(cross, 0, places=6)
        # No new mark and no press of the open panel came of the drags, and the cell's own tool did not run.
        self.assertEqual(1, len(self.marks(page, 'KinParallelLines')))
        expect(page.locator('[data-kin-pending]')).to_have_count(0)
        self.assertEqual(0, page.evaluate("synToolPresses"))
        # A locked (saved) mark has no point handles; a refused gate takes no move.
        page.evaluate("uid => { synLocked.add(uid); cornerstone.eventTarget.dispatchEvent(new Event('MODIFIED')); }", uid)
        expect(page.locator(f'[data-kin-handle="{uid}"][data-kin-point]')).to_have_count(0)
        page.evaluate("uid => { synLocked.delete(uid); window.synGate = '환자를 바꾸는 중입니다'; cornerstone.eventTarget.dispatchEvent(new Event('MODIFIED')); }", uid)
        expect(page.locator(f'[data-kin-handle="{uid}"][data-kin-point]')).to_have_count(5)
        self.drag(page, 'left', (round(after[0][0] / 0.5), round(after[0][1] / 0.5)), (5, 5))
        self.assertEqual(after, self.marks(page, 'KinParallelLines')[0]['points'])

    def test_04_length_ratio_on_an_image_without_spacing_is_pixel_based(self):
        page = self.open()
        panel = self.tool(page, 'Length Ratio')
        for pixel in [(10, 10), (40, 50), (10, 10), (10, 30)]: self.press(page, 'right', pixel)
        result = panel.locator('[data-measure-result]')
        expect(result).to_contain_text('Ratio (L1/L2) 2.50')
        expect(result).to_contain_text('Length 1 50.0 px · Length 2 20.0 px')
        expect(result).to_contain_text('픽셀 기준(간격 미확인)')
        [mark] = self.marks(page, 'KinLengthRatio')
        self.assertEqual(mark['baseline']['calculator'], 'kin-ratio-v1:px')
        self.close(mark['baseline']['values'], [50, 20, 2.5])
        # A second length of 0: no ratio ("—"), saved as null.
        # (Away from the first mark's points: a press on a point of an unlocked mark takes that point.)
        for pixel in [(60, 50), (90, 90), (70, 80), (70, 80)]: self.press(page, 'right', pixel)
        expect(result).to_contain_text('Ratio (L1/L2) —')
        self.close(self.marks(page, 'KinLengthRatio')[1]['baseline']['values'], [50, 0, None])

    def test_05_centre_line_angle_from_eight_points_in_any_order(self):
        page = self.open()
        panel = self.tool(page, 'Centre-line Angle')
        steps = panel.locator('[data-measure-steps] li')
        expect(steps).to_have_text(['Lines 1 and 2 — 선마다 두 끝점 (네 점)', 'Lines 3 and 4 — 선마다 두 끝점 (네 점)'])
        # Lines 1 and 2 horizontal (one drawn right to left); lines 3 and 4 at 45° drawn upwards.
        for pixel in [(10, 10), (50, 10), (50, 20), (10, 20)]: self.press(page, 'left', pixel)
        expect(steps.nth(0)).to_have_attribute('data-step', 'done')
        for pixel in [(50, 50), (10, 10 + 0), (60, 50), (20, 10)]: self.press(page, 'left', pixel)
        expect(panel.locator('[data-measure-result]')).to_contain_text('Angle 45.0° (315.0°)')
        [mark] = self.marks(page, 'KinCentreLineAngle')
        self.close(mark['baseline']['values'], [45, 315])
        # Two dashed centre lines are drawn.
        expect(page.locator('[data-kin-measure-layer=left] g[data-kin-mark=KinCentreLineAngle] line[stroke-dasharray]')).to_have_count(2)

    def test_06_volume_three_lengths_on_different_frames_ok_stamps_title_and_volume(self):
        page = self.open()
        panel = self.tool(page, 'Volume Measure', '2D Volume Measurement')
        expect(panel.get_by_label('Formula')).to_have_value('ellipsoid')
        expect(panel.get_by_role('button', name='Restart')).to_be_hidden()
        value = lambda part: panel.locator(f'[data-volume-value={part}]')
        # Length on the CT of 0.5 mm pixels: 40 columns = 20 mm.
        panel.get_by_role('button', name='Measure Length').click()
        self.press(page, 'left', (10, 10)); self.press(page, 'left', (50, 10))
        expect(value('Length')).to_have_text('20.0 mm')
        expect(panel.get_by_role('button', name='Measure Height')).to_have_attribute('aria-pressed', 'true')
        # Height and Width on an ultrasound frame of the same study: 50 rows × 0.3 mm, 50 columns × 0.2 mm.
        page.evaluate("synImage('right', 'syn:us')")
        self.press(page, 'right', (10, 10)); self.press(page, 'right', (10, 60))
        expect(value('Height')).to_have_text('15.0 mm')
        expect(value('Volume')).to_have_text('—')
        self.press(page, 'right', (20, 20)); self.press(page, 'right', (70, 20))
        expect(value('Width')).to_have_text('10.0 mm')
        expect(value('Volume')).to_have_text('1.57 mL')
        panel.get_by_label('Volume Title').fill('Prostate volume')
        panel.get_by_role('button', name='OK').click()
        expect(panel.locator('[data-measure-result]')).to_have_text('Stamped: Prostate volume: 1.57 mL')
        expect(value('Length')).to_have_text('—')
        [mark] = self.marks(page, 'KinVolume')
        self.assertEqual(mark['image'], 'syn:us')
        self.assertEqual(mark['text'], 'Prostate volume')
        b = mark['baseline']
        self.assertEqual(b['calculator'], 'kin-volume-v1:ellipsoid')
        self.close(b['values'], [20, 15, 10, math.pi / 6 * 20 * 15 * 10 / 1000])
        self.assertEqual([s['sopUid'] for s in b['sources']], ['syn:ct', 'syn:us', 'syn:us'])
        self.assertEqual([s['calculator'] for s in b['sources']], ['kin-length-v1:pixel', 'kin-length-v1:us', 'kin-length-v1:us'])
        # Each length is drawn on its own frame; the result's check from the originals passes; a changed value does not.
        expect(page.locator('[data-kin-measure-layer=left] [data-kin-volume-length]')).to_have_count(1)
        expect(page.locator('[data-kin-measure-layer=right] [data-kin-volume-length]')).to_have_count(2)
        self.assertEqual('', page.evaluate("uid => KinMeasureFrame.verify(cornerstoneTools.annotation.state.getAnnotation(uid))", mark['uid']))
        self.assertIn('재확인 필요', page.evaluate("""uid => { const a = cornerstoneTools.annotation.state.getAnnotation(uid);
          a.data.kinBaseline = { ...a.data.kinBaseline, values: [21, 15, 10, Math.PI / 6 * 21 * 15 * 10 / 1000] }; return KinMeasureFrame.verify(a); }""", mark['uid']))

    def test_07_volume_formula_reset_and_frames_without_spacing(self):
        page = self.open()
        panel = self.tool(page, 'Volume Measure', '2D Volume Measurement')
        value = lambda part: panel.locator(f'[data-volume-value={part}]')
        # Prolate spheroid has no Height step.
        panel.get_by_label('Formula').select_option('prolate')
        expect(panel.get_by_role('button', name='Measure Height')).to_be_disabled()
        expect(value('Height')).to_have_text('— (not used)')
        # A radiograph without spacing gives no length for a volume.
        self.press(page, 'right', (10, 10)); self.press(page, 'right', (60, 10))
        expect(panel.get_by_role('status')).to_contain_text('mm로 잴 수 없어 부피에 쓰지 않습니다')
        expect(value('Length')).to_have_text('—')
        self.press(page, 'left', (10, 10)); self.press(page, 'left', (50, 10))
        panel.get_by_role('button', name='OK').click()
        expect(panel.get_by_role('status')).to_contain_text('먼저 Width')
        self.press(page, 'left', (10, 20)); self.press(page, 'left', (30, 20))
        expect(value('Volume')).to_have_text(f"{round(math.pi / 6 * 20 * 10 * 10 / 1000, 2):.2f} mL")
        # Reset empties the lengths, the volume and the title; no mark was stamped.
        panel.get_by_label('Volume Title').fill('Nodule')
        panel.get_by_role('button', name='Reset').click()
        for part in ['Length', 'Width', 'Volume']: expect(value(part)).to_have_text('—')
        expect(panel.get_by_label('Volume Title')).to_have_value('')
        self.assertEqual([], self.marks(page, 'KinVolume'))

    def test_08_a_patient_switch_empties_a_volume_not_yet_stamped(self):
        page = self.open()
        panel = self.tool(page, 'Volume Measure', '2D Volume Measurement')
        self.press(page, 'left', (10, 10)); self.press(page, 'left', (50, 10))
        expect(panel.locator('[data-volume-value=Length]')).to_have_text('20.0 mm')
        page.evaluate("document.body.classList.add('kin-patient-switching')")
        expect(panel.locator('[data-volume-value=Length]')).to_have_text('—')
        expect(panel.get_by_role('status')).to_contain_text('환자나 검사가 바뀌어 재던 길이를 지웠습니다')
        page.evaluate("document.body.classList.remove('kin-patient-switching')")
        self.assertEqual([], self.marks(page, 'KinVolume'))

    def test_09_saved_values_are_checked_again_before_a_save_and_restart_takes_back_unsaved_marks(self):
        page = self.open()
        panel = self.tool(page, 'Length Ratio')
        for pixel in [(10, 10), (50, 10), (10, 20), (30, 20)]: self.press(page, 'left', pixel)
        [mark] = self.marks(page, 'KinLengthRatio')
        self.assertEqual('', page.evaluate("uid => KinMeasureFrame.verify(cornerstoneTools.annotation.state.getAnnotation(uid))", mark['uid']))
        self.assertIn('재확인 필요', page.evaluate("""uid => { const a = cornerstoneTools.annotation.state.getAnnotation(uid);
          a.data.kinBaseline = { ...a.data.kinBaseline, calculator: 'kin-ratio-v1:px' }; return KinMeasureFrame.verify(a); }""", mark['uid']))
        panel.get_by_role('button', name='Restart').click()
        self.assertEqual([], self.marks(page, 'KinLengthRatio'))

    def test_11_choosing_another_length_drops_a_point_of_the_one_before(self):
        page = self.open()
        panel = self.tool(page, 'Volume Measure', '2D Volume Measurement')
        self.press(page, 'left', (10, 10))
        panel.get_by_role('button', name='Measure Height').click()
        expect(page.locator('[data-kin-pending]')).to_have_count(0)
        self.press(page, 'left', (40, 20)); self.press(page, 'left', (40, 60))
        expect(panel.locator('[data-volume-value=Height]')).to_have_text('20.0 mm')
        expect(panel.locator('[data-volume-value=Length]')).to_have_text('—')

    def test_12_a_volume_is_checked_on_each_original_frame_identity_reference_and_plane(self):
        page = self.open()
        panel = self.tool(page, 'Volume Measure', '2D Volume Measurement')
        panel.get_by_label('Formula').select_option('prolate')
        self.press(page, 'left', (10, 10)); self.press(page, 'left', (50, 10))
        self.press(page, 'left', (10, 30)); self.press(page, 'left', (30, 30))
        panel.get_by_role('button', name='OK').click()
        [mark] = self.marks(page, 'KinVolume')
        verify = """([uid, change]) => { const a = cornerstoneTools.annotation.state.getAnnotation(uid), keep = structuredClone(a.data.kinBaseline);
          const s = a.data.kinBaseline.sources[0];
          if (change === 'reference') s.frameOfReferenceUid = '2.25.99';
          if (change === 'plane') s.points = s.points.map(p => [p[0], p[1], 5]);
          if (change === 'frame') s.sopUid = 'syn:ct2';
          const reason = KinMeasureFrame.verify(a); a.data.kinBaseline = keep; return reason; }"""
        self.assertEqual('', page.evaluate(verify, [mark['uid'], None]))
        for change, words in [('reference', '좌표 기준'), ('plane', '평면 밖'), ('frame', '')]:
            self.assertIn('재확인 필요', page.evaluate(verify, [mark['uid'], change]), change)
            self.assertIn(words, page.evaluate(verify, [mark['uid'], change]), change)
        # A line mark whose points are off its frame's plane asks for a recheck instead of showing its values.
        panel = self.tool(page, 'Length Ratio')
        for pixel in [(60, 60), (90, 60), (60, 80), (70, 80)]: self.press(page, 'left', pixel)
        [ratio] = self.marks(page, 'KinLengthRatio')
        self.assertIn('평면 밖', page.evaluate("""uid => { const a = cornerstoneTools.annotation.state.getAnnotation(uid);
          a.data.handles.points = a.data.handles.points.map(p => [p[0], p[1], 2]); return KinMeasureFrame.verify(a); }""", ratio['uid']))

    def test_13_a_saved_volume_not_yet_drawn_shows_its_lengths_on_their_frames_locked(self):
        page = self.open()
        # The History panel's saved head of a Volume whose result is on a frame not shown: its Length is on syn:ct.
        page.evaluate("""() => { const source = (sopUid, points) => ({ seriesUid: '2.25.2', sopUid, frame: 1, frameOfReferenceUid: '2.25.4', points, calculator: 'kin-length-v1:pixel' });
          const head = length => ({ kind: 'volume', hidden: false, annotation: null, item: { label: 'Cyst', baseline: { calculator: 'kin-volume-v1:prolate',
            values: [length, 10, Math.PI / 6 * length * 100 / 1000], sources: [source('syn:ct', [[5, 5, 0], [25, 5, 0]]), source('syn:ct2', [[5, 5, 0], [15, 5, 0]])] } } });
          window.synHeads = [head(20)]; window.kinViewerHistoryState = () => ({ scope: '2.25.1', heads: synHeads });
          cornerstone.eventTarget.dispatchEvent(new Event('MODIFIED')); }""")
        line = page.locator('[data-kin-measure-layer=left] [data-kin-volume-length]')
        expect(line).to_have_count(1)
        expect(line).to_have_text('L')
        expect(line.locator('[data-kin-point]')).to_have_count(0)
        # A stored length that is not the one its points make now is marked.
        page.evaluate("() => { synHeads[0] = { ...synHeads[0], item: { ...synHeads[0].item, baseline: { ...synHeads[0].item.baseline, values: [21, 10, Math.PI / 6 * 21 * 100 / 1000] } } }; cornerstone.eventTarget.dispatchEvent(new Event('MODIFIED')); }")
        expect(line).to_contain_text('재확인 필요')

    def test_14_the_print_draws_the_construction_lines(self):
        page = self.open()
        guides = page.evaluate("""() => ({
          parallel: KinMeasureLines.guides({ kind: 'parallel', points: [[0, 0, 0], [20, 0, 0], [5, 10, 0], [25, 10, 0]], baseline: { calculator: 'kin-parallel-v1:pixel' } }, 'syn:ct'),
          ctr: KinMeasureLines.guides({ kind: 'ctr', points: [[25, 5, 0], [25, 45, 0], [15, 20, 0], [40, 25, 0], [5, 30, 0], [45, 30, 0]], baseline: { calculator: 'kin-ctr4-v1:pixel' } }, 'syn:ct'),
          angle: KinMeasureLines.guides({ kind: 'centreAngle', points: [[0, 0, 0], [20, 0, 0], [0, 4, 0], [20, 4, 0], [0, 10, 0], [20, 30, 0], [4, 10, 0], [24, 30, 0]], baseline: { calculator: 'kin-centreangle-v1:pixel' } }, 'syn:ct'),
          ratio: KinMeasureLines.guides({ kind: 'ratio', points: [[0, 0, 0], [20, 0, 0], [0, 4, 0], [20, 4, 0]], baseline: { calculator: 'kin-ratio-v1:pixel' } }, 'syn:ct') })""")
        self.close([n for seg in guides['parallel'] for p in seg for n in p[:2]], [10, 0, 15, 10])
        self.close([n for seg in guides['ctr'] for p in seg for n in p[:2]], [15, 20, 25, 20, 40, 25, 25, 25])
        self.close([n for seg in guides['angle'] for p in seg for n in p[:2]], [0, 2, 20, 2, 2, 10, 22, 30])
        self.assertEqual([], guides['ratio'])

    def test_10_narrow_windows_keep_the_panel_fields_reachable(self):
        for size in [(768, 1024), (1024, 768)]:
            page = self.open(size)
            panel = self.tool(page, 'Volume Measure', '2D Volume Measurement')
            for name in ['Measure Length', 'Measure Height', 'Measure Width', 'OK', 'Reset']:
                button = panel.get_by_role('button', name=name)
                button.scroll_into_view_if_needed()
                expect(button).to_be_visible()


if __name__ == "__main__":
    unittest.main()
