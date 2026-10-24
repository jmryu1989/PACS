'use strict';
// D-T1/T2/T4/T5 -> unsigned/partial writes, duplicate approval, lost originals,
// and operational assignment receiving a medical signature. Real B2 PG and
// C2 ServerKeys/ServerSigning/public verification; session facts are synthetic.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID, randomBytes } = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const api = process.env.KIN_D_API || path.join(root, 'api');
const dist = path.join(api, 'dist');
const { PrismaClient } = require(path.join(api, 'node_modules/@prisma/client'));
const { AccessLedgerStore, LedgerFailure } = require(path.join(dist, 'emr-runtime/store'));
const { createRecordPort } = require(path.join(dist, 'emr-runtime/record-port'));
const { FailureJournal, FailureSpool } = require(path.join(dist, 'emr-runtime/failure-journal'));
const { ClinicalStore } = require(path.join(dist, 'emr-clinical/store'));
const { composeClinicalRuntime } = require(path.join(dist, 'emr-clinical/runtime'));
const { createOnlineClinicalServices } = require(path.join(dist, 'emr-clinical/services'));
const { readOnlineClinicalRecord } = require(path.join(dist, 'emr-clinical/response'));
const crypto = require(path.join(dist, 'emr-signature/server-crypto'));
const { OnlineSigningStore } = require(path.join(dist, 'emr-report/online-store'));
const { onlineClinicalSigner } = require(path.join(dist, 'emr-clinical/signing'));
const { verifyRegisteredServerEnvelope } = require(path.join(dist, 'emr-signature/server-verification'));
const restored = process.env.KIN_D_RESTORED === '1';
const clinicalTables = ['online_command', 'online_reference', 'online_version'];
const signingTables = ['doctor_key', 'key_history', 'operation', 'private_key', 'signed_version'];

async function restoreSnapshot(db) {
  const result = {};
  for (const [schema, tables] of [['emr_clinical', clinicalTables], ['emr_signing', signingTables]]) {
    const actual = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname=${schema} ORDER BY tablename`;
    assert.deepEqual(actual.map(row => row.tablename), tables);
    for (const table of tables) {
      const [row] = await db.$queryRawUnsafe(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"), '[]'::jsonb) AS rows FROM ${schema}.${table} t`);
      result[schema + '.' + table] = row.rows;
    }
  }
  return result;
}

if (!restored) {
test('D online exact versions, B2 result recovery and current access on PostgreSQL', async () => {
  const db = new PrismaClient(), witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_D_WITNESS_URL } } });
  const journal = new FailureJournal(db, new FailureSpool(process.env.KIN_D_SPOOL));
  const ledger = new AccessLedgerStore(db, journal);
  const { port } = createRecordPort(ledger);
  const storage = new ClinicalStore(db);
  const identity = { id: 'synthetic-doctor', issuer: 'synthetic-issuer', subject: 'synthetic-doctor' };
  const registration = 'synthetic-registration';
  const doctor = { identity, identityRegistrationId: registration, institutionId: 'synthetic-hospital', canSign: true };
  const actor = { identity, kind: 'member', roles: ['radiologist'], institutionId: doctor.institutionId,
    signingRegistrationId: registration };
  const study = { studyId: '1.2.826.0.1.3680043.10.900.1', managingInstitutionId: doctor.institutionId,
    patient: { linkId: 'synthetic-link', patientId: 'synthetic-patient', assigningAuthority: 'synthetic-hospital' } };
  let active = true, projectFailure = false, loseResponse = false, signCalls = 0;
  const facts = () => {
    if (!active) throw Object.assign(new Error('SessionEnded'), { code: 'SessionEnded' });
    return { actor: structuredClone(actor), requestId: randomUUID(), ip: { status: 'known', value: { address: '127.0.0.1', source: 'request-peer' } } };
  };
  const identities = { async resolve() { facts(); return { online: true, capacity: 'clinical',
    ingress: { requestId: randomUUID(), ip: { status: 'known', value: { address: '127.0.0.1', source: 'trusted-proxy' } } },
    actor: { identity, kind: 'member', roles: actor.roles, institutionId: doctor.institutionId, identityRegistrationId: registration,
      canSign: true, canCancel: true, rightsVersion: 'synthetic-rights', sessionState: 'active' } }; } };
  const wrap = randomBytes(32), keyStore = new OnlineSigningStore();
  const services = createOnlineClinicalServices({ records: port, store: storage, identity: identities,
    secrets: { currentId: 'synthetic-wrap', read: async () => Buffer.from(wrap) }, context: {
    async facts() { return facts(); },
    async study(_tx, _request, uid) { facts(); assert.equal(uid, study.studyId); return structuredClone(study); },
  }, async project(tx, _request, plan) {
    await tx.$executeRaw`INSERT INTO public.d_online_projection(version_id,body) VALUES (${plan.version.versionId},${plan.version.text})`;
    if (projectFailure) throw new Error('SyntheticProjectionFailure');
  } });
  const runtime = services.runtime, parts = runtime.parts;
  const actualSign = parts.signer.sign.bind(parts.signer);
  parts.signer.sign = async (...args) => { signCalls++; return actualSign(...args); };
  const empty = { content: null, attachments: [], navigation: [], readerId: null, workContext: null };
  const create = (reason = 'synthetic consultation') => ({ surface: 'consultation.create', studyId: study.studyId, recordId: randomUUID(),
    body: { requestId: randomUUID(), expectedOwner: [doctor.institutionId, identity.subject], recipientSub: 'synthetic-recipient', reason },
    prepare: async () => ({ ...empty, recipientId: 'synthetic-recipient', projection: null }) });
  const count = async table => Number((await witness.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${table}`))[0].n);
  try {
    await db.$connect(); await witness.$connect();
    const awaitingAdmission = port.begin();
    try { assert.equal(await awaitingAdmission.lookup(randomUUID()), null); }
    finally { awaitingAdmission.end(); }
    const pair = crypto.generateServerKeyPair(), kid = randomUUID();
    const key = { ...doctor, identity: { ...identity } };
    await keyStore.insertKey(witness, { kid, publicKey: pair.publicKey, doctor: key,
      status: 'active', registeredAt: new Date().toISOString(), endedAt: null },
    crypto.wrapServerPrivateKey(pair.privateKey, kid, 'synthetic-wrap', wrap));

    const first = create();
    const saved = await runtime.write({}, first);
    assert.equal(saved.status, 'committed');
    assert.equal(signCalls, 1);
    assert.equal(await count('emr_clinical.online_version'), 1);
    assert.equal(await count('public.d_online_projection'), 1);
    const history = await readOnlineClinicalRecord(parts, {}, 'consultation', first.recordId, 'history');
    assert.equal(history.bodies[0].text, first.body.reason);
    assert.equal(history.signatures[0].signature.registration.kid, kid);
    const originalEnvelope = JSON.stringify(history.signatures[0].signature.envelope);
    const replay = await runtime.write({}, first);
    assert.equal(replay.status, 'replayed');
    assert.deepEqual(replay.receipt, saved.receipt);
    assert.equal(signCalls, 1);
    await assert.rejects(runtime.write({}, { ...first, body: { ...first.body, reason: 'different request content' } }), /RequestIdReused/);

    const cancel = { ...first, surface: 'consultation.cancel', body: { requestId: randomUUID(),
      expectedOwner: first.body.expectedOwner, revision: 1, action: 'cancel', note: 'synthetic correction reason' },
      prepare: async () => ({ ...empty, recipientId: null, projection: null }) };
    assert.equal((await runtime.write({}, cancel)).status, 'committed');
    const reread = await readOnlineClinicalRecord(parts, {}, 'consultation', first.recordId, 'history');
    assert.deepEqual(reread.bodies.map(v => v.text), [first.body.reason, cancel.body.note]);
    assert.equal(JSON.stringify(reread.signatures[0].signature.envelope), originalEnvelope);

    const beforeVersions = await count('emr_clinical.online_version'), beforeProjections = await count('public.d_online_projection');
    projectFailure = true;
    await assert.rejects(runtime.write({}, create()), /SyntheticProjectionFailure/);
    projectFailure = false;
    assert.equal(await count('emr_clinical.online_version'), beforeVersions);
    assert.equal(await count('public.d_online_projection'), beforeProjections);

    // Fault injection after the real B2 COMMIT models a lost caller response.
    // Recovery reads PostgreSQL; it does not return a fabricated success receipt.
    const lossy = { begin() { const work = port.begin(); return { ...work, async transaction(...args) {
      const result = await work.transaction(...args); if (loseResponse) { loseResponse = false; throw new LedgerFailure('CommitUnknown'); } return result;
    } }; } };
    const lossyRuntime = composeClinicalRuntime({ ...parts, records: lossy });
    const lost = create('synthetic lost response'); loseResponse = true;
    const unknown = await lossyRuntime.write({}, lost);
    assert.equal(unknown.status, 'unknown');
    const callsAfterCommit = signCalls;
    assert.equal((await runtime.lookup({}, lost)).status, 'replayed');
    assert.equal((await runtime.write({}, lost)).status, 'replayed');
    assert.equal(signCalls, callsAfterCommit);

    const parallel = create('synthetic simultaneous delivery');
    const arrivals = await Promise.all([runtime.write({}, parallel), runtime.write({}, parallel)]);
    assert.equal(arrivals.every(v => ['committed', 'replayed', 'unknown'].includes(v.status)), true);
    assert.equal((await runtime.lookup({}, parallel)).status, 'replayed');
    assert.equal(signCalls, callsAfterCommit + 1);

    const beforeKeyFailure = await count('emr_clinical.online_version');
    await witness.$executeRaw`UPDATE emr_signing.doctor_key SET status='suspended' WHERE kid=${kid}`;
    await assert.rejects(runtime.write({}, create()), /DoctorSigningKeyUnavailable/);
    assert.equal(await count('emr_clinical.online_version'), beforeKeyFailure);
    // Historical verification uses the stored registration, even after replacement/restart.
    const restarted = composeClinicalRuntime({ ...parts, store: new ClinicalStore(db) });
    assert.equal((await restarted.lookup({}, first)).status, 'replayed');
    assert.equal((await readOnlineClinicalRecord(restarted.parts, {}, 'consultation', first.recordId, 'history')).bodies.length, 2);

    active = false;
    await assert.rejects(runtime.lookup({}, first), /SessionEnded/);
    await assert.rejects(readOnlineClinicalRecord(parts, {}, 'consultation', first.recordId, 'history'), /SessionEnded/);
    active = true;
    await witness.$executeRaw`UPDATE emr_signing.doctor_key SET status='active' WHERE kid=${kid}`;
    for (const [role, surface, body] of [
      ['clinician', 'question.create', { requestId: randomUUID(), expectedOwner: first.body.expectedOwner, body: '합성 임상의 질문' }],
      ['technician', 'tech-note.write', { attemptId: randomUUID(), baseVersion: 0, text: '합성 촬영 메모', reason: '' }],
    ]) {
      actor.roles = [role];
      const recordId = randomUUID(), beforeSign = signCalls;
      const result = await runtime.write({}, { surface, studyId: study.studyId, recordId, body,
        prepare: async () => ({ ...empty, recipientId: null, projection: null }) });
      assert.equal(result.status, 'committed'); assert.equal(signCalls, beforeSign + 1);
      const [row] = await witness.$queryRaw`SELECT signature FROM emr_clinical.online_version WHERE record_id=${recordId}`;
      const payload = JSON.parse(Buffer.from(JSON.parse(row.signature).envelope.payload, 'base64url').toString());
      assert.equal(payload.signer.id, identity.id); assert.equal(payload.recordId, recordId);
    }
    actor.roles = ['admin']; actor.signingRegistrationId = null;
    const assignment = { surface: 'assignment.write', studyId: study.studyId, recordId: randomUUID(), body: {
      requestId: randomUUID(), expectedOwner: first.body.expectedOwner, revision: 0, readerSub: null },
      prepare: async () => ({ ...empty, recipientId: null, projection: null }) };
    const noSignBefore = signCalls;
    assert.equal((await runtime.write({}, assignment)).status, 'committed');
    assert.equal(signCalls, noSignBefore);
    const rows = await witness.$queryRaw`SELECT signature FROM emr_clinical.online_version WHERE record_id=${assignment.recordId}`;
    assert.equal(rows[0].signature, null);

    study.teleInstitutionId = 'synthetic-receiver'; actor.institutionId = study.teleInstitutionId;
    const receiving = { ...assignment, recordId: randomUUID(), body: { ...assignment.body,
      requestId: randomUUID(), expectedOwner: [actor.institutionId, identity.subject] } };
    assert.equal((await runtime.write({}, receiving)).status, 'committed');
    assert.equal((await readOnlineClinicalRecord(parts, {}, 'assignment', receiving.recordId, 'current')).bodies[0].text, null);
    assert.equal(signCalls, noSignBefore);
    actor.institutionId = doctor.institutionId;
    await assert.rejects(readOnlineClinicalRecord(parts, {}, 'assignment', receiving.recordId, 'current'), /NotFound/);
    actor.institutionId = study.teleInstitutionId; study.teleInstitutionId = null;
    await assert.rejects(readOnlineClinicalRecord(parts, {}, 'assignment', receiving.recordId, 'current'), /NotFound/);
    await assert.rejects(runtime.write({}, receiving), /NotFound/);
    fs.writeFileSync(process.env.KIN_D_EXPECTED_PATH, JSON.stringify(await restoreSnapshot(witness)));
  } finally { wrap.fill(0); await journal.close(); await db.$disconnect(); await witness.$disconnect(); }
});
} else {
test('native restore preserves every C2/D table and verifies every historical clinical signature', async () => {
  const db = new PrismaClient({ datasources: { db: { url: process.env.KIN_D_WITNESS_URL } } });
  try {
    assert.deepEqual(await restoreSnapshot(db), JSON.parse(fs.readFileSync(process.env.KIN_D_EXPECTED_PATH, 'utf8')));
    const store = new ClinicalStore(db), signer = onlineClinicalSigner({ verifyRegisteredServerEnvelope });
    const rows = await db.$queryRaw`SELECT version_id FROM emr_clinical.online_version ORDER BY version_id`;
    assert.ok(rows.length > 0);
    for (const row of rows) {
      const version = await store.version(db, row.version_id);
      if (version.plan.signing) signer.verify(version.signature, version.plan.signing);
      else assert.equal(version.signature, null);
    }
  } finally { await db.$disconnect(); }
});
}
