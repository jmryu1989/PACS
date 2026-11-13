# coding: utf-8
"""MG menu on the served viewer with synthetic mammograms stored over C-STORE (test_mammography_hanging.py's phantoms:
current needs no flips, prior L is stored flipped on both axes): Mirrored point on eight cells (the same view only, in
image coordinates through each image's stored orientation), Quadrant Zoom Next ×3, a synthetic five-frame DBT where Step
Interval, Slab Thickness (pixel values in the cell and on its canvas, and back) and Play run on the real stack, and
Mammo Keypad Patient ▶ between two patient tabs with a linked reading screen holding unconfirmed text."""
import json, os, time, unittest, uuid
import numpy as np
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid
from pynetdicom import AE
from playwright.sync_api import expect
from test_viewer_ux_priors import ViewerUXPriorsE2E
from test_mammography_hanging import MammographyHangingE2E as MG
from test_prior_selection import canvas_ready
from invariants_live import Fixture

# Per-cell state read from the viewer: identity from the image's metadata, the zoom and the focal point in image indices.
CELLS = '''() => [...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).map(g=>{
  const v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId), id=v?.getCurrentImageId?.();
  if(!id) return null;
  const m=cornerstone.metaData.get('instance',id), d=v.getImageData().imageData, i=d.worldToIndex([...v.getCamera().focalPoint], new Float64Array(3));
  return {id:g.viewportId, study:m.StudyInstanceUID, side:m.ImageLaterality, view:m.ViewPosition, zoom:v.getZoom(), x:i[0], y:i[1],
    index:v.getCurrentImageIdIndex(), count:v.getImageIds().length};
})'''


class ViewerMgE2E(ViewerUXPriorsE2E):
    def mg(self, page, label):
        page.get_by_role('button', name='MG ▾', exact=True).click()
        page.get_by_role('menu', name='MG').get_by_role('menuitem', name=label, exact=True).click()

    def cells(self, page):
        return [c for c in page.evaluate(CELLS) if c]

    def cell(self, page, study, side, view):
        return next(c for c in self.cells(page) if c['study'] == study and c['side'] == side and c['view'] == view)

    def artifacts(self):
        from pathlib import Path
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', Path(__file__).parent / 'artifacts')); folder.mkdir(parents=True, exist_ok=True)
        return folder

    # Four DBT objects (R/L × CC/MLO) of five frames; tissue in frame z is 200 + 150·z² so a slab mean differs from every frame.
    def dbt(self, patient):
        uid = generate_uid()
        fixture = Fixture(uid, patient, "한림병원", "jmryu", "MG-DBT-SYNTHETIC")
        self.stack.active[uid] = fixture
        sop_class = '1.2.840.10008.5.1.4.1.1.13.1.3'
        ae = AE(ae_title='HALLYM_CT'); ae.add_requested_context(sop_class, ExplicitVRLittleEndian)
        assoc = ae.associate('127.0.0.1', int(os.environ.get('KIN_TEST_DICOM_PORT', '4242')), ae_title='KINLAB')
        self.assertTrue(assoc.is_established)
        frame_of_reference = generate_uid()
        try:
            for index, (view, side) in enumerate([(v, s) for v in ['CC', 'MLO'] for s in ['R', 'L']]):
                sop = generate_uid(); meta = FileMetaDataset()
                meta.TransferSyntaxUID = ExplicitVRLittleEndian
                meta.MediaStorageSOPClassUID, meta.MediaStorageSOPInstanceUID = sop_class, sop
                meta.ImplementationClassUID = generate_uid()
                ds = FileDataset(None, {}, file_meta=meta, preamble=b'\0' * 128)
                ds.is_little_endian, ds.is_implicit_VR = True, False
                ds.SOPClassUID, ds.SOPInstanceUID = sop_class, sop
                ds.SpecificCharacterSet = 'ISO_IR 192'
                ds.PatientID, ds.PatientName = patient, 'MGDBT^SYNTHETIC'
                ds.PatientBirthDate, ds.PatientSex, ds.InstitutionName = '', 'O', '한림병원'
                ds.StudyInstanceUID, ds.SeriesInstanceUID = uid, generate_uid()
                ds.StudyDate = ds.SeriesDate = '20260101'; ds.StudyTime = ds.SeriesTime = '120000'
                ds.StudyDescription = ds.SeriesDescription = 'MG DBT Phantom'
                ds.AccessionNumber, ds.StudyID = patient[-12:], 'MGDBT'
                ds.Modality, ds.SeriesNumber, ds.InstanceNumber = 'MG', index + 1, 1
                ds.Rows = ds.Columns = 128
                ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, 'MONOCHROME2'
                ds.BitsAllocated = ds.BitsStored = 16; ds.HighBit, ds.PixelRepresentation = 15, 0
                ds.WindowCenter, ds.WindowWidth = 1000, 2000
                ds.PresentationIntentType = 'FOR PRESENTATION'
                ds.ImageLaterality, ds.ViewPosition, ds.PartialView = side, view, 'NO'
                code = Dataset(); code.CodingSchemeDesignator = 'SCT'
                code.CodeValue = '399162004' if view == 'CC' else '399368009'; code.CodeMeaning = view
                ds.ViewCodeSequence = [code]
                ds.PatientOrientation = ['P' if side == 'R' else 'A', ('L' if side == 'R' else 'R') if view == 'CC' else 'F']
                ds.NumberOfFrames = 5
                ds.ImageType = ['ORIGINAL', 'PRIMARY', 'VOLUME', 'NONE']
                ds.VolumetricProperties, ds.VolumeBasedCalculationTechnique = 'VOLUME', 'NONE'
                ds.FrameOfReferenceUID = frame_of_reference
                directions = {'A': [0, -1, 0], 'P': [0, 1, 0], 'L': [1, 0, 0], 'R': [-1, 0, 0], 'H': [0, 0, 1], 'F': [0, 0, -1]}
                row, column = [directions[v] for v in ds.PatientOrientation]
                shared, plane, measures = Dataset(), Dataset(), Dataset()
                plane.ImageOrientationPatient = row + column
                measures.PixelSpacing, measures.SliceThickness = [1, 1], 1
                shared.PlaneOrientationSequence, shared.PixelMeasuresSequence = [plane], [measures]
                ds.SharedFunctionalGroupsSequence = [shared]; ds.PerFrameFunctionalGroupsSequence = []
                for z in range(5):
                    frame, frame_type, position = Dataset(), Dataset(), Dataset()
                    frame_type.FrameType = ds.ImageType
                    frame_type.VolumetricProperties, frame_type.VolumeBasedCalculationTechnique = 'VOLUME', 'NONE'
                    position.ImagePositionPatient = (np.cross(row, column) * z).astype(float).tolist()
                    frame.XRay3DFrameTypeSequence, frame.PlanePositionSequence = [frame_type], [position]
                    ds.PerFrameFunctionalGroupsSequence.append(frame)
                frames = []
                for z in range(5):
                    pixels = np.zeros((128, 128), dtype='<u2'); pixels[15:105, 15:80] = 200 + 150 * z * z
                    frames.append(pixels)
                ds.PixelData = np.stack(frames).tobytes()
                self.assertEqual(assoc.send_c_store(ds).Status, 0)
        finally:
            assoc.release()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            result = self.stack.request('GET', '/studies', 'jmryu')
            if result.status == 200 and any(s.get('uid') == uid for s in result.body.get('studies', [])): break
            time.sleep(.25)
        else:
            self.fail('Synthetic DBT did not reach the API')
        self.assertEqual(self.stack.request('PATCH', '/studies/' + uid, 'jmryu', {'ss': 'Verified'}).status, 200)
        return fixture

    def test_mg_01_mirrored_point_and_quadrant_zoom_on_eight_cells(self):
        patient = 'MGM-' + uuid.uuid4().hex[:12]
        current = MG.phantom(self, patient); prior = MG.phantom(self, patient, prior=True)
        page = self.login()
        MG.open_mg(self, page, [current, prior], 8)
        MG.image_state(self, page)
        before = {(c['study'], c['side'], c['view']): c for c in self.cells(page)}
        self.mg(page, 'Mirrored')
        expect(page.get_by_role('dialog', name='Mirrored')).to_be_visible()
        source = before[(current.uid, 'R', 'CC')]
        box = page.locator('[data-viewport-uid="' + source['id'] + '"]').bounding_box()
        page.mouse.click(box['x'] + box['width'] * 0.35, box['y'] + box['height'] * 0.4)
        page.wait_for_function('''id=>Math.abs(services.cornerstoneViewportService.getCornerstoneViewport(id).getZoom()-2)<1e-6''', arg=before[(prior.uid, 'L', 'CC')]['id'], timeout=15000)
        after = {(c['study'], c['side'], c['view']): c for c in self.cells(page)}
        (folder := self.artifacts()).joinpath('MG-mirrored.json').write_text(json.dumps({'before': list(before.values()), 'after': list(after.values())}), encoding='utf-8')
        page.screenshot(path=str(folder / 'MG-mirrored.png'))
        rcc = after[(current.uid, 'R', 'CC')]; x, y = rcc['x'], rcc['y']
        # Every CC cell at twice its Fit; the same place in image coordinates: mirrored across for the left breast, and
        # through the prior L's stored flips (both axes). 128 × 128 phantoms.
        for key, expected in (((current.uid, 'L', 'CC'), (127 - x, y)), ((prior.uid, 'R', 'CC'), (x, y)), ((prior.uid, 'L', 'CC'), (x, 127 - y))):
            with self.subTest(cell=key):
                self.assertAlmostEqual(after[key]['zoom'], 2, places=4)
                self.assertAlmostEqual(after[key]['x'], expected[0], delta=0.01)
                self.assertAlmostEqual(after[key]['y'], expected[1], delta=0.01)
        for key in [k for k in after if k[2] == 'MLO']:
            self.assertAlmostEqual(after[key]['zoom'], before[key]['zoom'], places=4)
        page.get_by_role('dialog', name='Mirrored').get_by_role('button', name='Close').click()
        # Quadrant Zoom: the chest-wall upper quarter first (R chest wall right, L left), then Next ×3.
        self.mg(page, 'Quadrant Zoom')
        panel = page.get_by_role('dialog', name='Quadrant Zoom')
        expect(panel.locator('b')).to_have_text('Quadrant 1/4: Upper-Outer (R/L matched)')
        page.wait_for_function('''id=>services.cornerstoneViewportService.getCornerstoneViewport(id).getZoom()>2.5''', arg=source['id'], timeout=15000)
        q = {(c['study'], c['side'], c['view']): c for c in self.cells(page)}
        # The phantom's breast box is columns 15 … 80, rows 15 … 105 (pixel edges): its centre column 47.5.
        self.assertGreater(q[(current.uid, 'R', 'CC')]['x'], 47.5); self.assertLess(q[(current.uid, 'L', 'CC')]['x'], 47.5)
        self.assertLess(q[(current.uid, 'R', 'CC')]['y'], 60); self.assertLess(q[(current.uid, 'L', 'CC')]['y'], 60)
        heads = []
        for _ in range(3):
            panel.get_by_role('button', name='Next Quadrant').click(); heads.append(panel.locator('b').text_content())
        self.assertEqual(['Quadrant 2/4: Upper-Inner (R/L matched)', 'Quadrant 3/4: Lower-Inner (R/L matched)', 'Quadrant 4/4: Lower-Outer (R/L matched)'], heads)
        page.screenshot(path=str(folder / 'MG-quadrant-4.png'))
        panel.get_by_role('button', name='Close').click()
        page.wait_for_function('''id=>Math.abs(services.cornerstoneViewportService.getCornerstoneViewport(id).getZoom()-1)<1e-6''', arg=source['id'], timeout=15000)

    def test_mg_02_dbt_step_interval_slab_pixels_and_play(self):
        f = self.dbt('MGD-' + uuid.uuid4().hex[:12])
        page = self.login()
        MG.open_mg(self, page, [f], 4)
        page.wait_for_function('''()=>[...services.viewportGridService.getState().viewports.values()].some(g=>services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId)?.getImageIds?.().length===5)''', timeout=60000)
        rcc = next(c for c in self.cells(page) if c['side'] == 'R' and c['view'] == 'CC')
        page.evaluate('id=>services.viewportGridService.setActiveViewportId(id)', rcc['id'])
        page.wait_for_function('id=>services.viewportGridService.getActiveViewportId()===id', arg=rcc['id'])
        self.mg(page, 'Tomo (DBT) Slices')
        panel = page.get_by_role('dialog', name='Tomo (DBT) Slices')
        expect(panel.locator('b')).to_have_text('Slice 1 / 5')
        panel.get_by_label('Step Interval').select_option('2')
        panel.get_by_role('button', name='Next ▶').click()
        expect(panel.locator('b')).to_have_text('Slice 3 / 5', timeout=15000)
        self.assertEqual(2, self.cell(page, f.uid, 'R', 'CC')['index'])
        # The value of a tissue pixel (column 40, row 60) in the cell's data and the grey drawn on its canvas there.
        probe = '''id=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id), d=v.getImageData().imageData;
          const value=d.getPointData().getScalars().getData()[60*128+40];
          const p=v.worldToCanvas(Array.from(d.indexToWorld([40,60,0], new Float64Array(3)))), c=v.canvas, r=c.width/c.clientWidth;
          const gray=c.getContext('2d').getImageData(Math.round(p[0]*r),Math.round(p[1]*r),1,1).data[0];
          return {value, gray};}'''
        page.wait_for_timeout(500)
        alone = page.evaluate(probe, rcc['id'])
        self.assertEqual(800, alone['value'])
        panel.get_by_label('Slab Thickness').select_option('3')
        badge = page.locator('[data-mg-badge=slab]')
        expect(badge).to_have_text('Slab 3', timeout=15000)
        page.wait_for_timeout(500)
        slab = page.evaluate(probe, rcc['id'])
        page.screenshot(path=str(self.artifacts() / 'MG-dbt-slab-3.png'))
        # Frames 1, 2, 3: (350 + 800 + 1550) / 3 = 900 in the data, and drawn brighter than frame 2's 800 (window 0 … 2000).
        self.assertAlmostEqual(900, slab['value'], delta=0.5)
        self.assertGreaterEqual(slab['gray'] - alone['gray'], 6, (alone, slab))
        panel.get_by_label('Slab Thickness').select_option('1')
        expect(badge).to_have_count(0)
        page.wait_for_timeout(500)
        back = page.evaluate(probe, rcc['id'])
        self.assertEqual(800, back['value'])
        self.assertLessEqual(abs(back['gray'] - alone['gray']), 1, (alone, back))
        panel.get_by_role('button', name='Play').click()
        page.wait_for_function('id=>services.cornerstoneViewportService.getCornerstoneViewport(id).getCurrentImageIdIndex()!==2', arg=rcc['id'], timeout=15000)
        panel.get_by_role('button', name='Stop').click()
        page.wait_for_timeout(300)
        at = self.cell(page, f.uid, 'R', 'CC')['index']; page.wait_for_timeout(600)
        self.assertEqual(at, self.cell(page, f.uid, 'R', 'CC')['index'])
        panel.get_by_role('button', name='Close').click()

    def test_mg_03_keypad_patient_move_takes_images_and_report_target_together(self):
        a = MG.phantom(self, 'MGKA-' + uuid.uuid4().hex[:12]); b = MG.phantom(self, 'MGKB-' + uuid.uuid4().hex[:12])
        work = self.login()
        self.select(work, a)
        with work.context.expect_page() as opened:
            work.locator('#m-filmbox').click()
        page = opened.value
        page.on('dialog', lambda dialog: dialog.accept())
        canvas_ready(page, 4)
        self.select(work, b)
        work.locator('#m-filmbox').click()
        tabs = page.get_by_role('tablist', name='Patients')
        expect(tabs.get_by_role('tab')).to_have_count(2, timeout=45000)
        tabs.get_by_role('tab').filter(has_text=a.patient_id).click()
        expect(tabs.get_by_role('tab').filter(has_text=a.patient_id)).to_have_attribute('aria-selected', 'true', timeout=45000)
        canvas_ready(page, 4)
        # The reading screen on A with text its server has not confirmed (its draft writes are refused for now).
        self.select(work, a)
        work.route('**/studies/' + a.uid + '/draft*', lambda route: route.fulfill(status=503, json={'message': 'Synthetic draft outage'}))
        work.locator('#findings').fill('MG KEYPAD A DRAFT')
        work.wait_for_timeout(2500)
        self.mg(page, 'Mammo Keypad')
        panel = page.get_by_role('dialog', name='Mammo Keypad')
        expect(panel.locator('ol li').first).to_contain_text('← images · report target')
        panel.get_by_role('button', name='Patient ▶').click()
        question = panel.get_by_role('alertdialog')
        expect(question.get_by_role('button')).to_have_text(['Save Draft & Move', 'Discard & Move', 'Cancel'], timeout=15000)
        question.get_by_role('button', name='Cancel').click()
        expect(tabs.get_by_role('tab').filter(has_text=a.patient_id)).to_have_attribute('aria-selected', 'true')
        work.unroute('**/studies/' + a.uid + '/draft*')
        panel.get_by_role('button', name='Patient ▶').click()
        panel.get_by_role('alertdialog').get_by_role('button', name='Save Draft & Move').click()
        tabs = page.get_by_role('tablist', name='Patients')
        expect(tabs.get_by_role('tab').filter(has_text=b.patient_id)).to_have_attribute('aria-selected', 'true', timeout=45000)
        panel = page.get_by_role('dialog', name='Mammo Keypad')
        expect(panel.locator('[role=status]')).to_contain_text('영상과 판독 대상으로 옮겼습니다', timeout=30000)
        page.screenshot(path=str(self.artifacts() / 'MG-keypad-moved.png'))
        # Images, tab and the reading screen's target are all B; A's text was saved as its draft before the move.
        page.wait_for_function('uid=>[...services.viewportGridService.getState().viewports.keys()].every(id=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(id),i=v?.getCurrentImageId?.();return !i||cornerstone.metaData.get("instance",i)?.StudyInstanceUID===uid})', arg=b.uid, timeout=45000)
        work.wait_for_function('uid=>document.querySelector("#rows tr.sel")?.dataset.uid===uid', arg=b.uid, timeout=15000, polling=100)
        draft = self.stack.request('GET', '/studies/' + a.uid + '/draft', 'doctor')
        self.assertEqual(200, draft.status, draft.text)
        self.assertIn('MG KEYPAD A DRAFT', json.dumps(draft.body, ensure_ascii=False))


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ViewerMgE2E(n) for n in loader.getTestCaseNames(ViewerMgE2E) if n.startswith('test_mg_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
