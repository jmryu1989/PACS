'use strict';
/* E-XA R1 pure model contract: REQ-XA-01..06 -> RISK-XA-CODEC/FALSE-TIME/OMIT/OOM/STALE/FALSE-SUCCESS -> XA01..XA06.
   Every case is one allowed behaviour and one refused one, asserted on the public KinXaPlaybackModel API with DICOM JSON
   (PS3.18 F.2) input; nothing here reads the module's source text. The synthetic metadata below is test data only: it
   stands in for runs the local public set does not have (multi-frame XA with Frame Time / Frame Time Vector, >500
   frames, >128 MiB) and does not replace a real public sample (tests/part1/xa/samples.json real_sample_pending).
   KIN_XA_MODEL_JS lets tests/part1/xa/mutants.py run the same cases against a mutated copy. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const M = require(process.env.KIN_XA_MODEL_JS || path.join(__dirname, '..', '..', '..', 'worklist-v0', 'hpacs-lite', 'xa-playback-model.js'));

const XA = '1.2.840.10008.5.1.4.1.1.12.1', ENHANCED = '1.2.840.10008.5.1.4.1.1.12.1.1';
const RF = '1.2.840.10008.5.1.4.1.1.12.2', US_MULTI = '1.2.840.10008.5.1.4.1.1.3.1', CT = '1.2.840.10008.5.1.4.1.1.2';
const MiB = 1024 * 1024;
const el = (vr, ...Value) => ({ vr, Value });
let serial = 0;
function run({ frames = 24, sopClass = XA, rows = 64, cols = 64, bits = 8, stored = bits, high = stored - 1, pointer, frameTime, vector, extra = {} } = {}) {
  serial++;
  const json = {
    '00080016': el('UI', sopClass), '00080018': el('UI', '2.25.7000' + serial), '0020000D': el('UI', '2.25.7001'),
    '0020000E': el('UI', '2.25.7002'), '00280008': el('IS', frames), '00280010': el('US', rows), '00280011': el('US', cols),
    '00280002': el('US', 1), '00280100': el('US', bits), '00280101': el('US', stored), '00280102': el('US', high), '00280103': el('US', 0),
  };
  if (pointer !== undefined) json['00280009'] = Array.isArray(pointer) ? el('AT', ...pointer) : el('AT', pointer);
  if (frameTime !== undefined) json['00181063'] = el('DS', frameTime);
  if (vector !== undefined) json['00181065'] = el('DS', ...vector);
  return Object.assign(json, extra);
}
const fixed = (frames, ms, more = {}) => run({ frames, pointer: '00181063', frameTime: ms, ...more });
const timed = (vector, more = {}) => run({ frames: vector.length, pointer: '00181065', vector, ...more });
function perFrame(times, tag = '00189151') {
  return el('SQ', ...times.map(t => ({ '00209111': el('SQ', { [tag]: el('DT', t) }) })));
}
const dimension = (...pointers) => el('SQ', ...pointers.map(p => ({ '00209165': el('AT', p) })));
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, message + ` (got ${actual}, expected ${expected})`);
function walk(start, n, state) {
  const seen = [start];
  let at = start, direction = state.direction ?? (state.mode === 'reverse' ? -1 : 1);
  for (let i = 0; i < n; i++) {
    const s = M.step({ ...state, index: at, direction });
    if (s.stop) { seen.push('stop'); break; }
    seen.push(s.next); at = s.next; direction = s.direction;
  }
  return seen;
}

test('XA01 allow: a stored XA run keeps SOP/frame identity apart from the viewport index and goes to XA playback', () => {
  const d = M.describe(fixed(24, 33.3));
  assert.equal(d.ok, true);
  assert.equal(d.kind, 'xa');
  assert.equal(d.frames, 24);
  assert.equal(d.playback, 'time');
  assert.equal(M.route(d).path, 'xa');
  assert.deepEqual({ ...M.frame(d, 0) }, { index: 0, number: 1, key: d.sop + '#1' });
  assert.deepEqual({ ...M.frame(d, 23) }, { index: 23, number: 24, key: d.sop + '#24' });
  assert.throws(() => M.frame(d, 24), RangeError);
  assert.throws(() => M.frame(d, -1), RangeError);
  // Enhanced XA is told apart and plays by its per-frame Frame Content time when one temporal dimension orders it.
  const times = ['20260101120000.000', '20260101120000.040', '20260101120000.100', '20260101120000.130'];
  const enhanced = M.describe(run({ frames: 4, sopClass: ENHANCED, extra: { '52009230': perFrame(times), '00209222': dimension('00189151') } }));
  assert.equal(enhanced.kind, 'enhanced-xa');
  assert.equal(enhanced.timing.source, 'frame-content');
  assert.deepEqual([...enhanced.timing.offsets].map(n => Math.round(n)), [0, 40, 100, 130]);
  assert.equal(M.route(enhanced).path, 'xa');
  // Enhanced XA has no Cine Module (A.47-1): a top-level Frame Time is not its timing, and without a shown time
  // dimension it is navigated frame by frame, never flattened into a run.
  const noContent = M.describe(run({ frames: 4, sopClass: ENHANCED, pointer: '00181063', frameTime: 33 }));
  assert.equal(noContent.timing.verified, false);
  assert.equal(M.route(noContent).path, 'xa-frames');
  const twoDimensions = M.describe(run({ frames: 4, sopClass: ENHANCED, extra: { '52009230': perFrame(times), '00209222': dimension('00209056', '00189151') } }));
  assert.equal(M.route(twoDimensions).path, 'xa-frames');
});

test('XA01 reject: a still, another modality, several objects or damaged identity never becomes an XA time run', () => {
  const still = M.describe(run({ frames: 1, pointer: '00181063', frameTime: 33 }));
  assert.equal(still.playback, 'still');
  assert.equal(M.route(still).path, 'still');
  const noFrames = { ...run({}) }; delete noFrames['00280008'];
  assert.equal(M.route(M.describe(noFrames)).path, 'still', 'Number of Frames absent is one frame');
  for (const sopClass of [RF, US_MULTI, CT]) assert.equal(M.route(M.describe(fixed(12, 33, { sopClass }))).path, 'generic', sopClass);
  assert.equal(M.route([M.describe(fixed(12, 33)), M.describe(fixed(12, 33))]).path, 'still', 'two XA objects are not one run');
  assert.equal(M.route([M.describe(run({ frames: 1 })), M.describe(run({ frames: 1 }))]).path, 'still');
  const noSop = run({}); delete noSop['00080018'];
  assert.deepEqual([M.describe(noSop).ok, M.describe(noSop).reason, M.route(M.describe(noSop)).path], [false, 'identity', 'refused']);
  for (const frames of [0, -3, 'abc', 2.5]) {
    const d = M.describe(run({ frames }));
    assert.deepEqual([d.ok, d.reason, M.route(d).path], [false, 'frames', 'refused'], String(frames));
  }
  for (const broken of [{ bits: 8, stored: 12 }, { bits: 12 }, { bits: 16, stored: 12, high: 15 }]) {
    const d = M.describe(fixed(12, 33, broken));
    assert.equal(d.reservation.ok, false, JSON.stringify(broken));
    assert.equal(M.route(d).path, 'refused', JSON.stringify(broken));
  }
  assert.equal(M.describe(null).ok, false);
  assert.equal(M.describe([]).ok, false);
});

test('XA02 allow: Frame Time and a non-uniform Frame Time Vector give their own source intervals; manual speed is separate', () => {
  const range = { first: 0, last: 23 };
  const ft = M.describe(fixed(24, 33.3)).timing;
  assert.equal(ft.source, 'frame-time');
  assert.equal(ft.verified, true);
  const source = { kind: 'source', rate: 1 };
  close(M.interval(ft, source, 0, 1, range), 33.3, 'XA-X1: Frame Time 33.3 ms must give 33.3 ms steps, not a fixed 10 fps');
  close(M.interval(ft, source, 5, 4, range), 33.3, 'XA-X1: Frame Time 33.3 ms must give 33.3 ms steps, not a fixed 10 fps');
  close(M.interval(ft, { kind: 'source', rate: 2 }, 0, 1, range), 16.65, 'an explicit 2x rate halves the source interval');
  const vector = [0, 20, 80, 40, 10, 50];
  const fv = M.describe(timed(vector)).timing;
  assert.equal(fv.source, 'frame-time-vector');
  const vrange = { first: 0, last: 5 };
  const steps = [0, 1, 2, 3, 4].map(i => M.interval(fv, source, i, i + 1, vrange));
  assert.notDeepEqual(steps, [40, 40, 40, 40, 40], 'XA-X2: a Frame Time Vector must keep each interval, not its average');
  assert.deepEqual(steps, [20, 80, 40, 10, 50], 'XA-X3: the first 0 is frame 1 at time 0; frame 2 follows after 20 ms, not one frame later');
  assert.deepEqual([...fv.offsets], [0, 20, 100, 140, 150, 200], 'XA-X3: the first 0 is frame 1 at time 0; frame 2 follows after 20 ms, not one frame later');
  assert.equal(M.interval(fv, source, 3, 2, vrange), 40, 'reverse plays the same adjacent difference backwards');
  assert.equal(M.interval(fv, source, 5, 0, vrange), 50, 'a wrap from the last frame uses that frame\'s own interval');
  assert.equal(M.interval(fv, source, 0, 5, vrange), 20, 'a reverse wrap from the first frame uses that frame\'s own interval');
  assert.deepEqual([...M.describe(timed(['0', '20.5', '30'])).timing.offsets], [0, 20.5, 50.5], 'decimal strings are read as DS');
  // Manual speed is a separate, explicit choice and never borrows the source label.
  assert.deepEqual({ ...M.defaultSpeed(ft) }, { kind: 'source', rate: 1 });
  assert.equal(M.interval(ft, { kind: 'manual', fps: 10 }, 0, 1, range), 100);
  assert.ok(M.speedOptions(ft).some(s => s.kind === 'source'));
});

test('XA02 reject: wrong length, NaN, negative, non-zero first, missing value or pointer contradiction is Unverified', () => {
  const cases = [
    ['vector one short', timed([0, 20, 30], { frames: 4 }), 'vector-length'],
    ['vector one long', run({ frames: 2, pointer: '00181065', vector: [0, 20, 30] }), 'vector-length'],
    ['vector NaN', timed([0, 'abc', 30]), 'vector-value'],
    ['vector negative', timed([0, 20, -5]), 'vector-value'],
    ['vector zero step', timed([0, 20, 0]), 'vector-value'],
    ['vector first not 0', timed([5, 20, 30]), 'vector-first'],
    ['pointer to Frame Time without Frame Time', run({ frames: 4, pointer: '00181063' }), 'frame-time'],
    ['Frame Time 0', fixed(4, 0), 'frame-time'],
    ['Frame Time negative', fixed(4, -33), 'frame-time'],
    ['no pointer although Frame Time exists', run({ frames: 4, frameTime: 33 }), 'pointer'],
    ['two pointers', run({ frames: 4, pointer: ['00181063', '00181065'], frameTime: 33, vector: [0, 1, 2, 3] }), 'pointer'],
    ['pointer to a non-time attribute', run({ frames: 4, pointer: '00182002' }), 'pointer-target'],
    ['pointer to the vector while only Frame Time exists', run({ frames: 4, pointer: '00181065', frameTime: 33 }), 'vector-length'],
  ];
  for (const [name, json, reason] of cases) {
    const d = M.describe(json);
    assert.equal(d.timing.verified, false, name);
    assert.equal(d.timing.source, 'unverified', name);
    assert.equal(d.timing.reason, reason, name);
    assert.deepEqual({ ...M.defaultSpeed(d.timing) }, { kind: 'manual', fps: 10 }, name);
    assert.equal(M.speedOptions(d.timing).some(s => s.kind === 'source'), false, name);
    assert.throws(() => M.interval(d.timing, { kind: 'source', rate: 1 }, 0, 1, { first: 0, last: d.frames - 1 }), RangeError, name);
    assert.equal(M.route(d).path, 'xa', name + ': still playable at an explicit manual speed');
  }
  const unordered = M.describe(run({ frames: 3, sopClass: ENHANCED, extra: { '52009230': perFrame(['20260101120000.1', '20260101120000.1', '20260101120000.3']) } }));
  assert.equal(unordered.timing.verified, false, 'Frame Content times that do not increase are not a timeline');
  const mixedZone = M.describe(run({ frames: 2, sopClass: ENHANCED, extra: { '52009230': perFrame(['20260101120000.1+0900', '20260101120000.3']) } }));
  assert.equal(mixedZone.timing.verified, false, 'a mix of zoned and unzoned times is not comparable');
  assert.throws(() => M.interval(M.describe(fixed(4, 33)).timing, { kind: 'manual', fps: 7 }, 0, 1, { first: 0, last: 3 }), RangeError);
});

test('XA02 allow: the source time basis (Frame Delay, Frame Content origin) is kept apart from the playback intervals; DT at the PS3.5 bounds is a time', () => {
  // C.7.6.5: relative time of frame n = Frame Delay + Frame Time x (n - 1); with a vector, Frame Delay + the summed increments.
  const ft = M.describe(fixed(3, 40, { extra: { '00181066': el('DS', 250) } })).timing;
  assert.deepEqual([...ft.offsets], [0, 40, 80], 'playback intervals start at frame 1');
  assert.deepEqual([...ft.basis.relative], [250, 290, 330], 'XA-X20: Frame Delay stays in the source timeline as data');
  assert.deepEqual([ft.basis.reference, ft.basis.frameDelay, ft.basis.frameDelayPresent], ['content-time', 250, true]);
  const fv = M.describe(timed([0, 20, 80, 40], { extra: { '00181066': el('DS', '120.5') } })).timing;
  assert.deepEqual([...fv.offsets], [0, 20, 100, 140]);
  assert.deepEqual([...fv.basis.relative], [120.5, 140.5, 220.5, 260.5], 'XA-X20: Frame Delay stays in the source timeline as data');
  assert.equal(M.interval(fv, { kind: 'source', rate: 1 }, 1, 2, { first: 0, last: 3 }), 80, 'Frame Delay never changes an interval');
  const none = M.describe(fixed(3, 40)).timing;
  assert.deepEqual([[...none.basis.relative], none.basis.frameDelay, none.basis.frameDelayPresent], [[0, 40, 80], 0, false]);
  // PS3.5 6.2 bounds: -1200 and +1400, +0000, six fraction digits, a day boundary.
  const enhancedTimes = (times, tag) => M.describe(run({ frames: times.length, sopClass: ENHANCED, extra: { '52009230': perFrame(times, tag), '00209222': dimension('00189151') } })).timing;
  const west = enhancedTimes(['20261009000000.000000-1200', '20261009000000.040000-1200', '20261009000000.100000-1200']);
  assert.deepEqual([west.verified, [...west.offsets].map(Math.round)], [true, [0, 40, 100]]);
  const east = enhancedTimes(['20261009235959.900+1400', '20261010000000.000+1400', '20261010000000.250+1400']);
  assert.deepEqual([east.verified, [...east.offsets].map(Math.round)], [true, [0, 100, 350]]);
  assert.equal(east.basis.origin, '20261009235959.900+1400');
  const utc = enhancedTimes(['20261231235959.500000+0000', '20270101000000.000001+0000']);
  assert.deepEqual([utc.verified, utc.offsets[1]], [true, 500.001], 'across a year boundary, microseconds kept');
  const acquisition = enhancedTimes(['20261009120000', '20261009120001'], '00189074');
  assert.deepEqual([acquisition.verified, acquisition.basis.attribute, [...acquisition.basis.relative]], [true, '00189074', [0, 1000]]);
});

test('XA02 reject: an unreadable Frame Delay, or a DT outside PS3.5 (offset beyond -1200..+1400, offset minutes over 59, -0000, impossible date or second), is Unverified', () => {
  for (const delay of ['abc', 'NaN', '']) {
    const t = M.describe(fixed(3, 40, { extra: { '00181066': el('DS', delay) } })).timing;
    assert.deepEqual([t.verified, t.reason, t.basis], [false, 'frame-delay', null], JSON.stringify(delay));
  }
  const timeline = times => M.describe(run({ frames: times.length, sopClass: ENHANCED, extra: { '52009230': perFrame(times), '00209222': dimension('00189151') } })).timing;
  const zoned = suffix => timeline(['20261009120000.000' + suffix, '20261009120000.040' + suffix]);
  for (const suffix of ['+1500', '-1300', '+1401', '-1201']) {
    assert.equal(zoned(suffix).verified, false, 'XA-X21: a DT offset outside -1200..+1400 is not a time (' + suffix + ')');
  }
  for (const suffix of ['+9960', '+0960', '-0000', '+090', '+09000']) {
    assert.equal(zoned(suffix).verified, false, suffix);
  }
  for (const bad of [['20261302120000', '20261302120001'], ['20260230120000', '20260230120001'], ['20261009240000', '20261009240001'],
    ['20261009126000', '20261009126001'], ['20261009120061', '20261009120062'], ['20261009120060', '20261009120061'],
    ['2026100912', '2026100913'], ['20261009120000.1234567', '20261009120001']]) {
    assert.equal(timeline(bad).verified, false, JSON.stringify(bad));
  }
  // A legal leap second (23:59:60 UTC on 31 December) cannot be turned into intervals without a leap-second table.
  const leap = timeline(['20161231235959.500+0000', '20161231235960.000+0000', '20170101000000.500+0000']);
  assert.deepEqual([leap.verified, leap.reason], [false, 'leap-second']);
});

test('XA03 allow: forward, reverse, yoyo, ranges and loops visit every frame of the range, the last included, endpoints once', () => {
  const all = { first: 0, last: 5, loop: true };
  assert.deepEqual(walk(0, 7, { ...all, mode: 'forward' }), [0, 1, 2, 3, 4, 5, 0, 1], 'XA-X4: forward play must reach the last stored frame before it loops');
  assert.deepEqual(walk(0, 6, { ...all, mode: 'forward', loop: false }), [0, 1, 2, 3, 4, 5, 'stop'], 'XA-X4: forward play must reach the last stored frame before it loops');
  assert.deepEqual(walk(5, 6, { ...all, mode: 'reverse' }), [5, 4, 3, 2, 1, 0, 5]);
  const yoyo = walk(0, 12, { first: 0, last: 3, loop: true, mode: 'yoyo', direction: 1 });
  assert.deepEqual(yoyo, [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0], 'XA-X5: yoyo turns at each end without showing the end frame twice');
  assert.ok(yoyo.every((v, i) => i === 0 || v !== yoyo[i - 1]), 'XA-X5: yoyo turns at each end without showing the end frame twice');
  assert.deepEqual(walk(0, 8, { first: 0, last: 3, loop: false, mode: 'yoyo', direction: 1 }), [0, 1, 2, 3, 2, 1, 0, 'stop']);
  assert.deepEqual(walk(2, 4, { first: 2, last: 4, loop: true, mode: 'forward' }), [2, 3, 4, 2, 3]);
  assert.deepEqual(M.windowPlan({ index: 0, first: 0, last: 5, mode: 'forward', direction: 1, loop: true, ahead: 3 }), [0, 1, 2, 3]);
  assert.deepEqual(M.windowPlan({ index: 4, first: 0, last: 5, mode: 'forward', direction: 1, loop: true, ahead: 8 }), [4, 5, 0, 1, 2, 3], 'a window never repeats a frame');
  assert.deepEqual(M.windowPlan({ index: 3, first: 0, last: 3, mode: 'yoyo', direction: 1, loop: true, ahead: 8 }), [3, 2, 1, 0]);
  assert.deepEqual(M.windowPlan({ index: 4, first: 0, last: 5, mode: 'forward', direction: 1, loop: false, ahead: 8 }), [4, 5], 'a window stops where play stops');
});

test('XA03 reject: an invalid range or play state is refused, never clamped into another frame', () => {
  const base = { index: 0, first: 0, last: 5, mode: 'forward', direction: 1, loop: true };
  for (const change of [{ first: 3, last: 3 }, { first: 4, last: 2 }, { index: 6 }, { index: -1 }, { index: 1.5 }, { mode: 'shuffle' }, { first: -1 }]) {
    assert.throws(() => M.step({ ...base, ...change }), RangeError, JSON.stringify(change));
  }
  const d = M.describe(fixed(6, 33));
  assert.throws(() => M.frame(d, 1.5), RangeError);
  assert.throws(() => M.interval(d.timing, { kind: 'source', rate: 1 }, 7, 8, { first: 0, last: 5 }), RangeError);
  assert.throws(() => M.interval(d.timing, { kind: 'source', rate: 3 }, 0, 1, { first: 0, last: 5 }), RangeError, 'only the offered rates');
  assert.throws(() => M.createCoverage(4, 2), RangeError);
});

// Forward play through the ledger exactly as a viewport uses it: lease the window, start and settle each supply,
// draw and publish the current frame, detach the previous front, let go of frames that left the window.
function traverse(d, owners = 1) {
  const ledger = M.createLedger(M.LIMITS), scope = 'scope', owner = {}, leases = new Map(), shown = [];
  const ahead = M.aheadFor({ frameBytes: d.frameBytes, owners });
  let index = 0, direction = 1, notReady = 0;
  const reclaim = () => { for (const t of ledger.reclaimables()) { ledger.reclaim(t); ledger.released(t); } };
  for (let n = 0; n < d.frames; n++) {
    const plan = M.windowPlan({ index, first: 0, last: d.frames - 1, mode: 'forward', direction, loop: false, ahead });
    for (const [i, held] of [...leases]) if (!plan.includes(i)) { ledger.leave(held.lease, held.resource); leases.delete(i); }
    reclaim();
    for (const i of plan) {
      if (leases.has(i)) continue;
      const lease = {}, r = ledger.admit({ lease, scope, key: M.frame(d, i).key, payload: d.payloadBytes });
      if (!r.ok) break;
      leases.set(i, { lease, resource: r.resource });
      if (!r.joined) { ledger.start(r.resource); ledger.settle(r.resource, true); }
    }
    const held = leases.get(index);
    if (!held || ledger.state(held.resource) !== 'decoded') { notReady++; break; }
    const draw = ledger.beginDraw({ resource: held.resource, lease: held.lease, owner, surface: d.surfaceBytes });
    if (!draw.ok) { notReady++; break; }
    const { previous } = ledger.publish(draw.draw, owner);
    if (previous) ledger.drop(previous);
    ledger.leave(held.lease, held.resource); leases.delete(index);
    shown.push(index);
    const s = M.step({ index, first: 0, last: d.frames - 1, mode: 'forward', direction, loop: false });
    if (s.stop) break;
    index = s.next; direction = s.direction;
  }
  return { shown, notReady, snapshot: ledger.snapshot() };
}
const ledgerOf = (bytes, decodes = 4, prepared = 500) => M.createLedger({ bytes, decodes, prepared, ahead: 8 });
// Admit one consumer lease and return what the ledger gave it.
function take(ledger, key, payload, { scope = 'A', lease = {} } = {}) {
  const r = ledger.admit({ lease, scope, key, payload });
  return { ...r, lease };
}

test('XA04 allow: a 601-frame run and a run over 128 MiB play first to last inside one bounded budget', () => {
  const long = M.describe(fixed(601, 10, { rows: 512, cols: 512 }));
  assert.equal(long.frames, 601, 'XA-X13: a 601-frame run keeps all 601 frames; nothing is cut at 500');
  assert.equal(M.route(long).path, 'xa', 'XA-X13: a 601-frame run keeps all 601 frames; nothing is cut at 500');
  assert.equal(long.frameBytes, 512 * 512 * 8, 'Float32 decode + RGBA8 staging per mono pixel');
  assert.deepEqual([long.payloadBytes, long.surfaceBytes], [512 * 512 * 4, 512 * 512 * 4], 'shared payload and per-viewport surface');
  assert.ok(long.frameBytes * long.frames > M.LIMITS.bytes, 'the run is larger than the budget');
  const a = traverse(long);
  assert.deepEqual(a.shown, Array.from({ length: 601 }, (_, i) => i), 'XA-X13: a 601-frame run keeps all 601 frames; nothing is cut at 500');
  assert.equal(a.notReady, 0);
  assert.ok(a.snapshot.peakBytes <= M.LIMITS.bytes && a.snapshot.peakPrepared <= M.LIMITS.prepared && a.snapshot.peakLoading <= M.LIMITS.decodes, JSON.stringify(a.snapshot));
  // 40 frames of 1024 x 1024: 160 MiB even by the old whole-run RGBA estimate (rows*columns*4), which refused it.
  const big = M.describe(fixed(40, 33, { rows: 1024, cols: 1024 }));
  assert.ok(1024 * 1024 * 4 * 40 > 129 * MiB);
  const b = traverse(big);
  assert.equal(b.shown.length, 40);
  assert.equal(b.shown.at(-1), 39);
  assert.equal(b.notReady, 0);
  assert.ok(b.snapshot.peakBytes <= M.LIMITS.bytes, JSON.stringify(b.snapshot));
  assert.ok(M.aheadFor({ frameBytes: big.frameBytes, owners: 2 }) < M.aheadFor({ frameBytes: big.frameBytes, owners: 1 }), 'two playing viewports share the budget');
});

test('XA04 reject: in-flight frames count, decoding stays at four, too-large or unreadable frames never reserve, no viewport frees another\'s frame', () => {
  const small = ledgerOf(10);
  const a = take(small, 'a', 4), b = take(small, 'b', 4);
  assert.deepEqual([a.ok, b.ok], [true, true]);
  small.start(a.resource);
  assert.equal(small.snapshot().bytes, 8, 'XA-X7: a frame still loading holds its reservation');
  assert.deepEqual(take(small, 'c', 4).reason, 'bytes', 'XA-X7: a frame still loading holds its reservation');
  const wide = ledgerOf(1000);
  const four = ['1', '2', '3', '4'].map(key => take(wide, key, 1));
  assert.ok(four.every(r => r.ok));
  assert.equal(take(wide, '5', 1).reason, 'decodes', 'XA-X8: no more than four frames decode at once');
  wide.start(four[0].resource); wide.settle(four[0].resource, true);
  assert.equal(take(wide, '5', 1).ok, true, 'a settled decode frees a decode permit');
  const few = ledgerOf(1000, 10, 3);
  for (const key of ['x', 'y', 'z']) take(few, key, 1);
  assert.equal(take(few, 'w', 1).reason, 'prepared');
  assert.equal(take(ledgerOf(M.LIMITS.bytes), 'huge', M.LIMITS.bytes + 1).reason, 'too-large');
  for (const size of [0, -1, 1.5, NaN, null]) assert.equal(take(ledgerOf(1000), 'k', size).ok, false, String(size));
  assert.equal(M.route(M.describe(fixed(8, 33, { rows: 8192, cols: 4096 }))).reason, 'frame-too-large');
  const noRows = fixed(8, 33); delete noRows['00280010'];
  assert.deepEqual([M.describe(noRows).frameBytes, M.route(M.describe(noRows)).path], [null, 'refused']);
  // Two viewports of the same opening share one reservation; B letting go never frees what A still holds.
  const ledger = ledgerOf(1000), A = take(ledger, 'sop#7', 100), B = take(ledger, 'sop#7', 100);
  assert.deepEqual([A.joined, B.joined, B.resource === A.resource, ledger.snapshot().bytes], [false, true, true, 100], 'one decode, one reservation');
  ledger.start(A.resource);
  assert.equal(ledger.leave(B.lease, B.resource), 'kept', 'XA-X9: another viewport\'s frame stays when one viewport lets go');
  assert.equal(ledger.holds(A.lease, A.resource), true, 'XA-X9: another viewport\'s frame stays when one viewport lets go');
  assert.equal(ledger.retiring(A.resource), false, 'XA-X9: another viewport\'s frame stays when one viewport lets go');
  assert.equal(ledger.leave(B.lease, B.resource), null, 'a viewport cannot release what it does not hold');
  ledger.settle(A.resource, true);
  assert.equal(ledger.leave(A.lease, A.resource), 'unheld');
  assert.deepEqual([ledger.reclaim(A.resource), ledger.released(A.resource), ledger.snapshot().bytes], [true, true, 0]);
  const C = take(ledger, 'sop#8', 50), D = take(ledger, 'sop#8', 50);
  ledger.start(C.resource);
  assert.equal(ledger.settle(C.resource, false), 'failed', 'a failed load ends the reservation for every holder');
  assert.deepEqual([ledger.holds(C.lease, C.resource), ledger.holds(D.lease, D.resource), ledger.snapshot().bytes], [false, false, 0]);
});

test('XA04 reject: a cancelled or timed-out load keeps its bytes and decode slot until the load itself ends, and nobody joins it', () => {
  const small = ledgerOf(10);
  const a = take(small, 'a', 4);
  small.start(a.resource);
  assert.equal(small.leave(a.lease, a.resource), 'retire', 'A was the last holder of a running load');
  assert.equal(small.snapshot().bytes, 4, 'XA-X16: a cancelled load still decoding keeps its reservation until it ends');
  assert.equal(small.state(a.resource), 'loading', 'XA-X16: a cancelled load still decoding keeps its reservation until it ends');
  take(small, 'b', 4);
  assert.equal(take(small, 'c', 4).reason, 'bytes', 'XA-X16: a cancelled load still decoding keeps its reservation until it ends');
  assert.equal(take(small, 'a', 4).reason, 'busy', 'an ending load cannot be joined or restarted');
  assert.equal(small.settle(a.resource, true), 'release', 'a late image of a cancelled load is given back, never held');
  assert.equal(small.snapshot().bytes, 8, 'until the release is acknowledged the bytes stay');
  assert.equal(small.released(a.resource), true);
  assert.equal(take(small, 'c', 4).ok, true);
  assert.equal(small.snapshot().bytes, 8);
  // Many cancels in flight never open more decode permits than four.
  const slots = ledgerOf(1000);
  const runs = ['1', '2', '3', '4'].map(key => { const r = take(slots, key, 1); slots.start(r.resource); slots.leave(r.lease, r.resource); return r; });
  assert.deepEqual([slots.snapshot().loading, slots.snapshot().retiring], [4, 4]);
  assert.equal(take(slots, '5', 1).reason, 'decodes', 'XA-X16: a cancelled load still decoding keeps its reservation until it ends');
  slots.settle(runs[0].resource, false);
  assert.equal(take(slots, '5', 1).ok, true);
  // An admitted resource whose source was never called is simply abandoned: nothing to release.
  const never = take(ledgerOf(100), 'n', 30);
  assert.equal(never.ok, true);
});

test('B05 model: an old incarnation\'s duplicate settle, leave or release never touches the new resource of the same frame', () => {
  const ledger = ledgerOf(100);
  const old = take(ledger, 'sop#1', 10);
  ledger.start(old.resource); ledger.leave(old.lease, old.resource);
  assert.equal(ledger.settle(old.resource, true), 'release');
  assert.equal(ledger.snapshot().bytes, 10, 'the old release is not acknowledged yet: its bytes stay');
  assert.equal(take(ledger, 'sop#1', 10).reason, 'busy', 'the same frame waits while the old one drains');
  ledger.released(old.resource);
  const fresh = take(ledger, 'sop#1', 10);
  assert.equal(fresh.ok, true);
  assert.notEqual(fresh.resource, old.resource, 'a new incarnation has a new token');
  ledger.start(fresh.resource);
  const before = ledger.snapshot();
  assert.equal(ledger.settle(old.resource, true), null, 'XA-X35: an old token never reaches the new incarnation');
  assert.equal(ledger.released(old.resource), false, 'XA-X35: an old token never reaches the new incarnation');
  assert.equal(ledger.leave(old.lease, old.resource), null, 'XA-X35: an old token never reaches the new incarnation');
  assert.equal(ledger.abandon(old.resource), false);
  assert.deepEqual(ledger.snapshot(), before, 'XA-X35: an old token never reaches the new incarnation');
  assert.equal(ledger.state(fresh.resource), 'loading');
  // A failed release keeps its bytes counted; nothing goes negative.
  ledger.settle(fresh.resource, true); ledger.leave(fresh.lease, fresh.resource); ledger.reclaim(fresh.resource);
  assert.equal(ledger.released(fresh.resource, false), false);
  assert.equal(ledger.snapshot().bytes, 10, 'a failed release is not accounted as returned');
  assert.ok(Object.values(ledger.snapshot()).every(v => typeof v !== 'number' || v >= 0));
});

test('B06 model: viewports of one opening share a load; one leaving cancels nobody else, and a retiring load is never joined', () => {
  const ledger = ledgerOf(1000);
  const first = take(ledger, 'sop#3', 40, { scope: 'O1' }), second = take(ledger, 'sop#3', 40, { scope: 'O1' });
  assert.deepEqual([first.joined, second.joined, first.resource === second.resource], [false, true, true]);
  ledger.start(first.resource);
  assert.equal(ledger.leave(first.lease, first.resource), 'kept', 'the first viewport leaving does not cancel the second');
  assert.equal(ledger.retiring(first.resource), false);
  assert.equal(ledger.settle(first.resource, true), 'decoded', 'the remaining consumer still gets the frame');
  assert.equal(ledger.leave(second.lease, second.resource), 'unheld');
  const third = take(ledger, 'sop#4', 40, { scope: 'O1' });
  ledger.start(third.resource); ledger.leave(third.lease, third.resource);
  assert.equal(take(ledger, 'sop#4', 40, { scope: 'O1' }).reason, 'busy', 'XA-X26: a retiring load is never joined or revived');
  assert.equal(ledger.snapshot().retiring, 1, 'XA-X26: a retiring load is never joined or revived');
  ledger.settle(third.resource, false);
  const again = take(ledger, 'sop#4', 40, { scope: 'O1' });
  assert.deepEqual([again.ok, again.joined, again.resource !== third.resource], [true, false, true], 'after it ends, a new token is admitted');
});

test('B07 model: under pressure only a decoded frame with no lease, no draw and no front is reclaimed', () => {
  const ledger = ledgerOf(1000), owner = {};
  const shown = take(ledger, 's', 10), drawing = take(ledger, 'd', 10), loading = take(ledger, 'l', 10), idle = take(ledger, 'i', 10);
  for (const r of [shown, drawing, idle]) { ledger.start(r.resource); ledger.settle(r.resource, true); }
  ledger.start(loading.resource);
  const front = ledger.beginDraw({ resource: shown.resource, lease: shown.lease, owner, surface: 5 });
  ledger.publish(front.draw, owner);
  ledger.leave(shown.lease, shown.resource);                     // quiescent shown: only its front pins it
  ledger.beginDraw({ resource: drawing.resource, lease: drawing.lease, owner: {}, surface: 5 });
  ledger.leave(drawing.lease, drawing.resource);                 // drawing: only the draw pins it
  ledger.leave(idle.lease, idle.resource);                       // decoded, held by nothing
  assert.deepEqual(ledger.reclaimables(), [idle.resource], 'XA-X29: a shown, drawing or loading frame is never reclaimed');
  assert.equal(ledger.reclaim(shown.resource), false, 'XA-X29: a shown, drawing or loading frame is never reclaimed');
  assert.equal(ledger.reclaim(drawing.resource), false);
  assert.equal(ledger.reclaim(loading.resource), false);
  assert.equal(ledger.reclaim(idle.resource), true);
  // The shown frame comes back only through the normal path: a new front replaces it and its surface is let go.
  const next = take(ledger, 'n', 10); ledger.start(next.resource); ledger.settle(next.resource, true);
  const nextDraw = ledger.beginDraw({ resource: next.resource, lease: next.lease, owner, surface: 5 });
  const { previous } = ledger.publish(nextDraw.draw, owner);
  assert.equal(previous, front.draw);
  assert.equal(ledger.drop(previous), true);
  assert.equal(ledger.reclaim(shown.resource), true, 'detached and let go: now reclaimable, once');
  assert.equal(ledger.reclaim(shown.resource), false);
});

test('B08 model: the same SOP and frame under another account, institution, session, opening or source revision is another resource', () => {
  const opening = { account: 'reader', institution: 'hospital', study: '2.25.1', series: '2.25.2', sop: '2.25.3', sequence: 1, session: 'S1' };
  const base = M.scopeKey(opening, 'r1');
  const others = [{ ...opening, account: 'other' }, { ...opening, institution: 'other' }, { ...opening, session: 'S2' }, { ...opening, sequence: 3 }]
    .map(o => M.scopeKey(o, 'r1')).concat([M.scopeKey(opening, 'r2')]);
  const ledger = ledgerOf(10000, 10), first = take(ledger, '2.25.3#1', 10, { scope: base });
  for (const scope of others) {
    const r = take(ledger, '2.25.3#1', 10, { scope });
    assert.deepEqual([r.ok, r.joined, r.resource !== first.resource], [true, false, true], 'XA-X22: another opening scope never shares a load: ' + scope);
  }
  assert.equal(take(ledger, '2.25.3#1', 10, { scope: base }).joined, true, 'the same complete opening and revision shares');
});

test('B09 model: a shared payload is counted once, every viewport surface on its own', () => {
  const ledger = ledgerOf(128), A = {}, B = {}, C = {};
  const fixedHold = take(ledger, 'other', 64);
  const a = take(ledger, 'f#1', 32), b = take(ledger, 'f#1', 32);
  ledger.start(a.resource); ledger.settle(a.resource, true);
  const drawA = ledger.beginDraw({ resource: a.resource, lease: a.lease, owner: A, surface: 16 });
  const drawB = ledger.beginDraw({ resource: b.resource, lease: b.lease, owner: B, surface: 16 });
  assert.deepEqual([fixedHold.ok, drawA.ok, drawB.ok, ledger.snapshot().bytes], [true, true, true, 128], '64 + 32 + 16 + 16; XA-X25: every surface is reserved on its own');
  const c = take(ledger, 'f#1', 32);
  assert.equal(c.joined, true, 'the payload is shared');
  assert.equal(ledger.beginDraw({ resource: c.resource, lease: c.lease, owner: C, surface: 16 }).reason, 'bytes', 'XA-X25: a third surface needs its own 16 MiB');
  assert.equal(ledger.snapshot().bytes, 128, 'XA-X25: a third surface needs its own 16 MiB');
  ledger.publish(drawA.draw, A); ledger.detach(drawA.draw); ledger.drop(drawA.draw);
  assert.equal(ledger.beginDraw({ resource: c.resource, lease: c.lease, owner: C, surface: 16 }).ok, true, 'after one surface is let go');
});

test('B12 model: bytes, four decodes and 500 prepared each refuse at the bound and admit again only after real returns', () => {
  const bytes = ledgerOf(100), held = take(bytes, 'h', 60);
  assert.equal(take(bytes, 'x', 41).reason, 'bytes');
  assert.equal(take(bytes, 'x', 40).ok, true);
  const decodes = ledgerOf(1000), runs = [1, 2, 3, 4].map(i => take(decodes, 'k' + i, 1));
  runs.forEach(r => decodes.start(r.resource));
  assert.equal(take(decodes, 'k5', 1).reason, 'decodes');
  decodes.leave(runs[0].lease, runs[0].resource);
  assert.equal(take(decodes, 'k5', 1).reason, 'decodes', 'a cancel is not an end');
  decodes.settle(runs[0].resource, true);
  assert.equal(take(decodes, 'k5', 1).ok, true, 'the decoder really stopped');
  const prepared = ledgerOf(10000, 1000, 500), all = [];
  for (let i = 0; i < 500; i++) { const r = take(prepared, 'p' + i, 1); prepared.start(r.resource); prepared.settle(r.resource, true); all.push(r); }
  assert.equal(take(prepared, 'p500', 1).reason, 'prepared');
  prepared.leave(all[0].lease, all[0].resource); prepared.reclaim(all[0].resource);
  assert.equal(take(prepared, 'p500', 1).reason, 'prepared', 'draining still counts');
  prepared.released(all[0].resource);
  assert.equal(take(prepared, 'p500', 1).ok, true);
  const s = prepared.snapshot();
  assert.deepEqual([s.prepared, s.peakPrepared <= 500, s.peakLoading <= 1000, held.ok], [500, true, true, true]);
});

test('B13 model: every way a frame can end returns exactly what it took, once, and nothing before it really ended', () => {
  const ledger = ledgerOf(1000), owner = {};
  const never = take(ledger, 'never', 10);
  assert.equal(ledger.leave(never.lease, never.resource), 'unstarted');
  assert.equal(ledger.abandon(never.resource), true, 'a source never called gives its reservation straight back');
  const thrown = take(ledger, 'thrown', 10); ledger.start(thrown.resource);
  assert.equal(ledger.settle(thrown.resource, false), 'failed');
  const late = take(ledger, 'late', 10); ledger.start(late.resource); ledger.leave(late.lease, late.resource);
  assert.equal(ledger.snapshot().bytes, 10, 'started work keeps its reservation until it settles');
  assert.equal(ledger.settle(late.resource, false), 'failed');
  const drawn = take(ledger, 'drawn', 10); ledger.start(drawn.resource); ledger.settle(drawn.resource, true);
  const draw = ledger.beginDraw({ resource: drawn.resource, lease: drawn.lease, owner, surface: 5 });
  ledger.leave(drawn.lease, drawn.resource);
  assert.equal(ledger.reclaim(drawn.resource), false, 'a draw still pins it');
  assert.equal(ledger.drop(draw.draw, false), false, 'a renderer that failed to let go keeps its surface counted');
  assert.equal(ledger.snapshot().bytes, 15);
  assert.equal(ledger.drop(draw.draw, true), true);
  assert.equal(ledger.drop(draw.draw, true), false, 'a second drop changes nothing');
  ledger.reclaim(drawn.resource);
  assert.equal(ledger.released(drawn.resource), true);
  assert.equal(ledger.released(drawn.resource), false);
  assert.deepEqual(ledger.snapshot().bytes + ledger.snapshot().loading + ledger.snapshot().prepared + ledger.snapshot().retiring, 0);
});

const enhancedTimeline = times => M.describe(run({ frames: times.length, sopClass: ENHANCED, extra: { '52009230': perFrame(times), '00209222': dimension('00189151') } })).timing;
test('B14 model: trailing ASCII SPACE is DT padding and changes nothing; the stored text is kept as it was', () => {
  const full = enhancedTimeline(['20261009120000.123456+0900', '20261009120000.223457+0900']);  // 26 characters: no room to pad
  assert.equal(full.verified, true);
  close(full.offsets[1], 100.001, 'microseconds kept');
  const plain = enhancedTimeline(['20261009120000', '20261009120001']), padded = enhancedTimeline(['20261009120000 ', '20261009120001 ']);
  assert.deepEqual([padded.verified, [...padded.offsets]], [plain.verified, [...plain.offsets]], 'padded and unpadded are the same time');
  assert.deepEqual([padded.verified, [...padded.offsets]], [true, [0, 1000]]);
  const year = enhancedTimeline(['20261231235959.999999 ', '20270101000000.000001 ']);
  assert.equal(year.verified, true);
  close(year.offsets[1], 0.002, 'across a year boundary');
  assert.equal(year.basis.origin, '20261231235959.999999 ', 'the stored text is not rewritten');
  assert.equal(enhancedTimeline(['20261009120000.0400' + ' '.repeat(8), '20261009120000.0800']).verified, false, 'padding cannot exceed the DT length');
  const ft = M.describe(fixed(3, 40, { extra: { '00181066': el('DS', 250) } })).timing;
  assert.deepEqual([...ft.basis.relative], [250, 290, 330], 'Frame Delay basis unchanged');
});

test('B15 model: leading or inner space, TAB, CR, LF, NBSP, NUL, BOM or too long a DT is invalid, never trimmed into a time', () => {
  const good = '20261009120000.040000';
  const bad = [' ' + good, good.slice(0, 8) + ' ' + good.slice(8), good + '\t', '\t' + good, good + '\r', good + '\n', '\n' + good,
    good + ' ', ' ' + good, good + '\u0000', '﻿' + good, good + ' ', good + '+0900  ', '2026100912000O', good + '+090A'];
  for (const value of bad) {
    const t = enhancedTimeline(['20261009120000.000000', value]);
    assert.equal(t.verified, false, 'XA-X37: only trailing ASCII SPACE is DT padding ' + JSON.stringify(value));
    assert.equal(M.speedOptions(t).some(s => s.kind === 'source'), false);
  }
  const raw = ['20261009120000.000000', ' ' + good];
  const json = run({ frames: 2, sopClass: ENHANCED, extra: { '52009230': perFrame(raw), '00209222': dimension('00189151') } });
  const copy = JSON.stringify(json);
  M.describe(json);
  assert.equal(JSON.stringify(json), copy, 'the input is not modified');
});

test('B16 model: a legal but coarse DT, a bad date or offset, a leap second or a non-increasing timeline is never filled in as verified', () => {
  const coarse = enhancedTimeline(['2026', '2027']);
  assert.deepEqual([coarse.verified, coarse.reason], [false, 'content-precision'], 'legal, too coarse to time frames');
  const minutes = enhancedTimeline(['202610091200', '202610091201']);
  assert.deepEqual([minutes.verified, minutes.reason], [false, 'content-precision']);
  const zonedYear = enhancedTimeline(['2007-0500', '2008-0500']);
  assert.deepEqual([zonedYear.verified, zonedYear.reason], [false, 'content-precision'], 'PS3.5 example 2007-0500 is legal');
  for (const bad of [['20261332120000', '20261332120001'], ['20261009120000+1500', '20261009120001+1500'], ['20261009120000-0000', '20261009120001-0000']]) {
    assert.deepEqual([enhancedTimeline(bad).verified, enhancedTimeline(bad).reason], [false, 'content-time'], JSON.stringify(bad));
  }
  assert.equal(enhancedTimeline(['20161231235959+0000', '20161231235960+0000']).reason, 'leap-second');
  assert.equal(enhancedTimeline(['20261009120001', '20261009120000']).reason, 'content-order');
  assert.equal(enhancedTimeline(['20261009120000', '20261009120001']).verified, true, 'a complete, increasing timeline');
});

test('XA05 allow: the same opening stays current, and a late frame keeps its place and its source interval', () => {
  const opened = { account: 'reader', institution: 'hospital', study: '2.25.1', series: '2.25.2', sop: '2.25.3', sequence: 4 };
  assert.equal(M.sameOpening(opened, { ...opened }), 'current');
  assert.equal(M.sameOpening(opened, { ...opened, sessionId: 'S1' }), 'current', 'other session facts do not change the opening');
  const d = M.describe(timed([0, 30, 30, 90, 30]));
  // Lateness is not an input of play order or timing: after any buffering the next frame is still index + 1.
  const range = { first: 0, last: 4 };
  assert.deepEqual(M.step({ index: 2, ...range, mode: 'forward', direction: 1, loop: true }), { stop: false, direction: 1, next: 3 });
  assert.equal(M.interval(d.timing, { kind: 'source', rate: 1 }, 2, 3, range), 90);
  assert.deepEqual(M.windowPlan({ index: 2, ...range, mode: 'forward', direction: 1, loop: true, ahead: 2 }), [2, 3, 4], 'the window keeps the waiting frame first');
});

test('XA05 reject: another account, no session or the same object opened again (A->B->A) is not the current opening', () => {
  const opened = { account: 'reader', institution: 'hospital', study: '2.25.1', series: '2.25.2', sop: '2.25.3', sequence: 4 };
  assert.equal(M.sameOpening(opened, null), 'ended');
  assert.equal(M.sameOpening(opened, undefined), 'ended');
  assert.equal(M.sameOpening(opened, { ...opened, account: 'other' }), 'ended');
  assert.equal(M.sameOpening(opened, { ...opened, institution: 'other' }), 'ended');
  assert.equal(M.sameOpening(opened, { ...opened, sop: '2.25.9' }), 'stale');
  assert.equal(M.sameOpening(opened, { ...opened, study: '2.25.9' }), 'stale');
  assert.equal(M.sameOpening(opened, { ...opened, sequence: 6 }), 'stale', 'XA-X11: the same object opened again is a new opening');
  // A missing field never matches by being equally missing; a new login session of the same person is not this opening.
  assert.equal(M.sameOpening({}, {}), 'ended');
  assert.equal(M.sameOpening({ account: 'reader' }, { account: 'reader' }), 'ended');
  for (const field of ['account', 'institution', 'study', 'series', 'sop', 'sequence']) {
    const partial = { ...opened }; delete partial[field];
    assert.equal(M.sameOpening(partial, partial), 'ended', field);
    assert.equal(M.sameOpening(opened, partial), 'ended', field);
  }
  assert.equal(M.sameOpening({ ...opened, session: 'old' }, { ...opened, session: 'new' }), 'ended');
  assert.equal(M.sameOpening({ ...opened, session: 'old' }, { ...opened }), 'ended');
  // The opening must name the very object the source supplies.
  const d = M.describe(fixed(4, 33));
  const key = { ...opened, study: d.study, series: d.series, sop: d.sop };
  assert.deepEqual({ ...M.openingMatches(key, d) }, { ok: true, reason: null });
  for (const field of ['study', 'series', 'sop']) assert.deepEqual({ ...M.openingMatches({ ...key, [field]: '2.25.999' }, d) }, { ok: false, reason: 'manifest' }, field);
  assert.equal(M.openingMatches({ ...key, account: '' }, d).reason, 'opening');
  assert.equal(M.openingMatches(key, M.describe(null)).ok, false);
});

test('XA06 allow: a frame is shown only after its render; after a middle failure the retried frame completes the range', () => {
  const coverage = M.createCoverage(0, 9);
  for (let i = 0; i < 6; i++) coverage.mark(i);
  assert.deepEqual(coverage.snapshot(), { shown: 6, total: 10, all: false }, 'frame 7 failed and is not shown');
  for (const i of [6, 7, 8, 9]) coverage.mark(i);
  assert.deepEqual(coverage.snapshot(), { shown: 10, total: 10, all: true });
  assert.equal(M.failureKind({ status: 403 }), 'denied');
  assert.equal(M.failureKind({ status: 401 }), 'denied');
  assert.equal(M.failureKind(Object.assign(new Error('x'), { name: 'AbortError' })), 'interrupted');
  assert.equal(M.failureKind(Object.assign(new Error('x'), { name: 'AbortError' }), { cancelled: true }), 'cancelled');
  assert.equal(M.failureKind(new Error('x'), { timedOut: true }), 'timeout');
  assert.equal(M.failureKind(new Error('JPEG decode failed')), 'failed');
  assert.equal(M.failureKind({ status: 500 }), 'failed');
});

test('XA06 reject: refused access, codec failure, cancellation and out-of-range marks never make All Shown', () => {
  const coverage = M.createCoverage(2, 6);
  for (const i of [2, 3, 4, 5, 5, 5, 1, 7, -1, 2.5]) coverage.mark(i);
  assert.deepEqual(coverage.snapshot(), { shown: 4, total: 5, all: false }, 'frame 7 of the range (index 6) never rendered');
  for (const kind of [M.failureKind({ status: 403 }), M.failureKind(new Error('codec')), M.failureKind(null, { cancelled: true })]) {
    assert.notEqual(kind, 'shown');
    assert.ok(['denied', 'failed', 'cancelled'].includes(kind), kind);
  }
});
