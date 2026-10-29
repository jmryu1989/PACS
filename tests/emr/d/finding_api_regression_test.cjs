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
function writeFixture({ pauseAdmission = false, commitUnknown = false, loseCommitReply = false } = {}) {
  let command = null, version = null, unit = null, operation = null, result = null;
  let signCount = 0, projectionCount = 0, accessCount = 0, prepareCount = 0, blocked = false;
  const admitted = deferred(), release = deferred();
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
        result = { ...result, outcome: 'committed', result: reference };
        if (loseCommitReply) throw Object.assign(new Error('lost COMMIT acknowledgement'), { code: 'CommitUnknown' });
      }
      return result;
    },
    transactionWithRecords: async fn => fn(tx, async (_event, effect) => { accessCount++; return effect(); }),
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
  return { invoke, admitted, release, block: () => { blocked = true; },
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
