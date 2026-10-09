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

function traverse(d, owners = 1) {
  const budget = M.createBudget(M.LIMITS), owner = {}, held = new Set(), shown = [];
  const ahead = M.aheadFor({ frameBytes: d.frameBytes, owners });
  let index = 0, direction = 1, notReady = 0;
  for (let n = 0; n < d.frames; n++) {
    const plan = M.windowPlan({ index, first: 0, last: d.frames - 1, mode: 'forward', direction, loop: false, ahead });
    for (const key of [...held]) if (!plan.some(i => M.frame(d, i).key === key)) { budget.release(owner, key); held.delete(key); }
    for (let pass = 0; pass < 3; pass++) {
      for (const i of plan) {
        const key = M.frame(d, i).key;
        if (held.has(key)) continue;
        if (!budget.reserve(owner, key, d.frameBytes).ok) break;
        held.add(key);
      }
      for (const key of held) budget.ready(key);
    }
    if (budget.state(M.frame(d, index).key) !== 'ready') notReady++;
    shown.push(index);
    const s = M.step({ index, first: 0, last: d.frames - 1, mode: 'forward', direction, loop: false });
    if (s.stop) break;
    index = s.next; direction = s.direction;
  }
  return { shown, notReady, snapshot: budget.snapshot() };
}

test('XA04 allow: a 601-frame run and a run over 128 MiB play first to last inside one bounded budget', () => {
  const long = M.describe(fixed(601, 10, { rows: 512, cols: 512 }));
  assert.equal(long.frames, 601, 'XA-X13: a 601-frame run keeps all 601 frames; nothing is cut at 500');
  assert.equal(M.route(long).path, 'xa', 'XA-X13: a 601-frame run keeps all 601 frames; nothing is cut at 500');
  assert.equal(long.frameBytes, 512 * 512 * 8, 'Float32 decode + RGBA8 staging per mono pixel');
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
  const small = M.createBudget({ bytes: 10, decodes: 4, prepared: 500, ahead: 8 });
  const owner = {};
  assert.equal(small.reserve(owner, 'a', 4).ok, true);
  assert.equal(small.reserve(owner, 'b', 4).ok, true);
  assert.equal(small.snapshot().bytes, 8, 'XA-X7: a frame still loading holds its reservation');
  assert.deepEqual(small.reserve(owner, 'c', 4), { ok: false, reason: 'bytes' }, 'XA-X7: a frame still loading holds its reservation');
  const wide = M.createBudget({ bytes: 1000, decodes: 4, prepared: 500, ahead: 8 });
  for (const key of ['1', '2', '3', '4']) assert.equal(wide.reserve(owner, key, 1).ok, true);
  assert.deepEqual(wide.reserve(owner, '5', 1), { ok: false, reason: 'decodes' }, 'XA-X8: no more than four frames decode at once');
  wide.ready('1');
  assert.equal(wide.reserve(owner, '5', 1).ok, true, 'a finished decode frees a decode slot');
  const few = M.createBudget({ bytes: 1000, decodes: 10, prepared: 3, ahead: 8 });
  for (const key of ['x', 'y', 'z']) few.reserve(owner, key, 1);
  assert.deepEqual(few.reserve(owner, 'w', 1), { ok: false, reason: 'prepared' });
  assert.deepEqual(M.createBudget().reserve(owner, 'huge', M.LIMITS.bytes + 1), { ok: false, reason: 'too-large' });
  for (const size of [0, -1, 1.5, NaN, null]) assert.equal(M.createBudget().reserve(owner, 'k', size).ok, false, String(size));
  assert.equal(M.route(M.describe(fixed(8, 33, { rows: 8192, cols: 4096 }))).reason, 'frame-too-large');
  const noRows = fixed(8, 33); delete noRows['00280010'];
  assert.deepEqual([M.describe(noRows).frameBytes, M.route(M.describe(noRows)).path], [null, 'refused']);
  // Two viewports of the same frame share one reservation; B letting go never frees what A still shows.
  const budget = M.createBudget(), A = {}, B = {};
  assert.deepEqual(budget.reserve(A, 'sop#7', 100), { ok: true, shared: false, state: 'loading' });
  assert.deepEqual(budget.reserve(B, 'sop#7', 100), { ok: true, shared: true, state: 'loading' });
  assert.equal(budget.snapshot().bytes, 100, 'one decode, one reservation');
  assert.equal(budget.ready('sop#7'), true);
  assert.equal(budget.release(B, 'sop#7'), false, 'XA-X9: another viewport\'s frame stays when one viewport lets go');
  assert.equal(budget.holds(A, 'sop#7'), true, 'XA-X9: another viewport\'s frame stays when one viewport lets go');
  assert.equal(budget.snapshot().bytes, 100, 'XA-X9: another viewport\'s frame stays when one viewport lets go');
  assert.equal(budget.release(B, 'sop#7'), false, 'a viewport cannot release what it does not hold');
  assert.equal(budget.release(A, 'sop#7'), true);
  assert.equal(budget.snapshot().bytes, 0);
  budget.reserve(A, 'sop#8', 50); budget.reserve(B, 'sop#8', 50);
  assert.equal(budget.drop('sop#8'), true, 'a failed load ends the reservation for every holder');
  assert.equal(budget.holds(A, 'sop#8') || budget.holds(B, 'sop#8'), false);
});

test('XA04 reject: a cancelled or timed-out load keeps its bytes and decode slot until the load itself ends, and nobody joins it', () => {
  const A = {}, B = {};
  const small = M.createBudget({ bytes: 10, decodes: 4, prepared: 500, ahead: 8 });
  small.reserve(A, 'a', 4);
  assert.equal(small.release(A, 'a'), true, 'A was the last holder');
  assert.equal(small.snapshot().bytes, 4, 'XA-X16: a cancelled load still decoding keeps its reservation until it ends');
  assert.equal(small.state('a'), 'retiring', 'XA-X16: a cancelled load still decoding keeps its reservation until it ends');
  small.reserve(A, 'b', 4);
  assert.deepEqual(small.reserve(A, 'c', 4), { ok: false, reason: 'bytes' }, 'XA-X16: a cancelled load still decoding keeps its reservation until it ends');
  assert.deepEqual(small.reserve(B, 'a', 4), { ok: false, reason: 'busy' }, 'an ending load cannot be joined or restarted');
  assert.equal(small.ready('a'), false, 'a late answer of a cancelled load does not become a held frame');
  assert.equal(small.drop('a'), true, 'the load has ended');
  assert.equal(small.reserve(A, 'c', 4).ok, true);
  assert.equal(small.snapshot().bytes, 8);
  // Many cancels in flight never open more decode slots than four.
  const slots = M.createBudget({ bytes: 1000, decodes: 4, prepared: 500, ahead: 8 });
  for (const key of ['1', '2', '3', '4']) { slots.reserve(A, key, 1); slots.release(A, key); }
  assert.deepEqual(slots.snapshot().loading, 4);
  assert.deepEqual(slots.reserve(A, '5', 1), { ok: false, reason: 'decodes' }, 'XA-X16: a cancelled load still decoding keeps its reservation until it ends');
  slots.drop('1');
  assert.equal(slots.reserve(A, '5', 1).ok, true);
  // A timeout lets every holder go at once; the reservation stays until the load really ends.
  const timed = M.createBudget({ bytes: 100, decodes: 4, prepared: 500, ahead: 8 });
  timed.reserve(A, 't', 30); timed.reserve(B, 't', 30);
  assert.equal(timed.retire('t'), true);
  assert.deepEqual([timed.holds(A, 't'), timed.holds(B, 't'), timed.snapshot().bytes, timed.snapshot().loading, timed.snapshot().retiring], [false, false, 30, 1, 1]);
  assert.equal(timed.release(A, 't'), false, 'nobody holds a retiring load any more');
  timed.drop('t');
  assert.deepEqual([timed.snapshot().bytes, timed.snapshot().loading], [0, 0]);
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
