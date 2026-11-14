'use strict';
/* Auto Save View on the API (api/src/viewer-auto-view.service.ts) against an in-memory database: one saved view per reader
 * and study, written over by each save and given back exactly; another reader's view is never read; a study the caller's
 * institution does not read is refused; a view naming a prior the caller no longer reads is not given out; Discard removes
 * only the caller's own; the saved view's shape is checked on writing and on reading back; the Jobs table is never used.
 * No DB, credentials or network.
 */
require('./service_test_loader.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');

const UID = '1.2.826.0.1.3680043.8.498.140', PRIOR = '1.2.826.0.1.3680043.8.498.141', FOREIGN = '1.2.826.0.1.3680043.8.498.142';
const RAD = { sub: 'sub-rad', actor: 'SYN-rad', roles: ['radiologist'], institution: 'inst-a', kind: 'member' };
const RAD2 = { sub: 'sub-rad-2', actor: 'SYN-rad-2', roles: ['radiologist'], institution: 'inst-a', kind: 'member' };
const OTHER = { sub: 'sub-other', actor: 'SYN-other', roles: ['radiologist'], institution: 'inst-b', kind: 'member' };
const camera = { focalPoint: [0.1, 0.2, -10.000000000000002], position: [0.1, 0.2, 89.99999999999999], viewUp: [0, -1, 0], viewPlaneNormal: [0, 0, 1],
  parallelScale: 26.525198938992046, rotation: 0, flipHorizontal: false, flipVertical: false };
const cell = (extra = {}) => ({ study: UID, series: UID + '.2', sop: UID + '.2.32', frame: 1, index: 31, zoom: 3.77, camera,
  properties: { voiRange: { lower: 31, upper: 192 }, VOILUTFunction: 'LINEAR', invert: false, interpolationType: 1 }, display: null, ...extra });
const view = (extra = {}) => ({ version: 1, studies: [UID], rows: 1, cols: 1, active: 0, cells: [cell()], ...extra });
const body = value => Buffer.from(JSON.stringify(value));
// One viewer's saves: its id, its count of saves and when each was taken, rising with each one.
const WRITER = '6f0c2a4e-3b1d-4c5e-8f9a-0b1c2d3e4f50', WRITER2 = '7a1d3b5f-4c2e-4d6f-9a0b-1c2d3e4f5061';
let seq = 0, clock = Date.now() - 600000;
const post = (snapshot, writer = WRITER, count = ++seq, at = ++clock) => body({ snapshot, writer, seq: count, at });
const drop = (writer = WRITER, count = ++seq, at = ++clock) => body({ writer, seq: count, at });
const RULE = { magnification: 'fit', windowing: { name: 'Lung', w: 1500, l: -600 }, filter: 'smooth', sort: 'position-desc', rotate: 90, flip: 'none', firstImage: 'first', gspsAuto: false, overlay: 'none' };

function harness() {
  const { ViewerAutoViewService } = require('/app/dist/viewer-auto-view.service');
  const studies = new Map([
    [UID, { uid: UID, institutionId: 'inst-a', teleInstitutionId: null, rs: 'W' }],
    [PRIOR, { uid: PRIOR, institutionId: 'inst-a', teleInstitutionId: null, rs: 'W' }],
    [FOREIGN, { uid: FOREIGN, institutionId: 'inst-b', teleInstitutionId: null, rs: 'W' }],
  ]);
  const rows = [];
  const key = where => where.authorSub_studyUid;
  const prisma = {
    studyState: { findMany: async ({ where }) => where.uid.in.map(uid => studies.get(uid)).filter(Boolean).map(s => ({ ...s })) },
    viewerAutoView: {
      findUnique: async ({ where }) => { const k = key(where); const row = rows.find(r => r.authorSub === k.authorSub && r.studyUid === k.studyUid); return row ? { ...row } : null; },
      // updateMany over { id, revision } (the row as it was read), createMany with skipDuplicates. Values as Prisma gives
      // them back (a JSON copy of writers, BigInt discardedAt).
      updateMany: async ({ where, data }) => {
        const found = rows.filter(r => r.id === where.id && r.revision === where.revision);
        for (const row of found) Object.assign(row, structuredClone(data));
        return { count: found.length };
      },
      createMany: async ({ data, skipDuplicates }) => {
        assert.equal(skipDuplicates, true);
        let count = 0;
        for (const create of data) if (!rows.some(r => r.authorSub === create.authorSub && r.studyUid === create.studyUid)) { rows.push({ createdAt: new Date(), ...structuredClone(create) }); count++; }
        return { count };
      },
    },
    // The Jobs table is not this feature's: any use of it fails the test.
    get viewerJob() { throw new Error('the Jobs table was used'); },
    $executeRaw: async () => 0,
  };
  prisma.$transaction = async work => work(prisma);
  const access = { revoked: new Set(),
    snapshot: async () => ({}), prepare: async () => {},
    require: async (c, uids) => { if (uids.some(uid => access.revoked.has(uid))) throw Object.assign(new Error('outside'), { getStatus: () => 403 }); },
    allowed: async (c, uids) => new Set(uids.filter(uid => !access.revoked.has(uid))) };
  return { service: new ViewerAutoViewService(prisma, access), rows, studies, access };
}
const status = code => error => { assert.equal(error.getStatus?.(), code, error.message); return true; };

test('one saved view per reader and study: written over, given back exactly, never another reader\'s', async () => {
  const h = harness();
  assert.deepEqual(await h.service.read(UID, RAD), { view: null });
  const first = await h.service.save(UID, post(view()), RAD);
  assert.equal(first.saved, true); assert.equal(first.revision, 1);
  const second = view({ studies: [UID, PRIOR], rows: 1, cols: 2, active: 1,
    cells: [cell({ display: RULE }), cell({ study: PRIOR, series: PRIOR + '.1', sop: PRIOR + '.1.7', frame: 3, index: 6, zoom: 1 })] });
  const written = await h.service.save(UID, post(second), RAD);
  assert.equal(written.revision, 2);
  assert.equal(h.rows.length, 1, 'one row per reader and study');
  const read = await h.service.read(UID, RAD);
  assert.deepEqual(read.view.snapshot, second, 'the view comes back exactly (17-digit numbers included)');
  assert.equal(read.view.revision, 2); assert.equal(typeof read.view.savedAt, 'string');
  // Another reader of the same institution has no view of this study, and saving one makes a row of its own.
  assert.deepEqual(await h.service.read(UID, RAD2), { view: null });
  await h.service.save(UID, post(view()), RAD2);
  assert.equal(h.rows.length, 2);
  assert.deepEqual((await h.service.read(UID, RAD)).view.snapshot, second, 'one reader\'s save leaves the other\'s view');
});

test('a study the caller does not read is refused; a view naming a prior no longer read is not given out', async () => {
  const h = harness();
  await assert.rejects(h.service.read(FOREIGN, RAD), status(403));
  await assert.rejects(h.service.save(FOREIGN, post(view({ studies: [FOREIGN], cells: [cell({ study: FOREIGN })] })), RAD), status(403));
  await assert.rejects(h.service.read(UID, OTHER), status(403));
  // A prior of another institution cannot be saved into a view.
  await assert.rejects(h.service.save(UID, post(view({ studies: [UID, FOREIGN] })), RAD), status(403));
  await h.service.save(UID, post(view({ studies: [UID, PRIOR] })), RAD);
  h.access.revoked.add(PRIOR);
  assert.deepEqual(await h.service.read(UID, RAD), { view: null });
  h.access.revoked.add(UID);
  await assert.rejects(h.service.read(UID, RAD), status(403));
  await assert.rejects(h.service.discard(UID, drop(), RAD), status(403));
  await assert.rejects(h.service.read(UID, { ...RAD, kind: 'clinician' }), status(403));
});

test('the saved view is checked when written and when read back', async () => {
  const h = harness();
  for (const [name, value] of [
    ['no snapshot key', { view: view() }],
    ['another study first', { snapshot: view({ studies: [PRIOR, UID] }) }],
    ['an extra key', { snapshot: { ...view(), title: 'x' } }],
    ['a cell key missing', { snapshot: view({ cells: [(({ display, ...rest }) => rest)(cell())] }) }],
    ['five rows', { snapshot: view({ rows: 5, cells: Array(5).fill(cell()) }) }],
    ['a bent camera', { snapshot: view({ cells: [cell({ camera: { ...camera, viewUp: [0, 0, 1] } })] }) }],
    ['a window turned over', { snapshot: view({ cells: [cell({ properties: { ...cell().properties, voiRange: { lower: 9, upper: 1 } } })] }) }],
    ['a rule with an unknown sort', { snapshot: view({ cells: [cell({ display: { ...RULE, sort: 'random' } })] }) }],
    ['a frame of 0', { snapshot: view({ cells: [cell({ frame: 0 })] }) }],
    ['no writer', { snapshot: view(), seq: 1, writer: undefined }],
    ['a writer that is not an id', { snapshot: view(), writer: 'viewer-1' }],
    ['a count of 0', { snapshot: view(), seq: 0 }],
    ['a count that is not a whole number', { snapshot: view(), seq: 1.5 }],
    ['no time', { snapshot: view(), at: undefined }],
    ['a time of 0', { snapshot: view(), at: 0 }],
  ]) await assert.rejects(h.service.save(UID, body({ writer: WRITER, seq: ++seq, at: ++clock, ...value }), RAD), status(400), name);
  await assert.rejects(h.service.discard(UID, body({ writer: WRITER, seq: ++seq }), RAD), status(400), 'a Discard names its viewer, count and time');
  assert.equal(h.rows.length, 0);
  // A stored view that does not read as one (written by another version) is not given out.
  await h.service.save(UID, post(view()), RAD);
  h.rows[0].snapshot = JSON.stringify({ ...view(), version: 9 });
  assert.deepEqual(await h.service.read(UID, RAD), { view: null });
});

test('Discard Saved View empties only the caller\'s own view of that study', async () => {
  const h = harness();
  await h.service.save(UID, post(view()), RAD);
  await h.service.save(UID, post(view()), RAD2);
  await h.service.save(PRIOR, post(view({ studies: [PRIOR], cells: [cell({ study: PRIOR })] })), RAD);
  assert.deepEqual(await h.service.discard(UID, drop(), RAD), { discarded: true });
  assert.deepEqual(await h.service.read(UID, RAD), { view: null });
  assert.ok((await h.service.read(UID, RAD2)).view, 'another reader keeps theirs');
  assert.ok((await h.service.read(PRIOR, RAD)).view, 'the reader keeps the view of another study');
  assert.deepEqual(await h.service.discard(UID, drop(), RAD), { discarded: false });
  // The row stays, empty, to keep the order of the saves.
  const kept = h.rows.find(r => r.authorSub === RAD.sub && r.studyUid === UID);
  assert.equal(kept.snapshot, null); assert.equal(typeof kept.discardedAt, 'bigint');
});

test('each viewer\'s last count is kept whatever another viewer writes; an older save of a viewer writes nothing', async () => {
  const h = harness();
  const zoom = z => view({ cells: [cell({ zoom: z })] });
  // The window closing sent the newer view (count 7) before the older one (count 6) arrived.
  assert.equal((await h.service.save(UID, post(zoom(3), WRITER, 7), RAD)).saved, true);
  const late = await h.service.save(UID, post(zoom(2), WRITER, 6), RAD);
  assert.deepEqual([late.saved, late.revision], [false, 1]);
  assert.equal((await h.service.read(UID, RAD)).view.snapshot.cells[0].zoom, 3);
  // The same count again writes nothing either; a later one does.
  assert.equal((await h.service.save(UID, post(zoom(4), WRITER, 7), RAD)).saved, false);
  assert.equal((await h.service.save(UID, post(zoom(5), WRITER, 8), RAD)).saved, true);
  // Another viewer (a new window on the study) has its own count and writes; the first viewer's is not forgotten:
  // its count 2, arriving late after the other viewer's save, writes nothing.
  const other = await h.service.save(UID, post(zoom(6), WRITER2, 1), RAD);
  assert.deepEqual([other.saved, other.revision], [true, 3]);
  assert.equal((await h.service.save(UID, post(zoom(9), WRITER, 2), RAD)).saved, false);
  assert.equal((await h.service.read(UID, RAD)).view.snapshot.cells[0].zoom, 6);
  // Only the 32 latest viewers are kept.
  const many = Array.from({ length: 40 }, (_, n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0'));
  for (const writer of many) await h.service.save(UID, post(zoom(1), writer, 1), RAD);
  assert.equal(h.rows[0].writers.length, 32);
  assert.deepEqual(h.rows[0].writers.at(-1), [many.at(-1), 1]);
});

test('a save taken before a Discard and arriving after it is refused, from any viewer; one taken after it writes', async () => {
  const h = harness();
  const zoom = z => view({ cells: [cell({ zoom: z })] });
  await h.service.save(UID, post(zoom(2), WRITER, 1, clock + 1), RAD);
  // An earlier window's save, taken at t, is still on its way when Discard is taken (t + 5) in another window.
  const t = (clock += 10);
  assert.deepEqual(await h.service.discard(UID, drop(WRITER2, 1, t + 5), RAD), { discarded: true });
  assert.equal((await h.service.save(UID, post(zoom(3), WRITER, 2, t), RAD)).saved, false, 'taken before the Discard');
  assert.equal((await h.service.save(UID, post(zoom(3), WRITER2, 1, t + 6), RAD)).saved, false, 'the discarding viewer\'s own count');
  assert.deepEqual(await h.service.read(UID, RAD), { view: null });
  const after = await h.service.save(UID, post(zoom(4), WRITER2, 2, t + 6), RAD);
  assert.equal(after.saved, true);
  assert.equal((await h.service.read(UID, RAD)).view.snapshot.cells[0].zoom, 4);
  // A Discard time later than the server's own clock is taken as the server's.
  await h.service.discard(UID, drop(WRITER2, 3, Date.now() + 3600000), RAD);
  assert.ok(Number(h.rows[0].discardedAt) <= Date.now());
  // A Discard with nothing saved yet still leaves the boundary.
  const h2 = harness();
  assert.deepEqual(await h2.service.discard(UID, drop(WRITER, 1, 1000), RAD), { discarded: false });
  assert.equal((await h2.service.save(UID, post(zoom(2), WRITER2, 1, 999), RAD)).saved, false);
});