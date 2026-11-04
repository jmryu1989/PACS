/* REQ-EMR-16 -> RISK-F-03/04 -> TEST-F-NATIVE-COPY-PG. REQ-EMR-17 -> TEST-F-NATIVE-RIGHTS-PG.
 * CD-09 F on an owned synthetic PostgreSQL database: native reports written by the real commit route (PacsController,
 * C2 signing, B2), Tech Notes written by the real D runtime, and the real F controller/service over the same Nest app.
 * Each case: input -> PostgreSQL witness of the branch (rows, advisory keys from pg_locks, blockers, NOWAIT probes)
 * -> product result. Only the OIDC transport and the Module A study/patient source are synthetic.
 */
'use strict';
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs'), path = require('node:path');
const api = process.env.KIN_F_API || path.resolve(__dirname, '../../../api');
const product = name => require(path.join(api, 'dist', name));
const dependency = name => require(path.join(api, 'node_modules', name));
dependency('reflect-metadata');
const { PrismaClient } = dependency('@prisma/client');
const jose = dependency('jose');
const { Module } = dependency('@nestjs/common');
const { NestFactory, APP_GUARD } = dependency('@nestjs/core');

const issuer = 'https://synthetic.invalid/realms/f-link', institution = 'synthetic-hospital';
const MEMBERS = { officer: ['admin'], 'fn-auditor': ['clinician'], 'fn-doctor': ['radiologist'], 'fn-tech': ['technician'] };
const sha = value => createHash('sha256').update(value).digest('hex');
const spool = process.env.KIN_F_SPOOL;
const evidence = {};
const note = (name, value) => { evidence[name] = value; fs.writeFileSync(path.join(spool, 'native-witness.json'), JSON.stringify(evidence, null, 2)); };
const ctx = {};

/** tests/emr/d/clinical_fixture.cjs with a no-op projector, so the D runtime can also write a Tech Note directly. */
async function clinicalFixture(db, records) {
  const { createOnlineClinicalServices, onlineClinicalProviders } = product('emr-clinical/services');
  const { ClinicalStore } = product('emr-clinical/store');
  const { OnlineSigningStore } = product('emr-report/online-store');
  const crypto = product('emr-signature/server-crypto');
  const wrap = randomBytes(32), registrations = new Map(), identities = {};
  const resolveId = async (tx, sub) => { const work = records.begin(); try { return await work.resolveIdentity(tx, issuer, sub); } finally { work.end(); } };
  for (const [sub, roles] of Object.entries(MEMBERS)) {
    const id = await db.$transaction(tx => resolveId(tx, sub));
    const doctor = { identity: { id, issuer, subject: sub }, identityRegistrationId: 'member:' + id, institutionId: institution,
      canSign: roles.some(r => ['radiologist', 'clinician', 'technician'].includes(r)) };
    registrations.set(id, doctor); identities[sub] = doctor.identity;
    const known = await db.$queryRaw`SELECT kid FROM emr_signing.doctor_key WHERE doctor_id=${id} AND status='active'`;
    if (doctor.canSign && !known.length) {
      const pair = crypto.generateServerKeyPair(), kid = randomUUID();
      await new OnlineSigningStore().insertKey(db, { kid, publicKey: pair.publicKey, doctor, status: 'active', registeredAt: new Date(Date.now() - 1000).toISOString(), endedAt: null },
        crypto.wrapServerPrivateKey(pair.privateKey, kid, 'fixture-wrap', wrap));
    }
  }
  const identity = {
    async resolve(tx, request) {
      const member = await tx.memberRights.findUnique({ where: { sub: request.sub ?? request.facts.subject } });
      if (!member || !member.approved || member.suspended) throw new Error('SyntheticAccountInactive');
      const id = await resolveId(tx, member.sub), doctor = registrations.get(id);
      return { online: true, capacity: doctor.canSign ? 'clinical' : 'operator',
        ingress: { requestId: randomUUID(), ip: { status: 'known', value: { address: '192.0.2.23', source: 'trusted-proxy' } } },
        actor: { identity: doctor.identity, kind: 'member', roles: member.roles, institutionId: member.institution,
          identityRegistrationId: doctor.identityRegistrationId, canSign: doctor.canSign, canCancel: doctor.canSign,
          rightsVersion: 'fixture:1', sessionState: 'active' } };
    },
    async doctor(_tx, inst, id) { const d = registrations.get(id); if (!d || d.institutionId !== inst) throw new Error('SyntheticDoctorMissing'); return d; },
  };
  const services = createOnlineClinicalServices({ records, store: new ClinicalStore(db), identity,
    secrets: { currentId: 'fixture-wrap', read: async () => Buffer.from(wrap) },
    context: {
      async facts(tx, request) {
        const current = await identity.resolve(tx, request);
        return { actor: { identity: current.actor.identity, kind: 'member', roles: current.actor.roles,
          institutionId: current.actor.institutionId, signingRegistrationId: current.actor.identityRegistrationId },
          requestId: current.ingress.requestId, ip: current.ingress.ip };
      },
      async scope(tx, request, uid) {
        const state = await tx.studyState.findUnique({ where: { uid } });
        if (!state || ![state.institutionId, state.teleInstitutionId].includes(request.institution ?? request.facts.institution)) product('emr-contract/validation').refuse('NotFound');
        return { studyId: uid, managingInstitutionId: state.institutionId, teleInstitutionId: state.teleInstitutionId };
      },
      async study(tx, request, uid) {
        const current = await this.scope(tx, request, uid);
        return { ...current, patient: patientOf(uid) };
      },
    }, async project() { return {}; },
  });
  return { services, providers: onlineClinicalProviders(services), identities };
}
const patientOf = uid => ({ linkId: 'fixture:' + uid, patientId: 'synthetic:' + uid, assigningAuthority: institution });

before(async () => {
  process.env.KIN_EMR_ENVIRONMENT = 'synthetic-test';
  const { EmrRuntime } = product('emr-runtime/application');
  const { EMR_RECORD_PORT } = product('emr-runtime/record-port');
  const { EMR_BACKGROUND_WORK } = product('emr-runtime/background-work');
  const { PrismaService } = product('prisma.service');
  const { AuthService } = product('auth.service');
  const { PresenceService } = product('presence.service');
  const { AuthGuard } = product('auth.guard');
  const { PacsController } = product('pacs.controller');
  const { PacsService } = product('pacs.service');
  const { StudyAccessService } = product('study-access.service');
  const { OrthancService } = product('orthanc.service');
  const { KeycloakService } = product('keycloak.service');
  const { FindingService } = product('finding.service');
  const { StudyTransferLocalService } = product('study-transfer-local.service');
  const { EmrAuditController } = product('emr-audit/audit.controller');
  const { EmrAuditService } = product('emr-audit/service');
  const { createRequestContext, REQUEST_CONTEXT_CAPTURE, REQUEST_CONTEXT_SOURCE } = product('emr-runtime/request-context');
  const { createRequestIngress } = product('emr-runtime/request-ingress');
  Object.assign(process.env, { KC_ISSUER: issuer, KC_AUDIENCE: 'kin-api', AUTH_REQUIRED: 'true',
    KIN_COOKIE_SECRET: randomUUID(), KC_WEB_SECRET: randomUUID(), PUBLIC_ORIGIN: 'https://synthetic.invalid' });
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  const jwk = { ...await jose.exportJWK(publicKey), kid: 'f-native', alg: 'RS256', use: 'sig' };
  ctx.provider = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise(resolve => ctx.provider.listen(0, '127.0.0.1', resolve));
  process.env.KC_JWKS_URL = 'http://127.0.0.1:' + ctx.provider.address().port + '/certs';
  ctx.tokens = {};
  for (const [sub, roles] of Object.entries(MEMBERS))
    ctx.tokens[sub] = await new jose.SignJWT({ email: sub + '@example.test', realm_access: { roles }, groups: ['/' + institution] })
      .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer).setSubject(sub).setAudience('kin-api')
      .setIssuedAt().setExpirationTime('30m').sign(privateKey);
  ctx.witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_F_WITNESS_URL } } });
  await ctx.witness.memberRightsImport.upsert({ where: { id: 'realm-v1' }, create: { id: 'realm-v1' }, update: {} });
  for (const [sub, roles] of Object.entries(MEMBERS))
    await ctx.witness.memberRights.upsert({ where: { sub }, update: {}, create: { sub, username: sub, email: sub + '@example.test',
      name: 'Synthetic ' + sub, emailVerified: true, approved: true, suspended: false, institution, roles } });
  ctx.runtime = new EmrRuntime(process.env.DATABASE_URL, path.join(spool, 'native-runtime'));
  await ctx.runtime.start();
  const clinical = await clinicalFixture(ctx.witness, ctx.runtime.port);
  ctx.clinical = clinical; ctx.identities = clinical.identities;
  const orthanc = { studyIdentityResources: async uid => [{ '0020000D': { Value: [uid] } }], studyIdentities: async () => [] };
  const requests = createRequestContext(createRequestIngress({ proxyPeers: ['127.0.0.1'] }), ctx.runtime.port);
  class NativeCopyFixture {}
  Module({ controllers: [PacsController, EmrAuditController], providers: [PrismaService, PacsService, AuthService, PresenceService, EmrAuditService,
    ...clinical.providers,
    { provide: REQUEST_CONTEXT_CAPTURE, useValue: requests.capture }, { provide: REQUEST_CONTEXT_SOURCE, useValue: requests.source },
    { provide: OrthancService, useValue: orthanc }, { provide: KeycloakService, useValue: {} }, { provide: FindingService, useValue: {} },
    { provide: StudyAccessService, useFactory: db => new StudyAccessService(db, orthanc, {}), inject: [PrismaService] },
    { provide: EMR_RECORD_PORT, useValue: ctx.runtime.port }, { provide: EMR_BACKGROUND_WORK, useValue: ctx.runtime.background.work },
    { provide: APP_GUARD, useClass: AuthGuard }, { provide: StudyTransferLocalService, useValue: {} }] })(NativeCopyFixture);
  ctx.app = await NestFactory.create(NativeCopyFixture, { logger: ['error'] });
  ctx.app.setGlobalPrefix('api'); await ctx.app.listen(0, '127.0.0.1');
  ctx.origin = await ctx.app.getUrl();
  // The installer's designation authority (link_live setUpClass) designates the auditor through the real route.
  const grant = await call('officer', 'POST', 'emr-audit/roster/fn-native-auditor', { kind: 'granted',
    subject: { issuer, subject: 'fn-auditor' }, scopes: ['disclosure'], validFrom: new Date(Date.now() - 1000).toISOString(), validUntil: null });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
});

after(async () => {
  if (ctx.app) await ctx.app.close();
  if (ctx.runtime) await ctx.runtime.stop(Date.now() + 10000);
  if (ctx.witness) await ctx.witness.$disconnect();
  if (ctx.provider) await new Promise(resolve => ctx.provider.close(resolve));
});

async function call(actor, method, route, body, origin = ctx.origin) {
  const r = await fetch(origin + '/api/' + route, { method, headers: { authorization: 'Bearer ' + ctx.tokens[actor],
    'content-type': 'application/json', 'x-real-ip': '192.0.2.23' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const audit = (method, route, body) => call('fn-auditor', method, 'emr-audit/' + route, body);
async function ok(method, route, body) { const r = await audit(method, route, body); assert.equal(r.status, 200, route + ' ' + JSON.stringify(r.body)); return r.body; }

// ---- native report writer through the real commit route
async function study() {
  const uid = '2.25.' + BigInt('0x' + randomUUID().replace(/-/g, '').slice(0, 15)).toString();
  const state = await ctx.witness.studyState.create({ data: { uid, institutionId: institution, ss: 'Verified' } });
  return { uid, revision: state.draftEpoch + ':0', version: 0 };
}
function commitBody(s, action, text) {
  return { expectedOwner: { institution, sub: 'fn-doctor', author: 'fn-doctor@example.test' }, baseVersion: s.version,
    findings: text, conclusion: text ? '합성 결론' : '', recommendation: '', citationIds: [], structureIds: [] };
}
async function draft(s, text) {
  const d = await call('fn-doctor', 'PUT', `studies/${s.uid}/report`, { ...commitBody(s, 'save', text), expectedRevision: s.revision });
  assert.equal(d.status, 200, JSON.stringify(d.body)); s.revision = d.body.revision;
}
async function commit(s, action, text = `${action} 합성 소견`, reason) {
  if (action !== 'reset') await draft(s, text);
  const r = await call('fn-doctor', 'POST', `studies/${s.uid}/report/commit`,
    { ...commitBody(s, action, text), expectedRevision: s.revision, action, ...(reason ? { reason } : {}) });
  assert.equal(r.status, 201, action + ' ' + JSON.stringify(r.body));
  s.revision = r.body.revision; s.version = r.body.state.version;
  return r.body;
}
async function techNote(uid, text = '합성 Tech Note', baseVersion = 0) {
  const result = await ctx.clinical.services.runtime.write({ sub: 'fn-tech', institution }, { surface: 'tech-note.write', studyId: uid, recordId: uid,
    body: { baseVersion, text, reason: baseVersion ? '합성 정정' : '', attemptId: randomUUID() },
    prepare: async () => ({ content: null, attachments: [], navigation: [], recipientId: null, readerId: null,
      workContext: { kind: 'acquisition', studyId: uid, referenceId: uid }, projection: null }) });
  assert.equal(result.status, 'committed', JSON.stringify(result));
  return result;
}
const versions = uid => ctx.witness.reportVersion.findMany({ where: { uid }, orderBy: { version: 'asc' } });
const signed = async uid => (await ctx.witness.$queryRaw`SELECT version_id, outcome FROM emr_signing.signed_version WHERE record_id=${uid}`)
  .map(r => r.outcome);
function copy(uid, recordKind, format = 'signed-electronic') {
  const at = new Date(Date.now() - 1000).toISOString();
  return { request: { requestId: 'fn-' + randomUUID(), receivedAt: at, patient: patientOf(uid), basis: { clauseId: 'medical:21.1', purpose: 'own records' },
    requester: { kind: 'patient', name: 'Synthetic patient', organization: null },
    evidence: [{ kind: 'identity-check', documentId: 'synthetic-identity-check', checkedBy: ctx.identities['fn-auditor'], checkedAt: at }],
    scope: [{ recordId: uid, versions: 'all', ...(recordKind ? { recordKind } : {}) }],
    delivery: format === 'signed-electronic' ? { recipient: 'Synthetic patient', method: 'electronic', format } : { recipient: 'Synthetic patient', method: 'in-person', format } },
    dueAt: new Date(Date.now() + 86400000).toISOString() };
}
const issuanceRows = requestId => ctx.witness.$queryRaw`SELECT issuance_id, body::jsonb AS body, xmin::text AS tx
  FROM emr_audit.issuance_event WHERE body::jsonb#>>'{manifest,requestId}'=${requestId} ORDER BY sequence`;
const copyRows = issuanceId => ctx.witness.$queryRaw`SELECT sha256, xmin::text AS tx FROM emr_audit.fixed_copy WHERE issuance_id=${issuanceId}`;

// ---- PostgreSQL lock witness (OR E5): advisory keys by hashtextextended(key,0) in pg_locks, waiters and their blockers.
const keys = { fixed: uid => JSON.stringify(['emr-fixed-record', uid]), request: id => JSON.stringify(['emr-f-request', id]),
  issuance: id => JSON.stringify(['emr-f-issuance', id]) };
async function lockRows(key) {
  return ctx.witness.$queryRaw`WITH k AS (SELECT hashtextextended(${key},0) AS h)
    SELECT l.pid::text AS pid, l.granted, pg_blocking_pids(l.pid)::text[] AS blockers, l.mode
    FROM pg_locks l, k WHERE l.locktype='advisory' AND l.objsubid=1
      AND l.classid::text=((k.h >> 32) & 4294967295)::text AND l.objid::text=(k.h & 4294967295)::text`;
}
async function until(what, probe, ms = 2500) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error('Witness did not observe: ' + what);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
const waiterOn = (key, blocker) => until('waiter on ' + key + ' blocked by ' + blocker, async () =>
  (await lockRows(key)).find(r => !r.granted && r.blockers.includes(blocker)));
const holderOf = async key => (await lockRows(key)).find(r => r.granted)?.pid ?? null;
/** A witness transaction holding one lock until released; its backend PID is the blocker to look for. */
function hold(take) {
  let release, ready, failed;
  const pid = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
  const released = new Promise(resolve => { release = resolve; });
  const done = ctx.witness.$transaction(async tx => {
    await take(tx);
    const [p] = await tx.$queryRaw`SELECT pg_backend_pid()::text AS pid`;
    ready(p.pid); await released;
  }, { timeout: 30000, maxWait: 5000 }).catch(error => { failed(error); throw error; });
  return { pid, release: async () => { release(); await done; } };
}
const holdKey = key => hold(tx => tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))::text`);
const holdTable = table => hold(tx => tx.$executeRawUnsafe(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`));
/** NOWAIT probe on the StudyState row, always rolled back: true when another transaction holds it. */
async function studyStateHeld(uid) {
  try {
    await ctx.witness.$transaction(async tx => {
      await tx.$queryRaw`SELECT uid FROM "StudyState" WHERE uid=${uid} FOR UPDATE NOWAIT`;
      throw Object.assign(new Error('probe rollback'), { probe: true });
    });
  } catch (error) {
    if (error.probe) return false;
    if (/55P03|could not obtain lock/.test(String(error.message) + JSON.stringify(error.meta ?? {}))) return true;
    throw error;
  }
}

// =====================================================================================================================
test('FT1 native head chain from the real commit route is prepared, issued, reopened and decided', async () => {
  const a = await study(); await commit(a, 'save', '저장 소견'); await commit(a, 'approve', '확정 소견'); await commit(a, 'addendum', '추가 소견');
  const b = await study(); await commit(b, 'approve', '첫 소견'); await commit(b, 'reset', '', '합성 정정');
  await commit(b, 'save', '다시 저장'); await commit(b, 'approve', '다시 확정');
  for (const s of [a, b]) {
    const rows = await versions(s.uid), head = rows.filter(r => r.action !== 'discarded'), outcomes = await signed(s.uid);
    const { verifyRegisteredServerEnvelope } = product('emr-signature/server-verification');
    // Independent check of the native contract: each signed version names the previous head row digest.
    for (const outcome of outcomes) {
      const p = verifyRegisteredServerEnvelope(outcome.envelope, outcome.keyAtSigning).payload;
      const index = head.findIndex(r => String(r.version) === outcome.versionId), prior = head[index - 1];
      assert.ok(index >= 0, 'signature on a head row');
      assert.deepEqual(p.previousVersion, prior ? { recordId: s.uid, versionId: String(prior.version), sha256: sha(JSON.stringify(prior)) } : null);
    }
    note('ft1-' + s.uid, { rows: rows.map(r => [r.version, r.action]), signed: outcomes.map(o => o.versionId) });
    const prepared = await audit('POST', 'issuances', copy(s.uid));
    assert.equal(prepared.status, 200, 'F-1: ' + JSON.stringify(prepared.body));
    const record = prepared.body.manifest.records[0];
    assert.deepEqual(record.versions.map(v => [v.versionId, v.act, v.signature !== null]),
      head.map(r => [String(r.version), r.action, outcomes.some(o => o.versionId === String(r.version))]));
    const issued = await ok('POST', `issuances/${encodeURIComponent(prepared.body.issuanceId)}/issue`);
    const originals = JSON.parse(Buffer.from(issued.artifact, 'base64')).originals;
    for (const [i, v] of record.versions.entries()) {
      const outcome = outcomes.find(o => o.versionId === v.versionId);
      if (outcome) assert.deepEqual(JSON.parse(originals[i].original), outcome);
      else assert.deepEqual(JSON.parse(JSON.parse(originals[i].original).reportVersion), JSON.parse(JSON.stringify(head[i])));
    }
    const read = await ok('GET', `issuances/${encodeURIComponent(prepared.body.issuanceId)}`);
    assert.equal(read.artifact, issued.artifact); assert.equal(sha(Buffer.from(read.artifact, 'base64')), read.sha256);
  }
  const rights = await audit('POST', 'rights-requests', { requestId: 'fn-r-' + randomUUID(), kind: 'correction', receivedAt: new Date(Date.now() - 1000).toISOString(),
    patient: patientOf(a.uid), recordIds: [a.uid], statement: '합성 정정 요구' });
  assert.equal(rights.status, 200, JSON.stringify(rights.body));
  const decided = await ok('POST', `rights-requests/${encodeURIComponent(rights.body.request.requestId)}/decide`);
  assert.deepEqual(decided.decision.records.map(r => [r.recordId, r.outcome]), [[a.uid, 'correct-by-new-signed-version']]);
});

test('FT2 native boundaries refuse save-only, unsigned confirmed and orphan evidence before any issuance', async () => {
  const cases = [
    ['save only', async s => { await commit(s, 'save', '저장만'); }, 'VersionListingIncomplete'],
    ['unsigned addendum row', async s => {
      await commit(s, 'approve', '확정');
      await ctx.witness.reportVersion.create({ data: { uid: s.uid, version: 2, action: 'addendum', findings: '서명 없는 추가', author: 'fn-doctor@example.test' } });
      await ctx.witness.report.update({ where: { uid: s.uid }, data: { version: 2 } });
    }, 'SignatureEvidenceRequired'],
    ['signature with no head row', async s => {
      await commit(s, 'approve', '확정');
      const [o] = await signed(s.uid);
      await ctx.witness.$executeRaw`INSERT INTO emr_signing.signed_version(record_id,version_id,kid,outcome)
        VALUES (${s.uid},'9',${o.kid},${JSON.stringify({ ...o, versionId: '9' })}::jsonb)`;
    }, 'SignatureEvidenceMismatch'],
  ];
  for (const [name, arrange, code] of cases) {
    const s = await study(); await arrange(s);
    const input = copy(s.uid), prepared = await audit('POST', 'issuances', input);
    assert.deepEqual([prepared.status, prepared.body.code], [409, code], name);
    assert.equal((await issuanceRows(input.request.requestId)).length, 0, name + ': no issuance');
    assert.equal(Number((await ctx.witness.$queryRaw`SELECT count(*)::int AS n FROM emr_audit.request_event WHERE request_id=${input.request.requestId}`)[0].n), 1,
      name + ': the intake and its hold stay committed');
  }
});

test('FT3 one Study UID with a Tech Note and a report: recordKind selects, an unselected request is refused', async () => {
  const s = await study(); await techNote(s.uid); await commit(s, 'approve', '판독 소견');
  const both = await ctx.witness.$queryRaw`SELECT (SELECT count(*) FROM emr_clinical.online_version WHERE record_id=${s.uid})::int AS clinical,
    (SELECT count(*) FROM emr_signing.signed_version WHERE record_id=${s.uid})::int AS report`;
  assert.ok(both[0].clinical > 0 && both[0].report > 0, 'witness: both stores hold the UID');
  const unselected = copy(s.uid), refused = await audit('POST', 'issuances', unselected);
  assert.deepEqual([refused.status, refused.body.code], [409, 'RecordKindAmbiguous'], JSON.stringify(refused.body));
  assert.equal(Number((await ctx.witness.$queryRaw`SELECT count(*)::int AS n FROM emr_audit.request_event WHERE request_id=${unselected.request.requestId}`)[0].n), 0);
  const report = await ok('POST', 'issuances', copy(s.uid, 'report'));
  assert.equal(report.manifest.records[0].recordKind, 'report');
  assert.deepEqual(report.manifest.records[0].versions.map(v => v.act), ['approve']);
  const clinical = await ok('POST', 'issuances', copy(s.uid, 'clinical'));
  assert.equal(clinical.manifest.records[0].recordKind, 'clinical');
  const stored = await ctx.witness.$queryRaw`SELECT body FROM emr_clinical.online_version WHERE record_id=${s.uid} ORDER BY sequence`;
  assert.deepEqual(clinical.manifest.records[0].versions.map(v => v.versionId), stored.map(r => JSON.parse(r.body).version.versionId));
  const rightsRefused = await audit('POST', 'rights-requests', { requestId: 'fn-r-' + randomUUID(), kind: 'correction',
    receivedAt: new Date(Date.now() - 1000).toISOString(), patient: patientOf(s.uid), recordIds: [s.uid], statement: '합성' });
  assert.deepEqual([rightsRefused.status, rightsRefused.body.code], [409, 'RecordKindAmbiguous']);
  const selected = await ok('POST', 'rights-requests', { requestId: 'fn-r-' + randomUUID(), kind: 'correction',
    receivedAt: new Date(Date.now() - 1000).toISOString(), patient: patientOf(s.uid), recordIds: [{ recordId: s.uid, recordKind: 'clinical' }], statement: '합성' });
  assert.deepEqual([selected.request.recordIds, selected.request.recordKinds], [[s.uid], { [s.uid]: 'clinical' }]);
  const decided = await ok('POST', `rights-requests/${encodeURIComponent(selected.request.requestId)}/decide`);
  assert.equal(decided.decision.records[0].recordKind, 'clinical');
  const holds = await ctx.witness.$queryRaw`SELECT DISTINCT record_id FROM emr_access.legal_hold_event
    WHERE body::jsonb#>>'{basis,requestId}'=${report.manifest.requestId}`;
  assert.deepEqual(holds.map(h => h.record_id), [s.uid], 'the hold keeps the plain record ID');
});

test('FT4 a report head moved after prepare refuses the first issue and is prepared again', async () => {
  const s = await study(); await commit(s, 'approve', '확정');
  const input = copy(s.uid, 'report'), stale = await ok('POST', 'issuances', input);
  await commit(s, 'addendum', '추가');
  assert.equal((await signed(s.uid)).length, 2, 'witness: the addendum signature committed before issue');
  const refused = await audit('POST', `issuances/${encodeURIComponent(stale.issuanceId)}/issue`);
  assert.deepEqual([refused.status, refused.body.code], [409, 'RecordHeadChanged']);
  const fresh = await ok('POST', 'issuances', input);
  assert.notEqual(fresh.issuanceId, stale.issuanceId);
  assert.equal((await issuanceRows(input.request.requestId)).filter(r => r.issuance_id === stale.issuanceId).at(-1).body.events.at(-1).kind, 'aborted');
  await techNote(s.uid);
  // A Tech Note under the same UID does not move the selected report.
  await ok('POST', `issuances/${encodeURIComponent(fresh.issuanceId)}/issue`);
});

test('FT5 a resolved request issues no new copy (sequential)', async () => {
  for (const outcome of ['lawfully-refused', 'withdrawn']) {
    const s = await study(); await commit(s, 'approve', '확정');
    const input = copy(s.uid), prepared = await ok('POST', 'issuances', input);
    await ok('POST', `requests/${encodeURIComponent(input.request.requestId)}/resolve`, { outcome, evidenceId: 'fn-end' });
    const rows = await issuanceRows(input.request.requestId);
    note('ft5-' + outcome, rows.map(r => r.body.events.map(e => e.kind)));
    const issue = await audit('POST', `issuances/${encodeURIComponent(prepared.issuanceId)}/issue`);
    assert.deepEqual([issue.status, issue.body.code], [409, 'RequestAlreadyResolved'], outcome + ' F-3: ' + JSON.stringify(issue.body).slice(0, 200));
    assert.equal((await copyRows(prepared.issuanceId)).length, 0);
    assert.equal(rows.at(-1).body.events.at(-1).kind, 'aborted', outcome + ': prepared copy aborted by the resolution');
    const again = await audit('POST', 'issuances', input);
    assert.deepEqual([again.status, again.body.code], [409, 'RequestAlreadyResolved']);
  }
});

test('FT6 resolve and issue of one request serialize on request -> issuance -> fixed record', async () => {
  // (a) the resolution first: it holds request and issuance and waits on the record; issue waits on the request.
  {
    const s = await study(); await commit(s, 'approve', '확정');
    const input = copy(s.uid), prepared = await ok('POST', 'issuances', input), id = prepared.issuanceId, requestId = input.request.requestId;
    const holder = holdKey(keys.fixed(s.uid)), blocker = await holder.pid;
    let resolve, issue;
    try {
      resolve = audit('POST', `requests/${encodeURIComponent(requestId)}/resolve`, { outcome: 'withdrawn', evidenceId: 'fn-race-a' });
      const resolver = (await waiterOn(keys.fixed(s.uid), blocker)).pid;
      assert.equal(await holderOf(keys.request(requestId)), resolver, 'the resolution holds the request');
      assert.equal(await holderOf(keys.issuance(id)), resolver, 'the resolution holds the issuance before the record');
      issue = audit('POST', `issuances/${encodeURIComponent(id)}/issue`);
      const issuer = (await waiterOn(keys.request(requestId), resolver)).pid;
      note('ft6a', { blocker, resolver, issuer, fixed: await lockRows(keys.fixed(s.uid)), request: await lockRows(keys.request(requestId)) });
    } finally { await holder.release(); }
    const [resolved, issued] = await Promise.all([resolve, issue]);
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    assert.deepEqual([issued.status, issued.body.code], [409, 'RequestAlreadyResolved']);
    assert.equal((await copyRows(id)).length, 0);
    assert.equal((await issuanceRows(requestId)).at(-1).body.events.at(-1).kind, 'aborted');
  }
  // (b) the issue first: it holds request and issuance and waits on the record; the resolution waits on the request.
  {
    const s = await study(); await commit(s, 'approve', '확정');
    const input = copy(s.uid), prepared = await ok('POST', 'issuances', input), id = prepared.issuanceId, requestId = input.request.requestId;
    const holder = holdKey(keys.fixed(s.uid)), blocker = await holder.pid;
    let resolve, issue;
    try {
      issue = audit('POST', `issuances/${encodeURIComponent(id)}/issue`);
      const issuer = (await waiterOn(keys.fixed(s.uid), blocker)).pid;
      assert.equal(await holderOf(keys.request(requestId)), issuer, 'the issue holds the request');
      assert.equal(await holderOf(keys.issuance(id)), issuer, 'the issue holds the issuance');
      resolve = audit('POST', `requests/${encodeURIComponent(requestId)}/resolve`, { outcome: 'withdrawn', evidenceId: 'fn-race-b' });
      const resolver = (await waiterOn(keys.request(requestId), issuer)).pid;
      note('ft6b', { blocker, issuer, resolver });
    } finally { await holder.release(); }
    const [issued, resolved] = await Promise.all([issue, resolve]);
    assert.equal(issued.status, 200, JSON.stringify(issued.body)); assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    const [stored] = await copyRows(id);
    assert.equal(stored.sha256, issued.body.sha256);
    assert.equal((await issuanceRows(requestId)).at(-1).body.events.at(-1).kind, 'issued', 'an issued copy is not aborted');
  }
});

test('FT8a F first: a paused prepare holds the record; the native writer waits on it holding no StudyState', async () => {
  // Prepare is paused after the record lock: its issuance_event INSERT waits on a witness table lock.
  {
    const s = await study(); await commit(s, 'approve', '확정');
    const input = copy(s.uid, 'report');
    await ok('POST', 'requests', input);
    // Everything slow happens before the pause: B2 bounds each lock wait at 3 s.
    await draft(s, '경합 추가');
    const table = holdTable('emr_audit.issuance_event'); await table.pid;
    let prepare, writer;
    try {
      prepare = audit('POST', 'issuances', input);
      const preparer = await until('prepare holds the record', () => holderOf(keys.fixed(s.uid)));
      writer = call('fn-doctor', 'POST', `studies/${s.uid}/report/commit`, { ...commitBody(s, 'addendum', '경합 추가'), expectedRevision: s.revision, action: 'addendum' });
      const waiting = await waiterOn(keys.fixed(s.uid), preparer);
      const held = await studyStateHeld(s.uid);
      note('ft8-f-first', { preparer, writer: waiting.pid, studyStateHeldByWaitingWriter: held });
      assert.equal(held, false, 'the waiting writer took the fixed record before StudyState (W-R order)');
    } finally { await table.release(); }
    const [prepared, written] = await Promise.all([prepare, writer]);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body)); assert.equal(written.status, 201, JSON.stringify(written.body));
    s.revision = written.body.revision; s.version = written.body.state.version;
    assert.deepEqual(prepared.body.manifest.records[0].versions.map(v => v.act), ['approve'], 'prepared before the addendum');
    const issue = await audit('POST', `issuances/${encodeURIComponent(prepared.body.issuanceId)}/issue`);
    assert.deepEqual([issue.status, issue.body.code], [409, 'RecordHeadChanged']);
  }
});

test('FT8b writer first: a paused native addendum holds the record; prepare waits and then reads the new head', async () => {
  // The addendum is paused at its ReportVersion INSERT.
  {
    const s = await study(); await commit(s, 'approve', '확정');
    const input = copy(s.uid, 'report');
    await ok('POST', 'requests', input);
    await draft(s, '먼저 추가');
    const table = holdTable('"ReportVersion"'); const tablePid = await table.pid;
    let prepare, writer;
    try {
      writer = call('fn-doctor', 'POST', `studies/${s.uid}/report/commit`, { ...commitBody(s, 'addendum', '먼저 추가'), expectedRevision: s.revision, action: 'addendum' });
      const writing = await until('writer holds the record', () => holderOf(keys.fixed(s.uid)));
      prepare = audit('POST', 'issuances', input);
      const waiting = await waiterOn(keys.fixed(s.uid), writing);
      note('ft8-writer-first', { tablePid, writer: writing, preparer: waiting.pid });
    } finally { await table.release(); }
    const [written, prepared] = await Promise.all([writer, prepare]);
    assert.equal(written.status, 201, JSON.stringify(written.body)); assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    assert.deepEqual(prepared.body.manifest.records[0].versions.map(v => v.act), ['approve', 'addendum'], 'the new head is prepared');
  }
});

test('FT8c a Tech Note write waits on the record held by a paused F prepare of the same UID, then both commit', async () => {
  {
    const s = await study(); await techNote(s.uid);
    const input = copy(s.uid, 'clinical');
    await ok('POST', 'requests', input);
    const table = holdTable('emr_audit.issuance_event'); await table.pid;
    let prepare, writing;
    try {
      prepare = audit('POST', 'issuances', input);
      const preparer = await until('prepare holds the record', () => holderOf(keys.fixed(s.uid)));
      writing = techNote(s.uid, '경합 Tech Note', 1).then(() => 'committed', error => error);
      const waiting = await waiterOn(keys.fixed(s.uid), preparer);
      note('ft8-tech-note', { preparer, techNote: waiting.pid });
    } finally { await table.release(); }
    const prepared = await prepare;
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    assert.equal(await writing, 'committed');
  }
});

test('FT7 a rights decision and a native addendum meet on the fixed record in both orders', async () => {
  const receive = async uid => ok('POST', 'rights-requests', { requestId: 'fn-r-' + randomUUID(), kind: 'correction',
    receivedAt: new Date(Date.now() - 1000).toISOString(), patient: patientOf(uid), recordIds: [{ recordId: uid, recordKind: 'report' }], statement: '합성' });
  // Decision first: paused at its request_event INSERT after reading the record set; the addendum waits on the record.
  {
    const s = await study(); await commit(s, 'approve', '확정');
    const received = await receive(s.uid); await draft(s, '결정 중 추가');
    const table = holdTable('emr_audit.request_event'); await table.pid;
    let decide, writer;
    try {
      decide = audit('POST', `rights-requests/${encodeURIComponent(received.request.requestId)}/decide`);
      const decider = await until('decision holds the record', () => holderOf(keys.fixed(s.uid)));
      writer = call('fn-doctor', 'POST', `studies/${s.uid}/report/commit`, { ...commitBody(s, 'addendum', '결정 중 추가'), expectedRevision: s.revision, action: 'addendum' });
      const waiting = await waiterOn(keys.fixed(s.uid), decider);
      const held = await studyStateHeld(s.uid);
      note('ft7-decision-first', { decider, writer: waiting.pid, studyStateHeldByWaitingWriter: held });
      assert.equal(held, false, 'the waiting writer took the fixed record before StudyState (W-R order)');
    } finally { await table.release(); }
    const [decided, written] = await Promise.all([decide, writer]);
    assert.equal(decided.status, 200, JSON.stringify(decided.body)); assert.equal(written.status, 201, JSON.stringify(written.body));
    assert.equal(decided.body.decision.records[0].outcome, 'correct-by-new-signed-version');
  }
  // Addendum first: paused at its ReportVersion INSERT holding the record; the decision waits, then reads after it.
  {
    const s = await study(); await commit(s, 'approve', '확정');
    const received = await receive(s.uid); await draft(s, '먼저 추가');
    const table = holdTable('"ReportVersion"'); await table.pid;
    let decide, writer;
    try {
      writer = call('fn-doctor', 'POST', `studies/${s.uid}/report/commit`, { ...commitBody(s, 'addendum', '먼저 추가'), expectedRevision: s.revision, action: 'addendum' });
      const writing = await until('writer holds the record', () => holderOf(keys.fixed(s.uid)));
      decide = audit('POST', `rights-requests/${encodeURIComponent(received.request.requestId)}/decide`);
      const waiting = await waiterOn(keys.fixed(s.uid), writing);
      note('ft7-writer-first', { writer: writing, decider: waiting.pid });
    } finally { await table.release(); }
    const [written, decided] = await Promise.all([writer, decide]);
    assert.equal(written.status, 201, JSON.stringify(written.body)); assert.equal(decided.status, 200, JSON.stringify(decided.body));
  }
});

test('FT9 issue and withdrawal write their rows and B2 records in one transaction', async () => {
  const s = await study(); await commit(s, 'approve', '확정');
  const input = copy(s.uid), prepared = await ok('POST', 'issuances', input), id = prepared.issuanceId;
  await ok('POST', `issuances/${encodeURIComponent(id)}/issue`);
  const [copyRow] = await copyRows(id), rows = await issuanceRows(input.request.requestId);
  const issuedRow = rows.find(r => r.body.events.at(-1).kind === 'issued'), preparedRow = rows.find(r => r.body.events.at(-1).kind === 'prepared');
  const ledger = await ctx.witness.$queryRaw`SELECT o.xmin::text AS outcome_tx, array_agg(DISTINCT e.xmin::text) AS entry_tx, array_agg(DISTINCT r.xmin::text) AS receipt_tx
    FROM emr_access.attempt_outcome o JOIN emr_access.access_entry e ON e.operation_id=o.operation_id
    JOIN emr_access.entry_receipt r ON r.operation_id=o.operation_id
    WHERE o.outcome='committed' AND o.result_kind='emr-audit' AND o.result_id=${id} GROUP BY o.xmin::text`;
  note('ft9-issue', { copy: copyRow.tx, issued: issuedRow.tx, prepared: preparedRow.tx, ledger });
  const same = ledger.filter(l => l.outcome_tx === copyRow.tx);
  assert.equal(issuedRow.tx, copyRow.tx, 'issued event and stored bytes');
  assert.ok(same.length === 1 && same[0].entry_tx.every(x => x === copyRow.tx) && same[0].receipt_tx.every(x => x === copyRow.tx), 'disclosure record');
  // Negative control on the same check: the preparing transaction's row is a different transaction.
  assert.notEqual(preparedRow.tx, copyRow.tx, 'the xmin check separates transactions');

  const t = await study(); await commit(t, 'approve', '확정');
  const second = copy(t.uid), ready = await ok('POST', 'issuances', second), requestId = second.request.requestId;
  await ok('POST', `requests/${encodeURIComponent(requestId)}/resolve`, { outcome: 'withdrawn', evidenceId: 'fn-atomic' });
  const [request] = await ctx.witness.$queryRaw`SELECT xmin::text AS tx FROM emr_audit.request_event WHERE request_id=${requestId} ORDER BY sequence DESC LIMIT 1`;
  const aborted = (await issuanceRows(requestId)).find(r => r.issuance_id === ready.issuanceId && r.body.events.at(-1).kind === 'aborted');
  const holds = await ctx.witness.$queryRaw`SELECT hold_id, array_agg(xmin::text) AS txs FROM emr_access.legal_hold_event
    WHERE body::jsonb#>>'{basis,requestId}'=${requestId} GROUP BY hold_id`;
  const lifted = await ctx.witness.$queryRaw`SELECT o.xmin::text AS tx FROM emr_access.attempt_outcome o
    WHERE o.outcome='committed' AND o.result_kind='emr-audit' AND o.result_id=${requestId}`;
  note('ft9-withdrawn', { request: request.tx, aborted: aborted?.tx, holds, lifted });
  assert.equal(aborted.tx, request.tx, 'the prepared copy is aborted by the resolving transaction');
  assert.ok(holds.length && holds.every(h => h.txs.includes(request.tx)), 'hold releases');
  assert.ok(lifted.some(l => l.tx === request.tx), 'lift-legal-hold record');
});

test('FT10 a lost issue answer replays the same bytes; an uncommitted failure leaves nothing', async () => {
  // (a) Relay: hold the real status/body, see the committed rows from a separate connection, then drop only the delivery.
  const s = await study(); await commit(s, 'approve', '확정');
  const input = copy(s.uid), prepared = await ok('POST', 'issuances', input), id = prepared.issuanceId;
  const captured = {};
  const relay = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const upstream = await fetch(ctx.origin + req.url, { method: req.method, headers: { authorization: req.headers.authorization,
      'content-type': 'application/json', 'x-real-ip': '192.0.2.23' }, body: chunks.length ? Buffer.concat(chunks) : undefined });
    captured.status = upstream.status; captured.body = await upstream.text();
    const rows = await copyRows(id);
    captured.committedBeforeDrop = rows.length;
    res.socket.destroy();
  });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(call('fn-auditor', 'POST', `emr-audit/issuances/${encodeURIComponent(id)}/issue`, undefined, 'http://127.0.0.1:' + relay.address().port));
  } finally { await new Promise(resolve => relay.close(resolve)); }
  note('ft10a', { status: captured.status, committedBeforeDrop: captured.committedBeforeDrop, bodySha: sha(captured.body) });
  assert.equal(captured.status, 200); assert.equal(captured.committedBeforeDrop, 1, 'committed before the answer was lost');
  const replay = await ok('POST', `issuances/${encodeURIComponent(id)}/issue`);
  assert.equal(replay.artifact, JSON.parse(captured.body).artifact); assert.equal((await copyRows(id)).length, 1);
  // (b) An owned trigger fails the issued event INSERT: nothing of the issue commits; the next call creates it once.
  const t = await study(); await commit(t, 'approve', '확정');
  const second = copy(t.uid), ready = await ok('POST', 'issuances', second);
  await ctx.witness.$executeRawUnsafe(`CREATE FUNCTION public.fn_native_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.body::jsonb->'events'->-1->>'kind'='issued' THEN RAISE EXCEPTION 'fn-native synthetic failure'; END IF; RETURN NEW; END $$`);
  await ctx.witness.$executeRawUnsafe('CREATE TRIGGER fn_native_fail BEFORE INSERT ON emr_audit.issuance_event FOR EACH ROW EXECUTE FUNCTION public.fn_native_fail()');
  let failed;
  try { failed = await audit('POST', `issuances/${encodeURIComponent(ready.issuanceId)}/issue`); }
  finally {
    await ctx.witness.$executeRawUnsafe('DROP TRIGGER fn_native_fail ON emr_audit.issuance_event');
    await ctx.witness.$executeRawUnsafe('DROP FUNCTION public.fn_native_fail()');
  }
  note('ft10b', { status: failed.status, body: failed.body });
  assert.ok(failed.status >= 500, 'uncommitted failure is not a success');
  assert.equal((await copyRows(ready.issuanceId)).length, 0);
  await ok('POST', `issuances/${encodeURIComponent(ready.issuanceId)}/issue`);
  assert.equal((await copyRows(ready.issuanceId)).length, 1);
  // (c) A deferred constraint fails only at COMMIT: observed and recorded (WR-F1), not decided here.
  const u = await study(); await commit(u, 'approve', '확정');
  const third = copy(u.uid), late = await ok('POST', 'issuances', third);
  await ctx.witness.$executeRawUnsafe(`CREATE FUNCTION public.fn_native_late() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fn-native deferred failure'; END $$`);
  await ctx.witness.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER fn_native_late AFTER INSERT ON emr_audit.fixed_copy
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_native_late()`);
  let deferred;
  try {
    const [t1] = await ctx.witness.$queryRaw`SELECT tgdeferrable, tginitdeferred FROM pg_trigger WHERE tgname='fn_native_late'`;
    assert.deepEqual([t1.tgdeferrable, t1.tginitdeferred], [true, true]);
    deferred = await audit('POST', `issuances/${encodeURIComponent(late.issuanceId)}/issue`);
  } finally {
    await ctx.witness.$executeRawUnsafe('DROP TRIGGER fn_native_late ON emr_audit.fixed_copy');
    await ctx.witness.$executeRawUnsafe('DROP FUNCTION public.fn_native_late()');
  }
  const rows = await copyRows(late.issuanceId);
  const outcome = await ctx.witness.$queryRaw`SELECT outcome FROM emr_access.attempt_outcome WHERE result_kind='emr-audit' AND result_id=${late.issuanceId}`;
  note('ft10c-deferred-commit', { status: deferred.status, code: deferred.body?.code, copies: rows.length, outcomes: outcome.map(o => o.outcome),
    falseSuccess: deferred.status === 200 && rows.length === 0 });
  assert.equal(rows.length, 0, 'the failed COMMIT stored no bytes');
});

test('FT11/FT12 only the designated auditor issues; an issued copy is independent of later record changes', async () => {
  const s = await study(); await techNote(s.uid); await commit(s, 'save', '저장 <소견>'); await commit(s, 'approve', '확정 소견');
  const input = copy(s.uid, 'report', 'paper-print');
  for (const actor of ['fn-doctor', 'officer']) {
    const denied = await call(actor, 'POST', 'emr-audit/issuances', input);
    assert.equal(denied.status, 403, actor);
  }
  assert.equal((await issuanceRows(input.request.requestId)).length, 0);
  assert.equal(Number((await ctx.witness.$queryRaw`SELECT count(*)::int AS n FROM emr_audit.request_event WHERE request_id=${input.request.requestId}`)[0].n), 0);
  const prepared = await ok('POST', 'issuances', input);
  const issued = await ok('POST', `issuances/${encodeURIComponent(prepared.issuanceId)}/issue`);
  const [stored] = await copyRows(prepared.issuanceId);
  const html = Buffer.from(issued.artifact, 'base64').toString('utf8');
  fs.writeFileSync(path.join(spool, 'native-fixed-copy.html'), html);
  assert.equal(stored.sha256, sha(Buffer.from(issued.artifact, 'base64')));
  const [grants] = await ctx.witness.$queryRaw`SELECT has_table_privilege('kin_runtime','emr_audit.fixed_copy','SELECT') AS s,
    has_table_privilege('kin_runtime','emr_audit.fixed_copy','INSERT') AS i, has_table_privilege('kin_runtime','emr_audit.fixed_copy','UPDATE') AS u,
    has_table_privilege('kin_runtime','emr_audit.fixed_copy','DELETE') AS d, has_table_privilege('kin_runtime','emr_audit.fixed_copy','TRUNCATE') AS t`;
  assert.deepEqual(grants, { s: true, i: true, u: false, d: false, t: false }, 'the runtime can only read and add copies');
  await commit(s, 'addendum', '발급 뒤 추가'); await techNote(s.uid, '발급 뒤 Tech Note', 1);
  const read = await ok('GET', `issuances/${encodeURIComponent(prepared.issuanceId)}`);
  assert.equal(read.artifact, issued.artifact); assert.equal(read.sha256, stored.sha256);
  assert.equal((await ok('POST', `issuances/${encodeURIComponent(prepared.issuanceId)}/issue`)).artifact, issued.artifact);
});
