"""Acceptance tooling boundaries; generated test files are never clinical evidence.

D73: exercise file selection and displayed-image identities, not product source strings.
"""
import json
from pathlib import Path
import sys
import tempfile
import unittest

from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, XRayAngiographicImageStorage, generate_uid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from mgxa_acceptance import inventory, selected_files
from mgxa_viewer_check import check_images


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


if __name__ == '__main__':
    unittest.main(verbosity=2)
