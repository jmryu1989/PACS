'use strict';
/* TEST-S5-U4a-ACCESS: the compiled clinician question service over a stub store and a recording Orthanc.
 * REQ-S5-U4p-STUDY-ACCESS-READ / REQ-S5-U4p-IDEMPOTENCY -> RISK-S5-U4p-ACCESS-READ-CONFLATION / REPLAY-HISTORY
 * (contract S5-U4p section 4.1, 7.1, 11).
 *
 * The real StudyAccessService (compiled, /app/dist) decides access; only Prisma and Orthanc are stubs, as in
 * study_access_service_test.cjs:61-67. Every stub call is logged in order, so "the source read ends before the
 * transaction starts" and "no Orthanc call inside the transaction callback" are read from one event list.
 *   (1) a metadata rule: the source tags are read before $transaction, and the callback makes no Orthanc call;
 *   (2) the policy revision moves during the source read: 409 STUDY_ACCESS_CHANGED, no transaction, no write;
 *   (3) the source read fails: 503, no transaction, no write;
 *   (4) the constructor takes PrismaService and StudyAccessService only (no OrthancService, no ConnectService);
 *   (5) a recording Orthanc sees only studyIdentityResources (every resource of the one study; WORKLIST-SPLIT-UID) and
 *       studyIdentities(true), and nothing at all when the
 *       policy has no metadata rule.
 * Also pinned over the same stubs: a replay after Closed answers the stored receipt without a write, reuse is
 * 409 REQUEST_ID_REUSED, the audit detail keys, and QUESTION_STATE for a state outside the machine.
 * Astra S5-U4a-F01 (one read, one snapshot): an answer, a close and a report reset committed between the statements
 * of a thread read never reach its answer; #2 and #3 run in one RepeatableRead transaction with no row lock and no
 * read outside it; the write paths keep the default isolation and the StudyState -> StudyQuestion lock order.
 * Hosted only (kin-api:ci): no /app/dist exists on a development host.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { ClinicianQuestionService, QUESTION_AUDIT_ACTION } = require('/app/dist/clinician-question.service');
const { StudyAccessService } = require('/app/dist/study-access.service');
const { OWNER_ONLY_AUDIT_ACTIONS } = require('/app/dist/pacs.service');
const { OrthancService } = require('/app/dist/orthanc.service');
const { ConnectService } = require('/app/dist/connect.service');

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
 * ordered event log; `transactions` keeps the options of every $transaction. `model` holds the lock and transaction
 * state as PostgreSQL would: each transaction's held row locks as a set (FOR UPDATE/SHARE on StudyState and
 * StudyQuestion; taking a row the transaction already holds changes nothing) and whether its lock bound (SET LOCAL
 * lock_timeout) is set. `locks` lists each lock request and `held` each transaction's set when it ends; every lock
 * request, report-head read, write and root-client read records the state it ran in. Assertions read that state, not
 * statement order or how many times a held row was asked for again; the real order on PostgreSQL is
 * witnessed by tests/emr/d/question_boundaries_pg_test.cjs. A RepeatableRead transaction reads a copy of the store taken when it starts
 * (PostgreSQL fixes the snapshot at its first statement; nothing commits in between here); any other transaction and
 * the root client read the live store per statement, as ReadCommitted does. Writes always go to the live store.
 * `between({event: step})` runs each step once, right after that statement of the NEXT transaction to start, as a
 * commit landing between two statements of that transaction; statements of other transactions never trigger it.
 */
function world(policy, { questions = [] } = {}) {
  const events = [], transactions = [], calls = [], audits = [];
  const writes = { question: 0, update: 0, entry: 0, audit: 0 };
  const store = { questions: new Map(questions.map(q => [q.id, { ...q }])), entries: new Map(), study: { rs: 'W' }, versions: [], report: null };
  const model = { locks: [], held: [], heads: [], writes: [], reads: [], root: [] };
  const w = { events, transactions, calls, audits, writes, store, model, policyRow: policy ? { institution, revision: 1, policy, reason: '', updatedBy: null, updatedAt: null } : null };
  w.mark = () => Object.fromEntries(Object.entries(model).map(([name, rows]) => [name, rows.length]));
  w.since = mark => Object.fromEntries(Object.entries(model).map(([name, rows]) => [name, rows.slice(mark[name])]));
  let target = null, steps = new Map(), open = 0;
  w.between = next => { steps = new Map(Object.entries(next)); target = 'next'; };
  w.pending = () => [...steps.keys()];
  const log = event => { events.push(event); };
  const after = async (index, event) => {
    if (index === null || index !== target || !steps.has(event)) return;
    const step = steps.get(event);
    steps.delete(event);
    await step();
  };
  // A commit writes its version rows and moves the Report head to its last kept version, as commitReport does in one transaction.
  w.publish = (...versions) => {
    store.versions.push(...versions.map(v => ({ uid, ...v })));
    const kept = versions.filter(v => v.action !== 'discarded');
    if (kept.length) store.report = { uid, version: kept[kept.length - 1].version };
  };
  const kind = sql => sql.includes('pg_advisory') ? 'advisory' : sql.includes('"StudyAccessPolicy"') ? 'policy'
    : sql.includes('FROM "StudyQuestion" q') ? 'list' : sql.includes('FROM "StudyQuestion" WHERE') ? 'question'
      : sql.includes('JOIN "Report"') ? 'head' : sql.includes('"ReportVersion"') ? 'anchor' : sql.includes('"StudyState"') ? 'study' : 'unknown';
  const query = async (where, view, index, strings, values, state = null) => {
    const sql = strings.join('?'), k = kind(sql);
    log(where + ':' + k);
    if (state) {
      const row = /FOR (UPDATE|SHARE)/.test(sql) && (k === 'study' || k === 'question');
      if (row || k === 'advisory') {
        const key = row ? k + ':' + values[0] : 'advisory';
        model.locks.push({ tx: state.index, kind: row ? 'row' : 'advisory', key, bound: state.bound, held: [...state.held] });
        if (row) state.held.add(key);
      }
      if (k === 'head') model.heads.push({ tx: state.index, held: [...state.held] });
      model.reads.push({ tx: state.index, table: k, held: [...state.held] });
    } else model.root.push({ table: k, started: transactions.length, open });
    let rows;
    if (k === 'advisory') rows = [{ locked: 1 }];
    else if (k === 'policy') rows = w.policyRow ? [w.policyRow] : [];
    else if (k === 'list') rows = [];
    else if (k === 'question') { const row = view.questions.get(values[0]); rows = row ? [{ ...row }] : []; }
    else if (k === 'anchor') {
      const kept = view.versions.filter(v => v.uid === values[0] && v.action !== 'discarded').map(v => v.version);
      rows = [{ version: kept.length ? Math.max(...kept) : null }];
    } else if (k === 'head') {
      // The Report row, the version row it names, and the highest kept version, as three independent facts of the store.
      const versions = view.versions.filter(v => v.uid === values[0]);
      const kept = versions.filter(v => v.action !== 'discarded').map(v => v.version);
      const head = view.report && view.report.uid === values[0] ? view.report.version : null;
      rows = [{ head, headAction: head === null ? null : versions.find(v => v.version === head)?.action ?? null,
        kept: kept.length ? Math.max(...kept) : null }];
    } else if (k === 'study') rows = values[0] === uid ? [{ uid, institutionId: institution, rs: view.study.rs }] : [];
    else throw new Error('unexpected SQL in the stub: ' + sql);
    await after(index, where + ':' + k);
    return rows;
  };
  const client = (view, index, state) => {
    const write = table => { log('tx:write'); model.writes.push({ tx: index, table, held: [...state.held] }); };
    return {
      studyGroupMember:{findMany:async()=>[]},
      studyState:{findUnique:async({where})=>where.uid===uid?{uid,institutionId:institution,...view.study}:null},
      reportVersion:{findUnique:async({where})=>view.versions.find(v=>v.uid===where.uid_version.uid&&v.version===where.uid_version.version)??null},
      $executeRaw: async strings => { log('tx:execute'); if (strings.join('?').includes('lock_timeout')) state.bound = true; return 0; },
      $queryRaw: (strings, ...values) => query('tx', view, index, strings, values, state),
      studyQuestion: { findUnique:async({where})=>view.questions.get(where.id)??null,
        create: async ({ data }) => { write('question'); writes.question++; store.questions.set(data.id, { ...data }); return data; },
        update: async ({ where, data }) => {
          write('question'); writes.update++;
          const row = { ...store.questions.get(where.id), ...data }; store.questions.set(where.id, row); return row;
        },
      },
      studyQuestionEntry: {
        findUnique: async ({ where }) => {
          log('tx:receipt'); model.reads.push({ tx: index, table: 'receipt', held: [...state.held] });
          const row = view.entries.get(where.id); return row ? { ...row } : null;
        },
        findMany: async ({ where }) => {
          log('tx:entries'); model.reads.push({ tx: index, table: 'entries', held: [...state.held] });
          const rows = [...view.entries.values()].filter(e => e.questionId === where.questionId).sort((a, b) => a.seq - b.seq).map(e => ({ ...e }));
          await after(index, 'tx:entries');
          return rows;
        },
        create: async ({ data }) => { write('entry'); writes.entry++; store.entries.set(data.id, { ...data }); return data; },
      },
      auditLog: { create: async ({ data }) => { write('audit'); writes.audit++; audits.push(data); return data; } },
    };
  };
  const prisma = {
    studyGroupMember:{findMany:async()=>[]},
    studyQuestion:{findUnique:async({where})=>store.questions.get(where.id)??null},
    $queryRaw: (strings, ...values) => query('root', store, null, strings, values),
    $transaction: async (fn, options) => {
      const index = transactions.push(options) - 1;
      if (target === 'next') target = index;
      const view = options?.isolationLevel === 'RepeatableRead' ? structuredClone(store) : store;
      log('tx:start'); open++;
      // Row locks end with the transaction, as at COMMIT or rollback.
      const state = { index, bound: false, held: new Set() };
      try { return await fn(client(view, index, state)); }
      finally { model.held.push({ tx: index, rows: [...state.held] }); open--; log('tx:end'); }
    },
    studyState: { findUnique:async({where})=>where.uid===uid?{uid,institutionId:institution,...store.study}:null, findMany: async () => { log('root:studies'); return [{ uid }]; } },
  };
  w.handlers = { studyIdentityResources: async u => [source(u)], studyIdentities: async () => [source(uid)] };
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

const create = (w, c, requestId, body = 'SYNTHETIC question') => w.svc.create(uid, c, { requestId, expectedOwner: owner(c), body });
const reply = (w, questionId, c, requestId, revision, body = 'SYNTHETIC answer') =>
  w.svc.reply(questionId, c, { requestId, expectedOwner: owner(c), revision, body });
const close = (w, questionId, c, requestId, revision, note = '') => w.svc.close(questionId, c, { requestId, expectedOwner: owner(c), revision, note });
const orthancAfterStart = w => w.events.slice(w.events.indexOf('tx:start')).filter(e => e.startsWith('orthanc:'));

test('(1) a metadata rule reads source tags before $transaction and never inside the callback', async () => {
  const w = world(metadataPolicy());
  const created = await create(w, { ...clinician }, id(1));
  assert.equal(created.replayed, false);
  const start = w.events.indexOf('tx:start');
  assert.ok(start > 0);
  const reads = w.events.map((event, index) => [event, index]).filter(([event]) => event.startsWith('orthanc:'));
  assert.ok(reads.length>0&&reads.every(([event])=>event==='orthanc:studyIdentityResources'), 'the UID route observes only original identity');
  assert.ok(reads.every(([, index]) => index < start), 'the source read ends before the transaction');
  assert.deepEqual(orthancAfterStart(w), []);
  const receipts = w.model.reads.filter(r => r.table === 'receipt');
  assert.ok(receipts.length > 0 && receipts.every(r => r.held.includes('study:' + uid)), 'the receipt lookup runs while StudyState is locked');
  // an id route prepares every study (prepare(c)) before its transaction too
  const before = w.events.length;
  const answered = await reply(w, id(1), { ...radiologist }, id(2), 1);
  const later = w.events.slice(before), second = later.indexOf('tx:start');
  assert.equal(answered.applied.action, 'answer');
  assert.ok(later.filter(e=>e.startsWith('orthanc:')).every(e=>['orthanc:studyIdentities','orthanc:studyIdentityResources'].includes(e)));
  assert.ok(later.indexOf('orthanc:studyIdentities') < second);
  assert.deepEqual(later.slice(second).filter(e => e.startsWith('orthanc:')), []);
  // the batch read asks for the access tags and not the accession (an optional deadline signal is not part of the request)
  const identity = w.calls.find(call => call.name === 'studyIdentities').args;
  assert.deepEqual([!!identity[0], !!identity[1]], [true, false]);
  assert.deepEqual(w.writes, { question: 1, update: 1, entry: 2, audit: 2 });
});

test('(2) a policy change during the source read is 409 STUDY_ACCESS_CHANGED with no transaction and no write', async () => {
  for (const route of ['create', 'reply', 'close']) {
    const w = world(metadataPolicy(), { questions: [{ id: id(10), studyUid: uid, institutionId: institution,
      authorSub: clinician.sub, authorActor: clinician.actor, authorName: clinician.name, state: 'Open', revision: 1, entryCount: 1 }] });
    w.handlers.studyIdentityResources = async u => { w.bumpPolicy(); return [source(u)]; };
    w.handlers.studyIdentities = async () => { w.bumpPolicy(); return [source(uid)]; };
    const call = route === 'create' ? create(w, { ...clinician }, id(11))
      : route === 'reply' ? reply(w, id(10), { ...radiologist }, id(11), 1)
        : close(w, id(10), { ...clinician }, id(11), 1);
    await assert.rejects(call, code(409, 'STUDY_ACCESS_CHANGED'), route);
    assert.equal(w.events.includes('tx:start'), false, route);
    assert.deepEqual(w.writes, { question: 0, update: 0, entry: 0, audit: 0 }, route);
  }
});

test('(3) a failed source read is 503 with no transaction and no write', async () => {
  for (const route of ['create', 'reply']) {
    const w = world(metadataPolicy(), { questions: [{ id: id(20), studyUid: uid, institutionId: institution,
      authorSub: clinician.sub, authorActor: clinician.actor, authorName: clinician.name, state: 'Open', revision: 1, entryCount: 1 }] });
    w.handlers.studyIdentityResources = async () => { throw new Error('SYNTHETIC transport failure'); };
    w.handlers.studyIdentities = async () => { throw new Error('SYNTHETIC transport failure'); };
    const call = route === 'create' ? create(w, { ...clinician }, id(21)) : reply(w, id(20), { ...radiologist }, id(21), 1);
    await assert.rejects(call, code(503), route);
    assert.equal(w.events.includes('tx:start'), false, route);
    assert.deepEqual(w.writes, { question: 0, update: 0, entry: 0, audit: 0 }, route);
  }
});

test('(4) the service is constructed from PrismaService and StudyAccessService only', () => {
  const types = Reflect.getMetadata('design:paramtypes', ClinicianQuestionService);
  assert.deepEqual(types.map(type => type.name), ['PrismaService', 'StudyAccessService']);
  assert.equal(types.includes(OrthancService), false);
  assert.equal(types.includes(ConnectService), false);
  const compiled = readFileSync('/app/dist/clinician-question.service.js', 'utf8');
  for (const name of ['OrthancService', 'ConnectService', './orthanc.service', './connect.service'])
    assert.equal(compiled.includes(name), false, name);
});

test('(5) only studyIdentityResources and studyIdentities(true) reach Orthanc, with original identity checked independently of metadata rules', async () => {
  const flows = async w => {
    await create(w, { ...clinician }, id(31));
    await reply(w, id(31), { ...radiologist }, id(32), 1);
    await w.svc.read(id(31), { ...clinician });
    await w.svc.forStudy(uid, { ...radiologist });
    await w.svc.list({ ...radiologist }, { view: 'inbox' });
    await close(w, id(31), { ...clinician }, id(33), 2);
  };
  const metadata = world(metadataPolicy());
  await flows(metadata);
  assert.ok(metadata.calls.length > 0);
  for (const call of metadata.calls) {
    assert.ok(['studyIdentityResources', 'studyIdentities'].includes(call.name), call.name);
    if (call.name === 'studyIdentities') assert.deepEqual([!!call.args[0], !!call.args[1]], [true, false]);
  }
  for (const policy of [null, uidPolicy()]) {
    const w = world(policy);
    await flows(w);
    assert.ok(w.calls.length>0&&w.calls.every(call=>call.name==='studyIdentityResources'), 'current exam identity is observed even under a UID-only policy');
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
  const settled = { ...w.writes };
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
    [() => close(w, id(41), { ...radiologist, sub: 'synthetic-reader-2', actor: 'synthetic-reader-2' }, id(43), 2), 409, 'REQUEST_ID_REUSED'],
    [() => reply(w, id(41), { ...radiologist }, id(44), 3), 409, 'QUESTION_CLOSED'],
    [() => reply(w, id(41), { ...radiologist }, id(45), 2), 409, 'QUESTION_CHANGED'],
    [() => reply(w, id(41), { ...clinician, sub: 'synthetic-other-clinician' }, id(46), 3), 404, 'QUESTION_NOT_FOUND'],
    [() => reply(w, id(41), { ...radiologist, roles: ['admin'] }, id(47), 3), 403, 'QUESTION_ROLE_REQUIRED'],
    [() => create(w, { ...clinician, roles: ['technician'] }, id(48)), 403, 'QUESTION_ROLE_REQUIRED'],
  ];
  for (const [call, status, value] of refusals) await assert.rejects(call, code(status, value), value);
  assert.deepEqual(w.writes, settled);
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

test('a state outside the machine is 409 QUESTION_STATE, never a transition', async () => {
  const w = world(null, { questions: [{ id: id(60), studyUid: uid, institutionId: institution, authorSub: clinician.sub,
    authorActor: clinician.actor, authorName: clinician.name, state: 'Bogus', revision: 1, entryCount: 1 }] });
  await assert.rejects(reply(w, id(60), { ...radiologist }, id(61), 1), code(409, 'QUESTION_STATE'));
  await assert.rejects(close(w, id(60), { ...radiologist }, id(62), 1, 'SYNTHETIC note'), code(409, 'QUESTION_STATE'));
  assert.deepEqual(w.writes, { question: 0, update: 0, entry: 0, audit: 0 });
});

const READ = { isolationLevel: 'RepeatableRead', maxWait: 4000, timeout: 8000 };
const WRITE = { maxWait: 4000, timeout: 8000 };

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
  w.publish({ version: 1, action: 'approve' });
  const reader = w.transactions.length;
  // An answer and a close commit right after the read's question row, a report reset (A -> W: discarded v2, reset v3)
  // right after its StudyState row. Read per statement, the answer was revision 1 / Open with three entries and
  // current {rs: 'A', version: 3}, a combination that never existed.
  w.between({
    'tx:question': async () => {
      await reply(w, id(81), { ...radiologist }, id(82), 1);
      await close(w, id(81), { ...radiologist }, id(83), 2, 'SYNTHETIC close while a read runs');
    },
    'tx:study': async () => {
      w.store.study.rs = 'W';
      w.publish({ version: 2, action: 'discarded' }, { version: 3, action: 'reset' });
    },
  });
  const { item } = await w.svc.read(id(81), { ...clinician });
  assert.deepEqual(w.pending(), [], 'both commits landed inside the read');
  assert.deepEqual(w.transactions[reader], READ);
  whole(item, 'during');
  assert.deepEqual([item.state, item.revision, item.entryCount, item.entries.map(e => e.kind), item.closed],
    ['Open', 1, 1, ['question'], null]);
  assert.deepEqual(item.current, { rs: 'A', version: 1 });
  // the next read is a new snapshot and sees every commit whole
  const later = (await w.svc.read(id(81), { ...clinician })).item;
  whole(later, 'after');
  assert.deepEqual([later.state, later.revision, later.entries.map(e => e.kind), later.closed.by.role],
    ['Closed', 3, ['question', 'answer', 'close'], 'radiologist']);
  assert.deepEqual(later.current, { rs: 'W', version: 3 });
  assert.deepEqual(w.writes, { question: 1, update: 2, entry: 3, audit: 3 });
});

test('F01: #2 and #3 read in one RepeatableRead transaction, with no row lock and no read outside it', async () => {
  const w = world(null);
  await create(w, { ...clinician }, id(91));
  // The only read outside the transaction is the policy snapshot of prepare(), taken before it starts.
  for (const [route, call, facts] of [
    ['read', () => w.svc.read(id(91), { ...clinician }), ['anchor', 'entries', 'policy', 'question', 'study']],
    ['forStudy', () => w.svc.forStudy(uid, { ...clinician }), ['list', 'policy', 'study']],
  ]) {
    const mark = w.mark(), at = w.transactions.length;
    await call();
    const seen = w.since(mark);
    assert.deepEqual(w.transactions.slice(at), [READ], route);
    assert.ok(seen.root.length>0&&seen.root.every(r=>r.table==='policy'&&r.started===at&&r.open===0),route+': preparation finishes before the transaction');
    assert.ok(seen.reads.every(r => r.tx === at), route + ': every other read is in the one RepeatableRead transaction');
    assert.deepEqual(facts.filter(table => !seen.reads.some(r => r.table === table)), [], route + ': the answer\'s facts come from that snapshot');
    assert.deepEqual(seen.locks.filter(l => l.kind === 'row'), [], route + ': no row lock');
    assert.deepEqual(seen.writes, [], route);
  }
  assert.deepEqual(w.writes, { question: 1, update: 0, entry: 1, audit: 1 });
});

test('F01: the write paths keep the default isolation and lock StudyState before StudyQuestion', async () => {
  const w = world(null);
  const study = 'study:' + uid, question = 'question:' + id(101);
  for (const [route, call, rows, saved] of [
    ['create', () => create(w, { ...clinician }, id(101)), [study], ['question', 'entry', 'audit']],
    ['reply', () => reply(w, id(101), { ...radiologist }, id(102), 1), [study, question], ['question', 'entry', 'audit']],
    ['close', () => close(w, id(101), { ...clinician }, id(103), 2), [study, question], ['question', 'entry', 'audit']],
  ]) {
    const mark = w.mark(), at = w.transactions.length;
    await call();
    const seen = w.since(mark);
    assert.deepEqual(w.transactions.slice(at), [WRITE], route + ': default isolation');
    assert.ok(seen.locks.length > 0 && seen.locks.every(l => l.bound), route + ': every lock waits under the lock bound');
    assert.deepEqual(seen.held.map(h => [...h.rows].sort()), [[...rows].sort()], route + ': the rows it holds');
    for (const lock of seen.locks.filter(l => l.key === question))
      assert.ok(lock.held.includes(study), route + ': StudyQuestion is locked only while StudyState is held');
    assert.deepEqual(seen.writes.map(x => x.table).sort(), [...saved].sort(), route + ': what it saves');
    for (const x of seen.writes) assert.deepEqual([...x.held].sort(), [...rows].sort(), route + ': every write holds those locks');
  }
});

/* CD-09 W-Q (WQ2): the report anchor a question write records. Input: the Report head, the version row it names and the
 * kept versions, set in the store before the write. Observed first: the store's three facts and that the write took the
 * StudyState lock. Result: the recorded anchor, or 409 QUESTION_REPORT_UNAVAILABLE with no question, entry or audit row. */
const anchorOf = w => [...w.store.entries.values()].map(e => e.reportVersion);
// Each write read the report head once, inside its own transaction and while that transaction held StudyState.
const headsUnderLock = (w, mark, writes, label) => {
  const heads = w.since(mark).heads;
  assert.equal(heads.length, writes, label + ': one head read per write');
  assert.ok(heads.every(h => h.held.includes('study:' + uid)), label + ': the head is read under the StudyState lock');
};

test('W-Q A1/A2: a write records null only without Report and kept versions, else the verified head', async () => {
  const w = world(null), mark = w.mark();
  await create(w, { ...clinician }, id(201));
  w.store.versions.push({ uid, version: 1, action: 'discarded' });      // a discarded-only history (force-discarded drafts)
  await reply(w, id(201), { ...radiologist }, id(202), 1);
  w.publish({ version: 2, action: 'approve' });
  await reply(w, id(201), { ...clinician }, id(203), 2);
  w.publish({ version: 3, action: 'discarded' }, { version: 4, action: 'reset' });
  await close(w, id(201), { ...clinician }, id(204), 3);
  assert.deepEqual(anchorOf(w), [null, null, 2, 4]);
  headsUnderLock(w, mark, 4, 'A1/A2');
  // The thread read keeps its own meaning: the last kept version.
  assert.deepEqual((await w.svc.read(id(201), { ...clinician })).item.current, { rs: 'W', version: 4 });
});

test('W-Q A3: a head that does not match its version rows is refused with no write; the read is unchanged', async () => {
  const cases = {
    'head row missing': w => { w.store.report = { uid, version: 2 }; },
    'head row discarded': w => { w.store.versions.push({ uid, version: 2, action: 'discarded' }); w.store.report = { uid, version: 2 }; },
    'kept above head': w => { w.store.versions.push({ uid, version: 2, action: 'approve' }); },
    'kept without Report': w => { w.store.report = null; },
  };
  for (const [label, corrupt] of Object.entries(cases)) {
    const w = world(null);
    await create(w, { ...clinician }, id(211));
    w.publish({ version: 1, action: 'approve' });
    corrupt(w);
    const writes = { ...w.writes }, mark = w.mark();
    await assert.rejects(reply(w, id(211), { ...radiologist }, id(212), 1), code(409, 'QUESTION_REPORT_UNAVAILABLE'), label);
    await assert.rejects(create(w, { ...clinician }, id(213)), code(409, 'QUESTION_REPORT_UNAVAILABLE'), label);
    assert.deepEqual(w.writes, writes, label + ': no question, entry or audit row');
    assert.deepEqual(w.since(mark).writes, [], label);
    headsUnderLock(w, mark, 2, label);
    assert.equal((await w.svc.read(id(211), { ...clinician })).item.current.rs, 'W', label + ': the read still answers');
  }
});

test('W-Q E1: a write whose locked study differs from the question row stops before any StudyState lock', async () => {
  const w = world(null);
  await create(w, { ...clinician }, id(221));
  const writes = { ...w.writes }, mark = w.mark();
  const other = '2.25.4243';
  await assert.rejects(w.svc.reply(id(221), { ...radiologist }, { requestId: id(222), expectedOwner: owner(radiologist), revision: 1,
    body: 'SYNTHETIC answer' }, undefined, other), code(409, 'QUESTION_CHANGED'));
  await assert.rejects(w.svc.create(uid, { ...clinician }, { requestId: id(223), expectedOwner: owner(clinician), body: 'SYNTHETIC' },
    undefined, other), code(409, 'QUESTION_CHANGED'));
  assert.deepEqual(w.since(mark).locks.filter(l => l.kind === 'row'), [], 'no row lock was taken');
  assert.deepEqual(w.writes, writes);
  // The same study goes through.
  await w.svc.reply(id(221), { ...radiologist }, { requestId: id(224), expectedOwner: owner(radiologist), revision: 1,
    body: 'SYNTHETIC answer' }, undefined, uid);
  assert.equal(w.writes.entry, writes.entry + 1);
});

test('W-Q E5: a finite lock wait that ends before the service runs is the question busy answer', () => {
  const { questionWriteError } = require('/app/dist/clinician-question.service');
  for (const sqlState of ['55P03', '40P01', '57014']) {
    const mapped = questionWriteError(Object.assign(new Error('raw'), { code: 'P2010', meta: { code: sqlState } }));
    assert.ok(code(503, 'QUESTION_BUSY')(mapped), sqlState);
  }
  const other = Object.assign(new Error('raw'), { code: 'P2010', meta: { code: '23514' } });
  assert.equal(questionWriteError(other), other, 'other failures keep their own outcome');
});