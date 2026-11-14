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
      upsert: async ({ where, create, update }) => {
        const k = key(where), row = rows.find(r => r.authorSub === k.authorSub && r.studyUid === k.studyUid);
        if (!row) { const made = { createdAt: new Date(), ...create }; rows.push(made); return { ...made }; }
        Object.assign(row, { ...update, revision: row.revision + update.revision.increment }); return { ...row };
      },
      deleteMany: async ({ where }) => { const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].authorSub === where.authorSub && rows[i].studyUid === where.studyUid) rows.splice(i, 1);
        return { count: before - rows.length }; },
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
  const first = await h.service.save(UID, body({ snapshot: view() }), RAD);
  assert.equal(first.saved, true); assert.equal(first.revision, 1);
  const second = view({ studies: [UID, PRIOR], rows: 1, cols: 2, active: 1,
    cells: [cell({ display: RULE }), cell({ study: PRIOR, series: PRIOR + '.1', sop: PRIOR + '.1.7', frame: 3, index: 6, zoom: 1 })] });
  const written = await h.service.save(UID, body({ snapshot: second }), RAD);
  assert.equal(written.revision, 2);
  assert.equal(h.rows.length, 1, 'one row per reader and study');
  const read = await h.service.read(UID, RAD);
  assert.deepEqual(read.view.snapshot, second, 'the view comes back exactly (17-digit numbers included)');
  assert.equal(read.view.revision, 2); assert.equal(typeof read.view.savedAt, 'string');
  // Another reader of the same institution has no view of this study, and saving one makes a row of its own.
  assert.deepEqual(await h.service.read(UID, RAD2), { view: null });
  await h.service.save(UID, body({ snapshot: view() }), RAD2);
  assert.equal(h.rows.length, 2);
  assert.deepEqual((await h.service.read(UID, RAD)).view.snapshot, second, 'one reader\'s save leaves the other\'s view');
});

test('a study the caller does not read is refused; a view naming a prior no longer read is not given out', async () => {
  const h = harness();
  await assert.rejects(h.service.read(FOREIGN, RAD), status(403));
  await assert.rejects(h.service.save(FOREIGN, body({ snapshot: view({ studies: [FOREIGN], cells: [cell({ study: FOREIGN })] }) }), RAD), status(403));
  await assert.rejects(h.service.read(UID, OTHER), status(403));
  // A prior of another institution cannot be saved into a view.
  await assert.rejects(h.service.save(UID, body({ snapshot: view({ studies: [UID, FOREIGN] }) }), RAD), status(403));
  await h.service.save(UID, body({ snapshot: view({ studies: [UID, PRIOR] }) }), RAD);
  h.access.revoked.add(PRIOR);
  assert.deepEqual(await h.service.read(UID, RAD), { view: null });
  h.access.revoked.add(UID);
  await assert.rejects(h.service.read(UID, RAD), status(403));
  await assert.rejects(h.service.discard(UID, RAD), status(403));
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
  ]) await assert.rejects(h.service.save(UID, body(value), RAD), status(400), name);
  assert.equal(h.rows.length, 0);
  // A stored view that does not read as one (written by another version) is not given out.
  await h.service.save(UID, body({ snapshot: view() }), RAD);
  h.rows[0].snapshot = JSON.stringify({ ...view(), version: 9 });
  assert.deepEqual(await h.service.read(UID, RAD), { view: null });
});

test('Discard Saved View removes only the caller\'s own view of that study', async () => {
  const h = harness();
  await h.service.save(UID, body({ snapshot: view() }), RAD);
  await h.service.save(UID, body({ snapshot: view() }), RAD2);
  await h.service.save(PRIOR, body({ snapshot: view({ studies: [PRIOR], cells: [cell({ study: PRIOR })] }) }), RAD);
  assert.deepEqual(await h.service.discard(UID, RAD), { discarded: true });
  assert.deepEqual(await h.service.read(UID, RAD), { view: null });
  assert.ok((await h.service.read(UID, RAD2)).view, 'another reader keeps theirs');
  assert.ok((await h.service.read(PRIOR, RAD)).view, 'the reader keeps the view of another study');
  assert.deepEqual(await h.service.discard(UID, RAD), { discarded: false });
});
