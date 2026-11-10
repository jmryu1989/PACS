'use strict';
// REQ-MG-PRELOAD-CACHE -> RISK-PRELOAD-OOM-REPORT-LOSS / RISK-PRELOAD-STALE-IDENTITY / RISK-PRELOAD-CROSS-SESSION
// -> TEST-MG-PRELOAD-STORE: the preload store's budget, eviction order and revision rules (worklist-v0/hpacs-lite/preload-store.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { create, budgetFor, studyOfPath, STATUS } = require('../worklist-v0/hpacs-lite/preload-store.js');

const GB = 1024 ** 3;
const path = (study, n = 1, sop = '9.1') => `/dicom-web/studies/${study}/series/8.1/instances/${sop}/frames/${n}`;
let nextId = 0;
const frame = bytes => ({ entryId: 'opaque-' + (++nextId), bytes });
const status = (store, uid) => store.snapshot().studies.find(s => s.uid === uid);

/** Fetch `count` frames of `uid` of `bytes` each, as the worker does, and mark it Ready. */
function fill(store, uid, count, bytes, revision = 'r1') {
  store.start(uid, count);
  for (let n = 1; n <= count; n++) assert.equal(store.put(uid, path(uid, n), frame(bytes), revision), 'stored');
  assert.equal(store.ready(uid), true);
}

test('R10 disk cap comes only from the institution setting; unset or invalid means no storage', () => {
  assert.equal(budgetFor(2), 2 * GB);
  assert.equal(budgetFor(32), 32 * GB);
  for (const none of [undefined, null, 0, -1, NaN, '8', Infinity]) assert.equal(budgetFor(none), null);
  const store = create(null);
  store.add([{ uid: '1.1' }]);
  store.start('1.1', 1);
  assert.equal(store.put('1.1', path('1.1'), frame(10), 'r1'), 'full', 'a store without a budget keeps nothing');
  assert.equal(store.used(), 0);
});

test('only frame paths without a query name a study', () => {
  assert.equal(studyOfPath(path('1.2.3', 4)), '1.2.3');
  for (const other of ['/dicom-web/studies/1.2.3/metadata', path('1.2.3') + '?x=1', '/instances/abc/preview', path('1.2.3', '1,2')])
    assert.equal(studyOfPath(other), null, other);
});

test('disk space stays within the budget: the opened-and-closed study goes first, never the open one or one not read yet', () => {
  const store = create(100);
  store.add([{ uid: '1.1' }, { uid: '1.2' }, { uid: '1.3' }, { uid: '1.4' }]);
  fill(store, '1.1', 3, 10);           // read, then closed
  fill(store, '1.2', 3, 10);           // open in a viewer
  fill(store, '1.3', 3, 10);           // not read yet
  store.open('1.1'); assert.equal(store.close('1.1'), true);
  store.open('1.2');
  store.start('1.4', 2);
  assert.equal(store.put('1.4', path('1.4', 1), frame(10), 'r1'), 'stored');   // 100 of 100
  assert.equal(store.put('1.4', path('1.4', 2), frame(25), 'r1'), 'stored', 'room made by dropping A');
  assert.equal(status(store, '1.1').status, STATUS.evicted);
  assert.match(status(store, '1.1').reason, /Retry/);
  assert.equal(status(store, '1.2').status, STATUS.ready);
  assert.equal(status(store, '1.3').status, STATUS.ready);
  assert.ok(store.used() <= store.budget());
  // Nothing left that may go: the next frame waits for disk space instead of evicting B (open) or C (not read yet).
  store.start('1.4', 3);
  assert.equal(store.put('1.4', path('1.4', 3), frame(20), 'r1'), 'full');
  assert.equal(status(store, '1.4').status, STATUS.queued);
  assert.equal(status(store, '1.4').waiting, true);
  assert.equal(store.next(), null, 'a waiting study is not picked again until disk space may be free');
  assert.equal(status(store, '1.2').status, STATUS.ready);
  assert.equal(status(store, '1.3').status, STATUS.ready);
  assert.ok(store.used() <= store.budget());
  // The viewer closes B: it may go now, and the queue resumes with D, keeping D's frames.
  assert.equal(store.close('1.2'), true);
  assert.equal(store.wake(), true);
  assert.equal(store.next().uid, '1.4');
  store.start('1.4', 3);
  assert.equal(store.put('1.4', path('1.4', 3), frame(20), 'r1'), 'stored');
  assert.equal(status(store, '1.2').status, STATUS.evicted);
  assert.equal(status(store, '1.4').done, 3);
  assert.ok(store.used() <= store.budget());
});

test('a study open in two viewers stays until both closed it', () => {
  const store = create(30);
  store.add([{ uid: '1.1' }, { uid: '1.2' }]);
  fill(store, '1.1', 2, 10);
  store.open('1.1'); store.open('1.1');
  assert.equal(store.close('1.1'), false);
  store.start('1.2', 1);
  assert.equal(store.put('1.2', path('1.2'), frame(20), 'r1'), 'full');
  assert.equal(status(store, '1.1').status, STATUS.ready);
  assert.equal(store.close('1.1'), true);
  store.wake(); store.start('1.2', 1);
  assert.equal(store.put('1.2', path('1.2'), frame(20), 'r1'), 'stored');
  assert.equal(status(store, '1.1').status, STATUS.evicted);
});

test('a study whose archive revision changes while it is fetched keeps nothing of it', () => {
  const store = create(1000);
  store.add([{ uid: '1.1' }]);
  store.start('1.1', 2);
  assert.equal(store.put('1.1', path('1.1', 1), frame(10), 'orthanc-study:x@1'), 'stored');
  assert.equal(store.put('1.1', path('1.1', 2), frame(10), 'orthanc-study:x@2'), 'changed');
  assert.equal(store.put('1.1', path('1.1', 2), frame(10), null), 'changed', 'a frame without a revision cannot be checked later');
  store.fail('1.1', 'changed');
  assert.equal(store.used(), 0);
  assert.equal(store.frame(path('1.1', 1)), null);
  assert.equal(store.held('1.1'), null);
});

test('held frames are answered by path and revision; failed, evicted and cleared studies answer nothing', () => {
  const store = create(1000);
  store.add([{ uid: '1.1', label: 'SYN-1 · Synthetic' }, { uid: '1.2' }]);
  fill(store, '1.1', 2, 10, 'rev-A');
  assert.deepEqual(store.held('1.1'), { revision: 'rev-A', status: STATUS.ready, copy: 1 });
  assert.equal(store.frame(path('1.1', 2)).bytes, 10);
  assert.equal(store.frame(path('1.1', 3)), null);
  assert.equal(store.held('1.2'), null, 'queued with nothing fetched is not held');
  store.evict('1.1', 'changed at open');
  assert.equal(store.held('1.1'), null);
  assert.equal(store.frame(path('1.1', 1)), null);
  assert.equal(store.used(), 0);
  fill(store, '1.2', 1, 10);
  store.clear('session ended');
  assert.equal(store.used(), 0);
  assert.deepEqual(store.snapshot().studies.map(s => [s.uid, s.status]), [['1.1', STATUS.evicted], ['1.2', STATUS.evicted]]);
});

test('Retry puts a failed or evicted study at the head of the queue; a held one is not re-added', () => {
  const store = create(1000);
  store.add([{ uid: '1.1' }, { uid: '1.2' }, { uid: '1.3' }]);
  store.fail('1.3', 'network');
  assert.equal(store.retry('1.3'), true);
  assert.equal(store.next().uid, '1.3');
  assert.equal(store.retry('1.1'), false, 'a queued study is already in the queue');
  fill(store, '1.3', 1, 10);
  assert.deepEqual(store.add([{ uid: '1.3' }, { uid: '1.4' }]), ['1.4']);
  assert.equal(status(store, '1.3').status, STATUS.ready);
});

test('a study that could not fit even alone does not wait for disk space; one that could fit once others go waits', () => {
  const store = create(100);
  store.add([{ uid: '1.1' }, { uid: '1.2' }, { uid: '1.3' }]);
  store.start('1.1', 3);
  assert.equal(store.put('1.1', path('1.1', 1), frame(40), 'r1'), 'stored');
  assert.equal(store.put('1.1', path('1.1', 2), frame(40), 'r1'), 'stored');
  assert.equal(store.put('1.1', path('1.1', 3), frame(40), 'r1'), 'oversize', '120 bytes can never fit in 100');
  assert.equal(status(store, '1.1').waiting, false, 'not parked for disk space');
  store.fail('1.1', 'too large');
  assert.equal(store.used(), 0, 'its partial bytes go with the failure');
  assert.equal(store.next().uid, '1.2', 'the queue goes on');
  // 1.2 is Ready and not read yet (it may not be evicted); 1.3 fits alone but not beside it: it waits.
  fill(store, '1.2', 1, 60);
  store.start('1.3', 1);
  assert.equal(store.put('1.3', path('1.3'), frame(50), 'r1'), 'full');
  assert.equal(status(store, '1.3').waiting, true);
});

test('a study whose frames so far project past the whole budget fails instead of waiting beside a study not read yet', () => {
  const store = create(100);
  store.add([{ uid: '1.1' }, { uid: '1.2' }, { uid: '1.3' }]);
  fill(store, '1.1', 1, 50);                    // Ready, not read yet: it may not be evicted
  store.start('1.2', 10);
  for (let n = 1; n <= 4; n++) assert.equal(store.put('1.2', path('1.2', n), frame(12), 'r1'), 'stored');
  // 5 frames of 12 projected over 10 frames is 120 > 100: no room the reader could free would ever be enough.
  assert.equal(store.put('1.2', path('1.2', 5), frame(12), 'r1'), 'oversize');
  store.fail('1.2', 'too large');
  // A study that would fit once 1.1 goes still waits for that.
  store.start('1.3', 10);
  for (let n = 1; n <= 9; n++) assert.equal(store.put('1.3', path('1.3', n), frame(5), 'r1'), 'stored');
  assert.equal(store.put('1.3', path('1.3', 10), frame(6), 'r1'), 'full', '45 + 6 fits alone; 1.1 holds the rest');
});

test('each fetch of a study is its own copy: one fetched again after Clear All is another copy', () => {
  const store = create(1000);
  store.add([{ uid: '1.1' }]);
  fill(store, '1.1', 1, 10);
  const first = store.held('1.1').copy;
  store.clear('cleared');
  assert.equal(store.held('1.1'), null);
  assert.equal(store.retry('1.1'), true);
  fill(store, '1.1', 1, 10);
  assert.notEqual(store.held('1.1').copy, first);
});

test('a study larger than the whole budget is refused from its first frames', () => {
  const store = create(100);
  store.add([{ uid: '1.1' }]);
  assert.equal(store.estimate('1.1', 101), false);
  assert.equal(store.estimate('1.1', 100), true);
});


test('R5 fixed 72-hour window blocks held/frame before sweep and releases every ID; retry starts a new window', () => {
  let now = 1000;
  const store = create(100, () => now);
  store.add([{uid:'1.1'}, {uid:'1.2'}]);
  store.fetched('1.1', now);
  fill(store, '1.1', 1, 10);
  const id = store.frame(path('1.1')).entryId;
  now += 72*3600000 - 1;
  assert.ok(store.held('1.1'));
  now++;
  assert.equal(store.held('1.1'), null);
  assert.equal(store.frame(path('1.1')), null);
  assert.deepEqual(store.expire(), [id]);
  assert.equal(store.used(), 0);
  assert.match(status(store, '1.1').reason, /72시간/);
  assert.match(status(store, '1.2').reason, /대기열/);
  assert.equal(store.retry('1.1'), true);
  assert.equal(status(store, '1.1').expiresAt, now + 72*3600000);
});

test('R5 a still-queued study expires at its original deadline after restart', () => {
  const queuedAt = 1000, deadline = queuedAt + 72 * 3600000;
  const store = create(100, () => queuedAt);
  store.add([{ uid: '1.1' }]);
  const manifest = store.manifest('1.1');
  assert.equal(manifest.fetchedAt, null, 'no frame was ever received');
  for (const restartAt of [deadline - 1, deadline, deadline + 3600000]) {
    const restarted = create(100, () => restartAt);
    restarted.restore(manifest, new Map());
    restarted.expire();
    if (restartAt < deadline) {
      assert.equal(restarted.next().uid, '1.1');
      assert.equal(status(restarted, '1.1').status, STATUS.queued);
    } else {
      assert.equal(restarted.next(), null, 'expired queue must not download again');
      assert.equal(status(restarted, '1.1').status, STATUS.evicted);
      assert.match(status(restarted, '1.1').reason, /대기열/);
    }
    assert.equal(status(restarted, '1.1').expiresAt, deadline, 'restart never renews retention');
  }
});

test('R11 R15 a persisted downloading manifest resumes Queued with reference-only frames', () => {
  const store = create(100);
  store.add([{uid:'1.1',label:'SYN · Patient'}]); store.start('1.1', 2);
  store.put('1.1', path('1.1'), {entryId:'opaque',bytes:10}, 'r');
  const manifest = store.manifest('1.1');
  assert.equal(manifest.status, 'Queued');
  const restarted = create(100);
  restarted.restore(manifest, new Map([['opaque',{bytes:10}]]));
  assert.equal(restarted.next().uid, '1.1');
  assert.equal(restarted.frame(path('1.1')).entryId, 'opaque');
  assert.equal(restarted.used(),10);
});

// FC-073 (A1 unit 15): Auto Preload adds and emergency order.
test('FC-073 urgent studies go ahead of every queued study as one run in their order; Retry still goes to the head when pressed', () => {
  const store = create(GB);
  store.add([{ uid: '1.1' }, { uid: '1.2' }]);
  store.add([{ uid: '2.1' }, { uid: '2.2', urgent: true }, { uid: '2.3', urgent: true }, { uid: '2.4' }]);
  const order = () => store.snapshot().studies.map(s => s.uid);
  assert.deepEqual(order(), ['2.2', '2.3', '1.1', '1.2', '2.1', '2.4']);
  assert.equal(store.next().uid, '2.2');
  store.add([{ uid: '3.1', urgent: true }]);
  assert.deepEqual(order().slice(0, 3), ['3.1', '2.2', '2.3'], 'a later urgent study goes ahead of the earlier run');
  store.fail('1.2', 'x');
  assert.equal(store.retry('1.2'), true);
  assert.equal(order()[0], '1.2', 'Retry at the moment it is pressed is the head');
});

test('FC-073 an auto add never queues a study the session already has, in any status; a manual add still re-queues Failed', () => {
  const store = create(GB);
  store.add([{ uid: '1.1' }, { uid: '1.2' }, { uid: '1.3' }]);
  store.fail('1.2', 'denied');
  store.evict('1.3', 'expired');
  assert.deepEqual(store.add([{ uid: '1.1' }, { uid: '1.2', urgent: true }, { uid: '1.3' }, { uid: '1.4' }], { auto: true }), ['1.4']);
  assert.equal(status(store, '1.2').status, STATUS.failed, 'a Failed study waits for Retry, not for the next list read');
  assert.equal(status(store, '1.3').status, STATUS.evicted);
  assert.deepEqual(store.add([{ uid: '1.2' }]), ['1.2'], 'the Preload button still queues a Failed study again');
});

test('FC-073 pick: the saved search rows, emergency first, each with the prior a viewer would open, each study once', () => {
  const { pick } = require('../worklist-v0/hpacs-lite/preload-queue.js');
  const row = (uid, key, date, modality, em = 'N') => ({ uid, sourcePatientKey: key, date, modality, em });
  const all = [
    row('a1', 'p|A', '2026-10-05', 'CT'), row('a0', 'p|A', '2026-09-01', 'CT'), row('a-mr', 'p|A', '2026-10-01', 'MR'),
    row('a-old', 'p|A', '2025-01-01', 'CT'), row('b1', 'p|B', '2026-10-05', 'CT', 'E'), row('b0', 'p|B', '2026-08-01', 'CT'),
    row('c1', 'p|C', '2026-10-05', 'CT'), row('c-same', 'p|C', '2026-10-05', 'CT'), row('d1', '', '2026-10-05', 'CT'),
    row('d0', '', '2026-01-01', 'CT'), row('e1', 'p|E', 'bad', 'CT'), row('e0', 'p|E', '2026-01-01', 'CT')];
  const matched = ['a1', 'b1', 'c1', 'd1', 'e1', 'a0'].map(uid => all.find(s => s.uid === uid));
  assert.deepEqual(pick(matched, all).map(s => [s.uid, s.urgent]),
    [['b1', true], ['a1', false], ['c1', false], ['d1', false], ['e1', false], ['a0', false]]);
  assert.deepEqual(pick(matched, all, { priors: true }).map(s => [s.uid, s.urgent]),
    [['b1', true], ['b0', true], ['a1', false], ['a0', false], ['c1', false], ['d1', false], ['e1', false], ['a-old', false]],
    'same patient and modality, latest earlier date (a0 is both a match and the prior of a1, once); none on the same day, without a patient key or a valid date');
  assert.deepEqual(pick([all[0]], all, { label: s => 'L ' + s.uid }), [{ uid: 'a1', label: 'L a1', urgent: false }]);
});

test('FC-073 the stored Auto Preload setting is exactly { version 1, search, priors }', () => {
  const { normalizeAuto } = require('../worklist-v0/hpacs-lite/preload-queue.js');
  assert.deepEqual(normalizeAuto({ version: 1, search: 'own:7', priors: true }), { version: 1, search: 'own:7', priors: true });
  assert.deepEqual(normalizeAuto({ version: 1, search: null, priors: false }), { version: 1, search: null, priors: false });
  for (const bad of [null, [], { version: 2, search: null, priors: false }, { version: 1, search: 7, priors: false },
    { version: 1, search: null, priors: 'yes' }, { version: 1, search: null, priors: false, extra: 1 }, { version: 1, search: 'x'.repeat(201), priors: false }])
    assert.equal(normalizeAuto(bad), null, JSON.stringify(bad));
});