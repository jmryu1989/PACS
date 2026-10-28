# coding: utf-8
"""REQ-MG-PRELOAD-MEM -> RISK-PRELOAD-STALE-IDENTITY / RISK-PRELOAD-UNRECORDED-VIEW / RISK-PRELOAD-STARVES-READING /
RISK-PRELOAD-OOM-REPORT-LOSS -> TEST-MG-PRELOAD-SERVED.

D1880 memory-only preload on the served stack, real browser: Preload on a worklist multi-selection, one study opened
while the others still load, frames after the opening check served from the worker's memory (no network read), the
store's memory within the budget the browser reported, nothing in Cache Storage / IndexedDB / OPFS, a fresh 열람 record
(provide-prepared) when a preloaded study is opened after its preload delivery closed, and a study changed after
preload dropped at opening and read live. Synthetic studies only; the SharedWorker's own fetches are not visible to
Playwright (measured: neither context.route nor request events see them), so the worker is observed through the panel.
"""
import json
import re
import sys
import time
import unittest
import uuid
from pathlib import Path

import numpy as np
from playwright.sync_api import expect
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid
from pynetdicom import AE

import test_worklist as base
from invariants_live import Fixture
from test_prior_selection import canvas_ready
from test_viewer_windows import ViewerWindowsE2E

FRAME = re.compile(r'/dicom-web/studies/([0-9.]+)/series/[0-9.]+/instances/[0-9.]+/frames/[0-9]+$')
# The idle gap that closes a study delivery (image-delivery-record.ts DEFAULT_IMAGE_DELIVERY_IDLE_MS, 120 s) plus the
# terminal's own append; the ledger poll ends well after it.
DELIVERY_CLOSE_WAIT = 240
STORAGE = """async () => {
  const opfs = [];
  try { const root = await navigator.storage.getDirectory(); for await (const [name] of root.entries()) opfs.push(name); }
  catch (error) { opfs.push('unreadable:' + error.name); }
  return { caches: await caches.keys(), indexedDB: (await indexedDB.databases()).map(d => d.name), opfs };
}"""


def store_slices(stack, uid, series, frame, patient, label, date, slices, size, start=0):
    """C-STORE `slices` uncompressed slices of `size`^2 into the study (a phantom over noise, so gzip cannot shrink it away)."""
    ae = AE(ae_title='HALLYM_CT')
    ae.add_requested_context(CTImageStorage, ExplicitVRLittleEndian)
    assoc = ae.associate('127.0.0.1', 4242, ae_title='KINLAB')
    if not assoc.is_established:
        raise RuntimeError('Local synthetic CT association failed')
    rng = np.random.default_rng(int(uuid.uuid4().hex[:8], 16))
    try:
        for z in range(start, start + slices):
            sop = generate_uid()
            meta = FileMetaDataset()
            meta.TransferSyntaxUID, meta.MediaStorageSOPClassUID = ExplicitVRLittleEndian, CTImageStorage
            meta.MediaStorageSOPInstanceUID, meta.ImplementationClassUID = sop, generate_uid()
            ds = FileDataset(None, {}, file_meta=meta, preamble=b'\0' * 128)
            ds.is_little_endian, ds.is_implicit_VR = True, False
            ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, sop
            ds.SpecificCharacterSet = 'ISO_IR 192'
            ds.PatientName, ds.PatientID = 'PRELOAD^SYNTHETIC', patient
            ds.PatientBirthDate, ds.PatientSex, ds.InstitutionName = '', 'O', '한림병원'
            ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = uid, series, frame
            ds.StudyDate = ds.SeriesDate = date
            ds.StudyTime = ds.SeriesTime = '120000'
            ds.AccessionNumber, ds.StudyID = 'PRELOAD' + label, 'PRELOAD'
            ds.StudyDescription = ds.SeriesDescription = 'PRELOAD ' + label
            ds.Modality, ds.SeriesNumber, ds.InstanceNumber = 'CT', 1, z + 1
            ds.ImageType = ['ORIGINAL', 'PRIMARY', 'AXIAL']
            ds.ImageOrientationPatient, ds.ImagePositionPatient = [1, 0, 0, 0, 1, 0], [0, 0, z * 2]
            ds.SliceLocation, ds.PixelSpacing = z * 2, [1, 1]
            ds.SliceThickness = ds.SpacingBetweenSlices = 2
            ds.Rows = ds.Columns = size
            ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, 'MONOCHROME2'
            ds.BitsAllocated = ds.BitsStored = 16
            ds.HighBit, ds.PixelRepresentation = 15, 0
            ds.WindowCenter, ds.WindowWidth = -500, 1000
            ds.RescaleIntercept, ds.RescaleSlope, ds.RescaleType = -1000, 1, 'HU'
            yy, xx = np.mgrid[:size, :size]
            disc = (xx - size // 2) ** 2 + (yy - size // 2) ** 2 < (size * 3 // 8) ** 2
            pixels = np.where(disc, 300 + (xx * 512 // size) * 2, 0) + rng.integers(0, 256, (size, size))
            ds.PixelData = pixels.astype('<u2').tobytes()
            status = assoc.send_c_store(ds)
            if status is None or status.Status != 0:
                raise RuntimeError('Synthetic CT C-STORE failed')
    finally:
        assoc.release()


class PreloadMemoryE2E(ViewerWindowsE2E):
    def study(self, patient, label, date, slices, size):
        uid, series, frame = generate_uid(), generate_uid(), generate_uid()
        fixture = Fixture(uid, patient, '한림병원', 'jmryu', 'PRELOAD-SYNTHETIC-' + label)
        self.stack.active[uid] = fixture   # owned by the stack's cleanup before the first write
        fixture.series, fixture.frame, fixture.date, fixture.slices = series, frame, date, slices
        store_slices(self.stack, uid, series, frame, patient, label, date, slices, size)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            result = self.stack.request('GET', '/studies', 'jmryu')
            if result.status == 200 and any(s.get('uid') == uid for s in result.body.get('studies', [])):
                break
            time.sleep(.25)
        else:
            raise RuntimeError('Synthetic study did not reach the real API')
        self.assertEqual(self.stack.request('PATCH', '/studies/' + uid, 'jmryu', {'ss': 'Verified'}).status, 200)
        return fixture

    def panel(self, p):
        """The preload panel as the reader sees it: uid -> [status, progress, note]."""
        return p.evaluate("""() => Object.fromEntries([...document.querySelectorAll('#preload-panel tbody tr')]
            .map(tr => [tr.dataset.uid, [...tr.cells].slice(1, 4).map(td => td.textContent)]))""")

    def wait_status(self, p, uid, pattern, timeout=120000):
        p.wait_for_function("""([uid, pattern]) => {
            const tr = document.querySelector(`#preload-panel tbody tr[data-uid="${uid}"]`);
            return tr && new RegExp(pattern).test(tr.cells[1].textContent);
        }""", arg=[uid, pattern], timeout=timeout)

    def memory(self, p):
        text = p.locator('#preload-panel [role="status"]').text_content()
        match = re.search(r'메모리 ([0-9.]+) / ([0-9.]+) GB', text)
        self.assertIsNotNone(match, text)
        return float(match.group(1)), float(match.group(2)), text

    def events(self, uid):
        rows = base.psql("SELECT sequence::text || ' ' || payload FROM emr_access.access_entry "
                         "WHERE payload::jsonb->'targets'->0->'studyId'->>'value'='" + uid + "' ORDER BY sequence")
        return [(int(r.split(' ', 1)[0]), json.loads(r.split(' ', 1)[1])) for r in rows]

    def wait_terminal(self, uid):
        deadline = time.monotonic() + DELIVERY_CLOSE_WAIT
        while time.monotonic() < deadline:
            done = [s for s, e in self.events(uid) if e['action'] in ('transfer-ended', 'transfer-aborted')]
            if done: return max(done)
            time.sleep(5)
        self.fail('the preload delivery of %s did not close within %ss' % (uid, DELIVERY_CLOSE_WAIT))

    def observe(self, context):
        seen = []
        context.on('request', lambda r: seen.append((FRAME.search(r.url.split('?')[0]).group(1), r.headers.get('x-kin-preload'), r.url))
                   if r.method == 'GET' and FRAME.search(r.url.split('?')[0]) else None)
        return seen

    def stack_index(self, viewer, index):
        """Show slice `index` of the open stack and wait until that image is the one drawn."""
        return viewer.evaluate("""async index => {
            const v = cornerstone.getEnabledElements().map(e => e.viewport).find(v => v.type === 'stack');
            const target = v.getImageIds()[index];
            await v.setImageIdIndex(index); v.render();
            for (let i = 0; i < 300 && v.csImage?.imageId !== target; i++) await new Promise(r => setTimeout(r, 50));
            return { target, drawn: v.csImage?.imageId, count: v.getImageIds().length };
        }""", index)

    def test_preload_01_queue_open_from_memory_record_and_no_disk(self):
        patient = 'PRELOAD-' + uuid.uuid4().hex[:10]
        a = self.study(patient, 'A', '20260803', slices=8, size=512)
        b = self.study(patient, 'B', '20260802', slices=48, size=1024)
        c = self.study(patient, 'C', '20260801', slices=48, size=1024)
        context = self.device()
        seen = self.observe(context)
        p = self.sign_in(context)
        self.limit(p, 2)
        if not p.locator('.left').is_visible(): p.get_by_role('button', name='Worklist', exact=True).click()
        p.locator('#quick').fill(patient)
        for f in (a, b, c):
            row = p.locator(f'#rows tr[data-uid="{f.uid}"]')
            expect(row).to_be_visible()
            row.click(modifiers=['Control'])
        expect(p.locator('#multi-selection-count')).to_have_text('Selected: 3')
        p.locator('#multi-selection-preload').click()
        expect(p.locator('#preload-panel')).to_be_visible()
        p.locator('#preload-panel > summary').click()

        # 1. Open A as soon as it is Ready, while B and C are still queued or loading.
        self.wait_status(p, a.uid, '^Ready')
        at_open = self.panel(p)
        print('PANEL AT OPEN', json.dumps(at_open, ensure_ascii=False), flush=True)
        before = len(seen)
        viewer = self.separate(p, a)
        canvas_ready(viewer, 1)
        reads = [s for s in seen[before:] if s[0] == a.uid]
        self.assertEqual([r[1] for r in reads], ['check'], 'one live check read opens a held study: %r' % reads)
        for index in range(1, a.slices):
            shown = self.stack_index(viewer, index)
            self.assertEqual(shown['drawn'], shown['target'], shown)
        self.assertEqual(shown['count'], a.slices)
        self.assertEqual([s for s in seen[before:] if s[0] == a.uid], reads, 'every later slice came from memory')
        self.wait_status(p, a.uid, r'^Ready \(Open\)')
        self.assertTrue(any(at_open[f.uid][0] in ('Queued', 'Downloading') for f in (b, c)),
                        'B or C was still loading when A opened: %r' % at_open)
        used, budget, text = self.memory(p)
        self.assertGreater(budget, 0, text)
        self.assertLessEqual(used, budget, text)
        for page in (p, viewer):
            self.assertEqual(page.evaluate(STORAGE), {'caches': [], 'indexedDB': [], 'opfs': []})
        viewer.close(run_before_unload=True)
        self.wait_status(p, a.uid, '^Ready$')

        # 2. B, opened after its preload delivery closed: the opening has its own 열람 record (D1877), from memory.
        self.wait_status(p, b.uid, '^Ready', timeout=300000)
        self.wait_status(p, c.uid, '^Ready', timeout=300000)
        closed = self.wait_terminal(b.uid)
        before = len(seen)
        viewer = self.separate(p, b)
        canvas_ready(viewer, 1)
        self.assertEqual([s[1] for s in seen[before:] if s[0] == b.uid], ['check'])
        deadline = time.monotonic() + 30
        while not [s for s, e in self.events(b.uid) if s > closed and e['action'] == 'provide-prepared']:
            self.assertLess(time.monotonic(), deadline, 'no 열람 record after the opening of a preloaded study')
            time.sleep(1)
        opened = [e for s, e in self.events(b.uid) if s > closed and e['action'] == 'provide-prepared']
        print('OPEN RECORD', json.dumps(opened, ensure_ascii=False)[:600], flush=True)
        for index in (b.slices // 2, b.slices - 1):
            shown = self.stack_index(viewer, index)
            self.assertEqual(shown['drawn'], shown['target'], shown)
        self.assertEqual([s[1] for s in seen[before:] if s[0] == b.uid], ['check'], 'B\'s slices came from memory')
        used, budget, text = self.memory(p)
        print('MEMORY', text, flush=True)
        self.assertLessEqual(used, budget, text)
        for page in (p, viewer):
            self.assertEqual(page.evaluate(STORAGE), {'caches': [], 'indexedDB': [], 'opfs': []})
        viewer.close(run_before_unload=True)

        # 3. C changed after it was preloaded (one more object stored): the opening check drops it and the viewer reads live.
        store_slices(self.stack, c.uid, c.series, c.frame, patient, 'C', c.date, 1, 1024, start=c.slices)
        before = len(seen)
        viewer = self.separate(p, c)
        canvas_ready(viewer, 1)
        self.wait_status(p, c.uid, '^Evicted')
        self.assertIn('달라', self.panel(p)[c.uid][2])
        self.stack_index(viewer, c.slices // 2)
        c_reads = [s[1] for s in seen[before:] if s[0] == c.uid]
        self.assertEqual(c_reads[0], 'check')
        self.assertGreater(len(c_reads), 1, 'after the drop the slices are read live')
        self.assertTrue(all(h is None for h in c_reads[1:]), c_reads)
        viewer.close(run_before_unload=True)
        # Retry queues it again under the new revision.
        p.locator(f'#preload-panel tbody tr[data-uid="{c.uid}"] button', has_text='Retry').click()
        self.wait_status(p, c.uid, '^Ready', timeout=300000)
        self.assertEqual(self.panel(p)[c.uid][1], '%d/%d' % (c.slices + 1, c.slices + 1))
        folder = Path(__file__).resolve().parents[2] / 'tmp' / 'preload-memory'; folder.mkdir(parents=True, exist_ok=True)
        p.screenshot(path=str(folder / 'worklist-panel.png'))


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(PreloadMemoryE2E(name) for name in PreloadMemoryE2E.__dict__ if name.startswith('test_preload_'))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace'); unittest.main(verbosity=2)
