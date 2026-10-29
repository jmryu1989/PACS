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
