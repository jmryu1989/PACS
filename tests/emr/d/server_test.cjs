/* EMR-D round 2 server side, pure halves: REQ-EMR-01/03/04/05/07/10/17 -> RISK-D-01..04 -> TEST-D-01 clinical_vs_operational,
 * TEST-D-02 versions_and_sr, TEST-D-03 read_scope, TEST-D-04 atomic_retry (server cases). The database, ledger and service
 * halves are the live suite tests/emr/d/live.py (EmrDLive); TEST-D-05 ui_reopen is the page round's.
 *
 * What runs here is the product code itself, compiled by the installed TypeScript with api/tsconfig.json: C's v2
 * verification through D's signature port (api/src/emr-clinical/signing.ts) with real P-256 signatures of a test-only
 * device (tests/emr/d/device.cjs, explicit test key policy), the change event a commit appends (store.ts), the
 * composition and its refusal (runtime.ts), and the six owning services refusing before any database work while nothing is
 * composed. Assertions are on returned facts, error codes and the absence of side effects, never on implementation text.
 * The declaration emr/units/d.json is compared with the cases collected by the installed TypeScript and Python parsers.
 * Synthetic data only.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = process.env.KIN_EMR_D_ROOT || path.resolve(__dirname, '..', '..', '..');
const api = path.join(root, 'api');
const SRC = path.resolve(process.env.KIN_EMR_D_API_SRC || path.join(api, 'src'));
const ts = require(path.join(api, 'node_modules/typescript'));
const config = ts.readConfigFile(path.join(api, 'tsconfig.json'), ts.sys.readFile);
assert.equal(config.error, undefined);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, api).options;
const compileTs = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
  { compilerOptions: options, fileName: filename }).outputText, filename);
const previousLoader = require.extensions['.ts'];
require.extensions['.ts'] = compileTs;
require(path.join(api, 'node_modules/reflect-metadata'));
const load = file => require(path.join(SRC, file));
const A = load('emr-contract/access-event.ts');
const V = load('emr-contract/validation.ts');
const R = load('emr-clinical/records.ts');
const SG = load('emr-clinical/signing.ts');
const ST = load('emr-clinical/store.ts');
const RT = load('emr-clinical/runtime.ts');
const SV = load('emr-clinical/services.ts');
const SOURCES = load('emr-clinical/sources.ts');
const COMPOSITION = load('emr-contract/composition.ts');
const B_ADAPTERS = load('emr-runtime/context.ts').runtimeAdapters;
const K = load('emr-signature/keys.ts');
const CV = load('emr-signature/canonical-v2.ts');
const { ClinicianQuestionService } = load('clinician-question.service.ts');
const { ImageRequestService } = load('image-request.service.ts');
const { ConsultationService } = load('consultation.service.ts');
const { FindingService } = load('finding.service.ts');
const { ManualSrService } = load('manual-sr.service.ts');
const { ReaderAssignmentService } = load('reader-assignment.service.ts');
if (previousLoader) require.extensions['.ts'] = previousLoader; else delete require.extensions['.ts'];
const device = require('./device.cjs')({ K, CV });

const who = id => ({ id, issuer: 'https://identity.example.test', subject: 'sub-' + id });
const actor = (id, roles, institutionId = 'inst-a') => ({ identity: who(id), kind: 'member', roles, institutionId, signingRegistrationId: 'reg-' + id });
const patient = { linkId: 'link-1', patientId: 'SYN-1', assigningAuthority: 'hospital-a' };
const study = { studyId: '1.2.840.99.1', managingInstitutionId: 'inst-a', patient };
const owner = a => [a.institutionId, a.identity.subject];
const c1 = actor('11111111-1111-4111-8111-111111111111', ['clinician']);
const r1 = actor('22222222-2222-4222-8222-222222222222', ['radiologist']);
const t1 = actor('33333333-3333-4333-8333-333333333333', ['technician']);
for (const a of [c1, r1]) device.register(a.identity, a.signingRegistrationId, a.institutionId);
// Exact text with CRLF, a decomposed character and a trailing space: the signed bytes are the text as written.
const Q = 'SYN 흉통 지속\r\n이전 CT와 비교 바랍니다 é ';
const input = (surface, a, unit, body, extra = {}) => ({ surface, actor: a, study, unit, body, content: null, attachments: [], navigation: [],
  recipientId: null, readerId: null, workContext: null, ids: { recordId: unit ? unit.recordId : body.requestId, versionId: randomUUID() },
  at: new Date().toISOString(), ...extra });
const question = (a = c1) => { const body = { requestId: randomUUID(), expectedOwner: owner(a), body: Q }; return R.planClinicalWrite(input('question.create', a, null, body)); };
const carried = (plan, a, options = {}) => ({ ...device.sign(plan.signing, { kid: 'kid-' + a.identity.id, eventId: plan.requestId, ...options }), eventId: plan.requestId });
const portFor = signed => SG.deviceSignaturePort(device.ports, () => signed);
const refusedAsync = async (promise, code, message) => assert.rejects(promise, e => e instanceof V.ContractError && e.code === code, message);
const known = value => ({ status: 'known', value });
const facts = (a, reading = false) => ({ event: { rolesAtTime: a.roles, trustedProxyIp: known({ address: '10.0.0.7', source: 'trusted-proxy' }),
  requestId: 'request-' + randomUUID(), reading }, projection: {} });

// ---------------- TEST-D-01 / TEST-D-04: the device signature through C's verification ----------------

test('TEST-D-01 clinical_vs_operational server: the author\'s device signature over the planned entry is accepted for that author only', async () => {
  const plan = question();
  assert.equal(plan.signing.signer.id, c1.identity.id, 'the planned signer is the author');
  const signed = carried(plan, c1), port = portFor(signed);
  const envelope = await port.sign(plan.signing, { originalId: 'original-1' });
  const evidence = await port.verify(envelope, plan.signing);
  assert.deepEqual(R.acceptSignature(plan, evidence), evidence, 'records.ts accepts exactly this evidence');
  assert.deepEqual([evidence.versionSha256, evidence.signer.id, evidence.verification.keyAtSigningTime],
    [plan.version.sha256, c1.identity.id, 'active']);
  // The signed bytes are the author's text as written (CRLF, decomposed character and trailing space kept).
  const signedText = JSON.parse(Buffer.from(envelope.jws.payload, 'base64url').toString('utf8')).text.body;
  assert.equal(signedText, Q);
  // Another registered person signing the clinician's entry is a proxy: refused, no evidence.
  const proxy = { ...device.sign(plan.signing, { kid: 'kid-' + r1.identity.id, eventId: plan.requestId,
    change: p => ({ ...p, signer: { ...r1.identity }, identityRegistrationId: r1.signingRegistrationId }) }), eventId: plan.requestId };
  await refusedAsync(portFor(proxy).verify(await portFor(proxy).sign(plan.signing, { originalId: 'o' }), plan.signing), 'SignatureBindingRefused',
    'a radiologist cannot sign the clinician\'s question');
  // The author's identity in the payload but another person's key: C refuses the registration binding.
  const borrowed = { ...device.sign(plan.signing, { kid: 'kid-' + r1.identity.id, eventId: plan.requestId,
    change: p => ({ ...p }) }), eventId: plan.requestId };
  await assert.rejects(portFor(borrowed).verify(await portFor(borrowed).sign(plan.signing, { originalId: 'o' }), plan.signing),
    e => e instanceof V.ContractError && ['SignerIdentityRefused', 'SignatureBindingRefused'].includes(e.code));
  // An operational step (technician acceptance of an image request) asks for no signature at all.
  const created = R.applyPlan(null, R.planClinicalWrite(input('image-request.create', c1, null, { requestId: randomUUID(), expectedOwner: owner(c1),
    kind: 'external-image', counterparty: 'SYN 외부병원', counterpartyInstitutionId: null, reason: Q })));
  const accepted = R.planClinicalWrite(input('image-request.accept', t1, created, { requestId: randomUUID(), expectedOwner: owner(t1), revision: 1,
    action: 'accept', note: '' }));
  assert.equal(accepted.signing, null, 'an operational acceptance has no signing request');
});

test('TEST-D-04 atomic_retry server: an absent, altered, held, inactive, offline or foreign-request signature is refused before any commit', async () => {
  const plan = question();
  await refusedAsync(portFor(null).sign(plan.signing, { originalId: 'o' }), 'SignatureRequired', 'no carried signature: nothing to sign with');
  const cases = [
    ['an altered text', { change: p => ({ ...p, text: { kind: 'clinical-entry', body: 'SYN 다른 내용' } }) }, 'SignatureBindingRefused'],
    ['another request ID', { eventId: randomUUID() }, 'SignatureBindingRefused'],
    ['an offline grant on an online write', { change: p => ({ ...p, grant: { grantId: 'grant-1', digest: 'ab'.repeat(32) } }) }, 'SignatureBindingRefused'],
    ['a reboot between anchor and signing', { timeBasisFor: signedAt => device.basis(signedAt, 'dev-' + c1.identity.id, { signBoot: 'boot-2' }) }, 'SignatureTimeUnverified'],
    ['bytes signed by another key', { signWith: 'kid-' + r1.identity.id }, 'SignatureIntegrityRefused'],
  ];
  for (const [label, option, code] of cases) {
    const signedAt = new Date().toISOString();
    const signed = { ...device.sign(plan.signing, { kid: 'kid-' + c1.identity.id, eventId: option.eventId ?? plan.requestId, signedAt,
      timeBasis: option.timeBasisFor ? option.timeBasisFor(signedAt) : null, change: option.change ?? null, signWith: option.signWith }), eventId: plan.requestId };
    const port = portFor(signed);
    await refusedAsync(port.verify(await port.sign(plan.signing, { originalId: 'o' }), plan.signing), code, label);
  }
  // Another version ID is refused before verification (the device signed some other version).
  const other = { ...device.sign({ ...plan.signing, versionId: randomUUID() }, { kid: 'kid-' + c1.identity.id, eventId: plan.requestId }), eventId: plan.requestId };
  await refusedAsync(portFor(other).sign(plan.signing, { originalId: 'o' }), 'SignatureBindingRefused', 'another version');
  // A key revoked before the signing time is not active at that time.
  const revoked = actor('44444444-4444-4444-8444-444444444444', ['clinician']);
  device.register(revoked.identity, revoked.signingRegistrationId, 'inst-a', { revokedAt: '2026-10-01T00:00:00.000Z' });
  const late = question(revoked), lateSigned = carried(late, revoked);
  await refusedAsync(portFor(lateSigned).verify(await portFor(lateSigned).sign(late.signing, { originalId: 'o' }), late.signing), 'SigningKeyInactive');
  // A test key is never accepted where the policy does not name it.
  const tpmOnly = SG.deviceSignaturePort({ ...device.ports, keyPolicy: { acceptedEvidence: ['tpm-nonexportable'] } }, () => carried(plan, c1));
  await refusedAsync(tpmOnly.verify(await tpmOnly.sign(plan.signing, { originalId: 'o' }), plan.signing), 'KeyEvidenceRefused');
});

test('TEST-D-02 versions_and_sr server: a manual SR adoption is the author\'s signature over the exact SOP and bytes', async () => {
  const author = r1, at = new Date().toISOString();
  const sr = { id: randomUUID(), studyId: study.studyId, authorId: author.identity.id, createdAt: at, attemptedAt: null, storedAt: null,
    bytesSha256: 'cd'.repeat(32), sopInstanceUid: '1.2.826.0.1.3680043.10.99.1', adoptedVersion: null, referencedBy: [], holdIds: [], orthanc: 'unknown' };
  const plan = R.planManualSrAdoption({ actor: author, study, sr, versionId: randomUUID(), at });
  const signed = { ...device.sign(plan.signing, { kid: 'kid-' + author.identity.id, eventId: sr.id }), eventId: sr.id };
  const port = portFor(signed);
  const evidence = await port.verify(await port.sign(plan.signing, { originalId: 'sr' }), plan.signing);
  assert.equal(evidence.versionSha256, plan.adoption.sha256);
  const text = JSON.parse(Buffer.from(signed.jws.payload, 'base64url').toString('utf8')).text.body;
  assert.equal(text, SG.srAdoptionText({ sopInstanceUid: sr.sopInstanceUid, sha256: sr.bytesSha256 }), 'the signed text names the SOP and the exact bytes');
  const otherBytes = { ...device.sign({ ...plan.signing, content: { kind: 'dicom', sopInstanceUid: sr.sopInstanceUid, sha256: 'ef'.repeat(32) } },
    { kid: 'kid-' + author.identity.id, eventId: sr.id }), eventId: sr.id };
  await refusedAsync(portFor(otherBytes).verify(await portFor(otherBytes).sign(plan.signing, { originalId: 'sr' }), plan.signing),
    'SignatureBindingRefused', 'a signature over other bytes adopts nothing');
});

// ---------------- TEST-D-03: the change event a commit appends ----------------

test('TEST-D-03 read_scope server: a write\'s access event names exactly its version, in both streams, with the bound context', () => {
  const plan = question();
  const event = ST.clinicalWriteEvent(plan, facts(c1), 'original-7');
  assert.equal(event.eventId, 'clinical-write:original-7', 'one event identity per original: a retried commit appends nothing new');
  assert.deepEqual(A.accessStreams(event), ['viewing', 'history'], 'a record change is in both streams (D-1)');
  assert.equal(A.statutoryAct(event), '기재');
  assert.deepEqual([event.targets.length, event.targets[0].recordId.value, event.targets[0].versionId.value, event.targets[0].kind],
    [1, plan.version.recordId, plan.version.versionId, 'clinical-question']);
  assert.deepEqual(event.targets[0].patientLinkSnapshot, known(patient));
  assert.deepEqual([event.context.basis, event.context.studyId, event.userId.value.id], ['clinical-request', study.studyId, c1.identity.id]);
  const unit = R.applyPlan(null, plan);
  const answer = R.planClinicalWrite(input('question.reply', r1, unit, { requestId: randomUUID(), expectedOwner: owner(r1), revision: 1, body: 'SYN 답변' }));
  const answered = ST.clinicalWriteEvent(answer, facts(r1, true), 'original-8');
  assert.deepEqual([A.statutoryAct(answered), answered.context.basis, answered.targets[0].kind], ['추가기재', 'assigned-reading', 'clinical-answer']);
  assert.equal(ST.clinicalWriteEvent(answer, facts(r1, false), 'original-8').context.basis, 'worklist');
  // A success needs the trusted ingress address; an unobserved one is never filled in.
  const unresolved = { ...facts(c1), event: { ...facts(c1).event, trustedProxyIp: { status: 'unresolved', reason: 'not-observed' } } };
  assert.throws(() => ST.clinicalWriteEvent(plan, unresolved, 'original-9'));
});

// ---------------- TEST-D-04: fail closed without the composition ----------------

function recorder() {
  const calls = [];
  const proxy = name => new Proxy(function () {}, {
    get: (_t, key) => { if (key === 'then') return undefined; calls.push(name + '.' + String(key)); return proxy(name + '.' + String(key)); },
    apply: () => { calls.push(name + '()'); return proxy(name + '()'); },
  });
  return { calls, proxy };
}
const runtimeRequired = e => typeof e?.getStatus === 'function' && e.getStatus() === 503 && e.getResponse()?.code === 'EMR_CLINICAL_RUNTIME_REQUIRED';

test('TEST-D-04 atomic_retry server: without the EMR composition every owning service refuses before touching the database', async () => {
  assert.throws(() => RT.clinicalRuntime(), e => e instanceof V.ContractError && e.code === 'EmrClinicalRuntimeRequired');
  assert.equal(SV.clinicalRuntime(), null, 'the owning services have no port while nothing is composed');
  assert.throws(() => SV.requireClinicalRuntime(), runtimeRequired);
  const uid = '1.2.840.99.7', id = randomUUID();
  const clinician = { kind: 'member', institution: 'inst-a', sub: 'sub-c', actor: 'syn-c', roles: ['clinician'] };
  const radiologist = { kind: 'member', institution: 'inst-a', sub: 'sub-r', actor: 'syn-r', roles: ['radiologist'] };
  const technician = { kind: 'member', institution: 'inst-a', sub: 'sub-t', actor: 'syn-t', roles: ['technician'] };
  const cases = [
    ['question.create', (p, a) => new ClinicianQuestionService(p, a).create(uid, clinician, { requestId: randomUUID(), expectedOwner: ['inst-a', 'sub-c'], body: Q }, {})],
    ['question.reply', (p, a) => new ClinicianQuestionService(p, a).reply(id, radiologist, { requestId: randomUUID(), expectedOwner: ['inst-a', 'sub-r'], revision: 1, body: 'SYN' }, {})],
    ['question.close', (p, a) => new ClinicianQuestionService(p, a).close(id, clinician, { requestId: randomUUID(), expectedOwner: ['inst-a', 'sub-c'], revision: 1, note: '' }, {})],
    ['question.read', (p, a) => new ClinicianQuestionService(p, a).read(id, clinician, {})],
    ['image-request.create', (p, a) => new ImageRequestService(p, a).create(uid, clinician, { requestId: randomUUID(), expectedOwner: ['inst-a', 'sub-c'],
      kind: 'external-image', counterparty: 'SYN', counterpartyInstitutionId: null, reason: Q }, {})],
    ['image-request.change', (p, a) => new ImageRequestService(p, a).change(id, technician, { requestId: randomUUID(), expectedOwner: ['inst-a', 'sub-t'],
      revision: 1, action: 'accept', note: '' }, {})],
    ['image-request.read', (p, a) => new ImageRequestService(p, a).read(id, technician, {})],
    ['consultation.create', (p, a, k) => new ConsultationService(p, k, a).create(uid, radiologist, { requestId: randomUUID(), expectedOwner: ['inst-a', 'sub-r'],
      recipientSub: randomUUID(), reason: Q }, {})],
    ['consultation.change', (p, a, k) => new ConsultationService(p, k, a).change(id, radiologist, { requestId: randomUUID(), expectedOwner: ['inst-a', 'sub-r'],
      revision: 1, action: 'accept', note: '' }, {})],
    ['consultation.read', (p, a, k) => new ConsultationService(p, k, a).read(id, radiologist, {})],
    ['assignment.write', (p, a, k) => new ReaderAssignmentService(p, k, a).write(uid, technician, { requestId: randomUUID(), expectedOwner: ['inst-a', 'sub-t'],
      revision: 0, readerSub: null }, {})],
    ['finding.create', (p, a, _k, o) => new FindingService(p, a, o).write(uid, Buffer.from(JSON.stringify({ requestId: randomUUID(),
      item: { schemaVersion: 1, title: 'SYN', text: 'SYN', sources: [{ itemId: randomUUID(), revision: 1 }] } })), radiologist, undefined, {})],
    ['manual-sr.store', (p, a, _k, o) => new ManualSrService(p, o, a).store(uid, id, Buffer.from('{}'), radiologist, {})],
    // Every response that carries clinical text refuses as well (DR2-03): the lists, a study's requests, the findings.
    ['image-request.list', (p, a) => new ImageRequestService(p, a).list(technician, { view: 'queue' }, {})],
    ['image-request.forStudy', (p, a) => new ImageRequestService(p, a).forStudy(uid, technician, {})],
    ['consultation.list', (p, a, k) => new ConsultationService(p, k, a).list(radiologist, { direction: 'sent' }, {})],
    ['finding.list', (p, a, _k, o) => new FindingService(p, a, o).list(uid, {}, radiologist, undefined, '2', {})],
    ['finding.revisions', (p, a, _k, o) => new FindingService(p, a, o).list(uid, {}, radiologist, id, '2', {})],
  ];
  for (const [label, run] of cases) {
    const r = recorder();
    await assert.rejects(run(r.proxy('prisma'), r.proxy('studyAccess'), r.proxy('keycloak'), r.proxy('orthanc')), runtimeRequired, label);
    assert.deepEqual(r.calls, [], label + ': no database, access policy, identity provider or image server call');
  }
});

test('TEST-D-01 clinical_vs_operational server: refusals reach the caller as closed errors without clinical text', () => {
  const expectations = [
    ['SignatureRequired', 403, 'CLINICAL_SIGNATURE_REQUIRED'], ['SigningIdentityRequired', 403, 'CLINICAL_SIGNATURE_REQUIRED'],
    ['SignatureBindingRefused', 403, 'CLINICAL_SIGNATURE_REFUSED'], ['SignatureFailed', 403, 'CLINICAL_SIGNATURE_REFUSED'],
    ['ProxySignatureRefused', 403, 'CLINICAL_SIGNATURE_REFUSED'], ['SigningKeyInactive', 403, 'CLINICAL_SIGNATURE_REFUSED'],
    ['StorageFailed', 503, 'CLINICAL_STORAGE_UNAVAILABLE'], ['OutcomeUnknown', 503, 'CLINICAL_OUTCOME_PENDING'],
    ['StaleRevision', 409, 'CLINICAL_RECORD_CHANGED'], ['NotFound', 404, 'CLINICAL_RECORD_NOT_FOUND'], ['ActorPathRefused', 403, 'CLINICAL_ACTION_FORBIDDEN'],
    ['RequestIdReused', 409, 'REQUEST_ID_REUSED'], ['TextRequired', 400, 'CLINICAL_INPUT_INVALID'],
  ];
  for (const [code, status, closed] of expectations) {
    const error = SV.clinicalHttpError(code);
    assert.deepEqual([error.getStatus(), error.getResponse().code], [status, closed], code);
    assert.ok(!JSON.stringify(error.getResponse()).includes('SYN'), code + ': no clinical text');
  }
  const own = SV.clinicalHttpError('StaleRevision', { StaleRevision: () => new (require(path.join(api, 'node_modules/@nestjs/common')).ConflictException)({ code: 'OWN', message: 'own' }) });
  assert.equal(own.getResponse().code, 'OWN', 'the owning service words its own codes');
  const common = require(path.join(api, 'node_modules/@nestjs/common'));
  assert.equal(SV.projectionCode(new common.ConflictException({ code: 'QUESTION_ENTRY_LIMIT', message: 'x' })), 'QUESTION_ENTRY_LIMIT');
  assert.equal(SV.projectionCode(new common.ConflictException('plain')), 'ProjectionConflict');
  assert.equal(SV.projectionCode(new common.NotFoundException('plain')), 'ProjectionNotFound');
  assert.equal(SV.outcomeCode({ status: 'committed', receipt: {} }), null);
  assert.equal(SV.outcomeCode({ status: 'failed', code: 'StaleRevision', retry: 'same-request' }), 'StaleRevision');
});

// ---------------- round 3 (Astra NEEDS_FIX DR2-01..08 on bfddc3d): each finding's behaviour, on the product code ----------------

/** A deterministic stand-in of the register's SQL functions for one original (the PostgreSQL behaviour of migration 46). */
function registerDb(row, { failCheckpoints = 0, commitHold = null, sources = null } = {}) {
  const seen = { checkpoints: 0, recoveries: 0, commits: 0, versions: [], seals: 0 };
  let failing = failCheckpoints;
  const db = { $executeRaw: async () => 0, $queryRaw: async (strings, ...v) => {
    const sql = strings.join('?');
    if (sql.includes('"ViewerRevision"') || sql.includes('"ViewerJobRevision"')) return sources(sql);
    if (sql.includes('emr_clinical.lock_request')) return [];
    if (sql.includes('emr_clinical.rejection_for')) return [{decision:row.rejection_decision??null}];
    if (sql.includes('emr_clinical.remember_rejection')) {row.rejection_decision=v[5];return [{done:true}];}
    if (sql.includes('emr_clinical.observe')) return [{ ...row, kind: 'observer' }];
    if (sql.includes('emr_clinical.recover(')) {
      seen.recoveries++;
      if (row.state !== 'pending') return [{ ...row, kind: 'observer' }];
      row.epoch++;
      return [{ ...row, kind: row.phase === 'commit-dispatched' ? 'fenced' : 'owner' }];
    }
    if (sql.includes('emr_clinical.checkpoint')) {
      seen.checkpoints++;
      if (failing-- > 0) throw new Error('SYN transient connection interruption');
      if (v[3] !== row.original_id || v[4] !== row.epoch || row.state !== 'pending') return [{ done: false }];
      row.phase = v[5]; row.checkpoint = v[6];
      return [{ done: true }];
    }
    if (sql.includes('emr_clinical.commit_version')) {
      if (v[3] !== row.original_id || v[4] !== row.epoch || row.phase !== 'commit-dispatched') throw new Error('SYN PermitFenced');
      if (commitHold) await commitHold;
      seen.commits++; seen.versions.push(JSON.parse(v[18]));
      row.state = 'committed'; row.terminal = v[20]; row.access_event = v[21]; row.record_id = v[5];
      return [{ done: null }];
    }
    if (sql.includes('emr_clinical.confirm_request')) { row.confirmed = true; return [{ done: true }]; }
    if (sql.includes('emr_clinical.note_attempt')) return [{ done: null }];
    if (sql.includes('emr_clinical.seal_rejected')) {
      seen.seals++;
      if (v[3] !== row.original_id || v[4] !== row.epoch || row.state !== 'pending') return [{ done: false }];
      row.state = 'rejected'; row.terminal = v[6];
      return [{ done: true }];
    }
    if (sql.includes('emr_clinical.unit_for')) return [];
    throw new Error('unexpected SQL ' + sql);
  } };
  return { db, seen };
}
const fakeLedger = (db, appended = []) => ({ withAppendTransaction: async work => work(db), appendInTransaction: async (_tx, event) => ({ provisional: true, eventId: event.eventId, entries: [] }),
  confirm: async () => ({ eventId: 'synthetic', durableAt: new Date().toISOString() }), settleTransaction: async () => {},
  append: async event => { appended.push(event); return { eventId: event.eventId, durableAt: new Date().toISOString() }; } });
const registerRow = (seed, facts, envelope = null) => ({ kind: 'owner', original_id: randomUUID(), epoch: 1, phase: 'admitted', state: 'pending',
  seed: JSON.stringify(seed), facts: JSON.stringify(facts), envelope: envelope === null ? null : JSON.stringify(envelope), checkpoint: null, terminal: null,
  record_id: null, access_event: null, confirmed: false });

test('TEST-D-04 atomic_retry server: a recovery releases the original it took over - after a transient store failure the next recovery commits it once, and an original still executing is never fenced', async () => {
  const t1 = actor('55555555-5555-4555-8555-555555555555', ['technician']);
  const allocation = () => input('assignment.write', t1, null, { requestId: randomUUID(), expectedOwner: owner(t1), revision: 0, readerSub: null },
    { ids: { recordId: 'assignment-' + randomUUID(), versionId: randomUUID() } });
  let effects = 0, held = null;
  SV.clinicalServices.prepareProjection.delete('assignment');
  SV.registerClinicalProjection('assignment', async () => { effects++; if (held) await held.promise; });
  // A checkpoint that fails once (a dropped connection) and then works again.
  const first = allocation(), row = registerRow(first, facts(t1));
  const { db, seen } = registerDb(row, { failCheckpoints: 1 });
  const runtime = new RT.ClinicalRuntime({ db, ledger: fakeLedger(db), context: {}, studies: {}, signatures: device.ports, recoveryDelayMs: 3600000 });
  const request = R.prepareClinicalWrite(first);
  assert.equal((await runtime.recover(request)).status, 'unknown', 'the store failed: the outcome is not known yet');
  assert.equal(runtime.store.isActive(row.original_id), false, 'the failed recovery released the original it took over');
  const second = await runtime.recover(request);
  assert.equal(second.status, 'replayed', 'the next recovery resumes the original');
  assert.deepEqual([seen.commits, effects, seen.recoveries], [1, 1, 2], 'committed exactly once');
  assert.equal(runtime.store.isActive(row.original_id), false, 'the successful recovery released it too');
  assert.equal((await runtime.recover(request)).status, 'replayed', 'a later recovery observes the committed original');
  assert.deepEqual([seen.commits, effects], [1, 1], 'and commits nothing again');
  // An original whose recovery is still executing (its commit has not returned): another recovery observes, never fences it.
  const other = allocation(), live = registerRow(other, facts(t1));
  let release; held = { promise: new Promise(resolve => { release = resolve; }) };
  const store2 = registerDb(live);
  const runtime2 = new RT.ClinicalRuntime({ db: store2.db, ledger: fakeLedger(store2.db), context: {}, studies: {}, signatures: device.ports, recoveryDelayMs: 3600000 });
  const running = runtime2.recover(R.prepareClinicalWrite(other));
  while (effects < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime2.store.isActive(live.original_id), true);
  assert.equal((await runtime2.recover(R.prepareClinicalWrite(other))).status, 'unknown', 'the second recovery only observes');
  assert.equal(store2.seen.recoveries, 1, 'no new epoch fenced the executing original');
  release(); held = null;
  assert.equal((await running).status, 'replayed');
  assert.deepEqual([store2.seen.commits, runtime2.store.isActive(live.original_id)], [1, false]);
});

test('TEST-D-04 atomic_retry server: an allocation request keeps its identity - the same request before and after its first commit, at any unit revision; another meaning under its request ID is another request', () => {
  const t1 = actor('66666666-6666-4666-8666-666666666666', ['technician']);
  // The allocation row's revision (3: the row existed before unit D, or a channel close moved it) is not D's unit revision.
  const body = { requestId: randomUUID(), expectedOwner: owner(t1), revision: 3, readerSub: null }, recordId = 'assignment-' + randomUUID();
  const opening = input('assignment.write', t1, null, body, { ids: { recordId, versionId: randomUUID() } });
  let plan;
  try { plan = R.planClinicalWrite(opening); }
  catch (error) { assert.fail('DR2-04: an allocation carrying its row\'s revision plans whatever D\'s unit revision is (' + error.message + ')'); }
  assert.equal(plan.version.entry, 'assignment');
  const unit = R.applyPlan(null, plan);
  const resend = R.prepareClinicalWrite(input('assignment.write', t1, unit, body, { ids: { recordId, versionId: randomUUID() } }));
  assert.equal(resend.fingerprint, R.prepareClinicalWrite(opening).fingerprint, 'the resend is the same request after the commit');
  const changed = R.prepareClinicalWrite(input('assignment.write', t1, unit, { ...body, readerSub: randomUUID() }, { ids: { recordId, versionId: randomUUID() },
    readerId: 'r9' }));
  assert.notEqual(changed.fingerprint, resend.fingerprint, 'another reader under the same request ID is another meaning');
  const next = R.planClinicalWrite(input('assignment.write', t1, unit, { ...body, requestId: randomUUID(), revision: 4 }, { ids: { recordId, versionId: randomUUID() } }));
  assert.deepEqual([next.version.sequence, next.version.previousVersion.versionId], [2, unit.head.versionId], 'D keeps its own history by head and sequence');
});

const people = new Map([c1, r1, t1].map(a => [a.identity.subject, a.identity]));
const providerContext = reader => ({ facts: async () => ({ actor: reader, trustedProxyIp: known({ address: '10.0.0.7', source: 'trusted-proxy' }),
  requestId: 'request-' + randomUUID(), member: async subject => people.get(subject) ?? who('unknown-' + subject), signature: null }) });
const unitRows = unit => unit.versions.map(v => ({ record_id: unit.recordId, record: unit.record, study_id: unit.studyId,
  managing_institution_id: unit.managingInstitutionId, patient: JSON.stringify(unit.patient), author_id: unit.parties.authorId, recipient_id: unit.parties.recipientId,
  state: unit.state, revision: unit.revision, head_version_id: unit.head.versionId, head_sha256: unit.head.sha256, clinical_entry: unit.clinicalEntry,
  sequence: v.sequence, version_id: v.versionId, body: JSON.stringify(v), signature: null }));
const unitsDb = units => ({ $queryRaw: async (_strings, ids) => units.filter(u => ids.includes(u.recordId)).flatMap(unitRows) });

test('TEST-D-03 read_scope server: a response serving many units hands out no text before every provision naming exactly its versions is durable; a projection naming another author or recipient is refused', async () => {
  const H = require('./response_test.cjs');
  const records = Array.from({length:70},()=>H.fixture('image-request'));
  const env=H.environment(records), route='GET image-requests', selector={view:'images',route,ids:records.map(f=>f.row.id)};
  const response=await H.B.clinicalResponse(env.parts,env.req,selector,env.context);
  const body=await H.serialize(env,route,response);
  assert.deepEqual(env.appended.map(e=>e.targets.length),[64,6],'70 versions: two provisions (64 + 6), both durable before the text is sent');
  assert.deepEqual(body.items.map(i=>i.reason),records.map(f=>f.unit.versions[0].text));
  assert.deepEqual(env.appended.flatMap(e=>e.targets.map(t=>t.versionId.value)),records.map(f=>f.unit.head.versionId));
  env.appended.length=0;env.changes.ledgerAt=2;
  await assert.rejects(H.B.clinicalResponse(env.parts,env.req,selector,env.context),/SYN ledger failure/,'TEST-D-03: no text without every provision durable');
  env.changes.ledgerAt=0;env.appended.length=0;records[0].row.requesterSub='someone-else';
  await assert.rejects(H.B.clinicalResponse(env.parts,env.req,selector,env.context),e=>e.code==='ProjectionMismatch','DR2-02: a projection naming another author is refused');
  assert.equal(env.appended.length,0);
  const f=H.fixture('consultation'), ce=H.environment([f]);
  f.row.recipientSub='somebody-else';
  await assert.rejects(H.B.clinicalResponse(ce.parts,ce.req,H.variant(f,'GET consultations'),ce.context),e=>e.code==='ProjectionMismatch','a rewritten recipient');
  assert.equal(ce.appended.length,0);
  f.row.recipientSub=H.recipient.identity.subject;
  const control=await H.B.clinicalResponse(ce.parts,ce.req,H.variant(f,'GET consultations'),ce.context);
  assert.equal(control.items[0].reason,f.unit.versions[0].text);

});

test('TEST-D-02 versions_and_sr server: a manual SR adoption counts only once its access event is durable - a ledger that cannot confirm it leaves it unconfirmed, and the same event confirms it later', async () => {
  const id = randomUUID();
  const event = A.parseAccessEvent({ formatVersion: 1, surface: 'POST studies/:uid/manual-sr/:id/store', eventId: 'clinical-sr:' + id, userId: known(r1.identity),
    rolesAtTime: known(['radiologist']), actingInstitution: known('inst-a'), managingInstitution: known('inst-a'), occurredAt: new Date().toISOString(),
    trustedProxyIp: known({ address: '10.0.0.7', source: 'trusted-proxy' }), cause: 'user-view', context: { basis: 'worklist', studyId: study.studyId, relatedStudyId: null, reason: null },
    executor: 'member', targets: [{ kind: 'manual-sr', patientLinkSnapshot: known(patient), studyId: known(study.studyId), recordId: known(id), versionId: known('v-1') }],
    action: 'write', result: 'succeeded', requestId: 'request-sr', auditLinkId: A.newAuditLinkId(), relatedEventId: null });
  const adoption = { version_id: 'v-1', sha256: 'ab'.repeat(32), bytes_sha256: 'cd'.repeat(32), sop_instance_uid: '1.2.826.0.1.3680043.10.99.7', study_id: study.studyId,
    managing_institution_id: 'inst-a', body: '{}', signature: '{}', access_event: JSON.stringify(event), confirmed: false };
  let confirms = 0, stored = true;
  const db = { $queryRaw: async strings => {
    const sql = strings.join('?');
    if (sql.includes('sr_adoption_for')) return stored ? [{ ...adoption }] : [];
    if (sql.includes('confirm_sr')) { confirms++; adoption.confirmed = true; return [{ done: 'true' }]; }
    throw new Error('unexpected SQL ' + sql);
  } };
  const appended = [];
  const down = { ...fakeLedger(db), append: async () => { throw Object.assign(new Error('SYN seal unavailable'), { name: 'LedgerFailure' }); } };
  await assert.rejects(new RT.ClinicalRuntime({ db, ledger: down, context: {}, studies: {}, signatures: device.ports }).confirmedSrAdoption(id), /SYN seal unavailable/,
    'DR2-01: an adoption the ledger cannot make durable is never reported confirmed');
  assert.deepEqual([confirms, adoption.confirmed], [0, false], 'not durable: the adoption stays unconfirmed (nothing may be published)');
  const runtime = new RT.ClinicalRuntime({ db, ledger: fakeLedger(db, appended), context: {}, studies: {}, signatures: device.ports });
  const confirmed = await runtime.confirmedSrAdoption(id);
  assert.deepEqual([confirmed.confirmed, confirms, appended.map(e => e.eventId)], [true, 1, ['clinical-sr:' + id]], 'the same event, never a second one');
  assert.equal((await runtime.confirmedSrAdoption(id)).confirmed, true);
  assert.deepEqual([confirms, appended.length], [1, 1], 'a confirmed adoption is not appended again');
  stored = false;
  assert.equal(await runtime.confirmedSrAdoption(id), null, 'no adoption: nothing to publish');
});

/**
 * The workflow run as GitHub's runner runs it, by installed tools only (DR3-06, DR4-07, R5-22, R5-23): js-yaml reads the
 * workflow (it refuses duplicate keys); GNU Bash interprets every `run:` script; each recorder line is run
 * as scripts/record-run.py itself (its own options; a scratch run directory, or the line's own one inside a checkout; a
 * stand-in child that does nothing, or prints a given output, changes or removes files and exits with a given code); bash
 * runs a step's script as the runner does (`bash -e`, the shell of a step that names none); a fake `docker` stands in for the
 * daemon - argparse for its options, docker's documented `image inspect` object, the Go template actions `{{ .A.B }}` and
 * `{{ index .A "key" }}` (anything else exits 2, a fixture error that fails the case, never passes it), and a build that
 * labels its image as the Dockerfile does (honest), with another revision (stale) or with none, or fails; git is the
 * checkout. The runner's `${{ env.NAME }}` substitution is the one expression evaluated here; any other `${{ }}` fails the
 * case as unsupported. No assertion reads the text of a step's script: its exit, its artifact and the image it leaves decide.
 */
const RUNNER = "import json, os, subprocess, sys, tempfile\nroot, todo = sys.argv[1], json.load(sys.stdin)\nout = {\"words\": [], \"records\": []}\nwith tempfile.TemporaryDirectory() as scratch:\n    helper = os.path.join(scratch, \"capture.py\")\n    with open(helper, \"w\", encoding=\"utf-8\") as f: f.write(todo[\"helper\"])\n    for i, job in enumerate(todo[\"records\"]):\n        job = job if isinstance(job, dict) else {\"line\": job}\n        cwd = job.get(\"cwd\") or root\n        request = dict(job, result=os.path.join(scratch, str(i)+\".json\"), run_dir=os.path.join(scratch, \"run-\"+str(i)))\n        settings = os.path.join(scratch, \"job.json\")\n        with open(settings,\"w\",encoding=\"utf-8\") as f: json.dump(request,f)\n        script = os.path.join(scratch, \"step.sh\")\n        with open(script,\"w\",encoding=\"utf-8\",newline=\"\\n\") as f:\n            f.write('python3() { \"$KIN_CAPTURE_PYTHON\" \"$KIN_CAPTURE_HELPER\" \"$@\"; }\\n'+job[\"line\"])\n        env = dict(os.environ, KIN_CAPTURE_PYTHON=sys.executable.replace(\"\\\\\",\"/\"), KIN_CAPTURE_HELPER=helper.replace(\"\\\\\",\"/\"), KIN_CAPTURE_JOB=settings, TARGET_SHA=\"a\"*40, MSYS_NO_PATHCONV=\"1\")\n        done = subprocess.run([todo[\"bash\"],\"-e\",script.replace(\"\\\\\",\"/\")],cwd=cwd,env=env,capture_output=True,text=True)\n        with open(request[\"result\"],encoding=\"utf-8\") as f: entry=json.load(f)\n        entry.update(exit=done.returncode,stderr=done.stderr[-2000:])\n        out[\"records\"].append(entry)\nprint(json.dumps(out))";
const RECORDER_CAPTURE = "import json, os, pathlib, runpy, subprocess, sys\njob=json.load(open(os.environ[\"KIN_CAPTURE_JOB\"],encoding=\"utf-8\"))\nscript=sys.argv[1]\nargv=sys.argv[2:]\n# argparse remains the recorder's authority; insert its documented override before the child separator.\nif not job.get(\"own_run_dir\"):\n    at=argv.index(\"--\")\n    argv[at:at]=[\"--run-dir\",job[\"run_dir\"]]\noriginal=subprocess.run\nentry={\"program\":[\"python3\",script]}\ndef run(command,*args,**kwargs):\n    if pathlib.Path(command[0]).name in (\"git\",\"git.exe\"):\n        return original(command,*args,**kwargs)\n    entry[\"command\"]=command\n    child=[sys.executable if v==\"{python}\" else v for v in job.get(\"child\",[\"{python}\",\"-c\",\"\"])]\n    return original(child,*args,**kwargs)\nsubprocess.run=run\nsys.argv=[script,*argv]\ntry:\n    runpy.run_path(script,run_name=\"__main__\")\nexcept SystemExit as exc:\n    code=exc.code\nelse:\n    code=0\nif not job.get(\"own_run_dir\"):\n    record=json.load(open(pathlib.Path(job[\"run_dir\"])/\"run.json\",encoding=\"utf-8\"))\n    entry[\"inputs\"]=[{k:f.get(k) for k in (\"requested\",\"tree\",\"status\")} for f in record[\"files_before\"]]\nwith open(job[\"result\"],\"w\",encoding=\"utf-8\") as f: json.dump(entry,f)\nsys.exit(code)";
const python = process.env.KIN_EMR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
function asRun(records) {
  const expanded = records.map(job => typeof job === 'string' ? actions(job, { TARGET_SHA: 'a'.repeat(40) })
    : { ...job, line: actions(job.line, { TARGET_SHA: 'a'.repeat(40) }) });
  const done = spawnSync(python, ['-B', '-I', '-c', RUNNER, root], { input: JSON.stringify({ records: expanded, helper: RECORDER_CAPTURE, bash: gnuBash() }), encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(done.status, 0, 'DR3-06: Bash recorder execution\n' + done.stderr);
  return JSON.parse(done.stdout);
}
/** A path as the file system names it: `./api/x` and `api/x` are one input. */
const posixName = name => path.posix.normalize(String(name).replace(/\\/g, '/'));
/** Whether a record hashed `file` as present: the file itself or a requested tree holding it. */
const hashes = (record, file) => record.inputs.some(i => i.status === 'present'
  && (i.tree === null ? posixName(i.requested) === file : file === posixName(i.tree) || file.startsWith(posixName(i.tree) + '/')));
/** A record with its paths as the file system names them. */
const pathsOf = r => ({ ...r, program: r.program.map(posixName),
  inputs: r.inputs && r.inputs.map(i => ({ ...i, requested: posixName(i.requested), tree: i.tree === null ? null : posixName(i.tree) })) });
/** The same recorder lines in other shell notation: quoted concatenation, single quotes, backslash escapes, `./` paths. */
const renote = line => line.replace(' --cwd .', " \\\n--cwd .").replace('"VCS_REF=${{ env.TARGET_SHA }}"', '"VCS_REF="\'${{ env.TARGET_SHA }}\'')
  .replace(' --file api/Dockerfile ', ' --file "api"/Dockerfile ').replace(' --file emr/units/d.json ', " --file 'emr/units/d.json' ")
  .replace(' --tree tests/emr/d ', ' --tree tests\\/emr/d ').replace(' --file api/tsconfig.json ', ' --file api\\/"tsconfig".json ')
  .replace(' --file api/package-lock.json ', ' --file ./api/package-lock.json ').replace(/^python3 scripts\//, 'python3 ./scripts/');

function workflowOf() {
  const yaml = require(path.join(api, 'node_modules/js-yaml'));
  const flow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/emr-d.yml'), 'utf8'));
  const job = flow.jobs['emr-d'];
  const declaration = JSON.parse(fs.readFileSync(path.join(root, 'emr/units/d.json'), 'utf8'));
  const consumed = declaration.ci.recorded_inputs, ids = Object.keys(consumed);
  return { flow, job, declaration, consumed, ids, steps: ids.map(id => Object.values(flow.jobs).flatMap(j => j.steps).find(s => s.id === id)) };
}
const GIT = ['-c', 'user.name=EMR-D test', '-c', 'user.email=emr-d@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false',
  '-c', 'init.defaultBranch=main'];
function gitIn(repo) {
  fs.mkdirSync(repo, { recursive: true });
  return (...args) => {
    const done = spawnSync('git', ['-C', repo, ...GIT, ...args], { encoding: 'utf8' });
    assert.equal(done.status, 0, 'git ' + args.join(' ') + ': ' + done.stderr);
    return done.stdout.trim();
  };
}
/** GNU bash, the runner's shell: `bash` on Linux; on Windows the one Git for Windows carries (usr/bin/bash.exe; MinGit's sh.exe). */
function gnuBash() {
  let bash = process.env.KIN_BASH;
  if (!bash && process.platform === 'win32') {
    const top = path.resolve(spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim(), '..', '..', '..');
    bash = ['usr/bin/bash.exe', 'bin/bash.exe', 'usr/bin/sh.exe'].map(p => path.join(top, p)).find(p => fs.existsSync(p));
  }
  bash = bash || 'bash';
  assert.match(String(spawnSync(bash, ['--version'], { encoding: 'utf8' }).stdout), /GNU bash/, 'GNU bash (the runner\'s shell) is available: ' + bash);
  return bash;
}
/** How the runner starts a step's script: `bash -e {0}` when no shell is named, `bash --noprofile --norc -eo pipefail {0}` for bash. */
function shellOf(flow, job, step) {
  const shell = step.shell ?? job.defaults?.run?.shell ?? flow.defaults?.run?.shell;
  if (shell === undefined) return ['-e'];
  assert.equal(shell, 'bash', 'this harness runs bash steps only');
  return ['--noprofile', '--norc', '-eo', 'pipefail'];
}
/** The runner's substitution of `${{ env.NAME }}` before the shell sees the text; any other expression is not evaluated here. */
function actions(text, env) {
  return text.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (whole, expression) => {
    if (expression === 'github.sha') return env.GITHUB_SHA || 'b'.repeat(40);
    const name = /^env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expression);
    if (!name || !Object.hasOwn(env, name[1])) throw new Error('unsupported expression for this harness: ' + whole);
    return env[name[1]];
  });
}
function withPath(env, dir) {
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH');
  const out = { ...env };
  if (key) delete out[key];
  out.PATH = dir + path.delimiter + (key ? env[key] : '');
  return out;
}
const FAKE_DOCKER = [
  '"""docker as this harness needs it: build (labels its image as the Dockerfile does - honest -, with another revision - stale -,',
  'with none - unlabelled -, or fails) and image inspect (the documented object; Go template field and index actions only)."""',
  'import argparse, hashlib, json, os, re, shlex, sys',
  'path = os.environ["KIN_FAKE_DOCKER_STATE"]',
  'with open(path, encoding="utf-8") as stream: state = json.load(stream)',
  'argv = sys.argv[1:]',
  'def field(value, chain):',
  '    for name in filter(None, chain.split(".")):',
  '        if not isinstance(value, dict) or name not in value: sys.exit("template: can\'t evaluate field " + name)',
  '        value = value[name]',
  '    return value',
  'def show(value):',
  '    if value is None: return "<no value>"',
  '    if isinstance(value, dict): return "map[" + " ".join(k + ":" + show(v) for k, v in sorted(value.items())) + "]"',
  '    return str(value)',
  'def action(match):',
  '    words = shlex.split(match.group(1))',
  '    if len(words) == 1 and words[0].startswith("."): return show(field(image, words[0]))',
  '    if len(words) == 3 and words[0] == "index" and words[1].startswith("."):',
  '        mapping = field(image, words[1])',
  '        return "" if mapping is None else str(mapping.get(words[2], ""))',
  '    print("fake docker: unsupported template action " + repr(match.group(1)), file=sys.stderr); sys.exit(2)',
  'if argv[:1] == ["build"]:',
  '    parser = argparse.ArgumentParser(prog="docker build", add_help=False)',
  '    parser.add_argument("--target"); parser.add_argument("--build-arg", action="append", default=[])',
  '    parser.add_argument("-t", "--tag", action="append", default=[]); parser.add_argument("--label", action="append", default=[])',
  '    parser.add_argument("context")',
  '    built = parser.parse_args(argv[1:])',
  '    if state["build"] == "fails": sys.exit("fake docker: the build failed")',
  '    args = dict(item.split("=", 1) for item in built.build_arg)',
  '    labels = dict(item.split("=", 1) for item in built.label)',
  '    revision = {"honest": args.get("VCS_REF", "unknown"), "stale": state["other"], "unlabelled": None}[state["build"]]',
  '    if revision is not None: labels["org.opencontainers.image.revision"] = revision',
  '    image = {"Id": "sha256:" + hashlib.sha256(json.dumps([built.target, built.context, sorted(args.items()), sorted(labels.items())]).encode()).hexdigest(),',
  '             "Config": {"Labels": labels or None}}',
  '    for tag in built.tag: state["images"][tag if ":" in tag.rsplit("/", 1)[-1] else tag + ":latest"] = image',
  '    with open(path, "w", encoding="utf-8") as stream: json.dump(state, stream)',
  '    print("naming to " + " ".join(built.tag)); sys.exit(0)',
  'if argv[:2] == ["image", "inspect"]:',
  '    parser = argparse.ArgumentParser(prog="docker image inspect", add_help=False)',
  '    parser.add_argument("-f", "--format"); parser.add_argument("images", nargs="+")',
  '    asked = parser.parse_args(argv[2:])',
  '    found = []',
  '    for ref in asked.images:',
  '        image = state["images"].get(ref) or next((i for i in state["images"].values() if i["Id"] == ref), None)',
  '        if image is None: print("Error: No such image: " + ref, file=sys.stderr); sys.exit(1)',
  '        found.append(image)',
  '    if not asked.format: print(json.dumps(found)); sys.exit(0)',
  '    for image in found: print(re.sub(r"\\{\\{-?\\s*(.*?)\\s*-?\\}\\}", action, asked.format))',
  '    sys.exit(0)',
  'print("fake docker: unsupported command " + repr(argv), file=sys.stderr); sys.exit(2)',
].join('\n');
/** A directory holding the fake `docker` (a POSIX script bash finds on PATH, running the fake with this Python). */
function fakeDockerBin(dir) {
  const bin = path.join(dir, 'bin'), unix = p => p.replace(/\\/g, '/');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'fake_docker.py'), FAKE_DOCKER);
  const exe = spawnSync(python, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nexec "' + unix(exe) + '" -B "' + unix(path.join(bin, 'fake_docker.py')) + '" "$@"\n', { mode: 0o755 });
  return bin;
}
// What scripts/record-run.py does with its child (the record itself is proven by the recorder cases): runs it as given.
const RECORDER_STAND_IN = 'python3() { case "$1" in scripts/record-run.py|./scripts/record-run.py) while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; shift; "$@" ;; *) "$KIN_EMR_PYTHON_EXE" "$@" ;; esac; }\n';
/** Runs a step's script (after the runner's substitution) with GNU bash as the runner starts it, in `cwd`. */
function runStep(h, step, env, cwd, prefix = '') {
  const file = path.join(h.scratch, 'step-' + randomUUID() + '.sh');
  fs.writeFileSync(file, prefix + actions(step.run, env));
  // The runner's PATH holds the shell's own utilities (mkdir, test, ...); Git for Windows keeps them beside its bash.
  const tools = process.platform === 'win32' && path.isAbsolute(h.bash) ? path.delimiter + path.dirname(h.bash) : '';
  env = { KIN_EMR_PYTHON_EXE: spawnSync(python, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim().replace(/\\/g, '/'), ...env };
  const done = spawnSync(h.bash, [...shellOf(h.flow, h.job, step), file.replace(/\\/g, '/')], { cwd, env: withPath({ ...process.env, ...env }, h.bin + tools), encoding: 'utf8' });
  return { status: done.status, out: String(done.stdout) + String(done.stderr) };
}
/** The image step built for `builtFor` (or not built), then the identity step checking `checkedFor`, on the fake daemon. */
function imageRun(h, { build = 'honest', builtFor, checkedFor, buildIt = true }) {
  const dir = fs.mkdtempSync(path.join(h.scratch, 'image-')), state = path.join(dir, 'docker.json');
  fs.writeFileSync(state, JSON.stringify({ build, other: h.other, images: {} }));
  const env = target => ({ KIN_FAKE_DOCKER_STATE: state, GITHUB_SHA: h.merge, TARGET_SHA: target });
  const built = buildIt ? runStep(h, h.image, env(builtFor), dir, RECORDER_STAND_IN) : null;
  const checked = runStep(h, h.identity, env(checkedFor), dir);
  const artifact = path.join(dir, 'tmp/emr-d-ci/image-identity.txt');
  return { built, checked, images: JSON.parse(fs.readFileSync(state, 'utf8')).images,
    artifact: fs.existsSync(artifact) ? fs.readFileSync(artifact, 'utf8').split(/\s+/).filter(Boolean) : null };
}

test('EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, and each record hashes what its command consumes', () => {
  const { flow, job, declaration, consumed, ids, steps } = workflowOf();
  const target = '${{ env.TARGET_SHA }}';
  assert.equal(job.env.TARGET_SHA, '${{ inputs.candidate_sha || github.event.pull_request.head.sha || github.sha }}', 'a PR checks its head, a dispatch its candidate');
  assert.equal(job.steps.find(s => String(s.uses).startsWith('actions/checkout@')).with.ref, target);
  steps.forEach((step, i) => assert.ok(step, 'the declared record ' + ids[i] + ' is a step of the workflow'));
  // D5D4-01: the server-mutants record's driver runs exactly the subvariants the declaration names beside each family, so a
  // family whose subvariants silently leave the driver is a difference here, never a smaller matrix that still passes.
  const declaredSubvariants = declaration.mutants.server.subvariants || {};
  const driver = spawnSync(python, ['-B', '-c', ['import importlib.util,json,sys',
    'spec=importlib.util.spec_from_file_location("sm",sys.argv[1]);sm=importlib.util.module_from_spec(spec);spec.loader.exec_module(sm)',
    'print(json.dumps({family:[v["id"] for v in rows] for family,rows in sm.SUBVARIANTS.items()}))'].join('\n'),
  path.join(root, 'tests/emr/d/server_mutants.py')], { encoding: 'utf8' });
  assert.equal(driver.status, 0, driver.stderr);
  assert.deepEqual(JSON.parse(driver.stdout.trim().split(/\r?\n/).at(-1)), declaredSubvariants, 'D5D4-01: the driver runs exactly the declared subvariants of each family');
  const families = declaration.mutants.server.ids, variants = Object.values(declaredSubvariants).flat();
  assert.ok(variants.length > 0, 'D5D4-01: the declaration names the mandatory subvariants');
  for (const family of Object.keys(declaredSubvariants)) assert.ok(families.includes(family), 'D5D4-01: ' + family + ' is a declared family');
  assert.equal(new Set(variants).size, variants.length, 'D5D4-01: no subvariant is declared twice');
  assert.ok(variants.every(id => !families.includes(id)), 'D5D4-01: a subvariant is never also a top-level family');
  // Explicit build-context contract (reviewed with api/Dockerfile); no Dockerfile grammar is interpreted here.
  const ran = asRun(steps.map(s => s.run)), record = id => ran.records[ids.indexOf(id)];
  const copied = ['api/package.json', 'api/package-lock.json', 'api/prisma', 'api/tsconfig.json',
    'api/nest-cli.json', 'api/src', 'api/start-production.sh', 'api/Dockerfile', 'api/.dockerignore'];
  const covers = (declared, file) => declared.some(n => file === posixName(n) || file.startsWith(posixName(n) + '/'));
  for (const file of copied) assert.ok(covers(consumed.image, file), 'the image declaration names ' + file);
  // DR3-05: each record hashes, as present, every input its command consumes; nothing it names is missing, except what an
  // earlier step of the same run produces (the image identity).
  for (const id of ids) {
    const r = pathsOf(record(id));
    assert.deepEqual([r.program, r.exit], [['python3', 'scripts/record-run.py'], 0], id + ': the recorder runs');
    for (const file of consumed[id]) assert.ok(hashes(r, file) || declaration.ci.produced_inputs.includes(file), 'the ' + id + ' record hashes ' + file);
    for (const input of r.inputs) assert.ok(input.status === 'present' || declaration.ci.produced_inputs.includes(input.requested), id + ' names ' + input.requested + ': ' + input.status);
  }
  for (const file of ['api/prisma/migrations', 'api/package-lock.json', 'api/tsconfig.json'])
    for (const id of ['server', 'server-mutants']) assert.ok(covers(consumed[id], file), 'DR3-05: the ' + id + ' declaration names ' + file);
  for (const file of ['api/tsconfig.json', 'api/package-lock.json']) assert.ok(covers(consumed.mutants, file), 'DR3-05: the mutants declaration names ' + file);
  assert.ok(covers(consumed.live, 'api/prisma/migrations'), 'R5-21: the live declaration names api/prisma/migrations (the tree its image applies)');
  const order = job.steps.map(s => s.id ?? s.name);
  for (const [before, after] of [['target-sha', 'checkout-identity'], ['checkout-identity', 'image'], ['image', 'image-identity'], ['image-identity', 'live']])
    assert.ok(order.indexOf(before) >= 0 && order.indexOf(before) < order.indexOf(after), before + ' runs before ' + after);
  // DR3-06: the shell's words decide, never their notation - escaped quotes and quoted concatenation split as a shell does,
  // and the workflow written with quoted concatenation, single quotes, backslash escapes and `./` paths records the same
  // inputs and runs the same commands.
  const renoted = steps.map(s => renote(s.run));
  assert.ok(renoted.every((line, i) => line !== steps[i].run), 'control: every recorder line is written differently');
  assert.deepEqual(asRun(renoted).records.map(pathsOf), ran.records.map(pathsOf), 'DR3-06: the shell\'s words, not their notation, decide the record and the command');

  const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'emr-d-workflow-'));
  try {
    const h = { bash: gnuBash(), flow, job, scratch, bin: fakeDockerBin(scratch), image: steps[ids.indexOf('image')],
      identity: job.steps.find(s => s.id === 'image-identity'), other: '0123456789abcdef'.repeat(2) + '01234567', merge: 'fedcba9876543210'.repeat(2) + 'fedcba98' };
    assert.ok(h.identity, 'the workflow checks the image identity');
    // R5-22 / DR4-07: the image step and the identity step, run. The image of the requested source passes and leaves
    // `<image id> <revision>` naming the image the live run uses; a wrong, unlabelled or absent image, or one built for
    // another checkout, stops the run and leaves no identity.
    const S = '89abcdef01234567'.repeat(2) + '89abcdef';
    const same = imageRun(h, { builtFor: S, checkedFor: S });
    assert.equal(same.built.status, 0, same.built.out);
    assert.equal(same.checked.status, 0, 'R5-22: the image of the requested source passes the identity check\n' + same.checked.out);
    const tag = actions(steps[ids.indexOf('live')].env.KIN_TEST_API_IMAGE, { TARGET_SHA: S });
    assert.ok(same.images[tag], 'the live run uses the image the image step built: ' + tag);
    assert.deepEqual(same.artifact, [same.images[tag].Id, S], 'R5-22: the identity names the image the live run uses and the requested source as its revision');
    for (const [build, what] of [['stale', 'labelled with another revision'], ['unlabelled', 'without a revision label']]) {
      const wrong = imageRun(h, { build, builtFor: S, checkedFor: S });
      assert.equal(wrong.built.status, 0, wrong.built.out);
      assert.notEqual(wrong.checked.status, 0, 'R5-22: image identity must refuse a wrong image (' + what + ')');
      assert.equal(wrong.artifact, null, 'R5-22: a refused image leaves no identity for the live run (' + what + ')');
    }
    const failed = imageRun(h, { build: 'fails', builtFor: S, checkedFor: S });
    assert.notEqual(failed.built.status, 0, 'a failed build fails the image step');
    assert.notEqual(failed.checked.status, 0, 'R5-22: no image, no identity');
    assert.equal(failed.artifact, null);
    const elsewhere = imageRun(h, { builtFor: h.other, checkedFor: S });
    assert.equal(elsewhere.built.status, 0, elsewhere.built.out);
    assert.notEqual(elsewhere.checked.status, 0, 'R5-22: image identity must refuse a wrong image (built for another checkout)');
    assert.equal(elsewhere.artifact, null);
    // The checkout and the requested SHA, run in a checkout: another commit checked out than TARGET_SHA, or a TARGET_SHA that
    // is not a full lowercase commit SHA, stops the run.
    const tiny = path.join(scratch, 'tiny'), git = gitIn(tiny);
    fs.mkdirSync(path.join(tiny, 'emr/units'), { recursive: true });
    fs.mkdirSync(path.join(tiny, 'scripts'));
    fs.copyFileSync(path.join(root, 'scripts/record-run.py'), path.join(tiny, 'scripts/record-run.py'));
    fs.writeFileSync(path.join(tiny, 'emr/units/d.json'), JSON.stringify({ cases: {}, mutants: {},
      ci: { recorded_inputs: { one: ['data.txt'] }, produced_inputs: [], outputs: { one: { kind: 'exit' } } } }));
    fs.writeFileSync(path.join(tiny, 'data.txt'), 'SYN first\n');
    git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'first');
    const first = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(tiny, 'data.txt'), 'SYN second\n');
    git('commit', '-q', '-am', 'second');
    const head = git('rev-parse', 'HEAD');
    const checkout = job.steps.find(s => s.id === 'checkout-identity'), requested = job.steps.find(s => s.id === 'target-sha');
    assert.equal(runStep(h, checkout, { TARGET_SHA: head }, tiny).status, 0, 'the checkout of the requested commit passes');
    assert.notEqual(runStep(h, checkout, { TARGET_SHA: first }, tiny).status, 0, 'R5-22: a checkout of another commit than TARGET_SHA is refused');
    assert.equal(runStep(h, requested, { TARGET_SHA: head }, tiny).status, 0, 'a full lowercase commit SHA is a requested source');
    for (const bad of ['', head.slice(1), head.toUpperCase(), head + '0', 'main'])
      assert.notEqual(runStep(h, requested, { TARGET_SHA: bad }, tiny).status, 0, 'a TARGET_SHA that is not a full lowercase commit SHA is refused: ' + bad);
    // Public TypeScript CLI: the real workflow child must typecheck, including failures.
    const compilerRoot = path.join(scratch, 'compiler');
    fs.mkdirSync(path.join(compilerRoot, 'api/src'), { recursive: true });
    fs.symlinkSync(path.join(api, 'node_modules'), path.join(compilerRoot, 'api/node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(path.join(compilerRoot, 'api/tsconfig.json'), JSON.stringify({ compilerOptions: { incremental: true, outDir: './dist', skipLibCheck: true, types: [] }, include: ['src/**/*.ts'] }));
    const observer = path.join(compilerRoot, 'observe-cache.cjs');
    fs.writeFileSync(observer, "const fs = require('node:fs'); const read = fs.readFileSync; fs.readFileSync = function(file, ...args) { if (String(file).endsWith('.tsbuildinfo')) throw new Error('D5D-05: unexpected cache read'); return read.call(this, file, ...args); };");
    const compile = text => {
      fs.writeFileSync(path.join(compilerRoot, 'api/src/input.ts'), text);
      return runStep(h, steps[ids.indexOf('typecheck')], { TARGET_SHA: head, NODE_OPTIONS: '--require ' + JSON.stringify(observer) }, compilerRoot, RECORDER_STAND_IN);
    };
    const cache = path.join(compilerRoot, 'api/dist/tsconfig.tsbuildinfo');
    for (const contents of [null, 'SYN prior cache', 'SYN different cache']) {
      if (contents !== null) { fs.mkdirSync(path.dirname(cache), { recursive: true }); fs.writeFileSync(cache, contents); }
      const ok = compile('export const value: number = 1;');
      assert.equal(ok.status, 0, 'D5D-08: real tsc passes a valid program\n' + ok.out);
      assert.match(ok.out, /^Check time:\s+\d/m, 'D5D-08: the child reports an actual typecheck');
      assert.match(ok.out, /input\.ts/, 'D5D-08: the checked source is reported');
      assert.equal(fs.existsSync(cache) ? fs.readFileSync(cache, 'utf8') : null, contents, 'D5D-05: incremental cache is neither consumed nor written');
    }
    const syntax = compile('export const value = ;'), type = compile('export const value: number = "SYN";');
    assert.notEqual(syntax.status, 0, 'D5D-08: tsc refuses syntax errors');
    assert.match(syntax.out, /error TS\d+:/);
    assert.notEqual(type.status, 0, 'D5D-08: tsc refuses type errors');
    assert.match(type.out, /error TS2322:/);
    fs.unlinkSync(path.join(compilerRoot, 'api/node_modules'));

    // Import the real live class, substitute only the external ports, and stop at DB entry.
    const liveProbe = String.raw`
import importlib.util,json,os,pathlib,sys,tempfile
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('live',sys.argv[1]); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
expected='sha256:'+'f'*64; target='a'*40
with tempfile.TemporaryDirectory() as tmp:
 identity=pathlib.Path(tmp)/'identity';identity.write_text(expected+' '+target)
 for label,ident,revision in [('match',expected,target),('retag','sha256:'+'e'*64,target),('revision',expected,'b'*40),('missing',expected,None)]:
  events=[]
  def run(args,**kwargs):
   assert args[:3]==['docker','image','inspect'],args
   return type('Result',(),{'stdout':json.dumps([{'Id':ident,'Config':{'Labels':{'org.opencontainers.image.revision':revision}}}]).encode()})()
  def db():
   events.append('DB');raise RuntimeError('DB_START')
  with patch.dict(os.environ,{'KIN_TEST_API_IMAGE':'syn:tag','TARGET_SHA':target,'KIN_EMR_D_IMAGE_IDENTITY':str(identity)}),patch.object(m.gate,'require_live_run'),patch.object(m,'run',run),patch.object(m.EmrDLive,'start_db',db),patch.object(m.EmrDLive,'cleanup_resources'):
   try:m.EmrDLive.setUpClass()
   except RuntimeError as e: error=str(e)
   else:raise AssertionError('probe must stop')
   finally:m.EmrDLive.doClassCleanups()
  assert bool(events)==(label=='match'),(label,events,error)
  if label=='match':assert m.EmrDLive.image==expected
  print(label,error)
`;
    const selectedImage = spawnSync(python, ['-B', '-c', liveProbe, path.join(root, 'tests/emr/d/live.py')], { encoding: 'utf8' });
    assert.equal(selectedImage.status, 0, 'D5D-03: identity mismatch is refused before DB start\n' + selectedImage.stdout + selectedImage.stderr);
    assert.match(selectedImage.stdout, /EMR_D_USED_IMAGE/, 'D5D-03: used immutable ID is preserved');

    const interruption = String.raw`
import importlib.util,json,pathlib,sys,tempfile,os,time,subprocess,threading,signal
spec=importlib.util.spec_from_file_location('same_source',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
 baseline=time.monotonic()
 for label in ['completed','timeout']:
  timeout=2400 if label=='completed' else max(10,4*(time.monotonic()-baseline))
  folder=pathlib.Path(tmp)/label
  receipt=pathlib.Path(tmp)/'tree.json'
  child='print("SYN completed",flush=True)' if label=='completed' else '\n'.join([
   'import os,sys,time,json,pathlib,subprocess',
   'descendant=subprocess.Popen([sys.executable,"-c","import time;time.sleep(86400)"])',
   'pathlib.Path(sys.argv[1]).write_text(json.dumps([os.getpid(),descendant.pid]))',
   'print("SYN partial",flush=True)',
   'while True: time.sleep(86400)',
  ])
  result=[];failures=[];finished=threading.Event();handles=[];pids=[]
  if os.name=='nt':
   import ctypes
   from ctypes import wintypes
   kernel=ctypes.WinDLL('kernel32',use_last_error=True)
   kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];kernel.OpenProcess.restype=wintypes.HANDLE
   kernel.WaitForSingleObject.argtypes=[wintypes.HANDLE,wintypes.DWORD]
   kernel.TerminateProcess.argtypes=[wintypes.HANDLE,wintypes.UINT]
   kernel.CloseHandle.argtypes=[wintypes.HANDLE]
  def alive(pid,handle):
   if os.name=='nt':return kernel.WaitForSingleObject(handle,0)==258
   try:
    os.kill(pid,0)
    stat=pathlib.Path('/proc')/str(pid)/'stat'
    return not stat.exists() or stat.read_text().rsplit(')',1)[1].split()[0]!='Z'
   except ProcessLookupError:return False
  def execute():
   try:result.append(m.recorded_execution([sys.executable,'-c',child,str(receipt)],sys.argv[2],os.environ,folder,timeout,[label]))
   except BaseException as exc:failures.append(exc)
   finally:finished.set()
  worker=threading.Thread(target=execute);worker.start()
  try:
   if label=='timeout':
    deadline=time.monotonic()+max(30,4*timeout)
    while not receipt.exists() and not finished.is_set() and time.monotonic()<deadline:time.sleep(.05)
    assert receipt.exists(),'D5D3-03: hung child tree started'
    # Capture handles while these owned children are alive, avoiding PID reuse on Windows.
    while not pids:
     try:pids=json.loads(receipt.read_text())
     except json.JSONDecodeError:
      assert time.monotonic()<deadline,'D5D3-03: process receipt completed'
      time.sleep(.05)
    for pid in pids:
     handle=kernel.OpenProcess(0x100001,False,pid) if os.name=='nt' else None
     if os.name=='nt':assert handle,'D5D3-03: owned child is observable'
     handles.append(handle)
    assert all(alive(pid,handle) for pid,handle in zip(pids,handles)),'D5D3-03: hung child and descendant were running'
   ended=finished.wait(2400 if label=='completed' else max(30,4*timeout))
   assert ended and not any(alive(pid,handle) for pid,handle in zip(pids,handles)),'D5D3-03: timeout kills the hung child and descendant'
  finally:
   # Only this probe's children can be cleaned up, including when kill is deliberately removed.
   for pid,handle in zip(pids,handles):
    if alive(pid,handle):
     if os.name=='nt':
      kernel.TerminateProcess(handle,1)
      assert kernel.WaitForSingleObject(handle,30000)==0,'D5D3-03: owned cleanup completed'
     else:os.kill(pid,signal.SIGKILL)
   worker.join()
   for handle in handles:
    if os.name=='nt':kernel.CloseHandle(handle)
  assert not failures,failures
  code,out,err=result[0]
  assert ('SYN completed' if label=='completed' else 'SYN partial') in out,(label,out,err)
  assert code==(0 if label=='completed' else 124),(label,code)
  assert (folder/'run.json').is_file()
  execution=json.loads((folder/'execution.json').read_text())
  child_exit=json.loads((folder/'child-exit.json').read_text())
  assert execution['selected']==[label]
  expected='completed' if label=='completed' else 'interrupted'
  assert execution['status']==child_exit['status']==expected,'D5D3-04: execution and child record the actual interruption state'
  assert execution['exit']==child_exit['exit']==code
  if label=='timeout':
   assert execution['exit_note'] and execution['error']==child_exit['error']=='TimeoutExpired','D5D3-04: interruption reason is retained'
   assert child_exit['child_process_exit']!=0,'D5D3-03: hung child did not finish normally'
  else:
   assert execution['exit_note'] is None and execution['error'] is None and child_exit['error'] is None
 assert 'SYN completed' in (pathlib.Path(tmp)/'completed/stdout.log').read_text()
 # Reviewer's lifecycle injection: a completed mutant, then partial timeout; the next run sees the preceding summary.
 import contextlib,io,subprocess
 from unittest import mock
 sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent))
 spec=importlib.util.spec_from_file_location('sm',pathlib.Path(sys.argv[1]).with_name('server_mutants.py'));sm=importlib.util.module_from_spec(spec);spec.loader.exec_module(sm)
 class Copy:
  def __init__(self,*a):self.root=pathlib.Path(sys.argv[2]);self.hashes={}
  def __enter__(self):return self
  def __exit__(self,*a):pass
 calls=[];summary=pathlib.Path(tmp)/'summary.json'
 def child(node,test,cases=None):
  calls.append(cases)
  if len(calls)<=2:
   return 0,'\n'.join('ok %d - %s'%(i,n) for i,n in enumerate(cases or list(sm.CASE.values()),1))+'\n','SYN baseline stderr'
  if len(calls)==3:
   mutant=sm.MUTANTS[0]
   return 1,'not ok 1 - '+mutant['case']+'\n  ---\n  failureType: \'testCodeFailure\'\n  code: \'ERR_ASSERTION\'\n  error: '+mutant['expect']+'\n  ...\n','SYN completed stderr'
  prior=json.loads(summary.read_text());assert len(prior['mutants'])==1,'previous summary not flushed'
  raise subprocess.TimeoutExpired([node,'--test'],900,output=b'SYN partial stdout',stderr=b'SYN partial stderr')
 with mock.patch.object(sm,'Copy',Copy),mock.patch.object(sm,'run',child),mock.patch.object(sm,'check_anchors',lambda:[]),mock.patch.object(sys,'argv',['mutants','--out',str(summary)]),contextlib.redirect_stdout(io.StringIO()):
  code=sm.main()
 result=json.loads(summary.read_text());assert code==1 and len(calls)==4,(code,calls)
 assert result['mutants'][0]['killed'] and result['mutants'][0]['stderr']=='SYN completed stderr'
 assert result['mutants'][1]['stdout']=='SYN partial stdout' and result['mutants'][1]['exit']==124
 assert len(result['pending'])==len(sm.MUTANTS)-2+len(sm.EQUIVALENTS)
 assert (summary.with_suffix('.runs')/'interruption-000/stdout.log').read_text()=='SYN partial stdout'
 # Every newly required subvariant participates in the declared family's verdict.
 original=sm.MUTANTS[0];variant=sm.SUBVARIANTS['M-D-D5D-07'][0]
 for survives in [False,True]:
  calls=[];summary=pathlib.Path(tmp)/('family-'+str(survives)+'.json')
  def family_child(node,test,cases=None):
   calls.append(cases)
   if len(calls)<=2 or (len(calls)==4 and survives):
    return 0,'\n'.join('ok %d - %s'%(i,n) for i,n in enumerate(cases or [original['case']],1))+'\n',''
   item=original if len(calls)==3 else variant
   return 1,'not ok 1 - '+item['case']+'\n  ---\n  failureType: \'testCodeFailure\'\n  code: \'ERR_ASSERTION\'\n  error: '+item['expect']+'\n  ...\n',''
  with mock.patch.object(sm,'Copy',Copy),mock.patch.object(sm,'run',family_child),mock.patch.object(sm,'check_anchors',lambda:[]),mock.patch.object(sm,'MUTANTS',[original]),mock.patch.object(sm,'EQUIVALENTS',[]),mock.patch.object(sm,'SUBVARIANTS',{original['id']:[variant]}),mock.patch.object(sys,'argv',['mutants','--out',str(summary)]),contextlib.redirect_stdout(io.StringIO()):
   code=sm.main()
  family=json.loads(summary.read_text())['mutants'][0]
  assert len(calls)==4 and family['original_killed'] and len(family['subvariants'])==1
  assert code==int(survives) and family['killed']==(not survives),'D5D3: a surviving subvariant fails its declared family and the driver'
`;
    const interrupted = spawnSync(python, ['-B', '-c', interruption, path.join(root, 'tests/emr/d/same_source.py'), root], { encoding: 'utf8' });
    assert.equal(interrupted.status, 0, 'D5D-07: completed and interrupted raw streams survive\n' + interrupted.stdout + interrupted.stderr);
    // The last step (tests/emr/d/same_source.py) on a real record of this checkout - its full matrix is the evidence case.
    const gateJob = flow.jobs['emr-d-gate'];
    assert.ok(gateJob, 'D5D-06: gate job exists');
    const finalGate = gateJob.steps.find(s => s.id === 'same-source');
    assert.ok(finalGate, 'D5D-06: final gate exists');
    assert.equal(typeof finalGate.run, 'string', 'D5D-06: final gate command is a shell script');
    const setOf = value => [...new Set(Array.isArray(value) ? value : value == null ? [] : [value])].sort();
    assert.deepEqual(setOf(gateJob.needs), ['emr-d', 'emr-d-server-mutants'], 'D5D-06: gate waits for both record jobs');
    // Explicit documented status-expression contract, not a second expression parser.
    const expression = value => typeof value === 'string' ? value.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1').replace(/\s+/g, '') : value;
    const failureSafe = value => ['!cancelled()', 'always()', 'success()||failure()', 'failure()||success()'].includes(expression(value));
    const enforced = value => value === undefined || value === false || expression(value) === 'false';
    assert.ok(failureSafe(gateJob.if), 'D5D2-01: gate job runs on failure');
    assert.ok(enforced(gateJob['continue-on-error']), 'D5D2-01: gate job cannot ignore failure');
    assert.ok(failureSafe(finalGate.if), 'D5D-06: final gate runs on failure');
    assert.ok(enforced(finalGate['continue-on-error']), 'D5D2-01: gate step cannot ignore failure');
    assert.equal(gateJob.env.TARGET_SHA, job.env.TARGET_SHA, 'D5D2: gate source equals producer source');
    assert.equal(gateJob.steps.find(s => String(s.uses).startsWith('actions/checkout@'))?.with?.ref, target, 'D5D2: gate checks out requested source');
    for (const [name, limit] of [['emr-d', 120], ['emr-d-server-mutants', 270], ['emr-d-gate', 10]])
      assert.ok(Number.isInteger(flow.jobs[name]['timeout-minutes']) && flow.jobs[name]['timeout-minutes'] > 0 && flow.jobs[name]['timeout-minutes'] <= limit, 'D5D2: bounded job budget ' + name);
    assert.deepEqual(setOf('one'), setOf(['one']), 'D5D2-02: scalar and singleton needs have equal meaning');
    const gateIndex = gateJob.steps.indexOf(finalGate);
    const gateUpload = gateJob.steps.find(s => String(s.uses).startsWith('actions/upload-artifact@'));
    assert.ok(gateUpload, 'D5D3-02: combined gate evidence upload exists');
    assert.equal(expression(gateUpload.if), 'always()', 'D5D3-02: combined gate evidence uploads always');
    assert.equal(gateUpload.with?.path, 'tmp/emr-d-ci/', 'D5D3-02: combined gate evidence includes the entire record root');
    assert.equal(gateUpload.with?.['if-no-files-found'], 'error', 'D5D3-02: missing combined gate evidence is an error');
    assert.ok(gateJob.steps.indexOf(gateUpload) > gateIndex, 'D5D3-02: combined evidence upload follows the final gate');
    for (const producer of ['emr-d', 'emr-d-server-mutants']) {
      const sourceJob = flow.jobs[producer];
      assert.deepEqual(setOf(sourceJob.needs), [], 'D5D2-06: record jobs run in parallel');
      assert.ok(sourceJob.if === undefined || failureSafe(sourceJob.if), 'D5D2: producer is not skipped');
      assert.ok(enforced(sourceJob['continue-on-error']), 'D5D2: producer cannot ignore failure');
      assert.equal(sourceJob.env.TARGET_SHA, job.env.TARGET_SHA, 'D5D2: producers use one source');
      assert.equal(sourceJob.steps.find(s => String(s.uses).startsWith('actions/checkout@'))?.with?.ref, target, 'D5D2: producer checks out requested source');
      const upload = sourceJob.steps.find(s => String(s.uses).startsWith('actions/upload-artifact@'));
      const producerGate = sourceJob.steps.find(s => s.id === 'producer-source');
      assert.ok(producerGate, 'D5D3: producer verifies its final checkout');
      assert.ok(failureSafe(producerGate.if), 'D5D3: producer verification runs on failure');
      assert.ok(enforced(producerGate['continue-on-error']), 'D5D3: producer verification cannot ignore failure');
      assert.ok(sourceJob.steps.indexOf(producerGate) > Math.max(...sourceJob.steps.map((s, i) => ids.includes(s.id) ? i : -1)) && sourceJob.steps.indexOf(producerGate) < sourceJob.steps.indexOf(upload), 'D5D3: producer verification follows records and precedes upload');
      assert.ok(upload && failureSafe(upload.if), 'D5D2: evidence uploads on failure');
      assert.equal(upload.with.path, 'tmp/emr-d-ci/', 'D5D2: entire evidence tree uploaded');
      assert.equal(upload.with['if-no-files-found'], 'error', 'D5D2: missing evidence is an error');
      assert.ok(sourceJob.steps.indexOf(upload) > Math.max(...sourceJob.steps.map((s, i) => ids.includes(s.id) ? i : -1)), 'D5D2: upload follows records');
      const download = gateJob.steps.find(s => String(s.uses).startsWith('actions/download-artifact@') && s.with?.name === upload.with.name);
      assert.ok(download && gateJob.steps.indexOf(download) < gateIndex, 'D5D-06: final gate runs after every record');
      assert.ok(failureSafe(download.if), 'D5D2: downloads run on failure');
      assert.equal(download.with.path, 'tmp/emr-d-ci/', 'D5D2: downloads restore the record root');
      assert.equal(download.with['run-id'], undefined, 'D5D2: downloads belong to this workflow run');
      assert.equal(download.with.repository, undefined, 'D5D2: downloads belong to this repository');
    }
    fs.mkdirSync(path.join(tiny, 'tests/emr/d'), { recursive: true });
    fs.copyFileSync(path.join(root, 'tests/emr/d/same_source.py'), path.join(tiny, 'tests/emr/d/same_source.py'));
    const check = runs => {
      fs.rmSync(path.join(tiny, 'tmp'), { recursive: true, force: true });
      fs.mkdirSync(path.join(tiny, 'tmp/emr-d-ci'), { recursive: true });
      fs.writeFileSync(path.join(tiny, 'tmp/emr-d-ci/image-identity.txt'), 'sha256:' + 'f'.repeat(64) + ' ' + head + '\n');
      const [one] = asRun([{ line: 'python3 scripts/record-run.py --run-dir tmp/emr-d-ci/one --cwd . --file data.txt -- true', cwd: tiny, own_run_dir: true }]).records;
      assert.equal(one.exit, 0, one.stderr);
      const file = path.join(tiny, 'tmp/emr-d-ci/one/run.json');
      fs.writeFileSync(file, JSON.stringify(runs(JSON.parse(fs.readFileSync(file, 'utf8')))));
      return runStep(h, finalGate, { TARGET_SHA: head }, tiny, 'python3() { \"' + python.replace(/\\/g, '/') + '\" \"$@\"; }\n');
    };
    const valid = check(run => run);
    assert.equal(valid.status, 0, 'a record of TARGET_SHA hashing its declared input as TARGET_SHA holds it passes\n' + valid.out);
    assert.equal(check(run => ({ ...run, git_head_after: first })).status, 1, 'a record of another commit fails the check (after its command)');
    assert.equal(check(run => ({ ...run, git_head_before: first })).status, 1, 'a record of another commit fails the check (before its command)');
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

// What a recorded command does in the evidence case: optionally changes (append:<path>) or removes (remove:<path>) inputs
// while it runs, prints a prepared output (its tool's own format) and exits with a given code.
const CHILD = [
  'import os, sys',
  'out, code = sys.argv[1], int(sys.argv[2])',
  'for action in sys.argv[3:]:',
  '    kind, name = action.split(":", 1)',
  '    if kind == "append":',
  '        with open(name, "ab") as stream: stream.write(b"\\n-- SYN changed while recorded\\n")',
  '    else:',
  '        os.remove(name)',
  'if out != "-":',
  '    with open(out, "rb") as stream: sys.stdout.buffer.write(stream.read())',
  'sys.exit(code)',
].join('\n');

test('EMR-D evidence: same_source.py passes only records of TARGET_SHA that hashed, unchanged, every file their step consumes as TARGET_SHA holds it, with their logs, exits and declared cases, and the image of TARGET_SHA', () => {
  const { declaration, consumed, ids, steps } = workflowOf();
  const produced = declaration.ci.produced_inputs.map(posixName);
  const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'emr-d-evidence-'));
  try {
    // A checkout of one commit holding every input the workflow's recorders name, copied from this tree; the recorder itself
    // lists what each line names.
    const named = new Set(asRun(steps.map(s => s.run)).records.flatMap(r => r.inputs.map(i => posixName(i.tree ?? i.requested))).filter(n => !produced.includes(n)));
    const repo = path.join(scratch, 'repo'), git = gitIn(repo);
    for (const name of named) fs.cpSync(path.join(root, name), path.join(repo, name), { recursive: true });
    git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'SYN evidence checkout');
    const sha = git('rev-parse', 'HEAD'), other = git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'SYN another commit');
    const runs = path.join(repo, 'tmp/emr-d-ci'), outputs = path.join(scratch, 'outputs');
    fs.mkdirSync(outputs);
    // Each step's output in its tool's own format: node's junit report (by node itself), the mutant drivers' summary, the
    // runner's EXACT_TESTS/PLAN_RESULT lines.
    const junitOf = (passing, skipped = []) => {
      const file = path.join(outputs, 'cases-' + randomUUID() + '.cjs'), env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      fs.writeFileSync(file, "'use strict';\nconst { test } = require('node:test');\n" + passing.map(n => 'test(' + JSON.stringify(n) + ', () => {});\n').join('')
        + skipped.map(n => 'test.skip(' + JSON.stringify(n) + ', () => {});\n').join(''));
      const done = spawnSync(process.execPath, ['--test', '--test-reporter=junit', file], { encoding: 'utf8', env });
      assert.equal(done.status, 0, done.stderr);
      return done.stdout;
    };
    const kinds = declaration.ci.outputs, server = declaration.cases.server.cases, contract = declaration.cases.contract;
    const summaryOf = section => ({ mutants: section.ids.map(id => ({ id, killed: true, subvariants: ((section.subvariants || {})[id] || []).map(v => ({ id: v, killed: true })) })),
      equivalents: (section.equivalents || []).map(id => ({ id, holds: true })),
      not_run: section.not_run || [], result: { killed: section.ids.length, total: section.ids.length } });
    const standard = {
      junit: { server: junitOf(server), contract: junitOf(contract.cases.filter(n => !contract.skipped.includes(n)), contract.skipped) },
      mutants: section => JSON.stringify(summaryOf(section)),
      'run-tests': section => 'EXACT_TESTS ' + JSON.stringify(section.cases.map(c => 'live.' + section.class + '.' + c)) + '\nPLAN_RESULT '
        + JSON.stringify({ status: 'passed', exit_code: 0 }) + '\nEMR_D_USED_IMAGE ' + JSON.stringify({ id: 'sha256:' + 'f'.repeat(64), revision: sha }) + '\n',
    };
    const outputOf = id => {
      const kind = kinds[id];
      if (kind.kind === 'tsc') return [...fs.readdirSync(path.join(repo, 'api/src'), { recursive: true }).filter(n => n.endsWith('.ts')).map(n => path.join(repo, 'api/src', n).replace(/\\/g, '/')), 'Files: 1', 'Types: 1', 'Check time: 0.01s', 'Total time: 0.01s'].join('\n');
      if (kind.kind === 'junit') return standard.junit[kind.declared];
      if (kind.kind === 'mutants') return standard.mutants(kind.declared ? declaration.mutants[kind.declared] : { ids: ['M-SYN-1'] });
      if (kind.kind === 'run-tests') return standard['run-tests'](declaration.cases[kind.declared]);
      return null;
    };
    const record = (list, { exit = 0, actions: changes = [], output, line } = {}) => asRun(list.map(id => {
      const text = output !== undefined ? output : outputOf(id);
      const file = text === null ? '-' : path.join(outputs, id + '-' + randomUUID() + '.out');
      if (text !== null) fs.writeFileSync(file, text);
      return { line: line || steps[ids.indexOf(id)].run, cwd: repo, own_run_dir: true, child: ['{python}', '-c', CHILD, file, String(exit), ...changes] };
    })).records.forEach((r, i) => assert.equal(r.exit, exit, list[i] + ': ' + r.stderr));
    const rerecord = (id, options) => { fs.rmSync(path.join(runs, id), { recursive: true, force: true }); record([id], options); };
    const identity = path.join(runs, 'image-identity.txt');
    const writeIdentity = text => { fs.mkdirSync(runs, { recursive: true }); fs.writeFileSync(identity, text); };
    writeIdentity('sha256:' + 'f'.repeat(64) + ' ' + sha + '\n');
    record(ids);
    const check = (targetSha = sha) => {
      const done = spawnSync(python, ['-B', path.join(repo, 'tests/emr/d/same_source.py')], { cwd: repo, env: { ...process.env, TARGET_SHA: targetSha }, encoding: 'utf8' });
      const report = path.join(runs, 'same-source.json');
      return { status: done.status, out: done.stdout + done.stderr, report: fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null };
    };
    const pristine = path.join(scratch, 'pristine');
    fs.cpSync(runs, pristine, { recursive: true });
    const reset = () => {
      git('checkout', '-q', '--', '.');
      git('clean', '-fdq', '-e', 'tmp');
      fs.rmSync(runs, { recursive: true, force: true });
      fs.cpSync(pristine, runs, { recursive: true });
    };
    const passes = (title, change) => {
      reset();
      change();
      const r = check();
      assert.equal(r.status, 0, title + '\n' + r.out);
      assert.deepEqual(Object.keys(r.report.steps).sort(), [...ids].sort());
      for (const [id, s] of Object.entries(r.report.steps)) assert.equal(s.verdict, 'pass', title + ': ' + id);
      return r;
    };
    const refused = (title, change, { step, names = [], target, verdict } = {}) => {
      reset();
      change();
      const r = check(target);
      assert.equal(r.status, 1, title + ' is refused\n' + r.out);
      assert.ok(r.report, title + ': same_source wrote its report\n' + r.out);
      const problems = step ? r.report.steps[step].problems : r.report.problems;
      if (step) assert.notEqual(r.report.steps[step].verdict, 'pass', title + ': the ' + step + ' record is not a pass');
      if (verdict) assert.equal(r.report.steps[step].verdict, verdict, title + ': ' + verdict);
      for (const name of names) assert.ok(problems.some(p => p.includes(name)), title + ': the refusal names ' + name + '\n' + problems.join('\n'));
    };
    const edit = (id, change) => {
      const file = path.join(runs, id, 'run.json');
      fs.writeFileSync(file, JSON.stringify(change(JSON.parse(fs.readFileSync(file, 'utf8')))));
    };
    const each = (run, change) => ({ ...run, files_before: change(run.files_before), files_after: change(run.files_after) });
    const migrations = fs.readdirSync(path.join(repo, 'api/prisma/migrations'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
    const firstMigration = 'api/prisma/migrations/' + migrations[0] + '/migration.sql', lastMigration = 'api/prisma/migrations/' + migrations.at(-1) + '/migration.sql';
    const added = 'api/prisma/migrations/29991231000000_syn/migration.sql';

    // Same inputs pass - as recorded, recorded again, and recorded from the lines in other shell notation.
    const valid = passes('every record of TARGET_SHA, hashing what its command consumes as TARGET_SHA holds it, passes', () => {});
    assert.deepEqual(valid.report.steps.contract.collected.skipped, contract.skipped, 'R5-21: a declared skip is kept as a skip, never counted as a pass');
    assert.deepEqual(valid.report.steps.server.collected.passed.slice().sort(), server.slice().sort(), 'the collected server cases are the declared ones');
    assert.deepEqual(valid.report.image_identity, ['sha256:' + 'f'.repeat(64), sha]);
    // Producer workspaces, not the fresh final checkout, own post-record drift.
    for (const [jobId, producer, own] of [['emr-d', 'main', ids.filter(id => id !== 'server-mutants')], ['emr-d-server-mutants', 'server-mutants', ['server-mutants']]]) {
      reset();
      const flow = workflowOf().flow, sourceJob = flow.jobs[jobId];
      const h = { flow, job: sourceJob, bash: gnuBash(), scratch, bin: fakeDockerBin(path.join(scratch, producer)) };
      const step = sourceJob.steps.find(s => s.id === 'producer-source');
      assert.ok(step, 'D5D3: producer verification exists');
      const run = () => runStep(h, step, { TARGET_SHA: sha }, repo, 'python3() { \"' + python.replace(/\\/g, '/') + '\" \"$@\"; }\n');
      for (const id of ids.filter(id => !own.includes(id))) fs.rmSync(path.join(runs, id), { recursive: true });
      const control = run();
      assert.equal(control.status, 0, 'D5D3: producer accepts exactly its own completed records\n' + control.out);
      fs.appendFileSync(path.join(repo, 'api/package-lock.json'), '\nSYN producer drift\n');
      assert.notEqual(run().status, 0, 'D5D3: producer refuses post-record drift');
      reset();
      fs.rmSync(path.join(runs, own[0]), { recursive: true });
      assert.notEqual(run().status, 0, 'D5D3: producer refuses its missing record');
      // Inspect each record's own refusal: another record that shares the input
      // must not mask a missing check here.
      const covers = (declared, file) => declared.some(n => file === posixName(n) || file.startsWith(posixName(n) + '/'));
      const driftInputs = { typecheck: 'api/tsconfig.json', contract: 'tests/emr/d/contract_test.cjs',
        mutants: 'tests/emr/d/mutants.py', server: 'scripts/emr-compose.py',
        'server-mutants': 'api/Dockerfile', image: 'api/Dockerfile', live: 'tests/live_test_gate.py' };
      for (const id of own) {
        reset();
        const file = driftInputs[id];
        assert.ok(covers(consumed[id], file), id + ' consumes its drift probe');
        if (!['typecheck', 'server-mutants'].includes(id)) assert.ok(!covers(consumed.typecheck, file), id + ' drift is outside typecheck');
        fs.appendFileSync(path.join(repo, file), '\nSYN isolated producer drift\n');
        const done = run(), report = JSON.parse(fs.readFileSync(path.join(runs, 'same-source-' + producer + '.json'), 'utf8'));
        assert.notEqual(done.status, 0, 'D5D3-01: producer refuses drift in ' + id);
        assert.ok(report.steps[id]?.problems.some(p => p.includes(file) && p.includes('final checkout')),
          'D5D3-01: producer checks post-record input for ' + id + '\n' + done.out);
        reset();
        fs.rmSync(path.join(runs, id), { recursive: true });
        assert.notEqual(run().status, 0, 'D5D3-01: producer refuses missing ' + id);
      }
    }

    reset();
    const gateFlow = workflowOf().flow, gateJob = gateFlow.jobs['emr-d-gate'];
    const gateHarness = { flow: gateFlow, job: gateJob, bash: gnuBash(), scratch, bin: fakeDockerBin(path.join(scratch, 'final-gate')) };
    const gateStep = gateJob.steps.find(s => s.id === 'same-source');
    const finalRun = () => runStep(gateHarness, gateStep, { TARGET_SHA: sha }, repo, 'python3() { \"' + python.replace(/\\/g, '/') + '\" \"$@\"; }\n');
    assert.equal(finalRun().status, 0, 'D5D3: final workflow gate accepts all seven records');
    for (const id of ids) {
      reset(); fs.rmSync(path.join(runs, id), { recursive: true });
      assert.notEqual(finalRun().status, 0, 'D5D3: final workflow gate requires every record: ' + id);
    }
    passes('R5-21: the same inputs recorded again pass', () => { for (const id of ids) rerecord(id); });
    passes('R5-21: the same inputs recorded from the lines in other shell notation pass', () => {
      for (const id of ids) rerecord(id, { line: renote(steps[ids.indexOf(id)].run) });
    });
    for (const file of ['api/src/finding.service.ts', 'api/tsconfig.json', firstMigration])
      refused('D5D-01: post-run change ' + file, () => fs.appendFileSync(path.join(repo, file), '\nSYN post-run\n'), { step: 'server', names: [file] });
    refused('D5D-01: post-run migration removal', () => fs.rmSync(path.join(repo, firstMigration)), { step: 'live', names: [firstMigration] });
    refused('D5D-01: post-run migration addition', () => { fs.mkdirSync(path.dirname(path.join(repo, added)), { recursive: true }); fs.writeFileSync(path.join(repo, added), 'SELECT 1;'); }, { step: 'live', names: [added] });
    refused('D5D-01: final HEAD changed', () => git('update-ref', 'HEAD', other), { names: ['final checkout HEAD'] });
    git('update-ref', 'HEAD', sha);
    passes('D5D-01: final LF/CRLF equivalence', () => { const p = path.join(repo, firstMigration); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\r?\n/g, '\r\n')); });
    refused('D5D-02: same count different contract cases', () => rerecord('contract', { output: junitOf(contract.cases.filter(n => !contract.skipped.includes(n)).map((_, i) => 'WRONG-' + i), contract.skipped) }), { step: 'contract' });
    refused('D5D-02: duplicate contract cases', () => rerecord('contract', { output: junitOf([...contract.cases.slice(2), contract.cases[0], contract.cases[0]]) }), { step: 'contract' });
    refused('D5D-02: unexpected contract skip', () => rerecord('contract', { output: junitOf(contract.cases.slice(1), contract.cases.slice(0, 1)) }), { step: 'contract' });
    for (const selected of [[], declaration.mutants.pure.ids.slice(1), ['UNKNOWN'], [...declaration.mutants.pure.ids.slice(1), declaration.mutants.pure.ids[1]]])
      refused('D5D-02: wrong R1 mutant selection ' + selected.length, () => rerecord('mutants', { output: JSON.stringify(summaryOf({ ...declaration.mutants.pure, ids: selected })) }), { step: 'mutants' });
    refused('D5D-01: record content differs while checkout restored', () => edit('server', run => each(run, list => list.map(f => f.requested === firstMigration ? { ...f, lf_sha256: '0'.repeat(64) } : f))), { step: 'server', names: [firstMigration] });
    refused('D5D-01: raw hash cannot borrow a valid LF hash', () => edit('server', run => each(run, list => list.map(f => f.requested === 'api/tsconfig.json' ? { ...f, sha256: '0'.repeat(64) } : f))), { step: 'server', names: ['api/tsconfig.json', 'raw hash'] });
    refused('D5D-08: another command cannot borrow a TypeScript result', () => edit('typecheck', run => ({ ...run, command: ['python3', '-c', 'pass'] })), { step: 'typecheck', names: ['TypeScript CLI'] });
    refused('D5D-08: unexecuted typecheck', () => rerecord('typecheck', { output: '' }), { step: 'typecheck' });
    for (const change of [text => text.replace('live.' + declaration.cases.live.class + '.', 'live.WrongClass.'), text => text.replace(declaration.cases.live.cases[0], 'not_declared')])
      refused('D5D2-04: live selection mismatch', () => rerecord('live', { output: change(outputOf('live')) }), { step: 'live', names: ['collected'] });
    refused('D5D2-04: failing equivalent', () => {
      const summary = summaryOf(declaration.mutants.server); summary.equivalents[0].holds = false;
      rerecord('server-mutants', { output: JSON.stringify(summary) });
    }, { step: 'server-mutants', verdict: 'fail' });
    refused('D5D2-05: partial TypeScript file list', () => rerecord('typecheck', { output: outputOf('typecheck').split('\n').slice(1).join('\n') }), { step: 'typecheck', names: ['missing files'] });
    refused('D5D2-05: used image differs from verified identity', () => rerecord('live', { output: outputOf('live').replace('f'.repeat(64), 'e'.repeat(64)) }), { step: 'live', names: ['live used image'] });
    refused('D5D2-05: R1 exclusions missing', () => {
      const summary = summaryOf(declaration.mutants.pure); delete summary.not_run;
      rerecord('mutants', { output: JSON.stringify(summary) });
    }, { step: 'mutants', names: ['not_run'] });
    // Every input a step declares is required of its record, by the declaration of TARGET_SHA: a record that hashed nothing of
    // a declared tree is refused, and so is one shaped to a declaration weakened in the working tree.
    refused('DR3-05: a record that did not hash a declared input fails the check', () => edit('server', run => each(run, list => list.filter(f => !f.requested.startsWith('api/prisma/')))),
      { step: 'server', names: ['api/prisma/schema.prisma'] });
    const migration = f => f.requested.startsWith('api/prisma/migrations/');
    refused('R5-21: a declaration weakened in the working tree is not the reference', () => {
      const weak = JSON.parse(fs.readFileSync(path.join(repo, 'emr/units/d.json'), 'utf8'));
      weak.ci.recorded_inputs.live = weak.ci.recorded_inputs.live.filter(n => n !== 'api/prisma/migrations' && n !== 'emr/units/d.json');
      fs.writeFileSync(path.join(repo, 'emr/units/d.json'), JSON.stringify(weak));
      edit('live', run => each(run, list => list.filter(f => !migration(f) && f.requested !== 'emr/units/d.json')));
    }, { step: 'live', names: ['emr/units/d.json'] });
    // The migration tree, the manifests, configuration and lock files as the checkout holds them.
    refused('R5-21: a migration file removed from the checkout', () => { fs.rmSync(path.join(repo, firstMigration)); rerecord('live'); }, { step: 'live', names: [firstMigration] });
    refused('R5-21: a migration file added to the checkout', () => {
      fs.mkdirSync(path.dirname(path.join(repo, added)), { recursive: true });
      fs.writeFileSync(path.join(repo, added), 'SELECT 1;\n');
      rerecord('live');
    }, { step: 'live', names: [added] });
    refused('R5-21: a migration changed in the checkout', () => { fs.appendFileSync(path.join(repo, lastMigration), '\n-- SYN\n'); rerecord('live'); },
      { step: 'live', names: [lastMigration] });
    refused('R5-21: the lock file missing', () => { fs.rmSync(path.join(repo, 'api/package-lock.json')); rerecord('typecheck'); }, { step: 'typecheck', names: ['api/package-lock.json'] });
    refused('R5-21: the Prisma schema missing', () => { fs.rmSync(path.join(repo, 'api/prisma/schema.prisma')); rerecord('typecheck'); },
      { step: 'typecheck', names: ['api/prisma/schema.prisma'] });
    refused('R5-21: a compile configuration missing', () => { fs.rmSync(path.join(repo, 'api/nest-cli.json')); rerecord('image'); }, { step: 'image', names: ['api/nest-cli.json'] });
    refused('R5-21: the declaration missing', () => { fs.rmSync(path.join(repo, 'emr/units/d.json')); rerecord('live'); }, { step: 'live', names: ['emr/units/d.json'] });
    // Changed while the command ran.
    refused('R5-21: a migration changed while the command ran', () => rerecord('live', { actions: ['append:' + lastMigration] }), { step: 'live', names: [lastMigration] });
    refused('R5-21: a migration removed while the command ran', () => rerecord('live', { actions: ['remove:' + firstMigration] }), { step: 'live', names: [firstMigration] });
    // The record itself (DR4-06, on records the recorder really wrote).
    refused('DR4-06: every migration entry removed from the server record, the schema kept', () => edit('server', run => each(run, list => list.filter(f => !migration(f)))),
      { step: 'server', names: [firstMigration] });
    refused('DR4-06: every hash removed from a record', () => edit('server', run => each(run, list => list.map(({ sha256, lf_sha256, ...rest }) => rest))),
      { step: 'server', names: ['api/tsconfig.json', lastMigration] });
    const tsconfig = f => f.requested === 'api/tsconfig.json';
    refused('DR4-06: an empty hash', () => edit('server', run => each(run, list => list.map(f => tsconfig(f) ? { ...f, sha256: '', lf_sha256: '' } : f))),
      { step: 'server', names: ['api/tsconfig.json'] });
    refused('DR4-06: a malformed hash', () => edit('server', run => each(run, list => list.map(f => tsconfig(f) ? { ...f, lf_sha256: f.lf_sha256.toUpperCase() } : f))),
      { step: 'server', names: ['api/tsconfig.json'] });
    refused('DR4-06: a hash changed after the command', () => edit('server', run => ({ ...run, files_after: run.files_after.map(f => tsconfig(f) ? { ...f, sha256: '0'.repeat(64), lf_sha256: '0'.repeat(64) } : f) })),
      { step: 'server', names: ['api/tsconfig.json'] });
    refused('R5-21: an unfinished record', () => edit('server', run => ({ ...run, status: 'running', files_after: null })), { step: 'server', verdict: 'invalid' });
    refused('a record of another commit fails the check (after its command)', () => edit('live', run => ({ ...run, git_head_after: other })), { step: 'live', names: ['another commit'] });
    refused('a record of another commit fails the check (before its command)', () => edit('live', run => ({ ...run, git_head_before: other })), { step: 'live', names: ['another commit'] });
    refused('R5-21: records of another commit than TARGET_SHA', () => {}, { target: other, step: 'server', names: ['another commit'] });
    // Unrun, failed, altered logs, collected cases.
    refused('R5-21: a declared step that did not run', () => fs.rmSync(path.join(runs, 'server'), { recursive: true }), { step: 'server', verdict: 'unrun' });
    refused('R5-21: a failing command', () => rerecord('typecheck', { exit: 1 }), { step: 'typecheck', verdict: 'fail' });
    refused('R5-21: a log changed after the run', () => fs.appendFileSync(path.join(runs, 'server', 'stderr.log'), 'SYN\n'), { step: 'server', names: ['stderr.log'] });
    refused('R5-21: a declared server case skipped', () => rerecord('server', { output: junitOf(server.slice(1), server.slice(0, 1)) }), { step: 'server', names: [server[0]] });
    refused('R5-21: a declared server case not collected', () => rerecord('server', { output: junitOf(server.slice(1)) }), { step: 'server', names: [server[0]] });
    refused('R5-21: a surviving server mutant', () => {
      const summary = summaryOf(declaration.mutants.server);
      summary.mutants[0].killed = false;
      summary.result.killed -= 1;
      rerecord('server-mutants', { output: JSON.stringify(summary) });
    }, { step: 'server-mutants', verdict: 'fail' });
    refused('D5D4-01: a server mutant family run without one of its declared subvariants', () => {
      const summary = summaryOf(declaration.mutants.server);
      const family = summary.mutants.find(m => m.subvariants.length);
      assert.ok(family, 'D5D4-01: the declaration names subvariants');
      family.subvariants.pop();
      rerecord('server-mutants', { output: JSON.stringify(summary) });
    }, { step: 'server-mutants', names: ['subvariants of'] });
    refused('R5-21: a record no step declares', () => fs.cpSync(path.join(runs, 'server'), path.join(runs, 'extra'), { recursive: true }), { names: ['a record no step declares'] });
    // The image identity (produced by the run, bound by the live record that consumed it).
    refused('R5-22: an image identity of another revision', () => { writeIdentity('sha256:' + 'f'.repeat(64) + ' ' + other + '\n'); rerecord('live', { output: outputOf('live').replace(sha, other) }); }, { names: ['not the image of'] });
    refused('R5-22: a malformed image identity', () => { writeIdentity('not-an-image ' + sha + '\n'); rerecord('live'); }, { names: ['not the image of'] });
    refused('R5-21: the image identity changed after the live run consumed it', () => writeIdentity('sha256:' + 'e'.repeat(64) + ' ' + sha + '\n'),
      { step: 'live', names: ['tmp/emr-d-ci/image-identity.txt'] });
    refused('D5D-03: a changed identity is refused even if a later log claims the new ID', () => {
      writeIdentity('sha256:' + 'e'.repeat(64) + ' ' + sha + '\n');
      const log = path.join(runs, 'live/stdout.log');
      fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace('f'.repeat(64), 'e'.repeat(64)));
      const digest = require('node:crypto').createHash('sha256').update(fs.readFileSync(log)).digest('hex');
      edit('live', run => ({ ...run, log_files: run.log_files.map(f => f.requested === 'stdout.log' ? { ...f, sha256: digest, lf_sha256: digest } : f) }));
    }, { step: 'live', names: ['tmp/emr-d-ci/image-identity.txt'] });
    assert.ok(consumed.live.includes('tmp/emr-d-ci/image-identity.txt'), 'the live run consumes the image identity');
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('EMR-D refusal matrix: every evidence boundary rejects its own counterexample', () => {
  const probe = String.raw`
import contextlib,copy,hashlib,importlib.util,io,json,os,pathlib,shutil,subprocess,sys,tempfile
spec=importlib.util.spec_from_file_location('gate',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
recorder=pathlib.Path(sys.argv[1]).resolve().parents[3]/'scripts/record-run.py'
passed=[]
def expect(label, action, fragment):
 result=action()
 assert any(fragment in str(p) for p in result),(label,fragment,result)
 passed.append(label)
def snap(items):
 bad=[];m.snapshot(items,'before',bad);return bad
h='a'*64
entry={'requested':'data.txt','status':'present','sha256':h,'lf_sha256':h}
expect('S01 malformed snapshot',lambda:snap([None]),'not a recorder entry')
expect('S02 absent input',lambda:snap([{**entry,'status':'missing'}]),'not hashed as present')
expect('S03 invalid hash',lambda:snap([{**entry,'sha256':''}]),'no valid SHA-256')
expect('S04 contradictory duplicate',lambda:snap([entry,{**entry,'sha256':'b'*64}]),'hashed twice')
with tempfile.TemporaryDirectory() as tmp, contextlib.chdir(tmp):
 root=pathlib.Path(tmp);m.RUNS=pathlib.Path('tmp/emr-d-ci')
 def write(name,value):
  p=pathlib.Path(name);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(value,encoding='utf-8');return p
 def js(name,value):return write(name,json.dumps(value))
 def git(*args):
  r=subprocess.run(['git','-c','user.name=SYN','-c','user.email=syn@example.test','-c','commit.gpgsign=false','-c','core.autocrlf=false',*args],capture_output=True,text=True)
  assert r.returncode==0,r.stderr
  return r.stdout.strip()
 write('data.txt','SYN\n');write('api/src/a.ts','export const a=1;\n');write('api/src/b.ts','export const b=2;\n')
 declaration={'ci':{'recorded_inputs':{'one':['data.txt','api/src','tmp/emr-d-ci/image-identity.txt']},'produced_inputs':['tmp/emr-d-ci/image-identity.txt'],'outputs':{'one':{'kind':'exit'}}}}
 js('emr/units/d.json',declaration);git('init','-q');git('add','data.txt','api/src','emr/units/d.json');git('commit','-qm','synthetic refusal fixture')
 sha=git('rev-parse','HEAD');commit=m.Commit(sha);os.environ['TARGET_SHA']=sha
 identity='sha256:'+'f'*64+' '+sha+'\n';write(m.RUNS/'image-identity.txt',identity)
 r=subprocess.run([sys.executable,'-B',str(recorder),'--run-dir',str(m.RUNS/'one'),'--file','data.txt','--tree','api/src','--file',str(m.RUNS/'image-identity.txt'),'--',sys.executable,'-c','print("SYN")'],capture_output=True,text=True)
 assert r.returncode==0,r.stderr
 runpath=m.RUNS/'one/run.json';original=json.loads(runpath.read_text());produced=set(declaration['ci']['produced_inputs']);needs=declaration['ci']['recorded_inputs']['one']
 def restore():
  for p in ['api/src/extra.ts','extra.txt']:
   pathlib.Path(p).unlink(missing_ok=True)
  write('api/src/a.ts','export const a=1;\n');write('api/src/b.ts','export const b=2;\n');write('data.txt','SYN\n')
  write(m.RUNS/'image-identity.txt',identity);write(m.RUNS/'one/stdout.log','SYN\n');write(m.RUNS/'one/stderr.log','');js(runpath,original)
 def checked(change=lambda r:None, **kw):
  restore();record=copy.deepcopy(original);change(record);js(runpath,record)
  return m.check_step('one',kw.get('needs',needs),produced,kw.get('output',{'kind':'exit'}),{},commit)
 assert checked()['verdict']=='pass'
 def reject(label,change,fragment,**kw):
  expect(label,lambda:checked(change,**kw)['problems'],fragment)
 reject('C01 incomplete record',lambda r:r.update(status='running'),'not a completed run')
 reject('C02 foreign source',lambda r:r.update(git_head_before='b'*40),'another commit')
 reject('C03 input disappears',lambda r:r.update(files_after=r['files_after'][1:]),'gone or unhashed')
 reject('C04 input appears',lambda r:r['files_after'].append({**entry,'requested':'extra.txt'}),'appeared during')
 reject('C05 input changes',lambda r:r['files_after'][0].update(sha256=h),'changed while')
 reject('C06 untracked input',lambda r:[r[k].append({**entry,'requested':'extra.txt'}) for k in ['files_before','files_after']],'not a file of')
 reject('C07 normalized input differs',lambda r:[r[k][0].update(lf_sha256=h) for k in ['files_before','files_after']],'differs from '+sha)
 reject('C08 raw input differs',lambda r:[r[k][0].update(sha256=h) for k in ['files_before','files_after']],'raw hash differs')
 reject('C09 produced input changed',lambda r:write(m.RUNS/'image-identity.txt','changed'),'not the file the run produced')
 reject('C10 required file unhashed',lambda r:[r.update({k:[f for f in r[k] if f['requested']!='data.txt']}) for k in ['files_before','files_after']],'declared input the record did not hash')
 reject('C11 nonexistent declaration',lambda r:None,'neither a file nor a tree',needs=[*needs,'unknown'])
 reject('C12 required tree member unhashed',lambda r:[r.update({k:[f for f in r[k] if f['requested']!='api/src/a.ts']}) for k in ['files_before','files_after']],'in api/src the record did not hash')
 reject('C13 final path added',lambda r:write('api/src/extra.ts','SYN'),'final checkout path added')
 reject('C14 final path removed',lambda r:pathlib.Path('api/src/a.ts').unlink(),'final checkout path removed')
 reject('C15 final content differs',lambda r:write('data.txt','changed'),'final checkout differs')
 reject('C16 produced input unhashed',lambda r:[r.update({k:[f for f in r[k] if m.normal(f['requested']) not in produced]}) for k in ['files_before','files_after']],'declared input the record did not hash')
 reject('C17 log hash absent',lambda r:r['log_files'][0].update(sha256=None),'log is not recorded')
 reject('C18 log changed',lambda r:write(m.RUNS/'one/stdout.log','changed'),'not the recorded bytes')
 reject('C19 child failure',lambda r:r.update(exit_code=1),'command exited 1')
 reject('C20 recorder failure',lambda r:r.update(recorder_exit_code=125),'recorder 125')
 reject('C21 compiler identity',lambda r:None,'installed TypeScript CLI',output={'kind':'tsc'})
 reject('C25 collected problems propagate',lambda r:r.update(command=['node',str(pathlib.Path('api/node_modules/typescript/bin/tsc').resolve())]),'complete TypeScript check',output={'kind':'tsc'})
 restore();runpath.unlink();assert m.check_step('one',needs,produced,{'kind':'exit'},{},commit)['verdict']=='unrun','C22 unrun record';passed.append('C22 unrun record')
 write(runpath,'{');assert m.check_step('one',needs,produced,{'kind':'exit'},{},commit)['verdict']=='invalid','C23 unreadable record';passed.append('C23 unreadable record')
 restore()
 # Each output dialect has an independent positive and isolated negatives.
 out=pathlib.Path('out');section={'cases':['one'],'skipped':[]}
 write(out,'<testsuite><testcase name="one"/></testsuite>');assert m.junit(out,section)==({'passed':['one'],'failed':[],'skipped':[]},[],False)
 expect('J01 selection',lambda:m.junit(out,{'cases':['two']})[1],'collected cases')
 expect('J02 absent declaration',lambda:m.junit(out,{})[1],'no independent exact')
 write(out,'<testsuite><testcase name="one"><skipped/></testcase></testsuite>');expect('J03 skip',lambda:m.junit(out,section)[1],'skipped, not passed')
 write(out,'<testsuite><testcase name="one"><failure/></testcase></testsuite>');assert m.junit(out,section)[2],'J04 collected failure';passed.append('J04 collected failure')
 mutant={'mutants':[{'id':'M','killed':True}],'equivalents':[{'id':'E','holds':True}],'not_run':['N'],'result':{'killed':1,'total':1}}
 selected={'ids':['M'],'equivalents':['E'],'not_run':['N']}
 def summary(change=lambda d:None,select=selected):
  data=copy.deepcopy(mutant);change(data);js(out,data);return m.mutant_summary(out,select)
 assert summary()[1:]==([],False)
 expect('M01 totals',lambda:summary(lambda d:d['result'].update(total=2))[1],'does not count')
 expect('M02 exclusions',lambda:summary(lambda d:d.pop('not_run'))[1],'not_run differs')
 expect('M03 mutant selection',lambda:summary(lambda d:d['mutants'][0].update(id='X'))[1],'mutants run')
 expect('M04 equivalent selection',lambda:summary(lambda d:d['equivalents'][0].update(id='X'))[1],'equivalents run')
 family={**selected,'subvariants':{'M':['V']}}
 assert summary(lambda d:d['mutants'][0].update(subvariants=[{'id':'V','killed':True}]),family)[1:]==([],False)
 expect('M07 subvariant selection',lambda:summary(lambda d:d['mutants'][0].update(subvariants=[{'id':'X','killed':True}]),family)[1],'subvariants of')
 for value in [False,1,None]:
  assert summary(lambda d:d['mutants'][0].update(killed=value))[2],'M05 surviving mutant';passed.append('M05 surviving mutant '+str(value))
  assert summary(lambda d:d['equivalents'][0].update(holds=value))[2],'M06 failing equivalent';passed.append('M06 failing equivalent '+str(value))
 live={'class':'Live','cases':['one']}
 lines=['EXACT_TESTS ["live.Live.one"]','PLAN_RESULT {"status":"passed"}','EMR_D_USED_IMAGE '+json.dumps({'id':'sha256:'+'f'*64,'revision':sha})]
 def runner(replacements={}):
  write(out,'\n'.join(replacements.get(i,v) for i,v in enumerate(lines))+'\n');return m.runner_lines(out,live)
 assert runner()[1:]==([],False)
 expect('L01 markers',lambda:runner({0:''})[1],'EXACT_TESTS')
 expect('L02 used identity',lambda:runner({2:lines[2].replace('f'*64,'e'*64)})[1],'live used image')
 expect('L03 class selection',lambda:runner({0:'EXACT_TESTS ["live.Wrong.one"]'})[1],'collected')
 expect('L04 method selection',lambda:runner({0:'EXACT_TESTS ["live.Live.wrong"]'})[1],'collected')
 assert runner({1:'PLAN_RESULT {"status":"failed"}'})[2],'L05 failed plan';passed.append('L05 failed plan')
 files=[str(pathlib.Path('api/src/'+n+'.ts').resolve()).replace('\\','/') for n in ['a','b']]
 metrics=['Files: 2','Types: 2','Check time: 0.1s','Total time: 0.1s']
 write(out,'\n'.join(files+metrics));assert m.collected({'kind':'tsc'},out,{})[1]==[]
 write(out,'\n'.join(files[1:]+metrics));expect('T01 partial compiler list',lambda:m.collected({'kind':'tsc'},out,{})[1],'missing files')
 write(out,'\n'.join(files));expect('T02 absent compiler metrics',lambda:m.collected({'kind':'tsc'},out,{})[1],'complete TypeScript check')
 write(out,'{');expect('O01 malformed output',lambda:m.collected({'kind':'mutants'},out,{})[1],'cannot be read')
 expect('O02 unknown output',lambda:m.collected({'kind':'unknown'},out,{})[1],'no known kind')
 # A zero exit with a real failed case must fail the step, not just expose collected data.
 restore();write(m.RUNS/'one/stdout.log','<testsuite><testcase name="one"><failure/></testcase></testsuite>')
 r=copy.deepcopy(original);digest=m.file_sha256(m.RUNS/'one/stdout.log');r['log_files'][0].update(sha256=digest,lf_sha256=digest);js(runpath,r)
 verdict=m.check_step('one',needs,produced,{'kind':'junit','declared':'syn'},{'cases':{'syn':section}},commit)
 expect('C24 zero exit failed collection',lambda:verdict['problems'],'collected cases show a failure');assert verdict['verdict']=='fail'
 def main():
  with contextlib.redirect_stdout(io.StringIO()):code=m.main()
  result=json.loads((m.RUNS/'same-source.json').read_text());return code,result
 restore();assert main()[0]==0
 r=copy.deepcopy(original);r['exit_code']=1;js(runpath,r);assert main()[0]==1,'G07 failed step refuses whole run';passed.append('G07 failed step refuses whole run');restore()
 os.environ['TARGET_SHA']='invalid';expect('G01 invalid target',lambda:main()[1]['problems'],'no declaration');os.environ['TARGET_SHA']=sha
 os.environ['TARGET_SHA']='b'*40;expect('G02 missing commit',lambda:main()[1]['problems'],'no declaration');os.environ['TARGET_SHA']=sha
 shutil.copytree(m.RUNS/'one',m.RUNS/'extra');expect('G03 undeclared record',lambda:main()[1]['problems'],'no step declares');shutil.rmtree(m.RUNS/'extra')
 write(m.RUNS/'image-identity.txt','bad');expect('G04 invalid image',lambda:main()[1]['problems'],'not the image');restore()
 git('commit','--allow-empty','-qm','other');expect('G05 checkout mismatch',lambda:main()[1]['problems'],'HEAD differs');git('reset','--soft',sha)
 declaration['ci']['outputs']['extra']={'kind':'exit'};js('emr/units/d.json',declaration);git('add','emr/units/d.json');git('commit','-qm','mismatched output declaration');os.environ['TARGET_SHA']=git('rev-parse','HEAD')
 expect('G06 output declaration mismatch',lambda:main()[1]['problems'],'ci.outputs names')
 print(json.dumps({'passed':passed,'count':len(passed)}))
`;
  const done = spawnSync(python, ['-B', '-c', probe, path.join(root, 'tests/emr/d/same_source.py')], { encoding: 'utf8' });
  assert.equal(done.status, 0, 'refusal matrix\n' + done.stdout + done.stderr);
  const result = JSON.parse(done.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(result.count, 60, 'refusal matrix reports every boundary');
});

test('TEST-D-04 atomic_retry server: the runtime is not composed unless A\'s stored-record reader serves the sources D cites', () => {
  const parts = { db: { $queryRaw: async () => [] }, ledger: fakeLedger({}), context: { facts: async () => ({}) }, studies: { facts: async () => study },
    signatures: device.ports };
  assert.throws(() => RT.composeClinicalRuntime(parts), e => e instanceof V.ContractError && e.code === 'ClinicalSourcesNotComposed');
  assert.equal(SV.clinicalRuntime(), null, 'nothing is bound: every clinical route keeps refusing with 503');
  const reader = SOURCES.clinicalStoredReader({ load: () => 'B' });
  assert.throws(() => reader.load('00000000-0000-4000-8000-000000000001', 'viewer-revision:00000000-0000-4000-8000-000000000001:1'),
    e => e instanceof V.ContractError && e.code === 'ClinicalSourceRequired', 'outside a resolution a source is refused, never guessed');
  assert.equal(reader.load('x', 'y'), 'B', 'everything else is the base reader\'s');
});

const sha256 = value => require('node:crypto').createHash('sha256').update(value, 'utf8').digest('hex');
const sorted = value => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
test('TEST-D-02 versions_and_sr server: what a finding incorporates is a fixed reference to its source\'s exact version - planned, signed, stored and recovered alike; a navigation link is none', async () => {
  COMPOSITION.composeEmrAdapters({ ...B_ADAPTERS, stored: SOURCES.clinicalStoredReader(B_ADAPTERS.stored) });
  const item = randomUUID(), key = randomUUID(), job = randomUUID(), comparison = '1.2.840.99.2';
  const length = { kind: 'length', label: 'SYN 8 mm', points: [[1, 2, 0], [3, 4, 0]], seriesUid: '1.2.840.99.1.1', sopUid: '1.2.840.99.1.1.1', frame: 1 };
  const keyImage = { kind: 'key', title: 'SYN key', seriesUid: '1.2.840.99.2.1', sopUid: '1.2.840.99.2.1.1', frame: 1 };
  const jobSnapshot = { version: 3, volume: null, marks: null };
  const at = '2026-10-12T01:02:03.004Z';
  const rows = sql => sql.includes('"ViewerJobRevision"')
    ? [{ jobId: job, revision: 2, at: new Date(at), title: 'SYN layout', description: '', hidden: false, studyUid: study.studyId, studies: [study.studyId], snapshot: JSON.stringify(jobSnapshot) }]
    : [{ itemId: item, revision: 1, action: 'create', at: new Date(at), snapshot: JSON.stringify(length), studyUid: study.studyId },
      { itemId: key, revision: 3, action: 'edit', at: new Date(at), snapshot: JSON.stringify(keyImage), studyUid: comparison }];
  const sourceDb = { $queryRaw: async strings => rows(strings.join('?')) };
  const refs = [{ kind: 'item', itemId: item, revision: 1 }, { kind: 'item', itemId: key, revision: 3 }, { kind: 'job', jobId: job, revision: 2 }];
  const resolved = await SV.readClinicalSources(sourceDb, refs);
  assert.deepEqual(resolved.map(r => [r.recordId, r.kinds[0], r.event.versionId, r.event.sha256]), [
    [item, 'measurement', 'revision:1', sha256(sorted(length))], [key, 'key-image', 'revision:3', sha256(sorted(keyImage))],
    [job, 'comparison-layout', 'revision:2', sha256(sorted({ studyUid: study.studyId, studies: [study.studyId], snapshot: jobSnapshot, title: 'SYN layout', description: '', hidden: false }))]]);
  await refusedAsync(SV.readClinicalSources(sourceDb, [{ kind: 'item', itemId: randomUUID(), revision: 1 }]), 'ClinicalSourceMissing', 'a source without its version row is refused, never left out');
  // The plan: each copied source is an attachment reference; the comparison study linked for navigation is not one.
  const body = { requestId: randomUUID(), item: { schemaVersion: 1 } }, content = 'SYN canonical finding snapshot';
  const finding = input('finding.create', r1, null, body, { content, attachments: resolved, navigation: [comparison] });
  const plan = R.planClinicalWrite(finding);
  const expected = resolved.map(r => ({ kind: r.kinds[0], recordId: r.recordId, versionId: r.event.versionId, sha256: r.event.sha256 }));
  assert.deepEqual([plan.version.attachments, plan.signing.attachments, plan.version.navigation], [expected, expected, [comparison]]);
  assert.ok(!plan.version.attachments.some(a => a.recordId === comparison), 'navigation creates no reference');
  // The author's device signs exactly these references; a payload naming other ones is refused.
  const signed = carried(plan, r1), port = portFor(signed);
  await port.verify(await port.sign(plan.signing, { originalId: 'o' }), plan.signing);
  const moved = { ...device.sign(plan.signing, { kid: 'kid-' + r1.identity.id, eventId: plan.requestId,
    change: p => ({ ...p, attachments: p.attachments.map((a, i) => i ? a : { ...a, versionId: 'revision:2' }) }) }), eventId: plan.requestId };
  await refusedAsync(portFor(moved).verify(await portFor(moved).sign(plan.signing, { originalId: 'o' }), plan.signing), 'SignatureBindingRefused');
  // Recovery of the registered original resolves the same source versions again and commits the very references signed.
  const seed = JSON.parse(JSON.stringify({ ...finding, attachments: resolved.map(r => ({ recordId: r.recordId, eventId: r.event.eventId, versionId:r.event.versionId, sha256:r.event.sha256, kinds:r.kinds })) }));
  const row = registerRow(seed, facts(r1, true), signed);
  const { db, seen } = registerDb(row, { sources: rows });
  let projected = 0;
  SV.clinicalServices.prepareProjection.delete('finding');
  SV.registerClinicalProjection('finding', async () => { projected++; });
  const runtime = new RT.ClinicalRuntime({ db, ledger: fakeLedger(db), context: {}, studies: {}, signatures: device.ports, recoveryDelayMs: 3600000 });
  assert.equal((await runtime.recover(R.prepareClinicalWrite(finding))).status, 'replayed', 'DR2-05: the recovered original resolves the same sources again and commits');
  assert.deepEqual([seen.commits, projected], [1, 1]);
  assert.deepEqual([seen.versions[0].versionId, seen.versions[0].attachments, seen.versions[0].text], [plan.version.versionId, expected, content],
    'the recovered commit stores exactly the references the author signed');
});

test('TEST-D-04 atomic_retry server: the runtime is composed once with every port and refuses a second composition', () => {
  const parts = { db: { $queryRaw: async () => [] }, ledger: { append: async () => ({}) }, context: { facts: async () => ({}) },
    studies: { facts: async () => study }, signatures: device.ports };
  assert.throws(() => RT.composeClinicalRuntime({ ...parts, ledger: null }), e => e instanceof V.ContractError && e.code === 'ClinicalRuntimePartRequired');
  const composed = RT.composeClinicalRuntime(parts);
  assert.equal(RT.clinicalRuntime(), composed);
  assert.equal(SV.requireClinicalRuntime(), composed, 'the composition binds the port of the owning services to this runtime');
  assert.throws(() => RT.composeClinicalRuntime(parts), e => e instanceof V.ContractError && e.code === 'ClinicalRuntimeAlreadyComposed');
  // DR2-08: the port is bound once at server start; no later binding (no request path) can replace it.
  assert.throws(() => SV.bindClinicalPort({ write: async () => ({}) }), e => e instanceof V.ContractError && e.code === 'ClinicalRuntimeAlreadyComposed',
    'DR2-08: no later binding replaces the port bound at server start');
  assert.equal(SV.requireClinicalRuntime(), composed);
});

// ---------------- round 4 (Astra NEEDS_FIX DR3-01..06 on a980357): each finding's behaviour, on the product code ----------------

/**
 * A separate module graph of api/src for a case that binds a runtime (or composes A's adapters) of its own: the services'
 * port is bound once per server start (DR2-08), so the case gets its own graph and the shared one stays as it was.
 */
function isolated(files) {
  const inSrc = key => key.startsWith(SRC + path.sep);
  const shared = Object.fromEntries(Object.entries(require.cache).filter(([key]) => inSrc(key)));
  for (const key of Object.keys(shared)) delete require.cache[key];
  const loader = require.extensions['.ts'];
  require.extensions['.ts'] = compileTs;
  try { return Object.fromEntries(Object.entries(files).map(([name, file]) => [name, load(file)])); }
  finally {
    for (const key of Object.keys(require.cache)) if (inSrc(key)) delete require.cache[key];
    Object.assign(require.cache, shared);
    if (loader) require.extensions['.ts'] = loader; else delete require.extensions['.ts'];
  }
}
const sqlError = code => Object.assign(new Error('SYN ' + code), { meta: { code } });
/**
 * A deterministic stand-in of the emr_clinical register and version store for any number of requests (the functions of
 * migration 46 as the runtime calls them, keyed by record/actor/request); `legacy` answers the owning service's own tables.
 */
function clinicalStore(legacy) {
  const requests = new Map(), units = new Map(), seen = { admitted: 0, commits: 0 };
  const key = v => JSON.stringify([v[0], v[1], v[2]]);
  const view = (row, kind) => [{ ...row, kind }];
  const db = { $executeRaw: async () => 0, $queryRaw: async (strings, ...v) => {
    const sql = strings.join('?');
    if(sql.includes('emr_clinical.lock_request'))return [];
    if(sql.includes('emr_clinical.response_facts'))return [...requests.values()].filter(r=>r.state==='committed'&&r.record_id===v[0]&&v[1].includes(JSON.parse(r.terminal).proof.version.versionId)).map(r=>({version_id:JSON.parse(r.terminal).proof.version.versionId,request_id:JSON.parse(r.terminal).proof.receipt.requestId,projection:JSON.stringify(JSON.parse(r.facts).projection)}));
    if (sql.includes('emr_clinical.unit_for')) return units.get(v[0]) ?? [];
    if (sql.includes('emr_clinical.admit(')) {
      const found = requests.get(key(v));
      if (found) { if (found.fingerprint !== v[3]) throw sqlError('ED002'); return view(found, 'observer'); }
      const row = { fingerprint: v[3], original_id: randomUUID(), epoch: 1, phase: 'admitted', state: 'pending', seed: v[4], facts: v[5], envelope: v[6],
        checkpoint: null, terminal: null, record_id: null, access_event: null, confirmed: false };
      requests.set(key(v), row); seen.admitted++;
      return view(row, 'owner');
    }
    if (sql.includes('emr_clinical.observe(')) {
      const found = requests.get(key(v));
      if (!found) return [];
      if (found.fingerprint !== v[3]) throw sqlError('ED002');
      return view(found, 'observer');
    }
    if (sql.includes('emr_clinical.checkpoint(')) {
      const row = requests.get(key(v));
      if (!row || row.original_id !== v[3] || row.epoch !== v[4] || row.state !== 'pending' || row.phase === 'commit-dispatched') return [{ done: false }];
      row.phase = v[5]; row.checkpoint = v[6];
      return [{ done: true }];
    }
    if (sql.includes('emr_clinical.commit_version(')) {
      const row = requests.get(key(v)), previous = units.get(v[5]) ?? [];
      if (!row || row.original_id !== v[3] || row.epoch !== v[4] || row.phase !== 'commit-dispatched' || row.state !== 'pending') throw sqlError('ED004');
      if (v[13] !== previous.length + 1) throw sqlError('ED003');
      const head = { record: v[0], study_id: v[6], managing_institution_id: v[7], patient: v[8], author_id: previous[0]?.author_id ?? v[9],
        recipient_id: previous.length ? previous[0].recipient_id : v[10], state: v[11], revision: v[13], head_version_id: v[14], head_sha256: v[15], clinical_entry: v[12] };
      units.set(v[5], [...previous, { sequence: v[13], version_id: v[14], body: v[18], signature: v[19] }].map(r => ({ ...r, ...head })));
      row.state = 'committed'; row.terminal = v[20]; row.access_event = v[21]; row.record_id = v[5]; seen.commits++;
      return [{ done: null }];
    }
    if (sql.includes('emr_clinical.confirm_request(')) { const row = requests.get(key(v)); if (row?.state === 'committed') row.confirmed = true; return [{ done: !!row }]; }
    if (sql.includes('emr_clinical.note_attempt(')) return [{ done: null }];
    return legacy(sql, v);
  } };
  db.$transaction = async work => work(db);
  return { db, requests, units, seen };
}
const statusOf = error => (typeof error?.getStatus === 'function' ? error.getStatus() : null);

test('TEST-D-04 atomic_retry server: an allocation request answers its own committed result - after a later allocation, beside a parallel duplicate and after its reader\'s account changed; only another meaning under its request ID is refused, and nothing is answered where the study is not visible today', async () => {
  const I = isolated({ SV: 'emr-clinical/services.ts', RT: 'emr-clinical/runtime.ts', A: 'reader-assignment.service.ts' });
  const tech = actor('77777777-7777-4777-8777-777777777777', ['technician']);
  // Readers are chosen by their identity provider subject (a UUID, as the assignment body requires).
  const [ra, rb] = ['78787878-7878-4787-8787-787878787871', '78787878-7878-4787-8787-787878787872'].map(id =>
    ({ ...actor(id, ['radiologist']), identity: { id, issuer: 'https://identity.example.test', subject: id.replace('7878-4787', '7979-4797') } }));
  const identities = new Map([tech, ra, rb].map(a => [a.identity.subject, a.identity]));
  const state = { uid: study.studyId, institutionId: 'inst-a', teleInstitutionId: null, rs: 'W', holder: null, heldAt: null };
  const rows = new Map(), audit = [];
  const store = clinicalStore(async sql => {
    if (sql.includes('"StudyState"')) return [{ ...state }];
    if (sql.includes('"AuditLog"')) return [];
    throw new Error('unexpected SQL ' + sql);
  });
  const db = store.db;
  db.memberRights={findUnique:async()=>({approved:true,suspended:false,institution:'inst-a',roles:['technician']})};
  db.readerAssignment = {
    findUnique: async ({ where }) => rows.get(where.studyUid_institutionId.institutionId) ?? null,
    upsert: async ({ where, create, update }) => {
      const k = where.studyUid_institutionId.institutionId, row = rows.has(k) ? { ...rows.get(k), ...update } : { ...create };
      rows.set(k, row); return row;
    },
  };
  db.auditLog = { create: async ({ data }) => { audit.push(data); return data; } };
  const disabled = new Set(), lookups = [];
  const keycloak = { getUser: async sub => {
    lookups.push(sub);
    const reader = [ra, rb].find(r => r.identity.subject === sub);
    return reader ? { id: sub, enabled: !disabled.has(sub), serviceAccountClientId: null, groups: ['inst-a'], roles: ['radiologist'],
      email: sub + '@synthetic.test', username: sub, firstName: 'SYN', lastName: 'reader' } : null;
  } };
  const runtime = new I.RT.ClinicalRuntime({ db, ledger: fakeLedger(db), studies: { facts: async () => study }, signatures: device.ports, recoveryDelayMs: 3600000,
    context: { facts: async () => ({ actor: tech, trustedProxyIp: known({ address: '10.0.0.7', source: 'trusted-proxy' }), requestId: 'request-' + randomUUID(),
      member: async subject => identities.get(subject) ?? who('unknown-' + subject), signature: null }) } });
  I.SV.bindClinicalPort(runtime);
  const service = new I.A.ReaderAssignmentService(db, keycloak, { snapshot: async () => ({}), require: async () => {}, prepare: async () => {} });
  const caller = { kind: 'member', institution: 'inst-a', sub: tech.identity.subject, actor: 'tech@synthetic.test', roles: ['technician'] };
  const send = body => service.write(study.studyId, caller, body, {});
  const allocation = (revision, reader) => ({ requestId: randomUUID(), expectedOwner: owner(tech), revision, readerSub: reader ? reader.identity.subject : null });
  const a = allocation(0, ra), b = allocation(1, rb);
  const first = await send(a), later = await send(b);
  assert.deepEqual([first.revision, first.reader?.sub, later.revision, later.reader?.sub], [1, ra.identity.subject, 2, rb.identity.subject]);
  const asked = lookups.length;
  assert.deepEqual(await send(a), first, 'DR3-01: the earlier request answers its own result after a later allocation');
  assert.equal(lookups.length, asked, 'DR3-01: a registered request is answered without asking the identity provider again');
  disabled.add(ra.identity.subject);
  assert.deepEqual(await send(a), first, 'DR3-01: its reader\'s account changed since - still the original result');
  await assert.rejects(send(allocation(2, ra)), e => statusOf(e) === 400, 'a new request still needs a reader who can be assigned today');
  await assert.rejects(send({ ...a, readerSub: rb.identity.subject }), e => statusOf(e) === 409, 'another meaning under a used request ID');
  const c = allocation(2, null);
  const [one, two] = await Promise.all([send(c), send(c)]);
  assert.deepEqual(one, two, 'two identical requests at once answer the same result');
  assert.deepEqual([one.revision, one.reader], [3, null]);
  assert.deepEqual(await send(a), first, 'DR3-01: and still after the duplicates');
  assert.deepEqual([store.seen.commits, audit.length, rows.get('inst-a').revision], [3, 3, 3], 'one commit, one row change and one audit entry per request');
  assert.deepEqual([...store.units.values()].map(u => u.length), [3], 'one operational version per committed request');
  state.institutionId = 'inst-z';
  await assert.rejects(send(a), e => statusOf(e) === 404, 'a study this institution cannot see today answers nothing, a resend included');
});

test('TEST-D-04 atomic_retry server: a consultation step resent after a later step answers that step\'s own result - its state, its text and who wrote it - through the durable provision of its own versions', async () => {
  const I = isolated({ SV: 'emr-clinical/services.ts', RT: 'emr-clinical/runtime.ts', C: 'consultation.service.ts' });
  const recipient = { ...actor('79797979-7979-4797-8797-797979797979', ['radiologist']),
    identity: { id: '79797979-7979-4797-8797-797979797979', issuer: 'https://identity.example.test', subject: '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a' } };
  device.register(recipient.identity, recipient.signingRegistrationId, 'inst-a');
  const identities = new Map([r1, recipient].map(a => [a.identity.subject, a.identity]));
  const rows = new Map(), audit = [];
  const store = clinicalStore(async sql => {
    if (sql.includes('"StudyState"')) return [{ uid: study.studyId, institutionId: 'inst-a' }];
    throw new Error('unexpected SQL ' + sql);
  });
  const db = store.db;
  db.memberRights={findUnique:async()=>({approved:true,suspended:false,institution:'inst-a',roles:['radiologist']})};
  db.studyConsultation = {
    findUnique: async ({ where }) => rows.has(where.id) ? { ...rows.get(where.id) } : null,
    findFirst: async ({ where }) => [...rows.values()].find(r => r.studyUid === where.studyUid && r.recipientSub === where.recipientSub && where.state.in.includes(r.state)) ?? null,
    create: async ({ data }) => { rows.set(data.id, { reply: null, cancelReason: null, ...data }); return { ...rows.get(data.id) }; },
    update: async ({ where, data }) => { rows.set(where.id, { ...rows.get(where.id), ...data }); return { ...rows.get(where.id) }; },
  };
  db.auditLog = { create: async ({ data }) => { audit.push(data); return data; } };
  const keycloak = { getUser: async sub => sub === recipient.identity.subject ? { id: sub, enabled: true, serviceAccountClientId: null, groups: ['inst-a'],
    roles: ['radiologist'], email: 'recipient@synthetic.test', username: 'recipient', firstName: 'SYN', lastName: 'recipient' } : null };
  const runtime = new I.RT.ClinicalRuntime({ db, ledger: fakeLedger(db), studies: { facts: async () => study }, signatures: device.ports, recoveryDelayMs: 3600000,
    context: { facts: async request => ({ actor: request.actor, trustedProxyIp: known({ address: '10.0.0.7', source: 'trusted-proxy' }), requestId: 'request-' + randomUUID(),
      member: async subject => identities.get(subject) ?? who('unknown-' + subject), signature: request.signature }) } });
  I.SV.bindClinicalPort(runtime);
  const service = new I.C.ConsultationService(db, keycloak, { snapshot: async () => ({}), require: async () => {}, prepare: async () => {} });
  const callerOf = (a, name) => ({ kind: 'member', institution: 'inst-a', sub: a.identity.subject, actor: name + '@synthetic.test', roles: ['radiologist'] });
  // The author's device signs the version the server will plan for this body (C2's signing route hands the page this plan).
  const signedBy = async (a, surface, body, extra = {}) => {
    const unit = await runtime.unit(id);
    const plan = R.planClinicalWrite(input(surface, a, unit, body, { ids: { recordId: id, versionId: randomUUID() }, ...extra }));
    return { actor: a, signature: plan.signing ? carried(plan, a) : null };
  };
  const cr = { requestId: randomUUID(), expectedOwner: owner(r1), recipientSub: recipient.identity.subject, reason: Q }, id = cr.requestId.toLowerCase();
  const created = await service.create(study.studyId, callerOf(r1, 'author'), cr, await signedBy(r1, 'consultation.create', cr, { recipientId: recipient.identity.id }));
  const acc = { requestId: randomUUID(), expectedOwner: owner(recipient), revision: 1, action: 'accept', note: '' };
  const accepted = await service.change(id, callerOf(recipient, 'recipient'), acc, await signedBy(recipient, 'consultation.accept', acc));
  const done = { requestId: randomUUID(), expectedOwner: owner(recipient), revision: 2, action: 'complete', note: 'SYN 자문 답변: 양성' };
  const completed = await service.change(id, callerOf(recipient, 'recipient'), done, await signedBy(recipient, 'consultation.complete', done));
  assert.deepEqual([created.item.state, accepted.item.state, completed.item.state, completed.item.reply], ['Requested', 'Accepted', 'Completed', done.note]);
  const resend = (body, a, name) => service.change(id, callerOf(a, name), body, { actor: a, signature: null });
  assert.deepEqual(await resend(acc, recipient, 'recipient'), accepted, 'DR3-01: the acceptance resent after the completion answers the acceptance');
  assert.deepEqual([accepted.item.revision, accepted.item.reply, accepted.item.changedBy], [2, null, 'recipient@synthetic.test']);
  assert.deepEqual(await resend(done, recipient, 'recipient'), completed, 'the completion resent answers the completion');
  assert.deepEqual(await service.create(study.studyId, callerOf(r1, 'author'), cr, { actor: r1, signature: null }), created, 'the request resent answers the request');
  assert.deepEqual([store.seen.commits, audit.length, rows.get(id).revision], [3, 3, 3], 'one commit per request');
});

test('TEST-D-03 read_scope server: a finding written before unit D answers neither its text nor its typed reasons; a signed finding\'s reasons leave only through their durable provision, and a refused revision carries none', async () => {
  const I = isolated({ SV: 'emr-clinical/services.ts', RT: 'emr-clinical/runtime.ts', F: 'finding.service.ts', VI: 'viewer-input.ts' });
  const uid = study.studyId, legacyId = randomUUID(), signedId = randomUUID();
  const reasons = { hide: 'SYN 숨김 사유: 다른 환자 검사로 보임', restore: 'SYN 복원 사유: 같은 환자로 확인' };
  const snapshot = hidden => ({ schemaVersion: 1, title: 'SYN 결절', text: 'SYN 우상엽 8 mm 결절', hidden, primary: 0, sources: [] });
  let unit = null;
  for (const [surface, body, hidden] of [['finding.create', { requestId: signedId, item: {} }, false],
    ['finding.hide', { requestId: randomUUID(), expectedRevision: 1, action: 'hide', item: {}, reason: reasons.hide }, true],
    ['finding.restore', { requestId: randomUUID(), expectedRevision: 2, action: 'restore', item: {}, reason: reasons.restore }, false]])
    unit = R.applyPlan(unit, R.planClinicalWrite(input(surface, r1, unit, body, { content: I.VI.canonical(snapshot(hidden)), ids: { recordId: signedId, versionId: randomUUID() } })));
  const signedRows = unit.versions.map(v => ({ revision: v.sequence, snapshot: JSON.parse(v.text), action: ['create', 'hide', 'restore'][v.sequence - 1],
    reason: v.reasonSource === 'stated' ? v.reason : '', actor: 'r1@synthetic.test', authorSub: r1.identity.subject, payloadBytes: Buffer.byteLength(v.text, 'utf8'), at: v.at.replace('Z', '') }));
  const legacyRows = [['create', ''], ['edit', ''], ['hide', 'SYN LEGACY 숨김 사유'], ['restore', 'SYN LEGACY 복원 사유']].map(([action, reason], i) =>
    ({ revision: i + 1, snapshot: snapshot(action === 'hide'), action, reason, actor: 'r1@synthetic.test', authorSub: r1.identity.subject, payloadBytes: 120,
      at: '2026-10-01T01:02:0' + i + '.000' }));
  let page = null, down = false;
  const appended = [];
  const db = { memberRights:{findUnique:async()=>({approved:true,suspended:false,institution:'inst-a',roles:['radiologist']})}, $executeRaw: async () => 0, studyState: { findUnique: async () => ({ uid, institutionId: 'inst-a', teleInstitutionId: null, rs: 'W' }) },
    $queryRaw: async (strings, ...v) => {
      const sql = strings.join('?');
      if (sql.includes('SELECT DISTINCT l.uid')) return [];
      if (sql.includes('AS present')) return [{ allowed: true, present: true, rows: JSON.stringify(page) }];
      if (sql.includes('emr_clinical.response_facts')) return v[1].map(version=>({version_id:version,request_id:randomUUID(),projection:JSON.stringify({caller:{sub:r1.identity.subject,actor:'r1@synthetic.test'}})}));
      if (sql.includes('SELECT * FROM "StudyState"'))return [{uid,institutionId:'inst-a',rs:'W'}];
      if (sql.includes('FROM "Finding" WHERE')) {const signed=v[0]===signedId;return [{id:v[0],studyUid:uid,authorSub:r1.identity.subject,authorActor:'r1@synthetic.test',revision:signed?unit.revision:4,hidden:false,createdAt:signed?unit.versions[0].at:legacyRows[0].at,updatedAt:signed?unit.versions.at(-1).at:legacyRows[3].at,snapshot:JSON.stringify(snapshot(false))}];}
      if (sql.includes('FROM "FindingRevision" WHERE'))return page.map(r=>({...r,snapshot:JSON.stringify(r.snapshot)}));
      if (sql.includes('emr_clinical.unit_for')) return v[0] === signedId ? unitRows(unit) : [];
      throw new Error('unexpected SQL ' + sql);
    } };
  db.$transaction = async work => work(db);
  const ledger = { ...fakeLedger(db), append: async event => {
    if (down) throw Object.assign(new Error('SYN seal unavailable'), { name: 'LedgerFailure' });
    appended.push(event); return { eventId: event.eventId, durableAt: new Date().toISOString() };
  } };
  I.SV.bindClinicalPort(new I.RT.ClinicalRuntime({ db, ledger, context: providerContext(r1), studies: { facts: async () => study }, signatures: device.ports }));
  const service = new I.F.FindingService(db, { prepare: async () => {}, require: async () => {}, allowed: async () => new Set(), snapshot: async () => ({}) }, {});
  const caller = { kind: 'member', institution: 'inst-a', sub: r1.identity.subject, actor: 'r1@synthetic.test', roles: ['radiologist'] };
  const revisions = id => service.list(uid, {}, caller, id, '2', {});
  // Written before unit D: no signed version, so an operational summary only - ledger up or down, nothing of the author's.
  page = legacyRows;
  for (const state of [true, false]) {
    down = state;
    const answer = await revisions(legacyId);
    assert.deepEqual(answer.revisions.map(r => [r.revision, r.action, r.reason, r.item]),
      [[1, 'create', null, null], [2, 'edit', null, null], [3, 'hide', null, null], [4, 'restore', null, null]], 'DR3-02: the summary of a revision written before unit D');
    assert.ok(!JSON.stringify(answer).includes('SYN'), 'DR3-02: no typed reason or text of a finding written before unit D, ledger ' + (state ? 'down' : 'up'));
  }
  assert.equal(appended.length, 0, 'nothing was provided: nothing clinical was served');
  // Signed: the reasons are the versions' own, served after one durable provision naming exactly those versions.
  page = signedRows; down = false;
  const served = await revisions(signedId);
  assert.deepEqual(served.revisions.map(r => r.reason), ['', reasons.hide, reasons.restore]);
  assert.deepEqual(appended.map(e => e.targets.map(t => t.versionId.value)), [unit.versions.map(v => v.versionId)]);
  down = true;
  await assert.rejects(revisions(signedId), e => statusOf(e) === 503 && !JSON.stringify(e.getResponse()).includes('SYN'), 'no durable provision: no reason');
  down = false;
  page = signedRows.map(r => r.revision === 2 ? { ...r, reason: 'SYN 다른 사유' } : r);
  await assert.rejects(revisions(signedId), e => statusOf(e) === 409 && !JSON.stringify(e.getResponse()).includes('SYN'), 'a diverged revision is refused without any reason');
});

test('TEST-D-02 versions_and_sr server: copies of one source version - two marks of one saved comparison, its saved view and a mark on it - are one fixed reference, planned, signed, stored and recovered alike, every copy kept in the text', async () => {
  const I = isolated({ SV: 'emr-clinical/services.ts', RT: 'emr-clinical/runtime.ts', R: 'emr-clinical/records.ts', SOURCES: 'emr-clinical/sources.ts',
    COMPOSITION: 'emr-contract/composition.ts', CTX: 'emr-runtime/context.ts', FI: 'finding-input.ts', VI: 'viewer-input.ts' });
  I.COMPOSITION.composeEmrAdapters({ ...I.CTX.runtimeAdapters, stored: I.SOURCES.clinicalStoredReader(I.CTX.runtimeAdapters.stored) });
  const job = randomUUID(), marks = [randomUUID(), randomUUID()], frame = '1.2.840.99.1.5.9';
  const volume = { study: study.studyId, series: study.studyId + '.5', sops: [study.studyId + '.5.1'], sourceDigest: 'ab'.repeat(32) };
  const saved = { version: 6, volume, marks: { marks: marks.map((id, i) => ({ id, label: 'SYN mark ' + i, point: [i, 2, 3] })) } };
  const row = { jobId: job, revision: 1, at: new Date('2026-10-12T01:00:00.000Z'), title: 'SYN saved comparison', description: '', hidden: false, studyUid: study.studyId,
    studies: [study.studyId], snapshot: JSON.stringify(saved) };
  const sourceDb = { $queryRaw: async strings => strings.join('?').includes('"ViewerJobRevision"') ? [row] : [] };
  const ref = { kind: 'job', jobId: job, revision: 1 };
  const [single] = await I.SV.readClinicalSources(sourceDb, [ref]);
  const copy = markId => I.FI.copyJob({ id: job, revision: 1, title: row.title, authorActor: 'r1@synthetic.test' }, row.studies, saved,
    I.FI.jobMark(saved, row.studies, markId), markId === undefined ? null : frame);
  for (const [label, markIds] of [['two marks of one saved comparison', marks], ['the saved view and a mark on it', [undefined, marks[0]]]]) {
    // What the finding service cites for its copies: each copy names the job revision it was copied from.
    const resolved = await I.SV.readClinicalSources(sourceDb, markIds.map(() => ref));
    assert.deepEqual(resolved.map(r => [r.recordId, r.event.versionId, r.event.sha256]), [[single.recordId, single.event.versionId, single.event.sha256]],
      'DR3-03: ' + label + ' cite that version once');
    const content = I.VI.canonical({ schemaVersion: 2, title: 'SYN 두 위치', text: 'SYN 두 위치 비교', characteristics: '', hidden: false, primary: 0, sources: markIds.map(copy) });
    const finding = input('finding.create', r1, null, { requestId: randomUUID(), item: { schemaVersion: 2 } }, { content, attachments: resolved });
    const plan = I.R.planClinicalWrite(finding);
    const expected = [{ kind: single.kinds[0], recordId: job, versionId: 'revision:1', sha256: single.event.sha256 }];
    assert.deepEqual([plan.version.attachments, plan.signing.attachments], [expected, expected], label + ': one fixed reference, planned and signed');
    assert.deepEqual(JSON.parse(plan.version.text).sources.map(s => s.mark?.id ?? null), markIds.map(id => id ?? null), label + ': every copy stays in the text');
    const signed = carried(plan, r1), port = portFor(signed);
    await port.verify(await port.sign(plan.signing, { originalId: 'o' }), plan.signing);
    // The registered original resolves the same one reference again in its recovery and stores exactly it.
    const seed = JSON.parse(JSON.stringify({ ...finding, attachments: resolved.map(r => ({ recordId: r.recordId, eventId: r.event.eventId, versionId:r.event.versionId, sha256:r.event.sha256, kinds:r.kinds })) }));
    const { db, seen } = registerDb(registerRow(seed, facts(r1, true), signed), { sources: () => [row] });
    I.SV.clinicalServices.prepareProjection.delete('finding');
  I.SV.registerClinicalProjection('finding', async () => {});
    const runtime = new I.RT.ClinicalRuntime({ db, ledger: fakeLedger(db), context: {}, studies: {}, signatures: device.ports, recoveryDelayMs: 3600000 });
    assert.equal((await runtime.recover(I.R.prepareClinicalWrite(finding))).status, 'replayed', label + ': recovered');
    assert.deepEqual([seen.commits, seen.versions[0].attachments, seen.versions[0].text], [1, expected, content], label + ': stored with the one reference');
  }
});

test('TEST-D-04 atomic_retry server: a cited source gone before the commit keeps the stale-source refusal - in a recovery, for the original and every resend, and in a commit itself; storage that cannot be read leaves it pending for the next recovery', async () => {
  const I = isolated({ SV: 'emr-clinical/services.ts', RT: 'emr-clinical/runtime.ts', R: 'emr-clinical/records.ts', SOURCES: 'emr-clinical/sources.ts',
    COMPOSITION: 'emr-contract/composition.ts', CTX: 'emr-runtime/context.ts', F: 'finding.service.ts', FI: 'finding-input.ts' });
  I.COMPOSITION.composeEmrAdapters({ ...I.CTX.runtimeAdapters, stored: I.SOURCES.clinicalStoredReader(I.CTX.runtimeAdapters.stored) });
  const item = randomUUID(), ref = { kind: 'item', itemId: item, revision: 1 };
  const rows = [{ itemId: item, revision: 1, action: 'create', at: new Date('2026-10-12T01:00:00.000Z'), studyUid: study.studyId,
    snapshot: JSON.stringify({ kind: 'length', label: 'SYN source' }) }];
  const resolved = await I.SV.readClinicalSources({ $queryRaw: async () => rows }, [ref]);
  const body = { requestId: randomUUID(), item: { schemaVersion: 1, title: 'SYN title', text: 'SYN copied source', sources: [{ itemId: item, revision: 1 }] } };
  const finding = input('finding.create', r1, null, body, { content: 'SYN copied source', attachments: resolved });
  const signed = carried(I.R.planClinicalWrite(finding), r1);
  const row = registerRow({ ...finding, attachments: resolved.map(r => ({ recordId: r.recordId, eventId: r.event.eventId, versionId:r.event.versionId, sha256:r.event.sha256, kinds:r.kinds })) }, facts(r1, true), signed);
  let sources = () => { throw new Error('SYN connection reset'); }, projected = 0;
  const { db, seen } = registerDb(row, { sources: sql => sources(sql) });
  I.SV.clinicalServices.prepareProjection.delete('finding');
  I.SV.registerClinicalProjection('finding', async () => { projected++; });
  const runtime = new I.RT.ClinicalRuntime({ db, ledger: fakeLedger(db), context: providerContext(r1), studies: { facts: async () => study },
    signatures: device.ports, recoveryDelayMs: 3600000 });
  const identity = I.R.prepareClinicalWrite(finding);
  // Storage that cannot be read now is no proof that the source is gone: pending, nothing sealed, nothing committed.
  const transient = await runtime.recover(identity);
  assert.deepEqual([transient.status, row.state, seen.seals, seen.commits, projected], ['unknown', 'pending', 0, 0, 0],
    'DR3-04: a transient failure leaves the original pending');
  // The cited source version is gone: the stored refusal is the source's change, never an input error, never a success.
  sources = () => [];
  const sealed = await runtime.recover(identity);
  assert.deepEqual([sealed.status, sealed.code], ['failed', 'ClinicalSourceMissing'], 'DR3-04: the recovery keeps the stale source as such');
  assert.deepEqual([row.state, seen.commits, projected], ['rejected', 0, 0], 'nothing committed: never a version without its reference');
  assert.equal((await runtime.recover(identity)).code, 'ClinicalSourceMissing', 'the stored refusal answers every later recovery');
  // The author's resend through the public route answers the service's stale-source refusal.
  I.SV.bindClinicalPort(runtime);
  const service = new I.F.FindingService({ studyState: { findUnique: async () => ({ uid: study.studyId, institutionId: 'inst-a', teleInstitutionId: null, rs: 'W' }) } },
    { require: async () => {}, snapshot:async()=>({}) }, {});
  const caller = { kind: 'member', institution: 'inst-a', sub: r1.identity.subject, actor: 'r1@synthetic.test', roles: ['radiologist'] };
  const refusal = await service.write(study.studyId, Buffer.from(JSON.stringify(body)), caller, undefined, {}).then(() => null, e => e);
  assert.deepEqual([statusOf(refusal), refusal?.getResponse?.().code], [409, 'FINDING_SOURCE_STALE'], 'DR3-04: the resend answers FINDING_SOURCE_STALE');
  assert.deepEqual([seen.commits, projected], [0, 0]);
  // The same change met by a commit itself (the measurement's revision and head removed between admission and commit): the
  // finding's own projection refuses it as the stale source, not as a missing record.
  const command = I.FI.findingCommand(Buffer.from(JSON.stringify(body)), true);
  const projection = { caller, body: JSON.stringify(body), fingerprint: I.FI.findingFingerprint(study.studyId, null, command), id: null,
    plan: { studies: [study.studyId], checked: [], frames: [] } };
  const tx = { memberRights:{findUnique:async()=>({approved:true,suspended:false,institution:'inst-a',roles:['radiologist']})}, $executeRaw: async () => 0, $queryRaw: async strings => {
    const sql = strings.join('?');
    if (sql.includes('"StudyState"')) return [{ uid: study.studyId, institutionId: 'inst-a', teleInstitutionId: null, rs: 'W' }];
    if (sql.includes('"ViewerItem"') || sql.includes('"ViewerRevision"')) return [];
    throw new Error('unexpected SQL ' + sql);
  } };
  await assert.rejects(I.SV.clinicalServices.projectors.get('finding')(tx, I.R.planClinicalWrite(finding), projection, caller), e => e?.code === 'ClinicalSourceMissing',
    'DR3-04: a commit whose cited source went after admission is refused as that stale source');
});

// ---------------- the declaration ----------------

test('EMR-D-R2 declaration: d.json lists exactly the collected server and live cases, existing owned paths and the newest migration', () => {
  const d = JSON.parse(fs.readFileSync(path.join(root, 'emr/units/d.json'), 'utf8'));
  const collected = [];
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'test' && ts.isStringLiteralLike(node.arguments[0]))
      collected.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(__filename, fs.readFileSync(__filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  assert.deepEqual(collected, d.cases.server.cases);
  assert.equal(collected.length, d.expected.server);
  const python = process.env.KIN_EMR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const listed = spawnSync(python, ['-B', '-I', '-c', [
    'import ast,json,sys', 'tree=ast.parse(open(sys.argv[1],encoding="utf-8").read())',
    'cls=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name==sys.argv[2]]',
    'print(json.dumps([f.name for f in cls[0].body if isinstance(f,ast.FunctionDef) and f.name.startswith("test")] if len(cls)==1 else None))',
  ].join('\n'), path.join(root, d.cases.live.file), d.cases.live.class], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const live = JSON.parse(listed.stdout);
  assert.deepEqual(live, d.cases.live.cases);
  assert.equal(live.length, d.expected.live);
  assert.ok(live.includes(d.candidate_flow.split('.')[1]), 'the candidate flow is a declared live case');
  assert.deepEqual(d.mutants.live.map(m => m.id), ['M-D-01', 'M-D-02', 'M-D-03', 'M-D-04', 'M-D-05']);
  for (const m of d.mutants.live) assert.ok(live.includes(m.kill), m.id + ' names its killing live case');
  for (const [round, paths] of Object.entries(d.owned_paths)) for (const file of paths)
    assert.ok(fs.existsSync(path.join(root, file)), round + ': ' + file);
  const all = Object.values(d.owned_paths).flat();
  assert.equal(new Set(all).size, all.length, 'no owned path is declared twice');
  const migrations = fs.readdirSync(path.join(api, 'prisma/migrations'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
  assert.equal(migrations.length, d.migrations.count);
  assert.equal(migrations.at(-1), d.migrations.added.at(-1));
  assert.equal(migrations.at(-2), d.migrations.latest_before);
  const kinds = Object.keys(load('emr-contract/classification.ts').RECORD_CLASSIFICATION);
  for (const [table, tableKinds] of Object.entries(d.schema.tables)) for (const kind of tableKinds) assert.ok(kinds.includes(kind), table + ': ' + kind);
});

test('R5 response boundary: all declared clinical and business variants reject unsigned or unauthorized body egress', () => {
  const env={...process.env,KIN_EMR_D_ROOT:root}; delete env.NODE_TEST_CONTEXT;
  const child=spawnSync(process.execPath,['--test','--test-reporter=tap',path.join(root,'tests/emr/d/response_test.cjs')],
    {cwd:root,encoding:'utf8',env,timeout:120000});
  assert.equal(child.status,0,'R5 response matrix must pass: '+child.stdout+' '+child.stderr);
  assert.match(child.stdout,/^# pass 18$/m,'all response cases must execute');
  assert.match(child.stdout,/^# skipped 0$/m,'no response case may be skipped');
});
test('R5 original request: recovery, ownership, metadata authorization and maximum seed matrices preserve original outcomes', () => {
  const env={...process.env,KIN_EMR_D_ROOT:root}; delete env.NODE_TEST_CONTEXT;
  const child=spawnSync(process.execPath,['--test','--test-reporter=tap',path.join(root,'tests/emr/d/recovery_test.cjs')],
    {cwd:root,encoding:'utf8',env,timeout:120000});
  assert.equal(child.status,0,'R5 recovery matrix must pass: '+child.stdout+' '+child.stderr);
  assert.match(child.stdout,/^# pass 7$/m,'all recovery cases must execute');
  assert.match(child.stdout,/^# skipped 0$/m,'no recovery case may be skipped');
});
