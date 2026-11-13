# coding: utf-8
"""Measure menu base tools on the shipped viewer over synthetic DICOM: Circle by Diameter, Spine Label, Marking, Text
and Memo are made through the step panel, saved through the Measurements & Key Images panel, reopened, edited, frozen
into a Job with annotations and printed; an image without pixel spacing gives no mm.

Run in CI: `python tests/measurement_ci.py --profile measure-base` (validate.yml worklist-ux-measurements; the
"Focused integration" workflow runs the same profile on a branch).
"""
import io
import math
import re
import sys
import unittest
import uuid

import numpy as np
from pydicom import dcmread
from pydicom.uid import generate_uid
from playwright.sync_api import expect
from test_viewer_job_print import ViewerJobPrintE2E, canvas_ready

TOOLS = {'circle': 'KinCircleDiameter', 'text': 'KinText', 'memo': 'KinMemo', 'spine': 'KinSpineLabel'}


class MeasureBaseE2E(ViewerJobPrintE2E):
    # ── the viewer ──
    def viewer(self, f):
        p = self.launch_job([f]); canvas_ready(p, 1)
        tab = p.locator('#kin-workspace-dock nav button[aria-controls=kin-viewer-history]')
        if tab.get_attribute('aria-expanded') != 'true': tab.click()
        expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text('개 저장 항목', timeout=45000)
        return p

    def tool(self, p, name):
        menu = p.get_by_role('button', name='Measure ▾')
        menu.scroll_into_view_if_needed(); menu.click()
        p.get_by_role('menu', name='Measure').get_by_role('menuitem', name=name, exact=True).click()
        panel = p.get_by_role('dialog', name=name)
        expect(panel).to_be_visible()
        return panel

    def press(self, p, fx, fy):
        box = p.locator('.cornerstone-canvas').first.bounding_box()
        p.mouse.click(box['x'] + box['width'] * fx, box['y'] + box['height'] * fy)

    def marks(self, p, kind):
        return p.evaluate("""tool => cornerstoneTools.annotation.state.getAllAnnotations().filter(a => a.metadata.toolName === tool)
          .map(a => ({ uid: a.annotationUID, text: a.data.text, title: a.data.title, points: a.data.handles.points, baseline: a.data.kinBaseline }))""", TOOLS[kind])

    def items(self, f):
        r = self.stack.request('GET', f'/studies/{f.uid}/viewer-items?includeHidden=true', 'doctor')
        self.assertEqual(r.status, 200, r.text); return r.body['items']

    def save_rows(self, p, kind, count):
        rows = p.locator(f'#kin-viewer-history section[data-kind={kind}]')
        expect(rows).to_have_count(count)
        for i in range(count):
            row = rows.nth(i)
            if row.get_by_role('button', name='Save', exact=True).count():
                row.get_by_role('button', name='Save', exact=True).click()
            expect(row).to_contain_text('Saved r1')
        return rows

    # The frame's geometry for an image position given as fractions of its columns and rows.
    def frame(self, f):
        ds = dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/' + self.stack.first_instance_id(f.uid) + '/file')))
        origin = np.array(ds.ImagePositionPatient, dtype=float); orientation = np.array(ds.ImageOrientationPatient, dtype=float)
        spacing = np.array(ds.PixelSpacing, dtype=float)
        def world(col, row): return (origin + orientation[:3] * spacing[1] * col + orientation[3:] * spacing[0] * row).tolist()
        return ds, spacing, world

    def test_measure_01_circle_by_diameter_saves_reopens_and_moves_with_its_values(self):
        f = self.ct('MEAS-' + uuid.uuid4().hex[:12], 'current', '20260801')
        p = self.viewer(f)
        panel = self.tool(p, 'Circle by Diameter')
        expect(panel.get_by_label('Diameter mm')).to_have_value('10')
        self.press(p, .5, .5)
        expect(panel.locator('[data-measure-result]')).to_contain_text('Ø 10.0 mm · Area 78.5 mm²')
        expect(panel.locator('[data-measure-result]')).to_contain_text('Mean')
        panel.get_by_role('button', name='Close', exact=True).click()
        row = p.locator('#kin-viewer-history section[data-kind=circle]')
        expect(row).to_contain_text('Circle by Diameter · Unsaved')
        expect(row).to_contain_text('SR 미지원 표식')
        row.get_by_role('button', name='Save', exact=True).click(); expect(row).to_contain_text('Saved r1')
        head = [h for h in self.items(f) if h['item']['kind'] == 'circle'][0]['item']
        self.assertEqual(7, len(head['baseline']['values'])); self.assertEqual(10, head['baseline']['values'][0])
        self.assertRegex(head['baseline']['calculator'], r'^kin-circle-v1:pixel:(hu|value)$')
        expect(row).to_contain_text('지름 10.0 mm')
        drawn = self.marks(p, 'circle')[0]
        self.assertEqual(head['points'], drawn['points'])
        p.close()
        # Reopened: the saved circle is drawn again, checked against the original's pixels.
        p = self.viewer(f)
        p.wait_for_function("() => cornerstoneTools.annotation.state.getAllAnnotations().some(a => a.metadata.toolName === 'KinCircleDiameter')", timeout=45000)
        self.assertEqual(head['points'], self.marks(p, 'circle')[0]['points'])
        layer = p.locator('[data-kin-mark=KinCircleDiameter]')
        expect(layer.locator('polyline')).to_have_count(1)
        expect(layer).to_contain_text('Ø 10.0 mm')
        expect(layer).not_to_contain_text('재확인 필요')
        # Edit: the circle is unlocked, moved by its handle, its values computed again at the new place, and saved as r2.
        row = p.locator('#kin-viewer-history section[data-kind=circle]')
        row.get_by_role('button', name='Edit', exact=True).click()
        handle = p.locator('[data-kin-handle]').first
        expect(handle).to_be_visible()
        box = handle.bounding_box(); x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
        p.mouse.move(x, y); p.mouse.down(); p.mouse.move(x + 30, y + 20, steps=6); p.mouse.up()
        row.get_by_role('button', name='Save', exact=True).click(); expect(row).to_contain_text('Saved r2')
        moved = [h for h in self.items(f) if h['item']['kind'] == 'circle'][0]['item']
        self.assertNotEqual(head['points'], moved['points'])
        self.assertEqual(10, moved['baseline']['values'][0])

    def test_measure_02_spine_label_marking_text_and_memo_save_and_reopen(self):
        f = self.ct('MEAS-' + uuid.uuid4().hex[:12], 'current', '20260801')
        p = self.viewer(f)
        panel = self.tool(p, 'Spine Label')
        expect(panel.get_by_label('Include C8')).not_to_be_checked(); expect(panel.get_by_label('Include L6')).not_to_be_checked()
        panel.get_by_label('Start Level').select_option('L4')
        panel.get_by_label('Include L6').check()
        panel.get_by_label('Direction').select_option('Top to bottom')
        expect(panel.locator('[data-spine-preview]')).to_contain_text('[L4] L5 L6 S1')
        for fy in (.3, .45, .6):
            self.press(p, .45, fy)
        self.assertEqual(['L4', 'L5', 'L6'], [m['text'] for m in self.marks(p, 'spine')])
        panel = self.tool(p, 'Marking')
        panel.get_by_label('New marking text').fill('RLL nodule')
        panel.get_by_role('button', name='Add to List', exact=True).click()
        expect(panel.get_by_label('Marking Text List').locator('option')).to_have_text(['RLL nodule'])
        panel.get_by_label('Marking Text List').select_option('RLL nodule')
        self.press(p, .3, .5)
        panel = self.tool(p, 'Text')
        panel.locator('textarea[aria-label=Text]').fill('Rt. lower lobe')
        self.press(p, .55, .55)
        panel = self.tool(p, 'Memo')
        panel.get_by_label('Memo Title').fill('F/U'); panel.get_by_label('Memo Text').fill('Compare with prior CT')
        self.press(p, .3, .75)
        panel.get_by_role('button', name='Close', exact=True).click()
        self.save_rows(p, 'spine', 3); self.save_rows(p, 'text', 2); self.save_rows(p, 'memo', 1)
        saved = {(h['item']['kind'], h['item']['label'], h['item'].get('title')) for h in self.items(f)}
        self.assertEqual({('spine', 'L4', None), ('spine', 'L5', None), ('spine', 'L6', None), ('text', 'RLL nodule', None),
                          ('text', 'Rt. lower lobe', None), ('memo', 'Compare with prior CT', 'F/U')}, saved)
        p.close()
        p = self.viewer(f)
        p.wait_for_function("() => cornerstoneTools.annotation.state.getAllAnnotations().filter(a => a.metadata.toolName.startsWith('Kin')).length === 6", timeout=45000)
        self.assertEqual(['L4', 'L5', 'L6'], sorted(m['text'] for m in self.marks(p, 'spine')))
        self.assertEqual([('F/U', 'Compare with prior CT')], [(m['title'], m['text']) for m in self.marks(p, 'memo')])
        expect(p.locator('[data-kin-mark=KinText]')).to_have_count(2)
        expect(p.locator('[data-kin-mark=KinMemo]')).to_contain_text('F/U')
        # The Marking list is the account's: a new viewer reads it again.
        panel = self.tool(p, 'Marking')
        expect(panel.get_by_label('Marking Text List').locator('option')).to_have_text(['RLL nodule'])
        panel.get_by_role('button', name='Close', exact=True).click()
        # A text edited in the panel row is saved as r2 and drawn with its new words.
        row = p.locator('#kin-viewer-history section[data-kind=text]').filter(has_text='Rt. lower lobe')
        row.get_by_role('button', name='Edit', exact=True).click()
        row.get_by_label('Annotation Text').fill('Rt. lower lobe nodule')
        row.get_by_role('button', name='Save', exact=True).click(); expect(row).to_contain_text('Saved r2')
        expect(p.locator('[data-kin-mark=KinText]').filter(has_text='Rt. lower lobe nodule')).to_have_count(1)

    def test_measure_03_job_with_annotations_prints_the_new_marks(self):
        f = self.ct('MEAS-' + uuid.uuid4().hex[:12], 'current', '20260801')
        ds, spacing, world = self.frame(f)
        common = dict(schemaVersion=1, seriesUid=str(ds.SeriesInstanceUID), sopUid=str(ds.SOPInstanceUID), frame=1, frameOfReferenceUid=str(ds.FrameOfReferenceUID))
        rows, cols = int(ds.Rows), int(ds.Columns); cx, cy = cols // 2, rows // 2
        # A 10 mm circle at the centre pixel, its values computed from the original as the viewer computes them.
        values = ds.pixel_array.astype(float) * float(getattr(ds, 'RescaleSlope', 1)) + float(getattr(ds, 'RescaleIntercept', 0))
        r = 5.0; rx = r / spacing[1]
        inside = [values[y, x] for y in range(rows) for x in range(cols) if ((x - cx) * spacing[1]) ** 2 + ((y - cy) * spacing[0]) ** 2 <= r * r + 1e-9]
        count = len(inside); mean = sum(inside) / count; sd = math.sqrt(max(0, sum(v * v for v in inside) / count - mean * mean))
        unit = 'hu' if getattr(ds, 'RescaleType', 'HU') == 'HU' else 'value'
        items = [
            dict(common, kind='text', label='RLL nodule', points=[world(cols * .3, rows * .5)]),
            dict(common, kind='memo', label='Compare with prior CT', title='F/U', points=[world(cols * .3, rows * .7)]),
            dict(common, kind='spine', label='L4', points=[world(cols * .6, rows * .3)]),
            dict(common, kind='circle', label='', points=[world(cx, cy), world(cx + rx, cy)],
                 baseline=dict(calculator='kin-circle-v1:pixel:' + unit, values=[10, math.pi * 25, mean, sd, min(inside), max(inside), count])),
        ]
        for item in items:
            response = self.stack.request('POST', f'/studies/{f.uid}/viewer-items', 'doctor', dict(requestId=str(uuid.uuid4()), item=item))
            self.assertEqual(response.status, 200, response.text)
        # The server refuses a circle whose diameter is not the one its points make on the original.
        wrong = dict(items[3], baseline=dict(items[3]['baseline'], values=[11, math.pi * 30.25] + items[3]['baseline']['values'][2:]))
        self.assertEqual(400, self.stack.request('POST', f'/studies/{f.uid}/viewer-items', 'doctor', dict(requestId=str(uuid.uuid4()), item=wrong)).status)
        p = self.launch_job([f]); canvas_ready(p, 1)
        p.get_by_label('Job Title', exact=True).fill('Measure base job')
        self.click_job(p, 'Save Job with Annotations', '저장된 주석 이력도 함께 고정했습니다')
        job = self.jobs(f)[0]
        frozen = self.stack.request('GET', f'/studies/{f.uid}/viewer-jobs/{job["id"]}', 'doctor')
        self.assertEqual(frozen.status, 200, frozen.text)
        self.assertEqual({'text', 'memo', 'spine', 'circle'}, {a['item']['kind'] for a in frozen.body['annotations']})
        paper = self.output(p)
        legend = paper.locator('[data-annotation-id]')
        expect(legend).to_have_count(4)
        expect(paper.locator('main')).to_contain_text('글 · RLL nodule')
        expect(paper.locator('main')).to_contain_text('메모 · F/U · Compare with prior CT')
        expect(paper.locator('main')).to_contain_text('척추 레벨 · L4')
        expect(paper.locator('main')).to_contain_text('지름 원')
        expect(paper.locator('main')).to_contain_text(re.compile(r'지름 10(\.0+)? mm'))
        self.assertEqual(paper.locator('script').count(), 0)

    def test_measure_04_an_image_without_spacing_gives_no_mm_and_still_takes_a_text(self):
        f = self.ct('MEAS-' + uuid.uuid4().hex[:12], 'current', '20260801')
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
        panel = self.tool(p, 'Circle by Diameter')
        self.press(p, .5, .5)
        expect(panel.get_by_role('status')).to_have_text('이 영상에서는 mm 지름을 쓸 수 없습니다')
        self.assertEqual([], self.marks(p, 'circle'))
        panel = self.tool(p, 'Text')
        panel.locator('textarea[aria-label=Text]').fill('scar')
        self.press(p, .4, .4)
        panel.get_by_role('button', name='Close', exact=True).click()
        self.save_rows(p, 'text', 1)
        saved = [h['item'] for h in self.items(f) if h['item']['kind'] == 'text'][0]
        self.assertEqual((str(ds.SOPInstanceUID), None, 'scar'), (saved['sopUid'], saved['frameOfReferenceUid'], saved['label']))


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(MeasureBaseE2E(n) for n in loader.getTestCaseNames(MeasureBaseE2E) if n.startswith('test_measure_'))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace'); unittest.main(verbosity=2)
