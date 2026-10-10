# coding: utf-8
"""E-XA isolated DOM: REQ-XA-02..08 -> RISK-XA-FALSE-TIME/OMIT/OOM/STALE/FALSE-SUCCESS/FALSE-READ -> XA02..XA06 and the
round-3 consult matrix (D732: L01-L08, D01-D08, R01-R08, B01-B04, B06, B08-B11).

Real Chromium, the shipped xa-playback-model.js and viewer-xa-playback.js, Playwright's own clock. The page gives the
module synthetic adapters only. They model the seams of the consult's contract, not the pinned OHIF renderer:
  * a source with separate transport and decode control points; a decoder keeps running after an abort and settles
    only when it ends; an abort during transport may be acknowledged late; mayDecode() is asked before decoding;
  * a renderer that prepares into a private surface behind the handle the module issued to that draw, changes the
    visible canvas only inside publish() and frees a surface only when release() names its handle; it has no "latest
    request" logic of its own, so only the module decides what reaches the screen and what is given back;
  * one physical viewport per canvas, reused by every opening shown in it, whose pixels encode SOP, frame and opening
    sequence so the test reads the screen itself; cover() hides the canvas;
  * an allocation ledger of what the fakes really hold (open loads, running decoders, live images and surfaces), which
    the module's budget() must cover and never exceed the limits of.
Assertions are on behaviour: visible pixels, the role=status frame label, displayed events, source/renderer calls and
releases, the public budget. KIN_XA_MODEL_JS / KIN_XA_VIEWER_JS let tests/part1/xa/mutants.py serve mutated copies.
"""
import os
import json
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
LIMIT = 128 * MIB
A, B = '2.25.101', '2.25.102'
HARNESS = r'''<!doctype html><meta charset="utf-8">
<div id="host0"></div><canvas id="view0" width="32" height="32"></canvas>
<div id="host1"></div><canvas id="view1" width="32" height="32"></canvas>
<div id="host2"></div><canvas id="view2" width="32" height="32"></canvas>
<div id="host3"></div><canvas id="view3" width="32" height="32"></canvas>
<script src="/worklist/hpacs-lite/xa-playback-model.js"></script>
<script src="/worklist/hpacs-lite/viewer-xa-playback.js"></script>
<script>
const XA = '1.2.840.10008.5.1.4.1.1.12.1';
const el = (vr, ...Value) => ({ vr, Value });
window.events = []; window.views = []; window.identities = []; window.phys = []; window.watchers = []; window.saved = {};
window.alloc = { calls: 0, ops: 0, decoders: 0, images: 0, surfaces: 0, bytes: 0, peakOps: 0, peakDecoders: 0, peakBytes: 0 };
window.produced = new WeakSet();
const codes = new Map();
const codeOf = sop => { if (!codes.has(sop)) codes.set(sop, codes.size + 1); return codes.get(sop); };
const sopOf = code => { for (const [sop, c] of codes) if (c === code) return sop; return null; };
const bump = (field, n) => { alloc[field] += n; alloc.peakOps = Math.max(alloc.peakOps, alloc.ops); alloc.peakDecoders = Math.max(alloc.peakDecoders, alloc.decoders); };
const bytesBy = n => { alloc.bytes += n; alloc.peakBytes = Math.max(alloc.peakBytes, alloc.bytes); };
const align = n => Math.ceil(n / 4) * 4;
window.metadata = ({ frames = 10, sop = '2.25.13', rows = 32, cols = 32, frameTime = 20, vector, missingTime = false, manifestStudy, study = '2.25.11' } = {}) => {
  const json = {
    '00080016': el('UI', XA), '00080018': el('UI', sop), '0020000D': el('UI', manifestStudy || study), '0020000E': el('UI', '2.25.12'),
    '00280008': el('IS', frames), '00280010': el('US', rows), '00280011': el('US', cols), '00280002': el('US', 1),
    '00280100': el('US', 8), '00280101': el('US', 8), '00280102': el('US', 7), '00280103': el('US', 0),
    '00280009': el('AT', vector ? '00181065' : '00181063'),
  };
  if (vector) json['00181065'] = el('DS', ...vector); else if (!missingTime) json['00181063'] = el('DS', frameTime);
  return json;
};
// One physical viewport per canvas: the same object for every opening shown in it.
window.physical = slot => phys[slot] || (phys[slot] = makeViewport(slot));
// The renderer keeps its private surfaces behind the opaque handle the module issues to each draw; it renders only
// into that surface, puts on screen only what publish() names, and frees a surface only when release() names its handle.
function makeViewport(slot) {
  const canvas = document.getElementById('view' + slot), front = canvas.getContext('2d');
  const log = { prepares: [], publishes: [], released: [], covers: [], aborted: [], holds: new Set(), pending: [] };
  const kins = new WeakMap();
  let current = null;
  return { log, canvas,
    current: () => views[slot]?.current ?? 0,
    prepare(image, frame, { draw, surface: handle, signal }) {
      const key = frame.sop + '#' + frame.frame;
      log.prepares.push({ key, sop: frame.sop, frame: frame.frame, opening: frame.opening,
        decoded: produced.has(image) && image.frame === frame.frame && image.sop === frame.sop });
      const surface = document.createElement('canvas'); surface.width = surface.height = 4;
      surface.kin = { key, sop: frame.sop, frame: frame.frame, opening: frame.opening, size: image.surfaceBytes, released: false };
      kins.set(handle, surface); bump('surfaces', 1); bytesBy(image.surfaceBytes);
      signal.addEventListener('abort', () => log.aborted.push(key), { once: true });
      const answer = how => {
        if (how === 'reject') throw Error('render failed');
        const c = surface.getContext('2d'); c.fillStyle = 'rgb(' + codeOf(frame.sop) + ',' + frame.frame + ',' + frame.opening + ')'; c.fillRect(0, 0, 4, 4);
        const r = { draw, surface: handle, sop: frame.sop, frame: frame.frame, opening: frame.opening };
        if (how === 'wrong-sop') r.sop = '2.25.999';
        if (how === 'wrong-frame') r.frame = frame.frame + 1;
        if (how === 'wrong-opening') r.opening = frame.opening + 100;
        if (how === 'wrong-draw') r.draw = Object.freeze({});
        if (how === 'no-surface') r.surface = null;
        if (how === 'foreign-handle') r.surface = Object.freeze({});
        if (how === 'front-surface') r.surface = current;  // another draw's surface: the one on screen
        if (how === 'wrong-draw-front-surface') { r.draw = Object.freeze({}); r.surface = current; }
        return r;
      };
      if (log.holds.has(key)) {
        log.holds.delete(key);
        return new Promise((resolve, reject) => log.pending.push({ key, finish: how => { try { resolve(answer(how || 'ok')); } catch (e) { reject(e); } } }));
      }
      return Promise.resolve().then(() => answer('ok'));
    },
    publish(receipt) {
      const surface = kins.get(receipt.surface);
      if (!surface || surface.kin.released) throw Error('no such surface');
      front.clearRect(0, 0, canvas.width, canvas.height); front.drawImage(surface, 0, 0, canvas.width, canvas.height);
      log.publishes.push({ ...surface.kin, at: performance.now(), calls: alloc.calls });
      current = receipt.surface;
    },
    release(handle) {
      const surface = handle && kins.get(handle);
      if (!surface || surface.kin.released) return;
      surface.kin.released = true; log.released.push(surface.kin.key); bump('surfaces', -1); bytesBy(-surface.kin.size);
    },
    clear() { front.clearRect(0, 0, canvas.width, canvas.height); current = null; },
    cover(on) { log.covers.push(on); canvas.style.visibility = on ? 'hidden' : 'visible'; },
  };
}
window.openRun = (slot, options = {}) => {
  const md = metadata(options), sop = md['00080018'].Value[0];
  const rows = options.rows || 32, cols = options.cols || 32, payload = rows * align(cols * 4), surfaceBytes = rows * align(cols * 4);
  const holdAll = options.hold === 'all';
  const log = { calls: [], decodes: [], skipped: [], aborts: [], releases: [], loads: new Map(), decodesHeld: new Map(), abortEnds: [],
    failures: new Map(), loadHold: new Set(holdAll ? [] : [...(options.hold || []), ...(options.holdLoad || [])]),
    decodeHold: new Set(options.holdDecode || []), transports: new Map(), outcomes: new Map(), auth: [], authPending: [] };
  const source = {
    metadata: md, revision: options.revision || '',
    reauthorize(opening, { attempt, signal, accessResult }) {
      log.auth.push({ opening, attempt });
      return new Promise((resolve, reject) => {
        const finish = how => {
          if (how === 'deny') { accessResult(403); reject(Object.assign(Error('denied'), { status: 403 })); return; }
          const proof = { opening, attempt, authorized: true, fresh: true, scope: 'frames' };
          if (how === 'cache') proof.fresh = false;
          if (how === 'foreign') proof.opening = { ...opening, sop: '2.25.999' };
          if (how === 'fail') { reject(Error('authorization transport failed')); return; }
          resolve(proof);
        };
        if (options.authHold) log.authPending.push(finish); else queueMicrotask(() => finish('ok'));
      });
    },
    load(index, { signal, mayDecode, accessResult }) {
      log.calls.push(index); alloc.calls++; bump('ops', 1); bytesBy(payload);
      return new Promise((resolve, reject) => {
        let done = false, phase = 'transport';
        const end = (ok, value) => { if (done) return false; done = true; bump('ops', -1); bytesBy(-payload); (ok ? resolve : reject)(value); return true; };
        log.outcomes.set(index, accessResult);
        log.transports.set(index, status => {
          accessResult(status);
          if (phase === 'decode' && !done) bump('decoders', -1);
          end(false, Object.assign(Error('HTTP refusal'), { status }));
        });
        signal.addEventListener('abort', () => {
          log.aborts.push(index);
          if (phase !== 'transport') return;  // a running decoder ends when it ends
          const stop = () => end(false, new DOMException('aborted', 'AbortError'));
          if (options.lateAbort) log.abortEnds.push(stop); else stop();
        }, { once: true });
        const decode = () => {
          if (done) return;
          if (!mayDecode()) { log.skipped.push(index); end(false, new DOMException('not wanted', 'AbortError')); return; }
          phase = 'decode'; log.decodes.push(index); bump('decoders', 1);
          const finish = how => {
            if (done) return;
            bump('decoders', -1);
            const failure = log.failures.get(index);
            if (failure) { end(false, failure()); return; }
            if (how === 'fail') { end(false, Error('decode failed')); return; }
            const image = { frame: index + 1, sop, surfaceBytes, payload, released: false };
            produced.add(image); bump('images', 1); bytesBy(payload);
            if (!end(true, { image, sop: how === 'foreign' ? '2.25.999' : sop, frame: index + 1 })) { bump('images', -1); bytesBy(-payload); }
          };
          if (log.decodeHold.has(index)) { log.decodeHold.delete(index); log.decodesHeld.set(index, finish); } else setTimeout(() => finish('ok'), 0);
        };
        if (holdAll || log.loadHold.has(index)) { log.loadHold.delete(index); log.loads.set(index, decode); } else setTimeout(decode, options.delay || 0);
      });
    },
    release(index, image) {
      log.releases.push(index);
      if (image && !image.released) { image.released = true; bump('images', -1); bytesBy(-payload); }
    },
  };
  const key = { account: options.account || 'reader', institution: 'hospital', study: options.study || '2.25.11', series: '2.25.12', sop, sequence: options.sequence || 1 };
  if (options.session) key.session = options.session;
  identities[slot] = options.currentNull ? null : { ...key };
  const listeners = watchers[slot] || (watchers[slot] = new Set());
  const identity = { key, current: () => identities[slot], subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
  const viewport = physical(slot);
  const view = { log, source, sop, sequence: key.sequence, payload, surfaceBytes, current: options.current, viewport };
  views[slot] = view;
  view.controller = KinViewerXaPlayback.mount({ host: document.getElementById('host' + slot), source, viewport, identity,
    events: { emit: e => { events.push({ slot, ...e }); if (window.onEvent) window.onEvent(slot, e); } } });
  view.panel = [...document.querySelectorAll('#host' + slot + ' [role=status]')].at(-1);
  return true;
};
const viewOf = (slot, name) => name ? saved[name] : views[slot];
window.save = (name, slot) => { saved[name] = views[slot]; return true; };
window.endSession = slot => { identities[slot] = null; for (const fn of [...(watchers[slot] || [])]) fn(); return true; };
window.releaseLoad = (slot, index, name) => viewOf(slot, name).log.loads.get(index)();
window.releaseHeld = (slot, index) => releaseLoad(slot, index);
window.finishDecode = (slot, index, how, name) => viewOf(slot, name).log.decodesHeld.get(index)(how || 'ok');
window.holdRender = (slot, key) => { physical(slot).log.holds.add(key); return true; };
window.finishRender = (slot, key, how) => {
  const log = physical(slot).log, i = log.pending.findIndex(p => p.key === key);
  if (i < 0) throw Error('no render pending for ' + key);
  const [p] = log.pending.splice(i, 1); p.finish(how); return true;
};
window.endAborts = (slot, name) => { viewOf(slot, name).log.abortEnds.splice(0).forEach(stop => stop()); return true; };
// A failing frame keeps failing (as look-ahead and when it is needed) until the test heals it.
window.failFrame = (slot, index, status) => views[slot].log.failures.set(index, () => Object.assign(new Error('frame decode failed'), status ? { status } : {}));
window.healFrame = (slot, index) => views[slot].log.failures.delete(index);
window.rejectTransport = (slot, index, status = 403, name) => viewOf(slot, name).log.transports.get(index)(status);
window.finishAuth = (slot, how = 'ok', name) => viewOf(slot, name).log.authPending.shift()(how);
window.frames = (slot, name) => { const v = viewOf(slot, name); return physical(slot).log.publishes.filter(p => p.sop === v.sop && p.opening === v.sequence).map(p => p.frame); };
window.times = slot => { const v = views[slot]; return physical(slot).log.publishes.filter(p => p.sop === v.sop && p.opening === v.sequence).map(p => p.at); };
// Everything the reader and the auditor can observe for one opening on one physical viewport.
window.look = (slot, name) => {
  const v = viewOf(slot, name), p = physical(slot), c = p.canvas;
  const hidden = c.style.visibility === 'hidden', d = c.getContext('2d').getImageData(0, 0, 1, 1).data;
  const pixel = d[3] === 0 ? null : [sopOf(d[0]), d[1], d[2]];
  const text = v.panel && v.panel.isConnected ? v.panel.textContent : '';
  const m = text.match(/Frame (\d+|-) \//);
  const own = events.filter(e => e.slot === slot && e.sop === v.sop && e.sequence === v.sequence);
  return { V: hidden ? null : pixel, pixel, C: hidden, Lb: m && m[1] !== '-' ? Number(m[1]) : null,
    E: own.filter(e => e.type === 'displayed').map(e => e.frame), provided: own.filter(e => e.type === 'provided').map(e => e.frame), status: text,
    Q: KinViewerXaPlayback.budget(), alloc: { ...alloc }, auth: v.log.auth.length, calls: [...v.log.calls], decodes: [...v.log.decodes], skipped: [...v.log.skipped],
    aborts: [...v.log.aborts], releases: [...v.log.releases],
    prepares: p.log.prepares.filter(x => x.opening === v.sequence && x.sop === v.sop).map(x => x.frame),
    published: p.log.publishes.filter(x => x.opening === v.sequence && x.sop === v.sop).map(x => x.frame),
    surfaceReleases: [...p.log.released], state: v.controller.state() };
};
</script>'''


def k(sop, frame):
    return '%s#%d' % (sop, frame)


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
        self.start_page()

    def tearDown(self):
        self.end_page()

    def start_page(self):
        self.context = self.browser.new_context(viewport={'width': 1400, 'height': 900})
        self.context.route(BASE + '/**', self.route)
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.clock.install(time=0)
        self.page.goto(BASE + '/xa')
        self.page.clock.pause_at(1000)

    def end_page(self):
        self.context.close()
        self.assertEqual(self.errors, [], 'no page error may hide behind a passing case')

    def fresh(self):
        self.end_page()
        self.start_page()

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
    def open(self, slot=0, settle=True, **options):
        self.page.evaluate('([slot, options]) => openRun(slot, options)', [slot, options])
        if settle:
            self.tick(1)

    def control(self, name, slot=0):
        return self.page.locator('#host%d [role=group]' % slot).last.get_by_role('button', name=name, exact=True)

    def status(self, slot=0):
        return self.page.locator('#host%d [role=status]' % slot).last

    def label(self, name, slot=0):
        return self.page.locator('#host%d [role=group]' % slot).last.get_by_label(name)

    def tick(self, ms):
        self.page.clock.run_for(ms)

    def js(self, expression, arg=None):
        return self.page.evaluate(expression, arg) if arg is not None else self.page.evaluate(expression)

    def state(self, slot=0):
        return self.js('slot => views[slot].controller.state()', slot)

    def frames(self, slot=0):
        return self.js('slot => frames(slot)', slot)

    def look(self, slot=0, name=None):
        return self.js('([slot, name]) => look(slot, name)', [slot, name])

    def seek(self, slot, frame):
        self.js('([slot, frame]) => { views[slot].controller.seek(frame); return true; }', [slot, frame])

    def save(self, name, slot=0):
        self.js('([name, slot]) => save(name, slot)', [name, slot])

    def hold(self, slot, phase, frame, sop=A):
        if phase == 'L':
            self.js('([slot, i]) => { views[slot].log.loadHold.add(i); return true; }', [slot, frame - 1])
        elif phase == 'D':
            self.js('([slot, i]) => { views[slot].log.decodeHold.add(i); return true; }', [slot, frame - 1])
        else:
            self.js('([slot, key]) => holdRender(slot, key)', [slot, k(sop, frame)])

    def complete(self, slot, phase, frame, how='ok', sop=A, name=None):
        if phase == 'L':
            self.js('([slot, i, name]) => { releaseLoad(slot, i, name); return true; }', [slot, frame - 1, name])
        elif phase == 'D':
            self.js('([slot, i, how, name]) => { finishDecode(slot, i, how, name); return true; }', [slot, frame - 1, how, name])
        else:
            self.js('([slot, key, how]) => finishRender(slot, key, how)', [slot, k(sop, frame), how])

    def honest(self, seen, message):
        """The module's budget covers what the fakes really hold and never passes a limit."""
        q, real = seen['Q'], seen['alloc']
        self.assertGreaterEqual(q['bytes'], real['bytes'], message + ' %s %s' % (q, real))
        self.assertGreaterEqual(q['loading'], real['ops'], message + ' %s %s' % (q, real))
        self.assertLessEqual(q['bytes'], LIMIT, message)
        self.assertLessEqual(q['loading'], 4, message)
        self.assertLessEqual(real['ops'], 4, message)
        self.assertTrue(all(v >= 0 for v in q.values() if isinstance(v, (int, float))), message)

    def drained(self, message='every owner closed, every resource given back'):
        self.js('() => { for (const v of [...views, ...Object.values(saved)]) v && v.controller.dispose(); return true; }')
        self.tick(5)
        q = self.js('KinViewerXaPlayback.budget()')
        real = self.js('({ ...alloc })')
        self.assertEqual((q['bytes'], q['loading'], q['prepared'], q['retiring']), (0, 0, 0, 0), message + ' %s' % q)
        self.assertEqual((real['bytes'], real['ops'], real['decoders'], real['images'], real['surfaces']), (0, 0, 0, 0, 0), message + ' %s' % real)

    # -- XA02 time -------------------------------------------------------------------------------------------------
    def test_xa02_source_vector_drives_each_frame_interval_and_is_named_source_timing(self):
        self.open(vector=[0, 40, 120, 60, 20], frames=5)
        self.label('Loop').uncheck()
        expect(self.status()).to_contain_text('Source Timing')
        started = self.js('performance.now()')
        self.control('Play').click()
        self.tick(400)
        self.assertEqual(self.frames(), [1, 2, 3, 4, 5])
        at = self.js('times(0)')
        self.assertEqual([round(at[1] - started), *[round(b - a) for a, b in zip(at[1:], at[2:])]], [40, 120, 60, 20],
                         'each stored interval in order, not an average or a fixed rate')
        expect(self.status()).to_contain_text('All Shown')
        self.assertNotIn('Native', self.status().inner_text())
        self.label('Playback Speed').select_option(label='Source Timing 2x')
        self.control('Play').click()
        self.tick(400)
        at = self.js('times(0)')
        self.assertEqual([round(b - a) for a, b in zip(at[-5:], at[-4:])], [20, 60, 30, 10])
        self.assertEqual(self.state()['speed'], {'kind': 'source', 'rate': 2})

    def test_xa02_unverified_timing_plays_only_at_a_named_manual_speed(self):
        self.open(frames=6, missingTime=True)
        expect(self.status()).to_contain_text('Manual 10 fps · Timing Unverified')
        labels = self.label('Playback Speed').locator('option').all_inner_texts()
        self.assertFalse([label for label in labels if 'Source' in label], labels)
        self.label('Loop').uncheck()
        self.control('Play').click()
        self.tick(1000)
        self.assertEqual(self.frames(), [1, 2, 3, 4, 5, 6])
        at = self.js('times(0)')
        self.assertEqual([round(b - a) for a, b in zip(at[1:], at[2:])], [100, 100, 100, 100])
        self.label('Playback Speed').select_option(label='30 fps')
        self.control('Play').click()
        self.tick(400)
        at = self.js('times(0)')
        self.assertEqual([round(b - a, 2) for a, b in zip(at[-6:], at[-5:])], [33.33] * 5)
        self.assertNotIn('Source Timing', self.status().inner_text())
        self.assertEqual(self.state()['timing'], {'source': 'unverified', 'verified': False})

    # -- XA03 order ------------------------------------------------------------------------------------------------
    def test_xa03_forward_yoyo_reverse_and_range_render_every_stored_frame_in_order(self):
        self.open(frames=6, frameTime=10)
        self.label('Loop').uncheck()
        self.control('Play').click()
        self.tick(200)
        self.assertEqual(self.frames(), [1, 2, 3, 4, 5, 6])
        self.assertTrue(self.js('physical(0).log.prepares.every(p => p.decoded)'), 'the renderer receives the decoded image itself, unchanged')
        self.label('Playback Direction').select_option('yoyo')
        self.label('Loop').check()
        self.control('Play').click()
        self.tick(115)
        yoyo = self.frames()[5:]
        self.assertEqual(yoyo[:12], [6, 5, 4, 3, 2, 1, 2, 3, 4, 5, 6, 5])
        self.assertTrue(all(a != b for a, b in zip(yoyo, yoyo[1:])), 'no end frame twice in a row')
        self.control('Pause').click()
        self.label('Playback Direction').select_option('reverse')
        self.label('Loop').uncheck()
        self.control('Last Frame').click()
        self.tick(5)
        before = len(self.frames())
        self.assertEqual(self.look()['Lb'], 6)
        self.control('Play').click()
        self.tick(200)
        self.assertEqual(self.frames()[before:], [5, 4, 3, 2, 1])
        self.label('Playback Direction').select_option('forward')
        self.label('Loop').check()
        self.label('Range Start').fill('2')
        self.label('Range End').fill('4')
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
        self.assertEqual(self.frames(), [1, 6, 1])
        for start, end in (('5', '3'), ('0', '4'), ('2', '7'), ('3', '3')):
            self.label('Range Start').fill(start)
            self.label('Range End').fill(end)
            self.control('Apply Range').click()
            self.assertEqual(self.state()['range'], {'first': 1, 'last': 6}, (start, end))
        self.tick(100)
        self.assertEqual(self.frames(), [1, 6, 1], 'a refused range shows no other frame')
        expect(self.status()).to_contain_text('Frame 1 / 6')

    # -- XA04 bounded supply ---------------------------------------------------------------------------------------
    def test_xa04_601_frame_run_reaches_its_last_frame_through_a_bounded_window(self):
        self.open(frames=601, frameTime=5)
        self.label('Loop').uncheck()
        before = self.js('alloc.calls')
        self.control('Play').click()
        self.tick(2)
        self.assertLessEqual(self.js('alloc.calls') - before, 9, 'XA-X6: playback prepares a small window, never the whole run up front')
        self.tick(3200)
        self.assertEqual(self.frames(), list(range(1, 602)), 'every stored frame, the 601st included')
        ahead = self.js('Math.max(...physical(0).log.publishes.map((p, i) => p.calls - (i + 1)))')
        self.assertLessEqual(ahead, 9, 'XA-X6: playback prepares a small window, never the whole run up front')
        seen = self.look()
        self.assertEqual(len(seen['calls']), len(set(seen['calls'])), 'forward play decodes each frame once')
        self.assertLessEqual(seen['alloc']['peakOps'], 4)
        budget = seen['Q']
        self.assertLessEqual(budget['peakBytes'], LIMIT)
        self.assertLessEqual(budget['peakPrepared'], 500)
        self.assertLessEqual(budget['peakLoading'], 4)
        expect(self.status()).to_contain_text('Frame 601 / 601')
        expect(self.status()).to_contain_text('All Shown')
        self.drained()

    def test_xa04_viewports_share_one_budget_and_never_free_each_others_frames(self):
        # 1024 x 1024 frames: a 4 MiB payload shared within one opening, a 4 MiB surface per viewport.
        self.open(0, frames=12, frameTime=20, rows=1024, cols=1024, sop='2.25.31')
        self.open(1, frames=12, frameTime=20, rows=1024, cols=1024, sop='2.25.31')
        self.open(2, frames=30, frameTime=20, rows=1024, cols=1024, sop='2.25.32')
        self.assertEqual(self.frames(1), [1])
        self.control('First Frame', 1).click()
        self.tick(5)
        self.assertEqual(self.frames(1), [1], 'seeking to the frame already shown invents no new display')
        for slot in (0, 2):
            self.label('Loop', slot).uncheck()
            self.control('Play', slot).click()
        self.tick(1200)
        self.assertEqual(self.frames(0), list(range(1, 13)))
        self.assertEqual(self.frames(2), list(range(1, 31)))
        self.assertNotIn(0, self.js('views[0].log.releases.concat(views[1].log.releases)'),
                         'frame 1 is still on viewport 1; viewport 0 moving on must not free it')
        self.assertEqual(self.js('views[0].log.calls.filter(i => i === 0).length + views[1].log.calls.filter(i => i === 0).length'), 1,
                         'the same stored frame is decoded once for both viewports')
        seen = self.look(0)
        self.honest(seen, 'the shared budget')
        self.assertLessEqual(seen['Q']['peakBytes'], LIMIT)
        self.drained()
        self.assertEqual(self.js('views[0].log.releases.concat(views[1].log.releases).filter(i => i === 0).length'), 1, 'given back once, at the end')
        # A frame that cannot pair with the next one inside 128 MiB is refused up front: nothing is fetched.
        self.open(2, frames=4, rows=8192, cols=4096, sop='2.25.33')
        expect(self.status(2)).to_contain_text('Unavailable')
        expect(self.control('Play', 2)).to_be_disabled()
        self.assertEqual(self.js('views[2].log.calls'), [])

    def test_xa04_cancelled_loads_hold_their_budget_until_the_abort_settles(self):
        self.open(1, frames=4, frameTime=20, rows=2048, cols=1024, sop='2.25.71')
        self.assertEqual(self.frames(1), [1])
        self.open(0, frames=20, frameTime=20, rows=2048, cols=1024, sop='2.25.72', hold='all', lateAbort=True)
        for n in range(10):
            self.control('Last Frame' if n % 2 else 'First Frame').click()
            self.tick(1)
            seen = self.look(0)
            self.assertLessEqual(seen['alloc']['ops'], 4, 'XA-X17: cancelled loads still running keep their slot, so no more than four run %s' % seen['Q'])
            self.assertGreaterEqual(seen['Q']['bytes'], seen['alloc']['bytes'], 'XA-X17: the budget counts every load that has not ended %s %s' % (seen['Q'], seen['alloc']))
            self.honest(seen, 'XA-X17: the budget counts every load that has not ended')
        self.assertGreater(len(self.js('views[0].log.abortEnds')), 0, 'aborts were asked for and are still unanswered')
        self.assertEqual(self.js('views[1].log.releases'), [], 'the other viewport keeps its frame')
        self.js('endAborts(0)')
        self.tick(1)
        self.js('releaseLoad(0, 19)')  # the latest request (Last Frame) now gets its load
        self.tick(1)
        seen = self.look(0)
        self.assertEqual((seen['V'], seen['Lb'], seen['E']), (['2.25.72', 20, 1], 20, [20]), 'the latest request is the one shown')
        self.assertEqual(seen['Q']['retiring'], 0)
        self.assertEqual(self.js('views[1].log.releases'), [])
        self.drained()

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
        visible = 'on => { Object.defineProperty(document, "hidden", { configurable: true, get: () => !on }); document.dispatchEvent(new Event("visibilitychange")); }'
        self.page.evaluate(visible, False)
        self.tick(500)
        self.assertEqual(self.frames(), [1, 2, 3, 4, 5, 6])
        self.assertEqual(self.state()['phase'], 'paused')
        self.page.evaluate(visible, True)
        self.tick(500)
        self.assertEqual(self.frames(), [1, 2, 3, 4, 5, 6], 'returning to the window replays nothing')
        # Pause while frame 8 is still loading for viewport 1. Viewport 2 shows the same opening and waits for the same
        # frame, so the shared load cannot be cancelled: its answer arrives after the Pause and must still not reach
        # viewport 1's screen or restart its playback.
        self.open(1, frames=10, frameTime=20, hold=[7], sop='2.25.41')
        self.open(2, frames=10, frameTime=20, sop='2.25.41')
        self.control('Play', 1).click()
        self.tick(130)
        self.assertEqual(self.frames(1), [1, 2, 3, 4, 5, 6, 7])
        self.label('Range Start', 2).fill('8')
        self.label('Range End', 2).fill('10')
        self.control('Apply Range', 2).click()
        self.control('First Frame', 2).click()
        self.tick(20)
        expect(self.status(1)).to_contain_text('Buffering')
        self.control('Pause', 1).click()
        self.js('releaseHeld(1, 7)')
        self.tick(200)
        self.assertEqual(self.frames(2), [1, 8], 'the waiting viewport still gets its frame')
        self.assertNotIn(8, self.frames(1), 'XA-X10: a frame that had not started drawing at Pause never reaches the screen')
        self.assertEqual(self.state(1)['phase'], 'paused')
        self.assertFalse(self.state(1)['playing'])
        expect(self.control('Play', 1)).to_be_enabled()
        self.assertNotIn(7, self.js('views[2].log.calls'), 'one decode for both viewports')

    def test_xa05_account_end_and_the_same_object_reopened_drop_late_frames(self):
        self.open(0, frames=10, frameTime=20, hold=[2], sequence=1)
        self.control('Play').click()
        self.tick(100)
        self.assertEqual(self.frames(), [1, 2])
        self.js('identities[0] = { ...identities[0], sequence: 2 }')  # A -> B -> A: the same object, a new opening
        self.js('releaseHeld(0, 2)')
        self.tick(100)
        self.assertEqual(self.frames(), [1, 2], 'the old opening\'s late frame is not drawn')
        self.assertTrue(self.look(0)['C'], 'the old opening stops and hides what it showed')
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
        self.assertTrue(self.look(1)['C'], 'an ended session hides the pixels')
        expect(self.status(1)).to_contain_text('Stopped')
        self.assertIn(4, self.js('views[1].log.aborts.concat(views[1].log.releases)'), 'the window of the ended opening is given back')

    def test_xa05_render_races_follow_only_the_latest_render_request(self):
        self.open(frames=10, frameTime=20, sop=A)
        self.label('Loop').uncheck()
        # Pause while frame 3 is being drawn: nothing newer was asked, so its render stands and the label follows.
        self.hold(0, 'R', 3)
        self.control('Play').click()
        self.tick(45)
        self.assertEqual(self.frames(), [1, 2])
        self.control('Pause').click()
        self.complete(0, 'R', 3)
        self.tick(1)
        seen = self.look()
        self.assertEqual((seen['V'][1], seen['Lb'], seen['E'][-1]), (3, 3, 3), 'a render that finishes after Pause is the latest request')
        self.tick(200)
        self.assertEqual(self.frames(), [1, 2, 3], 'Pause still stops playback')
        # Seek while a render is in flight: First Frame is pending when Last Frame answers.
        self.hold(0, 'R', 1)
        self.control('First Frame').click()
        self.tick(1)
        self.control('Last Frame').click()
        self.tick(1)
        self.complete(0, 'R', 1)
        self.tick(1)
        seen = self.look()
        self.assertEqual((seen['V'][1], seen['Lb'], seen['E'][-1]), (10, 10, 10), 'XA-X15: an older render answering late never moves the label or the displayed record')
        # Frame n + 1 finishes before frame n.
        self.hold(0, 'R', 5)
        for start in ('5', '6'):
            self.label('Range Start').fill(start)
            self.label('Range End').fill('10')
            self.control('Apply Range').click()
            self.control('First Frame').click()
            self.tick(1)
        self.complete(0, 'R', 5)
        self.tick(1)
        seen = self.look()
        self.assertEqual((seen['V'][1], seen['Lb'], seen['E'][-1]), (6, 6, 6), 'XA-X15: an older render answering late never moves the label or the displayed record')
        self.assertNotIn(5, seen['E'])
        self.drained()

    def test_xa05_mismatched_or_ended_openings_load_and_render_nothing(self):
        self.open(0, frames=10, frameTime=20, manifestStudy='2.25.999')
        self.js('(() => { const c = views[0].controller; c.first(); c.play(); c.last(); })()')
        self.tick(200)
        self.assertEqual(self.js('views[0].log.calls'), [], 'XA-X18: a source that is not the opened object is never fetched')
        self.assertEqual(self.js('physical(0).log.prepares'), [], 'XA-X18: a source that is not the opened object is never fetched')
        self.assertTrue(self.look(0)['C'], 'XA-X18: a source that is not the opened object is never fetched')
        expect(self.status(0)).to_contain_text('Unavailable')
        expect(self.control('Play', 0)).to_be_disabled()
        self.open(1, frames=10, frameTime=20, sop='2.25.81', currentNull=True)
        self.js('(() => { const c = views[1].controller; c.first(); c.play(); })()')
        self.tick(200)
        self.assertEqual((self.js('views[1].log.calls'), self.js('physical(1).log.prepares')), ([], []))
        self.assertTrue(self.look(1)['C'])
        # The session ends while look-ahead answers are still arriving: from that point no load and no render.
        self.open(2, frames=30, frameTime=1000, sop='2.25.82', hold=[3, 4, 5, 6])
        self.control('Play', 2).click()
        self.tick(5)
        self.assertEqual(self.frames(2), [1])
        before = self.js('views[2].log.calls.length')
        self.js('identities[2] = null')
        self.js('releaseHeld(2, 3)')  # a look-ahead answer arrives and pumps before any playback tick
        self.tick(1)
        self.assertEqual(self.js('views[2].log.calls.length'), before, 'XA-X19: after the session ends no further frame is fetched')
        self.tick(3000)
        self.assertEqual((self.js('views[2].log.calls.length'), self.frames(2)), (before, [1]))
        self.assertTrue(self.look(2)['C'])
        # A -> B -> A with an identical-looking series: the same Study/Series/SOP opened again is a new opening.
        self.open(3, frames=10, frameTime=20, sop='2.25.83', sequence=1, hold=[2])
        self.control('Play', 3).click()
        self.tick(30)
        self.save('A1', 3)
        old_calls = self.js('saved.A1.log.calls.length')
        self.js('identities[3] = { ...identities[3], sequence: 3 }')
        self.js('releaseHeld(3, 2)')
        self.tick(200)
        self.assertEqual(self.js('frames(3, "A1")'), [1, 2], 'the old opening draws nothing more')
        self.assertEqual(self.js('saved.A1.log.calls.length'), old_calls, 'the old opening fetches nothing more')
        self.assertEqual(self.js('saved.A1.controller.state().phase'), 'stale')
        self.assertTrue(self.look(3)['C'], 'the old opening hides what it showed')
        self.open(3, frames=10, frameTime=20, sop='2.25.83', sequence=3)
        seen = self.look(3)
        self.assertEqual((seen['V'], seen['Lb'], seen['C']), (['2.25.83', 1, 3], 1, False), 'the new opening of the same object plays normally')
        self.assertEqual(self.js('frames(3, "A1")'), [1, 2])

    # -- XA06 recovery ---------------------------------------------------------------------------------------------
    def test_xa06_middle_failure_stops_at_the_last_shown_frame_and_retry_continues_there(self):
        self.open(frames=10, frameTime=20)
        self.js('failFrame(0, 6)')
        self.label('Loop').uncheck()
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
        self.assertEqual(self.look()['E'], list(range(1, 11)))

    def test_xa06_denied_codec_failure_and_prefetch_never_count_as_shown(self):
        self.open(0, frames=10, frameTime=20)
        self.js('failFrame(0, 3, 403)')
        self.control('Play').click()
        self.tick(300)
        # Frame 4 is refused while it is still look-ahead: access is about the opening, so playback stops right there
        # (round 4, EXA-R3-02; until round 3 this ran on to frame 3 and stopped only when frame 4 was due).
        self.assertEqual(self.frames(), [1])
        self.assertEqual(self.state()['failure'], {'frame': 4, 'kind': 'denied'})
        expect(self.status()).to_contain_text('Access Denied')
        self.assertTrue(self.look(0)['C'], 'refused access hides the image')
        self.assertNotIn('All Shown', self.status().inner_text())
        self.open(1, frames=12, frameTime=20, sop='2.25.61')
        self.control('Play', 1).click()
        self.tick(25)
        self.control('Pause', 1).click()
        self.tick(5)
        seen = self.look(1)
        shown = self.frames(1)
        self.assertGreater(len(seen['provided']), 0, 'frames were prepared ahead of the screen')
        self.assertEqual(seen['state']['coverage'], {'shown': len(shown), 'total': 12, 'all': False}, 'XA-X14: a prepared frame is not a shown frame')
        expect(self.status(1)).to_contain_text('Shown %d / 12' % len(shown))
        self.assertEqual(seen['E'], shown)
        self.open(2, frames=6, frameTime=20, sop='2.25.62')
        self.js('failFrame(2, 1)')
        self.control('Play', 2).click()
        self.tick(100)
        self.assertEqual(self.frames(2), [1])
        self.assertEqual(self.state(2)['failure'], {'frame': 2, 'kind': 'failed'})
        self.assertFalse(self.state(2)['coverage']['all'])

    def test_xa06_render_timeout_needs_retry_and_a_late_success_changes_nothing(self):
        # R07 (DC01): a timed-out render keeps no right to the screen, even as the latest request; only Retry makes one.
        for variant in ('subsequent', 'initial', 'during-playback'):
            with self.subTest(variant=variant):
                self.fresh()
                if variant == 'subsequent':
                    self.open(frames=10, frameTime=20, sop=A)
                    self.hold(0, 'R', 5)
                    self.seek(0, 5)
                    self.tick(1)
                    expected = (None, 1, [1], True)
                    frame = 5
                elif variant == 'during-playback':
                    self.open(frames=30, frameTime=100, sop=A)
                    self.hold(0, 'R', 2)
                    self.control('Play').click()
                    self.tick(105)
                    self.assertIn(2, self.look()['prepares'])
                    expected = (None, 1, [1], True)
                    frame = 2
                else:
                    self.hold(0, 'R', 1)
                    self.open(frames=10, frameTime=20, sop=A)
                    expected = (None, None, [], True)
                    frame = 1
                self.tick(20001)
                expect(self.status()).to_contain_text('Failed')
                seen = self.look()
                self.assertEqual((seen['V'], seen['Lb'], seen['E'], seen['C']), expected)
                self.assertEqual(seen['state']['failure'], {'frame': frame, 'kind': 'render'})
                self.complete(0, 'R', frame)
                self.tick(5)
                seen = self.look()
                self.assertEqual((seen['V'], seen['Lb'], seen['E'], seen['C']), expected, 'XA-X34: a timed-out render does not recover on its own')
                self.assertEqual(seen['state']['failure'], {'frame': frame, 'kind': 'render'}, 'XA-X34: a timed-out render does not recover on its own')
                self.assertIn(k(A, frame), seen['surfaceReleases'], 'its own surface is given back once it really ended')
                self.control('Retry').click()
                self.tick(5)
                seen = self.look()
                self.assertEqual((seen['V'][1], seen['Lb'], seen['E'][-1], seen['C']), (frame, frame, frame, False), 'Retry is a new render that may succeed')
                self.assertFalse(seen['state']['playing'], 'XA-X42: Retry after a render timeout shows one verified frame and stays paused')
                self.tick(1000)
                self.assertEqual(self.look()['published'][-1], frame, 'XA-X42: Retry after a render timeout shows one verified frame and stays paused')
                self.drained()

    # -- the consult matrix: late load (L), late decode (D), late draw (R) x eight events ----------------------------
    def wait_x(self, phase, frame=5, slot=0):
        self.hold(slot, phase, frame)
        self.seek(slot, frame)
        self.tick(1)
        seen = self.look(slot)
        if phase == 'L':
            self.assertEqual((seen['calls'].count(frame - 1), seen['decodes'].count(frame - 1)), (1, 0), 'X waits in transport')
        elif phase == 'D':
            self.assertEqual(seen['decodes'].count(frame - 1), 1, 'X waits in its decoder')
        else:
            self.assertEqual(seen['prepares'].count(frame), 1, 'X waits in its render')
        return seen

    def assert_unseen(self, seen, x, s, message):
        """Z: the old target never reaches the screen, the label or the displayed record."""
        self.assertNotIn(x, seen['published'], message)
        self.assertNotIn(x, seen['E'], message)
        if s is None:
            self.assertEqual((seen['V'], seen['Lb'], seen['C']), (None, None, True), message)
        else:
            self.assertEqual((seen['V'], seen['Lb']), (s, s[1]), message)

    def late_seek(self, phase):
        for order in ('old-first', 'new-first'):
            with self.subTest(order=order):
                self.fresh()
                self.open(0, frames=10, sop=A)
                self.wait_x(phase)
                self.hold(0, 'L', 8)
                self.seek(0, 8)
                self.tick(1)
                s = [A, 1, 1]
                self.assert_unseen(self.look(), 5, s, 'nothing newer is ready yet: the old frame stays')
                if order == 'old-first':
                    self.complete(0, phase, 5)
                    self.tick(2)
                    seen = self.look()
                    self.assert_unseen(seen, 5, s, 'XA-X23: XA-X30: an older intent\'s frame never reaches the screen')
                    self.honest(seen, 'the old work ended and gave its own back')
                    self.complete(0, 'L', 8)
                    self.tick(2)
                else:
                    self.complete(0, 'L', 8)
                    self.tick(2)
                    self.complete(0, phase, 5)
                    self.tick(2)
                seen = self.look()
                self.assertEqual((seen['V'], seen['Lb'], seen['E'], seen['C']), ([A, 8, 1], 8, [1, 8], False), 'XA-X23: XA-X30: only the newest intent is shown')
                self.assertEqual(seen['decodes'].count(4), 0 if phase == 'L' else 1, 'a late transport never starts a decoder nobody wants')
                if phase == 'D':
                    self.assertEqual(seen['releases'].count(4), 1, 'the unwanted image goes back once')
                if phase == 'R':
                    self.assertEqual(seen['surfaceReleases'].count(k(A, 5)), 1, 'the private surface goes back once')
                self.honest(seen, 'after both answers')
                self.drained()

    def late_pause(self, phase):
        variants = ('alone', 'shared') if phase != 'R' else ('alone', 'seek-before-completion')
        for variant in variants:
            with self.subTest(variant=variant):
                self.fresh()
                self.open(0, frames=30, frameTime=20, sop=A)
                if variant == 'shared':
                    self.open(1, frames=30, frameTime=20, sop=A)
                self.hold(0, phase, 5)
                self.label('Loop').uncheck()
                self.control('Play').click()
                self.tick(85)
                self.assertEqual(self.frames(), [1, 2, 3, 4])
                if variant == 'shared':
                    self.seek(1, 5)
                    self.tick(1)
                self.control('Pause').click()
                calls = self.js('alloc.calls')
                if variant == 'seek-before-completion':  # a frame beyond the look-ahead, still loading
                    self.hold(0, 'L', 25)
                    self.seek(0, 25)
                    self.tick(1)
                self.complete(0, phase, 5)
                self.tick(3)
                seen = self.look()
                self.assertFalse(seen['state']['playing'])
                if phase == 'R' and variant == 'alone':
                    self.assertEqual((seen['V'], seen['Lb'], seen['E'][-1]), ([A, 5, 1], 5, 5), 'XA-X36: a draw already under way at Pause is still shown once')
                    self.assertEqual(seen['C'], False)
                else:
                    self.assert_unseen(seen, 5, [A, 4, 1], 'XA-X10: a frame that had not started drawing at Pause is never shown')
                self.tick(300)
                self.assertEqual(self.js('alloc.calls'), calls + (1 if variant == 'seek-before-completion' else 0), 'Pause starts nothing by itself')
                if variant == 'shared':
                    other = self.look(1)
                    self.assertEqual((other['V'], other['Lb'], other['E'][-1]), ([A, 5, 1], 5, 5), 'the other viewport still gets the shared frame')
                    self.assertEqual(self.js('views[0].log.calls.filter(i => i === 4).length + views[1].log.calls.filter(i => i === 4).length'), 1)
                    self.assertEqual(self.js('views[1].log.releases'), [])
                self.honest(self.look(), 'after Pause')
                if variant == 'seek-before-completion':
                    self.complete(0, 'L', 25)
                    self.tick(2)
                    self.assertEqual(self.look()['Lb'], 25)
                self.drained()

    def late_range(self, phase):
        for start, first in (('5', 5), ('6', 6)):
            with self.subTest(range=start + '..10'):
                self.fresh()
                self.open(0, frames=10, sop=A)
                self.wait_x(phase)
                self.label('Range Start').fill(start)
                self.label('Range End').fill('10')
                self.control('Apply Range').click()
                calls = self.js('alloc.calls')
                self.complete(0, phase, 5)
                self.tick(3)
                seen = self.look()
                self.assert_unseen(seen, 5, [A, 1, 1], 'XA-X23: a range change ends the old intent even inside the new range')
                self.assertIn('Shown 0 / %d' % (11 - first), seen['status'], 'the new range starts uncovered')
                self.assertFalse(seen['state']['playing'])
                self.assertEqual(self.js('alloc.calls'), calls, 'applying a range starts nothing')
                self.control('First Frame').click()
                self.tick(3)
                seen = self.look()
                self.assertEqual((seen['V'], seen['Lb'], seen['E'][-1]), ([A, first, 1], first, first))
                self.drained()

    def late_reopen(self, phase):
        self.open(0, frames=10, sop=A, sequence=1, settle=False, **({'holdLoad': [0]} if phase == 'L' else {'holdDecode': [0]} if phase == 'D' else {}))
        if phase == 'R':
            self.hold(0, 'R', 1)
        self.tick(1)
        self.save('A1', 0)
        self.open(0, frames=10, sop=B, study='2.25.21', sequence=2)
        seen = self.look(0)
        self.assertEqual((seen['V'], seen['C']), ([B, 1, 2], False))
        self.open(0, frames=10, sop=A, sequence=3, settle=False, holdLoad=[0])
        seen = self.look(0)
        self.assertEqual((seen['V'], seen['C'], seen['Lb'], seen['E']), (None, True, None, []), 'a new opening starts covered, before anything else')
        self.tick(1)
        a1_calls = self.js('saved.A1.log.calls.length')
        self.complete(0, phase, 1, name='A1')
        self.tick(3)
        seen = self.look(0)
        self.assertEqual((seen['V'], seen['C'], seen['Lb'], seen['E']), (None, True, None, []), 'A1 answering late changes nothing for A3')
        self.assertEqual(self.js('saved.A1.log.calls.length'), a1_calls)
        self.assertEqual(self.js('frames(0, "A1")'), [])
        self.assertEqual(seen['calls'].count(0), 1, 'A3 fetched its own frame; it never joined A1\'s')
        self.js('releaseLoad(0, 0)')
        self.tick(3)
        seen = self.look(0)
        self.assertEqual((seen['V'], seen['C'], seen['Lb'], seen['E']), ([A, 1, 3], False, 1, [1]))
        self.js('saved.A1.controller.dispose()')
        self.tick(3)
        seen = self.look(0)
        self.assertEqual((seen['V'], seen['C'], seen['Lb']), ([A, 1, 3], False, 1), 'the old mount closing touches nothing of the new one')
        self.honest(seen, 'three openings on one viewport')
        self.drained()

    def late_session(self, phase):
        for variant in ('session-end', 'owner-dispose'):
            with self.subTest(variant=variant):
                self.fresh()
                self.open(0, frames=10, sop=A, sequence=1, session='S1')
                self.wait_x(phase)
                self.save('old', 0)
                held = self.look(0)
                if variant == 'session-end':
                    self.js('endSession(0)')
                else:
                    self.js('views[0].controller.dispose()')
                self.assertTrue(self.look(0, 'old')['C'], 'hidden at once, before any timer')
                if phase == 'R':
                    self.assertNotIn(k(A, 5), self.look(0, 'old')['surfaceReleases'], 'a surface still being drawn is not given back')
                    self.assertNotIn(4, self.look(0, 'old')['releases'])
                self.open(0, frames=10, sop=A, sequence=2, session='S2')
                seen = self.look(0)
                self.assertEqual((seen['V'], seen['C'], seen['Lb'], seen['E']), ([A, 1, 2], False, 1, [1]), 'the new epoch shows its own first frame')
                self.complete(0, phase, 5, name='old')
                self.tick(3)
                seen = self.look(0)
                self.assertEqual((seen['V'], seen['C'], seen['Lb'], seen['E']), ([A, 1, 2], False, 1, [1]), 'the old epoch answering late changes nothing')
                self.assertEqual(self.js('frames(0, "old")'), [1])
                self.assertEqual(len(self.look(0, 'old')['calls']), len(held['calls']))
                self.honest(seen, 'two epochs')
                self.drained()

    def late_pressure(self, phase):
        if phase == 'R':
            # S: 32 MiB payload + 32 MiB front; X: 32 + 32 drawing. 128 MiB in use, every byte of it real.
            self.open(0, frames=10, rows=4096, cols=2048, sop=A)
            self.wait_x('R')
            self.hold(0, 'L', 8)
            self.seek(0, 8)
            self.tick(3)
            seen = self.look()
            self.assertEqual(seen['Q']['bytes'], LIMIT)
            self.assertEqual((seen['calls'].count(7), seen['prepares'].count(8)), (0, 0), 'XA-X28: no new frame while the drawing one still holds its memory')
            self.assertNotIn(4, seen['releases'], 'XA-X28: a frame still being drawn is never given back')
            self.assertNotIn(k(A, 5), seen['surfaceReleases'], 'XA-X28: a frame still being drawn is never given back')
            self.assertEqual((seen['V'], seen['Lb']), ([A, 1, 1], 1))
            self.honest(seen, 'at the limit')
            self.complete(0, 'R', 5)
            self.tick(3)
            seen = self.look()
            self.assert_unseen(seen, 5, [A, 1, 1], 'the superseded draw ends without showing')
            self.assertEqual(seen['calls'].count(7), 1, 'only now, with its memory really back, the new frame is fetched')
            self.complete(0, 'L', 8)
            self.tick(3)
            seen = self.look()
            self.assertEqual((seen['V'], seen['Lb'], seen['E'][-1]), ([A, 8, 1], 8, 8))
            self.honest(seen, 'after the new frame')
            self.drained()
            return
        self.open(0, frames=10, sop=A)
        self.wait_x(phase)
        self.open(1, frames=10, sop=B, hold='all', lateAbort=True, settle=False)
        self.tick(1)
        for frame in (2, 3, 4):
            self.seek(1, frame)
            self.tick(1)
        seen = self.look(0)
        self.assertEqual(seen['Q']['loading'], 4, 'four permits in use')
        calls = self.js('alloc.calls')
        self.seek(1, 5)
        self.tick(2)
        self.assertEqual(self.js('alloc.calls'), calls, 'a fifth load never starts')
        self.honest(self.look(0), 'XA-X27: at the decode limit, cancelled loads still count')
        if phase == 'D':
            self.js('endAborts(1)')
            self.tick(2)
            self.assertGreater(self.js('alloc.calls'), calls, 'only a really ended load lets the waiting one in')
            self.honest(self.look(0), 'after real ends')
        self.complete(0, phase, 5)
        self.tick(3)
        seen = self.look(0)
        self.assertEqual((seen['V'], seen['Lb'], seen['E']), ([A, 5, 1], 5, [1, 5]), 'the current frame is shown exactly once')
        self.assertEqual(seen['published'].count(5), 1)
        self.assertEqual(self.js('views[1].log.releases'), [], 'the other viewport loses nothing')
        self.js('endAborts(1)')
        self.js('(() => { for (const [i, go] of views[1].log.loads) go(); return true; })()')
        self.tick(3)
        self.drained()

    def late_timeout(self, phase):
        for variant in ('retry-after-arrival', 'retry-before-arrival'):
            with self.subTest(variant=variant):
                self.fresh()
                self.open(0, frames=10, sop=A, lateAbort=True)  # the timed-out transport keeps running after its abort
                self.wait_x(phase)
                self.tick(20001)
                expect(self.status()).to_contain_text('Failed')
                seen = self.look()
                self.assertEqual((seen['V'], seen['C'], seen['Lb'], seen['E']), (None, True, 1, [1]), 'timeout covers without altering display facts')
                self.assertGreaterEqual(seen['Q']['loading'], 1, 'the timed-out work still holds its permit')
                self.honest(seen, 'after the timeout')
                if variant == 'retry-after-arrival':
                    self.complete(0, phase, 5)
                    self.tick(3)
                    seen = self.look()
                    self.assertEqual((seen['V'], seen['C'], seen['Lb'], seen['E']), (None, True, 1, [1]), 'late timeout arrival is not success')
                    self.assertEqual(seen['state']['failure'], {'frame': 5, 'kind': 'timeout'})
                    self.control('Retry').click()
                    self.tick(3)
                else:
                    self.control('Retry').click()
                    self.tick(3)
                    self.assertEqual(self.look()['calls'].count(4), 1, 'Retry never joins or restarts the ending load')
                    self.complete(0, phase, 5)
                    self.tick(3)
                seen = self.look()
                self.assertEqual(seen['calls'].count(4), 2, 'Retry fetched the frame again, after the old load ended')
                self.assertEqual((seen['V'], seen['Lb'], seen['E']), ([A, 5, 1], 5, [1, 5]))
                self.drained()

    def late_abort(self, phase):
        if phase == 'D':
            self.open(0, frames=10, sop=A)
            for frame in (2, 3, 4, 5, 6, 7, 8, 9, 2, 3):
                self.hold(0, 'D', frame)
                self.seek(0, frame)
                self.tick(1)
                seen = self.look()
                self.assertLessEqual(seen['alloc']['decoders'], 4, 'XA-X27: cancelled decoders still count against the four')
                self.assertGreaterEqual(seen['Q']['loading'], seen['alloc']['ops'], 'XA-X27: cancelled decoders still count against the four')
                self.honest(seen, 'XA-X27: cancelled decoders still count against the four')
            for _ in range(12):
                pending = self.js('[...views[0].log.decodesHeld.keys()].reverse()')
                if not pending:
                    break
                for index in pending:
                    self.js('([i]) => { const f = views[0].log.decodesHeld.get(i); views[0].log.decodesHeld.delete(i); f("ok"); return true; }', [index])
                    self.tick(1)
                    self.honest(self.look(), 'while the old decoders end')
            seen = self.look()
            self.assertEqual((seen['V'], seen['Lb'], seen['E']), ([A, 3, 1], 3, [1, 3]), 'only the last intent is shown')
            self.assertEqual(seen['published'], [1, 3])
            self.assertEqual(sorted(seen['releases']), [1, 2, 3, 4], 'every cancelled decoder\'s image goes back exactly once')
            self.drained()
            return
        variants = ('abort-ends', 'late-success', 'dispose') if phase == 'L' else ('success', 'reject')
        for variant in variants:
            with self.subTest(variant=variant):
                self.fresh()
                self.open(0, frames=10, sop=A, lateAbort=True)
                self.wait_x(phase)
                if variant == 'dispose':
                    self.save('gone', 0)
                    self.js('views[0].controller.dispose()')
                else:
                    self.seek(0, 8)
                    self.tick(2)
                    self.assertEqual(self.look()['Lb'], 8)
                seen = self.look(0, 'gone' if variant == 'dispose' else None)
                if phase == 'L':
                    self.assertEqual(seen['releases'].count(4), 0)
                    self.assertGreaterEqual(seen['Q']['loading'], 1, 'an abort asked for is not an abort done')
                else:
                    self.assertNotIn(k(A, 5), seen['surfaceReleases'], 'XA-X28: a draw asked to stop keeps its surface until it ends')
                    self.assertNotIn(4, seen['releases'], 'XA-X28: a draw asked to stop keeps its frame until it ends')
                self.honest(seen, 'abort requested')
                if phase == 'L':
                    if variant == 'late-success':
                        self.complete(0, 'L', 5, name=None)
                    else:
                        self.js('endAborts(0, %s)' % ('"gone"' if variant == 'dispose' else 'undefined'))
                    self.tick(3)
                    self.js('endAborts(0, %s)' % ('"gone"' if variant == 'dispose' else 'undefined'))  # a duplicate end changes nothing
                else:
                    self.complete(0, 'R', 5, how='ok' if variant == 'success' else 'reject')
                    self.tick(3)
                if variant != 'dispose':
                    seen = self.look()
                    self.assert_unseen(seen, 5, [A, 8, 1], 'a late end after an abort shows nothing')
                    self.assertEqual(seen['E'], [1, 8])
                    if phase == 'R':
                        self.assertNotIn(k(A, 8), seen['surfaceReleases'], 'the new front is never given back by the old draw')
                    self.honest(seen, 'after the late end')
                self.drained()

    # L01..L08, D01..D08, R01..R08 (R07 is test_xa06_render_timeout_needs_retry_and_a_late_success_changes_nothing)
    def test_l01_late_load_seek(self): self.late_seek('L')
    def test_l02_late_load_pause(self): self.late_pause('L')
    def test_l03_late_load_range(self): self.late_range('L')
    def test_l04_late_load_reopen(self): self.late_reopen('L')
    def test_l05_late_load_session(self): self.late_session('L')
    def test_l06_late_load_pressure(self): self.late_pressure('L')
    def test_l07_late_load_timeout(self): self.late_timeout('L')
    def test_l08_late_load_abort(self): self.late_abort('L')
    def test_d01_late_decode_seek(self): self.late_seek('D')
    def test_d02_late_decode_pause(self): self.late_pause('D')
    def test_d03_late_decode_range(self): self.late_range('D')
    def test_d04_late_decode_reopen(self): self.late_reopen('D')
    def test_d05_late_decode_session(self): self.late_session('D')
    def test_d06_late_decode_pressure(self): self.late_pressure('D')
    def test_d07_late_decode_timeout(self): self.late_timeout('D')
    def test_d08_late_decode_abort(self): self.late_abort('D')
    def test_r01_late_draw_seek(self): self.late_seek('R')
    def test_r02_late_draw_pause(self): self.late_pause('R')
    def test_r03_late_draw_range(self): self.late_range('R')
    def test_r04_late_draw_reopen(self): self.late_reopen('R')
    def test_r05_late_draw_session(self): self.late_session('R')
    def test_r06_late_draw_pressure(self): self.late_pressure('R')
    def test_r08_late_draw_abort(self): self.late_abort('R')

    # -- the consult's boundary cases ------------------------------------------------------------------------------
    def test_b01_no_load_starts_after_the_gate_closes_between_admission_and_the_call(self):
        actions = {'identity-end': 'identities[0] = null', 'identity-replace': 'identities[0] = { ...identities[0], sequence: 9 }',
                   'seek-again': 'c.seek(8)', 'dispose': 'c.dispose()', 'control': ''}
        for variant, action in actions.items():
            with self.subTest(variant=variant):
                self.fresh()
                self.open(0, frames=10, sop=A)
                before = self.look()
                self.js('() => { const c = views[0].controller; c.seek(5); %s; return true; }' % action)
                self.tick(3)
                seen = self.look()
                if variant == 'control':
                    self.assertEqual((seen['calls'].count(4), seen['Lb']), (1, 5))
                    self.drained()
                    continue
                self.assertEqual(seen['calls'].count(4), 0, 'XA-X24: the gate decides at the call itself, not when the request was queued')
                self.assertNotIn(5, seen['prepares'])
                self.assertNotIn(5, seen['E'])
                self.assertEqual(seen['releases'].count(4), 0)
                if variant.startswith('identity'):
                    self.assertTrue(seen['C'])
                if variant != 'dispose':
                    self.assertLessEqual(seen['Q']['prepared'], before['Q']['prepared'] + (1 if variant == 'seek-again' else 0), 'the provisional reservation came back')
                self.honest(seen, 'after the refused call')
                self.drained()

    def test_b02_an_intent_change_before_or_during_the_draw_keeps_the_screen(self):
        for variant in ('seek-at-provided', 'back-to-shown-while-drawing', 'many-clicks'):
            with self.subTest(variant=variant):
                self.fresh()
                self.open(0, frames=10, sop=A)
                if variant == 'seek-at-provided':
                    self.js('window.onEvent = (slot, e) => { if (slot === 0 && e.type === "provided" && e.frame === 5) views[0].controller.seek(1); }')
                    self.seek(0, 5)
                    self.tick(3)
                    seen = self.look()
                    self.assertNotIn(5, seen['prepares'], 'a queued draw of a superseded frame never starts')
                elif variant == 'back-to-shown-while-drawing':
                    self.hold(0, 'R', 5)
                    self.seek(0, 5)
                    self.tick(1)
                    self.seek(0, 1)
                    self.complete(0, 'R', 5)
                    self.tick(3)
                    seen = self.look()
                else:
                    self.js('(() => { const c = views[0].controller; for (let i = 0; i < 30; i++) c.seek(2 + (i % 8)); c.seek(1); return true; })()')
                    self.tick(5)
                    seen = self.look()
                    self.assertLessEqual(seen['Q']['prepared'], 5, 'old clicks do not pile up work')
                self.assertEqual((seen['V'], seen['Lb'], seen['E'], seen['C']), ([A, 1, 1], 1, [1], False), 'XA-X23: the frame already shown stays, nothing new is recorded')
                self.honest(seen, 'after the intents')
                self.drained()

    def test_b03_only_an_exact_receipt_or_identity_is_published(self):
        for how in ('wrong-sop', 'wrong-frame', 'wrong-opening', 'wrong-draw', 'no-surface', 'foreign-handle', 'reject', 'foreign-image', 'exact'):
            with self.subTest(result=how):
                self.fresh()
                if how == 'foreign-image':
                    self.open(0, frames=10, sop=A, settle=False, holdDecode=[0])
                    self.tick(1)
                    self.js('finishDecode(0, 0, "foreign")')
                else:
                    self.hold(0, 'R', 1)
                    self.open(0, frames=10, sop=A)
                    self.complete(0, 'R', 1, how='ok' if how == 'exact' else how)
                self.tick(3)
                seen = self.look()
                if how == 'exact':
                    self.assertEqual((seen['V'], seen['Lb'], seen['E'], seen['C']), ([A, 1, 1], 1, [1], False))
                    self.drained()
                    continue
                self.assertEqual((seen['V'], seen['Lb'], seen['E'], seen['C']), (None, None, [], True), 'XA-X31: a result that is not exactly this draw is never shown')
                self.assertEqual(seen['published'], [], 'XA-X31: a result that is not exactly this draw is never shown')
                expect(self.status()).to_contain_text('Failed')
                if how == 'foreign-image':
                    self.assertEqual((seen['prepares'], seen['releases']), ([], [0]), 'a foreign image is refused before any draw and given back')
                else:
                    self.assertEqual(seen['surfaceReleases'], [k(A, 1)], 'the refused draw gives back exactly the surface issued to it')
                self.control('Retry').click()
                self.tick(3)
                seen = self.look()
                self.assertEqual((seen['V'], seen['Lb'], seen['E'], seen['C']), ([A, 1, 1], 1, [1], False), 'Retry with an exact result')
                self.drained()

    def test_b04_displayed_follows_the_published_render_exactly_once(self):
        for handler in ('none', 'seek', 'end', 'throw'):
            with self.subTest(handler=handler):
                self.fresh()
                self.open(0, frames=10, sop=A)
                self.hold(0, 'R', 5)
                self.seek(0, 5)
                self.tick(1)
                seen = self.look()
                self.assertEqual((seen['Lb'], seen['E']), (1, [1]), 'XA-X32: nothing is shown or recorded before the render completes')
                self.assertEqual(seen['state']['coverage']['shown'], 1, 'XA-X32: nothing is shown or recorded before the render completes')
                script = {'none': '', 'seek': 'views[0].controller.seek(8);', 'end': 'endSession(0);', 'throw': 'throw Error("observer");'}[handler]
                self.js('window.onEvent = (slot, e) => { if (slot === 0 && e.type === "displayed" && e.frame === 5) { %s } }' % script)
                calls = self.js('alloc.calls')
                self.complete(0, 'R', 5)
                self.tick(3)
                seen = self.look()
                self.assertEqual(seen['E'].count(5), 1, 'one published render, one displayed fact')
                self.assertEqual(self.js('events.filter(e => e.type === "displayed" && e.frame === 5).map(e => [e.sop, e.sequence])'), [[A, 1]])
                if handler == 'seek':
                    self.assertEqual(self.js('alloc.calls'), calls + 1, 'only the new intent fetches')
                if handler == 'end':
                    self.assertTrue(seen['C'])
                self.js('window.onEvent = null')
                self.honest(seen, 'after the observer')
                self.drained()

    def test_b06_one_opening_two_viewports_share_a_load_through_the_source_that_made_it(self):
        self.open(0, frames=10, sop=A)
        self.open(1, frames=10, sop=A)
        self.hold(0, 'L', 5)
        self.seek(0, 5)
        self.tick(1)
        self.seek(1, 5)
        self.tick(1)
        self.save('first', 0)
        self.js('views[0].controller.dispose()')
        self.tick(2)
        self.assertNotIn(4, self.js('saved.first.log.aborts'), 'the load is still wanted by the other viewport')
        self.complete(0, 'L', 5, name='first')
        self.tick(3)
        seen = self.look(1)
        self.assertEqual((seen['V'], seen['Lb'], seen['E'][-1]), ([A, 5, 1], 5, 5), 'XA-X26: the remaining viewport still gets the shared frame')
        self.assertEqual((self.js('saved.first.log.calls').count(4), self.js('views[1].log.calls').count(4)), (1, 0), 'one load for both')
        self.js('views[1].controller.dispose()')
        self.tick(3)
        self.assertEqual(self.js('saved.first.log.releases').count(4), 1, 'given back through the source that supplied it, once')
        self.drained()

    def test_b08_the_same_frame_of_another_opening_is_fetched_on_its_own(self):
        self.open(0, frames=10, sop=A, sequence=1)
        self.open(1, frames=10, sop=A, sequence=2)
        self.open(2, frames=10, sop=A, sequence=1, account='other')
        self.open(3, frames=10, sop=A, sequence=1, revision='r2')
        calls = [self.js('views[%d].log.calls' % slot) for slot in range(4)]
        self.assertEqual(calls, [[0], [0], [0], [0]], 'XA-X22: no opening joins another opening\'s load')
        for slot, seq in ((0, 1), (1, 2), (2, 1), (3, 1)):
            self.assertEqual(self.look(slot)['V'], [A, 1, seq])
        self.drained()

    def test_b09_a_shared_payload_counts_once_and_every_surface_on_its_own(self):
        self.open(2, frames=4, rows=4096, cols=2048, sop=B)                 # 32 + 32 MiB
        self.open(0, frames=4, rows=2048, cols=2048, sop=A)                 # 16 + 16 MiB
        self.open(1, frames=4, rows=2048, cols=2048, sop=A)                 # + 16 MiB surface, the payload is shared
        self.open(3, frames=4, rows=2048, cols=2048, sop=A)                 # + 16 MiB surface
        seen = self.look(3)
        self.assertEqual(seen['Q']['bytes'], LIMIT, '64 + 16 + 3 x 16; XA-X25: every surface is reserved on its own')
        self.assertEqual(sum(self.js('views[%d].log.calls.length' % s) for s in (0, 1, 3)), 1, 'one load for the shared frame')
        self.assertGreaterEqual(seen['Q']['bytes'], seen['alloc']['bytes'], 'XA-X25: every surface is reserved on its own')
        self.seek(3, 2)
        self.tick(3)
        seen = self.look(3)
        self.assertEqual(seen['calls'], [], 'no room: nothing is fetched')
        self.honest(seen, 'XA-X25: every surface is reserved on its own')
        self.js('views[2].controller.dispose()')
        self.tick(5)
        seen = self.look(3)
        self.assertEqual((seen['V'], seen['Lb']), ([A, 2, 1], 2), 'after real returns it proceeds')
        for slot in (0, 1):
            self.assertEqual(self.look(slot)['V'], [A, 1, 1], 'the other viewports keep their screens')
        self.drained()

    def test_b10_a_new_opening_stays_covered_until_its_own_first_render_is_published(self):
        for variant in ('render-fails', 'render-times-out', 'a-b-a'):
            with self.subTest(variant=variant):
                self.fresh()
                self.open(0, frames=10, sop=A, sequence=1)
                self.assertEqual(self.look(0)['V'], [A, 1, 1])
                self.save('A1', 0)
                self.hold(0, 'R', 1, sop=B)
                self.open(0, frames=10, sop=B, study='2.25.21', sequence=2, settle=False)
                seen = self.look(0)
                self.assertEqual((seen['V'], seen['C'], seen['Lb'], seen['E']), (None, True, None, []), 'covered from the claim on')
                self.tick(2)
                seen = self.look(0)
                self.assertEqual((seen['V'], seen['C'], seen['Lb']), (None, True, None), 'XA-X33: a decoded frame is not a shown frame: still covered')
                if variant == 'render-fails':
                    self.complete(0, 'R', 1, how='reject', sop=B)
                    self.tick(2)
                    self.js('saved.A1.controller.dispose()')
                    self.tick(2)
                    self.assertTrue(self.look(0)['C'], 'a failed first render and the old mount closing keep the cover')
                    self.control('Retry').click()
                elif variant == 'render-times-out':
                    self.tick(20001)
                    self.complete(0, 'R', 1, sop=B)
                    self.tick(2)
                    self.assertTrue(self.look(0)['C'], 'a timed-out first render keeps the cover even when it answers')
                    self.control('Retry').click()
                else:
                    self.complete(0, 'R', 1, sop=B)
                    self.tick(2)
                    self.assertEqual(self.look(0)['V'], [B, 1, 2])
                    self.open(0, frames=10, sop=A, sequence=3, settle=False, holdLoad=[0])
                    self.js('saved.A1.controller.dispose()')
                    self.tick(2)
                    self.assertEqual((self.look(0)['V'], self.look(0)['C']), (None, True))
                    self.js('releaseLoad(0, 0)')
                self.tick(3)
                seen = self.look(0)
                expected = [A, 1, 3] if variant == 'a-b-a' else [B, 1, 2]
                self.assertEqual((seen['V'], seen['C'], seen['Lb'], seen['E']), (expected, False, 1, [1]))
                self.drained()

    def test_b11_failures_keep_the_screen_they_found_and_never_fake_success(self):
        for variant in ('codec-after-shown', 'first-render-fails', 'denied'):
            with self.subTest(variant=variant):
                self.fresh()
                if variant == 'first-render-fails':
                    self.hold(0, 'R', 1)
                    self.open(0, frames=10, sop=A)
                    self.complete(0, 'R', 1, how='reject')
                    self.tick(2)
                    seen = self.look()
                    self.assertEqual((seen['V'], seen['C'], seen['Lb'], seen['E']), (None, True, None, []))
                    retry_frame = 1
                else:
                    self.open(0, frames=10, sop=A)
                    self.js('failFrame(0, 4%s)' % (', 403' if variant == 'denied' else ''))
                    self.seek(0, 5)
                    self.tick(3)
                    seen = self.look()
                    if variant == 'denied':
                        self.assertTrue(seen['C'], 'refused access hides at once')
                        expect(self.status()).to_contain_text('Access Denied')
                    else:
                        self.assertEqual((seen['V'], seen['C'], seen['Lb'], seen['E']), (None, True, 1, [1]), 'D783: a failed frame covers the preserved last display')
                        expect(self.status()).to_contain_text('Failed')
                    self.js('healFrame(0, 4)')
                    retry_frame = 5
                self.assertNotIn('All Shown', self.status().inner_text())
                self.control('Retry').click()
                self.tick(3)
                seen = self.look()
                self.assertEqual((seen['V'][1], seen['C'], seen['Lb'], seen['E'][-1]), (retry_frame, False, retry_frame, retry_frame), 'Retry, and only Retry, recovers')
                self.drained()

    # -- round 4 (Astra review of 61eb967) ---------------------------------------------------------------------------
    def test_exa_r3_01_a_receipt_naming_another_draws_surface_is_never_published_or_given_back(self):
        # The renderer answers frame 5 with the surface on screen (frame 1): once with this draw's own token, SOP and
        # frame, once with another token as well. Neither may publish, relabel or record frame 5, and neither may
        # free the front it names; the failed draw gives back only the surface issued to it.
        for how in ('front-surface', 'wrong-draw-front-surface'):
            with self.subTest(receipt=how):
                self.fresh()
                self.open(0, frames=10, sop=A)
                self.hold(0, 'R', 5)
                self.seek(0, 5)
                self.tick(1)
                self.complete(0, 'R', 5, how=how)
                self.tick(3)
                seen = self.look()
                self.assertEqual((seen['V'], seen['Lb'], seen['E'], seen['C']), (None, 1, [1], True),
                                 'XA-X38: only the surface issued to this draw is published')
                self.assertEqual((seen['published'], seen['state']['coverage']['shown']), ([1], 1), 'XA-X38: only the surface issued to this draw is published')
                self.assertNotIn(k(A, 1), seen['surfaceReleases'], 'XA-X39: a refused receipt never gives back the front it names')
                self.assertEqual(seen['surfaceReleases'], [k(A, 5)], 'XA-X39: a refused receipt never gives back the front it names')
                expect(self.status()).to_contain_text('Failed')
                self.honest(seen, 'after the refused receipt')
                self.control('Retry').click()
                self.tick(3)
                seen = self.look()
                self.assertEqual((seen['V'], seen['Lb'], seen['E'], seen['C']), ([A, 5, 1], 5, [1, 5], False), 'the front was still owned: Retry replaces it normally')
                self.assertEqual(sorted(seen['surfaceReleases']), sorted([k(A, 5), k(A, 1)]), 'the old front goes back once, after it was replaced')
                self.drained()

    def test_exa_r3_02_a_403_on_a_look_ahead_frame_covers_stops_and_ends_everything_pending(self):
        self.open(0, frames=30, frameTime=1000, sop=A, holdLoad=[4])
        self.js('failFrame(0, 4, 403)')
        self.hold(0, 'R', 2)
        self.control('Play').click()
        self.tick(1001)
        seen = self.look()
        self.assertEqual((seen['prepares'].count(2), seen['state']['playing'], seen['C']), (1, True, False), 'frame 2 is being drawn while frame 5 is still on its way')
        self.js('releaseLoad(0, 4)')  # frame 5, fetched only as look-ahead, is refused
        self.tick(2)
        seen = self.look()
        self.assertTrue(seen['C'], 'XA-X40: a 401/403 on any request of the opening covers at once')
        self.assertFalse(seen['state']['playing'], 'XA-X40: a 401/403 on any request of the opening covers at once')
        self.assertEqual(seen['state']['failure'], {'frame': 5, 'kind': 'denied'})
        expect(self.status()).to_contain_text('Access Denied')
        calls = len(seen['calls'])
        self.complete(0, 'R', 2)  # the draw under way at the refusal answers afterwards
        self.tick(3000)
        seen = self.look()
        self.assertNotIn(2, seen['published'], 'a draw pending at the refusal is never published')
        self.assertEqual((seen['Lb'], seen['E'], seen['C']), (1, [1], True))
        self.assertEqual(len(seen['calls']), calls, 'no new load after the refusal')
        self.honest(seen, 'after the refusal')
        self.js('healFrame(0, 4)')
        self.control('Retry').click()  # Retry asks for access again
        self.tick(3)
        seen = self.look()
        self.assertEqual((seen['V'], seen['C'], seen['Lb']), ([A, 5, 1], False, 5))
        self.assertFalse(seen['state']['playing'], 'D757 access recovery ends Paused')
        self.drained()

    def test_exa_r3_03_a_new_opening_whose_cover_fails_never_loads_or_shows_over_the_previous_study(self):
        for variant in ('cover-throws', 'cover-and-clear-throw'):
            with self.subTest(variant=variant):
                self.fresh()
                self.open(0, frames=10, sop=A, sequence=1)
                self.save('A1', 0)
                self.js('''([both]) => {
                  const p = physical(0), cover = p.cover, clear = p.clear; window.screenOk = false;
                  p.cover = on => { if (on && !window.screenOk) throw Error('cover unavailable'); return cover(on); };
                  if (both) p.clear = () => { if (!window.screenOk) throw Error('clear unavailable'); return clear(); };
                  return true; }''', [variant == 'cover-and-clear-throw'])
                self.open(0, frames=10, sop=B, study='2.25.21', sequence=2)
                seen = self.look(0)
                self.assertEqual((seen['calls'], seen['prepares'], seen['Lb'], seen['E']), ([], [], None, []),
                                 'XA-X41: without a cover the new opening never loads or draws over the previous Study')
                self.assertEqual(seen['state']['failure'], {'frame': 1, 'kind': 'cover'})
                expect(self.status()).to_contain_text('Failed')
                expect(self.control('Retry')).to_be_visible()
                if variant == 'cover-throws':
                    self.assertIsNone(seen['pixel'], 'XA-X41: the previous Study is cleared when it cannot be covered')
                else:
                    self.assertEqual(seen['pixel'], [A, 1, 1], 'nothing could hide it: the failure says so and nothing is drawn over it')
                    self.control('Retry').click()
                    self.tick(3)
                    self.assertEqual((self.look(0)['calls'], self.look(0)['state']['failure']['kind']), ([], 'cover'), 'Retry waits until the previous image can be hidden')
                self.js('window.screenOk = true')
                self.control('Retry').click()
                self.tick(3)
                seen = self.look(0)
                self.assertEqual((seen['V'], seen['C'], seen['Lb'], seen['E']), ([B, 1, 2], False, 1, [1]))
                self.drained()


    # D757: the source reports HTTP outcomes independently of mayDecode and consumer lifetime. The renderer has
    # no policy: commands and late results reach the product gate, and pixels/calls/facts are read independently.
    def deny(self, index=0, status=403, slot=0, name=None):
        self.js('([s,i,code,name]) => rejectTransport(s,i,code,name)', [slot, index, status, name])
        self.tick(1)

    def auth(self, how='ok'):
        self.js('how => finishAuth(0,how)', how)
        self.tick(3)

    def device_fault(self, on=True):
        self.js('''on => {
          const p=physical(0); window.deviceOk=!on;
          if (!window.deviceOriginal) {
            window.deviceOriginal={cover:p.cover,clear:p.clear};
            p.cover=v=>{ if(!window.deviceOk) throw Error('cover device fault'); return deviceOriginal.cover(v); };
            p.clear=()=>{ if(!window.deviceOk) throw Error('clear device fault'); return deviceOriginal.clear(); };
          }
        }''', on)

    def test_c01_late_denial_keeps_request_opening_after_consumer_zero(self):
        for status in (401, 403):
            for stage in ('L', 'D'):
                for before in (False, True):
                    with self.subTest(status=status, stage=stage, before=before):
                        self.fresh(); self.open(sop=A, frames=20, lateAbort=True)
                        self.hold(0, stage, 5); self.seek(0, 5); self.tick(2)
                        if before: self.hold(0, 'L', 10)
                        self.seek(0, 10); self.tick(2)
                        self.deny(4, status)
                        s = self.look()
                        self.assertEqual((s['state']['openingState'], s['C'], s['state']['playing']),
                                         ('AccessBlocked', True, False), 'XA-X44: consumer-zero late refusal blocks its living opening')
                        before_calls = s['calls']
                        self.js('views[0].controller.first(); views[0].controller.play()'); self.tick(5)
                        self.assertEqual(self.look()['calls'], before_calls)
                        self.js('endAborts(0)'); self.drained()

    def test_c02_cached_first_waits_for_fresh_authorization(self):
        self.open(sop=A, frames=20, authHold=True)
        self.seek(0, 2); self.tick(2); self.deny(1)
        s = self.look()
        self.control('First Frame').click(); self.js('views[0].controller.first()'); self.tick(3)
        after = self.look()
        self.assertEqual((after['published'], after['E'], after['C'], after['auth']),
                         (s['published'], s['E'], True, 0), 'XA-X48: cached First cannot publish through the blocked gate')
        for proof in ('cache', 'foreign', 'fail'):
            self.js('views[0].controller.retry()'); self.auth(proof)
            self.assertEqual(self.state()['openingState'], 'AccessBlocked')
        self.js('views[0].controller.retry()'); self.tick(2)
        self.assertTrue(self.look()['C'])
        self.auth()
        self.assertEqual((self.look()['V'], self.state()['openingState'], self.state()['playing']), ([A, 2, 1], 'Active', False))
        self.drained()

    def test_c03_device_fault_is_not_a_setting_and_retry_needs_safety(self):
        self.open(sop=A); self.save('old'); self.device_fault()
        self.open(sop=B, study='2.25.21', sequence=2)
        self.label('Playback Direction').select_option('reverse'); self.js('views[0].controller.play()'); self.tick(3)
        s = self.look()
        self.assertEqual((s['state']['openingState'], s['calls'], s['published']), ('CoverFailed', [], []),
                         'XA-X43: direction cannot clear device or access latch')
        self.assertEqual(s['V'], [A, 1, 1], 'both physical methods really failed; do not claim hidden pixels')
        self.js('views[0].controller.retry()'); self.tick(3)
        s = self.look()
        self.assertEqual((s['state']['openingState'], s['calls']), ('CoverFailed', []),
                         'XA-X47: failed barrier is not a recovery receipt')
        self.device_fault(False); self.js('views[0].controller.retry()'); self.tick(3)
        self.assertEqual(self.look()['V'], [B, 1, 2]); self.drained()

    def test_c04_uncover_failure_commits_no_display_fact_and_pins_front(self):
        for how in ('throw', 'false', 'promise'):
            with self.subTest(how=how):
                self.fresh()
                self.js('''how => { const p=physical(0), cover=p.cover; window.exposeOk=false;
                  p.cover=on=>{if(!on&&!exposeOk) { if(how==='throw') throw Error('exposure');
                    return how==='false'?false:Promise.resolve(); } return cover(on); }; }''', how)
                self.open(sop=A)
                s = self.look()
                self.assertEqual((s['Lb'], s['state']['frame'], s['state']['coverage']['shown'], s['E']), (None, None, 0, []),
                                 'XA-X50: hidden installed front is not a display fact')
                self.assertEqual(s['surfaceReleases'], [], 'XA-X51: attached hidden front must stay pinned until actual detach')
                self.honest(s, 'hidden front pinned')
                self.js('window.exposeOk=true; views[0].controller.retry()'); self.tick(3)
                s = self.look()
                self.assertEqual((s['V'], s['Lb'], s['E'], s['state']['coverage']['shown']), ([A, 1, 1], 1, [1], 1))
                self.drained()

    def test_c05_late_denial_of_other_opening_never_covers_new_owner(self):
        for first in (False, True):
            with self.subTest(first=first):
                self.fresh(); self.open(sop=A, holdLoad=[0], lateAbort=True); self.save('A1')
                self.open(sop=B, sequence=2, holdLoad=[0] if first else [])
                self.deny(0, name='A1')
                self.assertEqual(self.state()['openingState'], 'Active')
                if first: self.js('releaseLoad(0,0)'); self.tick(2)
                self.assertEqual(self.look()['V'], [B, 1, 2]); self.drained()

    def test_c06_late_a1_denial_never_targets_same_sop_a3(self):
        for status in (401, 403):
            with self.subTest(status=status):
                self.fresh(); self.open(sop=A, holdLoad=[0], lateAbort=True); self.save('A1')
                self.open(sop=B, sequence=2); self.save('B2')
                self.open(sop=A, sequence=3)
                self.deny(0, status, name='A1')
                s = self.look()
                self.assertEqual((s['V'], s['state']['openingState']), ([A, 1, 3], 'Active'),
                                 'XA-X45: late A1 refusal belongs to exact A1, not current same-SOP A3')
                self.deny(0, status)
                self.assertEqual(self.state()['openingState'], 'AccessBlocked'); self.drained()

    def test_c07_shared_opening_denial_survives_requester_dispose(self):
        self.open(sop=A, holdLoad=[0], lateAbort=True)
        self.open(1, sop=A)
        self.assertEqual((self.look()['calls'], self.look(1)['calls']), ([0], []))
        self.js('views[0].controller.dispose()'); self.seek(1, 10); self.tick(2)
        self.deny(0)
        self.assertEqual((self.state(1)['openingState'], self.look(1)['C']), ('AccessBlocked', True))
        self.drained()

    def test_c08_raw_denial_survives_abort_timeout_and_duplicate_delivery(self):
        for after in ('abort', 'timeout', 'decode'):
            for code in (401, 403):
                with self.subTest(after=after, code=code):
                    self.fresh(); self.open(sop=A, holdLoad=[0] if after != 'decode' else [], holdDecode=[0] if after == 'decode' else [])
                    if after == 'timeout': self.tick(20001)
                    else: self.seek(0, 10); self.tick(2)
                    self.deny(0, code)
                    epoch = self.state()['denyEpoch']; self.deny(0, code)
                    self.assertEqual((self.state()['openingState'], self.state()['denyEpoch']), ('AccessBlocked', epoch))
                    self.drained()
        self.fresh(); self.open(sop=A, holdLoad=[0]); self.seek(0, 10); self.tick(2)
        self.assertEqual(self.state()['openingState'], 'Active', 'an abort with no observed response invents no refusal')
        self.drained()
        self.fresh(); self.open(sop=A)
        self.js('window.httpRequest={}; views[0].log.outcomes.get(0)(403,window.httpRequest)'); self.tick(1)
        epoch = self.state()['denyEpoch']
        self.js('views[0].log.outcomes.get(0)(403,window.httpRequest)'); self.tick(1)
        self.assertEqual(self.state()['denyEpoch'], epoch, 'same subordinate request delivered twice is one denial')
        self.js('views[0].controller.retry()'); self.tick(3)
        self.js('views[0].log.outcomes.get(0)(401,{})'); self.tick(1)
        self.assertEqual(self.state()['openingState'], 'AccessBlocked', 'different subordinate request is a fresh observed denial')
        self.drained()

    def test_c09_authorization_attempt_cannot_erase_a_newer_refusal(self):
        self.open(sop=A, authHold=True)
        self.seek(0, 3); self.tick(2)
        self.seek(0, 2); self.tick(2); self.deny(1)
        self.js('views[0].controller.retry(); views[0].controller.retry()'); self.tick(2)
        self.assertEqual(self.look()['auth'], 1)
        self.deny(0); self.auth()
        s = self.look()
        self.assertEqual((s['C'], s['state']['openingState']), (True, 'AccessBlocked'),
                         'XA-X46: a1 success cannot erase d2 or expose cached pixels')
        self.js('views[0].controller.retry()'); self.auth()
        self.assertEqual(self.state()['openingState'], 'Active')
        # A different old request after success is a new event, even with an older start epoch.
        self.deny(2, 401)
        self.assertEqual(self.state()['openingState'], 'AccessBlocked')
        self.drained()
        self.fresh(); self.open(sop=A, authHold=True); self.deny()
        self.js('views[0].controller.retry()'); self.tick(20001)
        self.js('views[0].controller.retry()'); self.tick(2)
        self.assertEqual((self.look()['auth'], self.state()['openingState']), (1, 'AccessBlocked'), 'timeout does not finish the actual authorization transport')
        self.auth()
        self.assertEqual(self.state()['openingState'], 'AccessBlocked', 'expired proof never clears access')
        self.js('views[0].controller.retry()'); self.auth()
        self.assertEqual(self.state()['openingState'], 'Active'); self.drained()

    def test_c10_access_and_physical_fault_need_independent_recovery(self):
        self.open(sop=A, authHold=True); self.device_fault(); self.deny()
        self.assertEqual(self.state()['openingState'], 'CoverFailed')
        self.js('views[0].controller.retry()'); self.tick(2)
        self.assertEqual(self.look()['auth'], 0, 'no authorization transport before physical safety')
        self.device_fault(False); self.js('views[0].controller.retry()'); self.tick(2)
        self.assertEqual((self.state()['openingState'], self.look()['auth']), ('AccessBlocked', 1))
        self.auth(); self.assertEqual(self.state()['openingState'], 'Active'); self.drained()

    def test_c11_failed_retry_is_one_target_until_display_commit(self):
        self.open(sop=A); self.js('failFrame(0,4,0)'); self.seek(0, 5); self.tick(2)
        self.js('healFrame(0,4)'); self.hold(0, 'R', 5)
        self.js('views[0].controller.retry(); views[0].controller.play()'); self.tick(3)
        s = self.look()
        self.assertEqual((s['state']['openingState'], s['state']['playing']), ('Failed', False),
                         'XA-X49: Retry retains failure and no ordinary Play before its verified target commit')
        self.assertEqual(s['calls'], [0, 4, 4])
        self.complete(0, 'R', 5); self.tick(2)
        self.assertEqual((self.state()['openingState'], self.look()['V']), ('Active', [A, 5, 1])); self.drained()
        self.fresh(); self.open(sop=A)
        self.js('failFrame(0,4,0)'); self.seek(0,5); self.tick(2)
        self.js('healFrame(0,4)'); self.hold(0,'R',5)
        self.js('views[0].controller.retry()'); self.tick(2); self.save('recovering-owner')
        self.open(sop=A, current=4)
        self.js('views[0].controller.retry()'); self.tick(3)
        self.assertEqual((self.look()['V'], self.state()['openingState']), ([A,5,1], 'Active'), 'a revoked old owner recovery cannot lock Retry on a remount of the same O')
        self.complete(0,'R',5); self.tick(2)
        self.assertEqual(self.look()['V'], [A,5,1]); self.drained()
        self.fresh(); self.open(sop=A)
        self.js('failFrame(0,4,0)'); self.seek(0,5); self.tick(2)
        self.js('healFrame(0,4)'); self.hold(0,'L',5)
        self.js('views[0].controller.retry()'); self.tick(2)
        self.js('views[0].controller.pause()'); self.tick(2)
        self.assertEqual(self.state()['openingState'], 'Failed')
        self.js('views[0].controller.retry()'); self.tick(3)
        self.assertEqual((self.look()['V'], self.state()['playing']), ([A,5,1], False), 'Pause cancels a pre-draw recovery without permanently locking the next Retry')
        self.drained()

    def test_c12_partial_publish_failure_pins_possible_front_until_detach(self):
        self.open(sop=A)
        self.js('''() => {const p=physical(0), publish=p.publish; window.publishOk=false;
          p.publish=r=>{publish(r); if(!publishOk) throw Error('partial publish');};}''')
        self.seek(0, 5); self.tick(3)
        s = self.look()
        self.assertEqual((s['Lb'], s['E'], s['C']), (1, [1], True))
        self.assertNotIn(k(A, 5), s['surfaceReleases'], 'XA-X51: possible physical reference remains pinned')
        self.honest(s, 'partial publish')
        self.js('window.publishOk=true; views[0].controller.retry()'); self.tick(3)
        self.assertEqual(self.look()['V'], [A, 5, 1]); self.drained()

    def test_c13_new_authorization_never_revives_an_old_draw(self):
        self.open(sop=A, authHold=True); self.hold(0, 'R', 5); self.seek(0, 5); self.tick(2)
        self.deny(0); self.hold(0, 'R', 1)
        self.js('views[0].controller.first(); views[0].controller.retry()')
        self.auth(); self.complete(0, 'R', 5); self.tick(2)
        s = self.look()
        self.assertEqual((s['published'], s['E'], s['C']), ([1], [1], True),
                         'XA-X52: authorization never restores a revoked draw from the old epoch')
        self.complete(0, 'R', 1); self.tick(2)
        self.assertEqual(self.look()['V'], [A, 1, 1]); self.drained()

    def test_c14_observer_sees_one_complete_fact_before_reentry(self):
        for action in ('seek', 'end', 'throw'):
            with self.subTest(action=action):
                self.fresh(); self.open(sop=A)
                self.js('''action => {window.observed=[]; window.onEvent=(slot,e)=>{if(e.type!=='displayed')return;
                  window.observed.push(look(slot)); window.onEvent=null;
                  if(action==='seek')views[slot].controller.seek(8);
                  if(action==='end')endSession(slot);
                  if(action==='throw')throw Error('observer'); };}''', action)
                self.seek(0, 5); self.tick(3)
                s = self.js('window.observed[0]')
                self.assertEqual((s['V'], s['Lb'], s['state']['frame'], s['state']['coverage']['shown'], s['E']),
                                 ([A, 5, 1], 5, 5, 2, [1, 5]), 'XA-X53: observer reads the fully committed pixels label coverage and event')
                self.assertEqual(self.look()['E'].count(5), 1)
                if action == 'end': self.assertEqual(self.state()['openingState'], 'Ended')
                self.drained()

    def test_c15_ended_opening_cannot_be_revived_by_proof_or_remount(self):
        self.open(sop=A, authHold=True); self.deny(); self.js('views[0].controller.retry()')
        self.js('endSession(0)'); self.auth()
        self.assertEqual((self.state()['openingState'], self.look()['E']), ('Ended', [1]))
        self.save('ended'); self.open(sop=A)
        self.assertEqual((self.state()['openingState'], self.look()['calls']), ('Ended', []))
        self.save('remount'); self.open(sop=A, sequence=2, session='next')
        self.assertEqual(self.look()['V'], [A, 1, 2]); self.drained()
        self.fresh(); self.open(sop=A); self.open(1, sop=A)
        self.js('endSession(0)'); self.tick(1)
        self.assertEqual((self.state()['openingState'], self.state(1)['openingState'], self.look(1)['C']), ('Ended', 'Ended', True), 'host session end terminates all bindings of exact O')
        self.drained()

    def test_c16_normal_commands_need_no_retry_or_authorization(self):
        self.open(sop=A, frames=20)
        self.seek(0, 5); self.tick(3)
        self.assertEqual(self.look()['V'], [A, 5, 1], 'XA-X54: ordinary seek displays without Retry or another authorization')
        for command, frame in [('seek(6)', 6), ('seek(5)', 5), ('first()', 1), ('last()', 20)]:
            self.js('views[0].controller.' + command); self.tick(2)
            self.assertEqual(self.look()['Lb'], frame)
        self.label('Playback Direction').select_option('reverse')
        self.label('Loop').uncheck()
        self.label('Playback Speed').select_option('manual:10')
        self.label('Range Start').fill('2'); self.label('Range End').fill('8'); self.control('Apply Range').click()
        self.js('views[0].controller.play()'); self.tick(103); self.js('views[0].controller.pause()')
        before = self.look()['E']; self.tick(2)
        self.assertEqual((self.look()['E'], self.look()['auth'], self.state()['openingState']), (before, 0, 'Active'))
        self.drained()

    def test_m01_to_m16_opening_state_entry_matrix(self):
        commands = {
            1: 'c.seek(8); c.seek(1)', 2: 'c.first()', 3: 'c.last()', 4: 'c.seek((c.state().frame||1)+1)', 5: 'c.seek(Math.max(1,(c.state().frame||1)-1))',
            6: 'c.play()', 7: 'c.pause(); document.dispatchEvent(new Event("visibilitychange"))',
            8: 'input("Playback Direction").value="reverse"; input("Playback Direction").dispatchEvent(new Event("change")); c.play()',
            9: 'input("Playback Speed").value="manual:10"; input("Playback Speed").dispatchEvent(new Event("change")); c.play()',
            10: 'const loop=panel.querySelector("input[type=checkbox]"); loop.checked=false; loop.dispatchEvent(new Event("change")); c.play()',
            11: 'input("Range Start").value=2; input("Range End").value=8; [...panel.querySelectorAll("button")].find(b=>b.textContent==="Apply Range").dispatchEvent(new Event("click")); c.first(); c.play()',
            12: 'c.retry(); c.retry()', 15: 'endSession(0)', 16: 'c.dispose()',
        }
        for row in range(1, 17):
            if row == 13:
                print('D757_NOT_RUN M13-AB/CF/F/E: no native host resize adapter in R1')
                continue
            for state in ('AB', 'CF', 'F', 'E', 'Active'):
                with self.subTest(case='M%02d-%s' % (row, state)):
                    self.fresh()
                    if state == 'CF': self.device_fault()
                    self.open(sop=A, frames=20, authHold=True)
                    if state == 'AB': self.deny()
                    elif state == 'F':
                        self.js('failFrame(0,4,0)'); self.seek(0, 5); self.tick(2)
                    elif state == 'E': self.js('endSession(0)')
                    if state == 'Active' and row in (1, 2, 3, 4, 5):
                        self.seek(0, 5); self.tick(3)
                    if state == 'Active' and row == 7:
                        self.js('views[0].controller.play()')
                        self.assertTrue(self.state()['playing'])
                    before = self.look()
                    if row == 14:
                        self.save('same'); self.open(sop=A, frames=20, revision='new-source')
                        if state not in ('Active', 'F'):
                            self.assertEqual(self.state()['openingState'], before['state']['openingState'])
                            self.assertEqual(self.look()['calls'], [], 'same O remount, even another revision, does not clear its latch')
                        self.save('replacement'); self.open(sop=B, sequence=2)
                        if state == 'CF': self.assertEqual(self.look()['calls'], [])
                        else: self.assertEqual(self.look()['V'], [B, 1, 2])
                    else:
                        self.js('() => {const c=views[0].controller, panel=document.querySelector("#host0 [role=group]"), input=n=>[...panel.querySelectorAll("[aria-label]")].find(e=>e.getAttribute("aria-label")===n); ' + commands[row] + ';}')
                        self.tick(3)
                        after = self.look()
                        if state not in ('Active', 'F') and row < 14:
                            self.assertEqual(after['state']['openingState'], before['state']['openingState'])
                            self.assertEqual((after['calls'], after['prepares'], after['published'], after['E'], after['Lb']),
                                             (before['calls'] + ([4] if row == 12 and state == 'F' else []),
                                              before['prepares'], before['published'], before['E'], before['Lb']))
                            self.assertEqual(after['auth'], 1 if row == 12 and state == 'AB' else 0)
                        if state == 'Active' and row <= 12:
                            expected_frame = {1: 1, 2: 1, 3: 20, 4: 6, 5: 4, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1, 11: 2, 12: 1}[row]
                            expected_playing = row in (6, 8, 9, 10, 11)
                            self.assertEqual((after['Lb'], after['V'], after['state']['playing']),
                                             (expected_frame, [A, expected_frame, 1], expected_playing),
                                             'XA-X62: M01-M12 Active must perform the requested normal effect')
                            if expected_playing:
                                self.tick(103 if row == 9 else 23)
                                progressed = {6: 2, 8: 20, 9: 2, 10: 2, 11: 3}[row]
                                self.assertEqual((self.look()['Lb'], self.state()['playing']), (progressed, True),
                                                 'Active Play advances in the selected direction, speed and range')
                        if state == 'F' and row < 14:
                            self.assertIn(5, self.state()['failedFrames'], 'navigation/settings cannot erase a failed frame')
                            if row in (1, 2, 3, 4, 5, 11):
                                self.assertIsNotNone(after['V'], 'D783: other frames remain navigable')
                            else:
                                self.assertTrue(after['C'], 'the failed target stays covered until its own recovery')
                        if row in (15, 16): self.assertEqual(self.state()['openingState'], 'Ended')
                    after = self.look()
                    self.honest(after, 'matrix effect boundary')
                    print('D757_SUBCASE ' + json.dumps({'id': 'M%02d-%s' % (row, state), 'state': after['state']['openingState'],
                          'calls': after['calls'], 'pixels': after['V'], 'label': after['Lb'], 'displayed': after['E'], 'auth': after['auth']}))
                    # Every row ends with actual cleanup, including intentionally broken physical devices.
                    if state == 'CF': self.device_fault(False)
                    if row == 12 and state == 'AB': self.auth('fail')
                    self.drained()


    # D783: independent Opus probes promoted to maintained behaviour regressions.
    def report(self, name, observation):
        print(json.dumps({'probe': name, 'observation': observation}, ensure_ascii=False), flush=True)

    def snap(self, slot=0, name=None):
        s = self.look(slot, name)
        out = {k: s[k] for k in ('V', 'C', 'Lb', 'E', 'calls', 'published', 'auth')}
        out['state'] = {k: s['state'].get(k) for k in ('openingState', 'phase', 'playing', 'frame', 'failure', 'covered', 'exposure', 'recovering', 'denyEpoch', 'failedFrames')}
        out['status'] = s['status']
        out['note'] = self.js('slot => { const n=[...document.querySelectorAll("#host"+slot+" [aria-live]")].at(-1); return n ? n.textContent : null; }', slot)
        return out

    def events(self, slot=0):
        return self.js('slot => events.filter(e => e.slot === slot).map(e => [e.type, e.frame, e.sequence, e.kind || e.reason || null])', slot)

    def test_astra_r4_failed_barrier_settings_bypass_adapted(self):
        self.open(sop=A, frames=10, sequence=1)
        self.save('old')
        self.js('''() => { const p=physical(0); p.cover=()=>{throw Error('cover unavailable')}; p.clear=()=>{throw Error('clear unavailable')}; return true; }''')
        self.open(sop=B, study='2.25.21', sequence=2, frames=10, hold='all')
        self.assertEqual(self.look()['calls'], [])
        self.label('Playback Direction').select_option('reverse')
        play_disabled = self.js('() => [...document.querySelectorAll("#host0 [role=group]")].at(-1).querySelector("button").disabled')
        self.js('''() => { const b=[...document.querySelectorAll("#host0 [role=group]")].at(-1).querySelector("button");
          b.dispatchEvent(new Event("click")); views[0].controller.play(); views[0].controller.first(); return true; }''')
        self.tick(3)
        s = self.snap()
        self.report('astra_r4_failed_barrier_settings_bypass_adapted', {'play_button_disabled': play_disabled, 'seen': s})
        self.assertEqual((s['calls'], s['published'], s['state']['openingState']), ([], [], 'CoverFailed'),
                         'D742/EXA-R4-03: settings must not erase an unresolved opening barrier')

    def test_ce1_session_end_inside_publish_never_uncovers_or_counts(self):
        self.open(0, frames=10, sop=A)
        self.js('''() => { const p = physical(0), publish = p.publish;
          p.publish = r => { publish(r); if (r.frame === 5) endSession(0); }; return true; }''')
        self.seek(0, 5)
        self.tick(3)
        s = self.snap()
        self.report('ce1_session_end_inside_publish', {'seen': s, 'events': self.events()})
        self.assertEqual(s['state']['openingState'], 'Ended')
        self.assertTrue(s['C'], 'XA-X55: Ended opening never uncovers after synchronous publish re-entry')
        self.assertNotIn(5, s['E'], 'no displayed fact after the opening ended')
        self.assertNotEqual(s['Lb'], 5, 'no frame label after the opening ended')

    def test_ce2_denial_inside_publish_keeps_the_cover(self):
        self.open(0, frames=20, sop=A, lateAbort=True, holdLoad=[9])
        self.seek(0, 10)
        self.tick(2)
        self.js('''() => { const p = physical(0), publish = p.publish;
          p.publish = r => { publish(r); if (r.frame === 5) rejectTransport(0, 9, 403); }; return true; }''')
        self.seek(0, 5)
        self.tick(3)
        s = self.snap()
        self.report('ce2_denial_inside_publish', {'seen': s, 'events': self.events()})
        self.assertEqual(s['state']['openingState'], 'AccessBlocked')
        self.assertTrue(s['C'], 'AccessBlocked: the viewport stays covered; no uncover after the latch')
        self.assertNotIn(5, s['E'], 'no displayed fact under AccessBlocked')
        self.js('endAborts(0)')
        self.drained()

    def test_ce10_session_end_inside_previous_front_release_never_uncovers(self):
        self.open(0, frames=10, sop=A)
        self.js('''() => { const p = physical(0), release = p.release; window.armed = false;
          p.release = h => { release(h); if (window.armed) { window.armed = false; endSession(0); } }; return true; }''')
        self.js('window.armed = true')
        self.seek(0, 5)
        self.tick(3)
        s = self.snap()
        self.report('ce10_session_end_inside_release', {'seen': s, 'events': self.events()})
        self.assertEqual(s['state']['openingState'], 'Ended')
        self.assertTrue(s['C'], 'XA-X55: Ended opening never uncovers after synchronous publish re-entry')
        self.assertEqual(s['E'], [1, 5], 'the valid commit precedes old-front release; release re-entry adds no facts')

    def test_ce11_dispose_then_same_key_remount_is_terminal(self):
        self.open(0, frames=10, sop=A)
        self.js('views[0].controller.dispose()')
        self.tick(2)
        self.open(0, frames=10, sop=A)
        s = self.snap()
        self.report('ce11_dispose_then_same_key_remount', s)
        self.assertEqual((s['state']['openingState'], s['calls'], s['V']), ('Ended', [], None),
                         'by D757 design the same O cannot be revived; the R2 host must issue a new opening sequence')
        self.drained()

    def test_ce3_session_end_with_render_pending_then_late_success(self):
        self.open(0, frames=10, sop=A)
        self.hold(0, 'R', 5)
        self.seek(0, 5)
        self.tick(2)
        self.js('endSession(0)')
        self.tick(1)
        self.complete(0, 'R', 5)
        self.tick(3)
        s = self.snap()
        self.report('ce3_session_end_render_pending', {'seen': s, 'events': self.events()})
        self.assertEqual((s['state']['openingState'], s['C'], s['published'], s['E']), ('Ended', True, [1], [1]))
        self.drained()

    def test_ce4_cover_failure_then_opening_change_a_b_a(self):
        self.open(0, frames=10, sop=A, sequence=1)
        self.hold(0, 'D', 5)
        self.seek(0, 5)
        self.tick(2)
        self.save('A1')
        self.device_fault()
        self.open(0, frames=10, sop=B, study='2.25.21', sequence=2)
        self.save('B2')
        b2 = self.snap()
        self.open(0, frames=10, sop=A, sequence=3)
        self.save('A3')
        a3 = self.snap()
        self.complete(0, 'D', 5, name='A1')
        self.tick(3)
        self.label('Playback Direction').select_option('reverse')
        self.js('views[0].controller.play(); views[0].controller.first(); views[0].controller.seek(4)')
        self.tick(5)
        blocked = self.snap()
        a1 = self.snap(0, 'A1')
        self.js('views[0].controller.retry()')
        self.tick(3)
        still = self.snap()
        self.device_fault(False)
        self.js('views[0].controller.retry()')
        self.tick(3)
        healed = self.snap()
        self.report('ce4_cover_failure_a_b_a', {'B2_on_claim': b2, 'A3_on_claim': a3, 'A3_after_commands': blocked,
                                                'A1_after_late_decode': a1, 'A3_retry_device_still_broken': still,
                                                'A3_after_device_recovered_retry': healed, 'events': self.events()})
        self.assertEqual((b2['calls'], b2['published'], b2['state']['openingState']), ([], [], 'CoverFailed'))
        self.assertEqual((a3['calls'], a3['published'], a3['state']['openingState']), ([], [], 'CoverFailed'))
        self.assertEqual(a3['state']['exposure'], 'unknown', 'both hides failed: the residual A1 pixels are not reported hidden')
        self.assertEqual((blocked['calls'], blocked['published'], blocked['Lb'], blocked['E']), ([], [], None, []))
        self.assertEqual(a1['published'], [1], 'the late A1 decode never publishes on the reused viewport')
        self.assertEqual((still['calls'], still['state']['openingState']), ([], 'CoverFailed'))
        self.assertEqual((healed['V'], healed['Lb'], healed['E'], healed['state']['openingState'], healed['state']['playing']),
                         ([A, 1, 3], 1, [1], 'Active', False),
                         'after a real safe receipt Retry shows A3 at its own recovery target and stays paused')
        self.drained()

    def test_ce5a_retry_while_the_old_request_succeeds_late(self):
        self.open(0, frames=20, sop=A)
        self.hold(0, 'D', 5)
        self.seek(0, 5)
        self.tick(20001)
        failed = self.snap()
        self.js('views[0].controller.retry()')
        self.tick(2)
        waiting = self.snap()
        self.complete(0, 'D', 5)
        self.tick(5)
        s = self.snap()
        self.report('ce5a_retry_vs_late_old_success', {'failed': failed, 'retry_waiting': waiting, 'after': s, 'events': self.events()})
        self.assertEqual(failed['state']['openingState'], 'Failed')
        self.assertEqual((waiting['published'], waiting['E'], waiting['state']['openingState']), ([1], [1], 'Failed'),
                         'the Retry does not borrow the old incarnation before it settles')
        self.assertEqual((s['V'], s['E'], s['state']['openingState'], s['state']['playing']), ([A, 5, 1], [1, 5], 'Active', False))
        self.assertEqual(s['calls'].count(4), 2, 'the recovery uses its own new load, the old one only drains')
        self.drained()

    def test_ce5b_pending_retry_then_a_b_a_and_late_success(self):
        self.open(0, frames=20, sop=A, sequence=1)
        self.js('failFrame(0, 4, 0)')
        self.seek(0, 5)
        self.tick(2)
        self.js('healFrame(0, 4)')
        self.hold(0, 'D', 5)
        self.js('views[0].controller.retry()')
        self.tick(2)
        self.save('A1')
        self.open(0, frames=20, sop=B, study='2.25.21', sequence=2)
        self.save('B2')
        self.open(0, frames=20, sop=A, sequence=3)
        self.complete(0, 'D', 5, name='A1')
        self.tick(3)
        s = self.snap()
        a1 = self.snap(0, 'A1')
        self.report('ce5b_pending_retry_a_b_a', {'A3': s, 'A1': a1, 'events': self.events()})
        self.assertEqual((s['V'], s['Lb'], s['E'], s['state']['openingState']), ([A, 1, 3], 1, [1], 'Active'))
        self.assertEqual(a1['published'], [1], 'the old recovery never publishes after its opening lost the viewport')
        self.drained()

    def test_ce6_access_recovery_with_a_pending_failed_reason(self):
        self.open(0, frames=20, sop=A, lateAbort=True, holdLoad=[9])
        self.seek(0, 10)
        self.tick(2)
        self.js('failFrame(0, 4, 0)')
        self.seek(0, 5)
        self.tick(3)
        failed = self.snap()
        self.js('rejectTransport(0, 9, 403)')
        self.tick(1)
        blocked = self.snap()
        self.js('views[0].controller.retry()')
        self.tick(5)
        s = self.snap()
        self.report('ce6_access_and_failed_reasons', {'failed': failed, 'blocked': blocked, 'after_proof': s})
        self.js('healFrame(0, 4); endAborts(0)')
        self.assertEqual(failed['state']['failure'], {'frame': 5, 'kind': 'failed'})
        self.assertEqual(blocked['state']['openingState'], 'AccessBlocked')
        # D757 s2.1: lower-priority reasons are not deleted; Failed leaves only through its own recovery commit (frame 5).
        self.assertEqual(s['state']['failedFrames'], [5], 'XA-X59: access recovery preserves the independent frame-5 failure')
        self.seek(0, 5); self.tick(2)
        self.assertEqual((self.state()['openingState'], self.look()['C']), ('Failed', True))
        self.drained()

    def test_ce7_second_viewport_of_a_blocked_opening_names_the_real_reason(self):
        self.open(0, frames=20, sop=A)
        self.js('rejectTransport(0, 0, 403)')
        self.tick(1)
        self.open(1, frames=20, sop=A)
        s = self.snap(1)
        self.report('ce7_second_viewport_blocked_reason', s)
        self.assertEqual((s['calls'], s['state']['openingState'], s['C']), ([], 'AccessBlocked', True))
        self.assertIn('권한', s['note'], 'XA-X58: a refused mount explains the access reason')
        self.assertNotIn('가림을 설정하지 못해', s['note'])
        self.drained()

    def test_ce8_initial_cover_failure_recovers_the_opening_first_target(self):
        self.open(0, frames=20, sop=A, current=5)
        control = self.snap()
        self.fresh()
        self.device_fault()
        self.open(0, frames=20, sop=A, current=5)
        cf = self.snap()
        self.device_fault(False)
        self.js('views[0].controller.retry()')
        self.tick(3)
        s = self.snap()
        self.report('ce8_initial_cover_failure_target', {'control_no_fault': control, 'cover_failed': cf, 'after_retry': s})
        self.assertEqual(control['V'], [A, 6, 1])
        self.assertEqual(cf['state']['openingState'], 'CoverFailed')
        self.assertEqual(s['V'], [A, 6, 1], 'XA-X60: Retry recovers the intended first target (frame 6)')
        self.drained()

    def test_ce9_budget_wait_is_not_an_error_state(self):
        self.open(0, frames=6, sop='2.25.81', rows=4096, cols=2048)
        self.open(1, frames=6, sop='2.25.82', study='2.25.21', rows=4096, cols=2048)
        start = (self.snap(0), self.snap(1))
        self.seek(0, 2)
        self.tick(2)
        waiting = self.snap(0)
        self.tick(20001)
        later = self.snap(0)
        self.seek(0, 3)
        self.tick(2)
        seek_after = self.snap(0)
        self.js('views[1].controller.dispose()')
        self.tick(5)
        freed = self.snap(0)
        self.report('ce9_budget_wait', {'start': start, 'waiting': waiting, 'after_20s': later, 'seek3_after_20s': seek_after,
                                        'after_other_viewport_closed': freed})
        self.assertEqual(waiting['state']['openingState'], 'Active')
        self.assertEqual(later['state']['openingState'], 'Active', 'XA-X56: waiting for budget never consumes a load timeout')
        self.assertEqual(freed['Lb'], 3, 'when the other viewport closes, the waiting seek continues without Retry (C16)')
        self.drained()
        # A Retry also waits for its old decoder to drain; this busy wait does not consume the new load deadline.
        self.fresh(); self.open(sop=A); self.hold(0, 'D', 5); self.seek(0, 5); self.tick(20001)
        self.js('views[0].controller.retry()'); self.tick(20001)
        self.assertEqual(self.look()['calls'].count(4), 1)
        self.assertTrue(self.state()['recovering'])
        self.complete(0, 'D', 5); self.tick(4)
        self.assertEqual((self.look()['V'], self.look()['calls'].count(4)), ([A,5,1], 2))
        self.drained()

    def test_r6_recovery_clears_messages_and_refreshes_every_member(self):
        for reason in ('access', 'frame'):
            with self.subTest(reason=reason):
                self.fresh(); self.open(sop=A); self.open(1, sop=A)
                if reason == 'access': self.deny()
                else:
                    self.js('failFrame(0,4,0)'); self.seek(0,5); self.tick(3)
                    self.seek(1,5); self.tick(2)
                    self.js('healFrame(0,4)')
                self.js('views[0].controller.retry()'); self.tick(4)
                for slot in (0, 1):
                    self.assertEqual(self.state(slot)['openingState'], 'Active')
                    self.assertEqual(self.snap(slot)['note'], '', 'XA-X57: a recovery commit refreshes every member and clears its resolved error')
                    self.assertFalse(self.control('Play', slot).is_disabled())
                    self.assertTrue(self.control('Retry', slot).is_hidden())
                self.drained()

    def test_r6_failed_frames_have_independent_retry_and_do_not_block_navigation(self):
        self.open(sop=A, frames=20)
        self.js('failFrame(0,4,0); failFrame(0,8,0)')
        self.seek(0,5); self.tick(3)
        self.assertEqual((self.look()['C'], self.state()['failure']), (True, {'frame': 5, 'kind': 'failed'}))
        self.assertIn('Failed Frame 5', self.look()['status'])
        self.seek(0,6); self.tick(3)
        self.assertEqual(self.look()['V'], [A,6,1], 'XA-X61: a failed frame never blocks another frame')
        self.js('views[0].controller.play()'); self.tick(23)
        self.assertEqual((self.look()['Lb'], self.state()['playing']), (7, True))
        self.js('views[0].controller.pause()'); self.seek(0,9); self.tick(3)
        self.assertEqual(self.state()['failedFrames'], [5,9])
        self.seek(0,5); self.tick(3)
        self.assertEqual((self.look()['C'], self.state()['failure']['frame']), (True,5))
        self.assertNotIn(5, self.look()['E']); self.assertNotIn(9, self.look()['E'])
        self.js('healFrame(0,4); views[0].controller.retry()'); self.tick(3)
        self.assertEqual((self.look()['V'], self.state()['failedFrames']), ([A,5,1], [9]))
        self.seek(0,9); self.tick(2)
        self.assertTrue(self.look()['C']); self.assertIn('Failed Frame 9', self.look()['status'])
        self.js('healFrame(0,8); views[0].controller.retry()'); self.tick(3)
        self.assertEqual((self.look()['V'], self.state()['failedFrames']), ([A,9,1], []))
        self.drained()
        self.fresh(); self.open(sop=A, frames=10, holdLoad=[0])
        self.js('failFrame(0,0,0)'); self.complete(0, 'L', 1); self.tick(3)
        self.assertEqual((self.look()['Lb'], self.look()['E'], self.look()['C']), (None, [], True))
        self.seek(0, 2); self.tick(3); self.js('views[0].controller.play()'); self.tick(23)
        self.assertEqual((self.look()['Lb'], self.state()['playing'], self.state()['failedFrames']), (3, True, [1]))
        self.drained()

        # A pending Retry from a playback failure must not resume a later, explicitly paused seek.
        self.fresh(); self.open(sop=A)
        self.js('failFrame(0,4,0); views[0].controller.play()'); self.tick(103)
        self.js('healFrame(0,4)'); self.hold(0, 'R', 5)
        self.js('views[0].controller.retry()'); self.tick(3)
        self.seek(0,6); self.tick(3); self.complete(0, 'R', 5); self.tick(3)
        self.assertEqual((self.look()['V'], self.state()['playing']), ([A,6,1], False),
                         'XA-X63: a seek discards the old Retry resume ticket')
        self.assertIn(5, self.state()['failedFrames'])
        self.seek(0,5); self.tick(2); self.js('views[0].controller.retry()'); self.tick(3)
        self.assertEqual((self.look()['V'], self.state()['failedFrames']), ([A,5,1], []))
        self.drained()

    def test_r6_cover_and_requested_callbacks_revalidate_before_next_effect(self):
        self.hold(0, 'R', 1); self.open(sop=A)
        self.js("() => {const p=physical(0), cover=p.cover; let armed=true; p.cover=on=>{cover(on); if(!on&&armed){armed=false;endSession(0);}};}")
        self.complete(0, 'R', 1); self.tick(3)
        self.assertEqual((self.look()['C'], self.look()['E'], self.look()['Lb']), (True, [], None))
        self.honest(self.look(), 're-entry inside uncover pins the installed front'); self.drained()
        self.fresh()
        self.js("() => {window.onEvent=(slot,e)=>{if(e.type==='requested'){window.onEvent=null;endSession(slot);}};}")
        self.open(sop=A); self.tick(3)
        self.assertEqual((self.look()['C'], self.look()['E'], self.look()['published']), (True, [], []))
        self.drained()
        self.fresh(); self.open(sop=A, frames=6, rows=4096, cols=2048)
        self.seek(0, 2); self.tick(3)
        self.js("() => {const src=views[0].source, release=src.release; let armed=true; src.release=(...args)=>{const ack=release(...args); if(armed){armed=false;endSession(0);} return ack;};}")
        self.seek(0, 3); self.tick(3)
        self.assertEqual((self.look()['prepares'], self.look()['E'], self.look()['C']), ([1,2], [1,2], True),
                         'source release during budget relief revalidates before another prepare')
        self.drained()


if __name__ == '__main__':
    unittest.main(verbosity=2)
