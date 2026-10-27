'use strict';
// Real producers and request ownership; recording storage doubles only. The
// PostgreSQL suites (emr/d/online_live.py and emr/request/request_facts_live.py)
// separately check durability. This is the behaviour behind the D1816 scope the
// legacy AuditLog scan takes for EMR-D and the B2 request ports: what those flows
// record (B2 events with the shared request's facts; the retained admin AuditLog
// row). Context, preparation and current-session callbacks are test doubles;
// the PostgreSQL suites cover their service adapters and durable storage.
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { IncomingMessage, ServerResponse } = require('node:http');
const { Socket } = require('node:net');

module.exports = async function recordedBoundaries() {
  const root = path.resolve(__dirname, '../../..');
  const ts = require(path.join(root, 'api/node_modules/typescript'));
  const previous = require.extensions['.ts'];
  require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(require('node:fs').readFileSync(file, 'utf8'), {
    fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true },
  }).outputText, file);
  const load = name => require(path.join(root, 'api/src', name + '.ts'));
  const { ClinicalStore } = load('emr-clinical/store');
  const { composeClinicalRuntime } = load('emr-clinical/runtime');
  const { readOnlineClinicalRecord } = load('emr-clinical/response');
  const { createRecordPort } = load('emr-runtime/record-port');
  const { createRequestContext } = load('emr-runtime/request-context');
  const { createRequestIngress } = load('emr-runtime/request-ingress');
  const { AdminService } = load('admin.service');
  const { AdminController } = load('admin.controller');
  if (previous) require.extensions['.ts'] = previous; else delete require.extensions['.ts'];
  const issuer = 'https://audit-fixture.example.test';
  const subject = 'synthetic-admin', institution = 'synthetic-hospital', actorId = randomUUID();
  const studyId = '1.2.826.0.1.3680043.10.900.1';
  const study = { studyId, managingInstitutionId: institution,
    patient: { linkId: 'synthetic-link', patientId: 'synthetic-patient', assigningAuthority: institution } };
  const commands = [], versions = [], references = [], events = [], legacy = [], admissions = [], operations = new Map();
  let rejectAppend = false, rejectCurrent = false, currentChecks = 0, transactionChecks = 0, projected = 0;
  const db = {
    async $transaction(work) { return work(db); },
    async $queryRaw(strings, ...values) {
      const sql = strings.join('?');
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes('emr_clinical.online_command')) return commands.filter(c =>
        c.identity.receiptKey.record === values[0] && c.identity.receiptKey.actorId === values[1] &&
        c.identity.receiptKey.requestId === values[2]).map(c => ({ body: JSON.stringify(c) }));
      if (sql.includes('emr_clinical.online_version')) return versions.filter(v =>
        values.length === 1 ? v.plan.version.versionId === values[0] :
          v.plan.record === values[0] && v.plan.version.recordId === values[1]).map(v => ({
        body: JSON.stringify(v.plan), signature: v.signature === null ? null : JSON.stringify(v.signature), operation_id: v.operationId }));
      // Member-rights lock/time query. No SQL is executed by this fixture.
      return [{ boundary: new Date() }];
    },
    async $executeRaw(strings, ...values) {
      const sql = strings.join('?');
      if (sql.includes('INSERT INTO emr_clinical.online_command')) commands.push(JSON.parse(values[4]));
      else if (sql.includes('INSERT INTO emr_clinical.online_version')) {
        const plan = JSON.parse(values[5]);
        assert.deepEqual(values.slice(0, 4), [plan.record, plan.version.recordId, plan.version.versionId, plan.version.sequence]);
        versions.push({ plan, operationId: values[4], signature: values[6] === null ? null : JSON.parse(values[6]) });
      } else if (sql.includes('INSERT INTO emr_clinical.online_reference')) references.push(values);
      else assert.match(sql, /set_config|SET LOCAL|pg_advisory_xact_lock/);
      return 1;
    },
    memberRights: { findUnique: async () => null, create: async ({ data }) => ({ ...data, version: 1 }) },
    auditLog: { async create({ data }) { legacy.push(data); return data; } },
  };
  const receipt = event => ({ eventId: event.eventId, durableAt: new Date().toISOString() });
  const { port, control } = createRecordPort({
    async resolveRequestIdentity(givenIssuer, givenSubject) {
      assert.deepEqual([givenIssuer, givenSubject], [issuer, subject]); return actorId;
    },
    async admit(event, _served, keys) { return { event, ...keys }; },
    async transaction(operation, work) {
      if (rejectAppend) throw new Error('SyntheticLedgerUnavailable');
      const result = { outcome: 'committed', result: await work(db) };
      events.push(operation.event); operations.set(operation.operationId, result); return result;
    },
    async transactionWithRecords(work) {
      // RecordMutation runs the effect on the producer's transaction; a null
      // reference has no event, and events become visible only on commit.
      const pending = [];
      const result = await db.$transaction(tx => work(tx, async (event, effect) => {
        if (rejectAppend) throw new Error('SyntheticLedgerUnavailable');
        const reference = await effect();
        if (reference !== null) pending.push(event);
        return reference;
      }));
      events.push(...pending);
      return result;
    },
    async confirm(appended) {
      assert.equal(operations.get(appended.operationId)?.outcome, 'committed');
      const event = events.find(e => e.eventId === appended.eventId); assert.ok(event);
      return receipt(event);
    },
    async lookup(id) { return operations.get(id) ?? null; },
    async append(event) {
      if (rejectAppend) throw new Error('SyntheticLedgerUnavailable');
      events.push(event); return receipt(event);
    },
  });
  const requests = createRequestContext(createRequestIngress({ proxyPeers: [] }), port);
  const invoke = async (route, run) => {
    const req = Object.assign(new IncomingMessage(new Socket()), { sub: subject, actor: subject, roles: ['admin'] });
    const res = new ServerResponse(req);
    requests.capture.capture(req, res, { issuer, subject, roles: ['admin'], institution, rightsVersion: 1,
      binding: { method: 'bearer', sessionRef: null } }, route, async tx => {
      if (tx !== undefined) { assert.equal(tx === db, true); transactionChecks++; }
      currentChecks++;
      if (rejectCurrent) throw new Error('SyntheticSessionEnded');
    });
    admissions.push(requests.source.read(req));
    try { return await run(req); } finally { res.emit('finish'); }
  };
  const storage = new ClinicalStore(db);
  const context = {
    async facts(tx, req) {
      return requests.source.withWork(req, async current => {
        await current.requireCurrent(tx);
        const facts = current.facts;
        return { actor: { identity: facts.actor, kind: 'member', roles: facts.roles,
          institutionId: facts.institution, signingRegistrationId: null }, requestId: facts.requestId, ip: facts.ingress };
      });
    },
    async study(tx, req, uid) {
      await this.facts(tx, req); assert.equal(uid, studyId); return study;
    },
  };
  const runtime = composeClinicalRuntime({ records: port, store: storage, context,
    signer: { sign() { assert.fail('an operational assignment is not signed'); }, verify() { assert.fail('unexpected signature'); } },
    async project(tx) { assert.equal(tx === db, true); projected++; },
  });
  const write = { surface: 'assignment.write', studyId, recordId: randomUUID(),
    body: { requestId: randomUUID(), expectedOwner: [institution, subject], revision: null, readerSub: 'synthetic-reader' },
    async prepare(tx, facts) {
      assert.equal(tx === db, true); assert.equal(facts.actor.identity.id, actorId);
      return { content: null, attachments: [], navigation: [], recipientId: null,
        readerId: 'synthetic-reader', workContext: null, projection: null };
    },
  };
  const route = { method: 'POST', route: 'studies/:uid/reader-assignment', purpose: 'clinical' };
  const saved = await invoke(route, req => runtime.write(req, write));
  assert.equal(saved.status, 'committed');
  assert.equal(versions.length, 1); assert.equal(projected, 1); assert.equal(events.length, 1);
  const first = events[0];
  assert.deepEqual(first.userId.value, { id: actorId, issuer, subject });
  assert.equal(first.actingInstitution.value, institution); assert.equal(first.managingInstitution.value, institution);
  assert.equal(first.action, 'write'); assert.equal(first.result, 'succeeded');
  assert.equal(first.requestId, admissions[0].requestId);
  assert.deepEqual(first.rolesAtTime, { status: 'known', value: ['admin'] });
  assert.deepEqual(first.trustedProxyIp, { status: 'unresolved', reason: 'not-observed' });
  assert.deepEqual(first.targets[0].recordId, { status: 'known', value: write.recordId });
  assert.deepEqual(first.targets[0].versionId, { status: 'known', value: versions[0].plan.version.versionId });
  const replay = await invoke(route, req => runtime.write(req, write));
  assert.equal(replay.status, 'replayed'); assert.deepEqual(replay.receipt, saved.receipt);
  const lookup = await invoke(route, req => runtime.lookup(req, write));
  assert.equal(lookup.status, 'replayed'); assert.equal(projected, 1); assert.equal(versions.length, 1);
  const read = await invoke({ method: 'GET', route: 'studies/:uid/reader-assignment', purpose: 'clinical' },
    req => readOnlineClinicalRecord(runtime.parts, req, 'assignment', write.recordId, 'history'));
  assert.equal(read.recordId, write.recordId); assert.equal(read.bodies.length, 1);
  assert.equal(events.at(-1).action, 'provide-prepared');
  assert.equal(events.at(-1).requestId, admissions.at(-1).requestId);
  assert.deepEqual(events.at(-1).userId.value, { id: actorId, issuer, subject });
  assert.deepEqual(events.at(-1).targets[0].versionId, { status: 'known', value: versions[0].plan.version.versionId });
  assert.equal(read.access.eventId, events.at(-1).eventId);
  rejectAppend = true;
  await assert.rejects(invoke(route, req => readOnlineClinicalRecord(runtime.parts, req, 'assignment', write.recordId, 'current')), /SyntheticLedgerUnavailable/);
  const beforeFailure = { events: events.length, versions: versions.length, projected };
  await assert.rejects(invoke(route, req => runtime.write(req, { ...write, recordId: randomUUID(),
    body: { ...write.body, requestId: randomUUID() } })), /SyntheticLedgerUnavailable/);
  assert.deepEqual({ events: events.length, versions: versions.length, projected }, beforeFailure);
  rejectAppend = false; rejectCurrent = true;
  await assert.rejects(invoke(route, req => runtime.lookup(req, write)), /SyntheticSessionEnded/);
  rejectCurrent = false;

  const kcUser = { id: 'synthetic-new-member', username: 'synthetic-new-member', email: 'synthetic@example.test',
    firstName: 'Synthetic', lastName: 'Member', emailVerified: false, enabled: true };
  const kc = { createUser: async () => kcUser, setGroups: async () => {}, setRoles: async () => {},
    resetPassword: async () => {}, setEnabled: async () => {} };
  const admin = new AdminController(new AdminService(db, kc, null, null), null, requests.source);
  const beforeCreate = transactionChecks;
  // The plain (pending) create: since #259 an omitted verificationOverride means the face-to-face create, which needs
  // an institution and roles and continues into the approval patch.
  const created = await invoke({ method: 'POST', route: 'admin/users', purpose: 'clinical' },
    req => admin.create({ username: kcUser.username, email: kcUser.email, firstName: kcUser.firstName, lastName: kcUser.lastName,
      verificationOverride: false }, req));
  assert.equal(created.id, kcUser.id);
  assert.equal(transactionChecks, beforeCreate + 1, 'create rechecks the captured request on its transaction');
  assert.equal(legacy.length, 1); assert.equal(legacy[0].action, 'admin.user.create');
  assert.equal(legacy[0].actor, subject); assert.equal(legacy[0].target, kcUser.id);
  assert.ok(currentChecks > 0); assert.equal(control.live(), 0);
  return { clinicalEvents: events.map(event => event.action), clinicalVersions: versions.length,
    legacyActions: legacy.map(row => row.action), sharedRequestFacts: true };
};
