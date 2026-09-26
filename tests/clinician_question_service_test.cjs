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
 *   (5) a recording Orthanc sees only studyAccessMetadata and studyIdentities(true), and nothing at all when the
 *       policy has no metadata rule.
 * Also pinned over the same stubs: a replay after Closed answers the stored receipt without a write, reuse is
 * 409 REQUEST_ID_REUSED, the audit detail keys, and QUESTION_STATE for a state outside the machine.
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

/** One synthetic store: StudyState, StudyAccessPolicy, questions, receipts and audit rows, with an ordered event log. */
function world(policy, { questions = [] } = {}) {
  const events = [], calls = [], audits = [];
  const writes = { question: 0, update: 0, entry: 0, audit: 0 };
  const store = { questions: new Map(questions.map(q => [q.id, { ...q }])), entries: new Map() };
  const w = { events, calls, audits, writes, store, policyRow: policy ? { institution, revision: 1, policy, reason: '', updatedBy: null, updatedAt: null } : null };
  const kind = sql => sql.includes('pg_advisory') ? 'advisory' : sql.includes('"StudyAccessPolicy"') ? 'policy'
    : sql.includes('FROM "StudyQuestion" q') ? 'list' : sql.includes('FROM "StudyQuestion" WHERE') ? 'question'
      : sql.includes('"ReportVersion"') ? 'anchor' : sql.includes('"StudyState"') ? 'study' : 'unknown';
  const query = (where, strings, values) => {
    const sql = strings.join('?'), k = kind(sql);
    events.push(where + ':' + k);
    if (k === 'advisory') return [{ locked: 1 }];
    if (k === 'policy') return w.policyRow ? [w.policyRow] : [];
    if (k === 'list') return [];
    if (k === 'question') { const row = store.questions.get(values[0]); return row ? [{ ...row }] : []; }
    if (k === 'anchor') return [{ version: null }];
    if (k === 'study') return values[0] === uid ? [{ uid, institutionId: institution, rs: 'W' }] : [];
    throw new Error('unexpected SQL in the stub: ' + sql);
  };
  const tx = {
    $executeRaw: async () => { events.push('tx:execute'); return 0; },
    $queryRaw: async (strings, ...values) => query('tx', strings, values),
    studyQuestion: {
      create: async ({ data }) => { events.push('tx:write'); writes.question++; store.questions.set(data.id, { ...data }); return data; },
      update: async ({ where, data }) => {
        events.push('tx:write'); writes.update++;
        const row = { ...store.questions.get(where.id), ...data }; store.questions.set(where.id, row); return row;
      },
    },
    studyQuestionEntry: {
      findUnique: async ({ where }) => { events.push('tx:receipt'); const row = store.entries.get(where.id); return row ? { ...row } : null; },
      findMany: async ({ where }) => [...store.entries.values()].filter(e => e.questionId === where.questionId).sort((a, b) => a.seq - b.seq),
      create: async ({ data }) => { events.push('tx:write'); writes.entry++; store.entries.set(data.id, { ...data }); return data; },
    },
    auditLog: { create: async ({ data }) => { events.push('tx:write'); writes.audit++; audits.push(data); return data; } },
  };
  const prisma = {
    $queryRaw: async (strings, ...values) => query('root', strings, values),
    $transaction: async fn => { events.push('tx:start'); const result = await fn(tx); events.push('tx:end'); return result; },
    studyState: { findMany: async () => [{ uid }] },
  };
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
  assert.deepEqual(reads.map(([event]) => event), ['orthanc:studyAccessMetadata'], 'the UID route prepares one study');
  assert.ok(reads.every(([, index]) => index < start), 'the source read ends before the transaction');
  assert.deepEqual(orthancAfterStart(w), []);
  assert.ok(w.events.indexOf('tx:study') > start && w.events.indexOf('tx:receipt') > w.events.indexOf('tx:study'),
    'StudyState is locked before the receipt lookup');
  // an id route prepares every study (prepare(c)) before its transaction too
  const before = w.events.length;
  const answered = await reply(w, id(1), { ...radiologist }, id(2), 1);
  const later = w.events.slice(before), second = later.indexOf('tx:start');
  assert.equal(answered.applied.action, 'answer');
  assert.deepEqual(later.filter(e => e.startsWith('orthanc:')), ['orthanc:studyIdentities']);
  assert.ok(later.indexOf('orthanc:studyIdentities') < second);
  assert.deepEqual(later.slice(second).filter(e => e.startsWith('orthanc:')), []);
  assert.deepEqual(w.calls.find(call => call.name === 'studyIdentities').args, [true]);
  assert.deepEqual(w.writes, { question: 1, update: 1, entry: 2, audit: 2 });
});

test('(2) a policy change during the source read is 409 STUDY_ACCESS_CHANGED with no transaction and no write', async () => {
  for (const route of ['create', 'reply', 'close']) {
    const w = world(metadataPolicy(), { questions: [{ id: id(10), studyUid: uid, institutionId: institution,
      authorSub: clinician.sub, authorActor: clinician.actor, authorName: clinician.name, state: 'Open', revision: 1, entryCount: 1 }] });
    w.handlers.studyAccessMetadata = async u => { w.bumpPolicy(); return source(u); };
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
    w.handlers.studyAccessMetadata = async () => { throw new Error('SYNTHETIC transport failure'); };
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

test('(5) only studyAccessMetadata and studyIdentities(true) reach Orthanc, and nothing without a metadata rule', async () => {
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
    assert.ok(['studyAccessMetadata', 'studyIdentities'].includes(call.name), call.name);
    if (call.name === 'studyIdentities') assert.deepEqual(call.args, [true]);
  }
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
