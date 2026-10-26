'use strict';
// Read the selected wire body; HTTP/PG publication is covered by emr/a/report_reads_test.cjs.
const readBody = value => JSON.parse(value.json);

// B2 consumer fixture only: these existing pure suites exercise business/CAS rules.
// Real ledger atomicity and HTTP publication are tested against PostgreSQL.
const {withDraftRequestContext} = require('./emr/request/consumer_fixture.cjs');
function b2Ledger(prisma) {
  return { begin: () => ({
    resolveRequestIdentity: async () => '00000000-0000-4000-8000-000000000001',
    transactionWithRecords: (work, options) => prisma.$transaction(tx => work(tx, async (_event, effect) => effect()), options),
    end() {},
  }) };
}
// WORKLIST-SPLIT-UID (spec-worklist-split-uid-20261016): REQ-WSU-01..06/08 -> RISK-WSU-01..06/08 ->
// TEST-WSU-02, 03, 04, 05, 06, 08, 09, 12 (pure part). TEST-WSU-01 is tests/study_source_test.cjs.
// Every case calls the real services: PacsService (worklist, gateway, draft, hold, evidence, institutions, clinician),
// StudyAccessService and the real OrthancService over a stubbed global fetch that answers like Orthanc's /tools/find and
// QIDO-RS, one row per original Study resource. The database is an in-memory Prisma double whose interactive
// transactions commit or roll back together and whose StudyState uid is unique (a second create is P2002, as PostgreSQL
// answers the loser of a unique race). Assertions are on answers, stored rows, audit rows and source requests only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.ORTHANC_USER = 'synthetic'; process.env.ORTHANC_PASS = 'synthetic';
const { OrthancService } = require('/app/dist/orthanc.service');
const { StudyAccessService } = require('/app/dist/study-access.service');
const { PacsService } = require('/app/dist/pacs.service');
const { ReportPreviewController } = require('/app/dist/report-preview.controller');

const EPOCH = '00000000-0000-4000-8000-0000000000e1';
const INSTITUTIONS = [{ id: 'hallym', name: 'Hallym', type: 'hospital', dicomNames: 'HALLYM,한림대학교' },
  { id: 'center', name: 'Center', type: 'center', dicomNames: 'CENTER' },
  { id: 'other', name: 'Other', type: 'hospital', dicomNames: 'OTHER' }];
const caller = (over = {}) => ({ institution: 'hallym', sub: 'sub-reader', actor: 'reader', roles: ['radiologist'], kind: 'member', ...over });
const SPLIT = '2.25.900', NORMAL = '2.25.100';
// Two patient resources answering one Study UID (A and B) and a normal single resource.
const resource = (uid, patientId, extra = {}) => ({ uid, patientId, name: 'SYN^' + patientId, institution: 'HALLYM',
  accession: 'ACC-' + patientId, date: '20261001', modalities: ['CT'], birth: '19700101', sex: 'O', desc: 'SYN ' + uid, ...extra });
const A = (extra) => resource(SPLIT, 'SYN-PID-A', extra), B = (extra) => resource(SPLIT, 'SYN-PID-B', extra);

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value), (k, v) =>
  typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && ['createdAt', 'updatedAt', 'heldAt', 'at'].includes(k) ? new Date(v) : v);
const stateRow = (uid, over = {}) => ({ uid, institutionId: null, teleInstitutionId: null, origin: 'dicom', rs: 'W', holdReason: null,
  ss: 'Unverified', em: 'N', ts: 'none', matched: 'U', ward: '', reqHosp: 'KIN', repDoc: null, confirm: null, preDoc: null,
  preReviewer: null, preDocSub: null, preReviewerSub: null, ov: null, orig: null, orderOid: null, holder: null, heldAt: null,
  draftEpoch: EPOCH, updatedAt: new Date('2026-10-01T00:00:00.000Z'), createdAt: new Date('2026-10-01T00:00:00.000Z'), ...over });

/** A synthetic Orthanc behind fetch, a Prisma double, and the services built on them. */
function world({ resources = [], states = [], policy = null, institutions = INSTITUTIONS } = {}) {
  const w = { resources: clone(resources), states: new Map(states.map(s => [s.uid, clone(s)])), audits: [], writes: [],
    orthanc: [], unexpected: [], inTx: 0, reserved: new Map(), failAudit: null, orthancDown: false, policy,
    hooks: { stateFind: null, orderFind: null, find: null }, finds: 0, drafts: new Map(), reports: new Map() };
  const qido = r => ({ '0020000D': { Value: [r.uid] }, '00080080': { Value: [r.institution] }, '00100020': { Value: [r.patientId] },
    '00100010': { Value: [{ Alphabetic: r.name }] }, '00080020': { Value: [r.date] }, '00080050': { Value: [r.accession] },
    '00080061': { Value: r.modalities }, '00201206': { Value: [1] }, '00201208': { Value: [1] }, '00081030': { Value: [r.desc] },
    '00100030': { Value: [r.birth] }, '00100040': { Value: [r.sex] } });
  const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  w.fetch = async (url, init = {}) => {
    const u = new URL(url), method = (init.method || 'GET').toUpperCase();
    w.orthanc.push({ method, path: u.pathname, uid: u.searchParams.get('StudyInstanceUID'), inTx: w.inTx > 0 });
    if (w.orthancDown) throw new TypeError('fetch failed');
    if (method === 'POST' && u.pathname === '/tools/find') {
      const asked = JSON.parse(init.body).RequestedTags;
      const tags = r => ({ StudyInstanceUID: r.uid, InstitutionName: r.institution, PatientID: r.patientId, StudyDate: r.date,
        ModalitiesInStudy: r.modalities.join('\\'), AccessionNumber: r.accession });
      return json(w.resources.map(r => ({ Type: 'Study', RequestedTags: Object.fromEntries(asked.map(k => [k, tags(r)[k]])) })));
    }
    if (method === 'GET' && u.pathname === '/dicom-web/studies') {
      const wanted = u.searchParams.get('StudyInstanceUID');
      const rows = wanted === null ? w.resources : w.resources.filter(r => wanted.split(',').includes(r.uid));
      return json(rows.map(qido));
    }
    w.unexpected.push(method + ' ' + u.pathname);
    return new Response('', { status: 404 });
  };
  globalThis.fetch = w.fetch;

  const pick = (row, select) => row && (select ? Object.fromEntries(Object.keys(select).map(k => [k, row[k]])) : clone(row));
  const matches = (row, where) => !where || Object.entries(where).every(([k, v]) => k === 'OR' ? v.some(c => matches(row, c))
    : v && typeof v === 'object' && !(v instanceof Date) && Array.isArray(v.in) ? v.in.includes(row[k]) : row[k] === v);
  const write = (model, op, detail) => w.writes.push({ model, op, ...detail });
  // One client over a store: the root client writes straight to `store`; a transaction gets a staged copy.
  function client(store, root) {
    const states = {
      findMany: async arg => {
        const n = ++w.finds;
        if (w.hooks.find) await w.hooks.find(arg, n, store);
        return [...store.states.values()].filter(s => matches(s, arg?.where)).map(s => pick(s, arg?.select));
      },
      findUnique: async arg => pick(store.states.get(arg.where.uid), arg.select) ?? null,
      create: async ({ data }) => {
        // PostgreSQL makes the second insert of one key wait for the first transaction, then fail if it committed.
        const holder = w.reserved.get(data.uid);
        if (holder && !store.mine.has(data.uid)) await holder.done;
        if (store.states.has(data.uid) || w.states.has(data.uid))
          throw Object.assign(new Error('Unique constraint failed on the fields: (`uid`)'), { code: 'P2002', meta: { modelName: 'StudyState' } });
        w.reserved.set(data.uid, store.tx); store.mine.add(data.uid);
        const row = stateRow(data.uid, { ...data, createdAt: new Date() });
        store.states.set(data.uid, row); write('studyState', 'create', { uid: data.uid });
        return clone(row);
      },
      update: async ({ where, data }) => {
        const row = store.states.get(where.uid); if (!row) throw Object.assign(new Error('missing'), { code: 'P2025' });
        Object.assign(row, data); write('studyState', 'update', { uid: where.uid, data }); return clone(row);
      },
      updateMany: async ({ where, data }) => {
        const rows = [...store.states.values()].filter(s => matches(s, where));
        for (const row of rows) Object.assign(row, data);
        if (rows.length) write('studyState', 'updateMany', { where, data });
        return { count: rows.length };
      },
    };
    const raw = async (strings, ...values) => {
      const sql = strings.join('?');
      if (sql.includes('StudyAccessPolicy')) return w.policy ? [{ institution: 'hallym', revision: w.policy.revision ?? 1,
        policy: w.policy.policy ?? w.policy, reason: '', updatedBy: null, updatedAt: null }] : [];
      if (sql.includes('pg_advisory')) return [{ locked: 1 }];
      if (sql.includes('AuthSession')) return [{ held: 1 }];
      if (sql.includes('TechNoteRevision')) return [];
      if (sql.includes('FROM "StudyState" WHERE uid')) { const row = store.states.get(values[0]); return row ? [clone(row)] : []; }
      if (sql.includes('FROM "ReportDraft"')) { const row = store.drafts.get(values[0] + '|' + values[1]); return row ? [clone(row)] : []; }
      if (sql.includes('LEFT JOIN "Report"')) return [...store.states.values()].filter(s => values.flatMap(v => v?.values ?? [v]).includes(s.uid))
        .map(s => ({ uid: s.uid, institutionId: s.institutionId, teleInstitutionId: s.teleInstitutionId, rs: s.rs, repDoc: s.repDoc,
          confirm: s.confirm, version: 0, action: null }));
      return [];
    };
    const db = {
      studyState: states,
      auditLog: { create: async ({ data }) => {
        if (w.failAudit && data.target === w.failAudit && data.action === 'study.arrived') throw new Error('synthetic audit store failure');
        store.audits.push(data); write('auditLog', 'create', { action: data.action, target: data.target }); return data; } },
      report: { findMany: async () => [], findUnique: async () => null },
      reportVersion: { findMany: async () => [], findUnique: async () => null, findFirst: async () => null,
        createMany: async x => { write('reportVersion', 'createMany', {}); return { count: x.data.length }; } },
      reportDraft: {
        findMany: async ({ where }) => [...store.drafts.values()].filter(d => d.author === where.author && where.uid.in.includes(d.uid)).map(clone),
        findUnique: async ({ where }) => clone(store.drafts.get(where.uid_author.uid + '|' + where.uid_author.author)) ?? null,
        create: async ({ data }) => { const row = { ...data, updatedAt: new Date() }; store.drafts.set(data.uid + '|' + data.author, row);
          write('reportDraft', 'create', { uid: data.uid }); return clone(row); },
        updateMany: async ({ where, data }) => { const key = where.uid + '|' + where.author, row = store.drafts.get(key);
          if (!row || row.revision !== where.revision) return { count: 0 }; Object.assign(row, data); write('reportDraft', 'updateMany', { uid: where.uid });
          return { count: 1 }; },
      },
      readerAssignment: { findMany: async () => [] }, gatewayReceipt: { findMany: async () => [] },
      viewerItem: { findMany: async () => [] },
      order: { findMany: async arg => { if (w.hooks.orderFind) await w.hooks.orderFind(arg, store); return clone(w.orders ?? []).filter(o => matches(o, arg?.where)); },
        count: async () => 1, updateMany: async () => ({ count: 0 }) },
      institution: { upsert: async () => ({}), findMany: async () => clone(institutions) },
      memberRights: { findUnique: async () => null },
      readingTemplate: { count: async () => 1, findMany: async () => [] }, userFilter: { findMany: async () => [] },
      $queryRaw: raw, $executeRaw: async () => 1,
    };
    if (root) db.$transaction = async (work) => {
      // A staged copy: everything the work wrote is applied only when it returns.
      let finish; const tx = { done: new Promise(r => { finish = r; }) };
      const staged = { states: new Map([...store.states].map(([k, v]) => [k, clone(v)])), audits: [],
        drafts: new Map([...store.drafts].map(([k, v]) => [k, clone(v)])), mine: new Set(), tx };
      const writesBefore = w.writes.length; w.inTx++;
      try {
        const result = await work(client(staged, false));
        for (const [k, v] of staged.states) store.states.set(k, v);
        for (const [k, v] of staged.drafts) store.drafts.set(k, v);
        store.audits.push(...staged.audits);
        return result;
      } catch (error) { w.writes.length = writesBefore; throw error; }
      finally { w.inTx--; for (const uid of staged.mine) if (w.reserved.get(uid) === tx) w.reserved.delete(uid); finish(); }
    };
    return db;
  }
  const store = { states: w.states, audits: w.audits, drafts: w.drafts, mine: new Set() };
  w.prisma = client(store, true);
  w.orthancService = new OrthancService();
  w.studyAccess = new StudyAccessService(w.prisma, w.orthancService, {});
  w.pacs = withDraftRequestContext(new PacsService(w.prisma, w.orthancService, { usersInGroupWithRole: async () => [] }, w.studyAccess,
    { readableFindings: async () => [] }, b2Ledger(w.prisma)), b2Ledger(w.prisma));
  w.start = async () => { const log = console.log; console.log = () => {}; try { await w.pacs.onModuleInit(); } finally { console.log = log; } return w; };
  w.arrivals = () => w.audits.filter(a => a.action === 'study.arrived');
  w.sourceWrites = () => w.orthanc.filter(c => !(c.method === 'GET' || c.method === 'POST' && c.path === '/tools/find'));
  return w;
}
const uidsOf = list => list.studies.map(s => s.uid);
const code = e => e?.getResponse?.()?.code;
const rejects = (promise, status, wanted) => assert.rejects(promise, e => {
  assert.equal(e?.getStatus?.(), status, String(e?.message)); if (wanted !== undefined) assert.equal(code(e), wanted); return true; });

// ── TEST-WSU-02 cold registration, audit atomicity and race (M-WSU-01, M-WSU-02) ──
test('TEST-WSU-02 a UID with two patient resources registers one row and one arrival audit in either stored order', async () => {
  for (const order of [[A(), B()], [B(), A()]]) {
    for (const query of [undefined, { limit: '100' }]) {
      const w = await world({ resources: [...order, resource(NORMAL, 'SYN-PID-N')] }).start();
      const listed = await w.pacs.listStudies(caller(), query);
      assert.deepEqual([...w.states.keys()].sort(), [NORMAL, SPLIT]);
      assert.deepEqual(w.arrivals().map(a => a.target).sort(), [NORMAL, SPLIT], 'one study.arrived per UID');
      assert.equal(w.states.get(SPLIT).institutionId, 'hallym');
      assert.equal(w.states.get(SPLIT).ss, 'Unverified');
      assert.deepEqual(uidsOf(listed), [NORMAL]);
      assert.deepEqual(listed.identityIssues, [{ uid: SPLIT, code: 'STUDY_IDENTITY_UNRESOLVED' }]);
      // Warm: the same enumeration registers nothing more and still answers.
      const again = await w.pacs.listStudies(caller(), query);
      assert.deepEqual(uidsOf(again), [NORMAL]);
      assert.equal(w.arrivals().length, 2);
      assert.deepEqual(w.sourceWrites(), []);
    }
  }
});
test('TEST-WSU-02 a failed arrival audit rolls the new row back; a concurrent first list writes one row and one audit', async () => {
  const w = await world({ resources: [A(), B(), resource(NORMAL, 'SYN-PID-N')] }).start();
  w.failAudit = SPLIT;
  await assert.rejects(w.pacs.listStudies(caller()), /synthetic audit store failure/);
  assert.equal(w.states.has(SPLIT), false, 'the row is not left without its arrival audit');
  assert.equal(w.arrivals().some(a => a.target === SPLIT), false);
  w.failAudit = null;
  await w.pacs.listStudies(caller());
  assert.equal(w.arrivals().filter(a => a.target === SPLIT).length, 1);

  const race = await world({ resources: [A(), B()] }).start();
  // Both requests enumerate before either registers: the loser of the unique race reads the winner's row.
  let entered = 0, release; const gate = new Promise(r => { release = r; });
  race.hooks.find = async (arg, n) => { if (!arg?.where && ++entered <= 2) { if (entered === 2) release(); await gate; } };
  const [one, two] = await Promise.all([race.pacs.listStudies(caller()), race.pacs.listStudies(caller())]);
  assert.equal(race.states.size, 1);
  assert.equal(race.arrivals().length, 1, 'one arrival audit for the race');
  assert.deepEqual([one.identityIssues, two.identityIssues], [[{ uid: SPLIT, code: 'STUDY_IDENTITY_UNRESOLVED' }], [{ uid: SPLIT, code: 'STUDY_IDENTITY_UNRESOLVED' }]]);
});
test('TEST-WSU-02/05 an existing row keeps its institution, tele, request hospital and origin; a null institution is filled only by consensus', async () => {
  const kept = stateRow(SPLIT, { institutionId: 'hallym', teleInstitutionId: 'center', reqHosp: 'Hallym', origin: 'gateway', rs: 'T' });
  const w = await world({ resources: [A({ institution: 'CENTER' }), B({ institution: 'OTHER' })], states: [kept] }).start();
  await w.pacs.listStudies(caller());
  await w.pacs.listStudies(caller(), { limit: '10' });
  const row = w.states.get(SPLIT);
  assert.deepEqual([row.institutionId, row.teleInstitutionId, row.reqHosp, row.origin, row.rs], ['hallym', 'center', 'Hallym', 'gateway', 'T']);
  assert.deepEqual(w.writes.filter(x => x.model === 'studyState'), [], 'no write to an assigned row');
  assert.equal(w.arrivals().length, 0);

  // Null institution: alias names of one institution agree; any unknown, empty or different name keeps it null.
  for (const [names, expected] of [[['HALLYM', '한림대학교'], 'hallym'], [['HALLYM', 'CENTER'], null], [['HALLYM', 'UNKNOWN-SITE'], null], [['HALLYM', ''], null]]) {
    for (const order of [names, [...names].reverse()]) {
      const cold = await world({ resources: [A({ institution: order[0] }), B({ institution: order[1] })] }).start();
      await cold.pacs.listStudies(caller());
      assert.equal(cold.states.get(SPLIT).institutionId, expected, 'cold ' + order.join('+'));
      const warm = await world({ resources: [A({ institution: order[0] }), B({ institution: order[1] })], states: [stateRow(SPLIT)] }).start();
      await warm.pacs.listStudies(caller(), { limit: '5' });
      assert.equal(warm.states.get(SPLIT).institutionId, expected, 'warm ' + order.join('+'));
    }
  }
  // A manual assignment that lands between the enumeration and the fill is not overwritten.
  const manual = await world({ resources: [A(), B()], states: [stateRow(SPLIT)] }).start();
  manual.hooks.find = async (arg, n, store) => { if (n === 1) store.states.get(SPLIT).institutionId = 'center'; };
  await manual.pacs.listStudies(caller());
  assert.equal(manual.states.get(SPLIT).institutionId, 'center');
});

// ── TEST-WSU-03 stable lists and pagination (M-WSU-03, M-WSU-09) ──
test('TEST-WSU-03 103 normal studies and one split UID: unpaged and 100+3 pages carry the same normal set, total 103, issues on the last page', async () => {
  const normals = Array.from({ length: 103 }, (_, i) => resource('2.25.' + (1000 + i), 'SYN-N-' + i));
  for (const order of [[A(), B()], [B(), A()]]) {
    const w = await world({ resources: [...normals.slice(0, 50), order[0], ...normals.slice(50), order[1]] }).start();
    const whole = await w.pacs.listStudies(caller());
    assert.equal(whole.studies.length, 103);
    assert.deepEqual(whole.identityIssues, [{ uid: SPLIT, code: 'STUDY_IDENTITY_UNRESOLVED' }]);
    const first = await w.pacs.listStudies(caller(), { limit: '100' });
    assert.deepEqual([first.studies.length, first.pagination.total, first.pagination.offset, typeof first.pagination.next], [100, 103, 0, 'string']);
    assert.equal('identityIssues' in first, false, 'a middle page says nothing about issues');
    const last = await w.pacs.listStudies(caller(), { limit: '100', after: first.pagination.next });
    assert.deepEqual([last.studies.length, last.pagination.total, last.pagination.offset, last.pagination.next], [3, 103, 100, null]);
    assert.deepEqual(last.identityIssues, [{ uid: SPLIT, code: 'STUDY_IDENTITY_UNRESOLVED' }]);
    assert.deepEqual([...uidsOf(first), ...uidsOf(last)].sort(), uidsOf(whole).sort());
    const text = JSON.stringify([whole, first, last]);
    for (const leak of ['SYN-PID-A', 'SYN-PID-B', 'hallym|SYN-PID', 'ACC-SYN-PID']) assert.equal(text.includes(leak), false, leak);
    assert.equal([...whole.studies, ...first.studies, ...last.studies].some(s => s.uid === SPLIT), false);
  }
});
test('TEST-WSU-03 a split-only list is an empty successful page with its issue; an issue outside the scope is never counted', async () => {
  const w = await world({ resources: [A(), B()] }).start();
  const page = await w.pacs.listStudies(caller(), { limit: '100' });
  assert.deepEqual([page.studies, page.pagination.total, page.pagination.next], [[], 0, null]);
  assert.deepEqual(page.identityIssues, [{ uid: SPLIT, code: 'STUDY_IDENTITY_UNRESOLVED' }]);
  // Another institution's split and its count stay out of this caller's answer entirely.
  const other = await world({ resources: [A({ institution: 'OTHER' }), B({ institution: 'OTHER' }), resource(NORMAL, 'SYN-PID-N')] }).start();
  for (const query of [undefined, { limit: '100' }]) {
    const seen = await other.pacs.listStudies(caller(), query);
    assert.deepEqual(seen.identityIssues, []);
    assert.deepEqual(uidsOf(seen), [NORMAL]);
    if (query) assert.equal(seen.pagination.total, 1);
  }
  assert.deepEqual((await other.pacs.listStudies(caller({ institution: 'other' }))).identityIssues, [{ uid: SPLIT, code: 'STUDY_IDENTITY_UNRESOLVED' }]);
});

// ── TEST-WSU-04 policy intersection across every resource (M-WSU-05, M-WSU-06, M-WSU-07) ──
const rule = over => ({ patientId: null, modalities: [], dateFrom: null, dateTo: null, studyUids: [], ...over });
const restricted = rules => ({ version: 1, restricted: true, startsAt: null, endsAt: null, rules });
test('TEST-WSU-04 an issue needs every resource to pass the policy on its own; fields of two resources never join', async () => {
  const cases = [
    ['A only', [rule({ patientId: 'SYN-PID-A' })], false],
    ['B only', [rule({ patientId: 'SYN-PID-B' })], false],
    ['A or B, each by its own rule', [rule({ patientId: 'SYN-PID-A' }), rule({ patientId: 'SYN-PID-B' })], true],
    // A's patient with B's date: A fails the date, B fails the patient, only a joined tuple would pass.
    ['joined tuple', [rule({ patientId: 'SYN-PID-A', dateFrom: '2026-10-05', dateTo: '2026-10-05' })], false],
    ['explicit UID rule keeps its meaning', [rule({ studyUids: [SPLIT] })], true],
  ];
  for (const [label, rules, visible] of cases) for (const order of [[A(), B({ date: '20261005' })], [B({ date: '20261005' }), A()]]) {
    const w = await world({ resources: [...order, resource(NORMAL, 'SYN-PID-A')], policy: restricted(rules), states: [stateRow(SPLIT, { institutionId: 'hallym' })] }).start();
    for (const query of [undefined, { limit: '100' }]) {
      const listed = await w.pacs.listStudies(caller(), query);
      assert.deepEqual(listed.identityIssues, visible ? [{ uid: SPLIT, code: 'STUDY_IDENTITY_UNRESOLVED' }] : [], label);
    }
    // The single-UID preparation (all resources of that UID) and the batch preparation decide the same way.
    for (const prepare of [async c => w.studyAccess.prepare(c, [SPLIT]), async c => w.studyAccess.prepare(c)]) {
      const c = caller();
      await prepare(c);
      assert.equal((await w.studyAccess.allowed(c, [SPLIT])).has(SPLIT), visible, label + ' allowed');
    }
  }
});
test('TEST-WSU-04 another UID keeps its access while a split UID is out of scope; a failed source read is not a pass', async () => {
  const w = await world({ resources: [A(), B(), resource(NORMAL, 'SYN-PID-A')], policy: restricted([rule({ patientId: 'SYN-PID-A' })]) }).start();
  const c = caller();
  await w.studyAccess.prepare(c);
  const allowed = await w.studyAccess.allowed(c, [NORMAL, SPLIT]);
  assert.deepEqual([allowed.has(NORMAL), allowed.has(SPLIT)], [true, false]);
  await w.studyAccess.require(caller(), [NORMAL]);
  await rejects(w.studyAccess.require(caller(), [SPLIT]), 404);
  w.orthancDown = true;
  await rejects(w.studyAccess.require(caller(), [NORMAL]), 503);
});

// ── TEST-WSU-05 institution consensus and the tele boundary (M-WSU-08, M-WSU-20) ──
test('TEST-WSU-05 the announcement needs the stored owner on every resource; tele sees it only under its own scope', async () => {
  const issue = [{ uid: SPLIT, code: 'STUDY_IDENTITY_UNRESOLVED' }];
  const telerow = stateRow(SPLIT, { institutionId: 'hallym', teleInstitutionId: 'center' });
  const w = await world({ resources: [A(), B({ institution: '한림대학교' })], states: [telerow] }).start();
  assert.deepEqual((await w.pacs.listStudies(caller())).identityIssues, issue, 'owner');
  assert.deepEqual((await w.pacs.listStudies(caller({ institution: 'center' }))).identityIssues, issue, 'tele receiver');
  assert.deepEqual((await w.pacs.listStudies(caller({ institution: 'other' }))).identityIssues, [], 'unrelated institution');
  assert.deepEqual((await w.pacs.listStudies(caller({ institution: 'other', roles: ['admin'] }))).identityIssues, [], 'admin elsewhere');
  w.states.get(SPLIT).teleInstitutionId = null;
  assert.deepEqual((await w.pacs.listStudies(caller({ institution: 'center' }))).identityIssues, [], 'cancelled tele');
  // The receiver's own policy decides for the receiver.
  const scoped = await world({ resources: [A(), B()], states: [telerow], policy: restricted([rule({ patientId: 'SYN-PID-A' })]) }).start();
  assert.deepEqual((await scoped.pacs.listStudies(caller({ institution: 'center' }))).identityIssues, []);
  // A stored owner that one resource's own institution tag contradicts is not announced, and nothing moves.
  for (const order of [[A(), B({ institution: 'CENTER' })], [B({ institution: 'CENTER' }), A()]]) {
    const mixed = await world({ resources: order, states: [stateRow(SPLIT, { institutionId: 'hallym', reqHosp: 'Hallym' })] }).start();
    for (const c of [caller(), caller({ institution: 'center' })]) assert.deepEqual((await mixed.pacs.listStudies(c)).identityIssues, []);
    assert.deepEqual([mixed.states.get(SPLIT).institutionId, mixed.states.get(SPLIT).teleInstitutionId, mixed.states.get(SPLIT).reqHosp], ['hallym', null, 'Hallym']);
  }
  // A normal single original keeps the existing owner/tele behaviour.
  const single = await world({ resources: [resource(NORMAL, 'SYN-PID-N')], states: [stateRow(NORMAL, { institutionId: 'hallym', teleInstitutionId: 'center' })] }).start();
  assert.deepEqual(uidsOf(await single.pacs.listStudies(caller({ institution: 'center' }))), [NORMAL]);
  assert.equal((await single.pacs.listStudies(caller({ institution: 'center' }))).studies[0].tele, true);
});

// ── TEST-WSU-06 real changes stay conflicts (M-WSU-11, M-WSU-12, M-WSU-13) ──
test('TEST-WSU-06 a deleted row or a same-size different UID set at an await boundary is STUDY_LIST_CHANGED', async () => {
  const two = [resource(NORMAL, 'SYN-PID-N'), resource('2.25.101', 'SYN-PID-M')];
  const states = [stateRow(NORMAL, { institutionId: 'hallym' }), stateRow('2.25.101', { institutionId: 'hallym' })];
  for (const [label, when, query] of [['before details', 2, { limit: '10' }], ['before response', 3, { limit: '10' }], ['unpaged', 2, undefined]]) {
    const w = await world({ resources: two, states }).start();
    w.hooks.find = async (arg, n, store) => { if (n === when) store.states.delete('2.25.101'); };
    await rejects(w.pacs.listStudies(caller(), query), 409, 'STUDY_LIST_CHANGED');
    // Same number of rows, a different UID: a count comparison would pass it.
    const swap = await world({ resources: two, states }).start();
    swap.hooks.find = async (arg, n, store) => {
      if (n !== when) return;
      const moved = store.states.get('2.25.101'); store.states.delete('2.25.101');
      store.states.set('2.25.199', { ...moved, uid: '2.25.199' });
      if (arg?.where?.uid) arg.where.uid.in.push('2.25.199');
    };
    await rejects(swap.pacs.listStudies(caller(), query), 409, 'STUDY_LIST_CHANGED');
  }
});
test('TEST-WSU-06 a same-size answer that names another known UID with identical fields is still a changed list', async () => {
  // Page one is UID 100; the database answers the page details (and later the final read) with UID 101's row instead:
  // same count, a row the enumeration also knows with the very same access fields. Only the exact UID set tells them apart.
  const states = [stateRow(NORMAL, { institutionId: 'hallym' }), stateRow('2.25.101', { institutionId: 'hallym' })];
  for (const when of [2, 3]) {
    const w = await world({ resources: [resource(NORMAL, 'SYN-PID-N'), resource('2.25.101', 'SYN-PID-M')], states }).start();
    w.hooks.find = async (arg, n) => { if (n === when && arg?.where?.uid) arg.where.uid.in = ['2.25.101']; };
    await rejects(w.pacs.listStudies(caller(), { limit: '1' }), 409, 'STUDY_LIST_CHANGED');
  }
});
test('TEST-WSU-06 every access field changed before the details, before the response or during the order side is detected', async () => {
  const changes = { institutionId: 'center', teleInstitutionId: 'other', rs: 'P', preDoc: 'someone', preReviewer: 'reviewer',
    preDocSub: 'sub-x', preReviewerSub: 'sub-y' };
  for (const [field, value] of Object.entries(changes)) {
    for (const [label, when, query] of [['paged before details', 2, { limit: '10' }], ['paged before response', 3, { limit: '10' }],
      ['unpaged before response', 2, undefined]]) {
      const w = await world({ resources: [resource(NORMAL, 'SYN-PID-N')], states: [stateRow(NORMAL, { institutionId: 'hallym', teleInstitutionId: field === 'teleInstitutionId' ? null : 'center' })] }).start();
      w.hooks.find = async (arg, n, store) => { if (n === when) store.states.get(NORMAL)[field] = value; };
      await rejects(w.pacs.listStudies(caller(), query), 409, 'STUDY_LIST_CHANGED');
    }
    // A change during the completing page's order side, after the first comparison.
    const late = await world({ resources: [resource(NORMAL, 'SYN-PID-N'), A(), B()], states: [stateRow(NORMAL, { institutionId: 'hallym', teleInstitutionId: field === 'teleInstitutionId' ? null : 'center' }), stateRow(SPLIT, { institutionId: 'hallym' })] }).start();
    late.hooks.orderFind = async (arg, store) => { store.states.get(NORMAL)[field] = value; };
    await rejects(late.pacs.listStudies(caller(), { limit: '10' }), 409, 'STUDY_LIST_CHANGED');
    // The announced UID's own access is checked the same way.
    const issue = await world({ resources: [A(), B()], states: [stateRow(SPLIT, { institutionId: 'hallym', teleInstitutionId: field === 'teleInstitutionId' ? null : 'center' })] }).start();
    issue.hooks.orderFind = async (arg, store) => { store.states.get(SPLIT)[field] = value; };
    await rejects(issue.pacs.listStudies(caller()), 409, 'STUDY_LIST_CHANGED');
  }
});
test('TEST-WSU-06 single at enumeration but split at the page details is one conflict; a stable split never breaks a continuation', async () => {
  const w = await world({ resources: [resource(NORMAL, 'SYN-PID-N'), A()], states: [stateRow(NORMAL, { institutionId: 'hallym' })] }).start();
  w.hooks.find = async (arg, n) => { if (n === 2) w.resources.push(B()); };
  await rejects(w.pacs.listStudies(caller(), { limit: '10' }), 409, 'STUDY_LIST_CHANGED');
  w.hooks.find = null;
  const fresh = await w.pacs.listStudies(caller(), { limit: '10' });
  assert.deepEqual([uidsOf(fresh), fresh.identityIssues], [[NORMAL], [{ uid: SPLIT, code: 'STUDY_IDENTITY_UNRESOLVED' }]]);
  // A stable split that is reordered or gains a third resource between pages does not change the normal set.
  const normals = Array.from({ length: 3 }, (_, i) => resource('2.25.' + (200 + i), 'SYN-N-' + i));
  const paged = await world({ resources: [...normals, A(), B()] }).start();
  const first = await paged.pacs.listStudies(caller(), { limit: '2' });
  paged.resources = [B(), ...normals, A(), resource(SPLIT, 'SYN-PID-C')];
  const second = await paged.pacs.listStudies(caller(), { limit: '2', after: first.pagination.next });
  assert.deepEqual([...uidsOf(first), ...uidsOf(second)].sort(), normals.map(r => r.uid).sort());
  assert.deepEqual(second.identityIssues, [{ uid: SPLIT, code: 'STUDY_IDENTITY_UNRESOLVED' }]);
  // A policy revision change during the request stays the existing STUDY_ACCESS_CHANGED.
  const policy = await world({ resources: [resource(NORMAL, 'SYN-PID-N')], policy: { revision: 1, policy: restricted([rule({ studyUids: [NORMAL] })]) } }).start();
  policy.hooks.find = async (arg, n) => { if (n === 3) policy.policy = { revision: 2, policy: restricted([rule({ studyUids: [NORMAL] })]) }; };
  await rejects(policy.pacs.listStudies(caller(), { limit: '10' }), 409, 'STUDY_ACCESS_CHANGED');
});
test('TEST-WSU-06 a source access tag that changes between the enumeration and the page details is STUDY_LIST_CHANGED, even when both values pass the policy', async () => {
  // spec §3.2: the page's Orthanc details are held to the enumeration's tags. The stored rows and the UID set stay the
  // same, and both values of every changed tag pass the caller's policy, so only the source comparison can see it.
  const changes = { institution: 'OTHER', patientId: 'SYN-PID-M', date: '20261002', modalities: ['MR'] };
  const both = restricted([rule({ patientId: 'SYN-PID-N' }), rule({ patientId: 'SYN-PID-M' })]);
  for (const field of [null, ...Object.keys(changes)]) {
    const w = await world({ resources: [resource(NORMAL, 'SYN-PID-N')], states: [stateRow(NORMAL, { institutionId: 'hallym' })],
      policy: { revision: 1, policy: both } }).start();
    // findMany #1 is the enumeration's rows, #2 the page's details: the source changes between the two reads.
    w.hooks.find = async (arg, n) => { if (n === 2 && field) w.resources[0][field] = changes[field]; };
    if (!field) {
      const page = await w.pacs.listStudies(caller(), { limit: '10' });
      assert.deepEqual(uidsOf(page), [NORMAL], 'the unchanged source answers its page');
    } else await rejects(w.pacs.listStudies(caller(), { limit: '10' }), 409, 'STUDY_LIST_CHANGED');
    assert.deepEqual(w.sourceWrites(), []);
  }
  // A caller without a source-tag policy is held to the institution tag the enumeration resolved the row by.
  for (const change of [false, true]) {
    const open = await world({ resources: [resource(NORMAL, 'SYN-PID-N')], states: [stateRow(NORMAL, { institutionId: 'hallym' })] }).start();
    open.hooks.find = async (arg, n) => { if (n === 2 && change) open.resources[0].institution = 'OTHER'; };
    if (change) await rejects(open.pacs.listStudies(caller(), { limit: '10' }), 409, 'STUDY_LIST_CHANGED');
    else assert.deepEqual(uidsOf(await open.pacs.listStudies(caller(), { limit: '10' })), [NORMAL]);
  }
});
test('TEST-WSU-06 the page details are held to the enumeration\'s raw text: a whitespace-only change of InstitutionName, PatientID or StudyDate is STUDY_LIST_CHANGED', async () => {
  // The enumeration's raw text is the reference (spec §2.1/§3.2): a leading or trailing whitespace change of
  // InstitutionName, PatientID or StudyDate is a change. The policy reads the source (modality rule), and both values of
  // each tag pass it; the stored rows are untouched. A raw value that itself carries whitespace and does not change is
  // its own unchanged control.
  const ct = { revision: 1, policy: restricted([rule({ modalities: ['CT'] })]) };
  const spaced = { institution: ' HALLYM', patientId: ' SYN-PID-N', date: ' 20261001' };
  for (const field of Object.keys(spaced)) {
    const w = await world({ resources: [resource(NORMAL, 'SYN-PID-N')], states: [stateRow(NORMAL, { institutionId: 'hallym' })], policy: ct }).start();
    w.hooks.find = async (arg, n) => { if (n === 2) w.resources[0][field] = spaced[field]; };
    await rejects(w.pacs.listStudies(caller(), { limit: '10' }), 409, 'STUDY_LIST_CHANGED');
    assert.deepEqual(w.states.get(NORMAL).institutionId, 'hallym');
  }
  const kept = await world({ resources: [resource(NORMAL, ' SYN-PID-N ', { institution: 'HALLYM ', date: '20261001 ' })],
    states: [stateRow(NORMAL, { institutionId: 'hallym' })], policy: ct }).start();
  const unchanged = await kept.pacs.listStudies(caller(), { limit: '10' });
  assert.deepEqual([uidsOf(unchanged), unchanged.studies[0].id, unchanged.studies[0].date], [[NORMAL], ' SYN-PID-N ', '20261001 ']);
});

// ── TEST-WSU-08 direct clinical entries (M-WSU-14, M-WSU-16) ──
const owner = c => ({ institution: c.institution, sub: c.sub, author: c.actor });
const draftBody = (c, over = {}) => ({ expectedOwner: owner(c), expectedRevision: EPOCH + ':0', findings: 'SYN findings',
  conclusion: '', recommendation: '', baseVersion: 0, citationIds: [], structureIds: [], ...over });
async function clinical(resources, over = {}) {
  const row = stateRow(SPLIT, { institutionId: 'hallym', ss: 'Verified', em: 'E', ...over });
  const w = await world({ resources, states: [row] }).start();
  return w;
}
test('TEST-WSU-08 every report write and read on a split UID is 409 STUDY_IDENTITY_UNRESOLVED with no write; a single resource proceeds', async () => {
  const c = caller({ roles: ['radiologist', 'admin'] });
  const entries = {
    readDraft: w => w.pacs.readDraft(SPLIT, c),
    hold: w => w.pacs.hold(SPLIT, c),
    putDraft: w => w.pacs.putReport(SPLIT, draftBody(c), c, null),
    clearDraft: w => w.pacs.putReport(SPLIT, draftBody(c, { findings: '' }), c, null),
    discardDraft: w => w.pacs.discardDraft(SPLIT, { expectedOwner: owner(c), expectedRevision: EPOCH + ':0' }, c, null),
    forceDiscard: w => w.pacs.forceDiscardDrafts(SPLIT, { expectedOwner: owner(c), expectedEpoch: EPOCH }, c, null),
    ...Object.fromEntries(['save', 'approve', 'reset', 'defer', 'addendum'].map(action => ['commit-' + action,
      w => w.pacs.commitReport(SPLIT, { ...draftBody(c), action, reason: 'SYN reason', removeCitationIds: [] }, c, null)])),
    dictation: w => w.pacs.dictationGate(SPLIT, c),
    versions: w => w.pacs.versions(SPLIT, c),
    citations: w => w.pacs.reportCitations(SPLIT, c),
    structure: w => w.pacs.reportStructure(SPLIT, c),
    versionCitations: w => w.pacs.reportVersionCitations(SPLIT, '1', c),
    preview: w => new ReportPreviewController(w.prisma, w.orthancService, w.studyAccess, {}).read(SPLIT, c),
    clinicianRead: w => w.pacs.clinicianReportRead(SPLIT, caller({ roles: ['clinician'] })),
    dicomLookup: w => w.pacs.dicomLookup(SPLIT, '2.25.77', c),
  };
  for (const [name, call] of Object.entries(entries)) {
    const w = await clinical([A(), B()]);
    if (name === 'dicomLookup') w.orthancService.lookupInstance = async () => [{ Type: 'Instance', ID: '0000000a-0000000b-0000000c-0000000d-0000000e' }];
    if (name === 'dicomLookup') w.orthancService.instanceStudyUid = async () => SPLIT;
    const before = JSON.stringify([...w.states.values()]);
    await rejects(call(w), 409, 'STUDY_IDENTITY_UNRESOLVED');
    assert.deepEqual(w.writes, [], name + ' wrote');
    assert.equal(JSON.stringify([...w.states.values()]), before, name);
    assert.equal(w.orthanc.some(x => x.inTx), false, name + ' read the source inside a transaction');
    assert.deepEqual(w.sourceWrites(), []);
  }
  // Positive control: the same draft save and hold on one resource write.
  const one = await clinical([A()]);
  await one.pacs.putReport(SPLIT, draftBody(c), c, null);
  await one.pacs.hold(SPLIT, c);
  assert.deepEqual(one.writes.map(x => x.model + '.' + x.op), ['reportDraft.create', 'auditLog.create', 'studyState.update', 'auditLog.create']);
});
test('TEST-WSU-08 hold release and force release stay available; images are 403 for a split UID and pass for another UID', async () => {
  const c = caller({ roles: ['radiologist', 'admin'] });
  const w = await clinical([A(), B(), resource(NORMAL, 'SYN-PID-N')], { holder: 'reader', heldAt: new Date() });
  w.states.set(NORMAL, stateRow(NORMAL, { institutionId: 'hallym' }));
  assert.deepEqual(await w.pacs.release(SPLIT, c), { ok: true });
  assert.equal(w.states.get(SPLIT).holder, null);
  w.states.get(SPLIT).holder = 'someone-else'; w.states.get(SPLIT).heldAt = new Date();
  assert.equal((await w.pacs.forceRelease(SPLIT, c)).released, 'someone-else');
  for (const uri of ['/dicom-web/studies/' + SPLIT + '/series', '/dicom-web/studies?StudyInstanceUID=' + SPLIT,
    '/dicom-web/studies/' + SPLIT + '/series/2.25.5/instances/2.25.6/frames/1'])
    await rejects(w.pacs.authzDicom(uri, 'GET', c), 403);
  await w.pacs.authzDicom('/dicom-web/studies/' + NORMAL + '/series', 'GET', c);
  w.orthancService.instanceStudyUid = async () => SPLIT;
  await rejects(w.pacs.authzDicom('/instances/0000000a-0000000b-0000000c-0000000d-0000000e/frames/1', 'GET', c), 403);
});
test('TEST-WSU-08 scope and role refusals come first and say nothing about the source; an unobservable source is 503 (403 for images)', async () => {
  const outsider = caller({ institution: 'other', roles: ['radiologist'] });
  const w = await clinical([A(), B()]);
  await rejects(w.pacs.readDraft(SPLIT, outsider), 404);
  await rejects(w.pacs.putReport(SPLIT, draftBody(outsider), outsider, null), 404);
  await rejects(w.pacs.hold(SPLIT, outsider), 404);
  await rejects(w.pacs.versions(SPLIT, outsider), 404);
  await rejects(w.pacs.authzDicom('/dicom-web/studies/' + SPLIT + '/series', 'GET', outsider), 403);
  await rejects(w.pacs.readDraft(SPLIT, caller({ roles: ['technician'] })), 403);
  const down = await clinical([A()]);
  down.orthancDown = true;
  const c = caller();
  await rejects(down.pacs.readDraft(SPLIT, c), 503, 'STUDY_SOURCE_UNAVAILABLE');
  await rejects(down.pacs.putReport(SPLIT, draftBody(c), c, null), 503, 'STUDY_SOURCE_UNAVAILABLE');
  await rejects(down.pacs.authzDicom('/dicom-web/studies/' + SPLIT + '/series', 'GET', c), 403);
  assert.deepEqual(down.writes, []);
});
test('TEST-WSU-08 a source observation is per request: an earlier single answer does not admit a later split', async () => {
  const c1 = caller(), w = await clinical([A()]);
  await w.pacs.readDraft(SPLIT, c1);
  w.resources.push(B());
  await rejects(w.pacs.readDraft(SPLIT, caller()), 409, 'STUDY_IDENTITY_UNRESOLVED');
});

// ── TEST-WSU-09 derived projections (M-WSU-04) ──
test('TEST-WSU-09 a split UID is observed, has no order pairing or reconciliation, and is not restored by bootstrap or unassigned', async () => {
  // SPLIT is linked to order O-S; 2.25.901 is an unlinked split whose two resources carry ACC-4 (first) and ACC-5 (last).
  const OPEN = '2.25.901';
  const w = await world({ resources: [A({ accession: 'ACC-1' }), B({ accession: 'ACC-2' }), resource(NORMAL, 'SYN-PID-N', { accession: 'ACC-3' }),
      resource(OPEN, 'SYN-PID-C', { accession: 'ACC-4' }), resource(OPEN, 'SYN-PID-D', { accession: 'ACC-5' })],
    states: [stateRow(SPLIT, { institutionId: 'hallym', matched: 'U' }), stateRow(NORMAL, { institutionId: 'hallym', matched: 'U' }),
      stateRow(OPEN, { institutionId: 'hallym', matched: 'U' }),
      stateRow('2.25.555', { institutionId: 'hallym', matched: 'M', orderOid: 'O-LINKED' })] }).start();
  w.orders = [{ oid: 'O-1', institutionId: 'hallym', accession: 'ACC-1', matched: 'U', studyUid: null },
    { oid: 'O-2', institutionId: 'hallym', accession: 'ACC-2', matched: 'U', studyUid: null },
    { oid: 'O-3', institutionId: 'hallym', accession: 'ACC-3', matched: 'U', studyUid: null },
    { oid: 'O-4', institutionId: 'hallym', accession: 'ACC-4', matched: 'U', studyUid: null },
    { oid: 'O-5', institutionId: 'hallym', accession: 'ACC-5', matched: 'U', studyUid: null },
    { oid: 'O-S', institutionId: 'hallym', accession: 'ACC-1', matched: 'M', studyUid: SPLIT }];
  w.states.get(SPLIT).matched = 'M'; w.states.get(SPLIT).orderOid = 'O-S';
  for (const query of [undefined, { limit: '100' }]) {
    const listed = await w.pacs.listStudies(caller(), query);
    assert.deepEqual(listed.notObserved.map(x => x.uid), ['2.25.555'], 'a split UID is observed, not absent');
    const orders = Object.fromEntries(listed.orderReconciliation.orders.map(o => [o.oid, o]));
    assert.deepEqual(orders['O-1'].candidates, []);
    assert.deepEqual(orders['O-2'].candidates, []);
    assert.deepEqual([orders['O-4'].candidates, orders['O-5'].candidates], [[], []], 'neither resource accession of a split is a candidate');
    assert.deepEqual(orders['O-3'].candidates, [NORMAL], 'other orders still reconcile');
    assert.equal('O-S' in orders, false, 'the linked order of a split UID is not reconciled against either resource');
    assert.equal(JSON.stringify(listed.orderReconciliation).includes(SPLIT), false);
  }
  const boot = await w.pacs.bootstrap(caller());
  assert.equal(SPLIT in boot.states, false);
  assert.equal(NORMAL in boot.states, true);
  assert.deepEqual(w.writes, []);
  const lean = await w.pacs.bootstrap(caller(), { states: 'omit' });
  assert.deepEqual(lean.states, {});

  // Unassigned: a split is not two assignable patients, and its assignment is refused without a write.
  const orphan = await world({ resources: [A({ institution: 'UNKNOWN' }), B({ institution: 'UNKNOWN' }), resource(NORMAL, 'SYN-PID-N', { institution: 'UNKNOWN' })] }).start();
  await orphan.pacs.listStudies(caller());
  const admin = caller({ roles: ['admin'] });
  assert.deepEqual((await orphan.pacs.unassigned(admin)).studies.map(s => s.uid), [NORMAL]);
  const writes = orphan.writes.length;
  await rejects(orphan.pacs.assignInstitution(SPLIT, 'hallym', admin), 409, 'STUDY_IDENTITY_UNRESOLVED');
  assert.equal(orphan.writes.length, writes);
  assert.equal(orphan.states.get(SPLIT).institutionId, null);
  await orphan.pacs.assignInstitution(NORMAL, 'hallym', admin);
  assert.equal(orphan.states.get(NORMAL).institutionId, 'hallym');
});
test('TEST-WSU-09 the clinician list and timeline count the normal set and carry only UID+code issues', async () => {
  const w = await world({ resources: [A(), B(), resource(NORMAL, 'SYN-PID-N'), resource('2.25.101', 'SYN-PID-N')] }).start();
  const clinician = caller({ roles: ['clinician'], actor: 'clinician-1', sub: 'sub-clinician' });
  const list = readBody(await w.pacs.clinicianStudies(clinician));
  assert.deepEqual(list.studies.map(s => s.uid).sort(), [NORMAL, '2.25.101']);
  assert.deepEqual(list.identityIssues, [{ uid: SPLIT, code: 'STUDY_IDENTITY_UNRESOLVED' }]);
  assert.deepEqual(Object.keys(list).sort(), ['identityIssues', 'serverTime', 'studies']);
  const paged = readBody(await w.pacs.clinicianStudies(clinician, { limit: '1' }));
  assert.equal(paged.pagination.total, 2);
  assert.equal('identityIssues' in paged, false);
  const timeline = readBody(await w.pacs.clinicianTimeline(NORMAL, clinician, { limit: '10' }));
  assert.equal(timeline.pagination.total, 2);
  await rejects(w.pacs.clinicianTimeline(SPLIT, clinician, { limit: '10' }), 404);
});

// ── TEST-WSU-12 preservation and external resolution (pure part) ──
test('TEST-WSU-12 refusals keep rows, drafts and audits; an external resolution returns the UID to the normal list on the same row', async () => {
  const c = caller();
  const w = await clinical([A(), B()], { rs: 'T', reqHosp: 'Hallym', teleInstitutionId: 'center' });
  w.drafts.set(SPLIT + '|reader', { uid: SPLIT, author: 'reader', findings: 'SYN kept text', conclusion: '', recommendation: '',
    baseVersion: 0, citations: null, structured: null, revision: 3, present: true, updatedAt: new Date() });
  const before = JSON.stringify([[...w.states], [...w.drafts], w.audits]);
  await w.pacs.listStudies(c);
  await rejects(w.pacs.putReport(SPLIT, draftBody(c, { expectedRevision: EPOCH + ':3' }), c, null), 409, 'STUDY_IDENTITY_UNRESOLVED');
  await rejects(w.pacs.commitReport(SPLIT, { ...draftBody(c, { expectedRevision: EPOCH + ':3' }), action: 'approve', removeCitationIds: [] }, c, null), 409, 'STUDY_IDENTITY_UNRESOLVED');
  assert.equal(JSON.stringify([[...w.states], [...w.drafts], w.audits]), before);
  assert.deepEqual(w.sourceWrites(), []);
  assert.deepEqual(w.unexpected, []);
  // The sources are corrected outside this product: the next observation is one resource.
  w.resources = [A()];
  const listed = await w.pacs.listStudies(c);
  assert.deepEqual([uidsOf(listed), listed.identityIssues], [[SPLIT], []]);
  assert.equal(listed.studies[0].state.draft.findings, 'SYN kept text');
  assert.equal(w.arrivals().length, 0, 'no second arrival audit');
  assert.equal(JSON.stringify([[...w.states], [...w.drafts], w.audits]), before, 'listing wrote nothing');
  // An unobservable source is not a resolution.
  w.resources = [A(), B()]; w.orthancDown = true;
  await rejects(w.pacs.readDraft(SPLIT, caller()), 503, 'STUDY_SOURCE_UNAVAILABLE');
});
