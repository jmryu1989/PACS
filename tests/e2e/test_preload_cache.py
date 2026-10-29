# coding: utf-8
"""REQ-MG-PRELOAD-CACHE -> RISK-PRELOAD-STALE-IDENTITY / RISK-PRELOAD-UNRECORDED-VIEW / RISK-PRELOAD-STARVES-READING /
RISK-PRELOAD-DISK-READABLE / RISK-PRELOAD-CROSS-USER -> TEST-PRELOAD-CACHE-SERVED (R1-R4/R7-R9/R11-R13/R16).

D1890 encrypted retention preload on the served stack, real browser: Preload on a worklist multi-selection, one study opened
while the others still load, frames after the opening check served from the worker's disk cache (no network read), the
store's ciphertext within the budget, ciphertext in IndexedDB, nothing in Cache Storage / OPFS. 열람 (D1880 "each open still records
열람"; opening contract consult-preload-opening-contract-20261029): an opening's root is its user-view provide-prepared
in the PostgreSQL ledger. A preloaded study that is not opened has none (its preload is a background-fetch transfer)
(O3); every new opening has exactly one - right after the preload, after the preload's delivery closed, a fresh viewer
inside the previous viewer's idle gap (review R1), a reload, a back/forward return, a patient tab entering the study
again - and a same-scope Open adds none (O1); while the ledger cannot take the root (its admission held at the
PostgreSQL boundary), neither a live image body nor the worker's disk cache reaches the screen, and the study shows once
the root is durable - for a patient tab entering a study again, its live read waits and the current scope stays on
screen (O2); after the idle gap the same opening reads as a background-fetch delivery referring to its
root, and a HEAD records nothing (O4). With a viewer open, Clear All and Retry under a new revision: the viewer's next
read does not take the new copy from disk; it is read live, then checked, and only then served from disk - and the
opening keeps its one root (O5). The viewer's reading stays busy for the worker until the image body has ended (the
page's real streams). A study changed after preload is dropped at opening and read live. Synthetic studies only; the
SharedWorker's own fetches are not visible to Playwright (measured: neither context.route nor request events see them),
so the worker is observed through the panel.

The stack's site setting KIN_PRELOAD_DISK_GB must be set (a synthetic disk cap in GiB, e.g. 0.25): without it preload is
off by design and every study fails with that reason.
"""
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
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
from invariants_live import ROOT, Fixture
from test_prior_selection import canvas_ready
from test_viewer_windows import ViewerWindowsE2E

FRAME = re.compile(r'/dicom-web/studies/([0-9.]+)/series/[0-9.]+/instances/[0-9.]+/frames/[0-9]+$')
# The viewer's patient tab of the scope it shows is in place (kinViewerOpenPatient compares against it).
TAB_SHOWN = "() => typeof window.kinViewerOpenPatient === 'function' && !!document.querySelector('.kin-patient-tabs [role=tab][aria-selected=true]')"
# Whether the stack-viewport canvas shows an image: canvas_ready's own test, answered now instead of awaited.
DRAWN = """() => [...document.querySelectorAll('.cornerstone-canvas')].some(c => {
  const ctx = c.getContext('2d');
  if (!ctx || !c.width || !c.height) return false;
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 16) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); }
  return hi - lo > 100;
})"""
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


class PreloadCacheE2E(ViewerWindowsE2E):
    @classmethod
    def cleanup_sessions(cls):
        super().cleanup_sessions()
        subjects = list(cls.stack.user_ids.values())
        for sub in subjects:
            if str(uuid.UUID(sub)) != sub:
                raise RuntimeError('Invalid temporary subject; refusing cache-key cleanup')
        if subjects:
            quoted = ','.join("'" + sub + "'" for sub in subjects)
            base.psql('DELETE FROM "PreloadCacheKey" WHERE sub IN (' + quoted + ')')
            if base.psql('SELECT count(*) FROM "PreloadCacheKey" WHERE sub IN (' + quoted + ')') != ['0']:
                raise RuntimeError('Synthetic preload-key cleanup failed')

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
        return p.evaluate("""() => {
            const heads = [...document.querySelectorAll('#preload-panel thead th')].map(th => th.textContent);
            const at = name => heads.indexOf(name);
            return Object.fromEntries([...document.querySelectorAll('#preload-panel tbody tr')]
                .map(tr => [tr.dataset.uid, ['Status', 'Progress', 'Note'].map(name => tr.cells[at(name)].textContent)]));
        }""")

    def wait_status(self, p, uid, pattern, timeout=120000):
        try:
            p.wait_for_function("""([uid, pattern]) => {
                const at = [...document.querySelectorAll('#preload-panel thead th')].findIndex(th => th.textContent === 'Status');
                const tr = document.querySelector(`#preload-panel tbody tr[data-uid="${uid}"]`);
                return tr && at >= 0 && new RegExp(pattern).test(tr.cells[at].textContent);
            }""", arg=[uid, pattern], timeout=timeout)
        except Exception:
            print('PANEL', json.dumps(self.panel(p), ensure_ascii=False), flush=True)
            raise

    def disk_usage(self, p):
        text = p.locator('#preload-panel [role="status"]').text_content()
        match = re.search(r'보관 ([0-9.]+) / ([0-9.]+) GB', text)
        self.assertIsNotNone(match, text)
        return float(match.group(1)), float(match.group(2)), text

    def assert_ciphertext(self, page, patient):
        key_ids = page.evaluate("""async () => {
          const db=await new Promise(resolve=>{const r=indexedDB.open('kin-preload');r.onsuccess=()=>resolve(r.result);});
          const rows=await new Promise(resolve=>{const r=db.transaction('studies').objectStore('studies').getAll();r.onsuccess=()=>resolve(r.result);});
          db.close();return [...new Set(rows.map(r=>r.keyId))];
        }""")
        keys = []
        for key_id in key_ids:
            self.assertEqual(str(uuid.UUID(key_id)), key_id)
            rows = base.psql('SELECT encode("key", \'hex\') FROM "PreloadCacheKey" WHERE id=\'' + key_id + "'::uuid")
            self.assertEqual(len(rows), 1)
            raw = bytes.fromhex(rows[0])
            self.assertEqual(len(raw), 32)
            keys.append(base64.b64encode(raw).decode('ascii'))
        # Scan complete ciphertext in Chromium, returning predicates only: large CT studies need not serialize
        # every byte through Playwright. The test's server keys never enter assertion messages or artifacts.
        result = page.evaluate("""async ({keys,secrets}) => {
          const db=await new Promise(resolve=>{const r=indexedDB.open('kin-preload');r.onsuccess=()=>resolve(r.result);});
          const rows={};
          for(const name of db.objectStoreNames) rows[name]=await new Promise(resolve=>{
            const r=db.transaction(name).objectStore(name).getAll();r.onsuccess=()=>resolve(r.result);
          });db.close();
          const raw=keys.map(k=>Uint8Array.from(atob(k),c=>c.charCodeAt(0)));
          const contains=(bytes,key)=>bytes.some((b,i)=>b===key[0] && key.every((v,j)=>bytes[i+j]===v));
          const opfs=[];for await(const [name] of (await navigator.storage.getDirectory()).entries())opfs.push(name);
          const storage={local:{...localStorage},session:{...sessionStorage},name:window.name,caches:await caches.keys(),opfs};
          const storageText=JSON.stringify(storage),checks=[];
          secrets.push(KinWorkContext.session());
          for(const [store,values] of Object.entries(rows))for(const r of values){
            const bytes=new Uint8Array(r.ct),clear=JSON.stringify({...r,ct:undefined,iv:undefined});
            const prefix=new TextDecoder().decode(bytes.slice(0,256));
            let gunzipFailed=false;
            try {await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();}
            catch {gunzipFailed=true;}
            checks.push({store,fields:Object.keys(r),noIdentifiers:secrets.every(s=>!clear.includes(s)&&!prefix.includes(s)),
              noMagic:!(bytes[0]===31&&bytes[1]===139)&&!(bytes[0]===45&&bytes[1]===45),gunzipFailed,
              noRawKey:raw.every(k=>!contains(bytes,k)),noEncodedKey:keys.every(k=>!clear.includes(k)&&!prefix.includes(k))});
          }
          return {stores:Object.keys(rows),frames:rows.frames.length,checks,caches:storage.caches,opfs,
                  windowKeyAbsent:keys.every(k=>!storageText.includes(k))&&raw.every(k=>!storageText.includes(JSON.stringify([...k])))};
        }""", {'keys': keys, 'secrets': [patient, 'PRELOAD^SYNTHETIC', *self.stack.active.keys()]})
        self.assertEqual(set(result['stores']), {'frames','studies'})
        self.assertGreater(result['frames'], 0)
        self.assertEqual(result['caches'], [])
        self.assertEqual(result['opfs'], [])
        self.assertTrue(result['windowKeyAbsent'])
        for row in result['checks']:
            self.assertEqual(set(row['fields']), {'entryId','keyId','expiresAt','bytes','iv','ct'} if row['store']=='frames'
                             else {'manifestId','keyId','expiresAt','iv','ct'})
            self.assertTrue(all(row[k] for k in ('noIdentifiers','noMagic','gunzipFailed','noRawKey','noEncodedKey')), row)

    def events(self, uid):
        """The study's image-delivery 열람 events (D1877 pairs); report and draft reads of the study are other events."""
        rows = base.psql("SELECT sequence::text || ' ' || payload FROM emr_access.access_entry "
                         "WHERE payload::jsonb->'targets'->0->'studyId'->>'value'='" + uid + "' "
                         "AND payload::jsonb->'targets'->0->>'kind'='image' ORDER BY sequence")
        return [(int(r.split(' ', 1)[0]), json.loads(r.split(' ', 1)[1])) for r in rows]

    def opens(self, uid):
        """The study's opening records: user-view provide-prepared (a viewer's read). Preload reads are background-fetch."""
        return [(s, e) for s, e in self.events(uid) if e['action'] == 'provide-prepared' and e['cause'] == 'user-view']

    def wait_opens(self, uid, count, after=0):
        deadline = time.monotonic() + 30
        while len([1 for s, _ in self.opens(uid) if s > after]) < count:
            self.assertLess(time.monotonic(), deadline, 'no opening record for %s' % uid)
            time.sleep(1)
        return [e for s, e in self.opens(uid) if s > after]

    def viewer_read(self, viewer, url):
        """One frame read through the viewer page's own fetch: its session transport and preload seam, as the image loader reads."""
        return viewer.evaluate("""async url => {
            const r = await fetch(url, { headers: { Accept: 'multipart/related; type="application/octet-stream"; transfer-syntax=*' } });
            return { status: r.status, length: (await r.arrayBuffer()).byteLength };
        }""", url)

    def wait_terminal(self, uid):
        deadline = time.monotonic() + DELIVERY_CLOSE_WAIT
        while time.monotonic() < deadline:
            done = [s for s, e in self.events(uid) if e['action'] in ('transfer-ended', 'transfer-aborted')]
            if done: return max(done)
            time.sleep(5)
        self.fail('the preload delivery of %s did not close within %ss' % (uid, DELIVERY_CLOSE_WAIT))

    def observe(self, context):
        """The viewer pages' frame GETs: (study, X-KIN-Preload, url, opening); `self.finished` the studies of those whose
        response body arrived in full."""
        seen, self.finished = [], []
        def study(r): return FRAME.search(r.url.split('?')[0])
        context.on('request', lambda r: seen.append((study(r).group(1), r.headers.get('x-kin-preload'), r.url,
                                                     r.headers.get('x-kin-view-opening')))
                   if r.method == 'GET' and study(r) else None)
        context.on('requestfinished', lambda r: self.finished.append(study(r).group(1)) if r.method == 'GET' and study(r) else None)
        return seen

    def open_viewer(self, p, fixture):
        """The study opened from the worklist in its separate viewer window, not waiting for its pixels."""
        self.choose(p, fixture)
        with p.context.expect_page() as opened:
            p.locator('#m-filmbox').click()
        popup = opened.value
        popup.wait_for_url('**/ohif/viewer?**')
        return popup

    def hold_ledger(self):
        """Holds the access ledger's admission: emr_access.admit_operation takes ledger_metadata FOR UPDATE, so every
        record append waits behind this transaction until `release_ledger` - the PostgreSQL boundary itself, with no
        switch in the product. Returns once the row lock is granted."""
        held = subprocess.Popen(['docker', 'compose', 'exec', '-T', 'db', 'psql', '-U', 'kin', '-d', 'kin', '-XqAt',
                                 '-v', 'ON_ERROR_STOP=1'], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, text=True)
        # One request (`\;`): the session is idle in its transaction only once the row lock is granted.
        held.stdin.write("SET application_name = 'kin-preload-ledger-hold';\n"
                         "BEGIN \\; SELECT 1 FROM emr_access.ledger_metadata FOR UPDATE;\n")
        held.stdin.flush()
        deadline = time.monotonic() + 30
        while base.psql("SELECT count(*) FROM pg_stat_activity WHERE application_name = 'kin-preload-ledger-hold' "
                        "AND state = 'idle in transaction' AND query LIKE '%ledger_metadata FOR UPDATE%'") != ['1']:
            self.assertLess(time.monotonic(), deadline, 'the ledger admission lock was not taken')
            time.sleep(.2)
        return held

    def release_ledger(self, held):
        if held.poll() is None:
            held.stdin.write('COMMIT;\n'); held.stdin.close()
            held.wait(timeout=30)

    def wait_terminal_of(self, uid, event_id):
        """The terminal of the study's delivery whose provide-prepared is `event_id`, once the idle gap closed it."""
        deadline = time.monotonic() + DELIVERY_CLOSE_WAIT
        while time.monotonic() < deadline:
            for s, e in self.events(uid):
                if e['action'] in ('transfer-ended', 'transfer-aborted') and e['relatedEventId'] == event_id:
                    return s, e
            time.sleep(5)
        self.fail('the delivery of %s did not close within %ss' % (event_id, DELIVERY_CLOSE_WAIT))

    def stack_index(self, viewer, index):
        """Show slice `index` of the open stack and wait until that image is the one drawn."""
        return viewer.evaluate("""async index => {
            const v = cornerstone.getEnabledElements().map(e => e.viewport).find(v => v.type === 'stack');
            const target = v.getImageIds()[index];
            await v.setImageIdIndex(index); v.render();
            for (let i = 0; i < 300 && v.csImage?.imageId !== target; i++) await new Promise(r => setTimeout(r, 50));
            return { target, drawn: v.csImage?.imageId, count: v.getImageIds().length };
        }""", index)

    def test_preload_01_queue_open_from_cache_record_and_ciphertext(self):
        patient = 'PRELOAD-' + uuid.uuid4().hex[:10]
        a = self.study(patient, 'A', '20260803', slices=8, size=512)
        b = self.study(patient, 'B', '20260802', slices=48, size=1024)
        c = self.study(patient, 'C', '20260801', slices=48, size=1024)
        # E: preloaded, first opened while the ledger cannot take its root (O2). D: another patient's study, never
        # preloaded, the other tab of the patient-tab re-entry (O1).
        e_study = self.study(patient, 'E', '20260804', slices=4, size=512)
        d = self.study('PRELOAD-' + uuid.uuid4().hex[:10], 'D', '20260805', slices=4, size=256)
        context = self.device()
        seen = self.observe(context)
        p = self.sign_in(context)
        self.limit(p, 2)
        if not p.locator('.left').is_visible(): p.get_by_role('button', name='Worklist', exact=True).click()
        p.locator('#quick').fill(patient)
        # The queue follows the reader's row order, which the worklist's sort decides (run 1028c listed A last). The
        # small study A is queued by itself first, then B and C in one multi-selection, so A is the head of the queue;
        # the small E goes last.
        for group in ((a,), (b, c), (e_study,)):
            if p.locator('#multi-selection-clear').is_enabled(): p.locator('#multi-selection-clear').click()
            for f in group:
                row = p.locator(f'#rows tr[data-uid="{f.uid}"]')
                expect(row).to_be_visible()
                row.click(modifiers=['Control'])
            expect(p.locator('#multi-selection-count')).to_have_text('Selected: %d' % len(group))
            p.locator('#multi-selection-preload').click()
            expect(p.locator('#preload-panel')).to_be_visible()
        p.locator('#preload-panel > summary').click()

        # 1. Open A as soon as it is Ready, while B and C are still queued or loading.
        self.wait_status(p, a.uid, '^Ready')
        at_open = self.panel(p)
        print('PANEL AT OPEN', json.dumps(at_open, ensure_ascii=False), flush=True)
        self.assertEqual(self.opens(a.uid), [], 'a preloaded study not opened yet has no opening record')
        before = len(seen)
        viewer = self.separate(p, a)
        canvas_ready(viewer, 1)
        reads = [s for s in seen[before:] if s[0] == a.uid]
        self.assertEqual([r[1] for r in reads], ['check'], 'one live check read opens a held study: %r' % reads)
        first_opening = reads[0][3]
        self.assertTrue(first_opening, 'the check read names the viewer\'s opening')
        # Opened right after its preload, inside the preload delivery's idle gap: its own opening record, exactly one.
        opened = self.wait_opens(a.uid, 1)
        self.assertEqual(len(opened), 1, opened)
        print('OPEN RECORD A', json.dumps([[e['surface'], e['cause'], e['context']['basis'], e['occurredAt']] for e in opened]), flush=True)
        for index in range(1, a.slices):
            shown = self.stack_index(viewer, index)
            self.assertEqual(shown['drawn'], shown['target'], shown)
        self.assertEqual(shown['count'], a.slices)
        self.assertEqual([s for s in seen[before:] if s[0] == a.uid], reads, 'every later slice came from disk')
        self.wait_status(p, a.uid, r'^Ready.*\(Open\)')
        self.assertTrue(any(at_open[f.uid][0] in ('Queued', 'Downloading') for f in (b, c)),
                        'B or C was still loading when A opened: %r' % at_open)
        used, budget, text = self.disk_usage(p)
        self.assertGreater(budget, 0, text)
        self.assertLessEqual(used, budget, text)
        for page in (p, viewer):
            self.assertEqual(page.evaluate(STORAGE), {'caches': [], 'indexedDB': ['kin-preload'], 'opfs': []})
        self.assert_ciphertext(p, patient)
        # O1: Open of the scope already shown keeps the opening - no read, no record.
        viewer.wait_for_function(TAB_SHOWN)
        mark = len(seen)
        self.assertTrue(viewer.evaluate('href => kinViewerOpenPatient(href)', '/ohif/viewer?StudyInstanceUIDs=' + a.uid))
        viewer.wait_for_timeout(3000)   # Playwright's request events are dispatched while it waits, not in time.sleep
        self.assertEqual([s for s in seen[mark:] if s[0] == a.uid], [], 'a same-scope Open reads nothing')
        self.assertEqual(len(self.opens(a.uid)), 1, 'a same-scope Open is no new opening')
        viewer.close(run_before_unload=True)
        self.wait_status(p, a.uid, '^Ready$')

        # 1b. Review R1: A opened again at once in a fresh viewer, well inside the first viewer's 120 s idle gap - a new
        # opening with its own live check and its own root, its slices then from disk.
        before = len(seen)
        viewer = self.separate(p, a)
        reads = [s for s in seen[before:] if s[0] == a.uid]
        self.assertEqual([r[1] for r in reads], ['check'], reads)
        self.assertTrue(reads[0][3] and reads[0][3] != first_opening, 'the fresh viewer is another opening: %r' % reads)
        self.wait_opens(a.uid, 2)
        roots = self.opens(a.uid)
        self.assertEqual(len(roots), 2, 'one root per opening')
        # The first viewer's delivery was still open (its terminal, if any, comes after the second root): inside its gap.
        first_end = [s for s, x in self.events(a.uid) if x['action'] in ('transfer-ended', 'transfer-aborted')
                     and x['relatedEventId'] == roots[0][1]['eventId']]
        self.assertTrue(all(s > roots[1][0] for s in first_end), 'the reopen was inside the first delivery\'s idle gap: %r' % first_end)
        print('REOPEN A', json.dumps({'openings': [first_opening, reads[0][3]], 'roots': [r[0] for r in roots]}), flush=True)
        shown = self.stack_index(viewer, a.slices - 1)
        self.assertEqual(shown['drawn'], shown['target'], shown)
        self.assertEqual([s for s in seen[before:] if s[0] == a.uid], reads, 'its slices came from disk')

        # 1c. A reload of that viewer is a new opening.
        before = len(seen)
        viewer.reload()
        canvas_ready(viewer, 1)
        reads = [s for s in seen[before:] if s[0] == a.uid]
        self.assertEqual([r[1] for r in reads], ['check'], reads)
        self.wait_opens(a.uid, 3)
        self.assertEqual(len(self.opens(a.uid)), 3)

        # 1d. Patient tabs A -> D -> A in this document: entering A again is a new opening, recorded by a live read
        # before A's pixels - which the document may still hold - can show.
        viewer.on('dialog', lambda dialog: dialog.accept())   # the frame-coverage confirmation of leaving A unread
        viewer.wait_for_function(TAB_SHOWN)
        self.assertTrue(viewer.evaluate('href => kinViewerOpenPatient(href)', '/ohif/viewer?StudyInstanceUIDs=' + d.uid))
        canvas_ready(viewer, 1)
        self.assertEqual(self.ids(viewer), [d.uid])
        self.wait_opens(d.uid, 1)
        # O2 at the re-entry: while the ledger cannot take A's new root, its live read waits and the tab does not
        # switch - A's pixels, which this document may still hold, are not shown; once the root is durable it switches.
        # The viewer is already loaded, so the hold stands between this opening and its root only. The ledger's own
        # transaction gives up after 15 s (EMR_TX_TIMEOUT_MS), so the hold ends well before that. The waits are
        # Playwright's: its request events are dispatched only while it waits (runs 1029a/1029b waited in time.sleep and
        # never saw a read).
        before, done = len(seen), len(self.finished)
        # Patient resolution now records its own worklist read. Let that real lookup finish before holding the
        # image admission; locking the whole ledger before navigation would stop resolve(), not the opening root.
        held = None
        reentry_route = re.compile(r'/dicom-web/studies/' + re.escape(a.uid) + r'/series/.+/frames/[0-9]+(?:\?.*)?$')

        def hold_opening(route):
            nonlocal held
            if held is None:
                held = self.hold_ledger()
            route.continue_()

        viewer.route(reentry_route, hold_opening)
        try:
            viewer.evaluate('href => { window.__kinSwitch = kinViewerOpenPatient(href); }', '/ohif/viewer?StudyInstanceUIDs=' + a.uid)
            deadline = time.monotonic() + 8
            while held is None or not [s for s in seen[before:] if s[0] == a.uid]:
                if time.monotonic() > deadline:
                    print('REENTRY NOT SENT', json.dumps(viewer.evaluate("""async () => ({
                        switched: await Promise.race([window.__kinSwitch, new Promise(r => setTimeout(() => r('pending'), 100))]),
                        status: document.querySelector('.kin-patient-tabs [role=status]')?.textContent ?? null })"""),
                        ensure_ascii=False), flush=True)
                    self.fail('the re-entry\'s live read was not sent')
                viewer.wait_for_timeout(200)
            viewer.wait_for_timeout(5000)
            waiting = [s for s in seen[before:] if s[0] == a.uid]
            self.assertEqual([r[1] for r in waiting], [None], 'one live read, no cache, no check: %r' % waiting)
            self.assertNotIn(a.uid, self.finished[done:], 'the live read waits for its root')
            self.assertEqual(self.ids(viewer), [d.uid], 'D stays on screen while A\'s root is not durable')
            self.assertEqual(len(self.opens(a.uid)), 3, 'no root yet')
        finally:
            viewer.unroute(reentry_route, hold_opening)
            if held is not None:
                self.release_ledger(held)
        self.assertTrue(viewer.evaluate('window.__kinSwitch'), 'the switch completes once the root is durable')
        canvas_ready(viewer, 1)
        self.assertEqual(self.ids(viewer), [a.uid])
        reads = [s for s in seen[before:] if s[0] == a.uid]
        self.assertTrue(reads and reads[0][1] is None, 'the re-entry reads A live first: %r' % reads)
        self.assertTrue(all(r[3] == reads[0][3] for r in reads), 'every read of the re-entry names its one opening: %r' % reads)
        self.wait_opens(a.uid, 4)
        self.assertEqual(len(self.opens(a.uid)), 4)
        self.assertEqual(len(self.opens(d.uid)), 1, 'D was entered once')

        # 1e. Back/forward: leaving the viewer and coming back to it is a new opening, whether the browser kept the page
        # (back/forward cache: hidden until the return's record) or loads it again.
        viewer.evaluate('window.__kinKept = true')
        viewer.goto('about:blank')
        viewer.go_back()
        viewer.wait_for_url('**/ohif/viewer?**')
        canvas_ready(viewer, 1)
        kept = viewer.evaluate('window.__kinKept === true')
        self.wait_opens(a.uid, 5)
        self.assertEqual(len(self.opens(a.uid)), 5)
        self.assertEqual(viewer.evaluate('getComputedStyle(document.documentElement).visibility'), 'visible')
        print('BACK FORWARD', json.dumps({'kept_by_browser': kept}), flush=True)
        viewer.close(run_before_unload=True)

        # 2. B, opened after its preload delivery closed: the opening has its own 열람 record (D1877), from disk.
        self.wait_status(p, b.uid, '^Ready', timeout=300000)
        self.wait_status(p, c.uid, '^Ready', timeout=300000)
        self.wait_status(p, e_study.uid, '^Ready', timeout=300000)
        # B, C and E are fully preloaded and not opened: their preload is a transfer, not an opening (O3).
        for f in (b, c, e_study):
            self.assertEqual(self.opens(f.uid), [], 'never-opened preload of %s has no opening record' % f.uid)
            self.assertTrue(any(x['action'] == 'provide-prepared' and x['cause'] == 'background-fetch' for _, x in self.events(f.uid)),
                            'the preload delivery itself is recorded as the fetch it is')

        # 2a. O2, first opening: E is opened while the ledger takes no record. No image body of E arrives and nothing is
        # drawn - from the network or from the worker's disk cache - and no root exists. A fresh viewer has more to load
        # than the re-entry in 1d, which isolates the root, so whether E's check read is sent while held is recorded,
        # not asserted; the hold ends before the ledger's own 15 s transaction limit. Once the ledger takes records
        # again, E shows from one check and then disk, with exactly one root.
        before = len(seen)
        held = self.hold_ledger()
        try:
            viewer = self.open_viewer(p, e_study)
            deadline = time.monotonic() + 8
            while not [s for s in seen[before:] if s[0] == e_study.uid] and time.monotonic() < deadline:
                viewer.wait_for_timeout(200)
            if [s for s in seen[before:] if s[0] == e_study.uid]: viewer.wait_for_timeout(5000)
            waiting = [s for s in seen[before:] if s[0] == e_study.uid]
            self.assertTrue(all(r[1] == 'check' for r in waiting), waiting)
            self.assertNotIn(e_study.uid, self.finished, 'no image body before the root is durable')
            self.assertFalse(viewer.evaluate(DRAWN), 'nothing drawn before the root is durable')
            self.assertEqual(self.opens(e_study.uid), [])
            print('HELD FIRST OPENING E', json.dumps({'check_read_sent_while_held': bool(waiting)}), flush=True)
        finally:
            self.release_ledger(held)
        canvas_ready(viewer, 1)
        self.assertEqual(len(self.wait_opens(e_study.uid, 1)), 1)
        for index in range(1, e_study.slices):
            shown = self.stack_index(viewer, index)
            self.assertEqual(shown['drawn'], shown['target'], shown)
        self.assertEqual([s[1] for s in seen[before:] if s[0] == e_study.uid], ['check'], 'then every slice from disk')
        self.assertEqual(len(self.opens(e_study.uid)), 1)
        viewer.close(run_before_unload=True)

        closed = self.wait_terminal(b.uid)
        self.assertEqual(self.opens(b.uid), [])
        before = len(seen)
        viewer = self.separate(p, b)
        canvas_ready(viewer, 1)
        self.assertEqual([s[1] for s in seen[before:] if s[0] == b.uid], ['check'])
        opened = self.wait_opens(b.uid, 1, after=closed)
        self.assertEqual(len(opened), 1, opened)
        print('OPEN RECORD B', json.dumps([[e['surface'], e['cause'], e['context']['basis'], e['occurredAt']] for e in opened]), flush=True)
        for index in (b.slices // 2, b.slices - 1):
            shown = self.stack_index(viewer, index)
            self.assertEqual(shown['drawn'], shown['target'], shown)
        self.assertEqual([s[1] for s in seen[before:] if s[0] == b.uid], ['check'], 'B\'s slices came from disk')
        used, budget, text = self.disk_usage(p)
        print('DISK', text, flush=True)
        self.assertLessEqual(used, budget, text)
        for page in (p, viewer):
            self.assertEqual(page.evaluate(STORAGE), {'caches': [], 'indexedDB': ['kin-preload'], 'opfs': []})
        self.assert_ciphertext(p, patient)

        # 2b. With B's viewer still open: Clear All, B changes, Retry under its new revision. The viewer must not take
        # the new copy from disk under its earlier check: the next read goes live, a new check follows, then disk.
        urls = viewer.evaluate("""() => cornerstone.getEnabledElements().map(e => e.viewport).find(v => v.type === 'stack')
            .getImageIds().map(id => id.replace(/^wadors:/, ''))""")
        mark = len(seen)
        self.assertEqual(self.viewer_read(viewer, urls[1])['status'], 200)
        self.assertEqual([s for s in seen[mark:] if s[0] == b.uid], [], 'before the change: from disk')
        p.locator('#preload-clear').click()
        self.wait_status(p, b.uid, '^Evicted')
        store_slices(self.stack, b.uid, b.series, b.frame, patient, 'B', b.date, 1, 1024, start=b.slices)
        for f in (b, c):
            p.locator(f'#preload-panel tbody tr[data-uid="{f.uid}"] button', has_text='Retry').click()
        self.wait_status(p, b.uid, '^Ready', timeout=300000)
        self.assertEqual(self.panel(p)[b.uid][1], '%d/%d' % (b.slices + 1, b.slices + 1), 'the new copy holds the changed study')
        mark = len(seen)
        self.assertEqual(self.viewer_read(viewer, urls[2])['status'], 200)
        after_retry = [s for s in seen[mark:] if s[0] == b.uid]
        self.assertEqual([s[1] for s in after_retry], [None], 'the new copy is not used under the earlier check: read live')
        mark = len(seen)
        self.assertEqual(self.viewer_read(viewer, urls[3])['status'], 200)
        self.assertEqual([s[1] for s in seen[mark:] if s[0] == b.uid], ['check'], 'the new copy gets its own live check')
        mark = len(seen)
        self.assertEqual(self.viewer_read(viewer, urls[4])['status'], 200)
        self.assertEqual([s for s in seen[mark:] if s[0] == b.uid], [], 'after its check, the new copy is used')
        # O5: the replacement copy's live read and check belong to the opening already recorded - its one root.
        b_openings = {s[3] for s in seen[before:] if s[0] == b.uid}
        self.assertEqual(len(b_openings), 1, 'one opening for every read of B in this viewer: %r' % b_openings)
        self.assertEqual(len(self.opens(b.uid)), 1, 'a replacement check is no new opening')

        # 2c. Reading priority: the viewer stays busy for the preload worker until an image body has ended, in this
        # page's own streams (the module the viewer runs, a scripted worker port to watch its messages).
        busy = viewer.evaluate("""async () => {
            const posted = [];
            class Port { start() {} postMessage(m) { posted.push(m); } }
            class Worker { constructor() { this.port = new Port(); } }
            let controller;
            const body = new ReadableStream({ start(c) { controller = c; } });
            const win = { location: window.location, SharedWorker: Worker, Headers, Response, ReadableStream, crypto: window.crypto,
                          addEventListener() {} };
            const read = window.KinViewerPreload.attach(win, async () => new Response(body, { status: 200 }));
            const answer = await read(location.origin + '/dicom-web/studies/1.2.3/metadata', { headers: {} });
            const states = () => posted.filter(m => m.type === 'busy').map(m => m.busy);
            const atHeaders = states();
            const reader = answer.body.getReader();
            controller.enqueue(new Uint8Array([1, 2, 3]));
            await reader.read();
            await new Promise(r => setTimeout(r, 50));
            const midBody = states();
            controller.close();
            await reader.read();
            return { atHeaders, midBody, atEnd: states() };
        }""")
        self.assertEqual(busy, {'atHeaders': [True], 'midBody': [True], 'atEnd': [True, False]}, busy)
        viewer.close(run_before_unload=True)
        self.wait_status(p, c.uid, '^Ready', timeout=300000)

        # 3. C changed after it was preloaded (one more object stored): the opening check drops it and the viewer reads live.
        store_slices(self.stack, c.uid, c.series, c.frame, patient, 'C', c.date, 1, 1024, start=c.slices)
        before = len(seen)
        viewer = self.separate(p, c)
        canvas_ready(viewer, 1)
        self.wait_status(p, c.uid, '^Evicted')
        self.assertIn('달라', self.panel(p)[c.uid][2])
        self.stack_index(viewer, c.slices // 2)
        c_seen = [s for s in seen[before:] if s[0] == c.uid]
        c_reads = [s[1] for s in c_seen]
        self.assertEqual(c_reads[0], 'check')
        self.assertGreater(len(c_reads), 1, 'after the drop the slices are read live')
        self.assertTrue(all(h is None for h in c_reads[1:]), c_reads)

        # 3b. O4: the idle gap retires C's delivery, not its opening. A HEAD records nothing; the same opening's next read
        # is a background-fetch delivery of its own referring to the opening's one root.
        root = self.wait_opens(c.uid, 1)[0]
        self.assertEqual({s[3] for s in c_seen}, {c_seen[0][3]}, 'one opening for C\'s reads')
        self.wait_terminal_of(c.uid, root['eventId'])
        count = len(self.events(c.uid))
        urls = viewer.evaluate("""() => cornerstone.getEnabledElements().map(e => e.viewport).find(v => v.type === 'stack')
            .getImageIds().map(id => id.replace(/^wadors:/, ''))""")
        head = viewer.evaluate("""async url => (await fetch(url, { method: 'HEAD',
            headers: { Accept: 'multipart/related; type="application/octet-stream"; transfer-syntax=*' } })).status""", urls[1])
        self.assertEqual(head, 200)
        time.sleep(3)
        self.assertEqual(len(self.events(c.uid)), count, 'a HEAD records nothing')
        mark = len(seen)
        self.assertEqual(self.viewer_read(viewer, urls[2])['status'], 200)
        self.assertEqual([(s[1], s[3]) for s in seen[mark:] if s[0] == c.uid], [(None, c_seen[0][3])], 'a live read of the same opening')
        deadline = time.monotonic() + 30
        while len(self.events(c.uid)) == count:
            self.assertLess(time.monotonic(), deadline, 'no record for the later read')
            time.sleep(1)
        later = [(x['action'], x['cause'], x['relatedEventId']) for _, x in self.events(c.uid)[count:]]
        self.assertEqual(later, [('provide-prepared', 'background-fetch', root['eventId'])], later)
        self.assertEqual(len(self.opens(c.uid)), 1, 'still the opening\'s one root')
        print('CONTINUATION C', json.dumps({'root': root['eventId'], 'later': later}), flush=True)
        viewer.close(run_before_unload=True)
        # Retry queues it again under the new revision.
        p.locator(f'#preload-panel tbody tr[data-uid="{c.uid}"] button', has_text='Retry').click()
        self.wait_status(p, c.uid, '^Ready', timeout=300000)
        self.assertEqual(self.panel(p)[c.uid][1], '%d/%d' % (c.slices + 1, c.slices + 1))
        folder = Path(__file__).resolve().parents[2] / 'tmp' / 'preload-cache'; folder.mkdir(parents=True, exist_ok=True)
        p.screenshot(path=str(folder / 'worklist-panel.png'))

    def cache_fixture(self, label, context=None):
        patient = 'CACHE-' + uuid.uuid4().hex[:10]
        fixture = self.study(patient, label, '20261001', slices=4, size=256)
        context = context or self.device()
        seen = self.observe(context)
        page = self.sign_in(context)
        self.limit(page, 2)
        if not page.locator('.left').is_visible(): page.get_by_role('button', name='Worklist', exact=True).click()
        page.locator('#quick').fill(patient)
        row = page.locator(f'#rows tr[data-uid="{fixture.uid}"]')
        expect(row).to_be_visible()
        row.click(modifiers=['Control'])
        page.locator('#multi-selection-preload').click()
        self.wait_status(page, fixture.uid, '^Ready')
        return fixture, context, page, seen

    def test_preload_02_R9_corrupt_record_uses_live_frames_and_R16_clear_deletes(self):
        fixture, context, page, seen = self.cache_fixture('CORRUPT')
        page.evaluate("""async () => {
          const db=await new Promise(resolve=>{const r=indexedDB.open('kin-preload');r.onsuccess=()=>resolve(r.result);});
          await new Promise((resolve,reject)=>{const tx=db.transaction('frames','readwrite'),s=tx.objectStore('frames'),r=s.openCursor();
            r.onsuccess=()=>{const c=r.result;if(c){const v=c.value;new Uint8Array(v.ct)[0]^=1;c.update(v);c.continue();}};
            tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
        }""")
        before = len(seen)
        viewer = self.separate(page, fixture)
        canvas_ready(viewer, 1)
        for index in range(1, fixture.slices):
            shown = self.stack_index(viewer, index)
            self.assertEqual(shown['drawn'], shown['target'])
        self.wait_status(page, fixture.uid, '^Evicted')
        reads = [r for r in seen[before:] if r[0] == fixture.uid]
        self.assertTrue(any(r[1] is None for r in reads), 'corrupt cache falls back to live frames')
        self.assertEqual(len(self.opens(fixture.uid)), 1, 'one durable opening despite cache fallback')
        viewer.close(run_before_unload=True)
        page.locator('#preload-panel > summary').click()
        page.locator(f'#preload-panel tbody tr[data-uid="{fixture.uid}"] button', has_text='Retry').click()
        self.wait_status(page, fixture.uid, '^Ready')
        page.locator('#preload-clear').click()
        self.wait_status(page, fixture.uid, '^Evicted')
        count = page.evaluate("""async () => {
          const db=await new Promise(resolve=>{const r=indexedDB.open('kin-preload');r.onsuccess=()=>resolve(r.result);});
          const counts=await Promise.all([...db.objectStoreNames].map(name=>new Promise(resolve=>{const r=db.transaction(name).objectStore(name).count();r.onsuccess=()=>resolve(r.result);})));db.close();return counts.reduce((a,b)=>a+b,0);
        }""")
        self.assertEqual(count, 0)

    def test_preload_03_R13_cut_check_never_displays_cached_pixels(self):
        fixture, context, page, seen = self.cache_fixture('OFFLINE')
        def offline(route):
            if '/frames/' in route.request.url: route.abort('internetdisconnected')
            else: route.continue_()
        context.route('**/dicom-web/**', offline)
        viewer = self.open_viewer(page, fixture)
        viewer.wait_for_timeout(3000)
        self.assertFalse(viewer.evaluate("""() => !!window.cornerstone?.getEnabledElements().some(e => e.viewport?.csImage?.imageId)"""))
        self.assertEqual(self.opens(fixture.uid), [], 'cut opening has no user-view root and no cached display')
        context.unroute('**/dicom-web/**', offline)
        viewer.close(run_before_unload=True)

    def test_preload_04_R3_R11_same_profile_A_B_A_keeps_ciphertext_and_restores_ready(self):
        fixture, context, page, seen = self.cache_fixture('OWNERS')
        count_script = """async () => {
          const db=await new Promise(resolve=>{const r=indexedDB.open('kin-preload');r.onsuccess=()=>resolve(r.result);});
          const n=await new Promise(resolve=>{const r=db.transaction('frames').objectStore('frames').count();r.onsuccess=()=>resolve(r.result);});db.close();return n;
        }"""
        count = page.evaluate(count_script)
        self.assertEqual(count, fixture.slices)
        self.sign_out(page)
        other = self.sign_in(context, 'tech')
        other.wait_for_timeout(500)
        self.assertNotIn(fixture.uid, self.panel(other), 'B cannot name A encrypted rows')
        self.assertEqual(other.evaluate(count_script), count)
        mark = len(seen)
        viewer = self.separate(other, fixture)
        canvas_ready(viewer, 1)
        for index in range(1, fixture.slices):
            shown = self.stack_index(viewer, index)
            self.assertEqual(shown['drawn'], shown['target'])
        reads = [r for r in seen[mark:] if r[0] == fixture.uid]
        self.assertTrue(reads)
        self.assertTrue(all(r[1] is None for r in reads), 'B reads live, with no cache check')
        viewer.close(run_before_unload=True)
        self.sign_out(other)
        again = self.sign_in(context)
        self.wait_status(again, fixture.uid, '^Ready')
        self.assertEqual(again.evaluate(count_script), count)
        mark = len(seen)
        viewer = self.separate(again, fixture)
        canvas_ready(viewer, 1)
        for index in range(1, fixture.slices):
            shown = self.stack_index(viewer, index)
            self.assertEqual(shown['drawn'], shown['target'])
        self.assertEqual([r[1] for r in seen[mark:] if r[0] == fixture.uid], ['check'])
        viewer.close(run_before_unload=True)

    def test_preload_05_R4_persistent_profile_restart_keeps_ready_and_one_opening_check(self):
        profile = tempfile.mkdtemp(prefix='retention-profile-', dir=ROOT / 'tmp')
        options = dict(channel=self.browser_channel, headless=os.environ.get('KIN_E2E_HEADED') != '1',
                       ignore_https_errors=True, viewport={'width':1600,'height':1000},
                       args=['--enable-unsafe-swiftshader'])
        context = self.pw.chromium.launch_persistent_context(profile, **options)
        self.contexts.append(context)
        fixture, context, page, _ = self.cache_fixture('RESTART', context=context)
        background = [e for _,e in self.events(fixture.uid) if e['action']=='provide-prepared' and e['cause']=='background-fetch']
        context.close()
        self.contexts.remove(context)
        context = self.pw.chromium.launch_persistent_context(profile, **options)
        self.contexts.append(context)
        seen = self.observe(context)
        page = self.sign_in(context)
        self.wait_status(page, fixture.uid, '^Ready')
        self.assertEqual([e for _,e in self.events(fixture.uid) if e['action']=='provide-prepared' and e['cause']=='background-fetch'], background,
                         'restored Ready makes no background store read')
        self.assert_ciphertext(page, fixture.patient_id)
        viewer = self.separate(page, fixture)
        canvas_ready(viewer, 1)
        for index in range(1, fixture.slices):
            shown = self.stack_index(viewer, index)
            self.assertEqual(shown['drawn'], shown['target'])
        self.assertEqual([r[1] for r in seen if r[0]==fixture.uid], ['check'])
        self.assertEqual(len(self.opens(fixture.uid)), 1)
        viewer.close(run_before_unload=True)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(PreloadCacheE2E(name) for name in PreloadCacheE2E.__dict__ if name.startswith('test_preload_'))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace'); unittest.main(verbosity=2)
