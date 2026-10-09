# coding: utf-8
"""E-XA R1 isolated DOM: REQ-XA-02..06 -> RISK-XA-FALSE-TIME/OMIT/OOM/STALE/FALSE-SUCCESS -> XA02..XA06.

Real Chromium, the shipped xa-playback-model.js and viewer-xa-playback.js, Playwright's own clock for time. The page
gives the module synthetic adapters only: a source that serves frame objects (each load a new object, so the test can
see that the viewport receives exactly what the source decoded), a canvas viewport that confirms each render, and an
identity. They do not emulate the pinned OHIF renderer, a DICOMweb server or a codec; R2 binds the real seams.
Assertions are on the module's behaviour: what the viewport rendered and when, what the source was asked for, the
English status names (AGENTS 4) and the public controller state. KIN_XA_MODEL_JS / KIN_XA_VIEWER_JS let
tests/part1/xa/mutants.py serve mutated copies.
"""
import os
import sys
import unittest
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ROOT = Path(__file__).resolve().parents[3]
HP = ROOT / 'worklist-v0' / 'hpacs-lite'
SERVED = {
    'xa-playback-model.js': os.environ.get('KIN_XA_MODEL_JS') or str(HP / 'xa-playback-model.js'),
    'viewer-xa-playback.js': os.environ.get('KIN_XA_VIEWER_JS') or str(HP / 'viewer-xa-playback.js'),
}
BASE = 'https://xa.test'
MIB = 1024 * 1024
HARNESS = r'''<!doctype html><meta charset="utf-8">
<div id="host0"></div><canvas id="view0" width="32" height="32"></canvas>
<div id="host1"></div><canvas id="view1" width="32" height="32"></canvas>
<div id="host2"></div><canvas id="view2" width="32" height="32"></canvas>
<script src="/worklist/hpacs-lite/xa-playback-model.js"></script>
<script src="/worklist/hpacs-lite/viewer-xa-playback.js"></script>
<script>
const XA = '1.2.840.10008.5.1.4.1.1.12.1';
const el = (vr, ...Value) => ({ vr, Value });
window.events = []; window.views = []; window.identities = [];
window.metadata = ({ frames = 10, sop = '2.25.13', rows = 32, cols = 32, frameTime = 20, vector, missingTime = false } = {}) => {
  const json = {
    '00080016': el('UI', XA), '00080018': el('UI', sop), '0020000D': el('UI', '2.25.11'), '0020000E': el('UI', '2.25.12'),
    '00280008': el('IS', frames), '00280010': el('US', rows), '00280011': el('US', cols), '00280002': el('US', 1),
    '00280100': el('US', 8), '00280101': el('US', 8), '00280102': el('US', 7), '00280103': el('US', 0),
    '00280009': el('AT', vector ? '00181065' : '00181063'),
  };
  if (vector) json['00181065'] = el('DS', ...vector); else if (!missingTime) json['00181063'] = el('DS', frameTime);
  return json;
};
window.openRun = (slot, options = {}) => {
  const md = metadata(options);
  const log = { loads: [], aborts: [], releases: [], inflight: 0, maxInflight: 0, held: new Map(), images: new Map(), failures: new Map() };
  const hold = new Set(options.hold || []);
  const source = {
    metadata: md,
    load(index, { signal }) {
      log.loads.push(index); log.inflight++; log.maxInflight = Math.max(log.maxInflight, log.inflight);
      return new Promise((resolve, reject) => {
        let done = false;
        const settle = (ok, value) => { if (done) return; done = true; log.inflight--; (ok ? resolve : reject)(value); };
        signal.addEventListener('abort', () => { log.aborts.push(index); settle(false, new DOMException('aborted', 'AbortError')); }, { once: true });
        const image = { frame: index + 1, pixels: new Uint8Array(16).fill(index % 251) };
        log.images.set(index, image);
        const failure = log.failures.get(index);
        if (failure) { setTimeout(() => settle(false, failure()), 0); return; }
        if (hold.has(index)) { hold.delete(index); log.held.set(index, () => settle(true, image)); return; }
        setTimeout(() => settle(true, image), options.delay || 0);
      });
    },
    release(index) { log.releases.push(index); },
  };
  const canvas = document.getElementById('view' + slot), context = canvas.getContext('2d');
  const shown = [], covers = [];
  const viewport = {
    current: () => options.current ?? 0,
    show(index, image) {
      context.fillStyle = 'rgb(' + (image.frame % 256) + ',0,0)'; context.fillRect(0, 0, canvas.width, canvas.height);
      shown.push({ index, frame: image.frame, same: image === log.images.get(index), at: performance.now(), loads: log.loads.length });
      return Promise.resolve({ index });
    },
    cover(on) { covers.push(on); canvas.style.visibility = on ? 'hidden' : 'visible'; },
  };
  identities[slot] = { account: 'reader', institution: 'hospital', study: '2.25.11', series: '2.25.12', sop: md['00080018'].Value[0], sequence: options.sequence || 1 };
  const controller = KinViewerXaPlayback.mount({ host: document.getElementById('host' + slot), source, viewport,
    identity: { key: { ...identities[slot] }, current: () => identities[slot] }, events: { emit: e => events.push({ slot, ...e }) } });
  views[slot] = { controller, log, shown, covers };
  return true;
};
window.releaseHeld = (slot, index) => views[slot].log.held.get(index)();
// A failing frame keeps failing (as look-ahead and when it is needed) until the test heals it.
window.failFrame = (slot, index, status) => views[slot].log.failures.set(index, () => Object.assign(new Error('frame decode failed'), status ? { status } : {}));
window.healFrame = (slot, index) => views[slot].log.failures.delete(index);
window.frames = slot => views[slot].shown.map(s => s.frame);
window.gaps = slot => views[slot].shown.slice(1).map((s, i) => Math.round((s.at - views[slot].shown[i].at) * 1000) / 1000);
</script>'''


class XaPlaybackDomTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 1400, 'height': 900})
        self.context.route(BASE + '/**', self.route)
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.clock.install(time=0)
        self.page.goto(BASE + '/xa')
        self.page.clock.pause_at(1000)

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [], 'no page error may hide behind a passing case')

    def route(self, route):
        path = route.request.url[len(BASE):].split('?')[0]
        name = path.rsplit('/', 1)[-1]
        if path.startswith('/worklist/hpacs-lite/') and name in SERVED:
            route.fulfill(body=Path(SERVED[name]).read_text(encoding='utf-8'), content_type='text/javascript; charset=utf-8')
        elif path == '/xa':
            route.fulfill(body=HARNESS, content_type='text/html; charset=utf-8')
        else:
            route.fulfill(status=404, body='')

    # -- helpers ---------------------------------------------------------------------------------------------------
    def open(self, slot=0, **options):
        self.page.evaluate('([slot, options]) => openRun(slot, options)', [slot, options])

    def control(self, name, slot=0):
        return self.page.locator('#host%d' % slot).get_by_role('button', name=name, exact=True)

    def status(self, slot=0):
        return self.page.locator('#host%d' % slot).get_by_role('status')

    def tick(self, ms):
        self.page.clock.run_for(ms)

    def js(self, expression, arg=None):
        return self.page.evaluate(expression, arg) if arg is not None else self.page.evaluate(expression)

    def state(self, slot=0):
        return self.js('slot => views[slot].controller.state()', slot)

    def frames(self, slot=0):
        return self.js('slot => frames(slot)', slot)

    # -- XA02 time -------------------------------------------------------------------------------------------------
    def test_xa02_source_vector_drives_each_frame_interval_and_is_named_source_timing(self):
        self.open(vector=[0, 40, 120, 60, 20], frames=5)
        self.page.locator('#host0').get_by_label('Loop').uncheck()
        expect(self.status()).to_contain_text('Source Timing')
        self.control('Play').click()
        self.tick(400)
        self.assertEqual(self.frames(), [1, 2, 3, 4, 5])
        self.assertEqual(self.js('gaps(0)'), [40, 120, 60, 20], 'each stored interval in order, not an average or a fixed rate')
        expect(self.status()).to_contain_text('All Shown')
        self.assertNotIn('Native', self.status().inner_text())
        # An explicit rate stays named as a rate of the source timing.
        self.page.locator('#host0').get_by_label('Playback Speed').select_option(label='Source Timing 2x')
        self.control('Play').click()
        self.tick(400)
        self.assertEqual(self.js('gaps(0)').__getitem__(slice(-4, None)), [20, 60, 30, 10])
        self.assertEqual(self.state()['speed'], {'kind': 'source', 'rate': 2})

    def test_xa02_unverified_timing_plays_only_at_a_named_manual_speed(self):
        self.open(frames=6, missingTime=True)
        expect(self.status()).to_contain_text('Manual 10 fps · Timing Unverified')
        labels = self.page.locator('#host0').get_by_label('Playback Speed').locator('option').all_inner_texts()
        self.assertFalse([label for label in labels if 'Source' in label], labels)
        self.page.locator('#host0').get_by_label('Loop').uncheck()
        self.control('Play').click()
        self.tick(1000)
        self.assertEqual(self.frames(), [1, 2, 3, 4, 5, 6])
        self.assertEqual(self.js('gaps(0)'), [100, 100, 100, 100, 100])
        self.page.locator('#host0').get_by_label('Playback Speed').select_option(label='30 fps')
        self.control('Play').click()
        self.tick(400)
        self.assertEqual([round(g, 2) for g in self.js('gaps(0)')[-5:]], [33.33] * 5)
        self.assertNotIn('Source Timing', self.status().inner_text())
        self.assertEqual(self.state()['timing'], {'source': 'unverified', 'verified': False})

    # -- XA03 order ------------------------------------------------------------------------------------------------
    def test_xa03_forward_yoyo_reverse_and_range_render_every_stored_frame_in_order(self):
        self.open(frames=6, frameTime=10)
        host = self.page.locator('#host0')
        host.get_by_label('Loop').uncheck()
        self.control('Play').click()
        self.tick(200)
        self.assertEqual(self.frames(), [1, 2, 3, 4, 5, 6])
        self.assertTrue(self.js('views[0].shown.every(s => s.same)'), 'the viewport receives the decoded image itself, unchanged')
        host.get_by_label('Playback Direction').select_option('yoyo')
        host.get_by_label('Loop').check()
        self.control('Play').click()
        self.tick(115)
        yoyo = self.frames()[6:]
        self.assertEqual(yoyo[:12], [6, 5, 4, 3, 2, 1, 2, 3, 4, 5, 6, 5])
        self.assertTrue(all(a != b for a, b in zip(yoyo, yoyo[1:])), 'no end frame twice in a row')
        self.control('Pause').click()
        host.get_by_label('Playback Direction').select_option('reverse')
        host.get_by_label('Loop').uncheck()
        self.control('Last Frame').click()
        self.tick(5)
        before = len(self.frames())
        self.control('Play').click()
        self.tick(200)
        self.assertEqual(self.frames()[before:], [6, 5, 4, 3, 2, 1])
        host.get_by_label('Playback Direction').select_option('forward')
        host.get_by_label('Loop').check()
        host.get_by_label('Range Start').fill('2')
        host.get_by_label('Range End').fill('4')
        self.control('Apply Range').click()
        before = len(self.frames())
        self.control('Play').click()
        self.tick(65)
        self.assertEqual(self.frames()[before:][:7], [2, 3, 4, 2, 3, 4, 2])
        self.assertEqual(self.state()['range'], {'first': 2, 'last': 4})

    def test_xa03_first_last_and_a_refused_range_keep_the_frame_on_screen(self):
        self.open(frames=6, frameTime=10)
        self.control('Last Frame').click()
        self.tick(5)
        expect(self.status()).to_contain_text('Frame 6 / 6')
        self.control('First Frame').click()
        self.tick(5)
        expect(self.status()).to_contain_text('Frame 1 / 6')
        self.assertEqual(self.frames(), [6, 1])
        host = self.page.locator('#host0')
        for start, end in (('5', '3'), ('0', '4'), ('2', '7'), ('3', '3')):
            host.get_by_label('Range Start').fill(start)
            host.get_by_label('Range End').fill(end)
            self.control('Apply Range').click()
            self.assertEqual(self.state()['range'], {'first': 1, 'last': 6}, (start, end))
        self.tick(100)
        self.assertEqual(self.frames(), [6, 1], 'a refused range shows no other frame')
        expect(self.status()).to_contain_text('Frame 1 / 6')

    # -- XA04 bounded supply ---------------------------------------------------------------------------------------
    def test_xa04_601_frame_run_reaches_its_last_frame_through_a_bounded_window(self):
        self.open(frames=601, frameTime=5)
        self.page.locator('#host0').get_by_label('Loop').uncheck()
        self.control('Play').click()
        self.tick(2)
        early = self.js('views[0].log.loads.length')
        self.assertLessEqual(early, 9, 'XA-X6: playback prepares a small window, never the whole run up front')
        self.tick(3200)
        frames = self.frames()
        self.assertEqual(frames, list(range(1, 602)), 'every stored frame, the 601st included')
        ahead = self.js('Math.max(...views[0].shown.map((s, i) => s.loads - (i + 1)))')
        self.assertLessEqual(ahead, 9, 'XA-X6: playback prepares a small window, never the whole run up front')
        log = self.js('({ max: views[0].log.maxInflight, loads: views[0].log.loads.length, distinct: new Set(views[0].log.loads).size })')
        self.assertLessEqual(log['max'], 4)
        self.assertEqual(log['loads'], log['distinct'], 'forward play decodes each frame once')
        budget = self.js('KinViewerXaPlayback.budget()')
        self.assertLessEqual(budget['peakBytes'], 128 * MIB)
        self.assertLessEqual(budget['peakPrepared'], 500)
        self.assertLessEqual(budget['peakLoading'], 4)
        expect(self.status()).to_contain_text('Frame 601 / 601')
        expect(self.status()).to_contain_text('All Shown')

    def test_xa04_viewports_share_one_budget_and_never_free_each_others_frames(self):
        # 1024 x 1024 frames reserve 8 MiB each (Float32 decode + RGBA8 staging), so the window is budget-bound.
        self.open(0, frames=12, frameTime=20, rows=1024, cols=1024, sop='2.25.31')
        self.open(1, frames=12, frameTime=20, rows=1024, cols=1024, sop='2.25.31')
        self.open(2, frames=30, frameTime=20, rows=1024, cols=1024, sop='2.25.32')
        self.control('First Frame', 1).click()
        self.tick(5)
        self.assertEqual(self.frames(1), [1])
        for slot in (0, 2):
            self.page.locator('#host%d' % slot).get_by_label('Loop').uncheck()
            self.control('Play', slot).click()
        self.tick(1200)
        self.assertEqual(self.frames(0), list(range(1, 13)))
        self.assertEqual(self.frames(2), list(range(1, 31)))
        self.assertNotIn(0, self.js('views[0].log.releases.concat(views[1].log.releases)'),
                         'frame 1 is still on viewport 1; viewport 0 moving on must not free it')
        self.assertGreater(len(self.js('views[0].log.releases')), 0, 'viewport 0 does give back its own consumed frames')
        self.assertEqual(self.js('views[0].log.loads.filter(i => i === 0).length + views[1].log.loads.filter(i => i === 0).length'), 1,
                         'the same stored frame is decoded once for both viewports')
        budget = self.js('KinViewerXaPlayback.budget()')
        self.assertLessEqual(budget['peakBytes'], 128 * MIB)
        self.assertLessEqual(budget['peakLoading'], 4)
        self.js('views[1].controller.dispose()')
        self.tick(1)
        self.assertEqual(self.js('views[0].log.releases.concat(views[1].log.releases).filter(i => i === 0).length'), 1)
        # A frame that cannot pair with the next one inside 128 MiB is refused up front: nothing is fetched.
        self.js('views[2].controller.dispose()')
        self.open(2, frames=4, rows=8192, cols=4096, sop='2.25.33')
        expect(self.status(2)).to_contain_text('Unavailable')
        expect(self.control('Play', 2)).to_be_disabled()
        self.assertEqual(self.js('views[2].log.loads'), [])

    # -- XA05 races ------------------------------------------------------------------------------------------------
    def test_xa05_buffering_keeps_the_position_and_pause_drops_a_late_frame(self):
        self.open(frames=10, frameTime=20, hold=[4])
        self.control('Play').click()
        self.tick(70)
        self.assertEqual(self.frames(), [1, 2, 3, 4])
        self.tick(200)
        expect(self.status()).to_contain_text('Buffering')
        expect(self.status()).to_contain_text('Frame 4 / 10')
        self.assertEqual(self.frames(), [1, 2, 3, 4], 'no frame is skipped while frame 5 is late')
        self.js('releaseHeld(0, 4)')
        self.tick(1)
        self.assertEqual(self.frames()[-1], 5)
        expect(self.status()).to_contain_text('Slower Than Source')
        self.tick(25)
        self.assertEqual(self.frames(), [1, 2, 3, 4, 5, 6], 'after a late frame the clock restarts: no catch-up burst')
        self.control('Pause').click()
        # Pause while frame 8 is still decoding: its late answer must not reach the screen or restart playback.
        self.open(1, frames=10, frameTime=20, hold=[7], sop='2.25.41')
        self.control('Play', 1).click()
        self.tick(130)
        self.assertEqual(self.frames(1), [1, 2, 3, 4, 5, 6, 7])
        self.control('Pause', 1).click()
        self.js('releaseHeld(1, 7)')
        self.tick(200)
        self.assertNotIn(8, self.frames(1), 'XA-X10: a frame that arrives after Pause never reaches the screen')
        self.assertEqual(self.state(1)['phase'], 'paused')
        self.assertFalse(self.state(1)['playing'])
        expect(self.control('Play', 1)).to_be_enabled()

    def test_xa05_account_end_and_the_same_object_reopened_drop_late_frames(self):
        self.open(0, frames=10, frameTime=20, hold=[2], sequence=1)
        self.control('Play').click()
        self.tick(100)
        self.assertEqual(self.frames(), [1, 2])
        self.js('identities[0] = { ...identities[0], sequence: 2 }')  # A -> B -> A: the same object, a new opening
        self.js('releaseHeld(0, 2)')
        self.tick(100)
        self.assertEqual(self.frames(), [1, 2], 'the old opening\'s late frame is not drawn into the new one')
        self.assertEqual(self.js('views[0].covers'), [], 'a viewport that now belongs to another opening is left alone')
        self.assertEqual(self.state()['phase'], 'stale')
        expect(self.control('Play')).to_be_disabled()
        self.open(1, frames=10, frameTime=20, hold=[3], sop='2.25.51')
        self.control('Play', 1).click()
        self.tick(100)
        self.assertEqual(self.frames(1), [1, 2, 3])
        self.js('identities[1] = null')  # the session ended
        self.js('releaseHeld(1, 3)')
        self.tick(100)
        self.assertEqual(self.frames(1), [1, 2, 3])
        self.assertEqual(self.js('views[1].covers'), [True], 'an ended session hides the pixels')
        expect(self.status(1)).to_contain_text('Stopped')
        self.assertIn(4, self.js('views[1].log.aborts.concat(views[1].log.releases)'), 'the window of the ended opening is given back')

    # -- XA06 recovery ---------------------------------------------------------------------------------------------
    def test_xa06_middle_failure_stops_at_the_last_shown_frame_and_retry_continues_there(self):
        self.open(frames=10, frameTime=20)
        self.js('failFrame(0, 6)')
        self.page.locator('#host0').get_by_label('Loop').uncheck()
        self.control('Play').click()
        self.tick(300)
        self.assertEqual(self.frames(), [1, 2, 3, 4, 5, 6], 'XA-X12: playback stops at a failed frame and never steps over it')
        expect(self.status()).to_contain_text('Failed')
        expect(self.status()).to_contain_text('Frame 6 / 10')
        self.assertNotIn('All Shown', self.status().inner_text())
        self.assertEqual(self.state()['failure'], {'frame': 7, 'kind': 'failed'})
        self.js('healFrame(0, 6)')
        self.control('Retry').click()
        self.tick(200)
        self.assertEqual(self.frames(), list(range(1, 11)))
        expect(self.status()).to_contain_text('All Shown')
        displayed = self.js('events.filter(e => e.type === "displayed").map(e => e.frame)')
        self.assertEqual(displayed, list(range(1, 11)))

    def test_xa06_denied_codec_failure_and_prefetch_never_count_as_shown(self):
        self.open(0, frames=10, frameTime=20)
        self.js('failFrame(0, 3, 403)')
        self.control('Play').click()
        self.tick(300)
        self.assertEqual(self.frames(), [1, 2, 3])
        expect(self.status()).to_contain_text('Access Denied')
        self.assertEqual(self.js('views[0].covers'), [True], 'refused access hides the image')
        self.assertNotIn('All Shown', self.status().inner_text())
        self.open(1, frames=12, frameTime=20, sop='2.25.61')
        self.control('Play', 1).click()
        self.tick(25)
        self.control('Pause', 1).click()
        self.tick(5)
        shown = self.frames(1)
        provided = self.js('events.filter(e => e.slot === 1 && e.type === "provided").map(e => e.frame)')
        self.assertGreater(len(provided), len(shown), 'frames were prepared ahead of the screen')
        self.assertEqual(self.state(1)['coverage'], {'shown': len(shown), 'total': 12, 'all': False},
                         'XA-X14: a prepared frame is not a shown frame')
        expect(self.status(1)).to_contain_text('Shown %d / 12' % len(shown))
        displayed = self.js('events.filter(e => e.slot === 1 && e.type === "displayed").map(e => e.frame)')
        self.assertEqual(displayed, shown)
        self.assertTrue(self.js('events.some(e => e.slot === 1 && e.type === "cancelled") || views[1].log.releases.length > 0'),
                        'Pause gives the prepared window back')
        self.open(2, frames=6, frameTime=20, sop='2.25.62')
        self.js('failFrame(2, 1)')
        self.control('Play', 2).click()
        self.tick(100)
        self.assertEqual(self.frames(2), [1])
        self.assertEqual(self.state(2)['failure'], {'frame': 2, 'kind': 'failed'})
        self.assertFalse(self.state(2)['coverage']['all'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
