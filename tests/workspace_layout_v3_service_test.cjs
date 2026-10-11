'use strict';
/* REQ-WS1/WS2/WS7 -> RISK-WS1/WS2/WS7 -> TEST-W3-SERVER-01..12.
 * Public PacsService GET/PUT/DELETE behavior over a test-owned transactional store.
 * The accepted W3 client is a consumer, not the oracle: expected records below are
 * literal contract examples. No private member/source-text assertions or byte pins.
 * The double proves request/response and preservation behavior, not PostgreSQL locking.
 * Run source with service_test_loader, or unchanged in the compiled API image.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
if (!fs.existsSync('/app/dist/pacs')) require('./service_test_loader.cjs');
const { PacsService } = require('/app/dist/pacs.service');
const client = require('../worklist-v0/hpacs-lite/workspace-layout.js');
const clone = value => structuredClone(value);
const caller = { kind: 'member', institution: 'synthetic-hospital-a', sub: 'synthetic-reader-a',
  actor: 'reader@synthetic.test', roles: ['radiologist'] };
const owner = c => [c.institution, c.sub];
const reading = () => ({ version: 1, reportWidth: 540, imageHeight: 390,
  relatedHeight: null, relatedListHeight: 180, relatedHidden: false });
const layout = (version = 3) => ({ version, mode: 'portrait', portrait: { main: 430, top: 270 },
  landscape: { main: 740 }, ...(version >= 2 ? { reading: reading() } : {}),
  ...(version === 3 ? { workspace: { version: 1, rail: 232, worklist: 304, related: 184,
    prior: null, railCollapsed: false, studyPanelTab: 'images' } } : {}) });
const request = (value = layout(), revision = 0, c = caller) => ({ expectedOwner: owner(c), revision, layout: value });
const status = (code, reason) => error => error.getStatus?.() === code &&
  (reason === undefined || error.getResponse?.().code === reason);

function fixture() {
  let rows = new Map(), failRead = false, failWrite = false, loseUpdate = false, loseCreate = false;
  let writes = 0, transactions = 0;
  const key = o => JSON.stringify([o.institution, o.subject]);
  const table = store => ({
    async findUnique({ where }) {
      if (failRead) throw new Error('synthetic read unavailable');
      return clone(store.get(key(where.institution_subject)) ?? null);
    },
    async create({ data }) {
      if (failWrite) throw new Error('synthetic write unavailable');
      if (loseCreate || store.has(key(data))) throw Object.assign(new Error('unique'), { code: 'P2002' });
      const row = { ...data, updatedAt: new Date('2026-10-10T00:00:00Z') };
      store.set(key(data), row); writes++; return clone(row);
    },
    async updateMany({ where, data }) {
      if (failWrite) throw new Error('synthetic write unavailable');
      const row = store.get(key(where));
      if (loseUpdate || !row || row.revision !== where.revision) return { count: 0 };
      Object.assign(row, { value: data.value, revision: row.revision + data.revision.increment });
      writes++; return { count: 1 };
    },
  });
  const prisma = {
    workspaceLayout: { findUnique: args => table(rows).findUnique(args) },
    async $transaction(run) {
      transactions++;
      const pending = clone(rows);
      const result = await run({ workspaceLayout: table(pending) });
      rows = pending; return result;
    },
  };
  const service = new PacsService(prisma, {}, {}, {}, {});
  return { service, snapshot: () => clone(rows), writes: () => writes, transactions: () => transactions,
    seed(value, revision = 7, c = caller) {
      rows.set(JSON.stringify(owner(c)), { institution: c.institution, subject: c.sub, revision,
        value: JSON.stringify(value), updatedAt: new Date('2026-10-09T00:00:00Z') });
    },
    faults(options = {}) {
      ({ failRead = false, failWrite = false, loseUpdate = false, loseCreate = false } = options);
    } };
}

test('TEST-W3-SERVER-01 v1/v2/v3 retain their formats on GET and upgrade without losing reading', async () => {
  for (const version of [1, 2, 3]) {
    const f = fixture(), value = layout(version); f.seed(value);
    const before = f.snapshot();
    assert.deepEqual(await f.service.workspaceLayout(caller), { owner: owner(caller), revision: 7,
      layout: value, updatedAt: new Date('2026-10-09T00:00:00Z') });
    assert.deepEqual(f.snapshot(), before); assert.equal(f.writes(), 0); assert.equal(f.transactions(), 0);
    const upgraded = layout(); upgraded.reading = version >= 2 ? value.reading : reading();
    const saved = await f.service.writeWorkspaceLayout(request(upgraded, 7), caller, false);
    assert.equal(saved.revision, 8); assert.deepEqual(saved.layout, upgraded);
    assert.deepEqual(await f.service.workspaceLayout(caller), saved);
  }
});

test('TEST-W3-SERVER-02 accepted client records roundtrip via facade; all tabs and size endpoints survive', async () => {
  for (const tab of ['images', 'info', 'templates']) for (const size of [null, 1, 16384]) {
    const f = fixture(), value = layout();
    value.workspace = { version: 1, rail: size, worklist: size, related: size, prior: size,
      railCollapsed: size !== null, studyPanelTab: tab };
    value.reading.relatedHidden = true;
    const source = client.normalize(clone(value)); assert.deepEqual(source, value);
    const saved = await f.service.writeWorkspaceLayout(request(source), caller, false);
    source.workspace.rail = 987; source.reading.reportWidth = 222;
    assert.deepEqual(saved.layout, value); assert.equal(saved.revision, 1);
    assert.deepEqual(await f.service.workspaceLayout(caller), saved);
    assert.deepEqual(client.normalize(saved.layout), value);
  }
});

test('TEST-W3-SERVER-03 strict v3 envelopes reject missing/unknown keys, transient drawer state and oversized data', async () => {
  const invalid = [null, [], false, 'layout'];
  for (const key of Object.keys(layout())) { const v = layout(); delete v[key]; invalid.push(v); }
  for (const version of [0, 4, '3', true]) invalid.push({ ...layout(), version });
  for (const mode of [null, 'invalid', 1]) invalid.push({ ...layout(), mode });
  for (const key of ['open', 'drawerOpen', 'patient', 'report', 'token']) invalid.push({ ...layout(), [key]: 'x'.repeat(2050) });
  for (const value of [null, [], false, 'workspace']) invalid.push({ ...layout(), workspace: value });
  for (const key of Object.keys(layout().workspace)) { const v = layout(); delete v.workspace[key]; invalid.push(v); }
  for (const key of ['open', 'drawerOpen', 'patient', 'report', 'token']) {
    const v = layout(); v.workspace[key] = true; invalid.push(v);
  }
  for (const version of [0, 2, '1', true]) { const v = layout(); v.workspace.version = version; invalid.push(v); }
  for (const value of [null, 0, 1, 'false', [], {}]) { const v = layout(); v.workspace.railCollapsed = value; invalid.push(v); }
  for (const value of [null, '', 'Images', 'other', 0, [], {}]) { const v = layout(); v.workspace.studyPanelTab = value; invalid.push(v); }
  const f = fixture(); f.seed(layout()); const before = f.snapshot();
  for (const value of invalid) {
    await assert.rejects(f.service.writeWorkspaceLayout(request(value, 7), caller, false), status(400), JSON.stringify(value));
    assert.deepEqual(f.snapshot(), before);
  }
  assert.equal(f.transactions(), 0); assert.equal(f.writes(), 0);
});

test('TEST-W3-SERVER-04 every new geometry field requires null or integer 1..16384; legacy rounding remains', async () => {
  for (const name of ['rail', 'worklist', 'related', 'prior']) {
    for (const size of [0, -1, 16385, 1.5, '320', false, [], {}, NaN, Infinity]) {
      const f = fixture(), value = layout(); value.workspace[name] = size;
      await assert.rejects(f.service.writeWorkspaceLayout(request(value), caller, false), status(400), name + ':' + size);
      assert.equal(f.writes(), 0);
    }
  }
  for (const version of [1, 2, 3]) {
    const f = fixture(), value = layout(version); value.portrait.main = 431.6;
    const saved = await f.service.writeWorkspaceLayout(request(value), caller, false);
    assert.equal(saved.layout.portrait.main, 432);
    assert.equal(value.portrait.main, 431.6);
  }
});

test('TEST-W3-SERVER-05 v3 preserves strict reading and legacy panel validation', async () => {
  const invalid = [];
  for (const key of Object.keys(reading())) { const v = layout(); delete v.reading[key]; invalid.push(v); }
  for (const value of [null, [], false, { ...reading(), open: true }, { ...reading(), version: 2 },
    { ...reading(), relatedHidden: 1 }]) invalid.push({ ...layout(), reading: value });
  for (const name of ['reportWidth', 'imageHeight', 'relatedHeight', 'relatedListHeight'])
    for (const size of [0, 16385, 1.5, '320', false]) {
      const v = layout(); v.reading[name] = size; invalid.push(v);
    }
  for (const axis of ['portrait', 'landscape']) {
    for (const value of [null, [], { patient: 123 }, { main: 0 }, { main: 16385 }, { main: '320' }])
      invalid.push({ ...layout(), [axis]: value });
  }
  const f = fixture();
  for (const value of invalid) await assert.rejects(f.service.writeWorkspaceLayout(request(value), caller, false), status(400));
  assert.equal(f.writes(), 0);
});

test('TEST-W3-SERVER-06 current-revision v1/v2 cannot overwrite v3; explicit clear permits legacy reuse', async () => {
  const f = fixture(); const saved = await f.service.writeWorkspaceLayout(request(), caller, false);
  const before = f.snapshot();
  for (const version of [1, 2]) {
    await assert.rejects(f.service.writeWorkspaceLayout(request(layout(version), saved.revision), caller, false),
      status(409, 'WORKSPACE_CONFLICT'));
    assert.deepEqual(f.snapshot(), before); assert.deepEqual(await f.service.workspaceLayout(caller), saved);
  }
  const cleared = await f.service.writeWorkspaceLayout({ expectedOwner: owner(caller), revision: 1 }, caller, true);
  assert.equal(cleared.layout, null); assert.equal(cleared.revision, 2);
  await assert.rejects(f.service.writeWorkspaceLayout(request(layout(1), 1), caller, false), status(409));
  const legacy = await f.service.writeWorkspaceLayout(request(layout(1), 2), caller, false);
  assert.equal(legacy.revision, 3); assert.deepEqual(legacy.layout, layout(1));
});

test('TEST-W3-SERVER-07 changed owners and stale revisions preserve stored v3 for write and clear', async () => {
  const empty = fixture();
  await assert.rejects(empty.service.writeWorkspaceLayout(request(layout(), 1), caller, false), status(409, 'WORKSPACE_CONFLICT'));
  assert.equal(empty.snapshot().size, 0);
  const f = fixture(); f.seed(layout()); const before = f.snapshot();
  for (const clear of [false, true]) {
    const body = clear ? { expectedOwner: owner(caller), revision: 7 } : request(layout(), 7);
    for (const expectedOwner of [['other-hospital', caller.sub], [caller.institution, 'other-reader']]) {
      await assert.rejects(f.service.writeWorkspaceLayout({ ...body, expectedOwner }, caller, clear), status(409, 'WORKSPACE_OWNER_CHANGED'));
      assert.deepEqual(f.snapshot(), before);
    }
    for (const revision of [0, 6, 8]) {
      await assert.rejects(f.service.writeWorkspaceLayout({ ...body, revision }, caller, clear), status(409, 'WORKSPACE_CONFLICT'));
      assert.deepEqual(f.snapshot(), before);
    }
  }
  const value = layout(); value.workspace.studyPanelTab = 'info';
  const saved = await f.service.writeWorkspaceLayout(request(value, 7), caller, false);
  assert.equal(saved.revision, 8); assert.deepEqual(saved.layout, value);
});

test('TEST-W3-SERVER-08 facade retains member/role/subject/institution boundaries', async () => {
  const f = fixture();
  for (const roles of [['radiologist'], ['technician'], ['admin'], ['clinician', 'radiologist']]) {
    const c = { ...caller, roles, sub: roles.join('-') };
    const saved = await f.service.writeWorkspaceLayout(request(layout(), 0, c), c, false);
    assert.deepEqual(saved.owner, owner(c)); assert.deepEqual(saved.layout, layout());
  }
  for (const c of [{ ...caller, kind: 'gateway' }, { ...caller, roles: ['clinician'] },
    { ...caller, roles: [] }, { ...caller, institution: null }, { ...caller, sub: '' }]) {
    const before = f.snapshot();
    await assert.rejects(f.service.workspaceLayout(c), status(403));
    await assert.rejects(f.service.writeWorkspaceLayout(request(layout(), 0, c), c, false), status(403));
    await assert.rejects(f.service.writeWorkspaceLayout({ expectedOwner: owner(c), revision: 0 }, c, true), status(403));
    assert.deepEqual(f.snapshot(), before);
  }
  for (const c of [caller, { ...caller, institution: 'synthetic-hospital-b' }, { ...caller, sub: 'synthetic-reader-b' }]) {
    assert.equal((await f.service.workspaceLayout(c)).layout, null);
    const saved = await f.service.writeWorkspaceLayout(request(layout(), 0, c), c, false);
    assert.deepEqual(await f.service.workspaceLayout(c), saved);
  }
});

test('TEST-W3-SERVER-09 request shape/revision errors cannot reach storage', async () => {
  const f = fixture();
  for (const clear of [false, true]) {
    const body = clear ? { expectedOwner: owner(caller), revision: 0 } : request();
    const bad = [null, [], { ...body, extra: true }];
    for (const key of Object.keys(body)) { const b = clone(body); delete b[key]; bad.push(b); }
    for (const revision of [-1, 0.5, '0', true, 2147483647]) bad.push({ ...body, revision });
    for (const b of bad) await assert.rejects(f.service.writeWorkspaceLayout(b, caller, clear), status(400));
  }
  assert.equal(f.transactions(), 0); assert.equal(f.writes(), 0);
});

test('TEST-W3-SERVER-10 storage failures retain v3 and recover through public re-read', async () => {
  const f = fixture(); f.seed(layout()); const before = f.snapshot();
  f.faults({ failRead: true }); await assert.rejects(f.service.workspaceLayout(caller), /synthetic read unavailable/);
  assert.deepEqual(f.snapshot(), before);
  f.faults({ failWrite: true });
  await assert.rejects(f.service.writeWorkspaceLayout(request(layout(), 7), caller, false), /synthetic write unavailable/);
  assert.deepEqual(f.snapshot(), before);
  f.faults(); const current = await f.service.workspaceLayout(caller);
  const saved = await f.service.writeWorkspaceLayout(request(layout(), current.revision), caller, false);
  assert.equal(saved.revision, 8); assert.deepEqual(await f.service.workspaceLayout(caller), saved);
});

test('TEST-W3-SERVER-11 uniqueness and update CAS races answer conflict without a false success', async () => {
  const f = fixture(); f.faults({ loseCreate: true });
  await assert.rejects(f.service.writeWorkspaceLayout(request(), caller, false), status(409, 'WORKSPACE_CONFLICT'));
  assert.equal(f.snapshot().size, 0);
  f.seed(layout()); const before = f.snapshot(); f.faults({ loseUpdate: true });
  await assert.rejects(f.service.writeWorkspaceLayout(request(layout(), 7), caller, false), status(409, 'WORKSPACE_CONFLICT'));
  await assert.rejects(f.service.writeWorkspaceLayout({ expectedOwner: owner(caller), revision: 7 }, caller, true), status(409, 'WORKSPACE_CONFLICT'));
  assert.deepEqual(f.snapshot(), before);
});

test('TEST-W3-SERVER-12 malformed stored v3 is rejected on read without rewrite', async () => {
  for (const change of [v => { v.workspace.open = true; }, v => { v.workspace.rail = 1.5; },
    v => { v.reading.relatedHidden = 'false'; }]) {
    const f = fixture(), value = layout(); change(value); f.seed(value); const before = f.snapshot();
    await assert.rejects(f.service.workspaceLayout(caller), status(400));
    assert.deepEqual(f.snapshot(), before); assert.equal(f.writes(), 0);
  }
});
