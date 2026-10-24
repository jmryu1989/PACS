/* C2-L1/L2/L4/L5/L6/L7/L8 -> wrong doctor/version, lost publication, lost historical evidence
 * -> T-ID/T-TX/T-RETRY/T-TIME/T-LOG/T-KEY/T-RESTORE.
 * D1824: real C2 modules, B2 PG LedgerPort and migrations. Only request/report fixtures
 * live in the test. This does not claim HTTP, served-page or A-retention acceptance.
 * The VM harness applies the real C2 migration before running; no operational DB defaults or LiveStack.
 */
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const api = process.env.KIN_D_API || path.resolve(__dirname, '../../../api');
const ts = require(path.join(api, 'node_modules/typescript'));
const { PrismaClient } = require(path.join(api, 'node_modules/@prisma/client'));
const cfg = ts.readConfigFile(path.join(api, 'tsconfig.json'), ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(cfg.config, ts.sys, api).options;
const oldLoader = require.extensions['.ts'];
require.extensions['.ts'] = (m, filename) => m._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
  { compilerOptions: options, fileName: filename }).outputText, filename);
const { createServerSigning } = require(path.join(api, 'src/emr-signature/server-signing.module.ts'));
const { FileWrappingSecrets } = require(path.join(api, 'src/emr-signature/server-keys.ts'));
const { verifyRegisteredServerEnvelope } = require(path.join(api, 'src/emr-signature/server-verification.ts'));
const { transitionReport } = require(path.join(api, 'src/emr-contract/report-lifecycle.ts'));
const { OnlineSigningStore } = require(path.join(api, 'src/emr-report/online-store.ts'));
const { pgSigningLedger } = require(path.join(api, 'src/emr-signature/pg-ledger.ts'));
const { EmrLedgerClient } = require(path.join(api, 'src/emr-runtime/client.ts'));
const { AccessLedgerStore } = require(path.join(api, 'src/emr-runtime/store.ts'));
const { createRecordPort } = require(path.join(api, 'src/emr-runtime/record-port.ts'));
const { FailureJournal, FailureSpool } = require(path.join(api, 'src/emr-runtime/failure-journal.ts'));
if (oldLoader) require.extensions['.ts'] = oldLoader; else delete require.extensions['.ts'];

const url = process.env.C2_TEST_DATABASE_URL;
assert.ok(url, 'Explicit disposable C2 PostgreSQL URL required');
assert.match(new URL(url).pathname, /^\/c2_signing_test(?:_restored)?$/);
const db = new PrismaClient({ datasources: { db: { url } } });
const secretDir = process.env.C2_TEST_SECRET_DIR;
assert.ok(secretDir && path.isAbsolute(secretDir), 'Separate synthetic secret mount required');
const secretPath = path.join(secretDir, 'c2-wrap-v1.bin');
const secrets = new FileWrappingSecrets('c2-wrap-v1', { 'c2-wrap-v1': secretPath });
const identity = id => ({ id, issuer: 'https://synthetic.example.test', subject: `subject-${id}` });
const clone = value => JSON.parse(JSON.stringify(value));
const decoded = result => JSON.parse(Buffer.from(result.envelope.payload, 'base64url').toString('utf8'));
const request = id => ({ session: id });
let counter = 0;

// The runtime credential and B2 port are the same boundaries used by the API.
const runtime = new EmrLedgerClient(process.env.C2_TEST_RUNTIME_URL);
const journal = new FailureJournal(runtime, new FailureSpool(path.join(secretDir, 'failure-spool')));
const { port } = createRecordPort(new AccessLedgerStore(runtime, journal));
const ledger = () => pgSigningLedger(port);

const identities = {
  async resolve(tx, req) {
    const [row] = await tx.$queryRaw`SELECT facts FROM c2_fixture.member WHERE session_id=${req.session} FOR SHARE`;
    if (!row) throw new Error('SessionUnavailable');
    return row.facts;
  },
  async authorizeKeyManagement(tx, req, institutionId) {
    const current = await this.resolve(tx, req);
    assert.equal(current.capacity, 'operator');
    assert.equal(current.actor.institutionId, institutionId);
    return current;
  },
  async doctor(tx, institutionId, doctorId) {
    const [row] = await tx.$queryRaw`SELECT facts FROM c2_fixture.member WHERE doctor_id=${doctorId} AND institution_id=${institutionId} FOR SHARE`;
    if (!row) throw new Error('DoctorNotRegistered');
    return { identity: row.facts.actor.identity, identityRegistrationId: row.facts.actor.identityRegistrationId,
      institutionId, canSign: row.facts.actor.canSign && row.facts.actor.sessionState === 'active' };
  },
};

const reports = {
  async lock(tx, who, recordId) {
    const [row] = await tx.$queryRaw`SELECT current FROM c2_fixture.report WHERE record_id=${recordId} FOR UPDATE`;
    if (!row) throw new Error('ReportMissing');
    return row.current;
  },
  async validate(tx, current) {
    const [row] = await tx.$queryRaw`SELECT clinically_available FROM c2_fixture.report WHERE record_id=${current.facts.recordId}`;
    if (!row.clinically_available) throw new Error('RetainedOnly');
    // A's real retained-source adapter remains an integration handoff, never emulated in product code.
  },
  async publish(tx, current, command, approval, draftRevision) {
    const next = transitionReport(current.facts, command).facts;
    const updated = { ...current, facts: next };
    await tx.$executeRaw`UPDATE c2_fixture.report SET current=${JSON.stringify(updated)}::jsonb, published=${JSON.stringify(approval)}::jsonb
      WHERE record_id=${approval.recordId}`;
    await tx.$executeRaw`DELETE FROM c2_fixture.draft WHERE record_id=${approval.recordId} AND doctor_id=${approval.doctorId} AND revision=${draftRevision}`;
  },
  async authorizeResult(tx, who, approval) {
    const [row] = await tx.$queryRaw`SELECT current,clinically_available FROM c2_fixture.report WHERE record_id=${approval.recordId} FOR SHARE`;
    if (!row || !row.clinically_available || !row.current.study.readingInstitutionIds.includes(who.actor.institutionId)) throw new Error('ReadRefused');
  },
};
const core = (overrides = {}) => createServerSigning({ ledger: ledger(), identity: identities, reports, secrets, ...overrides });
let service;
const manage = (doctorId, action = 'provision', expectedKid = null) => service.keys.manage(request('operator'),
  { action, institutionId: 'hospital-1', doctorId, expectedKid, reason: '합성 시험 등록/종료' });

async function member(id, edits = {}) {
  const facts = { actor: { identity: identity(id), identityRegistrationId: `registration-${id}`, kind: 'member', roles: ['radiologist'],
    institutionId: 'hospital-1', canSign: true, canCancel: true, rightsVersion: '1', sessionState: 'active' },
    ingress: { requestId: `request-${id}`, ip: { status: 'known', value: { address: '192.0.2.1', source: 'trusted-proxy' } } },
    online: true, capacity: 'clinical' };
  Object.assign(facts, edits); if (edits.actor) facts.actor = { ...facts.actor, ...edits.actor };
  await db.$executeRaw`INSERT INTO c2_fixture.member(session_id,doctor_id,institution_id,facts)
    VALUES (${id},${id},${facts.actor.institutionId},${JSON.stringify(facts)}::jsonb)`;
  return facts;
}
async function setMember(id, change) {
  const [row] = await db.$queryRaw`SELECT facts FROM c2_fixture.member WHERE session_id=${id}`;
  change(row.facts);
  await db.$executeRaw`UPDATE c2_fixture.member SET facts=${JSON.stringify(row.facts)}::jsonb WHERE session_id=${id}`;
}
async function report(doctorId, overrides = {}) {
  const id = `report-${++counter}`, studyId = `1.2.840.99999.${counter}`;
  const current = { study: { studyId, patient: { linkId: `link-${counter}`, patientId: `patient-${counter}`, assigningAuthority: 'hospital-1' },
    managingInstitutionId: 'hospital-1', readingInstitutionIds: ['hospital-1'], assignment: { readerId: doctorId, generation: 1 } },
    facts: { recordId: id, studyId, previousCancelledRecordId: null, contentHistory: [], state: 'In Progress', firstApprovedAt: null,
      originalSignerId: null, amendUntil: null, publishedVersion: null, bodyVersion: null, addenda: [], claimantId: doctorId,
      claimGeneration: 1, preliminary: null, cancellation: null, finalized: null, retentionOnlySince: null },
    author: identity(doctorId), attachments: [] };
  Object.assign(current.facts, overrides);
  await db.$executeRaw`INSERT INTO c2_fixture.report(record_id,current) VALUES (${id},${JSON.stringify(current)}::jsonb)`;
  await db.$executeRaw`INSERT INTO c2_fixture.draft(record_id,doctor_id,revision) VALUES (${id},${doctorId},'draft-1')`;
  return { operationId: crypto.randomUUID(), action: 'approve', recordId: id, studyId, patient: current.study.patient,
    expectedClaimGeneration: current.facts.claimGeneration, expectedPublishedVersionId: null, submittedDraftRevision: 'draft-1',
    text: { findings: '한글\r\n e\u0301 🩻 ', conclusion: '결론\n', recommendation: '숨겨진 권고\r\n' }, reason: null };
}
async function counts(recordId) {
  const [row] = await db.$queryRaw`SELECT
    (SELECT count(*)::int FROM emr_signing.signed_version WHERE record_id=${recordId}) AS signatures,
    (SELECT count(*)::int FROM emr_access.access_entry e JOIN emr_access.access_target t USING(entry_id) WHERE t.record_id=${recordId} AND e.stream='history') AS events,
    (SELECT count(*)::int FROM c2_fixture.draft WHERE record_id=${recordId}) AS drafts,
    (SELECT published IS NOT NULL FROM c2_fixture.report WHERE record_id=${recordId}) AS published`;
  return row;
}

before(async () => {
  await db.$connect();
  service = core();
  if (process.env.C2_TEST_RESTORED === '1') {
    const [row] = await db.$queryRaw`SELECT count(*)::int AS count FROM c2_fixture.report`;
    counter = row.count;
    return;
  }
  fs.mkdirSync(secretDir, { recursive: true });
  fs.writeFileSync(secretPath, crypto.randomBytes(32), { mode: 0o600 });
  await db.$executeRaw`CREATE SCHEMA c2_fixture`;
  await db.$executeRaw`CREATE TABLE c2_fixture.member(session_id text PRIMARY KEY,doctor_id text NOT NULL,institution_id text NOT NULL,facts jsonb NOT NULL)`;
  await db.$executeRaw`CREATE TABLE c2_fixture.report(record_id text PRIMARY KEY,current jsonb NOT NULL,published jsonb,clinically_available boolean NOT NULL DEFAULT true)`;
  await db.$executeRaw`CREATE TABLE c2_fixture.draft(record_id text NOT NULL,doctor_id text NOT NULL,revision text NOT NULL,PRIMARY KEY(record_id,doctor_id))`;
  await db.$executeRaw`GRANT USAGE ON SCHEMA c2_fixture TO kin_runtime,kin_emr_reader`;
  await db.$executeRaw`GRANT SELECT,INSERT,UPDATE,DELETE ON c2_fixture.member,c2_fixture.report,c2_fixture.draft TO kin_runtime`;
  await member('operator', { capacity: 'operator' });
  for (const id of ['doctor-1', 'doctor-2', 'departing', 'replacement', 'race', 'restored-doctor']) {
    await member(id); await manage(id);
  }
});
after(async () => { await journal.close(); await runtime.$disconnect(); await db.$disconnect(); });

if (process.env.C2_TEST_RESTORED !== '1') {
test('T-KEY distinct persisted doctor keys survive service restart and public exports exclude private rows', async () => {
  const store = new OnlineSigningStore();
  const keys = await db.$transaction(async tx => [await store.currentKey(tx, 'hospital-1', 'doctor-1'), await store.currentKey(tx, 'hospital-1', 'doctor-2')]);
  assert.notEqual(keys[0].kid, keys[1].kid);
  assert.notDeepEqual(keys[0].publicKey, keys[1].publicKey);
  await assert.rejects(service.keys.manage(request('operator'), { action: 'approve', institutionId: 'hospital-1', doctorId: 'doctor-1',
    expectedKid: keys[0].kid, reason: '합성 명령' }), { code: 'KeyManagementActionRequired' });
  const cmd = await report('doctor-1'), approved = await core().approval.approve(request('doctor-1'), cmd);
  assert.equal(approved.kid, keys[0].kid);
  assert.equal(verifyRegisteredServerEnvelope(approved.envelope, approved.keyAtSigning).integrity, 'valid');
  await db.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL ROLE kin_emr_reader`;
    const rows = await tx.$queryRaw`SELECT * FROM emr_signing.doctor_key`;
    assert.ok(rows.length >= 2);
    assert.equal(JSON.stringify(rows).includes('ciphertext'), false);
  });
  await assert.rejects(db.$transaction(async tx => { await tx.$executeRaw`SET LOCAL ROLE kin_emr_reader`; await tx.$queryRaw`SELECT * FROM emr_signing.private_key`; }));
});

test('T-TX/T-BIND/T-LOG signature, publication, exact bytes and law-level event commit together', async () => {
  const cmd = await report('doctor-1'), signed = await service.approval.approve(request('doctor-1'), cmd);
  assert.deepEqual(decoded(signed).text, { kind: 'report', ...cmd.text });
  assert.deepEqual(await counts(cmd.recordId), { signatures: 1, events: 1, drafts: 0, published: true });
  const entries = await db.$queryRaw`SELECT stream,payload::jsonb AS facts FROM emr_access.access_entry e
    JOIN emr_access.access_target t USING(entry_id) WHERE t.record_id=${cmd.recordId} ORDER BY stream`;
  assert.deepEqual(entries.map(e => e.stream), ['history', 'viewing']);
  const entry = entries[0];
  assert.equal(entry.facts.occurredAt, signed.signedAt);
  assert.equal(entry.facts.userId.value.id, 'doctor-1');
  assert.equal(entry.facts.targets[0].patientLinkSnapshot.value.patientId, cmd.patient.patientId);
  assert.equal(entry.facts.targets[0].versionId.value, signed.versionId);
  assert.equal(entry.facts.trustedProxyIp.value.address, '192.0.2.1');
  assert.equal(JSON.stringify(entry).includes(cmd.text.findings), false);
  assert.equal(JSON.stringify(entry).includes('ciphertext'), false);
});

test('T-TX real SQL ledger failure rolls back signature, report, outcome and submitted draft deletion', async () => {
  const cmd = await report('doctor-1');
  await db.$executeRaw`ALTER TABLE emr_access.access_entry ADD CONSTRAINT ordinary_write_failure CHECK (payload::jsonb->>'action' <> 'approve-sign') NOT VALID`;
  try { await assert.rejects(service.approval.approve(request('doctor-1'), cmd)); }
  finally { await db.$executeRaw`ALTER TABLE emr_access.access_entry DROP CONSTRAINT ordinary_write_failure`; }
  assert.deepEqual(await counts(cmd.recordId), { signatures: 0, events: 0, drafts: 1, published: false });
  assert.equal(await service.approval.result(request('doctor-1'), cmd.operationId), null);
  await service.approval.approve(request('doctor-1'), cmd);
  assert.equal((await counts(cmd.recordId)).signatures, 1);
});

test('T-TX real signature persistence failure also preserves report and draft', async () => {
  const cmd = await report('doctor-1');
  await db.$executeRaw`ALTER TABLE emr_signing.signed_version ADD CONSTRAINT ordinary_storage_failure CHECK (false) NOT VALID`;
  try { await assert.rejects(service.approval.approve(request('doctor-1'), cmd)); }
  finally { await db.$executeRaw`ALTER TABLE emr_signing.signed_version DROP CONSTRAINT ordinary_storage_failure`; }
  assert.deepEqual(await counts(cmd.recordId), { signatures: 0, events: 0, drafts: 1, published: false });
});

test('T-RETRY duplicate clicks and a response lost after COMMIT return identical stored signature after restart', async () => {
  const cmd = await report('doctor-1');
  const [a,b] = await Promise.all([service.approval.approve(request('doctor-1'), cmd), service.approval.approve(request('doctor-1'), cmd)]);
  assert.deepEqual(a,b);
  assert.deepEqual(await core().approval.approve(request('doctor-1'), cmd), a);
  assert.deepEqual(await core().approval.result(request('doctor-1'), cmd.operationId), a);
  assert.equal((await counts(cmd.recordId)).signatures, 1);
  await assert.rejects(service.approval.approve(request('doctor-1'), { ...cmd, text: { ...cmd.text, findings: '다른 의도' } }), { code: 'SigningOperationConflict' });
  await assert.rejects(service.approval.result(request('doctor-2'), cmd.operationId), { code: 'SigningResultOwnerMismatch' });
});

test('T-RETRY transport failure after transaction COMMIT resolves without a new signature', async () => {
  const cmd = await report('doctor-1'), normal = ledger();
  const lost = core({ ledger: { async transactionWithRecords(work) {
    await normal.transactionWithRecords(work);
    throw new Error('CommitResponseLost');
  } } });
  await assert.rejects(lost.approval.approve(request('doctor-1'), cmd), /CommitResponseLost/);
  const resolved = await service.approval.result(request('doctor-1'),cmd.operationId);
  assert.ok(resolved);
  assert.deepEqual(await service.approval.approve(request('doctor-1'),cmd),resolved);
  assert.equal((await counts(cmd.recordId)).signatures,1);
});

test('T-ID current authority, session, online clinical capacity and patient/report basis are required', async () => {
  const cmd = await report('doctor-1');
  for (const change of [
    f => { f.actor.sessionState = 'ended'; }, f => { f.actor.canSign = false; }, f => { f.capacity = 'support'; },
    f => { f.actor.roles = ['admin']; }, f => { f.online = false; }, f => { f.actor.kind = 'service'; },
  ]) {
    const [saved] = await db.$queryRaw`SELECT facts FROM c2_fixture.member WHERE session_id='doctor-1'`;
    await setMember('doctor-1', change);
    try { await assert.rejects(service.approval.approve(request('doctor-1'), cmd), { code: 'OnlineDoctorApprovalRequired' }); }
    finally { await db.$executeRaw`UPDATE c2_fixture.member SET facts=${JSON.stringify(saved.facts)}::jsonb WHERE session_id='doctor-1'`; }
  }
  await assert.rejects(service.approval.approve(request('operator'), cmd));
  await assert.rejects(service.approval.approve(request('doctor-2'), cmd));
  await assert.rejects(service.approval.approve(request('doctor-1'), { ...cmd, patient: { ...cmd.patient, linkId: 'changed-link' } }), { code: 'SigningStudyConflict' });
  await assert.rejects(service.approval.approve(request('doctor-1'), { ...cmd, expectedClaimGeneration: 2 }), { code: 'SigningReportConflict' });
  await setMember('doctor-1', f => { f.actor.institutionId = 'hospital-2'; });
  try { await assert.rejects(service.approval.approve(request('doctor-1'),cmd), { code: 'SigningStudyConflict' }); }
  finally { await setMember('doctor-1', f => { f.actor.institutionId = 'hospital-1'; }); }
  await setMember('doctor-1', f => { f.actor.identity.subject = 'changed-account'; });
  try { await assert.rejects(service.approval.approve(request('doctor-1'),cmd), { code: 'DoctorSigningKeyUnavailable' }); }
  finally { await setMember('doctor-1', f => { f.actor.identity.subject = 'subject-doctor-1'; }); }
  await setMember('doctor-1', f => { f.actor.roles.push('admin'); });
  await service.approval.approve(request('doctor-1'), cmd);
  await setMember('doctor-1', f => { f.actor.roles = ['radiologist']; });
});

test('T-ID Preliminary author cannot self-approve; designated reviewer can', async () => {
  const cmd = await report('doctor-1', { state: 'Preliminary', claimantId: null, preliminary: { authorId: 'doctor-1', reviewerId: 'doctor-2' } });
  await assert.rejects(service.approval.approve(request('doctor-1'), cmd));
  const signed = await service.approval.approve(request('doctor-2'), cmd);
  assert.equal(signed.doctorId, 'doctor-2'); assert.equal(decoded(signed).author.id, 'doctor-1');
});

test('T-KEY revoke/replace issues a new kid while historic verification remains public-only', async () => {
  const cmd = await report('replacement'), original = await service.approval.approve(request('replacement'), cmd);
  const replacement = await manage('replacement', 'replace', original.kid);
  assert.notEqual(replacement.kid, original.kid);
  const history = await db.$transaction(tx => new OnlineSigningStore().history(tx, original.kid));
  assert.equal(history.at(-1).before,'active'); assert.equal(history.at(-1).after,'revoked');
  assert.equal(history.at(-1).actor.id,'operator');
  const next = await service.approval.approve(request('replacement'), await report('replacement'));
  assert.equal(next.kid, replacement.kid);
  assert.equal(verifyRegisteredServerEnvelope(original.envelope, original.keyAtSigning).integrity, 'valid');
  await manage('replacement', 'revoke', replacement.kid);
  await assert.rejects(service.approval.approve(request('replacement'), await report('replacement')), { code: 'DoctorSigningKeyUnavailable' });
  await db.$executeRaw`DELETE FROM emr_signing.private_key WHERE kid=${original.kid}`;
  assert.equal(verifyRegisteredServerEnvelope(original.envelope, original.keyAtSigning).integrity, 'valid');
  const fresh = await manage('replacement'); assert.notEqual(fresh.kid, replacement.kid);
});

test('T-KEY departure is rechecked in an established session and protected retry', async () => {
  const cmd = await report('departing'), signed = await service.approval.approve(request('departing'), cmd);
  await setMember('departing', f => { f.actor.canSign = false; });
  await assert.rejects(service.approval.approve(request('departing'), await report('departing')));
  await assert.rejects(service.approval.result(request('departing'), cmd.operationId));
  await manage('departing', 'revoke', signed.kid);
  assert.equal(verifyRegisteredServerEnvelope(signed.envelope, signed.keyAtSigning).registeredIdentity, 'matched');
});

test('T-KEY missing/wrong wrapping secret refuses new use; result lookup and public verification do not decrypt', async () => {
  const cmd = await report('doctor-1'), signed = await service.approval.approve(request('doctor-1'), cmd);
  const unavailable = core({ secrets: { currentId: 'c2-wrap-v1', read: async () => { throw new Error('NoSecret'); } } });
  assert.deepEqual(await unavailable.approval.result(request('doctor-1'), cmd.operationId), signed);
  await assert.rejects(unavailable.approval.approve(request('doctor-1'), await report('doctor-1')), /NoSecret/);
  const wrong = core({ secrets: { currentId: 'c2-wrap-v1', read: async () => crypto.randomBytes(32) } });
  await assert.rejects(wrong.approval.approve(request('doctor-1'), await report('doctor-1')));
});

test('T-TIME SQL lock delays actual signing; later typing survives clearing the submitted draft', async () => {
  const cmd = await report('doctor-1');
  let acquired, release;
  const locked = new Promise(r => { acquired = r; }), released = new Promise(r => { release = r; });
  const blocker = db.$transaction(async tx => {
    await tx.$queryRaw`SELECT record_id FROM c2_fixture.report WHERE record_id=${cmd.recordId} FOR UPDATE`;
    acquired(); await released;
  });
  await locked;
  const pending = service.approval.approve(request('doctor-1'), cmd);
  // Observe the database wait rather than assuming a timer means the signer reached the lock.
  let waiting = false;
  while (!waiting) {
    const rows = await db.$queryRaw`SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%c2_fixture.report%'`;
    waiting = rows.length > 0;
    if (!waiting) await new Promise(r => setTimeout(r, 10));
  }
  await db.$executeRaw`UPDATE c2_fixture.draft SET revision='draft-2' WHERE record_id=${cmd.recordId}`;
  const releaseTime = Date.now(); release(); await blocker;
  const signed = await pending;
  assert.equal(waiting, true); assert.ok(Date.parse(signed.signedAt) >= releaseTime);
  assert.equal((await counts(cmd.recordId)).drafts, 1);
});

test('T-KEY concurrent approval and revoke have one serial outcome', async () => {
  const cmd = await report('race');
  const key = await db.$transaction(tx => new OnlineSigningStore().currentKey(tx, 'hospital-1', 'race'));
  const [approve, revoke] = await Promise.allSettled([service.approval.approve(request('race'), cmd), manage('race','revoke',key.kid)]);
  assert.equal(revoke.status, 'fulfilled');
  if (approve.status === 'fulfilled') assert.equal(verifyRegisteredServerEnvelope(approve.value.envelope, approve.value.keyAtSigning).integrity, 'valid');
  else assert.equal(approve.reason.code, 'DoctorSigningKeyUnavailable');
  await assert.rejects(service.approval.approve(request('race'), await report('race')), { code: 'DoctorSigningKeyUnavailable' });
});

test('T-HISTORY addendum/cancellation preserve the exact original and reject a second approval', async () => {
  const cmd = await report('doctor-1'), first = await service.approval.approve(request('doctor-1'),cmd);
  await assert.rejects(service.approval.approve(request('doctor-1'), { ...cmd, operationId: crypto.randomUUID(), expectedClaimGeneration: 2, expectedPublishedVersionId: first.versionId }));
  const addendum = await service.approval.approve(request('doctor-1'), { ...cmd, operationId: crypto.randomUUID(), action: 'addendum',
    expectedClaimGeneration: 2, expectedPublishedVersionId: first.versionId, text: { ...cmd.text, findings: '추가 기재' } });
  assert.equal(decoded(addendum).previousVersion.versionId, first.versionId);
  await service.approval.approve(request('doctor-1'), { ...cmd, operationId: crypto.randomUUID(), action: 'cancel', reason: '잘못 연결한 합성 검사',
    expectedClaimGeneration: 2, expectedPublishedVersionId: addendum.versionId });
  assert.deepEqual(await service.approval.result(request('doctor-1'),cmd.operationId),first);
  assert.equal((await counts(cmd.recordId)).signatures,3);
});

test('T-LOG key custody changes remain non-clinical and carry real operator facts', async () => {
  const rows = await db.$queryRaw`SELECT stream,retention_class,payload::jsonb AS facts FROM emr_access.access_entry
    WHERE payload::jsonb->>'surface'='server:doctor-key-management'`;
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.stream, 'viewing');
    assert.equal(row.retention_class, 'rights3y');
    assert.equal(row.facts.userId.value.id, 'operator');
    assert.equal(row.facts.targets[0].kind, 'identity-access');
  }
});

test('T-RESTORE prepare a durable outcome and an offboarded doctor for the native pg_dump/restore phase', async () => {
  const cmd = await report('restored-doctor'), signed = await service.approval.approve(request('restored-doctor'), cmd);
  await setMember('restored-doctor', f => { f.actor.canSign = false; });
  const location = process.env.C2_TEST_EXPECTED_PATH;
  assert.ok(location); fs.mkdirSync(path.dirname(location), { recursive: true });
  fs.writeFileSync(location, JSON.stringify({ signed, cmd }));
});
} else {
test('T-RESTORE native backup restores exact signatures, wrapped keys, history, outcomes and current departure', async () => {
  const { signed, cmd } = JSON.parse(fs.readFileSync(process.env.C2_TEST_EXPECTED_PATH, 'utf8'));
  const restored = await db.$transaction(tx => new OnlineSigningStore().result(tx, cmd.operationId));
  assert.deepEqual(restored,signed);
  assert.equal(verifyRegisteredServerEnvelope(restored.envelope, restored.keyAtSigning).integrity, 'valid');
  await assert.rejects(service.approval.result(request('restored-doctor'),cmd.operationId));
  await assert.rejects(service.approval.approve(request('restored-doctor'), { ...cmd, operationId: crypto.randomUUID() }));
  // Restore orchestration reapplies a departure that occurred after the old active snapshot.
  await setMember('doctor-1', f => { f.actor.canSign = false; });
  await assert.rejects(service.approval.approve(request('doctor-1'), await report('doctor-1')));
  const active = await report('doctor-2');
  const approved = await service.approval.approve(request('doctor-2'),active);
  assert.equal(verifyRegisteredServerEnvelope(approved.envelope, approved.keyAtSigning).integrity, 'valid');
  const unavailable = core({ secrets: { currentId: 'c2-wrap-v1', read: async () => { throw new Error('SecretNotRestored'); } } });
  await assert.rejects(unavailable.approval.approve(request('doctor-2'), await report('doctor-2')), /SecretNotRestored/);
});
}
