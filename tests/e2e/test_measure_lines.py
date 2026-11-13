# coding: utf-8
"""Measure menu line tools on the shipped viewer over synthetic DICOM: CTR, Parallel Lines, Length Ratio, Centre-line Angle
and Volume Measure are made through the step panel, saved through the Measurements & Key Images panel, reopened, edited,
frozen into a Job with annotations and printed. A Volume's lengths are measured on a CT frame and on a synthetic ultrasound
frame (Region Calibration) of the same study; an image without pixel spacing gives pixel-based lines and no volume.

Run in CI: `python tests/measurement_ci.py --profile measure-lines` (validate.yml worklist-ux-measurements; the
"Focused integration" workflow runs the same profile on a branch).
"""
import io
import math
import sys
import unittest
import uuid

import numpy as np
from pydicom import dcmread
from pydicom.dataset import Dataset
from pydicom.sequence import Sequence
from pydicom.uid import generate_uid
from playwright.sync_api import expect
from test_viewer_job_print import canvas_ready
from test_measure_base import MeasureBaseE2E

TOOLS = {'ctr': 'KinCTR', 'parallel': 'KinParallelLines', 'ratio': 'KinLengthRatio', 'centreAngle': 'KinCentreLineAngle', 'volume': 'KinVolume'}
US_DELTA = (0.02, 0.03)  # PhysicalDeltaX, PhysicalDeltaY in cm: 0.2 mm columns, 0.3 mm rows.


# The values of a line tool from image pixel points and [row, column] spacing (None: pixels), as measure-lines-model.js.
def line_values(tool, pts, spacing):
    s = spacing or (1, 1)
    p = [np.array([x * s[1], y * s[0]]) for x, y in pts]
    size = lambda v: float(np.hypot(*v))
    cross = lambda a, b: float(a[0] * b[1] - a[1] * b[0])
    div = lambda a, b: None if a is None or b is None or abs(b) <= 1e-9 else a / b
    if tool == 'ctr4':
        axis = p[1] - p[0]; n = size(axis)
        away = lambda q: abs(cross(axis, q - p[0])) / n if n > 1e-9 else None
        mrd, mld, idd = away(p[2]), away(p[3]), size(p[5] - p[4])
        return [mrd, mld, idd, None if mrd is None else div(mrd + mld, idd)]
    if tool == 'ctr2':
        a, b = size(p[1] - p[0]), size(p[3] - p[2]); return [min(a, b), max(a, b), div(min(a, b), max(a, b))]
    if tool == 'parallel':
        d = p[1] - p[0]; joint = (p[2] + p[3]) / 2 - (p[0] + p[1]) / 2
        return [abs(cross(d, joint)) / size(d) if size(d) > 1e-9 else None, size(joint)]
    if tool == 'ratio':
        a, b = size(p[1] - p[0]), size(p[3] - p[2]); return [a, b, div(a, b)]
    if tool == 'centreangle':
        def centre(a1, a2, b1, b2):
            d = a2 - a1
            if size(d) <= 1e-9: d = b2 - b1
            if float(np.dot(b2 - b1, d)) < 0: b1, b2 = b2, b1
            return (a2 + b2) / 2 - (a1 + b1) / 2
        def down(u): return u if u[1] > 1e-9 or (abs(u[1]) <= 1e-9 and u[0] > 0) else -u
        u, v = down(centre(*p[:4])), down(centre(*p[4:]))
        angle = math.degrees(math.atan2(abs(cross(u, v)), float(np.dot(u, v)))); return [angle, 360 - angle]
    raise ValueError(tool)


class MeasureLinesE2E(MeasureBaseE2E):
    def tool(self, p, name, title=None):
        menu = p.get_by_role('button', name='Measure ▾')
        menu.scroll_into_view_if_needed(); menu.click()
        p.get_by_role('menu', name='Measure').get_by_role('menuitem', name=name, exact=True).click()
        panel = p.get_by_role('dialog', name=title or name)
        expect(panel).to_be_visible()
        return panel

    def marks(self, p, kind):
        return p.evaluate("""tool => cornerstoneTools.annotation.state.getAllAnnotations().filter(a => a.metadata.toolName === tool)
          .map(a => ({ uid: a.annotationUID, text: a.data.text, points: a.data.handles.points, baseline: a.data.kinBaseline, image: a.metadata.referencedImageId }))""", TOOLS[kind])

    def ct_geometry(self, f):
        ds = dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/' + self.stack.first_instance_id(f.uid) + '/file')))
        origin = np.array(ds.ImagePositionPatient, dtype=float); u = np.array(ds.ImageOrientationPatient[:3], dtype=float); v = np.array(ds.ImageOrientationPatient[3:], dtype=float)
        spacing = [float(x) for x in ds.PixelSpacing]
        world = lambda col, row: (origin + u * spacing[1] * col + v * spacing[0] * row).tolist()
        pixel = lambda w: [float(np.dot(np.array(w) - origin, u)) / spacing[1], float(np.dot(np.array(w) - origin, v)) / spacing[0]]
        return ds, spacing, world, pixel

    # A frame of the study made from its first CT image: an ultrasound image with one Region Calibration over the whole
    # image, or a radiograph without spacing. Neither has plane geometry: the viewer shows pixel (x, y) at [0, x, −y].
    def add_frame(self, f, kind):
        ds = dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/' + self.stack.first_instance_id(f.uid) + '/file')))
        ds.SOPInstanceUID = generate_uid(); ds.SeriesInstanceUID = generate_uid(); ds.SeriesNumber = 2 if kind == 'us' else 3
        for tag in ('PixelSpacing', 'ImagePositionPatient', 'ImageOrientationPatient', 'FrameOfReferenceUID', 'SliceLocation', 'SliceThickness'):
            if tag in ds: delattr(ds, tag)
        if kind == 'us':
            ds.SOPClassUID = '1.2.840.10008.5.1.4.1.1.6.1'; ds.Modality = 'US'
            region = Dataset()
            region.RegionSpatialFormat = 1; region.RegionDataType = 1; region.RegionFlags = 0
            region.RegionLocationMinX0 = 0; region.RegionLocationMinY0 = 0
            region.RegionLocationMaxX1 = int(ds.Columns) - 1; region.RegionLocationMaxY1 = int(ds.Rows) - 1
            region.PhysicalUnitsXDirection = 3; region.PhysicalUnitsYDirection = 3
            region.PhysicalDeltaX = US_DELTA[0]; region.PhysicalDeltaY = US_DELTA[1]
            ds.SequenceOfUltrasoundRegions = Sequence([region])
        else:
            ds.SOPClassUID = '1.2.840.10008.5.1.4.1.1.1'; ds.Modality = 'CR'
        ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID; ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
        stream = io.BytesIO(); ds.save_as(stream, write_like_original=False)
        self.assertEqual(200, self.stack._orthanc_request('POST', '/instances', stream.getvalue()).status)
        title = {'us': 'US frame', 'cr': 'CR without spacing'}[kind]
        key = dict(schemaVersion=1, kind='key', seriesUid=str(ds.SeriesInstanceUID), sopUid=str(ds.SOPInstanceUID), frame=1, title=title, description='')
        self.assertEqual(200, self.stack.request('POST', f'/studies/{f.uid}/viewer-items', 'doctor', dict(requestId=str(uuid.uuid4()), item=key)).status)
        return ds, title

    def go(self, p, title, sop):
        p.locator('#kin-viewer-history section').filter(has_text=title).get_by_role('button', name='Go to Image').click()
        p.wait_for_function("sop => cornerstone.metaData.get('instance', services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId()).getCurrentImageId())?.SOPInstanceUID === sop",
                            arg=sop, timeout=45000)

    def assert_values(self, actual, expected, places=4):
        self.assertEqual(len(actual), len(expected))
        for a, e in zip(actual, expected):
            if e is None: self.assertIsNone(a)
            else: self.assertAlmostEqual(a, e, places=places)

    def test_lines_01_four_tools_save_reopen_and_edit_with_values_from_the_original(self):
        f = self.ct('LINES-' + uuid.uuid4().hex[:12], 'current', '20260801')
        _, spacing, _, pixel = self.ct_geometry(f)
        p = self.viewer(f)
        panel = self.tool(p, 'CTR')
        expect(panel.get_by_label('CTR Method')).to_have_value('4')
        for fx, fy in [(.5, .15), (.5, .85), (.38, .5), (.66, .55), (.15, .62), (.85, .62)]: self.press(p, fx, fy)
        expect(panel.locator('[data-measure-result]')).to_contain_text('CTR ')
        panel = self.tool(p, 'Parallel Lines')
        for fx, fy in [(.2, .25), (.45, .25), (.32, .4)]: self.press(p, fx, fy)
        expect(panel.locator('[data-measure-result]')).to_contain_text('Gap ')
        panel = self.tool(p, 'Length Ratio')
        for fx, fy in [(.6, .2), (.8, .3), (.6, .35), (.7, .35)]: self.press(p, fx, fy)
        expect(panel.locator('[data-measure-result]')).to_contain_text('Ratio (L1/L2) ')
        panel = self.tool(p, 'Centre-line Angle')
        for fx, fy in [(.2, .7), (.4, .7), (.2, .76), (.4, .76), (.55, .7), (.75, .9), (.6, .7), (.8, .9)]: self.press(p, fx, fy)
        expect(panel.locator('[data-measure-result]')).to_contain_text('Angle ')
        panel.get_by_role('button', name='Close', exact=True).click()
        for kind in TOOLS:
            if kind == 'volume': continue
            row = self.save_rows(p, kind, 1).first
            expect(row).to_contain_text('SR 미지원 표식')
        saved = {h['item']['kind']: h['item'] for h in self.items(f) if h['item']['kind'] in TOOLS}
        self.assertEqual({'ctr', 'parallel', 'ratio', 'centreAngle'}, set(saved))
        # Each saved value is the one the saved points make on the original, in mm.
        for kind, item in saved.items():
            tool, basis = item['baseline']['calculator'][4:].split('-v1:')
            self.assertEqual('pixel', basis)
            self.assert_values(item['baseline']['values'], line_values(tool, [pixel(w) for w in item['points']], spacing))
        self.assertEqual('ctr4', saved['ctr']['baseline']['calculator'][4:8])
        expect(p.locator('#kin-viewer-history section[data-kind=ctr]')).to_contain_text('MRD')
        p.close()
        # Reopened: drawn again and checked against the original; the ratio is edited by one point and saved as r2.
        p = self.viewer(f)
        p.wait_for_function("() => document.querySelectorAll('[data-kin-mark^=KinCTR],[data-kin-mark=KinParallelLines],[data-kin-mark=KinLengthRatio],[data-kin-mark=KinCentreLineAngle]').length === 4", timeout=45000)
        for name in ['KinCTR', 'KinParallelLines', 'KinLengthRatio', 'KinCentreLineAngle']:
            expect(p.locator(f'[data-kin-mark={name}]')).not_to_contain_text('재확인 필요')
        row = p.locator('#kin-viewer-history section[data-kind=ratio]')
        row.get_by_role('button', name='Edit', exact=True).click()
        uid = self.marks(p, 'ratio')[0]['uid']
        handle = p.locator(f'[data-kin-handle="{uid}"][data-kin-point="point:1"]')
        expect(handle).to_be_visible()
        box = handle.bounding_box(); x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
        p.mouse.move(x, y); p.mouse.down(); p.mouse.move(x + 40, y + 10, steps=6); p.mouse.up()
        row.get_by_role('button', name='Save', exact=True).click(); expect(row).to_contain_text('Saved r2')
        edited = [h['item'] for h in self.items(f) if h['item']['kind'] == 'ratio'][0]
        self.assertNotEqual(saved['ratio']['points'], edited['points'])
        self.assert_values(edited['baseline']['values'], line_values('ratio', [pixel(w) for w in edited['points']], spacing))

    def test_lines_02_volume_from_a_ct_and_an_ultrasound_frame_and_none_without_spacing(self):
        f = self.ct('LINES-' + uuid.uuid4().hex[:12], 'current', '20260801')
        _, spacing, _, pixel = self.ct_geometry(f)
        us, us_title = self.add_frame(f, 'us')
        cr, cr_title = self.add_frame(f, 'cr')
        p = self.viewer(f)
        panel = self.tool(p, 'Volume Measure', '2D Volume Measurement')
        expect(panel.get_by_label('Formula')).to_have_value('ellipsoid')
        panel.get_by_role('button', name='Measure Length').click()
        self.press(p, .3, .5); self.press(p, .65, .5)
        expect(panel.locator('[data-volume-value=Length]')).to_contain_text(' mm')
        # Height and Width on the ultrasound frame of the same study.
        self.go(p, us_title, str(us.SOPInstanceUID))
        self.press(p, .45, .3); self.press(p, .45, .65)
        self.press(p, .3, .48); self.press(p, .62, .48)
        expect(panel.locator('[data-volume-value=Volume]')).to_contain_text(' mL')
        panel.get_by_label('Volume Title').fill('Prostate volume')
        panel.get_by_role('button', name='OK', exact=True).click()
        expect(panel.locator('[data-measure-result]')).to_contain_text('Stamped: Prostate volume: ')
        panel.get_by_role('button', name='Close', exact=True).click()
        self.save_rows(p, 'volume', 1)
        item = [h['item'] for h in self.items(f) if h['item']['kind'] == 'volume'][0]
        self.assertEqual((str(us.SOPInstanceUID), 'Prostate volume'), (item['sopUid'], item['label']))
        b = item['baseline']
        self.assertEqual('kin-volume-v1:ellipsoid', b['calculator'])
        self.assertEqual(['kin-length-v1:pixel', 'kin-length-v1:us', 'kin-length-v1:us'], [s['calculator'] for s in b['sources']])
        self.assertEqual(str(us.SOPInstanceUID), b['sources'][1]['sopUid'])
        # The lengths from their originals: the CT in its PixelSpacing, the ultrasound in its region's deltas.
        ct_len = line_values('ratio', [pixel(w) for w in b['sources'][0]['points']] * 2, spacing)[0]
        us_px = lambda w: [w[1], -w[2]]
        us_len = [line_values('ratio', [us_px(w) for w in s['points']] * 2, (US_DELTA[1] * 10, US_DELTA[0] * 10))[0] for s in b['sources'][1:]]
        self.assert_values(b['values'], [ct_len, *us_len, math.pi / 6 * ct_len * us_len[0] * us_len[1] / 1000])
        p.close()
        # Reopened on the ultrasound frame: the result is drawn and its lengths are checked against their originals.
        p = self.viewer(f)
        self.go(p, us_title, str(us.SOPInstanceUID))
        layer = p.locator('[data-kin-mark=KinVolume]')
        expect(layer).to_contain_text('Prostate volume')
        expect(layer).not_to_contain_text('재확인 필요')
        expect(p.locator('[data-kin-volume-length]')).to_have_count(2)
        # A radiograph without spacing: no length for a volume; a ratio is pixel-based and saved as such.
        self.go(p, cr_title, str(cr.SOPInstanceUID))
        panel = self.tool(p, 'Volume Measure', '2D Volume Measurement')
        self.press(p, .3, .5); self.press(p, .6, .5)
        expect(panel.get_by_role('status')).to_contain_text('mm로 잴 수 없어 부피에 쓰지 않습니다')
        expect(panel.locator('[data-volume-value=Length]')).to_have_text('—')
        panel = self.tool(p, 'Length Ratio')
        for fx, fy in [(.2, .2), (.5, .2), (.2, .4), (.35, .4)]: self.press(p, fx, fy)
        expect(panel.locator('[data-measure-result]')).to_contain_text('픽셀 기준(간격 미확인)')
        panel.get_by_role('button', name='Close', exact=True).click()
        self.save_rows(p, 'ratio', 1)
        ratio = [h['item'] for h in self.items(f) if h['item']['kind'] == 'ratio'][0]
        self.assertEqual('kin-ratio-v1:px', ratio['baseline']['calculator'])
        self.assert_values(ratio['baseline']['values'], line_values('ratio', [us_px(w) for w in ratio['points']], None))

    def test_lines_03_job_with_annotations_prints_the_line_tools(self):
        f = self.ct('LINES-' + uuid.uuid4().hex[:12], 'current', '20260801')
        ds, spacing, world, _ = self.ct_geometry(f)
        us, _ = self.add_frame(f, 'us')
        rows, cols = int(ds.Rows), int(ds.Columns)
        common = dict(schemaVersion=1, seriesUid=str(ds.SeriesInstanceUID), sopUid=str(ds.SOPInstanceUID), frame=1, frameOfReferenceUid=str(ds.FrameOfReferenceUID), label='')
        at = lambda fx, fy: (cols * fx, rows * fy)
        shapes = {
            'ctr': ('ctr4', [at(.5, .15), at(.5, .85), at(.35, .5), at(.68, .55), at(.15, .6), at(.85, .6)]),
            'parallel': ('parallel', [at(.2, .2), at(.4, .2), at(.2, .3), at(.4, .3)]),
            'ratio': ('ratio', [at(.6, .2), at(.8, .2), at(.6, .3), at(.7, .3)]),
            'centreAngle': ('centreangle', [at(.2, .7), at(.4, .7), at(.2, .75), at(.4, .75), at(.55, .7), at(.75, .9), at(.6, .7), at(.8, .9)]),
        }
        items = [dict(common, kind=kind, points=[world(*q) for q in pts], baseline=dict(calculator=f'kin-{tool}-v1:pixel', values=line_values(tool, pts, spacing)))
                 for kind, (tool, pts) in shapes.items()]
        # A Volume stamped on the CT frame: its Length on the CT, Height and Width on the ultrasound frame of the study.
        us_world = lambda x, y: [0, x, -y]
        length = line_values('ratio', [at(.3, .5), at(.6, .5)] * 2, spacing)[0]
        height = math.hypot(0, 40 * US_DELTA[1] * 10); width = math.hypot(50 * US_DELTA[0] * 10, 0)
        us_source = lambda pts: dict(seriesUid=str(us.SeriesInstanceUID), sopUid=str(us.SOPInstanceUID), frame=1, frameOfReferenceUid=None,
                                     points=[us_world(*q) for q in pts], calculator='kin-length-v1:us')
        items.append(dict(common, kind='volume', label='Cyst', points=[world(*at(.45, .45))], baseline=dict(calculator='kin-volume-v1:ellipsoid',
            values=[length, height, width, math.pi / 6 * length * height * width / 1000],
            sources=[dict(seriesUid=str(ds.SeriesInstanceUID), sopUid=str(ds.SOPInstanceUID), frame=1, frameOfReferenceUid=str(ds.FrameOfReferenceUID),
                          points=[world(*at(.3, .5)), world(*at(.6, .5))], calculator='kin-length-v1:pixel'),
                     us_source([(20, 10), (20, 50)]), us_source([(10, 30), (60, 30)])])))
        for item in items:
            response = self.stack.request('POST', f'/studies/{f.uid}/viewer-items', 'doctor', dict(requestId=str(uuid.uuid4()), item=item))
            self.assertEqual(response.status, 200, response.text)
        # The server refuses values that are not the ones the points make on the original, and a length not on its original.
        wrong = dict(items[2], baseline=dict(items[2]['baseline'], values=[v * 1.01 for v in items[2]['baseline']['values']]))
        self.assertEqual(400, self.stack.request('POST', f'/studies/{f.uid}/viewer-items', 'doctor', dict(requestId=str(uuid.uuid4()), item=wrong)).status)
        bad_source = dict(items[4], baseline=dict(items[4]['baseline'], sources=[items[4]['baseline']['sources'][0], us_source([(20, 10), (20, 60)]), items[4]['baseline']['sources'][2]]))
        self.assertEqual(400, self.stack.request('POST', f'/studies/{f.uid}/viewer-items', 'doctor', dict(requestId=str(uuid.uuid4()), item=bad_source)).status)
        p = self.launch_job([f]); canvas_ready(p, 1)
        p.evaluate('''async sop => { const g = services.viewportGridService.getState(), v = services.cornerstoneViewportService.getCornerstoneViewport(g.activeViewportId);
          const index = v.getImageIds().findIndex(id => cornerstone.metaData.get('instance', id).SOPInstanceUID === sop); if (index < 0) throw Error('fixture SOP missing');
          await v.setImageIdIndex(index); v.scroll(index - v.getTargetImageIdIndex(), false); }''', str(ds.SOPInstanceUID))
        p.wait_for_function("() => document.querySelectorAll('[data-kin-mark]').length === 5", timeout=45000)
        expect(p.locator('[data-kin-mark]')).not_to_contain_text('재확인 필요')
        p.get_by_label('Job Title', exact=True).fill('Measure lines job')
        self.click_job(p, 'Save Job with Annotations', '저장된 주석 이력도 함께 고정했습니다')
        job = self.jobs(f)[0]
        frozen = self.stack.request('GET', f'/studies/{f.uid}/viewer-jobs/{job["id"]}', 'doctor')
        self.assertEqual(frozen.status, 200, frozen.text)
        self.assertEqual({'ctr', 'parallel', 'ratio', 'centreAngle', 'volume'}, {a['item']['kind'] for a in frozen.body['annotations']})
        paper = self.output(p)
        expect(paper.locator('[data-annotation-id]')).to_have_count(5)
        main = paper.locator('main')
        for words in ['CTR · ', '평행선', '길이 비', '중심선 각', '부피 · Cyst', 'MRD', 'Gap', 'Ratio', 'Angle', 'Volume']:
            expect(main).to_contain_text(words)
        self.assertEqual(paper.locator('script').count(), 0)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(MeasureLinesE2E(n) for n in loader.getTestCaseNames(MeasureLinesE2E) if n.startswith('test_lines_'))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace'); unittest.main(verbosity=2)
