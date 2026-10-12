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
const previousLoader = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
  { compilerOptions: options, fileName: filename }).outputText, filename);
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
  const seen = { checkpoints: 0, recoveries: 0, commits: 0, versions: [] };
  let failing = failCheckpoints;
  const db = { $executeRaw: async () => 0, $queryRaw: async (strings, ...v) => {
    const sql = strings.join('?');
    if (sql.includes('"ViewerRevision"') || sql.includes('"ViewerJobRevision"')) return sources(sql);
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
  const questions = Array.from({ length: 70 }, () => R.applyPlan(null, question()));
  const db = unitsDb(questions), appended = [];
  const runtime = new RT.ClinicalRuntime({ db, ledger: fakeLedger(db, appended), context: providerContext(r1), studies: {}, signatures: device.ports });
  const caller = { subject: r1.identity.subject, institutionId: 'inst-a' };
  const units = await SV.readClinicalUnits(db, questions.map(q => q.recordId));
  const provisions = parties => questions.map(q => ({ record: 'question', recordId: q.recordId, studyId: study.studyId, scope: 'history', rows: units.get(q.recordId), parties }));
  let sentAfter = null;
  const texts = await runtime.provide({}, { route: 'GET questions', caller, units: provisions({ author: c1.identity.subject }),
    send: async (served, receipts) => { sentAfter = [appended.length, receipts.length]; return served.map(s => s.bodies.map(b => b.text)); } });
  assert.deepEqual(sentAfter, [2, 2], '70 versions: two provisions (64 + 6), both durable before the text is sent');
  assert.deepEqual(appended.flatMap(e => e.targets.map(t => t.versionId.value)), questions.map(q => q.head.versionId), 'exactly the served versions, once each');
  assert.ok(appended.every(e => e.action === 'provide-prepared' && e.surface === 'GET questions' && e.userId.value.id === r1.identity.id));
  assert.deepEqual(texts, questions.map(() => [Q]));
  // The second provision fails: nothing is sent at all.
  let sent = false, calls = 0;
  const failing = { ...fakeLedger(db), append: async event => { if (++calls === 2) throw new Error('SYN ledger down'); return { eventId: event.eventId, durableAt: new Date().toISOString() }; } };
  const down = new RT.ClinicalRuntime({ db, ledger: failing, context: providerContext(r1), studies: {}, signatures: device.ports });
  await assert.rejects(down.provide({}, { route: 'GET questions', caller, units: provisions({ author: c1.identity.subject }), send: async () => { sent = true; } }), /SYN ledger down/);
  assert.equal(sent, false, 'TEST-D-03: no text without every provision durable');
  // DR2-02: a projection whose author is not the version's, or rows not read from storage, get nothing (and log nothing).
  appended.length = 0;
  await refusedAsync(runtime.provide({}, { route: 'GET questions', caller, units: provisions({ author: 'sub-someone-else' }), send: async () => 'SYN' }), 'ProjectionMismatch',
    'DR2-02: a projection naming another author is refused');
  await refusedAsync(runtime.provide({}, { route: 'GET questions', caller, units: [{ ...provisions()[0], rows: unitRows(questions[0]) }], send: async () => 'SYN' }), 'NotFound');
  const consultation = R.applyPlan(null, R.planClinicalWrite(input('consultation.create', r1, null, { requestId: randomUUID(), expectedOwner: owner(r1),
    recipientSub: t1.identity.subject, reason: Q }, { recipientId: t1.identity.id })));
  const cdb = unitsDb([consultation]), crows = (await SV.readClinicalUnits(cdb, [consultation.recordId])).get(consultation.recordId);
  const reader = new RT.ClinicalRuntime({ db: cdb, ledger: fakeLedger(cdb, appended), context: providerContext(r1), studies: {}, signatures: device.ports });
  const one = recipient => ({ route: 'GET consultations', caller, units: [{ record: 'consultation', recordId: consultation.recordId, scope: 'texts', rows: crows,
    parties: { author: r1.identity.subject, recipient } }], send: async served => served[0].bodies.map(b => b.text) });
  await refusedAsync(reader.provide({}, one(c1.identity.subject)), 'ProjectionMismatch', 'a rewritten recipient');
  assert.equal(appended.length, 0, 'a refused projection logs no provision');
  assert.deepEqual(await reader.provide({}, one(t1.identity.subject)), [Q], 'control: the recipient the opening version fixed');
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

/** Shell words of one command line (single and double quotes; no expansion). */
const words = line => [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
test('EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, and each record hashes what its command consumes', () => {
  const yaml = require(path.join(api, 'node_modules/js-yaml'));
  const flow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/emr-d.yml'), 'utf8'));
  const job = flow.jobs['emr-d'], target = '${{ env.TARGET_SHA }}';
  assert.equal(job.env.TARGET_SHA, '${{ inputs.candidate_sha || github.event.pull_request.head.sha || github.sha }}', 'a PR checks its head, a dispatch its candidate');
  for (const step of job.steps) assert.ok(!/github\.sha|GITHUB_SHA|github\.ref\b/.test(JSON.stringify(step)), 'only TARGET_SHA names the source: ' + step.name);
  assert.equal(job.steps.find(s => String(s.uses).startsWith('actions/checkout@')).with.ref, target);
  const recorded = step => {
    const argv = words(step.run), split = argv.indexOf('--');
    const options = argv.slice(0, split), files = [], trees = [];
    options.forEach((word, i) => { if (word === '--file') files.push(options[i + 1]); if (word === '--tree') trees.push(options[i + 1]); });
    return { files, trees, command: argv.slice(split + 1) };
  };
  const covers = (r, file) => r.files.includes(file) || r.trees.some(tree => file === tree || file.startsWith(tree + '/'));
  const imageStep = job.steps.find(s => /\bdocker build\b/.test(s.run ?? '')), image = recorded(imageStep);
  const tag = image.command[image.command.indexOf('-t') + 1];
  assert.equal(image.command[image.command.indexOf('--build-arg') + 1], 'VCS_REF=' + target, 'the image is labelled with the requested source');
  assert.equal(tag, 'kin-emrd-ci:' + target);
  // Every input the production image copies from its build context (api/), and the Dockerfile itself, is hashed by the record.
  const dockerfile = fs.readFileSync(path.join(api, 'Dockerfile'), 'utf8').split(/\r?\n/);
  const copied = dockerfile.filter(line => /^COPY\s/.test(line) && !/--from=/.test(line)).flatMap(line => words(line).slice(1, -1)).map(src => 'api/' + src);
  assert.ok(copied.length >= 5);
  for (const file of [...copied, 'api/Dockerfile']) assert.ok(covers(image, file), 'the image record hashes ' + file);
  const liveStep = job.steps.find(s => (s.run ?? '').includes('scripts/run-tests.py --module tests/emr/d/live.py')), live = recorded(liveStep);
  assert.equal(liveStep.env.KIN_TEST_API_IMAGE, tag, 'the live run uses exactly the image built from the requested source');
  const declared = JSON.parse(fs.readFileSync(path.join(root, 'emr/units/d.json'), 'utf8')).ci.live_inputs;
  for (const input of declared) assert.ok(covers(live, input), 'the live record hashes ' + input);
  const order = job.steps.map(s => s.name);
  const labelStep = job.steps.find(s => (s.run ?? '').includes('org.opencontainers.image.revision') && (s.run ?? '').includes('image-identity.txt'));
  assert.ok(labelStep && order.indexOf(labelStep.name) > order.indexOf(imageStep.name) && order.indexOf(labelStep.name) < order.indexOf(liveStep.name),
    'the image revision is checked between the build and the live run');
  // The last step's own check, run on synthetic records: one record of another commit fails it, all of TARGET_SHA pass.
  const check = job.steps.find(s => (s.run ?? '').includes("<<'PY'\n"));
  assert.equal(order.indexOf(check.name), order.length - 2, 'the check runs after every record, before the evidence upload');
  const script = check.run.slice(check.run.indexOf("<<'PY'\n") + 7, check.run.lastIndexOf('PY'));
  const python = process.env.KIN_EMR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const sha = 'a'.repeat(40);
  const runCheck = heads => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'emr-d-check-'));
    fs.mkdirSync(path.join(dir, 'tmp/emr-d-ci'), { recursive: true });
    heads.forEach((head, i) => { fs.mkdirSync(path.join(dir, 'tmp/emr-d-ci', 'step' + i)); fs.writeFileSync(path.join(dir, 'tmp/emr-d-ci', 'step' + i, 'run.json'),
      JSON.stringify({ git_head_before: head, git_head_after: head })); });
    fs.writeFileSync(path.join(dir, 'tmp/emr-d-ci/image-identity.txt'), 'sha256:' + 'f'.repeat(64) + ' ' + sha + '\n');
    try { return spawnSync(python, ['-B', '-c', script], { cwd: dir, env: { ...process.env, TARGET_SHA: sha }, encoding: 'utf8' }).status; }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  assert.equal(runCheck([sha, sha]), 0, 'every record of TARGET_SHA passes');
  assert.equal(runCheck([sha, 'b'.repeat(40)]), 1, 'a record of another commit fails the check');
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
  const seed = JSON.parse(JSON.stringify({ ...finding, attachments: resolved.map(r => ({ recordId: r.recordId, eventId: r.event.eventId })) }));
  const row = registerRow(seed, facts(r1, true), signed);
  const { db, seen } = registerDb(row, { sources: rows });
  let projected = 0;
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
