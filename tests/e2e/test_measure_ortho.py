# coding: utf-8
"""Measure menu orthopaedic and spine tools on the shipped viewer over synthetic DICOM: Limb Length Discrepancy,
Acetabular Angle, Spine Balance, Cobb Angle (Lordosis / Kyphosis) and Pelvic Incidence are made by pressing known image
points through the step panel, saved through the Measurements & Key Images panel, checked against values calculated here
from the saved points, reopened and edited; hand-computed items are frozen into a Job with annotations and printed; an
image without pixel spacing gives pixels.

Run in CI: `python tests/measurement_ci.py --profile measure-ortho` (validate.yml worklist-ux-measurements; the
"Focused integration" workflow runs the same profile on a branch).
"""
import io
import math
import sys
import unittest
import uuid

import numpy as np
from pydicom import dcmread
from pydicom.uid import generate_uid
from playwright.sync_api import expect
from test_viewer_job_print import ViewerJobPrintE2E, canvas_ready

TOOLS = {'limbLength': 'KinLimbLength', 'acetabular': 'KinAcetabular', 'spineBalance': 'KinSpineBalance',
         'spineCobb': 'KinSpineCobb', 'pelvicIncidence': 'KinPelvicIncidence'}
NAMES = {'limbLength': 'Limb Length Discrepancy', 'acetabular': 'Acetabular Angle', 'spineBalance': 'Spine Balance',
         'spineCobb': 'Cobb Angle (Lordosis / Kyphosis)', 'pelvicIncidence': 'Pelvic Incidence'}
DEG = 180 / math.pi


# ── The definitions, written again here from the step texts (the third implementation beside the viewer's and the server's).
# Points: image pixels (column, row); spacing (row mm, column mm) or None. On the patient plane, y upwards.
def plane(points, spacing):
    row, col = spacing if spacing else (1, 1)
    return [np.array([x * col, -y * row]) for x, y in points]


def acute(u, v):
    return math.degrees(math.acos(min(1, abs(float(u @ v)) / np.linalg.norm(u) / np.linalg.norm(v))))


def reference(kind, points, spacing, back=None):
    P = plane(points, spacing)
    if kind == 'limbLength':
        base = P[1] - P[0]; n = np.array([-base[1], base[0]]) / np.linalg.norm(base)
        pl, pr = sorted(P[2:4], key=lambda p: p[0]); fl, fr = sorted(P[4:6], key=lambda p: p[0])
        left, right = abs(float((fl - pl) @ n)), abs(float((fr - pr) @ n))
        return [left, right, abs(left - right)]
    if kind == 'acetabular':
        a = P[1] - P[0]; one, two = P[3] - P[2], P[5] - P[4]
        left, right = (one, two) if (P[2] + P[3])[0] <= (P[4] + P[5])[0] else (two, one)
        return [acute(a, left), acute(a, right)]
    if kind == 'spineBalance':
        return [sum(p[0] for p in P[:4]) / 4 - (P[4][0] + P[5][0]) / 2]
    if kind == 'spineCobb':
        b = 1 if back == 'right' else -1
        lines = [(P[1] - P[0], (P[0] + P[1]) / 2), (P[3] - P[2], (P[2] + P[3]) / 2)]
        upper, lower = (lines[1], lines[0]) if lines[1][1][1] > lines[0][1][1] else (lines[0], lines[1])
        def tilt(u):
            x, y = u[0] * b, u[1]
            if x < 0 or (x == 0 and y < 0): x, y = -x, -y
            return math.degrees(math.atan2(y, x))
        return [tilt(upper[0]) - tilt(lower[0])]
    # Pelvic Incidence: the angle between the endplate's perpendicular (into the pelvis) and the line to the hip axis,
    # SS against the horizontal, PT against the vertical; PI = PT + SS is checked separately.
    H, front, back_end = (P[0] + P[1]) / 2, P[2], P[3]; M = (front + back_end) / 2
    a = 1 if front[0] > back_end[0] else -1
    ss = math.degrees(math.atan2(back_end[1] - front[1], a * (front[0] - back_end[0])))
    pt = math.degrees(math.atan2(a * (H[0] - M[0]), M[1] - H[1]))
    plate = front - back_end; normal = np.array([plate[1], -plate[0]])
    if normal[1] > 0: normal = -normal
    mh = H - M
    direct = math.degrees(math.acos(float(normal @ mh) / np.linalg.norm(normal) / np.linalg.norm(mh)))
    return [direct, pt, ss]


class MeasureOrthoE2E(ViewerJobPrintE2E):
    # ── the viewer ──
    def viewer(self, f):
        p = self.launch_job([f]); canvas_ready(p, 1)
        tab = p.locator('#kin-workspace-dock nav button[aria-controls=kin-viewer-history]')
        if tab.get_attribute('aria-expanded') != 'true': tab.click()
        expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text('개 저장 항목', timeout=45000)
        p.wait_for_function("() => !!window.KinMeasureOrtho && !!window.KinMeasureFrame", timeout=45000)
        return p

    def tool(self, p, name):
        menu = p.get_by_role('button', name='Measure ▾')
        menu.scroll_into_view_if_needed(); menu.click()
        p.get_by_role('menu', name='Measure').get_by_role('menuitem', name=name, exact=True).click()
        panel = p.get_by_role('dialog', name=name)
        expect(panel).to_be_visible()
        return panel

    # The page point of an image pixel in the active cell, through the cell's own view.
    def page_point(self, p, col, row):
        return p.evaluate('''([c, r]) => { const v = services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());
          const q = v.worldToCanvas(KinMeasureFrame.toWorld(v.getCurrentImageId(), [c, r])), rect = (v.canvas || v.element).getBoundingClientRect();
          return [rect.left + q[0], rect.top + q[1]]; }''', [col, row])

    def press(self, p, col, row):
        p.mouse.click(*self.page_point(p, col, row))

    def marks(self, p, kind):
        return p.evaluate("""tool => cornerstoneTools.annotation.state.getAllAnnotations().filter(a => a.metadata.toolName === tool)
          .map(a => ({ uid: a.annotationUID, points: a.data.handles.points, baseline: a.data.kinBaseline }))""", TOOLS[kind])

    def items(self, f):
        r = self.stack.request('GET', f'/studies/{f.uid}/viewer-items?includeHidden=true', 'doctor')
        self.assertEqual(r.status, 200, r.text); return r.body['items']

    def head(self, f, kind):
        return [h for h in self.items(f) if h['item']['kind'] == kind][0]

    # The frame's geometry: image pixel ↔ world for its axis-aligned plane.
    def frame(self, f):
        ds = dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/' + self.stack.first_instance_id(f.uid) + '/file')))
        origin = np.array(ds.ImagePositionPatient, dtype=float); orientation = np.array(ds.ImageOrientationPatient, dtype=float)
        spacing = tuple(float(n) for n in ds.PixelSpacing)
        u, v = orientation[:3], orientation[3:]
        def world(col, row): return (origin + u * spacing[1] * col + v * spacing[0] * row).tolist()
        def pixel(w): d = np.array(w) - origin; return [float(d @ u) / spacing[1], float(d @ v) / spacing[0]]
        return ds, spacing, world, pixel

    def check_values(self, kind, item, spacing, pixel):
        points = [pixel(w) for w in item['points']]
        back = item['baseline']['calculator'].split(':')[1] if kind == 'spineCobb' else None
        expected = reference(kind, points, spacing, back)
        for value, want in zip(item['baseline']['values'], expected):
            self.assertAlmostEqual(want, value, places=6, msg=kind)
        if kind == 'pelvicIncidence':
            pi, pt, ss = item['baseline']['values']; self.assertAlmostEqual(pi, pt + ss, places=9)

    def test_ortho_01_five_tools_made_by_points_saved_checked_reopened_and_edited(self):
        f = self.ct('ORTH-' + uuid.uuid4().hex[:12], 'current', '20260801')
        ds, spacing, world, pixel = self.frame(f)
        rows, cols = int(ds.Rows), int(ds.Columns)
        at = lambda fx, fy: (cols * fx, rows * fy)
        p = self.viewer(f)
        # The points of each tool, as fractions of the image (a pelvis and a spine drawn by where they are pressed).
        plan = {
            'limbLength': [at(.15, .30), at(.85, .30), at(.30, .36), at(.70, .34), at(.31, .60), at(.69, .62)],
            'acetabular': [at(.25, .50), at(.75, .50), at(.12, .40), at(.25, .50), at(.75, .50), at(.88, .44)],
            'spineBalance': [at(.42, .12), at(.52, .12), at(.53, .18), at(.41, .18), at(.30, .80), at(.74, .80)],
            'spineCobb': [at(.35, .25), at(.60, .30), at(.35, .70), at(.60, .64)],
            'pelvicIncidence': [at(.44, .82), at(.48, .82), at(.40, .55), at(.60, .45)],
        }
        for kind, points in plan.items():
            panel = self.tool(p, NAMES[kind])
            for col, row in points: self.press(p, col, row)
            expect(panel.locator('[data-measure-result]')).to_contain_text('Result: ')
            panel.get_by_role('button', name='Close', exact=True).click()
            expect(p.locator(f'[data-kin-mark={TOOLS[kind]}]')).to_have_count(1)
        self.assertEqual(0, p.locator('[data-kin-mark] text').filter(has_text='재확인 필요').count())
        for kind in plan:
            row = p.locator(f'#kin-viewer-history section[data-kind={kind}]')
            expect(row).to_contain_text(NAMES[kind] + ' · Unsaved')
            expect(row).to_contain_text('SR 미지원 표식')
            row.get_by_role('button', name='Save', exact=True).click(); expect(row).to_contain_text('Saved r1')
        heads = {kind: self.head(f, kind)['item'] for kind in plan}
        for kind, item in heads.items():
            self.check_values(kind, item, spacing, pixel)
            calculator = item['baseline']['calculator']
            self.assertEqual(calculator, {'spineCobb': 'kin-spinecobb-v1:right:pixel'}.get(kind, 'kin-' + kind.lower() + '-v1:pixel'))
        # The Cobb lines close in towards the back (the image's right, the default): a lordosis, negative.
        self.assertLess(heads['spineCobb']['baseline']['values'][0], 0)
        expect(p.locator('#kin-viewer-history section[data-kind=pelvicIncidence]')).to_contain_text('PI ')
        p.close()
        # Reopened: every mark is drawn again from the saved points, its values those of its points.
        p = self.viewer(f)
        p.wait_for_function("n => document.querySelectorAll('[data-kin-mark^=Kin]').length >= n", arg=5, timeout=45000)
        for kind, item in heads.items():
            self.assertEqual(item['points'], self.marks(p, kind)[0]['points'])
            expect(p.locator(f'[data-kin-mark={TOOLS[kind]}]')).not_to_contain_text('재확인 필요')
        pi, pt, ss = heads['pelvicIncidence']['baseline']['values']
        expect(p.locator('[data-kin-mark=KinPelvicIncidence]')).to_contain_text('PI %.1f° · PT %.1f° · SS %.1f°' % (pi, pt, ss))
        # Edit: the femoral head ① moved alone; the values follow and are saved as r2.
        row = p.locator('#kin-viewer-history section[data-kind=pelvicIncidence]')
        row.get_by_role('button', name='Edit', exact=True).click()
        handle = p.locator('[data-kin-mark=KinPelvicIncidence] [data-kin-point="0"]')
        expect(handle).to_be_visible()
        start = self.page_point(p, *plan['pelvicIncidence'][0]); end = self.page_point(p, cols * .38, rows * .84)
        p.mouse.move(*start); p.mouse.down(); p.mouse.move(*end, steps=6); p.mouse.up()
        row.get_by_role('button', name='Save', exact=True).click(); expect(row).to_contain_text('Saved r2')
        moved = self.head(f, 'pelvicIncidence')['item']
        self.assertEqual(heads['pelvicIncidence']['points'][1:], moved['points'][1:])
        self.assertNotEqual(heads['pelvicIncidence']['points'][0], moved['points'][0])
        self.check_values('pelvicIncidence', moved, spacing, pixel)
        self.assertNotAlmostEqual(pi, moved['baseline']['values'][0], places=3)

    def test_ortho_02_hand_computed_items_are_checked_by_the_server_frozen_and_printed(self):
        f = self.ct('ORTH-' + uuid.uuid4().hex[:12], 'current', '20260801')
        ds, spacing, world, pixel = self.frame(f)
        rows, cols = int(ds.Rows), int(ds.Columns)
        common = dict(schemaVersion=1, seriesUid=str(ds.SeriesInstanceUID), sopUid=str(ds.SOPInstanceUID), frame=1, frameOfReferenceUid=str(ds.FrameOfReferenceUID), label='')
        # Whole pixels, so the values are those written here: Pelvic Incidence with the hip axis right under the endplate's
        # middle (PT 0, PI = SS); Cobb with lines of equal and opposite slope.
        c, r = cols // 2, rows // 2; dx, dy = 20, 10
        sr, sc = spacing
        ss = math.degrees(math.atan2(dy * sr, 2 * dx * sc))
        cobb = 2 * math.degrees(math.atan2(4 * sr, 40 * sc))
        items = {
            'pelvicIncidence': ([(c - 2, r + 40), (c + 2, r + 40), (c - dx, r), (c + dx, r - dy)], 'kin-pelvicincidence-v1:pixel', [ss, 0, ss]),
            'spineCobb': ([(c - 20, r - 30), (c + 20, r - 26), (c - 20, r + 30), (c + 20, r + 26)], 'kin-spinecobb-v1:right:pixel', [-cobb]),
            'spineBalance': ([(c - 10, r - 40), (c + 10, r - 40), (c + 10, r - 30), (c - 10, r - 30), (c - 40, r + 40), (c + 20, r + 40)], 'kin-spinebalance-v1:pixel', [10 * sc]),
            'limbLength': ([(c - 40, r - 20), (c + 40, r - 20), (c - 30, r - 16), (c + 30, r - 18), (c - 30, r + 20), (c + 30, r + 22)], 'kin-limblength-v1:pixel', [36 * sr, 40 * sr, 4 * sr]),
            'acetabular': ([(c - 40, r), (c + 40, r), (c - 50, r - 10 * sc / sr), (c - 40, r), (c + 40, r), (c + 50, r - 10 * sc / sr)], 'kin-acetabular-v1:pixel', [45, 45]),
        }
        for kind, (points, calculator, values) in items.items():
            self.assertTrue(all(abs(a - b) < 1e-6 for a, b in zip(values, reference(kind, points, spacing, 'right'))), kind)
            item = dict(common, kind=kind, points=[world(x, y) for x, y in points], baseline=dict(calculator=calculator, values=values))
            response = self.stack.request('POST', f'/studies/{f.uid}/viewer-items', 'doctor', dict(requestId=str(uuid.uuid4()), item=item))
            self.assertEqual(response.status, 200, response.text)
        # The server refuses values that are not those its points make on the original, and another back side.
        points, calculator, values = items['pelvicIncidence']
        wrong = dict(common, kind='pelvicIncidence', points=[world(x, y) for x, y in points], baseline=dict(calculator=calculator, values=[ss + 1, 0, ss + 1]))
        self.assertEqual(400, self.stack.request('POST', f'/studies/{f.uid}/viewer-items', 'doctor', dict(requestId=str(uuid.uuid4()), item=wrong)).status)
        points, calculator, values = items['spineCobb']
        side = dict(common, kind='spineCobb', points=[world(x, y) for x, y in points], baseline=dict(calculator='kin-spinecobb-v1:left:pixel', values=values))
        self.assertEqual(400, self.stack.request('POST', f'/studies/{f.uid}/viewer-items', 'doctor', dict(requestId=str(uuid.uuid4()), item=side)).status)
        p = self.launch_job([f]); canvas_ready(p, 1)
        p.evaluate('''async sop => { const g = services.viewportGridService.getState(), v = services.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId);
          const index = v.getImageIds().findIndex(id => cornerstone.metaData.get('instance', id).SOPInstanceUID === sop); if (index < 0) throw Error('fixture SOP missing');
          await v.setImageIdIndex(index); v.scroll(index - v.getTargetImageIdIndex(), false); }''', str(ds.SOPInstanceUID))
        p.wait_for_function("() => document.querySelectorAll('[data-kin-mark^=Kin]').length === 5", timeout=45000)
        self.assertEqual(0, p.locator('[data-kin-mark] text').filter(has_text='재확인 필요').count())
        expect(p.locator('[data-kin-mark=KinSpineCobb]')).to_contain_text('Lordosis @−%.1f°' % cobb)
        p.get_by_label('Job Title', exact=True).fill('Measure ortho job')
        self.click_job(p, 'Save Job with Annotations', '저장된 주석 이력도 함께 고정했습니다')
        job = self.jobs(f)[0]
        frozen = self.stack.request('GET', f'/studies/{f.uid}/viewer-jobs/{job["id"]}', 'doctor')
        self.assertEqual(frozen.status, 200, frozen.text)
        self.assertEqual(set(items), {a['item']['kind'] for a in frozen.body['annotations']})
        paper = self.output(p)
        expect(paper.locator('[data-annotation-id]')).to_have_count(5)
        main = paper.locator('main')
        for name in ['다리 길이 차', '비구각', '척추 균형', 'Cobb (전만/후만)', '골반 입사각']:
            expect(main).to_contain_text(name)
        expect(main).to_contain_text('PI %.1f° · PT 0.0° · SS %.1f°' % (ss, ss))
        expect(main).to_contain_text('Lordosis @−%.1f°' % cobb)
        self.assertEqual(paper.locator('script').count(), 0)

    def test_ortho_03_an_image_without_spacing_gives_pixels(self):
        f = self.ct('ORTH-' + uuid.uuid4().hex[:12], 'current', '20260801')
        ds = dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/' + self.stack.first_instance_id(f.uid) + '/file')))
        ds.SOPInstanceUID = generate_uid(); ds.SeriesInstanceUID = generate_uid(); ds.SeriesNumber = 2
        ds.SOPClassUID = '1.2.840.10008.5.1.4.1.1.1'; ds.Modality = 'CR'
        for tag in ('PixelSpacing', 'ImagePositionPatient', 'ImageOrientationPatient', 'FrameOfReferenceUID', 'SliceLocation', 'SliceThickness'):
            if tag in ds: delattr(ds, tag)
        ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID; ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
        stream = io.BytesIO(); ds.save_as(stream, write_like_original=False)
        self.assertEqual(200, self.stack._orthanc_request('POST', '/instances', stream.getvalue()).status)
        key = dict(schemaVersion=1, kind='key', seriesUid=str(ds.SeriesInstanceUID), sopUid=str(ds.SOPInstanceUID), frame=1, title='CR without spacing', description='')
        self.assertEqual(200, self.stack.request('POST', f'/studies/{f.uid}/viewer-items', 'doctor', dict(requestId=str(uuid.uuid4()), item=key)).status)
        p = self.viewer(f)
        p.locator('#kin-viewer-history section').filter(has_text='CR without spacing').get_by_role('button', name='Go to Image').click()
        p.wait_for_function("sop => cornerstone.metaData.get('instance', services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId()).getCurrentImageId())?.SOPInstanceUID === sop",
                            arg=str(ds.SOPInstanceUID), timeout=45000)
        rows, cols = int(ds.Rows), int(ds.Columns)
        panel = self.tool(p, 'Spine Balance')
        for fx, fy in [(.42, .12), (.52, .12), (.53, .18), (.41, .18), (.30, .80), (.74, .80)]:
            self.press(p, cols * fx, rows * fy)
        expect(panel.locator('[data-measure-result]')).to_contain_text('px')
        expect(panel.locator('[data-measure-result]')).to_contain_text('픽셀 기준(간격 미확인)')
        panel.get_by_role('button', name='Close', exact=True).click()
        row = p.locator('#kin-viewer-history section[data-kind=spineBalance]')
        row.get_by_role('button', name='Save', exact=True).click(); expect(row).to_contain_text('Saved r1')
        saved = self.head(f, 'spineBalance')['item']
        self.assertEqual(('kin-spinebalance-v1:px', None), (saved['baseline']['calculator'], saved['frameOfReferenceUid']))
        expect(row).to_contain_text('픽셀 기준(간격 미확인)')


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(MeasureOrthoE2E(n) for n in loader.getTestCaseNames(MeasureOrthoE2E) if n.startswith('test_ortho_'))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace'); unittest.main(verbosity=2)
