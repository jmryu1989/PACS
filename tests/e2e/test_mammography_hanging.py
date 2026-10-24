"""MG follow-ups: real C-STORE, served OHIF and rendered asymmetric phantoms.

REQ-MG-01/02/04/05 -> RISK-MG-WRONG-STUDY / RISK-MG-FLIP-CLIP.
No classifier doubles or page replacement: mirrored stored pixels and their DICOM
orientation describe the same phantom. The preference provider is a public consumer.
"""
import os
import json
import time
import uuid
from pathlib import Path

import numpy as np
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid
from pynetdicom import AE

from test_worklist import WorklistE2E
from test_prior_selection import canvas_ready
from invariants_live import Fixture


class MammographyHangingE2E(WorklistE2E):
    def tearDown(self):
        try:
            for context in self.contexts:
                for page in context.pages:
                    if '/ohif/viewer' in page.url:
                        self.shot(page, self._testMethodName + '-final')
                        state = page.evaluate('''() => {
                          const s=window.services, grid=s?.viewportGridService.getState();
                          return {text:document.body.innerText,protocol:s?.hangingProtocolService.getState(),
                            sets:s?.displaySetService.getActiveDisplaySets?.().map(d=>({
                              uid:d.displaySetInstanceUID,modality:d.Modality,study:d.StudyInstanceUID,
                              images:d.images?.map(i=>({sop:i.SOPInstanceUID,side:i.ImageLaterality,view:i.ViewPosition}))})),
                            cells:grid?[...grid.viewports.values()].map(c=>{
                              const v=s.cornerstoneViewportService.getCornerstoneViewport(c.viewportId);
                              return {sets:c.displaySetInstanceUIDs,image:v?.getCurrentImageId?.(),type:v?.type,status:v?.viewportStatus};
                            }):[]};}''')
                        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', Path(__file__).parent / 'artifacts'))
                        (folder / (self._testMethodName + '.json')).write_text(json.dumps(state, default=str), encoding='utf-8')
        finally:
            super().tearDown()

    def phantom(self, patient, prior=False, uncertain=False, xa=False, dbt=False):
        uid = generate_uid()
        fixture = Fixture(uid, patient, "한림병원", "jmryu", "MG-FOLLOWUP-SYNTHETIC")
        self.stack.active[uid] = fixture
        sop_class = '1.2.840.10008.5.1.4.1.1.12.1' if xa else '1.2.840.10008.5.1.4.1.1.1.2'
        if dbt:
            sop_class = '1.2.840.10008.5.1.4.1.1.13.1.3'
        ae = AE(ae_title='HALLYM_CT')
        ae.add_requested_context(sop_class, ExplicitVRLittleEndian)
        assoc = ae.associate('127.0.0.1', 4242, ae_title='KINLAB')
        self.assertTrue(assoc.is_established)
        try:
            for index, (view, side) in enumerate([('CC', 'R')] if xa else [(v, s) for v in ['CC', 'MLO'] for s in ['R', 'L']]):
                sop = generate_uid()
                meta = FileMetaDataset()
                meta.TransferSyntaxUID = ExplicitVRLittleEndian
                meta.MediaStorageSOPClassUID, meta.MediaStorageSOPInstanceUID = sop_class, sop
                meta.ImplementationClassUID = generate_uid()
                ds = FileDataset(None, {}, file_meta=meta, preamble=b'\0' * 128)
                ds.is_little_endian, ds.is_implicit_VR = True, False
                ds.SOPClassUID, ds.SOPInstanceUID = sop_class, sop
                ds.SpecificCharacterSet = 'ISO_IR 192'
                ds.PatientID, ds.PatientName = patient, 'MGFOLLOWUP^SYNTHETIC'
                ds.PatientBirthDate, ds.PatientSex, ds.InstitutionName = '', 'O', '한림병원'
                ds.StudyInstanceUID, ds.SeriesInstanceUID = uid, generate_uid()
                ds.StudyDate = ds.SeriesDate = '20250101' if prior else '20260101'
                ds.StudyTime = ds.SeriesTime = '120000'
                ds.StudyDescription = ds.SeriesDescription = 'MG Followup Phantom'
                ds.AccessionNumber, ds.StudyID = patient[-12:], 'MGFOLLOWUP'
                ds.Modality = 'XA' if xa else 'MG'
                ds.SeriesNumber, ds.InstanceNumber = index + 1, 1
                ds.ImageType = ['ORIGINAL', 'PRIMARY']
                ds.Rows = ds.Columns = 128
                ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, 'MONOCHROME2'
                ds.BitsAllocated = ds.BitsStored = 16
                ds.HighBit, ds.PixelRepresentation = 15, 0
                ds.WindowCenter, ds.WindowWidth = 500, 1000
                ds.PixelSpacing = [1, 1]
                pixels = np.zeros((128, 128), dtype='<u2')
                pixels[15:105, 15:80] = 350
                pixels[22:42, 22:35] = 1000
                pixels[75:90, 55:70] = 700
                if xa:
                    ds.NumberOfFrames, ds.FrameTime = 12, 40
                    pixels = np.stack([np.roll(pixels, i, axis=1) for i in range(12)])
                else:
                    ds.PresentationIntentType = 'FOR PRESENTATION'
                    ds.ImageLaterality, ds.ViewPosition, ds.PartialView = side, view, 'NO'
                    code = Dataset()
                    code.CodingSchemeDesignator = 'SCT'
                    code.CodeValue = '399162004' if view == 'CC' else '399368009'
                    code.CodeMeaning = view
                    ds.ViewCodeSequence = [code]
                    # Current requires no flips. Prior L is stored flipped on both axes.
                    ds.PatientOrientation = ['P' if side == 'R' else 'A', ('L' if side == 'R' else 'R') if view == 'CC' else 'F']
                    if prior and side == 'L':
                        ds.PatientOrientation = ['P', 'L' if view == 'CC' else 'H']
                        pixels = pixels[::-1, ::-1].copy()
                    if uncertain:
                        del ds.PatientOrientation
                    if dbt:
                        # Three regular stored planes exercise on-demand DBT navigation; this
                        # small phantom makes no claim about real acquisition frame cost.
                        ds.NumberOfFrames = 3
                        ds.ImageType = ['ORIGINAL', 'PRIMARY', 'VOLUME', 'NONE']
                        ds.VolumetricProperties, ds.VolumeBasedCalculationTechnique = 'VOLUME', 'NONE'
                        ds.FrameOfReferenceUID = generate_uid()
                        directions = {'A': [0, -1, 0], 'P': [0, 1, 0], 'L': [1, 0, 0],
                                      'R': [-1, 0, 0], 'H': [0, 0, 1], 'F': [0, 0, -1]}
                        row, column = [directions[v] for v in ds.PatientOrientation]
                        shared, plane, measures = Dataset(), Dataset(), Dataset()
                        plane.ImageOrientationPatient = row + column
                        measures.PixelSpacing, measures.SliceThickness = [1, 1], 1
                        shared.PlaneOrientationSequence, shared.PixelMeasuresSequence = [plane], [measures]
                        ds.SharedFunctionalGroupsSequence = [shared]
                        ds.PerFrameFunctionalGroupsSequence = []
                        for z in range(3):
                            frame, frame_type, position = Dataset(), Dataset(), Dataset()
                            frame_type.FrameType = ds.ImageType
                            frame_type.VolumetricProperties, frame_type.VolumeBasedCalculationTechnique = 'VOLUME', 'NONE'
                            position.ImagePositionPatient = (np.cross(row, column) * z).astype(float).tolist()
                            frame.XRay3DFrameTypeSequence, frame.PlanePositionSequence = [frame_type], [position]
                            ds.PerFrameFunctionalGroupsSequence.append(frame)
                        pixels = np.stack([pixels] * 3)
                ds.PixelData = pixels.tobytes()
                self.assertEqual(assoc.send_c_store(ds).Status, 0)
        finally:
            assoc.release()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            result = self.stack.request('GET', '/studies', 'jmryu')
            if result.status == 200 and any(s.get('uid') == uid for s in result.body.get('studies', [])):
                break
            time.sleep(.25)
        else:
            self.fail('Synthetic MG did not reach the API')
        self.assertEqual(self.stack.request('PATCH', '/studies/' + uid, 'jmryu', {'ss': 'Verified'}).status, 200)
        return fixture

    def open_mg(self, page, studies, count):
        page.goto(self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + ','.join(f.uid for f in studies))
        canvas_ready(page, count)
        page.wait_for_function('n => window.services?.viewportGridService.getState().viewports.size === n', arg=count)

    def image_state(self, page):
        return page.wait_for_function('''() => {
          const rows=[...services.viewportGridService.getState().viewports.values()]
          .sort((a,b)=>a.y-b.y||a.x-b.x).map(cell=>{
            const v=services.cornerstoneViewportService.getCornerstoneViewport(cell.viewportId);
            const id=v?.getCurrentImageId?.(), canvas=v?.element.querySelector('.cornerstone-canvas');
            if(!id || !canvas?.width || !canvas.height)return {weight:0};
            const m=cornerstone.metaData.get('instance',id), c=v.getCamera(), ctx=canvas.getContext('2d');
            if(!m || !ctx)return {weight:0};
            const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
            let weight=0,x=0,y=0,max=0,bright=0,brightX=0,brightY=0;
            for(let n=0;n<pixels.length;n+=4)max=Math.max(max,pixels[n]);
            for(let j=0;j<canvas.height;j++)for(let i=0;i<canvas.width;i++){
              const p=pixels[(j*canvas.width+i)*4];weight+=p;x+=i*p;y+=j*p;
              if(p===max){bright++;brightX+=i;brightY+=j;}
            }
            return {weight,imageId:id,frameIndex:v.getCurrentImageIdIndex(),study:m.StudyInstanceUID,side:m.ImageLaterality,view:m.ViewPosition,
              flipH:!!c.flipHorizontal,flipV:!!c.flipVertical,x:x/weight/canvas.width,y:y/weight/canvas.height,
              brightX:brightX/bright/canvas.width,brightY:brightY/bright/canvas.height};
          });
          // Read readiness and pixels in one browser turn; a rehang can clear the canvas
          // between a separate readiness wait and the orientation measurement.
          return rows.length && rows.every(r=>r.weight>0) ? rows : false;
        }''', timeout=60000).json_value()

    def assert_oriented(self, page, prior, phase):
        rows = self.image_state(page)
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', Path(__file__).parent / 'artifacts'))
        folder.mkdir(parents=True, exist_ok=True)
        (folder / ('orientation-' + phase + '.json')).write_text(json.dumps(rows), encoding='utf-8')
        for row in rows:
            with self.subTest(phase=phase, study=row['study'], side=row['side'], view=row['view']):
                if phase == 'dbt-frame-2':
                    self.assertEqual(row['frameIndex'], 1, row)
                    self.assertTrue(row['imageId'].endswith('/frames/2'), row)
                expected = row['study'] == prior.uid and row['side'] == 'L'
                self.assertEqual((row['flipH'], row['flipV']), (expected, expected), row)
                # The stored phantom's brightest landmark belongs above and left of its centre.
                # This checks rendered orientation, without inventing cross-study registration.
                self.assertLess(row['brightX'], row['x'], row)
                self.assertLess(row['brightY'], row['y'], row)

    def shot(self, page, name):
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', Path(__file__).parent / 'artifacts'))
        folder.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(folder / ('MG-' + name + '.png')))

    def test_mg_current_only(self):
        current = self.phantom('MG-' + uuid.uuid4().hex[:16])
        page = self.login()
        self.open_mg(page, [current], 4)
        self.assertEqual(page.evaluate('kinMammographyHanging.get().layout'), 'current')
        self.assertTrue(all(s['study'] == current.uid for s in self.image_state(page)))
        self.shot(page, 'current-only')
        # A saved comparison preference cannot shrink a study with no comparison target.
        self.assertTrue(page.evaluate("kinMammographyHanging.set({layout:'compare',kind:null})"))
        canvas_ready(page, 4)
        self.assertEqual(page.evaluate('kinMammographyHanging.get().layout'), 'current')

    def test_mg_orientation_and_xa(self):
        patient = 'MG-' + uuid.uuid4().hex[:16]
        current, prior = self.phantom(patient), self.phantom(patient, prior=True)
        dbt_current, dbt_prior = self.phantom(patient, dbt=True), self.phantom(patient, prior=True, dbt=True)
        xa = self.phantom('XA-' + uuid.uuid4().hex[:16], xa=True)
        page = self.login()
        self.open_mg(page, [current, prior], 8)
        self.assertEqual(page.evaluate('kinMammographyHanging.get().layout'), 'compare')
        self.assert_oriented(page, prior, 'conventional-initial')
        self.shot(page, 'compare-orientation')
        for layout, count in [('current', 4), ('compare', 8)]:
            self.assertTrue(page.evaluate('(layout)=>kinMammographyHanging.set({layout,kind:null})', layout))
            canvas_ready(page, count)
            self.assert_oriented(page, prior, 'rehang-' + layout)
        self.open_mg(page, [dbt_current, dbt_prior], 8)
        self.assertEqual(page.locator('.kin-mg-slot').filter(has_text='DBT').count(), 8)
        self.assert_oriented(page, dbt_prior, 'dbt-initial')
        page.evaluate('''async () => {
          const cells=[...services.viewportGridService.getState().viewports.values()];
          await Promise.all(cells.map(c=>services.cornerstoneViewportService.getCornerstoneViewport(c.viewportId).setImageIdIndex(1)));
        }''')
        canvas_ready(page, 8)
        self.assert_oriented(page, dbt_prior, 'dbt-frame-2')
        self.shot(page, 'dbt-before-xa')
        self.open_mg(page, [xa], 1)
        self.assertEqual(self.image_state(page)[0]['study'], xa.uid)
        self.shot(page, 'xa-after-mg')
        print('XA_AFTER_DBT_RENDERED ' + xa.uid, flush=True)

    def test_mg_mount_provider_and_unverified(self):
        patient = 'MG-' + uuid.uuid4().hex[:16]
        current, prior = self.phantom(patient, uncertain=True), self.phantom(patient, prior=True)
        page = self.login()
        # Register as soon as the public extension hook is published, before real mode entry.
        # Only the provider is supplied; the actual extension and mount execute unmodified.
        page.add_init_script('''Object.defineProperty(window,'kinMammographyHanging',{
          configurable:true,get(){return this.mgHook},set(value){this.mgHook=value;
            value.registerPreferenceProvider?.(context=>{window.mgMountContext=context;
              return {layout:window.mgInitialLayout || 'current',kind:null};});}});''')
        self.open_mg(page, [current, prior], 4)
        self.assertEqual(page.evaluate('mgMountContext.studyInstanceUIDs'), [current.uid, prior.uid])
        state = self.image_state(page)
        self.assertTrue(all(not r['flipH'] and not r['flipV'] for r in state))
        self.assertEqual(page.get_by_text('Orientation Unverified', exact=False).count(), 4)
        self.shot(page, 'provider-unverified')
        self.assertFalse(page.evaluate("kinMammographyHanging.set({layout:'bad',kind:null})"))
        self.assertTrue(page.evaluate("kinMammographyHanging.set({layout:'compare',kind:null})"))
        canvas_ready(page, 8)
        self.assertEqual(page.evaluate('kinMammographyHanging.get().layout'), 'compare')
        page.add_init_script("window.mgInitialLayout = 'compare';")
        self.open_mg(page, [current, prior], 8)
        self.assertEqual(page.evaluate('mgMountContext.studyInstanceUIDs'), [current.uid, prior.uid])
        self.assertEqual(page.evaluate('kinMammographyHanging.get().layout'), 'compare')
