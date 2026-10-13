'use strict';
/* TEST-S5-U4a-ACCESS: the compiled clinician question service over a stub store and a recording Orthanc.
 * REQ-S5-U4p-STUDY-ACCESS-READ / REQ-S5-U4p-IDEMPOTENCY -> RISK-S5-U4p-ACCESS-READ-CONFLATION / REPLAY-HISTORY
 * (contract S5-U4p section 4.1, 7.1, 11); since EMR-D also REQ-EMR-01/03/07 -> RISK-D-01..04 -> TEST-D-04.
 *
 * The real StudyAccessService (compiled, /app/dist) decides access; only Prisma and Orthanc are stubs, as in
 * study_access_service_test.cjs:61-67. Since EMR-D the service is composed with the clinical runtime the server composes
 * (tests/emr/d/service_fixture.cjs): every write is one version the author's device signs, committed by the runtime with
 * the service's own projection of the rows below in one clinical commit, and every answer is read as the client gets it,
 * through the response boundary. Every stub call is logged in order with the transaction it ran in ('tx' a transaction of
 * the service or of the response boundary, 'commit' the clinical commit), so "the source read ends before a transaction
 * starts" and "no Orthanc call inside a transaction" are read from one event list.
 *   (1) a metadata rule: the source tags are read outside every transaction - the UID route's one study first;
 *   (2) the policy revision moves during the source read: 409 STUDY_ACCESS_CHANGED, nothing registered,
 *       versioned or written;
 *   (3) the source read fails: 503, nothing registered, versioned or written;
 *   (4) the constructor takes PrismaService and StudyAccessService only (no OrthancService, no ConnectService), as Nest's
 *       own metadata resolves it;
 *   (5) a recording Orthanc sees only studyAccessMetadata and studyIdentities(true), and nothing at all when the
 *       policy has no metadata rule.
 * Also pinned over the same stubs: a replay after Closed answers the stored receipt without a write, reuse is
 * 409 REQUEST_ID_REUSED, the audit detail keys, and a state outside the machine never becomes a transition.
 * Astra S5-U4a-F01 (one read, one snapshot): an answer, a close and a report reset committed between the statements
 * of a thread read never reach a client - its RepeatableRead snapshot is whole, and the boundary's final read refuses a
 * body that no longer is; #2 and #3 read in RepeatableRead transactions with no row lock and no row read outside them;
 * the clinical commit keeps the default isolation and the StudyState -> StudyQuestion lock order.
 * Hosted only (kin-api:ci): no /app/dist exists on a development host.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ClinicianQuestionService, QUESTION_AUDIT_ACTION } = require('/app/dist/clinician-question.service');
const { PrismaService } = require('/app/dist/prisma.service');
const { StudyAccessService } = require('/app/dist/study-access.service');
const { OWNER_ONLY_AUDIT_ACTIONS } = require('/app/dist/pacs.service');
const { OrthancService } = require('/app/dist/orthanc.service');
const { ConnectService } = require('/app/dist/connect.service');
const F = require('./emr/d/service_fixture.cjs').compose();
const CONTROLLERS = ['clinician-question.controller'];

const uid = '2.25.4242';
const institution = 'synthetic';
const clinician = { kind: 'member', institution, sub: 'synthetic-clinician-sub', actor: 'synthetic-clinician', roles: ['clinician'], name: 'SYNTHETIC clinician' };
const radiologist = { kind: 'member', institution, sub: 'synthetic-reader-sub', actor: 'synthetic-reader', roles: ['radiologist'], name: 'SYNTHETIC reader' };
const owner = c => [c.institution, c.sub];
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const metadataPolicy = () => ({ version: 1, restricted: true, startsAt: null, endsAt: null,
  rules: [{ patientId: 'SYNTHETIC-PATIENT', modalities: [], dateFrom: null, dateTo: null, studyUids: [] }] });
const uidPolicy = () => ({ version: 1, restricted: true, startsAt: null, endsAt: null,
  rules: [{ patientId: null, modalities: [], dateFrom: null, dateTo: null, studyUids: [uid] }] });
const source = u => ({ '0020000D': { Value: [u] }, '00100020': { Value: ['SYNTHETIC-PATIENT'] } });
const code = (status, value) => e => typeof e?.getStatus === 'function' && e.getStatus() === status
  && (value === undefined || e.getResponse()?.code === value);

/**
 * One synthetic store: StudyState (rs), ReportVersion, StudyAccessPolicy, questions, receipts and audit rows, with an
 * ordered event log. `statements` repeats `events` with the row lock of each SQL statement; `transactions` keeps the
 * options of every service $transaction and `{ commit: true }` for each clinical commit. A RepeatableRead transaction reads
 * a copy of the store - and of the clinical versions - taken when it starts (PostgreSQL fixes the snapshot at its first
 * statement; nothing commits in between here); any other transaction and the root client read the live store per
 * statement, as ReadCommitted does. Writes go to the live store and a failed clinical commit undoes them with its
 * versions. The unique keys the schema has refuse a second row (P2002). `between({event: step})` runs each step once,
 * right after that statement of the NEXT service transaction to start, as a commit landing between two statements of
 * that transaction; statements of other transactions never trigger it.
 */
function world(policy, { questions = [] } = {}) {
  const events = [], statements = [], transactions = [], calls = [], audits = [];
  const writes = { question: 0, update: 0, entry: 0, audit: 0 };
  const store = { questions: new Map(questions.map(q => [q.id, { ...q }])), entries: new Map(), study: { rs: 'W' }, versions: [] };
  const w = { events, statements, transactions, calls, audits, writes, store, policyRow: policy ? { institution, revision: 1, policy, reason: '', updatedBy: null, updatedAt: null } : null };
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
  const kind = sql => sql.includes('pg_advisory') ? 'advisory' : sql.includes('"StudyAccessPolicy"') ? 'policy'
    : sql.includes('FROM "StudyQuestion" q') ? 'list' : sql.includes('FROM "StudyQuestion" WHERE') ? 'question'
      : sql.includes('"ReportVersion"') ? 'anchor' : sql.includes('"StudyState"') ? 'study' : 'unknown';
  const query = async (where, view, index, strings, values) => {
    const sql = strings.join('?'), k = kind(sql);
    log(where + ':' + k, sql.includes('FOR UPDATE') ? ' FOR UPDATE' : sql.includes('FOR SHARE') ? ' FOR SHARE' : '');
    let rows;
    if (k === 'advisory') rows = [{ locked: 1 }];
    else if (k === 'policy') rows = w.policyRow ? [w.policyRow] : [];
    else if (k === 'list') rows = [];
    else if (k === 'question') { const row = view.questions.get(values[0]); rows = row ? [{ ...row }] : []; }
    else if (k === 'anchor') {
      const kept = view.versions.filter(v => v.uid === values[0] && v.action !== 'discarded').map(v => v.version);
      rows = [{ version: kept.length ? Math.max(...kept) : null }];
    } else if (k === 'study') rows = (Array.isArray(values[0]) ? values[0] : [values[0]]).filter(u => u === uid)
      .map(u => ({ uid: u, institutionId: institution, teleInstitutionId: null, rs: view.study.rs }));
    else throw new Error('unexpected SQL in the stub: ' + sql);
    await after(index, where + ':' + k);
    return rows;
  };
  const unique = (map, key) => { if (map.has(key)) throw Object.assign(new Error('SYNTHETIC unique constraint'), { code: 'P2002' }); };
  const client = (view, index, where = 'tx') => ({
    $executeRaw: async () => { log(where + ':execute'); return 0; },
    $queryRaw: (strings, ...values) => query(where, view, index, strings, values),
    studyQuestion: {
      findUnique: async ({ where: key }) => { log(where + ':question-row'); const row = view.questions.get(key.id); return row ? { ...row } : null; },
      create: async ({ data }) => { log(where + ':write'); unique(store.questions, data.id); writes.question++; store.questions.set(data.id, { ...data }); return data; },
      update: async ({ where: key, data }) => {
        log(where + ':write'); writes.update++;
        const row = { ...store.questions.get(key.id), ...data }; store.questions.set(key.id, row); return row;
      },
    },
    studyQuestionEntry: {
      findUnique: async ({ where: key }) => { log(where + ':receipt'); const row = view.entries.get(key.id); return row ? { ...row } : null; },
      findMany: async ({ where: key }) => {
        log(where + ':entries');
        const rows = [...view.entries.values()].filter(e => e.questionId === key.questionId).sort((a, b) => a.seq - b.seq).map(e => ({ ...e }));
        await after(index, where + ':entries');
        return rows;
      },
      create: async ({ data }) => { log(where + ':write'); unique(store.entries, data.id); writes.entry++; store.entries.set(data.id, { ...data }); return data; },
    },
    auditLog: { create: async ({ data }) => { log(where + ':write'); writes.audit++; audits.push(data); return data; } },
  });
  // The clinical half (tests/emr/d/service_fixture.cjs): a failed commit undoes the rows below with its versions.
  w.clinical = F.attach({
    tables: {
      snapshot: () => structuredClone({ questions: [...store.questions], entries: [...store.entries], study: store.study, versions: store.versions, writes, audits }),
      restore: s => {
        store.questions.clear(); for (const [k, v] of s.questions) store.questions.set(k, v);
        store.entries.clear(); for (const [k, v] of s.entries) store.entries.set(k, v);
        Object.assign(store.study, s.study); store.versions.splice(0, store.versions.length, ...s.versions);
        Object.assign(writes, s.writes); audits.splice(0, audits.length, ...s.audits);
      },
    },
    transaction: () => { const index = transactions.push({ commit: true }) - 1; log('commit:start'); return client(store, index, 'commit'); },
    finish: (_tx, how) => log(how === 'commit' ? 'commit:end' : 'commit:rollback'),
    studyOf: u => (u === uid ? { institutionId: institution } : null),
  });
  const root = {
    $queryRaw: (strings, ...values) => query('root', store, null, strings, values),
    $transaction: async (fn, options) => {
      const index = transactions.push(options) - 1;
      if (target === 'next') target = index;
      const repeatable = options?.isolationLevel === 'RepeatableRead';
      const view = repeatable ? structuredClone(store) : store;
      log('tx:start');
      try { return await fn(w.clinical.client(client(view, index), repeatable ? w.clinical.frozen() : null)); }
      finally { log('tx:end'); }
    },
    studyState: { findMany: async () => { log('root:studies'); return [{ uid }]; } },
    studyQuestionEntry: { findUnique: async ({ where }) => { log('root:receipt'); const row = store.entries.get(where.id); return row ? { ...row } : null; } },
  };
  const prisma = w.clinical.client(root);
  w.handlers = { studyAccessMetadata: async u => source(u), studyIdentities: async () => [source(uid)] };
  // Records every member the service stack touches, not only the two it is allowed to use.
  const orthanc = new Proxy({}, { get: (_target, name) => async (...args) => {
    calls.push({ name: String(name), args }); events.push('orthanc:' + String(name));
    const handler = w.handlers[name];
    return handler ? handler(...args) : null;
  } });
  w.access = new StudyAccessService(prisma, orthanc, {});
  w.svc = new ClinicianQuestionService(prisma, w.access);
  w.bumpPolicy = () => { w.policyRow = { ...w.policyRow, revision: w.policyRow.revision + 1 }; };
  return w;
}

/** One call as a client makes it: B2's verified request (the author's device signature for a clinical write) and the
 *  answer the response boundary gives. */
const call = async (route, c, run, write) => {
  const req = await F.request(c, write);
  return F.answer(CONTROLLERS, route, await run(req), req);
};
const create = (w, c, requestId, body = 'SYNTHETIC question') => {
  const b = { requestId, expectedOwner: owner(c), body };
  return call('POST studies/:uid/questions', c, req => w.svc.create(uid, c, b, req), { surface: 'question.create', body: b, recordId: requestId.toLowerCase(), studyId: uid });
};
const reply = (w, questionId, c, requestId, revision, body = 'SYNTHETIC answer') => {
  const b = { requestId, expectedOwner: owner(c), revision, body };
  return call('POST questions/:id/entries', c, req => w.svc.reply(questionId, c, b, req), { surface: 'question.reply', body: b, recordId: questionId.toLowerCase(), studyId: uid });
};
const close = (w, questionId, c, requestId, revision, note = '') => {
  const b = { requestId, expectedOwner: owner(c), revision, note };
  return call('POST questions/:id/close', c, req => w.svc.close(questionId, c, b, req), { surface: 'question.close', body: b, recordId: questionId.toLowerCase(), studyId: uid });
};
const read = (w, questionId, c) => call('GET questions/:id', c, req => w.svc.read(questionId, c, req));
const forStudy = (w, u, c) => call('GET studies/:uid/questions', c, req => w.svc.forStudy(u, c, req));
const list = (w, c, q) => call('GET questions', c, req => w.svc.list(c, q, req));
/** The Orthanc calls made while a transaction (of the service, of the boundary, or the clinical commit) was open. */
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
/** Nothing registered, versioned, signed or appended for a refused call. */
const noClinicalEffects = (w, label) => {
  assert.deepEqual([w.clinical.store.rows.size, w.clinical.store.units.size, w.clinical.store.events.length, w.clinical.provided.length],
    [0, 0, 0, 0], label + ': no request registered, no signed version, no ledger event');
};

test('(1) a metadata rule reads source tags before $transaction and never inside the callback', async () => {
  const w = world(metadataPolicy());
  const created = await create(w, { ...clinician }, id(1));
  assert.equal(created.replayed, false);
  const start = w.events.indexOf('tx:start');
  assert.ok(start > 0);
  assert.equal(w.events.find(e => e.startsWith('orthanc:')), 'orthanc:studyAccessMetadata', 'the UID route prepares its one study first');
  assert.ok(w.events.indexOf('orthanc:studyAccessMetadata') < start, 'the source read ends before the transaction');
  assert.deepEqual(insideTransactions(w), [], 'no Orthanc call inside a service transaction or the clinical commit');
  // The clinical commit locks StudyState before it writes the question's rows; the receipt is read after the commit.
  const commit = commitOf(w.statements);
  assert.ok(commit.includes('commit:study FOR UPDATE') && commit.indexOf('commit:study FOR UPDATE') < commit.indexOf('commit:write'),
    'StudyState is locked before the rows are written');
  assert.ok(w.events.indexOf('root:receipt') > w.events.lastIndexOf('commit:end'), 'the receipt is read after the commit');
  // an id route prepares every study (prepare(c)) before its transactions too
  const before = w.events.length;
  const answered = await reply(w, id(1), { ...radiologist }, id(2), 1);
  const later = w.events.slice(before), second = later.indexOf('tx:start');
  assert.equal(answered.applied.action, 'answer');
  assert.equal(later.find(e => e.startsWith('orthanc:')), 'orthanc:studyIdentities');
  assert.ok(later.indexOf('orthanc:studyIdentities') < second);
  assert.deepEqual(insideTransactions(w), []);
  assert.ok(w.calls.some(call => call.name === 'studyIdentities'));
  for (const call of w.calls.filter(call => call.name === 'studyIdentities')) assert.deepEqual(call.args, [true]);
  assert.deepEqual(w.writes, { question: 1, update: 1, entry: 2, audit: 2 });
});

test('(2) a policy change during the source read is 409 STUDY_ACCESS_CHANGED with no business or clinical effects', async () => {
  for (const route of ['create', 'reply', 'close']) {
    const w = world(metadataPolicy(), { questions: [{ id: id(10), studyUid: uid, institutionId: institution,
      authorSub: clinician.sub, authorActor: clinician.actor, authorName: clinician.name, state: 'Open', revision: 1, entryCount: 1 }] });
    w.handlers.studyAccessMetadata = async u => { w.bumpPolicy(); return source(u); };
    w.handlers.studyIdentities = async () => { w.bumpPolicy(); return [source(uid)]; };
    const attempt = route === 'create' ? create(w, { ...clinician }, id(11))
      : route === 'reply' ? reply(w, id(10), { ...radiologist }, id(11), 1)
        : close(w, id(10), { ...clinician }, id(11), 1);
    await assert.rejects(attempt, code(409, 'STUDY_ACCESS_CHANGED'), route);
    assert.ok(w.calls.some(c => ['studyAccessMetadata', 'studyIdentities'].includes(c.name)), route + ': required source metadata was attempted');
    assert.deepEqual(insideTransactions(w), [], route + ': metadata stays outside transactions');
    assert.deepEqual(w.writes, { question: 0, update: 0, entry: 0, audit: 0 }, route);
    noClinicalEffects(w, route);
  }
});

test('(3) a failed source read is 503 with no business or clinical effects', async () => {
  for (const route of ['create', 'reply']) {
    const w = world(metadataPolicy(), { questions: [{ id: id(20), studyUid: uid, institutionId: institution,
      authorSub: clinician.sub, authorActor: clinician.actor, authorName: clinician.name, state: 'Open', revision: 1, entryCount: 1 }] });
    w.handlers.studyAccessMetadata = async () => { throw new Error('SYNTHETIC transport failure'); };
    w.handlers.studyIdentities = async () => { throw new Error('SYNTHETIC transport failure'); };
    const attempt = route === 'create' ? create(w, { ...clinician }, id(21)) : reply(w, id(20), { ...radiologist }, id(21), 1);
    await assert.rejects(attempt, code(503), route);
    assert.ok(w.calls.some(c => ['studyAccessMetadata', 'studyIdentities'].includes(c.name)), route + ': required source metadata was attempted');
    assert.deepEqual(insideTransactions(w), [], route + ': metadata stays outside transactions');
    assert.deepEqual(w.writes, { question: 0, update: 0, entry: 0, audit: 0 }, route);
    noClinicalEffects(w, route);
  }
});

test('(4) the service is constructed from PrismaService and StudyAccessService only', () => {
  // Resolve Nest's effective injection tokens; display names and constructor arity are not DI contracts.
  const types = [...Reflect.getMetadata('design:paramtypes', ClinicianQuestionService)];
  for (const override of Reflect.getMetadata('self:paramtypes', ClinicianQuestionService) ?? []) types[override.index] = override.param;
  assert.deepEqual(types, [PrismaService, StudyAccessService]);
  assert.equal(types.includes(OrthancService), false);
  assert.equal(types.includes(ConnectService), false);
});

test('(5) only studyAccessMetadata and studyIdentities(true) reach Orthanc, and nothing without a metadata rule', async () => {
  const flows = async w => {
    await create(w, { ...clinician }, id(31));
    await reply(w, id(31), { ...radiologist }, id(32), 1);
    await read(w, id(31), { ...clinician });
    await forStudy(w, uid, { ...radiologist });
    await list(w, { ...radiologist }, { view: 'inbox' });
    await close(w, id(31), { ...clinician }, id(33), 2);
  };
  const metadata = world(metadataPolicy());
  await flows(metadata);
  assert.ok(metadata.calls.length > 0);
  for (const call of metadata.calls) {
    assert.ok(['studyAccessMetadata', 'studyIdentities'].includes(call.name), call.name);
    if (call.name === 'studyIdentities') assert.deepEqual(call.args, [true]);
  }
  assert.deepEqual(insideTransactions(metadata), []);
  for (const policy of [null, uidPolicy()]) {
    const w = world(policy);
    await flows(w);
    assert.deepEqual(w.calls, [], JSON.stringify(policy));
    assert.deepEqual(w.writes, { question: 1, update: 2, entry: 3, audit: 3 });
  }
});

test('replay after Closed answers the stored receipt without a write; reuse and late writes are refused', async () => {
  const w = world(null);
  const created = await create(w, { ...clinician }, id(41));
  const answered = await reply(w, id(41), { ...radiologist }, id(42), 1);
  const closed = await close(w, id(41), { ...clinician }, id(43), 2);
  assert.deepEqual([created.applied.revision, answered.applied.revision, closed.applied.revision], [1, 2, 3]);
  assert.deepEqual([answered.applied.from, answered.applied.to, closed.applied.from, closed.applied.to], ['Open', 'Answered', 'Answered', 'Closed']);
  const settled = { ...w.writes }, versions = w.clinical.store.units.get(id(41)).revision;
  for (const [again, first] of [[await create(w, { ...clinician }, id(41)), created],
    [await reply(w, id(41), { ...radiologist }, id(42), 1), answered], [await close(w, id(41), { ...clinician }, id(43), 2), closed]]) {
    assert.equal(again.replayed, true);
    assert.deepEqual(again.applied, first.applied);
  }
  assert.deepEqual(w.writes, settled);
  // Thunks: each call starts only when its rejection handler is attached.
  const refusals = [
    [() => reply(w, id(41), { ...radiologist }, id(42), 1, 'SYNTHETIC other answer'), 409, 'REQUEST_ID_REUSED'],
    [() => close(w, id(41), { ...radiologist }, id(42), 1, 'SYNTHETIC note'), 409, 'REQUEST_ID_REUSED'],
    // Another person's request with an ID already used is that person's new request (EMR-D: the register's key is the
    // record kind, the actor and the request ID); it is refused as what it is and writes nothing.
    [() => close(w, id(41), { ...radiologist, sub: 'synthetic-reader-2', actor: 'synthetic-reader-2' }, id(43), 2), 400, 'QUESTION_INPUT_INVALID'],
    [() => close(w, id(41), { ...radiologist, sub: 'synthetic-reader-3', actor: 'synthetic-reader-3' }, id(43), 3, 'SYNTHETIC note'), 409, 'QUESTION_CLOSED'],
    // ...and that person's own request ID, once used, is refused for another meaning.
    [() => close(w, id(41), { ...radiologist, sub: 'synthetic-reader-2', actor: 'synthetic-reader-2' }, id(43), 3, 'SYNTHETIC note'), 409, 'REQUEST_ID_REUSED'],
    [() => reply(w, id(41), { ...radiologist }, id(44), 3), 409, 'QUESTION_CLOSED'],
    [() => reply(w, id(41), { ...radiologist }, id(45), 2), 409, 'QUESTION_CHANGED'],
    [() => reply(w, id(41), { ...clinician, sub: 'synthetic-other-clinician' }, id(46), 3), 404, 'QUESTION_NOT_FOUND'],
    [() => reply(w, id(41), { ...radiologist, roles: ['admin'] }, id(47), 3), 403, 'QUESTION_ROLE_REQUIRED'],
    [() => create(w, { ...clinician, roles: ['technician'] }, id(48)), 403, 'QUESTION_ROLE_REQUIRED'],
  ];
  for (const [attempt, status, value] of refusals) await assert.rejects(attempt, code(status, value), value);
  assert.deepEqual(w.writes, settled);
  assert.equal(w.clinical.store.units.get(id(41)).revision, versions, 'no refused call adds a version');
});

test('receipts and audit rows carry the fixed keys and no text; the action is owner-only in GET audit', async () => {
  assert.equal(QUESTION_AUDIT_ACTION, 'study.question');
  assert.ok(OWNER_ONLY_AUDIT_ACTIONS.includes(QUESTION_AUDIT_ACTION));
  const w = world(null);
  const body = 'SYNTHETIC body text that must stay out of audit';
  const created = await create(w, { ...clinician }, id(51), body);
  await close(w, id(51), { ...radiologist }, id(52), 1, 'SYNTHETIC note text that must stay out of audit');
  assert.deepEqual(Object.keys(created.applied).sort(), ['action', 'at', 'entry', 'from', 'id', 'requestId', 'revision', 'studyUid', 'to']);
  assert.deepEqual(Object.keys(created).sort(), ['applied', 'owner', 'replayed']);
  assert.equal(w.audits.length, 2);
  for (const row of w.audits) {
    assert.equal(row.action, QUESTION_AUDIT_ACTION);
    assert.equal(row.target, uid);
    const detail = JSON.parse(row.detail);
    assert.deepEqual(Object.keys(detail).sort(), ['entry', 'from', 'id', 'institution', 'kind', 'requestId', 'revision', 'role', 'to']);
    assert.equal(detail.institution, institution);
    assert.equal(row.detail.includes('SYNTHETIC'), false);
  }
  assert.deepEqual(w.audits.map(row => JSON.parse(row.detail).role), ['clinician', 'radiologist']);
  const receipt = w.store.entries.get(id(51));
  assert.deepEqual(receipt.result, created.applied);
  assert.equal(JSON.stringify(receipt.result).includes('SYNTHETIC'), false);
});

test('a state outside the machine is never a transition', async () => {
  // A row whose state is outside the machine never becomes a transition: neither a legacy row the clinical store holds no
  // version of (no unit to continue: 404), nor a question whose row was altered to such a state (the projection under its
  // row lock finds it is not the fold of its versions: 409). No row, version or ledger event moves.
  const legacy = world(null, { questions: [{ id: id(60), studyUid: uid, institutionId: institution, authorSub: clinician.sub,
    authorActor: clinician.actor, authorName: clinician.name, state: 'Bogus', revision: 1, entryCount: 1 }] });
  await assert.rejects(reply(legacy, id(60), { ...radiologist }, id(61), 1), code(404, 'QUESTION_NOT_FOUND'));
  await assert.rejects(close(legacy, id(60), { ...radiologist }, id(62), 1, 'SYNTHETIC note'), code(404, 'QUESTION_NOT_FOUND'));
  assert.deepEqual(legacy.writes, { question: 0, update: 0, entry: 0, audit: 0 });
  assert.equal(legacy.clinical.store.units.size, 0);
  const w = world(null);
  await create(w, { ...clinician }, id(63));
  w.store.questions.get(id(63)).state = 'Bogus';
  const settled = { ...w.writes }, events = w.clinical.store.events.length;
  await assert.rejects(reply(w, id(63), { ...radiologist }, id(64), 1), code(409, 'QUESTION_CHANGED'));
  await assert.rejects(close(w, id(63), { ...radiologist }, id(65), 1, 'SYNTHETIC note'), code(409, 'QUESTION_CHANGED'));
  assert.deepEqual(w.writes, settled);
  assert.deepEqual([w.clinical.store.units.get(id(63)).revision, w.clinical.store.events.length, w.store.questions.get(id(63)).state], [1, events, 'Bogus']);
});

/** One thread answer describes one moment: revision = entryCount = entries 1..n, closed and a close entry exactly when Closed. */
function whole(item, label) {
  assert.equal(item.revision, item.entryCount, label);
  assert.deepEqual(item.entries.map(e => e.seq), Array.from({ length: item.entryCount }, (_, i) => i + 1), label);
  assert.equal(item.closed !== null, item.state === 'Closed', label);
  assert.equal(item.entries.some(e => e.kind === 'close'), item.state === 'Closed', label);
}

test('F01: commits between the statements of a thread read never reach its answer', async () => {
  const w = world(null);
  await create(w, { ...clinician }, id(81));
  w.store.study.rs = 'A';
  w.store.versions.push({ uid, version: 1, action: 'approve' });
  const reader = w.transactions.length;
  // An answer and a close commit right after the read's question row, a report reset (A -> W: discarded v2, reset v3)
  // right after its StudyState row. Read per statement, the answer would be revision 1 / Open with three entries and
  // current {rs: 'A', version: 3}, a combination that never existed. The read's snapshot is whole (revision 1, its one
  // entry), and the boundary's final read, after the commits, refuses to hand out a thread that no longer is.
  w.between({
    'tx:question': async () => {
      await reply(w, id(81), { ...radiologist }, id(82), 1);
      await close(w, id(81), { ...radiologist }, id(83), 2, 'SYNTHETIC close while a read runs');
    },
    'tx:study': async () => {
      w.store.study.rs = 'W';
      w.store.versions.push({ uid, version: 2, action: 'discarded' }, { uid, version: 3, action: 'reset' });
    },
  });
  await assert.rejects(read(w, id(81), { ...clinician }), code(409, 'CLINICAL_RECORD_CHANGED'), 'no body of a moment that no longer is');
  assert.deepEqual(w.pending(), [], 'both commits landed inside the read');
  assert.equal(w.transactions[reader]?.isolationLevel, 'RepeatableRead');
  // the next read is a new snapshot and sees every commit whole
  const later = (await read(w, id(81), { ...clinician })).item;
  whole(later, 'after');
  assert.deepEqual([later.state, later.revision, later.entries.map(e => e.kind), later.closed.by.role],
    ['Closed', 3, ['question', 'answer', 'close'], 'radiologist']);
  assert.deepEqual(later.current, { rs: 'W', version: 3 });
  assert.deepEqual(w.writes, { question: 1, update: 2, entry: 3, audit: 3 });
  // Without commits in between, the same read hands out the whole thread of its moment.
  const stable = world(null);
  await create(stable, { ...clinician }, id(84));
  const { item } = await read(stable, id(84), { ...clinician });
  whole(item, 'stable');
  assert.deepEqual([item.state, item.revision, item.entryCount, item.entries.map(e => e.kind), item.closed], ['Open', 1, 1, ['question'], null]);
});

test('F01: #2 and #3 read in one RepeatableRead transaction, with no row lock and no read outside it', async () => {
  const w = world(null);
  await create(w, { ...clinician }, id(91));
  // A read is the service's RepeatableRead transaction and, for a body of clinical text, the boundary's final
  // RepeatableRead read before it is handed out; outside them only the access policy is read, and nothing is committed.
  for (const [route, attempt] of [['read', () => read(w, id(91), { ...clinician })], ['forStudy', () => forStudy(w, uid, { ...clinician })]]) {
    const from = w.statements.length, at = w.transactions.length;
    await attempt();
    assert.ok(w.transactions.length > at, route + ': snapshot reads occurred');
    assert.ok(w.transactions.slice(at).every(t => t?.isolationLevel === 'RepeatableRead'), route + ': every read uses a stable snapshot');
    const own = w.statements.slice(from);
    assert.deepEqual(own.filter(s => / FOR (UPDATE|SHARE)$/.test(s)), [], route + ': no row lock');
    assert.deepEqual(own.filter(s => s.startsWith('root:') && s !== 'root:policy'), [], route + ': nothing but the access policy is read outside a transaction');
    assert.deepEqual(own.filter(s => s.startsWith('commit:')), [], route + ': a read commits nothing');
    assert.ok(own.includes('tx:question') || own.includes('tx:list'), route);
  }
  assert.deepEqual(w.writes, { question: 1, update: 0, entry: 1, audit: 1 });
});

test('EMR-D boundary: a normal thread read answers; a failed B provision, a corrupted projection field and an access change before the answer each give no body', async () => {
  // EMR-D a5 (consult section 3.3): the fixture's own sensitivity - the same read that answers normally gives no body
  // once B cannot make its provision durable, once a legacy field no longer is the fold of its versions, and once the
  // caller's access changes between the read and the answer. No refusal carries the thread's text.
  const w = world(null), text = 'SYNTHETIC question text';
  await create(w, { ...clinician }, id(111), text);
  const { item } = await read(w, id(111), { ...clinician });
  assert.deepEqual([item.state, item.revision, item.entries.map(e => e.body)], ['Open', 1, [text]]);
  // A non-HTTP error reaches the caller as Nest's generic 500 without its message.
  const noBody = async (label, attempt, statuses) => {
    const before = structuredClone(w.writes), responses = w.clinical.responses.length;
    const error = await attempt().then(() => null, e => e);
    if (error instanceof assert.AssertionError) throw error;
    assert.deepEqual(w.writes, before, label + ': no business writes');
    for (const response of w.clinical.responses.slice(responses)) {
      assert.deepEqual(response.writes, [], label + ': no raw response writes');
      assert.equal(response.bodies, 0, label + ': no body emitted');
    }
    assert.ok(error, label + ': answered');
    const http = typeof error.getStatus === 'function', status = http ? error.getStatus() : 500;
    assert.ok(statuses.includes(status), label + ': ' + status + ' ' + error.message);
    assert.equal(JSON.stringify(http ? error.getResponse() : { statusCode: 500, message: 'Internal server error' }).includes(text), false, label + ': the refusal carries no text');
  };
  w.clinical.fault.provide = 1;
  await noBody('B cannot make the provision durable', () => read(w, id(111), { ...clinician }), [503]);
  w.clinical.fault.receipt = 1;
  await noBody('B answers with another event\'s receipt', () => read(w, id(111), { ...clinician }), [500, 503]);
  const row = w.store.questions.get(id(111)), name = row.authorName;
  row.authorName = 'SYNTHETIC corruption';
  await noBody('a projection field is not the fold of its versions', () => read(w, id(111), { ...clinician }), [409]);
  row.authorName = name;
  const req = await F.request({ ...clinician }), answer = await w.svc.read(id(111), { ...clinician }, req);
  w.clinical.pin(clinician.sub, { sub: clinician.sub, approved: false, suspended: false, institution, roles: [...clinician.roles] });
  await noBody('the caller\'s rights end before the answer', () => F.answer(CONTROLLERS, 'GET questions/:id', answer, req), [403, 404]);
});

test('F01: the write paths keep the default isolation and lock StudyState before StudyQuestion', async () => {
  const w = world(null);
  for (const [route, attempt] of [
    ['create', () => create(w, { ...clinician }, id(101))],
    ['reply', () => reply(w, id(101), { ...radiologist }, id(102), 1)],
    ['close', () => close(w, id(101), { ...clinician }, id(103), 2)],
  ]) {
    const from = w.statements.length, at = w.transactions.length;
    await attempt();
    const transactions = w.transactions.slice(at), commit = commitOf(w.statements.slice(from));
    assert.ok(transactions.some(t => t.commit), route + ': clinical transaction owns the writes');
    assert.ok(transactions.filter(t => !t.commit).every(t => t?.isolationLevel === 'RepeatableRead'), route + ': stable authorization snapshot');
    const parent = commit.indexOf('commit:study FOR UPDATE'), written = commit.indexOf('commit:write');
    assert.ok(parent >= 0 && written > parent, route + ': lock StudyState before business writes');
    assert.ok(commit.includes('commit:advisory'), route + ': policy lock protects the commit');
    const childLock = (route === 'create' ? null : 'commit:question FOR UPDATE');
    if (childLock) assert.ok(commit.indexOf(childLock) > parent && commit.indexOf(childLock) < written,
      route + ': lock the dependent row after StudyState and before writes');
  }
});
