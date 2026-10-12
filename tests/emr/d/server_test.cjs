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

test('TEST-D-04 atomic_retry server: the runtime is composed once with every port and refuses a second composition', () => {
  const parts = { db: { $queryRaw: async () => [] }, ledger: { append: async () => ({}) }, context: { facts: async () => ({}) },
    studies: { facts: async () => study }, signatures: device.ports };
  assert.throws(() => RT.composeClinicalRuntime({ ...parts, ledger: null }), e => e instanceof V.ContractError && e.code === 'ClinicalRuntimePartRequired');
  const composed = RT.composeClinicalRuntime(parts);
  assert.equal(RT.clinicalRuntime(), composed);
  assert.equal(SV.requireClinicalRuntime(), composed, 'the composition binds the port of the owning services to this runtime');
  assert.throws(() => RT.composeClinicalRuntime(parts), e => e instanceof V.ContractError && e.code === 'ClinicalRuntimeAlreadyComposed');
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
