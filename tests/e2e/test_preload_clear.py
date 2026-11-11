# coding: utf-8
"""Requirement (A1 FC-072): Clear All deletes the preloaded copies from the browser; a Ready row shows when its copy expires.
-> TEST-PRELOAD-CLEAR-SERVED.

On the served stack, in a real browser, with synthetic studies only, what the reader sees is checked against what the
browser actually stores (the worker's IndexedDB `kin-preload`):
1. A study too large for the site's preload budget fails before it is fully fetched. With only that Failed row in the
   panel, Clear All deletes its stored record; the row keeps its status and reason, and Retry is still offered.
2. A small study is preloaded: its PF cell and panel row say Ready, and the row names the time its copy expires, which
   is the expiry stored with the copy, 72 hours after it was fetched. Its frames and record are in IndexedDB.
3. Clear All: IndexedDB holds no frame and no record, the row says Evicted with the cleared note, the PF cell says
   Evicted. The Failed row is unchanged.
4. Opening the study again reads every slice from the server (no cache check, no read from disk) and records one opening,
   and opening it stores no new copy.

The site setting KIN_PRELOAD_DISK_GB comes from this module's own CI profile (`preload-clear` in tests/measurement_ci.py):
small enough that a 32-slice 1024x1024 study does not fit and a 4-slice 256x256 study does.
"""
import json
import sys
import unittest
import uuid
from pathlib import Path

from playwright.sync_api import expect

from test_preload_cache import PreloadCacheE2E
from test_prior_selection import canvas_ready

# preload-worker.js MESSAGES.size / MESSAGES.cleared, the words the reader reads in the panel's Note column.
SIZE = '검사가 미리 받기 저장 용량보다 커서 받을 수 없습니다. 판독 때 바로 엽니다.'
CLEARED = '미리 받은 영상을 비웠습니다.'
# What the browser holds for preload: the rows of each object store, without their ciphertext.
STORED = """async () => {
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open('kin-preload'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const all = name => new Promise(resolve => { const r = db.transaction(name).objectStore(name).getAll(); r.onsuccess = () => resolve(r.result); });
  const out = {};
  for (const name of db.objectStoreNames) out[name] = (await all(name)).map(r => ({ expiresAt: r.expiresAt }));
  db.close();
  return out;
}"""
EMPTY = """async () => {
  const db = await new Promise(resolve => { const r = indexedDB.open('kin-preload'); r.onsuccess = () => resolve(r.result); });
  const counts = await Promise.all([...db.objectStoreNames].map(name => new Promise(resolve => {
    const r = db.transaction(name).objectStore(name).count(); r.onsuccess = () => resolve(r.result); })));
  db.close();
  return counts.every(n => n === 0);
}"""
TTL_MS = 72 * 3600 * 1000


class PreloadClearE2E(PreloadCacheE2E):
    def stored(self, page):
        rows = page.evaluate(STORED)
        return len(rows.get('frames', [])), rows.get('studies', [])

    def pf(self, page, fixture):
        return page.locator(f'#rows tr[data-uid="{fixture.uid}"] .pf').text_content()

    def queue(self, page, fixture):
        if page.locator('#multi-selection-clear').is_enabled():
            page.locator('#multi-selection-clear').click()
        row = page.locator(f'#rows tr[data-uid="{fixture.uid}"]')
        expect(row).to_be_visible()
        row.click(modifiers=['Control'])
        expect(page.locator('#multi-selection-count')).to_have_text('Selected: 1')
        page.locator('#multi-selection-preload').click()
        expect(page.locator('#preload-panel')).to_be_visible()

    def clear_all(self, page):
        page.locator('#preload-clear').click()
        page.wait_for_function(EMPTY, timeout=30000, polling=250)

    def test_preload_clear_01_failed_only_then_ready_expiry_clear_deletes_copy_and_reopen_reads_live(self):
        patient = 'CLEAR-' + uuid.uuid4().hex[:10]
        large = self.study(patient, 'LARGE', '20261002', slices=32, size=1024)
        small = self.study(patient, 'SMALL', '20261001', slices=4, size=256)
        context = self.device()
        seen = self.observe(context)
        p = self.sign_in(context)
        self.limit(p, 2)
        if not p.locator('.left').is_visible(): p.get_by_role('button', name='Worklist', exact=True).click()
        self.show_worklist_column(p, 'pf')
        p.locator('#filterrow [data-f="id"]').fill(patient)

        # 1. Only a Failed row: the study does not fit the site's budget.
        self.queue(p, large)
        p.locator('#preload-panel > summary').click()
        self.wait_status(p, large.uid, '^Failed$', timeout=180000)
        failed = self.panel(p)[large.uid]
        self.assertEqual(failed[2], SIZE, failed)
        self.assertEqual(self.pf(p, large), 'Failed')
        frames, studies = self.stored(p)
        print('STORED FAILED', json.dumps({'frames': frames, 'studies': len(studies)}), flush=True)
        self.assertEqual(frames, 0, 'a Failed study keeps no frame')
        self.assertEqual(len(studies), 1, 'the Failed row is kept as a record')
        self.clear_all(p)
        p.wait_for_timeout(1000)
        self.assertEqual(self.panel(p)[large.uid], failed, 'Clear All keeps a Failed row\'s status and reason')
        expect(p.locator(f'#preload-panel tbody tr[data-uid="{large.uid}"] button', has_text='Retry')).to_be_visible()
        self.assertEqual(self.pf(p, large), 'Failed')

        # 2. A study that fits: Ready, with the expiry of the copy the browser actually holds.
        self.queue(p, small)
        self.wait_status(p, small.uid, '^Ready')
        self.assertEqual(self.pf(p, small), 'Ready')
        frames, studies = self.stored(p)
        self.assertEqual(frames, small.slices, 'every slice is held in IndexedDB')
        self.assertEqual(len(studies), 1, 'one record: the Ready study\'s')
        expires = studies[0]['expiresAt']
        shown = p.evaluate("""([uid, expires]) => {
            const at = [...document.querySelectorAll('#preload-panel thead th')].findIndex(th => th.textContent === 'Status');
            return { text: document.querySelector(`#preload-panel tbody tr[data-uid="${uid}"]`).cells[at].textContent,
                     expected: 'Ready · ' + new Date(expires).toLocaleString() + '까지', left: expires - Date.now() };
        }""", [small.uid, expires])
        print('READY EXPIRY', json.dumps(shown, ensure_ascii=False), flush=True)
        self.assertEqual(shown['text'], shown['expected'], 'the Ready row names the stored copy\'s expiry')
        self.assertLess(abs(shown['left'] - TTL_MS), 10 * 60 * 1000, 'the copy expires 72 hours after it was fetched')

        # 3. Clear All deletes the copy from the browser's storage, and the screen says so.
        self.clear_all(p)
        self.wait_status(p, small.uid, '^Evicted$')
        self.assertEqual(self.panel(p)[small.uid][2], CLEARED)
        self.assertEqual(self.pf(p, small), 'Evicted')
        self.assertEqual(self.panel(p)[large.uid], failed)
        self.assertEqual(self.stored(p), (0, []))
        p.screenshot(path=str(self.artifact_dir() / 'PRELOAD-CLEAR-after-clear.png'))

        # 4. Opening it again reads from the server: no cache check, every slice live, one opening, no new copy.
        before = len(seen)
        viewer = self.separate(p, small)
        canvas_ready(viewer, 1)
        for index in range(1, small.slices):
            drawn = self.stack_index(viewer, index)
            self.assertEqual(drawn['drawn'], drawn['target'], drawn)
        reads = [s for s in seen[before:] if s[0] == small.uid]
        print('REOPEN READS', json.dumps([r[1] for r in reads]), flush=True)
        self.assertTrue(reads, 'the reopened study read its frames')
        self.assertTrue(all(r[1] is None for r in reads), 'no read is a cache check: %r' % [r[1] for r in reads])
        self.assertEqual(len({r[2].split('?')[0] for r in reads}), small.slices, 'every slice came from the server')
        self.assertEqual(len(self.wait_opens(small.uid, 1)), 1)
        self.assertEqual(self.stored(p), (0, []), 'opening the study stores no copy')
        self.wait_status(p, small.uid, '^Evicted')
        viewer.close(run_before_unload=True)

    def artifact_dir(self):
        folder = Path(__file__).resolve().parent / 'artifacts' / 'preload-clear-ci'
        folder.mkdir(parents=True, exist_ok=True)
        return folder


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(PreloadClearE2E(name) for name in PreloadClearE2E.__dict__ if name.startswith('test_preload_clear_'))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace'); unittest.main(verbosity=2)
