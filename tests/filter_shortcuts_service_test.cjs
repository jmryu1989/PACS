'use strict';
// REQ-WS3/WS7 -> RISK-WS3/WS7 -> WS3-SHORTCUTS: public service outcomes.
// The fake serializes transactions and rolls back on rejection, including the CAS lock increment.
require('./service_test_loader.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PacsFilters } = require('/app/dist/pacs/filters');
const { shortcutEntries } = require('/app/dist/filter-folders');
const caller = (sub = 'reader', institution = 'SYNTHETIC') => ({ sub, institution, actor: institution + ':' + sub, kind: 'member', roles: ['radiologist'] });
const first = { id: 'a', name: 'CT & MR', searchId: 'own:1' };
const absent = { id: 'b', name: 'Unavailable shared', searchId: 'shared:999' };
const status = n => e => e.getStatus?.() === n;
function fixture() {
  let db = { collections: {}, filters: [{ id: 1, owner: caller().actor, name: 'Search', folder: '', cols: '{}' }] }, tail = Promise.resolve();
  const prisma = {
    $transaction(run) {
      const pending = tail.then(async () => {
        const copy = structuredClone(db);
        const tx = {
          sharedFilterLibrary: { async upsert() { return { revision: 1, folders: [{path:'Team',description:'',ordinal:0}], filters: [{id:9,name:'Shared CT',mode:'Radiology',quick:'',days:-1,cols:{modality:'CT'},sortKey:null,sortDir:0,folder:'Team',description:'',ordinal:0}] }; } },
          userFilterCollection: {
            async findUnique({ where }) { return structuredClone(copy.collections[where.owner] ?? null); },
            async upsert({ where, create, update }) {
              const row = copy.collections[where.owner] ??= { shortcuts: [], ...structuredClone(create) };
              if (db.collections[where.owner]) row.revision += update.revision.increment;
              return structuredClone(row);
            },
            async update({ where, data }) { Object.assign(copy.collections[where.owner], structuredClone(data)); return structuredClone(copy.collections[where.owner]); },
          },
          userFilter: {
            async findMany({ where }) { return structuredClone(copy.filters.filter(f => f.owner === where.owner)); },
            async deleteMany({ where }) { const old = copy.filters.length; copy.filters = copy.filters.filter(f => !(f.owner === where.owner && (typeof where.id === 'number' ? f.id === where.id : where.id.in.includes(f.id)))); return { count: old - copy.filters.length }; },
            async create({ data }) { const row = { id: Math.max(0, ...copy.filters.map(f => f.id)) + 1, ...structuredClone(data) }; copy.filters.push(row); return structuredClone(row); },
            async updateMany({ where, data }) { const rows = copy.filters.filter(f => f.owner === where.owner && (where.id == null || f.id === where.id)); rows.forEach(f => Object.assign(f, structuredClone(data))); return { count: rows.length }; },
          },
        };
        const result = await run(tx); db = copy; return result;
      });
      tail = pending.catch(() => {}); return pending;
    },
  };
  const service = new PacsFilters(prisma);
  const read = (c = caller()) => service.readFilterFolders(c);
  const write = (snapshot, shortcuts, c = caller()) => service.writeFilterFolders({ expectedOwner: snapshot.owner,
    revision: snapshot.revision, command: { action: 'replace-shortcuts', shortcuts } }, c);
  return { service, read, write };
}
test('WS3-SHORTCUTS: empty additive read and ordered full replacement survive a new read', async () => {
  const f = fixture(), before = await f.read();
  assert.deepEqual(before.shortcuts, []); assert.equal(before.revision, 0);
  const saved = await f.write(before, [absent, first]);
  assert.equal(saved.revision, 1); assert.deepEqual(saved.shortcuts, [absent, first]);
  assert.deepEqual(saved.filters, before.filters); assert.deepEqual(saved.folders, before.folders);
  assert.deepEqual(await f.read(), saved);
  const replaced = await f.write(saved, [{ ...first, name: 'Renamed' }]);
  assert.deepEqual(replaced.shortcuts, [{ ...first, name: 'Renamed' }]);
  assert.deepEqual((await f.write(replaced, [])).shortcuts, []);
});
test('WS3-SHORTCUTS-CAS: concurrent whole arrays have one winner and no merge', async () => {
  const f = fixture(), before = await f.read();
  const results = await Promise.allSettled([f.write(before, [first]), f.write(before, [absent])]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.getStatus(), 409);
  assert.deepEqual((await f.read()).shortcuts, [first]);
  assert.equal((await f.read()).revision, 1);
});
test('WS3-SHORTCUTS-OWNER: foreign owner, different institution, and gateway writes fail', async () => {
  const f = fixture(), before = await f.read();
  for (const c of [caller('other'), caller('reader', 'OTHER')]) {
    await assert.rejects(f.write(before, [first], c), status(409));
    assert.deepEqual((await f.read(c)).shortcuts, []);
  }
  await assert.rejects(f.write(before, [first], { ...caller(), kind: 'gateway' }), status(403));
  assert.deepEqual(await f.read(), before);
});
test('WS3-SHORTCUTS-UNAVAILABLE: deleting a search leaves its shortcut and stale revision cannot overwrite', async () => {
  const f = fixture(), saved = await f.write(await f.read(), [first, absent]);
  await f.service.deleteFilter(1, caller());
  const now = await f.read();
  assert.deepEqual(now.shortcuts, [first, absent]); assert.deepEqual(now.filters, []);
  await assert.rejects(f.write(saved, []), status(409));
  assert.deepEqual(await f.read(), now);
});
test('WS3-SHORTCUTS-ROLLBACK: malformed commands never advance revision or replace folders', async () => {
  const f = fixture(), before = await f.write(await f.read(), [first]);
  for (const command of [{ action: 'replace-shortcuts', shortcuts: [], force: true },
    { action: 'replace-shortcuts', shortcuts: [first, first] }, { action: 'replace-shortcuts' }]) {
    await assert.rejects(f.service.writeFilterFolders({ expectedOwner: before.owner, revision: before.revision, command }, caller()), status(400));
    assert.deepEqual(await f.read(), before);
  }
});
test('WS3-SHORTCUTS-VALIDATION: exact bounded fields, stable namespace and detached results', () => {
  for (const value of [null, {}, [null], [{ ...first, extra: true }], [{ ...first, name: ' ' }],
    [{ ...first, id: 'a\nb' }], [{ ...first, id: 1 }], [{ ...first, name: 'a'.repeat(401) }],
    [{ ...first, searchId: 'own:0' }], [{ ...first, searchId: 'shared:01' }], [{ ...first, searchId: 'Search' }],
    Array.from({ length: 201 }, (_, i) => ({ ...first, id: String(i) }))]) assert.throws(() => shortcutEntries(value), status(400));
  const input = [{ ...first, name: ' <img> ' }];
  assert.deepEqual(shortcutEntries(input), [{ ...first, name: '<img>' }]);
  assert.equal(input[0].name, ' <img> ');
});

test('WS3-SHORTCUTS-PRESERVE: folder save/move/remove and shared copy keep shortcuts and advance revision', async () => {
  const f = fixture();
  let saved = await f.write(await f.read(), [first, absent]);
  for (const command of [
    { action:'save-folder', path:'Personal', description:'keep', ordinal:0 },
    { action:'move-searches', ids:[1], to:'Personal' },
    { action:'move-folder', from:'Personal', to:'Moved' },
    { action:'remove-folder', path:'Moved' },
  ]) {
    const next = await f.service.writeFilterFolders({ expectedOwner:saved.owner, revision:saved.revision, command }, caller());
    assert.deepEqual(next.shortcuts, [first, absent]);
    assert.equal(next.revision, saved.revision + 1);
    assert.deepEqual(await f.read(), next);
    saved = next;
  }
  const copied = await f.service.copySharedFilters({ expectedOwner:saved.owner, personalRevision:saved.revision,
    revision:1, from:'Team', to:'Imported', namePrefix:'Copy ' }, caller());
  assert.deepEqual(copied.shortcuts, [first, absent]);
  assert.equal(copied.revision, saved.revision + 1);
  assert.equal(copied.filters.length, 2);
  assert.equal(copied.filters.find(row => row.name === 'Copy Shared CT').folder, 'Imported');
  assert.deepEqual(await f.read(), copied);
});
