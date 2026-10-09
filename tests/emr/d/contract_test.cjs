/* EMR-D round 1: REQ-EMR-01/03/04/05/07/10/17 -> RISK-D-01..04 -> TEST-D-01 clinical_vs_operational, TEST-D-02 versions_and_sr,
 * TEST-D-03 read_scope, TEST-D-04 atomic_retry (the pure halves). TEST-D-05 ui_reopen is a DOM/live case of round 2 and is not
 * declared here. Each case asserts the allowed outcome and the refused one, the refusal by its error code together with the
 * absence of side effects (no plan, no port call, no body, the record unchanged).
 *
 * The D modules and the real A contracts are compiled by the installed TypeScript (api/node_modules) with api/tsconfig.json.
 * Byte identity is asserted only where it is the requirement itself (AGENTS 1-B.14): the exact signed text and the SR bytes.
 * The signature port below is a stand-in for C's signer/verifier port (round 2 binds the real one); D never builds evidence.
 * Synthetic data only. KIN_EMR_D_SRC points the run at another copy of api/src/emr-clinical (tests/emr/d/mutants.py); A is
 * then loaded from that copy's sibling emr-contract, so D and the test share one set of A capabilities.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..', '..', '..');
const api = path.join(root, 'api');
const ts = require(path.join(api, 'node_modules/typescript'));
const DSRC = path.resolve(process.env.KIN_EMR_D_SRC || path.join(api, 'src/emr-clinical'));
const ASRC = path.join(DSRC, '..', 'emr-contract');
const config = ts.readConfigFile(path.join(api, 'tsconfig.json'), ts.sys.readFile);
assert.equal(config.error, undefined);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, api).options;
const previousLoader = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
  { compilerOptions: options, fileName: filename }).outputText, filename);
const M = require(path.join(ASRC, 'composition.ts'));
const A = require(path.join(ASRC, 'classification.ts'));
const E = require(path.join(ASRC, 'access-event.ts'));
const Routes = require(path.join(ASRC, 'routes.ts'));
const S = require(path.join(ASRC, 'signature.ts'));
const C = require(path.join(DSRC, 'contract.ts'));
const R = require(path.join(DSRC, 'records.ts'));
if (previousLoader) require.extensions['.ts'] = previousLoader; else delete require.extensions['.ts'];

// One synthetic composition per process, as the server does once at startup (B, round 2).
const storedRows = new Map();
const { stored } = M.composeEmrAdapters({
  stored: { load: (recordId, eventId) => storedRows.get(recordId + ':' + eventId) },
  legal: { load: () => undefined, listHolds: recordId => ({ recordId, holdIds: [], complete: true }) },
  purpose: { load: () => undefined, loadSignedResult: () => undefined },
  clinical: { loadStudy: () => undefined, loadReportPatient: () => undefined },
});

const T0 = Date.parse('2026-10-09T00:00:00.000Z');
const t = minutes => new Date(T0 + minutes * 60000).toISOString();
const who = id => ({ id, issuer: 'https://identity.example.test', subject: `sub-${id}` });
const actor = (id, roles, institutionId = 'inst-a', registration = `reg-${id}`) =>
  ({ identity: who(id), kind: 'member', roles, institutionId, signingRegistrationId: registration });
const patient = { linkId: 'link-1', patientId: 'SYN-1', assigningAuthority: 'hospital-a' };
const study = { studyId: '1.2.840.99.1', managingInstitutionId: 'inst-a', patient };
const owner = a => [a.institutionId, a.identity.subject];
const c1 = actor('c1', ['clinician']), c2 = actor('c2', ['clinician']);
const r1 = actor('r1', ['radiologist']), r2 = actor('r2', ['radiologist']);
const admin = actor('ad', ['admin']), tech = actor('tc', ['technician']);
const rOther = actor('r9', ['radiologist'], 'inst-b'), rTele = actor('rt', ['radiologist'], 'inst-tele');
// Exact text with CRLF, a decomposed character and a trailing space: signed bytes are kept as written.
const Q = 'SYN 흉통 지속\r\n이전 CT와 비교 바랍니다 é ';
const ANSWER = 'SYN 이전 CT 대비 변화 없음.';

function input(surface, a, unit, body, extra = {}) {
  return { surface, actor: a, study, unit, body, content: null, attachments: [], navigation: [], recipientId: null, readerId: null, workContext: null,
    ids: { recordId: unit ? unit.recordId : randomUUID(), versionId: randomUUID() }, at: unit ? t(unit.versions.length * 10) : t(0), ...extra };
}
const plan = (...args) => R.planClinicalWrite(input(...args));
const step = (unit, ...args) => R.applyPlan(unit, R.planClinicalWrite(input(args[0], args[1], unit, ...args.slice(2))));
const qBody = (a, text = Q) => ({ requestId: randomUUID(), expectedOwner: owner(a), body: text });
const replyBody = (a, unit, text) => ({ requestId: randomUUID(), expectedOwner: owner(a), revision: unit.revision, body: text });
const closeBody = (a, unit, note) => ({ requestId: randomUUID(), expectedOwner: owner(a), revision: unit.revision, note });
const changeBody = (a, unit, action, note) => ({ requestId: randomUUID(), expectedOwner: owner(a), revision: unit.revision, action, note });
function questionThread() {
  const opened = step(null, 'question.create', c1, qBody(c1));
  return step(opened, 'question.reply', r1, replyBody(r1, opened, ANSWER));
}
function consultation(extra = {}) {
  return R.applyPlan(null, plan('consultation.create', r1, null,
    { requestId: randomUUID(), expectedOwner: owner(r1), recipientSub: randomUUID(), reason: Q }, { recipientId: 'r2', ...extra }));
}
function imageRequest() {
  return R.applyPlan(null, plan('image-request.create', c1, null, { requestId: randomUUID(), expectedOwner: owner(c1), kind: 'external-image',
    counterparty: 'SYN 외부병원', counterpartyInstitutionId: null, reason: Q }));
}
const SNAPSHOT = JSON.stringify({ schemaVersion: 2, title: 'SYN nodule', text: 'SYN 8 mm 결절', hidden: false, primary: true, sources: [] });
function measurement(id = 'item-1') {
  const facts = { recordId: id, model: 'ViewerItem', row: { snapshot: { type: 'measurement' } }, event: { eventId: `ev-${id}`, recordId: id,
    versionId: `${id}-r1`, sha256: 'ab'.repeat(32), contentSha256: 'ab'.repeat(32), at: t(-60), act: 'creation', signature: null,
    predecessor: null, components: [], processing: null } };
  storedRows.set(`${id}:ev-${id}`, facts);
  return A.resolveStoredRecord(stored, id, `ev-${id}`);
}
function finding(extra = {}) {
  return R.applyPlan(null, plan('finding.create', r1, null, { requestId: randomUUID(), item: {} }, { content: SNAPSHOT, ...extra }));
}
function refused(fn, code, message) { assert.throws(fn, error => error instanceof Error && error.code === code, message); }
async function refusedAsync(promise, code, message) { await assert.rejects(promise, error => error instanceof Error && error.code === code, message); }
function accessEvent(p, a, action, result) {
  return { formatVersion: 1, surface: p.access ? p.access.route : p.route, eventId: randomUUID(), userId: { status: 'known', value: a.identity },
    rolesAtTime: { status: 'known', value: a.roles }, actingInstitution: { status: 'known', value: a.institutionId },
    managingInstitution: { status: 'known', value: 'inst-a' }, occurredAt: t(500),
    trustedProxyIp: { status: 'known', value: { address: '10.0.0.7', source: 'trusted-proxy' } }, cause: 'user-view', executor: 'member',
    targets: p.access ? [p.access.target] : p.targets, action, result, requestId: randomUUID(), auditLinkId: `audit:${randomUUID()}`, relatedEventId: null };
}
function signaturePort({ failSign = false, verdict = null, signer = null, versionId = null } = {}) {
  const calls = { sign: 0, verify: 0 };
  return { calls, port: {
    async sign(request) { calls.sign++; if (failSign) throw new Error('SYN signer unavailable'); return { synthetic: true, versionId: request.versionId }; },
    async verify(envelope, request) {
      calls.verify++;
      return { recordId: request.recordId, versionId: versionId ?? request.versionId, versionSha256: request.versionSha256,
        signer: signer ?? request.author, identityRegistrationId: request.identityRegistrationId,
        verification: verdict ?? { integrity: 'valid', registeredIdentity: 'matched', keyAtSigningTime: 'active', compromise: 'not-known' } };
    } } };
}
function memoryStore(unit) {
  const receipts = new Map(), key = k => JSON.stringify([k.record, k.actorId, k.requestId]);
  const state = { unit, commits: 0, failCommit: null, failRequery: false, wrongReceipt: false, finds: 0, signatures: [], late: [] };
  return { state, port: {
    async findReceipt(k) { state.finds++; if (state.failRequery && state.commits) throw new Error('SYN store unavailable'); return receipts.get(key(k)) ?? null; },
    async commit(work) {
      state.commits++;
      if (state.failCommit === 'before') throw new Error('SYN connection reset before commit');
      if (state.failCommit === 'rolledback') throw new R.CommitRolledBack('SYN statement failed inside the transaction');
      if (state.failCommit === 'late') {
        // The answer is lost while the original transaction is still in flight; it becomes visible later.
        state.late.push(() => { state.unit = R.applyPlan(state.unit, work.plan); receipts.set(key(work.plan.receiptKey), work.plan.receipt); });
        throw new Error('SYN connection lost during COMMIT');
      }
      if (state.failCommit === 'taken') {
        // A concurrent request with the same ID and another body won the unique receipt key first.
        receipts.set(key(work.plan.receiptKey), { ...work.plan.receipt, fingerprint: '0'.repeat(64) });
        throw new Error('SYN unique violation on the receipt key');
      }
      state.unit = R.applyPlan(state.unit, work.plan); receipts.set(key(work.plan.receiptKey), work.plan.receipt); state.signatures.push(work.signature);
      if (state.failCommit === 'after') throw new Error('SYN answer lost after commit');
      return state.wrongReceipt ? { ...work.plan.receipt, versionId: 'other' } : work.plan.receipt;
    } } };
}

// ---------------- TEST-D-01 clinical_vs_operational ----------------

test('TEST-D-01 clinical_vs_operational: a question and its answer are signed clinical entries of their own authors', () => {
  const create = plan('question.create', c1, null, qBody(c1));
  assert.equal(create.entry, 'clinical-entry', 'M-D-01: a clinician question text must be a signed clinical entry');
  assert.ok(create.signing, 'M-D-01: a clinical entry must carry a signing request');
  assert.deepEqual(create.signing.author, c1.identity);
  assert.deepEqual(create.signing.signer, c1.identity, 'the signer is the author, never a proxy');
  assert.equal(create.signing.identityRegistrationId, 'reg-c1');
  assert.equal(create.signing.content.body, Q, 'the exact text is what is signed');
  assert.deepEqual([create.version.kind, create.version.act, create.signing.action, create.access.action, create.projection.state],
    ['clinical-question', 'entry', 'record', 'write', 'Open']);
  const opened = R.applyPlan(null, create);
  const answer = plan('question.reply', r1, opened, replyBody(r1, opened, ANSWER));
  assert.equal(answer.entry, 'clinical-entry', 'M-D-01: a radiologist answer must be a signed clinical entry');
  assert.deepEqual([answer.version.kind, answer.version.act, answer.signing.action, answer.access.action, answer.projection.state],
    ['clinical-answer', 'additional-entry', 'addendum', 'additional-entry', 'Answered']);
  assert.deepEqual(answer.signing.previousVersion, opened.head);
  assert.deepEqual(answer.signing.signer, r1.identity);
  const answered = R.applyPlan(opened, answer);
  const followup = plan('question.reply', c1, answered, replyBody(c1, answered, 'SYN 추가 질문'));
  assert.deepEqual([followup.entry, followup.version.kind, followup.projection.state], ['clinical-entry', 'clinical-question', 'Open']);
});

test('TEST-D-01 clinical_vs_operational: consultation and finding text is signed; acceptance only moves state', () => {
  const requested = consultation();
  assert.equal(requested.versions[0].entry, 'clinical-entry', 'M-D-01: a consultation request by a radiologist must be a signed clinical entry');
  const accept = plan('consultation.accept', r2, requested, changeBody(r2, requested, 'accept', ''));
  assert.deepEqual([accept.entry, accept.signing, accept.version.act, accept.access.action], ['state-change', null, 'bookkeeping', 'modify']);
  const accepted = R.applyPlan(requested, accept);
  const complete = plan('consultation.complete', r2, accepted, changeBody(r2, accepted, 'complete', ANSWER));
  assert.equal(complete.entry, 'clinical-entry', 'M-D-01: a consultation reply must be a signed clinical entry');
  assert.deepEqual([complete.signing.action, complete.signing.signer.id], ['addendum', 'r2']);
  const created = finding();
  assert.equal(created.versions[0].entry, 'clinical-entry', 'M-D-01: a finding must be a signed clinical entry');
  const edit = plan('finding.edit', r1, created, { requestId: randomUUID(), expectedRevision: 1, action: 'edit', item: {} },
    { content: SNAPSHOT.replace('8 mm', '9 mm') });
  assert.deepEqual([edit.entry, edit.version.act, edit.signing.action, edit.access.action], ['clinical-entry', 'correction', 'amend', 'modify']);
});

test('TEST-D-01 clinical_vs_operational: reader assignment carries no text and never a clinical signature', () => {
  for (const a of [admin, tech, r1]) {
    const p = plan('assignment.write', a, null, { requestId: randomUUID(), expectedOwner: owner(a), revision: 0, readerSub: randomUUID() },
      { readerId: 'r2' });
    assert.deepEqual([p.entry, p.signing, p.version.capacity, p.version.kind, p.projection.state, p.access.action],
      ['assignment', null, 'operational-staff', 'assignment', 'Assigned', 'write'], `assignment by ${a.identity.id} is allocation only`);
    const assigned = R.applyPlan(null, p);
    const unassign = plan('assignment.write', a, assigned, { requestId: randomUUID(), expectedOwner: owner(a), revision: 1, readerSub: null });
    assert.deepEqual([unassign.entry, unassign.signing, unassign.projection.state, unassign.access.action], ['assignment', null, 'Unassigned', 'modify']);
  }
  const body = { requestId: randomUUID(), expectedOwner: owner(r1), revision: 0, readerSub: randomUUID() };
  refused(() => plan('assignment.write', r1, null, { ...body, note: Q }, { readerId: 'r2' }), 'RequestShapeRefused', 'no note on an assignment');
  refused(() => plan('assignment.write', r1, null, { ...body, body: Q }, { readerId: 'r2' }), 'RequestShapeRefused', 'no body on an assignment');
  refused(() => plan('assignment.write', r1, null, { ...body, clinicalEntry: true }, { readerId: 'r2' }), 'AuthorityFieldRefused');
  refused(() => plan('assignment.write', r1, null, body, { readerId: 'r2', content: Q }), 'TextRefused', 'no server text on an assignment');
});

test('TEST-D-01 clinical_vs_operational: staff processing text is an operational note; a clinician\'s request text is adopted and signed', () => {
  const requested = imageRequest();
  assert.equal(requested.versions[0].entry, 'clinical-entry', 'M-D-01: the requesting clinician reason must be a signed clinical entry');
  assert.equal(requested.clinicalEntry, true, 'the request is marked as carrying signed clinical text (no chart class by itself, D-19)');
  const accept = plan('image-request.accept', tech, requested, changeBody(tech, requested, 'accept', ''));
  assert.deepEqual([accept.entry, accept.signing], ['state-change', null]);
  const accepted = R.applyPlan(requested, accept);
  const close = plan('image-request.close', tech, accepted, changeBody(tech, accepted, 'close', 'SYN 외부 영상 수신 완료'));
  assert.deepEqual([close.entry, close.signing, close.version.capacity, close.projection.clinicalEntry],
    ['operational-note', null, 'operational-staff', true], 'a technician\'s note is recorded but never signed as a clinical entry');
  const opened = step(null, 'question.create', c1, qBody(c1));
  const byAdmin = plan('question.close', admin, opened, closeBody(admin, opened, 'SYN 중복 질문'));
  assert.deepEqual([byAdmin.entry, byAdmin.signing, byAdmin.version.capacity], ['operational-note', null, 'operational-staff']);
  const byReader = plan('question.close', r1, opened, closeBody(r1, opened, 'SYN 중복 질문'));
  assert.deepEqual([byReader.entry, byReader.signing.signer.id], ['clinical-entry', 'r1'], 'the same note by a radiologist is a signed clinical entry');
  const quiet = plan('question.close', c1, opened, closeBody(c1, opened, ''));
  assert.deepEqual([quiet.entry, quiet.signing, quiet.projection.state], ['state-change', null, 'Closed']);
  refused(() => plan('question.close', admin, opened, closeBody(admin, opened, '')), 'TextRequired', 'another person closing needs a reason');
});

test('TEST-D-01 clinical_vs_operational: a radiographer signs their own Tech Note; an administrator never signs in their place', () => {
  const note = (a, unit, text, reason) => ({ baseVersion: unit ? unit.revision : 0, text, reason, attemptId: randomUUID() });
  const first = plan('tech-note.write', tech, null, note(tech, null, 'SYN 조영제 주입 후 오심', ''));
  assert.equal(first.entry, 'clinical-entry', 'M-D-01: a radiographer Tech Note must be a signed entry of its author');
  assert.deepEqual([first.signing.signer, first.signing.action, first.version.kind, first.access.action], [tech.identity, 'record', 'tech-note', 'write']);
  const written = R.applyPlan(null, first);
  const cleared = plan('tech-note.write', tech, written, note(tech, written, '', 'SYN 다른 환자 메모'));
  assert.deepEqual([cleared.entry, cleared.version.act, cleared.signing.action, cleared.signing.reason, cleared.signing.content.body],
    ['clinical-entry', 'correction', 'amend', 'SYN 다른 환자 메모', ''], 'clearing a note is a signed correction with its reason');
  const byAdmin = plan('tech-note.write', admin, written, note(admin, written, 'SYN 관리자 수정', 'SYN 오타'));
  assert.deepEqual([byAdmin.entry, byAdmin.signing, byAdmin.version.capacity], ['operational-note', null, 'operational-staff']);
  refused(() => plan('tech-note.write', tech, written, note(tech, written, 'SYN 수정', ' ')), 'ReasonRequired');
  refused(() => plan('tech-note.write', tech, null, note(tech, null, ' ', '')), 'TextRequired');
  refused(() => plan('tech-note.write', r1, written, note(r1, written, 'SYN 판독의 메모', 'SYN')), 'ActorPathRefused', 'a radiologist does not write the Tech Note');
  refused(() => plan('tech-note.write', actor('tt', ['technician'], 'inst-tele'), written, note(tech, written, 'SYN', 'SYN')), 'NotFound',
    'only the acquiring institution writes the Tech Note');
  refused(() => R.planClinicalRead({ actor: rTele, unit: written, scope: 'current' }), 'NotFound', 'Part 1 serves no other institution');
});

test('TEST-D-01 clinical_vs_operational: body claims of authority are refused and server facts alone decide the class', () => {
  for (const field of ['author', 'verified', 'recordKind', 'signed', 'clinicalEntry', 'institutionId', 'signer']) {
    refused(() => plan('question.create', c1, null, { ...qBody(c1), [field]: field === 'author' ? who('r1') : true }), 'AuthorityFieldRefused',
      `${field} in the body is refused`);
  }
  refused(() => plan('question.create', c1, null, { ...qBody(c1), extra: 1 }), 'RequestShapeRefused');
  refused(() => plan('question.create', c1, null, { ...qBody(c1), expectedOwner: ['inst-a', 'sub-c2'] }), 'OwnerChanged');
  const body = { requestId: randomUUID(), expectedOwner: owner(admin), recipientSub: randomUUID(), reason: Q };
  const byAdmin = plan('consultation.create', admin, null, body, { recipientId: 'r2' });
  const byReader = plan('consultation.create', r1, null, { ...body, expectedOwner: owner(r1) }, { recipientId: 'r2' });
  assert.deepEqual([byAdmin.entry, byAdmin.signing], ['operational-note', null], 'an admin-only actor cannot author a clinical entry');
  assert.equal(byReader.entry, 'clinical-entry');
  const mixed = actor('mx', ['admin', 'radiologist']);
  const byMixed = plan('consultation.create', mixed, null, { ...body, expectedOwner: owner(mixed) }, { recipientId: 'r2' });
  assert.deepEqual([byMixed.entry, byMixed.version.capacity], ['clinical-entry', 'clinical-author'], 'a mixed-role person acting clinically signs as a clinician');
});

test('TEST-D-01 clinical_vs_operational: no registered signer, a service account or a foreign path plans nothing', () => {
  refused(() => plan('question.create', actor('c3', ['clinician'], 'inst-a', null), null, qBody(actor('c3', ['clinician']))), 'SigningIdentityRequired');
  refused(() => plan('question.create', { ...c1, kind: 'service' }, null, qBody(c1)), 'ServiceActorRefused');
  refused(() => plan('question.create', admin, null, qBody(admin)), 'ActorPathRefused', 'only a clinician opens a question');
  const opened = step(null, 'question.create', c1, qBody(c1));
  refused(() => plan('question.reply', tech, opened, replyBody(tech, opened, ANSWER)), 'ActorPathRefused');
  refused(() => plan('question.reply', c2, opened, replyBody(c2, opened, ANSWER)), 'ActorPathRefused', 'another clinician is not a party');
  const requested = consultation();
  refused(() => plan('consultation.complete', r1, requested, changeBody(r1, requested, 'complete', ANSWER)), 'ActorPathRefused',
    'only the recipient replies');
});

test('TEST-D-01 clinical_vs_operational: planned kinds belong to the A route and the signing request is a valid A payload', () => {
  const opened = step(null, 'question.create', c1, qBody(c1));
  const requested = imageRequest();
  const plans = [plan('question.create', c1, null, qBody(c1)), plan('question.reply', r1, opened, replyBody(r1, opened, ANSWER)),
    plan('question.close', admin, opened, closeBody(admin, opened, 'SYN 중복')),
    plan('image-request.cancel', c1, requested, changeBody(c1, requested, 'cancel', 'SYN 불필요')),
    plan('finding.create', r1, null, { requestId: randomUUID(), item: {} }, { content: SNAPSHOT })];
  for (const p of plans) {
    assert.ok(Routes.routeContract(p.access.route).kinds.includes(p.version.kind));
    const parsed = E.parseAccessEvent(accessEvent(p, p.version.author.id === 'ad' ? admin : p.version.author.id === 'r1' ? r1 : c1, p.access.action, 'succeeded'));
    assert.deepEqual(parsed.targets[0].versionId, { status: 'known', value: p.version.versionId });
    if (!p.signing) continue;
    const s = p.signing;
    const bytes = S.canonicalPayload({ formatVersion: 'emr-signature/1', text: { kind: 'clinical-entry', body: s.content.body }, patient: s.patient,
      studyId: s.studyId, managingInstitutionId: s.managingInstitutionId, actingInstitutionId: s.actingInstitutionId, recordKind: s.recordKind,
      recordId: s.recordId, versionId: s.versionId, author: s.author, signer: s.signer, identityRegistrationId: s.identityRegistrationId,
      action: s.action, serverTime: p.version.at, previousVersion: s.previousVersion, attachments: s.attachments, reason: s.reason });
    assert.equal(JSON.parse(bytes.toString('utf8')).text.body, s.content.body);
  }
  assert.equal(plans[3].signing.action, 'cancel');
  assert.equal(plans[3].signing.reason, 'SYN 불필요', 'a cancellation is signed with its reason');
});

// ---------------- TEST-D-02 versions_and_sr ----------------

test('TEST-D-02 versions_and_sr: every change appends a version; earlier text stays exact and the projection is the fold', () => {
  const requested = consultation();
  const accepted = step(requested, 'consultation.accept', r2, changeBody(r2, requested, 'accept', ''));
  const completed = step(accepted, 'consultation.complete', r2, changeBody(r2, accepted, 'complete', ANSWER));
  assert.deepEqual(completed.versions.map(v => v.text), [Q, null, ANSWER], 'M-D-02: the request text and the reply both stay in the history');
  assert.equal(completed.versions[0].contentSha256, require('node:crypto').createHash('sha256').update(Buffer.from(Q, 'utf8')).digest('hex'));
  completed.versions.forEach((v, i) => assert.deepEqual(v.previousVersion, i ? { recordId: v.recordId, versionId: completed.versions[i - 1].versionId,
    sha256: completed.versions[i - 1].sha256 } : null));
  assert.deepEqual(R.projectUnit(completed), { state: 'Completed', revision: 3, head: completed.head, clinicalEntry: false,
    parties: { authorId: 'r1', recipientId: 'r2' } });
  let request = imageRequest();
  request = step(request, 'image-request.accept', tech, changeBody(tech, request, 'accept', ''));
  request = step(request, 'image-request.close', tech, changeBody(tech, request, 'close', 'SYN 수신 완료'));
  assert.deepEqual(request.versions.map(v => [v.text, v.state.to]), [[Q, 'Requested'], [null, 'Accepted'], ['SYN 수신 완료', 'Closed']],
    'M-D-02: the image request reason and every processing note stay in the history');
});

test('TEST-D-02 versions_and_sr: a rewritten, dropped or reordered earlier version is refused, never projected', () => {
  const unit = questionThread();
  const rewritten = structuredClone(unit); rewritten.versions[0].text = 'SYN 다른 질문';
  const dropped = structuredClone(unit); dropped.versions.shift();
  const reordered = structuredClone(unit); reordered.versions.reverse();
  for (const broken of [rewritten, dropped, reordered]) {
    refused(() => R.projectUnit(broken), 'UnitHistoryBroken');
    refused(() => plan('question.reply', c1, broken, replyBody(c1, broken, 'SYN 추가')), 'UnitHistoryBroken', 'no write on a broken history');
  }
  const stale = plan('question.reply', c1, unit, replyBody(c1, unit, 'SYN 추가'));
  const opened = step(null, 'question.create', c1, qBody(c1));
  refused(() => R.applyPlan(opened, stale), 'StaleRevision', 'a plan cannot be appended to another head');
});

test('TEST-D-02 versions_and_sr: a finding correction keeps the original and incorporates source copies, not the comparison link', () => {
  const item = measurement();
  const created = finding({ attachments: [item], navigation: ['1.2.840.99.7'] });
  const original = created.versions[0];
  assert.deepEqual(original.attachments, [{ kind: 'measurement', recordId: 'item-1', versionId: 'item-1-r1', sha256: 'ab'.repeat(32) }]);
  assert.deepEqual(original.navigation, ['1.2.840.99.7'], 'the comparison study is a navigation link only');
  const edited = step(created, 'finding.edit', r1, { requestId: randomUUID(), expectedRevision: 1, action: 'edit', item: {} },
    { content: SNAPSHOT.replace('8 mm', '9 mm'), attachments: [item] });
  const hidden = step(edited, 'finding.hide', r1, { requestId: randomUUID(), expectedRevision: 2, action: 'hide', item: {}, reason: 'SYN 오기재' },
    { content: SNAPSHOT.replace('8 mm', '9 mm').replace('"hidden":false', '"hidden":true') });
  assert.deepEqual(hidden.versions.map(v => [v.text === SNAPSHOT, v.act, v.state.to, v.reason]),
    [[true, 'entry', 'Visible', null], [false, 'correction', 'Visible', null], [false, 'correction', 'Hidden', 'SYN 오기재']],
    'M-D-02: the original finding stays next to its corrections');
  refused(() => finding({ attachments: [structuredClone(item)] }), 'StoredRecordRequired', 'a copied or forged attachment is not a stored record');
  refused(() => plan('question.create', c1, null, qBody(c1), { attachments: [item] }), 'AttachmentRefused');
  refused(() => plan('question.create', c1, null, qBody(c1), { navigation: ['1.2.840.99.7'] }), 'NavigationRefused');
  refused(() => step(created, 'finding.hide', r1, { requestId: randomUUID(), expectedRevision: 1, action: 'hide', item: {}, reason: ' ' },
    { content: SNAPSHOT }), 'ReasonRequired', 'hiding outside the reading context needs a stated reason');
  refused(() => step(created, 'finding.edit', r2, { requestId: randomUUID(), expectedRevision: 1, action: 'edit', item: {} },
    { content: SNAPSHOT }), 'ActorPathRefused', 'only the author corrects a finding');
});

const NOW = t(60 * 48);
function sr(overrides = {}) {
  return { id: randomUUID(), studyId: study.studyId, authorId: 'r1', createdAt: t(0), attemptedAt: null, storedAt: null, bytesSha256: 'cd'.repeat(32),
    sopInstanceUid: '1.2.840.99.1.5', adoptedVersion: null, referencedBy: [], holdIds: [], orthanc: 'absent', ...overrides };
}

test('TEST-D-02 versions_and_sr: the 24-hour window ends only an unattempted, unadopted, unreferenced, unheld copy Orthanc confirms absent', () => {
  const version = { recordId: 'f-1', versionId: 'f-1-v1', sha256: 'ef'.repeat(32) };
  // Rows as the store holds them: an adoption commits its signature with the store intent (attemptedAt), Orthanc's
  // confirmation later sets storedAt; an attempt whose outcome is unknown has attemptedAt only.
  const rows = {
    eligible: sr(), adopted: sr({ attemptedAt: t(5), storedAt: t(6), adoptedVersion: version }), signed: sr({ attemptedAt: t(5), adoptedVersion: version }),
    attempted: sr({ attemptedAt: t(5) }), referenced: sr({ referencedBy: [version] }), held: sr({ holdIds: ['hold:1'] }),
    boundary: sr({ createdAt: t(60 * 24) }), unknown: sr({ orthanc: 'unknown' }), present: sr({ orthanc: 'present' }),
  };
  const result = R.planManualSrCleanup(Object.values(rows), NOW);
  const reasons = Object.fromEntries(result.keep.map(k => [Object.keys(rows).find(name => rows[name].id === k.id), k.reason]));
  assert.equal(reasons.adopted, 'adopted', 'M-D-04: an adopted SR is never cleared by the 24-hour window');
  assert.equal(reasons.signed, 'adopted', 'M-D-04: a signed adoption is never cleared by the 24-hour window');
  assert.equal(reasons.attempted, 'store-attempted', 'M-D-04: an attempt with an unknown outcome is never cleared by the 24-hour window');
  assert.deepEqual(result.clear.map(c => c.id), [rows.eligible.id]);
  assert.deepEqual(result.clear[0], { id: rows.eligible.id, bytesSha256: 'cd'.repeat(32), purposeEnd: 'preparation-window-ended' });
  assert.deepEqual(reasons, { adopted: 'adopted', signed: 'adopted', attempted: 'store-attempted', referenced: 'referenced', held: 'held',
    boundary: 'within-window', unknown: 'orthanc-unconfirmed', present: 'orthanc-unconfirmed' });
});

test('TEST-D-02 versions_and_sr: Orthanc reconciliation adopts only the exact bytes this server authorized', () => {
  const attempted = sr({ attemptedAt: t(5) });
  const present = sha => ({ status: 'present', sopInstanceUid: attempted.sopInstanceUid, sha256: sha });
  assert.equal(R.reconcileManualSr(attempted, present('cd'.repeat(32))).outcome, 'adopt');
  assert.equal(R.reconcileManualSr(attempted, present('00'.repeat(32))).outcome, 'conflict', 'other bytes under the same SOP are never adopted');
  assert.equal(R.reconcileManualSr(attempted, { ...present('cd'.repeat(32)), sopInstanceUid: '1.2.3' }).outcome, 'conflict');
  assert.equal(R.reconcileManualSr(sr(), present('cd'.repeat(32))).outcome, 'conflict', 'an instance this server never sent is not ours');
  assert.equal(R.reconcileManualSr(attempted, { status: 'absent' }).outcome, 'retry-store');
  assert.equal(R.reconcileManualSr(sr(), { status: 'absent' }).outcome, 'not-attempted');
  assert.equal(R.reconcileManualSr(attempted, { status: 'unknown' }).outcome, 'keep-pending', 'an unknown lookup changes nothing');
  assert.equal(R.reconcileManualSr(sr({ attemptedAt: t(5), storedAt: t(6) }), { status: 'unknown' }).outcome, 'already-adopted');
});

test('TEST-D-02 versions_and_sr: the store intent is the author\'s signature over the exact SR bytes; others are refused', () => {
  const row = sr({ createdAt: t(0) });
  const adoption = R.planManualSrAdoption({ actor: r1, study, sr: row, versionId: 'sr-v1', at: t(30) });
  assert.deepEqual(adoption.signing.content, { kind: 'dicom', sopInstanceUid: row.sopInstanceUid, sha256: row.bytesSha256 });
  assert.deepEqual([adoption.signing.recordKind, adoption.signing.signer, adoption.signing.versionSha256], ['manual-sr', r1.identity, adoption.adoption.sha256]);
  refused(() => R.planManualSrAdoption({ actor: r2, study, sr: row, versionId: 'sr-v1', at: t(30) }), 'ActorPathRefused');
  refused(() => R.planManualSrAdoption({ actor: rOther, study, sr: row, versionId: 'sr-v1', at: t(30) }), 'NotFound');
  refused(() => R.planManualSrAdoption({ actor: r1, study, sr: row, versionId: 'sr-v1', at: t(60 * 25) }), 'PreparationExpired');
  refused(() => R.planManualSrAdoption({ actor: { ...r1, signingRegistrationId: null }, study, sr: row, versionId: 'sr-v1', at: t(30) }), 'SigningIdentityRequired');
  refused(() => R.planManualSrAdoption({ actor: r1, study, sr: sr({ attemptedAt: t(5) }), versionId: 'sr-v1', at: t(30) }), 'StateTransitionRefused');
});

// ---------------- TEST-D-03 read_scope ----------------

test('TEST-D-03 read_scope: the author and institution readers are served; another clinician and another institution are not', () => {
  const unit = questionThread();
  assert.deepEqual(R.planClinicalRead({ actor: c1, unit, scope: 'current' }).versions.map(v => v.versionId), [unit.head.versionId]);
  assert.equal(R.planClinicalRead({ actor: r2, unit, scope: 'history' }).versions.length, 2);
  assert.equal(R.planClinicalRead({ actor: admin, unit, scope: 'history' }).targets.length, 2);
  refused(() => R.planClinicalRead({ actor: rOther, unit, scope: 'history' }), 'NotFound', 'M-D-05: another institution gets no body');
  refused(() => R.planClinicalRead({ actor: rTele, unit, scope: 'current' }), 'NotFound', 'M-D-05: a reading institution is another institution in Part 1');
  refused(() => R.planClinicalRead({ actor: c2, unit, scope: 'current' }), 'NotFound', 'another clinician\'s thread is not served');
  refused(() => R.planClinicalRead({ actor: tech, unit, scope: 'current' }), 'NotFound');
  const requested = consultation();
  assert.equal(R.planClinicalRead({ actor: r2, unit: requested, scope: 'current' }).versions.length, 1);
  refused(() => R.planClinicalRead({ actor: actor('r3', ['radiologist']), unit: requested, scope: 'current' }), 'NotFound', 'a non-party reader');
  const created = finding();
  assert.equal(R.planClinicalRead({ actor: r2, unit: created, scope: 'current' }).versions.length, 1, 'a radiologist of the institution reads findings');
  refused(() => R.planClinicalRead({ actor: rTele, unit: created, scope: 'current' }), 'NotFound', 'M-D-05: no finding is served to another institution');
});

test('TEST-D-03 read_scope: a write from another institution is refused before anything else is examined', () => {
  const opened = step(null, 'question.create', c1, qBody(c1));
  refused(() => plan('question.reply', rOther, opened, replyBody(rOther, opened, ANSWER)), 'NotFound', 'M-D-05: another institution cannot write');
  refused(() => plan('question.reply', rOther, opened, { ...replyBody(rOther, opened, ANSWER), author: who('r1') }), 'NotFound',
    'M-D-05: the institution boundary comes before any other refusal');
  refused(() => plan('question.create', actor('c9', ['clinician'], 'inst-b'), null, qBody(actor('c9', ['clinician'], 'inst-b'))), 'NotFound');
  refused(() => plan('finding.create', rTele, null, { requestId: randomUUID(), item: {} }, { content: SNAPSHOT }), 'NotFound',
    'M-D-05: a reading institution is another institution in Part 1');
  const assignment = (a, unit, revision) => ({ requestId: randomUUID(), expectedOwner: owner(a), revision, readerSub: randomUUID() });
  const ownerRow = R.applyPlan(null, plan('assignment.write', admin, null, assignment(admin, null, 0), { readerId: 'r1' }));
  const teleAdmin = actor('ta', ['admin'], 'inst-tele');
  refused(() => plan('assignment.write', teleAdmin, ownerRow, assignment(teleAdmin, ownerRow, 1), { readerId: 'rt' }), 'NotFound',
    'M-D-05: another institution cannot write the assignment');
  refused(() => R.planClinicalRead({ actor: teleAdmin, unit: ownerRow, scope: 'current' }), 'NotFound');
  refused(() => plan('assignment.write', teleAdmin, null, assignment(teleAdmin, null, 0), { readerId: 'rt' }), 'NotFound', 'no row is opened for another institution');
  assert.equal(ownerRow.managingInstitutionId, 'inst-a');
});

test('TEST-D-03 read_scope: bodies are handed out only after the access event for exactly those versions is durable', async () => {
  const unit = questionThread();
  const p = R.planClinicalRead({ actor: r1, unit, scope: 'history' });
  const sent = [];
  const send = async bodies => { sent.push(bodies); return 'sent'; };
  const event = accessEvent(p, r1, 'provide-prepared', 'prepared');
  const durable = { append: async e => ({ eventId: e.eventId, durableAt: t(501) }) };
  assert.equal(await R.provideClinicalRead(durable, event, p, send), 'sent');
  assert.deepEqual(sent[0].map(b => [b.text, b.author.id, b.kind]), [[Q, 'c1', 'clinical-question'], [ANSWER, 'r1', 'clinical-answer']]);
  await assert.rejects(R.provideClinicalRead({ append: async () => { throw new Error('SYN ledger down'); } }, event, p, send), /SYN ledger down/);
  await assert.rejects(R.provideClinicalRead({ append: async () => ({ eventId: 'other', durableAt: t(501) }) }, event, p, send), /Durability receipt mismatch/);
  let appended = 0;
  const counting = { append: async e => { appended++; return { eventId: e.eventId, durableAt: t(501) }; } };
  const narrowed = { ...event, targets: event.targets.slice(0, 1) };
  await refusedAsync(R.provideClinicalRead(counting, narrowed, p, send), 'AccessTargetMismatch');
  await refusedAsync(R.provideClinicalRead(counting, accessEvent(p, r2, 'provide-prepared', 'prepared'), p, send), 'AccessTargetMismatch');
  await refusedAsync(R.provideClinicalRead(counting, { ...event, managingInstitution: { status: 'known', value: 'inst-b' } }, p, send),
    'AccessTargetMismatch', 'the event names the record managing institution');
  await refusedAsync(R.provideClinicalRead(counting, event, structuredClone(p), send), 'ReadPlanRequired');
  assert.equal(appended, 0);
  assert.equal(sent.length, 1, 'TEST-D-03: no body is sent before the access event is durable');
  assert.ok(![Q, ANSWER].some(text => JSON.stringify(p).includes(JSON.stringify(text).slice(1, -1))), 'the plan itself carries no clinical text');
});

test('TEST-D-03 read_scope: summaries, receipts and refusals carry no clinical text', () => {
  const unit = questionThread();
  const texts = [Q, ANSWER, 'SYN 비공개 추가'].map(text => JSON.stringify(text).slice(1, -1));
  const writePlan = plan('question.reply', c1, unit, replyBody(c1, unit, 'SYN 비공개 추가'));
  for (const value of [R.summarizeUnit(unit), writePlan.receipt]) {
    const json = JSON.stringify(value);
    assert.ok(texts.every(text => !json.includes(text)), `no clinical text in ${json}`);
  }
  assert.ok(JSON.stringify(writePlan.version).includes(texts[2]), 'control: the version itself does hold the text');
  try { R.planClinicalRead({ actor: c2, unit, scope: 'history' }); assert.fail('expected a refusal'); }
  catch (error) { assert.equal(error.message, 'NotFound'); }
});

// ---------------- TEST-D-04 atomic_retry ----------------

function replyInput(unit, a = r1, body = replyBody(a, unit, ANSWER)) { return input('question.reply', a, unit, body); }

test('TEST-D-04 atomic_retry: one commit per request; a replay returns the stored receipt without signing again', async () => {
  const opened = step(null, 'question.create', c1, qBody(c1));
  const store = memoryStore(opened), sig = signaturePort();
  const body = replyBody(r1, opened, ANSWER);
  const first = await R.commitClinicalWrite({ store: store.port, signature: sig.port }, replyInput(opened, r1, body));
  assert.equal(first.status, 'committed');
  assert.deepEqual([store.state.commits, sig.calls.sign, store.state.unit.revision], [1, 1, 2]);
  assert.ok(store.state.signatures[0].evidence.versionId === first.receipt.versionId, 'the committed signature binds the committed version');
  const again = await R.commitClinicalWrite({ store: store.port, signature: sig.port }, replyInput(opened, r1, body));
  assert.deepEqual([again.status, again.receipt], ['replayed', first.receipt]);
  assert.deepEqual([store.state.commits, sig.calls.sign, store.state.unit.revision], [1, 1, 2], 'a replay neither signs nor commits');
  const later = store.state.unit;
  await R.commitClinicalWrite({ store: store.port, signature: sig.port }, replyInput(later, c1, replyBody(c1, later, 'SYN 추가')));
  const afterChange = await R.commitClinicalWrite({ store: store.port, signature: sig.port }, replyInput(store.state.unit, r1, body));
  assert.deepEqual([afterChange.status, afterChange.receipt], ['replayed', first.receipt], 'an applied request still replays after later changes');
  await refusedAsync(R.commitClinicalWrite({ store: store.port, signature: sig.port }, replyInput(store.state.unit, r1, { ...body, body: 'SYN 다른 답' })),
    'RequestIdReused');
  assert.equal(store.state.commits, 2);
});

test('TEST-D-04 atomic_retry: a failed, unverified or proxy signature commits nothing and leaves the record unchanged', async () => {
  const opened = step(null, 'question.create', c1, qBody(c1));
  const cases = [
    [{ failSign: true }, 'SignatureFailed', 'M-D-03: a signature failure must not commit or answer success'],
    [{ verdict: { integrity: 'invalid', registeredIdentity: 'matched', keyAtSigningTime: 'active', compromise: 'not-known' } }, 'SignatureNotVerified'],
    [{ verdict: { integrity: 'valid', registeredIdentity: 'matched', keyAtSigningTime: 'inactive', compromise: 'not-known' } }, 'SignatureNotVerified'],
    [{ verdict: { integrity: 'valid', registeredIdentity: 'matched', keyAtSigningTime: 'active', compromise: 'suspected' } }, 'SignatureNotVerified'],
    [{ signer: who('r2') }, 'ProxySignatureRefused'],
    [{ versionId: 'another-version' }, 'SignatureBindingRefused'],
  ];
  for (const [options, code, message] of cases) {
    const store = memoryStore(opened), sig = signaturePort(options);
    const outcome = await R.commitClinicalWrite({ store: store.port, signature: sig.port }, replyInput(opened));
    assert.deepEqual([outcome.status, outcome.code, store.state.commits], ['failed', code, 0], message || code);
    assert.deepEqual(store.state.unit, opened, message || code);
  }
  const accepted = consultation();
  const store = memoryStore(accepted), sig = signaturePort({ failSign: true });
  const outcome = await R.commitClinicalWrite({ store: store.port, signature: sig.port },
    input('consultation.accept', r2, accepted, changeBody(r2, accepted, 'accept', '')));
  assert.deepEqual([outcome.status, sig.calls.sign, store.state.commits], ['committed', 0, 1], 'a state change needs no signature');
});

test('TEST-D-04 atomic_retry: a lost commit answer is resolved by the stored receipt, never guessed', async () => {
  const opened = step(null, 'question.create', c1, qBody(c1));
  const lost = memoryStore(opened); lost.state.failCommit = 'after';
  const body = replyBody(r1, opened, ANSWER);
  const recovered = await R.commitClinicalWrite({ store: lost.port, signature: signaturePort().port }, replyInput(opened, r1, body));
  assert.deepEqual([recovered.status, lost.state.commits, lost.state.unit.revision], ['committed', 1, 2]);
  lost.state.failCommit = null;
  assert.equal((await R.commitClinicalWrite({ store: lost.port, signature: signaturePort().port }, replyInput(opened, r1, body))).status, 'replayed');
  const reset = memoryStore(opened); reset.state.failCommit = 'rolledback';
  const failed = await R.commitClinicalWrite({ store: reset.port, signature: signaturePort().port }, replyInput(opened));
  assert.deepEqual([failed.status, failed.code, failed.retry, reset.state.unit], ['failed', 'StorageFailed', 'same-request', opened]);
  const dark = memoryStore(opened); dark.state.failCommit = 'before'; dark.state.failRequery = true;
  const unknown = await R.commitClinicalWrite({ store: dark.port, signature: signaturePort().port }, replyInput(opened));
  assert.deepEqual([unknown.status, unknown.code], ['unknown', 'OutcomeUnknown'], 'an unreadable outcome is neither success nor failure');
  const odd = memoryStore(opened); odd.state.wrongReceipt = true;
  assert.equal((await R.commitClinicalWrite({ store: odd.port, signature: signaturePort().port }, replyInput(opened))).status, 'unknown');
  const raced = memoryStore(opened); raced.state.failCommit = 'taken';
  await refusedAsync(R.commitClinicalWrite({ store: raced.port, signature: signaturePort().port }, replyInput(opened)), 'RequestIdReused',
    'a key another body took first is a refusal, not a success');
  assert.deepEqual(raced.state.unit, opened);
});

test('TEST-D-04 atomic_retry: a stale revision, a forbidden transition or a regressed clock is refused before any signing', async () => {
  const unit = questionThread();
  const store = memoryStore(unit), sig = signaturePort();
  await refusedAsync(R.commitClinicalWrite({ store: store.port, signature: sig.port },
    input('question.reply', c1, unit, { ...replyBody(c1, unit, 'SYN 추가'), revision: 1 })), 'StaleRevision');
  const requested = consultation();
  const accepted = step(requested, 'consultation.accept', r2, changeBody(r2, requested, 'accept', ''));
  const done = step(accepted, 'consultation.complete', r2, changeBody(r2, accepted, 'complete', ANSWER));
  await refusedAsync(R.commitClinicalWrite({ store: store.port, signature: sig.port },
    input('consultation.cancel', r1, done, changeBody(r1, done, 'cancel', 'SYN 취소'))), 'StateTransitionRefused');
  await refusedAsync(R.commitClinicalWrite({ store: store.port, signature: sig.port },
    input('question.reply', c1, unit, replyBody(c1, unit, 'SYN 추가'), { at: t(-1) })), 'ServerTimeRegressed');
  assert.deepEqual([sig.calls.sign, store.state.commits], [0, 0]);
});

// ---------------- round 2: review 5457844 findings D-R1-01..06 ----------------

const ports = (store, sig = signaturePort()) => ({ store: store.port, signature: sig.port });
const outcomeOf = promise => promise.catch(error => ({ status: 'threw', code: error.code }));
const SUB = { r1: '11111111-1111-4111-8111-111111111111', r2: '22222222-2222-4222-8222-222222222222', r3: '33333333-3333-4333-8333-333333333333' };

test('TEST-D-04 atomic_retry: an opening write replays from the re-read unit; a new amendment still needs its reason', async () => {
  const assignmentStore = memoryStore(null);
  const assignment = { requestId: randomUUID(), expectedOwner: owner(admin), revision: 0, readerSub: SUB.r1.toUpperCase() };
  const first = await R.commitClinicalWrite(ports(assignmentStore), input('assignment.write', admin, null, assignment, { readerId: 'r1' }));
  assert.equal(first.status, 'committed');
  const again = await outcomeOf(R.commitClinicalWrite(ports(assignmentStore),
    input('assignment.write', admin, assignmentStore.state.unit, { ...assignment, readerSub: SUB.r1 }, { readerId: 'r1' })));
  assert.deepEqual([again.status, again.receipt], ['replayed', first.receipt], 'M-D-R1-01: the first assignment replays from the re-read unit');
  const noteStore = memoryStore(null);
  const note = { baseVersion: 0, text: 'SYN 조영제 주입 후 오심', reason: '', attemptId: randomUUID() };
  const written = await R.commitClinicalWrite(ports(noteStore), input('tech-note.write', tech, null, note));
  const replay = await outcomeOf(R.commitClinicalWrite(ports(noteStore), input('tech-note.write', tech, noteStore.state.unit, note)));
  assert.deepEqual([replay.status, replay.receipt], ['replayed', written.receipt], 'M-D-R1-01: the first Tech Note replays without a reason');
  assert.equal(noteStore.state.commits, 1);
  const amendment = { baseVersion: 1, text: 'SYN 수정', reason: '', attemptId: randomUUID() };
  await refusedAsync(R.commitClinicalWrite(ports(noteStore), input('tech-note.write', tech, noteStore.state.unit, amendment)), 'ReasonRequired',
    'a new amendment needs its reason');
  assert.equal((await R.commitClinicalWrite(ports(noteStore), input('tech-note.write', tech, noteStore.state.unit,
    { ...amendment, reason: 'SYN 오기재' }))).status, 'committed');
});

// Independent of the product: the fields each service's request carries (services at 04e50ab), one refusal case per field.
// Surfaces whose route opens a new unit are sent again without a unit, as the server would (no record ID in the route).
const CLINICAL_OPENS = new Set(['image-request.create', 'consultation.create', 'question.create', 'finding.create']);
const opened = () => step(null, 'question.create', c1, qBody(c1));
const acceptedConsultation = () => { const r = consultation(); return step(r, 'consultation.accept', r2, changeBody(r2, r, 'accept', '')); };
const acceptedRequest = () => { const r = imageRequest(); return step(r, 'image-request.accept', tech, changeBody(tech, r, 'accept', '')); };
const imageBody = () => ({ requestId: randomUUID(), expectedOwner: owner(c1), kind: 'external-image', counterparty: 'SYN 외부병원',
  counterpartyInstitutionId: null, reason: Q });
const MEANING_FIELDS = [
  ['image-request.create', 'kind', () => [c1, null, imageBody(), {}], b => [{ ...b, kind: 'image-transfer' }, {}]],
  ['image-request.create', 'counterparty', () => [c1, null, imageBody(), {}], b => [{ ...b, counterparty: 'SYN 다른 병원' }, {}]],
  ['image-request.create', 'counterpartyInstitutionId', () => [c1, null, imageBody(), {}], b => [{ ...b, counterpartyInstitutionId: 'inst-c' }, {}]],
  ['image-request.create', 'reason', () => [c1, null, imageBody(), {}], b => [{ ...b, reason: 'SYN 다른 사유' }, {}]],
  ['consultation.create', 'recipientSub', () => [r1, null, { requestId: randomUUID(), expectedOwner: owner(r1), recipientSub: SUB.r2, reason: Q }, { recipientId: 'r2' }],
    b => [{ ...b, recipientSub: SUB.r3 }, { recipientId: 'r3' }]],
  ['consultation.create', 'reason', () => [r1, null, { requestId: randomUUID(), expectedOwner: owner(r1), recipientSub: SUB.r2, reason: Q }, { recipientId: 'r2' }],
    b => [{ ...b, reason: 'SYN 다른 의뢰' }, { recipientId: 'r2' }]],
  ['question.create', 'body', () => [c1, null, qBody(c1), {}], b => [{ ...b, body: 'SYN 다른 질문' }, {}]],
  ['question.reply', 'body', () => { const u = opened(); return [r1, u, replyBody(r1, u, ANSWER), {}]; }, b => [{ ...b, body: 'SYN 다른 답' }, {}]],
  ['question.reply', 'revision', () => { const u = opened(); return [r1, u, replyBody(r1, u, ANSWER), {}]; }, b => [{ ...b, revision: 2 }, {}]],
  ['question.close', 'note', () => { const u = opened(); return [c1, u, closeBody(c1, u, ''), {}]; }, b => [{ ...b, note: 'SYN 해결됨' }, {}]],
  ['consultation.complete', 'note', () => { const u = acceptedConsultation(); return [r2, u, changeBody(r2, u, 'complete', ANSWER), {}]; },
    b => [{ ...b, note: 'SYN 다른 답변' }, {}]],
  ['consultation.accept', 'action', () => { const u = consultation(); return [r2, u, changeBody(r2, u, 'accept', ''), {}]; },
    b => [{ ...b, action: 'complete', note: ANSWER }, {}], 'consultation.complete'],
  ['image-request.close', 'note', () => { const u = acceptedRequest(); return [tech, u, changeBody(tech, u, 'close', 'SYN 수신 완료'), {}]; },
    b => [{ ...b, note: 'SYN 일부 수신' }, {}]],
  ['assignment.write', 'readerSub', () => [admin, null, { requestId: randomUUID(), expectedOwner: owner(admin), revision: 0, readerSub: SUB.r1 }, { readerId: 'r1' }],
    b => [{ ...b, readerSub: SUB.r2 }, { readerId: 'r2' }]],
  ['assignment.write', 'revision', () => [admin, null, { requestId: randomUUID(), expectedOwner: owner(admin), revision: 0, readerSub: SUB.r1 }, { readerId: 'r1' }],
    b => [{ ...b, revision: 1 }, { readerId: 'r1' }]],
  ['tech-note.write', 'text', () => [tech, null, { baseVersion: 0, text: 'SYN 메모', reason: '', attemptId: randomUUID() }, {}], b => [{ ...b, text: 'SYN 다른 메모' }, {}]],
  ['tech-note.write', 'reason', () => [tech, null, { baseVersion: 0, text: 'SYN 메모', reason: '', attemptId: randomUUID() }, {}], b => [{ ...b, reason: 'SYN 사유' }, {}]],
  ['tech-note.write', 'baseVersion', () => [tech, null, { baseVersion: 0, text: 'SYN 메모', reason: '', attemptId: randomUUID() }, {}], b => [{ ...b, baseVersion: 1 }, {}]],
  ['finding.create', 'item', () => [r1, null, { requestId: randomUUID(), item: {} }, { content: SNAPSHOT }],
    b => [{ ...b, item: { title: 'SYN other' } }, { content: SNAPSHOT.replace('nodule', 'other') }]],
  ['finding.hide', 'item', () => { const u = finding(); return [r1, u, { requestId: randomUUID(), expectedRevision: 1, action: 'hide', item: {} },
    { content: SNAPSHOT, workContext: { kind: 'reading', studyId: study.studyId, referenceId: 'claim-1' } }]; },
    b => [{ ...b, item: { hidden: true } }, { content: SNAPSHOT, workContext: { kind: 'reading', studyId: study.studyId, referenceId: 'claim-1' } }]],
  ['finding.hide', 'reason', () => { const u = finding(); return [r1, u, { requestId: randomUUID(), expectedRevision: 1, action: 'hide', item: {} },
    { content: SNAPSHOT, workContext: { kind: 'reading', studyId: study.studyId, referenceId: 'claim-1' } }]; },
    b => [{ ...b, reason: 'SYN 오기재' }, { content: SNAPSHOT }]],
];
for (const [surface, field, first, change, secondSurface] of MEANING_FIELDS) {
  test(`TEST-D-04 atomic_retry: the same request ID with another ${surface} ${field} is refused`, async () => {
    const [a, unit, body, extra] = first();
    const store = memoryStore(unit);
    assert.equal((await R.commitClinicalWrite(ports(store), input(surface, a, unit, body, extra))).status, 'committed');
    const [changed, changedExtra] = change(body);
    const opensFresh = CLINICAL_OPENS.has(surface);
    await refusedAsync(R.commitClinicalWrite(ports(store), input(secondSurface ?? surface, a, opensFresh ? null : store.state.unit, changed, changedExtra)),
      'RequestIdReused', `M-D-R1-02: ${surface} ${field} is part of the request meaning`);
    assert.equal(store.state.commits, 1, 'the changed request committed nothing');
  });
}

test('TEST-D-04 atomic_retry: a lost answer with no visible receipt stays unknown and resolves to the late real outcome', async () => {
  const unit = opened();
  const store = memoryStore(unit); store.state.failCommit = 'late';
  const body = replyBody(r1, unit, ANSWER);
  const first = await R.commitClinicalWrite(ports(store), replyInput(unit, r1, body));
  assert.deepEqual([first.status, first.code, first.retry], ['unknown', 'OutcomeUnknown', 'same-request'],
    'M-D-R1-03: a missing receipt after a lost answer is not a failure');
  store.state.late.forEach(apply => apply()); store.state.failCommit = null;
  const resolved = await R.commitClinicalWrite(ports(store), replyInput(store.state.unit, r1, body));
  assert.deepEqual([resolved.status, resolved.receipt.versionId, store.state.unit.revision], ['replayed', store.state.unit.head.versionId, 2],
    'the same request ends as the real (late) outcome, appended once');
  const definite = memoryStore(unit); definite.state.failCommit = 'rolledback';
  const rolledBack = await R.commitClinicalWrite(ports(definite), replyInput(unit));
  assert.deepEqual([rolledBack.status, rolledBack.code, definite.state.unit], ['failed', 'StorageFailed', unit], 'only a reported rollback is a failure');
});

test('TEST-D-04 atomic_retry: a resend whose receipt lookup fails stays unknown until the late original is visible', async () => {
  const unit = opened();
  const store = memoryStore(unit); store.state.failCommit = 'late';
  const body = replyBody(r1, unit, ANSWER);
  assert.equal((await R.commitClinicalWrite(ports(store), replyInput(unit, r1, body))).status, 'unknown');
  store.state.failCommit = null; store.state.failRequery = true;
  const resend = await outcomeOf(R.commitClinicalWrite(ports(store), replyInput(unit, r1, body)));
  assert.deepEqual([resend.status, resend.code], ['unknown', 'OutcomeUnknown'], 'M-D-R1-03b: an unreadable receipt store on resend is not a failure');
  assert.equal(store.state.commits, 1, 'the resend committed nothing while the outcome was unknown');
  store.state.late.forEach(apply => apply()); store.state.failRequery = false;
  const resolved = await R.commitClinicalWrite(ports(store), replyInput(store.state.unit, r1, body));
  assert.deepEqual([resolved.status, store.state.unit.revision], ['replayed', 2], 'the original success is the final answer');
});

test('TEST-D-03 read_scope: a rewritten author or recipient projection is refused and no body is provided', async () => {
  const unit = questionThread();
  const forged = structuredClone(unit); forged.parties.authorId = 'c2';
  refused(() => R.planClinicalRead({ actor: c2, unit: forged, scope: 'history' }), 'UnitHistoryBroken',
    'M-D-R1-04: a rewritten author projection grants nothing');
  let sent = 0;
  await assert.rejects((async () => {
    const p = R.planClinicalRead({ actor: c2, unit: forged, scope: 'history' });
    await R.provideClinicalRead({ append: async e => ({ eventId: e.eventId, durableAt: t(501) }) }, accessEvent(p, c2, 'provide-prepared', 'prepared'), p,
      async () => { sent++; });
  })(), error => error.code === 'UnitHistoryBroken');
  assert.equal(sent, 0, 'no body is provided for a rewritten projection');
  refused(() => plan('question.reply', c2, forged, replyBody(c2, forged, 'SYN')), 'UnitHistoryBroken', 'nor is a write planned on it');
  const requested = consultation();
  assert.equal(requested.versions[0].recipientId, 'r2', 'the recipient is fixed by the opening version');
  const rerouted = structuredClone(requested); rerouted.parties.recipientId = 'r3';
  refused(() => R.planClinicalRead({ actor: actor('r3', ['radiologist']), unit: rerouted, scope: 'current' }), 'UnitHistoryBroken');
  assert.equal(R.planClinicalRead({ actor: r2, unit: requested, scope: 'current' }).versions.length, 1,
    'control: the genuine recipient is served');
  assert.equal(R.planClinicalRead({ actor: c1, unit, scope: 'current' }).versions.length, 1, 'control: the genuine author is served');
});

test('TEST-D-02 versions_and_sr: an Orthanc observation contradicting an adopted SR is a conflict, never adopted', () => {
  const adopted = sr({ attemptedAt: t(5), storedAt: t(6) });
  const present = (sha, sop = adopted.sopInstanceUid) => ({ status: 'present', sopInstanceUid: sop, sha256: sha });
  assert.equal(R.reconcileManualSr(adopted, present('00'.repeat(32))).outcome, 'conflict', 'M-D-R1-05: another hash under an adopted SOP is a conflict');
  assert.equal(R.reconcileManualSr(adopted, present('cd'.repeat(32), '1.2.3')).outcome, 'conflict', 'another SOP is a conflict');
  assert.equal(R.reconcileManualSr(adopted, { status: 'absent' }).outcome, 'conflict', 'an adopted original that is gone is a conflict');
  assert.equal(R.reconcileManualSr(adopted, present('cd'.repeat(32))).outcome, 'already-adopted', 'control: the same bytes stay adopted');
  assert.equal(R.reconcileManualSr(adopted, { status: 'unknown' }).outcome, 'already-adopted', 'an unknown lookup changes nothing');
});

test('TEST-D-02 versions_and_sr: a Tech Note amendment in the acquisition context needs no typed reason and is a signed correction keeping the original', () => {
  const written = R.applyPlan(null, plan('tech-note.write', tech, null, { baseVersion: 0, text: 'SYN 조영제 주입 후 오심', reason: '', attemptId: randomUUID() }));
  const context = { kind: 'acquisition', studyId: study.studyId, referenceId: 'exam-1' };
  const amend = () => ({ baseVersion: 1, text: 'SYN 조영제 주입 후 오심, 회복', reason: '', attemptId: randomUUID() });
  let amended;
  assert.doesNotThrow(() => { amended = plan('tech-note.write', tech, written, amend(), { workContext: context }); },
    'M-D-R2-01: a Tech Note amendment in the acquisition context needs no typed reason');
  assert.deepEqual([amended.entry, amended.version.act, amended.signing.action, amended.version.reasonSource, amended.signing.reason, amended.signing.signer],
    ['clinical-entry', 'correction', 'amend', 'work-context', 'work-context:acquisition:exam-1', tech.identity]);
  assert.equal(R.applyPlan(written, amended).versions[0].text, 'SYN 조영제 주입 후 오심', 'the original note is kept');
  refused(() => plan('tech-note.write', tech, written, amend()), 'ReasonRequired', 'outside the work context an amendment needs a reason');
  refused(() => plan('tech-note.write', tech, written, amend(), { workContext: { ...context, studyId: '1.2.840.99.9' } }), 'ReasonRequired',
    'work on another study is outside the context');
  refused(() => plan('tech-note.write', tech, written, amend(), { workContext: { ...context, kind: 'reading' } }), 'ReasonRequired',
    'a reading context does not bind a Tech Note reason');
  assert.equal(plan('tech-note.write', tech, written, { ...amend(), reason: ' SYN 오기재 ' }).version.reasonSource, 'stated');
});

test('TEST-D-02 versions_and_sr: hide and restore in the reading context need no typed reason and are signed corrections keeping the original', () => {
  const created = finding();
  const context = { kind: 'reading', studyId: study.studyId, referenceId: 'claim-1' };
  const HIDDEN = SNAPSHOT.replace('"hidden":false', '"hidden":true');
  const hideBody = () => ({ requestId: randomUUID(), expectedRevision: 1, action: 'hide', item: {} });
  let hide;
  assert.doesNotThrow(() => { hide = plan('finding.hide', r1, created, hideBody(), { content: HIDDEN, workContext: context }); },
    'M-D-R1-06: hiding in the reading context needs no typed reason');
  assert.deepEqual([hide.entry, hide.version.act, hide.signing.action, hide.version.reasonSource, hide.signing.reason, hide.projection.state],
    ['clinical-entry', 'correction', 'amend', 'work-context', 'work-context:reading:claim-1', 'Hidden']);
  const hidden = R.applyPlan(created, hide);
  assert.equal(hidden.versions[0].text, SNAPSHOT, 'the original finding is kept next to the correction');
  const restore = plan('finding.restore', r1, hidden, { requestId: randomUUID(), expectedRevision: 2, action: 'restore', item: {} },
    { content: SNAPSHOT, workContext: context });
  assert.deepEqual([restore.entry, restore.version.reasonSource, restore.projection.state], ['clinical-entry', 'work-context', 'Visible']);
  refused(() => plan('finding.hide', r1, created, hideBody(), { content: HIDDEN }), 'ReasonRequired', 'outside the reading context a reason is required');
  refused(() => plan('finding.hide', r1, created, hideBody(), { content: HIDDEN, workContext: { ...context, studyId: '1.2.840.99.9' } }), 'ReasonRequired',
    'reading another study is outside the context');
  const stated = plan('finding.hide', r1, created, { ...hideBody(), reason: 'SYN 오기재' }, { content: HIDDEN });
  assert.deepEqual([stated.version.reasonSource, stated.signing.reason], ['stated', 'SYN 오기재'], 'a stated reason is kept as stated');
  refused(() => plan('finding.edit', r1, created, { requestId: randomUUID(), expectedRevision: 1, action: 'edit', item: {}, reason: 'SYN' },
    { content: SNAPSHOT.replace('8 mm', '9 mm') }), 'TextRefused', 'an edit carries no reason');
});
