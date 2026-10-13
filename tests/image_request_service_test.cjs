'use strict';
/* TEST-S5-U4c-ACCESS: the compiled image request service over a stub store and a recording Orthanc.
 * REQ-S5-U4p-STUDY-ACCESS-READ / REQ-S5-U4p-IDEMPOTENCY / REQ-S5-U4p-CONNECT-SEPARATE -> RISK-S5-U4p-ACCESS-READ-CONFLATION /
 * REPLAY-HISTORY / REQUEST-AS-TRANSFER (contract S5-U4p section 4.1, 7.1, 10.2, 11); since EMR-D also REQ-EMR-01/03/07 ->
 * RISK-D-01..04 -> TEST-D-04.
 *
 * The real StudyAccessService (compiled, /app/dist) decides access; only Prisma and Orthanc are stubs, as in
 * study_access_service_test.cjs and clinician_question_service_test.cjs. Since EMR-D the service is composed with the
 * clinical runtime the server composes (tests/emr/d/service_fixture.cjs): every write is one version - the requesting
 * clinician's device signs the request and its cancel, staff handling is an unsigned operational entry - committed by
 * the runtime with the service's own projection of the rows below in one clinical commit, and every answer is read as
 * the client gets it, through the response boundary. Every stub call is logged in order with the transaction it ran in
 * ('tx' a transaction of the service or of the response boundary, 'commit' a clinical transaction), so "the source read
 * ends before a transaction starts" and "no Orthanc call inside a transaction" are read from one event list.
 *   (1) a metadata rule: the source tags are read before every transaction and no transaction makes an Orthanc call
 *       (create: studyAccessMetadata of its one study; a change and its replay: studyIdentities(true));
 *   (2) the policy revision moves during the source read: 409 STUDY_ACCESS_CHANGED, no transaction, nothing registered,
 *       versioned or written (create, change, replay);
 *   (3) the source read fails: 503, no transaction, nothing registered, versioned or written (create, change, replay);
 *   (4) the constructor takes PrismaService and StudyAccessService only (no OrthancService, no ConnectService), as Nest's
 *       own metadata resolves it, and no flow of the service touches a Connect delegate or table;
 *   (5) a recording Orthanc sees only studyAccessMetadata and studyIdentities(true) across create, accept, replay, read,
 *       forStudy, list and close, and nothing at all when the policy has no metadata rule.
 * Also pinned over the same stubs: every applied requestId replays its stored receipt without a write, after Closed and
 * after a new active request; reuse is 409 REQUEST_ID_REUSED; the active-request rule, the counterparty check, the
 * transition table, the action roles and the audit detail keys without text; the lock order (StudyState before the
 * request row and the counterparty Institution, the receipt read after the commit); #8/#9 in one RepeatableRead
 * snapshot; an owner change between the statements of a read gives no body at the boundary; and the original terminal
 * of an accepted, a declined and a refused request.
 * Hosted only (kin-api:ci): no /app/dist exists on a development host.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ImageRequestService, IMAGE_REQUEST_AUDIT_ACTION } = require('/app/dist/image-request.service');
const { StudyAccessService } = require('/app/dist/study-access.service');
const { OWNER_ONLY_AUDIT_ACTIONS } = require('/app/dist/pacs.service');
const { OrthancService } = require('/app/dist/orthanc.service');
const { ConnectService } = require('/app/dist/connect.service');
const F = require('./emr/d/service_fixture.cjs').compose();
const CONTROLLERS = ['image-request.controller'];

const uid = '2.25.4343';
const institution = 'synthetic';
const counterparty = 'synthetic-other';
const member = (name, roles) => ({ kind: 'member', institution, sub: 'synthetic-' + name + '-sub', actor: 'synthetic-' + name,
  roles, name: 'SYNTHETIC ' + name });
const clinician = member('clinician', ['clinician']);
const technician = member('tech', ['technician']);
const radiologist = member('reader', ['radiologist']);
const admin = member('admin', ['admin']);
const owner = c => [c.institution, c.sub];
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const metadataPolicy = () => ({ version: 1, restricted: true, startsAt: null, endsAt: null,
  rules: [{ patientId: 'SYNTHETIC-PATIENT', modalities: [], dateFrom: null, dateTo: null, studyUids: [] }] });
const uidPolicy = () => ({ version: 1, restricted: true, startsAt: null, endsAt: null,
  rules: [{ patientId: null, modalities: [], dateFrom: null, dateTo: null, studyUids: [uid] }] });
const source = u => ({ '0020000D': { Value: [u] }, '00100020': { Value: ['SYNTHETIC-PATIENT'] } });
const code = (status, value) => e => typeof e?.getStatus === 'function' && e.getStatus() === status
  && (value === undefined || e.getResponse()?.code === value);
// A legacy row written before EMR-D (no clinical version of it exists).
const seeded = (n, state, revision) => ({ id: id(n), studyUid: uid, institutionId: institution, kind: 'image-transfer',
  requesterSub: clinician.sub, requesterActor: clinician.actor, requesterName: clinician.name,
  counterpartyText: 'SYNTHETIC hospital', counterpartyInstitutionId: null, reason: 'SYNTHETIC reason', state, revision,
  handlerActor: null, handlerName: null, note: null, changedBy: clinician.actor, createdAt: new Date(0), updatedAt: new Date(0) });
// Members of a Connect flow the service must never reach (REQ-S5-U4p-CONNECT-SEPARATE).
const CONNECT = ['transfer', 'transferBasis', 'processingAgreement', 'connect'];
const CONNECT_TABLES = ['"Transfer"', '"TransferBasis"', '"ProcessingAgreement"'];

/**
 * One synthetic store: the study's owner, StudyAccessPolicy, requests, receipts and audit rows, with an ordered event log.
 * `statements` repeats `events` with the row lock of each SQL statement; `transactions` keeps the options of every service
 * $transaction and `{ commit: true }` for each clinical transaction. A RepeatableRead transaction reads a copy of the
 * store - and of the clinical versions - taken when it starts (PostgreSQL fixes the snapshot at its first statement;
 * nothing commits in between here); any other transaction and the root client read the live store per statement, as
 * ReadCommitted does. Writes go to the live store and a failed clinical commit undoes them with its versions. The unique
 * keys the schema has refuse a second row (P2002). `between({event: step})` runs each step once, right after that
 * statement of the NEXT service transaction to start, as a commit landing between two statements of that transaction.
 * `touched` records every member the service reads of its Prisma clients and `sql` every statement of the case's tables.
 */
function world(policy, { requests = [] } = {}) {
  const events = [], statements = [], transactions = [], calls = [], audits = [], touched = new Set(), sql = [];
  const writes = { request: 0, update: 0, receipt: 0, audit: 0 };
  const store = { requests: new Map(requests.map(r => [r.id, { ...r }])), receipts: new Map(), study: { institutionId: institution } };
  const institutions = new Set([institution, counterparty]);
  const w = { events, statements, transactions, calls, audits, writes, store, touched, sql,
    policyRow: policy ? { institution, revision: 1, policy, reason: '', updatedBy: null, updatedAt: null } : null };
  let target = null, steps = new Map();
  w.between = next => { steps = new Map(Object.entries(next)); target = 'next'; };
  w.pending = () => [...steps.keys()];
  const log = (event, lock = '') => { events.push(event); statements.push(event + lock); };
  const after = async (index, event) => {
    if (index === null || index !== target || !steps.has(event)) return;
    const step = steps.get(event);
    steps.delete(event);
    await step();
  };
  const kind = text => text.includes('pg_advisory') ? 'advisory' : text.includes('"StudyAccessPolicy"') ? 'policy'
    : text.includes('FROM "StudyImageRequest" r') ? 'list' : text.includes('FROM "StudyImageRequest" WHERE "studyUid"') ? 'active'
      : text.includes('FROM "StudyImageRequest" WHERE id') ? 'request' : text.includes('"Institution"') ? 'institution'
        : text.includes('"StudyState"') ? 'study' : 'unknown';
  const lockOf = text => text.includes('FOR UPDATE') ? ' FOR UPDATE' : text.includes('FOR KEY SHARE') ? ' FOR KEY SHARE'
    : text.includes('FOR SHARE') ? ' FOR SHARE' : '';
  const query = async (where, view, index, strings, values) => {
    const text = strings.join('?'), k = kind(text);
    sql.push(text);
    log(where + ':' + k, lockOf(text));
    let rows;
    if (k === 'advisory') rows = [{ locked: 1 }];
    else if (k === 'policy') rows = w.policyRow ? [w.policyRow] : [];
    else if (k === 'list') rows = [];
    else if (k === 'request') { const row = view.requests.get(values[0]); rows = row ? [{ ...row }] : []; }
    else if (k === 'active') rows = [...view.requests.values()].filter(r => r.studyUid === values[0] && r.kind === values[1]
      && r.requesterSub === values[2] && ['Requested', 'Accepted'].includes(r.state)).map(r => ({ id: r.id }));
    else if (k === 'institution') rows = institutions.has(values[0]) ? [{ id: values[0] }] : [];
    else if (k === 'study') rows = (Array.isArray(values[0]) ? values[0] : [values[0]]).filter(u => u === uid)
      .map(u => ({ uid: u, institutionId: view.study.institutionId, teleInstitutionId: null }));
    else throw new Error('unexpected SQL in the stub: ' + text);
    await after(index, where + ':' + k);
    return rows;
  };
  const unique = (map, key, field) => {
    if (map.has(key)) throw Object.assign(new Error('SYNTHETIC unique constraint'), { code: 'P2002', meta: { target: [field] } });
  };
  const client = (view, index, where = 'tx') => ({
    $executeRaw: async () => { log(where + ':execute'); return 0; },
    $queryRaw: (strings, ...values) => query(where, view, index, strings, values),
    studyImageRequest: {
      findUnique: async ({ where: key }) => { log(where + ':request-row'); const row = view.requests.get(key.id); return row ? { ...row } : null; },
      create: async ({ data }) => { log(where + ':write'); unique(store.requests, data.id, 'id'); writes.request++; store.requests.set(data.id, { ...data }); return data; },
      update: async ({ where: key, data }) => {
        log(where + ':write'); writes.update++;
        const row = { ...store.requests.get(key.id), ...data }; store.requests.set(key.id, row); return row;
      },
    },
    studyImageRequestReceipt: {
      findUnique: async ({ where: key }) => { log(where + ':receipt'); const row = view.receipts.get(key.requestId); return row ? { ...row } : null; },
      create: async ({ data }) => { log(where + ':write'); unique(store.receipts, data.requestId, 'requestId'); writes.receipt++; store.receipts.set(data.requestId, { ...data }); return data; },
    },
    auditLog: { create: async ({ data }) => { log(where + ':write'); writes.audit++; audits.push(data); return data; } },
  });
  // What the service reads of a client it is handed, as it reads it.
  const recorded = value => new Proxy(value, { get: (object, name) => { touched.add(String(name)); return object[name]; } });
  // The clinical half (tests/emr/d/service_fixture.cjs): a failed commit undoes the rows below with its versions.
  w.clinical = F.attach({
    tables: {
      snapshot: () => structuredClone({ requests: [...store.requests], receipts: [...store.receipts], study: store.study, writes, audits }),
      restore: s => {
        store.requests.clear(); for (const [k, v] of s.requests) store.requests.set(k, v);
        store.receipts.clear(); for (const [k, v] of s.receipts) store.receipts.set(k, v);
        Object.assign(store.study, s.study); Object.assign(writes, s.writes); audits.splice(0, audits.length, ...s.audits);
      },
    },
    transaction: () => { const index = transactions.push({ commit: true }) - 1; log('commit:start'); return client(store, index, 'commit'); },
    finish: (_tx, how) => log(how === 'commit' ? 'commit:end' : 'commit:rollback'),
    studyOf: u => (u === uid ? { institutionId: store.study.institutionId } : null),
  });
  const root = {
    $queryRaw: (strings, ...values) => query('root', store, null, strings, values),
    $transaction: async (fn, options) => {
      const index = transactions.push(options) - 1;
      if (target === 'next') target = index;
      const repeatable = options?.isolationLevel === 'RepeatableRead';
      const view = repeatable ? structuredClone(store) : store;
      log('tx:start');
      try { return await fn(recorded(w.clinical.client(client(view, index), repeatable ? w.clinical.frozen() : null))); }
      finally { log('tx:end'); }
    },
    studyState: { findMany: async () => { log('root:studies'); return [{ uid }]; } },
    studyImageRequestReceipt: { findUnique: async ({ where }) => { log('root:receipt'); const row = store.receipts.get(where.requestId); return row ? { ...row } : null; } },
  };
  const prisma = recorded(w.clinical.client(root));
  w.handlers = { studyAccessMetadata: async u => source(u), studyIdentities: async () => [source(uid)] };
  // Records every member the service stack touches, not only the two it is allowed to use.
  const orthanc = new Proxy({}, { get: (_target, name) => async (...args) => {
    calls.push({ name: String(name), args }); events.push('orthanc:' + String(name));
    const handler = w.handlers[name];
    return handler ? handler(...args) : null;
  } });
  w.access = new StudyAccessService(prisma, orthanc, {});
  w.svc = new ImageRequestService(prisma, w.access);
  w.bumpPolicy = () => { w.policyRow = { ...w.policyRow, revision: w.policyRow.revision + 1 }; };
  /** Starts the observation afresh after a case's preparation (the stores keep what it made). */
  w.observe = () => {
    for (const list of [events, statements, transactions, calls, sql]) list.splice(0);
    touched.clear();
    Object.assign(writes, { request: 0, update: 0, receipt: 0, audit: 0 });
    w.settled = { rows: w.clinical.store.rows.size, units: JSON.stringify([...w.clinical.store.units]), events: w.clinical.store.events.length };
  };
  w.settled = { rows: 0, units: '[]', events: 0 };
  return w;
}

/** One call as a client makes it: B2's verified request (the requesting clinician's device signature for a clinical
 *  write) and the answer the response boundary gives. */
const call = async (route, c, run, write) => {
  const req = await F.request(c, write);
  return F.answer(CONTROLLERS, route, await run(req), req);
};
const create = (w, c, requestId, extra = {}) => {
  const b = { requestId, expectedOwner: owner(c), kind: 'image-transfer', counterparty: 'SYNTHETIC receiving hospital',
    counterpartyInstitutionId: null, reason: 'SYNTHETIC reason', ...extra };
  return call('POST studies/:uid/image-requests', c, req => w.svc.create(uid, c, b, req),
    { surface: 'image-request.create', body: b, recordId: String(requestId).toLowerCase(), studyId: uid });
};
const change = (w, target, c, requestId, revision, action, note = action === 'accept' ? '' : 'SYNTHETIC note') => {
  const b = { requestId, expectedOwner: owner(c), revision, action, note };
  return call('POST image-requests/:id', c, req => w.svc.change(target, c, b, req),
    { surface: 'image-request.' + action, body: b, recordId: target.toLowerCase(), studyId: uid });
};
const read = (w, target, c) => call('GET image-requests/:id', c, req => w.svc.read(target, c, req));
const forStudy = (w, u, c) => call('GET studies/:uid/image-requests', c, req => w.svc.forStudy(u, c, req));
const list = (w, c, q) => call('GET image-requests', c, req => w.svc.list(c, q, req));
/** The Orthanc calls made while a transaction (of the service, of the boundary, or a clinical one) was open. */
const insideTransactions = w => {
  let open = 0;
  const found = [];
  for (const event of w.events) {
    if (event === 'tx:start' || event === 'commit:start') open++;
    else if (event === 'tx:end' || event === 'commit:end' || event === 'commit:rollback') open--;
    else if (open > 0 && event.startsWith('orthanc:')) found.push(event);
  }
  return found;
};
/** The statements of the clinical commit that wrote rows (a write also admits under the request lock in its own
 *  clinical transaction, which writes nothing of the service's). */
const commitOf = statements => {
  const segments = [];
  statements.forEach((s, i) => { if (s === 'commit:start') segments.push([i]); else if ((s === 'commit:end' || s === 'commit:rollback') && segments.length) segments.at(-1).push(i); });
  const found = segments.map(([from, to]) => statements.slice(from, to)).filter(segment => segment.includes('commit:write'));
  assert.equal(found.length, 1, 'one clinical commit wrote rows');
  return found[0];
};
const noWrites = { request: 0, update: 0, receipt: 0, audit: 0 };
/** Nothing registered, versioned or appended since the case's observation started. */
const noClinicalEffects = (w, label) => {
  assert.deepEqual([w.clinical.store.rows.size, JSON.stringify([...w.clinical.store.units]), w.clinical.store.events.length, w.events.includes('commit:start')],
    [w.settled.rows, w.settled.units, w.settled.events, false], label + ': no request registered, no version, no ledger event, no commit');
};
// An Accepted request of the clinician (created as id(10)) with the technician's applied accept id(11), made through the
// service as a client makes them, for the replay route of (2) and (3); the observation starts after it.
const acceptedWorld = async policy => {
  const w = world(policy);
  await create(w, { ...clinician }, id(10));
  await change(w, id(10), { ...technician }, id(11), 1, 'accept');
  assert.deepEqual([w.store.requests.get(id(10)).state, w.store.requests.get(id(10)).revision], ['Accepted', 2]);
  w.observe();
  return w;
};
const routes = w => ({
  create: () => create(w, { ...clinician }, id(12), { kind: 'external-image' }),
  change: () => change(w, id(10), { ...technician }, id(13), 2, 'close', 'SYNTHETIC record'),
  replay: () => change(w, id(10), { ...technician }, id(11), 1, 'accept'),
});

test('(1) a metadata rule reads source tags before every transaction and never inside one', async () => {
  const w = world(metadataPolicy());
  const created = await create(w, { ...clinician }, id(1));
  assert.equal(created.replayed, false);
  const start = w.events.indexOf('tx:start');
  assert.ok(start > 0);
  // The UID route prepares its one study before its first transaction; the clinical commit prepares its trusted caller
  // (every study, studyIdentities(true)) after the admission and before the commit transaction.
  const reads = w.events.map((event, index) => [event, index]).filter(([event]) => event.startsWith('orthanc:'));
  assert.deepEqual(reads.map(([event]) => event), ['orthanc:studyAccessMetadata', 'orthanc:studyIdentities']);
  assert.ok(reads[0][1] < start, 'the source read ends before the transaction');
  assert.ok(reads[1][1] < w.events.lastIndexOf('commit:start'), 'the caller is prepared before the commit');
  assert.deepEqual(insideTransactions(w), [], 'no Orthanc call inside a service transaction or a clinical one');
  // The clinical commit locks StudyState before it writes the request's rows; the receipt is read after the commit.
  const commit = commitOf(w.statements);
  assert.ok(commit.includes('commit:study FOR UPDATE') && commit.indexOf('commit:study FOR UPDATE') < commit.indexOf('commit:write'),
    'StudyState is locked before the rows are written');
  assert.ok(w.events.indexOf('root:receipt') > w.events.lastIndexOf('commit:end'), 'the receipt is read after the commit');
  // an id route prepares every study (prepare(c)) before its transactions too, for a change and for its replay; the
  // change's commit prepares its caller once more before the commit, and a replay commits nothing
  for (const [label, sources] of [['change', 2], ['replay', 1]]) {
    const before = w.events.length;
    const result = await change(w, id(1), { ...technician }, id(2), 1, 'accept');
    assert.equal(result.replayed, label === 'replay', label);
    const later = w.events.slice(before), second = later.indexOf('tx:start');
    assert.deepEqual(later.filter(e => e.startsWith('orthanc:')), Array(sources).fill('orthanc:studyIdentities'), label);
    assert.ok(later.indexOf('orthanc:studyIdentities') < second, label);
    assert.equal(later.includes('commit:write'), label === 'change', label);
  }
  assert.deepEqual(insideTransactions(w), []);
  assert.deepEqual(w.calls.filter(c => c.name === 'studyIdentities').map(c => c.args), [[true], [true], [true], [true]]);
  assert.deepEqual(w.writes, { request: 1, update: 1, receipt: 2, audit: 2 });
});

test('(2) a policy change during the source read is 409 STUDY_ACCESS_CHANGED with no transaction and no write', async () => {
  for (const route of ['create', 'change', 'replay']) {
    const w = await acceptedWorld(metadataPolicy());
    w.handlers.studyAccessMetadata = async u => { w.bumpPolicy(); return source(u); };
    w.handlers.studyIdentities = async () => { w.bumpPolicy(); return [source(uid)]; };
    await assert.rejects(routes(w)[route](), code(409, 'STUDY_ACCESS_CHANGED'), route);
    assert.equal(w.events.includes('tx:start'), false, route);
    assert.deepEqual(w.writes, noWrites, route);
    noClinicalEffects(w, route);
  }
});

test('(3) a failed source read is 503 with no transaction and no write', async () => {
  for (const route of ['create', 'change', 'replay']) {
    const w = await acceptedWorld(metadataPolicy());
    w.handlers.studyAccessMetadata = async () => { throw new Error('SYNTHETIC transport failure'); };
    w.handlers.studyIdentities = async () => { throw new Error('SYNTHETIC transport failure'); };
    await assert.rejects(routes(w)[route](), code(503), route);
    assert.equal(w.events.includes('tx:start'), false, route);
    assert.deepEqual(w.writes, noWrites, route);
    noClinicalEffects(w, route);
  }
});

test('(4) the service is constructed from PrismaService and StudyAccessService only and reaches no Connect delegate or table', async () => {
  // What Nest injects is what its metadata names: the design types, with no token of the service's own replacing one.
  const types = Reflect.getMetadata('design:paramtypes', ImageRequestService);
  assert.deepEqual(types.map(type => type.name), ['PrismaService', 'StudyAccessService']);
  assert.equal(types.includes(OrthancService), false);
  assert.equal(types.includes(ConnectService), false);
  assert.equal(Reflect.getMetadata('self:paramtypes', ImageRequestService), undefined, 'no @Inject token overrides a design type');
  assert.equal(ImageRequestService.length, 2);
  // Every route, as a client calls it: no Connect delegate is read and no statement names a Connect table.
  const w = world(null);
  await create(w, { ...clinician }, id(21), { counterpartyInstitutionId: counterparty });
  await change(w, id(21), { ...technician }, id(22), 1, 'accept');
  await read(w, id(21), { ...clinician });
  await forStudy(w, uid, { ...technician });
  await list(w, { ...technician }, { view: 'queue' });
  await list(w, { ...clinician }, { view: 'mine' });
  await change(w, id(21), { ...admin }, id(23), 2, 'close', 'SYNTHETIC record');
  await create(w, { ...clinician }, id(24));
  await change(w, id(24), { ...clinician }, id(25), 1, 'cancel', 'SYNTHETIC cancel');
  assert.ok(w.touched.has('$transaction') && w.touched.has('studyImageRequestReceipt'), 'the recording sees the service read its clients');
  assert.deepEqual(CONNECT.filter(name => w.touched.has(name)), []);
  assert.ok(w.sql.length > 0);
  assert.deepEqual(w.sql.filter(text => CONNECT_TABLES.some(table => text.includes(table))), []);
  assert.deepEqual(w.calls, [], 'no Orthanc member is touched without a metadata rule');
});

test('(5) only studyAccessMetadata and studyIdentities(true) reach Orthanc, and nothing without a metadata rule', async () => {
  const flows = async w => {
    await create(w, { ...clinician }, id(31));
    await change(w, id(31), { ...technician }, id(32), 1, 'accept');
    await change(w, id(31), { ...technician }, id(32), 1, 'accept');
    await read(w, id(31), { ...clinician });
    await forStudy(w, uid, { ...radiologist });
    await list(w, { ...technician }, { view: 'queue' });
    await change(w, id(31), { ...admin }, id(33), 2, 'close', 'SYNTHETIC record');
  };
  const metadata = world(metadataPolicy());
  await flows(metadata);
  assert.ok(metadata.calls.length > 0);
  for (const c of metadata.calls) {
    assert.ok(['studyAccessMetadata', 'studyIdentities'].includes(c.name), c.name);
    if (c.name === 'studyIdentities') assert.deepEqual(c.args, [true]);
  }
  assert.deepEqual(insideTransactions(metadata), []);
  for (const policy of [null, uidPolicy()]) {
    const w = world(policy);
    await flows(w);
    assert.deepEqual(w.calls, [], JSON.stringify(policy));
    assert.deepEqual(w.writes, { request: 1, update: 2, receipt: 3, audit: 3 });
  }
});

test('every applied requestId replays its stored receipt without a write, after Closed and after a new active request', async () => {
  const w = world(null);
  const created = await create(w, { ...clinician }, id(41));
  const accepted = await change(w, id(41), { ...technician }, id(42), 1, 'accept');
  const closed = await change(w, id(41), { ...technician }, id(43), 2, 'close', 'SYNTHETIC record');
  assert.deepEqual([created, accepted, closed].map(r => [r.applied.action, r.applied.from, r.applied.to, r.applied.revision]),
    [['create', null, 'Requested', 1], ['accept', 'Requested', 'Accepted', 2], ['close', 'Accepted', 'Closed', 3]]);
  const fresh = await create(w, { ...clinician }, id(44));
  assert.deepEqual([fresh.replayed, fresh.applied.id, fresh.applied.revision], [false, id(44), 1]);
  const settled = { ...w.writes }, versions = w.clinical.store.units.get(id(41)).revision;
  for (const [again, first] of [[await create(w, { ...clinician }, id(41)), created],
    [await change(w, id(41), { ...technician }, id(42), 1, 'accept'), accepted],
    [await change(w, id(41), { ...technician }, id(43), 2, 'close', 'SYNTHETIC record'), closed]]) {
    assert.equal(again.replayed, true);
    assert.deepEqual(again.applied, first.applied);
  }
  assert.deepEqual(w.writes, settled);
  const other = { ...clinician, sub: 'synthetic-other-clinician-sub', actor: 'synthetic-other-clinician' };
  // Thunks: each call starts only when its rejection handler is attached.
  const refusals = [
    [() => create(w, { ...clinician }, id(41), { reason: 'SYNTHETIC other reason' }), 409, 'REQUEST_ID_REUSED'],
    [() => change(w, id(41), { ...technician }, id(42), 1, 'decline', 'SYNTHETIC decline'), 409, 'REQUEST_ID_REUSED'],
    [() => change(w, id(41), { ...technician }, id(43), 2, 'close', 'SYNTHETIC other record'), 409, 'REQUEST_ID_REUSED'],
    [() => change(w, id(44), { ...technician }, id(42), 1, 'accept'), 409, 'REQUEST_ID_REUSED'],
    // Another person's request with an ID already used is that person's new request (EMR-D: the register's key is the
    // record kind, the actor and the request ID); a create names its record by its request ID, so it finds the record
    // already there and is refused as a record that changed, writing nothing.
    [() => create(w, { ...other }, id(41)), 409, 'CLINICAL_RECORD_CHANGED'],
    [() => create(w, { ...clinician }, id(45)), 409, 'IMAGE_REQUEST_ACTIVE_EXISTS'],
    [() => change(w, id(41), { ...technician }, id(46), 3, 'decline', 'SYNTHETIC late'), 409, 'IMAGE_REQUEST_STATE'],
    [() => change(w, id(41), { ...technician }, id(47), 2, 'decline', 'SYNTHETIC late'), 409, 'IMAGE_REQUEST_CHANGED'],
    [() => change(w, id(44), { ...technician }, id(48), 1, 'accept', 'SYNTHETIC not empty'), 400, 'IMAGE_REQUEST_INPUT_INVALID'],
    [() => change(w, id(44), { ...technician }, id(49), 1, 'close', ''), 400, 'IMAGE_REQUEST_INPUT_INVALID'],
    [() => change(w, id(44), { ...clinician }, id(50), 1, 'accept'), 403, 'IMAGE_REQUEST_ROLE_REQUIRED'],
    [() => change(w, id(44), { ...radiologist }, id(51), 1, 'close', 'SYNTHETIC'), 403, 'IMAGE_REQUEST_ROLE_REQUIRED'],
    [() => change(w, id(44), { ...technician }, id(52), 1, 'cancel', 'SYNTHETIC'), 403, 'IMAGE_REQUEST_ROLE_REQUIRED'],
    [() => change(w, id(44), { ...other }, id(53), 1, 'cancel', 'SYNTHETIC'), 404, 'IMAGE_REQUEST_NOT_FOUND'],
    [() => change(w, id(44), { ...technician, roles: ['technician', 'clinician'] }, id(54), 1, 'cancel', 'SYNTHETIC'), 403,
      'IMAGE_REQUEST_ACTION_FORBIDDEN'],
    [() => create(w, { ...technician }, id(55)), 403, 'IMAGE_REQUEST_ROLE_REQUIRED'],
    [() => create(w, { ...clinician }, id(56), { kind: 'external-image', counterpartyInstitutionId: institution }), 400,
      'IMAGE_REQUEST_COUNTERPARTY_INVALID'],
    [() => create(w, { ...clinician }, id(57), { kind: 'external-image', counterpartyInstitutionId: 'synthetic-unknown' }), 400,
      'IMAGE_REQUEST_COUNTERPARTY_INVALID'],
    [() => create(w, { ...clinician }, id(58), { kind: 'external-image', institution: counterparty }), 400, 'IMAGE_REQUEST_INPUT_INVALID'],
    [() => create(w, { ...clinician }, id(59), { kind: 'transfer' }), 400, 'IMAGE_REQUEST_INPUT_INVALID'],
  ];
  for (const [attempt, status, value] of refusals) await assert.rejects(attempt, code(status, value), value);
  assert.deepEqual(w.writes, settled);
  assert.equal(w.clinical.store.units.get(id(41)).revision, versions, 'no refused call adds a version');
  assert.deepEqual([w.store.requests.get(id(41)).state, w.store.requests.get(id(44)).state], ['Closed', 'Requested']);
});

test('receipts and audit rows carry the fixed keys and no text; the action is owner-only in GET audit', async () => {
  assert.equal(IMAGE_REQUEST_AUDIT_ACTION, 'study.image-request');
  assert.ok(OWNER_ONLY_AUDIT_ACTIONS.includes(IMAGE_REQUEST_AUDIT_ACTION));
  assert.ok(OWNER_ONLY_AUDIT_ACTIONS.includes('study.question'), 'S5-U4a keeps its action');
  const w = world(null);
  const created = await create(w, { ...clinician }, id(61), { counterparty: 'SYNTHETIC counterparty text',
    counterpartyInstitutionId: counterparty, reason: 'SYNTHETIC reason text that must stay out of audit' });
  await change(w, id(61), { ...admin }, id(62), 1, 'decline', 'SYNTHETIC note text that must stay out of audit');
  assert.deepEqual(Object.keys(created.applied).sort(), ['action', 'at', 'from', 'id', 'kind', 'requestId', 'revision', 'studyUid', 'to']);
  assert.deepEqual(Object.keys(created).sort(), ['applied', 'owner', 'replayed']);
  assert.equal(w.audits.length, 2);
  for (const row of w.audits) {
    assert.equal(row.action, IMAGE_REQUEST_AUDIT_ACTION);
    assert.equal(row.target, uid);
    const detail = JSON.parse(row.detail);
    assert.deepEqual(Object.keys(detail).sort(),
      ['action', 'counterpartyInstitutionId', 'from', 'id', 'institution', 'kind', 'requestId', 'revision', 'role', 'to']);
    assert.deepEqual([detail.institution, detail.counterpartyInstitutionId], [institution, counterparty]);
    assert.equal(row.detail.includes('SYNTHETIC'), false);
  }
  assert.deepEqual(w.audits.map(row => JSON.parse(row.detail).role), ['clinician', 'admin']);
  const receipt = w.store.receipts.get(id(61));
  assert.deepEqual([receipt.result, receipt.subjectSub, receipt.imageRequestId, receipt.appliedRevision], [created.applied, clinician.sub, id(61), 1]);
  assert.equal(JSON.stringify(receipt.result).includes('SYNTHETIC'), false);
  const row = w.store.requests.get(id(61));
  assert.deepEqual([row.state, row.handlerActor, row.note], ['Declined', admin.actor, 'SYNTHETIC note text that must stay out of audit']);
});

test('a state outside the machine is never a transition', async () => {
  // A row whose state is outside the machine never becomes a transition: neither a legacy row the clinical store holds no
  // version of (no unit to continue: 404), nor a request whose row was altered to such a state (the projection under its
  // row lock finds it is not the fold of its versions: 409). No row, version or ledger event moves.
  const legacy = world(null, { requests: [seeded(70, 'Bogus', 1)] });
  for (const [c, action, note] of [[technician, 'accept', ''], [technician, 'close', 'SYNTHETIC'], [admin, 'decline', 'SYNTHETIC'],
    [clinician, 'cancel', 'SYNTHETIC']])
    await assert.rejects(change(legacy, id(70), { ...c }, id(71), 1, action, note), code(404, 'IMAGE_REQUEST_NOT_FOUND'), action);
  assert.deepEqual(legacy.writes, noWrites);
  assert.equal(legacy.clinical.store.units.size, 0);
  const w = world(null);
  await create(w, { ...clinician }, id(72));
  w.store.requests.get(id(72)).state = 'Bogus';
  w.observe();
  let n = 73;
  for (const [c, action, note] of [[technician, 'accept', ''], [technician, 'close', 'SYNTHETIC'], [admin, 'decline', 'SYNTHETIC'],
    [clinician, 'cancel', 'SYNTHETIC']])
    await assert.rejects(change(w, id(72), { ...c }, id(n++), 1, action, note), code(409, 'IMAGE_REQUEST_CHANGED'), action);
  assert.deepEqual(w.writes, noWrites);
  assert.deepEqual([w.clinical.store.units.get(id(72)).revision, w.clinical.store.events.length, w.store.requests.get(id(72)).state],
    [1, w.settled.events, 'Bogus']);
});

const READ = { isolationLevel: 'RepeatableRead', maxWait: 4000, timeout: 8000 };

test('#8 and #9 read in one RepeatableRead transaction, with no row lock and no read outside it', async () => {
  const w = world(null);
  await create(w, { ...clinician }, id(81));
  // A read is the service's RepeatableRead transaction and, for a body of clinical text, the boundary's final
  // RepeatableRead read before it is handed out; outside them only the access policy is read, and nothing is committed.
  // The service's statements are followed, in the same snapshot, by the boundary's (the access policy, the request row
  // and its study's access); the boundary's final read repeats the latter after the access policy is checked again.
  const boundary = ['tx:advisory', 'tx:policy', 'tx:request-row', 'tx:study', 'tx:advisory', 'tx:policy'];
  for (const [route, attempt, inside, outside] of [
    ['read', () => read(w, id(81), { ...clinician }), ['tx:request', 'tx:study', 'tx:advisory', 'tx:policy', ...boundary],
      ['tx:request-row', 'tx:study', 'tx:advisory', 'tx:policy']],
    ['forStudy', () => forStudy(w, uid, { ...clinician }), ['tx:study', 'tx:advisory', 'tx:policy', 'tx:list', 'tx:advisory', 'tx:policy'], []],
  ]) {
    const from = w.statements.length, at = w.transactions.length;
    await attempt();
    const own = w.statements.slice(from);
    assert.deepEqual(w.transactions.slice(at), [READ, READ], route);
    assert.deepEqual(own, ['root:policy', 'tx:start', 'tx:execute', 'tx:advisory', 'tx:policy', ...inside, 'tx:end',
      'root:policy', 'root:policy', 'tx:start', ...outside, 'tx:end'], route);
    assert.deepEqual(own.filter(s => / FOR (UPDATE|KEY SHARE|SHARE)$/.test(s)), [], route + ': no row lock');
    assert.deepEqual(own.filter(s => s.startsWith('root:') && s !== 'root:policy'), [], route + ': nothing but the access policy is read outside a transaction');
    assert.deepEqual(own.filter(s => s.startsWith('commit:')), [], route + ': a read commits nothing');
  }
  assert.deepEqual(w.writes, { request: 1, update: 0, receipt: 1, audit: 1 });
});

test('an owner change committed between the statements of a request read never reaches its answer', async () => {
  const w = world(null);
  await create(w, { ...clinician }, id(91));
  const reader = w.transactions.length;
  // Read per statement, the row said this institution and the study said another: a 404 for a row that was visible. The
  // read's snapshot is whole, and the boundary's final check, after the move, gives no body to an institution that no
  // longer owns the study.
  w.between({ 'tx:request': async () => { w.store.study.institutionId = 'synthetic-elsewhere'; } });
  const refused = await read(w, id(91), { ...technician }).then(() => null, e => e);
  assert.deepEqual(w.pending(), [], 'the move landed inside the read');
  assert.deepEqual(w.transactions[reader], READ);
  assert.ok(refused && typeof refused.getStatus === 'function' && [403, 404, 409].includes(refused.getStatus()), refused ? refused.message : 'answered');
  assert.equal(JSON.stringify(refused.getResponse()).includes('SYNTHETIC'), false, 'the refusal carries no text');
  // the next read and a write start after the move and see it whole: hidden, never moved
  await assert.rejects(read(w, id(91), { ...technician }), code(404, 'IMAGE_REQUEST_NOT_FOUND'));
  await assert.rejects(change(w, id(91), { ...technician }, id(92), 1, 'accept'), code(404, 'IMAGE_REQUEST_NOT_FOUND'));
  assert.deepEqual(w.writes, { request: 1, update: 0, receipt: 1, audit: 1 });
  assert.equal(w.store.requests.get(id(91)).institutionId, institution);
});

test('the write paths keep the default isolation and lock StudyState before the request row and the counterparty', async () => {
  const w = world(null);
  const locks = rows => rows.filter(s => ['commit:advisory', 'commit:write'].includes(s) || / FOR (UPDATE|KEY SHARE|SHARE)$/.test(s));
  const runs = [];
  for (const [route, attempt] of [
    ['create', () => create(w, { ...clinician }, id(101), { counterpartyInstitutionId: counterparty })],
    ['accept', () => change(w, id(101), { ...technician }, id(102), 1, 'accept')],
    ['close', () => change(w, id(101), { ...technician }, id(103), 2, 'close', 'SYNTHETIC record')],
  ]) {
    const from = w.statements.length, at = w.transactions.length;
    await attempt();
    runs.push([route, w.transactions.slice(at).map(t => (t.commit ? 'commit' : t.isolationLevel ?? 'default')), locks(commitOf(w.statements.slice(from)))]);
  }
  // A write checks visibility in a RepeatableRead read and is admitted under its request lock; its rows are written by
  // the clinical commit at the default isolation, which takes the access policy's shared lock, then StudyState before
  // the request row and the counterparty Institution, then writes.
  const parent = ['commit:advisory', 'commit:study FOR UPDATE', 'commit:advisory'];
  const written = ['commit:write', 'commit:write', 'commit:write'];
  assert.deepEqual(runs, [
    ['create', ['RepeatableRead', 'commit', 'commit'], [...parent, 'commit:institution FOR KEY SHARE', ...written]],
    ['accept', ['RepeatableRead', 'commit', 'commit'], [...parent, 'commit:request FOR UPDATE', ...written]],
    ['close', ['RepeatableRead', 'commit', 'commit'], [...parent, 'commit:request FOR UPDATE', ...written]],
  ]);
  // the receipt is read after the commit that wrote it, so one requestId answers what it applied once
  const last = w.events.slice(w.events.lastIndexOf('commit:start'));
  assert.ok(last.indexOf('root:receipt') > last.indexOf('commit:end'));
});

test('EMR-D boundary: a normal request read answers; a failed B provision, a corrupted projection field and an access change before the answer each give no body', async () => {
  // EMR-D a5 (consult section 3.3): the fixture's own sensitivity - the same read that answers normally gives no body
  // once B cannot make its provision durable, once a legacy field no longer is the fold of its versions, and once the
  // caller's access changes between the read and the answer. No refusal carries the request's text.
  const w = world(null), text = 'SYNTHETIC reason only the read may carry';
  await create(w, { ...clinician }, id(111), { reason: text });
  const { item } = await read(w, id(111), { ...clinician });
  assert.deepEqual([item.id, item.state, item.revision], [id(111), 'Requested', 1]);
  assert.ok(JSON.stringify(item).includes(text), 'the normal answer carries the signed reason');
  // A non-HTTP error reaches the caller as Nest's generic 500 without its message.
  const noBody = async (label, attempt, statuses) => {
    const error = await attempt().then(() => null, e => e);
    assert.ok(error, label + ': answered');
    const http = typeof error.getStatus === 'function', status = http ? error.getStatus() : 500;
    assert.ok(statuses.includes(status), label + ': ' + status + ' ' + error.message);
    assert.equal(JSON.stringify(http ? error.getResponse() : { statusCode: 500, message: 'Internal server error' }).includes(text), false, label + ': the refusal carries no text');
  };
  w.clinical.fault.provide = 1;
  await noBody('B cannot make the provision durable', () => read(w, id(111), { ...clinician }), [503]);
  w.clinical.fault.receipt = 1;
  await noBody('B answers with another event\'s receipt', () => read(w, id(111), { ...clinician }), [500, 503]);
  const row = w.store.requests.get(id(111)), kept = row.counterpartyText;
  row.counterpartyText = 'SYNTHETIC corruption';
  await noBody('a projection field is not the fold of its versions', () => read(w, id(111), { ...clinician }), [409]);
  row.counterpartyText = kept;
  const req = await F.request({ ...clinician }), answer = await w.svc.read(id(111), { ...clinician }, req);
  w.clinical.pin(clinician.sub, { sub: clinician.sub, approved: false, suspended: false, institution, roles: [...clinician.roles] });
  await noBody('the caller\'s rights end before the answer', () => F.answer(CONTROLLERS, 'GET image-requests/:id', answer, req), [403, 404]);
});

test('EMR-D original terminal: an accepted and a declined request replay their own outcome after the request moves on, and a refused create replays its refusal', async () => {
  const w = world(null);
  await create(w, { ...clinician }, id(121));
  const accepted = await change(w, id(121), { ...technician }, id(122), 1, 'accept');
  const declined = await change(w, id(121), { ...admin }, id(123), 2, 'decline', 'SYNTHETIC decline');
  // A second active request of the same kind is refused while id(121) is active ... (refused before the decline: replay below)
  await create(w, { ...clinician }, id(124), { kind: 'external-image' });
  await assert.rejects(create(w, { ...clinician }, id(125), { kind: 'external-image' }), code(409, 'IMAGE_REQUEST_ACTIVE_EXISTS'));
  await change(w, id(124), { ...clinician }, id(126), 1, 'cancel', 'SYNTHETIC cancel');
  const settled = { ...w.writes }, row = { ...w.store.requests.get(id(121)) };
  assert.deepEqual([row.state, row.revision], ['Declined', 3]);
  // The original terminals: the accept answers Requested -> Accepted and the decline Accepted -> Declined, each as applied,
  // without moving the current row; the refused create stays refused after the request that blocked it is cancelled.
  const again = await change(w, id(121), { ...technician }, id(122), 1, 'accept');
  assert.deepEqual([again.replayed, again.applied], [true, accepted.applied]);
  assert.deepEqual([accepted.applied.from, accepted.applied.to, declined.applied.from, declined.applied.to], ['Requested', 'Accepted', 'Accepted', 'Declined']);
  const twice = await change(w, id(121), { ...admin }, id(123), 2, 'decline', 'SYNTHETIC decline');
  assert.deepEqual([twice.replayed, twice.applied], [true, declined.applied]);
  await assert.rejects(create(w, { ...clinician }, id(125), { kind: 'external-image' }), code(409, 'IMAGE_REQUEST_ACTIVE_EXISTS'));
  assert.deepEqual(w.writes, settled);
  assert.deepEqual(w.store.requests.get(id(121)), row);
  assert.equal(w.store.requests.has(id(125)), false);
});
