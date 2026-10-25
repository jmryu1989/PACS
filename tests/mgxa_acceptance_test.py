"""Acceptance tooling boundaries; generated test files are never clinical evidence.

D73: exercise file selection and displayed-image identities, not product source strings.
"""
import json
from pathlib import Path
import sys
import tempfile
import unittest

from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, XRayAngiographicImageStorage, generate_uid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from mgxa_acceptance import inventory, selected_files, provenance, digest, local_use_policy, use_limits
from mgxa_viewer_check import (check_images, comparison_pairs, mg_projection, check_projection_pair,
    original_display, display_observations, check_identity_preserved, check_cine_order, aggregate_status, same_origin)
from mgxa_fixture import fixture_compose, fixture_realm
from ci_select import select


class AcceptancePrep(unittest.TestCase):
    def fixture(self, root, modality='XA', frames=1):
        folder = root / 'tcia-test' / 'studies' / 'fixture'
        folder.mkdir(parents=True)
        meta = FileMetaDataset()
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        meta.MediaStorageSOPClassUID = XRayAngiographicImageStorage
        meta.MediaStorageSOPInstanceUID = generate_uid()
        ds = FileDataset(None, {}, file_meta=meta, preamble=b'\0'*128)
        ds.is_little_endian, ds.is_implicit_VR = True, False
        ds.SOPClassUID, ds.SOPInstanceUID = meta.MediaStorageSOPClassUID, meta.MediaStorageSOPInstanceUID
        ds.StudyInstanceUID, ds.SeriesInstanceUID = generate_uid(), generate_uid()
        ds.PatientID, ds.Modality, ds.NumberOfFrames = 'GENERATED-TEST', modality, frames
        ds.Rows, ds.Columns, ds.BitsAllocated = 1, 1, 8
        ds.PixelData = b'\0' * (frames + frames % 2)
        path = folder/'image.dcm'
        ds.save_as(path, write_like_original=False)
        (root/'tcia-test'/'manifest.json').write_text(json.dumps({'studies':[
            {'folder':'studies/fixture','source':'TCIA','collection':'GENERATED TEST ONLY'}]}))
        return ds, path

    def test_inventory_keeps_rf_separate_and_ignores_archive_duplicate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ds, path = self.fixture(root, modality='RF', frames=3)
            raw = root/'tcia-test'/'raw'
            raw.mkdir()
            (raw/'duplicate.dcm').write_bytes(path.read_bytes())
            body = inventory(root)
            self.assertEqual(len(body['files']), 1)
            self.assertFalse(body['xa_cine_available'])
            self.assertEqual(body['groups'][0]['frames'], 3)
            self.assertEqual(body['parse_errors'], [])

    def test_selection_requires_unchanged_original_and_known_study(self):
        with tempfile.TemporaryDirectory() as tmp:
            ds, path = self.fixture(Path(tmp))
            body = inventory(tmp)
            self.assertEqual(len(selected_files(body, [str(ds.StudyInstanceUID)])), 1)
            self.assertEqual(len(selected_files(body, [str(ds.StudyInstanceUID)], [str(ds.SOPInstanceUID)])), 1)
            with self.assertRaisesRegex(ValueError, 'SOP'):
                selected_files(body, [str(ds.StudyInstanceUID)], ['2.25.999'])
            with self.assertRaises(ValueError):
                selected_files(body, ['2.25.999'])
            path.write_bytes(path.read_bytes() + b'changed')
            with self.assertRaisesRegex(ValueError, 'changed'):
                selected_files(body, [str(ds.StudyInstanceUID)])

    def test_unregistered_source_is_not_loaded(self):
        with tempfile.TemporaryDirectory() as tmp:
            ds, path = self.fixture(Path(tmp))
            (Path(tmp)/'tcia-test'/'manifest.json').write_text('{"studies":[]}')
            body = inventory(tmp)
            with self.assertRaisesRegex(ValueError, 'public sample'):
                selected_files(body, [str(ds.StudyInstanceUID)])

    def test_declared_public_repository_cine_is_selectable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ds, path = self.fixture(root, frames=12)
            (root/'tcia-test'/'manifest.json').write_text(json.dumps({'studies':[
                {'folder':'studies/fixture','source':'GDCMData','public_sample':True,
                 'source_url':'https://example.invalid/public-test.dcm','licence':'fixture'}]}))
            body = inventory(tmp)
            self.assertTrue(body['xa_cine_available'])
            selected = selected_files(body, [str(ds.StudyInstanceUID)])
            self.assertEqual(selected[0]['frames'],12)
            self.assertEqual(selected[0]['licence'],'fixture')

    def test_valid_dataset_without_part10_preamble_is_inventoried(self):
        with tempfile.TemporaryDirectory() as tmp:
            ds, path = self.fixture(Path(tmp))
            path.write_bytes(path.read_bytes()[132:])
            body = inventory(tmp)
            self.assertEqual(body['parse_errors'], [])
            self.assertEqual(body['files'][0]['sop'], str(ds.SOPInstanceUID))

    def test_render_requires_selected_identity_frame_pixels_and_both_dates(self):
        row = {'study':'1','series':'2','sop':'3','frames':2}
        cell = {'image':'wadors:https://localhost/dicom-web/studies/1/series/2/instances/3/frames/2',
                'width':512,'height':512,'min':0,'max':254}
        check_images([cell], [row], ['1'])
        for bad in (dict(cell, image=cell['image'][:-1]+'3'), dict(cell, max=0)):
            with self.assertRaises(AssertionError):
                check_images([bad], [row], ['1'])
        with self.assertRaisesRegex(AssertionError, 'both displayed'):
            check_images([cell], [row], ['1','4'])

    def test_comparison_pairs_both_breasts_without_cross_pairing(self):
        cells = [{'image':f'wadors:/studies/{study}/series/2/instances/{x+1}/frames/1',
                  'x':x, 'y':y} for y in (0,1) for x,study in enumerate(('1','1','4','4'))]
        pairs = comparison_pairs(list(reversed(cells)), ['1','4'])
        self.assertEqual([(a['x'],b['x'],a['y'],b['y']) for a,b in pairs],
                         [(0,2,0,0),(1,3,0,0),(0,2,1,1),(1,3,1,1)])
        with self.assertRaisesRegex(AssertionError, 'missing counterpart'):
            comparison_pairs(cells[:-1], ['1','4'])

    def test_original_representation_and_pairing(self):
        with tempfile.TemporaryDirectory() as tmp:
            ds, path = self.fixture(Path(tmp), modality='MG', frames=4)
            ds.ImageType = ['DERIVED', 'PRIMARY', 'VOLUME', 'NONE']
            ds.ImageLaterality, ds.ViewPosition = 'L', 'CC'
            ds.save_as(path, write_like_original=False)
            a = mg_projection({'path': str(path)}, tmp)
            self.assertEqual(a['kind'], 'dbt')
            check_projection_pair(a, dict(a))
            for change in ({'laterality': ['R']}, {'view_position': ['MLO']}, {'kind': 'generated2d'},
                           {'kind': 'conventional'}, {'kind': 'unverified'}):
                with self.subTest(change=change), self.assertRaises(AssertionError):
                    check_projection_pair(a, dict(a, **change))
            ds.NumberOfFrames = 1
            ds.ImageType = ['DERIVED', 'PRIMARY', 'TOMOSYNTHESIS', 'GENERATED_2D']
            generated = path.with_name('generated.dcm')
            ds.save_as(generated, write_like_original=False)
            self.assertEqual(mg_projection({'path': str(generated)}, tmp)['kind'], 'generated2d')

    def test_enhanced_original_geometry_and_voi_detect_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            ds, path = self.fixture(Path(tmp), modality='MG', frames=2)
            shared, voi = Dataset(), Dataset()
            voi.WindowCenter, voi.WindowWidth = [512,460,570], [800,680,980]
            shared.FrameVOILUTSequence = [voi]
            orientation = Dataset()
            orientation.ImageOrientationPatient = [1,0,0,0,1,0]
            shared.PlaneOrientationSequence = [orientation]
            ds.SharedFunctionalGroupsSequence = [shared]
            ds.PerFrameFunctionalGroupsSequence = []
            for frame, spacing in enumerate(([.064867,.086917], [.1,.2])):
                group, measures, position = Dataset(), Dataset(), Dataset()
                measures.PixelSpacing = spacing
                group.PixelMeasuresSequence = [measures]
                position.ImagePositionPatient = [0,0,-frame]
                group.PlanePositionSequence = [position]
                ds.PerFrameFunctionalGroupsSequence.append(group)
            ds.save_as(path, write_like_original=False)
            self.assertEqual(original_display(ds, 2)['spacing_xy'], [.2,.1])
            row = {'study':str(ds.StudyInstanceUID),'series':str(ds.SeriesInstanceUID),'sop':str(ds.SOPInstanceUID),
                   'modality':'MG','path':str(path)}
            cell = {'image':f"wadors:/studies/{row['study']}/series/{row['series']}/instances/{row['sop']}/frames/1",
                    'spacing':[.086917,.064867,1], 'windowLevel':{'windowCenter':512,'windowWidth':800},
                    'imagePlane':{'rowCosines':[1,0,0], 'columnCosines':[0,1,0], 'imagePositionPatient':[0,0,0]},
                    'camera':{'viewPlaneNormal':[0,0,1], 'focalPoint':[200,300,0]}}
            self.assertEqual(display_observations([cell],[row],tmp)[0]['status'], 'PASS')
            checks = display_observations([dict(cell, spacing=[1,1,1], windowLevel={'windowCenter':512,'windowWidth':1023})],[row],tmp)
            self.assertEqual(checks[0]['status'], 'FAIL')
            self.assertEqual(checks[0]['classification'], 'PRODUCT_OBSERVATION')
            self.assertEqual(len(checks[0]['failures']), 2)
            # Correct pixels/spacing/VOI with the last frame's geometry was the
            # real false PASS. Check camera and metadata independently.
            for bad in (dict(cell, camera={'viewPlaneNormal':[0,0,1], 'focalPoint':[200,300,-1]}),
                        dict(cell, imagePlane=dict(cell['imagePlane'], imagePositionPatient=[0,0,-1])),
                        dict(cell, imagePlane=dict(cell['imagePlane'], rowCosines=[0,1,0]))):
                check = display_observations([bad],[row],tmp)[0]
                self.assertEqual(check['status'], 'FAIL')
                self.assertEqual(check['classification'], 'PRODUCT_OBSERVATION')
            missing = display_observations([dict(cell, imagePlane=None)],[row],tmp)[0]
            self.assertEqual(missing['status'], 'NOT_RUN')

    def test_frame_geometry_uses_requested_per_frame_plane_and_nearest_position(self):
        with tempfile.TemporaryDirectory() as tmp:
            ds, path = self.fixture(Path(tmp), modality='MG', frames=2)
            ds.PixelSpacing, ds.WindowCenter, ds.WindowWidth = [1,1], 512, 800
            ds.ImageOrientationPatient, ds.ImagePositionPatient = [1,0,0,0,1,0], [0,0,0]
            ds.PerFrameFunctionalGroupsSequence = [Dataset(), Dataset()]
            orientation, position = Dataset(), Dataset()
            orientation.ImageOrientationPatient = [0,1,0,.6,0,-.8]
            position.ImagePositionPatient = [-.8,0,-.6]
            ds.PerFrameFunctionalGroupsSequence[1].PlaneOrientationSequence = [orientation]
            ds.PerFrameFunctionalGroupsSequence[1].PlanePositionSequence = [position]
            ds.save_as(path, write_like_original=False)
            row = {'sop':str(ds.SOPInstanceUID),'modality':'MG','path':str(path)}
            cell = {'image':f"wadors:/studies/1/series/2/instances/{row['sop']}/frames/2",
                    'spacing':[1,1], 'windowLevel':{'windowCenter':512,'windowWidth':800},
                    'imagePlane':{'rowCosines':[0,1,0], 'columnCosines':[.6,0,-.8], 'imagePositionPatient':[-.8,0,-.6]},
                    'camera':{'viewPlaneNormal':[.8,0,.6], 'focalPoint':[-.2,20,-1.4]}}
            check = display_observations([cell],[row],tmp)[0]
            self.assertEqual(check['status'], 'PASS')
            self.assertEqual(check['expected']['orientation'], [0,1,0,.6,0,-.8])
            for observed in check['geometry']['position_checks']:
                self.assertEqual(observed['nearest_stored_frames'], [2])
            # A midpoint is ambiguous, not a verified frame position.
            tied = dict(cell, camera={'focalPoint':[-.4,0,-.3]})
            self.assertEqual(display_observations([tied],[row],tmp)[0]['status'], 'NOT_RUN')

    def test_missing_original_geometry_is_not_a_display_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            ds, path = self.fixture(Path(tmp), modality='MG')
            ds.PixelSpacing, ds.WindowCenter, ds.WindowWidth = [1,1], 512, 800
            ds.save_as(path, write_like_original=False)
            row = {'sop':str(ds.SOPInstanceUID),'modality':'MG','path':str(path)}
            cell = {'image':f"wadors:/studies/1/series/2/instances/{row['sop']}/frames/1",
                    'spacing':[1,1], 'windowLevel':{'windowCenter':512,'windowWidth':800}}
            self.assertEqual(display_observations([cell],[row],tmp)[0]['status'], 'NOT_RUN')

    def test_zoom_fit_identity_includes_viewport_and_frame(self):
        cell = {'viewportId':'a','image':'wadors:/studies/1/series/2/instances/3/frames/1'}
        check_identity_preserved([cell], [dict(cell)])
        for after in ([], [dict(cell, viewportId='b')], [dict(cell, image=cell['image'][:-1]+'2')],
                      [dict(cell, image=cell['image'].replace('instances/3','instances/4'))]):
            with self.assertRaises(AssertionError):
                check_identity_preserved([cell], after)

    def test_both_cine_rates_use_complete_order_with_wrap(self):
        for rate in (30,29):
            events = [{'image':str(i%3),'index':i%3,'t':i*1000/rate} for i in range(5)]
            self.assertAlmostEqual(check_cine_order(events,3), rate)
            with self.assertRaises(AssertionError):
                check_cine_order(events[:2]+events[3:],3)

    def test_subset_and_failures_never_report_complete(self):
        passed = [{'status':'PASS_TECHNICAL_CHECK_ONLY'}]
        self.assertEqual(aggregate_status(passed,['xa'],['mg','xa']), 'PARTIAL')
        self.assertEqual(aggregate_status([{'status':'FAIL'}],['xa'],['mg','xa']), 'FAIL')
        self.assertEqual(aggregate_status(passed,['xa'],['xa']), 'TECHNICAL_CHECKS_COMPLETE_DOCTOR_ACCEPTANCE_PENDING')

    def test_api_errors_share_origin_without_path_filter(self):
        self.assertTrue(same_origin('https://localhost:9443/api/studies/1/findings','https://localhost:9443'))
        self.assertTrue(same_origin('https://localhost/api/x','https://localhost:443'))
        self.assertFalse(same_origin('https://localhost:9444/api/x','https://localhost:9443'))

    def test_manifest_local_restriction_is_consumed(self):
        for manifest, source in (({'scope':'LOCAL TEST USE ONLY'}, {}),
                                 ({}, {'licence':'public test sample, local evaluation only; no redistribution licence claimed'}),
                                 ({}, {'local_only':True})):
            policy = local_use_policy(manifest, source)
            self.assertTrue(policy['local_only'])
            rows = [dict(policy, sop='1')]
            self.assertEqual(use_limits(rows, 'http://localhost:8042')['local_only_sops'], ['1'])
            with self.assertRaises(ValueError):
                use_limits(rows, 'https://example.invalid')
        self.assertFalse(local_use_policy({}, {})['local_only'])

    def test_provenance_identifies_executed_script_and_dirty_tree(self):
        facts = provenance(__file__)
        self.assertEqual(facts['scripts_sha256']['tests/mgxa_acceptance_test.py'], digest(__file__))
        self.assertIn('git_status', facts)

    def test_ci_selects_real_tool_consumers(self):
        for path in ('scripts/mgxa_acceptance.py','scripts/mgxa_viewer_check.py','scripts/mgxa_fixture.py','tests/mgxa_acceptance_test.py'):
            self.assertTrue(select([path])['ci-selfchecks'], path)

    def test_fixture_uses_requested_tree_image_ports_and_own_volumes(self):
        with tempfile.TemporaryDirectory() as tmp:
            compose = fixture_compose(Path(tmp), 'mgxa-test', 'mgxa-test:candidate', 19443, 18042)
            self.assertEqual(compose['services']['api']['image'], 'mgxa-test:candidate')
            self.assertEqual(compose['services']['proxy']['ports'], ['127.0.0.1:19443:443'])
            self.assertEqual(compose['services']['orthanc']['ports'], ['127.0.0.1:18042:8042'])
            self.assertTrue(all(v == {} for v in compose['volumes'].values()))
            self.assertFalse(compose['services']['db']['ports'])
            realm = fixture_realm('https://localhost:19443', 'generated-fixture-password')
            bff = next(c for c in realm['clients'] if c['clientId'] == 'kin-bff')
            self.assertEqual(bff['redirectUris'], ['https://localhost:19443/api/auth/callback'])
            self.assertEqual([u['username'] for u in realm['users'] if not u.get('serviceAccountClientId')], ['mgxa-doctor'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
