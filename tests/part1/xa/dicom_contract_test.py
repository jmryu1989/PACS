# coding: utf-8
"""E-XA R1 DICOM contract: REQ-XA-01/02/04/07 -> RISK-XA-CODEC/FALSE-TIME/OOM/REGRESSION -> XA01/XA02/XA04/XA07.

The shipped KinXaPlaybackModel (run in node) reads the metadata a standard library writes for real and synthetic DICOM
files (pydicom Dataset.to_json_dict = PS3.18 F.2, the DICOMweb metadata form); pydicom independently reads the same
files and decodes their frames. Each case compares the model's identity, timing, budget and route with what the files
actually hold.

Public samples (tests/part1/xa/samples.json) are read in place by exact path and SHA-256 and are never modified. A
missing or changed public file FAILS the case as "verification incomplete"; nothing here is skipped into a pass.
The local public set has no multi-frame XA. Every multi-frame XA, compressed XA, Frame Time Vector, >500-frame,
>128 MiB, Enhanced XA, ultrasound and stored-subtraction object below is SYNTHETIC: built in a temporary directory at
run time with pydicom/Pillow, never committed, not clinical, and listed in samples.json real_sample_pending as what a
real public sample must still confirm. KIN_XA_MODEL_JS lets mutants.py run these cases against a mutated model copy.
"""
import copy
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pydicom
from PIL import Image
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.encaps import encapsulate, generate_pixel_data_frame
from pydicom.tag import Tag
from pydicom.uid import ExplicitVRLittleEndian, JPEGBaseline8Bit, RLELossless, generate_uid

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
MODEL = Path(os.environ.get('KIN_XA_MODEL_JS') or ROOT / 'worklist-v0' / 'hpacs-lite' / 'xa-playback-model.js')
SAMPLES = json.loads((HERE / 'samples.json').read_text(encoding='utf-8'))
XA, ENHANCED_XA, US_MULTI = '1.2.840.10008.5.1.4.1.1.12.1', '1.2.840.10008.5.1.4.1.1.12.1.1', '1.2.840.10008.5.1.4.1.1.3.1'
FRAME_TIME, FRAME_TIME_VECTOR = Tag(0x0018, 0x1063), Tag(0x0018, 0x1065)
LIMIT = 128 * 1024 * 1024
BRIDGE = r'''
const M = require(process.argv[2]);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const out = JSON.parse(input).map(job => {
    const list = job.metadata.map(m => M.describe(m));
    const shape = d => ({ ok: d.ok, reason: d.reason || null, kind: d.kind || null, frames: d.frames ?? null, playback: d.playback ?? null,
      timing: d.timing ? { source: d.timing.source, verified: d.timing.verified, reason: d.timing.reason, offsets: d.timing.offsets ? [...d.timing.offsets] : null,
        basis: d.timing.basis ? { ...d.timing.basis, relative: [...d.timing.basis.relative] } : null } : null,
      frameBytes: d.frameBytes ?? null, subtractionRecommended: d.subtractionRecommended ?? null,
      keys: d.ok ? Array.from({ length: d.frames }, (_, i) => M.frame(d, i).key) : null, sop: d.sop || null });
    const result = { describe: list.map(shape), route: { ...M.route(list.length === 1 ? list[0] : list) } };
    if (job.traverse && result.route.path === 'xa') result.traverse = traverse(list[0]);
    return result;
  });
  process.stdout.write(JSON.stringify(out));
});
// Forward play first to last through the shared budget: window reserve -> decode -> show -> give back.
function traverse(d) {
  const budget = M.createBudget(M.LIMITS), owner = {}, held = new Set(), shown = [];
  const ahead = M.aheadFor({ frameBytes: d.frameBytes, owners: 1 });
  let index = 0, direction = 1, notReady = 0;
  for (let n = 0; n < d.frames; n++) {
    const plan = M.windowPlan({ index, first: 0, last: d.frames - 1, mode: 'forward', direction, loop: false, ahead });
    const keys = new Set(plan.map(i => M.frame(d, i).key));
    for (const key of [...held]) if (!keys.has(key)) { budget.release(owner, key); held.delete(key); }
    for (let pass = 0; pass < 3; pass++) {
      for (const i of plan) { const key = M.frame(d, i).key; if (held.has(key)) continue; if (!budget.reserve(owner, key, d.frameBytes).ok) break; held.add(key); }
      for (const key of held) budget.ready(key);
    }
    if (budget.state(M.frame(d, index).key) !== 'ready') notReady++;
    shown.push(index);
    const s = M.step({ index, first: 0, last: d.frames - 1, mode: 'forward', direction, loop: false });
    if (s.stop) break;
    index = s.next; direction = s.direction;
  }
  return { shown: shown.length, first: shown[0], last: shown.at(-1), ordered: shown.every((v, i) => v === i), notReady, ...budget.snapshot() };
}
'''


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def metadata(path):
    """What a DICOMweb metadata answer carries for one instance: the header as PS3.18 JSON, no pixel data."""
    return pydicom.dcmread(str(path), stop_before_pixels=True).to_json_dict()


def marker(index):
    # A per-frame gray level that survives lossy JPEG: frame k is told apart from k +/- 1 by >= 9 levels.
    return 20 + (index * 9) % 220


def frames_for(count, rows, cols, dtype=np.uint8, stored=8):
    frames = np.zeros((count, rows, cols), dtype=dtype)
    top = (1 << stored) - 1
    for k in range(count):
        level = marker(k) * (top // 255 if dtype != np.uint8 else 1)
        frames[k, :, :] = level
        frames[k, rows // 4: rows // 2, (k * 3) % cols] = min(top, level + 40)  # a moving bar: the run is a run in time
    return frames


def dataset(path, sop_class, frames_count, rows, cols, *, bits=8, stored=8, modality='XA', pointer=FRAME_TIME,
            frame_time=None, vector=None, frame_delay=None):
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = sop_class
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = pydicom.dataset.FileDataset(str(path), {}, file_meta=meta, preamble=b'\0' * 128)
    ds.is_little_endian, ds.is_implicit_VR = True, False
    ds.SOPClassUID, ds.SOPInstanceUID = sop_class, meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID, ds.SeriesInstanceUID = generate_uid(), generate_uid()
    ds.Modality, ds.PatientName, ds.PatientID = modality, 'SYNTHETIC^XA^R1', 'SYN-XA-R1'
    ds.ContentDate, ds.ContentTime = '20261009', '120000'
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, 'MONOCHROME2'
    ds.Rows, ds.Columns, ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = rows, cols, bits, stored, stored - 1, 0
    ds.NumberOfFrames = frames_count
    if pointer is not None:
        ds.FrameIncrementPointer = pointer
    if frame_time is not None:
        ds.FrameTime = frame_time
    if vector is not None:
        ds.FrameTimeVector = vector
    if frame_delay is not None:
        ds.FrameDelay = frame_delay
    return ds


def save_native(ds, frames):
    ds.PixelData = frames.tobytes()
    ds.save_as(ds.filename, write_like_original=False)
    return Path(ds.filename)


def save_rle(ds, frames):
    ds.PixelData = frames.tobytes()
    ds.compress(RLELossless, frames)
    ds.save_as(ds.filename, write_like_original=False)
    return Path(ds.filename)


def save_jpeg(ds, frames):
    fragments = []
    for frame in frames:
        buffer = io.BytesIO()
        Image.fromarray(frame).save(buffer, format='JPEG', quality=95)  # uint8 2-D: an 8-bit gray JPEG
        fragments.append(buffer.getvalue())
    ds.file_meta.TransferSyntaxUID = JPEGBaseline8Bit
    ds.LossyImageCompression, ds.LossyImageCompressionMethod = '01', 'ISO_10918_1'
    ds.PixelData = encapsulate(fragments)
    ds['PixelData'].VR = 'OB'
    ds['PixelData'].is_undefined_length = True
    ds.save_as(ds.filename, write_like_original=False)
    return Path(ds.filename)


def frame_alone(path, index):
    """Decode one frame from its own fragment(s) only: the frame-level supply a WADO frame retrieve depends on."""
    ds = pydicom.dcmread(str(path))
    count = int(ds.NumberOfFrames)
    if not ds.file_meta.TransferSyntaxUID.is_compressed:
        size = int(ds.Rows) * int(ds.Columns) * (int(ds.BitsAllocated) // 8)
        one = np.frombuffer(ds.PixelData[index * size:(index + 1) * size], dtype=np.uint8 if ds.BitsAllocated == 8 else np.uint16)
        return one.reshape(int(ds.Rows), int(ds.Columns))
    fragment = list(generate_pixel_data_frame(ds.PixelData, count))[index]
    return decode_fragment(ds, fragment)


def decode_fragment(ds, fragment):
    single = copy.deepcopy(ds)
    single.NumberOfFrames = 1
    single.PixelData = encapsulate([fragment])
    single['PixelData'].is_undefined_length = True
    return single.pixel_array


def enhanced(path, times, dimensions):
    ds = dataset(path, ENHANCED_XA, len(times), 16, 16, pointer=None)
    items = []
    for t in times:
        content = Dataset()
        content.FrameReferenceDateTime = t
        content.FrameAcquisitionDateTime = t
        item = Dataset()
        item.FrameContentSequence = [content]
        items.append(item)
    ds.PerFrameFunctionalGroupsSequence = items
    ds.SharedFunctionalGroupsSequence = [Dataset()]
    index = []
    for pointer in dimensions:
        d = Dataset()
        d.DimensionIndexPointer = pointer
        index.append(d)
    ds.DimensionIndexSequence = index
    return save_native(ds, frames_for(len(times), 16, 16))


class Contract(unittest.TestCase):
    """Builds the synthetic set once; runs the shipped model once per question."""

    @classmethod
    def setUpClass(cls):
        cls.node = shutil.which('node')
        cls.tmp = Path(tempfile.mkdtemp(prefix='e-xa-r1-contract-'))
        (cls.tmp / 'bridge.cjs').write_text(BRIDGE, encoding='utf-8')
        root = Path(os.environ.get(SAMPLES['root_env']) or SAMPLES['default_root'])
        cls.public = {s['id']: dict(s, path=root / s['relpath']) for s in SAMPLES['public']}
        cls.public_before = {sid: (sha256(s['path']) if s['path'].is_file() else None) for sid, s in cls.public.items()}
        t = cls.tmp
        cls.syn = {}
        cls.syn['jpeg_ft'] = save_jpeg(dataset(t / 'jpeg_ft.dcm', XA, 24, 64, 64, frame_time=33.3, frame_delay=250), frames_for(24, 64, 64))
        vector = [0, 33.3, 33.4, 66.6, 16.7, 50, 33.3, 100, 16.7, 33.3, 25, 41.7]
        cls.vector = vector
        cls.syn['rle_ftv'] = save_rle(dataset(t / 'rle_ftv.dcm', XA, 12, 64, 64, bits=16, stored=12, pointer=FRAME_TIME_VECTOR, vector=vector,
                                              frame_delay=120.5), frames_for(12, 64, 64, np.uint16, 12))
        cls.syn['rle_601'] = save_rle(dataset(t / 'rle_601.dcm', XA, 601, 32, 32, frame_time=33.3), frames_for(601, 32, 32))
        cls.syn['jpeg_130mib'] = save_jpeg(dataset(t / 'jpeg_130mib.dcm', XA, 130, 1024, 1024, frame_time=66.7), frames_for(130, 1024, 1024))
        sub = dataset(t / 'rle_sub.dcm', XA, 8, 32, 32, frame_time=66.7)
        sub.RecommendedViewingMode = 'SUB'
        mask = Dataset()
        mask.MaskOperation, mask.ApplicableFrameRange, mask.MaskFrameNumbers, mask.MaskSubPixelShift = 'AVG_SUB', [2, 8], [1], [0.5, -0.25]
        sub.MaskSubtractionSequence = [mask]
        cls.sub_frames = frames_for(8, 32, 32)
        cls.syn['rle_sub'] = save_rle(sub, cls.sub_frames)
        times = ['20261009120000.000000', '20261009120000.033000', '20261009120000.100000', '20261009120000.133000',
                 '20261009120000.200000', '20261009120000.250000']
        cls.enhanced_times = times
        cls.syn['enhanced_time'] = enhanced(t / 'enhanced_time.dcm', times, [Tag(0x0018, 0x9151)])
        cls.syn['enhanced_two'] = enhanced(t / 'enhanced_two.dcm', times, [Tag(0x0020, 0x9056), Tag(0x0018, 0x9151)])
        cls.syn['us_multi'] = save_native(dataset(t / 'us_multi.dcm', US_MULTI, 4, 16, 16, modality='US', frame_time=33), frames_for(4, 16, 16))
        cls.syn_before = {name: sha256(path) for name, path in cls.syn.items()}

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def model(self, jobs):
        if not self.node:
            self.fail('node is not on PATH: the shipped model cannot run, verification incomplete')
        done = subprocess.run([self.node, str(self.tmp / 'bridge.cjs'), str(MODEL)], input=json.dumps(jobs), capture_output=True,
                              text=True, encoding='utf-8', timeout=120)
        self.assertEqual(done.returncode, 0, done.stderr[-2000:])
        return json.loads(done.stdout)

    def ask(self, *metadatas, traverse=False):
        return self.model([{'metadata': list(metadatas), 'traverse': traverse}])[0]

    def sample(self, sid):
        s = self.public[sid]
        if not s['path'].is_file():
            self.fail('public sample %s unavailable at %s: verification incomplete (not a skip)' % (sid, s['path']))
        self.assertEqual(sha256(s['path']), s['sha256'], 'public sample %s changed: verification incomplete' % sid)
        return s

    def samples(self, predicate):
        chosen = [self.sample(sid) for sid, s in sorted(self.public.items()) if predicate(s)]
        self.assertTrue(chosen, 'samples.json lists no public sample for this case')
        return chosen

    def assert_public_unchanged(self):
        for sid, s in self.public.items():
            self.assertEqual(sha256(s['path']), self.public_before[sid], 'public sample %s must be read-only' % sid)


class XaDicomContractTest(Contract):
    # ---- XA01 identity and frames --------------------------------------------------------------------------------
    def test_xa01_allow_stored_frames_keep_identity_and_decode_alone_in_order(self):
        # Real public XA: single uncompressed frames are stills with one source frame and a real pixel decode.
        xa = self.samples(lambda s: s['sop_class'] == XA)
        self.assertEqual(len(xa), 14)
        answers = self.model([{'metadata': [metadata(s['path'])], 'traverse': False} for s in xa])
        for s, answer in zip(xa, answers):
            d = answer['describe'][0]
            header = pydicom.dcmread(str(s['path']))
            self.assertEqual((d['ok'], d['kind'], d['frames'], d['playback'], answer['route']['path']), (True, 'xa', 1, 'still', 'still'), s['id'])
            self.assertEqual(d['keys'], [header.SOPInstanceUID + '#1'], s['id'])
            self.assertEqual(header.pixel_array.shape, (header.Rows, header.Columns), s['id'])
        # Real public RF multi-frame (pipeline regression, not XA): frame k of the stored bytes is frame k of the decode.
        for s in self.samples(lambda s: s['frames'] > 1):
            full = pydicom.dcmread(str(s['path'])).pixel_array
            for k in (0, s['frames'] - 1):
                np.testing.assert_array_equal(frame_alone(s['path'], k), full[k], err_msg=s['id'])
        # Synthetic compressed XA runs: each stored frame decodes from its own fragment, in stored order, as its own
        # frame; the model's frame keys follow the same order.
        for name, count in (('jpeg_ft', 24), ('rle_ftv', 12)):
            path = self.syn[name]
            d = self.ask(metadata(path))['describe'][0]
            sop = pydicom.dcmread(str(path), stop_before_pixels=True).SOPInstanceUID
            self.assertEqual(d['keys'], ['%s#%d' % (sop, k + 1) for k in range(count)], name)
            full = pydicom.dcmread(str(path)).pixel_array
            for k in range(count):
                alone = frame_alone(path, k)
                np.testing.assert_array_equal(alone, full[k], err_msg='%s frame %d' % (name, k + 1))
                level = int(np.median(alone)) // (16 if name == 'rle_ftv' else 1)
                self.assertLessEqual(abs(level - marker(k)), 3, '%s frame %d carries its own marker' % (name, k + 1))

    def test_xa01_reject_damaged_frames_and_identity_never_become_playable_frames(self):
        path = self.syn['jpeg_ft']
        ds = pydicom.dcmread(str(path))
        fragment = list(generate_pixel_data_frame(ds.PixelData, int(ds.NumberOfFrames)))[5]
        with self.assertRaises(Exception, msg='a truncated JPEG fragment must not decode into a frame'):
            decode_fragment(ds, fragment[:len(fragment) // 3])
        base = metadata(path)
        broken = {
            'no SOP Instance UID': {k: v for k, v in base.items() if k != '00080018'},
            'Number of Frames 0': {**base, '00280008': {'vr': 'IS', 'Value': [0]}},
            'Number of Frames text': {**base, '00280008': {'vr': 'IS', 'Value': ['many']}},
            'Bits Stored above Bits Allocated': {**base, '00280101': {'vr': 'US', 'Value': [12]}},
            'High Bit not Bits Stored - 1': {**base, '00280102': {'vr': 'US', 'Value': [3]}},
            'no Rows': {k: v for k, v in base.items() if k != '00280010'},
        }
        answers = self.model([{'metadata': [m], 'traverse': False} for m in broken.values()])
        for name, answer in zip(broken, answers):
            self.assertEqual(answer['route']['path'], 'refused', name)
            self.assertIsNone(answer['describe'][0]['frameBytes'], name)

    # ---- XA02 time -----------------------------------------------------------------------------------------------
    def test_xa02_allow_frame_time_and_frame_time_vector_are_the_source_timeline(self):
        d = self.ask(metadata(self.syn['jpeg_ft']))['describe'][0]
        self.assertEqual(d['timing']['source'], 'frame-time')
        for n, offset in enumerate(d['timing']['offsets']):
            self.assertAlmostEqual(offset, n * 33.3, places=6)
        # C.7.6.5: relative time of frame n = Frame Delay + Frame Time x (n - 1), kept as the source basis.
        header = pydicom.dcmread(str(self.syn['jpeg_ft']), stop_before_pixels=True)
        self.assertEqual(float(header.FrameDelay), 250.0)
        self.assertEqual(d['timing']['basis']['frameDelay'], 250)
        np.testing.assert_allclose(d['timing']['basis']['relative'], [float(header.FrameDelay) + n * float(header.FrameTime) for n in range(24)], atol=1e-9)
        header = pydicom.dcmread(str(self.syn['rle_ftv']), stop_before_pixels=True)
        self.assertEqual(header.FrameIncrementPointer, FRAME_TIME_VECTOR)
        d = self.ask(metadata(self.syn['rle_ftv']))['describe'][0]
        self.assertEqual(d['timing']['source'], 'frame-time-vector')
        expected = np.cumsum([float(v) for v in header.FrameTimeVector])
        np.testing.assert_allclose(d['timing']['offsets'], expected, rtol=0, atol=1e-9)
        np.testing.assert_allclose(d['timing']['basis']['relative'], float(header.FrameDelay) + expected, rtol=0, atol=1e-9)
        steps = np.diff(d['timing']['offsets'])
        self.assertGreater(steps.max() - steps.min(), 50, 'the vector is non-uniform and stays so')
        # Real public RF Cine Module (regression on real files, not XA evidence): Frame Increment Pointer -> Frame Time.
        for s in self.samples(lambda s: s['frames'] > 1):
            d = self.ask(metadata(s['path']))['describe'][0]
            self.assertEqual(d['timing']['source'], 'frame-time', s['id'])
            np.testing.assert_allclose(d['timing']['offsets'], [n * s['frame_time'] for n in range(s['frames'])], err_msg=s['id'])

    def test_xa02_reject_missing_or_contradictory_source_timing_is_unverified(self):
        base = metadata(self.syn['rle_ftv'])
        variants = {
            'vector one short': {**base, '00181065': {'vr': 'DS', 'Value': base['00181065']['Value'][:-1]}},
            'vector with a negative step': {**base, '00181065': {'vr': 'DS', 'Value': [0, 33.3, -1] + base['00181065']['Value'][3:]}},
            'vector first not 0': {**base, '00181065': {'vr': 'DS', 'Value': [10] + base['00181065']['Value'][1:]}},
            'pointer to Frame Time, none present': {**base, '00280009': {'vr': 'AT', 'Value': ['00181063']}},
            'no Frame Increment Pointer': {k: v for k, v in base.items() if k != '00280009'},
            'pointer to a non-time attribute': {**base, '00280009': {'vr': 'AT', 'Value': ['00182002']}},
        }
        answers = self.model([{'metadata': [m], 'traverse': False} for m in variants.values()])
        for name, answer in zip(variants, answers):
            d = answer['describe'][0]
            self.assertEqual((d['timing']['source'], d['timing']['verified'], d['timing']['offsets']), ('unverified', False, None), name)
            self.assertEqual(answer['route']['path'], 'xa', name + ': playable only at an explicit manual speed')

    # ---- XA04 bounded supply -------------------------------------------------------------------------------------
    def test_xa04_allow_601_frame_and_over_128_mib_runs_traverse_first_to_last_within_budget(self):
        long = self.ask(metadata(self.syn['rle_601']), traverse=True)
        d, walk = long['describe'][0], long['traverse']
        self.assertEqual((d['frames'], long['route']['path']), (601, 'xa'), 'XA-X13: a 601-frame stored run is never cut at 500')
        self.assertEqual((walk['shown'], walk['first'], walk['last'], walk['ordered'], walk['notReady']), (601, 0, 600, True, 0))
        self.assertLessEqual(walk['peakBytes'], LIMIT)
        self.assertLessEqual(walk['peakPrepared'], 500)
        self.assertLessEqual(walk['peakLoading'], 4)
        for k in (0, 300, 600):
            self.assertEqual(int(np.median(frame_alone(self.syn['rle_601'], k))), marker(k), 'frame %d is reachable on its own' % (k + 1))
        big = self.ask(metadata(self.syn['jpeg_130mib']), traverse=True)
        d, walk = big['describe'][0], big['traverse']
        header = pydicom.dcmread(str(self.syn['jpeg_130mib']), stop_before_pixels=True)
        decoded = int(header.NumberOfFrames) * header.Rows * header.Columns * header.BitsAllocated // 8
        self.assertGreater(decoded, 129 * 1024 * 1024, 'the stored run itself decodes to more than 128 MiB')
        self.assertEqual(d['frameBytes'], 1024 * 1024 * 8)
        self.assertEqual((big['route']['path'], walk['shown'], walk['last'], walk['notReady']), ('xa', 130, 129, 0))
        self.assertLessEqual(walk['peakBytes'], LIMIT)
        for k in (0, 129):
            self.assertLessEqual(abs(int(np.median(frame_alone(self.syn['jpeg_130mib'], k))) - marker(k)), 3)

    def test_xa04_reject_a_frame_that_cannot_pair_in_the_budget_or_lacks_its_size_never_reserves(self):
        base = metadata(self.syn['rle_601'])
        variants = {
            '8192 x 4096 frame': {**base, '00280010': {'vr': 'US', 'Value': [8192]}, '00280011': {'vr': 'US', 'Value': [4096]}},
            'no Bits Allocated': {k: v for k, v in base.items() if k != '00280100'},
            'no Columns': {k: v for k, v in base.items() if k != '00280011'},
            'Samples per Pixel 2': {**base, '00280002': {'vr': 'US', 'Value': [2]}},
        }
        answers = self.model([{'metadata': [m], 'traverse': True} for m in variants.values()])
        for name, answer in zip(variants, answers):
            self.assertEqual(answer['route']['path'], 'refused', name)
            self.assertNotIn('traverse', answer, name + ': a refused run is never walked')
        for answer in answers[1:]:
            self.assertIsNone(answer['describe'][0]['frameBytes'], 'missing or impossible pixel attributes reserve nothing')
        self.assertEqual(answers[0]['route']['reason'], 'frame-too-large')
        self.assertGreater(answers[0]['describe'][0]['frameBytes'] * 2, LIMIT)

    # ---- XA07 one owner per object, stored pixels unchanged ------------------------------------------------------
    def test_xa07_allow_each_object_goes_to_one_playback_path(self):
        expected = {}
        for s in self.samples(lambda s: True):
            expected[s['id']] = ('still' if s['sop_class'] == XA else 'generic', metadata(s['path']))
        answers = self.model([{'metadata': [m], 'traverse': False} for _, m in expected.values()])
        for (sid, (path, _)), answer in zip(expected.items(), answers):
            self.assertEqual(answer['route']['path'], path, sid)
        synthetic = {'jpeg_ft': 'xa', 'rle_ftv': 'xa', 'us_multi': 'generic', 'enhanced_time': 'xa', 'enhanced_two': 'xa-frames'}
        answers = self.model([{'metadata': [metadata(self.syn[n])], 'traverse': False} for n in synthetic])
        for (name, path), answer in zip(synthetic.items(), answers):
            self.assertEqual(answer['route']['path'], path, name)
        enhanced_answer = answers[list(synthetic).index('enhanced_time')]['describe'][0]
        self.assertEqual(enhanced_answer['kind'], 'enhanced-xa')
        self.assertEqual(enhanced_answer['timing']['source'], 'frame-content')
        self.assertEqual([round(v) for v in enhanced_answer['timing']['offsets']], [0, 33, 100, 133, 200, 250])
        pair = self.ask(metadata(self.syn['jpeg_ft']), metadata(self.syn['rle_ftv']))
        self.assertEqual(pair['route']['path'], 'still', 'two XA objects in one display set are not flattened into one run')

    def test_xa07_reject_stored_subtraction_is_shown_as_stored_and_no_source_changes(self):
        answer = self.ask(metadata(self.syn['rle_sub']))
        d = answer['describe'][0]
        self.assertEqual((answer['route']['path'], d['subtractionRecommended'], d['frames']), ('xa', True, 8))
        sop = pydicom.dcmread(str(self.syn['rle_sub']), stop_before_pixels=True).SOPInstanceUID
        self.assertEqual(d['keys'], ['%s#%d' % (sop, k + 1) for k in range(8)], 'stored frames keep their own numbers; no mask frame is dropped or merged')
        for k in range(8):
            np.testing.assert_array_equal(frame_alone(self.syn['rle_sub'], k), self.sub_frames[k], err_msg='stored frame %d' % (k + 1))
        for name, path in self.syn.items():
            self.assertEqual(sha256(path), self.syn_before[name], 'synthetic %s unchanged by the run' % name)
        self.samples(lambda s: True)
        self.assert_public_unchanged()


if __name__ == '__main__':
    unittest.main(verbosity=2)
