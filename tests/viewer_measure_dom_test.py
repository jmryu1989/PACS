# coding: utf-8
"""Measure menu base tools on the shipped image toolbar: the step panel and the marks it makes.

The shipped viewer-features.js, viewer-ux-toolbar.js, viewer-features-measure.js, measure-tools-model.js and
config/ohif/planar-geometry.js run in Chromium beside the synthetic services and account endpoint of
viewer_features_dom_test.py, a synthetic cornerstone (annotation state, locking, metadata, a 100 × 100 CT frame with
0.5 mm pixels and a radiograph without spacing) and a cell whose view can be zoomed, rotated and flipped. The History
panel's edit gate is a synthetic answer; its save path is covered end to end in tests/e2e/test_measure_base.py.
"""
from pathlib import Path
import sys
import unittest

from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, str(Path(__file__).resolve().parent))
from viewer_features_dom_test import HARNESS, SETUP, ORIGIN, OWNER  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"

# A synthetic cornerstone. Image syn:ct is CT 100 × 100, 0.5 mm pixels, stored value x + 10·y with intercept −1024;
# syn:cr is a radiograph with neither spacing nor frame of reference. The left cell's view maps world (mm) to canvas
# through zoom, rotation and flip (whole canvas pixels at whole image pixels, as a mouse press gives); synView(...) changes it.
CORNERSTONE = """() => {
  window.synGate = ''; window.synToolPresses = 0; window.synLocked = new Set();
  const annotations = new Map(), events = new EventTarget();
  const ct = { Modality: 'CT', SOPClassUID: '1.2.840.10008.5.1.4.1.1.2', Rows: 100, Columns: 100, PixelSpacing: [0.5, 0.5],
    ImagePositionPatient: [0, 0, 0], ImageOrientationPatient: [1, 0, 0, 0, 1, 0], FrameOfReferenceUID: '2.25.4' };
  const cr = { Modality: 'CR', SOPClassUID: '1.2.840.10008.5.1.4.1.1.1', Rows: 100, Columns: 100 };
  const pixels = new Int16Array(100 * 100).map((_, i) => (i % 100) + 10 * Math.floor(i / 100));
  window.cornerstone = {
    Enums: { Events: { IMAGE_RENDERED: 'CORNERSTONE_IMAGE_RENDERED', CAMERA_MODIFIED: 'CORNERSTONE_CAMERA_MODIFIED', STACK_NEW_IMAGE: 'CORNERSTONE_STACK_NEW_IMAGE' } },
    eventTarget: events,
    utilities: {},
    metaData: { get(type, id) {
      const tags = id === 'syn:ct' ? ct : id === 'syn:cr' ? cr : null; if (!tags) return undefined;
      if (type === 'instance') return tags;
      if (type === 'imagePlaneModule') return id === 'syn:ct' ? { imagePositionPatient: [0, 0, 0], rowCosines: [1, 0, 0], columnCosines: [0, 1, 0],
        rowPixelSpacing: 0.5, columnPixelSpacing: 0.5, frameOfReferenceUID: '2.25.4' } : { rowPixelSpacing: null, columnPixelSpacing: null };
      if (type === 'modalityLutModule') return id === 'syn:ct' ? { rescaleSlope: 1, rescaleIntercept: -1024 } : { rescaleSlope: 1, rescaleIntercept: 0 };
    } },
    cache: { getImage: id => ({ rows: 100, columns: 100, color: false, numberOfComponents: 1, slope: 1, intercept: id === 'syn:ct' ? -1024 : 0, getPixelData: () => pixels }) },
    getEnabledElements: () => synViewports.map(viewport => ({ viewport })),
  };
  window.cornerstoneTools = {
    Enums: { Events: { ANNOTATION_ADDED: 'ADDED', ANNOTATION_MODIFIED: 'MODIFIED', ANNOTATION_REMOVED: 'REMOVED' } },
    annotation: {
      state: {
        getAllAnnotations: () => [...annotations.values()], getAnnotation: uid => annotations.get(uid),
        addAnnotation(a) { annotations.set(a.annotationUID, a); events.dispatchEvent(new Event('ADDED')); },
        removeAnnotation(uid) { annotations.delete(uid); events.dispatchEvent(new Event('REMOVED')); },
      },
      locking: { isAnnotationLocked: uid => synLocked.has(uid) },
      config: { style: { getDefaultToolStyles: () => ({ global: { color: 'rgb(255, 255, 0)', lineWidth: '1' } }) } },
    },
  };
  window.kinViewerImageReference = id => id ? { study: '2.25.1', seriesUid: '2.25.2', sopUid: id, frame: 1 } : null;
  window.kinViewerHistoryMarkGate = () => synGate;
  // The cells: the panes of the synthetic grid, each with a view {zoom, rotation (degrees), flip, pan}.
  window.synViewports = ['left', 'right'].map(id => {
    const element = document.querySelector('#pane-' + id + ' .viewport-element');
    const v = { id, type: 'stack', element, image: id === 'left' ? 'syn:ct' : 'syn:cr', view: { zoom: 2, rotation: 0, flip: false, pan: [10, 5] },
      getCurrentImageId() { return this.image; }, getFrameOfReferenceUID() { return this.image === 'syn:ct' ? '2.25.4' : undefined; },
      getCamera: () => ({ viewPlaneNormal: [0, 0, 1], viewUp: [0, -1, 0] }),
      worldToCanvas([x, y]) { const { zoom, rotation, flip, pan } = this.view, a = rotation * Math.PI / 180, fx = flip ? -x : x;
        return [zoom * (fx * Math.cos(a) - y * Math.sin(a)) + pan[0] + 100, zoom * (fx * Math.sin(a) + y * Math.cos(a)) + pan[1]]; },
      canvasToWorld([cx, cy]) { const { zoom, rotation, flip, pan } = this.view, a = rotation * Math.PI / 180;
        const px = (cx - pan[0] - 100) / zoom, py = (cy - pan[1]) / zoom, fx = px * Math.cos(a) + py * Math.sin(a), y = -px * Math.sin(a) + py * Math.cos(a);
        return [flip ? -fx : fx, y, 0]; } };
    // The cell's own left tool: counts the presses it receives.
    element.addEventListener('mousedown', event => { if (event.button === 0) synToolPresses++; });
    return v;
  });
  window.synView = (id, view) => { const v = synViewports.find(x => x.id === id); Object.assign(v.view, view); document.dispatchEvent(new Event('CORNERSTONE_CAMERA_MODIFIED')); };
  // The page point of an image pixel (column, row) in a cell, through its current view.
  window.synPagePoint = (id, [col, row]) => {
    const v = synViewports.find(x => x.id === id), spacing = v.image === 'syn:ct' ? 0.5 : 1, rect = v.element.getBoundingClientRect();
    const [x, y] = v.worldToCanvas([col * spacing, row * spacing, 0]); return [rect.left + x, rect.top + y];
  };
  window.synMarks = () => cornerstoneTools.annotation.state.getAllAnnotations().map(a => ({ uid: a.annotationUID, tool: a.metadata.toolName, image: a.metadata.referencedImageId,
    text: a.data.text, title: a.data.title, points: a.data.handles.points, baseline: a.data.kinBaseline }));
}"""


class ViewerMeasureDOMTest(unittest.TestCase):
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
        page.route(ORIGIN + "/worklist/hpacs-lite/measure-tools-model.js",
                   lambda route: route.fulfill(path=str(HPACS / "measure-tools-model.js"), content_type="text/javascript; charset=utf-8"))
        page.goto(ORIGIN + "/")
        page.add_style_tag(path=str(HPACS / "viewer-ux-theme.css"))
        page.add_style_tag(content="[data-cy=viewport-pane] { width: 400px !important; height: 300px !important; }")
        page.add_script_tag(path=str(ROOT / "config" / "ohif" / "planar-geometry.js"))
        for name in ["viewer-ux-shortcuts.js", "viewer-features.js", "viewer-features-measure.js", "viewer-ux-toolbar.js"]:
            page.add_script_tag(path=str(HPACS / name))
        page.evaluate(SETUP, OWNER)
        page.evaluate(CORNERSTONE)
        page.evaluate("() => synMount()")
        expect(page.locator('.kin-ux-toolbar-settings [role=status]')).to_have_text('계정 설정 · 다른 PC에서도 적용됩니다.')
        page.wait_for_function("() => !!window.KinMeasureToolsModel && !!window.KinMeasureFrame")
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

    def marks(self, page):
        return page.evaluate("synMarks()")

    def test_01_measure_menu_lists_the_base_tools_in_order(self):
        page = self.open()
        page.get_by_role('button', name='Measure ▾').click()
        expect(page.get_by_role('menu', name='Measure').get_by_role('menuitem')).to_have_text(
            ['Circle by Diameter', 'Spine Label', 'Marking', 'Text', 'Memo'])

    def test_02_circle_by_diameter_places_a_circle_with_its_statistics_and_the_left_tool_does_not_run(self):
        page = self.open()
        panel = self.tool(page, 'Circle by Diameter')
        expect(panel.get_by_label('Diameter mm')).to_have_value('10')
        expect(panel.locator('[data-measure-steps] li')).to_have_text(['원의 가운데를 누르세요'])
        self.press(page, 'left', [50, 40])
        marks = self.marks(page)
        self.assertEqual(1, len(marks))
        circle = marks[0]
        self.assertEqual('KinCircleDiameter', circle['tool'])
        # 10 mm on 0.5 mm pixels: the edge 10 columns from the centre.
        self.assertEqual([[25, 20, 0], [30, 20, 0]], circle['points'])
        expected = page.evaluate("""() => { const M = KinMeasureToolsModel, shape = M.circleShape([50, 40], 10, [0.5, 0.5]);
          return M.circleValues(10, M.circleStats(shape, 100, 100, [0.5, 0.5], (x, y) => x + 10 * y - 1024)); }""")
        self.assertEqual({'calculator': 'kin-circle-v1:pixel:hu', 'values': expected}, circle['baseline'])
        self.assertEqual(7, len(expected)); self.assertEqual(317, expected[6])
        self.assertAlmostEqual(-1024 + 50 + 400, expected[2], places=6)
        expect(panel.locator('[data-measure-result]')).to_contain_text('Ø 10.0 mm · Area 78.5 mm²')
        expect(panel.locator('[data-measure-result]')).to_contain_text('HU')
        self.assertEqual(0, page.evaluate('synToolPresses'))
        expect(page.locator('[data-kin-measure-layer=left] [data-kin-mark=KinCircleDiameter] polyline')).to_have_count(1)
        # Closed, the panel takes no press: the cell's tool has it, and the circle stays.
        panel.get_by_role('button', name='Close').click()
        self.press(page, 'left', [20, 20])
        self.assertEqual(1, page.evaluate('synToolPresses'))
        self.assertEqual(1, len(self.marks(page)))

    def test_03_the_same_image_point_gives_the_same_values_after_zoom_rotation_and_flip(self):
        page = self.open()
        panel = self.tool(page, 'Circle by Diameter')
        self.press(page, 'left', [50, 40])
        # Saved (locked), the first circle has no handle to grab at that point.
        page.evaluate("() => synLocked.add(synMarks()[0].uid)")
        expect(page.locator('[data-kin-handle]')).to_have_count(0)
        page.evaluate("() => synView('left', { zoom: 2, rotation: 90, flip: true, pan: [150, 120] })")
        self.press(page, 'left', [50, 40])
        first, second = self.marks(page)
        for a, b in zip(first['points'], second['points']):
            for m, n in zip(a, b):
                self.assertAlmostEqual(m, n, places=9)
        self.assertEqual(first['baseline']['calculator'], second['baseline']['calculator'])
        for m, n in zip(first['baseline']['values'], second['baseline']['values']):
            self.assertAlmostEqual(m, n, places=9)
        # The layer follows the view: the circle's ring is drawn where the new view puts it.
        centre = page.evaluate("() => synPagePoint('left', [50, 40])")
        # The layer redraws on its next frame after the view changed.
        page.wait_for_function("""c => { const rect = document.querySelector('[data-kin-measure-layer=left]').getBoundingClientRect();
          const points = document.querySelector('[data-kin-measure-layer=left] polyline').getAttribute('points').split(' ').map(p => p.split(',').map(Number));
          const xs = points.map(p => p[0] + rect.left); return Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - c[0]) < 1e-3; }""", arg=centre)
        ring = page.evaluate("""() => { const rect = document.querySelector('[data-kin-measure-layer=left]').getBoundingClientRect();
          const points = document.querySelector('[data-kin-measure-layer=left] polyline').getAttribute('points').split(' ').map(p => p.split(',').map(Number));
          const xs = points.map(p => p[0] + rect.left), ys = points.map(p => p[1] + rect.top);
          return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, Math.max(...xs) - Math.min(...xs)]; }""")
        self.assertAlmostEqual(centre[0], ring[0], places=3); self.assertAlmostEqual(centre[1], ring[1], places=3)
        self.assertAlmostEqual(2 * 10, ring[2], places=2)
        panel.get_by_role('button', name='Close').click()

    def test_04_no_mm_on_an_image_without_spacing(self):
        page = self.open()
        panel = self.tool(page, 'Circle by Diameter')
        self.press(page, 'right', [50, 40])
        expect(panel.get_by_role('status')).to_have_text('이 영상에서는 mm 지름을 쓸 수 없습니다')
        self.assertEqual([], self.marks(page))
        # A text mark needs no spacing: it is placed on the same image.
        self.tool(page, 'Text').get_by_label('Text', exact=True).fill('scar')
        self.press(page, 'right', [10, 10])
        self.assertEqual([('KinText', 'syn:cr', 'scar')], [(m['tool'], m['image'], m['text']) for m in self.marks(page)])

    def test_05_every_press_asks_the_edit_gate_and_a_patient_switch_refuses(self):
        page = self.open()
        panel = self.tool(page, 'Text')
        panel.get_by_label('Text', exact=True).fill('RLL')
        page.evaluate("() => { synGate = '현재 검사 접근과 보관 작업을 확인한 후 측정하세요.'; }")
        self.press(page, 'left', [30, 30])
        expect(panel.get_by_role('status')).to_have_text('현재 검사 접근과 보관 작업을 확인한 후 측정하세요.')
        # During a switch the images are hidden; a press that still reaches a cell (a synthetic one here) is refused.
        page.evaluate("() => { synGate = ''; document.body.classList.add('kin-patient-switching'); }")
        page.evaluate("""() => { const [x, y] = synPagePoint('left', [30, 30]);
          document.elementsFromPoint(x, y); synViewports[0].element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: x, clientY: y })); }""")
        expect(panel.get_by_role('status')).to_have_text('환자를 바꾸는 중에는 표식을 만들거나 옮기지 않습니다')
        page.evaluate("() => { document.body.classList.remove('kin-patient-switching'); synBusy = true; }")
        self.press(page, 'left', [30, 30])
        expect(panel.get_by_role('status')).to_have_text('영상 작업을 불러오거나 저장하는 중입니다. 완료 후 다시 누르세요')
        page.evaluate("() => { synBusy = false; delete window.kinViewerHistoryMarkGate; }")
        self.press(page, 'left', [30, 30])
        expect(panel.get_by_role('status')).to_have_text('측정 기록을 확인할 수 없어 표식을 만들지 않습니다')
        self.assertEqual([], self.marks(page))
        # Refused presses are the panel's too: the cell's tool never ran.
        self.assertEqual(0, page.evaluate('synToolPresses'))

    def test_06_spine_label_stamps_the_next_level_on_every_press_and_restart_takes_back_unsaved_labels(self):
        page = self.open()
        panel = self.tool(page, 'Spine Label')
        expect(panel.get_by_label('Include C8')).not_to_be_checked()
        expect(panel.get_by_label('Include L6')).not_to_be_checked()
        self.assertIn('L4', page.evaluate("() => [...document.querySelector('[aria-label=\"Start Level\"]').options].map(o => o.value)"))
        panel.get_by_label('Start Level').select_option('L4')
        panel.get_by_label('Include L6').check()
        expect(panel.locator('[data-spine-preview]')).to_contain_text('[L4] L5 L6 S1')
        expect(panel.locator('[data-spine-preview]')).to_contain_text('C1 C2')
        self.assertEqual(['Top to bottom', 'Bottom to top'], page.evaluate("() => [...document.querySelector('[aria-label=\"Direction\"]').options].map(o => o.value)"))
        panel.get_by_label('Direction').select_option('Top to bottom')
        expect(panel.locator('[data-measure-result]')).to_have_text('Next level: L4')
        for row in (20, 35, 50, 65):
            self.press(page, 'left', [50, row])
        self.assertEqual(['L4', 'L5', 'L6', 'S1'], [m['text'] for m in self.marks(page)])
        self.press(page, 'left', [50, 80])
        expect(panel.get_by_role('status')).to_contain_text('마지막 레벨까지')
        self.assertEqual(4, len(self.marks(page)))
        # A saved (locked) label stays; Restart takes back the others and starts at the start level again.
        page.evaluate("() => synLocked.add(synMarks()[0].uid)")
        panel.get_by_role('button', name='Restart').click()
        self.assertEqual(['L4'], [m['text'] for m in self.marks(page)])
        expect(panel.locator('[data-measure-result]')).to_have_text('Next level: L4')
        # Locked, the kept label has no handle to grab where the next press lands.
        expect(page.locator('[data-kin-handle]')).to_have_count(0)
        panel.get_by_label('Direction').select_option('Bottom to top')
        self.press(page, 'left', [50, 20]); self.press(page, 'left', [50, 10])
        self.assertEqual(['L4', 'L4', 'L3'], [m['text'] for m in self.marks(page)])

    def test_07_marking_list_is_the_accounts_and_stamps_the_chosen_text(self):
        page = self.open()
        panel = self.tool(page, 'Marking')
        expect(panel.get_by_label('Marking Text List').locator('option')).to_have_count(0)
        self.press(page, 'left', [40, 40])
        expect(panel.get_by_role('status')).to_have_text('목록에서 문구를 고르세요')
        panel.get_by_label('New marking text').fill('RLL nodule')
        panel.get_by_role('button', name='Add to List').click()
        expect(panel.get_by_label('Marking Text List').locator('option')).to_have_text(['RLL nodule'])
        page.wait_for_function("() => synServer.puts.length === 1")
        self.assertEqual(['RLL nodule'], page.evaluate("synServer.puts[0].viewerSettings.features.markingTexts"))
        panel.get_by_label('Marking Text List').select_option('RLL nodule')
        self.press(page, 'left', [40, 40])
        self.assertEqual([('KinText', 'RLL nodule')], [(m['tool'], m['text']) for m in self.marks(page)])
        expect(page.locator('[data-kin-measure-layer=left] [data-kin-mark=KinText] text')).to_have_text('RLL nodule')
        # The list is read again from the account in a new panel; Delete removes the chosen phrase and saves.
        panel.get_by_role('button', name='Close').click()
        panel = self.tool(page, 'Marking')
        expect(panel.get_by_label('Marking Text List').locator('option')).to_have_text(['RLL nodule'])
        panel.get_by_label('Marking Text List').select_option('RLL nodule')
        panel.get_by_role('button', name='Delete Selected Marking Text').click()
        page.wait_for_function("() => synServer.puts.length === 2")
        self.assertEqual([], page.evaluate("synServer.puts[1].viewerSettings.features.markingTexts"))

    def test_08_text_without_arrow_and_memo_with_title(self):
        page = self.open()
        panel = self.tool(page, 'Text')
        self.press(page, 'left', [30, 30])
        expect(panel.get_by_role('status')).to_contain_text('글을 넣은 뒤')
        panel.get_by_label('Text', exact=True).fill('Rt. lower lobe')
        self.press(page, 'left', [30, 30])
        mark = page.locator('[data-kin-measure-layer=left] [data-kin-mark=KinText]')
        expect(mark.locator('text')).to_have_text('Rt. lower lobe')
        expect(mark.locator('line, path, polyline')).to_have_count(0)
        panel = self.tool(page, 'Memo')
        self.assertEqual(0, page.locator('[data-feature-panel=measure-text]').count())
        self.press(page, 'left', [60, 60])
        expect(panel.get_by_role('status')).to_contain_text('제목이나 글을')
        panel.get_by_label('Memo Title').fill('F/U')
        panel.get_by_label('Memo Text').fill('Compare with prior CT')
        self.press(page, 'left', [60, 60])
        memo = [m for m in self.marks(page) if m['tool'] == 'KinMemo'][0]
        self.assertEqual(('F/U', 'Compare with prior CT'), (memo['title'], memo['text']))
        expect(page.locator('[data-kin-measure-layer=left] [data-kin-mark=KinMemo] text')).to_have_text(['F/U', 'Compare with prior CT'])

    def test_09_an_unlocked_mark_drags_and_a_locked_one_does_not(self):
        page = self.open()
        panel = self.tool(page, 'Text')
        panel.get_by_label('Text', exact=True).fill('A')
        self.press(page, 'left', [20, 20])
        panel.get_by_role('button', name='Close').click()
        handle = page.locator('[data-kin-measure-layer=left] [data-kin-handle]')
        expect(handle).to_have_count(1)
        start = page.evaluate("() => synPagePoint('left', [20, 20])"); end = page.evaluate("() => synPagePoint('left', [40, 30])")
        page.mouse.move(*start); page.mouse.down(); page.mouse.move(*end, steps=4); page.mouse.up()
        point = self.marks(page)[0]['points'][0]
        self.assertAlmostEqual(20, point[0], places=6); self.assertAlmostEqual(15, point[1], places=6)
        self.assertEqual(0, page.evaluate('synToolPresses'))
        # A drag the gate refuses keeps the mark where it was.
        page.evaluate("() => { synGate = '계정이 확인되기 전에는 측정·표식을 편집하지 않습니다.'; }")
        start = end; end = page.evaluate("() => synPagePoint('left', [60, 60])")
        page.mouse.move(*start); page.mouse.down(); page.mouse.move(*end, steps=4); page.mouse.up()
        self.assertEqual(point, self.marks(page)[0]['points'][0])
        page.evaluate("() => { synGate = ''; synLocked.add(synMarks()[0].uid); }")
        expect(handle).to_have_count(0)

    def test_10_close_drops_an_unfinished_mark_and_a_press_on_another_image_starts_it_again(self):
        page = self.open()
        # A two-step tool of the frame (the form the Measure menu's line tools take): its first point is pending.
        page.evaluate("""() => { window.synDone = []; KinMeasureFrame.open({ id: 'syn-two', title: 'Two Points',
          steps: [{ text: 'First point', points: 1 }, { text: 'Second point', points: 1 }],
          complete: (tool, presses) => { synDone.push(presses.map(p => [p.imageId, p.image])); return ''; } }); }""")
        panel = page.get_by_role('dialog', name='Two Points')
        self.press(page, 'left', [10, 10])
        expect(panel.locator('[data-step=done]')).to_have_text(['First point'])
        expect(panel.locator('[data-step=now]')).to_have_text(['Second point'])
        expect(page.locator('[data-kin-measure-layer=left] [data-kin-pending]')).to_have_count(1)
        self.press(page, 'right', [10, 10])
        expect(panel.get_by_role('status')).to_contain_text('다른 영상')
        self.press(page, 'right', [20, 10])
        self.assertEqual([[['syn:cr', [10, 10]], ['syn:cr', [20, 10]]]], page.evaluate('synDone'))
        self.press(page, 'left', [30, 30])
        expect(page.locator('[data-kin-pending]')).to_have_count(1)
        panel.get_by_role('button', name='Close').click()
        expect(page.locator('[data-kin-pending]')).to_have_count(0)
        self.assertEqual(1, len(page.evaluate('synDone')))

    def test_12_a_circle_moved_off_the_image_goes_back_with_the_values_of_its_place(self):
        page = self.open()
        panel = self.tool(page, 'Circle by Diameter')
        self.press(page, 'left', [50, 40])
        panel.get_by_role('button', name='Close').click()
        before = self.marks(page)[0]
        start = page.evaluate("() => synPagePoint('left', [50, 40])")
        # Over another place first (its values are computed there), then released beyond the image: the drag is undone.
        page.mouse.move(*start); page.mouse.down()
        page.mouse.move(*page.evaluate("() => synPagePoint('left', [70, 60])"), steps=4)
        moved = self.marks(page)[0]
        self.assertNotEqual(before['baseline']['values'][2], moved['baseline']['values'][2])
        page.mouse.move(*page.evaluate("() => synPagePoint('left', [130, 60])"), steps=4); page.mouse.up()
        after = self.marks(page)[0]
        self.assertEqual((before['points'], before['baseline']), (after['points'], after['baseline']))
        expect(page.locator('[data-kin-mark=KinCircleDiameter]')).not_to_contain_text('재확인 필요')
        # The History panel's check before a save: the stored values are those of the circle's place.
        self.assertEqual('', page.evaluate("() => KinMeasureFrame.verify(cornerstoneTools.annotation.state.getAllAnnotations()[0])"))
        # Checked from the pixels each time, not from an earlier verdict: pixels away fails, pixels back passes.
        page.evaluate("() => { window.synCache = cornerstone.cache.getImage; cornerstone.cache.getImage = () => undefined; }")
        self.assertNotEqual('', page.evaluate("() => KinMeasureFrame.verify(cornerstoneTools.annotation.state.getAllAnnotations()[0])"))
        page.evaluate("() => { cornerstone.cache.getImage = synCache; }")
        self.assertEqual('', page.evaluate("() => KinMeasureFrame.verify(cornerstoneTools.annotation.state.getAllAnnotations()[0])"))
        page.evaluate("() => { cornerstoneTools.annotation.state.getAllAnnotations()[0].data.kinBaseline.values[2] += 1; }")
        self.assertIn('저장 당시 값과 다릅니다', page.evaluate("() => KinMeasureFrame.verify(cornerstoneTools.annotation.state.getAllAnnotations()[0])"))

    def test_13_another_image_drops_the_points_of_an_unfinished_mark(self):
        page = self.open()
        page.evaluate("""() => { window.synDone = []; KinMeasureFrame.open({ id: 'syn-two', title: 'Two Points',
          steps: [{ text: 'First point', points: 1 }, { text: 'Second point', points: 1 }],
          complete: (tool, presses) => { synDone.push(presses.length); return ''; } }); }""")
        panel = page.get_by_role('dialog', name='Two Points')
        self.press(page, 'left', [10, 10])
        expect(panel.locator('[data-step=now]')).to_have_text(['Second point'])
        # A → B → A: the first point does not wait on A for its second.
        page.evaluate("() => { synViewports[0].image = 'syn:cr'; document.dispatchEvent(new Event('CORNERSTONE_STACK_NEW_IMAGE')); }")
        expect(panel.get_by_role('status')).to_contain_text('영상이 바뀌어')
        expect(panel.locator('[data-step=now]')).to_have_text(['First point'])
        page.evaluate("() => { synViewports[0].image = 'syn:ct'; document.dispatchEvent(new Event('CORNERSTONE_STACK_NEW_IMAGE')); }")
        self.press(page, 'left', [20, 20])
        self.assertEqual([], page.evaluate('synDone'))
        expect(panel.locator('[data-step=now]')).to_have_text(['Second point'])

    def test_11_the_menu_fits_the_narrow_windows(self):
        for size in ((768, 1024), (1024, 768)):
            page = self.open(size=size)
            button = page.get_by_role('button', name='Measure ▾')
            button.scroll_into_view_if_needed()
            expect(button).to_be_visible()
            box = button.bounding_box()
            self.assertTrue(box['x'] >= 0 and box['x'] + box['width'] <= size[0], (size, box))
            panel = self.tool(page, 'Spine Label')
            box = panel.bounding_box()
            self.assertTrue(box['x'] >= 0 and box['x'] + box['width'] <= size[0] and box['y'] + box['height'] <= size[1], (size, box))


if __name__ == "__main__":
    unittest.main()
