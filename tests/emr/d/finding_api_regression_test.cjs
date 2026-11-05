/* R290-04: TEST-S2-API-04/T09e and TEST-S2-API-10/T10d.
 * Actual finding controller/service and EMR routes/runtime, with synthetic storage ports.
 * The pending schedule pauses admission before the first business transaction; it does
 * not simulate a database outage. PostgreSQL/served coverage remains in finding_api_test.py.
 */
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const api = path.join(process.env.KIN_FINDING_API_ROOT || root, 'api');
const ts = require(path.join(root, 'api/node_modules/typescript'));
const config = ts.readConfigFile(path.join(api, 'tsconfig.json'), ts.sys.readFile);
assert.equal(config.error, undefined);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, api).options;
const previousLoader = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
  { compilerOptions: options, fileName: filename }).outputText, filename);
const { FindingService } = require(path.join(api, 'src/finding.service.ts'));
const { FindingController } = require(path.join(api, 'src/finding.controller.ts'));
const { ClinicalRoutes } = require(path.join(api, 'src/emr-clinical/routes.ts'));
const { PacsClinicalRoutes } = require(path.join(api, 'src/emr-clinical/pacs-routes.ts'));
const { ReaderAssignmentController } = require(path.join(api, 'src/reader-assignment.controller.ts'));
const { applyPlan } = require(path.join(api, 'src/emr-clinical/records.ts'));
const { refuse } = require(path.join(api, 'src/emr-contract/validation.ts'));
const { NotFoundException } = require(path.join(api, 'node_modules/@nestjs/common'));
if (previousLoader) require.extensions['.ts'] = previousLoader; else delete require.extensions['.ts'];

const uid = '1.2.840.9999.290', id = '00000000-0000-4000-8000-000000000004';
const caller = { sub: 'synthetic-reader', actor: 'synthetic-reader', roles: ['radiologist'], institution: 'inst-a', kind: 'member' };
const state = { uid, institutionId: 'inst-a', teleInstitutionId: null, rs: 'N' };
const response = { setHeader() {} };
const status = async action => { try { await action(); return 200; } catch (error) { if (!error.getStatus) throw error; return error.getStatus(); } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function readFixture(row, current = caller, transactionRow = row) {
  let reads = 0;
  const tx = { studyState: { findUnique: async () => transactionRow }, $executeRaw: async () => {},
    $queryRaw: async () => ++reads % 2 ? [] : [{ allowed: transactionRow?.institutionId === current.institution && transactionRow.rs !== 'P', rows: '[]' }] };
  const db = { studyState: { findUnique: async () => row }, $transaction: async fn => fn(tx) };
  const svc = new FindingService(db, { prepare: async () => {}, require: async () => {} }, {});
  const scope = async () => {
    if (!row || ![row.institutionId, row.teleInstitutionId].includes(current.institution)) throw new NotFoundException('검사가 없습니다.');
    return { studyId: uid, managingInstitutionId: row.institutionId };
  };
  const routes = new ClinicalRoutes({ records: { begin: () => ({ end() {}, transactionWithRecords: async fn => fn(tx, () => {}) }) },
    context: { facts: async () => ({ actor: {} }), scope },
    store: { unit: async () => row ? { studyId: uid } : null } }, () => { throw new Error('read cannot prepare a write'); });
  return { svc, controller: new FindingController(svc, routes), request: { ...current, headers: {} } };
}

test('tenant boundary: finding list and history conceal a foreign study', async () => {
  const f = readFixture({ ...state, institutionId: 'inst-b' });
  assert.equal(await status(() => f.controller.list(uid, {}, f.request, response)), 404);
  assert.equal(await status(() => f.controller.revisions(uid, id, {}, f.request, response)), 404);
});

test('tenant boundary: an absent study has the same refusal', async () => {
  const f = readFixture(null);
  assert.equal(await status(() => f.controller.list(uid, {}, f.request, response)), 404);
  assert.equal(await status(() => f.controller.revisions(uid, id, {}, f.request, response)), 404);
});

test('tenant boundary: permitted empty list, preliminary refusal and service actor refusal remain distinct', async () => {
  const own = readFixture(state);
  assert.deepEqual((await own.controller.list(uid, {}, own.request, response)).items, []);
  for (const [row, current] of [[{ ...state, rs: 'P', preDocSub: 'other', preReviewerSub: 'other-reviewer' }, caller],
    [state, { ...caller, kind: 'service' }]]) {
    const f = readFixture(row, current);
    assert.equal(await status(() => f.controller.list(uid, {}, f.request, response)), 403);
  }
});

test('tenant boundary: institution change before the list snapshot is concealed', async () => {
  const f = readFixture(state, caller, { ...state, institutionId: 'inst-b' });
  assert.equal(await status(() => f.controller.list(uid, {}, f.request, response)), 404);
});

// Only the persistence/identity/signature ports are synthetic. Planning, request
// fingerprinting, replay selection and API outcome translation are production code.
function writeFixture({ pauseAdmission = false, commitUnknown = false, loseCommitReply = false, commandFails = null } = {}) {
  let command = null, version = null, unit = null, operation = null, result = null;
  let signCount = 0, projectionCount = 0, accessCount = 0, prepareCount = 0, blocked = false;
  const admitted = deferred(), release = deferred(), provide = [];
  const actor = { identity: { id: 'reader-id', issuer: 'https://synthetic.invalid', subject: caller.sub },
    kind: 'member', roles: caller.roles, institutionId: caller.institution, signingRegistrationId: 'synthetic-registration' };
  const study = { studyId: uid, managingInstitutionId: 'inst-a',
    patient: { linkId: 'synthetic-link', patientId: 'SYN-290', assigningAuthority: 'inst-a' } };
  const requestId = randomUUID(), recordId = randomUUID();
  const write = { surface: 'finding.create', studyId: uid, recordId, body: { requestId, item: { text: 'SYN finding' } } };
  const tx = {};
  const store = {
    transaction: async fn => fn(tx), unit: async () => unit, lockUnit: async () => {},
    async prepare(identity, build) {
      if (command) {
        if (command.identity.fingerprint !== identity.fingerprint) refuse('RequestIdReused');
        return { command, created: false };
      }
      const ids = { operationId: randomUUID(), attemptId: randomUUID(), versionId: randomUUID() };
      command = { ...await build(tx, ids), ...ids, identity };
      return { command, created: true };
    },
    version: async () => version,
    async append(_tx, c, signature, saved) {
      unit = applyPlan(unit, c.plan);
      version = { operationId: c.operationId, plan: c.plan, signature, response: saved };
    },
  };
  const work = {
    end() {}, lookup: async () => result,
    async admit(event, _served, keys) {
      if (!operation) {
        operation = { ...keys, event };
        result = { outcome: 'pending', operationId: keys.operationId, eventId: event.eventId };
        admitted.resolve();
        if (pauseAdmission) await release.promise;
      }
      return operation;
    },
    async transaction(_op, project) {
      // B2 locks the admitted operation and executes its mutation at most once.
      if (result.outcome === 'pending') {
        if (commitUnknown) throw Object.assign(new Error('unreadable COMMIT outcome'), { code: 'CommitUnknown' });
        const reference = await project(tx);
        // B2 judged the write's own COMMIT aborted: its effect rolled back and the operation settled negative.
        if (commandFails) { result = { ...result, outcome: 'negative' }; unit = null; version = null;
          throw Object.assign(new Error(commandFails), { code: commandFails }); }
        result = { ...result, outcome: 'committed', result: reference };
        if (loseCommitReply) throw Object.assign(new Error('lost COMMIT acknowledgement'), { code: 'CommitUnknown' });
      }
      return result;
    },
    // The provide record of the stored result: a transaction of its own after the write committed. w.provide makes B2
    // judge that transaction not committed (AppendNotCommitted) or unreadable (CommitUnknown), once per entry.
    transactionWithRecords: async fn => {
      const value = await fn(tx, async (_event, effect) => { accessCount++; return effect(); });
      const failed = provide.shift();
      if (failed) { accessCount--; throw Object.assign(new Error(failed), { code: failed }); }
      return value;
    },
    confirm: async () => ({ eventId: operation.event.eventId, durableAt: '2026-10-30T00:00:00.000Z' }),
  };
  const routes = new ClinicalRoutes({ store, records: { begin: () => work },
    context: { facts: async () => ({ actor, requestId: randomUUID(), ip: { status: 'known', value: { address: '127.0.0.1', source: 'request-peer' } } }),
      study: async () => study },
    signer: { sign: async () => { signCount++; return { synthetic: true }; }, verify() {} } }, async () => {
    prepareCount++;
    if (blocked) throw new NotFoundException();
    return { content: JSON.stringify(write.body.item), attachments: [], navigation: [uid + '.1'],
      recipientId: null, readerId: null, workContext: null, projection: {} };
  });
  const invoke = async (body = write.body) => {
    try {
      return { status: 200, body: await routes.write({}, { ...write, body }, async () => {
        projectionCount++; return { id: recordId, revision: 1, item: write.body.item };
      }) };
    } catch (error) { if (!error.getStatus) throw error; return { status: error.getStatus(), body: error.getResponse() }; }
  };
  return { invoke, admitted, release, provide, block: () => { blocked = true; },
    counts: () => ({ signCount, projectionCount, accessCount, prepareCount }), write };
}

test('parallel identical creates: pending admission joins one commit and returns one replay', async () => {
  const f = writeFixture({ pauseAdmission: true });
  const first = f.invoke();
  await f.admitted.promise;
  let twin;
  try { twin = await f.invoke(); } finally { f.release.resolve(); }
  const original = await first;
  assert.deepEqual([original.status, twin.status], [200, 200]);
  assert.equal(original.body.emr.replayed, false);
  assert.deepEqual(twin.body, { ...original.body, emr: { ...original.body.emr, replayed: true } });
  assert.equal(f.counts().signCount, 1);
  assert.equal(f.counts().projectionCount, 1);
  assert.equal(f.counts().accessCount, 2);
});

test('parallel identical creates: genuine COMMIT uncertainty remains unknown with no duplicate effect', async () => {
  const f = writeFixture({ commitUnknown: true });
  const result = await f.invoke();
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'OutcomeUnknown');
  assert.equal(f.counts().signCount, 0);
  assert.equal(f.counts().projectionCount, 0);
});

test('lost COMMIT reply is recovered by replay without another signature or projection', async () => {
  const f = writeFixture({ loseCommitReply: true });
  const lost = await f.invoke();
  assert.equal(lost.status, 503);
  assert.equal(lost.body.code, 'OutcomeUnknown');
  const replay = await f.invoke();
  assert.equal(replay.status, 200);
  assert.equal(replay.body.emr.replayed, true);
  assert.equal(f.counts().signCount, 1);
  assert.equal(f.counts().projectionCount, 1);
});

test('replays reject changed payloads and recheck comparison access without another signature', async () => {
  const f = writeFixture();
  assert.equal((await f.invoke()).status, 200);
  const changed = await f.invoke({ ...f.write.body, item: { text: 'different' } });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'REQUEST_ID_REUSED');
  f.block();
  assert.equal((await f.invoke()).status, 404);
  assert.equal(f.counts().signCount, 1);
  assert.equal(f.counts().projectionCount, 1);
});

// B2-COMMIT (plan section 3, K11/K12 pure): the write's own transaction and the record of providing its stored result are
// different steps. B6 contract change (2026-11-05, 정모 님 decision; 의료법 제23조④ keeps the 열람 record, it does not refuse
// the reading): a provide record that did not commit or cannot be told no longer withholds the saved result (the former
// 503 ProvideNotRecorded / OutcomeUnknown(provide) assertions were that withdrawn design). The write's answer is sent as
// committed, marked `accessRecord`; it never says the finding was not saved, and the same request ID still replays the
// stored result with no second signature or projection.
/** The operator's lines for unrecorded provide records (no administrator alert path exists): who, what, when, result. */
async function unrecordedLines(action) {
  const lines = [], warn = console.warn;
  console.warn = (...args) => { const text = args.join(' '); if (text.startsWith('[EMR] access record ')) lines.push(text); else warn(...args); };
  try { return { value: await action(), lines: lines.map(line => {
    const [, result, json] = /^\[EMR\] access record (not-recorded|unknown): (.*)$/.exec(line);
    return { result, ...JSON.parse(json) };
  }) }; } finally { console.warn = warn; }
}
for (const [failed, accessRecord] of [['AppendNotCommitted', 'not-recorded'], ['CommitUnknown', 'unknown']]) {
  test(`B2-COMMIT a provide record B2 judged ${failed} still sends the saved result, marked accessRecord ${accessRecord}`, async () => {
    const f = writeFixture();
    f.provide.push(failed);
    const { value: first, lines } = await unrecordedLines(() => f.invoke());
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.accessRecord, accessRecord);
    assert.equal(lines.length, 1, 'one line for the one provide event');
    assert.deepEqual([lines[0].result, lines[0].user.id, lines[0].action, lines[0].targets[0].recordId, typeof lines[0].at],
      [accessRecord, 'reader-id', 'provide-prepared', f.write.recordId, 'string'], 'who, what, when and the result');
    assert.equal(JSON.stringify(lines[0]).includes('SYN-290'), false, 'no patient ID in the line');
    assert.deepEqual([first.body.id, first.body.revision, first.body.item], [f.write.recordId, 1, f.write.body.item], 'the saved result');
    assert.equal(first.body.emr.replayed, false, 'the write itself committed');
    assert.deepEqual([f.counts().signCount, f.counts().projectionCount, f.counts().accessCount], [1, 1, 0]);
    const again = await f.invoke();
    assert.equal(again.status, 200);
    assert.equal(again.body.emr.replayed, true);
    assert.equal(again.body.accessRecord, undefined, 'a recorded provide carries no mark');
    assert.deepEqual([f.counts().signCount, f.counts().projectionCount, f.counts().accessCount], [1, 1, 1]);
  });
}

test('B2-COMMIT an unknown COMMIT of the write itself is still OutcomeUnknown of the command step', async () => {
  const command = writeFixture({ commitUnknown: true });
  const unknownWrite = await command.invoke();
  assert.equal(unknownWrite.status, 503);
  assert.deepEqual([unknownWrite.body.code, unknownWrite.body.stage], ['OutcomeUnknown', 'command']);
  assert.doesNotMatch(unknownWrite.body.message, /저장되지 않았습니다|그대로/);
});

test('B2-COMMIT a write whose own COMMIT did not commit is AppendNotCommitted of the command step', async () => {
  const f = writeFixture({ commandFails: 'AppendNotCommitted' });
  const out = await f.invoke();
  assert.equal(out.status, 503);
  assert.deepEqual([out.body.code, out.body.stage], ['AppendNotCommitted', 'command']);
  assert.match(out.body.message, /[가-힣]/);
});

/** Clinical read routes over one served finding version, where B2 judges each transaction's COMMIT after its callback
 * ran (as store.ts does): `fail(n)` names the code for the n-th transaction (0 = the read, 1 = its provide record). */
function readRoutes(fail) {
  const version = { plan: { version: { sequence: 1, versionId: 'version-1' }, access: { target: { kind: 'finding' } }, signing: null } };
  const tx = { studyState: { findUnique: async () => state }, $executeRaw: async () => {}, $queryRaw: async () => [] };
  const work = { calls: 0, recorded: 0, end() {}, async transactionWithRecords(fn) {
    const index = work.calls++;
    const value = await fn(tx, async (_event, effect) => { work.recorded++; return effect(); });
    const code = fail(index);
    if (code) throw Object.assign(new Error(code), { code });
    return value;
  } };
  const known = { status: 'known', value: { id: 'reader-id' } };
  const routes = new ClinicalRoutes({ records: { begin: () => work },
    context: { facts: async () => ({ actor: { identity: known.value, roles: [], institutionId: 'inst-a' }, requestId: 'req', ip: { status: 'unresolved', reason: 'not-observed' } }),
      scope: async () => ({ studyId: uid, managingInstitutionId: 'inst-a' }),
      study: async () => ({ studyId: uid, managingInstitutionId: 'inst-a', patient: { linkId: 'l', patientId: 'p', assigningAuthority: 'inst-a' } }) },
    store: { unit: async () => ({ studyId: uid }), lockUnit: async () => {}, history: async () => ({ unit: { studyId: uid }, versions: [version] }),
      versions: async () => [version] },
    signer: { verify() {} } }, () => { throw new Error('read cannot prepare a write'); });
  return { routes, work };
}
const refusal = async action => {
  try { await action(); return null; } catch (error) { if (!error.getStatus) throw error; return { status: error.getStatus(), ...error.getResponse() }; }
};
// B6 contract change (2026-11-05, see above): a read, a list and the assignment read (also the follow-up of an assignment
// POST) whose provide record B2 judged not committed or could not judge send the body they read, marked `accessRecord`,
// where the withdrawn design answered 503 ProvideNotRecorded / OutcomeUnknown(provide). A workflow is a write: unchanged.
test('B2-COMMIT reads, lists and the assignment read send their body when the provide record fails; a workflow answers the command step', async () => {
  for (const [code, accessRecord] of [['AppendNotCommitted', 'not-recorded'], ['CommitUnknown', 'unknown']]) {
    for (const [name, call, body] of [
      ['read', routes => routes.read({}, 'finding', id, async () => ({ items: ['SYN finding'] })), { items: ['SYN finding'] }],
      ['collection', routes => routes.collection({}, 'GET studies/:uid/findings', 'finding',
        async () => ({ items: [{ id, studyUid: uid, revision: 1 }] }), uid), { items: [{ id, studyUid: uid, revision: 1 }] }],
      ['assignment', routes => routes.assignment({}, uid, async () => ({ revision: 1, readerSub: 'SYN' })), { revision: 1, readerSub: 'SYN' }]]) {
      // The provide record is the last transaction of each route (a snapshot read first reads, then records).
      const records = readRoutes(() => null);
      await call(records.routes);
      const last = records.work.calls - 1;
      const f = readRoutes(index => index === last ? code : null);
      const { value: out, lines } = await unrecordedLines(() => call(f.routes));
      assert.equal(f.work.recorded, 1, `${name} ${code}: the provide record was attempted`);
      assert.equal(out.accessRecord, accessRecord, `${name} ${code}`);
      assert.deepEqual(lines.map(l => [l.result, l.user.id, l.action]), [[accessRecord, 'reader-id', 'provide-prepared']], `${name} ${code}: logged`);
      for (const [key, value] of Object.entries(body)) assert.deepEqual(out[key], value, `${name} ${code}: the body read is sent`);
      // A recorded provide is unmarked.
      assert.equal((await call(readRoutes(() => null).routes)).accessRecord, undefined, `${name}: recorded`);
    }
    const workflow = await refusal(() => readRoutes(() => code).routes.workflow({}, async () => 'changed'));
    assert.deepEqual([workflow.status, workflow.code, workflow.stage],
      [503, code === 'CommitUnknown' ? 'OutcomeUnknown' : 'AppendNotCommitted', 'command'], `workflow ${code}`);
  }
});

// B6 (2026-11-05): an assignment POST and a Tech Note replay answer with two provide records - the write's stored result
// (ClinicalRoutes.write, its own mark tested above) and the current row or head read after it through the real clinical
// read. The answer keeps the mark when either record failed; when both failed, a record known not kept ('not-recorded')
// outranks one not confirmed. The write is stubbed at its answer; the controller, PACS routes and the follow-up read are
// production code.
const TWO_RECORDS = [[null, null, undefined], ['not-recorded', null, 'not-recorded'], ['unknown', null, 'unknown'],
  [null, 'AppendNotCommitted', 'not-recorded'], [null, 'CommitUnknown', 'unknown'],
  ['unknown', 'AppendNotCommitted', 'not-recorded'], ['not-recorded', 'CommitUnknown', 'not-recorded']];
/** readRoutes whose last transaction (the follow-up read's provide record) B2 judges `later`, and whose write answers `written`. */
async function twoRecords(call, written, later, replayed) {
  const dry = readRoutes(() => null);
  dry.routes.write = async () => ({ emr: { replayed } });
  await call(dry.routes);
  const last = dry.work.calls - 1;
  const f = readRoutes(index => index === last ? later : null);
  const writes = [];
  f.routes.write = async (request, write) => {
    writes.push(write);
    return { emr: { replayed }, ...(write.surface === 'tech-note.write' ? { note: { version: 1 } } : {}), ...(written ? { accessRecord: written } : {}) };
  };
  return { ...await unrecordedLines(() => call(f.routes)), work: f.work, writes };
}
test('B2-COMMIT an assignment POST keeps the accessRecord of its write or of the current row it answers', async () => {
  for (const replayed of [false, true]) for (const [written, later, expected] of TWO_RECORDS) {
    const reads = [];
    const service = { read: async (_uid, _caller, _tx, request) => { reads.push(request); return { revision: 1, readerSub: 'SYN' }; } };
    const call = routes => new ReaderAssignmentController(service, routes)
      .write(uid, { ...caller, headers: {} }, { requestId: 'SYN-REQUEST', readerSub: 'SYN' });
    const { value: out, lines, work } = await twoRecords(call, written, later, replayed);
    const label = `replayed=${replayed} write=${written} current=${later}`;
    assert.equal(out.accessRecord, expected, label);
    assert.deepEqual([out.revision, out.readerSub], [1, 'SYN'], `${label}: the current row`);
    assert.equal(reads.at(-1), replayed ? 'SYN-REQUEST' : null, `${label}: a replay is matched to its request`);
    assert.equal(work.recorded, 1, `${label}: the current row's provide record was attempted`);
    assert.equal(lines.length, later ? 1 : 0, `${label}: the current row's failed record is logged`);
  }
});
test('B2-COMMIT a Tech Note replay keeps the accessRecord of its stored receipt or of the head it answers', async () => {
  const notes = { prepareWrite: async () => {}, techNote: async () => ({ note: { version: 1, text: 'SYN note' } }) };
  const call = routes => new PacsClinicalRoutes({}, notes, routes).saveTechNote(uid, { attemptId: 'SYN-ATTEMPT' }, caller, {});
  for (const [written, later, expected] of TWO_RECORDS) {
    const { value: out, work } = await twoRecords(call, written, later, true);
    const label = `write=${written} head=${later}`;
    assert.equal(out.accessRecord, expected, label);
    assert.deepEqual(out.latestNote, { version: 1, text: 'SYN note' }, `${label}: today's head`);
    assert.deepEqual([out.note, out.emr.replayed], [{ version: 1 }, true], `${label}: the stored receipt`);
    assert.equal(work.recorded, 1, `${label}: the head's provide record was attempted`);
  }
  // A first save reads no head after the write: its answer is the write's, mark and all.
  for (const written of [null, 'not-recorded', 'unknown']) {
    const { value: out, work } = await twoRecords(call, written, null, false);
    assert.deepEqual([out.accessRecord, out.latestNote, work.calls], [written ?? undefined, undefined, 0], `first save write=${written}`);
  }
});
